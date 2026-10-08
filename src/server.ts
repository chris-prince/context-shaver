// mini-context for Claude Code: a local proxy between Claude Code and the
// Anthropic API that trims old tool output, long Edit/Write inputs and
// reasoning from each request it forwards. The stored session and the screen
// are untouched; only what is sent changes. See README.md.
//
// Each conversation (keyed by its first message, so a subagent is its own) has
// a frontier, saved under state/, that every request is trimmed up to. On each
// request the cost rule (trim.ts, decide) says whether moving it up to the
// latest completed turns pays: always on a cold cache, and on a warm one when
// what it saves outweighs what it rewrites.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { hash, kinds, LOG_DIR, writeLine, writeParts } from './log.ts'
import { candidate, decide, strip, turnsOf, type ApiMsg, type Decision, type Frontier, type Options } from './trim.ts'

const { values: a } = parseArgs({
  allowNegative: true,
  options: {
    port: { type: 'string', default: '8787' },
    upstream: { type: 'string', default: 'https://api.anthropic.com' },
    dir: { type: 'string', default: path.resolve(import.meta.dirname, '..') },
    'strip-tool-calls': { type: 'boolean', default: true },
    'strip-reasoning': { type: 'boolean', default: true },
    'strip-tool-calls-wait-turns': { type: 'string', default: '0' },
    'strip-reasoning-wait-turns': { type: 'string', default: '0' },
    'log-step-events': { type: 'boolean', default: false },
    'cache-ttl-seconds': { type: 'string', default: '3600' },
  },
})

const o: Options = {
  stripToolCalls: a['strip-tool-calls'],
  stripReasoning: a['strip-reasoning'],
  stripToolCallsWaitTurns: Number(a['strip-tool-calls-wait-turns']),
  stripReasoningWaitTurns: Number(a['strip-reasoning-wait-turns']),
}
const ttlMs = Number(a['cache-ttl-seconds']) * 1000
const stateDir = path.join(a.dir, 'state')
const logRoot = path.join(a.dir, LOG_DIR)
mkdirSync(stateDir, { recursive: true })

// A conversation's frontier, and the model and time of its last answered
// request, which say whether its cache is still warm.
type State = { frontier: Frontier; model: string; lastAt: number }

function load(key: string): State | undefined {
  try {
    return JSON.parse(readFileSync(path.join(stateDir, `${key}.json`), 'utf8'))
  } catch {
    return undefined
  }
}

const save = (key: string, s: State) => writeFileSync(path.join(stateDir, `${key}.json`), JSON.stringify(s))

// What a request becomes: the body to send, and what to record once it is
// answered.
type Prepared = { body: Buffer; key: string; frontier: Frontier; model: string; logDir?: string; logLine?: Record<string, unknown> }

// Trims a /v1/messages request. Only requests with tools are trimmed: those
// are the main loop and subagents. Claude Code's side requests are sent as
// they came.
function prepare(raw: Buffer, now: number): Prepared | undefined {
  const body = JSON.parse(raw.toString('utf8'))
  const msgs: ApiMsg[] | undefined = body.messages
  if (!Array.isArray(msgs) || !msgs.length || !body.tools?.length) return
  const key = hash(JSON.stringify(msgs[0]))
  const s = load(key)
  const f = s?.frontier ?? { tools: 0, reasoning: 0 }
  const keep = strip(msgs, f)
  const next = candidate(msgs, f, o)
  let sent = keep
  let frontier = f
  let d: Decision | undefined
  if (next.tools > f.tools || next.reasoning > f.reasoning) {
    const advanced = strip(msgs, next)
    d = decide(keep.msgs, advanced.msgs, !s || s.model !== body.model || now - s.lastAt > ttlMs)
    if (d.advanced) [sent, frontier] = [advanced, next]
  }
  body.messages = sent.msgs
  const p: Prepared = { body: Buffer.from(JSON.stringify(body)), key, frontier, model: body.model }
  if (a['log-step-events']) {
    let session = 'unknown'
    try {
      session = JSON.parse(body.metadata?.user_id ?? '{}').session_id ?? session
    } catch {}
    p.logDir = path.join(logRoot, `${session}-${key.slice(0, 8)}`)
    const time = new Date(now).toISOString()
    if (d?.savedChars) {
      const context: Record<string, number> = {}
      for (const m of keep.msgs) for (const [k, n] of Object.entries(kinds(JSON.stringify(m), m).kinds)) context[k] = (context[k] ?? 0) + n
      const advanced = d.advanced ? sent : strip(msgs, next)
      writeLine(p.logDir, {
        event: 'compaction',
        time,
        advanced: d.advanced,
        cacheState: d.cold ? 'cold' : 'warm',
        savedChars: d.savedChars,
        rewriteChars: d.rewriteChars,
        extraChars: d.extraChars,
        turns: turnsOf(msgs).completed,
        stubbedResults: advanced.results - keep.results,
        stubbedInputs: advanced.inputs - keep.inputs,
        thinkingBlocks: advanced.thinking - keep.thinking,
        context,
      })
    }
    p.logLine = { event: 'request', time, model: body.model, parts: writeParts(p.logDir, sent.msgs) }
  }
  return p
}

// The usage a response reports: message_start's, with message_delta's output
// tokens, for a stream; the body's for a plain response.
type Usage = { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number }

function usageReader() {
  let usage: Usage | undefined
  let buf = ''
  const dec = new TextDecoder()
  const line = (l: string) => {
    if (!l.startsWith('data: ')) return
    try {
      const e = JSON.parse(l.slice(6))
      if (e.type === 'message_start') usage = { ...e.message?.usage }
      if (e.type === 'message_delta' && usage && e.usage?.output_tokens !== undefined) usage.output_tokens = e.usage.output_tokens
    } catch {}
  }
  return {
    push(chunk: Uint8Array) {
      buf += dec.decode(chunk, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      lines.forEach(line)
    },
    end(): Usage | undefined {
      if (usage) return usage
      try {
        return JSON.parse(buf).usage
      } catch {
        return undefined
      }
    },
  }
}

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'keep-alive'])

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  const url = req.url ?? '/'
  let p: Prepared | undefined
  if (req.method === 'POST' && url.split('?')[0] === '/v1/messages' && raw.length) {
    try {
      p = prepare(raw, Date.now())
    } catch (err) {
      console.error('mini-context: request left untrimmed:', err)
    }
  }
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v
  const abort = new AbortController()
  res.on('close', () => res.writableFinished || abort.abort())
  const send = (body: Buffer | undefined) =>
    fetch(a.upstream + url, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body, signal: abort.signal })
  let up = await send(p?.body ?? raw)
  // A trimmed request the API refuses is sent again as it came, so a trim
  // never costs the user a turn.
  if (p && up.status === 400) {
    console.error(`mini-context: trimmed request refused, sent untrimmed: ${(await up.text()).slice(0, 500)}`)
    p = undefined
    up = await send(raw)
  }
  const out: Record<string, string> = {}
  up.headers.forEach((v, k) => {
    if (k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding') out[k] = v
  })
  res.writeHead(up.status, out)
  const usage = usageReader()
  if (up.body)
    for await (const chunk of up.body) {
      res.write(chunk)
      if (p) usage.push(chunk)
    }
  res.end()
  if (!p || up.status !== 200) return
  save(p.key, { frontier: p.frontier, model: p.model, lastAt: Date.now() })
  if (p.logDir && p.logLine) {
    const u = usage.end()
    writeLine(p.logDir, {
      ...p.logLine,
      ...(u && {
        inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        cachedTokens: u.cache_read_input_tokens ?? 0,
        writtenTokens: u.cache_creation_input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
      }),
    })
  }
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (abortedBy(err)) return res.end()
    console.error('mini-context:', err)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `mini-context proxy: ${err}` } }))
    } else res.end()
  })
}).listen(Number(a.port), '127.0.0.1', () => console.error(`mini-context: listening on http://127.0.0.1:${a.port}, forwarding to ${a.upstream}`))

const abortedBy = (err: unknown) => err instanceof Error && err.name === 'AbortError'

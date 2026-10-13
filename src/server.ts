// ctx-shaver: a local proxy between Claude Code and the Anthropic API that
// trims old tool output, long Edit/Write inputs and reasoning from each request
// it forwards. The stored session and the screen are untouched; only what is
// sent changes. See README.md.
//
// What is trimmed, and when, is the policy file's (policy.ts); with none, it
// passes requests through. Each conversation (keyed by its first message, so a
// subagent is its own) has an applied clock, saved under proxy-data/state/: the
// completed steps and turns every request is trimmed at. On each request the
// cost rule (trim.ts, decide) says whether moving it up to the conversation's
// clock pays: always on a cold cache, and on a warm one when what it saves
// outweighs what it rewrites, priced against the cache entries the
// conversation's requests left.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { hash, kinds, LOG_DIR, writeDefs, writeLine, writeParts } from './log.ts'
import { clockOf, heldTo, type ApiMsg, type Clock } from './items.ts'
import { forceDefer } from './defer.ts'
import { pendingCommand, reply, stripCommands } from './command.ts'
import { describe, observe, render, type Sent, type Stats } from './stats.ts'
import { latest, record } from './journal.ts'
import { loadPolicy } from './policy.ts'
import { apply, decide, positionsOf, readThrough, seedOf, TEXT_TOKENS, transitions, trimmedEnd, type Decision } from './trim.ts'

const { values: a } = parseArgs({
  allowNegative: true,
  options: {
    port: { type: 'string', default: '8787' },
    upstream: { type: 'string', default: 'https://api.anthropic.com' },
    dir: { type: 'string', default: path.resolve(import.meta.dirname, '..', 'proxy-data') },
    policy: { type: 'string', default: path.resolve(import.meta.dirname, '..', 'policy.json') },
    'log-step-events': { type: 'boolean', default: false },
    'cache-ttl-seconds': { type: 'string', default: '3600' },
  },
})

const loaded = loadPolicy(a.policy)
if (!loaded) console.error(`ctx-shaver: no policy at ${a.policy}, so requests pass through untrimmed`)
const policy = loaded ?? {}
const ttlMs = Number(a['cache-ttl-seconds']) * 1000
const stateDir = path.join(a.dir, 'state')
const logRoot = path.join(a.dir, LOG_DIR)
mkdirSync(stateDir, { recursive: true })

// A conversation's applied clock; the cache entries its answered requests
// wrote or read, by prefix hash, with when (trim.ts, positionsOf); and the
// tokens each thinking block it was answered with bills, by the signature's
// hash (trim.ts, sizeOf). Its stats, for `:shaver stats`, are in its journal.
type State = { applied: Clock; entries?: Record<string, number>; thinking?: Record<string, number> }

// A state saved before the applied clock, with a frontier, is read as none.
function load(key: string): State | undefined {
  try {
    const s: State = JSON.parse(readFileSync(path.join(stateDir, `${key}.json`), 'utf8'))
    return s.applied ? s : undefined
  } catch {
    return undefined
  }
}

const save = (key: string, s: State) => writeFileSync(path.join(stateDir, `${key}.json`), JSON.stringify(s))

// Each conversation's stats as its journal ends (journal.ts), replayed from the
// journal the first time they're asked for.
const current = new Map<string, Stats | undefined>()
const journalOf = (key: string) => path.join(stateDir, `${key}.journal.jsonl`)
function latestOf(key: string): Stats | undefined {
  if (!current.has(key)) current.set(key, latest(journalOf(key)))
  return current.get(key)
}

// What a request becomes: the body to send, and what to record once it is
// answered.
type Prepared = { body: Buffer; key: string; applied: Clock; entries: Record<string, number>; touched: string[]; thinking: Record<string, number>; stats?: Stats; sent: Sent; logDir?: string; logLine?: Record<string, unknown> }

// Trims a /v1/messages request. Only requests with tools are trimmed: those
// are the main loop and subagents. Claude Code's side requests are sent as
// they came.
function prepare(raw: Buffer, now: number): Prepared | undefined {
  const body = JSON.parse(raw.toString('utf8'))
  const msgs: ApiMsg[] | undefined = body.messages
  if (!Array.isArray(msgs) || !msgs.length || !body.tools?.length) return
  if (policy.tools_not_deferred) forceDefer(body, policy.tools_not_deferred)
  const key = hash(JSON.stringify(msgs[0]))
  const s = load(key)
  const held = heldTo(s?.applied ?? { steps: 0, turns: 0 }, msgs)
  const clock = clockOf(msgs)
  const entries = Object.fromEntries(Object.entries(s?.entries ?? {}).filter(([, t]) => now - t <= ttlMs))
  const live = new Set(Object.keys(entries))
  const seed = seedOf(body.model, body.tools, body.system)
  const thinking = new Map(Object.entries(s?.thinking ?? {}))
  const keep = apply(msgs, policy, held)
  let sent = keep
  let applied = held
  let next = keep
  let d: Decision | undefined
  if (clock.steps > held.steps || clock.turns > held.turns) {
    next = apply(msgs, policy, clock)
    d = decide(keep.msgs, next.msgs, live, seed, body.model, thinking)
    if (d.advanced) [sent, applied] = [next, clock]
  }
  body.messages = sent.msgs
  // The entries this request writes or reads: one at each breakpoint, and the
  // one it reads through.
  const pos = positionsOf(sent.msgs, seed, thinking)
  const r = readThrough(pos, live)
  const touched = pos.filter((q, i) => q.breakpoint || i === r).map((q) => q.prefix)
  // Where trimming ends in the messages as sent, which drops shorten.
  const ends = trimmedEnd(msgs, policy, applied)
  const sentEnd = (end: number) => sent.origin.filter((i) => i < end).length
  const trimmed = { tools: sentEnd(ends.tools), reasoning: sentEnd(ends.reasoning) }
  const time = new Date(now).toISOString()
  const p: Prepared = { body: Buffer.from(JSON.stringify(body)), key, applied, entries, touched, thinking: s?.thinking ?? {}, stats: latestOf(key), sent: describe(body, trimmed, time, d?.advanced) }
  if (a['log-step-events']) {
    p.logDir = logDirOf(body)
    if (d?.savedChars) {
      const context: Record<string, number> = {}
      for (const m of keep.msgs) for (const [k, n] of Object.entries(kinds(JSON.stringify(m), m).kinds)) context[k] = (context[k] ?? 0) + n
      writeLine(p.logDir, {
        event: 'compaction',
        time,
        advanced: d.advanced,
        cacheState: d.cold ? 'cold' : 'warm',
        savedChars: d.savedChars,
        rewriteChars: d.rewriteChars,
        extraChars: d.extraChars,
        steps: clock.steps,
        turns: clock.turns,
        transitions: transitions(keep, next),
        context,
      })
    }
    const predictedCachedChars = pos.slice(0, r + 1).reduce((n, q) => n + q.size, 0)
    p.logLine = { event: 'request', time, model: body.model, predictedCachedChars, breakpoints: pos.filter((q) => q.breakpoint).length, trimmedEnd: trimmed, parts: writeParts(p.logDir, sent.msgs), ...writeDefs(p.logDir, body) }
  }
  return p
}

// Where a conversation's requests are logged: its session, and its key.
function logDirOf(body: { messages: ApiMsg[]; metadata?: { user_id?: string } }): string {
  let session = 'unknown'
  try {
    session = JSON.parse(body.metadata?.user_id ?? '{}').session_id ?? session
  } catch {}
  return path.join(logRoot, `${session}-${hash(JSON.stringify(body.messages[0])).slice(0, 8)}`)
}

// The answer to `:shaver policy`: the policy file as it is now, which may differ
// from what was loaded at startup if it was edited since.
function policyText(): string {
  try {
    return '`' + a.policy + '`:\n```json\n' + readFileSync(a.policy, 'utf8').trimEnd() + '\n```'
  } catch {
    return `ctx-shaver: no policy at ${a.policy}, so requests pass through untrimmed.`
  }
}

// The answer to `:shaver stats`: the conversation's latest answered request,
// from its journal (stats.ts).
function stats(body: { messages: ApiMsg[]; metadata?: { user_id?: string } }): string {
  const s = latestOf(hash(JSON.stringify(body.messages[0])))
  if (!s) return 'ctx-shaver: no request in this conversation has been counted yet, so there are no stats.'
  return '```\n' + render(s, path.basename(logDirOf(body))) + '\n```'
}

// The usage a response reports: message_start's, with message_delta's output
// tokens, for a stream; the body's for a plain response. Also its content's
// lengths: each thinking block's signature and the characters of everything
// else.
type Usage = { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number }; output_tokens?: number }

type Content = { signatures: string[]; visibleChars: number }

function usageReader() {
  let usage: Usage | undefined
  const content: Content = { signatures: [], visibleChars: 0 }
  let buf = ''
  const dec = new TextDecoder()
  const line = (l: string) => {
    if (!l.startsWith('data: ')) return
    try {
      const e = JSON.parse(l.slice(6))
      if (e.type === 'message_start') usage = { ...e.message?.usage }
      if (e.type === 'message_delta' && usage && e.usage?.output_tokens !== undefined) usage.output_tokens = e.usage.output_tokens
      if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') content.signatures.push('')
      if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') content.visibleChars += JSON.stringify(e.content_block.name).length
      if (e.type === 'content_block_delta') {
        const d = e.delta ?? {}
        if (d.type === 'signature_delta' && content.signatures.length) content.signatures[content.signatures.length - 1] += d.signature
        if (d.type === 'text_delta') content.visibleChars += d.text.length
        if (d.type === 'input_json_delta') content.visibleChars += d.partial_json.length
      }
    } catch {}
  }
  return {
    push(chunk: Uint8Array) {
      buf += dec.decode(chunk, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      lines.forEach(line)
    },
    end(): { usage?: Usage; content: Content } {
      if (usage) return { usage, content }
      try {
        const b = JSON.parse(buf)
        for (const c of b.content ?? [])
          if (c.type === 'thinking') content.signatures.push(c.signature ?? '')
          else content.visibleChars += c.type === 'text' ? c.text.length : c.type === 'tool_use' ? JSON.stringify(c.name).length + JSON.stringify(c.input).length : 0
        return { usage: b.usage, content }
      } catch {
        return { content }
      }
    },
  }
}

// What each thinking block of a response bills when sent back: the output
// tokens less the visible content's worth, shared among its blocks by
// signature length.
function thinkingOf(u: Usage | undefined, c: Content): Record<string, number> {
  const sigs = c.signatures.filter(Boolean)
  const total = sigs.reduce((n, sg) => n + sg.length, 0)
  if (!u?.output_tokens || !total) return {}
  const tokens = Math.max(0, u.output_tokens - TEXT_TOKENS * c.visibleChars)
  return Object.fromEntries(sigs.map((sg) => [hash(sg), Math.round((tokens * sg.length) / total)]))
}

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'keep-alive'])

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const original = await readBody(req)
  let raw = original
  const url = req.url ?? '/'
  // bin/run-proxy --restart and --stop stop the proxy with this. The header
  // keeps a web page from sending it: browsers send a custom header only after a
  // CORS check this proxy doesn't answer.
  if (req.method === 'POST' && url === '/ctx-shaver/shutdown' && req.headers['x-ctx-shaver'] === 'shutdown') {
    console.error('ctx-shaver: shutting down, as asked')
    return void res.end('stopping\n', () => process.exit(0))
  }
  let p: Prepared | undefined
  if (req.method === 'POST' && url.split('?')[0] === '/v1/messages' && raw.length) {
    // `:shaver` commands are answered here; answered ones are stripped (command.ts).
    try {
      const body = JSON.parse(raw.toString('utf8'))
      if (Array.isArray(body.messages) && body.messages.length) {
        const msgs = stripCommands(body.messages)
        const command = body.tools?.length && pendingCommand(msgs)
        if (command) {
          const text = command === ':shaver policy' ? policyText() : stats({ ...body, messages: msgs })
          res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' })
          const context = latestOf(hash(JSON.stringify(body.messages[0])))?.inputTokens ?? 0
          return void res.end(reply(text, body.model, !!body.stream, context))
        }
        if (msgs.length < body.messages.length) raw = Buffer.from(JSON.stringify({ ...body, messages: msgs }))
      }
    } catch (err) {
      console.error('ctx-shaver: commands left in:', err)
    }
    try {
      p = prepare(raw, Date.now())
    } catch (err) {
      console.error('ctx-shaver: request left untrimmed:', err)
    }
  }
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v
  const abort = new AbortController()
  res.on('close', () => res.writableFinished || abort.abort())
  const send = (body: Buffer | undefined) =>
    fetch(a.upstream + url, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body, signal: abort.signal })
  let up = await send(p?.body ?? raw)
  // A changed request the API refuses is sent again as it came, so the proxy
  // never costs the user a turn.
  if ((p || raw !== original) && up.status === 400) {
    console.error(`ctx-shaver: changed request refused, sent as it came: ${(await up.text()).slice(0, 500)}`)
    p = undefined
    up = await send(original)
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
  const { usage: u, content } = usage.end()
  const now = Date.now()
  const entries = { ...p.entries, ...Object.fromEntries(p.touched.map((h) => [h, now])) }
  const inputTokens = u ? u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0
  const next = inputTokens ? observe(p.stats, p.sent, inputTokens, u?.output_tokens ?? 0) : p.stats
  if (inputTokens && next) {
    record(journalOf(p.key), latestOf(p.key), next, u)
    current.set(p.key, next)
  }
  save(p.key, { applied: p.applied, entries, thinking: { ...p.thinking, ...thinkingOf(u, content) } })
  if (p.logDir && p.logLine) {
    writeLine(p.logDir, {
      ...p.logLine,
      ...(u && {
        inputTokens,
        cachedTokens: u.cache_read_input_tokens ?? 0,
        writtenTokens60m: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        writtenTokens5m: (u.cache_creation_input_tokens ?? 0) - (u.cache_creation?.ephemeral_1h_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
      }),
    })
  }
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (abortedBy(err)) return res.end()
    console.error('ctx-shaver:', err)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `ctx-shaver proxy: ${err}` } }))
    } else res.end()
  })
}).listen(Number(a.port), '127.0.0.1', () => console.error(`ctx-shaver: listening on http://127.0.0.1:${a.port}, forwarding to ${a.upstream}`))

const abortedBy = (err: unknown) => err instanceof Error && err.name === 'AbortError'

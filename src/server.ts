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

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { hash, kinds, LOG_DIR, writeDefs, writeLine, writeParts } from './log.ts'
import { clockOf, heldTo, isPrompt, type ApiMsg, type Clock } from './items.ts'
import type { Canonical, Content, Protocol, UsageReader } from './protocol.ts'
import { MESSAGES } from './messages.ts'
import { CHAT } from './chat.ts'
import { RESPONSES } from './responses.ts'
import { forceDefer } from './defer.ts'
import { pendingCommand, stripCommands, withoutPending } from './command.ts'
import { conversationId, harnessOf, NO_CONVENTIONS, type Harness } from './harness.ts'
import { bornOf, describe, estimate, isSuggestion, observe, render, settled, type Sent, type Stats } from './stats.ts'
import { history, latest, record } from './journal.ts'
import { add, cost, spent, type Cost, type Usage } from './cost.ts'
import { localHost, route } from './via.ts'
import { loadPolicy, seedPolicy } from './policy.ts'
import { modelOf } from './models.ts'
import { anchored, apply, freedSystem, decide, positionsOf, readThrough, seedOf, fullyTrimmed, settledEnd, TEXT_TOKENS, transitions, trimmedEnd, type Decision } from './trim.ts'
import { summaryForkOf, instructions, recordOf, startsOf, summarized, validChain, type SummaryFork, type Summary } from './summary.ts'

const repoPolicy = path.resolve(import.meta.dirname, '..', 'policy.json')
const { values: a } = parseArgs({
  allowNegative: true,
  options: {
    port: { type: 'string', default: '8787' },
    upstream: { type: 'string', default: 'https://api.anthropic.com' },
    dir: { type: 'string', default: path.resolve(import.meta.dirname, '..', 'proxy-data') },
    policy: { type: 'string', default: repoPolicy },
    'log-step-events': { type: 'boolean', default: false },
    'cache-ttl-seconds': { type: 'string', default: '3600' },
  },
})

// The repo's policy.json is made from policy.default.json the first time; a
// --policy file given is taken as it is.
if (a.policy === repoPolicy) seedPolicy(repoPolicy, path.resolve(import.meta.dirname, '..', 'policy.default.json'))
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
// hash (trim.ts, sizeOf); how many of its records it sends (summary.ts), and
// the turn the last summary fork was offered at. Its stats, for `:shaver info`,
// are in its journal.
type State = { applied: Clock; entries?: Record<string, number>; thinking?: Record<string, number>; summarized?: number; offered?: number }

// A state saved before the applied clock, with a frontier, is read as none.
function load(key: string): State | undefined {
  try {
    const s: State = JSON.parse(readFileSync(path.join(stateDir, `${key}.json`), 'utf8'))
    return s.applied ? s : undefined
  } catch {
    return undefined
  }
}

// Two requests of a conversation can be in flight at once (a side request
// beside the main loop), each with the state it loaded, so the entries and
// thinking another saved meanwhile are kept: what one knows of the cache, the
// other doesn't undo. The clock and the rest are the later request's.
function save(key: string, s: State): void {
  const was = load(key)
  const entries: Record<string, number> = {}
  for (const [h, t] of [...Object.entries(was?.entries ?? {}), ...Object.entries(s.entries ?? {})]) if (Date.now() - t <= ttlMs) entries[h] = Math.max(t, entries[h] ?? 0)
  writeFileSync(path.join(stateDir, `${key}.json`), JSON.stringify({ ...s, entries, thinking: { ...was?.thinking, ...s.thinking } }))
}

// A conversation's records (summary.ts), and the dollars its summary forks have
// cost. They are kept apart from its state, which a request answered after a
// summary fork began, and prepared before it ended, would save over.
type Summaries = { chain: Summary[]; spent: number; requests: number }
const summariesOf = (key: string) => path.join(stateDir, `${key}.summaries.json`)
function loadSummaries(key: string): Summaries {
  try {
    const s = JSON.parse(readFileSync(summariesOf(key), 'utf8'))
    return { ...s, requests: s.requests ?? s.chain.length }
  } catch {
    return { chain: [], spent: 0, requests: 0 }
  }
}

// Each conversation's stats as its journal ends (journal.ts) and its cost so
// far (cost.ts), replayed from the journal the first time they're asked for and
// kept up as requests are answered.
type Current = { stats?: Stats; cost?: Cost }
const current = new Map<string, Current>()
const journalOf = (key: string) => path.join(stateDir, `${key}.journal.jsonl`)
function currentOf(key: string): Current {
  let c = current.get(key)
  if (!c) current.set(key, (c = { stats: latest(journalOf(key)), cost: cost(history(journalOf(key)), ttlMs) }))
  return c
}
const latestOf = (key: string) => currentOf(key).stats

// What a request becomes: the body to send, and what to record once it is
// answered.
type Prepared = { body: Buffer; key: string; proto: Protocol; model: string; provider?: string; applied: Clock; entries: Record<string, number>; touched: string[]; thinking: Record<string, number>; summarized: number; offered?: number; summaryFork?: (tokens: number[]) => SummaryFork | undefined; stats?: Stats; sent: Sent; suggestion: boolean; logDir?: string; logLine?: Record<string, unknown> }

// Trims a request, given as the core's (protocol.ts). Only requests with tools
// are trimmed: those are the main loop and subagents. Claude Code's side
// requests are sent as they came.
//
// Where the cache writes an entry at each request's end by itself (automatic),
// there is no breakpoint to add, so no anchor.
function prepare(proto: Protocol, h: Harness | undefined, body: Canonical, render: (c: Canonical) => unknown, headers: IncomingHttpHeaders, now: number): Prepared | undefined {
  const msgs: ApiMsg[] | undefined = body.messages
  if (!Array.isArray(msgs) || !msgs.length || !body.tools?.length) return
  if (proto.defers && policy.tools_not_deferred) forceDefer(body, policy.tools_not_deferred)
  const key = conversationId(h, proto.name, body, headers)
  const conv = h?.conventions ?? NO_CONVENTIONS
  const auto = proto.automatic
  const s = load(key)
  const held = heldTo(s?.applied ?? { steps: 0, turns: 0 }, msgs)
  const clock = clockOf(msgs)
  const model = modelOf(body.model, body.provider)
  const entries = Object.fromEntries(Object.entries(s?.entries ?? {}).filter(([, t]) => now - t <= (model.ttl ? model.ttl * 1000 : ttlMs)))
  const live = new Set(Object.keys(entries))
  const seed = seedOf(body.model, body.tools, body.system)
  const thinking = new Map(Object.entries(s?.thinking ?? {}))
  // The records it sends: those sent before, and on a cold cache, all there are.
  const chain = policy.summary_threshold_tokens ? validChain(loadSummaries(key).chain, msgs) : []
  const before = Math.min(s?.summarized ?? 0, chain.length)
  let records = before
  let keep = summarized(apply(msgs, policy, held, conv), msgs, chain.slice(0, records))
  const cold = (ps: ReturnType<typeof positionsOf>) => ps.some((q) => q.breakpoint) && readThrough(ps, live, model.lookback) < 0
  if (records < chain.length && cold(positionsOf(keep.msgs, seed, thinking, auto))) {
    records = chain.length
    keep = summarized(apply(msgs, policy, held, conv), msgs, chain)
  }
  // One more breakpoint where the messages stop matching them settled
  // (anchored), unless it leaves less read from the cache.
  const end = auto ? undefined : settledEnd(keep.msgs, summarized(fullyTrimmed(msgs, policy, conv), msgs, chain.slice(0, records)).msgs, seed, thinking)
  const marks = (v: unknown) => JSON.stringify(v ?? null).split('"cache_control"').length - 1
  const spare = 4 - [body.system, body.tools, msgs].reduce((n: number, v) => n + marks(v), 0)
  const freed = spare > 0 ? undefined : freedSystem(body.system)
  const reads = (m: ApiMsg[]) => {
    const ps = positionsOf(m, seed, thinking, auto)
    return ps.slice(0, readThrough(ps, live, model.lookback) + 1).reduce((n, q) => n + q.size, 0)
  }
  const anchor = (m: ApiMsg[]) => {
    if (auto || (spare <= 0 && !freed)) return m
    const x = anchored(m, end, seed, thinking)
    return reads(x) >= reads(m) ? x : m
  }
  let sent = keep
  let applied = held
  let next = keep
  let d: Decision | undefined
  if (clock.steps > held.steps || clock.turns > held.turns) {
    next = summarized(apply(msgs, policy, clock, conv), msgs, chain.slice(0, records))
    d = decide(anchor(keep.msgs), anchor(next.msgs), live, seed, model, thinking, auto)
    if (d.advanced) [sent, applied] = [next, clock]
  }
  body.messages = anchor(sent.msgs)
  if (freed && marks(body.messages) > marks(sent.msgs)) body.system = freed
  // The entries this request writes or reads: one at each breakpoint, or with
  // automatic caching at each user message's end, and the one it reads through.
  const pos = positionsOf(body.messages, seed, thinking, auto)
  const r = readThrough(pos, live, model.lookback)
  const touched = pos.filter((q, i) => q.breakpoint || (auto && !q.joined) || i === r).map((q) => q.prefix)
  // Where trimming ends in the messages as sent, which drops shorten.
  const ends = trimmedEnd(msgs, policy, applied)
  const sentEnd = (end: number) => sent.origin.filter((i) => i < end).length
  const trimmed = { tools: sentEnd(ends.tools), reasoning: sentEnd(ends.reasoning) }
  const time = new Date(now).toISOString()
  // A record takes its turns' prompts out of the messages; the stats count them still.
  const described = { ...describe(body, trimmed, time, d?.advanced || records > before, conv), turns: msgs.filter(isPrompt).length }
  // Each record is dated by the first message it covers.
  const starts = startsOf(msgs, chain.slice(0, records))
  described.parts.filter((q) => q.kinds.summary).forEach((q, k) => (q.born = bornOf(latestOf(key), msgs[starts[k]])))
  const suggestion = isSuggestion(msgs)
  const after = policy.summary_threshold_tokens && (model.summaryThreshold ?? policy.summary_threshold_tokens)
  // Whether to send a summary fork is known once the response's counts are in.
  const summaryFork = after && !suggestion && pos.some((q) => q.breakpoint) ? (tokens: number[]) => summaryForkOf(sent, msgs, chain, s?.offered ?? 0, after, thinking, tokens) : undefined
  const p: Prepared = { body: Buffer.from(JSON.stringify(render(body))), key, proto, model: body.model, provider: body.provider, applied, entries, touched, thinking: s?.thinking ?? {}, summarized: records, offered: s?.offered, summaryFork, stats: latestOf(key), sent: described, suggestion }
  if (a['log-step-events']) {
    p.logDir = path.join(logRoot, key)
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
        // To test the anchor breakpoint's efficacy: the decision without it,
        // or the entry it keeps, which lookback would otherwise still find.
        // Remove this (and the logged field) once we're confident in it.
        unanchored: (({ advanced, extraChars }) => ({ advanced, extraChars }))(decide(keep.msgs, next.msgs, new Set([...live].filter((e) => e !== end)), seed, model, thinking, auto)),
      })
    }
    const predictedCachedChars = pos.slice(0, r + 1).reduce((n, q) => n + q.size, 0)
    p.logLine = { event: 'request', time, model: body.model, provider: body.provider, protocol: proto.name, ...(records && { summaries: records }), predictedCachedChars, breakpoints: pos.filter((q) => q.breakpoint).length, trimmedEnd: trimmed, parts: writeParts(p.logDir, body.messages), ...writeDefs(p.logDir, body as Parameters<typeof writeDefs>[1]) }
  }
  return p
}

// A conversation's key, which names its state, journal and log dir. A
// conversation is one message history that only grows: the proxy's applied
// clock counts steps and turns into it, and its cache entries are prefixes of
// it, so neither means anything for another history. The protocol makes the
// key unique among the conversations it serves (harness.ts, conversationId).

// The answer to `:shaver policy`: the policy file as it is now, which may differ
// from what was loaded at startup if it was edited since.
function policyText(): string {
  try {
    return '`' + a.policy + '`:\n```json\n' + readFileSync(a.policy, 'utf8').trimEnd() + '\n```'
  } catch {
    return `ctx-shaver: no policy at ${a.policy}, so requests pass through untrimmed.`
  }
}

// The answer to `:shaver info`: the conversation's latest answered request,
// from its journal (stats.ts), or before there is one, this request estimated
// as it will be sent once the command is answered, tools deferred.
function stats(proto: Protocol, h: Harness | undefined, body: Canonical, headers: IncomingHttpHeaders): string {
  const sent = structuredClone({ ...body, messages: withoutPending(body.messages) })
  if (proto.defers && policy.tools_not_deferred) forceDefer(sent, policy.tools_not_deferred)
  const key = conversationId(h, proto.name, sent, headers)
  const { stats: s, cost: c } = currentOf(key)
  const { spent: summaryForks, requests } = loadSummaries(key)
  const withSummaryForks = c && { ...c, actual: c.actual + summaryForks }
  const text = s ? render(s, key, false, withSummaryForks, requests) : render(estimate(describe(sent, { tools: 0, reasoning: 0 }, new Date().toISOString(), false, h?.conventions ?? NO_CONVENTIONS)), key, true, withSummaryForks, requests)
  return '```\n' + text + '\n```'
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

// Upgrade too: a WebSocket the client tries first (OpenCode's OpenAI provider)
// goes up as plain HTTP, and the client falls back when it's refused.
const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'keep-alive', 'upgrade'])
// The account's usage limits from the latest answer each protocol's API sent,
// which Claude Code shows in the status line. Answers made here carry them
// too, or the status line loses them for that turn.
const limits = new Map<Protocol, Record<string, string>>()

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

function refuse(res: ServerResponse, proto: Protocol, status: 400 | 403, message: string): void {
  console.error(message)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(proto.error(status, message))
}

// The protocol a path is, after any /via/; Messages for any other path, which
// is passed through.
const protocolOf = (url: string) => [MESSAGES, CHAT, RESPONSES].find((p) => p.serves(url.split('?')[0])) ?? MESSAGES

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const original = await readBody(req)
  let raw = original
  const r = route(req.url ?? '/', a.upstream)
  const proto = protocolOf('error' in r ? '/' : r.url)
  if (!localHost(req.headers.host)) return refuse(res, proto, 403, `ctx-shaver proxy: refused a request for Host ${req.headers.host}`)
  if ('error' in r) return refuse(res, proto, 400, `ctx-shaver proxy: ${r.error}`)
  const { upstream, url } = r
  const h = harnessOf(r.harness, req.headers)
  if (h && 'error' in h) return refuse(res, proto, 400, `ctx-shaver proxy: ${h.error}`)
  // bin/run-proxy --restart and --stop stop the proxy with this. The header
  // keeps a web page from sending it: browsers send a custom header only after a
  // CORS check this proxy doesn't answer.
  if (req.method === 'POST' && url === '/ctx-shaver/shutdown' && req.headers['x-ctx-shaver'] === 'shutdown') {
    console.error('ctx-shaver: shutting down, as asked')
    return void res.end('stopping\n', () => process.exit(0))
  }
  let p: Prepared | undefined
  if (req.method === 'POST' && proto.serves(url.split('?')[0]) && raw.length) {
    // `:shaver` commands are answered here; answered ones are stripped (command.ts).
    let c: ReturnType<Protocol['canonical']> | undefined
    try {
      c = proto.canonical(JSON.parse(raw.toString('utf8')))
    } catch (err) {
      console.error('ctx-shaver: request not read:', err)
    }
    const body = c?.body
    try {
      if (c && body && Array.isArray(body.messages) && body.messages.length) {
        const msgs = stripCommands(body.messages)
        const command = body.tools?.length && pendingCommand(msgs)
        if (command) {
          const text = command === ':shaver policy' ? policyText() : stats(proto, h, { ...body, messages: msgs }, req.headers)
          res.writeHead(200, { ...limits.get(proto), 'content-type': body.stream ? 'text/event-stream' : 'application/json' })
          const context = latestOf(conversationId(h, proto.name, { ...body, messages: withoutPending(msgs) }, req.headers))?.inputTokens ?? 0
          return void res.end(proto.reply(text, body.model, !!body.stream, context))
        }
        if (msgs.length < body.messages.length) {
          body.messages = msgs
          raw = Buffer.from(JSON.stringify(c.render(body)))
        }
      }
    } catch (err) {
      console.error('ctx-shaver: commands left in:', err)
    }
    try {
      if (c && body) p = prepare(proto, h, body, c.render, req.headers, Date.now())
    } catch (err) {
      console.error('ctx-shaver: request left untrimmed:', err)
    }
  }
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v
  const abort = new AbortController()
  const usage = proto.usageReader()
  // A client that leaves once its answer is complete hasn't interrupted it:
  // Codex closes before the stream's last bytes, which are still read for the
  // usage.
  res.on('close', () => res.writableFinished || usage.done || abort.abort())
  const send = (body: Buffer | undefined) =>
    fetch(upstream + url, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body, signal: abort.signal })
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
  const re = proto.limits
  if (re && up.status === 200 && Object.keys(out).some((k) => re.test(k))) limits.set(proto, Object.fromEntries(Object.entries(out).filter(([k]) => re.test(k))))
  res.writeHead(up.status, out)
  // The answer's state is saved once it is complete, before the client sees
  // its end: Codex sends the next request then, before the stream closes.
  let finished = false
  const finish = () => {
    if (finished || !p || up.status !== 200) return
    finished = true
    answered(p, usage, upstream + url, headers)
  }
  if (up.body)
    for await (const chunk of up.body) {
      usage.push(chunk)
      if (usage.done) finish()
      if (!res.destroyed) res.write(chunk)
    }
  res.end()
  finish()
}

// Records an answered request: its stats, cost and cache entries, the
// conversation's state, any summary fork due and its log line.
function answered(p: Prepared, usage: UsageReader, target: string, headers: Record<string, string>): void {
  const { usage: u, content } = usage.end()
  const now = Date.now()
  const entries = { ...p.entries, ...Object.fromEntries(p.touched.map((h) => [h, now])) }
  const inputTokens = u ? u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0
  const next = inputTokens ? observe(p.stats, p.sent, inputTokens, u?.output_tokens ?? 0) : p.stats
  if (inputTokens && next && !p.suggestion) {
    const c = currentOf(p.key)
    record(journalOf(p.key), c.stats, next, u)
    current.set(p.key, { stats: next, cost: add(c.cost, c.stats, next, u!, ttlMs) })
  }
  const due = p.summaryFork && next && !p.suggestion && !summaryForking.has(p.key) ? p.summaryFork(settled(p.sent, next.tokens)) : undefined
  save(p.key, { applied: p.applied, entries, thinking: { ...p.thinking, ...thinkingOf(u, content) }, summarized: p.summarized, offered: due?.current ?? p.offered })
  if (due) void summarize(p, due, target, headers)
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

// The conversations with a summary fork under way, which get no second one.
const summaryForking = new Set<string>()

// Sends a summary fork of an answered request for a record of its turns
// (summary.ts): the request as sent, with the instructions asked after it, in
// its protocol's form, not streamed. Its cost goes to the conversation's
// records whatever it answers. Its record follows the ones the summary fork
// started after; any later ones no longer fit the messages.
async function summarize(p: Prepared, f: SummaryFork, target: string, headers: Record<string, string>): Promise<void> {
  const { key, logDir } = p
  summaryForking.add(key)
  const began = Date.now()
  const body = p.proto.summaryFork(JSON.parse(p.body.toString('utf8')), instructions(f))
  const asked = { start: f.start, current: f.current, maxTokens: body.max_tokens, thinking: body.thinking }
  const before = loadSummaries(key)
  writeFileSync(summariesOf(key), JSON.stringify({ ...before, requests: before.requests + 1 }))
  try {
    const r = await fetch(target, { method: 'POST', headers: { ...headers, accept: body.stream ? 'text/event-stream' : 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) })
    const text = await r.text()
    if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 500)}`)
    const out = p.proto.summaryForkAnswer(text)
    const time = new Date().toISOString()
    const record = recordOf(out.content, f, time)
    const s = loadSummaries(key)
    writeFileSync(summariesOf(key), JSON.stringify({ ...s, chain: record ? [...s.chain.filter((r) => r.endsBefore <= f.start), record] : s.chain, spent: s.spent + (out.usage ? spent(p.model, p.provider, out.usage) : 0) }))
    if (logDir) writeLine(logDir, { event: 'summary', time, ...asked, ms: Date.now() - began, endsBefore: record?.endsBefore, chars: record?.text.length ?? 0, usage: out.usage })
  } catch (err) {
    console.error('ctx-shaver: summary fork failed:', err)
    if (logDir) writeLine(logDir, { event: 'summary', time: new Date().toISOString(), ...asked, ms: Date.now() - began, error: String(err).slice(0, 500) })
  } finally {
    summaryForking.delete(key)
  }
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (abortedBy(err)) return res.end()
    console.error('ctx-shaver:', err)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(protocolOf((req.url ?? '/').replace(/^\/via\/[^/?#]*/, '')).error(502, `ctx-shaver proxy: ${err}`))
    } else res.end()
  })
}).listen(Number(a.port), '127.0.0.1', () => console.error(`ctx-shaver: listening on http://127.0.0.1:${a.port}, forwarding to ${a.upstream}`))

const abortedBy = (err: unknown) => err instanceof Error && err.name === 'AbortError'

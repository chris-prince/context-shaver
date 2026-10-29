// context-shaver: a local proxy between Claude Code and the Anthropic API that
// trims old tool output, long Edit/Write inputs and reasoning from each request
// it forwards. The stored session and the screen are untouched; only what is
// sent changes. See README.md.
//
// What is trimmed, and when, is the policy file's (policy.ts); with none, it
// passes requests through. Each conversation (keyed by its first message, so a
// subagent is its own) has an applied clock, saved under proxy-data/state/: the
// completed requests and turns every request is trimmed at. On each request the
// cost rule (trim.ts, decide) says whether moving it up to the conversation's
// clock pays: always on a cold cache, and on a warm one when what it saves
// outweighs what it rewrites, priced against the cache entries the
// conversation's requests left.

import { execFileSync } from 'node:child_process'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'
import { hash, kinds, LOG_DIR, paramsOf, withReceivedDelta, writeDefs, writeLine, writeParts } from './log.ts'
import { blocks, clockNow, clockOf, heldTo, isPrompt, type ApiMsg, type Clock } from './items.ts'
import type { Canonical, Content, Counted, Protocol, UsageReader, Wire } from './protocol.ts'
import { MESSAGES } from './messages.ts'
import { CHAT } from './chat.ts'
import { RESPONSES } from './responses.ts'
import { actionOf, dropTools, forceDefer, offerable, searchOn, toolListMessage, withPicked, type ToolRule } from './defer.ts'
import { keptWhole, LINE_WORDS, lineOf, linesOf, linesPrompt, listMessage, shaveSkills, skillsOf, withLines, type Skill, type SkillRule } from './skills.ts'
import { answeredMidTurn, midTurnCommands, pendingCommand, stripCommands, withoutPending } from './command.ts'
import { afterAnswer, ANALYZING, ANALYZING_TOOLS, NOTHING, optimizing, skillsAsked, skillsText, toolsAsked, toolsText, type Proposal, type Skills } from './optimize.ts'
import { totals } from './totals.ts'
import { conversationId, harnessOf, NO_CONVENTIONS, type Harness } from './harness.ts'
import { bornFrom, bornOf, counted as countOf, describe, estimate, isSuggestion, keyOf, observe, render, settled, splitShaved, SUMMARIES, withoutSuggestion, type Sent, type Stats } from './stats.ts'
import { bareLines, forks, history, latest, record, recordBare, recordFork, recordResent, sideKey, written, type BareLine, type ForkKind, type ForkLine, type Why } from './journal.ts'
import { add, addBare, addResent, cost, spent, type Cost, type Usage } from './cost.ts'
import { localHost, route } from './via.ts'
import { loadPolicy, parsePolicy, seedPolicy, skillRulesNow, textRules, toolRulesOf, type Policy } from './policy.ts'
import { lifetimeMs, modelOf } from './models.ts'
import { anchored, apply, freedSystem, decide, markedTtl, positionsOf, readThrough, seedOf, fullyTrimmed, settledEnd, TEXT_TOKENS, transitions, trimmedEnd, type Decision } from './trim.ts'
import { coveredBy, summaryForkOf, instructions, mergedOf, recordOf, startsOf, summarized, validChain, type SummaryFork, type Summary } from './summary.ts'

const repoPolicy = path.resolve(import.meta.dirname, '..', 'policy.json')
const { values: a } = parseArgs({
  allowNegative: true,
  options: {
    port: { type: 'string', default: '18787' },
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
if (!loaded) console.error(`shaver: no policy at ${a.policy}, so requests pass through untrimmed`)
const policy = loaded ?? {}
const parts = policy.conversation_shaver_rules ?? {}
const { summary_threshold_tokens: summaryAt, memoir_threshold_tokens: memoirAt } = textRules(policy)
const ttlMs = Number(a['cache-ttl-seconds']) * 1000
const stateDir = path.join(a.dir, 'state')
const logRoot = path.join(a.dir, LOG_DIR)
mkdirSync(stateDir, { recursive: true })
// The commit this proxy started from, for bin/run-proxy to tell whether the
// checkout has moved on since; empty outside a git checkout.
const commit = (() => {
  try { return execFileSync('git', ['-C', import.meta.dirname, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
})()

// A conversation's applied clock; the cache entries its answered requests
// wrote or read, by prefix hash, with when (trim.ts, positionsOf); and the
// tokens each thinking block it was answered with bills, by the signature's
// hash (trim.ts, sizeOf); how many of its records it sends (summary.ts), how
// many of those as the memoir, and the turn the last summary fork was offered
// at; the skill rules its list was last shortened by, and when it took them.
// Its stats, for `shaver info`, are in its journal.
type SkillList = { rules: SkillRule[]; at: number }
type State = { applied: Clock; entries?: Record<string, number>; thinking?: Record<string, number>; summarized?: number; merged?: number; offered?: number; skillList?: SkillList }

// The skill rules a conversation's list is shortened by: while its cache is
// warm the ones it has, so new ones don't rewrite it, unless lines from
// `shaver optimize` were applied since; else the policy's.
const skillListOf = (s: State | undefined, warm: boolean, now: number): SkillList | undefined =>
  s?.skillList && warm && s.skillList.at > skillsForcedAt ? s.skillList : policy.skill_shaver_rules && { rules: policy.skill_shaver_rules, at: now }

// A state saved before the applied clock, with a frontier, is read as none;
// one whose clock counts steps has them read as requests.
function load(key: string): State | undefined {
  try {
    const s: State = JSON.parse(readFileSync(path.join(stateDir, `${key}.json`), 'utf8'))
    if (s.skillList) s.skillList.rules = skillRulesNow(s.skillList.rules)
    if (s.applied) s.applied = clockNow(s.applied)
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

// A conversation's records (summary.ts), how many of the oldest the memoir
// holds, and the dollars its summary forks have cost. They are kept apart from
// its state, which a request answered after a summary fork began, and prepared
// before it ended, would save over.
type Summaries = { chain: Summary[]; merged?: number; spent: number; requests: number }
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
  if (!c) {
    let spentSoFar = cost(history(journalOf(key)), ttlMs)
    for (const b of bareLines(journalOf(key))) spentSoFar = addBare(spentSoFar, b)
    current.set(key, (c = { stats: latest(journalOf(key)), cost: spentSoFar }))
  }
  return c
}

// The requests answered since the proxy started that no journal line was
// written for, which `shaver info` and proxy.log report.
let missed = 0

// Journals a request the API answered, a client's or a fork's, and reports it
// missed if that wrote no line.
function journaling(to: string, f: () => void): void {
  const before = written
  try {
    f()
  } finally {
    if (written === before) {
      missed++
      console.error(`${new Date().toISOString()} shaver: journal missed a request to ${to}`)
    }
  }
}
const latestOf = (key: string) => currentOf(key).stats

// What a request becomes: the body to send, and what to record once it is
// answered.
type Prepared = { body: Buffer; key: string; proto: Protocol; model: string; provider?: string; applied: Clock; entries: Record<string, number>; touched: string[]; thinking: Record<string, number>; summarized: number; merged: number; offered?: number; skillList?: SkillList; summaryFork?: (tokens: number[]) => SummaryFork | undefined; stats?: Stats; sent: Sent; suggestion: boolean; logDir?: string; logLine?: Record<string, unknown>; counted?: (attribution: unknown) => Counted | undefined; messages: ApiMsg[] }

// Trims a request, given as the core's (protocol.ts). Only requests with tools
// are trimmed: those are the main loop and subagents. Side requests (Claude
// Code's titles, Codex's compactions) are sent as they came, and journaled
// bare (journal.ts).
//
// Where the cache writes an entry at each request's end by itself (automatic),
// there is no breakpoint to add, so no anchor.
function prepare(proto: Protocol, h: Harness | undefined, key: string, body: Canonical, { render, ids, counted }: Wire, params: Record<string, unknown>, now: number): Prepared | undefined {
  const msgs: ApiMsg[] | undefined = body.messages
  if (!Array.isArray(msgs) || !msgs.length || !body.tools?.length) return
  const conv = h?.conventions ?? NO_CONVENTIONS
  const auto = proto.automatic
  const s = load(key)
  const suggestion = isSuggestion(msgs)
  const own = withoutSuggestion(msgs)
  const held = heldTo(s?.applied ?? { requests: 0, turns: 0 }, own)
  const clock = clockOf(own)
  const marked = markedTtl(body)
  const model = { ...modelOf(body.model, body.provider), ...(marked && { ttl: marked }) }
  const entries = Object.fromEntries(Object.entries(s?.entries ?? {}).filter(([, t]) => now - t <= lifetimeMs(model.ttl, ttlMs)))
  const live = new Set(Object.keys(entries))
  // What it takes out of the base: deferred tools, and skills off the list.
  const toolRules = toolRulesOf(policy, h?.name)
  const dropped = h && toolRules ? dropTools(body, toolRules, h.alwaysLoaded) : 0
  const deferred = proto.defers && h?.defers && toolRules ? forceDefer(body, toolRules, h.alwaysLoaded, proto.searchTool) : 0
  const skillList = skillListOf(s, live.size > 0, now)
  const { cut: skills, trimmed: skillsTrimmed } = skillList ? shaveSkills(body, skillList.rules) : { cut: 0 }
  const seed = seedOf(body.model, body.tools, body.system)
  const thinking = new Map(Object.entries(s?.thinking ?? {}))
  // The records it sends, and how many of them as the memoir: as sent before,
  // and on a cold cache, all there are.
  const file = summaryAt ? loadSummaries(key) : undefined
  const chain = file ? validChain(file.chain, msgs) : []
  const before = Math.min(s?.summarized ?? 0, chain.length)
  const mergedBefore = Math.min(s?.merged ?? 0, before)
  let records = before
  let merged = mergedBefore
  let keep = summarized(apply(msgs, parts, held, conv), msgs, chain.slice(0, records), merged)
  const cold = (ps: ReturnType<typeof positionsOf>) => ps.some((q) => q.breakpoint) && readThrough(ps, live, model.lookback) < 0
  const allMerged = Math.min(file?.merged ?? 0, chain.length)
  let covers: string[] | undefined
  if ((records < chain.length || merged < allMerged) && cold(positionsOf(keep.msgs, seed, thinking, auto))) {
    if (records < chain.length) covers = coveredBy(keep, msgs, chain, records).map(keyOf)
    records = chain.length
    merged = allMerged
    keep = summarized(apply(msgs, parts, held, conv), msgs, chain, merged)
  }
  // One more breakpoint where the messages stop matching them settled
  // (anchored), unless it leaves less read from the cache.
  const end = auto ? undefined : settledEnd(keep.msgs, summarized(fullyTrimmed(msgs, parts, conv), msgs, chain.slice(0, records), merged).msgs, seed, thinking)
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
  const horizon = model.horizon(latestOf(key)?.requests ?? 0)
  if (clock.requests > held.requests || clock.turns > held.turns) {
    next = summarized(apply(msgs, parts, clock, conv), msgs, chain.slice(0, records), merged)
    d = decide(anchor(keep.msgs), anchor(next.msgs), live, seed, model, thinking, auto, horizon)
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
  const ends = trimmedEnd(msgs, parts, applied)
  const sentEnd = (end: number) => sent.origin.filter((i) => i < end).length
  const trimmed = { tools: sentEnd(ends.tools), reasoning: sentEnd(ends.reasoning) }
  const time = new Date(now).toISOString()
  // A record takes its turns' prompts out of the messages; the stats count them still.
  const described = { ...describe(body, trimmed, time, d?.advanced || records > before || merged > mergedBefore, conv), turns: msgs.filter(isPrompt).length }
  if (deferred + dropped) described.defs.deferred = deferred + dropped
  if (skills) described.defs.skills = skills
  if (skillsTrimmed) splitShaved(described, skillsTrimmed)
  if (marked) described.ttl = marked
  if (covers) described.covers = covers
  const last = latestOf(key)
  const lastPart = (last?.suggestion ? last.parts.at(-2) : last?.parts.at(-1))?.key
  if (h?.resends && lastPart && !described.parts.some((q) => q.key === lastPart)) described.compacted = true
  // Each record is dated by the first message it covers, the memoir by its first record's.
  const starts = startsOf(msgs, chain.slice(0, records))
  described.parts.filter((q) => q.kinds.memoir).forEach((q) => (q.born = bornFrom(latestOf(key), msgs, starts[0])))
  described.parts.filter((q) => q.kinds.summary).forEach((q, k) => (q.born = bornFrom(latestOf(key), msgs, starts[merged + k])))
  if (suggestion) described.suggestion = true
  const after = summaryAt && (model.summaryThreshold ?? summaryAt)
  // Whether to send a summary fork is known once the response's counts are in.
  const summaryFork = after && !suggestion && pos.some((q) => q.breakpoint) ? (tokens: number[]) => summaryForkOf(sent, msgs, chain, s?.offered ?? 0, after, thinking, tokens, (m) => bornOf(latestOf(key), m)) : undefined
  const p: Prepared = { body: Buffer.from(JSON.stringify(render(body))), key, proto, model: body.model, provider: body.provider, applied, entries, touched, thinking: s?.thinking ?? {}, summarized: records, merged, offered: s?.offered, skillList, summaryFork, stats: latestOf(key), sent: described, suggestion, messages: body.messages, ...(counted && { counted: (at: unknown) => counted(body.messages, at) }) }
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
        requests: clock.requests,
        turns: clock.turns,
        transitions: transitions(keep, next),
        context,
        // To test the anchor breakpoint's efficacy: the decision without it,
        // or the entry it keeps, which lookback would otherwise still find.
        // Remove this (and the logged field) once we're confident in it.
        unanchored: (({ advanced, extraChars }) => ({ advanced, extraChars }))(decide(keep.msgs, next.msgs, new Set([...live].filter((e) => e !== end)), seed, model, thinking, auto, horizon)),
      })
    }
    const predictedCachedChars = pos.slice(0, r + 1).reduce((n, q) => n + q.size, 0)
    // The messages as the client sent them, when they went up changed, so
    // what was taken (a newest answer's thinking, say) can be rebuilt.
    const changed = msgs.length !== body.messages.length || msgs.some((m, i) => JSON.stringify(m) !== JSON.stringify(body.messages[i]))
    p.logLine = { event: 'request', time, model: body.model, provider: body.provider, protocol: proto.name, params, ...(records && { summaries: records }), predictedCachedChars, breakpoints: pos.filter((q) => q.breakpoint).length, trimmedEnd: trimmed, ...(ids && { headIds: ids.head }), parts: writeParts(p.logDir, body.messages, ids?.of), ...(changed && { received: writeParts(p.logDir, msgs).map((q) => q.hash) }), ...writeDefs(p.logDir, body as Parameters<typeof writeDefs>[1]) }
  }
  return p
}

// A conversation's key, which names its state, journal and log dir. A
// conversation is one message history that only grows: the proxy's applied
// clock counts requests and turns into it, and its cache entries are prefixes of
// it, so neither means anything for another history. The protocol makes the
// key unique among the conversations it serves (harness.ts, conversationId).

// The answer to `shaver policy`: the policy file as it is now, which may differ
// from what was loaded at startup if it was edited since.
function policyText(): string {
  try {
    return '`' + a.policy + '`:\n```json\n' + readFileSync(a.policy, 'utf8').trimEnd() + '\n```'
  } catch {
    return `Shaver policy file not found, should be at ${a.policy}`
  }
}

// The answer to `shaver info`: the conversation's latest answered request,
// from its journal (stats.ts), or before there is one, this request estimated
// as it will be sent once the command is answered, tools deferred.
function stats(proto: Protocol, h: Harness | undefined, key: string, body: Canonical): string {
  const sent = structuredClone({ ...body, messages: withoutPending(body.messages) })
  const toolRules = toolRulesOf(policy, h?.name)
  if (h && toolRules) dropTools(sent, toolRules, h.alwaysLoaded)
  if (proto.defers && h?.defers && toolRules) forceDefer(sent, toolRules, h.alwaysLoaded, proto.searchTool)
  const trimmed = policy.skill_shaver_rules ? shaveSkills(sent, policy.skill_shaver_rules).trimmed : undefined
  const { stats: s, cost: c } = currentOf(key)
  const { spent: summaryForks, requests, chain } = loadSummaries(key)
  // `shaver optimize` requests made here are charged to the skill list.
  const lines = [...forks(journalOf(key))].reduce((n, f) => n + (f.kind === 'optimize' && f.usage ? spent(f.model, f.provider, f.usage) : 0), 0)
  const withSummaryForks = c && { ...c, actual: c.actual + summaryForks + lines, saved: { ...c.saved, [SUMMARIES]: (c.saved[SUMMARIES] ?? 0) - summaryForks, 'skills-shaved': (c.saved['skills-shaved'] ?? 0) - lines } }
  // Each summary request is running, or left a record or none. A record no
  // longer fitting the messages is dropped, like one replaced or none at all.
  const valid = validChain(chain, sent.messages).length
  const applied = Math.min(load(key)?.summarized ?? 0, valid)
  const pending = valid - applied + (summaryForking.has(key) ? 1 : 0)
  const summaryRequests = { applied, pending, dropped: requests - applied - pending }
  const described = describe(sent, { tools: 0, reasoning: 0 }, new Date().toISOString(), false, h?.conventions ?? NO_CONVENTIONS)
  if (trimmed) splitShaved(described, trimmed)
  const text = s ? render(s, key, false, withSummaryForks, summaryRequests) : render(estimate(described), key, true, withSummaryForks, summaryRequests)
  const warning = missed ? `\n\nshaver: since it started, the journal missed ${countOf(missed, 'request')}; see proxy.log` : ''
  return '```\n' + text + warning + '\n```'
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

// What each thinking block sent back billed, where the API counted it, in
// place of thinkingOf's guess: its count less its visible text's worth, which
// trim.ts's sizeOf counts apart.
function billedThinking(msgs: readonly ApiMsg[], billed: ReadonlyMap<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of msgs)
    for (const b of blocks(m)) {
      const n = typeof b.signature === 'string' ? billed.get(b.signature) : undefined
      if (b.type === 'thinking' && n !== undefined) out[hash(String(b.signature))] = Math.max(0, Math.round(n - TEXT_TOKENS * (JSON.stringify(b).length - String(b.signature).length)))
    }
  return out
}

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'keep-alive', 'upgrade'])
// The account's usage limits from the latest answer each protocol's API sent,
// which Claude Code shows in the status line. Answers made here carry them
// too, or the status line loses them for that turn.
const limits = new Map<Protocol, Record<string, string>>()
// The headers a request is sent on with: the client's, but for hop-by-hop
// ones, and the encoding of a body the proxy decompressed.
function forwarded(from: IncomingHttpHeaders, zstd: boolean): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(from)) if (!HOP.has(k) && !(zstd && k === 'content-encoding') && v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v
  return headers
}

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

// Responses tool-search probes: this Codex request with the policy's
// deferrals, and tiny standalone ones (the client-executed round trip, a
// search the backend runs, and deferral inside a namespace) that take only
// its route, auth and model.
async function probeCodexToolSearch(context: { target: string; headers: Record<string, string>; model: string; real?: { body: Canonical; render: Wire['render']; rules: readonly ToolRule[]; always: readonly string[] } }): Promise<Record<string, unknown>> {
  const functionTool = {
    type: 'function', name: 'shaver_probe_confirm', description: 'Confirms this tool-search probe.', defer_loading: true,
    parameters: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false },
  }
  // A search the client answers, which both of Codex's routes accept.
  const searchTool = {
    type: 'tool_search', execution: 'client', description: 'Find tools to use for the current task.',
    parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'], additionalProperties: false },
  }
  const usage: Record<string, Record<string, number>> = {}
  const send = async (stage: string, body: Record<string, unknown>) => {
    const response = await fetch(context.target, {
      method: 'POST', headers: context.headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    })
    const text = await response.text()
    let data: any
    try { data = JSON.parse(text) } catch {
      // Codex's Responses backend requires streaming. Read its terminal event
      // into the same shape as a non-streaming Responses object; its output can
      // be empty with the items sent only as their own events.
      const items: unknown[] = []
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('data: ')) continue
        try {
          const event = JSON.parse(line.slice(6))
          if (event.type === 'response.completed' || event.type === 'response.failed' || event.type === 'response.incomplete') data = event.response
          else if (event.type === 'response.output_item.done') items.push(event.item)
          else if (event.type === 'error') data = { error: event.error }
        } catch { /* ignore non-JSON SSE data */ }
      }
      if (data && !data.output?.length && items.length) data.output = items
    }
    if (data?.usage) {
      const u = data.usage
      usage[stage] = Object.fromEntries(['input_tokens', 'input_tokens_details', 'output_tokens', 'total_tokens'].flatMap((k) =>
        typeof u[k] === 'number' ? [[k, u[k]]] : k === 'input_tokens_details' && typeof u[k]?.cached_tokens === 'number' ? [['cached_input_tokens', u[k].cached_tokens]] : []))
    }
    return { response, text, data }
  }
  const base = { model: context.model, store: false, stream: true, parallel_tool_calls: false, max_output_tokens: 48, reasoning: { context: 'all_turns' } }
  const ask = (text: string) => [{ role: 'user', content: [{ type: 'input_text', text }] }]
  // A search the backend runs itself, with no client round trip: execution
  // left off, and asked for as server.
  const hosted = async (stage: string, tool: Record<string, unknown>) => {
    try {
      const r = await send(stage, { ...base, input: ask('Find the harmless probe function and call it with marker set to probe.'), tools: [tool, functionTool], tool_choice: 'required' })
      if (!r.response.ok) return { http: r.response.status, error: r.data?.error?.message ?? r.text.slice(0, 1000) }
      return { output: r.data?.output?.map((item: any) => ({ type: item.type, name: item.name, execution: item.execution, status: item.status })) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  // Whether a deferred function inside a namespace, as Codex sends its tools,
  // is hidden: its input tokens should match the request without it.
  const nested = async (stage: string, tools: unknown[]) => {
    try {
      const r = await send(stage, { ...base, input: ask('Reply with ok.'), tools: [searchTool, ...tools] })
      return r.response.ok ? usage[stage]?.input_tokens : { http: r.response.status, error: r.data?.error?.message ?? r.text.slice(0, 1000) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  // The search the client answers, as Codex does.
  const client = async (): Promise<Record<string, unknown>> => {
    try {
      const first = await send('search', { ...base, input: ask('Find the harmless probe function so I can confirm tool search works.'), tools: [searchTool, functionTool], tool_choice: 'required' })
      if (!first.response.ok) return { result: 'rejected', stage: 'search', status: first.response.status, error: first.data?.error?.message ?? first.text.slice(0, 1000) }
      const searchCall = first.data?.output?.find((item: any) => item.type === 'tool_search_call' && item.execution === 'client')
      if (!searchCall?.call_id) return { result: 'inconclusive', stage: 'search', detail: 'Response did not contain a client tool_search_call.' }
      // The call as the backend sent it, which Codex answers: it names the field
      // the search is asked in.
      const search_call = Object.fromEntries(Object.entries(searchCall).filter(([k]) => !['id', 'call_id'].includes(k)))
      const second = await send('confirmation', {
        ...base,
        input: [
          ...first.data.output,
          { type: 'tool_search_output', execution: 'client', call_id: searchCall.call_id, status: 'completed', tools: [functionTool] },
          ...ask('Call shaver_probe_confirm now with marker set to probe.'),
        ],
        tool_choice: { type: 'function', name: 'shaver_probe_confirm' },
      })
      if (!second.response.ok) return { result: 'rejected', stage: 'confirmation', status: second.response.status, error: second.data?.error?.message ?? second.text.slice(0, 1000), search_call }
      const confirmed = second.data?.output?.some((item: any) => item.type === 'function_call' && item.name === 'shaver_probe_confirm')
      return { result: confirmed ? 'supported' : 'inconclusive', detail: confirmed ? 'Client tool-search round trip returned the probe function call; it was not executed.' : 'Follow-up did not return the probe function call.', response_status: second.data?.status, incomplete_details: second.data?.incomplete_details, error: second.data?.error, output: second.data?.output?.map((item: any) => ({ type: item.type, name: item.name, status: item.status })), search_call }
    } catch (error) {
      return { result: 'error', detail: error instanceof Error ? error.message : String(error) }
    }
  }
  // This Codex request as the proxy sends it, with one short message for its
  // history: the input tokens with the policy's deferrals and without, where
  // each deferred tool sits, and what the model does when asked for one.
  const real = async (): Promise<Record<string, unknown>> => {
    if (!context.real) return { result: 'skipped' }
    const { body, render, rules, always } = context.real
    const tools = (body.tools ?? []).map(({ defer_loading, ...t }) => t)
    const deferred = { ...body, tools: [...tools] }
    if (!forceDefer(deferred, rules, always, searchTool)) return { result: 'inconclusive', detail: 'The policy defers none of this request\'s tools.' }
    const names = (deferred.tools ?? []).filter((t) => t.defer_loading).map((t) => t.name)
    const loaded = { ...deferred, tools: (deferred.tools ?? []).map(({ defer_loading, ...t }) => t) }
    const asked = (c: Canonical, text: string) => render({ ...c, messages: [{ role: 'user', content: [{ type: 'text', text }] }] }) as any
    const sent = asked(deferred, 'Reply with ok.')
    const where: unknown[] = []
    const walk = (list: any[], at: string, prefix = '') => list.forEach((t) => t.type === 'namespace' && t.tools
      ? walk(t.tools, at, `${prefix}${t.name}.`)
      : names.includes(`${prefix}${t.name ?? t.type}`) && where.push({ name: `${prefix}${t.name ?? t.type}`, at, defer_loading: t.defer_loading ?? false }))
    walk(sent.tools ?? [], 'tools')
    for (const it of sent.input ?? []) if (it.type === 'additional_tools') walk(it.tools ?? [], 'input additional_tools')
    const tokens = async (stage: string, wire: any) => {
      const r = await send(stage, { ...wire, store: false, stream: true, max_output_tokens: 48 })
      return r.response.ok ? usage[stage]?.input_tokens : { http: r.response.status, error: r.data?.error?.message ?? r.text.slice(0, 1000) }
    }
    const call = async (stage: string, wire: any) => {
      const r = await send(stage, { ...wire, store: false, stream: true, max_output_tokens: 400 })
      return r.response.ok ? r.data?.output?.map((item: any) => ({ type: item.type, name: item.name, namespace: item.namespace, execution: item.execution })) : { http: r.response.status, error: r.data?.error?.message ?? r.text.slice(0, 1000) }
    }
    const ask = `Call your ${names[0]} tool now, with any valid arguments.`
    try {
      const input_tokens = { deferred: await tokens('real_deferred', sent), loaded: await tokens('real_loaded', asked(loaded, 'Reply with ok.')) }
      const asked_for = { tool: names[0], deferred: await call('real_asked', asked(deferred, ask)) }
      return { deferred: names, where, input_tokens, asked_for, detail: 'Deferral works if its input tokens are well below loaded, and asked_for starts with a tool_search_call.' }
    } catch (error) {
      return { result: 'error', detail: error instanceof Error ? error.message : String(error) }
    }
  }
  const loadedTool = { ...functionTool, defer_loading: undefined }
  const space = (tool: unknown) => ({ type: 'namespace', name: 'shaver_probe', description: 'Probe tools.', tools: [tool] })
  return {
    real: await real(),
    client: await client(),
    hosted: { bare: await hosted('hosted_bare', { type: 'tool_search' }), server: await hosted('hosted_server', { type: 'tool_search', execution: 'server' }) },
    namespace: {
      input_tokens: { none: await nested('nested_none', []), deferred: await nested('nested_deferred', [space(functionTool)]), loaded: await nested('nested_loaded', [space(loadedTool)]) },
      detail: 'Deferral inside a namespace works if deferred is near none and well below loaded.',
    },
    usage,
  }
}

// The protocol a path is, after any /via/; Messages for any other path, which
// is passed through. ChatGPT's backend for Codex runs no tool search itself,
// so nothing is deferred there.
const protocolOf = (url: string, upstream = '') => {
  const p = [MESSAGES, CHAT, RESPONSES].find((p) => p.serves(url.split('?')[0])) ?? MESSAGES
  return p === RESPONSES && /^https:\/\/chatgpt\.com(\/|$)/.test(upstream) ? { ...p, defers: false } : p
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const arrived = Date.now()
  // Codex's OpenAI provider compresses what it sends with zstd; it's read here
  // and sent on as it reads.
  const zstd = req.headers['content-encoding'] === 'zstd'
  const original = zstd ? zstdDecompressSync(await readBody(req)) : await readBody(req)
  let raw = original
  const r = route(req.url ?? '/', a.upstream)
  const proto = 'error' in r ? protocolOf('/') : protocolOf(r.url, r.upstream)
  if (!localHost(req.headers.host)) return refuse(res, proto, 403, `shaver proxy: refused a request for Host ${req.headers.host}`)
  if ('error' in r) return refuse(res, proto, 400, `shaver proxy: ${r.error}`)
  const { upstream, url } = r
  const h = harnessOf(r.harness, req.headers)
  if (h && 'error' in h) return refuse(res, proto, 400, `shaver proxy: ${h.error}`)
  // bin/run-proxy --restart and --stop stop the proxy with this. The header
  // keeps a web page from sending it: browsers send a custom header only after a
  // CORS check this proxy doesn't answer.
  if (req.method === 'POST' && url === '/shaver/shutdown' && req.headers['x-shaver'] === 'shutdown') {
    console.error('shaver: shutting down, as asked')
    return void res.end('stopping\n', () => process.exit(0))
  }
  // bin/run-proxy asks this to tell whether the proxy on its port runs from its
  // repo (one from elsewhere is restarted, keeping logging) and from its commit.
  if (req.method === 'GET' && url === '/shaver/procinfo' && req.headers['x-shaver'] === 'procinfo') {
    return void res.end(`shaver repo: ${path.resolve(import.meta.dirname, '..')}\nshaver commit: ${commit}\nshaver logging: ${a['log-step-events'] ? 'on' : 'off'}\n`)
  }
  // A WebSocket a client tries first (Codex's and OpenCode's OpenAI providers)
  // is refused with 426, which sends it straight to HTTP: Codex retried a
  // refused one for ~8s first. Codex over WebSockets sends only what's new.
  if (req.headers.upgrade) return void res.writeHead(426).end()
  let p: Prepared | undefined
  // The conversation whose waiting commands are answered if this request's
  // response ends the turn, and the request as forwarded.
  let turnEnd: { key: string; body: Canonical; render: Wire['render'] } | undefined
  // Why a request the API answers would be journaled bare, if it's sent as it came.
  let why: Why = 'side'
  let c: ReturnType<Protocol['canonical']> | undefined
  let params: Record<string, unknown> = {}
  // The conversation's key, from the messages as the client sent them, before any are stripped (harness.ts).
  let key: string | undefined
  const served = req.method === 'POST' && proto.serves(url.split('?')[0]) && raw.length > 0
  if (served) {
    // `shaver` commands are answered here; answered ones are stripped (command.ts).
    try {
      const wire = JSON.parse(raw.toString('utf8'))
      params = paramsOf(wire)
      c = proto.canonical(wire)
    } catch (err) {
      why = 'unread'
      console.error('shaver: request not read:', err)
    }
    const body = c?.body
    key = body && Array.isArray(body.messages) && body.messages.length ? conversationId(h, proto.name, body, req.headers) : undefined
    try {
      if (c && body && key) {
        const msgs = stripCommands(body.messages)
        // Read before stripping: an answer to `shaver optimize` is one only after its reply.
        const command = body.tools?.length && pendingCommand(body.messages)
        if (command) {
          const r = proto.replying(body.model, !!body.stream, latestOf(key)?.inputTokens ?? 0)
          res.writeHead(200, { ...limits.get(proto), 'content-type': body.stream ? 'text/event-stream' : 'application/json' })
          res.write(r.start)
          // What an answer says before it's done shows at once in a stream.
          let said = ''
          const say = (t: string) => {
            said += t
            res.write(r.text(t))
          }
          const text = await answerOf(command, proto, h, key, { ...body, messages: msgs }, c.render, upstream + url, forwarded(req.headers, zstd), say).catch(internalError)
          return void res.end(r.text(text) + r.end(said + text))
        }
        // Commands sent mid-turn wait for a response that ends the turn.
        const mid = body.tools?.length ? midTurnCommands(body.messages) : []
        if (mid.length || waiting.size) {
          if (mid.length) waiting.set(key, [...(waiting.get(key) ?? []), ...mid])
          if (body.stream && waiting.has(key)) turnEnd = { key, body: structuredClone({ ...body, messages: msgs }), render: c.render }
        }
        if (msgs.length < body.messages.length || msgs.some((m, i) => m !== body.messages[i])) {
          body.messages = msgs
          raw = Buffer.from(JSON.stringify(c.render(body)))
        }
      }
    } catch (err) {
      console.error('shaver: commands left in:', err)
    }
    try {
      if (c && body && key) p = prepare(proto, h, key, body, c, params, Date.now())
    } catch (err) {
      why = 'untrimmed'
      console.error('shaver: request left untrimmed:', err)
    }
  }
  const headers = forwarded(req.headers, zstd)
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
  // never costs the user a turn, and journaled as resent.
  let resent: Prepared | undefined
  if ((p || raw !== original) && up.status === 400) {
    console.error(`shaver: changed request refused, sent as it came: ${(await up.text()).slice(0, 500)}`)
    ;[resent, p] = [p, undefined]
    up = await send(original)
  }
  const out: Record<string, string> = {}
  up.headers.forEach((v, k) => {
    if (k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding') out[k] = v
  })
  const re = proto.limits
  if (re && up.status === 200 && Object.keys(out).some((k) => re.test(k))) limits.set(proto, Object.fromEntries(Object.entries(out).filter(([k]) => re.test(k))))
  // An error answer goes to proxy.log whether or not requests are logged, so
  // the upstream's own text is always on record.
  if (up.status >= 400) {
    const text = Buffer.from(await up.arrayBuffer())
    console.error(`${new Date().toISOString()} shaver: upstream answered ${up.status} to ${req.method} ${upstream}${url.split('?')[0]}: ${text.toString('utf8').slice(0, 2000)}`)
    res.writeHead(up.status, out)
    return void res.end(text)
  }
  res.writeHead(up.status, out)
  // The answer's state is saved once it is complete, before the client sees
  // its end: Codex sends the next request then, before the stream closes.
  // Every request the API answers is journaled: as answered once its answer
  // is complete, and bare when it was sent as it came or cut off, with the
  // usage read by then. A cut-off request leaves the state as it was, so its
  // trim is decided again and journaled with the next.
  let finished = false
  const finish = (cut: boolean) => {
    if (finished || !served || up.status !== 200) return
    finished = true
    journaling(url.split('?')[0], () => {
      if (p && !cut) answered(p, usage, upstream + url, headers)
      else if (resent && !cut) answeredResent(resent, usage)
      else {
        const q = p ?? resent
        const body = c?.body
        const u = usage.end().usage
        const provider = q ? q.provider : body?.provider
        const b: BareLine = { time: q?.sent.time ?? new Date(arrived).toISOString(), model: q?.model ?? body?.model ?? 'unknown', ...(provider && { provider }), ...(u && { usage: u }), why: cut ? 'cut off' : why }
        // One not read has no conversation to go with, so its harness's own.
        const bare = q?.key ?? (key ? sideKey(stateDir, key) : `${h?.name ?? proto.name}-unread`)
        const log = !a['log-step-events'] ? undefined : q ? q.logLine && { dir: q.logDir!, line: q.logLine } : body && { dir: path.join(logRoot, bare), side: body, protocol: proto.name }
        answeredBare(bare, b, log)
      }
    })
  }
  // A response ending the turn gets the answers to the commands sent during
  // it, after the request is journaled, so `shaver info` counts it.
  const write = (s: string | Uint8Array) => res.destroyed || res.write(s)
  const held = turnEnd && proto.holdClose(write)
  try {
    if (up.body)
      for await (const chunk of up.body) {
        usage.push(chunk)
        if (usage.done) finish(false)
        if (held) held.push(chunk)
        else write(chunk)
      }
  } catch (err) {
    finish(true)
    throw err
  }
  if (held && turnEnd) {
    finish(false)
    const commands = waiting.get(turnEnd.key)
    if (held.ended && commands && !res.destroyed) {
      waiting.delete(turnEnd.key)
      for (const command of commands) {
        let said = ''
        const text = await answerOf(command, proto, h, turnEnd.key, turnEnd.body, turnEnd.render, upstream + url, headers, (t) => (said += t)).catch(internalError)
        write(held.add(answeredMidTurn(command) + said + text))
      }
    }
    write(held.rest())
  }
  res.end()
  finish(false)
}

// What answers a command, for the request `body` of conversation `key`, the
// command stripped; `say` gets any text ready before the rest, which follows it.
async function answerOf(command: string, proto: Protocol, h: Harness | undefined, key: string, body: Canonical, render: Wire['render'], target: string, headers: Record<string, string>, say: (text: string) => void): Promise<string> {
  if (command.startsWith(':shaver optimize')) return optimize(command, proto, h, key, body, render, target, headers, say)
  if (command === ':shaver probe-codex-tool-search') {
    if (proto.name !== 'responses' || h?.name !== 'codex') return 'This probe is available only through a Codex Responses session.'
    const probeHeaders = { ...headers }
    for (const name of ['accept', 'accept-encoding', 'content-length', 'content-type', 'host', 'connection']) delete probeHeaders[name]
    probeHeaders['content-type'] = 'application/json'
    probeHeaders.accept = 'application/json'
    const rules = toolRulesOf(policy, h.name)
    const result = await probeCodexToolSearch({ target, headers: probeHeaders, model: body.model, ...(rules && { real: { body, render, rules, always: h.alwaysLoaded } }) })
    return 'Codex tool-search probe:\n```json\n' + JSON.stringify(result, null, 2) + '\n```'
  }
  if (command === ':shaver policy') return policyText()
  if (command === ':shaver info all') return '```\n' + totals(stateDir, ttlMs) + '\n```'
  return stats(proto, h, key, body)
}

// Records an answered request: its stats, cost and cache entries, the
// conversation's state, any summary fork due and its log line.
function answered(p: Prepared, usage: UsageReader, target: string, headers: Record<string, string>): void {
  const { usage: u, content, attribution } = usage.end()
  const now = Date.now()
  const entries = { ...p.entries, ...Object.fromEntries(p.touched.map((h) => [h, now])) }
  const inputTokens = u ? u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0
  // With no usage there are no counts to take the stats on from, so it's
  // journaled bare, and like one cut off leaves the state as it was.
  if (!u || !inputTokens) return answeredBare(p.key, { time: p.sent.time, model: p.model, ...(p.provider && { provider: p.provider }), why: 'no usage' }, p.logLine && { dir: p.logDir!, line: p.logLine })
  const c = attribution !== undefined ? p.counted?.(attribution) : undefined
  const next = observe(p.stats, p.sent, inputTokens, u.output_tokens ?? 0, c && { defs: c.head, parts: c.messages, kinds: c.kinds })
  const was = currentOf(p.key)
  record(journalOf(p.key), was.stats, next, u)
  current.set(p.key, { stats: next, cost: add(was.cost, was.stats, next, u, ttlMs) })
  const due = p.summaryFork && !p.suggestion && !summaryForking.has(p.key) ? p.summaryFork(settled(p.sent, next.tokens)) : undefined
  save(p.key, { applied: p.applied, entries, thinking: { ...p.thinking, ...thinkingOf(u, content), ...(c && billedThinking(p.messages, c.reasoning)) }, summarized: p.summarized, merged: p.merged, offered: due?.current ?? p.offered, skillList: p.skillList })
  if (due) void summarize(p, due, target, headers)
  if (p.logDir && p.logLine) writeLine(p.logDir, { ...withReceivedDelta(p.logDir, p.logLine), ...usageFields(u), ...(attribution !== undefined && { attribution }) })
}

// A log line's counts from a request's usage.
const usageFields = (u: Usage | undefined) =>
  u && {
    inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    cachedTokens: u.cache_read_input_tokens ?? 0,
    writtenTokens60m: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    writtenTokens5m: (u.cache_creation_input_tokens ?? 0) - (u.cache_creation?.ephemeral_1h_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
  }

// Records a request answered as it came after its changed form was refused:
// its line in the journal and its cost. The proxy's state stays as it was,
// since none of this request's trim went up. A conversation with no journal
// yet has no stats to count it in, so it's journaled bare.
function answeredResent(p: Prepared, usage: UsageReader): void {
  const { usage: u } = usage.end()
  const was = currentOf(p.key)
  if (!u || !was.stats) return answeredBare(p.key, { time: p.sent.time, model: p.model, ...(p.provider && { provider: p.provider }), ...(u && { usage: u }), why: u ? 'resent' : 'no usage' })
  const stats = recordResent(journalOf(p.key), was.stats, new Date().toISOString(), u)
  current.set(p.key, { stats, cost: addResent(was.cost, stats, u) })
}

// Records a request journaled bare (journal.ts): its line and its cost, and
// with logging its log line. A request the proxy prepared is logged as
// requests are, marked bare; a side request as an event of its own, its
// messages whole, so the logs' request lines stay the conversation's.
function answeredBare(key: string, b: BareLine, log?: { dir: string; line: Record<string, unknown> } | { dir: string; side: Canonical; protocol: string }): void {
  const was = currentOf(key)
  recordBare(journalOf(key), b)
  current.set(key, { ...was, cost: addBare(was.cost, b) })
  if (!log) return
  const counts = { ...usageFields(b.usage), bare: b.why }
  if ('line' in log) writeLine(log.dir, { ...withReceivedDelta(log.dir, log.line), ...counts })
  else writeLine(log.dir, { event: 'side', time: b.time, model: b.model, provider: b.provider, protocol: log.protocol, parts: writeParts(log.dir, log.side.messages), ...writeDefs(log.dir, log.side as Parameters<typeof writeDefs>[1]), ...counts })
}

// The conversations with a summary fork under way, which get no second one.
const summaryForking = new Set<string>()

// Sends a request the proxy makes of its own, a fork, and journals it as
// finish journals a client's: once the API answers 200, before the answer is
// used, with the usage its protocol reads in it, or marked cut off or no usage.
// Gives the answer and that usage; throws for any other status.
async function forked(p: Pick<Prepared, 'key' | 'proto' | 'model' | 'provider'>, kind: ForkKind, body: Canonical, target: string, headers: Record<string, string>): Promise<{ text: string; usage?: Usage }> {
  const r = await fetch(target, { method: 'POST', headers: { ...headers, accept: body.stream ? 'text/event-stream' : 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) })
  if (r.status !== 200) throw new Error(`${r.status} ${(await r.text()).slice(0, 500)}`)
  let text: string | undefined
  let usage: Usage | undefined
  try {
    text = await r.text()
    const reader = p.proto.usageReader()
    reader.push(Buffer.from(text))
    usage = reader.end().usage
  } finally {
    const line: ForkLine = { time: new Date().toISOString(), kind, model: p.model, ...(p.provider && { provider: p.provider }), ...(usage ? { usage } : { why: text === undefined ? 'cut off' : 'no usage' }) }
    journaling(`a ${kind} fork`, () => recordFork(journalOf(p.key), line))
  }
  return { text, usage }
}

// Sends a summary fork of an answered request for a record of its turns
// (summary.ts): the request as sent, with the instructions asked after it, in
// its protocol's form, not streamed. Its cost goes to the conversation's
// records whatever it answers. Its record follows the ones the summary fork
// started after; any later ones no longer fit the messages. Then the oldest
// go into the memoir, if the records hold too many tokens.
async function summarize(p: Prepared, f: SummaryFork, target: string, headers: Record<string, string>): Promise<void> {
  const { key, logDir } = p
  summaryForking.add(key)
  const began = Date.now()
  const body = p.proto.summaryFork(JSON.parse(p.body.toString('utf8')), instructions(f))
  const asked = { start: f.start, current: f.current, maxTokens: body.max_tokens, thinking: body.thinking }
  const before = loadSummaries(key)
  writeFileSync(summariesOf(key), JSON.stringify({ ...before, requests: before.requests + 1 }))
  try {
    const { text, usage } = await forked(p, 'summary', body, target, headers)
    if (usage) {
      const s = loadSummaries(key)
      writeFileSync(summariesOf(key), JSON.stringify({ ...s, spent: s.spent + spent(p.model, p.provider, usage) }))
    }
    const out = p.proto.summaryForkAnswer(text)
    const time = new Date().toISOString()
    const record = recordOf(out.content, f, time, usage?.output_tokens)
    let merged: number | undefined
    if (record) {
      const s = loadSummaries(key)
      const chain = [...s.chain.filter((r) => r.endsBefore <= f.start), record]
      merged = memoirAt ? mergedOf(chain, s.merged ?? 0, memoirAt) : 0
      writeFileSync(summariesOf(key), JSON.stringify({ ...s, chain, merged }))
    }
    if (logDir) writeLine(logDir, { event: 'summary', time, ...asked, ms: Date.now() - began, endsBefore: record?.endsBefore, chars: record?.text.length ?? 0, arcs: record?.arcs?.length, merged, usage })
  } catch (err) {
    console.error('shaver: summary fork failed:', err)
    if (logDir) writeLine(logDir, { event: 'summary', time: new Date().toISOString(), ...asked, ms: Date.now() - began, error: String(err).slice(0, 500) })
  } finally {
    summaryForking.delete(key)
  }
}

// `shaver optimize` (optimize.ts) measures here, asks the session's own model
// for the skills' lines, and puts the items picked in the policy, in memory
// and on disk, for every session the proxy serves, at once.

// What it asked last, waiting for an answer in the conversation it asked in.
let proposal: Proposal | undefined

// The skills part of the offer in the conversation `key`, worked out while
// the tools are chosen: what it has said so far, shown with it, and where it
// says the rest once the tools are answered.
let skillsLater: { key: string; skills: Promise<Skills>; said: string; say?: (text: string) => void } | undefined

// Shows what `later` said so far with `say`, and the rest as it is said.
function sayingTo(later: NonNullable<typeof skillsLater>, say: (text: string) => void) {
  if (later.said) say(later.said)
  later.say = say
}

// Commands sent mid-turn, by conversation, waiting for a response that ends
// the turn (command.ts). Kept in memory, so a restart drops them.
const waiting = new Map<string, string[]>()

// When lines were last applied: a conversation that took its skill rules
// before then takes the policy's on its next request, warm or not.
let skillsForcedAt = 0

// The request's base as the proxy sends it, through the message holding the
// skill list, with the skill rules the session sends it with, or `rules`, and
// the policy's tool rules, or `tools`. Forks start from it, so they read what
// the session has cached of it.
function baseOf(proto: Protocol, h: Harness | undefined, key: string, body: Canonical, render: Wire['render'], rules = sessionRules(key, body), tools = toolRulesOf(policy, h?.name)): Record<string, unknown> {
  const fork: Canonical = structuredClone({ ...body, messages: body.messages.slice(0, Math.max(listMessage(body), toolListMessage(body)) + 1) })
  if (h && tools) dropTools(fork, tools, h.alwaysLoaded)
  if (proto.defers && h?.defers && tools) forceDefer(fork, tools, h.alwaysLoaded, proto.searchTool)
  if (rules) shaveSkills(fork, rules)
  return render(fork) as Record<string, unknown>
}

function sessionRules(key: string, body: Canonical): readonly SkillRule[] | undefined {
  const now = Date.now()
  const s = load(key)
  const ttl = modelOf(body.model, body.provider).ttl
  return skillListOf(s, Object.values(s?.entries ?? {}).some((t) => now - t <= lifetimeMs(ttl, ttlMs)), now)?.rules
}

// The tokens a base holds, as its protocol's usage reports them: it is sent
// with a short question after it, so its answer costs little, and the
// question after the old and new bases alike drops out of their difference.
// No breakpoint is added at the base's end: Claude Code marks it only in a
// conversation's first request, and the next request after the lines change
// has none there to read an entry written at it.
async function promptOf(proto: Protocol, key: string, body: Canonical, base: Record<string, unknown>, target: string, headers: Record<string, string>): Promise<{ tokens: number; usage: Usage }> {
  const ask = proto.summaryFork(base, 'Reply with only: OK')
  if (proto === MESSAGES) ask.max_tokens = 16
  const { usage } = await forked({ key, proto, model: body.model, provider: body.provider }, 'optimize', ask, target, headers)
  if (!usage) throw new Error('no usage in the answer')
  return { tokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), usage }
}

const UNRETRIEVED = 'Shaver unable to retrieve skill details.'

// A command's answer threw: a bug, shown rather than breaking the stream.
function internalError(err: unknown): string {
  console.error('shaver: answering a command failed:', err)
  return `Shaver internal error: ${err instanceof Error ? err.message : err}`
}

async function optimize(command: string, proto: Protocol, h: Harness | undefined, key: string, body: Canonical, render: Wire['render'], target: string, headers: Record<string, string>, say: (text: string) => void): Promise<string> {
  if (command !== ':shaver optimize') {
    const shown = proposal?.key === key ? proposal : undefined
    if (!shown) return NOTHING
    // From the file as it is now, so edits by hand since the proxy started stay.
    let text: string
    try {
      text = readFileSync(a.policy, 'utf8')
    } catch {
      text = '{}\n'
    }
    const { reply, text: written, next } = afterAnswer(shown, command.slice(':shaver optimize '.length), text, a.policy)
    if (written !== text) {
      const now = parsePolicy(JSON.parse(written))
      writeFileSync(a.policy, written)
      if (shown.asking === 'skills') {
        policy.skill_shaver_rules = now.skill_shaver_rules
        skillsForcedAt = Date.now()
      } else policy.tool_shaver_rules = now.tool_shaver_rules
    }
    proposal = next
    const later = skillsLater?.key === key ? skillsLater : undefined
    if (shown.asking !== 'tools' || next?.asking !== 'skills' || !later) return reply
    say(`${reply}\n\n`)
    sayingTo(later, say)
    const asked = skillsAsked(next, await later.skills)
    proposal = asked.next
    skillsLater = undefined
    return asked.reply
  }
  // The tool rules as they are now, so a tools answer given while the skills
  // are measured doesn't change their base.
  const now = toolRulesOf(policy, h?.name) ?? []
  const measure = (rules?: readonly SkillRule[], tools = now) => promptOf(proto, key, body, baseOf(proto, h, key, body, render, rules, tools), target, headers)
  let base: ReturnType<typeof measure> | undefined
  const old = () => (base ??= measure())
  // The skills' lines are asked for while the tools are measured and chosen.
  const later = { key, said: '' } as NonNullable<typeof skillsLater>
  const relay = (text: string) => {
    later.said += text
    later.say?.(text)
  }
  const offer = toolOffer(proto, h, body)
  if (typeof offer !== 'string') say(ANALYZING_TOOLS)
  later.skills = skillsStage(proto, h, key, body, render, target, headers, relay, old, measure).catch((err) => ({ text: internalError(err), skills: [], lines: {}, trimmed: [] }))
  const none: Proposal = { key, asking: 'tools', tools: offer, skills: [], lines: {}, trimmed: [], changed: 0 }
  if (typeof offer === 'string') {
    say(`${offer}\n\n`)
    sayingTo(later, say)
    const { reply, next } = skillsAsked(none, await later.skills)
    proposal = next
    return reply
  }
  // The base as sent, without the offered tools, with none shaved, and with
  // the action done to all.
  const dropped = withPicked(now, offer.names, new Set(offer.names), 'drop', h!.alwaysLoaded)
  const measured = await Promise.all([old(), measure(undefined, dropped), measure(undefined, []), measure(undefined, offer.all)])
    .then(([o, w, whole, all]) => ({ own: o.tokens - w.tokens, blocked: whole.tokens - o.tokens, more: o.tokens - all.tokens }), (err: Error) => err)
  const { reply, next } = toolsAsked(key, { harness: h!, action: offer.action, names: offer.names, chosen: offer.chosen, text: toolsText(offer.names, offer.chosen, measured, offer.action) })!
  proposal = next
  skillsLater = later
  return reply
}

// The tools `shaver optimize` asks about deferring, or dropping where they
// can't be deferred, those the policy does that to already, and the rules
// doing it to them all, or why there are none.
function toolOffer(proto: Protocol, h: Harness | undefined, body: Canonical): { action: 'defer' | 'drop'; names: string[]; chosen: string[]; all: ToolRule[] } | string {
  // Responses with deferring off is ChatGPT's backend for Codex (protocolOf),
  // which runs no tool searches, so its tools can only be dropped.
  const action = proto.searchTool && !proto.defers ? 'drop' : 'defer'
  if ((action === 'defer' && !proto.defers) || !h?.defers) return "Shaver can't defer tools in this harness yet."
  if (action === 'defer' && !searchOn(body, proto.searchTool)) return 'Tool search is off, so no tools can be deferred. Start Claude Code with ENABLE_TOOL_SEARCH=true to turn it on.'
  const now = toolRulesOf(policy, h.name) ?? []
  const names = offerable(body, h.alwaysLoaded)
  if (!names.length) return `No tools but ${h.alwaysLoaded.join(', ')} are sent in full, so none can be ${action === 'drop' ? 'dropped' : 'deferred'}.`
  return { action, names, chosen: names.filter((name) => actionOf(now, name) === action), all: withPicked(now, names, new Set(names), action, h.alwaysLoaded) }
}

// The skills part of `shaver optimize`'s answer, with the skills in its
// table, a line for each, and those whose line is sent already. Lines are
// asked for only for the others.
async function skillsStage(proto: Protocol, h: Harness | undefined, key: string, body: Canonical, render: Wire['render'], target: string, headers: Record<string, string>, say: (text: string) => void, old: () => Promise<{ tokens: number }>, measure: (rules?: readonly SkillRule[]) => Promise<{ tokens: number }>): Promise<Skills> {
  const none = (text: string) => ({ text, skills: [], lines: {}, trimmed: [] })
  const listed = skillsOf(body)
  if (!listed.length) return none('No skills found in this session.')
  const shown = keptWhole(listed, policy.skill_shaver_rules ?? [])
  if (!shown.length) return none('All skills are already trimmed in shaver policy file, no changes needed.')
  const current: Record<string, string> = {}
  for (const s of shown) {
    const line = lineOf(s, policy.skill_shaver_rules ?? [])
    if (line !== undefined) current[s.name] = line
  }
  const generated = await linesFor(proto, h, key, body, render, target, headers, say, old, measure, shown, shown.filter((s) => current[s.name] === undefined))
  if (typeof generated === 'string') return none(generated)
  const lines = { ...current, ...generated }
  const lined = shown.filter((s) => lines[s.name])
  // Only if both answers were no JSON object or had every line too long.
  if (!lined.length) return none('Shaver skill optimization failed.')
  const saved = await Promise.all([old(), measure(withLines(policy.skill_shaver_rules ?? [], lined, lines))]).then(([o, w]) => o.tokens - w.tokens, (err: Error) => err)
  const trimmed = lined.filter((s) => current[s.name] !== undefined).map((s) => s.name)
  return { text: skillsText(lined, lines, new Set(trimmed), saved), skills: lined, lines, trimmed }
}

// Lines for `skills` from the session's model, or why there are none, saying
// what it is doing while it waits. The count and tokens it reports are for
// every skill in the table, `shown`, trimmed or not.
async function linesFor(proto: Protocol, h: Harness | undefined, key: string, body: Canonical, render: Wire['render'], target: string, headers: Record<string, string>, say: (text: string) => void, old: () => Promise<{ tokens: number }>, measure: (rules?: readonly SkillRule[]) => Promise<{ tokens: number }>, shown: Skill[], skills: Skill[]): Promise<Record<string, string> | string> {
  say(ANALYZING)
  // The lines are asked for while the skills' own tokens are measured: the
  // base as sent, without those skills' entries, and with no skill shaved.
  const without = measure([...shown.map((s) => ({ name: s.name, action: 'drop' as const })), ...(sessionRules(key, body) ?? [])])
  const whole = measure([])
  const asked = (async (): Promise<Record<string, string> | string> => {
    let lines: Record<string, string> = {}
    // A model's answer can leave skills out, so those are asked for once more.
    for (let tries = 0; tries < 2; tries++) {
      const ask = skills.filter((s) => !lines[s.name])
      if (!ask.length) break
      try {
        const { text } = await forked({ key, proto, model: body.model, provider: body.provider }, 'optimize', proto.summaryFork(baseOf(proto, h, key, body, render), linesPrompt(ask)), target, headers)
        const answer = proto.summaryForkAnswer(text).content.filter((b) => b.type === 'text').map((b) => String(b.text)).join('')
        lines = { ...lines, ...linesOf(answer, ask) }
      } catch (err) {
        console.error('shaver: asking for skill lines failed:', err)
        return UNRETRIEVED
      }
    }
    return lines
  })()
  const measured = await Promise.all([old(), without, whole]).then(([o, w, n]) => ({ own: o.tokens - w.tokens, blocked: n.tokens - o.tokens }), () => undefined)
  say(optimizing(shown.length, measured, skills.length > 0))
  return asked
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (abortedBy(err)) return res.end()
    console.error('shaver:', err)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(protocolOf((req.url ?? '/').replace(/^\/via\/[^/?#]*/, '')).error(502, `shaver proxy: ${err}`))
    } else res.end()
  })
}).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err
  console.error(`shaver: ${inUse(a.port)}`)
  process.exit(1)
}).listen(Number(a.port), '127.0.0.1', () => console.error(`shaver: listening on http://127.0.0.1:${a.port}, forwarding to ${a.upstream}`))

function inUse(port: string) {
  return `port ${port} is in use by another program. Set SHAVER_PORT=NNNN to an available port number.`
}

const abortedBy = (err: unknown) => err instanceof Error && err.name === 'AbortError'

// Node restores SIGHUP's default, undoing nohup, so the terminal that started
// the proxy closing would stop it. It stops on /shaver/shutdown instead.
process.on('SIGHUP', () => {})

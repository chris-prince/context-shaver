// `:shaver info` from the conversation's journal alone, with no logs. After each
// answered request the proxy counts its parts' tokens (observe) as
// scripts/defs.py's part_tokens does from the logs, and keeps only what the
// next request and the stats need: the latest request's parts, and their
// counts. render prints them in three sections: the base, the conversation
// before the frontier, and the frontier.
//
// Taken in order, a request's reported count less what its parts already
// counted is what its new parts cost together. A new reply costs the output
// count of the request that answered with it; the other new parts share what
// is left by bytes. A part is a message (as JSON without breakpoints), or the
// system blocks and tools sent in full together. A tool a tool search loads
// counts with the message that loads it, since the API expands each reference
// into the tool's definition whether or not the tool is deferred. A trim that changes an earlier message unbinds the
// thinking of the replies after it, so those are counted again, at their bytes
// less the thinking.

import { hash, kinds as kindsOf, preambleEnd, sections as sectionsOf } from './log.ts'
import { blocks, CLAUDE_CODE, isPrompt, type ApiMsg, type Block, type Conventions } from './items.ts'
import type { Cost } from './cost.ts'

export type Tool = { name?: string; defer_loading?: boolean }

// A request as it was sent, as observe needs it.
export type Sent = {
  time: string
  model: string
  provider?: string
  // The prompts among its messages (items.ts, isPrompt).
  turns: number
  parts: Array<{ key: string; bytes: number; kinds: Record<string, number>; lineage?: string; role: string; thinking: number; born?: string }>
  // `sections` is the system prompt's bytes by section, when the protocol's
  // conventions cut it (Conventions.promptHeadings); `deferred` is the bytes of
  // the tool definitions the proxy deferred (defer.ts) and `skills` those it
  // took off the skill list (skills.ts), which the base would hold without it.
  // Before 2026-10-21 `deferred` held both.
  defs: { key: string; systemPrompt: number; tools: number; sections?: Record<string, number>; deferred?: number; skills?: number }
  ends: { tools: number; reasoning: number }
  // Whether the proxy advanced its trim on this request.
  advanced: boolean
  // The seconds its breakpoints asked the cache to keep it (trim.ts, markedTtl).
  ttl?: number
  // Whether it is Claude Code's prompt suggestion (isSuggestion).
  suggestion?: boolean
  // Whether the client compacted its conversation since the request before
  // (harness.ts, resends). What it keeps, the base, the user's messages and a
  // summary, is nothing the policy trims, so all the trims took out is gone.
  compacted?: boolean
  // The keys of the parts the request before sent that the records it adds
  // replace (summary.ts, coveredBy); none before 2026-10-27.
  covers?: string[]
}

export type Stats = {
  first: string
  requests: number
  turns: number
  time: string
  model: string
  provider?: string
  // The latest request's Sent.ttl; none before 2026-10-22.
  ttl?: number
  // Whether the latest request was a prompt suggestion, which counts as no
  // request or turn; none before 2026-10-23, when suggestions weren't journaled.
  suggestion?: boolean
  // Whether the client compacted before the latest request (Sent.compacted).
  compacted?: boolean
  // The latest request's Sent.covers.
  covers?: string[]
  inputTokens: number
  // What the proxy's trims have taken out of the request, in all.
  removedTokens: number
  // Each part's latest count, by key.
  tokens: Record<string, number>
  // Counted replies' thinking, in bytes, which a trim before them unbinds.
  bound: Record<string, number>
  // The output count of each answered request, by its last message's key,
  // until the reply it answered with shows up.
  answers: Record<string, number>
  // When each part, and each lineage, first appeared.
  seen: Record<string, string>
  // Each part's bytes by kind, and its tokens by kind where the API counted
  // them (protocol.ts, Counted).
  parts: Array<{ key: string; kinds: Record<string, number>; counted?: Record<string, number>; lineage?: string }>
  defs: Sent['defs']
  ends: Sent['ends']
}

// A message as JSON without breakpoints. Claude Code sends a lone text block
// carrying one as an array, and as a string once the breakpoint moves on, so
// that becomes the string. A part's key.
export function keyOf(m: ApiMsg): string {
  let c: unknown = m.content
  if (Array.isArray(c)) {
    const bs = c.map(({ cache_control, ...b }: Block) => b)
    c = bs.length === 1 && bs[0].type === 'text' && Object.keys(bs[0]).length === 2 ? bs[0].text : bs
  }
  return hash(JSON.stringify([m.role, c]))
}

// When a message was first sent, by the stats so far.
export function bornOf(s: Stats | undefined, m: ApiMsg): string | undefined {
  const { lineage } = kindsOf(JSON.stringify(m), m)
  return (lineage && s?.seen['lineage:' + lineage]) || s?.seen[keyOf(m)]
}

// When the messages from `from` on were first sent: the first of them with a
// date. One sent trimmed and with no lineage (an assistant message with its
// thinking taken out) has none under its own key.
export function bornFrom(s: Stats | undefined, msgs: readonly ApiMsg[], from: number): string | undefined {
  for (let i = from; i < msgs.length; i++) {
    const born = bornOf(s, msgs[i])
    if (born) return born
  }
}

// The tools a message's tool results load by tool_reference.
function referenced(m: ApiMsg): string[] {
  const out: string[] = []
  for (const b of blocks(m))
    if (b.type === 'tool_result' && Array.isArray(b.content))
      for (const c of b.content as Block[]) if (c.type === 'tool_reference') out.push(String(c.tool_name))
  return out
}

export function describe(body: { model: string; provider?: string; messages: ApiMsg[]; system?: unknown; tools?: Tool[] }, ends: Sent['ends'], time: string, advanced = false, conv: Conventions = CLAUDE_CODE): Sent {
  const msgs = body.messages
  const responded = preambleEnd(msgs)
  const tools = body.tools ?? []
  const size = new Map(tools.map((t) => [t.name, JSON.stringify(t).length]))
  const parts = msgs.map((m, i) => {
    const json = JSON.stringify(m)
    const k = kindsOf(json, m, responded < 0 || i < responded)
    const thinking = m.role === 'assistant' ? blocks(m).filter((b) => b.type === 'thinking') : []
    const loaded = referenced(m).reduce((n, t) => n + (size.get(t) ?? 0), 0)
    const kinds = loaded ? { ...k.kinds, toolsLoaded: loaded } : k.kinds
    return { key: keyOf(m), bytes: json.length + loaded, kinds, lineage: k.lineage, role: m.role, thinking: thinking.length ? JSON.stringify(thinking).length : 0 }
  })
  const system: unknown[] = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : Array.isArray(body.system) ? body.system : []
  const full = tools.filter((t) => !t.defer_loading).map((t) => JSON.stringify(t))
  const sys = system.map((s) => JSON.stringify(s))
  const sections: Record<string, number> = {}
  if (conv.promptHeadings.length)
    for (const b of system as Block[])
      for (const [s, n] of b.type === 'text' ? sectionsOf(b, conv.promptHeadings) : [['system', JSON.stringify(b).length] as [string, number]]) {
        const name = s === 'system' ? 'system-prompt' : s.slice('system:'.length)
        sections[name] = (sections[name] ?? 0) + n
      }
  return {
    time,
    model: body.model,
    ...(body.provider && { provider: body.provider }),
    turns: msgs.filter(isPrompt).length,
    parts,
    defs: { key: 'defs:' + hash([...sys, '', ...full].map(hash).join()), systemPrompt: sys.reduce((n, s) => n + s.length, 0), tools: full.reduce((n, s) => n + s.length, 0), ...(Object.keys(sections).length && { sections }) },
    ends,
    advanced,
  }
}

// Whether a request is Claude Code's prompt suggestion: the conversation so far
// and a last message asking what the user will type next. It sends one after a
// reply, interactively, with no header to tell it apart. Its cost and any trim
// it makes count, but not it as a request or its message as a turn the user
// took.
export function isSuggestion(msgs: readonly ApiMsg[]): boolean {
  const last = msgs.at(-1)
  if (last?.role !== 'user') return false
  const text = typeof last.content === 'string' ? last.content : last.content.find((b) => b.type === 'text')?.text ?? ''
  return text.startsWith('[SUGGESTION MODE:')
}

// The messages but a suggestion's own, which is not a prompt the user typed, so
// does not end the turn before it: the agent may yet go on, as on a background
// task's notice. The next prompt ends it.
export const withoutSuggestion = (msgs: ApiMsg[]): ApiMsg[] => (isSuggestion(msgs) ? msgs.slice(0, -1) : msgs)

// The stats once a request is answered with these counts. Where the API
// counted parts itself (protocol.ts, Counted), they take its counts, and only
// the rest are estimated, from what is left.
export function observe(prev: Stats | undefined, r: Sent, inputTokens: number, outputTokens: number, apiCounts?: { defs?: number; parts: Array<number | undefined>; kinds?: Array<Record<string, number> | undefined> }): Stats {
  const known = { ...prev?.tokens }
  const bound = { ...prev?.bound }
  const answers = { ...prev?.answers }
  const keys = r.parts.map((p) => p.key)
  const sizes: Record<string, number> = {}
  const count: Record<string, number> = {}
  for (const p of r.parts) {
    sizes[p.key] = p.bytes
    count[p.key] = (count[p.key] ?? 0) + 1
  }
  sizes[r.defs.key] = r.defs.systemPrompt + r.defs.tools
  const exact = new Map<string, number>()
  if (apiCounts?.defs !== undefined) exact.set(r.defs.key, apiCounts.defs)
  apiCounts?.parts.forEach((n, i) => n !== undefined && exact.set(keys[i], n))
  for (const [k, n] of exact) {
    known[k] = n
    delete bound[k]
  }
  const isNew = new Set(Object.keys(sizes).filter((k) => !(k in known)))
  const first = keys.findIndex((k) => isNew.has(k))
  if (first >= 0)
    for (const k of new Set(keys.slice(first)))
      if (!isNew.has(k) && k in bound) {
        isNew.add(k)
        sizes[k] -= bound[k]
        delete bound[k]
      }
  const replies: string[] = []
  let left = inputTokens - Object.keys(sizes).filter((k) => !isNew.has(k)).reduce((n, k) => n + known[k] * (count[k] ?? 1), 0)
  r.parts.forEach((p, i) => {
    if (exact.has(p.key) && p.role === 'assistant' && i) delete answers[keys[i - 1]]
    // A reply first sent with its thinking trimmed off costs less than its
    // output, which counted the thinking.
    if (!isNew.has(p.key) || p.role !== 'assistant' || !i || i < r.ends.reasoning) return
    const out = answers[keys[i - 1]]
    if (!out) return
    delete answers[keys[i - 1]]
    known[p.key] = out
    left -= out * count[p.key]
    if (p.thinking > 2) bound[p.key] = p.thinking
    isNew.delete(p.key)
    replies.push(p.key)
  })
  // An output count can be a few tens of tokens over the reply's input cost;
  // the replies give back what would leave the other new parts below zero.
  const counted = replies.reduce((n, k) => n + known[k] * count[k], 0)
  if (left < 0 && counted) {
    for (const k of replies) known[k] *= Math.max(0, counted + left) / counted
    left = 0
  }
  const rest = [...isNew].reduce((n, k) => n + sizes[k] * (count[k] ?? 1), 0)
  for (const k of isNew) known[k] = (left * sizes[k]) / rest
  if (outputTokens) answers[keys[keys.length - 1]] = outputTokens

  // An advance takes out what the previous request's parts cost less what
  // they cost now: the parts through the last one it also sent, counting
  // repeats, since Claude Code sends the same reminder again. What follows
  // that is the turn's new parts. A suggestion's last message, which nothing
  // sends again, is no part of it. A compaction leaves nothing taken out.
  let removedTokens = r.compacted ? 0 : prev?.removedTokens ?? 0
  const was = prev?.suggestion ? prev.parts.slice(0, -1) : prev?.parts ?? []
  if (prev && r.advanced && !r.compacted) removedTokens += was.reduce((n, p) => n + (prev.tokens[p.key] ?? 0), 0) - r.parts.slice(0, keptOf(was, r.parts)).reduce((n, p) => n + known[p.key], 0)

  const seen = { ...prev?.seen }
  for (const p of r.parts) {
    seen[p.key] ??= p.born ?? r.time
    if (p.lineage) seen['lineage:' + p.lineage] ??= r.time
  }
  const requests = (prev?.requests ?? 0) + (r.suggestion ? 0 : 1)
  return {
    first: prev?.first ?? r.time,
    requests,
    turns: r.suggestion ? prev?.turns ?? 0 : r.turns,
    time: r.time,
    model: r.model,
    ...(r.provider && { provider: r.provider }),
    ...(r.ttl && { ttl: r.ttl }),
    suggestion: !!r.suggestion,
    ...(r.compacted && { compacted: true }),
    ...(r.covers && { covers: r.covers }),
    inputTokens,
    removedTokens,
    tokens: known,
    bound,
    answers,
    seen,
    parts: r.parts.map((p, i) => ({ key: p.key, kinds: p.kinds, ...(apiCounts?.kinds?.[i] && { counted: rounded(apiCounts.kinds[i]) }), ...(p.lineage ? { lineage: p.lineage } : {}) })),
    defs: r.defs,
    ends: r.ends,
  }
}

const rounded = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, n]) => [k, Math.round(n)]))

// How many of a request's parts it kept from the request before: those
// through the last part it also sent, counting repeats, since Claude Code
// sends the same reminder again.
function keptOf(prev: ReadonlyArray<{ key: string }>, parts: ReadonlyArray<{ key: string }>): number {
  const left: Record<string, number> = {}
  for (const p of prev) left[p.key] = (left[p.key] ?? 0) + 1
  let end = 0
  parts.forEach((p, i) => {
    if (left[p.key]) [left[p.key], end] = [left[p.key] - 1, i + 1]
  })
  return end
}

// A part's tokens by kind: by the API's count of each kind where it counted
// them, else its count split by bytes.
function sharesOf(p: Stats['parts'][number], tokens: Record<string, number>): Array<[string, number]> {
  const by = p.counted ?? p.kinds
  const total = Object.values(by).reduce((a, b) => a + b, 0)
  return Object.entries(by).map(([k, n]) => [k, total ? ((tokens[p.key] ?? 0) * n) / total : 0])
}

// The types of trim a saving is told by: the base's shaves (cost.ts), and in
// the conversation each kind's (log.ts, kinds), with `other` for the rest.
// The summaries' type holds the records and memoir, and the parts records
// replace (Sent.covers), so its saving is net of what carrying them costs.
export const BASE = ['deferred-tools', 'skill-list']
export const SUMMARIES = 'summary+memoir'
const TYPES: Record<string, string> = { toolCalls: 'tools', toolCallsStubbed: 'tools', toolResults: 'tools', toolResultsStubbed: 'tools', toolResultsSkill: 'tools', toolsLoaded: 'tools', reasoning: 'reasoning', user: 'messages', assistant: 'messages', harness: 'messages', summary: SUMMARIES, memoir: SUMMARIES }

// What a request took out of the conversation, by type of trim: what
// removedTokens added, a kind at a time. Given the stats before, as cost.ts
// keeps them, and after.
export function removedByType(prev: Stats, s: Stats): Record<string, number> {
  const out: Record<string, number> = {}
  const add = (k: string, n: number) => (out[TYPES[k] ?? 'other'] = (out[TYPES[k] ?? 'other'] ?? 0) + n)
  // Counted with repeats, as keptOf counts them.
  const covered: Record<string, number> = {}
  for (const k of s.covers ?? []) covered[k] = (covered[k] ?? 0) + 1
  for (const p of prev.parts) {
    const replaced = covered[p.key] > 0 && covered[p.key]--
    for (const [k, n] of sharesOf(p, prev.tokens)) add(replaced ? 'summary' : k, n)
  }
  for (const p of s.parts.slice(0, keptOf(prev.parts, s.parts))) for (const [k, n] of sharesOf(p, s.tokens)) add(k, -n)
  return out
}

// The base's tokens: the system blocks and tools, and the system messages.
export function baseOf(s: Stats): number {
  let n = s.tokens[s.defs.key] ?? 0
  for (const p of s.parts) for (const [kind, share] of sharesOf(p, s.tokens)) if (kind === 'system' || kind.startsWith('system:')) n += share
  return n
}

// The user's messages' tokens.
export const promptsOf = (s: Stats): number => s.parts.reduce((n, p) => n + sharesOf(p, s.tokens).reduce((m, [kind, share]) => m + (kind === 'user' ? share : 0), 0), 0)

// The kinds the frontier holds back, each with the frontier that trims it.
const FRONTIER: Record<string, 'tools' | 'reasoning'> = { reasoning: 'reasoning', toolCalls: 'tools', toolResults: 'tools' }
const inFrontier = (kind: string, i: number, ends: Sent['ends']) => kind in FRONTIER && i >= ends[FRONTIER[kind]]

// Each part's tokens before the frontier: its count, less the share of its
// kinds the frontier holds.
export function settled(s: Sent, tokens: Record<string, number>): number[] {
  return s.parts.map((p, i) => {
    const bytes = Object.values(p.kinds).reduce((a, b) => a + b, 0)
    return Object.entries(p.kinds).reduce((n, [kind, b]) => (inFrontier(kind, i, s.ends) ? n : n + ((tokens[p.key] ?? 0) * b) / bytes), 0)
  })
}
const LABELS: Record<string, string> = { harness: 'system-message' }
const REST_TYPES = ['toolsLoaded', 'user', 'harness', 'assistant', 'toolCalls', 'toolCallsStubbed', 'toolResults', 'toolResultsStubbed', 'toolResultsSkill', 'reasoning', 'memoir', 'summary', 'other']

// A kind as the output shows it: renamed, if at all, then hyphen-cased.
const label = (k: string) => LABELS[k] ?? k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
const byLabel = (a: string, b: string) => (label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0)

// A local calendar day, as days since the epoch.
function day(iso: string): number {
  const d = new Date(iso)
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000
}

// A timestamp as local date, time and zone, like 2026-10-10 14:21 PDT.
function localTime(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value ?? ''
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${zone}`
}

// The time between two timestamps, like 1d 3h 5m, leaving out leading zero
// units: 17h 0m, 42m.
function span(start: string, end: string): string {
  const minutes = Math.floor((Date.parse(end) - Date.parse(start)) / 60000)
  const units: Array<[number, string]> = [[Math.floor(minutes / 1440), 'd'], [Math.floor(minutes / 60) % 24, 'h'], [minutes % 60, 'm']]
  while (units.length > 1 && !units[0][0]) units.shift()
  return units.map(([n, u]) => `${n}${u}`).join(' ')
}

const percent = (v: number, total: number) => (total ? Math.floor((v / total) * 100 + 0.5) : 0)

function line(name: string, value: number, total: number, width = 22): string {
  return `${name.padEnd(width)}${Math.round(value).toLocaleString('en-US').padStart(12)}  (${String(percent(value, total)).padStart(2)}%)`
}

const head = (name: string, value: number, total: number) => line('  ' + name, value, total)
const row = (name: string, value: number, total: number, indent = 0) => '    ' + line(' '.repeat(indent) + name, value, total)

// Without the shaver, what it is now, and what the shaver saved, with the
// numbers lined up.
function difference(heading: string, without: number, now: number, show: (v: number) => string, labels: [string, string, string]): string[] {
  const [w, n, d] = [without, now, without - now].map(show)
  const width = Math.max(w.length, n.length, d.length)
  return ['  ' + heading, `    ${w.padStart(width)} ${labels[0]}`, `    ${n.padStart(width)} ${labels[1]}`, `    ${d.padStart(width)} ${labels[2]} (${percent(without - now, without)}%)`]
}

// Tokens a byte on a session's first request, which measured 0.345 to 0.367.
const BYTE_TOKENS = 0.36

// The stats before any request is answered: the request alone, its count
// estimated from its bytes.
export function estimate(r: Sent): Stats {
  const bytes = r.defs.systemPrompt + r.defs.tools + r.parts.reduce((n, p) => n + p.bytes, 0)
  return { ...observe(undefined, r, Math.round(bytes * BYTE_TOKENS), 0), requests: 0, turns: 0 }
}

// Dollars, a minus before the sign, and none on what rounds to nothing.
export const money = (v: number) => (v.toFixed(2).startsWith('-') && Number(v.toFixed(2)) ? '-$' : '$') + Math.abs(v).toFixed(2)

// The session's cost without the shaver and as it was (cost.ts), the saving
// split by type of trim, each named for the base or the conversation (each a
// share of the cost without the shaver, as the saving is), with the client's
// own compactions the shaver kept it from needing.
export const costLines = (c: Cost, heading = 'Costs (session)') => [
  ...difference(heading, c.without, c.actual, money, ['if no shaver (estimated, if auto-compacted)', 'actual', 'saved']),
  ...(Object.keys(c.saved).some((t) => t !== 'other') ? ['', '  Savings Breakdown', ...split(c)] : []),
  '',
  '  Speedup',
  `    ${counted(Math.round(c.waitMs / 60_000), 'minute')} saved (by avoiding ${c.compactions} /autocompact)`,
]

const SAVED = [...BASE, 'tools', 'reasoning', 'messages', SUMMARIES, 'other']

// Each type named for its half, shares padded to 2 digits as in line(). A
// type that rounds to nothing is left out.
function split(c: Cost): string[] {
  const types = SAVED.filter((t) => money(c.saved[t] ?? 0) !== '$0.00')
  const width = Math.max(...types.map((t) => money(c.saved[t]).length))
  return types.map((t) => `    ${money(c.saved[t]).padStart(width)} (${String(percent(c.saved[t], c.without)).padStart(2)}%) ${BASE.includes(t) ? 'base' : 'conv'}:${t}`)
}

export const counted = (n: number, noun: string) => `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`

// What became of a session's summary requests (summary.ts): their records the
// prompt sends now (applied), those still to answer or waiting for a cold cache
// (pending), and the rest (dropped).
export type Forks = { applied: number; pending: number; dropped: number }

export function render(s: Stats, session: string, estimated = false, cost?: Cost, forks: Forks = { applied: 0, pending: 0, dropped: 0 }): string {
  const total = s.inputTokens
  const by: Record<string, number> = {}
  const add = (k: string, n: number) => (by[k] = (by[k] ?? 0) + n)
  const sections: Record<string, number> = {}
  const fixed = s.tokens[s.defs.key] ?? 0
  const defBytes = s.defs.systemPrompt + s.defs.tools
  add('systemPrompt', (fixed * s.defs.systemPrompt) / defBytes)
  add('tools', (fixed * s.defs.tools) / defBytes)
  for (const [name, n] of Object.entries(s.defs.sections ?? { 'system-prompt': s.defs.systemPrompt })) sections[name] = (sections[name] ?? 0) + (fixed * n) / defBytes

  const ref = day(s.time)
  const byDay: Record<number, number> = {}
  let frontier = 0
  s.parts.forEach((p, i) => {
    const born = (p.lineage && s.seen['lineage:' + p.lineage]) || s.seen[p.key]
    const ago = ref - day(born)
    for (const [kind, share] of sharesOf(p, s.tokens)) {
      if (kind === 'system' || kind.startsWith('system:')) {
        add('preamble', share)
        const name = kind.slice('system:'.length) || 'other'
        sections[name] = (sections[name] ?? 0) + share
      }
      else if (inFrontier(kind, i, s.ends)) frontier += share
      else {
        add(kind, share)
        byDay[ago] = (byDay[ago] ?? 0) + share
      }
    }
  })
  const base = (by.systemPrompt ?? 0) + (by.tools ?? 0) + (by.preamble ?? 0)
  const conversation = total - base - frontier

  const out = [`Session: ${session}`, `Model: ${s.model}`, ...(s.provider ? [`Provider: ${s.provider}`] : []), '', localTime(s.time), `${counted(s.requests, 'request')} across ${counted(s.turns, 'turn')}, spanning ${span(s.first, s.time)}`, ...(cost ? ['', 'Shaver Summary', ...costLines(cost)] : [])]
  // The prompt as sent, then as it would be without the shaver, lined up.
  const [now, without] = [total, total + (s.removedTokens ?? 0)].map((v) => Math.round(v).toLocaleString('en-US'))
  const requests = forks.applied + forks.pending + forks.dropped
  const fates = requests ? [`    ${Object.entries(forks).map(([fate, n]) => `${n} ${fate}`).join(', ')}`] : []
  out.push('', estimated ? 'Context Details (estimated)' : 'Context Details', '', `  ${now.padStart(without.length)} tokens, actual`, `  ${without} tokens, if no shaver`, '', `  ${counted(requests, 'summary creation request')}`, ...fates, '', head('Base', base, total), "  Session's fixed overhead. If over 10k, shrink big items.")
  // The system prompt and the preamble by section, and the tools, side by
  // side.
  const baseRows: Array<[string, number]> = [['tools', by.tools ?? 0], ...Object.entries(sections)]
  for (const [name, v] of baseRows.sort(([a], [z]) => (a < z ? -1 : a > z ? 1 : 0))) out.push(row(name, v, total))
  out.push('', head('Conversation', conversation, total), '  Earlier turns, already trimmed. Should stay small.', '    by type:')
  for (const k of [...REST_TYPES].sort(byLabel)) if (by[k]) out.push(row(label(k), by[k], total, 2))
  out.push('    by age:')
  if (byDay[0]) out.push(row('today', byDay[0], total, 2))
  for (const d of Object.keys(byDay).map(Number).filter((d) => d > 0).sort((a, b) => a - b)) out.push(row(`${d} day${d !== 1 ? 's' : ''} ago`, byDay[d], total, 2))
  out.push('', head('Frontier', frontier, total), '  Recent turns, not yet eligible to trim. Okay if large.')
  return out.join('\n')
}

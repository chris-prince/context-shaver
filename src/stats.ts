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

import { hash, kinds as kindsOf } from './log.ts'
import { blocks, isPrompt, type ApiMsg, type Block } from './items.ts'
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
  defs: { key: string; systemPrompt: number; tools: number }
  ends: { tools: number; reasoning: number }
  // Whether the proxy advanced its trim on this request.
  advanced: boolean
}

export type Stats = {
  first: string
  requests: number
  turns: number
  time: string
  model: string
  provider?: string
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
  parts: Array<{ key: string; kinds: Record<string, number>; lineage?: string }>
  defs: Sent['defs']
  ends: Sent['ends']
}

// A message as JSON without breakpoints. Claude Code sends a lone text block
// carrying one as an array, and as a string once the breakpoint moves on, so
// that becomes the string.
function plain(m: ApiMsg): string {
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
  return (lineage && s?.seen['lineage:' + lineage]) || s?.seen[plain(m)]
}

// The tools a message's tool results load by tool_reference.
function referenced(m: ApiMsg): string[] {
  const out: string[] = []
  for (const b of blocks(m))
    if (b.type === 'tool_result' && Array.isArray(b.content))
      for (const c of b.content as Block[]) if (c.type === 'tool_reference') out.push(String(c.tool_name))
  return out
}

export function describe(body: { model: string; provider?: string; messages: ApiMsg[]; system?: unknown; tools?: Tool[] }, ends: Sent['ends'], time: string, advanced = false): Sent {
  const msgs = body.messages
  const responded = msgs.findIndex((m) => m.role === 'assistant')
  const tools = body.tools ?? []
  const size = new Map(tools.map((t) => [t.name, JSON.stringify(t).length]))
  const parts = msgs.map((m, i) => {
    const json = JSON.stringify(m)
    const k = kindsOf(json, m, responded < 0 || i < responded)
    const thinking = m.role === 'assistant' ? blocks(m).filter((b) => b.type === 'thinking') : []
    const loaded = referenced(m).reduce((n, t) => n + (size.get(t) ?? 0), 0)
    const kinds = loaded ? { ...k.kinds, toolsLoaded: loaded } : k.kinds
    return { key: plain(m), bytes: json.length + loaded, kinds, lineage: k.lineage, role: m.role, thinking: thinking.length ? JSON.stringify(thinking).length : 0 }
  })
  const system: unknown[] = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : Array.isArray(body.system) ? body.system : []
  const full = tools.filter((t) => !t.defer_loading).map((t) => JSON.stringify(t))
  const sys = system.map((s) => JSON.stringify(s))
  return {
    time,
    model: body.model,
    ...(body.provider && { provider: body.provider }),
    turns: msgs.filter(isPrompt).length,
    parts,
    defs: { key: 'defs:' + hash([...sys, '', ...full].map(hash).join()), systemPrompt: sys.reduce((n, s) => n + s.length, 0), tools: full.reduce((n, s) => n + s.length, 0) },
    ends,
    advanced,
  }
}

// Whether a request is Claude Code's prompt suggestion: the conversation so far
// and a last message asking what the user will type next. It sends one after a
// reply, interactively, with no header to tell it apart, so the stats leave it
// out by that message; counted, it would add a turn the user never took.
export function isSuggestion(msgs: readonly ApiMsg[]): boolean {
  const last = msgs.at(-1)
  if (last?.role !== 'user') return false
  const text = typeof last.content === 'string' ? last.content : last.content.find((b) => b.type === 'text')?.text ?? ''
  return text.startsWith('[SUGGESTION MODE:')
}

// The stats once a request is answered with these counts.
export function observe(prev: Stats | undefined, r: Sent, inputTokens: number, outputTokens: number): Stats {
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
  // that is the turn's new parts.
  let removedTokens = prev?.removedTokens ?? 0
  if (prev && r.advanced) {
    const left: Record<string, number> = {}
    for (const p of prev.parts) left[p.key] = (left[p.key] ?? 0) + 1
    let end = 0
    r.parts.forEach((p, i) => {
      if (left[p.key]) [left[p.key], end] = [left[p.key] - 1, i + 1]
    })
    const kept = r.parts.slice(0, end)
    removedTokens += prev.parts.reduce((n, p) => n + (prev.tokens[p.key] ?? 0), 0) - kept.reduce((n, p) => n + known[p.key], 0)
  }

  const seen = { ...prev?.seen }
  for (const p of r.parts) {
    seen[p.key] ??= p.born ?? r.time
    if (p.lineage) seen['lineage:' + p.lineage] ??= r.time
  }
  const requests = (prev?.requests ?? 0) + 1
  return {
    first: prev?.first ?? r.time,
    requests,
    turns: r.turns,
    time: r.time,
    model: r.model,
    ...(r.provider && { provider: r.provider }),
    inputTokens,
    removedTokens,
    tokens: known,
    bound,
    answers,
    seen,
    parts: r.parts.map((p) => ({ key: p.key, kinds: p.kinds, ...(p.lineage ? { lineage: p.lineage } : {}) })),
    defs: r.defs,
    ends: r.ends,
  }
}

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
const REST_TYPES = ['toolsLoaded', 'user', 'harness', 'assistant', 'toolCalls', 'toolCallsStubbed', 'toolResults', 'toolResultsStubbed', 'toolResultsSkill', 'reasoning', 'summary', 'other']

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

const tally = (now: number, removed: number) => difference('Tokens (current)', now + removed, now, (v) => Math.round(v).toLocaleString('en-US'), ['if no shaver', 'actual', 'saved'])

// Tokens a byte on a session's first request, which measured 0.345 to 0.367.
const BYTE_TOKENS = 0.36

// The stats before any request is answered: the request alone, its count
// estimated from its bytes.
export function estimate(r: Sent): Stats {
  const bytes = r.defs.systemPrompt + r.defs.tools + r.parts.reduce((n, p) => n + p.bytes, 0)
  return { ...observe(undefined, r, Math.round(bytes * BYTE_TOKENS), 0), requests: 0, turns: 0 }
}

// The session's cost without the shaver and as it was (cost.ts).
const costLines = (c: Cost) => difference('Costs (session)', c.without, c.actual, (v) => '$' + v.toFixed(2), ['if no shaver (estimated)', 'actual', 'saved'])

const counted = (n: number, noun: string) => `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`

// `summaries` is how many summary requests (summary.ts) the session has sent,
// answered or not.
export function render(s: Stats, session: string, estimated = false, cost?: Cost, summaries = 0): string {
  const total = s.inputTokens
  const by: Record<string, number> = {}
  const add = (k: string, n: number) => (by[k] = (by[k] ?? 0) + n)
  const sections: Record<string, number> = {}
  const fixed = s.tokens[s.defs.key] ?? 0
  const defBytes = s.defs.systemPrompt + s.defs.tools
  add('systemPrompt', (fixed * s.defs.systemPrompt) / defBytes)
  add('tools', (fixed * s.defs.tools) / defBytes)

  const ref = day(s.time)
  const byDay: Record<number, number> = {}
  let frontier = 0
  s.parts.forEach((p, i) => {
    const born = (p.lineage && s.seen['lineage:' + p.lineage]) || s.seen[p.key]
    const ago = ref - day(born)
    const bytes = Object.values(p.kinds).reduce((a, b) => a + b, 0)
    for (const [kind, n] of Object.entries(p.kinds)) {
      const share = ((s.tokens[p.key] ?? 0) * n) / bytes
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

  const out = [`Session: ${session}`, `Model: ${s.model}`, ...(s.provider ? [`Provider: ${s.provider}`] : []), '', localTime(s.time), `${counted(s.requests, 'request')} across ${counted(s.turns, 'turn')}, spanning ${span(s.first, s.time)}`, '', estimated ? 'Context Summary (estimated)' : 'Context Summary', ...tally(total, s.removedTokens ?? 0), ...(cost ? costLines(cost) : []), `  Summaries: ${counted(summaries, 'creation request')}`]
  out.push('', 'Context Details', '', head('Base', base, total), "  Session's fixed overhead. If over 10k, shrink big items.")
  // The system prompt, the tools, and the preamble by section, side by side.
  const baseRows: Array<[string, number]> = [['system-prompt', by.systemPrompt ?? 0], ['tools', by.tools ?? 0], ...Object.entries(sections)]
  for (const [name, v] of baseRows.sort(([a], [z]) => (a < z ? -1 : a > z ? 1 : 0))) out.push(row(name, v, total))
  out.push('', head('Conversation', conversation, total), '  Earlier turns, already trimmed. Should stay small.', '    by age:')
  for (const d of Object.keys(byDay).map(Number).filter((d) => d > 0).sort((a, b) => b - a)) out.push(row(`${d} day${d !== 1 ? 's' : ''} ago`, byDay[d], total, 2))
  if (byDay[0]) out.push(row('today', byDay[0], total, 2))
  out.push('    by type:')
  for (const k of [...REST_TYPES].sort(byLabel)) if (by[k]) out.push(row(label(k), by[k], total, 2))
  out.push('', head('Frontier', frontier, total), '  Recent turns, not yet eligible to trim. Okay if large.')
  return out.join('\n')
}

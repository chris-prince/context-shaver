// `:shaver stats` from the conversation's journal alone, with no logs. After each
// answered request the proxy counts its parts' tokens (observe) as
// scripts/defs.py's part_tokens does from the logs, and keeps only what the
// next request and the stats need: the latest request's parts, and their
// counts. render prints them as scripts/analyze-context.py does.
//
// Taken in order, a request's reported count less what its parts already
// counted is what its new parts cost together. A new reply costs the output
// count of the request that answered with it; the other new parts share what
// is left by bytes. A part is a message (as JSON without breakpoints), the
// system blocks and tools sent in full together, or a deferred tool a tool
// search has loaded. A trim that changes an earlier message unbinds the
// thinking of the replies after it, so those are counted again, at their bytes
// less the thinking.

import { hash, kinds as kindsOf } from './log.ts'
import { blocks, isPrompt, type ApiMsg, type Block } from './items.ts'

type Tool = { name?: string; defer_loading?: boolean }

// A request as it was sent, as observe needs it.
export type Sent = {
  time: string
  model: string
  // The prompts among its messages (items.ts, isPrompt).
  turns: number
  parts: Array<{ key: string; bytes: number; kinds: Record<string, number>; lineage?: string; role: string; thinking: number }>
  defs: { key: string; systemPrompt: number; tools: number }
  loaded: Array<{ key: string; bytes: number }>
  ends: { tools: number; reasoning: number }
}

export type Stats = {
  first: string
  requests: number
  turns: number
  time: string
  model: string
  inputTokens: number
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
  loaded: string[]
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

// The deferred tools a request's tool results load by tool_reference.
function referenced(msgs: readonly ApiMsg[]): Set<string> {
  const out = new Set<string>()
  for (const m of msgs)
    for (const b of blocks(m))
      if (b.type === 'tool_result' && Array.isArray(b.content))
        for (const c of b.content as Block[]) if (c.type === 'tool_reference') out.add(String(c.tool_name))
  return out
}

export function describe(body: { model: string; messages: ApiMsg[]; system?: unknown; tools?: Tool[] }, ends: Sent['ends'], time: string): Sent {
  const msgs = body.messages
  const responded = msgs.findIndex((m) => m.role === 'assistant')
  const parts = msgs.map((m, i) => {
    const json = JSON.stringify(m)
    const k = kindsOf(json, m, responded < 0 || i < responded)
    const thinking = m.role === 'assistant' ? blocks(m).filter((b) => b.type === 'thinking') : []
    return { key: plain(m), bytes: json.length, kinds: k.kinds, lineage: k.lineage, role: m.role, thinking: thinking.length ? JSON.stringify(thinking).length : 0 }
  })
  const system: unknown[] = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : Array.isArray(body.system) ? body.system : []
  const tools = body.tools ?? []
  const full = tools.filter((t) => !t.defer_loading).map((t) => JSON.stringify(t))
  const sys = system.map((s) => JSON.stringify(s))
  const loaded = referenced(msgs)
  return {
    time,
    model: body.model,
    turns: msgs.filter(isPrompt).length,
    parts,
    defs: { key: 'defs:' + hash([...sys, '', ...full].map(hash).join()), systemPrompt: sys.reduce((n, s) => n + s.length, 0), tools: full.reduce((n, s) => n + s.length, 0) },
    loaded: tools.filter((t) => t.defer_loading && loaded.has(t.name ?? '')).map((t) => JSON.stringify(t)).map((j) => ({ key: 'tool:' + hash(j), bytes: j.length })),
    ends,
  }
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
  for (const t of r.loaded) sizes[t.key] = t.bytes
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

  const seen = { ...prev?.seen }
  for (const p of r.parts) {
    seen[p.key] ??= r.time
    if (p.lineage) seen['lineage:' + p.lineage] ??= r.time
  }
  const requests = (prev?.requests ?? 0) + 1
  return {
    first: prev?.first ?? r.time,
    requests,
    turns: r.turns,
    time: r.time,
    model: r.model,
    inputTokens,
    tokens: known,
    bound,
    answers,
    seen,
    parts: r.parts.map((p) => ({ key: p.key, kinds: p.kinds, ...(p.lineage ? { lineage: p.lineage } : {}) })),
    defs: r.defs,
    loaded: r.loaded.map((t) => t.key),
    ends: r.ends,
  }
}

// The kinds the frontier holds back, each with the frontier that trims it.
const FRONTIER: Record<string, 'tools' | 'reasoning'> = { reasoning: 'reasoning', toolCalls: 'tools', toolResults: 'tools' }
const BASE_TYPES = ['systemPrompt', 'tools', 'preamble']
// What Claude Code injects reads the same before the first response as after.
const LABELS: Record<string, string> = { preamble: 'systemMessage', harness: 'systemMessage' }
const REST_TYPES = ['toolsLoaded', 'user', 'harness', 'assistant', 'toolCalls', 'toolCallsStubbed', 'toolResults', 'toolResultsStubbed', 'toolResultsSkill', 'reasoning', 'other']

const label = (k: string) => LABELS[k] ?? k
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

function row(name: string, value: number, total: number, showPercent = true, indent = 0): string {
  const line = `  ${' '.repeat(indent)}${name.padEnd(20)}${Math.round(value).toLocaleString('en-US').padStart(12)}`
  return showPercent ? line + `  (${String(percent(value, total)).padStart(2)}%)` : line
}

export function render(s: Stats, session: string): string {
  const total = s.inputTokens
  const by: Record<string, number> = {}
  const add = (k: string, n: number) => (by[k] = (by[k] ?? 0) + n)
  const fixed = s.tokens[s.defs.key] ?? 0
  const defBytes = s.defs.systemPrompt + s.defs.tools
  add('systemPrompt', (fixed * s.defs.systemPrompt) / defBytes)
  add('tools', (fixed * s.defs.tools) / defBytes)
  add('toolsLoaded', s.loaded.reduce((n, k) => n + (s.tokens[k] ?? 0), 0))

  const ref = day(s.time)
  const byDay: Record<number, number> = {}
  let frontier = 0
  s.parts.forEach((p, i) => {
    const born = (p.lineage && s.seen['lineage:' + p.lineage]) || s.seen[p.key]
    const ago = ref - day(born)
    const bytes = Object.values(p.kinds).reduce((a, b) => a + b, 0)
    for (const [kind, n] of Object.entries(p.kinds)) {
      const share = ((s.tokens[p.key] ?? 0) * n) / bytes
      if (kind === 'system') add('preamble', share)
      else if (kind in FRONTIER && i >= s.ends[FRONTIER[kind]]) frontier += share
      else {
        add(kind, share)
        byDay[ago] = (byDay[ago] ?? 0) + share
      }
    }
  })
  const persist = total - frontier
  const base = (by.systemPrompt ?? 0) + (by.tools ?? 0) + (by.preamble ?? 0)

  const out = [`Session: ${session}`, `Model: ${s.model}`, '', localTime(s.time), `${s.requests.toLocaleString('en-US')} requests across ${s.turns.toLocaleString('en-US')} turns, spanning ${span(s.first, s.time)}`, `${total.toLocaleString('en-US')} tokens`]
  out.push('', 'Tokens by age (in calendar days, local time)', row('base', base, total))
  if (by.toolsLoaded) out.push(row('toolsLoaded', by.toolsLoaded, total))
  for (const d of Object.keys(byDay).map(Number).filter((d) => d > 0).sort((a, b) => b - a)) out.push(row(`${d} day${d !== 1 ? 's' : ''} ago`, byDay[d], total))
  if (byDay[0]) out.push(row('today', byDay[0], total))
  if (frontier) out.push(row('frontier', frontier, total))
  out.push(row('TOTAL', total, total, false))
  out.push('', 'Tokens by part type (pre-frontier only)', row('base', base, persist))
  for (const k of [...BASE_TYPES].sort(byLabel)) out.push(row(label(k), by[k] ?? 0, persist, true, 2))
  out.push(row('non-base', persist - base, persist))
  for (const k of [...REST_TYPES].sort(byLabel)) {
    if (['toolsLoaded', 'reasoning', 'other'].includes(k) && !by[k]) continue
    out.push(row(label(k), by[k] ?? 0, persist, true, 2))
  }
  out.push(row('TOTAL', persist, persist, false))
  return out.join('\n')
}

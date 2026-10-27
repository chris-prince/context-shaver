// A conversation's stats history: proxy-data/state/<key>.journal.jsonl, a line
// per counted request holding what it changed in the stats (stats.ts). The
// lines replayed from the start give the stats as they were after any
// request. A journal begun after the stats were holds them whole in its first
// line, so its history starts there.
//
// A line records results, not inputs, so a replay never reruns the counting.
// Its fields: the plain fields that changed, null for one gone (before
// 2026-10-24 one gone was left out, so replay kept it); for each record, the entries set
// and the keys deleted; and, when it changed, the part list, each run of parts
// kept from the previous list as [from, to) and each other part whole. A line
// also holds the request's usage as the API reported it (cache reads, cache
// writes by TTL, output), which the stats leave out and replay ignores.
//
// A request the proxy makes of its own, a fork (server.ts, forked), gets a
// line of its own, { fork: { time, kind, model, provider, usage, why } }, with
// no change to the stats, so replay skips it. Older journals have summary
// forks' as { summaryFork: { time, model, provider, usage } }.
//
// A request the API refused changed and answered as it came (server.ts) gets a
// line marked resent: true, its usage and its count as a request, with the
// rest of the stats as they were, since it went up untrimmed.
//
// Any other request the API answered gets a bare line, { bare: { time, model,
// provider, usage, why } }, with no change to the stats, so replay skips it:
// one sent as it came (a side request without tools, or one not read or not
// trimmed), one cut off before its answer ended, one answered with no usage,
// and one resent before the conversation had stats. It counts what it was
// billed, the same with and without the shaver, and not as a request. Before
// 2026-10-24 none of these were journaled.

import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Usage } from './cost.ts'
import { withWrites } from './responses.ts'
import type { Stats } from './stats.ts'

// Every other field is plain, set whole when it changes: listing them let a
// new one go unjournaled (Stats.compacted, until 2026-10-24).
const RECORDS = ['tokens', 'bound', 'answers', 'seen'] as const
type Plain = Exclude<keyof Stats, (typeof RECORDS)[number] | 'parts'>
const plainOf = (s: Stats | undefined) => Object.keys(s ?? {}).filter((f) => f !== 'parts' && !(RECORDS as readonly string[]).includes(f)) as Plain[]

type Part = Stats['parts'][number]
export type Delta = {
  set?: Partial<Pick<Stats, Plain>>
  records?: Partial<Record<(typeof RECORDS)[number], { set?: Record<string, unknown>; del?: string[] }>>
  parts?: Array<[number, number] | Part>
  usage?: Usage
  resent?: true
}
// why is set when the answer gave no usage, as on a bare line.
// A summary fork, or the request `:shaver optimize` makes for skill lines.
export type ForkKind = 'summary' | 'optimize'
export type ForkLine = { time: string; kind: ForkKind; model: string; provider?: string; usage?: Usage; why?: Why }
export type Why = 'side' | 'unread' | 'untrimmed' | 'cut off' | 'no usage' | 'resent'
export type BareLine = { time: string; model: string; provider?: string; usage?: Usage; why: Why }

// The request lines written since the proxy started (server.ts checks one is
// written for every answered request).
export let written = 0
const append = (file: string, line: object) => {
  appendFileSync(file, JSON.stringify(line) + '\n')
  written++
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function diff(prev: Stats | undefined, next: Stats): Delta {
  const d: Delta = {}
  for (const f of [...new Set([...plainOf(prev), ...plainOf(next)])].sort()) if (!prev || !same(prev[f], next[f])) (d.set ??= {})[f] = (next[f] ?? null) as never
  for (const f of RECORDS) {
    const a: Record<string, unknown> = prev?.[f] ?? {}
    const b: Record<string, unknown> = next[f]
    const set = Object.fromEntries(Object.entries(b).filter(([k, v]) => !same(a[k], v)))
    const del = Object.keys(a).filter((k) => !(k in b))
    if (Object.keys(set).length || del.length) (d.records ??= {})[f] = { ...(Object.keys(set).length && { set }), ...(del.length && { del }) }
  }
  if (!prev || !same(prev.parts, next.parts)) {
    // Where each part sits in the previous list, by its JSON.
    const at = new Map<string, number[]>()
    prev?.parts.forEach((p, i) => at.set(JSON.stringify(p), [...(at.get(JSON.stringify(p)) ?? []), i]))
    const ops: Delta['parts'] = []
    for (const p of next.parts) {
      const found = at.get(JSON.stringify(p)) ?? []
      const last = ops[ops.length - 1]
      // Extend the run when this part follows it, else start one where the
      // part first sits.
      if (Array.isArray(last) && found.includes(last[1])) last[1]++
      else if (found.length) ops.push([found[0], found[0] + 1])
      else ops.push(p)
    }
    d.parts = ops
  }
  return d
}

// Applies a line to the stats before it, in place: copying the records, which
// every line changes, would cost a line as much as all the lines before it.
function apply(s: Stats | undefined, d: Delta): Stats {
  const parts = d.parts?.flatMap((op) => (Array.isArray(op) ? s!.parts.slice(op[0], op[1]) : [op]))
  s = Object.assign(s ?? ({} as Stats), d.set)
  for (const [k, v] of Object.entries(d.set ?? {})) if (v === null) delete s[k as keyof Stats]
  for (const f of RECORDS) {
    const r = d.records?.[f]
    const out: Record<string, unknown> = (s[f] ??= {} as never)
    Object.assign(out, r?.set)
    for (const k of r?.del ?? []) delete out[k]
  }
  if (parts) s.parts = parts
  return s
}

// Appends the change from prev, the stats the journal ends with, to next, and
// the usage the request reported.
export function record(file: string, prev: Stats | undefined, next: Stats, usage?: Usage): void {
  append(file, { ...diff(prev, next), ...(usage && { usage }) })
}

// Appends a bare line.
export function recordBare(file: string, b: BareLine): void {
  append(file, { bare: b })
}

// Appends a resent request's line, given the stats the journal ends with, and
// returns the stats it leaves.
export function recordResent(file: string, prev: Stats, time: string, usage: Usage): Stats {
  const set = { requests: prev.requests + 1, time }
  append(file, { set, usage, resent: true })
  return { ...prev, ...set }
}

// Appends a fork's line.
export function recordFork(file: string, f: ForkLine): void {
  append(file, { fork: f })
}

// A line's fork, if it is one, an older summary fork's line included.
export const forkOf = (d: { fork?: ForkLine; summaryFork?: Omit<ForkLine, 'kind'> }): ForkLine | undefined => d.fork ?? (d.summaryFork && { ...d.summaryFork, kind: 'summary' })

// The journal's lines, parsed; none if there is none.
export function* linesOf(file: string): Generator<Delta & { fork?: ForkLine; summaryFork?: Omit<ForkLine, 'kind'>; bare?: BareLine }> {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) if (line) yield JSON.parse(line)
}

// The stats after each line of a journal, in order, each built from the one
// before, with the usage the line holds; none if there is none. Every line
// gives the same stats object, changed in place, so a caller that keeps a
// line's stats past the next one copies what it needs. A Codex journal's
// usage gets the cache writes ChatGPT's backend doesn't report (responses.ts).
export function* history(file: string): Generator<{ stats: Stats; usage?: Usage; resent?: true }> {
  const codex = path.basename(file).startsWith('codex-')
  let s: Stats | undefined
  for (const d of linesOf(file)) if (!forkOf(d) && !d.bare) yield { stats: (s = apply(s, d)), usage: d.usage && codex ? withWrites(d.usage) : d.usage, ...(d.resent && { resent: d.resent }) }
}

// The forks a journal records, in order.
export function* forks(file: string): Generator<ForkLine> {
  for (const d of linesOf(file)) {
    const f = forkOf(d)
    if (f) yield f
  }
}

// The conversation a request sent as it came is journaled with, given its own
// key: its own, if it has a journal, else its session's latest, since a side
// request's first message is its own, not the conversation's. A key with no
// session (only its harness's name and the hash) is its own.
export function sideKey(dir: string, key: string): string {
  const session = key.slice(0, key.lastIndexOf('-') + 1)
  if (existsSync(path.join(dir, `${key}.journal.jsonl`)) || !session.slice(0, -1).includes('-')) return key
  const theirs = readdirSync(dir)
    .filter((f) => f.startsWith(session) && f.endsWith('.journal.jsonl'))
    .map((f) => ({ f, at: statSync(path.join(dir, f)).mtimeMs }))
    .sort((x, y) => x.at - y.at)
  return theirs.length ? theirs[theirs.length - 1].f.slice(0, -'.journal.jsonl'.length) : key
}

// The bare lines a journal records, in order.
export function* bareLines(file: string): Generator<BareLine> {
  for (const d of linesOf(file)) if (d.bare) yield d.bare
}

export function* replay(file: string): Generator<Stats> {
  for (const { stats } of history(file)) yield stats
}

// The stats the journal ends with. A journal that won't replay is moved aside
// to <key>.journal.bad.jsonl and the stats start again, so trimming, which
// counts from them, never depends on it.
export function latest(file: string): Stats | undefined {
  let s: Stats | undefined
  try {
    for (s of replay(file));
    return s
  } catch (err) {
    renameSync(file, file.replace(/\.jsonl$/, '.bad.jsonl'))
    console.error(`shaver: journal moved aside, stats start again: ${file}:`, err)
    return undefined
  }
}

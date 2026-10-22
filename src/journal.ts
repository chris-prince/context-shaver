// A conversation's stats history: proxy-data/state/<key>.journal.jsonl, a line
// per counted request holding what it changed in the stats (stats.ts). The
// lines replayed from the start give the stats as they were after any
// request. A journal begun after the stats were holds them whole in its first
// line, so its history starts there.
//
// A line records results, not inputs, so a replay never reruns the counting.
// Its fields: the plain fields that changed; for each record, the entries set
// and the keys deleted; and, when it changed, the part list, each run of parts
// kept from the previous list as [from, to) and each other part whole. A line
// also holds the request's usage as the API reported it (cache reads, cache
// writes by TTL, output), which the stats leave out and replay ignores.
//
// A summary fork (summary.ts) gets a line of its own, { summaryFork: { time,
// model, provider, usage } }, with no change to the stats, so replay skips it.

import { appendFileSync, existsSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import type { Usage } from './cost.ts'
import { withWrites } from './responses.ts'
import type { Stats } from './stats.ts'

const PLAIN = ['first', 'requests', 'turns', 'time', 'model', 'provider', 'inputTokens', 'removedTokens', 'defs', 'ends'] as const
const RECORDS = ['tokens', 'bound', 'answers', 'seen'] as const

type Part = Stats['parts'][number]
export type Delta = {
  set?: Partial<Pick<Stats, (typeof PLAIN)[number]>>
  records?: Partial<Record<(typeof RECORDS)[number], { set?: Record<string, unknown>; del?: string[] }>>
  parts?: Array<[number, number] | Part>
  usage?: Usage
}
export type SummaryForkLine = { time: string; model: string; provider?: string; usage?: Usage }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function diff(prev: Stats | undefined, next: Stats): Delta {
  const d: Delta = {}
  for (const f of PLAIN) if (!prev || !same(prev[f], next[f])) (d.set ??= {})[f] = next[f] as never
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
  appendFileSync(file, JSON.stringify({ ...diff(prev, next), ...(usage && { usage }) }) + '\n')
}

// Appends a summary fork's line.
export function recordSummaryFork(file: string, f: SummaryForkLine): void {
  appendFileSync(file, JSON.stringify({ summaryFork: f }) + '\n')
}

// The journal's lines, parsed; none if there is none.
function* linesOf(file: string): Generator<Delta & { summaryFork?: SummaryForkLine }> {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) if (line) yield JSON.parse(line)
}

// The stats after each line of a journal, in order, each built from the one
// before, with the usage the line holds; none if there is none. Every line
// gives the same stats object, changed in place, so a caller that keeps a
// line's stats past the next one copies what it needs. A Codex journal's
// usage gets the cache writes ChatGPT's backend doesn't report (responses.ts).
export function* history(file: string): Generator<{ stats: Stats; usage?: Usage }> {
  const codex = path.basename(file).startsWith('codex-')
  let s: Stats | undefined
  for (const d of linesOf(file)) if (!d.summaryFork) yield { stats: (s = apply(s, d)), usage: d.usage && codex ? withWrites(d.usage) : d.usage }
}

// The summary forks a journal records, in order.
export function* summaryForks(file: string): Generator<SummaryForkLine> {
  for (const d of linesOf(file)) if (d.summaryFork) yield d.summaryFork
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

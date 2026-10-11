// A conversation's stats history: proxy-data/state/<key>.journal.jsonl, a line
// per counted request holding what it changed in the stats (stats.ts). The
// lines replayed from the start give the stats as they were after any
// request. A journal begun after the stats were holds them whole in its first
// line, so its history starts there.
//
// A line records results, not inputs, so a replay never reruns the counting.
// Its fields: the plain fields that changed; for each record, the entries set
// and the keys deleted; and, when it changed, the part list, each run of parts
// kept from the previous list as [from, to) and each other part whole.

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { Stats } from './stats.ts'

const PLAIN = ['first', 'requests', 'time', 'model', 'inputTokens', 'defs', 'loaded', 'ends'] as const
const RECORDS = ['tokens', 'bound', 'answers', 'seen'] as const

type Part = Stats['parts'][number]
export type Delta = {
  set?: Partial<Pick<Stats, (typeof PLAIN)[number]>>
  records?: Partial<Record<(typeof RECORDS)[number], { set?: Record<string, unknown>; del?: string[] }>>
  parts?: Array<[number, number] | Part>
}

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

export function apply(prev: Stats | undefined, d: Delta): Stats {
  const s = { ...prev, ...d.set } as Stats
  for (const f of RECORDS) {
    const r = d.records?.[f]
    const out: Record<string, unknown> = { ...prev?.[f], ...r?.set }
    for (const k of r?.del ?? []) delete out[k]
    s[f] = out as never
  }
  if (d.parts) s.parts = d.parts.flatMap((op) => (Array.isArray(op) ? prev!.parts.slice(op[0], op[1]) : [op]))
  return s
}

// Appends the change from prev, the stats the journal ends with, to next.
export function record(file: string, prev: Stats | undefined, next: Stats): void {
  appendFileSync(file, JSON.stringify(diff(prev, next)) + '\n')
}

// The stats after each line of a journal, in order; none if there is none.
export function replay(file: string): Stats[] {
  const out: Stats[] = []
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split('\n'))
    if (line) out.push(apply(out[out.length - 1], JSON.parse(line)))
  return out
}

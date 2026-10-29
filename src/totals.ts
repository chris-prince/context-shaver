// `:shaver info all`: what every conversation the proxy has a journal for cost,
// and would have without it, replayed from each journal as `:shaver info`
// replays one (cost.ts), so each conversation adds what its own info shows.
// The cost is summed request by request, so it can be cut by environment:
// harness (the key's first part) and model together. A summary fork counts for the model its journal
// line gives; spend from before forks were journaled, for the conversation's
// last model. Either is charged to the summaries' saving; a `:shaver optimize`
// request, to the skill list's.
//
// Not counted: requests that weren't journaled (side requests without tools,
// and requests cut off, before 2026-10-24; Claude Code's suggestion-mode
// requests before 2026-10-23), and a
// conversation's requests after one whose model has no price, where its cost
// stops, as in its info.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { add, addResent, before, spent, type Cost } from './cost.ts'
import { bareLines, forks as forksOf, history } from './journal.ts'
import { costLines, counted, money, SUMMARIES, type Stats } from './stats.ts'

type Sum = { conversations: Set<string>; requests: number; without: number; actual: number; saved: Record<string, number>; compactions: number; waitMs: number }
const blank = (): Sum => ({ conversations: new Set(), requests: 0, without: 0, actual: 0, saved: {}, compactions: 0, waitMs: 0 })

const localDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA')

export function totals(stateDir: string, ttlMs: number): string {
  const groups = new Map<string, Sum>()
  const at = (g: string) => groups.get(g) ?? (groups.set(g, blank()), groups.get(g)!)
  const count = (key: string, model: string, d: Partial<Omit<Sum, 'conversations'>>) => {
    for (const g of ['all', `env:${key.split('-')[0]}\0${model}`]) {
      const t = at(g)
      t.conversations.add(key)
      for (const [k, v] of Object.entries(d)) {
        if (k === 'saved') for (const [type, n] of Object.entries(v as Sum['saved'])) t.saved[type] = (t.saved[type] ?? 0) + n
        else t[k as Exclude<keyof Sum, 'conversations' | 'saved'>] += v as number
      }
    }
  }
  let first: string | undefined
  let stopped = 0
  let unreadable = 0
  const files = readdirSync(stateDir).filter((f) => f.endsWith('.journal.jsonl'))
  for (const f of files) {
    const key = f.slice(0, -'.journal.jsonl'.length)
    const file = path.join(stateDir, f)
    let c: Cost | undefined = { without: 0, actual: 0, saved: {}, compactions: 0, waitMs: 0 }
    let prev: Stats | undefined
    let last: string | undefined
    let forks = 0
    try {
      for (const { stats: s, usage: u, resent } of history(file)) {
        const next = u && c ? (resent ? addResent(c, s, u) : add(c, prev, s, u, ttlMs)) : c
        if (c && !next) stopped++
        const d = { requests: s.requests - (prev?.requests ?? 0) }
        count(key, s.model, next && c ? { ...d, without: next.without - c.without, actual: next.actual - c.actual, saved: Object.fromEntries(Object.entries(next.saved).map(([t, n]) => [t, n - (c!.saved[t] ?? 0)])), compactions: next.compactions - c.compactions, waitMs: next.waitMs - c.waitMs } : d)
        if (!first || s.first < first) first = s.first
        c = next
        prev = before(s)
        last = s.model
      }
      for (const k of forksOf(file)) {
        const v = k.usage ? spent(k.model, k.provider, k.usage) : 0
        count(key, k.model, { actual: v, saved: { [k.kind === 'optimize' ? 'skills-shaved' : SUMMARIES]: -v } })
        if (k.kind === 'summary') forks += v
      }
      for (const b of bareLines(file)) {
        const v = b.usage ? spent(b.model, b.provider, b.usage) : 0
        count(key, b.model, { without: v, actual: v })
      }
    } catch {
      unreadable++
      continue
    }
    const rest = spentOf(stateDir, key) - forks
    if (last && rest > 0) count(key, last, { actual: rest, saved: { [SUMMARIES]: -rest } })
  }

  const all = at('all')
  const out = [`All sessions: ${counted(all.conversations.size, 'session')}, ${counted(all.requests, 'request')}${first ? `, since ${localDay(first)}` : ''}`, '', ...costLines(all, 'Costs (all time)')]
  // One entry per harness and model: its two names, then its figures under
  // the column headings, each column as wide as its widest cell, and the
  // figures ending where the no-shaver line above ends.
  const envs = [...groups].filter(([g]) => g.startsWith('env:')).sort(([a], [b]) => (a < b ? -1 : 1))
  if (envs.length) {
    const head = ['#sess', '#req', 'no shaver', 'actual', 'saved']
    const cells = envs.map(([, t]) => {
      const saved = t.without - t.actual
      const share = t.without ? Math.round((saved / t.without) * 100) : 0
      return [String(t.conversations.size), t.requests.toLocaleString('en-US'), money(t.without), money(t.actual), money(saved), `(${String(share).padStart(2)}%)`]
    })
    const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)))
    const row = (c: string[]) => c.map((v, i) => (i ? '  ' : '') + v.padStart(widths[i])).join('')
    const shareWidth = Math.max(...cells.map((c) => c[5].length))
    const figures = cells.map((c) => row(c.slice(0, 5)) + ' ' + c[5].padStart(shareWidth))
    const indent = ' '.repeat(Math.max(2, out[3].length - figures[0].length) + 2)
    out.push('', 'By environment', indent + row(head))
    envs.forEach(([g], n) => {
      const [harness, model] = g.slice('env:'.length).split('\0')
      out.push(`  ${model}`, `  on ${harness}`, indent + figures[n])
    })
  }
  const notes = [
    ...(stopped ? [`${counted(stopped, 'session')} stopped at a model with no price`] : []),
    ...(unreadable ? [`${counted(unreadable, 'journal')} couldn't be read`] : []),
    "side requests and requests cut off before 2026-10-24, and suggestion-mode requests before 2026-10-23, weren't journaled",
  ]
  out.push('', `Not counted: ${notes.join('; ')}.`)
  return out.join('\n')
}

// What a conversation's summary forks cost in all, as its info counts it.
function spentOf(stateDir: string, key: string): number {
  try {
    return JSON.parse(readFileSync(path.join(stateDir, `${key}.summaries.json`), 'utf8')).spent ?? 0
  } catch {
    return 0
  }
}

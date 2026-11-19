// The answer to `shaver info`, from a conversation's state files, shared by
// the proxy (server.ts, stats) and scripts/info.ts, which gives it for any
// conversation with no proxy running.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { counted, render, SUMMARIES, type Forks, type Stats } from './stats.ts'
import { bareLines, history, latest } from './journal.ts'
import { addBare, cost, type Cost } from './cost.ts'
import type { Summary } from './summary.ts'

// A conversation's records (summary.ts), how many of the oldest the memoir
// holds, and the dollars its summary forks have cost. They are kept apart from
// its state, which a request answered after a summary fork began, and prepared
// before it ended, would save over. `failed` is the last summary fork that gave
// no record (Forks, stats.ts).
export type Summaries = { chain: Summary[]; merged?: number; spent: number; requests: number; failed?: Forks['failed'] }
export const summariesIn = (dir: string, key: string) => path.join(dir, `${key}.summaries.json`)
export function summariesFrom(dir: string, key: string): Summaries {
  try {
    const s = JSON.parse(readFileSync(summariesIn(dir, key), 'utf8'))
    return { ...s, requests: s.requests ?? s.chain.length }
  } catch {
    return { chain: [], spent: 0, requests: 0 }
  }
}

export const journalIn = (dir: string, key: string) => path.join(dir, `${key}.journal.jsonl`)

// A conversation's stats as its journal ends (journal.ts) and its cost so far
// (cost.ts), the requests journaled bare included.
export function journaled(dir: string, key: string, ttlMs: number): { stats?: Stats; cost?: Cost } {
  let c = cost(history(journalIn(dir, key)), ttlMs)
  for (const b of bareLines(journalIn(dir, key))) c = addBare(c, b)
  return { stats: latest(journalIn(dir, key)), cost: c }
}

// What the proxy knows that the state files don't: the summary records that
// still fit the messages, and the requests no journal line was written for.
// Without a running proxy, no summary fork is in flight and none were missed.
export type Live = { valid: number; inFlight?: boolean; missed?: number }

// `shaver info`'s text: the stats, or with none journaled yet, `estimated`
// ones; the cost with the summary forks' spend; and the summary requests,
// each of which is running, or left a record or none. A record no longer
// fitting the messages is dropped, like one replaced or none at all.
export function infoText(key: string, version: string, s: Stats, estimated: boolean, c: Cost | undefined, sums: Summaries, summarized: number, live: Live): string {
  const withForks = c && { ...c, actual: c.actual + sums.spent, saved: { ...c.saved, [SUMMARIES]: (c.saved[SUMMARIES] ?? 0) - sums.spent } }
  const applied = Math.min(summarized, live.valid)
  const pending = live.valid - applied + (live.inFlight ? 1 : 0)
  const forks: Forks = { applied, pending, dropped: sums.requests - applied - pending, ...(sums.failed && { failed: sums.failed }) }
  const text = render(s, key, estimated, withForks, forks)
  const warning = live.missed ? `\n\nshaver: since it started, the journal missed ${counted(live.missed, 'request')}; see proxy.log` : ''
  return '```\n' + `Shaver Version: ${version}\n` + text + warning + '\n```'
}

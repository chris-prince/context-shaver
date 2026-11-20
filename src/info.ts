// The answer to `shaver info`, from a conversation's state files, shared by
// the proxy (server.ts, stats) and scripts/info.ts, which gives it for any
// conversation with no proxy running.

import { readdirSync, readFileSync } from 'node:fs'
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

// The rest of a conversation's session, which `shaver info`'s cost sums: its
// earlier histories, each a conversation of its own once a compaction or
// rewind gave it a new first message (harness.ts, conversationId), and in
// a main conversation, its subagents: a Claude Code subagent's session ends in
// its agent ID where the main's ends in "main", and a Codex subagent's in its
// thread ID where the parent's is the session alone. A key with no session
// (its first message alone) has none. `agent` is a subagent's ID; `spent`, its
// summary forks' dollars.
export type Other = { key: string; agent?: string; stats?: Stats; cost?: Cost; spent: number }
export function othersOf(dir: string, key: string, read: (key: string) => { stats?: Stats; cost?: Cost }): Other[] {
  const own = key.slice(0, key.lastIndexOf('-') + 1)
  if (!own.slice(0, -1).includes('-')) return []
  const session = key.startsWith('claude-') && own.endsWith('-main-') ? own.slice(0, -'main-'.length) : own
  return readdirSync(dir)
    .filter((f) => f.endsWith('.journal.jsonl'))
    .map((f) => f.slice(0, -'.journal.jsonl'.length))
    // A journal moved aside (`<key>.pre-repair`) isn't a conversation's.
    .filter((k) => k !== key && k.startsWith(session) && !k.includes('.'))
    .map((k) => {
      // Between the session and the first message's hash: "main", a Claude
      // Code agent ID, a Codex thread ID, or nothing (a Codex parent's).
      const between = k.slice(session.length, Math.max(session.length, k.lastIndexOf('-')))
      return { key: k, ...(between && between !== 'main' && { agent: between }), ...read(k), spent: summariesFrom(dir, k).spent }
    })
}

// A cost with its summary forks' spend, which is charged to the summaries'
// saving.
const withForks = (c: Cost, spent: number): Cost => ({ ...c, actual: c.actual + spent, saved: { ...c.saved, [SUMMARIES]: (c.saved[SUMMARIES] ?? 0) - spent } })

function plus(a: Cost, b: Cost): Cost {
  const saved = { ...a.saved }
  for (const [t, n] of Object.entries(b.saved)) saved[t] = (saved[t] ?? 0) + n
  return { ...a, without: a.without + b.without, actual: a.actual + b.actual, saved, compactions: a.compactions + b.compactions, waitMs: a.waitMs + b.waitMs }
}

// What the session's cost covers besides the conversation: its earlier
// histories and subagents with stats (one of side requests only is counted,
// but isn't a history), and those whose model has no price, so aren't.
function noteOf(others: Other[]): string | undefined {
  const shown = others.filter((o) => o.stats)
  const histories = shown.filter((o) => !o.agent).length
  const agents = new Set(shown.flatMap((o) => o.agent ?? [])).size
  const parts = [...(histories ? [`${histories} earlier ${histories === 1 ? 'history' : 'histories'}`] : []), ...(agents ? [counted(agents, 'subagent')] : [])]
  const unpriced = shown.filter((o) => !o.cost).length
  if (!parts.length) return undefined
  return `Includes ${parts.join(' and ')}${unpriced ? ` (${unpriced} not counted: no price for its model)` : ''}.`
}

// What the proxy knows that the state files don't: the summary records that
// still fit the messages, and the requests no journal line was written for.
// Without a running proxy, no summary fork is in flight and none were missed.
export type Live = { valid: number; inFlight?: boolean; missed?: number }

// `shaver info`'s text: the stats, or with none journaled yet, `estimated`
// ones; the cost with the summary forks' spend, summed over the session
// (othersOf); and the summary requests, each of which is running, or left a
// record or none. A record no longer fitting the messages is dropped, like
// one replaced or none at all.
export function infoText(key: string, version: string, s: Stats, estimated: boolean, c: Cost | undefined, sums: Summaries, summarized: number, live: Live, others: Other[] = []): string {
  const session = c && others.reduce((t, o) => (o.cost ? plus(t, withForks(o.cost, o.spent)) : t), withForks(c, sums.spent))
  const applied = Math.min(summarized, live.valid)
  const pending = live.valid - applied + (live.inFlight ? 1 : 0)
  const forks: Forks = { applied, pending, dropped: sums.requests - applied - pending, ...(sums.failed && { failed: sums.failed }) }
  const text = render(s, key, estimated, session, forks, noteOf(others))
  const warning = live.missed ? `\n\nshaver: since it started, the journal missed ${counted(live.missed, 'request')}; see proxy.log` : ''
  return '```\n' + `Shaver Version: ${version}\n` + text + warning + '\n```'
}

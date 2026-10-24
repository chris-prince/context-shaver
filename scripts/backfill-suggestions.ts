// Adds to a conversation's journal the prompt-suggestion requests the proxy
// answered before 2026-10-23 without journaling, rebuilt from its logs. Each
// goes in before the first line after it, counted from the stats before it,
// with that line's deferred tools, skills, turns and cache TTL (which come
// from what prepare learned, not from the request). The lines already there
// keep their stats, but for removedTokens, which grows by what the
// suggestions' trims removed. A suggestion already journaled is left alone,
// so a second run changes nothing.
//
// Stop the proxy first: it holds each conversation's latest stats and writes
// its next line as a change from them. The journal is kept as
// <key>.journal.jsonl.pre-backfill, which `:shaver info all` doesn't read.
//
// Usage: bin/node-wrapper scripts/backfill-suggestions.ts <key>…

import { copyFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { describe, isSuggestion, observe, type Sent, type Stats } from '../src/stats.ts'
import { forkOf, history, record, recordBare, recordFork, recordResent } from '../src/journal.ts'
import type { Usage } from '../src/cost.ts'

export type Suggestion = { sent: Sent; inputTokens: number; outputTokens: number; usage: Usage }

// Writes to out the journal at file with each suggestion, in time order, in
// its place; returns how many went in and the tokens their trims removed.
export function fill(file: string, out: string, suggestions: Suggestion[]): { inserted: number; removed: number } {
  const raw = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const lines = history(file)
  const have = new Set<string>()
  for (const { stats } of history(file)) have.add(stats.time)
  const todo = suggestions.filter((x) => !have.has(x.sent.time))
  let prev: Stats | undefined
  let extra = 0
  let inserted = 0
  // Journals the suggestions from before time.
  const before = (time: string) => {
    while (todo.length && todo[0].sent.time < time) {
      const x = todo.shift()!
      if (!prev) continue
      const sent = { ...x.sent, defs: { ...x.sent.defs, ...pick(prev.defs) }, turns: prev.turns, ...(prev.ttl && { ttl: prev.ttl }) }
      const next = observe(prev, sent, x.inputTokens, x.outputTokens)
      extra += next.removedTokens - prev.removedTokens
      record(out, prev, next, x.usage)
      prev = next
      inserted++
    }
  }
  for (const d of raw) {
    const f = forkOf(d)
    if (f) {
      before(f.time)
      recordFork(out, f)
      continue
    }
    if (d.bare) {
      before(d.bare.time)
      recordBare(out, d.bare)
      continue
    }
    const { stats } = lines.next().value!
    before(stats.time)
    const next = structuredClone({ ...stats, removedTokens: stats.removedTokens + extra })
    if (d.resent) prev = recordResent(out, prev!, next.time, d.usage)
    else {
      record(out, prev, next, d.usage)
      prev = next
    }
  }
  return { inserted, removed: extra }
}

const pick = (defs: Stats['defs']) => ({ ...(defs?.deferred !== undefined && { deferred: defs.deferred }), ...(defs?.skills !== undefined && { skills: defs.skills }) })

// The suggestions a session's logs hold, as the proxy would have counted them.
export function fromLogs(dir: string): Suggestion[] {
  const events = readFileSync(path.join(dir, 'step_events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const advanced = new Set(events.filter((e) => e.event === 'compaction' && e.advanced).map((e) => e.time))
  const part = (h: string) => JSON.parse(readFileSync(path.join(dir, 'parts', h + '.json'), 'utf8'))
  return events
    .filter((e) => e.event === 'request' && e.inputTokens && e.tools && !e.bare)
    .flatMap((r) => {
      const messages = r.parts.map((p: { hash: string }) => part(p.hash))
      if (!isSuggestion(messages)) return []
      const body = { model: r.model, messages, system: r.system.map((x: { hash: string }) => part(x.hash)), tools: r.tools.map((t: { hash: string }) => part(t.hash)) }
      const sent = { ...describe(body, r.trimmedEnd ?? r.frontierEnd ?? { tools: 0, reasoning: 0 }, r.time, advanced.has(r.time)), suggestion: true }
      const usage = {
        input_tokens: r.inputTokens - r.cachedTokens - r.writtenTokens5m - r.writtenTokens60m,
        cache_read_input_tokens: r.cachedTokens,
        cache_creation_input_tokens: r.writtenTokens5m + r.writtenTokens60m,
        cache_creation: { ephemeral_5m_input_tokens: r.writtenTokens5m, ephemeral_1h_input_tokens: r.writtenTokens60m },
        output_tokens: r.outputTokens ?? 0,
      }
      return [{ sent, inputTokens: r.inputTokens, outputTokens: r.outputTokens ?? 0, usage }]
    })
}

if (import.meta.main) {
  const keys = process.argv.slice(2)
  if (!keys.length) {
    console.error('usage: bin/node-wrapper scripts/backfill-suggestions.ts <key>…')
    process.exit(1)
  }
  if (await fetch('http://127.0.0.1:8787/').then(() => true, () => false)) {
    console.error('the proxy is running: stop it first (bin/run-proxy --stop)')
    process.exit(1)
  }
  const data = path.join(import.meta.dirname, '..', 'proxy-data')
  for (const key of keys) {
    const file = path.join(data, 'state', key + '.journal.jsonl')
    const out = file + '.backfill'
    if (existsSync(out)) rmSync(out)
    const { inserted, removed } = fill(file, out, fromLogs(path.join(data, 'logs', key)))
    if (!inserted) {
      rmSync(out, { force: true })
      console.log(`${key}: nothing to add`)
      continue
    }
    if (!existsSync(file + '.pre-backfill')) copyFileSync(file, file + '.pre-backfill')
    renameSync(out, file)
    console.log(`${key}: added ${inserted} suggestions, whose trims removed ${Math.round(removed).toLocaleString('en-US')} tokens`)
  }
}

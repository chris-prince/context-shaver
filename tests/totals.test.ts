import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { describe, observe, type Stats } from '../src/stats.ts'
import { history, latest, record, recordResent, recordSummaryFork } from '../src/journal.ts'
import { cost, spent } from '../src/cost.ts'
import { totals } from '../src/totals.ts'
import type { ApiMsg } from '../src/items.ts'

const ends = { tools: 0, reasoning: 0 }
const user = (text: string): ApiMsg => ({ role: 'user', content: text })
const reply = (text: string): ApiMsg => ({ role: 'assistant', content: [{ type: 'text', text }] })
const HOUR = 3600_000

// A conversation of n growing requests a minute apart, journaled to dir.
function conversation(dir: string, key: string, model: string, n: number) {
  const file = path.join(dir, `${key}.journal.jsonl`)
  let s: Stats | undefined
  const msgs: ApiMsg[] = [user('a'.repeat(4000))]
  for (let i = 0; i < n; i++) {
    const body = { model, messages: [...msgs], system: 'sys', tools: [{ name: 'Bash' }] }
    const next = observe(s, describe(body, ends, `2026-10-11T10:${String(i).padStart(2, '0')}:00Z`), 2000 + 500 * i, 30)
    record(file, s, next, { input_tokens: 10, cache_read_input_tokens: i ? 1500 + 500 * i : 0, cache_creation_input_tokens: i ? 500 : 2000, output_tokens: 30 })
    s = next
    msgs.push(reply('b'.repeat(1000)), user('c'.repeat(1000)))
  }
  return file
}

test('all-time totals add up what each conversation info shows', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shaver-totals-'))
  const a = conversation(dir, 'claude-aaaa', 'claude-opus-5-5', 6)
  const b = conversation(dir, 'codex-bbbb', 'gpt-6-luna', 4)
  const fork = { time: '2026-10-11T10:30:00Z', model: 'claude-opus-5-5', usage: { input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, output_tokens: 800 } }
  recordSummaryFork(a, fork)
  // A request refused changed and resent as it came.
  const resent = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 6000, output_tokens: 30 }
  recordResent(a, latest(a)!, '2026-10-11T10:31:00Z', resent)
  // The summaries file holds the fork's spend and one from before forks were
  // journaled.
  writeFileSync(path.join(dir, 'claude-aaaa.summaries.json'), JSON.stringify({ spent: spent(fork.model, undefined, fork.usage) + 0.5 }))
  const ca = cost(history(a), HOUR)!
  const cb = cost(history(b), HOUR)!
  const text = totals(dir, HOUR)
  const money = (v: number) => '$' + v.toFixed(2)
  // The resent request costs the same either way.
  const lines = Array.from(history(a), (l) => ({ ...l, stats: structuredClone(l.stats) }))
  const before = cost(lines.slice(0, -1), HOUR)!
  const v = spent('claude-opus-5-5', undefined, resent)
  assert.ok(Math.abs(ca.without - before.without - v) < 1e-12)
  assert.ok(Math.abs(ca.actual - before.actual - v) < 1e-12)
  assert.match(text, /^All sessions: 2 sessions, 11 requests, since 2026-10-11/)
  assert.match(text, new RegExp(`\\${money(ca.without + cb.without)} if no shaver`))
  assert.match(text, new RegExp(`\\${money(ca.actual + cb.actual + spent(fork.model, undefined, fork.usage) + 0.5)} actual`))
  assert.match(text, /\nBy environment\n +#sess  #req  .*\n  claude-opus-5-5\n  on claude\n +1 {5}7  /)
  assert.match(text, /\n {2}gpt-6-luna\n {2}on codex\n +1 {5}4  /)
  assert.doesNotMatch(text, /days/)
})

test('totals with no journals', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shaver-totals-'))
  assert.match(totals(dir, HOUR), /^All sessions: 0 sessions, 0 requests\n/)
})

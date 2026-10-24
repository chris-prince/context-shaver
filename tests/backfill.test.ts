import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { describe, observe } from '../src/stats.ts'
import { forks, history, record } from '../src/journal.ts'
import type { ApiMsg } from '../src/items.ts'
import { fill } from '../scripts/backfill-suggestions.ts'

const ends = { tools: 0, reasoning: 0 }
const body = (messages: ApiMsg[]) => ({ model: 'm', messages, system: 'sys', tools: [{ name: 'Bash' }] })
const usage = (n: number) => ({ input_tokens: n, output_tokens: 0 })
// Replay changes one stats object in place, so each step is copied as it comes.
const stats = (file: string) => Array.from(history(file), (h) => structuredClone(h.stats))

test('a backfilled suggestion is journaled as the proxy now journals it, and its trim counts after', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'backfill-'))
  const a: ApiMsg = { role: 'user', content: 'a'.repeat(400) }
  const b: ApiMsg = { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(400) }] }
  const c: ApiMsg = { role: 'user', content: 'c' }
  const stub: ApiMsg = { role: 'assistant', content: [{ type: 'text', text: 'b' }] }
  const ask: ApiMsg = { role: 'user', content: '[SUGGESTION MODE: Suggest what the user might naturally type next]'.repeat(20) }
  const d: ApiMsg = { role: 'user', content: 'd' }
  const sent1 = describe(body([a, b, c]), ends, '2026-10-11T10:00:00Z')
  const suggestion = { ...describe(body([a, stub, c, ask]), ends, '2026-10-11T10:00:10Z', true), suggestion: true }
  const sent3 = describe(body([a, stub, c, d]), ends, '2026-10-11T10:01:00Z')
  const fork = { time: '2026-10-11T10:00:30Z', model: 'm' }

  // As the proxy journals it now.
  const live = path.join(dir, 'live.journal.jsonl')
  const s1 = observe(undefined, sent1, 1000, 0)
  const s2 = observe(s1, suggestion, 900, 10)
  record(live, undefined, s1, usage(1000))
  record(live, s1, s2, usage(900))
  record(live, s2, observe(s2, sent3, 700, 0), usage(700))

  // As it did before: the suggestion missing, so the next request finds the
  // trim made already and counts nothing removed. Lines then had no
  // suggestion field, so the line after an inserted suggestion must clear it.
  const old = path.join(dir, 'old.journal.jsonl')
  const { suggestion: _, ...o1 } = s1
  const { suggestion: __, ...t3 } = observe(s1, sent3, 700, 0)
  assert.equal(t3.removedTokens, 0)
  record(old, undefined, o1, usage(1000))
  appendFileSync(old, JSON.stringify({ summaryFork: fork }) + '\n')
  record(old, o1, t3, usage(700))

  const filled = path.join(dir, 'filled.journal.jsonl')
  assert.deepEqual(fill(old, filled, [{ sent: suggestion, inputTokens: 900, outputTokens: 10, usage: usage(900) }]), { inserted: 1, removed: s2.removedTokens })
  const [f1, f2, f3] = stats(filled)
  const [, l2, l3] = stats(live)
  assert.deepEqual([f1, f2], [o1, l2])
  assert.equal(f3.removedTokens, l3.removedTokens)
  assert.deepEqual({ ...f3, removedTokens: 0 }, t3)
  assert.deepEqual([...history(filled)].map((h) => h.usage), [usage(1000), usage(900), usage(700)])
  // The fork keeps its place, after the suggestion it came after, an older
  // summary fork's line written as a fork's.
  const lines = readFileSync(filled, 'utf8').trim().split('\n')
  assert.ok(JSON.parse(lines[2]).fork)
  assert.deepEqual([...forks(filled)], [{ ...fork, kind: 'summary' }])

  // A second run finds the suggestion journaled and adds nothing.
  const again = path.join(dir, 'again.journal.jsonl')
  assert.deepEqual(fill(filled, again, [{ sent: suggestion, inputTokens: 900, outputTokens: 10, usage: usage(900) }]), { inserted: 0, removed: 0 })
  assert.equal(readFileSync(again, 'utf8'), readFileSync(filled, 'utf8'))
})

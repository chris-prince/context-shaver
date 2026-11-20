import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { describe, observe } from '../src/stats.ts'
import { infoText, othersOf } from '../src/info.ts'
import type { Cost } from '../src/cost.ts'

const s = observe(undefined, describe({ model: 'm', messages: [{ role: 'user', content: 'a' }], system: 'sys', tools: [] }, { tools: 0, reasoning: 0 }, '2026-11-19T10:00:00Z'), 1000, 30)
const cost = (n: number): Cost => ({ without: 2 * n, actual: n, saved: { tools: n }, compactions: 1, waitMs: 60_000 })

test("a Claude Code conversation's session is its ancestor conversations and its subagents", () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'info-'))
  for (const k of ['claude-s1-main-aaaa', 'claude-s1-main-bbbb', 'claude-s1-ag1-cccc', 'claude-s1-ag1-dddd', 'claude-s1-main-bbbb.pre-repair', 'claude-s2-main-eeee']) appendFileSync(path.join(dir, `${k}.journal.jsonl`), '')
  writeFileSync(path.join(dir, 'claude-s1-main-bbbb.summaries.json'), JSON.stringify({ chain: [], spent: 0.5 }))
  const others = othersOf(dir, 'claude-s1-main-aaaa', () => ({}))
  assert.deepEqual(others.map((o) => [o.key, o.agent, o.spent]).sort(), [['claude-s1-ag1-cccc', 'ag1', 0], ['claude-s1-ag1-dddd', 'ag1', 0], ['claude-s1-main-bbbb', undefined, 0.5]])
  // A subagent's session is its own conversations, not the main conversation.
  assert.deepEqual(othersOf(dir, 'claude-s1-ag1-cccc', () => ({})).map((o) => o.key), ['claude-s1-ag1-dddd'])
  // A key with no session has none.
  appendFileSync(path.join(dir, 'claude-ffff.journal.jsonl'), '')
  assert.deepEqual(othersOf(dir, 'claude-ffff', () => ({})), [])
})

test("a Codex conversation's session is its ancestor conversations and its subagents' threads", () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'info-'))
  for (const k of ['codex-s1-aaaa', 'codex-s1-bbbb', 'codex-s1-thr1-cccc', 'codex-s1-thr1-dddd', 'codex-s1-thr2-eeee', 'codex-s2-ffff']) appendFileSync(path.join(dir, `${k}.journal.jsonl`), '')
  const others = othersOf(dir, 'codex-s1-aaaa', () => ({}))
  assert.deepEqual(others.map((o) => [o.key, o.agent]).sort(), [['codex-s1-bbbb', undefined], ['codex-s1-thr1-cccc', 'thr1'], ['codex-s1-thr1-dddd', 'thr1'], ['codex-s1-thr2-eeee', 'thr2']])
  assert.deepEqual(othersOf(dir, 'codex-s1-thr1-cccc', () => ({})).map((o) => o.key), ['codex-s1-thr1-dddd'])
})

test("shaver info's costs are the session's, with a note first saying what they include", () => {
  const sums = { chain: [], spent: 0.25, requests: 0 }
  const others = [
    { key: 'h', stats: s, cost: cost(2), spent: 0.5 },
    { key: 'a', agent: 'x', stats: s, cost: cost(4), spent: 0 },
    { key: 'a2', agent: 'x', stats: s, cost: cost(8), spent: 0 },
    // Side requests only: counted, but not a conversation.
    { key: 'side', cost: cost(16), spent: 0 },
    // No price for its model: a conversation, but not counted.
    { key: 'u', stats: s, spent: 0 },
  ]
  const out = infoText('k', 'v', s, false, cost(1), sums, 0, { valid: 0 }, others)
  const actual = 1 + 2 + 4 + 8 + 16 + 0.25 + 0.5
  assert.match(out, new RegExp(`Shaver Summary\\n\\n  « Includes 2 ancestor conversations and 1 subagent \\(1 not counted: no price for its model\\)\\. »\\n\\n  Costs \\(session\\)\\n +\\$62\\.00 if no shaver.*\\n +\\$${actual.toFixed(2).replace('.', '\\.')} actual`))
  // The breakdown and speedup are the session's too: the summaries' spend
  // charged to their saving.
  assert.match(out, /\$31\.00 \(50%\) conv:tools/)
  assert.match(out, /-\$0\.75 \(-1%\) conv:summary\+memoir/)
  assert.match(out, /5 minutes saved \(by avoiding 5 \/autocompact\)/)
  // With nothing else in the session, there's no note.
  assert.doesNotMatch(infoText('k', 'v', s, false, cost(1), sums, 0, { valid: 0 }), /Includes/)
})

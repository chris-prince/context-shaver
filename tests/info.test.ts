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
  // A journal of side requests only gives how many it journaled; others don't.
  appendFileSync(path.join(dir, 'claude-s1-main-bbbb.journal.jsonl'), JSON.stringify({ bare: { time: '2026-11-19T10:00:00Z', model: 'm', why: 'side' } }) + '\n')
  assert.equal(othersOf(dir, 'claude-s1-main-aaaa', () => ({})).find((o) => o.key === 'claude-s1-main-bbbb')!.sides, 1)
  assert.equal(othersOf(dir, 'claude-s1-main-aaaa', (k) => (k === 'claude-s1-main-bbbb' ? { stats: s } : {})).find((o) => o.key === 'claude-s1-main-bbbb')!.sides, undefined)
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
    // Side requests only, journaled bare or none counted as a request: their
    // cost counted, and they're side requests, not conversations.
    { key: 'side', cost: cost(16), spent: 0, sides: 3 },
    { key: 'search', stats: { ...s, requests: 0 }, cost: { without: 0, actual: 0, saved: {}, compactions: 0, waitMs: 0 }, spent: 0, sides: 1 },
    // No price for its model: a conversation, but not counted.
    { key: 'u', stats: s, spent: 0 },
  ]
  const out = infoText('k', 'v', s, false, cost(1), sums, 0, { valid: 0 }, others)
  const actual = 1 + 2 + 4 + 8 + 16 + 0.25 + 0.5
  assert.match(out, new RegExp(`Shaver Summary\\n\\n  « Includes 1 ancestor conv, 1 subagent, 4 side reqs\\. »\\n\\n  Costs \\(session\\)\\n +\\$62\\.00 if no shaver.*\\n +\\$${actual.toFixed(2).replace('.', '\\.')} actual`))
  // The conversation left out is warned of at the bottom, with the journal's
  // misses and ignored breakpoints.
  const warned = infoText('k', 'v', s, false, cost(1), sums, 0, { valid: 0, missed: 2, ignoredMarks: 1 }, others)
  const one = (t: string) => t.slice(t.indexOf('WARNINGS')).replace(/\n    /g, ' ')
  assert.match(one(warned), /^WARNINGS\n\n  - Model not known to shaver: m Costs omit 1 conv, and shaver may trim inefficiently!\n  - Since shaver started, the journal missed 2 requests; see proxy\.log\.\n  - The server ignored the explicit breakpoints on 1 request, .*; see scripts\/audit\.ts\.\n```$/)
  // Without a cost, only the session's own missing price is warned of.
  assert.match(one(infoText('k', 'v', s, false, undefined, sums, 0, { valid: 0 }, others)), /^WARNINGS\n\n  - Model not known to shaver: m Costs aren't shown, and shaver may trim inefficiently!\n```$/)
  // The breakdown and speedup are the session's too: the summaries' spend
  // charged to their saving.
  assert.match(out, /\$31\.00 \(50%\) conv:tools/)
  assert.match(out, /-\$0\.75 \(-1%\) conv:summary\+memoir/)
  assert.match(out, /5 minutes saved \(by avoiding 5 \/autocompact\)/)
  // Under the requests line, the rest of the session's requests and turns, a
  // line for its ancestor conversations, one for its subagents and one for its
  // side requests.
  assert.match(out, /spanning .*\n  \+ 2 requests across 2 turns, in ancestor convs\n  \+ 2 requests across 2 turns, in subagents\n  \+ 4 side reqs\n/)
  // With nothing else in the session, there's no note.
  assert.doesNotMatch(infoText('k', 'v', s, false, cost(1), sums, 0, { valid: 0 }), /Includes/)
})

test("a conversation going on from one in another session brings that session's in", () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'info-'))
  for (const k of ['claude-old-main-aaaa', 'claude-old-main-bbbb', 'claude-old-ag1-cccc', 'claude-new-main-bbbb', 'claude-new-main-dddd', 'claude-other-main-bbbb']) appendFileSync(path.join(dir, `${k}.journal.jsonl`), '')
  const turns = (n: number, more: object = {}) => ({ stats: { ...s, requests: 5, turns: n, ...more } })
  const read = (k: string) => (k === 'claude-new-main-bbbb' ? turns(12, { from: 'claude-old-main-bbbb' }) : k === 'claude-old-main-bbbb' ? turns(10) : turns(3))
  const others = othersOf(dir, 'claude-new-main-dddd', read)
  assert.deepEqual(others.map((o) => o.key).sort(), ['claude-new-main-bbbb', 'claude-old-ag1-cccc', 'claude-old-main-aaaa', 'claude-old-main-bbbb'])
  assert.equal(others.find((o) => o.key === 'claude-old-ag1-cccc')!.agent, 'ag1')
  // Each adds the turns it adds: the one going on from another, those past it.
  const out = infoText('claude-new-main-dddd', 'v', { ...s, turns: 4 }, false, cost(1), { chain: [], spent: 0, requests: 0 }, 0, { valid: 0 }, others)
  assert.match(out, /\+ 15 requests across 15 turns, in ancestor convs\n  \+ 5 requests across 3 turns, in subagents/)
  // The conversation asking going on from one counts that one's turns itself.
  const asking = othersOf(dir, 'claude-new-main-bbbb', read)
  assert.match(infoText('claude-new-main-bbbb', 'v', read('claude-new-main-bbbb').stats, false, cost(1), { chain: [], spent: 0, requests: 0 }, 0, { valid: 0 }, asking), /\+ 15 requests across 6 turns, in ancestor convs/)
})

test("a lone request adds at most its prompt's turn, and none if it's the client's compaction", () => {
  const lone = (more: object) => ({ key: 'x', stats: { ...s, requests: 1, turns: 42, ...more }, cost: cost(1), spent: 0 })
  const text = (more: object) => infoText('k', 'v', s, false, cost(1), { chain: [], spent: 0, requests: 0 }, 0, { valid: 0 }, [lone(more)])
  assert.match(text({}), /\+ 1 request across 1 turn, in ancestor convs/)
  assert.match(text({ compaction: true }), /\+ 1 request, in ancestor convs\n/)
})

test("the summary requests' outcomes are shown as errors (failed and rejected), empty (nothing complete), and the rest dropped", () => {
  const fates = (sums: object, summarized: number, live: { valid: number; inFlight?: boolean }) => infoText('k', 'v', s, false, cost(1), { chain: [], spent: 0, ...sums } as never, summarized, live).match(/summary creation requests?\n {6}(.*)/)![1]
  // 7 requests: 2 applied, 1 in flight, 1 failed, 1 rejected, 1 empty, and 1 recorded but since replaced.
  const outcomes = { recorded: 2, salvaged: 1, failed: 1, rejected: 1, 'nothing-complete': 1 }
  assert.equal(fates({ requests: 7, outcomes }, 2, { valid: 2, inFlight: true }), '2 applied, 1 pending, 1 empty, 2 errors, 1 dropped')
  // A file from before outcomes were counted: all that gave no record, dropped.
  assert.equal(fates({ requests: 4 }, 2, { valid: 2 }), '2 applied, 0 pending, 2 dropped')
})

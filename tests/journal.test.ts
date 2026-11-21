import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { describe, observe, type Stats } from '../src/stats.ts'
import { bareLines, diff, journalKeys, LastCalls, history, newestCall, latest, record, recordBare, recordFork, recordResent, replay, sideKey, forks } from '../src/journal.ts'
import { callIdsOf } from '../src/items.ts'
import type { ApiMsg } from '../src/items.ts'

const ends = { tools: 0, reasoning: 0 }
const body = (messages: ApiMsg[]) => ({ model: 'm', messages, system: 'sys', tools: [{ name: 'Bash' }] })
const user = (text: string): ApiMsg => ({ role: 'user', content: text })
const reply = (text: string): ApiMsg => ({ role: 'assistant', content: [{ type: 'text', text }] })
// Replay changes one stats object in place, so steps kept for later are copied.
const copy = (s: Stats) => structuredClone(s)

test('replaying the journal gives the stats after every request', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'journal-')), 'k.journal.jsonl')
  // Growing, a side request forking back, a trim changing an early message,
  // and a repeated message.
  const requests = [
    [user('a')],
    [user('a'), reply('b'), user('c')],
    [user('a')],
    [user('a'), reply('b'), user('c'), reply('d'), user('e')],
    [user('a'), reply('[trimmed]'), user('c'), reply('d'), user('e'), reply('f'), user('c')],
  ]
  const observed: Stats[] = []
  let s: Stats | undefined
  requests.forEach((msgs, i) => {
    const next = observe(s, describe(body(msgs), ends, `2026-10-11T10:0${i}:00Z`), 1000 + 100 * i, 30)
    record(file, s, next, { input_tokens: 10, cache_read_input_tokens: 900 + 100 * i, cache_creation_input_tokens: 90, output_tokens: 30 })
    observed.push((s = next))
  })
  assert.deepEqual(Array.from(replay(file), copy), observed)
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => l.usage.cache_read_input_tokens), [900, 1000, 1100, 1200, 1300])
  assert.deepEqual(latest(file), observed.at(-1))
})

test('a fork has its own line, which stats replay skips', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'journal-')), 'k.journal.jsonl')
  const s1 = observe(undefined, describe(body([user('a')]), ends, '2026-10-11T10:00:00Z'), 1000, 30)
  record(file, undefined, s1, { input_tokens: 10, output_tokens: 30 })
  const fork = { time: '2026-10-11T10:00:30Z', kind: 'summary' as const, model: 'm', usage: { input_tokens: 5, cache_read_input_tokens: 900, output_tokens: 400 } }
  recordFork(file, fork)
  // One answered 200 with nothing to read, and an older summary fork's line.
  const unread = { time: '2026-10-11T10:00:40Z', kind: 'summary' as const, model: 'm', why: 'no usage' as const }
  recordFork(file, unread)
  const older = { time: '2026-10-11T10:00:50Z', model: 'm', usage: { input_tokens: 7, output_tokens: 70 } }
  appendFileSync(file, JSON.stringify({ summaryFork: older }) + '\n')
  const s2 = observe(s1, describe(body([user('a'), reply('b'), user('c')]), ends, '2026-10-11T10:01:00Z'), 1100, 30)
  record(file, s1, s2, { input_tokens: 10, output_tokens: 30 })
  assert.deepEqual(Array.from(replay(file), copy), [s1, s2])
  assert.deepEqual([...forks(file)], [fork, unread, { ...older, kind: 'summary' }])
})

test('a resent request counts as a request, with its usage, and leaves the rest of the stats', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'journal-')), 'k.journal.jsonl')
  const s1 = observe(undefined, describe(body([user('a')]), ends, '2026-10-11T10:00:00Z'), 1000, 30)
  record(file, undefined, s1, { input_tokens: 10, output_tokens: 30 })
  const u = { input_tokens: 10, cache_creation_input_tokens: 1200, output_tokens: 30 }
  const s2 = recordResent(file, copy(s1), '2026-10-11T10:01:00Z', u)
  assert.deepEqual(s2, { ...s1, requests: 2, time: '2026-10-11T10:01:00Z' })
  const lines = Array.from(history(file), (l) => ({ ...l, stats: copy(l.stats) }))
  assert.deepEqual(lines.at(-1), { stats: s2, usage: u, resent: true })
  assert.equal(lines[0].resent, undefined)
  // A compaction request resent as it came is marked, so the next request is
  // known to follow a compaction; on replay too.
  const s3 = recordResent(file, copy(s2), '2026-10-11T10:02:00Z', u, true)
  assert.equal(s3.compaction, true)
  assert.equal(Array.from(history(file)).at(-1)!.stats.compaction, true)
  // The line before it says the next is the client's compaction; no other does.
  assert.deepEqual(Array.from(history(file), (l) => l.compactsNext), [undefined, true, undefined])
})

test('a field that goes away stays gone on replay', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'journal-')), 'k.journal.jsonl')
  const s1 = { ...observe(undefined, describe(body([user('a')]), ends, '2026-10-11T10:00:00Z'), 1000, 30), suggestion: true }
  record(file, undefined, s1, { input_tokens: 10, output_tokens: 30 })
  const { suggestion: _, ...s2 } = observe(s1, describe(body([user('a'), reply('b'), user('c')]), ends, '2026-10-11T10:01:00Z'), 1100, 30)
  record(file, s1, s2, { input_tokens: 10, output_tokens: 30 })
  assert.deepEqual(Array.from(replay(file), copy), [s1, s2])
})

test('every field of the stats is journaled, one no list names included', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'journal-')), 'k.journal.jsonl')
  const s1 = observe(undefined, describe(body([user('a')]), ends, '2026-10-11T10:00:00Z'), 1000, 30)
  const s2 = { ...observe(s1, { ...describe(body([user('c')]), ends, '2026-10-11T10:01:00Z'), compacted: true }, 1100, 30), unheardOf: [1] } as Stats
  const { unheardOf: _, ...s3 } = observe(s2, describe(body([user('c'), reply('d'), user('e')]), ends, '2026-10-11T10:02:00Z'), 1200, 30) as Stats & { unheardOf?: unknown }
  record(file, undefined, s1)
  record(file, s1, s2)
  record(file, s2, s3)
  assert.equal(s2.compacted, true)
  assert.deepEqual(Array.from(replay(file), copy), [s1, s2, s3])
})

test('a bare line has its usage and leaves the stats alone', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'journal-')), 'k.journal.jsonl')
  const s1 = observe(undefined, describe(body([user('a')]), ends, '2026-10-11T10:00:00Z'), 1000, 30)
  record(file, undefined, s1, { input_tokens: 10, output_tokens: 30 })
  const side = { time: '2026-10-11T10:00:30Z', model: 'haiku', usage: { input_tokens: 500, output_tokens: 20 }, why: 'side' as const }
  const cut = { time: '2026-10-11T10:00:40Z', model: 'm', why: 'cut off' as const }
  recordBare(file, side)
  recordBare(file, cut)
  const s2 = observe(s1, describe(body([user('a'), reply('b'), user('c')]), ends, '2026-10-11T10:01:00Z'), 1100, 30)
  record(file, s1, s2, { input_tokens: 10, output_tokens: 30 })
  assert.deepEqual(Array.from(replay(file), copy), [s1, s2])
  assert.deepEqual([...bareLines(file)], [side, cut])
})

test('a side request is journaled with its own conversation, or failing that its session', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'journal-'))
  const touch = (k: string) => appendFileSync(path.join(dir, `${k}.journal.jsonl`), '')
  touch('claude-s1-main-aaaa')
  touch('claude-s1-agent-x-bbbb')
  assert.equal(sideKey(dir, 'claude-s1-main-cccc'), 'claude-s1-main-aaaa')
  assert.equal(sideKey(dir, 'claude-s1-agent-x-dddd'), 'claude-s1-agent-x-bbbb')
  touch('codex-t1-eeee')
  assert.equal(sideKey(dir, 'codex-t1-eeee'), 'codex-t1-eeee')
  assert.equal(sideKey(dir, 'claude-s2-main-ffff'), 'claude-s2-main-ffff')
  // A Codex parent's side request isn't journaled with its subagent's thread.
  touch('codex-t1-thr1-gggg')
  assert.equal(sideKey(dir, 'codex-t1-hhhh'), 'codex-t1-eeee')
})

test('replaying the journal keeps the pinned provider', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'journal-')), 'k.journal.jsonl')
  const next = observe(undefined, describe({ ...body([user('a')]), provider: 'deepinfra' }, ends, '2026-10-11T10:00:00Z'), 1000, 30)
  record(file, undefined, next, { input_tokens: 10, output_tokens: 30 })
  assert.equal(latest(file)?.provider, 'deepinfra')
})

test('a line keeps runs of unchanged messages as ranges', () => {
  const s1 = observe(undefined, describe(body([user('a'), reply('b'), user('c')]), ends, '2026-10-11T10:00:00Z'), 900, 0)
  const s2 = observe(s1, describe(body([user('a'), reply('b'), user('c'), reply('d'), user('e')]), ends, '2026-10-11T10:01:00Z'), 1000, 0)
  const d = diff(s1, s2)
  assert.deepEqual(d.messages?.[0], [0, 3])
  assert.equal(d.messages?.length, 3)
})

// BACKCOMPAT: journals before 2026-11-07 call `messages` `parts`.
test('a journal from before the rename is read as one after it', () => {
  const s1 = observe(undefined, describe(body([user('a'), reply('b'), user('c')]), ends, '2026-10-11T10:00:00Z'), 900, 0)
  const s2 = observe(s1, describe(body([user('a'), reply('b'), user('c'), reply('d'), user('e')]), ends, '2026-10-11T10:01:00Z'), 1000, 0)
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'journal-')), 'journal.jsonl')
  const old = (d: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(d).map(([k, v]) => [k === 'messages' ? 'parts' : k, v])))
  writeFileSync(file, old(diff(undefined, s1)) + '\n' + old(diff(s1, s2)) + '\n')
  assert.deepEqual([...replay(file)].at(-1)!.messages, s2.messages)
})

test('there is no history without a journal', () => {
  assert.deepEqual([...replay(path.join(tmpdir(), 'no-such-journal.jsonl'))], [])
  assert.equal(latest(path.join(tmpdir(), 'no-such-journal.jsonl')), undefined)
})

test('a journal that will not replay is moved aside and the stats start again', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'journal-')), 'k.journal.jsonl')
  const s = observe(undefined, describe(body([user('a')]), ends, '2026-10-11T10:00:00Z'), 1000, 30)
  record(file, undefined, s)
  appendFileSync(file, '{"set":{"requ')
  assert.equal(latest(file), undefined)
  assert.equal(existsSync(file), false)
  assert.match(readFileSync(file.replace(/\.jsonl$/, '.bad.jsonl'), 'utf8'), /"requ$/)
})

test("a conversation goes on from one in another session whose newest tool call its first request holds", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'journal-')), 'last-calls.json')
  const calls = new LastCalls(file)
  calls.set('claude-old-main-aaaa', 'toolu_1')
  calls.set('claude-old-main-aaaa', 'toolu_2')
  calls.set('claude-other-main-bbbb', 'toolu_9')
  calls.set('codex-p-aaaa', 'call_1')
  // Found by the newest call; a different first message doesn't matter.
  assert.equal(calls.continuedFrom('claude-new-main-cccc', ['toolu_1', 'toolu_2', 'toolu_3']), 'claude-old-main-aaaa')
  // Not by a call that is no longer a conversation's newest, nor none at all.
  assert.equal(calls.continuedFrom('claude-new-main-cccc', ['toolu_1']), undefined)
  assert.equal(calls.continuedFrom('claude-new-main-cccc', []), undefined)
  // Of two, the one whose call is newest in the request.
  assert.equal(calls.continuedFrom('claude-new-main-cccc', ['toolu_2', 'toolu_9']), 'claude-other-main-bbbb')
  // Not another harness's, nor one in its own session: a Codex subagent forked
  // with its parent's history is the parent's session already.
  assert.equal(calls.continuedFrom('codex-new-aaaa', ['toolu_2']), undefined)
  assert.equal(calls.continuedFrom('codex-p-thr-aaaa', ['call_1']), undefined)
  // A restart reads the file, and only the file.
  assert.equal(new LastCalls(file).continuedFrom('claude-new-main-cccc', ['toolu_2']), 'claude-old-main-aaaa')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'claude-old-main-aaaa': 'toolu_2', 'claude-other-main-bbbb': 'toolu_9', 'codex-p-aaaa': 'call_1' })
  // A missing file is an empty table.
  assert.equal(new LastCalls(file + '.none').continuedFrom('claude-new-main-cccc', ['toolu_2']), undefined)
})

test("a request's newest tool call and the conversation it goes on from are kept in the stats", () => {
  const msgs = [user('a'), { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] }, user('b')]
  const s1 = observe(undefined, { ...describe(body(msgs), ends, '2026-11-20T10:00:00Z'), lastCall: 'toolu_1', from: 'claude-old-main-aaaa' }, 1000, 30)
  const s2 = observe(s1, describe(body([...msgs, reply('c'), user('d')]), ends, '2026-11-20T10:01:00Z'), 1100, 30)
  assert.equal(s1.lastCall, 'toolu_1')
  assert.equal(s2.lastCall, undefined)
  assert.equal(s2.from, 'claude-old-main-aaaa')
  assert.deepEqual(callIdsOf(msgs), ['toolu_1'])
})

test('a restart fills in the conversations the table lacks, from their journals or logs, and none is looked for twice', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'journal-'))
  const state = path.join(root, 'state')
  const logs = path.join(root, 'logs')
  mkdirSync(state)
  const journal = (k: string, lines: object[]) => writeFileSync(path.join(state, `${k}.journal.jsonl`), lines.map((l) => JSON.stringify(l) + '\n').join(''))
  // One whose journal has its newest call; one from before lastCall, whose
  // log has it; one with no tool call; one moved aside, which isn't a
  // conversation.
  journal('claude-a-main-aaaa', [{ set: { requests: 1, lastCall: 'toolu_1' } }, { set: { requests: 2, lastCall: 'toolu_2' } }])
  journal('claude-b-main-bbbb', [{ set: { requests: 1 } }])
  journal('claude-c-main-cccc', [{ set: { requests: 1 } }])
  journal('claude-d-main-dddd.bad', [{ set: { requests: 1 } }])
  const dir = path.join(logs, 'claude-b-main-bbbb')
  mkdirSync(path.join(dir, 'objects'), { recursive: true })
  const obj = (h: string, m: ApiMsg) => writeFileSync(path.join(dir, 'objects', `${h}.json`), JSON.stringify(m))
  obj('h1', user('a'))
  obj('h2', { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_3', name: 'Bash', input: {} }] })
  obj('h3', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: 'ok' }] })
  obj('h4', reply('done'))
  const line = (o: object) => JSON.stringify(o) + '\n'
  const messages = ['h1', 'h2', 'h3', 'h4'].map((hash, i) => ({ role: i % 2 ? 'assistant' : 'user', hash, bytes: 1 }))
  writeFileSync(path.join(dir, 'step_events.jsonl'), line({ event: 'request', messages }) + line({ event: 'summary' }) + line({ event: 'request', bare: true, messages: [] }))
  assert.deepEqual(journalKeys(state).sort(), ['claude-a-main-aaaa', 'claude-b-main-bbbb', 'claude-c-main-cccc'])
  assert.equal(newestCall(state, logs, 'claude-a-main-aaaa'), 'toolu_2')
  assert.equal(newestCall(state, logs, 'claude-b-main-bbbb'), 'toolu_3')
  assert.equal(newestCall(state, logs, 'claude-c-main-cccc'), null)

  const file = path.join(state, 'last-calls.json')
  writeFileSync(file, JSON.stringify({ 'claude-a-main-aaaa': 'toolu_9' }))
  const looked: string[] = []
  const find = (k: string) => (looked.push(k), newestCall(state, logs, k))
  // What the table has is kept; the rest are looked for once and saved.
  assert.equal(new LastCalls(file).fill(journalKeys(state), find), 2)
  assert.deepEqual(looked.sort(), ['claude-b-main-bbbb', 'claude-c-main-cccc'])
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'claude-a-main-aaaa': 'toolu_9', 'claude-b-main-bbbb': 'toolu_3', 'claude-c-main-cccc': null })
  // The next restart looks for none, and finds the filled one.
  looked.length = 0
  const again = new LastCalls(file)
  assert.equal(again.fill(journalKeys(state), find), 0)
  assert.deepEqual(looked, [])
  assert.equal(again.continuedFrom('claude-new-main-eeee', ['toolu_3']), 'claude-b-main-bbbb')
  // One found with none takes its call when it makes one.
  again.set('claude-c-main-cccc', 'toolu_4')
  assert.equal(new LastCalls(file).continuedFrom('claude-new-main-eeee', ['toolu_4']), 'claude-c-main-cccc')
})

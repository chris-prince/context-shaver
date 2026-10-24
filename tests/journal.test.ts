import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { describe, observe, type Stats } from '../src/stats.ts'
import { bareLines, diff, history, latest, record, recordBare, recordFork, recordResent, replay, sideKey, forks } from '../src/journal.ts'
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
})

test('replaying the journal keeps the pinned provider', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'journal-')), 'k.journal.jsonl')
  const next = observe(undefined, describe({ ...body([user('a')]), provider: 'deepinfra' }, ends, '2026-10-11T10:00:00Z'), 1000, 30)
  record(file, undefined, next, { input_tokens: 10, output_tokens: 30 })
  assert.equal(latest(file)?.provider, 'deepinfra')
})

test('a line keeps runs of unchanged parts as ranges', () => {
  const s1 = observe(undefined, describe(body([user('a'), reply('b'), user('c')]), ends, '2026-10-11T10:00:00Z'), 900, 0)
  const s2 = observe(s1, describe(body([user('a'), reply('b'), user('c'), reply('d'), user('e')]), ends, '2026-10-11T10:01:00Z'), 1000, 0)
  const d = diff(s1, s2)
  assert.deepEqual(d.parts?.[0], [0, 3])
  assert.equal(d.parts?.length, 3)
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

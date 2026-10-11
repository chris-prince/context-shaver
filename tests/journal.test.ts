import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { describe, observe, type Stats } from '../src/stats.ts'
import { diff, latest, record, replay } from '../src/journal.ts'
import type { ApiMsg } from '../src/items.ts'

const ends = { tools: 0, reasoning: 0 }
const body = (messages: ApiMsg[]) => ({ model: 'm', messages, system: 'sys', tools: [{ name: 'Bash' }] })
const user = (text: string): ApiMsg => ({ role: 'user', content: text })
const reply = (text: string): ApiMsg => ({ role: 'assistant', content: [{ type: 'text', text }] })

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
    record(file, s, next)
    observed.push((s = next))
  })
  assert.deepEqual([...replay(file)], observed)
  assert.deepEqual(latest(file), observed.at(-1))
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

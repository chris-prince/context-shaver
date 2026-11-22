// scripts/rereads.ts: when results are used again, and which are re-reads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiMsg } from '../src/items.ts'
import { usesOf, wholeIn } from '../scripts/rereads.ts'

const line = (k: number) => `const value${k} = computeSomethingLong(argument${k})`
const file = (from: number, to: number, numbered = false) => Array.from({ length: to - from + 1 }, (_, i) => (numbered ? `${String(from + i).padStart(6)}→` : '') + line(from + i)).join('\n')
const call = (id: string, input: object): ApiMsg => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input }] })
const result = (id: string, content: unknown): ApiMsg => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] })
// Each request the one before and the next exchange.
const grow = (...steps: ApiMsg[][]) => steps.reduce<ApiMsg[][]>((reqs, s) => [...reqs, [...(reqs.at(-1) ?? []), ...s]], [])

test('a quote counts for the newest result holding the line, decided on the request before it is sent', () => {
  const reqs = grow(
    [{ role: 'user', content: 'go' }],
    [call('a', { command: 'sed -n 1,10p f.ts' }), result('a', file(1, 10))],
    [call('b', { command: 'sed -n 5,8p f.ts' }), result('b', [{ type: 'text', text: file(5, 8, true) }])],
    [call('c', { old_string: line(6) + '\n' + line(2) })],
  )
  const u = usesOf(reqs)
  assert.deepEqual(u.uses.map((x) => ({ ...x, ids: x.ids.sort() })), [{ at: 2, ids: ['a', 'b'] }])
  assert.equal(u.results.get('b')!.at, 2)
})

test('a result all of whose lines were seen is a re-read; one with new lines is not', () => {
  const reqs = grow(
    [{ role: 'user', content: 'go' }],
    [call('a', { command: 'sed -n 1,10p f.ts' }), result('a', file(1, 10))],
    [call('b', { command: 'sed -n 3,6p f.ts' }), result('b', file(3, 6))],
    [call('c', { command: 'sed -n 8,14p f.ts' }), result('c', file(8, 14))],
    [{ role: 'assistant', content: [{ type: 'tool_use', id: 'd', name: 'Read', input: {} }, { type: 'tool_use', id: 'e', name: 'Read', input: {} }] }, result('d', file(11, 13, true)), result('e', 'x')],
  )
  assert.deepEqual(usesOf(reqs).rereads, [
    { at: 1, id: 'b', of: 'a', alone: true },
    { at: 3, id: 'd', of: 'c', alone: false },
  ])
})

test('a result is whole unless dropped, stubbed or culled', () => {
  const msgs = [result('a', file(1, 3)), result('b', '[CULLED 900 B FROM CTX]'), result('c', [{ type: 'text', text: '[CULLED 12 B FROM CTX]' }])]
  assert.deepEqual([...wholeIn(msgs)], ['a'])
})

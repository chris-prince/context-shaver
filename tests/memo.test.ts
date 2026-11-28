import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ApiMsg, Block } from '../src/items.ts'
import { checks, contentsFrozen, newRequest, report } from '../src/memo.ts'
import { positionsOf, sizeOf } from '../src/trim.ts'

const NONE = Object.assign(new Map<string, number>(), { after: new Map<string, string>() })
const on = <T>(f: () => T): T => {
  const was = checks.on
  checks.on = true
  try {
    return f()
  } finally {
    checks.on = was
  }
}

test('with the checks on, a hit on a block changed since throws', () => {
  const b: Block = { type: 'text', text: 'abc' }
  on(() => {
    sizeOf(b, NONE)
    b.text = 'abcdef'
    assert.throws(() => sizeOf(b, NONE), /memo length/)
  })
})

test('with the checks on, a frozen message content throws where a block is changed', () => {
  const msgs: ApiMsg[] = [{ role: 'user', content: [{ type: 'text', text: 'abc' }] }]
  contentsFrozen(msgs)
  assert.throws(() => ((msgs[0].content as Block[])[0].text = 'x'), TypeError)
  assert.throws(() => (msgs[0].content as Block[]).push({ type: 'text', text: 'y' }), TypeError)
  msgs[0].content = 'new content'
  assert.equal(msgs[0].content, 'new content')
})

test('a prefix looked up again in a request is a hit, and a request starts with none looked up', () => {
  const msgs: ApiMsg[] = [{ role: 'user', content: [{ type: 'text', text: 'abc' }] }]
  on(() => {
    newRequest()
    positionsOf(msgs, 'seed', NONE)
    positionsOf(msgs, 'seed', NONE)
    assert.match(report().join('\n'), /prefix: 2 lookups, 1 misses, 0 again, 1 distinct/)
  })
})

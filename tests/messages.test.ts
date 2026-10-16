import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MESSAGES } from '../src/messages.ts'

test('a streamed answer is done at message_stop', () => {
  const r = MESSAGES.usageReader()
  const ev = (o: unknown) => new TextEncoder().encode(`event: x\ndata: ${JSON.stringify(o)}\n\n`)
  r.push(ev({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }))
  r.push(ev({ type: 'message_delta', usage: { output_tokens: 7 } }))
  assert.equal(r.done, false)
  r.push(ev({ type: 'message_stop' }))
  assert.equal(r.done, true)
  assert.deepEqual(r.end().usage, { input_tokens: 10, output_tokens: 7 })
})

test('a base URL ending in /v1 is served', () => {
  assert.ok(MESSAGES.serves('/v1/messages') && MESSAGES.serves('/messages'))
})

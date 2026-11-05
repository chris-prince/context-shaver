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

test("a streamed answer gives the reply's text, and whether it ends the turn", () => {
  const ev = (o: unknown) => new TextEncoder().encode(`event: x\ndata: ${JSON.stringify(o)}\n\n`)
  const stream = (stop: string, ...events: unknown[]) => {
    const r = MESSAGES.usageReader()
    r.push(ev({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }))
    for (const e of events) r.push(ev(e))
    r.push(ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 9 } }))
    r.push(ev({ type: 'message_stop' }))
    return r.end().reply
  }
  const thought = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
  ]
  const said = [
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Do' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ne.' } },
    { type: 'content_block_stop', index: 1 },
  ]
  assert.deepEqual(stream('end_turn', ...thought, ...said), { text: ['Done.'], ended: true })
  const called = stream('tool_use', ...thought,
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ls"}' } },
    { type: 'content_block_stop', index: 1 })
  assert.deepEqual(called, { text: [], ended: false })
  // One cut off before its stop reason is no reply.
  const r = MESSAGES.usageReader()
  r.push(ev({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }))
  for (const e of said) r.push(ev(e))
  assert.equal(r.end().reply, undefined)
})

test('a base URL ending in /v1 is served', () => {
  assert.ok(MESSAGES.serves('/v1/messages') && MESSAGES.serves('/messages'))
})

test("a summary fork's answer keeps its blocks, usage and stop reason", () => {
  const out = MESSAGES.summaryForkAnswer(JSON.stringify({ content: [{ type: 'thinking', thinking: '', signature: 's' }], usage: { input_tokens: 5, output_tokens: 7 }, stop_reason: 'max_tokens' }))
  assert.deepEqual(out.content, [{ type: 'thinking', thinking: '', signature: 's' }])
  assert.equal(out.usage?.output_tokens, 7)
  assert.equal(out.stop, 'max_tokens')
})

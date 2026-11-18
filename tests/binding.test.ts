// Which requests binding.ts sets drop_block on, and how it reads what the API dropped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BETA, bound, droppedAt, eligible, transformed, withBeta } from '../src/binding.ts'
import { MESSAGES } from '../src/messages.ts'

test('every Claude model newer than the 5.0s is eligible, whatever its prefix or suffix; older ones and other models are not', () => {
  for (const m of ['claude-fable-5-2', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5[1m]', 'claude-haiku-5-5-20261001', 'us.anthropic.claude-opus-5-5-v1:0', 'claude-opus-5-5@20261001', 'claude-opus-6', 'claude-sonnet-7-1'])
    assert.ok(eligible(m), m)
  for (const m of ['claude-3-5-sonnet-20241022', 'claude-3-opus', 'claude-opus-4-1', 'claude-sonnet-4-5[1m]', 'claude-haiku-4-5-20251001', 'claude-opus-4', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-5-20260101', 'us.anthropic.claude-sonnet-4-5-v1:0', 'gpt-5.5', 'minimax-m3'])
    assert.ok(!eligible(m), m)
})

const thought = { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'hi' }] }
const req = (more: object) => Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'a' }, thought, { role: 'user', content: 'b' }], ...more }))

test('drop_block is set on every eligible request that holds thinking, with adaptive or no thinking, the rest of thinking kept', () => {
  const unset = bound(req({}))!
  assert.deepEqual(JSON.parse(unset.body.toString()).thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } })
  const adaptive = JSON.parse(bound(req({ thinking: { type: 'adaptive', display: 'updates' } }))!.body.toString())
  assert.deepEqual(adaptive.thinking, { type: 'adaptive', display: 'updates', block_binding: { prefix_mismatch_behavior: 'drop_block' } })
  assert.deepEqual(adaptive.messages, JSON.parse(req({}).toString()).messages, 'messages as they were')
  const redacted = Buffer.from(JSON.stringify({ model: 'claude-fable-5-2', messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }] }] }))
  assert.ok(bound(redacted))
})

test('a request is left as it is: no thinking blocks, thinking off or enabled, the client\'s own block_binding, an older model, or not JSON', () => {
  assert.equal(bound(Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'a' }] }))), undefined)
  assert.equal(bound(req({ thinking: { type: 'disabled' } })), undefined)
  assert.equal(bound(req({ thinking: { type: 'enabled', budget_tokens: 1000 } })), undefined)
  assert.equal(bound(req({ thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } } })), undefined)
  assert.equal(bound(req({ model: 'claude-opus-4-1' })), undefined)
  assert.equal(bound(Buffer.from('not json')), undefined)
})

test('the beta is added to the client\'s anthropic-beta once', () => {
  assert.equal(withBeta({})['anthropic-beta'], BETA)
  assert.equal(withBeta({ 'anthropic-beta': 'a-1,b-2' })['anthropic-beta'], `a-1,b-2,${BETA}`)
  assert.equal(withBeta({ 'anthropic-beta': `a-1, ${BETA}` })['anthropic-beta'], `a-1, ${BETA}`)
})

const list = [
  { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
  { type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'prefix_binding_mismatch' },
  { type: 'thinking_mismatch_allowed', path: 'messages.5.content.0', reason: 'prefix_binding_mismatch' },
]
const counts = { 'thinking_dropped/prefix_binding_mismatch': 2, 'thinking_mismatch_allowed/prefix_binding_mismatch': 1 }

test('input_transformations are counted by type and reason; an empty list is none', () => {
  assert.deepEqual(transformed(list), counts)
  assert.equal(transformed([]), undefined)
  assert.equal(transformed(undefined), undefined)
})

const sse = (events: object[]) => Buffer.from(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(''))
const usage = { input_tokens: 5, output_tokens: 1 }

test('the Messages reader takes input_transformations from message_start, from a final message_delta after a fallback, or from the body', () => {
  const read = (chunk: Buffer) => {
    const r = MESSAGES.usageReader()
    r.push(chunk)
    return r.end().transformations
  }
  assert.deepEqual(read(sse([{ type: 'message_start', message: { usage, input_transformations: list } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage }, { type: 'message_stop' }])), counts)
  assert.deepEqual(read(sse([{ type: 'message_start', message: { usage, input_transformations: [] } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage, input_transformations: list.slice(0, 1) }, { type: 'message_stop' }])), { 'thinking_dropped/prefix_binding_mismatch': 1 })
  assert.deepEqual(read(Buffer.from(JSON.stringify({ content: [], usage, stop_reason: 'end_turn', input_transformations: list }))), counts)
  assert.equal(read(sse([{ type: 'message_start', message: { usage } }, { type: 'message_stop' }])), undefined)
})

test('droppedAt gives the messages whose thinking was dropped, once each, and none for a mismatch allowed', () => {
  assert.deepEqual(droppedAt(list), [1, 3])
  assert.deepEqual(droppedAt([...list, { type: 'thinking_dropped', path: 'messages.3.content.2', reason: 'prefix_binding_mismatch' }]), [1, 3])
  assert.equal(droppedAt(list.slice(2)), undefined)
  assert.equal(droppedAt([]), undefined)
  assert.equal(droppedAt(undefined), undefined)
})

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

test("a conversation's id is its session, agent and first message", () => {
  const body = (session: string) => ({ model: 'm', messages: [{ role: 'user' as const, content: 'hi' }], metadata: { user_id: JSON.stringify({ session_id: session }) } })
  const main = MESSAGES.conversationId(body('s1'), {})
  assert.match(main, /^claude-s1-main-[0-9a-f]{8}$/)
  assert.match(MESSAGES.conversationId(body('s1'), { 'x-claude-code-agent-id': 'a7' }), /^claude-s1-a7-/)
  assert.notEqual(MESSAGES.conversationId(body('s2'), {}), main)
  assert.match(MESSAGES.conversationId({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, {}), /^claude-[0-9a-f]{8}$/)
  assert.match(MESSAGES.conversationId({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { 'x-session-id': 'ses_x' }), /^claude-ses_x-[0-9a-f]{8}$/)
})

test('a base URL ending in /v1 is served', () => {
  assert.ok(MESSAGES.serves('/v1/messages') && MESSAGES.serves('/messages'))
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandOf, pendingCommand, reply, stripCommands, withoutPending } from '../src/command.ts'

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const system = (text: string) => ({ role: 'system', content: text })
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })

test('a command is a user message whose only text is one', () => {
  assert.equal(commandOf(user(' :shaver stats\n')), ':shaver stats')
  assert.equal(commandOf({ role: 'user', content: ':shaver policy' }), ':shaver policy')
  assert.equal(commandOf(user(':shaver stats please')), undefined)
  assert.equal(commandOf(user(':shaver other')), undefined)
  assert.equal(commandOf(assistant(':shaver stats')), undefined)
})

const firstPrompt = (text: string) => ({ role: 'user', content: [{ type: 'text', text: '<system-reminder>\nAGENTS.md\n</system-reminder>' }, { type: 'text', text: '<system-reminder>\ngit status\n</system-reminder>\n' }, { type: 'text', text }] })

test('a first prompt is a command despite the reminders before it', () => {
  assert.equal(commandOf(firstPrompt(':shaver stats')), ':shaver stats')
  assert.equal(commandOf(firstPrompt('hello')), undefined)
})

test('a request asks for a command despite the system messages after it', () => {
  assert.equal(pendingCommand([firstPrompt(':shaver stats'), system('environment')]), ':shaver stats')
  assert.equal(pendingCommand([user('a'), assistant('A'), user(':shaver policy')]), ':shaver policy')
  assert.equal(pendingCommand([user(':shaver stats'), assistant('stats')]), undefined)
})

test('the pending command is left out but for its reminders', () => {
  assert.deepEqual(withoutPending([firstPrompt(':shaver stats'), system('environment')]), [{ role: 'user', content: firstPrompt('').content.slice(0, 2) }, system('environment')])
  assert.deepEqual(withoutPending([user('a'), assistant('b'), user(':shaver stats')]), [user('a'), assistant('b')])
})

test('an answered first-prompt command is stripped but for its reminders', () => {
  const msgs = [firstPrompt(':shaver stats'), assistant('stats'), user('b')]
  assert.deepEqual(stripCommands(msgs), [{ role: 'user', content: firstPrompt('').content.slice(0, 2) }, user('b')])
})

test('an answered command and its reply are stripped, the system messages between moved before the next reply', () => {
  const msgs = [user('a'), assistant('A'), user(':shaver stats'), system('nudge'), assistant('stats'), user('b')]
  assert.deepEqual(stripCommands(msgs), [user('a'), assistant('A'), user('b'), system('nudge')])
  assert.deepEqual(stripCommands([...msgs, assistant('B')]), [user('a'), assistant('A'), user('b'), system('nudge'), assistant('B')])
})

test("a first-prompt command keeps Claude Code's preamble", () => {
  const msgs = [firstPrompt(':shaver stats'), system('preamble'), assistant('stats'), user('b'), assistant('B')]
  assert.deepEqual(stripCommands(msgs), [{ role: 'user', content: firstPrompt('').content.slice(0, 2) }, user('b'), system('preamble'), assistant('B')])
})

test('a command not yet answered stays', () => {
  const msgs = [user('a'), assistant('A'), user(':shaver stats'), system('nudge')]
  assert.deepEqual(stripCommands(msgs), msgs)
})

test('the reply streams as one text block, reporting the context as cache reads', () => {
  const events = reply('hi', 'm', true, 58000).trim().split('\n\n').map((e) => JSON.parse(e.split('\ndata: ')[1]))
  assert.deepEqual(events.map((e) => e.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
  assert.equal(events[2].delta.text, 'hi')
  assert.deepEqual(events[0].message.usage, { input_tokens: 0, cache_read_input_tokens: 58000, output_tokens: 0 })
  const plain = JSON.parse(reply('hi', 'm', false, 58000))
  assert.deepEqual(plain.content, [{ type: 'text', text: 'hi' }])
  assert.equal(plain.usage.cache_read_input_tokens, 58000)
})

test('a command the model answered with a tool call stays', () => {
  const call = { role: 'assistant', content: [{ type: 'text', text: 'Let me look' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }
  const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }
  const msgs = [user('a'), assistant('A'), user(':shaver stats'), call, result]
  assert.deepEqual(stripCommands(msgs), msgs)
})

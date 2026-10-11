import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandOf, reply, stripCommands } from '../src/command.ts'

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

test('an answered command, the system messages after it and its reply are stripped', () => {
  const msgs = [user('a'), assistant('A'), user(':shaver stats'), system('nudge'), assistant('stats'), user('b')]
  assert.deepEqual(stripCommands(msgs), [user('a'), assistant('A'), user('b')])
})

test('a command not yet answered stays', () => {
  const msgs = [user('a'), assistant('A'), user(':shaver stats'), system('nudge')]
  assert.deepEqual(stripCommands(msgs), msgs)
})

test('the reply streams as one text block with no usage', () => {
  const events = reply('hi', 'm', true).trim().split('\n\n').map((e) => JSON.parse(e.split('\ndata: ')[1]))
  assert.deepEqual(events.map((e) => e.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
  assert.equal(events[2].delta.text, 'hi')
  assert.deepEqual(JSON.parse(reply('hi', 'm', false)).content, [{ type: 'text', text: 'hi' }])
})

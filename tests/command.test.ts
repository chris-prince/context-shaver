import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCommand, reply, stripCommands } from '../src/command.ts'

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const system = (text: string) => ({ role: 'system', content: text })
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })

test('the command is a user message whose only text is it', () => {
  assert.ok(isCommand(user(' :ctx stats\n')))
  assert.ok(isCommand({ role: 'user', content: ':ctx stats' }))
  assert.ok(!isCommand(user(':ctx stats please')))
  assert.ok(!isCommand(assistant(':ctx stats')))
})

test('an answered command, the system messages after it and its reply are stripped', () => {
  const msgs = [user('a'), assistant('A'), user(':ctx stats'), system('nudge'), assistant('stats'), user('b')]
  assert.deepEqual(stripCommands(msgs), [user('a'), assistant('A'), user('b')])
})

test('a command not yet answered stays', () => {
  const msgs = [user('a'), assistant('A'), user(':ctx stats'), system('nudge')]
  assert.deepEqual(stripCommands(msgs), msgs)
})

test('the reply streams as one text block with no usage', () => {
  const events = reply('hi', 'm', true).trim().split('\n\n').map((e) => JSON.parse(e.split('\ndata: ')[1]))
  assert.deepEqual(events.map((e) => e.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
  assert.equal(events[2].delta.text, 'hi')
  assert.deepEqual(JSON.parse(reply('hi', 'm', false)).content, [{ type: 'text', text: 'hi' }])
})

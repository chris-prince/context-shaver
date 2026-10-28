import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandOf, pendingCommand, reply, stripCommands, withoutPending, wordsOf } from '../src/command.ts'

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const system = (text: string) => ({ role: 'system', content: text })
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })

test('a command is a user message whose only text is one', () => {
  assert.equal(commandOf(user(' :shaver info\n')), ':shaver info')
  assert.equal(commandOf({ role: 'user', content: ':shaver policy' }), ':shaver policy')
  assert.equal(commandOf(user(': shaver info')), ':shaver info')
  assert.equal(commandOf(user(':shaver info all')), ':shaver info all')
  assert.equal(commandOf(user(':shaver info please')), undefined)
  assert.equal(commandOf(user(':shaver other')), undefined)
  assert.equal(commandOf(assistant(':shaver info')), undefined)
})

test('the colon is optional and the words after shaver are split as a shell would', () => {
  assert.equal(commandOf(user('shaver info')), ':shaver info')
  assert.equal(commandOf(user(':\t shaver   info \n all')), ':shaver info all')
  assert.equal(commandOf(user(`:shaver "info" 'all'`)), ':shaver info all')
  assert.equal(commandOf(user(':shaver "info all"')), undefined)
  assert.equal(commandOf(user(':shavers info')), undefined)
  assert.equal(commandOf(user('the shaver info')), undefined)
  assert.deepEqual(wordsOf(` a "b c" d'e f'g '' "it's"`), ['a', 'b c', 'de fg', '', "it's"])
  assert.equal(wordsOf('a "b'), undefined)
  assert.equal(wordsOf(`a'b`), undefined)
})

const firstPrompt = (text: string) => ({ role: 'user', content: [{ type: 'text', text: '<system-reminder>\nAGENTS.md\n</system-reminder>' }, { type: 'text', text: '<system-reminder>\ngit status\n</system-reminder>\n' }, { type: 'text', text }] })

// As Claude Code sent it after `/restart`, with `!` command blocks added.
const afterLocal = (text: string) => ({
  role: 'user',
  content: [
    { type: 'text', text: '<system-reminder>\nAGENTS.md\n</system-reminder>' },
    { type: 'text', text: '<command-name>/restart</command-name>\n<command-message>restart</command-message>\n<command-args></command-args>\n' },
    { type: 'text', text: '<local-command-stdout>Successfully updated</local-command-stdout>\n' },
    { type: 'text', text: '<bash-input>ls</bash-input>' },
    { type: 'text', text },
  ],
})

test('a command is one despite any tagged blocks with it, which stripping keeps', () => {
  assert.equal(commandOf(afterLocal(':shaver info')), ':shaver info')
  assert.equal(commandOf(afterLocal('hello')), undefined)
  assert.equal(commandOf(user('<b>bold</b> :shaver info')), undefined)
  const kept = { role: 'user', content: afterLocal('').content.slice(0, 4) }
  assert.deepEqual(withoutPending([user('a'), assistant('b'), afterLocal(':shaver info')]), [user('a'), assistant('b'), kept])
  assert.deepEqual(stripCommands([user('a'), assistant('b'), afterLocal(':shaver info'), assistant('stats'), user('c')]), [user('a'), assistant('b'), kept, user('c')])
})

test('a request asks for a command despite the system messages after it', () => {
  assert.equal(pendingCommand([firstPrompt(':shaver info'), system('environment')]), ':shaver info')
  assert.equal(pendingCommand([user('a'), assistant('A'), user(':shaver policy')]), ':shaver policy')
  assert.equal(pendingCommand([user(':shaver info'), assistant('stats')]), undefined)
})

test('the pending command is left out but for its tagged blocks', () => {
  assert.deepEqual(withoutPending([firstPrompt(':shaver info'), system('environment')]), [{ role: 'user', content: firstPrompt('').content.slice(0, 2) }, system('environment')])
  assert.deepEqual(withoutPending([user('a'), assistant('b'), user(':shaver info')]), [user('a'), assistant('b')])
})

test('an answered first-prompt command is stripped but for its tagged blocks', () => {
  const msgs = [firstPrompt(':shaver info'), assistant('stats'), user('b')]
  assert.deepEqual(stripCommands(msgs), [{ role: 'user', content: firstPrompt('').content.slice(0, 2) }, user('b')])
})

test('an answered command and its reply are stripped, the system messages between moved before the next reply', () => {
  const msgs = [user('a'), assistant('A'), user(':shaver info'), system('nudge'), assistant('stats'), user('b')]
  assert.deepEqual(stripCommands(msgs), [user('a'), assistant('A'), user('b'), system('nudge')])
  assert.deepEqual(stripCommands([...msgs, assistant('B')]), [user('a'), assistant('A'), user('b'), system('nudge'), assistant('B')])
})

test('a breakpoint on a stripped reply moves to the message before the command', () => {
  const control = { type: 'ephemeral', ttl: '1h' }
  const mark = (m: { role: string; content: { type: string; text: string }[] }) => ({ ...m, content: [{ ...m.content[0], cache_control: control }] })
  // Claude Code's suggestion marks the last reply, here the proxy's.
  const msgs = [user('a'), assistant('A'), user(':shaver info'), mark(assistant('stats')), user('suggest')]
  assert.deepEqual(stripCommands(msgs), [user('a'), mark(assistant('A')), user('suggest')])
  const thought = { role: 'assistant', content: [{ type: 'text', text: 'A' }, { type: 'thinking', thinking: '' }] }
  assert.deepEqual(stripCommands([user('a'), thought, ...msgs.slice(2)])[1].content, [{ type: 'text', text: 'A', cache_control: control }, { type: 'thinking', thinking: '' }])
})

test("a first-prompt command keeps Claude Code's preamble", () => {
  const msgs = [firstPrompt(':shaver info'), system('preamble'), assistant('stats'), user('b'), assistant('B')]
  assert.deepEqual(stripCommands(msgs), [{ role: 'user', content: firstPrompt('').content.slice(0, 2) }, user('b'), system('preamble'), assistant('B')])
})

test('a command not yet answered stays', () => {
  const msgs = [user('a'), assistant('A'), user(':shaver info'), system('nudge')]
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
  const msgs = [user('a'), assistant('A'), user(':shaver info'), call, result]
  assert.deepEqual(stripCommands(msgs), msgs)
})

test("y or n is a command only as the answer to `:shaver optimize`'s reply", () => {
  const offered = [user('a'), assistant('A'), user(':shaver optimize'), system('note'), assistant('Apply? y or n')]
  assert.equal(pendingCommand([...offered, user(' Y ')]), ':shaver optimize yes')
  assert.equal(pendingCommand([...offered, user('no'), system('note')]), ':shaver optimize no')
  assert.equal(pendingCommand([user(':shaver info'), assistant('stats'), user('y')]), undefined)
  assert.equal(pendingCommand([user('a'), assistant('A'), user('y')]), undefined)
  // Answered, the answer and its reply go with the command and its reply.
  assert.deepEqual(stripCommands([...offered, user('y'), assistant('wrote'), user('next')]), [user('a'), assistant('A'), user('next'), system('note')])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answeredMidTurn, closeHeld, commandOf, midTurnCommands, pendingCommand, reply, stripCommands, textBlock, withoutPending, wordsOf } from '../src/command.ts'
import { PICK } from '../src/optimize.ts'
import { CHAT } from '../src/chat.ts'
import { MESSAGES } from '../src/messages.ts'
import { wholeReply } from '../src/protocol.ts'
import { RESPONSES } from '../src/responses.ts'

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const system = (text: string) => ({ role: 'system', content: text })
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })

test('a command is a user message whose only text is one', () => {
  assert.equal(commandOf(user(' :shaver info\n')), ':shaver info')
  assert.equal(commandOf({ role: 'user', content: ':shaver policy' }), ':shaver policy')
  assert.equal(commandOf(user(': shaver info')), ':shaver info')
  assert.equal(commandOf(user(':shaver info all')), ':shaver info all')
  assert.equal(commandOf(user('shaver probe-codex-tool-search')), ':shaver probe-codex-tool-search')
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

test('a reply sent in pieces reads as one whole answer of all its text, on every protocol', () => {
  const read = (p: typeof MESSAGES, s: string) => {
    const r = p.usageReader()
    r.push(new TextEncoder().encode(s))
    return { done: r.done, chars: r.end().content.visibleChars }
  }
  for (const p of [MESSAGES, CHAT, RESPONSES]) {
    const r = p.replying('m', true, 100)
    const pieces = r.start + r.text('working… ') + r.text('done') + r.end('working… done')
    assert.deepEqual(read(p, pieces), read(p, wholeReply(p.replying('m', true, 100), 'working… done')), p.name)
    assert.deepEqual(read(p, pieces), { done: true, chars: 'working… done'.length }, p.name)
  }
})

test('a command the model answered with a tool call stays', () => {
  const call = { role: 'assistant', content: [{ type: 'text', text: 'Let me look' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }
  const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }
  const msgs = [user('a'), assistant('A'), user(':shaver info'), call, result]
  assert.deepEqual(stripCommands(msgs), msgs)
})

const asked = `Which skills should I trim?\n${PICK}`

test('any reply to a reply asking which to change is a command, and only then', () => {
  const offered = [user('a'), assistant('A'), user(':shaver optimize'), system('note'), assistant(asked)]
  assert.equal(pendingCommand([...offered, user(' ALL ')]), ':shaver optimize all')
  assert.equal(pendingCommand([...offered, user('none'), system('note')]), ':shaver optimize none')
  assert.equal(pendingCommand([...offered, user('Keep')]), ':shaver optimize keep')
  assert.equal(pendingCommand([...offered, user('1 3,5')]), ':shaver optimize 1 3 5')
  assert.equal(pendingCommand([...offered, user('1 and 3')]), ':shaver optimize invalid')
  assert.equal(pendingCommand([user(':shaver info'), assistant('stats'), user('all')]), undefined)
  assert.equal(pendingCommand([user('a'), assistant('A'), user('2')]), undefined)
  // An answer's reply can ask again, and the next answer is one too.
  const again = [...offered, user('2'), assistant(`Modified 1 skill.\n\nWhich tools should I defer?\n${PICK}`)]
  assert.equal(pendingCommand([...again, user('none')]), ':shaver optimize none')
  // Answered, the answers and their replies go with the command and its reply.
  assert.deepEqual(stripCommands([...again, user('none'), assistant('wrote'), user('next')]), [user('a'), assistant('A'), user('next'), system('note')])
})

// As Claude Code adds a message sent while the model works.
const midTurn = (text: string, extra = {}) => ({
  type: 'text',
  text: `The user sent a new message while you were working:\n${text}\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.`,
  ...extra,
})
const result = { type: 'tool_result', tool_use_id: 't1', content: 'ok' }
const call = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }

test('a command sent mid-turn waits, and neither it nor its answer reaches the model', () => {
  const control = { type: 'ephemeral' }
  const sent = { role: 'user', content: [result, midTurn(': shaver info', { cache_control: control })] }
  const asked = { role: 'user', content: [result, midTurn('also check the tests')] }
  assert.deepEqual(midTurnCommands([user('a'), call, sent]), [':shaver info'])
  assert.deepEqual(midTurnCommands([user('a'), call, asked]), [])
  assert.deepEqual(midTurnCommands([user('a'), call, sent, assistant('done')]), [])
  // The breakpoint moves to the block before; an ordinary message stays.
  assert.deepEqual(stripCommands([user('a'), call, sent]), [user('a'), call, { role: 'user', content: [{ ...result, cache_control: control }] }])
  assert.deepEqual(stripCommands([user('a'), call, asked]), [user('a'), call, asked])
  const ended = { role: 'assistant', content: [{ type: 'text', text: 'done' }, { type: 'text', text: answeredMidTurn(':shaver info') + 'stats' }] }
  assert.deepEqual(stripCommands([user('a'), call, sent, ended, user('b')]), [user('a'), call, { role: 'user', content: [{ ...result, cache_control: control }] }, assistant('done'), user('b')])
})

test('a command sent mid-turn as a system message waits, and the message goes', () => {
  const control = { type: 'ephemeral' }
  const tools = { role: 'user', content: [result] }
  const sent = { role: 'system', content: [midTurn('shaver info', { cache_control: control })] }
  const asked = { role: 'system', content: [midTurn('also check the tests')] }
  assert.deepEqual(midTurnCommands([user('a'), call, tools, sent]), [':shaver info'])
  assert.deepEqual(midTurnCommands([user('a'), call, tools, asked]), [])
  // The breakpoint moves to the message before; an ordinary message stays.
  assert.deepEqual(stripCommands([user('a'), call, tools, sent]), [user('a'), call, { role: 'user', content: [{ ...result, cache_control: control }] }])
  assert.deepEqual(stripCommands([user('a'), call, tools, asked]), [user('a'), call, tools, asked])
})

test("an answer answers `:shaver optimize` sent mid-turn once the turn ends with its reply", () => {
  const ended = { role: 'assistant', content: [{ type: 'text', text: 'done' }, { type: 'text', text: answeredMidTurn(':shaver optimize') + asked }] }
  const before = [user('a'), call, { role: 'user', content: [result, midTurn('shaver optimize')] }, ended]
  assert.equal(pendingCommand([...before, user('all')]), ':shaver optimize all')
  assert.deepEqual(stripCommands([...before, user('all'), assistant('wrote'), user('next')]), [user('a'), call, { role: 'user', content: [result] }, assistant('done'), user('next')])
})

test('a command right after tool results was sent mid-turn by Codex or OpenCode, unless a tool was interrupted', () => {
  const tools = { role: 'user', content: [result] }
  const sent = user('shaver info')
  assert.deepEqual(midTurnCommands([user('a'), call, tools, sent]), [':shaver info'])
  assert.equal(pendingCommand([user('a'), call, tools, sent]), undefined)
  assert.deepEqual(stripCommands([user('a'), call, tools, sent]), [user('a'), call, tools])
  // It stays in the turn's later requests, and still goes.
  assert.deepEqual(stripCommands([user('a'), call, tools, sent, call, tools]), [user('a'), call, tools, call, tools])
  // An ordinary prompt stays.
  assert.deepEqual(midTurnCommands([user('a'), call, tools, user('also check the tests')]), [])
  // After an interrupted tool, it's the next turn's command, answered now.
  const stopped = { role: 'user', content: [{ ...result, content: '{"error":{"type":"aborted","message":"Tool execution interrupted"},"content":[]}' }] }
  assert.deepEqual(midTurnCommands([user('a'), call, stopped, sent]), [])
  assert.equal(pendingCommand([user('a'), call, stopped, sent]), ':shaver info')
  // Between turns, after a reply, likewise.
  assert.equal(pendingCommand([user('a'), assistant('done'), sent]), ':shaver info')
})

test("an answer added to the model's text is cut from it, and a pick still answers `:shaver optimize`", () => {
  const tools = { role: 'user', content: [result] }
  const ended = { role: 'assistant', content: [{ type: 'text', text: 'done\n\n' + answeredMidTurn(':shaver optimize') + asked }] }
  const before = [user('a'), call, tools, user('shaver optimize'), ended]
  assert.equal(pendingCommand([...before, user('1')]), ':shaver optimize 1')
  assert.deepEqual(stripCommands([...before, user('next')]), [user('a'), call, tools, assistant('done'), user('next')])
})

test('a stream passes through but for its close, held so blocks can go before it', () => {
  const events = [
    { type: 'message_start', message: {} },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]
  const wire = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  let out = ''
  const held = closeHeld((s) => (out += s))
  // Cut anywhere, even inside an event.
  for (let i = 0; i < wire.length; i += 7) held.push(Buffer.from(wire.slice(i, i + 7)))
  assert.equal(out, wire.slice(0, wire.indexOf('event: message_delta')))
  assert.equal(held.ended, true)
  assert.equal(out + held.add('answer') + held.rest(), wire.replace('event: message_delta', textBlock('answer', 2) + 'event: message_delta'))
  const calling = closeHeld(() => {})
  calling.push(Buffer.from(wire.replace('end_turn', 'tool_use')))
  assert.equal(calling.ended, false)
})

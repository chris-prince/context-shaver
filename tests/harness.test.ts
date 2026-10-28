import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conversationId, harnessOf, sessionOf, type Harness } from '../src/harness.ts'
import { canonical as chat } from '../src/chat.ts'
import { canonical as responses } from '../src/responses.ts'
import { withoutPending } from '../src/command.ts'

const msgs = [{ role: 'user' as const, content: 'hi' }]
const of = (declared: string | undefined, headers = {}) => harnessOf(declared, headers) as Harness | undefined

test('a declared harness is the one used, whatever the headers say', () => {
  assert.equal(of('codex', { 'x-opencode-session-id': 's' })?.name, 'codex')
  assert.deepEqual(harnessOf('aider', {}), { error: 'not a harness: /harness/aider' })
})

test("without one, it is the harness whose headers the request sends", () => {
  assert.equal(of(undefined, { 'x-claude-code-session-id': 's' })?.name, 'claude')
  assert.equal(of(undefined, { 'x-codex-window-id': 'w' })?.name, 'codex')
  assert.equal(of(undefined, { 'x-opencode-client': 'cli' })?.name, 'opencode')
  assert.equal(of(undefined, { 'user-agent': 'opencode/2.0.30', 'x-session-id': 's' }), undefined)
})

test("a Claude Code conversation's id is its session, agent and first message", () => {
  const body = (session: string) => ({ model: 'm', messages: msgs, metadata: { user_id: JSON.stringify({ session_id: session }) } })
  const claude = of('claude')
  const main = conversationId(claude, 'messages', body('s1'), {})
  assert.match(main, /^claude-s1-main-[0-9a-f]{8}$/)
  assert.match(conversationId(claude, 'messages', body('s1'), { 'x-claude-code-agent-id': 'a7' }), /^claude-s1-a7-/)
  assert.notEqual(conversationId(claude, 'messages', body('s2'), {}), main)
  assert.match(conversationId(claude, 'messages', { model: 'm', messages: msgs }, {}), /^claude-[0-9a-f]{8}$/)
})

test("a conversation's session is shared by its subagents and later first messages, and by nothing else", () => {
  const claude = of('claude')
  const body = (session: string, text = 'hi') => ({ model: 'm', messages: [{ role: 'user', content: text }], metadata: { user_id: JSON.stringify({ session_id: session }) } })
  const id = (session: string, text?: string, agent?: string) => conversationId(claude, 'messages', body(session, text), agent ? { 'x-claude-code-agent-id': agent } : {})
  const s = 'a1b2-c3d4'
  assert.equal(sessionOf(id(s)), sessionOf(id(s, 'after /compact')))
  assert.equal(sessionOf(id(s)), sessionOf(id(s, 'hi', 'a7')))
  assert.notEqual(sessionOf(id(s)), sessionOf(id('a1b2-c3d5')))
  const lone = conversationId(claude, 'messages', { model: 'm', messages: msgs }, {})
  assert.equal(sessionOf(lone), lone)
  const opencode = (session: string, text: string) => conversationId(of('opencode'), 'messages', { model: 'm', messages: [{ role: 'user', content: text }] }, { 'x-opencode-session-id': session })
  assert.equal(sessionOf(opencode('ses_a', 'x')), sessionOf(opencode('ses_a', 'y')))
  assert.notEqual(sessionOf(opencode('ses_a', 'x')), sessionOf(opencode('ses_b', 'x')))
})

test("each harness's session names its conversations, on any protocol", () => {
  assert.match(conversationId(of('opencode'), 'messages', { model: 'm', messages: msgs }, { 'x-opencode-session-id': 'ses_a' }), /^opencode-ses_a-[0-9a-f]{8}$/)
  assert.match(conversationId(of('opencode'), 'responses', { model: 'm', messages: msgs, prompt_cache_key: 'k' }, { 'x-opencode-session-id': 'ses_a' }), /^opencode-ses_a-/)
  assert.match(conversationId(of('codex'), 'responses', { model: 'm', messages: msgs, prompt_cache_key: 'sess-a' }, {}), /^codex-sess-a-/)
  assert.match(conversationId(of('codex'), 'responses', { model: 'm', messages: msgs }, { 'session-id': 'sess-b' }), /^codex-sess-b-/)
})

// As `:shaver info` names the conversation, from the request with the command
// taken out: on a first request that leaves no messages at all.
test('a first request that is only a command still names its conversation', () => {
  const named = (body: { messages: never[] } & object, h: string, protocol: string, headers = {}) =>
    conversationId(of(h), protocol, { ...body, messages: withoutPending(body.messages) } as never, headers)
  const codex = responses({ model: 'gpt-6-luna', prompt_cache_key: 'sess-a', instructions: 'You are Codex.', input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: ':shaver info' }] },
  ] }).body
  assert.match(named(codex as never, 'codex', 'responses'), /^codex-sess-a-[0-9a-f]{8}$/)
  const opencode = chat({ model: 'm', messages: [{ role: 'system', content: 'You are OpenCode.' }, { role: 'user', content: ':shaver info' }] }).body
  assert.match(named(opencode as never, 'opencode', 'chat', { 'x-opencode-session-id': 'ses_a' }), /^opencode-ses_a-[0-9a-f]{8}$/)
})

test("an unknown harness's conversations are named by protocol, and by a session the body names", () => {
  assert.match(conversationId(undefined, 'chat', { model: 'm', messages: msgs, prompt_cache_key: 'k1' }, {}), /^chat-k1-[0-9a-f]{8}$/)
  assert.notEqual(conversationId(undefined, 'chat', { model: 'm', messages: msgs, user: 'u2' }, {}), conversationId(undefined, 'chat', { model: 'm', messages: msgs, user: 'u3' }, {}))
  assert.match(conversationId(undefined, 'messages', { model: 'm', messages: msgs }, {}), /^messages-[0-9a-f]{8}$/)
})

test("only a harness with a tool that loads tools has others deferred", () => {
  assert.deepEqual([of('claude'), of('codex'), of('opencode')].map((h) => h?.defers), [true, false, false])
})

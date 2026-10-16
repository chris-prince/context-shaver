import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonical, CHAT } from '../src/chat.ts'
import type { ApiMsg, Block } from '../src/items.ts'

const wire = {
  model: 'openai/gpt-5.6',
  stream: true,
  messages: [
    { role: 'system', content: 'You are OpenCode.' },
    { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
    {
      role: 'assistant',
      content: 'Looking.',
      reasoning: 'think first',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"filePath":"a.ts"}' } },
        { id: 'c2', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(100) },
    { role: 'tool', tool_call_id: 'c2', content: 'a.ts' },
    { role: 'assistant', content: 'Done.' },
    { role: 'user', content: 'thanks' },
  ],
}

test('a request the core leaves comes back as it came', () => {
  const c = canonical(wire)
  const out = c.render(c.body) as typeof wire
  assert.deepEqual(out.messages, wire.messages)
  assert.equal(JSON.stringify(out.messages), JSON.stringify(wire.messages))
})

test('a request becomes the core shape', () => {
  const { body } = canonical(wire)
  assert.deepEqual(body.system, [{ type: 'text', text: 'You are OpenCode.' }])
  assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user'])
  const a = body.messages[1].content as Block[]
  assert.deepEqual(a.map((b) => b.type), ['thinking', 'text', 'tool_use', 'tool_use'])
  assert.deepEqual(a[2].input, { filePath: 'a.ts' })
  const r = body.messages[2].content as Block[]
  assert.deepEqual(r.map((b) => b.tool_use_id), ['c1', 'c2'])
})

test('a changed message keeps the blocks the core left', () => {
  const c = canonical(wire)
  const msgs = c.body.messages.map((m, i) => {
    if (i === 1) return { ...m, content: (m.content as Block[]).filter((b) => b.type !== 'thinking') }
    if (i === 2) return { ...m, content: (m.content as Block[]).map((b, j) => (j === 0 ? { ...b, content: '[stubbed]' } : b)) }
    return m
  })
  const out = (c.render({ ...c.body, messages: msgs }) as typeof wire).messages as Record<string, unknown>[]
  assert.equal(out[2].reasoning, undefined)
  assert.equal(out[2].content, 'Looking.')
  assert.deepEqual(out[2].tool_calls, wire.messages[2].tool_calls)
  assert.deepEqual(out[3], { role: 'tool', tool_call_id: 'c1', content: '[stubbed]' })
  assert.strictEqual(out[4], wire.messages[4])
  assert.strictEqual(out[0], wire.messages[0])
})

test('a stream is asked for its usage', () => {
  const c = canonical(wire)
  const out = c.render(c.body) as Record<string, unknown>
  assert.deepEqual(out.stream_options, { include_usage: true })
})

test('two sessions started the same way get different ids when they name themselves', () => {
  const a = CHAT.conversationId({ ...canonical(wire).body, prompt_cache_key: 'ses_a' }, {})
  const b = CHAT.conversationId({ ...canonical(wire).body, prompt_cache_key: 'ses_b' }, {})
  assert.notEqual(a, b)
  assert.match(a, /^chat-ses_a-/)
})

test('usage counts the prompt as uncached, read and written together', () => {
  const r = CHAT.usageReader()
  const ev = (o: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(o)}\n\n`)
  r.push(ev({ choices: [{ delta: { content: 'hello' } }] }))
  r.push(ev({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 150 } } }))
  r.push(new TextEncoder().encode('data: [DONE]\n\n'))
  const { usage, content } = r.end()
  assert.deepEqual(usage, { input_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 150, output_tokens: 20 })
  assert.equal(content.visibleChars, 5)
})

test('a record the core adds is sent as a plain assistant message', () => {
  const c = canonical(wire)
  const record: ApiMsg = { role: 'assistant', content: [{ type: 'text', text: 'my record' }] }
  const msgs = [c.body.messages[0], record, ...c.body.messages.slice(3)]
  const out = (c.render({ ...c.body, messages: msgs }) as typeof wire).messages
  assert.deepEqual(out[2], { role: 'assistant', content: 'my record' })
  assert.strictEqual(out[1], wire.messages[1])
  assert.strictEqual(out[3], wire.messages[5])
})

test('a fork asks after the messages as sent, without streaming', () => {
  const sent = canonical(wire).render(canonical(wire).body) as Record<string, unknown>
  const f = CHAT.fork(sent, 'summarize')
  assert.equal(f.stream, false)
  assert.equal(f.stream_options, undefined)
  const m = f.messages as unknown[]
  assert.deepEqual(m.slice(0, -1), sent.messages)
  assert.deepEqual(m.at(-1), { role: 'user', content: 'summarize' })
})

test("a fork's answer becomes blocks and usage", () => {
  const out = CHAT.forkAnswer({ choices: [{ message: { role: 'assistant', content: 'the record', reasoning: 'hmm' } }], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 900 } } })
  assert.deepEqual(out.content, [{ type: 'text', text: 'the record' }])
  assert.deepEqual(out.usage, { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 20 })
})

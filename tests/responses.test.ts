import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonical, RESPONSES } from '../src/responses.ts'
import type { ApiMsg, Block } from '../src/items.ts'

// Shaped like Codex's requests to ChatGPT's backend.
const wire = {
  model: 'gpt-6-luna',
  stream: true,
  prompt_cache_key: 'sess-a',
  input: [
    { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }] }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/w</cwd>\n</environment_context>' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'count the lines' }] },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think first' }], encrypted_content: 'enc' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Counting.' }] },
    { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'tools.exec("wc -l a.txt")' },
    { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'x'.repeat(100) }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'thanks' }] },
  ],
}

test('a request the core leaves comes back as it came', () => {
  const c = canonical(wire)
  assert.equal(JSON.stringify(c.render(c.body)), JSON.stringify(wire))
})

test('a request becomes the core shape', () => {
  const { body } = canonical(wire)
  assert.deepEqual(body.system, [
    { type: 'text', text: 'You are Codex.' },
    { type: 'text', text: '<environment_context>\n  <cwd>/w</cwd>\n</environment_context>' },
  ])
  assert.deepEqual((body.tools as { name: string }[]).map((t) => t.name), ['functions.exec'])
  assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user'])
  const a = body.messages[1].content as Block[]
  assert.deepEqual(a.map((b) => b.type), ['thinking', 'text', 'tool_use'])
  assert.equal(a[0].signature, 'enc')
  assert.equal((body.messages[2].content as Block[])[0].tool_use_id, 'c1')
})

test('a changed message keeps the items the core left', () => {
  const c = canonical(wire)
  const msgs = c.body.messages.map((m, i) => {
    if (i === 1) return { ...m, content: (m.content as Block[]).filter((b) => b.type !== 'thinking') }
    if (i === 2) return { ...m, content: (m.content as Block[]).map((b) => ({ ...b, content: '[stubbed]' })) }
    return m
  })
  const out = (c.render({ ...c.body, messages: msgs }) as typeof wire).input
  assert.deepEqual(out.map((it) => it.type), ['additional_tools', 'message', 'message', 'message', 'message', 'custom_tool_call', 'custom_tool_call_output', 'message', 'message'])
  assert.strictEqual(out[4], wire.input[5])
  assert.strictEqual(out[5], wire.input[6])
  assert.deepEqual(out[6], { type: 'custom_tool_call_output', call_id: 'c1', output: '[stubbed]' })
  assert.strictEqual(out[7], wire.input[8])
})

test('a record the core adds is sent as an assistant message', () => {
  const c = canonical(wire)
  const record: ApiMsg = { role: 'assistant', content: [{ type: 'text', text: 'my record' }] }
  const out = (c.render({ ...c.body, messages: [c.body.messages[0], record, ...c.body.messages.slice(3)] }) as typeof wire).input
  assert.deepEqual(out[4], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'my record' }] })
  assert.strictEqual(out[3], wire.input[3])
  assert.strictEqual(out[5], wire.input[8])
})

const completed = { type: 'response.completed', response: { output: [{ type: 'reasoning', encrypted_content: 'e' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }], usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 900 }, attribution: { items: { msg_1: { input_tokens: 1000, cached_tokens: 900 } } } } } }
const stream = `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: {} })}\n\nevent: response.completed\ndata: ${JSON.stringify(completed)}\n\n`

test("usage and content come from the stream's last event", () => {
  const r = RESPONSES.usageReader()
  const b = new TextEncoder().encode(stream)
  const last = b.length - new TextEncoder().encode(`data: ${JSON.stringify(completed)}\n\n`).length
  for (let i = 0; i < last; i += 50) r.push(b.slice(i, Math.min(i + 50, last)))
  assert.equal(r.done, false)
  r.push(b.slice(last))
  assert.equal(r.done, true)
  const { usage, content, attribution } = r.end()
  assert.deepEqual(usage, { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 20 })
  assert.deepEqual(content, { signatures: ['e'], visibleChars: 5 })
  assert.deepEqual(attribution, { items: { msg_1: { input_tokens: 1000, cached_tokens: 900 } } })
})

test('a summary fork asks after the items as sent, still streamed', () => {
  const sent = canonical(wire).render(canonical(wire).body) as typeof wire
  const f = RESPONSES.summaryFork(sent, 'summarize') as typeof wire
  assert.equal(f.stream, true)
  assert.deepEqual(f.input.slice(0, -1), sent.input)
  assert.deepEqual(f.input.at(-1), { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summarize' }] })
})

test("a summary fork's streamed answer becomes blocks and usage", () => {
  const out = RESPONSES.summaryForkAnswer(stream)
  assert.deepEqual(out.content, [{ type: 'text', text: 'hello' }])
  assert.equal(out.usage?.cache_read_input_tokens, 900)
})

test("a local answer streams as one message, and turn state isn't kept as a limit", () => {
  const events = RESPONSES.reply('hi', 'gpt-6-luna', true, 500).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
  assert.equal(events.at(-1).type, 'response.completed')
  assert.equal(events.at(-1).response.output[0].content[0].text, 'hi')
  assert.ok(RESPONSES.limits?.test('x-codex-primary-used-percent'))
  assert.ok(!RESPONSES.limits?.test('x-codex-turn-state'))
})

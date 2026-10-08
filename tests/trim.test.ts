import assert from 'node:assert/strict'
import { test } from 'node:test'
import { candidate, decide, inputStub, isPrompt, strip, TOOL_RESULT_STUB, turnsOf, type ApiMsg, type Options } from '../src/trim.ts'

const opts: Options = { stripToolCalls: true, stripReasoning: true, stripToolCallsWaitTurns: 0, stripReasoningWaitTurns: 0 }
const long = 'x'.repeat(5000)

// A turn as Claude Code sends it: prompt, a response with thinking and a tool
// call, its result, a response with thinking and an answer, and a
// mid-conversation system message.
function turn(n: number, tool: string, input: Record<string, unknown>): ApiMsg[] {
  const id = `toolu_${n}`
  return [
    { role: 'user', content: n === 1 ? [{ type: 'text', text: '<system-reminder>\ncontext\n</system-reminder>' }, { type: 'text', text: `prompt ${n}` }] : `prompt ${n}` },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: 'sig' }, { type: 'tool_use', id, name: tool, input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: long, cache_control: { type: 'ephemeral' } }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: 'sig' }, { type: 'text', text: `answer ${n}` }] },
    { role: 'system', content: 'reminder' },
  ]
}
const msgs = [...turn(1, 'Write', { file_path: 'a.txt', content: long }), ...turn(2, 'Bash', { command: 'seq 1 3000' }), ...turn(3, 'Bash', { command: 'ls' })]

test('prompts: user text, not tool results or reminders', () => {
  assert.equal(isPrompt(msgs[0]), true)
  assert.equal(isPrompt(msgs[2]), false)
  assert.equal(isPrompt({ role: 'user', content: '<system-reminder>x</system-reminder>' }), false)
  assert.equal(isPrompt({ role: 'user', content: '[Request interrupted by user]' }), false)
  assert.deepEqual(turnsOf(msgs).completed, 2)
})

test('strips completed turns up to the frontier, never the current one', () => {
  const s = strip(msgs, { tools: 5, reasoning: 5 }) // held to the 2 completed turns
  assert.equal(s.results, 2)
  assert.equal(s.inputs, 1)
  assert.equal(s.thinking, 4)
  const r = s.msgs[2].content as any[]
  assert.equal(r[0].content, TOOL_RESULT_STUB)
  assert.deepEqual(r[0].cache_control, { type: 'ephemeral' })
  assert.equal((s.msgs[1].content as any[])[0].input.content, inputStub(5000))
  assert.deepEqual(s.msgs.slice(10), msgs.slice(10))
})

test('tools and reasoning have their own frontiers', () => {
  const s = strip(msgs, { tools: 1, reasoning: 0 })
  assert.equal(s.results, 1)
  assert.equal(s.thinking, 0)
  assert.equal((s.msgs[1].content as any[])[0].type, 'thinking')
})

test('stripping is idempotent', () => {
  const once = strip(msgs, { tools: 2, reasoning: 2 })
  const twice = strip(once.msgs, { tools: 2, reasoning: 2 })
  assert.deepEqual(twice.msgs, once.msgs)
  assert.equal(twice.results + twice.inputs + twice.thinking, 0)
})

test('candidate honours waits and never moves back', () => {
  assert.deepEqual(candidate(msgs, { tools: 0, reasoning: 0 }, opts), { tools: 2, reasoning: 2 })
  assert.deepEqual(candidate(msgs, { tools: 0, reasoning: 0 }, { ...opts, stripToolCallsWaitTurns: 1, stripReasoning: false }), { tools: 1, reasoning: 0 })
  assert.deepEqual(candidate(msgs, { tools: 2, reasoning: 2 }, { ...opts, stripToolCallsWaitTurns: 2 }), { tools: 2, reasoning: 2 })
})

test('cold always advances; warm only when savings outweigh the rewrite', () => {
  const keep = strip(msgs, { tools: 0, reasoning: 0 }).msgs
  const adv = strip(msgs, { tools: 2, reasoning: 2 }).msgs
  assert.equal(decide(keep, adv, true).advanced, true)
  assert.equal(decide(keep, adv, false).advanced, true) // the results are most of the history
  // Saving a few characters at the start of a long history does not pay.
  const big: ApiMsg[] = [{ role: 'user', content: 'pp' }, { role: 'user', content: long.repeat(40) }]
  const tiny: ApiMsg[] = [{ role: 'user', content: 'p' }, big[1]]
  assert.equal(decide(big, tiny, false).advanced, false)
  assert.equal(decide(big, tiny, true).advanced, true)
  assert.equal(decide(msgs, msgs, true).advanced, false)
})

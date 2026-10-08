import assert from 'node:assert/strict'
import { test } from 'node:test'
import { candidate, decide, frontierEnd, isPrompt, isStubbed, strip, stub, stubHeredocs, turnsOf, type ApiMsg, type Options } from '../src/trim.ts'

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

test('the frontier ends where the turn after it starts', () => {
  // Turns of 5 messages; 2 completed. The frontier is held to them.
  assert.deepEqual(frontierEnd(msgs, { tools: 1, reasoning: 0 }), { tools: 5, reasoning: 0 })
  assert.deepEqual(frontierEnd(msgs, { tools: 5, reasoning: 2 }), { tools: 10, reasoning: 10 })
})

test('strips completed turns up to the frontier, never the current one', () => {
  const s = strip(msgs, { tools: 5, reasoning: 5 }) // held to the 2 completed turns
  assert.equal(s.results, 2)
  assert.equal(s.inputs, 1)
  assert.equal(s.thinking, 4)
  const r = s.msgs[2].content as any[]
  assert.equal(r[0].content, stub(5000))
  assert.deepEqual(r[0].cache_control, { type: 'ephemeral' })
  assert.equal((s.msgs[1].content as any[])[0].input.content, stub(5000))
  assert.deepEqual(s.msgs.slice(10), msgs.slice(10))
})

test('here-document bodies are stubbed, each to its own end line', () => {
  const body = 'line\n'.repeat(20).trimEnd()
  const n = Buffer.byteLength(body)
  assert.equal(stubHeredocs(`cat > a <<'EOF'\n${body}\nEOF\nls`), `cat > a <<'EOF'\n${stub(n)}\nEOF\nls`)
  assert.equal(stubHeredocs(`python3 - <<"PY" && x\n${body}\nPY`), `python3 - <<"PY" && x\n${stub(n)}\nPY`)
  assert.equal(stubHeredocs(`cat <<-END\n${body}\n\t\tEND`), `cat <<-END\n${stub(n)}\n\t\tEND`)
  // Two on one line take their bodies in order.
  assert.equal(stubHeredocs(`f <<A <<B\n${body}\nA\n${body}\nB`), `f <<A <<B\n${stub(n)}\nA\n${stub(n)}\nB`)
  // Only its own word ends a body.
  assert.equal(stubHeredocs(`cat <<A\nEOF\n${body}\nA`), `cat <<A\n${stub(n + 4)}\nA`)
  // A here-string, a short body and an unterminated one are left alone.
  for (const c of [`cat <<< "${body}"`, `cat <<EOF\nhi\nEOF`, `cat <<EOF\n${body}`]) assert.equal(stubHeredocs(c), c)
  assert.equal(isStubbed(stubHeredocs(`cat <<EOF\n${body}\nEOF`)), true)
  assert.equal(isStubbed(`echo '${stub(5)}'`), false)
  assert.equal(stubHeredocs(stubHeredocs(`cat <<EOF\n${body}\nEOF`)), stubHeredocs(`cat <<EOF\n${body}\nEOF`))
})

test('a Bash call has its here-documents stubbed', () => {
  const heredoc = `cat > b <<EOF\n${long}\nEOF`
  const m = [...turn(1, 'Bash', { command: heredoc }), ...turn(2, 'Bash', { command: 'ls' })]
  const s = strip(m, { tools: 1, reasoning: 0 })
  assert.equal(s.inputs, 1)
  assert.equal((s.msgs[1].content as any[])[1].input.command, `cat > b <<EOF\n${stub(5000)}\nEOF`)
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

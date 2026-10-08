import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { applyToRequest, decide, inputStub, plan, TOOL_RESULT_STUB, type ApiMsg, type Options } from '../hooks/trim'

const opts: Options = { stripToolCalls: true, stripReasoning: true, stripToolCallsWaitTurns: 0, stripReasoningWaitTurns: 0 }
const long = 'x'.repeat(5000)

// Two turns, each: prompt, thinking, a tool call, its result, thinking, answer.
// Every row carries a handle, as session.compact hands them.
function turn(n: number, tool: string, input: Record<string, unknown>): SessionMessage[] {
  const id = `toolu_${n}`
  return [
    { role: 'user', text: `prompt ${n}`, toolUses: [], handle: `u${n}` },
    { role: 'assistant', text: '', toolUses: [], handle: `t${n}a` },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input, text: long }], handle: `c${n}` },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: long, isError: false } as any], handle: `r${n}` },
    { role: 'assistant', text: '', toolUses: [], handle: `t${n}b` },
    { role: 'assistant', text: `answer ${n}`, toolUses: [], handle: `a${n}` },
  ]
}
const rows = [...turn(1, 'Write', { file_path: 'a.txt', content: long }), ...turn(2, 'Bash', { command: 'seq 1 3000' })]

// The same two turns as the request carries them.
function apiTurn(n: number, tool: string, input: Record<string, unknown>): ApiMsg[] {
  const id = `toolu_${n}`
  return [
    { role: 'user', content: [{ type: 'text', text: `prompt ${n}` }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id, name: tool, input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: long }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: `answer ${n}` }] },
  ]
}
const api = [...apiTurn(1, 'Write', { file_path: 'a.txt', content: long }), ...apiTurn(2, 'Bash', { command: 'seq 1 3000' })]

test('stubs results and long Write content, drops thinking, keeps the rest', () => {
  const p = plan(rows, opts)
  expect(p.turns).toBe(2)
  expect(p.thinkingRows).toBe(4)
  expect([...p.results]).toEqual(['toolu_1', 'toolu_2'])
  expect([...p.inputs.keys()]).toEqual(['toolu_1'])
  const write = p.rows.find((m) => m.toolUses[0]?.tool === 'Write')!
  expect(write.handle).toBe(undefined)
  expect(write.toolUses[0]!.input).toEqual({ file_path: 'a.txt', content: inputStub(5000) })
  const bash = p.rows.find((m) => m.toolUses[0]?.tool === 'Bash')!
  expect(bash.handle).toBe('c2') // nothing to stub in a short command
  expect(p.rows.filter((m) => m.toolResults?.length).every((m) => !m.handle && m.toolResults![0]!.text === TOOL_RESULT_STUB)).toBe(true)
  expect(p.rows.filter((m) => m.role === 'user' && !m.toolResults?.length).map((m) => m.handle)).toEqual(['u1', 'u2'])
})

test('a second plan changes nothing', () => {
  const once = plan(rows, opts).rows.map((m, i) => ({ ...m, handle: m.handle ?? `new${i}` }))
  const twice = plan(once, opts)
  expect(twice.rows).toEqual(once)
  expect(twice.results.size + twice.inputs.size + twice.thinkingRows).toBe(0)
})

test('wait turns hold back the latest completed turns', () => {
  const p = plan(rows, { ...opts, stripToolCallsWaitTurns: 1, stripReasoningWaitTurns: 2 })
  expect([...p.results]).toEqual(['toolu_1'])
  expect(p.thinkingRows).toBe(0)
})

test('the request loses thinking where the plan rebuilds a call or strips reasoning', () => {
  const keepReasoning = { ...opts, stripReasoning: false }
  const p = plan(rows, keepReasoning)
  const after = applyToRequest(api, p, keepReasoning)
  expect(after.turns).toBe(2)
  const thinking = after.msgs.map((m) => m.content.some((b) => b.type === 'thinking'))
  // Turn 1's call was rebuilt (Write content stubbed), so its thinking goes;
  // turn 2's call was not, so its thinking stays.
  expect(thinking).toEqual([false, false, false, true, false, true, false, true])
  expect(after.msgs[2]!.content[0]!.content).toBe(TOOL_RESULT_STUB)
  expect([after.results, after.inputs, after.thinking]).toEqual([2, 1, 1])
  // On a request already trimmed, the same plan changes nothing.
  const again = applyToRequest(after.msgs, p, keepReasoning)
  expect([again.results, again.inputs, again.thinking]).toEqual([0, 0, 0])
})

test('advances when the saving outweighs the rewrite, on a warm cache', () => {
  const p = plan(rows, opts)
  const d = decide(api, applyToRequest(api, p, opts).msgs, false)
  expect(d.advanced).toBe(true)
  expect(d.savedChars > 14000).toBe(true)
})

test('declines a small saving ahead of a long tail, unless the cache is cold', () => {
  const small = 'y'.repeat(400)
  const tail: ApiMsg = { role: 'user', content: [{ type: 'text', text: 'z'.repeat(20000) }] }
  const r: SessionMessage[] = [
    { role: 'user', text: 'p', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: small } as any] },
    { role: 'user', text: 'z'.repeat(20000), toolUses: [] },
  ]
  const before: ApiMsg[] = [
    { role: 'user', content: [{ type: 'text', text: 'p' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: small }] },
    tail,
  ]
  const after = applyToRequest(before, plan(r, opts), opts).msgs
  expect(decide(before, after, false).advanced).toBe(false)
  expect(decide(before, after, true).advanced).toBe(true)
})

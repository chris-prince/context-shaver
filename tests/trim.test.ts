import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { clockOf, isPrompt, stepsOf, turnsOf, type ApiMsg, type Clock } from '../src/items.ts'
import { parsePolicy, treatment, type Policy } from '../src/policy.ts'
import { apply, decide, isStubbed, stub, stubHeredocs, transitions, trimmedEnd, type Applied } from '../src/trim.ts'

const long = 'x'.repeat(5000)
const stubAll: Policy = { tool: [{ on: 'step', wait: 0, action: 'stub' }], reasoning: [{ on: 'turn', wait: 0, action: 'drop' }] }
const dropAll: Policy = { tool: [{ on: 'step', wait: 0, action: 'drop' }], reasoning: [{ on: 'turn', wait: 0, action: 'drop' }] }
const committed = parsePolicy(JSON.parse(readFileSync(new URL('../policy.json', import.meta.url), 'utf8')))

// The items an application changed, counted by kind and treatment.
const counts = (a: Applied) => transitions({ msgs: [], origin: [], treated: new Map() }, a)

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
  // Two assistant messages a turn; the sixth is the latest step.
  assert.deepEqual(stepsOf(msgs).completed, 5)
  assert.deepEqual(stepsOf(msgs).stepOf.slice(0, 5), [0, 1, 1, 2, 2])
})

test('a rule is due once its unit is completed, past the wait', () => {
  const it = { kind: 'tool' as const, id: 't', step: 3, turn: 2 }
  const stubAt = (steps: number) => treatment([{ on: 'step', wait: 1, action: 'stub' }], it, { steps, turns: 0 })
  assert.deepEqual([3, 4].map(stubAt), [undefined, 'stub'])
  const both = [{ on: 'step', wait: 0, action: 'stub' }, { on: 'turn', wait: 0, action: 'drop' }] as const
  assert.equal(treatment([...both], it, { steps: 3, turns: 1 }), 'stub')
  assert.equal(treatment([...both], it, { steps: 3, turns: 2 }), 'drop') // the stronger wins
  // Before the first prompt is turn 0, which no rule reaches.
  assert.equal(treatment([{ on: 'turn', wait: 0, action: 'drop' }], { ...it, turn: 0 }, { steps: 9, turns: 9 }), undefined)
})

test('a policy file is checked', () => {
  assert.deepEqual(Object.keys(committed), ['tool', 'skill', 'reasoning'])
  for (const bad of [[], { tools: [] }, { tool: {} }, { tool: [{ on: 'step', wait: -1, action: 'stub' }] }, { reasoning: [{ on: 'turn', wait: 0, action: 'stub' }] }])
    assert.throws(() => parsePolicy(bad))
})

test('with no rules, requests pass through', () => {
  const a = apply(msgs, {}, { steps: 5, turns: 2 })
  assert.deepEqual(a.msgs, msgs)
  assert.equal(a.treated.size, 0)
})

test('trimming ends where the furthest rule reaches', () => {
  const p: Policy = { tool: [{ on: 'step', wait: 1, action: 'stub' }] }
  assert.deepEqual(trimmedEnd(msgs, p, { steps: 2, turns: 0 }), { tools: 3, reasoning: 0 })
  // Held to the 5 completed steps and 2 turns.
  assert.deepEqual(trimmedEnd(msgs, { ...committed, ...stubAll }, { steps: 9, turns: 9 }), { tools: 13, reasoning: 10 })
})

test('stubs completed steps and drops completed turns\' thinking, never the latest', () => {
  const s = apply(msgs, stubAll, { steps: 9, turns: 5 }) // held to 5 steps, 2 turns
  // The current turn's result too: its step is completed.
  assert.deepEqual(counts(s), { 'tool:stub': 3, 'reasoning:drop': 4 })
  const r = s.msgs[2].content as any[]
  assert.equal(r[0].content, stub(5000))
  assert.deepEqual(r[0].cache_control, { type: 'ephemeral' })
  assert.equal((s.msgs[1].content as any[])[0].input.content, stub(5000))
  assert.equal((s.msgs[12].content as any[])[0].content, stub(5000))
  assert.deepEqual(s.msgs.slice(13), msgs.slice(13))
})

test('dropping removes calls with their results, and messages left empty', () => {
  const s = apply(msgs, { tool: dropAll.tool }, { steps: 1, turns: 0 })
  assert.deepEqual(counts(s), { 'tool:drop': 1 })
  // The call's message keeps its thinking; the result's message goes.
  assert.deepEqual(s.msgs[1].content, [{ type: 'thinking', thinking: 'hm', signature: 'sig' }])
  assert.deepEqual(s.msgs.slice(2), msgs.slice(3))
  assert.deepEqual(s.origin.slice(0, 3), [0, 1, 3])
  // With its thinking dropped too, the call's message goes as well. The
  // current turn keeps its thinking, and the latest step its call.
  const all = apply(msgs, dropAll, { steps: 9, turns: 5 })
  assert.deepEqual(counts(all), { 'reasoning:drop': 4, 'tool:drop': 3 })
  assert.deepEqual(all.origin, [0, 3, 4, 5, 8, 9, 10, 11, 13, 14])
  assert.deepEqual(all.msgs[7].content, [{ type: 'thinking', thinking: 'hm', signature: 'sig' }])
  assert.equal(all.msgs.some((m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result')), false)
  assert.deepEqual(all.msgs.slice(8), msgs.slice(13))
})

test('a pair whose results a system message follows is stubbed, not dropped', () => {
  const sys: ApiMsg[] = [...msgs.slice(0, 3), { role: 'system', content: 'reminder' }, ...msgs.slice(3)]
  const c: Clock = { steps: 1, turns: 0 }
  assert.deepEqual(apply(sys, { tool: dropAll.tool }, c).msgs, sys)
  const s = apply(sys, { tool: [...stubAll.tool!, ...dropAll.tool!] }, c)
  assert.deepEqual(counts(s), { 'tool:stub': 1 })
})

test('a tool call is stubbed, then dropped, as the conversation goes on', () => {
  // Stub once a step is behind the latest completed one; drop 2 steps later.
  const p: Policy = { tool: [{ on: 'step', wait: 1, action: 'stub' }, { on: 'step', wait: 3, action: 'drop' }] }
  const convo = [1, 2, 3, 4].flatMap((n) => turn(n, 'Bash', { command: 'seq 1 3000' }))
  // What the first call's result is in each request, and the completed steps
  // when that changed. Each request is trimmed at the clock it is sent at, or,
  // through the gate on a warm cache, at the applied clock, as the server does.
  const history = (gated: boolean) => {
    const seen: Array<[string, number]> = []
    let applied: Clock = { steps: 0, turns: 0 }
    for (let k = 3; k <= convo.length; k++) {
      const prefix = convo.slice(0, k)
      const clock = clockOf(prefix)
      let sent = apply(prefix, p, clock)
      if (gated) {
        const keep = apply(prefix, p, applied)
        if (decide(keep.msgs, sent.msgs, false).advanced) applied = clock
        else sent = keep
      }
      const result = sent.msgs.flatMap((m) => (typeof m.content === 'string' ? [] : m.content)).find((b) => b.tool_use_id === 'toolu_1')
      const now = !result ? 'dropped' : result.content === stub(5000) ? 'stubbed' : result.content === long ? 'whole' : 'other'
      if (seen.at(-1)?.[0] !== now) seen.push([now, clock.steps])
    }
    return seen
  }
  // Its step is 1: stubbed at 2 completed steps, dropped at 4.
  assert.deepEqual(history(false), [['whole', 0], ['stubbed', 2], ['dropped', 4]])
  // The gate may hold each back a while, but both still happen, in order.
  assert.deepEqual(history(true).map(([now]) => now), ['whole', 'stubbed', 'dropped'])
})

test('the gate applies every due transition at once', () => {
  const stubLater: Policy = { ...committed, tool: [{ on: 'step', wait: 1, action: 'stub' }] }
  const at = (c: Clock) => apply(msgs, stubLater, c)
  assert.deepEqual(transitions(at({ steps: 0, turns: 0 }), at({ steps: 5, turns: 2 })), { 'tool:stub': 2, 'reasoning:drop': 4 })
  // A clock the gate held back catches up in one batch: a call never sent
  // stubbed goes straight to dropped. One sent stubbed moves on to dropped.
  const p: Policy = { tool: [{ on: 'step', wait: 3, action: 'stub' }, { on: 'step', wait: 4, action: 'drop' }] }
  assert.deepEqual(transitions(apply(msgs, p, { steps: 0, turns: 0 }), apply(msgs, p, { steps: 5, turns: 2 })), { 'tool:drop': 1 })
  assert.deepEqual(transitions(apply(msgs, p, { steps: 4, turns: 2 }), apply(msgs, p, { steps: 5, turns: 2 })), { 'tool:drop': 1 })
})

test('a skill goes whole, with its body, once its turn is completed', () => {
  const skill: ApiMsg[] = [
    { role: 'user', content: 'prompt 1' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_s', name: 'Skill', input: { skill: 'claude-api' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s', content: 'Launching skill: claude-api' }, { type: 'text', text: `Base directory for this skill: /x\n${long}` }] },
    { role: 'assistant', content: [{ type: 'text', text: 'answer 1' }] },
    { role: 'user', content: 'prompt 2' },
    { role: 'assistant', content: [{ type: 'text', text: 'answer 2' }] },
  ]
  const within = skill.slice(0, 4)
  assert.deepEqual(apply(within, committed, clockOf(within)).msgs, within)
  const after = apply(skill, committed, clockOf(skill))
  assert.deepEqual(counts(after), { 'skill:drop': 1 })
  assert.deepEqual(after.origin, [0, 3, 4, 5])
  // Tool rules leave a skill alone.
  assert.deepEqual(apply(skill, { tool: dropAll.tool }, clockOf(skill)).msgs, skill)
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
  const s = apply(m, stubAll, { steps: 1, turns: 0 })
  assert.deepEqual(counts(s), { 'tool:stub': 1 })
  assert.equal((s.msgs[1].content as any[])[1].input.command, `cat > b <<EOF\n${stub(5000)}\nEOF`)
})

test('tools and reasoning have their own rules', () => {
  const s = apply(msgs, stubAll, { steps: 1, turns: 0 })
  assert.deepEqual(counts(s), { 'tool:stub': 1 })
  assert.equal((s.msgs[1].content as any[])[0].type, 'thinking')
})

test('applying is idempotent', () => {
  const once = apply(msgs, stubAll, { steps: 5, turns: 2 })
  const twice = apply(once.msgs, stubAll, { steps: 5, turns: 2 })
  assert.deepEqual(twice.msgs, once.msgs)
  assert.equal(twice.treated.size, 0)
})

test('cold always advances; warm only when savings outweigh the rewrite', () => {
  const keep = apply(msgs, stubAll, { steps: 0, turns: 0 }).msgs
  const adv = apply(msgs, stubAll, { steps: 5, turns: 2 }).msgs
  assert.equal(decide(keep, adv, true).advanced, true)
  assert.equal(decide(keep, adv, false).advanced, true) // the results are most of the history
  // Saving a few characters at the start of a long history does not pay.
  const big: ApiMsg[] = [{ role: 'user', content: 'pp' }, { role: 'user', content: long.repeat(40) }]
  const tiny: ApiMsg[] = [{ role: 'user', content: 'p' }, big[1]]
  assert.equal(decide(big, tiny, false).advanced, false)
  assert.equal(decide(big, tiny, true).advanced, true)
  assert.equal(decide(msgs, msgs, true).advanced, false)
})

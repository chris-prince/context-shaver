import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { blocks, clockNow, clockOf, isPrompt, requestsOf, turnsOf, type ApiMsg, type Clock } from '../src/items.ts'
import { hash } from '../src/log.ts'
import { afterOf, loadPolicy, parsePolicy, seedPolicy, skillRulesNow, treatment, upgraded, withList, type PartRules } from '../src/policy.ts'
import { shaveSkills, type SkillRule } from '../src/skills.ts'
import { anchored, apply, decide, freedSystem, isStubbed, markedTtl, positionsOf, readThrough, settledEnd, sizeOf, stub, stubHeredocs, transitions, trimmedEnd, type Applied, writeCost } from '../src/trim.ts'
import { modelOf } from '../src/models.ts'

const long = 'x'.repeat(5000)
const stubAll: PartRules = { tool: [{ action: 'stub', after: '0 requests' }], reasoning: [{ action: 'drop', after: '0 turns' }] }
const dropAll: PartRules = { tool: [{ action: 'drop', after: '0 requests' }], reasoning: [{ action: 'drop', after: '0 turns' }] }
const policy = parsePolicy(JSON.parse(readFileSync(new URL('../policy.default.json', import.meta.url), 'utf8')))
const committed = policy.conversation_shaver_rules!

// The messages with a breakpoint on the last block, as Claude Code sends them.
const tailed = (msgs: readonly ApiMsg[]): ApiMsg[] =>
  msgs.map((m, i) => {
    if (i < msgs.length - 1) return m
    const c = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
    return { ...m, content: c.map((b, j) => (j < c.length - 1 ? b : { ...b, cache_control: { type: 'ephemeral', ttl: '1h' } })) }
  })
// Gating with a breakpoint on the last block, against a cache that holds an
// entry at every block of `cached` (none, for a cold one), so either request
// can read up to its first change.
const gate = (before: readonly ApiMsg[], after: readonly ApiMsg[], cached: readonly ApiMsg[], model = 'claude-haiku-5-5', thinking = new Map<string, number>()) =>
  decide(tailed(before), tailed(after), new Set(positionsOf(cached, 's', thinking).map((p) => p.prefix)), 's', modelOf(model), thinking)

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
  assert.equal(isPrompt({ role: 'user', content: '<environment_context>\n  <current_date>2026-10-16</current_date>\n</environment_context>' }), false)
  assert.deepEqual(turnsOf(msgs).completed, 2)
  // Two assistant messages a turn; the sixth is the latest request.
  assert.deepEqual(requestsOf(msgs).completed, 5)
  assert.deepEqual(requestsOf(msgs).requestOf.slice(0, 5), [0, 1, 1, 2, 2])
})

test('a rule is due once its unit is completed, past the wait', () => {
  const it = { kind: 'tool' as const, id: 't', request: 3, turn: 2 }
  const stubAt = (requests: number) => treatment([{ action: 'stub', after: '1 request' }], it, { requests, turns: 0 })
  assert.deepEqual([3, 4].map(stubAt), [undefined, 'stub'])
  // Singular or plural is read the same whatever the count.
  assert.deepEqual(afterOf({ action: 'stub', after: '1 requests' }), { on: 'request', wait: 1 })
  assert.deepEqual(afterOf({ action: 'stub', after: '4 turn' }), { on: 'turn', wait: 4 })
  const both = [{ action: 'stub', after: '0 requests' }, { action: 'drop', after: '0 turns' }] as const
  assert.equal(treatment([...both], it, { requests: 3, turns: 1 }), 'stub')
  assert.equal(treatment([...both], it, { requests: 3, turns: 2 }), 'drop') // the stronger wins
  // Before the first prompt is turn 0, which no rule reaches.
  assert.equal(treatment([{ action: 'drop', after: '0 turns' }], { ...it, turn: 0 }, { requests: 9, turns: 9 }), undefined)
})

test('a policy file is checked', () => {
  assert.deepEqual(Object.keys(policy), ['conversation_shaver_rules', 'tool_shaver_rules', 'skill_shaver_rules'])
  assert.deepEqual(Object.keys(committed), ['tool', 'skill', 'tool_search', 'reasoning', 'prompt_and_assistant_text'])
  const parts = (v: object) => ({ conversation_shaver_rules: v })
  const tools = (v: unknown) => ({ tool_shaver_rules: v })
  const skills = (v: unknown) => ({ skill_shaver_rules: v })
  for (const bad of [[], { tools: [] }, { tool: [] }, parts([]), parts({ tool: {} }), parts({ tools: [] }), tools('x'), tools({ claude: {} }), tools({ claude: [{ name: 'x' }] }), tools({ codex: [{ name: 'x', defer: true }] }), tools({ codex: [{ name: 'x', action: 'stub' }] }), tools({ codex: [{ name: 'x', action: 'keep', defer: true }] }), parts({ prompt_and_assistant_text: { summary_threshold_tokens: 0 } }), parts({ prompt_and_assistant_text: { summary_threshold_tokens: '20k' } }), parts({ prompt_and_assistant_text: { memoir_threshold_tokens: 0 } }), parts({ prompt_and_assistant_text: { other: 1 } }), parts({ tool: [{ action: 'stub', after: '-1 request' }] }), parts({ tool: [{ action: 'stub', after: '1 step' }] }), parts({ tool: [{ action: 'stub', after: '1request' }] }), parts({ tool: [{ after: 1, action: 'stub' }] }), parts({ tool: [{ after: '1 turn', wait: 1, action: 'stub' }] }), parts({ tool: [{ on: 'step', wait: 1, action: 'stub' }] }), parts({ reasoning: [{ action: 'stub', after: '0 turns' }] }), skills({}), skills([{ name: 'x', action: 'stub' }]), skills([{ name: 'x', action: 'drop', sentences: 1 }]), skills([{ action: 'keep' }]), skills([{ match: 'x', action: 'keep' }]), skills([{ name: 'x', action: 'stub', text: 'a line' }]), skills([{ name: 'x', action: 'stub', text: 'a line', replaces: 'h', sentences: 1 }]), skills([{ name: 'x', action: 'drop', text: 'a line', replaces: 'h' }])])
    assert.throws(() => parsePolicy(bad))
  assert.doesNotThrow(() => parsePolicy(skills([{ name: 'x', action: 'stub', text: 'a line', replaces: 'h' }])))
  assert.doesNotThrow(() => parsePolicy(tools({ claude: [{ name: 'x', action: 'defer' }], codex: [] })))
})

test('a policy in an older form is put in the current one, and one in the current form is left', () => {
  const older = { tool: [{ on: 'step', wait: 4, action: 'drop' }], tools_not_deferred: ['Bash'], skill_list: [{ match: 'x-*', action: 'drop' }], summary_threshold_tokens: 20000, memoir_threshold_tokens: 15000 }
  assert.deepEqual(upgraded(older), {
    conversation_shaver_rules: { tool: [{ action: 'drop', after: '4 requests' }], prompt_and_assistant_text: { summary_threshold_tokens: 20000, memoir_threshold_tokens: 15000 } },
    tool_shaver_rules: { claude: [{ name: 'Bash', action: 'keep' }, { name: '*', action: 'defer' }] },
    skill_shaver_rules: [{ name: 'x-*', action: 'drop' }],
  })
  assert.equal(upgraded(policy), undefined)
  assert.equal(upgraded({}), undefined)
  const timed = { conversation_shaver_rules: { skill: [{ on: 'turn', wait: 2, action: 'stub' }, { action: 'drop', after: '9 requests' }], prompt_and_assistant_text: { summary_threshold_tokens: 5 } }, tool_shaver_rules: {} }
  assert.deepEqual(upgraded(timed), { conversation_shaver_rules: { skill: [{ action: 'stub', after: '2 turns' }, { action: 'drop', after: '9 requests' }], prompt_and_assistant_text: { summary_threshold_tokens: 5 } }, tool_shaver_rules: {} })
})

test('skill rules a session saved in the older form, by match, are read by name, so its list still shortens', () => {
  const saved = [{ match: 'x-*', action: 'drop' }, { name: 'y', action: 'keep' }] as SkillRule[]
  const rules = skillRulesNow(saved)
  assert.deepEqual(rules, [{ name: 'x-*', action: 'drop' }, { name: 'y', action: 'keep' }])
  const body = { messages: [{ role: 'system', content: 'The following skills are available for use with the Skill tool:\n\n- x-a: A thing.\n- y: Why.' }] }
  assert.doesNotThrow(() => shaveSkills(body, rules))
  assert.ok(!body.messages[0].content.includes('x-a'))
})

test('a clock a session saved when requests were steps is read as requests, so trimming holds there', () => {
  const saved = clockNow({ steps: 2, turns: 1 } as Clock)
  assert.deepEqual(saved, { requests: 2, turns: 1 })
  assert.deepEqual(apply(msgs, stubAll, saved), apply(msgs, stubAll, { requests: 2, turns: 1 }))
  assert.deepEqual(clockNow({ requests: 3, turns: 0 }), { requests: 3, turns: 0 })
})

test('loading a policy in an older form rewrites the file in the current one, keeping the old text beside it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shaver-'))
  const file = path.join(dir, 'policy.json')
  const older = '{"tool":[{"on":"step","wait":4,"action":"drop"}],"tool_list":{"claude":[{"name":"*","defer":true}]},"summary_threshold_tokens":20000}'
  writeFileSync(file, older)
  const loaded = loadPolicy(file)
  assert.deepEqual(loaded, { conversation_shaver_rules: { tool: [{ action: 'drop', after: '4 requests' }], prompt_and_assistant_text: { summary_threshold_tokens: 20000 } }, tool_shaver_rules: { claude: [{ name: '*', action: 'defer' }] } })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), loaded)
  assert.equal(readFileSync(`${file}.old`, 'utf8'), older)
  assert.deepEqual(loadPolicy(file), loaded)
})

test('a missing policy file is made from the default, and an edited one is kept', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shaver-'))
  const [file, from] = [path.join(dir, 'policy.json'), path.join(dir, 'policy.default.json')]
  seedPolicy(file, from)
  assert.throws(() => readFileSync(file))
  writeFileSync(from, '{"tool":[]}')
  seedPolicy(file, from)
  assert.equal(readFileSync(file, 'utf8'), '{"tool":[]}')
  writeFileSync(file, '{}')
  seedPolicy(file, from)
  assert.equal(readFileSync(file, 'utf8'), '{}')
})

test('with no rules, requests pass through', () => {
  const a = apply(msgs, {}, { requests: 5, turns: 2 })
  assert.deepEqual(a.msgs, msgs)
  assert.equal(a.treated.size, 0)
})

test('trimming ends where the furthest rule reaches', () => {
  const p: PartRules = { tool: [{ action: 'stub', after: '1 request' }] }
  assert.deepEqual(trimmedEnd(msgs, p, { requests: 2, turns: 0 }), { tools: 3, reasoning: 0 })
  // Held to the 5 completed requests and 2 turns.
  assert.deepEqual(trimmedEnd(msgs, { ...committed, ...stubAll }, { requests: 9, turns: 9 }), { tools: 13, reasoning: 10 })
})

test('stubs completed requests and drops completed turns\' thinking, never the latest', () => {
  const s = apply(msgs, stubAll, { requests: 9, turns: 5 }) // held to 5 requests, 2 turns
  // The current turn's result too: its request is completed.
  assert.deepEqual(counts(s), { 'tool:stub': 3, 'reasoning:drop': 4 })
  const r = s.msgs[2].content as any[]
  assert.equal(r[0].content, stub(5000))
  assert.deepEqual(r[0].cache_control, { type: 'ephemeral' })
  assert.equal((s.msgs[1].content as any[])[0].input.content, stub(5000))
  assert.equal((s.msgs[12].content as any[])[0].content, stub(5000))
  assert.deepEqual(s.msgs.slice(13), msgs.slice(13))
})

test('dropping removes calls with their results, and messages left empty', () => {
  const s = apply(msgs, { tool: dropAll.tool }, { requests: 1, turns: 0 })
  assert.deepEqual(counts(s), { 'tool:drop': 1 })
  // The call's message keeps its thinking; the result's message goes.
  assert.deepEqual(s.msgs[1].content, [{ type: 'thinking', thinking: 'hm', signature: 'sig' }])
  assert.deepEqual(s.msgs.slice(2), msgs.slice(3))
  assert.deepEqual(s.origin.slice(0, 3), [0, 1, 3])
  // With its thinking dropped too, the call's message goes as well. The
  // current turn keeps its thinking, and the latest request its call.
  const all = apply(msgs, dropAll, { requests: 9, turns: 5 })
  assert.deepEqual(counts(all), { 'reasoning:drop': 4, 'tool:drop': 3 })
  assert.deepEqual(all.origin, [0, 3, 4, 5, 8, 9, 10, 11, 13, 14])
  assert.deepEqual(all.msgs[7].content, [{ type: 'thinking', thinking: 'hm', signature: 'sig' }])
  assert.equal(all.msgs.some((m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result')), false)
  assert.deepEqual(all.msgs.slice(8), msgs.slice(13))
})

test('a pair whose drop would leave a system message after an assistant one is stubbed, not dropped', () => {
  const sys: ApiMsg[] = [...msgs.slice(0, 3), { role: 'system', content: 'reminder' }, ...msgs.slice(3)]
  const c: Clock = { requests: 1, turns: 0 }
  // The call's message keeps its thinking, which the system message would
  // follow. A policy with no stub rule stubs it all the same.
  for (const tool of [dropAll.tool!, [...stubAll.tool!, ...dropAll.tool!]]) {
    const s = apply(sys, { tool }, c)
    assert.deepEqual(counts(s), { 'tool:stub': 1 })
    assert.deepEqual(s.origin, sys.map((_, i) => i))
  }
  // With its thinking dropped too, the call's message goes, and the system
  // message follows the prompt.
  const both = apply(sys, dropAll, { requests: 1, turns: 1 })
  assert.deepEqual(counts(both), { 'reasoning:drop': 2, 'tool:drop': 1 })
  assert.deepEqual(both.origin.slice(0, 3), [0, 3, 4])
})

test('of two pairs before a system message, one is kept so that it follows a user message', () => {
  // A response with text and a call, then a call alone, then a system message.
  // Dropping both leaves the system message after the text, so the second
  // pair, the one beside it, is kept and stubbed; the first still goes, its
  // text staying.
  const call = (n: number, text?: string): ApiMsg[] => [
    { role: 'assistant', content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id: `toolu_${n}`, name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${n}`, content: long }] },
  ]
  const convo: ApiMsg[] = [{ role: 'user', content: 'prompt' }, ...call(1, 'looking'), ...call(2), { role: 'system', content: 'reminder' }, ...call(3), { role: 'assistant', content: 'done' }]
  const s = apply(convo, { tool: dropAll.tool }, { requests: 2, turns: 0 })
  assert.deepEqual(counts(s), { 'tool:drop': 1, 'tool:stub': 1 })
  assert.equal((s.msgs[3].content as any[])[0].content, stub(long.length))
  assert.deepEqual(s.origin, [0, 1, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(s.msgs[1].content, [{ type: 'text', text: 'looking' }])
})

test('a tool search is its own kind, dropped by its own rules', () => {
  const convo = [1, 2, 3].flatMap((n) => turn(n, n === 1 ? 'ToolSearch' : 'Bash', { query: 'select:CronList' }))
  const p: PartRules = { tool: [{ action: 'drop', after: '0 requests' }], tool_search: [{ action: 'drop', after: '1 turn' }] }
  const kept = apply(convo, p, { requests: 5, turns: 1 })
  assert.deepEqual(counts(kept), { 'tool:drop': 2 })
  assert.ok(kept.msgs.some((m) => typeof m.content !== 'string' && m.content.some((b) => b.tool_use_id === 'toolu_1')))
  assert.deepEqual(counts(apply(convo, p, { requests: 5, turns: 2 })), { 'tool:drop': 2, 'tool_search:drop': 1 })
})

test('a Read sent as system text is a tool call; the rest of its message stays', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `${i + 1}\tline ${i + 1}\n`).join('')
  const read = (f: string, body = lines) => `Called the Read tool with the following input: {"file_path":"${f}"}\nResult of calling the Read tool:\n${body}\n`
  const env = '# Environment\nYou have been invoked in the following environment.'
  const attached: ApiMsg = { role: 'system', content: [{ type: 'text', text: read('a.ts') + read('b.ts') + env, cache_control: { type: 'ephemeral' } }] }
  const convo = [...msgs.slice(0, 3), attached, ...msgs.slice(3)]
  const at = (a: Applied) => a.msgs[a.origin.indexOf(3)]

  const stubbed = apply(convo, stubAll, clockOf(convo))
  assert.deepEqual(stubbed.treated.get('read:3:1'), { kind: 'tool', action: 'stub' })
  const s = `${stub(Buffer.byteLength(lines))}\n`
  assert.deepEqual(at(stubbed).content, [{ type: 'text', text: read('a.ts', s) + read('b.ts', s) + env, cache_control: { type: 'ephemeral' } }])

  const dropped = apply(convo, dropAll, clockOf(convo))
  assert.deepEqual(blocks(at(dropped)), [{ type: 'text', text: env, cache_control: { type: 'ephemeral' } }])
  // A message holding only Reads goes whole.
  const alone = [...msgs.slice(0, 3), { role: 'system', content: read('a.ts') } as ApiMsg, ...msgs.slice(3)]
  assert.equal(apply(alone, dropAll, clockOf(alone)).origin.includes(3), false)
  // Before the first response, it is the base.
  const base = [msgs[0], { role: 'system', content: read('a.ts') } as ApiMsg, ...msgs.slice(1)]
  assert.equal(apply(base, dropAll, clockOf(base)).msgs[1], base[1])
})

test('a tool call is stubbed, then dropped, as the conversation goes on', () => {
  // Stub once a request is behind the latest completed one; drop 2 requests later.
  const p: PartRules = { tool: [{ action: 'stub', after: '1 request' }, { action: 'drop', after: '3 requests' }] }
  const convo = [1, 2, 3, 4].flatMap((n) => turn(n, 'Bash', { command: 'seq 1 3000' }))
  // What the first call's result is in each request, and the completed requests
  // when that changed. Each request is trimmed at the clock it is sent at, or,
  // through the gate on a warm cache, at the applied clock, as the server does.
  const history = (gated: boolean) => {
    const seen: Array<[string, number]> = []
    let applied: Clock = { requests: 0, turns: 0 }
    for (let k = 3; k <= convo.length; k++) {
      const prefix = convo.slice(0, k)
      const clock = clockOf(prefix)
      let sent = apply(prefix, p, clock)
      if (gated) {
        const keep = apply(prefix, p, applied)
        if (gate(keep.msgs, sent.msgs, keep.msgs).advanced) applied = clock
        else sent = keep
      }
      const result = sent.msgs.flatMap((m) => (typeof m.content === 'string' ? [] : m.content)).find((b) => b.tool_use_id === 'toolu_1')
      const now = !result ? 'dropped' : result.content === stub(5000) ? 'stubbed' : result.content === long ? 'whole' : 'other'
      if (seen.at(-1)?.[0] !== now) seen.push([now, clock.requests])
    }
    return seen
  }
  // Its request is 1: stubbed at 2 completed requests, dropped at 4.
  assert.deepEqual(history(false), [['whole', 0], ['stubbed', 2], ['dropped', 4]])
  // The gate may hold each back a while, but both still happen, in order.
  assert.deepEqual(history(true).map(([now]) => now), ['whole', 'stubbed', 'dropped'])
})

test('the gate applies every due transition at once', () => {
  const stubLater: PartRules = { ...committed, tool: [{ action: 'stub', after: '1 request' }] }
  const at = (c: Clock) => apply(msgs, stubLater, c)
  assert.deepEqual(transitions(at({ requests: 0, turns: 0 }), at({ requests: 5, turns: 2 })), { 'tool:stub': 2, 'reasoning:drop': 4 })
  // A clock the gate held back catches up in one batch: a call never sent
  // stubbed goes straight to dropped. One sent stubbed moves on to dropped.
  const p: PartRules = { tool: [{ action: 'stub', after: '3 requests' }, { action: 'drop', after: '4 requests' }] }
  assert.deepEqual(transitions(apply(msgs, p, { requests: 0, turns: 0 }), apply(msgs, p, { requests: 5, turns: 2 })), { 'tool:drop': 1 })
  assert.deepEqual(transitions(apply(msgs, p, { requests: 4, turns: 2 }), apply(msgs, p, { requests: 5, turns: 2 })), { 'tool:drop': 1 })
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
  const p: PartRules = { skill: [{ action: 'drop', after: '0 turns' }] }
  const within = skill.slice(0, 4)
  assert.deepEqual(apply(within, p, clockOf(within)).msgs, within)
  const after = apply(skill, p, clockOf(skill))
  assert.deepEqual(counts(after), { 'skill:drop': 1 })
  assert.deepEqual(after.origin, [0, 3, 4, 5])
  // Tool rules leave a skill alone.
  assert.deepEqual(apply(skill, { tool: dropAll.tool }, clockOf(skill)).msgs, skill)
})

test('a stubbed skill keeps its call, result and base directory', () => {
  const body = `Base directory for this skill: /x\n${long}`
  const skill: ApiMsg[] = [
    { role: 'user', content: 'prompt 1' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_s', name: 'Skill', input: { skill: 'claude-api' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s', content: 'Launching skill: claude-api' }, { type: 'text', text: body }] },
    ...turn(2, 'Bash', { command: 'ls' }),
    ...turn(3, 'Bash', { command: 'ls' }),
  ]
  const p: PartRules = { skill: [{ action: 'stub', after: '1 request' }, { action: 'drop', after: '3 requests' }] }
  const stubbed = apply(skill, p, { requests: 2, turns: 0 })
  assert.deepEqual(counts(stubbed), { 'skill:stub': 1 })
  assert.deepEqual(stubbed.msgs[2].content, [skill[2].content[0], { type: 'text', text: `Base directory for this skill: /x\n${stub(long.length)}` }])
  assert.deepEqual(stubbed.origin, skill.map((_, i) => i))
  assert.deepEqual(counts(apply(skill, p, { requests: 4, turns: 0 })), { 'skill:drop': 1 })
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
  const s = apply(m, stubAll, { requests: 1, turns: 0 })
  assert.deepEqual(counts(s), { 'tool:stub': 1 })
  assert.equal((s.msgs[1].content as any[])[1].input.command, `cat > b <<EOF\n${stub(5000)}\nEOF`)
})

test('tools and reasoning have their own rules', () => {
  const s = apply(msgs, stubAll, { requests: 1, turns: 0 })
  assert.deepEqual(counts(s), { 'tool:stub': 1 })
  assert.equal((s.msgs[1].content as any[])[0].type, 'thinking')
})

test('applying is idempotent', () => {
  const once = apply(msgs, stubAll, { requests: 5, turns: 2 })
  const twice = apply(once.msgs, stubAll, { requests: 5, turns: 2 })
  assert.deepEqual(twice.msgs, once.msgs)
  assert.equal(twice.treated.size, 0)
})

test('cold always advances; warm only when savings outweigh the rewrite', () => {
  const keep = apply(msgs, stubAll, { requests: 0, turns: 0 }).msgs
  const adv = apply(msgs, stubAll, { requests: 5, turns: 2 }).msgs
  assert.equal(gate(keep, adv, []).advanced, true)
  assert.equal(gate(keep, adv, keep).advanced, true) // the results are most of the history
  // Saving a few characters at the start of a long history does not pay.
  const big: ApiMsg[] = [{ role: 'user', content: 'pp' }, { role: 'user', content: long.repeat(40) }]
  const tiny: ApiMsg[] = [{ role: 'user', content: 'p' }, big[1]]
  assert.equal(gate(big, tiny, big).advanced, false)
  assert.equal(gate(big, tiny, []).advanced, true)
  assert.equal(gate(msgs, msgs, []).advanced, false)
})

test('a request with no breakpoints in its messages never advances', () => {
  const unmarked = (ms: readonly ApiMsg[]): ApiMsg[] => JSON.parse(JSON.stringify(ms, (k, v) => (k === 'cache_control' ? undefined : v)))
  const keep = unmarked(apply(msgs, stubAll, { requests: 0, turns: 0 }).msgs)
  const adv = unmarked(apply(msgs, stubAll, { requests: 5, turns: 2 }).msgs)
  assert.equal(decide(keep, adv, new Set(), 's', modelOf('claude-haiku-5-5')).advanced, false)
})

test('a thinking block is sized by the tokens it bills, not its signature', () => {
  const sig = 's'.repeat(2000)
  const block = { type: 'thinking', thinking: '', signature: sig }
  const think = (sg: string): ApiMsg => ({ role: 'assistant', content: [{ ...block, signature: sg }, { type: 'text', text: 'a' }] })
  const tail: ApiMsg[] = [{ role: 'user', content: 'x'.repeat(3000) }]
  const keep = [{ role: 'user', content: 'p' } as ApiMsg, think(sig), ...tail]
  const drop = [keep[0], { role: 'assistant', content: [{ type: 'text', text: 'a' }] } as ApiMsg, ...tail]
  // Unknown, it is put at 0.13 tokens a signature character: 2000 chars of
  // signature size as 667 of text.
  assert.equal(sizeOf(block, new Map()), 667 - 2000 + JSON.stringify(block).length)
  // A block that billed little is not worth the rewrite; one that billed much is.
  assert.equal(gate(keep, drop, keep, 'claude-haiku-5-5', new Map([[hash(sig), 50]])).advanced, false)
  assert.equal(gate(keep, drop, keep, 'claude-haiku-5-5', new Map([[hash(sig), 3000]])).advanced, true)
})

test('a model with cheaper reads makes a rewrite cost more of them', () => {
  // Saving S of a rewrite R ≈ 3S: M R - (M + 1) S is about 37 S at M = 19, within K S
  // = 40 S, and about 77 S at M = 39, beyond it.
  const head: ApiMsg[] = [{ role: 'user', content: 'p' }]
  const keep = [...head, { role: 'user', content: 'x'.repeat(1000) } as ApiMsg, { role: 'user', content: 'y'.repeat(2000) } as ApiMsg]
  const drop = [...head, { role: 'user', content: '' } as ApiMsg, keep[2]]
  assert.equal(writeCost(modelOf('claude-haiku-5-5')), 19)
  assert.equal(writeCost(modelOf('claude-opus-5-5')), 39)
  // A 5-minute write is 1.25x input.
  assert.ok(Math.abs(writeCost({ ...modelOf('claude-haiku-5-5'), ttl: 300 }) - 11.5) < 1e-9)
  assert.ok(Math.abs(writeCost(modelOf('gpt-6-luna'), true) - 11.5) < 1e-9)
  // Sol reads at 0.05x input, not luna's 0.1x, so a write costs twice the reads.
  assert.ok(Math.abs(writeCost(modelOf('gpt-6.1-sol'), true) - 24) < 1e-9)
  // Sonnet 5 reads at 0.1x, so a 5-minute write costs 11.5 reads and an hour's 19.
  assert.ok(Math.abs(writeCost({ ...modelOf('claude-sonnet-5'), ttl: 300 }) - 11.5) < 1e-9)
  assert.ok(Math.abs(writeCost(modelOf('claude-sonnet-5')) - 19) < 1e-9)
  assert.equal(gate(keep, drop, keep).advanced, true)
  assert.equal(gate(keep, drop, keep, 'claude-opus-5-5').advanced, false)
})

test('advancing reads only through an entry the cache holds', () => {
  // A long head, a 1000-character change, then a 2000-character tail. With an
  // entry at every block, advancing rewrites 3000 characters to save 1000; with
  // one only where the last request ended, it rewrites the head as well.
  const head: ApiMsg[] = [{ role: 'user', content: 'h'.repeat(20000) }, { role: 'user', content: 'p' }]
  const keep = [...head, { role: 'user', content: 'x'.repeat(1000) } as ApiMsg, { role: 'user', content: 'y'.repeat(2000) } as ApiMsg]
  const drop = [...head, { role: 'user', content: '' } as ApiMsg, keep[3]]
  const atHead = gate(keep, drop, keep)
  assert.equal(atHead.advanced, true)
  assert.equal(atHead.rewriteChars, positionsOf(tailed(keep), 's', new Map()).slice(2).reduce((n, p) => n + p.size, 0))
  const live = new Set(positionsOf(tailed(keep), 's', new Map()).filter((p) => p.breakpoint).map((p) => p.prefix))
  const atEnd = decide(tailed(keep), tailed(drop), live, 's', modelOf('claude-haiku-5-5'))
  assert.equal(atEnd.cold, false)
  assert.equal(atEnd.advanced, false)
  assert.ok(atEnd.rewriteChars > 23000)
})

test('a breakpoint where the messages stop matching them settled lets a move read through it', () => {
  // As above, but the requests before the move carried a breakpoint on the last
  // block before the change, so the move reads the head and rewrites the rest.
  const head: ApiMsg[] = [{ role: 'user', content: 'h'.repeat(20000) }, { role: 'user', content: 'p' }]
  const keep = [...head, { role: 'user', content: 'x'.repeat(1000) } as ApiMsg, { role: 'user', content: 'y'.repeat(2000) } as ApiMsg]
  const drop = [...head, { role: 'user', content: '' } as ApiMsg, keep[3]]
  const end = settledEnd(keep, drop, 's', new Map())
  const [a, b] = [anchored(tailed(keep), end, 's', new Map()), anchored(tailed(drop), end, 's', new Map())]
  assert.deepEqual(blocks(a[1])[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(blocks(b[1])[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  const live = new Set(positionsOf(a, 's', new Map()).filter((p) => p.breakpoint).map((p) => p.prefix))
  const d = decide(a, b, live, 's', modelOf('claude-haiku-5-5'))
  assert.equal(d.advanced, true)
  assert.ok(d.rewriteChars < 4000)
})

test('the settled breakpoint skips thinking and leaves the message ones in place', () => {
  const end = settledEnd(msgs, apply(msgs, stubAll, { requests: Infinity, turns: Infinity }).msgs, 's', new Map())
  // Turn 1's first response is where trimming starts: its thinking and call
  // change, so the breakpoint goes on the prompt before them.
  const a = anchored(tailed(msgs), end, 's', new Map())
  assert.ok(blocks(a[0])[1].cache_control)
  assert.equal(a.flatMap(blocks).filter((b) => b.cache_control).length, 5)
  // Nothing settled differs: the last block already has a breakpoint, so none is added.
  assert.equal(anchored(tailed(msgs), settledEnd(msgs, msgs, 's', new Map()), 's', new Map()).flatMap(blocks).filter((b) => b.cache_control).length, 4)
})

test('the system prompt gives up its first breakpoint, and only when it has two', () => {
  const c = { type: 'ephemeral', ttl: '1h' }
  const system = [{ type: 'text', text: 'billing' }, { type: 'text', text: 'identity', cache_control: c }, { type: 'text', text: 'prompt', cache_control: c }]
  assert.deepEqual(freedSystem(system), [system[0], { type: 'text', text: 'identity' }, system[2]])
  assert.equal(freedSystem([system[0], system[2]]), undefined)
  assert.equal(freedSystem('a string'), undefined)
})

test('an entry more than 20 blocks before every breakpoint is not read', () => {
  const msgs = Array.from({ length: 20 + 3 }, (_, i): ApiMsg => ({ role: 'user', content: `m${i}` }))
  const first = msgs.slice(0, 2)
  assert.equal(decide(tailed(msgs), tailed(msgs.slice(1)), new Set(positionsOf(first, 's', new Map()).map((p) => p.prefix)), 's', modelOf('claude-haiku-5-5')).cold, true)
  const near = msgs.slice(0, 3)
  assert.equal(decide(tailed(msgs), tailed(msgs.slice(1)), new Set(positionsOf(near, 's', new Map()).map((p) => p.prefix)), 's', modelOf('claude-haiku-5-5')).cold, false)
})

test('a run of tool calls or results is one lookback position', () => {
  const calls: ApiMsg = { role: 'assistant', content: Array.from({ length: 20 + 5 }, (_, i) => ({ type: 'tool_use', id: `t${i}`, name: 'Read', input: {} })) }
  const results: ApiMsg = { role: 'user', content: Array.from({ length: 20 + 5 }, (_, i) => ({ type: 'tool_result', tool_use_id: `t${i}`, content: 'x' })) }
  const pos = positionsOf(tailed([{ role: 'user', content: 'go' }, calls, results]), 's', new Map())
  assert.equal(readThrough(pos, new Set([pos[0].prefix]), 20), 0)
})

test('with automatic caching, a request reads back only 20 user runs from its end', () => {
  const turn = (i: number): ApiMsg[] => [
    { role: 'user', content: [{ type: 'text', text: `q${i}` }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: long }] },
    { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] },
  ]
  const before = Array.from({ length: 30 }, (_, i) => turn(i)).flat()
  // What prepare records: each user message's end, and the request's own.
  const ends = (msgs: ApiMsg[]) => positionsOf(msgs, 's', new Map(), true).filter((p) => !p.joined || p.breakpoint)
  const live = new Set(ends(before).map((p) => p.prefix))
  const stubbedAt = (j: number) => before.map((m, k) => (k === j ? { ...m, content: [{ type: 'tool_result', tool_use_id: `t${(j - 2) / 4}`, content: stub(5000) }] } : m))
  const grown = [...before, { role: 'user', content: [{ type: 'text', text: 'next' }] } as ApiMsg]
  const pos = (msgs: ApiMsg[]) => positionsOf(msgs, 's', new Map(), true)
  // Growing reads up to the end of the last request.
  assert.equal(readThrough(pos(grown), live, 20), pos(before).length - 1)
  // A change within reach reads up to the user run before it; one further back, nothing.
  assert.equal(readThrough(pos(stubbedAt(110)), live, 20), 108)
  assert.equal(readThrough(pos(stubbedAt(2)), live, 20), -1)
})

test("a request's breakpoints give its entries' lifetime", () => {
  const hour = { type: 'ephemeral', ttl: '1h' }
  const five = { type: 'ephemeral' }
  const body = (system: object, last: object) => ({ system: [{ type: 'text', text: 's', cache_control: system }], messages: [{ role: 'user', content: [{ type: 'text', text: 'u', cache_control: last }] }] })
  assert.equal(markedTtl(body(hour, hour)), 3600)
  // Bedrock clients often leave the TTL out: the API's 5 minutes.
  assert.equal(markedTtl(body(five, five)), 300)
  assert.equal(markedTtl(body(hour, five)), 300)
  assert.equal(markedTtl({ messages: [{ role: 'user', content: 'u' }] }), undefined)
})

test("setting a policy file's skill list changes only that value's text", () => {
  const rules = [{ name: 'init', action: 'stub' as const, text: 'Set "up" memory]', replaces: 'ab' }, { name: 'x-*', action: 'drop' as const }]
  const head = '{\n  // not JSON, but kept as written\n  "conversation_shaver_rules":   { "tool": [ { "on": "step", "wait": 4, "action": "drop" } ] },\n  "note": "skill_shaver_rules: [ }",\n  "nested": { "skill_shaver_rules": [1] },\n  "skill_shaver_rules": '
  const tail = ',\n  "tool_shaver_rules": {}\n}\n'
  const text = head + '[\n    { "name": "old", "action": "keep" }\n  ]' + tail
  const out = withList(text, 'skill_shaver_rules', rules)
  assert.ok(out.startsWith(head) && out.endsWith(tail))
  assert.deepEqual(JSON.parse(out.slice(head.length, out.length - tail.length)), rules)
  for (const file of ['{\n  "conversation_shaver_rules": {}\n}\n', '{}\n']) {
    const added = JSON.parse(withList(file, 'skill_shaver_rules', rules))
    assert.deepEqual(added, { ...JSON.parse(file), skill_shaver_rules: rules })
  }
})

test("a policy file's tool rules are set in place, by harness", () => {
  const rules = { claude: [{ name: 'Bash', action: 'keep' }, { name: '*', action: 'defer' }], codex: [] }
  const file = '{\n  "conversation_shaver_rules": {},\n  "tool_shaver_rules": { "claude": [] },\n  "skill_shaver_rules": []\n}\n'
  const out = withList(file, 'tool_shaver_rules', rules)
  assert.deepEqual(Object.entries(JSON.parse(out)), [['conversation_shaver_rules', {}], ['tool_shaver_rules', rules], ['skill_shaver_rules', []]])
})

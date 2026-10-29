import { test } from 'node:test'
import assert from 'node:assert/strict'
import { afterAnswer, optimizing, pickWords, PICK, skillsAsked, skillsText, toolsAsked, toolsText, type Proposal } from '../src/optimize.ts'
import { parsePolicy, toolRulesOf } from '../src/policy.ts'

const skill = (name: string) => ({ name, description: `${name} does a long thing in many words` })
const skills = [skill('alpha'), skill('beta'), skill('gamma')]
const lines = { alpha: 'Alpha line', beta: 'Beta line', gamma: 'Gamma line' }
const file = (body: object) => JSON.stringify(body, null, 2) + '\n'
const rulesIn = (text: string) => parsePolicy(JSON.parse(text))
const stub = (s: { name: string; description: string }, text: string) => ({ match: s.name, action: 'stub', text, replaces: '*' })

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  key: 'k', asking: 'skills', skills, lines, trimmed: [],
  tools: { harness: { name: 'claude', core: ['Bash'] }, action: 'defer', names: ['Agent', 'WebFetch'], chosen: [], text: 'TOOLS TABLE' },
  changed: 0, ...over,
})

test('an answer is all, none, keep or item numbers, whatever the case or separators', () => {
  assert.equal(pickWords('All'), 'all')
  assert.equal(pickWords('keep'), 'keep')
  assert.equal(pickWords('1, 3 5'), '1 3 5')
  assert.equal(pickWords('1,3-6 9'), '1 3-6 9')
  assert.equal(pickWords('2 - 4,07'), '2-4 7')
  // Any other reply is an answer too, so it asks again.
  assert.equal(pickWords('trim them'), 'invalid')
  assert.equal(pickWords('1 x'), 'invalid')
  assert.equal(pickWords(' , '), 'invalid')
  assert.equal(pickWords('1-'), '1-')
  assert.equal(pickWords('1-2-3'), '1-2-3')
  assert.equal(pickWords('5-3'), '5-3')
})

test('the skill table numbers every skill and says which are trimmed', () => {
  const text = skillsText(skills, lines, new Set(['beta']), 1000, true)
  assert.equal(text, [
    'Can save 1,000 tokens using short skill descriptions:',
    '',
    '| Skill | Trimmed | Trimmed Description |',
    '| --- | --- | --- |',
    '| 1. alpha | No | Alpha line |',
    '| 2. beta | Yes | Beta line |',
    '| 3. gamma | No | Gamma line |',
  ].join('\n'))
})

test('the tool table numbers every tool and says which are deferred', () => {
  assert.match(toolsText(['Agent', 'WebFetch'], ['WebFetch'], 900), /^Can save 900 tokens by deferring tools until the model needs them:\n\n\| Tool \| Deferred \|\n\| --- \| --- \|\n\| 1\. Agent \| No \|\n\| 2\. WebFetch \| Yes \|$/)
})

test("where tools can't be deferred, dropping is offered with a warning, and the question asks which to drop", () => {
  const text = toolsText(['clock.sleep'], [], 40, 'drop')
  assert.match(text, /^Codex can't defer tools with ChatGPT sign-in, only drop them\. The model can't use a dropped tool at all, so drop with caution\.\n\nCan save 40 tokens by dropping tools:\n\n\| Tool \| Dropped \|\n/)
  const tools = { harness: { name: 'codex', core: [] }, action: 'drop' as const, names: ['clock.sleep'], chosen: [], text }
  assert.match(toolsAsked('k', tools)!.reply, /Which tools should be dropped\?/)
  const rules = toolRulesOf(rulesIn(afterAnswer(proposal({ asking: 'tools', tools }), 'all', file({}), '/p').text), 'codex')
  assert.deepEqual(rules, [{ name: 'clock.sleep', action: 'drop' }])
})

test('the header counts every skill in the table', () => {
  assert.equal(optimizing(22, 4226), '22 skills add 4,226 tokens on every request. Optimizing...\n\n')
  assert.equal(optimizing(1, undefined), '1 skill is listed. Optimizing...\n\n')
})

test('the first question is about tools, if there are any to defer', () => {
  const asked = toolsAsked('k', proposal().tools)!
  assert.equal(asked.reply, `TOOLS TABLE\n\nWhich tools should be deferred?\n${PICK}`)
  assert.equal(asked.next.asking, 'tools')
  assert.deepEqual(asked.next.skills, [])
  assert.equal(toolsAsked('k', 'No tools to defer.'), undefined)
})

test('the skills question follows, if there are any to trim', () => {
  const asked = skillsAsked(proposal({ asking: 'tools', skills: [], lines: {} }), { text: 'SKILLS TABLE', skills, lines, trimmed: ['beta'] })
  assert.equal(asked.reply, `SKILLS TABLE\n\nWhich skills should be trimmed?\n${PICK}`)
  assert.equal(asked.next?.asking, 'skills')
  assert.deepEqual(asked.next?.trimmed, ['beta'])
  const none = { text: 'No skills found in this session.', skills: [], lines: {}, trimmed: [] }
  assert.deepEqual(skillsAsked(proposal({ asking: 'tools' }), none), { reply: 'No skills found in this session.' })
  assert.match(skillsAsked(proposal({ asking: 'tools', changed: 1 }), none).reply, /^No skills found in this session\.\n\nRun \/clear/)
})

test('a skill answer puts the lines picked in the policy, and ends', () => {
  const before = file({ skill_list: [{ match: '*', action: 'keep' }] })
  const out = afterAnswer(proposal(), '1 3', before, '/p/policy.json')
  assert.deepEqual(rulesIn(out.text).skill_list, [stub(skills[0], 'Alpha line'), stub(skills[2], 'Gamma line'), { match: '*', action: 'keep' }])
  assert.match(out.reply, /^Modified 2 skills in shaver policy file\.\n\/p\/policy\.json\n\nRun \/clear in every claude\/codex\/opencode active session/)
  assert.equal(out.next, undefined)
})

test('an answer turns back the trims it leaves out', () => {
  const before = file({ skill_list: [stub(skills[1], 'Beta line'), { match: '*', action: 'keep' }] })
  const out = afterAnswer(proposal({ trimmed: ['beta'] }), 'none', before, '/p')
  assert.deepEqual(rulesIn(out.text).skill_list, [{ match: '*', action: 'keep' }])
  assert.match(out.reply, /^Modified 1 skill in/)
})

test('lines for skills this session does not list stay', () => {
  const other = skill('delta')
  const before = file({ skill_list: [stub(other, 'Delta line')] })
  const out = afterAnswer(proposal(), 'none', before, '/p')
  assert.equal(out.text, before)
})

test('keep, or picking what is already so, leaves the file as it was', () => {
  const before = file({ skill_list: [stub(skills[1], 'Beta line')] })
  assert.equal(afterAnswer(proposal({ trimmed: ['beta'] }), 'keep', before, '/p').text, before)
  assert.equal(afterAnswer(proposal({ trimmed: ['beta'] }), '2', before, '/p').text, before)
})

test('an invalid answer asks again and changes nothing', () => {
  const before = file({})
  for (const answer of ['4', '0', '2-4', '1 99999', '3-2', '2-2-3', '1-', '-1', '1 , -', '1 x', 'trim them', 'keep it']) {
    const out = afterAnswer(proposal(), pickWords(answer), before, '/p')
    assert.equal(out.text, before, answer)
    assert.equal(out.reply, `All numbers must be between 1 and 3. Ranges must be stated as X-Y, smaller number first. Keywords are: all / none / keep.\n\nWhich skills should be trimmed?\n${PICK}`)
    assert.equal(out.next?.asking, 'skills')
  }
})

test('a range picks every item in it', () => {
  const trimmedBy = (answer: string) => {
    const text = afterAnswer(proposal(), pickWords(answer), file({ skill_list: [{ match: '*', action: 'keep' }] }), '/p').text
    return rulesIn(text).skill_list!.filter((r) => 'text' in r).map((r) => r.match)
  }
  assert.deepEqual(trimmedBy('1-2'), ['alpha', 'beta'])
  assert.deepEqual(trimmedBy('2-2'), ['beta'])
  assert.deepEqual(trimmedBy('1,2-3'), ['alpha', 'beta', 'gamma'])
})

test('a tool answer writes tool rules in place of tools_not_deferred, then goes on to skills', () => {
  const before = file({ tools_not_deferred: ['Bash'] })
  const out = afterAnswer(proposal({ asking: 'tools' }), '2', before, '/p')
  assert.ok(!out.text.includes('tools_not_deferred'))
  const rules = toolRulesOf(rulesIn(out.text), 'claude')!
  assert.deepEqual(rules.find((r) => r.name === 'Agent'), { name: 'Agent', action: 'keep' })
  assert.deepEqual(rules.at(-1), { name: '*', action: 'defer' })
  assert.equal(out.reply, 'Modified 1 tool in shaver policy file.\n/p')
  assert.equal(out.next?.asking, 'skills')
  assert.equal(out.next?.changed, 1)
})

test("a tool answer changes only its harness's rules", () => {
  const codexRules = [{ name: 'clock.sleep', action: 'keep' }]
  const tools = { harness: { name: 'codex', core: [] }, action: 'defer' as const, names: ['clock.sleep'], chosen: [], text: 'T' }
  const before = file({ tool_list: { claude: [{ name: 'Agent', action: 'keep' }, { name: '*', action: 'defer' }], codex: codexRules } })
  const all = rulesIn(afterAnswer(proposal({ asking: 'tools', tools }), 'all', before, '/p').text)
  assert.deepEqual(toolRulesOf(all, 'claude'), toolRulesOf(rulesIn(before), 'claude'))
  assert.deepEqual(toolRulesOf(all, 'codex'), [{ name: '*', action: 'defer' }])
  const claudeTools = { ...(proposal().tools as Exclude<Proposal['tools'], string>), chosen: ['WebFetch'] }
  const none = rulesIn(afterAnswer(proposal({ asking: 'tools', tools: claudeTools }), 'none', before, '/p').text)
  assert.deepEqual(toolRulesOf(none, 'codex'), codexRules)
  assert.ok(!toolRulesOf(none, 'claude')!.some((r) => r.name === '*'))
})

test('a tool answer that changes nothing still puts tool rules in an older form in the current one', () => {
  const tools = { harness: { name: 'codex', core: [] }, action: 'defer' as const, names: ['clock.sleep'], chosen: [], text: 'T' }
  for (const before of [file({ tools_not_deferred: ['Bash'] }), file({ tool_list: [{ name: '*', action: 'defer' }] }), file({ tool_list: { claude: [{ name: '*', defer: true }] } })]) {
    const out = afterAnswer(proposal({ asking: 'tools', tools }), 'keep', before, '/p')
    assert.ok(!out.text.includes('tools_not_deferred'))
    assert.ok(!/"defer"\s*:/.test(out.text))
    assert.deepEqual(Object.keys(rulesIn(out.text).tool_list!), ['claude'])
    assert.equal(out.next?.changed, 0)
  }
  const current = file({ tool_list: { claude: [] } })
  assert.equal(afterAnswer(proposal({ asking: 'tools' }), 'keep', current, '/p').text, current)
})

test('the /clear advice shows only when something changed', () => {
  assert.equal(afterAnswer(proposal(), 'keep', file({}), '/p').reply, 'Modified 0 skills in shaver policy file.\n/p')
  assert.match(afterAnswer(proposal({ changed: 2 }), 'keep', file({}), '/p').reply, /\n\nRun \/clear/)
})

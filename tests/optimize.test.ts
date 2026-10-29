import { test } from 'node:test'
import assert from 'node:assert/strict'
import { afterAnswer, offered, optimizing, pickWords, PICK, skillsText, toolsText, type Proposal } from '../src/optimize.ts'
import { parsePolicy } from '../src/policy.ts'
import { descriptionHash } from '../src/skills.ts'

const skill = (name: string) => ({ name, description: `${name} does a long thing in many words` })
const skills = [skill('alpha'), skill('beta'), skill('gamma')]
const lines = { alpha: 'Alpha line', beta: 'Beta line', gamma: 'Gamma line' }
const file = (body: object) => JSON.stringify(body, null, 2) + '\n'
const rulesIn = (text: string) => parsePolicy(JSON.parse(text))
const stub = (s: { name: string; description: string }, text: string) => ({ match: s.name, action: 'stub', text, replaces: descriptionHash(s.description) })

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  key: 'k', asking: 'skills', skills, lines, trimmed: [],
  tools: { names: ['Agent', 'WebFetch'], deferred: [], text: 'TOOLS TABLE' },
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
    '| # | Skill | Trimmed | Description |',
    '| --- | --- | --- | --- |',
    '| 1 | alpha | No | Alpha line |',
    '| 2 | beta | Yes | Beta line |',
    '| 3 | gamma | No | Gamma line |',
  ].join('\n'))
})

test('the tool table numbers every tool and says which are deferred', () => {
  assert.match(toolsText(['Agent', 'WebFetch'], ['WebFetch'], 900), /^Can save 900 tokens by deferring tools until the model needs them:\n\n\| # \| Tool \| Deferred \|\n\| --- \| --- \| --- \|\n\| 1 \| Agent \| No \|\n\| 2 \| WebFetch \| Yes \|$/)
})

test('the header counts every skill in the table', () => {
  assert.equal(optimizing(22, 4226), '22 skills add 4,226 tokens on every request. Optimizing...\n\n')
  assert.equal(optimizing(1, undefined), '1 skill is listed. Optimizing...\n\n')
})

test('the first question is about skills when there are any, else tools', () => {
  const both = offered('k', { text: 'SKILLS TABLE', skills, lines, trimmed: [] }, proposal().tools)
  assert.ok(both.reply.endsWith(`Which skills should I trim?\n${PICK}`))
  assert.equal(both.next?.asking, 'skills')
  const toolsOnly = offered('k', { text: 'No skills found in this session.', skills: [], lines: {}, trimmed: [] }, proposal().tools)
  assert.ok(toolsOnly.reply.endsWith(`Which tools should I defer?\n${PICK}`))
  assert.equal(toolsOnly.next?.asking, 'tools')
  const neither = offered('k', { text: 'No skills found in this session.', skills: [], lines: {}, trimmed: [] }, 'No tools to defer.')
  assert.equal(neither.next, undefined)
})

test('a skill answer puts the lines picked in the policy, then asks about tools', () => {
  const before = file({ skill_list: [{ match: '*', action: 'keep' }] })
  const out = afterAnswer(proposal(), '1 3', before, '/p/policy.json')
  assert.deepEqual(rulesIn(out.text).skill_list, [stub(skills[0], 'Alpha line'), stub(skills[2], 'Gamma line'), { match: '*', action: 'keep' }])
  assert.equal(out.reply, 'Modified 2 skills in shaver policy file.\n/p/policy.json\n\nTOOLS TABLE\n\n' + `Which tools should I defer?\n${PICK}`)
  assert.equal(out.next?.asking, 'tools')
  assert.equal(out.next?.changed, 2)
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
    assert.equal(out.reply, `All numbers must be between 1 and 3. Ranges must be stated as X-Y, smaller number first.\n\nWhich skills should I trim?\n${PICK}`)
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

test('a tool answer writes tool rules in place of tools_not_deferred, and ends', () => {
  const before = file({ tools_not_deferred: ['Bash'] })
  const out = afterAnswer(proposal({ asking: 'tools', changed: 2 }), '2', before, '/p')
  assert.ok(!out.text.includes('tools_not_deferred'))
  const rules = rulesIn(out.text).tool_list!
  assert.deepEqual(rules.find((r) => r.name === 'Agent'), { name: 'Agent', defer: false })
  assert.deepEqual(rules.at(-1), { name: '*', defer: true })
  assert.equal(out.next, undefined)
  assert.match(out.reply, /\n\nRun \/clear in every claude\/codex\/opencode active session/)
})

test('the /clear advice shows only when something changed', () => {
  const out = afterAnswer(proposal({ asking: 'tools' }), 'keep', file({}), '/p')
  assert.equal(out.reply, 'Modified 0 tools in shaver policy file.\n/p')
})

test('with no tools to offer, the skill answer ends with why', () => {
  const out = afterAnswer(proposal({ tools: 'No tools to defer.' }), 'keep', file({}), '/p')
  assert.equal(out.reply, 'Modified 0 skills in shaver policy file.\n/p\n\nNo tools to defer.')
  assert.equal(out.next, undefined)
})

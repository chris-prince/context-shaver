import { test } from 'node:test'
import assert from 'node:assert/strict'
import { descriptionHash, keptWhole, LINE_WORDS, linesOf, shaveSkills, skillsOf, withLines, type SkillRule } from '../src/skills.ts'

const HEAD = 'The following skills are available for use with the Skill tool:\n\n'
const list = [
  '- init: Initialize a CLAUDE.md file.',
  '- claude-api: Reference for the Claude API. Covers models.\nTRIGGER — whenever the prompt names Claude.\nSKIP — when another provider is used.',
  '- artifact-design: Design guidance. Load first.',
  '- anthropic-skills:docs: docs (editable docs). Use for documents.',
].join('\n')
const request = () => ({ messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: [{ type: 'text', text: `env\n\n${HEAD}${list}\n\nmore` }] }] })
const textOf = (b: ReturnType<typeof request>) => (b.messages[1].content as { text: string }[])[0].text

test('each skill takes the first rule matching its name; one matching none is kept', () => {
  const b = request()
  const rules: SkillRule[] = [
    { match: 'claude-api', action: 'keep' },
    { match: 'artifact-*', action: 'drop' },
    { match: 'anthropic-skills:*', action: 'drop' },
    { match: 'claude-*', action: 'drop' },
    { match: 'i*', action: 'stub', sentences: 1 },
  ]
  const before = textOf(b).length
  const out = shaveSkills(b, rules)
  assert.equal(textOf(b), `env\n\n${HEAD}- init: Initialize a CLAUDE.md file.\n- claude-api: Reference for the Claude API. Covers models.\nTRIGGER — whenever the prompt names Claude.\nSKIP — when another provider is used.\n\nmore`)
  assert.equal(out, before - textOf(b).length)
})

test('a stub keeps the first sentences of a description, its later lines too', () => {
  const b = request()
  shaveSkills(b, [{ match: '*', action: 'stub', sentences: 1 }])
  assert.equal(textOf(b), `env\n\n${HEAD}- init: Initialize a CLAUDE.md file.\n- claude-api: Reference for the Claude API.\n- artifact-design: Design guidance.\n- anthropic-skills:docs: docs (editable docs).\n\nmore`)
})

test('with every skill dropped the heading goes too', () => {
  const b = request()
  shaveSkills(b, [{ match: '*', action: 'drop' }])
  assert.equal(textOf(b), 'env\n\nmore')
})

test('a list quoted outside a system message is left alone', () => {
  const b = request()
  b.messages[1].role = 'user'
  assert.equal(shaveSkills(b, [{ match: '*', action: 'drop' }]), 0)
  assert.equal(textOf(b), textOf(request()))
})

test("a written line stands in for the description it replaces, and only that one", () => {
  const skills = skillsOf(request())
  const init = skills.find((s) => s.name === 'init')!
  const api = skills.find((s) => s.name === 'claude-api')!
  const b = request()
  shaveSkills(b, [
    { match: 'init', action: 'stub', text: 'Make CLAUDE.md', replaces: descriptionHash(init.description) },
    { match: 'claude-api', action: 'stub', text: 'Claude API reference', replaces: descriptionHash('an older description') },
  ])
  assert.ok(textOf(b).includes('- init: Make CLAUDE.md\n'))
  assert.ok(textOf(b).includes(`- claude-api: ${api.description}\n`))
})

test('a written line no shorter than its description leaves the description', () => {
  const b = request()
  const { description } = skillsOf(b).find((s) => s.name === 'artifact-design')!
  shaveSkills(b, [{ match: 'artifact-design', action: 'stub', text: description + ' More.', replaces: descriptionHash(description) }])
  assert.equal(textOf(b), textOf(request()))
})

test('the skills listed are read whole, descriptions running over lines included', () => {
  assert.deepEqual(
    skillsOf(request()).map((s) => s.name),
    ['init', 'claude-api', 'artifact-design', 'anthropic-skills:docs'],
  )
  assert.equal(skillsOf(request())[1].description, 'Reference for the Claude API. Covers models.\nTRIGGER — whenever the prompt names Claude.\nSKIP — when another provider is used.')
})

test('lines are written for the skills kept whole, lines written before aside', () => {
  const skills = skillsOf(request())
  const rules: SkillRule[] = [
    { match: 'init', action: 'stub', text: 'old', replaces: 'x' },
    { match: 'claude-*', action: 'keep' },
    { match: 'artifact-*', action: 'drop' },
    { match: 'anthropic-*', action: 'stub', sentences: 1 },
  ]
  assert.deepEqual(keptWhole(skills, rules).map((s) => s.name), ['init', 'claude-api'])
})

test("an answer's lines count only for skills asked about, each a string of at most LINE_WORDS words", () => {
  const skills = skillsOf(request()).slice(0, 3)
  const long = Array(LINE_WORDS + 1).fill('word').join(' ')
  const answer = '```json\n' + JSON.stringify({ init: ' Set up project memory ', 'claude-api': long, 'artifact-design': 3, other: 'Not asked' }) + '\n```'
  assert.deepEqual(linesOf(answer, skills), { init: 'Set up project memory' })
  assert.deepEqual(linesOf('no JSON here', skills), {})
})

test('written lines go ahead of the other rules, in place of lines written before', () => {
  const skills = skillsOf(request())
  const rules: SkillRule[] = [{ match: 'claude-api', action: 'stub', text: 'old', replaces: 'x' }, { match: 'artifact-*', action: 'drop' }]
  const out = withLines(rules, skills, { init: 'Set up project memory' })
  assert.deepEqual(out, [{ match: 'init', action: 'stub', text: 'Set up project memory', replaces: descriptionHash(skills[0].description) }, { match: 'artifact-*', action: 'drop' }])
})

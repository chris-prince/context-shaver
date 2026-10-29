import { test } from 'node:test'
import assert from 'node:assert/strict'
import { descriptionHash, keptWhole, LINE_WORDS, lineOf, linesOf, listMessage, shaveSkills, skillsOf, withLines, type SkillRule } from '../src/skills.ts'

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
  assert.deepEqual(out, { cut: before - textOf(b).length, trimmed: 0 })
})

test('a stub keeps the first sentences of a description, its later lines too', () => {
  const b = request()
  const out = shaveSkills(b, [{ match: '*', action: 'stub', sentences: 1 }])
  assert.equal(textOf(b), `env\n\n${HEAD}- init: Initialize a CLAUDE.md file.\n- claude-api: Reference for the Claude API.\n- artifact-design: Design guidance.\n- anthropic-skills:docs: docs (editable docs).\n\nmore`)
  // Every entry but init's, unchanged, as JSON counts them.
  const shortened = ['- claude-api: Reference for the Claude API.', '- artifact-design: Design guidance.', '- anthropic-skills:docs: docs (editable docs).']
  assert.equal(out.trimmed, shortened.reduce((n, e) => n + JSON.stringify(e).length - 2, 0))
})

test('with every skill dropped the heading goes too', () => {
  const b = request()
  shaveSkills(b, [{ match: '*', action: 'drop' }])
  assert.equal(textOf(b), 'env\n\nmore')
})

test('a list quoted outside a system message is left alone', () => {
  const b = request()
  b.messages[1].role = 'user'
  assert.equal(shaveSkills(b, [{ match: '*', action: 'drop' }]).cut, 0)
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

test('a skill listed again later takes its later entry, and the base ends at the first list', () => {
  const b = request()
  b.messages.push({ role: 'user', content: 'go on' }, { role: 'system', content: [{ type: 'text', text: `# Environment update\n\n${HEAD}- init: Initialize a CLAUDE.md file, now faster.` }] })
  const skills = skillsOf(b)
  assert.deepEqual(skills.map((s) => s.name), ['init', 'claude-api', 'artifact-design', 'anthropic-skills:docs'])
  assert.equal(skills[0].description, 'Initialize a CLAUDE.md file, now faster.')
  assert.equal(listMessage(b), 1)
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

// Shaped like Codex's skills part, in its system.
const codex = () => ({
  messages: [{ role: 'user', content: 'hi' }],
  system: [
    { type: 'text', text: 'You are Codex.' },
    { type: 'text', text: '<skills_instructions>\n## Skills\nIntro.\n### Available skills\n- imagegen: Generate or edit images. (file: /s/imagegen/SKILL.md)\n- r2:update-pet: Update the pet (and its food). (file: r2/update-pet/SKILL.md)\n### How to use skills\n- Read the SKILL.md.\n</skills_instructions>' },
  ],
})

test("Codex's list is read and shortened in the system, each entry keeping where its SKILL.md is", () => {
  const b = codex()
  const skills = skillsOf(b)
  assert.deepEqual(skills, [
    { name: 'imagegen', description: 'Generate or edit images.' },
    { name: 'r2:update-pet', description: 'Update the pet (and its food).' },
  ])
  assert.equal(listMessage(b), -1)
  const out = shaveSkills(b, [
    { match: 'imagegen', action: 'stub', text: 'Make images', replaces: descriptionHash(skills[0].description) },
    { match: 'r2:*', action: 'drop' },
  ])
  assert.equal(out.trimmed, '- imagegen: Make images (file: /s/imagegen/SKILL.md)'.length)
  assert.equal(b.system[0].text, 'You are Codex.')
  assert.equal(b.system[1].text, '<skills_instructions>\n## Skills\nIntro.\n### Available skills\n- imagegen: Make images (file: /s/imagegen/SKILL.md)\n### How to use skills\n- Read the SKILL.md.\n</skills_instructions>')
})

test('written lines go ahead of the other rules, in place of lines written before', () => {
  const skills = skillsOf(request())
  const rules: SkillRule[] = [{ match: 'claude-api', action: 'stub', text: 'old', replaces: 'x' }, { match: 'artifact-*', action: 'drop' }]
  const out = withLines(rules, skills, { init: 'Set up project memory' })
  assert.deepEqual(out, [{ match: 'init', action: 'stub', text: 'Set up project memory', replaces: descriptionHash(skills[0].description) }, { match: 'artifact-*', action: 'drop' }])
  // A skill not among those given, trimmed already or listed elsewhere, keeps its line.
  assert.deepEqual(withLines(rules, skills.filter((s) => s.name === 'init'), { init: 'Set up project memory' }).slice(1), rules)
})

test("a skill's line counts as sent only while its rule is the first to match and the line is still its description's", () => {
  const [init] = skillsOf(request())
  const line: SkillRule = { match: 'init', action: 'stub', text: 'Set up project memory', replaces: descriptionHash(init.description) }
  assert.equal(lineOf(init, [line]), 'Set up project memory')
  assert.equal(lineOf(init, [{ match: 'in*', action: 'keep' }, line]), undefined)
  assert.equal(lineOf(init, [{ ...line, replaces: 'changed' }]), undefined)
  assert.equal(lineOf(init, []), undefined)
})

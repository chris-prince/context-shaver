import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shaveSkills, type SkillRule } from '../src/skills.ts'

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

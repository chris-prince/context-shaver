import assert from 'node:assert/strict'
import { test } from 'node:test'
import { kinds } from '../src/log.ts'
import type { ApiMsg } from '../src/trim.ts'

test('injected content is system in the preamble and harness after it; the prompt is user', () => {
  const reminder = { type: 'text', text: '<system-reminder>\nCLAUDE.md\n</system-reminder>' }
  const m: ApiMsg = { role: 'user', content: [reminder, { type: 'text', text: 'hello' }] }
  const json = JSON.stringify(m)
  const pre = kinds(json, m, true).kinds
  assert.equal(pre.system, JSON.stringify(reminder).length)
  assert.equal(pre.system + pre.user, json.length)
  const later = kinds(json, m).kinds
  assert.equal(later.harness, JSON.stringify(reminder).length)
  assert.equal(later.system, undefined)

  const env: ApiMsg = { role: 'system', content: '# Environment' }
  assert.deepEqual(kinds(JSON.stringify(env), env, true).kinds, { system: JSON.stringify(env).length })
  assert.deepEqual(kinds(JSON.stringify(env), env).kinds, { harness: JSON.stringify(env).length })
})

test('a skill body beside the Skill result counts as a tool result', () => {
  const m: ApiMsg = { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: 'Launching skill: x' },
    { type: 'text', text: 'Base directory for this skill: /x\n\n# X' },
  ] }
  const k = kinds(JSON.stringify(m), m).kinds
  assert.equal(k.toolResultsSkill, JSON.stringify(m.content[1]).length)
  assert.equal(k.toolResults, JSON.stringify(m.content[0]).length)
})

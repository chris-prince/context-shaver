import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { kinds, writeDefs } from '../src/log.ts'
import type { ApiMsg } from '../src/items.ts'

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

  // Tools surfaced mid-preamble come as non-text blocks; they are preamble too.
  const added = { role: 'system', content: [{ type: 'text', text: '# Environment' }, { type: 'tool_addition', tool: { name: 'Docs' } }] } as ApiMsg
  assert.deepEqual(kinds(JSON.stringify(added), added, true).kinds, { system: JSON.stringify(added).length })
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

test('system blocks and tool definitions are listed with their bytes, deferred tools marked', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'log-'))
  const tool = { name: 'Read', input_schema: {} }
  const later = { name: 'Artifact', input_schema: {}, defer_loading: true }
  const d = writeDefs(dir, { system: 'You are Claude Code.', tools: [tool, later] })
  assert.deepEqual(d.system.map((s) => s.bytes), [JSON.stringify({ type: 'text', text: 'You are Claude Code.' }).length])
  assert.deepEqual(d.tools.map(({ name, bytes, deferred }) => ({ name, bytes, deferred })), [
    { name: 'Read', bytes: JSON.stringify(tool).length, deferred: undefined },
    { name: 'Artifact', bytes: JSON.stringify(later).length, deferred: true },
  ])
  assert.equal(readFileSync(path.join(dir, 'parts', `${d.tools[1].hash}.json`), 'utf8'), JSON.stringify(later))
})

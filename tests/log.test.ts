import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { kinds, paramsOf, receivedOf, withReceivedDelta, writeDefs } from '../src/log.ts'
import type { ApiMsg } from '../src/items.ts'

test("after a Codex compaction, its preamble messages are base by section and the compaction is not", () => {
  const dev: ApiMsg = { role: 'system', content: [{ type: 'text', text: '<skills_instructions>\n## Skills\n- a: b\n</skills_instructions>' }] }
  const env: ApiMsg = { role: 'user', content: [{ type: 'text', text: '<environment_context>\n  <cwd>/w</cwd>\n</environment_context>' }] }
  const compaction: ApiMsg = { role: 'system', content: [{ type: 'item', item: { type: 'compaction', encrypted_content: 'e' } }] }
  assert.deepEqual(Object.keys(kinds(JSON.stringify(dev), dev, true).kinds), ['system:skills'])
  // A user message's envelope stays user, as with Claude Code's reminders.
  assert.deepEqual(Object.keys(kinds(JSON.stringify(env), env, true).kinds), ['system:other', 'user'])
  assert.deepEqual(Object.keys(kinds(JSON.stringify(compaction), compaction, true).kinds), ['harness'])
})

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
  assert.deepEqual(kinds(JSON.stringify(env), env, true).kinds, { 'system:other': JSON.stringify(env).length })
  assert.deepEqual(kinds(JSON.stringify(env), env).kinds, { harness: JSON.stringify(env).length })

  // Tools surfaced mid-preamble come as non-text blocks; they are preamble too.
  const tool = { type: 'tool_addition', tool: { name: 'Docs' } }
  const added = { role: 'system', content: [{ type: 'text', text: '# Environment' }, tool] } as ApiMsg
  const n = JSON.stringify(added).length
  assert.deepEqual(kinds(JSON.stringify(added), added, true).kinds, { 'system:other': n - JSON.stringify(tool).length, 'system:tools-deferred': JSON.stringify(tool).length })
})

test('preamble text is cut at its headings into sections', () => {
  const text = '<system-reminder>\n# Environment\nmacOS\nThe following skills are available:\n- a: b\nNot at a line start: Available agent types\nToday\'s date is 2026-10-13.'
  const m: ApiMsg = { role: 'system', content: [{ type: 'text', text }] }
  const json = JSON.stringify(m)
  const k = kinds(json, m, true).kinds
  assert.deepEqual(Object.keys(k).sort(), ['system:other', 'system:skills'])
  const skills = JSON.stringify('The following skills are available:\n- a: b\nNot at a line start: Available agent types\n').length - 2
  assert.equal(k['system:skills'], skills)
  assert.equal(k['system:other'] + k['system:skills'], json.length)
})

test('the memory index is cut out of the instructions reminder', () => {
  const memory = 'Contents of /Users/x/.claude/projects/p/memory/MEMORY.md (user\'s auto-memory):\n- [A](a.md) — b\n'
  const text = '<system-reminder>\nCodebase and user instructions are shown below.\nContents of /Users/x/AGENTS.md (project instructions):\nrules\n' + memory + '</system-reminder>'
  const m: ApiMsg = { role: 'user', content: [{ type: 'text', text }] }
  const json = JSON.stringify(m)
  const k = kinds(json, m, true).kinds
  assert.deepEqual(Object.keys(k).sort(), ['system:agents-md', 'system:memory', 'user'])
  assert.equal(k['system:memory'], JSON.stringify(memory + '</system-reminder>').length - 2)
  assert.equal(k['system:agents-md'] + k['system:memory'] + k.user, json.length)
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

test('params are what a request asked for, without its content, model or who asked', () => {
  const claude = { model: 'claude-opus-5-5', metadata: { user_id: 'u' }, system: [], tools: [], messages: [], max_tokens: 128000, thinking: { type: 'adaptive', display: 'omitted' }, output_config: { effort: 'medium' }, stream: true }
  assert.deepEqual(paramsOf(claude), { max_tokens: 128000, thinking: { type: 'adaptive', display: 'omitted' }, output_config: { effort: 'medium' }, stream: true })
  const codex = { model: 'gpt-6-luna', instructions: 'x', input: [], tools: [], client_metadata: {}, prompt_cache_key: 'k', reasoning: { effort: 'high' }, store: false }
  assert.deepEqual(paramsOf(codex), { reasoning: { effort: 'high' }, store: false })
  const opencode = { model: 'deepseek/deepseek-v4.1-flash', messages: [], tools: [], user: 'u', provider: { order: ['deepseek'] }, max_tokens: 32000 }
  assert.deepEqual(paramsOf(opencode), { provider: { order: ['deepseek'] }, max_tokens: 32000 })
})

test('received is logged as a change from the line before and read back whole', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'log-'))
  const parts = (...hs: string[]) => hs.map((hash) => ({ part: 'user', hash, bytes: 1 }))
  const lines = [
    withReceivedDelta(dir, { event: 'request', parts: parts('a', 'b') }),
    { event: 'compaction' },
    withReceivedDelta(dir, { event: 'request', parts: parts('a', 'x'), received: ['a', 'b', 'c'] }),
    withReceivedDelta(dir, { event: 'request', parts: parts('a', 'y'), received: ['a', 'b', 'd', 'e'] }),
  ]
  assert.deepEqual(lines[2].received, { keep: 2, add: ['c'] })
  assert.deepEqual(lines[3].received, { keep: 2, add: ['d', 'e'] })
  assert.deepEqual(receivedOf(lines), [['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'd', 'e']])
})

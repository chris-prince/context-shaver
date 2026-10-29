import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferrable, dropTools, forceDefer, offerable, withPicked, type ToolRule } from '../src/defer.ts'
import { toolRulesOf } from '../src/policy.ts'
import { RESPONSES } from '../src/responses.ts'

const HEAD = 'Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n'
const request = (env: string) => ({
  tools: [{ name: 'Bash' }, { name: 'ToolSearch' }, { name: 'Artifact' }, { name: 'WebFetch', defer_loading: true }],
  messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: [{ type: 'text', text: `env\n\nThe following deferred tools… ${HEAD}WebFetch\n\nmore` }] }].slice(0, env ? 2 : 1),
})
const keepBash: ToolRule[] = [{ name: 'Bash', action: 'keep' }, { name: '*', action: 'defer' }]
// Claude Code's core tools.
const core = ['Bash', 'Edit', 'Read', 'Write']

test('a tool the rules defer is deferred and listed with the others; ToolSearch never is', () => {
  const b = request('env')
  forceDefer(b, keepBash)
  assert.deepEqual(b.tools, [{ name: 'Bash' }, { name: 'ToolSearch' }, { name: 'Artifact', defer_loading: true }, { name: 'WebFetch', defer_loading: true }])
  assert.match((b.messages[1].content as { text: string }[])[0].text, /calling them:\nArtifact\nWebFetch\n\nmore$/)
})

test('each tool takes the first rule matching it, and one no rule matches is sent as it came', () => {
  const tools = ['Bash', 'BashOutput', 'Artifact', 'mcp__docs__read', 'mcp__docs__write'].map((name) => ({ name }))
  const rules: ToolRule[] = [{ name: 'mcp__docs__read', action: 'keep' }, { name: 'mcp__*', action: 'defer' }, { name: 'Bash*', action: 'defer' }, { name: 'Bash', action: 'keep' }]
  assert.deepEqual(deferrable({ tools }, rules), ['Bash', 'BashOutput', 'mcp__docs__write'])
})

test("each harness has its own tool rules; the older forms are Claude Code's, a tool_list winning over tools_not_deferred", () => {
  const lists = { tool_list: { claude: keepBash, codex: [{ name: '*', action: 'keep' }] } }
  assert.deepEqual(toolRulesOf(lists, 'claude'), keepBash)
  assert.deepEqual(toolRulesOf(lists, 'codex'), [{ name: '*', action: 'keep' }])
  assert.equal(toolRulesOf(lists, 'opencode'), undefined)
  assert.equal(toolRulesOf(lists, undefined), undefined)
  assert.deepEqual(toolRulesOf({ tools_not_deferred: ['Bash'] }, 'claude'), keepBash)
  assert.equal(toolRulesOf({ tools_not_deferred: ['Bash'] }, 'codex'), undefined)
  assert.deepEqual(toolRulesOf({ tool_list: keepBash }, 'claude'), keepBash)
  assert.equal(toolRulesOf({ tool_list: keepBash }, 'codex'), undefined)
  assert.deepEqual(toolRulesOf({ tools_not_deferred: ['Bash'], tool_list: [] }, 'claude'), [])
  assert.deepEqual(toolRulesOf({ tool_list: { claude: [{ name: 'Bash', defer: false }, { name: '*', defer: true }] } }, 'claude'), keepBash)
  assert.equal(toolRulesOf({}, 'claude'), undefined)
})

test('picked tools are deferred and the others shown kept, whatever the rules did before; the core tools stay loaded', () => {
  const tools = ['Bash', 'Edit', 'Read', 'Write', 'ToolSearch', 'Agent', 'Artifact', 'Skill', 'mcp__docs__read'].map((name) => ({ name }))
  const shown = ['Agent', 'Artifact', 'Skill', 'mcp__docs__read']
  const before: ToolRule[] = [{ name: 'Agent', action: 'defer' }, { name: 'mcp__*', action: 'keep' }, { name: 'Bash', action: 'defer' }, { name: '*', action: 'defer' }]
  for (const picked of [[], ['Artifact'], ['Agent', 'mcp__docs__read'], shown]) {
    const rules = withPicked(before, shown, new Set(picked), core, 'defer')
    // A hand rule placing a core tool stays; the other core tools are kept.
    assert.deepEqual(deferrable({ tools }, rules), tools.map((t) => t.name).filter((n) => n === 'Bash' || picked.includes(n)))
  }
  assert.ok(!withPicked(before, shown, new Set(), core, 'defer').some((r) => r.name === '*'))
})

test('picked tools are dropped by name, never by a catch-all, and those always loaded are never dropped', () => {
  const tools = ['functions.exec', 'functions.wait', 'clock.sleep', 'web.run', 'collaboration.ask'].map((name) => ({ type: 'function', name }))
  const rules = withPicked([{ name: 'web.run', action: 'drop' }], ['clock.sleep', 'web.run', 'collaboration.ask'], new Set(['clock.sleep']), [], 'drop')
  assert.ok(!rules.some((r) => r.name === '*'))
  const body = { tools: structuredClone(tools) }
  // A hand-written catch-all drops none always loaded.
  assert.equal(dropTools(body, [...rules, { name: '*', action: 'drop' }]), JSON.stringify(tools[2]).length)
  assert.deepEqual(body.tools.map((t) => t.name), ['functions.exec', 'functions.wait', 'web.run', 'collaboration.ask'])
})

test('the tools offered are those sent in full, but ToolSearch and the core ones', () => {
  const tools = [{ name: 'Bash' }, { name: 'ToolSearch' }, { name: 'Agent' }, { name: 'WebFetch', defer_loading: true }]
  assert.deepEqual(offerable({ tools }, core), ['Agent'])
})

test('with no list in a system message, nothing is deferred, even if the conversation quotes one', () => {
  const b = request('')
  b.messages.push({ role: 'assistant', content: [{ type: 'text', text: `It reads: ${HEAD}Agent` }] })
  forceDefer(b, keepBash)
  assert.deepEqual(b.tools, request('').tools)
  assert.equal(b.messages.length, 2)
})

test('with tool search off, nothing is deferred', () => {
  const b = request('')
  b.tools = b.tools.filter((t) => t.name !== 'ToolSearch')
  forceDefer(b, [{ name: '*', action: 'defer' }])
  assert.deepEqual(b.tools, request('').tools.filter((t) => t.name !== 'ToolSearch'))
  assert.equal(b.messages.length, 1)
})

test('Responses defers selected tools and adds the backend\'s tool search without a Claude system message; exec and wait never are', () => {
  const b = { tools: [{ name: 'functions.exec' }, { name: 'functions.wait' }, { name: 'clock.sleep' }, { name: 'collaboration.spawn_agent' }] }
  assert.deepEqual(offerable(b, []), ['clock.sleep', 'collaboration.spawn_agent'])
  const bytes = forceDefer(b, [{ name: '*', action: 'defer' }], RESPONSES.searchTool)
  assert.equal(bytes, JSON.stringify({ name: 'clock.sleep' }).length + JSON.stringify({ name: 'collaboration.spawn_agent' }).length)
  assert.deepEqual(b.tools, [
    { name: 'functions.exec' },
    { name: 'functions.wait' },
    { name: 'clock.sleep', defer_loading: true },
    { name: 'collaboration.spawn_agent', defer_loading: true },
    { type: 'tool_search' },
  ])
})

test('Responses defers nothing when the client sends a tool search of its own, which finds only its own deferred tools', () => {
  const search = { type: 'tool_search', execution: 'client' }
  const b = { tools: [{ name: 'clock.sleep' }, search] }
  assert.equal(forceDefer(b, [{ name: '*', action: 'defer' }], RESPONSES.searchTool), 0)
  assert.deepEqual(b.tools, [{ name: 'clock.sleep' }, search])
})

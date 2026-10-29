import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferrable, dropTools, forceDefer, offerable, withPicked, type ToolRule } from '../src/defer.ts'
import { toolRulesOf, upgraded } from '../src/policy.ts'
import { RESPONSES } from '../src/responses.ts'
import { harnessOf, type Harness } from '../src/harness.ts'

const CLAUDE = (harnessOf('claude', {}) as Harness).alwaysLoaded
const CODEX = (harnessOf('codex', {}) as Harness).alwaysLoaded

const HEAD = 'Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n'
const request = (env: string) => ({
  tools: [{ name: 'Bash' }, { name: 'ToolSearch' }, { name: 'Artifact' }, { name: 'WebFetch', defer_loading: true }],
  messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: [{ type: 'text', text: `env\n\nThe following deferred tools… ${HEAD}WebFetch\n\nmore` }] }].slice(0, env ? 2 : 1),
})
const keepBash: ToolRule[] = [{ name: 'Bash', action: 'keep' }, { name: '*', action: 'defer' }]

test('a tool the rules defer is deferred and listed with the others; ToolSearch never is', () => {
  const b = request('env')
  forceDefer(b, keepBash, CLAUDE)
  assert.deepEqual(b.tools, [{ name: 'Bash' }, { name: 'ToolSearch' }, { name: 'Artifact', defer_loading: true }, { name: 'WebFetch', defer_loading: true }])
  assert.match((b.messages[1].content as { text: string }[])[0].text, /calling them:\nArtifact\nWebFetch\n\nmore$/)
})

test('each tool takes the first rule matching it, and one no rule matches is sent as it came', () => {
  const tools = ['Web', 'WebFetch', 'Artifact', 'mcp__docs__read', 'mcp__docs__write'].map((name) => ({ name }))
  const rules: ToolRule[] = [{ name: 'mcp__docs__read', action: 'keep' }, { name: 'mcp__*', action: 'defer' }, { name: 'Web*', action: 'defer' }, { name: 'Web', action: 'keep' }]
  assert.deepEqual(deferrable({ tools }, rules, CLAUDE), ['Web', 'WebFetch', 'mcp__docs__write'])
})

test("each harness has its own tool rules; the older forms are Claude Code's, a tool_list winning over tools_not_deferred", () => {
  const lists = { tool_shaver_rules: { claude: keepBash, codex: [{ name: '*', action: 'keep' as const }] } }
  assert.deepEqual(toolRulesOf(lists, 'claude'), keepBash)
  assert.deepEqual(toolRulesOf(lists, 'codex'), [{ name: '*', action: 'keep' }])
  assert.equal(toolRulesOf(lists, 'opencode'), undefined)
  assert.equal(toolRulesOf(lists, undefined), undefined)
  assert.equal(toolRulesOf({}, 'claude'), undefined)
  const now = (v: Record<string, unknown>) => upgraded(v)?.tool_shaver_rules
  assert.deepEqual(now({ tools_not_deferred: ['Bash'] }), { claude: keepBash })
  assert.deepEqual(now({ tool_list: keepBash }), { claude: keepBash })
  assert.deepEqual(now({ tools_not_deferred: ['Bash'], tool_list: [] }), { claude: [] })
  assert.deepEqual(now({ tool_list: { claude: [{ name: 'Bash', defer: false }, { name: '*', defer: true }], codex: [] } }), { claude: keepBash, codex: [] })
})

test("picked tools are deferred and the others shown kept, whatever the rules did before; Claude Code's Bash, Edit, Read, Write and Skill stay loaded, even if a rule defers them", () => {
  const tools = ['Bash', 'Edit', 'Read', 'Write', 'Skill', 'ToolSearch', 'Agent', 'Artifact', 'mcp__docs__read'].map((name) => ({ name }))
  const shown = ['Agent', 'Artifact', 'mcp__docs__read']
  const before: ToolRule[] = [{ name: 'Agent', action: 'defer' }, { name: 'mcp__*', action: 'keep' }, { name: 'Bash', action: 'defer' }, { name: 'Skill', action: 'defer' }, { name: '*', action: 'defer' }]
  for (const picked of [[], ['Artifact'], ['Agent', 'mcp__docs__read'], shown]) {
    const rules = withPicked(before, shown, new Set(picked), 'defer', CLAUDE)
    assert.deepEqual(deferrable({ tools }, rules, CLAUDE), tools.map((t) => t.name).filter((n) => picked.includes(n)))
  }
  assert.ok(!withPicked(before, shown, new Set(), 'defer', CLAUDE).some((r) => r.name === '*'))
})

test('picking drops the rules for tools always loaded, which do nothing, and keeps the others', () => {
  const before: ToolRule[] = ['Bash', 'Edit', 'Read', 'Write', 'ToolSearch', 'Skill'].map((name) => ({ name, action: 'keep' as const }))
  const rules = withPicked([...before, { name: 'mcp__*', action: 'keep' }], ['Agent'], new Set(['Agent']), 'defer', CLAUDE)
  assert.deepEqual(rules, [{ name: 'mcp__*', action: 'keep' }, { name: '*', action: 'defer' }])
})

test('picked tools are dropped by name, never by a catch-all, and those always loaded are never dropped', () => {
  const tools = ['functions.exec', 'functions.wait', 'clock.sleep', 'web.run', 'collaboration.ask'].map((name) => ({ type: 'function', name }))
  const rules = withPicked([{ name: 'web.run', action: 'drop' }], ['clock.sleep', 'web.run', 'collaboration.ask'], new Set(['clock.sleep']), 'drop', CODEX)
  assert.ok(!rules.some((r) => r.name === '*'))
  const body = { tools: structuredClone(tools) }
  // A hand-written catch-all drops none always loaded.
  assert.equal(dropTools(body, [...rules, { name: '*', action: 'drop' }], CODEX), JSON.stringify(tools[2]).length)
  assert.deepEqual(body.tools.map((t) => t.name), ['functions.exec', 'functions.wait', 'web.run', 'collaboration.ask'])
})

test('the tools offered are those sent in full, but those always loaded', () => {
  const tools = [{ name: 'Bash' }, { name: 'ToolSearch' }, { name: 'Skill' }, { name: 'Agent' }, { name: 'WebFetch', defer_loading: true }]
  assert.deepEqual(offerable({ tools }, CLAUDE), ['Agent'])
})

test("each harness keeps only its own tools loaded: one with another's tool name can defer it", () => {
  const tools = [{ name: 'Skill' }, { name: 'functions.exec' }]
  assert.deepEqual(offerable({ tools }, CLAUDE), ['functions.exec'])
  assert.deepEqual(offerable({ tools }, CODEX), ['Skill'])
})

test('with no list in a system message, nothing is deferred, even if the conversation quotes one', () => {
  const b = request('')
  b.messages.push({ role: 'assistant', content: [{ type: 'text', text: `It reads: ${HEAD}Agent` }] })
  forceDefer(b, keepBash, CLAUDE)
  assert.deepEqual(b.tools, request('').tools)
  assert.equal(b.messages.length, 2)
})

test('with tool search off, nothing is deferred', () => {
  const b = request('')
  b.tools = b.tools.filter((t) => t.name !== 'ToolSearch')
  forceDefer(b, [{ name: '*', action: 'defer' }], CLAUDE)
  assert.deepEqual(b.tools, request('').tools.filter((t) => t.name !== 'ToolSearch'))
  assert.equal(b.messages.length, 1)
})

test('with the list sent but no ToolSearch to load from it, nothing is deferred', () => {
  const b = request('env')
  b.tools = b.tools.filter((t) => t.name !== 'ToolSearch')
  const before = structuredClone(b)
  assert.equal(forceDefer(b, [{ name: '*', action: 'defer' }], CLAUDE), 0)
  assert.deepEqual(b, before)
})

test('Responses defers selected tools and adds the backend\'s tool search without a Claude system message; exec and wait never are', () => {
  const b = { tools: [{ name: 'functions.exec' }, { name: 'functions.wait' }, { name: 'clock.sleep' }, { name: 'collaboration.spawn_agent' }] }
  assert.deepEqual(offerable(b, CODEX), ['clock.sleep', 'collaboration.spawn_agent'])
  const bytes = forceDefer(b, [{ name: '*', action: 'defer' }], CODEX, RESPONSES.searchTool)
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
  assert.equal(forceDefer(b, [{ name: '*', action: 'defer' }], CODEX, RESPONSES.searchTool), 0)
  assert.deepEqual(b.tools, [{ name: 'clock.sleep' }, search])
})

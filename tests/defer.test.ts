import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferrable, forceDefer, offerable, withDeferred, type ToolRule } from '../src/defer.ts'
import { toolRulesOf } from '../src/policy.ts'
import { RESPONSES } from '../src/responses.ts'

const HEAD = 'Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n'
const request = (env: string) => ({
  tools: [{ name: 'Bash' }, { name: 'ToolSearch' }, { name: 'Artifact' }, { name: 'WebFetch', defer_loading: true }],
  messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: [{ type: 'text', text: `env\n\nThe following deferred tools… ${HEAD}WebFetch\n\nmore` }] }].slice(0, env ? 2 : 1),
})
const keepBash: ToolRule[] = [{ name: 'Bash', defer: false }, { name: '*', defer: true }]

test('a tool the rules defer is deferred and listed with the others; ToolSearch never is', () => {
  const b = request('env')
  forceDefer(b, keepBash)
  assert.deepEqual(b.tools, [{ name: 'Bash' }, { name: 'ToolSearch' }, { name: 'Artifact', defer_loading: true }, { name: 'WebFetch', defer_loading: true }])
  assert.match((b.messages[1].content as { text: string }[])[0].text, /calling them:\nArtifact\nWebFetch\n\nmore$/)
})

test('each tool takes the first rule matching it, and one no rule matches is sent as it came', () => {
  const tools = ['Bash', 'BashOutput', 'Artifact', 'mcp__docs__read', 'mcp__docs__write'].map((name) => ({ name }))
  const rules: ToolRule[] = [{ name: 'mcp__docs__read', defer: false }, { name: 'mcp__*', defer: true }, { name: 'Bash*', defer: true }, { name: 'Bash', defer: false }]
  assert.deepEqual(deferrable({ tools }, rules), ['Bash', 'BashOutput', 'mcp__docs__write'])
})

test('tools_not_deferred reads as rules keeping its tools, then deferring every other; a tool_list wins over it', () => {
  assert.deepEqual(toolRulesOf({ tools_not_deferred: ['Bash'] }), keepBash)
  assert.deepEqual(toolRulesOf({ tools_not_deferred: ['Bash'], tool_list: [] }), [])
  assert.equal(toolRulesOf({}), undefined)
})

test('picked tools are deferred and the others shown kept, whatever the rules did before; the core tools stay loaded', () => {
  const tools = ['Bash', 'Edit', 'Read', 'Write', 'ToolSearch', 'Agent', 'Artifact', 'Skill', 'mcp__docs__read'].map((name) => ({ name }))
  const shown = ['Agent', 'Artifact', 'Skill', 'mcp__docs__read']
  const before: ToolRule[] = [{ name: 'Agent', defer: true }, { name: 'mcp__*', defer: false }, { name: 'Bash', defer: true }, { name: '*', defer: true }]
  for (const picked of [[], ['Artifact'], ['Agent', 'mcp__docs__read'], shown]) {
    const rules = withDeferred(before, shown, new Set(picked))
    // A hand rule placing a core tool stays; the other core tools are kept.
    assert.deepEqual(deferrable({ tools }, rules), tools.map((t) => t.name).filter((n) => n === 'Bash' || picked.includes(n)))
  }
  assert.ok(!withDeferred(before, shown, new Set()).some((r) => r.name === '*'))
})

test('the tools offered are those sent in full, but ToolSearch and the core ones', () => {
  const tools = [{ name: 'Bash' }, { name: 'ToolSearch' }, { name: 'Agent' }, { name: 'WebFetch', defer_loading: true }]
  assert.deepEqual(offerable({ tools }), ['Agent'])
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
  forceDefer(b, [{ name: '*', defer: true }])
  assert.deepEqual(b.tools, request('').tools.filter((t) => t.name !== 'ToolSearch'))
  assert.equal(b.messages.length, 1)
})

test('Responses defers selected tools and adds client tool search without a Claude system message; exec and wait never are', () => {
  const b = { tools: [{ name: 'functions.exec' }, { name: 'functions.wait' }, { name: 'clock.sleep' }, { name: 'collaboration.spawn_agent' }] }
  assert.deepEqual(offerable(b), ['clock.sleep', 'collaboration.spawn_agent'])
  const bytes = forceDefer(b, [{ name: '*', defer: true }], RESPONSES.searchTool)
  assert.equal(bytes, JSON.stringify({ name: 'clock.sleep' }).length + JSON.stringify({ name: 'collaboration.spawn_agent' }).length)
  assert.deepEqual(b.tools, [
    { name: 'functions.exec' },
    { name: 'functions.wait' },
    { name: 'clock.sleep', defer_loading: true },
    { name: 'collaboration.spawn_agent', defer_loading: true },
    {
      type: 'tool_search', execution: 'client', description: 'Find tools to use for the current task.',
      parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'], additionalProperties: false },
    },
  ])
})

test('Responses leaves an existing client tool_search definition alone and never defers it', () => {
  const search = { type: 'tool_search', execution: 'client' }
  const b = { tools: [{ name: 'clock.sleep' }, search] }
  forceDefer(b, [{ name: '*', defer: true }], RESPONSES.searchTool)
  assert.deepEqual(b.tools, [{ name: 'clock.sleep', defer_loading: true }, search])
})

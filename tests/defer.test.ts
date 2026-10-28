import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferrable, deferringAll, forceDefer, type ToolRule } from '../src/defer.ts'
import { toolRulesOf } from '../src/policy.ts'

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

test('deferring all keeps the core tools no rule places, and leaves rules with a catch-all as they are', () => {
  assert.deepEqual(deferringAll([{ name: 'Edit', defer: true }]), [{ name: 'Edit', defer: true }, ...['Bash', 'Read', 'Write'].map((name) => ({ name, defer: false })), { name: '*', defer: true }])
  assert.deepEqual(deferringAll(keepBash), keepBash)
  assert.deepEqual(deferringAll([{ name: '*', defer: false }]), [{ name: '*', defer: false }])
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

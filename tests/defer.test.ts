import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forceDefer } from '../src/defer.ts'

const HEAD = 'Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n'
const request = (env: string) => ({
  tools: [{ name: 'Bash' }, { name: 'ToolSearch' }, { name: 'Artifact' }, { name: 'WebFetch', defer_loading: true }],
  messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: [{ type: 'text', text: `env\n\nThe following deferred tools… ${HEAD}WebFetch\n\nmore` }] }].slice(0, env ? 2 : 1),
})

test('a tool not kept is deferred and listed with the others; ToolSearch never is', () => {
  const b = request('env')
  forceDefer(b, ['Bash', 'Missing'])
  assert.deepEqual(b.tools, [{ name: 'Bash' }, { name: 'ToolSearch' }, { name: 'Artifact', defer_loading: true }, { name: 'WebFetch', defer_loading: true }])
  assert.match((b.messages[1].content as { text: string }[])[0].text, /calling them:\nArtifact\nWebFetch\n\nmore$/)
})

test('with no list in a system message, nothing is deferred, even if the conversation quotes one', () => {
  const b = request('')
  b.messages.push({ role: 'assistant', content: [{ type: 'text', text: `It reads: ${HEAD}Agent` }] })
  forceDefer(b, ['Bash'])
  assert.deepEqual(b.tools, request('').tools)
  assert.equal(b.messages.length, 2)
})

test('with tool search off, nothing is deferred', () => {
  const b = request('')
  b.tools = b.tools.filter((t) => t.name !== 'ToolSearch')
  forceDefer(b, [])
  assert.deepEqual(b.tools, request('').tools.filter((t) => t.name !== 'ToolSearch'))
  assert.equal(b.messages.length, 1)
})

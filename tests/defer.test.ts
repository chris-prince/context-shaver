import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forceDefer } from '../src/defer.ts'

const HEAD = 'Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n'
const request = (env: string) => ({
  tools: [{ name: 'Bash' }, { name: 'Artifact' }, { name: 'WebFetch', defer_loading: true }],
  messages: [{ content: 'hi' }, { content: [{ type: 'text', text: `env\n\nThe following deferred tools… ${HEAD}WebFetch\n\nmore` }] }].slice(0, env ? 2 : 1),
})

test('a forced tool is deferred and listed with the others', () => {
  const b = request('env')
  forceDefer(b, ['Artifact', 'WebFetch', 'Missing'])
  assert.deepEqual(b.tools, [{ name: 'Bash' }, { name: 'Artifact', defer_loading: true }, { name: 'WebFetch', defer_loading: true }])
  assert.match((b.messages[1].content as { text: string }[])[0].text, /calling them:\nArtifact\nWebFetch\n\nmore$/)
})

test('with tool search off, nothing is deferred', () => {
  const b = request('')
  forceDefer(b, ['Artifact'])
  assert.deepEqual(b.tools, request('').tools)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localHost, route } from '../src/via.ts'

const API = 'https://api.anthropic.com'
const via = (base: string, rest: string) => `/via/${encodeURIComponent(base)}${rest}`

test('a /via/ path names its upstream and is stripped', () => {
  assert.deepEqual(route(via('http://localhost:9000', '/v1/messages?beta=true'), API), { upstream: 'http://localhost:9000', url: '/v1/messages?beta=true' })
  assert.deepEqual(route(via('https://llm.corp.example.com', '/v1/models'), API), { upstream: 'https://llm.corp.example.com', url: '/v1/models' })
  assert.deepEqual(route(via('http://localhost:9000', ''), API), { upstream: 'http://localhost:9000', url: '/' })
})

test("an upstream's own path is kept, less a trailing slash", () => {
  assert.deepEqual(route(via('https://gw.example.com/anthropic/', '/v1/messages'), API), { upstream: 'https://gw.example.com/anthropic', url: '/v1/messages' })
})

test('any other path goes to the fallback as it came', () => {
  assert.deepEqual(route('/v1/messages', API), { upstream: API, url: '/v1/messages' })
  assert.deepEqual(route('/shaver/shutdown', API), { upstream: API, url: '/shaver/shutdown' })
})

test('a bad /via/ upstream is an error, never the fallback', () => {
  for (const u of ['/via/localhost:9000/v1/messages', '/via//v1/messages', '/via/%E0%A4%A/v1/messages', via('file:///etc/passwd', '/x'), via('https://u:p@gw.example.com', '/x'), via('https://gw.example.com?a=1', '/x')])
    assert.ok('error' in route(u, API), u)
})

test("only this machine's Host is served", () => {
  for (const h of ['127.0.0.1:8787', 'localhost:8787', 'LOCALHOST', '127.0.0.1']) assert.ok(localHost(h), h)
  for (const h of [undefined, '', 'evil.com:8787', 'localhost.evil.com:8787', '127.0.0.1.evil.com', '10.0.0.1:8787', 'localhost:8787@evil.com']) assert.ok(!localHost(h), String(h))
})

test('a /harness/ path names its harness and is stripped, before any /via/', () => {
  assert.deepEqual(route('/harness/codex/v1/responses', API), { upstream: API, url: '/v1/responses', harness: 'codex' })
  assert.deepEqual(route(`/harness/opencode${via('https://openrouter.ai/api/v1', '/chat/completions')}`, API), { upstream: 'https://openrouter.ai/api/v1', url: '/chat/completions', harness: 'opencode' })
})

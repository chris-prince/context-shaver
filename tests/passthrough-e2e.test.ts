// SHAVER_MODE=passthrough, end to end: each request reaches the upstream byte
// for byte as the client sent it, compressed or not, and only once, refused or
// not; its answer comes back as the upstream sent it; a `shaver` command goes
// to the API unanswered; the policy file and the state are left alone; and
// with logging each request has a `passthrough` line with its usage. The
// policy would drop the tool result and is in a format a shaving proxy
// rewrites on start, so either would show.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const ROOT = path.join(import.meta.dirname, '..')

type Got = { body: Buffer; headers: IncomingHttpHeaders }
async function upstream() {
  const got: Got[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      got.push({ body, headers: req.headers })
      if (body.includes('REFUSE')) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'refused for the test' } }))
      }
      const usage = { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      event('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], usage } })
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'from upstream' } })
      event('content_block_stop', { index: 0 })
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
      event('message_stop', {})
      res.end()
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, got, close: () => server.close() }
}

function start(up: string, dir: string, policy: string, mode: string): { child: ChildProcess; url: Promise<string>; exit: Promise<{ code: number | null; err: string }> } {
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.ts'), '--port', '0', '--upstream', up, '--dir', dir, '--policy', policy, '--log-step-events'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, SHAVER_MODE: mode } })
  let err = ''
  const url = new Promise<string>((ok) => child.stderr!.on('data', (c) => {
    err += c
    const m = err.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
    if (m) ok(m[1])
  }))
  const exit = new Promise<{ code: number | null; err: string }>((ok) => child.on('exit', (code) => ok({ code, err })))
  return { child, url, exit }
}

// A policy in the format before eligible_after, which loading upgrades and writes back.
const OLD_POLICY = JSON.stringify({ conversation_shaver_rules: { tool: [{ action: 'drop', after: '1 request' }] }, tool_shaver_rules: { claude: [] }, skill_shaver_rules: [] }, null, 1)

const body = (last: string, extra = {}) => Buffer.from(JSON.stringify({
  model: 'claude-opus-5-5', max_tokens: 10, stream: true, system: 'sys', ...extra,
  tools: [{ name: 'Read', description: 'reads', input_schema: { type: 'object' } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'start' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x'.repeat(40_000) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'read it' }] },
    { role: 'user', content: [{ type: 'text', text: last }] },
  ],
}))

test('passthrough sends each request on unmodified, once, and logs it', async () => {
  const up = await upstream()
  const dir = mkdtempSync(path.join(tmpdir(), 'passthrough-e2e-'))
  const policy = path.join(dir, 'policy.json')
  writeFileSync(policy, OLD_POLICY)
  const p = start(up.url, dir, policy, 'passthrough')
  try {
    const url = await p.url
    const send = (b: Buffer, headers: Record<string, string> = {}) =>
      fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'pt-test', ...headers }, body: b })

    const plain = body('go on')
    const r1 = await send(plain)
    assert.equal(r1.status, 200)
    assert.match(await r1.text(), /from upstream/)

    // A command goes to the API as typed; the answer is the API's.
    const info = body(':shaver info')
    const r2 = await (await send(info)).text()
    assert.match(r2, /from upstream/)
    assert.doesNotMatch(r2, /Shaver Version/)

    // A refused request is sent once, and its refusal passed back.
    const refused = body('REFUSE this')
    const r3 = await send(refused)
    assert.equal(r3.status, 400)
    assert.match(await r3.text(), /refused for the test/)

    // A compressed body goes on compressed, with its encoding.
    const zipped = zstdCompressSync(body('zipped'))
    assert.equal((await send(zipped, { 'content-encoding': 'zstd' })).status, 200)

    assert.equal(up.got.length, 4)
    assert.deepEqual(up.got.map((g) => g.body), [plain, info, refused, zipped])
    assert.equal(up.got[3].headers['content-encoding'], 'zstd')
    assert.equal(up.got[0].headers['x-claude-code-session-id'], 'pt-test')
    assert.ok(!up.got.some((g) => g.body.includes('cache_control')))

    assert.equal(readFileSync(policy, 'utf8'), OLD_POLICY)
    assert.deepEqual(readdirSync(path.join(dir, 'state')), [])

    const logs = path.join(dir, 'logs')
    const lines = readdirSync(logs).flatMap((d) => readFileSync(path.join(logs, d, 'step_events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)))
    assert.deepEqual(lines.map((l) => l.event), ['passthrough', 'passthrough', 'passthrough', 'passthrough'])
    const ok = lines.filter((l) => l.status === 200)
    assert.equal(ok.length, 3)
    for (const l of ok) assert.deepEqual([l.inputTokens, l.cachedTokens, l.outputTokens], [127, 100, 1])
    assert.equal(lines.find((l) => l.status === 400).error.includes('refused for the test'), true)
    assert.equal(lines[0].messages.length, 5)
  } finally {
    p.child.kill()
    up.close()
  }
})

test('an unknown SHAVER_MODE stops the proxy at start', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'passthrough-e2e-'))
  const p = start('http://127.0.0.1:9', dir, path.join(dir, 'none.json'), 'passthru')
  const { code, err } = await p.exit
  assert.equal(code, 1)
  assert.match(err, /SHAVER_MODE is "passthru"/)
})

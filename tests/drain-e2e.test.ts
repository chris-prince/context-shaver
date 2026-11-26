// A drain (bin/run-proxy --when-idle), end to end: a reply streaming when it's
// asked for streams to its end, a request after it is turned away to be
// retried (503, Retry-After: 5) without reaching the upstream, and the proxy
// exits once the reply has ended and been journaled, starting no summary fork.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')

test('a drain lets the reply streaming finish, turns new requests away to retry, then exits', async (t) => {
  // An upstream that starts each reply and holds it open.
  const replies: ServerResponse[] = []
  let reached!: () => void
  const first = new Promise<void>((ok) => (reached = ok))
  const up = createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
    replies.push(res)
    reached()
  })
  await new Promise<void>((ok) => up.listen(0, '127.0.0.1', ok))
  t.after(() => up.close())

  const dir = mkdtempSync(path.join(tmpdir(), 'drain-'))
  const policy = path.join(dir, 'policy.json')
  copyFileSync(path.join(ROOT, 'policy.default.json'), policy)
  const upstream = `http://127.0.0.1:${(up.address() as { port: number }).port}`
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.ts'), '--port', '0', '--upstream', upstream, '--dir', dir, '--policy', policy], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, SHAVER_MODE: 'passthrough' } })
  t.after(() => child.kill())
  let exited = false
  const exit = new Promise<number | null>((ok) => child.on('exit', (code) => ((exited = true), ok(code))))
  let err = ''
  const base = await new Promise<string>((ok) => child.stderr!.on('data', (c) => {
    err += c
    const m = err.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
    if (m) ok(m[1])
  }))

  const ask = () => fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 1, stream: true, messages: [{ role: 'user', content: 'hi' }] }) })
  const streaming = ask()
  await first
  const asked = await fetch(`${base}/shaver/shutdown`, { method: 'POST', headers: { 'x-shaver': 'drain' } })
  assert.equal(await asked.text(), 'draining\n')

  const turned = await ask()
  assert.equal(turned.status, 503)
  assert.equal(turned.headers.get('retry-after'), '5')
  await turned.text()
  assert.equal(replies.length, 1)
  await new Promise((ok) => setTimeout(ok, 300))
  assert.equal(exited, false)

  replies[0].end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  assert.match(await (await streaming).text(), /message_stop/)
  assert.equal(await exit, 0)
})

// A client that leaves mid-reply while draining: the proxy finishes with the
// request (state saved, request journaled) before it exits, not at the close.
test('a request whose client left while draining is journaled before the proxy exits', async (t) => {
  let reached!: () => void
  const first = new Promise<void>((ok) => (reached = ok))
  const up = createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"usage":{"input_tokens":100,"output_tokens":1}}}\n\n')
    reached()
  })
  await new Promise<void>((ok) => up.listen(0, '127.0.0.1', ok))
  t.after(() => up.close())

  const dir = mkdtempSync(path.join(tmpdir(), 'drain-'))
  const policy = path.join(dir, 'policy.json')
  writeFileSync(policy, JSON.stringify({
    conversation_shaver_rules: { user_and_assistant_text: { summary_threshold_tokens: 1e9, memoir_threshold_tokens: 1e9 } },
    tool_shaver_rules: { claude: [] },
    skill_shaver_rules: [],
  }))
  const upstream = `http://127.0.0.1:${(up.address() as { port: number }).port}`
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.ts'), '--port', '0', '--upstream', upstream, '--dir', dir, '--policy', policy, '--log-step-events'], { stdio: ['ignore', 'ignore', 'pipe'] })
  t.after(() => child.kill())
  const exit = new Promise<number | null>((ok) => child.on('exit', ok))
  let err = ''
  const base = await new Promise<string>((ok) => child.stderr!.on('data', (c) => {
    err += c
    const m = err.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
    if (m) ok(m[1])
  }))

  const left = new AbortController()
  const streaming = fetch(`${base}/v1/messages`, {
    method: 'POST', signal: left.signal, headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 's1' },
    body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, stream: true, metadata: { user_id: JSON.stringify({ session_id: 's1' }) }, system: [{ type: 'text', text: 'You are Claude Code.' }], tools: [{ name: 'Read', description: 'Reads a file.', input_schema: { type: 'object', properties: {} } }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }] }),
  })
  await first
  await (await streaming).body!.getReader().read()
  await fetch(`${base}/shaver/shutdown`, { method: 'POST', headers: { 'x-shaver': 'drain' } })
  left.abort()
  assert.equal(await exit, 0)

  const [key] = readdirSync(path.join(dir, 'logs'))
  const lines = readFileSync(path.join(dir, 'logs', key, 'step_events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(lines.filter((l) => l.event === 'request').length, 1)
})

// A summary fork due on a reply answered while draining isn't started: the
// request's line says why, the upstream is never asked, and the proxy exits.
test('a drain starts no summary fork, and says so in the request line', async (t) => {
  const forks: unknown[] = []
  let hold: (() => void) | undefined
  let reached!: () => void
  const second = new Promise<void>((ok) => (reached = ok))
  let n = 0
  const up = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const body = JSON.parse(raw)
      if (JSON.stringify(body.messages.at(-1)).includes('I need a record of our work')) forks.push(body)
      const answer = () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 20 } }))
      }
      if (++n === 2) (hold = answer), reached()
      else answer()
    })
  })
  await new Promise<void>((ok) => up.listen(0, '127.0.0.1', ok))
  t.after(() => up.close())

  const dir = mkdtempSync(path.join(tmpdir(), 'drain-'))
  const policy = path.join(dir, 'policy.json')
  writeFileSync(policy, JSON.stringify({
    conversation_shaver_rules: { user_and_assistant_text: { summary_threshold_tokens: 10, memoir_threshold_tokens: 1e9 } },
    tool_shaver_rules: { claude: [] },
    skill_shaver_rules: [],
  }))
  const upstream = `http://127.0.0.1:${(up.address() as { port: number }).port}`
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.ts'), '--port', '0', '--upstream', upstream, '--dir', dir, '--policy', policy, '--log-step-events'], { stdio: ['ignore', 'ignore', 'pipe'] })
  t.after(() => child.kill())
  const exit = new Promise<number | null>((ok) => child.on('exit', ok))
  let err = ''
  const base = await new Promise<string>((ok) => child.stderr!.on('data', (c) => {
    err += c
    const m = err.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
    if (m) ok(m[1])
  }))

  const history: unknown[] = []
  const send = (prompt: string) => {
    history.push({ role: 'user', content: [{ type: 'text', text: prompt + ' ' + 'x'.repeat(400), cache_control: { type: 'ephemeral' } }] })
    return fetch(`${base}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 's1' },
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 1000, metadata: { user_id: JSON.stringify({ session_id: 's1' }) }, system: [{ type: 'text', text: 'You are Claude Code.' }], tools: [{ name: 'Read', description: 'Reads a file.', input_schema: { type: 'object', properties: {} } }], messages: history }),
    }).then(async (r) => (history.push({ role: 'assistant', content: (await r.json()).content }), r.status))
  }
  assert.equal(await send('Read the files.'), 200)
  const answered = send('Read more.')
  await second
  await fetch(`${base}/shaver/shutdown`, { method: 'POST', headers: { 'x-shaver': 'drain' } })
  hold!()
  assert.equal(await answered, 200)
  assert.equal(await exit, 0)

  const [key] = readdirSync(path.join(dir, 'logs'))
  const reqs = readFileSync(path.join(dir, 'logs', key, 'step_events.jsonl'), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l)).filter((l) => l.event === 'request')
  assert.equal(reqs.length, 2)
  assert.equal(reqs[1].summaryCheck?.skip, 'draining')
  assert.equal(forks.length, 0)
})

// SHAVER_DROP_UNBOUND_THINKING end to end (binding.ts): with it on, every
// request the proxy sends upstream that holds thinking, to a model newer than
// the 5.0s, asks for unbound thinking to be dropped, with the beta, and no
// other request does; what the API reports dropped is logged; a model that
// refuses the setting gets the request again without it, and not the setting
// again. With it off, nothing changes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BETA } from '../src/binding.ts'

const ROOT = path.join(import.meta.dirname, '..')
const DROPPED = [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }]

type Seen = { beta: string; body: any }
type Up = { url: string; seen: Seen[]; refuse: { on: boolean }; thinking: { tokens?: number }; close(): void }
// An upstream that reports one block dropped when asked to drop, and, told to
// refuse, refuses block_binding as a model without it would; given a thinking
// count, reports it as the thinking-token-count beta does.
async function upstream(): Promise<Up> {
  const seen: Seen[] = []
  const refuse = { on: false }
  const thinking: { tokens?: number } = {}
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw)
      seen.push({ beta: String(req.headers['anthropic-beta'] ?? ''), body })
      const binding = body.thinking?.block_binding
      if (refuse.on && binding) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking.block_binding: Extra inputs are not permitted' } }))
      }
      const usage = { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      event('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], usage, ...(binding && { input_transformations: DROPPED }) } })
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } })
      event('content_block_stop', { index: 0 })
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1, ...(thinking.tokens !== undefined && { output_tokens_details: { thinking_tokens: thinking.tokens } }) } })
      event('message_stop', {})
      res.end()
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, seen, refuse, thinking, close: () => server.close() }
}

type Proxy = { url: string; dir: string; child: ChildProcess; err: () => string }
async function proxy(up: string, on: boolean): Promise<Proxy> {
  const dir = mkdtempSync(path.join(tmpdir(), 'binding-e2e-'))
  const policy = path.join(dir, 'policy.json')
  writeFileSync(
    policy,
    JSON.stringify({
      conversation_shaver_rules: { tool: [{ action: 'drop', after: '1 request' }], user_and_assistant_text: { summary_threshold_tokens: 10_000_000, memoir_threshold_tokens: 10_000_000 } },
      tool_shaver_rules: { claude: [] },
      skill_shaver_rules: [],
    }),
  )
  const home = path.join(dir, 'home')
  mkdirSync(path.join(home, '.claude'), { recursive: true })
  const env = { ...process.env, HOME: home }
  delete env.CLAUDE_CONFIG_DIR
  if (on) env.SHAVER_DROP_UNBOUND_THINKING = '1'
  else delete env.SHAVER_DROP_UNBOUND_THINKING
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.ts'), '--port', '0', '--upstream', up, '--dir', dir, '--policy', policy, '--log-step-events'], { stdio: ['ignore', 'ignore', 'pipe'], env })
  let err = ''
  const url = await new Promise<string>((ok, fail) => {
    child.stderr!.on('data', (c) => {
      err += c
      const m = err.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
      if (m) ok(m[1])
    })
    child.on('exit', () => fail(new Error(err)))
  })
  return { url, dir, child, err: () => err }
}

const thought = { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'a', name: 'Read', input: {} }] }
const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x'.repeat(4000) }] }
const prompt = (t: string) => ({ role: 'user', content: [{ type: 'text', text: t }] })

async function send(p: Proxy, model: string, msgs: object[]) {
  const r = await fetch(`${p.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-beta': 'client-beta-1', 'x-claude-code-session-id': 'binding-test' },
    body: JSON.stringify({ model, max_tokens: 10, stream: true, thinking: { type: 'adaptive', display: 'updates' }, system: 'sys', tools: [{ name: 'Read', description: 'reads', input_schema: { type: 'object' } }], messages: msgs }),
  })
  await r.text()
  return r.status
}

const holdsThinking = (b: any) => b.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'thinking'))
const asksDrop = (s: Seen) => s.body.thinking?.block_binding?.prefix_mismatch_behavior === 'drop_block' && s.beta === `client-beta-1,${BETA}`
const requests = (dir: string) =>
  readdirSync(path.join(dir, 'logs')).flatMap((d) => readFileSync(path.join(dir, 'logs', d, 'step_events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))).filter((x) => x.event === 'request')

test('on: every request holding thinking to a newer model asks to drop unbound thinking, and none other; drops are logged; a refusal is sent again without it', async () => {
  const up = await upstream()
  const p = await proxy(up.url, true)
  try {
    assert.match(p.err(), /dropping unbound thinking/)
    // A first prompt, with no thinking yet, then two with it; then an older model.
    assert.equal(await send(p, 'claude-opus-5-5', [prompt('one')]), 200)
    assert.equal(await send(p, 'claude-opus-5-5', [prompt('one'), thought, result]), 200)
    assert.equal(await send(p, 'claude-fable-5-2', [prompt('one'), thought, result, prompt('two'), thought, result]), 200)
    assert.equal(await send(p, 'claude-opus-4-1', [prompt('one'), thought, result]), 200)
    const eligible = (s: Seen) => !s.body.model.includes('-4-')
    for (const s of up.seen) assert.equal(asksDrop(s), holdsThinking(s.body) && eligible(s), `${s.body.model}, ${s.body.messages.length} messages`)
    for (const s of up.seen) if (!asksDrop(s)) assert.equal(s.beta, 'client-beta-1', 'the client\'s beta, as it came')
    assert.ok(up.seen.slice(1, 3).every(asksDrop), 'both requests with thinking asked')
    const logged = requests(p.dir)
    assert.deepEqual(logged.map((x) => x.inputTransformations), [undefined, { 'thinking_dropped/prefix_binding_mismatch': 1 }, { 'thinking_dropped/prefix_binding_mismatch': 1 }, undefined])
    assert.ok(logged.every((x) => x.headers['anthropic-beta'] === 'client-beta-1'), 'the client\'s beta header logged')
    // Each request's log says whether it asked, exactly when it was sent asking.
    assert.deepEqual(logged.map((x) => x.dropAsked), up.seen.map((s) => (asksDrop(s) ? true : undefined)))

    // A model that refuses the setting gets the request again without it, and
    // isn't sent it again.
    up.refuse.on = true
    const before = up.seen.length
    assert.equal(await send(p, 'claude-sonnet-5-5', [prompt('one'), thought, result]), 200)
    assert.deepEqual(up.seen.slice(before).map(asksDrop), [true, false])
    assert.match(p.err(), /claude-sonnet-5-5 refused drop_block for unbound thinking; sent without it/)
    assert.equal(await send(p, 'claude-sonnet-5-5', [prompt('one'), thought, result, prompt('two')]), 200)
    assert.deepEqual(up.seen.slice(before + 2).map(asksDrop), [false])
    assert.deepEqual(requests(p.dir).slice(logged.length).map((x) => x.dropAsked), [undefined, undefined], 'sent again without it, logged as not asked')
  } finally {
    p.child.kill()
    up.close()
  }
})

test('off: requests holding thinking go up without the setting or the beta', async () => {
  const up = await upstream()
  const p = await proxy(up.url, false)
  try {
    assert.doesNotMatch(p.err(), /dropping unbound thinking/)
    assert.equal(await send(p, 'claude-fable-5-2', [prompt('one'), thought, result]), 200)
    assert.equal(up.seen.length, 1)
    assert.equal(up.seen[0].body.thinking.block_binding, undefined)
    assert.equal(up.seen[0].beta, 'client-beta-1')
    assert.equal(requests(p.dir)[0].dropAsked, undefined)
  } finally {
    p.child.kill()
    up.close()
  }
})

// The thinking-token-count beta's count reaches the stats: journaled for the
// answer when the response reports it, and not when it doesn't.
test('a reported thinking count is journaled for its answer, and none without one', async () => {
  const up = await upstream()
  const p = await proxy(up.url, false)
  // The journal's thinking record as it stands: a count moves from the answer
  // to its message once the answer is sent back, a delete and a set.
  const counts = () => {
    const now: Record<string, unknown> = {}
    const lines = readdirSync(path.join(p.dir, 'state'))
      .filter((f) => f.endsWith('.journal.jsonl'))
      .flatMap((f) => readFileSync(path.join(p.dir, 'state', f), 'utf8').trim().split('\n'))
    for (const l of lines) {
      const r = JSON.parse(l).records?.thinking
      for (const k of r?.del ?? []) delete now[k]
      Object.assign(now, r?.set)
    }
    return Object.values(now)
  }
  try {
    up.thinking.tokens = 7
    assert.equal(await send(p, 'claude-opus-5-5', [prompt('one')]), 200)
    assert.deepEqual(counts(), [7])
    delete up.thinking.tokens
    assert.equal(await send(p, 'claude-opus-5-5', [prompt('one'), thought, result]), 200)
    assert.deepEqual(counts(), [7], 'no count reported, none journaled')
  } finally {
    p.child.kill()
    up.close()
  }
})

// What Claude Code's compaction would keep is folded from the client's
// messages and journaled, so shaver info can use it.
test("the fold of what Claude Code's compaction keeps is journaled with each request", async () => {
  const up = await upstream()
  const p = await proxy(up.url, false)
  const keeps = () => readdirSync(path.join(p.dir, 'state'))
    .filter((f) => f.endsWith('.journal.jsonl'))
    .flatMap((f) => readFileSync(path.join(p.dir, 'state', f), 'utf8').trim().split('\n'))
    .map((l) => JSON.parse(l).set?.keep)
    .filter(Boolean)
  try {
    assert.equal(await send(p, 'claude-opus-5-5', [prompt('one')]), 200)
    assert.equal(await send(p, 'claude-opus-5-5', [prompt('one'), thought, result, prompt('two')]), 200)
    const said = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })
    const three = [prompt('one'), thought, result, prompt('two'), said('a'), prompt('three')]
    assert.equal(await send(p, 'claude-opus-5-5', three), 200)
    // A fourth that changes nothing it keeps: the answers are counted only to two.
    assert.equal(await send(p, 'claude-opus-5-5', [...three, said('b'), prompt('four')]), 200)
    const k = keeps()
    // The answers among the messages, journaled only when what it keeps
    // changed, and not where the fold got to.
    assert.deepEqual(k.map((x) => x.rounds), [0, 1, 2])
    assert.ok(k.every((x) => !('n' in x) && !('last' in x) && !('calls' in x)))
  } finally {
    p.child.kill()
    up.close()
  }
})

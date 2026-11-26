// A shaved request the API refuses freezes the conversation's shaving, end to
// end: the proxy sends it again shaped as the last request that worked, warns
// at each turn's end, tries shaving again only once that would save RETRY_STEP
// (10K) more tokens a request, and logs each attempt. The shave here is the trim
// force_trim_before_autocompact makes near Claude Code's compaction, which a
// warm cache would otherwise hold back; the upstream refuses any request that
// holds call c without a's result as sent, until told to stop. A result is
// dropped from the second request after the one it came in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
// A tool result of about n thousand tokens: the upstream counts 4 characters a token.
const result = (name: string, k: number) => name + ' ' + 'x'.repeat(k * 4000)
const A = result('REFUSE', 140)

type Up = { url: string; bodies: string[]; refuse: { on: boolean }; close(): void }
// The upstream's refusal of a request body, if it refuses it: by default, one
// holding call c without a's result as sent.
type Refusal = (raw: string) => string | undefined
const withoutA: Refusal = (raw) => (raw.includes('"id":"c"') && !raw.includes(A) ? 'refused for the test' : undefined)
async function upstream(refusal: Refusal = withoutA): Promise<Up> {
  const bodies: string[] = []
  const refuse = { on: true }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      bodies.push(raw)
      const why = refuse.on ? refusal(raw) : undefined
      if (why) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: why } }))
      }
      const usage = { input_tokens: Math.round(raw.length / 4), output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      event('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], usage } })
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } })
      event('content_block_stop', { index: 0 })
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
      event('message_stop', {})
      res.end()
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, bodies, refuse, close: () => server.close() }
}

type Proxy = { url: string; dir: string; child: ChildProcess }
async function proxy(up: string, dir = mkdtempSync(path.join(tmpdir(), 'freeze-e2e-')), more: Record<string, string> = {}): Promise<Proxy> {
  const policy = path.join(dir, 'policy.json')
  // Tool results dropped a request after they're sent, forced near compaction;
  // no summaries.
  writeFileSync(
    policy,
    JSON.stringify({
      force_trim_before_autocompact: { on_proximity_to_autocompact: '20000 tokens' },
      conversation_shaver_rules: { tool: [{ action: 'drop', eligible_after: '1 request' }], user_and_assistant_text: { summary_threshold_tokens: 10_000_000, memoir_threshold_tokens: 10_000_000 } },
      tool_shaver_rules: { claude: [] },
      skill_shaver_rules: [],
    }),
  )
  // A home whose Claude Code settings put the compaction at 167K (autocompact.ts),
  // so the trim is forced from 147K.
  const home = path.join(dir, 'home')
  mkdirSync(path.join(home, '.claude'), { recursive: true })
  writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: 200_000 }))
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, SHAVER_BUG_REPORT_URL: 'https://example.test/bugs', ...more }
  delete env.CLAUDE_CONFIG_DIR
  if (!('SHAVER_DROP_UNBOUND_THINKING' in more)) delete env.SHAVER_DROP_UNBOUND_THINKING
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.ts'), '--port', '0', '--upstream', up, '--dir', dir, '--policy', policy, '--log-step-events'], { stdio: ['ignore', 'ignore', 'pipe'], env })
  const url = await new Promise<string>((ok, fail) => {
    let err = ''
    child.stderr!.on('data', (c) => {
      err += c
      const m = err.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
      if (m) ok(m[1])
    })
    child.on('exit', () => fail(new Error(err)))
  })
  return { url, dir, child }
}

const text = (role: string, t: string) => ({ role, content: [{ type: 'text', text: t }] })
const tool = (id: string, content: string) => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file: id } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
]

// The messages with a cache breakpoint on the last block, as Claude Code sends them.
const marked = (msgs: any[]) => [...msgs.slice(0, -1), { ...msgs.at(-1), content: msgs.at(-1).content.map((b: object, j: number, all: object[]) => (j === all.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b)) }]

// A request through the proxy: its status and the reply's text.
async function send(p: Proxy, msgs: any[]) {
  const r = await fetch(`${p.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'freeze-test' },
    body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, stream: true, system: 'sys', tools: [{ name: 'Read', description: 'reads', input_schema: { type: 'object' } }], messages: marked(msgs) }),
  })
  const raw = await r.text()
  const blocks: string[] = []
  for (const l of raw.split('\n'))
    if (l.startsWith('data: ')) {
      const e = JSON.parse(l.slice(6))
      if (e.delta?.type === 'text_delta') blocks[e.index] = (blocks[e.index] ?? '') + e.delta.text
    }
  return { status: r.status, said: blocks.join('\n'), last: blocks.at(-1) ?? '', reply: { role: 'assistant', content: blocks.map((t) => ({ type: 'text', text: t })) } }
}

// The last request line's freeze: what was sent, in order, and how each went.
const lastFreeze = (dir: string) => {
  const logs = path.join(dir, 'logs')
  const lines = readdirSync(logs).flatMap((d) => readFileSync(path.join(logs, d, 'step_events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)))
  return lines.filter((x) => x.event === 'request').at(-1).freeze
}
const attempts = (f: any) => f.attempts.map((a: any) => `${a.sent} ${a.status}`)

test('a refused shave freezes, sends the last shape, warns, and retries once worth it', async () => {
  const up = await upstream()
  const p = await proxy(up.url)
  try {
    const msgs: any[] = [text('user', 'do it'), ...tool('a', A)]
    // 1 and 2: 140K, then 145K, tokens; a's result can't go yet.
    assert.equal((await send(p, msgs)).status, 200)
    msgs.push(...tool('b', result('second', 5)))
    assert.equal((await send(p, msgs)).status, 200)
    assert.equal(lastFreeze(p.dir), undefined, 'nothing frozen, nothing logged')
    // 3: 148K, so a's result is dropped: refused, then sent as request 2 was,
    // with c after it.
    msgs.push(...tool('c', result('third', 3)))
    const third = await send(p, msgs)
    assert.equal(third.status, 200)
    const [shaved, frozen] = up.bodies.slice(-2)
    assert.ok(!shaved.includes(A), 'the shave was tried first')
    assert.ok(frozen.includes(A) && frozen.includes('third'), 'then the last shape')
    assert.deepEqual(attempts(lastFreeze(p.dir)), ['shaved 400', 'frozen 200'])
    assert.match(third.last, /^\[shaver\] Warning: shaving is paused for this session, and your context is \d+k tokens larger than it otherwise would be\.\n\nAt \d{1,2}:\d\d [AP]M on [A-Z][a-z]{2}\. \d{4}-\d\d-\d\d, the API refused a request that the shaver had modified, with this error:\nrefused for the test\n\n/, 'the warning ends the reply')
    assert.match(third.last, /report this problem at https:\/\/example\.test\/bugs and include/, 'SHAVER_BUG_REPORT_URL overrides the address')
    assert.match(third.last, /run \S+\/bin\/run-proxy --update to install it\.$/)
    // 4: the turn's reply, warning and all, then a new prompt: the shave would
    // save only b's and c's 8K more, so it stays frozen, untried, and the
    // warning is taken out of the request.
    msgs.push(third.reply, text('user', 'go on'), ...tool('d', result('fourth', 5)))
    const count = up.bodies.length
    const fourth = await send(p, msgs)
    assert.equal(up.bodies.length, count + 1, 'no shave tried')
    assert.deepEqual(attempts(lastFreeze(p.dir)), ['frozen 200'])
    assert.ok(!up.bodies.at(-1)!.includes('[shaver] warning'))
    assert.match(fourth.said, /shaving is paused/)
    // 5: with d's 5K, 13K more: the shave is tried again, taken, and the freeze ends.
    up.refuse.on = false
    msgs.push(fourth.reply, text('user', 'more'), ...tool('e', 'small'))
    const fifth = await send(p, msgs)
    const f = lastFreeze(p.dir)
    assert.deepEqual(attempts(f), ['shaved 200'])
    assert.equal(f.unfrozen, 'retry-worked')
    assert.doesNotMatch(fifth.said, /shaving is paused/)
    assert.ok(!up.bodies.at(-1)!.includes(A), 'shaved')
  } finally {
    p.child.kill()
    up.close()
  }
})

test('a proxy restarted ends a freeze', async () => {
  const up = await upstream()
  let p = await proxy(up.url)
  try {
    const msgs: any[] = [text('user', 'do it'), ...tool('a', A), ...tool('b', result('second', 5))]
    await send(p, msgs.slice(0, 3))
    await send(p, msgs)
    msgs.push(...tool('c', result('third', 3)))
    await send(p, msgs)
    assert.equal(lastFreeze(p.dir).mode, 'frozen')
    p.child.kill()
    p = await proxy(up.url, p.dir)
    up.refuse.on = false
    msgs.push(...tool('d', 'small'))
    const r = await send(p, msgs)
    const f = lastFreeze(p.dir)
    assert.equal(f.unfrozen, 'restart')
    assert.deepEqual(attempts(f), ['shaved 200'])
    assert.doesNotMatch(r.said, /shaving is paused/)
  } finally {
    p.child.kill()
    up.close()
  }
})

// A drop that joins one message's thinking straight to the next's, refused as
// some routes refuse it, turns on the rule that stubs such calls instead
// for that conversation (server.ts, Refusals): the request is trimmed again
// under it and sent at once, with no freeze, and its later requests are
// trimmed under it from the start.
test("a drop refused for joining thinking to thinking is trimmed again with such calls stubbed, and not frozen", async () => {
  const joined: Refusal = (raw) => {
    const ms = JSON.parse(raw).messages
    const at = ms.findIndex((m: any, j: number) => m.role === 'assistant' && ms[j + 1]?.role === 'assistant' && m.content.at(-1)?.type === 'thinking' && ms[j + 1].content[0]?.type === 'thinking')
    return at < 0 ? undefined : `messages.${at}.content.0: \`thinking\` or \`redacted_thinking\` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.`
  }
  const up = await upstream(joined)
  const p = await proxy(up.url)
  // A step of a tool loop: thinking, then a call, then its result.
  const step = (id: string, content: string) => [
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'which next', signature: `sig-${id}` }, { type: 'tool_use', id, name: 'Read', input: { file: id } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  ]
  try {
    const msgs: any[] = [text('user', 'do it'), ...step('a', A)]
    assert.equal((await send(p, msgs)).status, 200)
    msgs.push(...step('b', result('second', 5)))
    assert.equal((await send(p, msgs)).status, 200)
    // 3: a's call is due; dropping it joins a's thinking to b's: refused, then
    // sent with a stubbed.
    msgs.push(...step('c', result('third', 3)))
    const third = await send(p, msgs)
    assert.equal(third.status, 200)
    assert.deepEqual(attempts(lastFreeze(p.dir)), ['shaved 400', 'shaved 200'])
    const sent = up.bodies.at(-1)!
    assert.ok(sent.includes('"id":"a"') && !sent.includes(A), 'a stubbed, not dropped')
    assert.doesNotMatch(third.said, /shaving is paused/)
    // 4: b's call is due too, and stubbed from the start.
    msgs.push(...step('d', 'small'))
    const count = up.bodies.length
    assert.equal((await send(p, msgs)).status, 200)
    assert.equal(up.bodies.length, count + 1, 'sent once')
    assert.equal(joined(up.bodies.at(-1)!), undefined)
  } finally {
    p.child.kill()
    up.close()
  }
})

// A shave refused for thinking it unbound, as API-key routes refuse it, turns
// on asking the API to drop unbound thinking for that conversation (binding.ts):
// the request is sent again asking, with no freeze, and its later requests ask
// from the start, while another conversation's don't. With
// SHAVER_DROP_UNBOUND_THINKING=0 it freezes as any refusal does.
const unbound: Refusal = (raw) => {
  const b = JSON.parse(raw)
  const thinks = b.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'thinking'))
  return thinks && !raw.includes(A) && !b.thinking?.block_binding ? 'messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".' : undefined
}
const step = (id: string, content: string) => [
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'which next', signature: `sig-${id}` }, { type: 'tool_use', id, name: 'Read', input: { file: id } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
]
const asksDrop = (raw: string) => JSON.parse(raw).thinking?.block_binding?.prefix_mismatch_behavior === 'drop_block'

test('a shave refused for unbound thinking is sent again asking the API to drop it, and not frozen', async () => {
  const up = await upstream(unbound)
  const p = await proxy(up.url)
  try {
    const msgs: any[] = [text('user', 'do it'), ...step('a', A)]
    assert.equal((await send(p, msgs)).status, 200)
    msgs.push(...step('b', result('second', 5)))
    assert.equal((await send(p, msgs)).status, 200)
    assert.ok(up.bodies.every((b) => !asksDrop(b)), 'not asked before a refusal')
    // 3: a's result is dropped, unbinding later thinking: refused, then sent
    // again asking.
    msgs.push(...step('c', result('third', 3)))
    const third = await send(p, msgs)
    assert.equal(third.status, 200)
    assert.deepEqual(attempts(lastFreeze(p.dir)), ['shaved 400', 'shaved 200'])
    const [refused, again] = up.bodies.slice(-2)
    assert.ok(!refused.includes(A) && !again.includes(A), 'shaved both times')
    assert.ok(!asksDrop(refused) && asksDrop(again))
    assert.deepEqual(failures(p.dir).map((f) => f.cause), [undefined], 'the shave\'s')
    assert.doesNotMatch(third.said, /shaving is paused/)
    // 4: asked from the start, sent once.
    msgs.push(...step('d', 'small'))
    const count = up.bodies.length
    assert.equal((await send(p, msgs)).status, 200)
    assert.equal(up.bodies.length, count + 1, 'sent once')
    assert.ok(asksDrop(up.bodies.at(-1)!))
    // Another conversation isn't asked: the refusal was this one's.
    assert.equal((await send(p, [text('user', 'another task'), ...step('x', A)])).status, 200)
    assert.ok(!asksDrop(up.bodies.at(-1)!), 'other conversation not asked')
  } finally {
    p.child.kill()
    up.close()
  }
})

// The failed events logged, of every conversation.
const failures = (dir: string) => {
  const logs = path.join(dir, 'logs')
  return readdirSync(logs).flatMap((d) => readFileSync(path.join(logs, d, 'step_events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))).filter((x) => x.event === 'failed')
}

// Thinking the client itself unbound, as Claude Code sends it after compacting
// with thinking from before the compaction, is refused before the proxy has
// trimmed anything. It gets the same handling, since the client sends that
// thinking again, but is logged as the client's refusal.
test("a client's own request refused for unbound thinking is handled the same, and logged as the client's", async () => {
  const up = await upstream(unbound)
  const p = await proxy(up.url)
  try {
    const msgs: any[] = [text('user', 'This session is being continued from a previous conversation.'), ...step('s', 'small')]
    const first = await send(p, msgs)
    assert.equal(first.status, 200)
    assert.deepEqual(attempts(lastFreeze(p.dir)), ['shaved 400', 'shaved 200'])
    const [refused, again] = up.bodies.slice(-2)
    assert.ok(!asksDrop(refused) && asksDrop(again))
    assert.deepEqual(failures(p.dir).map((f) => f.cause), ['client'])
    msgs.push(...step('t', 'small'))
    assert.equal((await send(p, msgs)).status, 200)
    assert.ok(asksDrop(up.bodies.at(-1)!), 'asked from then on')
  } finally {
    p.child.kill()
    up.close()
  }
})

test('with SHAVER_DROP_UNBOUND_THINKING=0 a shave refused for unbound thinking freezes', async () => {
  const up = await upstream(unbound)
  const p = await proxy(up.url, undefined, { SHAVER_DROP_UNBOUND_THINKING: '0' })
  try {
    const msgs: any[] = [text('user', 'do it'), ...step('a', A)]
    await send(p, msgs)
    msgs.push(...step('b', result('second', 5)))
    await send(p, msgs)
    msgs.push(...step('c', result('third', 3)))
    assert.equal((await send(p, msgs)).status, 200)
    assert.deepEqual(attempts(lastFreeze(p.dir)), ['shaved 400', 'frozen 200'])
    assert.ok(up.bodies.every((b) => !asksDrop(b)))
  } finally {
    p.child.kill()
    up.close()
  }
})

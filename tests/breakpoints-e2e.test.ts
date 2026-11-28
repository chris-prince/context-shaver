// SHAVER_CODEX_BREAKPOINTS end to end: with it on, every Codex request goes
// upstream with explicit breakpoints, at its last live entry, where it stops
// matching its messages settled, and where it stops matching them trimmed as
// far as the turn's requests take them, so a trim reads the prefix it keeps
// however far back, and at the end of its head; with it off, the same
// requests go with none, trimmed alike; and an upstream that refuses the
// field gets the same request without it, and no breakpoint after.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')

type Up = { url: string; seen: any[]; close(): void }
// How the upstream refuses: `named`, a 400 naming the field to a request that
// carries it; `unnamed`, the same in words that don't name it; `trimmed`, a
// 400 to any request with a stubbed output, the field or not; `placed`, a 400
// to a request that carries it, for the block it's on.
type Refusing = 'named' | 'unnamed' | 'trimmed' | 'placed'
// An upstream that answers every Responses request with a short message, or
// refuses as `refusing` says.
async function upstream(refusing?: Refusing): Promise<Up> {
  const seen: any[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      seen.push(JSON.parse(raw))
      const outputs = raw.split('"function_call_output"').length - 1
      const whole = raw.split('x'.repeat(4000)).length - 1
      const refuse = refusing === 'trimmed' ? whole < outputs : !!refusing && raw.includes('prompt_cache_breakpoint')
      if (refuse) {
        const message =
          refusing === 'named'
            ? "Unknown parameter: 'input[0].content[0].prompt_cache_breakpoint'."
            : refusing === 'placed'
              ? 'prompt_cache_breakpoint must be attached to a content block that renders cacheable prompt content.'
              : 'Invalid request.'
        res.writeHead(400, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }))
      }
      const usage = { input_tokens: 1000, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } }
      const completed = { type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage } }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: {} })}\n\n`)
      res.end(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`)
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() }
}

type Proxy = { url: string; child: ChildProcess }
const SETTLING = { tool: [{ action: 'stub', after: '0 turns' }] }
async function proxy(up: string, on: boolean, rules: object = SETTLING): Promise<Proxy> {
  const dir = mkdtempSync(path.join(tmpdir(), 'breakpoints-e2e-'))
  const policy = path.join(dir, 'policy.json')
  writeFileSync(
    policy,
    JSON.stringify({
      conversation_shaver_rules: { ...rules, user_and_assistant_text: { summary_threshold_tokens: 10_000_000, memoir_threshold_tokens: 10_000_000 } },
      tool_shaver_rules: { codex: [] },
      skill_shaver_rules: [],
    }),
  )
  const env = { ...process.env, HOME: dir }
  // On is the default, so it's the variable unset; off is 0.
  if (on) delete env.SHAVER_CODEX_BREAKPOINTS
  else env.SHAVER_CODEX_BREAKPOINTS = '0'
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.ts'), '--port', '0', '--upstream', up, '--dir', dir, '--policy', policy], { stdio: ['ignore', 'ignore', 'pipe'], env })
  let err = ''
  const url = await new Promise<string>((ok, fail) => {
    child.stderr!.on('data', (c) => {
      err += c
      const m = err.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
      if (m) ok(m[1])
    })
    child.on('exit', () => fail(new Error(err)))
  })
  return { url, child }
}

const prompt = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
const call = (i: number) => ({ type: 'function_call', call_id: `c${i}`, name: 'shell', arguments: '{}' })
const output = (i: number) => ({ type: 'function_call_output', call_id: `c${i}`, output: `${i} ${'x'.repeat(4000)}` })

async function send(p: Proxy, input: object[], key = 'breakpoints-test') {
  const r = await fetch(`${p.url}/harness/codex/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'session-id': key },
    body: JSON.stringify({ model: 'gpt-6.1-sol', instructions: 'be brief', stream: true, prompt_cache_key: key, tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }], input }),
  })
  await r.text()
  assert.equal(r.status, 200)
}

// A turn of 50 calls, then a second prompt, by which, its turn over, each
// output is due to be stubbed: the trimmed prompt keeps its 103 items, so the
// prefix before the first stubbed output is past sol's lookback of 20 items.
// With `twice`, a second such conversation after it, through the same proxy.
async function conversation(on: boolean, refusing?: Refusing, twice = false) {
  const up = await upstream(refusing)
  const p = await proxy(up.url, on)
  try {
    for (const key of twice ? ['first', 'second'] : ['breakpoints-test']) {
      const turn: object[] = [prompt(`look around (${key})`)]
      for (let i = 0; i < 50; i++) {
        await send(p, turn, key)
        turn.push(call(i), output(i))
      }
      await send(p, [...turn, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }, prompt('now summarize')], key)
    }
    return up.seen
  } finally {
    p.child.kill()
    up.close()
  }
}

const marked = (body: any) =>
  body.input.flatMap((item: any, i: number) => (Array.isArray(item.content ?? item.output) ? (item.content ?? item.output) : []).filter((c: any) => c.prompt_cache_breakpoint).map(() => i))
const stubbed = (body: any) => body.input.filter((item: any) => item.type === 'function_call_output' && !JSON.stringify(item.output).includes('x'.repeat(4000))).length

test('on: each request is marked at its last live entry and at its settled boundary, the trimmed one at the end of what it keeps, which is past the lookback', async () => {
  const seen = await conversation(true)
  const last = seen.at(-1)
  assert.equal(stubbed(last), 50)
  // The prompt, where the last request's boundary made an entry, and its own
  // boundary: all of it, as nothing more is due.
  assert.deepEqual(marked(last), [0, 102])
  assert.deepEqual(last.input[0].content, [{ type: 'input_text', text: 'look around (breakpoints-test)', prompt_cache_breakpoint: { mode: 'explicit' } }])
  // Before it, the boundary is the prompt, the last block before the first
  // output, which will be stubbed; the last live entry is the output the
  // request before ended with, marked as an array of one part.
  assert.deepEqual(marked(seen[0]), [0])
  assert.deepEqual(marked(seen[1]), [0])
  seen.slice(2, -1).forEach((body, n) => {
    assert.deepEqual(marked(body), [0, 2 * n + 2])
    assert.deepEqual(body.input[2 * n + 2].output, [{ type: 'input_text', text: `${n} ${'x'.repeat(4000)}`, prompt_cache_breakpoint: { mode: 'explicit' } }])
  })
})

test('off: the same requests go unmarked, trimmed alike', async () => {
  const seen = await conversation(false)
  assert.equal(stubbed(seen.at(-1)), 50)
  for (const body of seen) assert.deepEqual(marked(body), [])
})

// However the refusal's words go, the same request goes again without the
// breakpoint, and the model is marked no more.
for (const refusing of ['named', 'unnamed'] as const)
  test(`refused, ${refusing}: the same request goes again without the breakpoint, and the model is marked no more`, async () => {
    const seen = await conversation(true, refusing, true)
    // The first conversation's first request refused, then resent; every one
    // after goes unmarked, the trimmed ones too.
    assert.equal(seen.length, 1 + 51 + 51)
    const [refused, resent] = seen
    assert.deepEqual(marked(refused), [0])
    // The prompt as it was: a breakpoint taken out leaves the part as it came.
    assert.deepEqual(resent, JSON.parse(JSON.stringify(refused, (k, v) => (k === 'prompt_cache_breakpoint' ? undefined : v))))
    for (const body of seen.slice(1)) assert.deepEqual(marked(body), [])
    for (const trimmed of [seen[51], seen.at(-1)]) assert.equal(stubbed(trimmed), 50)
  })

test('refused for where it is: that request goes again without the breakpoint, and the next is marked as before', async () => {
  const seen = await conversation(true, 'placed')
  // Each of the 51 requests refused marked, then resent unmarked as it was.
  assert.equal(seen.length, 2 * 51)
  for (let i = 0; i < seen.length; i += 2) {
    assert.notDeepEqual(marked(seen[i]), [])
    assert.deepEqual(seen[i + 1], JSON.parse(JSON.stringify(seen[i], (k, v) => (k === 'prompt_cache_breakpoint' ? undefined : v))))
  }
  assert.equal(stubbed(seen.at(-1)), 50)
})

test('refused without the breakpoint too: the freeze takes it, and the model is still marked', async () => {
  const seen = await conversation(true, 'trimmed', true)
  // Each conversation's last request: refused marked, refused again unmarked,
  // then sent untrimmed by the freeze.
  assert.equal(seen.length, 2 * (51 + 2))
  for (const at of [50, 103]) {
    const [refused, resent, frozen] = seen.slice(at, at + 3)
    assert.deepEqual(marked(refused), [0, 102])
    assert.deepEqual(marked(resent), [])
    assert.equal(stubbed(resent), 50)
    assert.equal(stubbed(frozen), 0)
    // Untrimmed, its boundary is the prompt still, and its last live entry
    // the output the request before ended with.
    assert.deepEqual(marked(frozen), [0, 98])
  }
})

// One turn of 50 calls after a head of one developer message, under rules
// that stub an output 4 requests on and drop its call when the turn is over:
// while the turn lasts its settled boundary stays at the prompt.
async function longTurn(on: boolean) {
  const up = await upstream()
  const p = await proxy(up.url, on, { tool: [{ action: 'stub', after: '4 requests' }, { action: 'drop', after: '0 turns' }] })
  try {
    const turn: object[] = [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are in /repo.' }] }, prompt('look around')]
    for (let i = 0; i < 50; i++) {
      await send(p, turn)
      turn.push(call(i), output(i))
    }
    return up.seen
  } finally {
    p.child.kill()
    up.close()
  }
}

test("on, in a long turn: each request is marked at its head's end, and a trim where the turn's next trim starts, which that trim reads", async () => {
  const seen = await longTurn(true)
  // The last stubbed output: the head's message, the prompt, then a call and an output each.
  const boundary = (body: any) => 1 + 2 * stubbed(body)
  const trims = seen.map((_, n) => n).filter((n) => n > 0 && stubbed(seen[n]) > stubbed(seen[n - 1]))
  assert.ok(trims.length >= 2)
  seen.forEach((body, n) => {
    const at = marked(body)
    assert.ok(at.length <= 4)
    // The head's end and the settled boundary, the prompt.
    assert.deepEqual(at.slice(0, 2), [0, 1])
    assert.deepEqual(body.input[0].content, [{ type: 'input_text', text: 'You are in /repo.', prompt_cache_breakpoint: { mode: 'explicit' } }])
    // Once trimmed, the last output stubbed, before the next one due.
    if (stubbed(body)) assert.ok(at.includes(boundary(body)))
    // And on a trim, the one the trim before left there, its last live entry.
    const before = trims[trims.indexOf(n) - 1]
    if (before !== undefined) assert.deepEqual(at, [0, 1, boundary(seen[before]), boundary(body)])
  })
})

test('off, in a long turn: the same requests go unmarked, the head too', async () => {
  const seen = await longTurn(false)
  assert.ok(stubbed(seen.at(-1)) > 0)
  for (const body of seen) assert.ok(!JSON.stringify(body).includes('prompt_cache_breakpoint'))
})

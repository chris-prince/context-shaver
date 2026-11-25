// SHAVER_CODEX_BREAKPOINTS end to end: with it on, a Codex request whose
// trim keeps a prefix past the lookback goes upstream with an explicit
// breakpoint at that prefix's end; with it off, the same requests go with
// none, trimmed alike; and an upstream that refuses the field gets the same
// trimmed request without it, and no breakpoint after.
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
// 400 to any request with a stubbed output, the field or not.
type Refusing = 'named' | 'unnamed' | 'trimmed'
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
        const message = refusing === 'named' ? "Unknown parameter: 'input[0].content[0].prompt_cache_breakpoint'." : 'Invalid request.'
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
async function proxy(up: string, on: boolean): Promise<Proxy> {
  const dir = mkdtempSync(path.join(tmpdir(), 'breakpoints-e2e-'))
  const policy = path.join(dir, 'policy.json')
  writeFileSync(
    policy,
    JSON.stringify({
      conversation_shaver_rules: { tool: [{ action: 'stub', after: '0 turns' }], user_and_assistant_text: { summary_threshold_tokens: 10_000_000, memoir_threshold_tokens: 10_000_000 } },
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
// prefix before the first stubbed output is past sol's lookback of 78 items.
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

test('on: the trimmed request is marked at the end of what it keeps, which is past the lookback', async () => {
  const seen = await conversation(true)
  const last = seen.at(-1)
  assert.equal(stubbed(last), 50)
  assert.deepEqual(marked(last), [0])
  assert.deepEqual(last.input[0].content, [{ type: 'input_text', text: 'look around (breakpoints-test)', prompt_cache_breakpoint: { mode: 'explicit' } }])
  // Within the lookback, nothing is marked.
  for (const body of seen.slice(0, -1)) assert.deepEqual(marked(body), [])
})

test('off: the same requests go unmarked, trimmed alike', async () => {
  const seen = await conversation(false)
  assert.equal(stubbed(seen.at(-1)), 50)
  for (const body of seen) assert.deepEqual(marked(body), [])
})

// However the refusal's words go, the same trimmed request goes again without
// the breakpoint, and the model is marked no more.
for (const refusing of ['named', 'unnamed'] as const)
  test(`refused, ${refusing}: the same trimmed request goes again without the breakpoint, and the model is marked no more`, async () => {
    const seen = await conversation(true, refusing, true)
    // The first conversation's last request refused, then resent; the second's
    // last, which would be marked as the first's was, goes unmarked.
    assert.equal(seen.length, 51 + 1 + 51)
    const [refused, resent, next] = [seen[50], seen[51], seen.at(-1)]
    assert.deepEqual(marked(refused), [0])
    // The prompt as it was: a breakpoint taken out leaves the part as it came.
    assert.deepEqual(resent, JSON.parse(JSON.stringify(refused, (k, v) => (k === 'prompt_cache_breakpoint' ? undefined : v))))
    assert.equal(stubbed(resent), 50)
    assert.deepEqual(marked(next), [])
    assert.equal(stubbed(next), 50)
  })

test('refused without the breakpoint too: the freeze takes it, and the model is still marked', async () => {
  const seen = await conversation(true, 'trimmed', true)
  // Each conversation's last request: refused marked, refused again unmarked,
  // then sent untrimmed by the freeze.
  assert.equal(seen.length, 2 * (51 + 2))
  for (const at of [50, 103]) {
    const [refused, resent, frozen] = seen.slice(at, at + 3)
    assert.deepEqual(marked(refused), [0])
    assert.deepEqual(marked(resent), [])
    assert.equal(stubbed(resent), 50)
    assert.equal(stubbed(frozen), 0)
  }
})

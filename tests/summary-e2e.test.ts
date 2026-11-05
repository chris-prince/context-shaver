// Summary forks end to end: the real proxy, in front of a stand-in upstream,
// sends one each turn, and must log how each one went (failed with its stage,
// rejected with its reason and the answer saved, or recorded), why it sent
// none on the other requests, what `shaver info` shows of the last failure,
// and where the records break when a prompt they end before is rewritten.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

// The upstream answers the client's requests with text; summary forks, by
// turn, with an error, then an answer with no closing line, then a record.
async function upstream(): Promise<{ url: string; close(): void }> {
  const forks = [
    () => ({ status: 500, body: { type: 'error', error: { type: 'api_error', message: 'boom' } } }),
    () => ({ status: 200, text: '## [1] Read the files.\n- read them', stop: 'max_tokens' }),
    () => ({ status: 200, text: '## [1] Read the files.\n- read them\n\n## [2] Read more.\n- read more\n\nEnds before: [3]', stop: 'end_turn' }),
  ]
  let n = 0
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const body = JSON.parse(raw)
      const fork = JSON.stringify(body.messages.at(-1)).includes('I need a record of our work') ? forks[n++]() : { status: 200, text: 'Done.', stop: 'end_turn' }
      res.writeHead(fork.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify('body' in fork ? fork.body : { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: fork.text }], stop_reason: fork.stop, usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 20 } }))
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
}


const POLICY = {
  conversation_shaver_rules: { user_and_assistant_text: { summary_threshold_tokens: 10, memoir_threshold_tokens: 1e9 } },
  tool_shaver_rules: { claude: [] },
  skill_shaver_rules: [],
}

// The step events written so far: none before the file is made, and not a
// line still being written.
const lines = (dir: string, key: string) => {
  const file = path.join(dir, 'logs', key, 'step_events.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l))
}

// The proxy is another process, and logs a request after the client has its
// answer: waits for what the test reads next, and fails if it never comes.
async function until(done: () => boolean, what: string) {
  for (let t = 0; !done(); t++) {
    if (t === 800) throw new Error(`timed out waiting for ${what}`)
    await new Promise((ok) => setTimeout(ok, 25))
  }
}

test('each summary fork logs how it went, and each request why it sent none', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'summary-e2e-'))
  const up = await upstream()
  const policy = path.join(dir, 'policy.json')
  writeFileSync(policy, JSON.stringify(POLICY))
  // Port 0: the proxy takes a free port as it binds, and names it.
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.ts'), '--port', '0', '--upstream', up.url, '--dir', dir, '--policy', policy, '--log-step-events'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  try {
    const url = await new Promise<string>((ok, fail) => {
      child.stderr!.on('data', (d) => { err += d; const m = err.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (m) ok(m[1]) })
      child.on('exit', (code) => fail(new Error(`the proxy exited (${code}): ${err}`)))
    })
    const history: any[] = []
    const send = async (messages: any[]) => {
      const last = messages.at(-1)
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 's1' },
        body: JSON.stringify({
          model: 'claude-opus-5-5', max_tokens: 1000, metadata: { user_id: JSON.stringify({ session_id: 's1' }) },
          system: [{ type: 'text', text: 'You are Claude Code.' }],
          tools: [{ name: 'Read', description: 'Reads a file.', input_schema: { type: 'object', properties: {} } }],
          messages: [...messages.slice(0, -1), { ...last, content: [{ ...last.content[0], cache_control: { type: 'ephemeral' } }] }],
        }),
      })
      assert.equal(r.status, 200)
      return (await r.json()).content
    }
    // Each turn waits for its own log line, and for the summary fork it sent
    // to finish.
    const logged = (event: string) => (existsSync(path.join(dir, 'logs')) ? readdirSync(path.join(dir, 'logs')).flatMap((key) => lines(dir, key)).filter((l) => l.event === event).length : 0)
    for (const [k, prompt] of ['Read the files.', 'Read more.', 'And more.', 'Last one.'].entries()) {
      history.push({ role: 'user', content: [{ type: 'text', text: prompt + ' ' + 'x'.repeat(400) }] })
      history.push({ role: 'assistant', content: await send(history) })
      await until(() => logged('request') > k && logged('summary') >= k, `turn ${k + 1}'s request and summary fork`)
    }
    // Rewound to turn 3 with a new prompt: the record that ends before it no
    // longer fits.
    await send([...history.slice(0, 4), { role: 'user', content: [{ type: 'text', text: 'Something else.' }] }])
    await until(() => logged('request') === 5, "the rewound request's line")
    // What the proxy wrote to stderr is all read once it has exited.
    const closed = new Promise((ok) => child.on('close', ok))
    child.kill()
    await closed
    const [key] = readdirSync(path.join(dir, 'logs'))
    const all = lines(dir, key)
    const forks = all.filter((l) => l.event === 'summary')
    assert.deepEqual(forks.map((l) => l.outcome), ['failed', 'rejected', 'recorded'])
    assert.equal(forks[0].stage, 'status')
    assert.match(forks[0].error, /500/)
    assert.match(readFileSync(path.join(dir, 'logs', key, forks[0].answer), 'utf8'), /boom/)
    assert.deepEqual([forks[1].reason, forks[1].stop], ['no-ends-before', 'max_tokens'])
    assert.match(readFileSync(path.join(dir, 'logs', key, forks[1].answer), 'utf8'), /read them/)
    assert.deepEqual([forks[2].endsBefore, forks[2].arcs, forks[2].stop, forks[2].answer], [3, 2, 'end_turn', undefined])
    // Why each request sent none, or that it sent one.
    const checks = all.filter((l) => l.event === 'request').map((l) => l.summaryCheck?.skip ?? l.summaryCheck)
    assert.deepEqual(checks.slice(0, 4), ['no-new-turn', 'sent', 'sent', 'sent'])
    const dropped = all.filter((l) => l.event === 'summary-dropped')
    assert.deepEqual(dropped.map((l) => [l.index, l.dropped, l.endsBefore]), [[0, 1, 3]])
    // The proxy's log says the same, and the records file keeps the last failure.
    assert.match(err, /turns 1-2: failed at status: Error, status 500, at /)
    // Nothing the upstream or the model wrote reaches it.
    assert.doesNotMatch(err, /boom|read them/)
    assert.match(err, /turns 1-3: rejected, no-ends-before, 20 output tokens, stopped: max_tokens/)
    // It has problems only: the recorded fork is in the step events alone.
    assert.doesNotMatch(err, /turns 1-4/)
    assert.match(err, /1 of 1 no longer fit, from record 1, which ends before \[3\]: that turn's prompt changed/)
    const file = JSON.parse(readFileSync(path.join(dir, 'state', `${key}.summaries.json`), 'utf8'))
    assert.deepEqual([file.failed.outcome, file.failed.reason, file.requests], ['rejected', 'no-ends-before', 3])
  } finally {
    child.kill()
    up.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

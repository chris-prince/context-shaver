// Codex's remote compaction (POST …/responses/compact) is sent on as it came
// and journaled bare, with its usage, under its session's conversation, so its
// cost is counted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')

test("a Codex compaction is passed through unchanged and journaled bare with its usage", async () => {
  const bodies: { url: string; raw: string }[] = []
  const usage = { input_tokens: 34315, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 317, output_tokens_details: { reasoning_tokens: 200 }, total_tokens: 34632 }
  const up = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      bodies.push({ url: req.url ?? '', raw })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'r', object: 'response', output: [{ type: 'compaction', encrypted_content: 'z' }], usage }))
    })
  })
  await new Promise<void>((ok) => up.listen(0, '127.0.0.1', ok))
  const { port } = up.address() as { port: number }

  const dir = mkdtempSync(path.join(tmpdir(), 'compact-e2e-'))
  const policy = path.join(dir, 'policy.json')
  writeFileSync(policy, JSON.stringify({ conversation_shaver_rules: { tool: [{ action: 'drop', after: '1 request' }] }, tool_shaver_rules: { codex: [] }, skill_shaver_rules: [] }))
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.ts'), '--port', '0', '--upstream', `http://127.0.0.1:${port}`, '--dir', dir, '--policy', policy, '--log-step-events'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HOME: dir } })
  try {
    const url = await new Promise<string>((ok, fail) => {
      let err = ''
      child.stderr!.on('data', (c) => {
        err += c
        const m = err.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
        if (m) ok(m[1])
      })
      child.on('exit', () => fail(new Error(err)))
    })
    const body = JSON.stringify({ model: 'gpt-5.5', instructions: 'be brief', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'shaver info' }] }, { type: 'function_call_output', call_id: 'c', output: 'x'.repeat(1000) }] })
    const r = await fetch(`${url}/harness/codex/v1/responses/compact`, { method: 'POST', headers: { 'content-type': 'application/json', 'session-id': 's1' }, body })
    assert.equal(r.status, 200)
    assert.deepEqual((await r.json()).usage, usage)
    // Sent as it came: no command answered, nothing dropped.
    assert.deepEqual(bodies, [{ url: '/v1/responses/compact', raw: body }])

    const state = path.join(dir, 'state')
    const journals = readdirSync(state).filter((f) => f.endsWith('.journal.jsonl'))
    assert.equal(journals.length, 1)
    assert.match(journals[0], /^codex-s1-/)
    const bare = readFileSync(path.join(state, journals[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((l) => l.bare).filter(Boolean)
    assert.equal(bare.length, 1)
    assert.equal(bare[0].why, 'compaction')
    assert.equal(bare[0].model, 'gpt-5.5')
    assert.ok(bare[0].usage, 'its usage is journaled')

    const logs = path.join(dir, 'logs')
    const lines = readdirSync(logs).flatMap((d) => readFileSync(path.join(logs, d, 'step_events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)))
    const logged = lines.filter((l) => l.bare === 'compaction')
    assert.equal(logged.length, 1)
    assert.equal(logged[0].inputTokens, 34315)
    assert.equal(logged[0].outputTokens, 317)
  } finally {
    child.kill()
    up.close()
  }
})

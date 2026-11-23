// scripts/backtest-shaver.ts's compaction, end to end: the real proxy, in
// front of a stand-in upstream, logs rounds of file reads with no trimming,
// and the backtest over that log must compact each horizon as the client
// would: every prompt past the limit is followed by a compaction, and the
// prompt after one is back to the base, the summary and what it keeps, the
// last round and the files read again. With --no-compaction no horizon
// compacts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { modelOf } from '../src/models.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const MODEL = 'claude-opus-5-5'

// The upstream answers each request with a tool call, costing a token per 4
// bytes of its body.
async function upstream(): Promise<{ url: string; close(): void }> {
  let n = 0
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const body = JSON.parse(raw)
      n++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: `m${n}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'tool_use', id: `t${n}`, name: 'Read', input: { file_path: `/f${n}.ts` } }], stop_reason: 'tool_use', usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 20 } }))
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
}

// Nothing trimmed, so the logged prompt grows with every call.
const POLICY = {
  conversation_shaver_rules: {
    tool: [],
    'tool:skill': [],
    reasoning: [],
    user_and_assistant_text: { summary_threshold_tokens: 1e9, memoir_threshold_tokens: 1e9 },
  },
  tool_shaver_rules: { claude: [] },
  skill_shaver_rules: [],
}

// CALLS tool calls, each result about 10K tokens, a new prompt every ROUND.
const CALLS = 24
const ROUND = 3
async function converse(url: string) {
  const history: any[] = [{ role: 'user', content: [{ type: 'text', text: 'Read the files.' }] }]
  for (let i = 0; i < CALLS; i++) {
    const messages = history.map((m, j) => j < history.length - 1 ? m : { ...m, content: m.content.map((b: object, k: number) => k === m.content.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b) })
    const r = await fetch(`${url}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 's1' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1000, metadata: { user_id: JSON.stringify({ session_id: 's1' }) },
        system: [{ type: 'text', text: 'You are Claude Code.' }],
        tools: [{ name: 'Read', description: 'Reads a file.', input_schema: { type: 'object', properties: {} } }],
        messages,
      }),
    })
    assert.equal(r.status, 200)
    const a = await r.json()
    history.push({ role: 'assistant', content: a.content })
    history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: a.content[0].id, content: `file ${i}: ` + 'x'.repeat(40_000) }] })
    if ((i + 1) % ROUND === 0) history.push({ role: 'assistant', content: [{ type: 'text', text: 'Read them.' }] }, { role: 'user', content: [{ type: 'text', text: 'Read more files.' }] })
  }
}

type Out = { tokens: Record<string, number[]>; compacted: Record<string, number[]> }

test('the horizon backtest compacts each horizon past the limit, and not with --no-compaction', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'backtest-compaction-e2e-'))
  const up = await upstream()
  const policy = path.join(dir, 'policy.json')
  writeFileSync(policy, JSON.stringify(POLICY, null, 2) + '\n')
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.ts'), '--port', '0', '--upstream', up.url, '--dir', dir, '--policy', policy, '--log-step-events'], { stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    let err = ''
    const url = await new Promise<string>((ok, fail) => {
      child.stderr!.on('data', (d) => { err += d; const m = err.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (m) ok(m[1]) })
      child.on('exit', (code) => fail(new Error(`the proxy exited (${code}): ${err}`)))
    })
    await converse(url)
    const [key] = readdirSync(path.join(dir, 'logs'))
    const backtest = (...flags: string[]): Out => {
      const out = path.join(dir, `out${flags.join('')}.jsonl`)
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/backtest-shaver.ts'), ...flags, '--out', out, path.join(dir, 'logs', key)], { env: { ...process.env, POLICY: policy }, encoding: 'utf8' })
      return JSON.parse(readFileSync(out, 'utf8').trim())
    }

    // The limit well under the logged prompt's last size (about 240K tokens),
    // and well over what a compaction leaves.
    const AT = 80_000
    const c = modelOf(MODEL).compaction!
    assert.equal(c.kept, 20_000)
    const on = backtest('--compact-at', String(AT))
    const off = backtest('--no-compaction')
    const NONE = 'no message trims'
    assert.ok(off.tokens[NONE].at(-1)! > 2 * AT, 'the log should grow well past the limit')
    for (const [row, tokens] of Object.entries(on.tokens)) {
      const compacted = new Set(on.compacted[row])
      // Every prompt past the limit, but the last, is followed by a
      // compaction, and only those are.
      tokens.slice(0, -1).forEach((t, n) => assert.equal(compacted.has(n), t > AT, `${row}: request ${n}, ${t} tokens`))
      // The prompt after each is the base, the summary, the last round, at
      // most ROUND results of about 10K tokens, and the files read before it,
      // each over 5,000 tokens and so a note.
      for (const n of compacted) assert.ok(tokens[n + 1] <= tokens[0] + c.summarized! + ROUND * 10_500 + 5 * 100, `${row}: after request ${n}, ${tokens[n + 1]} tokens`)
    }
    // The horizon with no trimming crosses the limit, more than once.
    assert.ok(on.compacted[NONE].length >= 2, JSON.stringify(on.compacted[NONE]))
    // Without compaction, no horizon compacts, and the prompts are the
    // logged ones up to the first compaction.
    for (const row of Object.keys(off.compacted)) assert.deepEqual(off.compacted[row], [], row)
    const first = on.compacted[NONE][0]
    assert.deepEqual(on.tokens[NONE].slice(0, first + 1), off.tokens[NONE].slice(0, first + 1))
  } finally {
    child.kill()
    up.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

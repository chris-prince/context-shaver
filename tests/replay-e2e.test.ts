// scripts/replay.ts end to end: the real proxy, in front of a stand-in
// upstream, logs a conversation of tool calls under a drop policy, and the
// replay of that log must rebuild every request, reproduce what the proxy
// sent from the rebuild, and price a POLICY file as the same built-in policy.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

// The upstream answers each request with a tool call, or text when its last
// message says so, costing a token per 4 bytes of its body.
async function upstream(): Promise<{ url: string; close(): void }> {
  let n = 0
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const body = JSON.parse(raw)
      const content = JSON.stringify(body.messages.at(-1)).includes('ANSWER NOW') ? [{ type: 'text', text: 'Done.' }] : [{ type: 'tool_use', id: `t${n}`, name: 'Read', input: { n } }]
      n++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: `m${n}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: 'end_turn', usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 20 } }))
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
}

const freePort = async () => {
  const s = createServer()
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok))
  const { port } = s.address() as { port: number }
  await new Promise((ok) => s.close(ok))
  return port
}

// The replay's own drop policy at wait 2, so WAIT=2 checks the rebuild.
const POLICY = {
  conversation_shaver_rules: {
    tool: [{ action: 'drop', after: '2 requests' }],
    skill: [{ action: 'drop', after: '0 turns' }],
    reasoning: [{ action: 'drop', after: '0 turns' }],
    user_and_assistant_text: { summary_threshold_tokens: 1e9, memoir_threshold_tokens: 1e9 },
  },
  tool_shaver_rules: { claude: [] },
  skill_shaver_rules: [],
}

// Two turns of tool calls, the last message carrying a breakpoint as Claude
// Code's does. The first result is large and the rest small, so dropping it
// pays for rewriting what follows it even with the cache modelled.
async function converse(url: string) {
  const history: any[] = []
  const send = async () => {
    const messages = history.map((m, i) => i < history.length - 1 ? m : { ...m, content: m.content.map((b: object, j: number) => j === m.content.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b) })
    const r = await fetch(`${url}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 's1' },
      body: JSON.stringify({
        model: 'claude-opus-5-5', max_tokens: 1000, metadata: { user_id: JSON.stringify({ session_id: 's1' }) },
        system: [{ type: 'text', text: 'You are Claude Code.' }],
        tools: [{ name: 'Read', description: 'Reads a file.', input_schema: { type: 'object', properties: {} } }],
        messages,
      }),
    })
    assert.equal(r.status, 200)
    const a = await r.json()
    history.push({ role: 'assistant', content: a.content })
    return a.content[0]
  }
  for (const [prompt, calls] of [['Read the files.', 6], ['Read some more.', 3]] as const) {
    history.push({ role: 'user', content: [{ type: 'text', text: prompt }] })
    for (let i = 0; i < calls; i++) {
      const call = await send()
      history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: `file ${call.input.n}: ` + 'x'.repeat(call.input.n === 0 ? 200000 : 200) }] })
    }
    history.at(-1).content.push({ type: 'text', text: 'ANSWER NOW' })
    await send()
  }
}

test('the replay rebuilds a logged conversation and reprices it consistently', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'replay-e2e-'))
  const up = await upstream()
  const policy = path.join(dir, 'policy.json')
  writeFileSync(policy, JSON.stringify(POLICY, null, 2) + '\n')
  const port = await freePort()
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.ts'), '--port', String(port), '--upstream', up.url, '--dir', dir, '--policy', policy, '--log-step-events'], { stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    let err = ''
    await new Promise<void>((ok, fail) => {
      child.stderr!.on('data', (d) => { err += d; if (err.includes('listening on')) ok() })
      child.on('exit', (code) => fail(new Error(`the proxy exited (${code}): ${err}`)))
    })
    await converse(`http://127.0.0.1:${port}`)
    const [key] = readdirSync(path.join(dir, 'logs'))
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/replay.ts'), path.join(dir, 'logs', key)], { env: { ...process.env, WAIT: '2', POLICY: policy }, encoding: 'utf8' })
    const row = (name: string) => out.split('\n').find((l) => l.startsWith(name))!.slice(14)
    const cost = (name: string) => Number(row(name).match(/^ \$([\d.]+)/)![1])
    assert.match(out, /: 11 requests, rebuild breaks 0,/)
    assert.match(out, /doesn't reproduce: 0 of 11\n/)
    assert.match(row('no trimming'), /trims 0$/)
    assert.doesNotMatch(row('drop wait 2'), /trims 0$/)
    assert.equal(row('POLICY'), row('drop wait 2'))
    assert.ok(cost('drop wait 2') < cost('no trimming'))
  } finally {
    child.kill()
    up.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

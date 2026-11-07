// trim_before_autocompact end to end: the real proxy, in front of a stand-in
// upstream, on a warm cache. A prompt grown near Claude Code's compaction is
// sent untrimmed without the setting, the cache check holding the trims back,
// and trimmed as on a cold cache with it, which the log records.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

// Two tool results of this many characters take the prompt past 147K tokens
// (167K less the margin) with the second, and back under 125K without the first.
const BIG = 250_000
// A note after each result, so a warm cache would rewrite too much to drop one.
const NOTE = 40_000
// Claude Code's compaction ask, as it opens and as it says what it is.
const ASK = { type: 'text', text: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nThis conversation is being compacted. … inside <summary></summary> tags …' }

// The upstream calls a tool twice, then answers; it counts a prompt's tokens
// as a quarter of its characters, and keeps each request's messages.
async function upstream(): Promise<{ url: string; close(): void; asked: any[][] }> {
  const asked: any[][] = []
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const body = JSON.parse(raw)
      asked.push(body.messages)
      const n = body.messages.filter((m: any) => m.role === 'assistant').length
      const content = n < 2 ? [{ type: 'tool_use', id: `t${n + 1}`, name: 'Read', input: {} }] : [{ type: 'text', text: 'Done.' }]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, content, stop_reason: n < 2 ? 'tool_use' : 'end_turn', usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 20 } }))
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, close: () => server.close(), asked }
}

const lines = (dir: string) => {
  const logs = path.join(dir, 'logs')
  if (!existsSync(logs)) return []
  return readdirSync(logs).flatMap((key) => {
    const file = path.join(logs, key, 'step_events.jsonl')
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l)) : []
  })
}

async function until(done: () => boolean, what: string) {
  for (let t = 0; !done(); t++) {
    if (t === 800) throw new Error(`timed out waiting for ${what}`)
    await new Promise((ok) => setTimeout(ok, 25))
  }
}

// One turn of two tool calls through the proxy, with the setting or without:
// the messages upstream got last, and the step events.
async function run(setting: boolean, compacting = false): Promise<{ last: any[]; events: any[] }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'autocompact-e2e-'))
  const up = await upstream()
  const policy = path.join(dir, 'policy.json')
  writeFileSync(policy, JSON.stringify({
    conversation_shaver_rules: { tool: [{ action: 'drop', after: '0 requests' }] },
    tool_shaver_rules: { claude: [] },
    skill_shaver_rules: [],
    ...(setting && { trim_before_autocompact: true }),
  }))
  // A home of its own, whose Claude Code settings put the compaction at 167K
  // (200K less 20K of output less 13K, autocompact.ts), whatever this machine's.
  const home = path.join(dir, 'home')
  mkdirSync(path.join(home, '.claude'), { recursive: true })
  writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: 200_000 }))
  const env = { ...process.env, HOME: home }
  delete env.CLAUDE_CONFIG_DIR
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.ts'), '--port', '0', '--upstream', up.url, '--dir', dir, '--policy', policy, '--log-step-events'], { stdio: ['ignore', 'ignore', 'pipe'], env })
  let err = ''
  try {
    const url = await new Promise<string>((ok, fail) => {
      child.stderr!.on('data', (d) => { err += d; const m = err.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (m) ok(m[1]) })
      child.on('exit', (code) => fail(new Error(`the proxy exited (${code}): ${err}`)))
    })
    const history: any[] = [{ role: 'user', content: [{ type: 'text', text: 'Read the files.' }] }]
    for (let k = 0; k < 3; k++) {
      const last = history.at(-1)
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 's1' },
        body: JSON.stringify({
          model: 'claude-opus-5-5', max_tokens: 1000, metadata: { user_id: JSON.stringify({ session_id: 's1' }) },
          system: [{ type: 'text', text: 'You are Claude Code.' }],
          tools: [{ name: 'Read', description: 'Reads a file.', input_schema: { type: 'object', properties: {} } }],
          messages: [...history.slice(0, -1), { ...last, content: [...last.content.slice(0, -1), { ...last.content.at(-1), cache_control: { type: 'ephemeral' } }] }],
        }),
      })
      assert.equal(r.status, 200)
      const { content } = await r.json()
      await until(() => lines(dir).filter((l) => l.event === 'request').length > k, `request ${k + 1}'s line`)
      history.push({ role: 'assistant', content })
      if (content[0].type === 'tool_use') history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: content[0].id, content: String(k).repeat(BIG) }, { type: 'text', text: 'n'.repeat(NOTE) }, ...(compacting && k === 1 ? [ASK] : [])] })
    }
    return { last: up.asked.at(-1)!, events: lines(dir) }
  } catch (e) {
    throw new Error(`${e}\n${err}`)
  } finally {
    child.kill()
    up.close()
  }
}

const results = (msgs: any[]) => msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === 'tool_result' && String(b.content).length >= BIG)

test('without trim_before_autocompact, a warm cache holds the trims back near the limit', async () => {
  const { last, events } = await run(false)
  assert.equal(results(last).length, 2)
  assert.ok(!events.some((l) => l.event === 'autocompact-trim'))
})

test('with trim_before_autocompact, a prompt near the limit is sent as a cold cache would send it', async () => {
  const { last, events } = await run(true)
  // The first result is due for dropping and gone; the second, just made, kept.
  assert.equal(results(last).length, 1)
  assert.equal(String(results(last)[0].content)[0], '1')
  const [line] = events.filter((l) => l.event === 'autocompact-trim')
  assert.equal(line.at, 167_000)
  assert.ok(line.beforeTokens >= 147_000 && line.afterTokens <= 125_000, JSON.stringify(line))
})

test('with trim_before_autocompact, the compaction request itself is not trimmed for it', async () => {
  const { last, events } = await run(true, true)
  assert.equal(results(last).length, 2)
  assert.ok(!events.some((l) => l.event === 'autocompact-trim'))
})

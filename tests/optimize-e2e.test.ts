// `shaver optimize` end to end: the real proxy, started as its own process,
// in front of a stand-in upstream, sent Claude Code's requests for the offer,
// the answer and the next prompt. It checks what unit tests can't: the
// conversation's key, the stripped commands and the offer held between them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SKILLS = { alpha: 'Alpha line', beta: 'Beta line', gamma: 'Gamma line' }
const LIST = 'The following skills are available for use with the Skill tool:\n\n' +
  Object.keys(SKILLS).map((name) => `- ${name}: ${name} does a long and detailed thing, described here in many more words than it needs`).join('\n')

// The upstream: every request costs a token per 4 bytes of its body, so the
// shorter base measures smaller; the lines fork gets a line for each skill,
// and anything else an OK. It keeps the bodies the proxy sent.
type Upstream = { url: string; bodies: any[]; close(): void }
async function upstream(): Promise<Upstream> {
  const bodies: any[] = []
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const body = JSON.parse(raw)
      bodies.push(body)
      const text = raw.includes('Below is the list of skills') ? JSON.stringify(SKILLS) : 'OK'
      const usage = { input_tokens: Math.ceil(raw.length / 4), output_tokens: 1 }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      event('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], usage: { ...usage, output_tokens: 0 } } })
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
      event('content_block_stop', { index: 0 })
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
      event('message_stop', {})
      res.end()
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, bodies, close: () => server.close() }
}

const freePort = async () => {
  const s = createServer()
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok))
  const { port } = s.address() as { port: number }
  await new Promise((ok) => s.close(ok))
  return port
}

// The proxy, with a policy keeping every skill whole, in a directory of its own.
type Proxy = { url: string; policy: string; child: ChildProcess; err: () => string }
async function proxy(up: string): Promise<Proxy> {
  const dir = mkdtempSync(path.join(tmpdir(), 'optimize-e2e-'))
  const policy = path.join(dir, 'policy.json')
  writeFileSync(policy, JSON.stringify({ skill_shaver_rules: [{ name: '*', action: 'keep' }] }, null, 2) + '\n')
  const port = await freePort()
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.ts'), '--port', String(port), '--upstream', up, '--dir', dir, '--policy', policy], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  await new Promise<void>((ok, fail) => {
    child.stderr!.on('data', (d) => {
      err += d
      if (err.includes('listening on')) ok()
    })
    child.on('exit', (code) => fail(new Error(`the proxy exited (${code}): ${err}`)))
  })
  return { url: `http://127.0.0.1:${port}`, policy, child, err: () => err }
}

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })

// The messages as Claude Code sends them: the skill list follows the first
// message, as blocks only when it's last, then, with tool search on, the
// deferred tools' list; and the last two messages carry cache breakpoints on
// their last blocks.
const DEFERRED = 'Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\nWebSearch\n'
function laidOut(messages: object[], search: boolean): object[] {
  const all = [
    messages[0],
    { role: 'system', content: messages.length > 1 || search ? LIST : [{ type: 'text', text: LIST }] },
    ...(search ? [{ role: 'system', content: messages.length > 1 ? DEFERRED : [{ type: 'text', text: DEFERRED }] }] : []),
    ...messages.slice(1),
  ]
  return all.map((m, i) => {
    const { content, ...rest } = m as { content: string | object[] }
    if (i < all.length - 2 || typeof content === 'string') return m
    return { ...rest, content: content.map((b, j) => (j === content.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b)) }
  })
}

// Sends Claude Code's request with `messages` around the skill list, with
// tool search on if `search`, and returns the text of the streamed answer.
async function send(p: Proxy, messages: object[], search: boolean): Promise<string> {
  const body = {
    model: 'claude-opus-5-5', max_tokens: 1000, stream: true,
    metadata: { user_id: JSON.stringify({ session_id: 's1' }) },
    system: [{ type: 'text', text: 'You are Claude Code.' }],
    tools: ['Bash', 'Read', 'Agent', ...(search ? ['ToolSearch'] : [])].map((name) => ({ name, description: `The ${name} tool.`, input_schema: { type: 'object', properties: {} } })),
    messages: laidOut(messages, search),
  }
  const r = await fetch(`${p.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 's1' }, body: JSON.stringify(body) })
  assert.equal(r.status, 200)
  let text = ''
  for (const line of (await r.text()).split('\n')) {
    if (!line.startsWith('data: ')) continue
    const d = JSON.parse(line.slice(6))
    if (d.delta?.type === 'text_delta') text += d.delta.text
  }
  return text
}

// Runs `steps` of prompts, each sent after the history so far with the
// replies as the answers to them, and returns the replies.
async function converse(p: Proxy, prompts: string[], search: boolean): Promise<string[]> {
  const history: object[] = []
  const replies: string[] = []
  for (const prompt of prompts) {
    // Claude Code's first message carries its reminder before the prompt.
    history.push(history.length ? user(prompt) : { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nContext for the session.\n</system-reminder>' }, { type: 'text', text: prompt }] })
    const reply = await send(p, history, search)
    replies.push(reply)
    history.push(assistant(reply))
  }
  return replies
}

const stubbed = (policy: string) => JSON.parse(readFileSync(policy, 'utf8')).skill_shaver_rules.filter((r: { text?: string }) => r.text).map((r: { name: string }) => r.name)
const listSent = (up: Upstream) => JSON.stringify(up.bodies.at(-1).messages.find((m: { role: string }) => m.role === 'system'))

async function scenario(prompts: string[], search = false) {
  const up = await upstream()
  const p = await proxy(up.url)
  try {
    const replies = await converse(p, prompts, search)
    return { replies, picked: stubbed(p.policy), sent: listSent(up), tools: up.bodies.at(-1).tools, policy: JSON.parse(readFileSync(p.policy, 'utf8')) }
  } finally {
    p.child.kill()
    rmSync(path.dirname(p.policy), { recursive: true, force: true })
    up.close()
  }
}

test('optimize offers a numbered table, and the answer trims the skills picked from the next request', async () => {
  const { replies, picked, sent } = await scenario(['hello', 'shaver optimize', '1 3', 'carry on'])
  assert.match(replies[1], /^Tool search is off/)
  assert.match(replies[1], /\| 1\. alpha \| No \| Alpha line \|/)
  assert.match(replies[1], /Which skills should be trimmed\?/)
  assert.match(replies[2], /^Modified 2 skills in shaver policy file\./)
  assert.deepEqual(picked, ['alpha', 'gamma'])
  assert.ok(sent.includes('- alpha: Alpha line') && sent.includes('- gamma: Gamma line'))
  assert.ok(!sent.includes('- beta: Beta line'))
})

test('an answer with a range and commas trims every skill it names', async () => {
  const { replies, picked } = await scenario(['hello', 'shaver optimize', '1,2-3', 'carry on'])
  assert.match(replies[2], /^Modified 3 skills in shaver policy file\./)
  assert.deepEqual(picked, ['alpha', 'beta', 'gamma'])
})

test('an invalid answer asks again, and the next one applies', async () => {
  // A reply that isn't an answer stays with the proxy too: it, not the
  // model, asks again.
  const { replies, picked } = await scenario(['hello', 'shaver optimize', '3-1', 'trim them', '2'])
  for (const reply of replies.slice(2, 4)) assert.match(reply, /^All numbers must be between 1 and 3\. Ranges must be stated as X-Y, smaller number first\. Keywords are: all \/ none \/ keep\./)
  assert.deepEqual(picked, ['beta'])
})

test('with tool search on, tools are asked about first and the skills, worked out meanwhile, next', async () => {
  const { replies, picked, tools, policy } = await scenario(['hello', 'shaver optimize', '1', '1 3', 'carry on'], true)
  assert.match(replies[1], /^Analyzing tools\.\.\./)
  assert.match(replies[1], /\| 1\. Agent \| No \|/)
  assert.match(replies[1], /Which tools should be deferred\?/)
  assert.ok(!replies[1].includes('alpha'))
  assert.match(replies[2], /^Modified 1 tool in shaver policy file\.\n.*\n\nAnalyzing skills\.\.\./)
  assert.match(replies[2], /\| 1\. alpha \| No \| Alpha line \|/)
  assert.match(replies[2], /Which skills should be trimmed\?/)
  assert.match(replies[3], /^Modified 2 skills/)
  assert.deepEqual(picked, ['alpha', 'gamma'])
  assert.deepEqual(Object.keys(policy.tool_shaver_rules), ['claude'])
  assert.equal(policy.tool_shaver_rules.claude.at(-1).name, '*')
  assert.equal(tools.find((t: { name: string }) => t.name === 'Agent').defer_loading, true)
})

test('optimize as the first prompt applies its answer', async () => {
  const { replies, picked } = await scenario(['shaver optimize', 'all'])
  assert.match(replies[1], /^Modified 3 skills/)
  assert.deepEqual(picked, ['alpha', 'beta', 'gamma'])
})

test('a request with no tools, sent as it came, is journaled without an error', async () => {
  const up = await upstream()
  const p = await proxy(up.url)
  try {
    const body = { model: 'claude-opus-5-5', max_tokens: 100, stream: true, messages: [user('Write a title for this conversation.')] }
    const r = await fetch(`${p.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 's1' }, body: JSON.stringify(body) })
    assert.equal(r.status, 200)
    await r.text()
    await new Promise((ok) => setTimeout(ok, 100))
    assert.equal(p.child.exitCode, null)
    assert.doesNotMatch(p.err(), /Error/)
  } finally {
    p.child.kill()
    rmSync(path.dirname(p.policy), { recursive: true, force: true })
    up.close()
  }
})

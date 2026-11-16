#!/usr/bin/env node
// Measures a model's prompt-cache lookback and TTL through Codex itself, so
// the requests are the ones Codex makes, on Codex's own auth and route. It
// needs nothing from this repo: it runs Codex with its base URL set to a
// small forwarder of its own, which passes each request on to --upstream and
// reads the usage of each answer (input and cached tokens).
//
//   lookback: one session grows to --runs tool results (`cat sN`, about 250
//     tokens each, unique to the run), then is resumed once per k, largest
//     first. Each resume's first request has the item k runs before its end
//     changed. If the model still reads the prefix before that item, the
//     cache looked back at least k runs; if it reads nothing (or only an
//     earlier probe's shorter prefix), it didn't. A run is a stretch of
//     input items between model outputs: a prompt, or a batch of tool results.
//   ttl: one short session per gap, all side by side; each is resumed after
//     its gap, and the read shows whether the entry was still there.
//
// usage: probe-codex-model-details.ts lookback|ttl --model M [options]
//   lookback  [--runs 80] [--k 70,55,51,49,45,21,19,10]
//   ttl       [--gaps 1,20,40,70]       minutes
//   --upstream URL   default https://chatgpt.com/backend-api/codex (ChatGPT sign-in)
//   --codex PATH     default codex
import http from 'node:http'
import { spawn } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

const [mode, ...rest] = process.argv.slice(2)
const opt = (name: string, def: string) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : def
}
const model = opt('model', '')
if (!['lookback', 'ttl'].includes(mode) || !model) {
  console.error('usage: probe-codex-model-details.ts lookback|ttl --model M [--runs 80] [--k 70,...] [--gaps 1,20,...] [--upstream URL] [--codex PATH]')
  process.exit(2)
}
const upstream = opt('upstream', 'https://chatgpt.com/backend-api/codex').replace(/\/$/, '')
const codexPath = opt('codex', 'codex')
const nums = (s: string) => s.split(',').map(Number)

type Item = { type?: string; role?: string; output?: unknown; content?: { type: string; text?: string }[] }
type Seen = { session: string; items: number; input: number; cached: number; edited?: number }
const seen: Seen[] = []
// A probe's edit: the session it's for and k. Used once, on that session's next request.
const edits = new Map<string, number>()

const isInput = (it: Item) => it.type === 'function_call_output' || it.type === 'custom_tool_call_output' || (it.type === 'message' && it.role !== 'assistant')
// The last item of each run, oldest first.
function runEnds(input: Item[]): number[] {
  const ends: number[] = []
  input.forEach((it, i) => {
    if (isInput(it) && !(input[i + 1] && isInput(input[i + 1]))) ends.push(i)
  })
  return ends
}
function mark(it: Item) {
  const note = '\n(changed by the lookback probe)'
  if (typeof it.output === 'string') it.output += note
  else if (it.content?.length) it.content.push({ type: 'input_text', text: note })
  else it.output = JSON.stringify(it.output) + note
}

const HOP = new Set(['host', 'connection', 'content-length', 'content-encoding', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'upgrade'])
const server = http.createServer(async (req, res) => {
  // Codex tries a WebSocket first; refused, it falls back to HTTP, whose bodies can be read.
  if (req.headers.upgrade) return void res.writeHead(426).end()
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c)
  let raw = Buffer.concat(chunks)
  if (req.headers['content-encoding'] === 'zstd') raw = zstdDecompressSync(raw)
  let body: { input?: Item[]; prompt_cache_key?: string } | undefined
  try {
    body = JSON.parse(raw.toString())
  } catch {}
  let rec: Seen | undefined
  if (body && Array.isArray(body.input)) {
    rec = { session: body.prompt_cache_key ?? String(req.headers['session_id'] ?? '?'), items: body.input.length, input: 0, cached: 0 }
    const k = edits.get(rec.session)
    if (k !== undefined) {
      edits.delete(rec.session)
      const ends = runEnds(body.input)
      rec.edited = ends[ends.length - k]
      if (rec.edited === undefined) throw new Error(`only ${ends.length} runs, can't change the one ${k} back`)
      mark(body.input[rec.edited])
      raw = Buffer.from(JSON.stringify(body))
    }
  }
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v
  const up = await fetch(upstream + req.url, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : raw })
  const out: Record<string, string> = {}
  up.headers.forEach((v, k) => {
    if (!HOP.has(k)) out[k] = v
  })
  res.writeHead(up.status, out)
  let text = ''
  const dec = new TextDecoder()
  for await (const c of up.body ?? []) {
    res.write(c)
    if (rec) text += dec.decode(c, { stream: true })
  }
  res.end()
  if (!rec) return
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      const ev = JSON.parse(line.slice(6))
      const u = ev.type === 'response.completed' ? ev.response?.usage : undefined
      if (u) {
        rec.input = u.input_tokens
        rec.cached = u.input_tokens_details?.cached_tokens ?? 0
        seen.push(rec)
      }
    } catch {}
  }
  if (!rec.input && up.status !== 200) console.error(`  upstream ${up.status}: ${text.slice(0, 300)}`)
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port

const dir = mkdtempSync(join(tmpdir(), 'probe-codex-'))
const nonce = randomBytes(6).toString('hex')
// sN: about 250 tokens of hex words, unique to this probe and to N.
for (let n = 1; n <= 200; n++) {
  const words = Array.from({ length: 40 }, (_, i) => createHash('sha256').update(`${nonce}-${n}-${i}`).digest('hex').slice(0, 16))
  writeFileSync(join(dir, `s${n}`), `step ${n}\n${words.join(' ')}\n`)
}

// Runs Codex once; resolves to its session id.
function codex(prompt: string, resume?: string): Promise<string> {
  const args = ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-C', dir, '-m', model, '-c', `openai_base_url="http://127.0.0.1:${port}"`]
  if (resume) args.push('resume', resume)
  args.push(prompt)
  return new Promise((resolve, reject) => {
    const p = spawn(codexPath, args, { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    p.stdout.on('data', (c) => (out += c))
    p.on('close', (code) => {
      const id = out.match(/"thread_id":"([^"]+)"/)?.[1] ?? resume
      if (code === 0 && id) resolve(id)
      else reject(new Error(`codex exited ${code}: ${out.slice(-500)}`))
    })
  })
}
const of = (id: string) => seen.filter((s) => s.session === id)
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '-')
const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`

if (mode === 'lookback') {
  const runs = Number(opt('runs', '80'))
  const ks = nums(opt('k', '70,55,51,49,45,21,19,10')).sort((a, b) => b - a)
  const t0 = Date.now()
  const id = await codex(`For N from 1 to ${runs}, run \`cat sN\` with the shell: exactly one call per step, in order, waiting for each result before the next. Never combine steps. Then reply DONE.`)
  const build = of(id)
  const outputs = build.length - 1
  console.log(`session ${id}: ${build.length} requests (wanted ${runs + 1}), built in ${minutes(Date.now() - t0)}`)
  console.log(`build reads: ${build.map((s) => pct(s.cached, s.input)).join(' ')}`)
  if (outputs < Math.max(...ks)) console.log(`warning: fewer tool results than the largest k`)
  console.log('\n  k   changed item   prefix before it   read   share   earlier probe read')
  let floor = 0
  for (const k of ks) {
    edits.set(id, k)
    await codex('Reply OK.', id)
    const probe = of(id).filter((s) => s.edited !== undefined).at(-1)!
    // The longest prefix cached before the change: the biggest earlier request that ended before it.
    const prefix = Math.max(0, ...of(id).filter((s) => s !== probe && s.items <= probe.edited!).map((s) => s.input))
    console.log(`${String(k).padStart(3)}   ${String(probe.edited).padStart(12)}   ${String(prefix).padStart(16)}   ${String(probe.cached).padStart(6)}   ${pct(probe.cached, prefix).padStart(5)}   ${String(floor).padStart(18)}`)
    floor = probe.cached
  }
  console.log(`\nA read near the prefix: the cache looked back at least k runs. Near 0, or near the earlier probe's read: it didn't. Elapsed ${minutes(Date.now() - t0)}.`)
} else {
  const gaps = nums(opt('gaps', '1,20,40,70'))
  console.log(`one session per gap (${gaps.join(', ')} min), side by side; done in about ${Math.max(...gaps)} min`)
  const rows = await Promise.all(
    gaps.map(async (g) => {
      const id = await codex('Run `cat s1` with the shell, then reply DONE.')
      const before = of(id).at(-1)!
      await new Promise((r) => setTimeout(r, g * 60_000))
      await codex('Reply OK.', id)
      const after = of(id).find((s) => s !== before && s.items > before.items)!
      return { g, id, last: before.input, read: after.cached }
    }),
  )
  console.log('\ngap (min)   last request   read after gap   share')
  for (const r of rows) console.log(`${String(r.g).padStart(9)}   ${String(r.last).padStart(12)}   ${String(r.read).padStart(14)}   ${pct(r.read, r.last).padStart(5)}`)
}
server.close()

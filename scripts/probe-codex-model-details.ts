// Measures a model's prompt-cache lookback and TTL through Codex itself, so
// the requests are the ones Codex makes, on Codex's own auth and route. It
// needs nothing from this repo: it runs Codex with its base URL set to a
// small forwarder of its own, which passes each request on to --upstream and
// reads the usage of each answer (input and cached tokens).
//
//   lookback: for each of --sizes, side by side, one session grows to --runs
//     tool results (`cat sN`, about that many tokens each, unique to the
//     run), then is resumed once per k, largest first. Each resume's first request has the item k runs before its end
//     changed. If the model still reads the prefix before that item, the
//     cache looked back at least k runs; if it reads nothing (or only an
//     earlier probe's shorter prefix), it didn't. A run is a stretch of
//     input items between model outputs: a prompt, or a batch of tool results.
//     Each size's edge is between its largest k read before its smallest k
//     not read. Whether the limit counts runs or tokens shows across sizes: a
//     limit in runs keeps its edge at the same k, one in tokens at the same
//     "tokens after it" (the request's input from the changed item on). A probe
//     can move a later one's edge by a run (its own prompt is a run that the
//     cache never saw unchanged), so the edges may differ by one.
//   ttl: one short session per gap, all side by side; each is resumed after
//     its gap, and the read shows whether the entry was still there.
//
// Usage: bin/node-wrapper scripts/probe-codex-model-details.ts lookback|ttl --model M [options]
//   lookback  [--runs 80] [--k 70,55,51,49,45,21,19,10] [--sizes 250,1000]
//   ttl       [--gaps 1,20,40,70]       minutes
//   --upstream URL   default https://chatgpt.com/backend-api/codex (ChatGPT sign-in)
//   --codex PATH     default codex, as the user's shell has it (alias, function or PATH)
//   --wrapper-var NAME --real-codex PATH
//                    for a wrapper that runs the Codex named in $NAME (say
//                    MY_CODEX_PATH) and gives it a provider of its own:
//                    NAME is set to a stand-in for the Codex at PATH, which
//                    sends each provider's base URL through the forwarder
//                    instead, the provider's own named in the path (/via/)
import http from 'node:http'
import { spawn } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

const [mode, ...rest] = process.argv.slice(2)
const opt = (name: string, def: string) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : def
}
const model = opt('model', '')
const wrapperVar = opt('wrapper-var', '')
const realCodex = opt('real-codex', '')
if (!['lookback', 'ttl'].includes(mode) || !model || !wrapperVar !== !realCodex) {
  console.error('usage: probe-codex-model-details.ts lookback|ttl --model M [--runs 80] [--k 70,...] [--sizes 250,1000] [--gaps 1,20,...] [--upstream URL] [--codex PATH] [--wrapper-var NAME --real-codex PATH]')
  process.exit(2)
}
const upstream = opt('upstream', 'https://chatgpt.com/backend-api/codex').replace(/\/$/, '')
const codexPath = opt('codex', 'codex')
const VIA = /^\/via\/([^/?#]*)(.*)$/
// A word for bash, single-quoted.
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
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
  // A provider's own base URL, from the stand-in, as src/via.ts reads it. Only
  // for a Host of this machine's, so a web page reaching here by DNS rebinding
  // can't name one.
  const via = VIA.exec(req.url ?? '')
  if (via && req.headers.host !== `127.0.0.1:${port}`) return void res.writeHead(403).end()
  const target = via ? decodeURIComponent(via[1]).replace(/\/$/, '') + via[2] : upstream + req.url
  const up = await fetch(target, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : raw })
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
// A directory of sN files: about `tokens` tokens of hex words each (16 hex
// characters are about 6 tokens), unique to this probe, the size and N.
function files(tokens: number): string {
  const d = join(dir, `t${tokens}`)
  mkdirSync(d)
  for (let n = 1; n <= 200; n++) {
    const words = Array.from({ length: Math.max(1, Math.round(tokens / 6.25)) }, (_, i) => createHash('sha256').update(`${nonce}-${tokens}-${n}-${i}`).digest('hex').slice(0, 16))
    writeFileSync(join(d, `s${n}`), `step ${n}\n${words.join(' ')}\n`)
  }
  return d
}

// The stand-in for --wrapper-var: links to all beside the real Codex, as a
// wrapper may want them beside the Codex it's given (as codex-via-shaver
// --stand-in makes), and in Codex's place a script that rewrites each
// model_providers.P.base_url given to it, turning off P's WebSockets.
const wrapperEnv: Record<string, string> = {}
if (wrapperVar) {
  const sd = join(dir, 'stand-in')
  mkdirSync(sd)
  // After links, as an npm or Homebrew codex is one: the files beside the
  // install, not beside the link. The stand-in lasts only as long as the probe.
  const real = realpathSync(realCodex)
  const from = dirname(real)
  for (const f of readdirSync(from)) if (f !== basename(real)) symlinkSync(join(from, f), join(sd, f))
  const stub = join(sd, basename(realCodex))
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
# Percent-encodes all but unreserved characters (RFC 3986), for a path segment.
enc() {
  local LC_ALL=C s=$1 out= c i
  for ((i = 0; i < \${#s}; i++)); do
    c=\${s:i:1}
    case $c in
      [a-zA-Z0-9.~_-]) out+=$c ;;
      *) printf -v c '%%%02X' "'$c"; out+=$c ;;
    esac
  done
  printf %s "$out"
}
re='^(--config=)?(model_providers\\.([^.=]+)\\.base_url)=(.*)$'
quoted='^"(.*)"$|^'\\''(.*)'\\''$'
args=()
for a in "$@"; do
  if [[ $a =~ $re ]]; then
    pre=\${BASH_REMATCH[1]} key=\${BASH_REMATCH[2]} p=\${BASH_REMATCH[3]} u=\${BASH_REMATCH[4]}
    [[ $u =~ $quoted ]] && u=\${BASH_REMATCH[1]}\${BASH_REMATCH[2]}
    args+=("$pre$key=\\"http://127.0.0.1:${port}/via/$(enc "\${u%/}")\\"" -c "model_providers.$p.supports_websockets=false")
  else
    args+=("$a")
  fi
done
exec ${quote(real)} "\${args[@]}"
`,
    { mode: 0o755 },
  )
  wrapperEnv[wrapperVar] = stub
}

// Stops the probe, as there is nothing to measure: the model refused, or
// Codex's requests never came through the forwarder.
function stop(why: string): never {
  console.error(`probe-codex-model-details: ${why}`)
  process.exit(1)
}

// Runs Codex once; resolves to its session id.
function codex(prompt: string, resume?: string, cwd = dir): Promise<string> {
  const args = ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-C', cwd, '-m', model, '-c', `openai_base_url="http://127.0.0.1:${port}"`]
  if (resume) args.push('resume', resume)
  args.push(prompt)
  return new Promise((resolve, reject) => {
    // Through an interactive login shell, as codex-via-shaver does, so `codex`
    // is what it is at the user's prompt: their alias or function, set up by
    // their profile. Its output is only searched, so a profile's own lines do no harm.
    // A --wrapper-var is set there too, after the profile, which may set it itself.
    const command = codexPath === 'codex' ? 'codex' : quote(codexPath)
    const env = Object.entries(wrapperEnv).map(([k, v]) => `export ${k}=${quote(v)}; `).join('')
    const p = spawn('bash', ['-lic', `${env}${command} "$@"`, 'bash', ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    p.stdout.on('data', (c) => (out += c))
    p.on('close', (code) => {
      const id = out.match(/"thread_id":"([^"]+)"/)?.[1] ?? resume
      const failed = out.match(/"type":"turn\.failed","error":\{"message":"((?:[^"\\]|\\.)*)"/)?.[1]
      if (failed) stop(`Codex's turn failed, so ${model} can't be probed here: ${JSON.parse(`"${failed}"`)}`)
      if (code !== 0 || !id) return reject(new Error(`codex exited ${code}: ${out.slice(-500)}`))
      if (!of(id).length) stop(`Codex answered, but none of its requests came through the forwarder: is it using another model provider than its built-in OpenAI one?`)
      resolve(id)
    })
  })
}
const of = (id: string) => seen.filter((s) => s.session === id)
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '-')
const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`

if (mode === 'lookback') {
  const runs = Number(opt('runs', '80'))
  const ks = nums(opt('k', '70,55,51,49,45,21,19,10')).sort((a, b) => b - a)
  const sizes = nums(opt('sizes', '250,1000'))
  const t0 = Date.now()
  type Row = { k: number; edited: number; prefix: number; after: number; read: number; floor: number; hit: boolean }
  // One size's session and probes; its lines, printed when all are done, as they run side by side.
  async function probe(tokens: number) {
    const cwd = files(tokens)
    const lines: string[] = []
    const id = await codex(`For N from 1 to ${runs}, run \`cat sN\` with the shell: exactly one call per step, in order, waiting for each result before the next. Never combine steps. Then reply DONE.`, undefined, cwd)
    const build = of(id)
    lines.push(`session ${id}: ${build.length} requests (wanted ${runs + 1}), built in ${minutes(Date.now() - t0)}`)
    lines.push(`build reads: ${build.map((s) => pct(s.cached, s.input)).join(' ')}`)
    if (build.length - 1 < Math.max(...ks)) lines.push(`warning: fewer tool results than the largest k`)
    const rows: Row[] = []
    let floor = 0
    for (const k of ks) {
      edits.set(id, k)
      await codex('Reply OK.', id, cwd)
      const probe = of(id).filter((s) => s.edited !== undefined).at(-1)!
      // The longest prefix cached before the change: the biggest earlier request that ended before it.
      const prefix = Math.max(0, ...of(id).filter((s) => s !== probe && s.items <= probe.edited!).map((s) => s.input))
      // Read: all of the prefix but its last part block (cached in blocks of 128 tokens).
      rows.push({ k, edited: probe.edited!, prefix, after: probe.input - prefix, read: probe.cached, floor, hit: prefix > 0 && prefix - probe.cached < 128 })
      floor = probe.cached
    }
    return { tokens, lines, rows }
  }
  const results = await Promise.all(sizes.map(probe))
  const edges = results.map(({ tokens, lines, rows }) => {
    console.log(`\n--- about ${tokens} tokens a run`)
    for (const l of lines) console.log(l)
    console.log('\n  k   changed item   prefix before it   tokens after it   read   share   earlier probe read')
    for (const r of rows) console.log(`${String(r.k).padStart(3)}   ${String(r.edited).padStart(12)}   ${String(r.prefix).padStart(16)}   ${String(r.after).padStart(15)}   ${String(r.read).padStart(6)}   ${pct(r.read, r.prefix).padStart(5)}   ${String(r.floor).padStart(18)}`)
    const miss = rows.filter((r) => !r.hit).at(-1)
    const hit = rows.find((r) => r.hit && (!miss || r.k < miss.k))
    return { tokens, hit, miss }
  })
  const at = (r?: Row) => (r ? `${r.k} (${r.after})` : '-')
  console.log('\nedges:  size   read at k (tokens after)   not read at k (tokens after)')
  for (const e of edges) console.log(`${String(e.tokens).padStart(12)}   ${at(e.hit).padEnd(24)}   ${at(e.miss)}`)
  // Each size's edge as ranges of k and of tokens after, from its read to its
  // miss; one more run of slack in k, as a probe can move a later one's edge.
  const bounded = edges.filter((e) => e.hit && e.miss)
  const overlap = (f: (e: (typeof bounded)[0]) => [number, number]) => Math.max(...bounded.map((e) => f(e)[0])) <= Math.min(...bounded.map((e) => f(e)[1]))
  if (bounded.length < 2) console.log(`\nCan't tell runs from tokens: an edge between a read and a miss is needed at two sizes or more. Choose --k around it.`)
  else {
    const byRuns = overlap((e) => [e.hit!.k, e.miss!.k + 1])
    const byTokens = overlap((e) => [e.hit!.after, e.miss!.after])
    const lo = Math.max(...bounded.map((e) => e.hit!.k))
    console.log(
      byRuns && !byTokens
        ? `\nThe limit counts runs: about ${lo} at every size.`
        : byTokens && !byRuns
          ? `\nThe limit counts tokens: between ${Math.max(...bounded.map((e) => e.hit!.after))} and ${Math.min(...bounded.map((e) => e.miss!.after))} after the change at every size.`
          : byRuns
            ? `\nCan't tell runs from tokens: the edges agree both ways. Choose --sizes further apart, or --k closer to the edge.`
            : `\nThe limit counts neither runs nor tokens alone: the edges agree neither way.`,
    )
  }
  console.log(`Elapsed ${minutes(Date.now() - t0)}.`)
} else {
  const gaps = nums(opt('gaps', '1,20,40,70'))
  // The sN files its sessions cat.
  const cwd = files(250)
  console.log(`one session per gap (${gaps.join(', ')} min), side by side; done in about ${Math.max(...gaps)} min`)
  const rows = await Promise.all(
    gaps.map(async (g) => {
      const id = await codex('Run `cat s1` with the shell, then reply DONE.', undefined, cwd)
      const before = of(id).at(-1)!
      await new Promise((r) => setTimeout(r, g * 60_000))
      await codex('Reply OK.', id, cwd)
      const after = of(id).find((s) => s !== before && s.items > before.items)!
      return { g, id, last: before.input, read: after.cached }
    }),
  )
  console.log('\ngap (min)   last request   read after gap   share')
  for (const r of rows) console.log(`${String(r.g).padStart(9)}   ${String(r.last).padStart(12)}   ${String(r.read).padStart(14)}   ${pct(r.read, r.last).padStart(5)}`)
}
server.close()

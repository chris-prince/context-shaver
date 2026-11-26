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
//     Each session's edge is between its largest k read before its smallest k
//     not read. What the limit counts shows across sessions: one in runs keeps
//     its edge at the same k, one in tokens at the same "tokens after it" (the
//     request's input after the prefix cached before the change), one in items
//     at the same "items after it" (its input items after that prefix's, what
//     the lookback counts back over). A probe can move a later one's edge by a run (its own
//     prompt is a run that the cache never saw unchanged), so the edges in k
//     may differ by one. Sizes tell runs from tokens; --pads tells runs from
//     items: a session with P padding has P short user items after each tool
//     result, the same on every request, so each run has P more items but the
//     runs are as many. There's a session for each size and each padding.
//   ttl: one short session per gap, all side by side; each is resumed after
//     its gap, and the read shows whether the entry was still there.
//   breakpoints: what explicit cache breakpoints (prompt_cache_breakpoint on
//     an input_text part) do. One session of two prompts, the second --runs
//     tool results long, is resumed once; that request is held while it's
//     sent upstream changed, each variant once, in order (each reads what the
//     ones before it left), and then passed on. P is the second prompt, far
//     back; O1 to O5 the outputs after it, each the end of a request of Codex's:
//       same     the request again: read all
//       mark     a breakpoint on P's text: read all if one leaves the prompt as it was
//       miss     O1 changed: read little, as it's past the lookback
//       reach    O1 changed, P marked: read through P if a breakpoint finds an entry far back
//       array    P marked, O1 sent as an array of one input_text part: read all if that's its string's prompt
//       tmark    as array, O2 an array marked
//       treach   as tmark, O3 changed: read through O2 if an output's breakpoint finds its entry
//       read     O4 marked as an array, nothing changed: read all, writing past it
//       onRead   O4 marked, O5 changed: read through O4, as a request of Codex's ended there
//       split    P's text in two parts, the first marked: no request ended there
//       onSplit  as split, O1 changed: read through it only if marking it made an entry
//   boundaries: whether a trim can leave an entry at a breakpoint of its own,
//     far back, for the requests and the trim after it to read (trim.ts,
//     liveEnd). The session is breakpoints' and is held the same way; each
//     variant is the prompt a request of the proxy's would send, in order:
//       same     the request again: read all
//       W-write  O1 changed, O3 marked: a prompt new from O1 on, so read little; it writes past O3
//       W-again  the same, unmarked: read all, as W-write left an entry at its end
//       W-ext    one item more: read through W-write's end, by the lookback
//       W-extM   two items more, O3 marked: read through W-ext's end if the lookback still reads beside a breakpoint
//       T-write  a trim: O5 changed too, O3 and O7 marked: read through O3 if writing past it left an entry
//       T-ext    the request after the trim: O7 marked, one item more: read through T-write's end
//       T-ext2   the next: O7 and T-ext's end marked, one item more: read through T-ext's end
//       F-none   T-ext's prompt unmarked with --lookback + 5 items more: read little, as it's past the lookback
//       F-bound  as many other items more, O7 marked: read through O7 if T-write left an entry there
//       F-both   as many others, O7 and T-ext's end marked: read through T-ext's end
//
// Usage: bin/node-wrapper scripts/probe-codex-model-details.ts lookback|ttl|breakpoints|boundaries --model M [options]
//   lookback     [--runs 80] [--k 70,55,51,49,45,21,19,10] [--sizes 250,1000] [--pads 0,3]
//   ttl          [--gaps 1,20,40,70]       minutes
//   breakpoints  [--runs 100] [--lookback 78]   O1 to O5 must be more than --lookback items from the end
//   boundaries   [--runs 100] [--lookback 78]   O7 too; --lookback is at least the model's
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
if (!['lookback', 'ttl', 'breakpoints', 'boundaries'].includes(mode) || !model || !wrapperVar !== !realCodex) {
  console.error('usage: probe-codex-model-details.ts lookback|ttl|breakpoints|boundaries --model M [--runs 80] [--k 70,...] [--sizes 250,1000] [--gaps 1,20,...] [--lookback 78] [--upstream URL] [--codex PATH] [--wrapper-var NAME --real-codex PATH]')
  process.exit(2)
}
const upstream = opt('upstream', 'https://chatgpt.com/backend-api/codex').replace(/\/$/, '')
const codexPath = opt('codex', 'codex')
const VIA = /^\/via\/([^/?#]*)(.*)$/
// A word for bash, single-quoted.
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
const nums = (s: string) => s.split(',').map(Number)

type Part = { type: string; text?: string; prompt_cache_breakpoint?: unknown }
type Item = { type?: string; role?: string; output?: unknown; content?: Part[] }
type Seen = { session: string; items: number; input: number; cached: number; edited?: number }
const seen: Seen[] = []
// A probe's edit: the session it's for and k. Made on that session's requests
// until one of them completes, so a retried one is edited too.
const edits = new Map<string, number>()
// How many responses each model answered under, as the response names it: one
// name can be served by more than one backend, each answering under a name of
// its own, and the cache can differ between them.
const served = new Map<string, number>()
// For breakpoints and boundaries: the session whose next request is held for the variants,
// sent from the forwarder as Codex waits, as a wrapper's provider may last
// only as long as Codex runs.
let holding: { session: string; variants: (target: string, headers: Record<string, string>, body: { input: Item[] }) => Promise<void> } | undefined

const isInput = (it: Item) => it.type === 'function_call_output' || it.type === 'custom_tool_call_output' || (it.type === 'message' && it.role !== 'assistant')
// The last item of each run, oldest first.
function runEnds(input: Item[]): number[] {
  const ends: number[] = []
  input.forEach((it, i) => {
    if (isInput(it) && !(input[i + 1] && isInput(input[i + 1]))) ends.push(i)
  })
  return ends
}
// A session's padding, named in its prompt, which every request of it has.
const padOf = (raw: string) => Number(/\(lookback probe, padding (\d+)\)/.exec(raw)?.[1] ?? 0)
// Puts `pad` short user items after each tool result, named by its call, so
// every request has them in the same places.
function padded(input: Item[], pad: number): Item[] {
  if (!pad) return input
  return input.flatMap((it) => {
    if (it.type !== 'function_call_output' && it.type !== 'custom_tool_call_output') return [it]
    const call = (it as { call_id?: string }).call_id
    return [it, ...Array.from({ length: pad }, (_, i) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `(probe padding ${i + 1} of ${pad} after ${call}; ignore it)` }] }))]
  })
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
    const pad = padOf(raw.toString())
    if (pad) {
      body.input = padded(body.input, pad)
      raw = Buffer.from(JSON.stringify(body))
    }
    rec = { session: body.prompt_cache_key ?? String(req.headers['session_id'] ?? '?'), items: body.input.length, input: 0, cached: 0 }
    const k = edits.get(rec.session)
    if (k !== undefined) {
      const ends = runEnds(body.input)
      rec.edited = ends[ends.length - k]
      if (rec.edited !== undefined) {
        mark(body.input[rec.edited])
        raw = Buffer.from(JSON.stringify(body))
      }
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
  if (rec && body && holding?.session === rec.session) {
    const { variants } = holding
    holding = undefined
    await variants(target, headers, body as { input: Item[] })
  }
  // A connection the upstream drops is answered 502, which Codex retries, rather than ending the probe.
  const up = await fetch(target, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : raw }).catch((e: Error) => {
    console.error(`  upstream failed: ${e.cause instanceof Error ? e.cause.message : e.message}`)
  })
  if (!up) return void res.writeHead(502).end()
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
        const m = String(ev.response?.model ?? '?')
        served.set(m, (served.get(m) ?? 0) + 1)
        rec.input = u.input_tokens
        rec.cached = u.input_tokens_details?.cached_tokens ?? 0
        seen.push(rec)
        edits.delete(rec.session)
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
// characters are about 6 tokens), unique to this probe, the session and N.
function files(tokens: number, name = `t${tokens}`): string {
  const d = join(dir, name)
  mkdirSync(d)
  for (let n = 1; n <= 200; n++) {
    const words = Array.from({ length: Math.max(1, Math.round(tokens / 6.25)) }, (_, i) => createHash('sha256').update(`${nonce}-${name}-${n}-${i}`).digest('hex').slice(0, 16))
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
  const pads = nums(opt('pads', '0'))
  const t0 = Date.now()
  type Row = { k: number; edited: number; items: number; prefix: number; after: number; read: number; floor: number; hit: boolean }
  // One session's build and probes, at a size and padding; its lines, printed
  // when all are done, as they run side by side.
  async function probe(tokens: number, pad: number) {
    const name = `t${tokens}p${pad}`
    const cwd = files(tokens, name)
    const lines: string[] = []
    const id = await codex(`For N from 1 to ${runs}, run \`cat sN\` with the shell: exactly one call per step, in order, waiting for each result before the next. Never combine steps. Then reply DONE. (lookback probe, padding ${pad})`, undefined, cwd)
    const build = of(id)
    lines.push(`session ${id}: ${build.length} requests (wanted ${runs + 1}), built in ${minutes(Date.now() - t0)}`)
    lines.push(`build reads: ${build.map((s) => pct(s.cached, s.input)).join(' ')}`)
    // A session that stopped short (the model combined or skipped steps) is probed only within its runs.
    const within = ks.filter((k) => k < build.length)
    if (within.length < ks.length) lines.push(`warning: only ${build.length - 1} tool results, so k ${ks.filter((k) => k >= build.length).join(', ')} not probed`)
    const rows: Row[] = []
    let floor = 0
    for (const k of within) {
      edits.set(id, k)
      const sent = of(id).length
      await codex('Reply OK.', id, cwd)
      // This k's edited request, never an earlier probe's.
      const probe = of(id).slice(sent).find((s) => s.edited !== undefined)
      edits.delete(id)
      if (!probe) {
        lines.push(`warning: no request was changed at k ${k} (too few runs, or none completed), so it isn't probed`)
        continue
      }
      // The longest prefix cached before the change: the biggest earlier request that ended before it.
      const entry = of(id)
        .filter((s) => s !== probe && s.items <= probe.edited!)
        .reduce<Seen | undefined>((a, s) => (!a || s.input > a.input ? s : a), undefined)
      const prefix = entry?.input ?? 0
      // Read: all of the prefix but its last part block (cached in blocks of 128 tokens).
      rows.push({ k, edited: probe.edited!, items: probe.items - (entry?.items ?? 0), prefix, after: probe.input - prefix, read: probe.cached, floor, hit: prefix > 0 && prefix - probe.cached < 128 })
      floor = probe.cached
    }
    return { tokens, pad, lines, rows }
  }
  const results = await Promise.all(sizes.flatMap((t) => pads.map((p) => probe(t, p))))
  const edges = results.map(({ tokens, pad, lines, rows }) => {
    console.log(`\n--- about ${tokens} tokens a run, ${pad} padding items a run`)
    for (const l of lines) console.log(l)
    console.log('\n  k   changed item   items after it   prefix before it   tokens after it   read   share   earlier probe read')
    for (const r of rows) console.log(`${String(r.k).padStart(3)}   ${String(r.edited).padStart(12)}   ${String(r.items).padStart(14)}   ${String(r.prefix).padStart(16)}   ${String(r.after).padStart(15)}   ${String(r.read).padStart(6)}   ${pct(r.read, r.prefix).padStart(5)}   ${String(r.floor).padStart(18)}`)
    const miss = rows.filter((r) => !r.hit).at(-1)
    const hit = rows.find((r) => r.hit && (!miss || r.k < miss.k))
    return { tokens, pad, hit, miss }
  })
  const at = (r?: Row) => (r ? `${r.k} (${r.after} tokens, ${r.items} items)` : '-')
  console.log('\nedges:  size   padding   read at k (after it)               not read at k (after it)')
  for (const e of edges) console.log(`${String(e.tokens).padStart(12)}   ${String(e.pad).padStart(7)}   ${at(e.hit).padEnd(33)}   ${at(e.miss)}`)
  // Each session's edge as a range in each unit, from its read to just short
  // of its miss: a limit in that unit is in every session's range. In k, a run
  // of slack, as a probe can move a later one's edge; tokens and items after
  // are measured on the request, so earlier probes' prompts are counted in them.
  const bounded = edges.filter((e) => e.hit && e.miss)
  const units = [
    { unit: 'runs', range: (e: (typeof bounded)[0]): [number, number] => [e.hit!.k, e.miss!.k] },
    { unit: 'tokens', range: (e: (typeof bounded)[0]): [number, number] => [e.hit!.after, e.miss!.after - 1] },
    { unit: 'items', range: (e: (typeof bounded)[0]): [number, number] => [e.hit!.items, e.miss!.items - 1] },
  ].map(({ unit, range }) => ({ unit, lo: Math.max(...bounded.map((e) => range(e)[0])), hi: Math.min(...bounded.map((e) => range(e)[1])) }))
  const fits = units.filter((u) => u.lo <= u.hi)
  const varied = [new Set(bounded.map((e) => e.tokens)).size > 1 && 'sizes', new Set(bounded.map((e) => e.pad)).size > 1 && 'paddings'].filter(Boolean)
  // Every read and miss, not only the edges: a limit in a unit is above each
  // read and below each miss, so a miss at or below a read in every unit, in
  // one session or across them, means the reads come and go (a cache routed
  // across machines, say) and no limit can be told from more --k.
  const rows = results.flatMap((r) => r.rows)
  const values = { runs: (r: Row) => r.k, tokens: (r: Row) => r.after, items: (r: Row) => r.items }
  const steady = Object.values(values).some((v) => Math.max(...rows.filter((r) => r.hit).map(v)) < Math.min(...rows.filter((r) => !r.hit).map(v)))
  if (!steady)
    console.log(`\nThe reads aren't steady: in each of runs, tokens and items, a miss came at or below a read. Probe again to see if it repeats; a limit can't be told from these.`)
  else if (bounded.length < 2) console.log(`\nCan't tell what the limit counts: an edge between a read and a miss is needed in two sessions or more. Choose --k around it.`)
  else if (fits.length === 1) console.log(`\nThe limit counts ${fits[0].unit}: ${fits[0].lo === fits[0].hi ? fits[0].lo : `between ${fits[0].lo} and ${fits[0].hi}`} after the change in every session.`)
  else if (fits.length)
    console.log(`\nCan't tell ${fits.map((u) => u.unit).join(' from ')}: the edges agree in each. ${varied.length < 2 ? `Vary ${varied.includes('sizes') ? '--pads' : '--sizes'} too, or c` : 'C'}hoose --k closer to the edges.`)
  else console.log(`\nThe limit counts none of runs, tokens or items alone: the edges agree in none.`)
  console.log(`Answered as ${[...served].map(([m, n]) => `${m} (${n})`).join(', ') || 'nothing'}.`)
  console.log(`Elapsed ${minutes(Date.now() - t0)}.`)
} else if (mode === 'breakpoints' || mode === 'boundaries') {
  const runs = Number(opt('runs', '100'))
  const lookback = Number(opt('lookback', '78'))
  const cwd = files(250)
  const t0 = Date.now()
  const steps = (from: number, to: number) => `For N from ${from} to ${to}, run \`cat sN\` with the shell: exactly one call per step, in order, waiting for each result before the next. Never combine steps. Then reply DONE.`
  const id = await codex(steps(1, 10), undefined, cwd)
  await codex(steps(11, 10 + runs), id, cwd)
  const MARK = { mode: 'explicit' }
  const isOutput = (it: Item) => it.type === 'function_call_output' || it.type === 'custom_tool_call_output'
  // The input tokens through an item: of the request of Codex's that ended with it.
  const through = (i: number) => of(id).find((s) => s.items === i + 1)?.input ?? 0
  holding = {
    session: id,
    variants: async (target, headers, T) => {
      const p = T.input.findIndex((it) => it.type === 'message' && it.role === 'user' && it.content?.some((q) => q.text?.startsWith('For N from 11')))
      if (p < 0) stop("the second prompt isn't in the request")
      const o = T.input.flatMap((it, i) => (isOutput(it) && i > p ? [i] : []))
      const far = mode === 'breakpoints' ? 5 : 7
      if (o.length < far || T.input.length - o[far - 1] <= lookback) stop(`too few outputs more than ${lookback} items from the end: give more --runs`)
      const markP = (b: { input: Item[] }) => void (b.input[p].content!.at(-1)!.prompt_cache_breakpoint = MARK)
      const change = (b: { input: Item[] }, i: number) => mark(b.input[i])
      const asArray = (b: { input: Item[] }, i: number, marked = false) => {
        const it = b.input[i]
        // Codex sends an output as a string or, since about 0.170, as parts
        // already: then its last part is the one marked.
        if (typeof it.output === 'string') it.output = [{ type: 'input_text', text: it.output, ...(marked && { prompt_cache_breakpoint: MARK }) }]
        else if (marked && Array.isArray(it.output)) it.output.at(-1)!.prompt_cache_breakpoint = MARK
      }
      const split = (b: { input: Item[] }) => {
        const it = b.input[p]
        const t = it.content!.at(-1)!.text!
        const k = Math.floor(t.length / 2)
        it.content = [...it.content!.slice(0, -1), { type: 'input_text', text: t.slice(0, k), prompt_cache_breakpoint: MARK }, { type: 'input_text', text: t.slice(k) }]
      }
      // For boundaries: a change named by its tag, so that variants with the
      // same changes send the same prompt; a short user item at the end, as a
      // later request would have added, marked or not; and n of them.
      const tagged = (b: { input: Item[] }, i: number, tag: string) => {
        const it = b.input[i]
        if (typeof it.output === 'string') it.output += `\n(changed ${tag})`
        else if (Array.isArray(it.output)) (it.output as Part[]).at(-1)!.text += `\n(changed ${tag})`
        else stop('an output is neither a string nor parts')
      }
      const add = (b: { input: Item[] }, tag: string, marked = false) => void b.input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Reply OK. (${tag})`, ...(marked && { prompt_cache_breakpoint: MARK }) }] })
      const many = (b: { input: Item[] }, tag: string) => { for (let i = 0; i < lookback + 5; i++) add(b, `${tag}${i}`) }
      const [o1, o2, o3, o4, o5, , o7] = o
      const boundaries: [string, (b: { input: Item[] }) => void][] = [
        ['same', () => {}],
        ['W-write', (b) => (tagged(b, o1, 'w'), asArray(b, o3, true))],
        ['W-again', (b) => tagged(b, o1, 'w')],
        ['W-ext', (b) => (tagged(b, o1, 'w'), add(b, 'x1'))],
        ['W-extM', (b) => (tagged(b, o1, 'w'), asArray(b, o3, true), add(b, 'x1'), add(b, 'x2'))],
        ['T-write', (b) => (tagged(b, o1, 'w'), asArray(b, o3, true), tagged(b, o5, 't'), asArray(b, o7, true))],
        ['T-ext', (b) => (tagged(b, o1, 'w'), tagged(b, o5, 't'), asArray(b, o7, true), add(b, 'y1'))],
        ['T-ext2', (b) => (tagged(b, o1, 'w'), tagged(b, o5, 't'), asArray(b, o7, true), add(b, 'y1', true), add(b, 'y2'))],
        ['F-none', (b) => (tagged(b, o1, 'w'), tagged(b, o5, 't'), add(b, 'y1'), many(b, 'z'))],
        ['F-bound', (b) => (tagged(b, o1, 'w'), tagged(b, o5, 't'), asArray(b, o7, true), add(b, 'y1'), many(b, 'q'))],
        ['F-both', (b) => (tagged(b, o1, 'w'), tagged(b, o5, 't'), asArray(b, o7, true), add(b, 'y1', true), many(b, 'r'))],
      ]
      const breakpoints: [string, (b: { input: Item[] }) => void][] = [
        ['same', () => {}],
        ['mark', markP],
        ['miss', (b) => change(b, o1)],
        ['reach', (b) => (markP(b), change(b, o1))],
        ['array', (b) => (markP(b), asArray(b, o1))],
        ['tmark', (b) => (markP(b), asArray(b, o1), asArray(b, o2, true))],
        ['treach', (b) => (markP(b), asArray(b, o1), asArray(b, o2, true), change(b, o3))],
        ['read', (b) => asArray(b, o4, true)],
        ['onRead', (b) => (asArray(b, o4, true), change(b, o5))],
        ['split', split],
        ['onSplit', (b) => (split(b), change(b, o1))],
      ]
      const variants = mode === 'breakpoints' ? breakpoints : boundaries
      const from = (i: number) => `item ${i}, ${T.input.length - i} from the end, ${through(i)} tokens through it`
      console.log(`session ${id}: ${T.input.length} items; P ${from(p)}; ${(mode === 'breakpoints' ? [1, 2, 3, 4, 5] : [1, 3, 5, 7]).map((n) => `O${n} ${from(o[n - 1])}`).join('; ')}\n`)
      console.log('variant   status    input   cached   share')
      for (const [name, f] of variants) {
        const b = structuredClone(T)
        f(b)
        const r = await fetch(target, { method: 'POST', headers, body: JSON.stringify(b) }).catch((e: Error) => stop(`upstream failed: ${e.message}`))
        const text = await r.text()
        let u: { input_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | undefined
        for (const line of text.split('\n'))
          if (line.startsWith('data: '))
            try {
              const ev = JSON.parse(line.slice(6))
              if (ev.type === 'response.completed') u = ev.response?.usage
            } catch {}
        const input = u?.input_tokens ?? 0
        const cached = u?.input_tokens_details?.cached_tokens ?? 0
        console.log(`${name.padEnd(8)}  ${String(r.status).padStart(6)}   ${String(input).padStart(6)}   ${String(cached).padStart(6)}   ${pct(cached, input).padStart(5)}`)
        if (!u) console.log(`          ${text.slice(0, 400).replaceAll('\n', ' ')}`)
      }
    },
  }
  await codex('Reply OK.', id, cwd)
  if (holding) stop("none of Codex's requests came through the forwarder after the session was built")
  console.log(`\nAnswered as ${[...served].map(([m, n]) => `${m} (${n})`).join(', ') || 'nothing'}.`)
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

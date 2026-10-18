// Backtests how many later requests a trim's savings are counted over (the
// horizon H in trim.ts, decide). Each logged conversation's requests are
// rebuilt untrimmed, as in replay.ts, then trimmed afresh under the live
// policy with each horizon: K, and N x the requests so far for several N. Each
// request is priced with the cache model (positionsOf, readThrough) and its
// model's prices, in characters at the input price. Only the messages are
// priced: the base is the same under every horizon. The model's actions are
// held fixed, so a trim never makes it fetch again what was taken. The
// anchor goes on as in server.ts (prepare), assuming a spare breakpoint, and
// so do summary records: each one from when it was made, applied on a cold
// cache. A record a later one replaced isn't kept, so it is missed while it
// stood. The rebuild uses the messages as received where they were logged
// (server.ts, received), and as sent before that.
// Usage: bin/node-wrapper scripts/backtest-horizon.ts [--since ISO] [--until ISO] [--first n] [--out file.jsonl] [proxy-data/logs/<conversation> ...]
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { clockOf, heldTo, type ApiMsg, type Block, type Clock } from '../src/items.ts'
import { harnessOf, NO_CONVENTIONS, type Harness } from '../src/harness.ts'
import { modelOf, type Model } from '../src/models.ts'
import { loadPolicy } from '../src/policy.ts'
import { promptHash, promptsOf, summarized, validChain, type Summary } from '../src/summary.ts'
import { kinds, receivedOf } from '../src/log.ts'
import { anchored, apply, transitions, decide, fullyTrimmed, K, positionsOf, readThrough, settledEnd } from '../src/trim.ts'

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args.splice(i, 2)[1]
}
const compare = args.includes('--compare') && !!args.splice(args.indexOf('--compare'), 1)
const since = opt('--since') ?? ''
const until = opt('--until') ?? '9999'
const outFile = opt('--out')
const first = Number(opt('--first') ?? Infinity)
const root = path.join(import.meta.dirname, '..')
const policy = loadPolicy(path.join(root, 'policy.json'))!
const dirs = args.length ? args : readdirSync(path.join(root, 'proxy-data/logs'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, 'proxy-data/logs', d.name))

const HORIZONS: [string, (n: number) => number][] = [
  ['none', () => -1], [`K=${K}`, () => K], ['K=20', () => 20],
  ...[0.3, 0.4, 0.5, 0.6, 0.7].map((c): [string, (n: number) => number] => [`min(20,${c}n)`, (n) => Math.min(20, c * n)]),
]
// --horizons '[[label, [[from, k, slope], ...]], ...]': piecewise-linear
// horizons over request numbers r = n + 1, each segment running from its
// first request with K = k + slope * (r - from).
const pieces = opt('--horizons')
if (pieces) HORIZONS.splice(2, Infinity, ...(JSON.parse(pieces) as [string, [number, number, number][]][]).map(([label, segs]): [string, (n: number) => number] =>
  [label, (n) => { const [from, k, slope] = segs.findLast(([f]) => f <= n + 1)!; return Math.max(0, k + slope * (n + 1 - from)) }]))

// A message as sent without breakpoints (replay.ts, strip).
function strip(m: ApiMsg): ApiMsg {
  if (typeof m.content === 'string') return m
  const c = m.content
  if (c.length === 1 && c[0].type === 'text' && c[0].cache_control && Object.keys(c[0]).length === 3) return { ...m, content: String(c[0].text) }
  return { ...m, content: c.map(({ cache_control, ...b }) => b as Block) }
}
const same = (x: ApiMsg, y: ApiMsg) => JSON.stringify(strip(x)) === JSON.stringify(strip(y))

// Breakpoints go where the request had them, counted from the end (replay.ts, marked).
function marked(o: ApiMsg[], s: ApiMsg[]): ApiMsg[] {
  const out = o.map((m) => m)
  for (let k = 1; k <= Math.min(4, s.length, o.length); k++) {
    const sm = s.at(-k)!
    if (typeof sm.content === 'string' || !sm.content.some((b) => b.cache_control)) continue
    const om = out.at(-k)!
    if (typeof om.content === 'string') { out[out.length - k] = sm; continue }
    out[out.length - k] = { ...om, content: om.content.map((b, i) => (sm.content[i] as Block)?.cache_control ? { ...b, cache_control: (sm.content[i] as Block).cache_control } : b) }
  }
  return out
}

type Logged = { advanced: boolean; cacheState?: string; savedChars: number; rewriteChars: number; extraChars: number }
type Req = { time: string; model: Model; auto: boolean; msgs: ApiMsg[]; logged?: Logged; sent: ApiMsg[] }
type Thinking = Map<string, number>
type Conv = { reqs: Req[]; broken: number; logged: number; h?: Harness; thinking: Thinking; chain: Summary[] }
type Tally = { cost: number; trims: number; costs: number[] }

// One conversation's requests, rebuilt untrimmed: each is the rebuild of the
// latest earlier request it extends, plus what follows that request's last
// message in what it sent.
function rebuild(dir: string): Conv {
  const lines = readFileSync(path.join(dir, 'step_events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const requests = lines.filter((e) => e.event === 'request')
  const got = receivedOf(lines)
  const kept = requests.flatMap((e, n) => (e.parts?.length && e.tools !== undefined ? [n] : []))
  const all = kept.map((n) => requests[n])
  const load = (h: string): ApiMsg => JSON.parse(readFileSync(path.join(dir, 'parts', h + '.json'), 'utf8'))
  const sent = all.map((e) => e.parts.map((p: { hash: string }) => load(p.hash)) as ApiMsg[])
  const recv = kept.map((n, i) => (requests[n].received ? got[n].map(load) : sent[i]))
  const orig: ApiMsg[][] = []
  let broken = 0
  recv.forEach((s, n) => {
    for (let k = n - 1; k >= 0; k--) {
      const j = s.findLastIndex((m) => same(m, recv[k].at(-1)!))
      if (j >= 0) return orig.push([...orig[k], ...s.slice(j + 1).map(strip)])
    }
    if (n) broken++
    orig.push(s.map(strip))
  })
  if (process.env.DEBUG_REBUILD) {
    orig.forEach((o, n) => { if (n && all[n].time >= '2026-10-15T16:3') { const a = clockOf(orig[n - 1]), b = clockOf(o); if (b.steps - a.steps !== 1) console.log('jump', n, all[n].time, a.steps, '->', b.steps, 'msgs', orig[n - 1].length, '->', o.length) } })
    const sigs = (ms: ApiMsg[]) => new Set(ms.flatMap((m) => (typeof m.content === 'string' ? [] : m.content.filter((x) => x.type === 'thinking').map((x) => String(x.signature).slice(0, 16)))))
    sent.forEach((s, n) => { const o = sigs(orig[n]); const lost = [...sigs(s)].filter((x) => !o.has(x)); if (lost.length) console.log('lost', n, all[n].time, lost.length) })
  }
  const h = harnessOf(path.basename(dir).split('-')[0], {}) as Harness | undefined
  const trims = new Map(lines.filter((e) => e.event === 'compaction').map((e) => [e.time, e]))
  const reqs = all.map((e, n) => ({ time: e.time, model: modelOf(e.model, e.provider), auto: e.protocol !== undefined && e.protocol !== 'messages', msgs: marked(orig[n], sent[n]), logged: trims.get(e.time), sent: sent[n] }))
  const logged = lines.filter((e) => e.event === 'compaction' && e.advanced && e.savedChars && e.time >= since && e.time < until).length
  // What each thinking block billed, as the proxy last saved it (server.ts, State).
  const state = path.join(root, 'proxy-data/state', path.basename(dir) + '.json')
  const thinking: Thinking = new Map(Object.entries(existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')).thinking ?? {} : {}))
  const records = state.replace(/\.json$/, '.summaries.json')
  const chain: Summary[] = policy.summary_threshold_tokens && existsSync(records) ? JSON.parse(readFileSync(records, 'utf8')).chain : []
  return { reqs, broken, logged, h: h && 'name' in h ? h : undefined, thinking, chain }
}

// Claude Code runs each WebSearch as its own one-request conversation;
// those aren't sessions, so they're left out.
function isSearch({ reqs }: Conv): boolean {
  const c = reqs[0]?.msgs[0]?.content
  const text = typeof c === 'string' ? c : c?.find((b) => b.type === 'text')?.text
  return String(text ?? '').startsWith('Perform a web search for the query:')
}

// The records renumbered to the rebuilt messages' prompts, each matched by its
// prompt's hash after the previous one's: the client counts turns the proxy
// answered itself (:shaver commands), which no logged request holds.
function renumbered(chain: readonly Summary[], msgs: readonly ApiMsg[]): Summary[] {
  const prompts = promptsOf(msgs)
  const out: Summary[] = []
  let from = 0
  for (const s of chain) {
    const k = prompts.findIndex((i, k) => k >= from && promptHash(msgs[i]) === s.prompt)
    if (k < 0) break
    out.push({ ...s, endsBefore: k + 1 })
    from = k + 1
  }
  return out
}

// Read and write prices relative to input (replay.ts and trim.ts, writeCost).
const rates = (m: Model, auto: boolean) => ({ read: m.price ? m.price.read / m.price.input : 0.1, write: m.price?.write ? m.price.write / m.price.input : auto ? 1 : 2 })

function run({ reqs, h, thinking, chain: all }: Conv, horizon: (n: number) => number, trace?: (n: number, q: Req, d?: Logged) => void): Tally {
  const conv = h?.conventions ?? NO_CONVENTIONS
  let applied: Clock = { steps: 0, turns: 0 }
  let sentRecords = 0
  const entries = new Map<string, number>()
  const out: Tally = { cost: 0, trims: 0, costs: [] }
  reqs.forEach((q, n) => {
    const t = Date.parse(q.time)
    const ttl = (q.model.ttl ?? 3600) * 1000
    for (const [p, at] of entries) if (t - at > ttl) entries.delete(p)
    const live = new Set(entries.keys())
    const held = heldTo(applied, q.msgs)
    const clock = clockOf(q.msgs)
    const chain = validChain(renumbered(all.filter((r) => r.time <= q.time), q.msgs), q.msgs)
    let records = Math.min(sentRecords, chain.length)
    let keep = summarized(apply(q.msgs, policy, held, conv), q.msgs, chain.slice(0, records))
    const reads = (m: ApiMsg[]) => {
      const ps = positionsOf(m, 's', thinking, q.auto)
      return ps.slice(0, readThrough(ps, live, q.model.lookback) + 1).reduce((x, p) => x + p.size, 0)
    }
    const cold = (m: ApiMsg[]) => { const ps = positionsOf(m, 's', thinking, q.auto); return ps.some((p) => p.breakpoint) && readThrough(ps, live, q.model.lookback) < 0 }
    if (records < chain.length && cold(keep.msgs)) {
      records = chain.length
      keep = summarized(apply(q.msgs, policy, held, conv), q.msgs, chain)
    }
    sentRecords = records
    const end = q.auto ? undefined : settledEnd(keep.msgs, summarized(fullyTrimmed(q.msgs, policy, conv), q.msgs, chain.slice(0, records)).msgs, 's', thinking)
    const anchor = (m: ApiMsg[]) => {
      if (q.auto) return m
      const x = anchored(m, end, 's', thinking)
      return reads(x) >= reads(m) ? x : m
    }
    let body = anchor(keep.msgs)
    if (horizon(n) >= 0 && (clock.steps > held.steps || clock.turns > held.turns)) {
      const next = summarized(apply(q.msgs, policy, clock, conv), q.msgs, chain.slice(0, records))
      const d = decide(anchor(keep.msgs), anchor(next.msgs), live, 's', q.model, thinking, q.auto, horizon(n))
      if (process.env.DEBUG_N === String(n) && trace) {
        const context: Record<string, number> = {}
        for (const m of keep.msgs) for (const [k, v] of Object.entries(kinds(JSON.stringify(m), m).kinds)) context[k] = (context[k] ?? 0) + v
        console.log('transitions', JSON.stringify(transitions(keep, next)), 'context', JSON.stringify(context))
      }
      if (process.env.DEBUG_N === String(n) && trace) console.log('held', held, 'clock', clock, 'records', records, 'of', chain.length, 'treated', JSON.stringify(next.treated).slice(0, 300))
      if (process.env.DEBUG_N === String(n) && trace) for (const [nm, m] of [['before', anchor(keep.msgs)], ['after', anchor(next.msgs)]] as const) {
        const ps = positionsOf(m, 's', thinking, q.auto)
        console.log(nm, 'read', readThrough(ps, live, q.model.lookback), 'of', ps.length, 'live', live.size, ps.map((p, i) => `${i}:${p.size}${p.breakpoint ? '*' : ''}${live.has(p.prefix) ? 'L' : ''}`).join(' '))
      }
      trace?.(n, q, { ...d, cacheState: d.cold ? 'cold' : 'warm' })
      // Comparing, the trims applied are those the proxy made, so each decision
      // is judged on the state the proxy had.
      if (trace ? q.logged?.advanced : d.advanced) {
        body = anchor(next.msgs)
        applied = clock
        if (d.savedChars && q.time >= since && q.time < until) out.trims++
      }
    }
    if (process.env.DEBUG_SENT && trace && q.time >= since && q.time < until) {
      const norm = (m: ApiMsg) => { const x = strip(m); return JSON.stringify(typeof x.content === 'string' ? { ...x, content: [{ type: 'text', text: x.content }] } : x) }
      const i = q.sent.findIndex((m, j) => !body[j] || norm(m) !== norm(body[j]))
      if (i >= 0 || body.length !== q.sent.length) console.log('sent differs', n, q.time, 'at', i, 'of', q.sent.length, body.length, '\n  sent ', JSON.stringify(strip(q.sent[i] ?? {} as ApiMsg)).slice(0, 300), '\n  model', JSON.stringify(strip(body[i] ?? {} as ApiMsg)).slice(0, 300))
    }
    const pos = positionsOf(body, 's', thinking, q.auto)
    const r = readThrough(pos, live, q.model.lookback)
    const last = pos.findLastIndex((p) => p.breakpoint)
    const { read, write } = rates(q.model, q.auto)
    if (q.time >= since && q.time < until) {
      const c = pos.reduce((x, p, i) => x + p.size * (i <= r ? read : i <= last ? write : 1), 0)
      out.cost += c
      out.costs.push(c)
    }
    for (const [i, p] of pos.entries()) if (p.breakpoint || (q.auto && !p.joined) || i === r) entries.set(p.prefix, t)
  })
  return out
}

// With --compare, each request K's decision and the logged one differ on,
// side by side, then how many differ.
if (compare) {
  const f = (d?: Logged) => (d ? `${d.advanced ? 'TRIM' : 'keep'} ${d.cacheState} saved ${d.savedChars} rewrite ${d.rewriteChars} extra ${d.extraChars}` : '-')
  for (const dir of dirs) {
    const c = rebuild(dir)
    if (isSearch(c)) continue
    const { reqs } = c
    const sim = new Map<number, Logged>()
    run(c, () => K, (n, _q, d) => sim.set(n, d!))
    let bad = 0, both = 0
    reqs.forEach((q, n) => {
      if (q.time < since || q.time >= until || (!q.logged && !sim.get(n)?.savedChars)) return
      both++
      const s = sim.get(n)
      if ((s?.advanced ?? false) === (q.logged?.advanced ?? false) && s?.savedChars === q.logged?.savedChars) return
      bad++
      console.log(`${n} ${q.time}\n  logged ${f(q.logged)}\n  model  ${f(s)}`)
    })
    console.log(`${path.basename(dir)}: ${bad} of ${both} decisions differ`)
  }
  process.exit(0)
}

// Totals by harness, then over all.
const totals = new Map<string, { convs: number; reqs: number; broken: number; logged: number; by: Tally[] }>()
for (const dir of dirs) {
  let got
  try { got = rebuild(dir) } catch { continue }
  if (isSearch(got)) continue
  got.reqs = got.reqs.slice(0, first)
  const { reqs, broken, logged, h } = got
  const inWindow = reqs.filter((q) => q.time >= since && q.time < until).length
  if (!inWindow) continue
  const by = HORIZONS.map(([, f]) => run(got, f))
  if (outFile) appendFileSync(outFile, JSON.stringify({ conv: path.basename(dir), harness: h?.name ?? 'unknown', costs: Object.fromEntries(HORIZONS.map(([label], i) => [label, by[i].costs])) }) + '\n')
  for (const name of [h?.name ?? 'unknown', 'all']) {
    const t = totals.get(name) ?? { convs: 0, reqs: 0, broken: 0, logged: 0, by: HORIZONS.map(() => ({ cost: 0, trims: 0 })) }
    t.convs++; t.reqs += inWindow; t.broken += broken; t.logged += logged
    by.forEach((b, i) => { t.by[i].cost += b.cost; t.by[i].trims += b.trims })
    totals.set(name, t)
  }
}
for (const [name, t] of totals) {
  const base = t.by[1].cost
  console.log(`\n${name}: ${t.convs} conversations, ${t.reqs} requests (rebuild breaks ${t.broken}), ${t.logged} trims logged`)
  HORIZONS.forEach(([label], i) => console.log(`  ${label.padEnd(20)} ${(t.by[i].cost / 1e6).toFixed(2)}M chars at input price  ${i === 1 ? '        ' : `${(((t.by[i].cost - base) / base) * 100).toFixed(1).padStart(6)}%`}  trims ${t.by[i].trims}`))
}

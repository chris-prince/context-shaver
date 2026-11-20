// Backtests how many later requests a trim's savings are counted over (the
// horizon H in trim.ts, decide). Each logged conversation's requests are
// rebuilt untrimmed, as in replay.ts, then trimmed afresh under the live
// policy with each horizon: the model's own (models.ts), the earlier ones
// (5, and min(20, 0.6n)), and the model's with other caps on the requests
// since the last trim, and with no message trims at all (the system prompt
// and tools still shaved as the proxy sent them; scripts/stats-from-logs.ts
// gives the cost without the shaver). Each request is priced with the cache
// model (positionsOf, readThrough) and its model's prices, in tokens at the
// input price, its chars converted at its own reported tokens a char. Only
// the messages are priced: the base is the same under every horizon. The
// proxy's forced trim before the client compacts is made as the policy has
// it (server.ts, prepare). The model's actions are held fixed, so a trim never makes it fetch
// again what was taken. The anchor goes on as in server.ts (prepare),
// assuming a spare breakpoint, and so do summary records: each one from when
// it was made, applied on a cold cache. A record a later one replaced isn't
// kept, so it is missed while it stood. The rebuild uses the messages as
// received where they were logged (server.ts, received), and as sent before
// that. Each conversation's line is printed as it finishes, the totals at the
// end; --out writes each request's cost too.
// Each horizon's client compacts as it would (cost.ts does the same for the
// cost without the shaver): once a request's prompt, as that horizon sent it,
// is past the client's limit, it pays for a compaction request, the prompt
// read and the summary written, and its later requests send the summary and
// what the compaction keeps (models.ts, Compaction) in place of what came
// before. The limit is each request's journaled compactAt (autocompact.ts),
// else its model's; --compact-at overrides it, --no-compaction leaves it out.
// A compaction the client really made stands in every horizon, and one is
// never made just before it; one a horizon would have avoided isn't, so
// horizons that trim more are still charged the client's own. Summary
// records aren't applied after a horizon's own compaction.
// Usage: [POLICY=<file>] bin/node-wrapper scripts/backtest-horizon.ts [--compare] [--since ISO] [--until ISO] [--first n] [--horizons JSON] [--compact-at tokens] [--no-compaction] [--out file.jsonl] [proxy-data/logs/<conversation> ...]
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { clockOf, heldTo, type ApiMsg, type Block, type Clock } from '../src/items.ts'
import { ccVersion, folded, keptTokens, type Keep } from '../src/compact-keep.ts'
import { harnessOf, NO_CONVENTIONS, type Harness } from '../src/harness.ts'
import { history } from '../src/journal.ts'
import { modelOf, PROMPTS_KEPT, SINCE, type Model } from '../src/models.ts'
import { forcedTrimOf, loadPolicy, textRules } from '../src/policy.ts'
import { isCompaction, keyOf, promptTokens, type Stats } from '../src/stats.ts'
import { promptHash, promptsOf, summarized, validChain, type Summary } from '../src/summary.ts'
import { messagesOf, objectsOf, receivedOf } from '../src/log.ts'
import { anchored, apply, counting, decide, entriesOf, fullyTrimmed, markedTtl, positionsOf, readThrough, settledEnd } from '../src/trim.ts'

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args.splice(i, 2)[1]
}
const compare = args.includes('--compare') && !!args.splice(args.indexOf('--compare'), 1)
// Comparing with the decisions logged, only the client's own compactions.
const compacting = !(args.includes('--no-compaction') && !!args.splice(args.indexOf('--no-compaction'), 1)) && !compare
const compactAt = opt('--compact-at')
const fromTime = opt('--since') ?? ''
const until = opt('--until') ?? '9999'
const outFile = opt('--out')
const first = Number(opt('--first') ?? Infinity)
const root = path.join(import.meta.dirname, '..')
const policy = loadPolicy(process.env.POLICY ?? path.join(root, 'policy.json'))!
const rules = policy.conversation_shaver_rules ?? {}
const summaryAt = textRules(policy).summary_threshold_tokens
const forcing = forcedTrimOf(policy)
const dirs = args.length ? args : readdirSync(path.join(root, 'proxy-data/logs'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, 'proxy-data/logs', d.name))

// Each request's model's horizon, as the proxy asks it (server.ts, prepare).
// `since` is the requests since the messages were last trimmed. Every
// horizon is 0 on a compaction (run), as its messages are never sent again.
const modelHorizon = (n: number, q: Req, since: number) => q.model.horizon(n, since)
const HORIZONS: [string, (n: number, q: Req, since: number) => number][] = [
  ['no message trims', () => -1], [`model (${SINCE}x since)`, modelHorizon], ['K=5', () => 5], ['min(20,0.6n)', (n) => Math.min(20, 0.6 * n)],
  ...[0.25, 0.4, 0.6, 1].map((c): [string, (n: number, q: Req, since: number) => number] => [`cap ${c}x since`, (n, _q, since) => Math.min(20, 0.6 * n, c * since)]),
]
// --horizons '[[label, [[from, k, slope, since?], ...]], ...]': piecewise-linear
// horizons over request numbers r = n + 1, each segment running from its
// first request with K = k + slope * (r - from), capped at since × the
// requests since the last trim where a segment gives `since`.
const pieces = opt('--horizons')
if (pieces) HORIZONS.splice(2, Infinity, ...(JSON.parse(pieces) as [string, [number, number, number, number?][]][]).map(([label, segs]): [string, (n: number, q: Req, since: number) => number] =>
  [label, (n, _q, since) => { const [from, k, slope, c] = segs.findLast(([f]) => f <= n + 1)!; const h = k + slope * (n + 1 - from); return Math.max(0, c === undefined ? h : Math.min(h, c * since)) }]))

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

type Logged = { advanced: boolean; cacheState?: string; savedChars: number; rewriteChars: number; extraChars: number; forced?: boolean }
// `inputTokens`: the request's input as reported; `ratio`: its tokens a char,
// that input over the chars it sent (messages as `chars` counts them, system
// prompt and tools as logged), or its conversation's where none was reported;
// `base`: the bytes of its system prompt and tools sent; `at`: where its
// client compacts, null where it doesn't, from the journal; `forced`: whether
// the proxy forced a trim on it (server.ts, autocompact-trim); `estimate`:
// a prompt's tokens as the proxy would estimate them before sending it;
// `version`: Claude Code's (ccVersion).
type Req = { time: string; model: Model; auto: boolean; msgs: ApiMsg[]; logged?: Logged; sent: ApiMsg[]; inputTokens?: number; ratio: number; base: number; at?: number | null; forced: boolean; estimate: (msgs: readonly ApiMsg[]) => number | undefined; version?: string }
type Thinking = Map<string, number>
type Conv = { reqs: Req[]; broken: number; logged: number; h?: Harness; thinking: Thinking; chain: Summary[] }
// `cost`: tokens at the input price; `tokens`: each request's prompt as sent,
// estimated; `compacted`: the requests a compaction followed.
type Tally = { cost: number; trims: number; costs: number[]; compactions: number; ms: number; tokens: number[]; compacted: number[] }
const chars = (ms: readonly ApiMsg[]) => ms.reduce((n, m) => n + JSON.stringify(strip(m)).length, 0)
// Whether one request's messages go on from another's.
const extend = (next: readonly ApiMsg[], prev: readonly ApiMsg[]) => next.length > prev.length && same(next[prev.length - 1], prev.at(-1)!)

// One conversation's requests, rebuilt untrimmed: each is the rebuild of the
// latest earlier request it extends, plus what follows that request's last
// message in what it sent.
function rebuild(dir: string): Conv {
  const lines = readFileSync(path.join(dir, 'step_events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const requests = lines.filter((e) => e.event === 'request')
  const got = receivedOf(lines)
  const kept = requests.flatMap((e, n) => (messagesOf(e)?.length && e.tools !== undefined ? [n] : []))
  const all = kept.map((n) => requests[n])
  const objects = objectsOf(dir)
  const load = (h: string): ApiMsg => JSON.parse(readFileSync(path.join(objects, h + '.json'), 'utf8'))
  const sent = all.map((e) => messagesOf(e).map((p) => load(p.hash)) as ApiMsg[])
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
  const h = harnessOf(path.basename(dir).split('-')[0], {}) as Harness | undefined
  const trims = new Map(lines.filter((e) => e.event === 'compaction').map((e) => [e.time, e]))
  const forced = new Set(lines.filter((e) => e.event === 'autocompact-trim').map((e) => e.time))
  // Each model with the TTL its request's breakpoints asked for, as the proxy
  // takes it (server.ts, prepare).
  const ttlOf = (e: { system?: { hash: string }[] }, n: number) => markedTtl({ system: (e.system ?? []).map((b) => load(b.hash)), messages: sent[n] })
  const state = path.join(dir, '../../state', path.basename(dir) + '.json')
  // Where the client compacts, as the journal last had it at each request.
  const journal = state.replace(/\.json$/, '.journal.jsonl')
  // And the counts the proxy estimates a prompt's tokens from before sending
  // it (promptTokens): each key's, as they changed, and the base's key.
  const ats: [string, number | null][] = []
  const counts = new Map<string, [string, number | undefined][]>()
  const defs: [string, string][] = []
  let was = new Map<string, number>()
  for (const { stats: s } of existsSync(journal) ? history(journal) : []) {
    if (s.compactAt !== undefined) ats.push([s.time, s.compactAt])
    const now = new Map(Object.entries(s.tokens ?? {}))
    for (const [k, v] of now) if (was.get(k) !== v) counts.get(k)?.push([s.time, v]) ?? counts.set(k, [[s.time, v]])
    for (const k of was.keys()) if (!now.has(k)) counts.get(k)!.push([s.time, undefined])
    was = now
    defs.push([s.time, s.defs.key])
  }
  const atOf = (time: string) => ats.findLast(([t]) => t <= time)?.[1]
  // As the proxy estimates `msgs` before the request at `time`: none before
  // its first request is journaled.
  const estimateOf = (time: string) => (msgs: readonly ApiMsg[]): number | undefined => {
    const key = defs.findLast(([t]) => t < time)?.[1]
    if (key === undefined) return undefined
    const tokens: Record<string, number> = {}
    for (const k of [key, ...msgs.map(keyOf)]) {
      const v = counts.get(k)?.findLast(([t]) => t < time)?.[1]
      if (v !== undefined) tokens[k] = v
    }
    return promptTokens({ tokens, defs: { key } } as unknown as Stats, msgs)
  }
  const bytes = (xs?: { bytes?: number; deferred?: boolean }[]) => (xs ?? []).reduce((n, x) => n + (x.deferred ? 0 : x.bytes ?? 0), 0)
  // The chars each request sent: the messages' size as the backtest measures
  // it, since the log gives no bytes for them.
  const sentChars = all.map((e, n) => chars(sent[n]) + bytes(e.system) + bytes(e.tools))
  const counted = all.flatMap((e, n) => (typeof e.inputTokens === 'number' && sentChars[n] ? [n] : []))
  if (all.length && !counted.length) throw new Error(`${path.basename(dir)}: no request reports its input tokens, so its chars can't be converted`)
  const convRatio = counted.reduce((x, n) => x + all[n].inputTokens, 0) / counted.reduce((x, n) => x + sentChars[n], 0)
  const reqs = all.map((e, n): Req => ({ time: e.time, model: { ...modelOf(e.model, e.provider), ...(ttlOf(e, n) && { ttl: ttlOf(e, n) }) }, auto: e.protocol !== undefined && e.protocol !== 'messages', msgs: marked(orig[n], sent[n]), logged: trims.get(e.time), sent: sent[n],
    ...(typeof e.inputTokens === 'number' && { inputTokens: e.inputTokens }), ratio: typeof e.inputTokens === 'number' && sentChars[n] ? e.inputTokens / sentChars[n] : convRatio, base: bytes(e.system) + bytes(e.tools), at: atOf(e.time), forced: forced.has(e.time), estimate: estimateOf(e.time),
    ...(h?.name === 'claude' && { version: ccVersion((e.system ?? []).map((b: { hash: string }) => load(b.hash))) }) }))
  const logged = lines.filter((e) => e.event === 'compaction' && e.advanced && e.savedChars && e.time >= fromTime && e.time < until).length
  // What each thinking block and counted tool call billed, as the proxy last
  // saved it (server.ts, State and recordedOf).
  const saved = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : {}
  const thinking: Thinking = new Map([...Object.entries<number>(saved.thinking ?? {}), ...Object.entries<number>(saved.calls ?? {}).map(([id, n]) => [`call:${id}`, n] as const)])
  const records = state.replace(/\.json$/, '.summaries.json')
  const chain: Summary[] = summaryAt && existsSync(records) ? JSON.parse(readFileSync(records, 'utf8')).chain : []
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
// answered itself (`shaver` commands), which no logged request holds.
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

function run({ reqs, h, thinking, chain: all }: Conv, horizon: (n: number, q: Req, since: number) => number, trace?: (n: number, q: Req, d?: Logged) => void): Tally {
  const conv = h?.conventions ?? NO_CONVENTIONS
  let applied: Clock = { requests: 0, turns: 0 }
  let sentRecords = 0
  const entries = new Map<string, number>()
  const out: Tally = { cost: 0, trims: 0, costs: [], compactions: 0, ms: 0, tokens: [], compacted: [] }
  // After this horizon's own compaction: what it sends in place of the
  // messages before `from`, while the requests go on from `last`.
  let compacted: { prefix: ApiMsg[]; from: number; last: ApiMsg } | undefined
  // What Claude Code's compaction would keep, folded from the client's
  // messages; none for other harnesses.
  let fold: Keep | undefined
  reqs.forEach((real, n) => {
    if (h?.name === 'claude') fold = folded(fold, real.msgs, undefined, real.version)
    if (compacted && !(real.msgs.length > compacted.from && same(real.msgs[compacted.from - 1], compacted.last))) compacted = undefined
    const q: Req = compacted ? { ...real, msgs: [...compacted.prefix, ...real.msgs.slice(compacted.from)] } : real
    const t = Date.parse(q.time)
    const ttl = (q.model.ttl ?? 3600) * 1000
    for (const [p, at] of entries) if (t - at > ttl) entries.delete(p)
    const live = new Set(entries.keys())
    const held = heldTo(applied, q.msgs)
    const clock = clockOf(q.msgs)
    const chain = compacted ? [] : validChain(renumbered(all.filter((r) => r.time <= q.time), q.msgs), q.msgs)
    let records = Math.min(sentRecords, chain.length)
    let keep = summarized(apply(q.msgs, rules, held, conv, thinking), q.msgs, chain.slice(0, records))
    const reads = (m: ApiMsg[]) => {
      const ps = positionsOf(m, 's', thinking, counting(q.model, q.auto))
      return ps.slice(0, readThrough(ps, live, q.model.lookback) + 1).reduce((x, p) => x + p.size, 0)
    }
    const cold = (m: ApiMsg[]) => { const ps = positionsOf(m, 's', thinking, counting(q.model, q.auto)); return ps.some((p) => p.breakpoint) && readThrough(ps, live, q.model.lookback) < 0 }
    if (records < chain.length && cold(keep.msgs)) {
      records = chain.length
      keep = summarized(apply(q.msgs, rules, held, conv, thinking), q.msgs, chain)
    }
    sentRecords = records
    const end = q.auto ? undefined : settledEnd(keep.msgs, summarized(fullyTrimmed(q.msgs, rules, conv, thinking), q.msgs, chain.slice(0, records)).msgs, 's', thinking)
    const anchor = (m: ApiMsg[]) => {
      if (q.auto) return m
      const x = anchored(m, end, 's', thinking)
      return reads(x) >= reads(m) ? x : m
    }
    let body = anchor(keep.msgs)
    const { ratio } = real
    // The prompt of `msgs` as this horizon would send it: the reported input,
    // less what it leaves out of the messages the proxy sent, converted.
    const tokensOf = (msgs: ApiMsg[]) => (real.inputTokens !== undefined ? real.inputTokens + ratio * (chars(msgs) - chars(real.sent)) : ratio * (chars(msgs) + real.base))
    const at = compactAt !== undefined ? Number(compactAt) : real.at !== undefined ? real.at : q.model.compaction?.at
    // The proxy's forced trim (server.ts, prepare): within the policy's
    // proximity of the client's compaction, everything due is sent trimmed and
    // every record applied, if that saves at least its least saving. Not on a
    // compaction, nor for a horizon that never trims. Comparing, the proxy's
    // forced trims are applied, and each one it or this makes is traced.
    // Its sizes are the proxy's own estimates, from what it had counted by then.
    let forced = false
    const near = forcing && at != null && horizon(n, q, 0) >= 0 && !isCompaction(q.msgs) ? real.estimate(keep.msgs) : undefined
    if (near !== undefined) {
      const full = summarized(apply(q.msgs, rules, clock, conv, thinking), q.msgs, chain)
      const saves = near - real.estimate(full.msgs)!
      const would = near >= at! - forcing!.proximity && saves >= forcing!.saves
      forced = trace ? real.forced : would
      if (trace && (would || real.forced)) trace(n, q, { advanced: would, forced: true, savedChars: Math.round(saves), rewriteChars: 0, extraChars: 0 })
      if (forced) {
        body = anchor(full.msgs)
        applied = clock
        sentRecords = records = chain.length
        if (q.time >= fromTime && q.time < until) out.trims++
      }
    }
    // A horizon below 0 never trims; any other is 0 on a compaction.
    if (!forced && horizon(n, q, 0) >= 0 && (clock.requests > held.requests || clock.turns > held.turns)) {
      const next = summarized(apply(q.msgs, rules, clock, conv, thinking), q.msgs, chain.slice(0, records))
      const d = decide(anchor(keep.msgs), anchor(next.msgs), live, 's', q.model, thinking, q.auto, isCompaction(q.msgs) ? 0 : horizon(n, q, clock.requests - held.requests))
      trace?.(n, q, { ...d, cacheState: d.cold ? 'cold' : 'warm' })
      // Comparing, the trims applied are those the proxy made, so each decision
      // is judged on the state the proxy had.
      if (trace ? q.logged?.advanced : d.advanced) {
        body = anchor(next.msgs)
        applied = clock
        if (d.savedChars && q.time >= fromTime && q.time < until) out.trims++
      }
    }
    if (process.env.DEBUG_SENT && trace && q.time >= fromTime && q.time < until) {
      const norm = (m: ApiMsg) => { const x = strip(m); return JSON.stringify(typeof x.content === 'string' ? { ...x, content: [{ type: 'text', text: x.content }] } : x) }
      const i = q.sent.findIndex((m, j) => !body[j] || norm(m) !== norm(body[j]))
      if (i >= 0 || body.length !== q.sent.length) console.log('sent differs', n, q.time, 'at', i, 'of', q.sent.length, body.length, '\n  sent ', JSON.stringify(strip(q.sent[i] ?? {} as ApiMsg)).slice(0, 300), '\n  model', JSON.stringify(strip(body[i] ?? {} as ApiMsg)).slice(0, 300))
    }
    const pos = positionsOf(body, 's', thinking, counting(q.model, q.auto))
    const r = readThrough(pos, live, q.model.lookback)
    const last = pos.findLastIndex((p) => p.breakpoint)
    const { read, write } = rates(q.model, q.auto)
    const inWindow = q.time >= fromTime && q.time < until
    const tokens = tokensOf(body)
    if (inWindow) {
      const c = ratio * pos.reduce((x, p, i) => x + p.size * (i <= r ? read : i <= last ? write : 1), 0)
      out.cost += c
      out.costs.push(c)
      out.tokens.push(tokens)
    }
    for (const h of entriesOf(pos, r)) entries.set(h, t)
    // Past the client's limit, it compacts before the next request, unless
    // that one is its own compaction or doesn't go on from this one.
    const c = q.model.compaction
    const next = reqs[n + 1]
    if (!compacting || at == null || !c || !next || tokens <= at || isCompaction(q.msgs) || isCompaction(next.msgs) || !extend(next.msgs, real.msgs)) return
    const tok = (m: ApiMsg) => JSON.stringify(strip(m)).length * ratio
    const filler = (tokens: number): ApiMsg => ({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(Math.max(0, Math.round(tokens / ratio))) }] })
    const summary = filler(c.summarized ?? c.summary)
    // The same rules as src/cost.ts's keptOf, which has token totals only.
    let prefix: ApiMsg[]
    if (fold) {
      // Claude Code: what its compaction keeps, folded from the client's
      // messages (compact-keep.ts), as the proxy journals it: in one message
      // the summary, the context sent again and the files read again. The
      // last exchange it keeps whole is what the next request adds. With one
      // answer only, nothing is compacted.
      const kept = keptTokens(fold, ratio)
      if (kept === undefined) return
      prefix = [filler((c.summarized ?? c.summary) + kept)]
    } else if (c.kept === 'prompts') {
      // The newest user messages, up to PROMPTS_KEPT tokens, then the summary.
      const kept: ApiMsg[] = []
      let size = 0
      for (const i of promptsOf(q.msgs).toReversed()) {
        if (size + tok(q.msgs[i]) > PROMPTS_KEPT) break
        size += tok(q.msgs[i])
        kept.unshift(strip(q.msgs[i]))
      }
      prefix = [...kept, summary]
    } else {
      // The summary, then the newest messages up to `kept` tokens from an
      // answer on, and at least the last round: an answer and what followed.
      // With one round only, nothing is compacted.
      let i = q.msgs.length
      for (let size = 0; i > 0 && size + tok(q.msgs[i - 1]) <= c.kept; i--) size += tok(q.msgs[i - 1])
      let from = q.msgs.findIndex((m, j) => j >= i && m.role === 'assistant')
      if (from < 0) from = q.msgs.findLastIndex((m) => m.role === 'assistant')
      if (from <= 1) return
      prefix = [summary, ...q.msgs.slice(from).map(strip)]
    }
    // The compaction request reads the prompt as just sent, and writes the
    // summary.
    const now = new Set(entries.keys())
    const r2 = readThrough(pos, now, q.model.lookback)
    const output = q.model.price ? q.model.price.output / q.model.price.input : 5
    if (inWindow) {
      const cost = ratio * pos.reduce((x, p, i) => x + p.size * (i <= r2 ? read : 1), 0) + c.summary * output
      out.cost += cost
      out.costs[out.costs.length - 1] += cost
      out.compactions++
      out.ms += c.ms
      out.compacted.push(n)
    }
    compacted = { prefix, from: real.msgs.length, last: real.msgs.at(-1)! }
    applied = { requests: 0, turns: 0 }
    sentRecords = 0
  })
  return out
}

// With --compare, each request whose decision at its model's horizon and the
// logged one differ on,
// side by side, then how many differ.
if (compare) {
  const f = (d?: Logged) => (d ? `${d.advanced ? 'TRIM' : 'keep'} ${d.cacheState} saved ${d.savedChars} rewrite ${d.rewriteChars} extra ${d.extraChars}` : '-')
  for (const dir of dirs) {
    const c = rebuild(dir)
    if (isSearch(c)) continue
    const { reqs } = c
    const sim = new Map<number, Logged>()
    const simForced = new Map<number, Logged>()
    run(c, modelHorizon, (n, _q, d) => (d!.forced ? simForced : sim).set(n, d!))
    let bad = 0, both = 0
    reqs.forEach((q, n) => {
      if (q.time < fromTime || q.time >= until) return
      // A forced trim, the proxy's or this one's: whether both made it.
      const sf = simForced.get(n)
      if (q.forced || sf) {
        both++
        if (q.forced === !!sf?.advanced) return
        bad++
        return console.log(`${n} ${q.time}\n  logged ${q.forced ? 'FORCED' : 'not forced'}\n  model  ${sf?.advanced ? 'FORCED' : 'not forced'} (saves ${sf?.savedChars} tokens)`)
      }
      if (!q.logged && !sim.get(n)?.savedChars) return
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
type Sum = { cost: number; trims: number; compactions: number; ms: number }
const totals = new Map<string, { convs: number; reqs: number; broken: number; logged: number; by: Sum[] }>()
// Compactions, where a horizon made any.
const made = (b: Sum) => (b.compactions ? ` +${b.compactions}c` : '')
for (const [k, dir] of dirs.entries()) {
  let got
  // A folder with no requests logged isn't a conversation.
  if (!existsSync(path.join(dir, 'step_events.jsonl'))) continue
  got = rebuild(dir)
  if (isSearch(got)) continue
  got.reqs = got.reqs.slice(0, first)
  const { reqs, broken, logged, h } = got
  const inWindow = reqs.filter((q) => q.time >= fromTime && q.time < until).length
  if (!inWindow) continue
  const by = HORIZONS.map(([, f]) => run(got, f))
  const pct = (i: number) => `${by[i].cost >= by[1].cost ? '+' : ''}${(((by[i].cost - by[1].cost) / (by[1].cost || 1)) * 100).toFixed(1)}%`
  console.log(`${k + 1}/${dirs.length} ${path.basename(dir)} ${h?.name ?? 'unknown'} ${inWindow} req | ${HORIZONS.map(([label], i) => `${label} ${i === 1 ? `${(by[i].cost / 1e6).toFixed(2)}M` : pct(i)} ${by[i].trims}${made(by[i])}`).join(' | ')}`)
  const each = (f: (b: Tally) => unknown) => Object.fromEntries(HORIZONS.map(([label], i) => [label, f(by[i])]))
  if (outFile) appendFileSync(outFile, JSON.stringify({ conv: path.basename(dir), harness: h?.name ?? 'unknown', costs: each((b) => b.costs), tokens: each((b) => b.tokens.map(Math.round)), compacted: each((b) => b.compacted) }) + '\n')
  for (const name of [h?.name ?? 'unknown', 'all']) {
    const t = totals.get(name) ?? { convs: 0, reqs: 0, broken: 0, logged: 0, by: HORIZONS.map(() => ({ cost: 0, trims: 0, compactions: 0, ms: 0 })) }
    t.convs++; t.reqs += inWindow; t.broken += broken; t.logged += logged
    by.forEach((b, i) => { t.by[i].cost += b.cost; t.by[i].trims += b.trims; t.by[i].compactions += b.compactions; t.by[i].ms += b.ms })
    totals.set(name, t)
  }
}
for (const [name, t] of totals) {
  const base = t.by[1].cost
  console.log(`\n${name}: ${t.convs} conversations, ${t.reqs} requests (rebuild breaks ${t.broken}), ${t.logged} trims logged`)
  HORIZONS.forEach(([label], i) => console.log(`  ${label.padEnd(20)} ${(t.by[i].cost / 1e6).toFixed(2)}M tokens at input price  ${i === 1 ? '        ' : `${(((t.by[i].cost - base) / base) * 100).toFixed(1).padStart(6)}%`}  trims ${t.by[i].trims}  compactions ${t.by[i].compactions} (${(t.by[i].ms / 60_000).toFixed(1)} min)`))
}

// Replays one logged conversation's requests, rebuilt untrimmed, through the
// proxy's logic under several policies, and prices each with the cache model.
// The model's actions are held fixed: same requests, same outputs, so it can't
// show a model fetching again what a trim took. WAIT, the step wait of the drop
// policy the run used, also checks the rebuild: what the proxy sent should be
// what that policy gives the rebuilt request at some clock.
// Usage: [WAIT=<n>] bin/node-wrapper scripts/replay.ts proxy-data/logs/<conversation> [from ISO] [to ISO]
import { readFileSync } from 'node:fs'
import { clockOf, heldTo, type ApiMsg, type Block, type Clock } from '../src/items.ts'
import { hash } from '../src/log.ts'
import { apply, decide, positionsOf, readThrough, TEXT_TOKENS, type Position } from '../src/trim.ts'
import type { Policy } from '../src/policy.ts'

const [dir, from = '', to = '9999'] = process.argv.slice(2)
const TTL = 3600e3
const all = readFileSync(dir + '/step_events.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((e) => e.event === 'request' && e.inputTokens !== undefined && e.tools && !e.bare)
const reqs = all.filter((e) => e.time >= from && e.time < to)
const load = (h: string): ApiMsg => JSON.parse(readFileSync(`${dir}/parts/${h}.json`, 'utf8'))
// A message as sent without breakpoints. Claude Code sends a lone text block
// carrying one as an array, and as a string once the breakpoint moves on.
function strip(m: ApiMsg): ApiMsg {
  if (typeof m.content === 'string') return m
  const c = m.content
  if (c.length === 1 && c[0].type === 'text' && c[0].cache_control && Object.keys(c[0]).length === 3) return { ...m, content: String(c[0].text) }
  return { ...m, content: c.map(({ cache_control, ...b }) => b as Block) }
}
const same = (x: ApiMsg, y: ApiMsg) => JSON.stringify(strip(x)) === JSON.stringify(strip(y))

// 1. Rebuild: each request is the original of the latest earlier request it
// extends, plus what follows that request's last message in what it sent.
// Claude Code's prompt suggestions fork the conversation, so the request after
// one extends the request before it.
const sent: ApiMsg[][] = reqs.map((e) => e.parts.map((p: { hash: string }) => load(p.hash)))
const orig: ApiMsg[][] = []
let broken = 0
sent.forEach((s, n) => {
  for (let k = n - 1; k >= 0; k--) {
    const j = s.findLastIndex((m) => same(m, sent[k].at(-1)!))
    if (j >= 0) return orig.push([...orig[k], ...s.slice(j + 1).map(strip)])
  }
  if (n) broken++
  orig.push(s.map(strip))
})

// Breakpoints go where the request had them, counted from the end, which is
// never trimmed.
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

// Thinking tokens, as the proxy records them: the response's output less its
// visible content, by signature.
const thinking = new Map<string, number>()
reqs.forEach((e, n) => {
  const next = orig[n + 1]
  if (!next) return
  const a = next[orig[n].length]
  if (!a || a.role !== 'assistant' || typeof a.content === 'string') return
  let visible = 0
  const sigs: string[] = []
  for (const b of a.content)
    if (b.type === 'thinking' && typeof b.signature === 'string') sigs.push(b.signature)
    else visible += b.type === 'text' ? String(b.text).length : b.type === 'tool_use' ? JSON.stringify(b.name).length + JSON.stringify(b.input).length : 0
  const total = sigs.reduce((x, s) => x + s.length, 0)
  const tokens = Math.max(0, e.outputTokens - TEXT_TOKENS * visible)
  for (const s of sigs) thinking.set(hash(s), Math.round((tokens * s.length) / total))
})

// What a request sends besides its messages, in characters: the system
// blocks, the tools sent in full, and the deferred tools its messages load by
// tool_reference, which the API expands to their definitions.
type Def = { name?: string; bytes: number; deferred?: boolean }
function defsSize(e: { system: Def[]; tools: Def[] }, msgs: ApiMsg[]): number {
  const loaded = new Set<string>()
  for (const m of msgs)
    if (typeof m.content !== 'string')
      for (const b of m.content) if (b.type === 'tool_result' && Array.isArray(b.content)) for (const c of b.content) if (c?.type === 'tool_reference') loaded.add(c.tool_name)
  const sum = (ds: Def[]) => ds.reduce((x, d) => x + d.bytes, 0)
  return sum(e.system) + sum(e.tools.filter((t) => !t.deferred || loaded.has(t.name!)))
}

// The base, the system blocks, the tools sent in full and the preamble (what
// Claude Code injects before the first response, the kind src/log.ts calls
// `system`), takes its tokens from the conversation's first request, as the
// API reported them, less that request's other parts, shared by bytes.
const sig = (e: { system: (Def & { hash: string })[]; tools: (Def & { hash: string })[] }) =>
  JSON.stringify([e.system.map((d) => d.hash), e.tools.filter((t) => !t.deferred).map((t) => t.hash)])
if (all[0].parts.some((p: { part: string }) => p.part === 'assistant')) throw new Error(`${dir} was logged from partway through, so its base has no exact count`)
if (all.some((e) => sig(e) !== sig(all[0]))) throw new Error(`${dir} sent other system blocks or tools than its first request, so its base has no exact count`)
const kindsOf = (p: { hash: string; part: string; bytes: number }): Record<string, number> => {
  try { return JSON.parse(readFileSync(`${dir}/parts/${p.hash}.kinds.json`, 'utf8')).kinds ?? { [p.part]: p.bytes } } catch { return { [p.part]: p.bytes } }
}
const firstKinds = all[0].parts.flatMap((p: { hash: string; part: string; bytes: number }) => Object.entries(kindsOf(p)))
const pre = firstKinds.filter(([k]: [string, number]) => k === 'system').reduce((x: number, [, n]: [string, number]) => x + n, 0)
const sum = (ds: Def[]) => ds.reduce((x, d) => x + d.bytes, 0)
const fixed = sum(all[0].system) + sum(all[0].tools.filter((t: Def) => !t.deferred))
const firstOther = firstKinds.reduce((x: number, [k, n]: [string, number]) => x + (k === 'system' ? 0 : n), 0)
const BASE = (all[0].inputTokens * (fixed + pre)) / (fixed + pre + firstOther)

// Tokens = rate x characters past the base, the rate being the requests'
// tokens less the base over what they sent besides it. A request's messages
// carry the preamble, so what it sends besides them costs the base less the
// preamble at that rate, plus the deferred tools it has loaded.
const sz = (ps: Position[]) => ps.reduce((x, p) => x + p.size, 0)
const xs = sent.map((s, n) => defsSize(reqs[n], s) + sz(positionsOf(s, 's', thinking)) - fixed - pre)
const rate = reqs.reduce((a, e) => a + e.inputTokens - BASE, 0) / xs.reduce((a, b) => a + b)
const defsTokens = (e: { system: Def[]; tools: Def[] }, msgs: ApiMsg[]) => BASE - rate * pre + rate * (defsSize(e, msgs) - fixed)

// Opus 5.5: $4 input, read 0.05x, 1-hour write 2x, output 5x.
const P = 4 / 1e6
function price(base: number, pos: Position[], r: number, warm: boolean) {
  const last = pos.findLastIndex((p) => p.breakpoint)
  let rd = warm ? base : 0, wr = warm ? 0 : base, plain = 0
  pos.forEach((p, i) => { const t = p.size * rate; if (i <= r) rd += t; else if (i <= last) wr += t; else plain += t })
  return { rd, wr, plain }
}

type Run = { cost: number; rd: number; wr: number; ctx: number; advanced: number; mismatch: number; firstMiss?: string }
function run(policy: Policy | 'sent', actual?: Policy): Run {
  let applied: Clock = { requests: 0, turns: 0 }
  let found: Clock = { requests: 0, turns: 0 }
  const entries = new Map<string, number>()
  // The tools and system are cached already when the first request read them.
  let lastAt = reqs[0].cachedTokens >= 0.9 * defsTokens(reqs[0], sent[0]) ? Date.parse(reqs[0].time) : -Infinity
  const out: Run = { cost: 0, rd: 0, wr: 0, ctx: 0, advanced: 0, mismatch: 0 }
  reqs.forEach((e, n) => {
    const t = Date.parse(e.time)
    for (const [h, at] of entries) if (t - at > TTL) entries.delete(h)
    const live = new Set(entries.keys())
    const msgs = marked(orig[n], sent[n])
    let body: ApiMsg[]
    if (policy === 'sent') {
      body = sent[n]
      if (actual) {
        // Does some clock reproduce what was sent from the rebuilt request?
        const c = clockOf(msgs)
        // The applied clock only moves forward, so search from the last one found.
        const want = JSON.stringify(sent[n].map(strip))
        let ok = false
        for (let tu = found.turns; tu <= c.turns && !ok; tu++)
          for (let rq = 0; rq <= c.requests && !ok; rq++)
            if (JSON.stringify(apply(msgs, actual, heldTo({ requests: rq, turns: tu }, msgs)).msgs.map(strip)) === want) [ok, found] = [true, { requests: rq, turns: tu }]
        if (!ok && !out.mismatch++) out.firstMiss = `#${n} ${e.time}`
      }
    } else {
      const held = heldTo(applied, msgs)
      const clock = clockOf(msgs)
      const keep = apply(msgs, policy, held)
      body = keep.msgs
      if (clock.requests > held.requests || clock.turns > held.turns) {
        const next = apply(msgs, policy, clock)
        const d = decide(keep.msgs, next.msgs, live, 's', e.model, thinking)
        if (d.advanced) { body = next.msgs; applied = clock; if (d.savedChars) out.advanced++ }
      }
    }
    const pos = positionsOf(body, 's', thinking)
    const r = readThrough(pos, live)
    const c = price(defsTokens(e, body), pos, r, t - lastAt <= TTL)
    out.rd += c.rd; out.wr += c.wr; out.ctx = Math.max(out.ctx, c.rd + c.wr + c.plain)
    out.cost += P * (0.05 * c.rd + 2 * c.wr + c.plain + 5 * e.outputTokens)
    for (const [i, p] of pos.entries()) if (p.breakpoint || i === r) entries.set(p.prefix, t)
    lastAt = t
  })
  return out
}

const logged = reqs.reduce((x, e) => {
  const w = (e.writtenTokens60m ?? e.writtenTokens ?? 0) + (e.writtenTokens5m ?? 0)
  return x + P * (0.05 * e.cachedTokens + 2 * w + (e.inputTokens - e.cachedTokens - w) + 5 * e.outputTokens)
}, 0)
const fmt = (name: string, r: Run) => console.log(`${name.padEnd(14)} $${r.cost.toFixed(2)}  read ${(r.rd / 1e6).toFixed(2)}M  write ${(r.wr / 1e3).toFixed(0)}k  peak ${(r.ctx / 1e3).toFixed(0)}k  trims ${r.advanced}`)
console.log(`${dir.replace(/\/$/, '').split('/').at(-1)}: ${reqs.length} requests, rebuild breaks ${broken}, rate ${rate.toFixed(3)} tok/char, base ${BASE.toFixed(0)}`)
console.log(`logged         $${logged.toFixed(2)}`)
const actualWait = Number(process.env.WAIT)
const pol = (w: number): Policy => ({ tool: [{ on: 'step', wait: w, action: 'drop' }], skill: [{ on: 'turn', wait: 0, action: 'drop' }], reasoning: [{ on: 'turn', wait: 0, action: 'drop' }] })
const s = run('sent', actualWait ? pol(actualWait) : undefined)
fmt('sent, repriced', s)
if (actualWait) console.log(`  rebuilt requests the real policy doesn't reproduce: ${s.mismatch} of ${reqs.length}${s.firstMiss ? `, from ${s.firstMiss}` : ''}`)
fmt('no trimming', run({}))
for (const w of [2, 4, 8, 16]) fmt(`drop wait ${w}`, run(pol(w)))
fmt('8 + 2 turns', run({ ...pol(8), tool: [{ on: 'step', wait: 8, action: 'drop' }, { on: 'turn', wait: 2, action: 'drop' }] }))

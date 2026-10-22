import assert from 'node:assert/strict'
import { test } from 'node:test'
import { add, cost, without, type Usage } from '../src/cost.ts'
import { modelOf } from '../src/models.ts'
import { render, type Stats } from '../src/stats.ts'

const HOUR = 3600e3
const at = (minute: number, inputTokens: number, removedTokens: number, model = 'claude-opus-5-5') =>
  ({ time: new Date(Date.UTC(2026, 9, 14, 10, minute)).toISOString(), inputTokens, removedTokens, model, parts: [] }) as unknown as Stats
const usage = (uncached: number, reads: number, writes: number, output = 0): Usage => ({ input_tokens: uncached, cache_read_input_tokens: reads, cache_creation_input_tokens: writes, cache_creation: { ephemeral_1h_input_tokens: writes }, output_tokens: output })

test('cold, both read only the shared prefix and write the rest', () => {
  assert.deepEqual(without(undefined, at(0, 10_000, 4000), usage(10, 5000, 4990, 7), HOUR).tokens, { uncached: 10, reads: 5000, writes: 8990, output: 7 })
  assert.deepEqual(without(at(0, 10_000, 4000), at(61, 10_000, 4000), usage(10, 5000, 4990), HOUR).tokens.writes, 8990)
})

test('a warm advance would have read the whole previous prompt', () => {
  // Was 20k, of which nothing trimmed; now 12k with 9k trimmed: 21k w/o.
  assert.deepEqual(without(at(0, 20_000, 0), at(1, 12_000, 9000), usage(10, 5000, 6990), HOUR).tokens, { uncached: 10, reads: 20_000, writes: 990, output: 0 })
})

test('otherwise the trimmed-out tokens are read on a hit and written on a miss', () => {
  const prev = at(0, 12_000, 9000)
  assert.deepEqual(without(prev, at(1, 13_000, 9000), usage(10, 12_000, 990), HOUR).tokens, { uncached: 10, reads: 21_000, writes: 990, output: 0 })
  assert.deepEqual(without(prev, at(1, 13_000, 9000), usage(10, 5000, 7990), HOUR).tokens, { uncached: 10, reads: 5000, writes: 16_990, output: 0 })
})

test('cost totals both sides in dollars', () => {
  const c = cost(
    [
      { stats: at(0, 20_000, 0), usage: usage(0, 0, 20_000) },
      // The advance: a rewrite costs more than reading on.
      { stats: at(1, 12_000, 9000), usage: usage(0, 5000, 7000) },
      // Reading on costs less.
      { stats: at(2, 13_000, 9000), usage: usage(0, 12_000, 1000, 100) },
      { stats: at(3, 13_000, 9000) },
    ],
    HOUR,
  )
  // Opus: writes $8, reads $0.20, output $20 a million. W/o reads 41k and
  // writes 22k; actual reads 17k and writes 28k.
  assert.ok(Math.abs(c!.without - (41_000 * 0.2 + 22_000 * 8 + 100 * 20) / 1e6) < 1e-12)
  assert.ok(Math.abs(c!.actual - (17_000 * 0.2 + 28_000 * 8 + 100 * 20) / 1e6) < 1e-12)
})

test('5-minute writes, long prompts and unknown models', () => {
  const short = cost([{ stats: at(0, 1000, 0), usage: { ...usage(0, 0, 1000), cache_creation: { ephemeral_5m_input_tokens: 1000 } } }], HOUR)
  assert.equal(short!.actual, (1000 * 5) / 1e6)
  const haiku = cost([{ stats: at(0, 200_000, 0, 'claude-haiku-5-5'), usage: usage(200_000, 0, 0) }], HOUR)
  assert.equal(haiku!.actual, (200_000 * 0.5) / 1e6)
  assert.equal(cost([{ stats: at(0, 1000, 0, 'm'), usage: usage(0, 0, 1000) }], HOUR), undefined)
})

test('adding a request at a time gives the same cost as the whole journal', () => {
  const lines = [
    { stats: at(0, 20_000, 0), usage: usage(0, 0, 20_000) },
    { stats: at(1, 12_000, 9000), usage: usage(0, 5000, 7000) },
    { stats: at(2, 13_000, 9000), usage: usage(0, 12_000, 1000) },
  ]
  let c = add({ without: 0, actual: 0, saved: {}, compactions: 0, waitMs: 0 }, undefined, lines[0].stats, lines[0].usage, HOUR)
  for (let i = 1; i < lines.length; i++) c = add(c, lines[i - 1].stats, lines[i].stats, lines[i].usage, HOUR)
  assert.deepEqual(c, cost(lines, HOUR))
  assert.equal(add(c, lines[2].stats, at(3, 13_000, 9000, 'm'), usage(0, 13_000, 0), HOUR), undefined)
})

test('past compactAt the client compacts, keeping the base and some of the rest', () => {
  // A 10k base, 6k of it tools of which the proxy deferred a third more.
  const big = (minute: number, inputTokens: number, removedTokens: number) =>
    ({ ...at(minute, inputTokens, removedTokens), tokens: { d: 10_000 }, parts: [], defs: { key: 'd', systemPrompt: 400, tools: 600, deferred: 200 } }) as unknown as Stats
  const lines = [
    { stats: big(0, 100_000, 0), usage: usage(0, 0, 100_000) },
    // 172k w/o the proxy: a 12k base and a 160k rest. It compacts after.
    { stats: big(1, 70_000, 100_000), usage: usage(0, 10_000, 60_000) },
    // The client's rest grew 20k: w/o, the rest is 160k kept, plus 20k.
    { stats: big(2, 90_000, 100_000), usage: usage(0, 70_000, 20_000) },
  ]
  const c = cost(lines, HOUR)!
  assert.equal(c.compactions, 1)
  assert.equal(c.waitMs, 65_000)
  // The 2k deferred: written cold, then read with the base, after the
  // compaction too.
  const price = modelOf('claude-opus-5-5').price!
  assert.ok(Math.abs(c.saved['deferred-tools'] - (2000 * 2 * price.input + 2 * 2000 * price.read) / 1e6) < 1e-12)
  assert.ok(Math.abs(c.context!.rest - (160_000 * 0.2 + 20_000)) < 1e-6)
  // The request after it reads the base and writes the rest.
  const w = without(lines[1].stats, lines[2].stats, lines[2].usage, HOUR, { rest: 160_000 * 0.2, client: 160_000, cached: 12_000 }, 165_000)
  assert.ok(Math.abs(w.tokens.reads - 12_000) < 1e-6 && Math.abs(w.tokens.writes - (160_000 * 0.2 + 20_000)) < 1e-6)
})

test('render shows the cost after the tokens', () => {
  const s = { ...at(2, 13_000, 9000), first: at(0, 0, 0).time, requests: 3, turns: 2, tokens: {}, bound: {}, answers: {}, seen: {}, parts: [], defs: { key: 'd', systemPrompt: 1, tools: 1 }, ends: { tools: 0, reasoning: 0 } } as Stats
  const c = cost([{ stats: at(0, 12_000, 9000), usage: usage(0, 0, 12_000) }, { stats: at(2, 13_000, 9000), usage: usage(0, 12_000, 1000) }], HOUR)
  const out = render(s, 'session', false, c)
  assert.match(out, /saved \(41%\)\n  Costs \(session\)\n    \$0\.18 if no shaver \(estimated, if auto-compacted\)\n    \$0\.11 actual\n    \$0\.07 saved \(41%\)\n  Auto-compactions avoided: 0 \(about 0 min of waiting\)\n  Summaries: 0 creation requests\n\nContext Details\n\n  Base/)
})

test('render splits the saving by type of trim', () => {
  const s = { ...at(2, 13_000, 9000), first: at(0, 0, 0).time, requests: 3, turns: 2, tokens: {}, bound: {}, answers: {}, seen: {}, parts: [], defs: { key: 'd', systemPrompt: 1, tools: 1 }, ends: { tools: 0, reasoning: 0 } } as Stats
  const out = render(s, 'session', false, { without: 1, actual: 0.4, saved: { 'deferred-tools': 0.1, 'skill-list': 0.05, tools: 0.3, reasoning: 0.15, messages: 0.001 }, compactions: 0, waitMs: 0 })
  assert.match(out, /\$0\.60 saved \(60%\)\n      \$0\.10 \(10%\) base:deferred-tools\n      \$0\.05 \( 5%\) base:skill-list\n      \$0\.30 \(30%\) conv:tools\n      \$0\.15 \(15%\) conv:reasoning\n  Auto/)
})

test('a trim is charged its rewrite, and later savings are shared by what each type took out', () => {
  const part = (key: string, kinds: Record<string, number>, counted?: Record<string, number>) => ({ key, kinds, ...(counted && { counted }) })
  const stats = (minute: number, inputTokens: number, removedTokens: number, parts: Stats['parts'], tokens: Record<string, number>) => ({ ...at(minute, inputTokens, removedTokens), parts, tokens }) as Stats
  // A prompt, a tool result of 6k, a reply of 4k, 3k of it reasoning by the
  // API's count though its bytes are mostly the call, and the next prompt.
  const [prompt, next] = [part('p', { user: 1 }), part('n', { user: 1 })]
  const result = part('r', { toolResults: 100 })
  const reply = part('a', { reasoning: 10, toolCalls: 90 }, { reasoning: 3000, toolCalls: 1000 })
  const trimmed = [prompt, part('r2', { toolResultsStubbed: 10 }), part('a2', { toolCalls: 90 }, { toolCalls: 1000 }), next]
  const lines = [
    { stats: stats(0, 11_000, 0, [prompt, result, reply, next], { p: 500, r: 6000, a: 4000, n: 500 }), usage: usage(0, 0, 11_000) },
    // The trim stubs the result and drops the reasoning.
    { stats: stats(1, 2100, 8900, trimmed, { p: 500, r: 6000, a: 4000, n: 500, r2: 100, a2: 1000 }), usage: usage(0, 0, 2100) },
    { stats: stats(2, 2200, 8900, [...trimmed, part('u', { user: 1 })], { p: 500, n: 500, r2: 100, a2: 1000, u: 100 }), usage: usage(0, 2100, 100) },
  ]
  const c = cost(lines, HOUR)!
  assert.deepEqual([c.removed!.tools, c.removed!.reasoning], [5900, 3000])
  const price = modelOf('claude-opus-5-5').price!
  // The trim rewrote 2.1k where it would have read 11k; after it, 8.9k more
  // would have been read.
  const trim = (11_000 * price.read - 2100 * 2 * price.input) / 1e6
  const later = (8900 * price.read) / 1e6
  assert.ok(Math.abs(c.saved.tools - ((trim + later) * 5900) / 8900) < 1e-12)
  assert.ok(Math.abs(c.saved.reasoning - ((trim + later) * 3000) / 8900) < 1e-12)

  // A later trim, of the first prompt, still credits the earlier trims with
  // the 8.9k they kept out, read; the prompt's trim takes the rest.
  const last = [...trimmed.slice(1), part('u', { user: 1 }), part('v', { user: 1 })]
  const d = cost([...lines, { stats: stats(3, 2200, 9400, last, { n: 500, r2: 100, a2: 1000, u: 100, v: 500 }), usage: usage(0, 1700, 500) }], HOUR)!
  assert.ok(Math.abs(d.saved.tools - c.saved.tools - (later * 5900) / 8900) < 1e-12)
  assert.ok(Math.abs(d.saved.reasoning - c.saved.reasoning - (later * 3000) / 8900) < 1e-12)
  assert.ok(Math.abs(d.without - d.actual - (c.without - c.actual) - (d.saved.tools - c.saved.tools) - (d.saved.reasoning - c.saved.reasoning) - (d.saved.messages ?? 0)) < 1e-12)
})

test('what was taken out before a compaction weighs what it keeps against what is taken out after', () => {
  const part = (key: string, kinds: Record<string, number>) => ({ key, kinds })
  const stats = (minute: number, inputTokens: number, removedTokens: number, parts: Stats['parts'], tokens: Record<string, number>) => ({ ...at(minute, inputTokens, removedTokens), parts, tokens }) as Stats
  const [p, n, u, w, x] = [part('p', { user: 1 }), part('n', { user: 1 }), part('u', { user: 1 }), part('w', { user: 1 }), part('x', { user: 1 })]
  const r = part('r', { toolResults: 1 })
  const r2 = part('r2', { toolResultsStubbed: 1 })
  const tokens = { p: 500, n: 500, r: 100_000, r2: 100, u: 70_000, w: 100, x: 100 }
  const lines = [
    { stats: stats(0, 101_000, 0, [p, r, n], tokens), usage: usage(0, 0, 101_000) },
    // The trim stubs the 100k result.
    { stats: stats(1, 1100, 99_900, [p, r2, n], tokens), usage: usage(0, 0, 1100) },
    // A 70k message: 171k without the proxy, past Opus's 165k, so it compacts after.
    { stats: stats(2, 71_100, 99_900, [p, r2, n, u], tokens), usage: usage(0, 1100, 70_000) },
    // The trim drops the message.
    { stats: stats(3, 1200, 169_900, [p, r2, n, w], tokens), usage: usage(0, 1100, 100) },
  ]
  const c = cost(lines, HOUR)!
  assert.equal(c.compactions, 1)
  assert.ok(Math.abs(c.removed!.tools - 99_900 * 0.2) < 1e-6)
  assert.equal(c.removed!.messages, 70_000)
  // The request after is shared 19,980 to 70k.
  const d = cost([...lines, { stats: stats(4, 1300, 169_900, [p, r2, n, w, x], tokens), usage: usage(0, 1200, 100) }], HOUR)!
  const [tools, messages] = [d.saved.tools - c.saved.tools, d.saved.messages - c.saved.messages]
  assert.ok(Math.abs(tools / messages - 19_980 / 70_000) < 1e-9)
})

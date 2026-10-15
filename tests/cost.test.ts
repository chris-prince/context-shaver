import assert from 'node:assert/strict'
import { test } from 'node:test'
import { add, cost, without, type Usage } from '../src/cost.ts'
import { render, type Stats } from '../src/stats.ts'

const HOUR = 3600e3
const at = (minute: number, inputTokens: number, removedTokens: number, model = 'claude-opus-5-5') =>
  ({ time: new Date(Date.UTC(2026, 9, 14, 10, minute)).toISOString(), inputTokens, removedTokens, model }) as Stats
const usage = (uncached: number, reads: number, writes: number, output = 0): Usage => ({ input_tokens: uncached, cache_read_input_tokens: reads, cache_creation_input_tokens: writes, cache_creation: { ephemeral_1h_input_tokens: writes }, output_tokens: output })

test('cold, both read only the shared prefix and write the rest', () => {
  assert.deepEqual(without(undefined, at(0, 10_000, 4000), usage(10, 5000, 4990, 7), HOUR), { uncached: 10, reads: 5000, writes: 8990, output: 7 })
  assert.deepEqual(without(at(0, 10_000, 4000), at(61, 10_000, 4000), usage(10, 5000, 4990), HOUR).writes, 8990)
})

test('a warm advance would have read the whole previous prompt', () => {
  // Was 20k, of which nothing trimmed; now 12k with 9k trimmed: 21k w/o.
  assert.deepEqual(without(at(0, 20_000, 0), at(1, 12_000, 9000), usage(10, 5000, 6990), HOUR), { uncached: 10, reads: 20_000, writes: 990, output: 0 })
})

test('otherwise the trimmed-out tokens are read on a hit and written on a miss', () => {
  const prev = at(0, 12_000, 9000)
  assert.deepEqual(without(prev, at(1, 13_000, 9000), usage(10, 12_000, 990), HOUR), { uncached: 10, reads: 21_000, writes: 990, output: 0 })
  assert.deepEqual(without(prev, at(1, 13_000, 9000), usage(10, 5000, 7990), HOUR), { uncached: 10, reads: 5000, writes: 16_990, output: 0 })
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
  let c = add({ without: 0, actual: 0 }, undefined, lines[0].stats, lines[0].usage, HOUR)
  for (let i = 1; i < lines.length; i++) c = add(c, lines[i - 1].stats, lines[i].stats, lines[i].usage, HOUR)
  assert.deepEqual(c, cost(lines, HOUR))
  assert.equal(add(c, lines[2].stats, at(3, 13_000, 9000, 'm'), usage(0, 13_000, 0), HOUR), undefined)
})

test('render shows the cost after the tokens', () => {
  const s = { ...at(2, 13_000, 9000), first: at(0, 0, 0).time, requests: 3, turns: 2, tokens: {}, bound: {}, answers: {}, seen: {}, parts: [], defs: { key: 'd', systemPrompt: 1, tools: 1 }, ends: { tools: 0, reasoning: 0 } } as Stats
  const c = cost([{ stats: at(0, 12_000, 9000), usage: usage(0, 0, 12_000) }, { stats: at(2, 13_000, 9000), usage: usage(0, 12_000, 1000) }], HOUR)
  const out = render(s, 'session', false, c)
  assert.match(out, /saved \(41%\)\n  Costs \(session\)\n    \$0\.18 if no shaver \(estimated\)\n    \$0\.11 actual\n    \$0\.07 saved \(41%\)\n  Summaries: 0 creation requests\n\nContext Details\n\n  Base/)
})

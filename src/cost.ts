// What a conversation's requests cost, and what they would have cost without
// the proxy's trims, from its journal (journal.ts) and nothing more: each line
// holds the request's usage as the API reported it, and the stats it leaves
// give the prompt's size now (inputTokens) and without the trims
// (inputTokens + removedTokens).
//
// The counterfactual is per request, against the journal's previous one:
// - Cold (none, or the cache's TTL has passed since): both read only what
//   this one read, the system prompt and tools; the trimmed-out tokens would
//   have been written too.
// - Advanced while warm: the trim's rewrite. Without it the request would have
//   read the whole previous prompt and written only what is new.
// - Otherwise as it was, the trimmed-out tokens read on a hit and written on a
//   miss.
// Output is the same either way.

import type { Stats } from './stats.ts'

export type Usage = {
  input_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  output_tokens?: number
}

// Dollars a million tokens. Writes cost 1.25x input at the 5-minute TTL and
// 2x at the hour. A long prompt, over `long.over` tokens, costs `long.times`
// as much in all.
type Price = { input: number; output: number; read: number; long?: { over: number; times: number } }
export const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, read: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, read: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, read: 0.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, read: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, read: 0.01, long: { over: 100_000, times: 5 } },
  // At DeepInfra, which OpenCode pins it to; other providers price it apart.
  'deepseek/deepseek-v4.1-flash': { input: 0.14, output: 0.42, read: 0.0042 },
}

export type Tokens = { uncached: number; reads: number; writes: number; output: number }
// Dollars, without the trims and as it was.
export type Cost = { without: number; actual: number }

// What the request would have sent without the trims.
export function without(prev: Stats | undefined, s: Stats, u: Usage, ttlMs: number): Tokens {
  const reads = u.cache_read_input_tokens ?? 0
  const writes = u.cache_creation_input_tokens ?? 0
  const removed = s.removedTokens ?? 0
  const all = s.inputTokens + removed
  const output = u.output_tokens ?? 0
  const uncached = u.input_tokens
  if (!prev || Date.parse(s.time) - Date.parse(prev.time) > ttlMs) return { uncached, reads, writes: writes + removed, output }
  if (removed !== (prev.removedTokens ?? 0)) {
    const r = Math.min(prev.inputTokens + (prev.removedTokens ?? 0), all - uncached)
    return { uncached, reads: r, writes: all - uncached - r, output }
  }
  return reads >= s.inputTokens / 2 ? { uncached, reads: reads + removed, writes, output } : { uncached, reads, writes: writes + removed, output }
}

// A request's tokens in dollars; writes at the hour's price but for the share
// written for 5 minutes.
function dollars(p: Price, t: Tokens, short: number): number {
  const times = p.long && t.uncached + t.reads + t.writes > p.long.over ? p.long.times : 1
  const writes = (short * 1.25 + (t.writes - short) * 2) * p.input
  return ((t.uncached * p.input + t.reads * p.read + writes + t.output * p.output) * times) / 1e6
}

// What a request the client never saw cost, as a summary fork (summary.ts);
// nothing for a model with no price.
export function spent(model: string, u: Usage): number {
  const p = PRICES[model]
  const t: Tokens = { uncached: u.input_tokens, reads: u.cache_read_input_tokens ?? 0, writes: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 }
  return p ? dollars(p, t, u.cache_creation?.ephemeral_5m_input_tokens ?? 0) : 0
}

// The cost so far with a request's added, given the stats it leaves, the stats
// before it, and its usage; none once a request's model has no price.
export function add(c: Cost | undefined, prev: Stats | undefined, s: Stats, u: Usage, ttlMs: number): Cost | undefined {
  const p = PRICES[s.model]
  if (!c || !p) return undefined
  const actual: Tokens = { uncached: u.input_tokens, reads: u.cache_read_input_tokens ?? 0, writes: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 }
  const wo = without(prev, s, u, ttlMs)
  return {
    without: c.without + dollars(p, wo, ttlMs > 300_000 ? 0 : wo.writes),
    actual: c.actual + dollars(p, actual, u.cache_creation?.ephemeral_5m_input_tokens ?? 0),
  }
}

// The cost of the requests each stats line follows, given as each line's stats
// and the usage it holds. Lines from before the journal held usage count for
// nothing.
export function cost(lines: Iterable<{ stats: Stats; usage?: Usage }>, ttlMs: number): Cost | undefined {
  let c: Cost | undefined = { without: 0, actual: 0 }
  let prev: Stats | undefined
  for (const { stats: s, usage: u } of lines) {
    if (u) c = add(c, prev, s, u, ttlMs)
    prev = s
  }
  return c
}

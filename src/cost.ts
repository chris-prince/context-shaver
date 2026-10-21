// What a conversation's requests cost, and what they would have cost without
// the proxy, from its journal (journal.ts) and nothing more: each line holds
// the request's usage as the API reported it, and the stats it leaves give the
// prompt's size now (inputTokens) and without the trims (inputTokens +
// removedTokens).
//
// Without the proxy the prompt would also hold the tool definitions it
// deferred, in the base, and where the client compacts by itself (Model's
// compactAt), the conversation would not have grown past that: the
// counterfactual keeps its own size, growing as the client's conversation
// grows, and once the prompt passes compactAt the client compacts it, as a
// request reading the whole prompt and answering with a summary, and the
// conversation after the base keeps KEPT of its size. That request, and the
// wait for it, are what the proxy saved.
//
// Each request, against the journal's previous one:
// - Cold (none, or the cache's TTL has passed since): it reads what this one
//   read, with the deferred tools if that was the base, and writes the rest.
// - Warm and advanced: it reads all the previous prompt was, or the base after
//   a compaction, and writes the rest.
// - Warm and read from the cache: it reads as far as this one, plus all the
//   proxy took out, up to what the previous prompt was.
// - Otherwise, a miss without a trim, as cold.
// Output is the same either way.

import { modelOf, type Price } from './models.ts'
import { baseOf, type Stats } from './stats.ts'

export type Usage = {
  input_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  output_tokens?: number
}


// Five Claude Code compactions logged on 2026-10-08 to 10-10: what came after
// the base kept 11-29% of its tokens (a median of 18%, rounded to 20%), the
// summary ran 6.6-8.9K tokens, and the next request came about a minute later.
const KEPT = 0.2
const SUMMARY_TOKENS = 7600
const COMPACTION_MS = 65_000

export type Tokens = { uncached: number; reads: number; writes: number; output: number }
// The prompt without the proxy, after a request: its tokens past the base,
// those of the client's own (untrimmed) prompt, and how much of it the cache
// holds for the next request.
export type Context = { rest: number; client: number; cached: number }
// Dollars, without the proxy and as it was, and the share of the difference
// that is the tool definitions it deferred; the compactions the proxy saved,
// and the time they'd have taken.
export type Cost = { without: number; actual: number; deferral: number; compactions: number; waitMs: number; context?: Context }

// A request's base without the proxy: with the tool definitions it deferred
// and the skill list it shortened, at the base's tokens a byte.
// Blind spot: a deferred tool the model loads with ToolSearch is expanded into
// the conversation from then on, so it's paid for there, while it's still
// counted here as deferred. The estimate then pays for it twice, overstating
// the saving (and the deferral share) by about its size a request; the
// ToolSearch request itself, a cost of deferring, isn't charged to it either.
const baseWithout = (s: Stats) => (s.defs ? baseOf(s) + (s.defs.deferred ? ((s.tokens[s.defs.key] ?? 0) * s.defs.deferred) / (s.defs.systemPrompt + s.defs.tools) : 0) : 0)
// The client's own (untrimmed) prompt past the base.
const clientRest = (s: Stats) => s.inputTokens + (s.removedTokens ?? 0) - (s.defs ? baseOf(s) : 0)
// The prompt without the proxy after a request, before any compaction.
const contextOf = (s: Stats): Context => ({ rest: clientRest(s), client: clientRest(s), cached: baseWithout(s) + clientRest(s) })

// What the request would have sent without the proxy, and the prompt then,
// whether the client compacts after it. Without the prompt before it, that
// is the previous request's as the client sent it.
export function without(prev: Stats | undefined, s: Stats, u: Usage, ttlMs: number, ctx = prev && contextOf(prev), compactAt?: number): { tokens: Tokens; context: Context; compacted: boolean } {
  const reads = u.cache_read_input_tokens ?? 0
  const base = baseWithout(s)
  const client = clientRest(s)
  const rest = ctx ? Math.min(ctx.rest + client - ctx.client, client) : client
  const all = base + rest
  const uncached = u.input_tokens
  const warm = prev && ctx && Date.parse(s.time) - Date.parse(prev.time) <= ttlMs
  const advanced = warm && (s.removedTokens ?? 0) !== (prev.removedTokens ?? 0)
  const read = warm && !advanced && reads >= s.inputTokens / 2
  const r = Math.min(all - uncached, advanced ? ctx.cached : read ? Math.min(ctx.cached, reads + all - s.inputTokens) : reads && reads + base - (s.defs ? baseOf(s) : 0))
  const tokens = { uncached, reads: r, writes: all - uncached - r, output: u.output_tokens ?? 0 }
  if (compactAt && all > compactAt) return { tokens, context: { rest: rest * KEPT, client, cached: base }, compacted: true }
  return { tokens, context: { rest, client, cached: all }, compacted: false }
}

// A request's tokens in dollars; writes at the hour's price but for the share
// written for 5 minutes, or at the model's own write price.
function dollars(p: Price, t: Tokens, short: number): number {
  const times = p.long && t.uncached + t.reads + t.writes > p.long.over ? p.long.times : 1
  const writes = p.write ? t.writes * p.write : (short * 1.25 + (t.writes - short) * 2) * p.input
  return ((t.uncached * p.input + t.reads * p.read + writes + t.output * p.output) * times) / 1e6
}

// What a request the client never saw cost, as a summary fork (summary.ts);
// nothing for a model with no price.
export function spent(model: string, provider: string | undefined, u: Usage): number {
  const p = modelOf(model, provider).price
  const t: Tokens = { uncached: u.input_tokens, reads: u.cache_read_input_tokens ?? 0, writes: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 }
  return p ? dollars(p, t, u.cache_creation?.ephemeral_5m_input_tokens ?? 0) : 0
}

// The cost so far with a request's added, given the stats it leaves, the stats
// before it, and its usage; none once a request's model has no price.
export function add(c: Cost | undefined, prev: Stats | undefined, s: Stats, u: Usage, ttlMs: number): Cost | undefined {
  const m = modelOf(s.model, s.provider)
  const p = m.price
  if (!c || !p) return undefined
  const actual: Tokens = { uncached: u.input_tokens, reads: u.cache_read_input_tokens ?? 0, writes: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 }
  const short = (t: Tokens) => (ttlMs > 300_000 ? 0 : t.writes)
  const wo = without(prev, s, u, ttlMs, c.context, m.compactAt)
  const all = wo.tokens.uncached + wo.tokens.reads + wo.tokens.writes
  const compaction: Tokens = { uncached: 0, reads: all, writes: 0, output: SUMMARY_TOKENS }
  // The deferred tools sit at the front, so they were read with the base or
  // written with it. A compaction's reading them counts with the conversation,
  // whose growth it comes from.
  const deferred = baseWithout(s) - (s.defs ? baseOf(s) : 0)
  const read = wo.tokens.reads >= baseWithout(s)
  const less: Tokens = { ...wo.tokens, reads: wo.tokens.reads - (read ? deferred : 0), writes: wo.tokens.writes - (read ? 0 : deferred) }
  const withoutRequest = dollars(p, wo.tokens, short(wo.tokens))
  return {
    without: c.without + withoutRequest + (wo.compacted ? dollars(p, compaction, 0) : 0),
    actual: c.actual + dollars(p, actual, u.cache_creation?.ephemeral_5m_input_tokens ?? 0),
    deferral: c.deferral + withoutRequest - dollars(p, less, short(less)),
    compactions: c.compactions + (wo.compacted ? 1 : 0),
    waitMs: c.waitMs + (wo.compacted ? COMPACTION_MS : 0),
    context: wo.context,
  }
}

// The cost of the requests each stats line follows, given as each line's stats
// and the usage it holds. Lines from before the journal held usage count for
// nothing.
export function cost(lines: Iterable<{ stats: Stats; usage?: Usage }>, ttlMs: number): Cost | undefined {
  let c: Cost | undefined = { without: 0, actual: 0, deferral: 0, compactions: 0, waitMs: 0 }
  let prev: Stats | undefined
  for (const { stats: s, usage: u } of lines) {
    if (u) c = add(c, prev, s, u, ttlMs)
    prev = s
  }
  return c
}

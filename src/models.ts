// What the proxy knows of each model: its prices and how its prompt cache
// behaves. A model's entry holds what is true wherever it is served; under
// `providers`, what one provider behind a router does differently, which
// overrides it field by field. The provider is the one a request pins
// (Canonical.provider), as OpenCode pins OpenRouter's with provider.order.

// Dollars a million tokens. Writes cost 1.25x input at the 5-minute TTL and
// 2x at the hour; with automatic caching (protocol.ts) they're billed as plain
// input, which usage reports as uncached. A model whose writes cost something
// else gives `write`. A long prompt, over `long.over` tokens, costs `long.times`
// as much in all, but its output `long.output` times as much where that's given.
export type Price = { input: number; output: number; read: number; write?: number; long?: { over: number; times: number; output?: number } }

export type Model = {
  price?: Price
  // How far back from a breakpoint a request finds an entry (trim.ts, readThrough).
  lookback: number
  // Seconds an entry lasts unread, where the request's breakpoints don't say.
  ttl?: number
  // Tokens of earlier turns that start a summary fork, in place of the policy's
  // summary_threshold_tokens; the policy still decides whether there are any.
  summaryThreshold?: number
  // How the client compacts the conversation by itself, which the cost
  // without the shaver counts (cost.ts): past `at` tokens of prompt, a request
  // reads it all and answers with `summary` tokens, taking `ms`. The prompt
  // then keeps its base and `kept` of the rest, or with 'prompts' the user's
  // messages, up to PROMPTS_KEPT tokens, and the summary.
  compaction?: Compaction
  // The later requests a trim's savings are counted over (trim.ts, decide),
  // given the requests before this one and those since the messages were
  // last trimmed.
  horizon: (n: number, since: number) => number
}
type Settings = Partial<Model>
export type Compaction = { at: number; kept: number | 'prompts'; summary: number; ms: number }

// Codex keeps the newest user messages up to 64K tokens (compact_remote_v2.rs,
// RETAINED_MESSAGE_TOKEN_BUDGET, by osolmaz's reading of its source; local/notes.md).
export const PROMPTS_KEPT = 64_000

// Where a client compacts is worked out per request from its harness's
// settings (autocompact.ts); `at` here stands where that can't be said.
// Claude Code compacts on a 200K window at 167K: the eight automatic
// compaction requests logged here that the shaver left untrimmed read
// 164.7-167.1K tokens (usage). In five compactions, what came after the
// base kept 11-29% of its tokens (a median of 18%, rounded to 20%), the
// summary ran 6.6-8.9K tokens, and the next request came about a minute later.
const CLAUDE_CODE = { compaction: { at: 165_000, kept: 0.2, summary: 7600, ms: 65_000 } }

// Codex caps its auto-compact limit at 90% of the context window, and luna's
// is 272K (~/.codex/models_cache.json; local/notes.md, "Make Codex's cost and
// savings figures accurate"). It compacts remotely (v2): the answer is one
// encrypted item, the summary, which the prompt keeps after the user's
// messages. Two logged here (2026-10-24) counted 150-200 tokens, at about 20
// of its characters a token, and their requests answered with about as many; over
// 1,087 compactions osolmaz measured a median item of 15,820 characters, so
// about 800 tokens, and 34s for one of a 174K prompt.
const CODEX_V2 = { at: 244_800, kept: 'prompts' as const, summary: 800, ms: 34_000 } // at: 90% of 272K
// OpenAI's long prompts: past 272K input tokens, input, reads and writes
// double and output is 1.5x (OpenRouter's listings, 2026-11-16).
const OPENAI_LONG = { over: 272_000, times: 2, output: 1.5 }
const LUNA = { price: { input: 0.1, output: 0.5, read: 0.01, write: 0.125, long: OPENAI_LONG }, lookback: 50, ttl: 1800, compaction: CODEX_V2 }
// Sol's window is 272K too (`codex debug models`, Codex 0.163.0). Its lookback
// was probed on 2026-11-17 through Codex (probe-codex-model-details.ts
// lookback): read 38 runs back, nothing at 39, at about 250 and 1,000 tokens
// a run, so it counts runs, not tokens.
const SOL = { price: { input: 2, output: 10, read: 0.1, write: 2.5, long: OPENAI_LONG }, lookback: 38, ttl: 1800, compaction: CODEX_V2 }
// Prices from OpenRouter's listings (2026-11-16): reads at 0.05x input on
// terra, 0.1x on astra, writes at 1.25x. The TTL was probed on 2026-11-16
// through OpenRouter (check-prices.ts --lifetime): entries read after 1, 15
// and 28 minutes, nothing after 32. The lookback was probed on 2026-11-17
// through Codex, as sol's was: astra's is sol's, 38 runs (at about 250 tokens
// a run only); terra's is 20 runs at about 250 and 1,000 tokens a run (read at
// 20, at 21 and 22 only the session's opening, 21,488 tokens, which terra kept
// past its lookback, a read this table doesn't model). Terra's window is
// 500K where Codex's model catalog lists it (`codex debug models`, Codex
// 0.169.0), so Codex compacts it at 450K; a ChatGPT sign-in's catalog doesn't
// list terra or astra yet. The compaction's summary and time are sol's, not
// measured on these.
const TERRA = { ...SOL, price: { input: 1, output: 5, read: 0.05, write: 1.25, long: OPENAI_LONG }, lookback: 20, compaction: { ...CODEX_V2, at: 450_000 } } // at: 90% of 500K
const ASTRA = { ...SOL, price: { input: 10, output: 50, read: 1, write: 12.5, long: OPENAI_LONG }, lookback: 38 }

const MODELS: Record<string, Settings & { providers?: Record<string, Settings> }> = {
  'claude-opus-5-5': { price: { input: 4, output: 20, read: 0.2 }, ...CLAUDE_CODE },
  'claude-fable-5-1': { price: { input: 10, output: 50, read: 0.25 }, ...CLAUDE_CODE },
  // OpenRouter's listing (2026-11-16): reads at 0.025x input, writes at the
  // usual 1.25x and 2x, as billed (scripts/check-prices.ts). The 1-hour TTL
  // was probed on 2026-11-16, served by Anthropic, two reads per gap: read
  // after 1, 30 and 58 minutes, gone after 62. The lookback is assumed to be
  // Anthropic's documented 20 blocks.
  'claude-fable-5-2': { price: { input: 8, output: 40, read: 0.2 }, ...CLAUDE_CODE },
  'claude-mythos-5-1': { price: { input: 10, output: 50, read: 0.25 }, ...CLAUDE_CODE },
  // Reads at 0.1, as billed through OpenRouter (scripts/check-prices.ts).
  'claude-sonnet-5-5': { price: { input: 2, output: 10, read: 0.1 }, ...CLAUDE_CODE },
  // Anthropic's pricing page, matching OpenRouter: reads at 0.1x input, not
  // Sonnet 5.5's 0.05x, and no long-context surcharge across its 1M window.
  // The lookback (20 blocks) and the TTL (5 minutes or an hour, as each
  // request's breakpoints ask) are Anthropic's documented ones (DEFAULT, markedTtl).
  // Claude Code 2.1.287 asks for 5 minutes. Probed on 2026-10-27, two sessions
  // per gap: each session's own
  // 11.4K tokens were all read after 1 and 4 minutes, and rewritten after 6
  // and 10. The base before them, the same in every session, was read throughout.
  'claude-sonnet-5': { price: { input: 2, output: 10, read: 0.2 }, ...CLAUDE_CODE },
  'claude-haiku-5-5': { price: { input: 0.1, output: 0.5, read: 0.01, long: { over: 100_000, times: 5 } }, ...CLAUDE_CODE },
  // OpenAI's pricing page and prompt-caching guide (local/notes.md, "Check
  // Codex in use"): writes at 1.25x input, the latest 50 breakpoints looked
  // through, and entries kept at least 30 minutes after their last use. A
  // Codex session read nearly all of it after 35 minutes and nothing after 59,
  // so the 30 minutes is what's counted on. OpenRouter names it openai/gpt-6-luna.
  'gpt-6-luna': LUNA,
  'openai/gpt-6-luna': LUNA,
  // Prices from OpenAI's model page, matching OpenRouter's: reads at 0.05x
  // input, not luna's 0.1x, and writes at 1.25x. The TTL was probed on
  // 2026-10-27 through Codex 0.163.0, two sessions per gap: all read after 28
  // minutes, nothing after 32 or 60. So the 30 minutes is a hard edge, not a
  // floor. The compaction summary is luna's, not yet measured on sol.
  'gpt-6.1-sol': SOL,
  'openai/gpt-6.1-sol': SOL,
  'gpt-6.1-terra': TERRA,
  'openai/gpt-6.1-terra': TERRA,
  'gpt-6-astra': ASTRA,
  'openai/gpt-6-astra': ASTRA,
  // Priced apart by each provider, so only per provider.
  'deepseek/deepseek-v4.1-flash': {
    providers: {
      // Measured through OpenRouter (mini-ctx-opencode's notes.md and
      // cache-behavior.md; local/notes.md, "DeepInfra lookback"): an hour's
      // TTL, writes at the input price, and an entry for every 128-token
      // prefix, found however far back it is. Warm requests read their entry
      // reliably (26 of 26 there; every one in a real OpenCode session here).
      deepinfra: { price: { input: 0.14, output: 0.42, read: 0.0042 }, lookback: Infinity, summaryThreshold: 7000 },
    },
  },
}

// Anthropic's lookback, 20 blocks, and GPT-5.6's, 20 user runs (local/openai-design.md, "CacheModel").
// The horizon is one for every harness. A trim held back now is mostly made a
// little later, once as much more is due, so its savings are counted only
// over half the requests since the last trim. In backtests of Claude Code,
// Codex and OpenCode sessions (2026-11-17, local/notes.md, "A trim's
// horizon") that did as well as or better than each harness's best before
// (min(20, 0.6n) for Claude Code, 5 for Codex and OpenCode). SINCE = Infinity
// gives the horizon without the cap.
export const SINCE = 0.5
const DEFAULT: Model = { lookback: 20, horizon: (n, since) => Math.min(20, 0.6 * n, SINCE * since) }

export function modelOf(name: string, provider?: string): Model {
  const { providers, ...m } = MODELS[name] ?? {}
  return { ...DEFAULT, ...m, ...(provider ? providers?.[provider] : undefined) }
}

// How long entries last, in ms: `ttl` (what the request's breakpoints asked
// for, trim.ts, markedTtl, else the model's), but never past --cache-ttl-seconds.
export const lifetimeMs = (ttl: number | undefined, capMs: number) => Math.min(capMs, (ttl ?? Infinity) * 1000)

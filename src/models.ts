// What the proxy knows of each model: its prices and how its prompt cache
// behaves. A model's entry holds what is true wherever it is served; under
// `providers`, what one provider behind a router does differently, which
// overrides it field by field. The provider is the one a request pins
// (Canonical.provider), as OpenCode pins OpenRouter's with provider.order.

// Dollars a million tokens. Writes cost 1.25x input at the 5-minute TTL and
// 2x at the hour; with automatic caching (protocol.ts) they're billed as plain
// input, which usage reports as uncached. A model whose writes cost something
// else gives `write`. A long prompt, over `long.over` tokens, costs `long.times`
// as much in all.
export type Price = { input: number; output: number; read: number; write?: number; long?: { over: number; times: number } }

export type Model = {
  price?: Price
  // How far back from a breakpoint a request finds an entry (trim.ts, readThrough).
  lookback: number
  // Seconds an entry lasts unread, where it isn't --cache-ttl-seconds.
  ttl?: number
  // Tokens of earlier turns that start a summary fork, in place of the policy's
  // summary_threshold_tokens; the policy still decides whether there are any.
  summaryThreshold?: number
  // The prompt's tokens past which the client compacts the conversation by
  // itself, which the cost without the shaver counts (cost.ts).
  compactAt?: number
  // The later requests a trim's savings are counted over (trim.ts, decide),
  // given the requests before this one.
  horizon: (n: number) => number
}
type Settings = Partial<Model>

// Claude Code compacts on a 200K window at about 165K: five compactions
// logged here fired at 144-167K.
const CLAUDE_CODE = { compactAt: 165_000 }

// Backtests of logged sessions (local/notes.md, "A trim's horizon"): Codex and
// OpenCode sessions did best counting a trim over 5 requests.
const SHORT = () => 5

const MODELS: Record<string, Settings & { providers?: Record<string, Settings> }> = {
  'claude-opus-5-5': { price: { input: 4, output: 20, read: 0.2 }, ...CLAUDE_CODE },
  'claude-fable-5-1': { price: { input: 10, output: 50, read: 0.25 }, ...CLAUDE_CODE },
  'claude-mythos-5-1': { price: { input: 10, output: 50, read: 0.25 }, ...CLAUDE_CODE },
  'claude-sonnet-5-5': { price: { input: 2, output: 10, read: 0.2 }, ...CLAUDE_CODE },
  'claude-haiku-5-5': { price: { input: 0.1, output: 0.5, read: 0.01, long: { over: 100_000, times: 5 } }, ...CLAUDE_CODE },
  // OpenAI's pricing page and prompt-caching guide (local/notes.md, "Check
  // Codex in use"): writes at 1.25x input, the latest 50 breakpoints looked
  // through, and entries kept at least 30 minutes after their last use. A
  // Codex session read nearly all of it after 35 minutes and nothing after 59,
  // so the 30 minutes is what's counted on. Past 272K input tokens, input
  // doubles and output is 1.5x, which `long` can't say.
  'gpt-6-luna': { price: { input: 0.1, output: 0.5, read: 0.01, write: 0.125 }, lookback: 50, ttl: 1800, horizon: SHORT },
  // Priced apart by each provider, so only per provider.
  'deepseek/deepseek-v4.1-flash': {
    providers: {
      // Measured through OpenRouter (mini-ctx-opencode's notes.md and
      // cache-behavior.md; local/notes.md, "DeepInfra lookback"): an hour's
      // TTL, writes at the input price, and an entry for every 128-token
      // prefix, found however far back it is. Warm requests read their entry
      // reliably (26 of 26 there; every one in a real OpenCode session here).
      deepinfra: { price: { input: 0.14, output: 0.42, read: 0.0042 }, lookback: Infinity, summaryThreshold: 7000, horizon: SHORT },
    },
  },
}

// Anthropic's lookback, 20 blocks, and GPT-5.6's, 20 user runs (local/openai-design.md, "CacheModel").
// The horizon did best on Claude Code sessions, short ones most of all, of
// those backtested (local/notes.md, "A trim's horizon").
const DEFAULT: Model = { lookback: 20, horizon: (n) => Math.min(20, 0.6 * n) }

export function modelOf(name: string, provider?: string): Model {
  const { providers, ...m } = MODELS[name] ?? {}
  return { ...DEFAULT, ...m, ...(provider ? providers?.[provider] : undefined) }
}

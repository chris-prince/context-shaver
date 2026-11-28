// Unless SHAVER_CODEX_BREAKPOINTS=0, a Responses (Codex) request's anchors
// are sent as explicit breakpoints (OpenAI's prompt_cache_breakpoint, which
// responses.ts puts on where the core marked a block): up to three in every
// request's messages and one at its system prompt's end (trim.ts, liveEnd and
// markedSystem). It's been seen to work for gpt-6.1-sol, gpt-6.1-terra,
// gpt-6-astra and gpt-6-luna; Codex's ChatGPT backend refuses it for
// gpt-6-luna ("not supported on this model", 2026-11-25). A model whose
// upstream refuses a marked request, its first, is sent the same request
// without it, and not marked again until the proxy restarts.

export const on = process.env.SHAVER_CODEX_BREAKPOINTS !== '0'

// Models whose upstream refused the field since the proxy started.
const refused = new Set<string>()

// Whether a request of this model gets explicit breakpoints.
export const marking = (model: string) => on && !refused.has(model)

// Sends a Responses request. A 400 to one with a breakpoint, whatever its
// words, sends it again with every breakpoint taken out, which leaves the
// prompt as it was: if that's accepted, the field was what was refused, and
// the model isn't marked again; if not, the first 400 is answered, for the
// freeze (server.ts, Frozen) to deal with as any other.
export async function fetchMarked(url: string, init: { method?: string; headers: Record<string, string>; body?: Buffer | string; signal?: AbortSignal }): Promise<Response> {
  const r = await fetch(url, init)
  if (!on || r.status !== 400 || init.body === undefined || !String(init.body).includes('"prompt_cache_breakpoint"')) return r
  let b: { model?: unknown }
  try {
    b = JSON.parse(String(init.body))
  } catch {
    return r
  }
  const again = await fetch(url, { ...init, body: JSON.stringify(b, (k, v) => (k === 'prompt_cache_breakpoint' ? undefined : v)) })
  if (again.status === 400) {
    await again.body?.cancel()
    return r
  }
  refused.add(String(b.model))
  const error = (await r.text()).replace(/\s+/g, ' ').slice(0, 200)
  console.error(`${new Date().toISOString()} shaver: ${b.model} refused prompt_cache_breakpoint (${error}); sent without it, and not sent it again until the proxy restarts`)
  return again
}

// With SHAVER_DROP_UNBOUND_THINKING=1 (temporary, while preserved thinking is
// new), a Messages request asks the API to drop thinking blocks no longer
// bound to the conversation before them, rather than refuse the request.
//
// Each thinking block of a model with preserved thinking is bound to the
// system, tools and messages that came before it as the API saw them. Shaving
// changes those, so the thinking after a trim, a stub or a summary no longer
// matches. Unset, Fable 5.2 and Mythos 5.x answer that with a 400, and Opus,
// Sonnet and Haiku 5.5 may, or let the blocks through, billed. With
// thinking.block_binding.prefix_mismatch_behavior "drop_block" and the
// thinking-binding-controls beta, the API drops them, unbilled, and lists them
// in input_transformations. A block still bound is left alone, so the setting
// goes on every request that holds thinking: what the API saw before is the
// proxy's doing, not the client's, so its request can't tell.
//
// Models are excluded, not listed, so new ones get it: Claude 3, 4.x and the
// 5.0s don't check the binding, and what they do with the setting isn't
// documented. A model that refuses it anyway is sent the request without it,
// and not the setting again until the proxy restarts.

export const BETA = 'thinking-binding-controls-2026-08-01'
export const on = process.env.SHAVER_DROP_UNBOUND_THINKING === '1'

// Models that refused the setting since the proxy started.
const refused = new Set<string>()

// Whether a model gets the setting: a Claude model newer than the 5.0s. Its ID
// is read without a provider's prefix (us.anthropic.), a version suffix (-v1:0,
// @20250805), a date or a window ([1m]).
export function eligible(model: string): boolean {
  const at = model.indexOf('claude-')
  if (at < 0 || refused.has(model)) return false
  const id = model.slice(at).replace(/\[.*\]$/, '').replace(/@.*$/, '').replace(/-v\d+(:\d+)?$/, '').replace(/-\d{8}$/, '')
  return !/^claude-(\d|[a-z]+-[34](-|$)|[a-z]+-5$)/.test(id)
}

// A request body with drop_block set, or undefined where it's left as it is:
// not JSON, a model not eligible, no thinking blocks in its messages, thinking
// other than adaptive (the setting is a 400 with thinking off), or a
// block_binding the client chose itself.
export function bound(body: Buffer): { body: Buffer; model: string } | undefined {
  let b: any
  try {
    b = JSON.parse(body.toString('utf8'))
  } catch {
    return
  }
  if (!b || typeof b.model !== 'string' || !eligible(b.model)) return
  const t = b.thinking
  if (t !== undefined && (t?.type !== 'adaptive' || t.block_binding !== undefined)) return
  const thinks = Array.isArray(b.messages) && b.messages.some((m: any) => Array.isArray(m?.content) && m.content.some((c: any) => c?.type === 'thinking' || c?.type === 'redacted_thinking'))
  if (!thinks) return
  b.thinking = { ...(t ?? { type: 'adaptive' }), block_binding: { prefix_mismatch_behavior: 'drop_block' } }
  return { body: Buffer.from(JSON.stringify(b)), model: b.model }
}

// The headers with the beta added to the client's anthropic-beta, if it isn't there.
export function withBeta(headers: Record<string, string>): Record<string, string> {
  const was = headers['anthropic-beta']
  if (!was) return { ...headers, 'anthropic-beta': BETA }
  return was.split(',').some((v) => v.trim() === BETA) ? headers : { ...headers, 'anthropic-beta': `${was},${BETA}` }
}

// Responses to requests sent with drop_block, so their logs can say so: one
// with no input_transformations logged then dropped nothing.
const asked = new WeakSet<Response>()
export const dropAsked = (r: Response) => asked.has(r)

// Sends a Messages request, with drop_block where bound sets it, when on. A
// 400 that names the setting or the beta sends it again as given.
export async function fetchBound(url: string, init: { method?: string; headers: Record<string, string>; body?: Buffer | string; signal?: AbortSignal }): Promise<Response> {
  const b = on && init.body !== undefined ? bound(Buffer.from(init.body)) : undefined
  if (!b) return fetch(url, init)
  const r = await fetch(url, { ...init, headers: withBeta(init.headers), body: b.body })
  if (r.status !== 400 || !/block_binding|thinking-binding-controls/.test(await r.clone().text())) return asked.add(r), r
  refused.add(b.model)
  console.error(`${new Date().toISOString()} shaver: ${b.model} refused drop_block for unbound thinking; sent without it, and not sent it again until the proxy restarts`)
  return fetch(url, init)
}

// A response's input_transformations, counted by type and reason, as
// "thinking_dropped/prefix_binding_mismatch".
export function transformed(list: unknown): Record<string, number> | undefined {
  if (!Array.isArray(list) || !list.length) return
  const out: Record<string, number> = {}
  for (const t of list) {
    const k = `${t?.type ?? '?'}/${t?.reason ?? '?'}`
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

// The messages whose thinking a response's input_transformations dropped, by
// index in the request as sent, from paths as "messages.3.content.0".
export function droppedAt(list: unknown): number[] | undefined {
  if (!Array.isArray(list)) return
  const at = new Set<number>()
  for (const t of list) {
    const m = t?.type === 'thinking_dropped' && /^messages\.(\d+)\./.exec(String(t.path))
    if (m) at.add(Number(m[1]))
  }
  return at.size ? [...at] : undefined
}

// Once the API refuses a conversation's shaved request for thinking no longer
// bound to the conversation before it, that conversation's Messages requests
// ask the API to drop such blocks instead (the server keeps this in its state).
// SHAVER_DROP_UNBOUND_THINKING=1 asks from the start for every conversation,
// and =0 never.
//
// Each thinking block of a model with preserved thinking is bound to the
// system, tools and messages that came before it as the API saw them. Shaving
// changes those, so the thinking after a trim, a stub or a summary no longer
// matches. What the API does then depends on the route, not only the model: on
// 2026-11-25, with an API key, Fable 5.2 and Opus 5.5 both answered a 400
// ("bound to a different conversation"); through a Claude Code sign-in, Opus
// 5.5 left the blocks out itself, unbilled and unreported, as drop_block
// would. With thinking.block_binding.prefix_mismatch_behavior "drop_block" and
// the thinking-binding-controls beta, the API drops them, unbilled, and lists
// them in input_transformations. A block still bound is left alone, so once
// asked, the setting goes on every request that holds thinking: what the API
// saw before is the proxy's doing, not the client's, so its request can't
// tell. It isn't asked before a refusal, since a route that drops the blocks
// itself gains nothing from it and the beta could change.
//
// Models are excluded, not listed, so new ones get it: Claude 3, 4.x and the
// 5.0s don't check the binding, and what they do with the setting isn't
// documented. A model that refuses it anyway is sent the request without it,
// and not the setting again until the proxy restarts.

export const BETA = 'thinking-binding-controls-2026-08-01'
const setting = process.env.SHAVER_DROP_UNBOUND_THINKING
// Whether drop_block is asked: always with =1, never with =0, and otherwise
// where the conversation has had UNBOUND.
export const drop = { on: setting === '1', never: setting === '0' }

// The API's refusal of a thinking block no longer bound to the conversation.
export const UNBOUND = /The block is bound to a different conversation/

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

// Sends a Messages request, with drop_block where bound sets it, when the
// conversation asks it (`ask`) or =1 does, and =0 doesn't forbid it. A 400
// that names the setting or the beta sends it again as given, unless it's the
// unbound-thinking refusal, which names them too.
export async function fetchBound(url: string, init: { method?: string; headers: Record<string, string>; body?: Buffer | string; signal?: AbortSignal }, ask = false): Promise<Response> {
  const b = !drop.never && (drop.on || ask) && init.body !== undefined ? bound(Buffer.from(init.body)) : undefined
  if (!b) return fetch(url, init)
  const r = await fetch(url, { ...init, headers: withBeta(init.headers), body: b.body })
  const text = r.status === 400 ? await r.clone().text() : ''
  if (r.status !== 400 || UNBOUND.test(text) || !/block_binding|thinking-binding-controls/.test(text)) return asked.add(r), r
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

// Defers the tools Claude Code sends in full, all but those the policy keeps
// and ToolSearch, which loads the others: each is marked `defer_loading`
// in the tool list and added to the deferred tools Claude Code lists in its
// environment message, so the model loads it with ToolSearch like the others.
// Claude Code sometimes sends no such list even with tool search on; the proxy
// then adds one of its own, worded as Claude Code's, as a system message
// just before the first reply (or at the end, before there is one): the API
// refuses a system message that a user message follows.
// With tool search off there is no ToolSearch, nothing could load the tool,
// and the request is left as it came.

const HEAD = 'Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n'
const INTRO = 'The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. '

type Block = { type: string; text?: string }
type Body = { tools?: { name?: string; defer_loading?: boolean }[]; messages?: { role: string; content: string | Block[] }[] }

export function forceDefer(body: Body, keep: readonly string[]): void {
  const msgs = body.messages ?? []
  if (!body.tools?.some((t) => t.name === 'ToolSearch')) return
  const defer = new Set(body.tools.filter((t) => t.name && !t.defer_loading && t.name !== 'ToolSearch' && !keep.includes(t.name)).map((t) => t.name))
  if (!defer.size) return
  body.tools = body.tools.map((t) => (defer.has(t.name) ? { ...t, defer_loading: true } : t))
  const names = [...defer].join('\n') + '\n'
  // Only system messages: a conversation that quotes the list is not one.
  const env = msgs.filter((m) => m.role === 'system')
  const texts = env.flatMap((m) => (typeof m.content === 'string' ? [m.content] : m.content.map((b) => b.text ?? '')))
  if (!texts.some((t) => t.includes(HEAD))) {
    const at = msgs.findIndex((m) => m.role === 'assistant')
    msgs.splice(at < 0 ? msgs.length : at, 0, { role: 'system', content: [{ type: 'text', text: INTRO + HEAD + names }] })
    return
  }
  const list = (t: string) => t.replace(HEAD, HEAD + names)
  for (const m of env) m.content = typeof m.content === 'string' ? list(m.content) : m.content.map((b) => (b.text?.includes(HEAD) ? { ...b, text: list(b.text) } : b))
}

// Defers tools that Claude Code sends in full: each is marked `defer_loading`
// in the tool list and added to the deferred tools Claude Code lists in its
// environment message, so the model loads it with ToolSearch like the others.
// With tool search off there is no list, nothing could load the tool, and the
// request is left as it came.

const HEAD = 'Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n'

type Block = { type: string; text?: string }
type Body = { tools?: { name?: string; defer_loading?: boolean }[]; messages?: { content: string | Block[] }[] }

export function forceDefer(body: Body, names: readonly string[]): void {
  const msgs = body.messages ?? []
  const texts = msgs.flatMap((m) => (typeof m.content === 'string' ? [m.content] : m.content.map((b) => b.text ?? '')))
  if (!texts.some((t) => t.includes(HEAD))) return
  const defer = new Set(body.tools?.filter((t) => t.name && !t.defer_loading && names.includes(t.name)).map((t) => t.name))
  if (!defer.size) return
  body.tools = body.tools?.map((t) => (defer.has(t.name) ? { ...t, defer_loading: true } : t))
  const list = (t: string) => t.replace(HEAD, HEAD + [...defer].join('\n') + '\n')
  for (const m of msgs) m.content = typeof m.content === 'string' ? list(m.content) : m.content.map((b) => (b.text?.includes(HEAD) ? { ...b, text: list(b.text) } : b))
}

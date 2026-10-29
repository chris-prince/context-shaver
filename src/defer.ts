// Defers the tools sent in full that the policy's rules defer, all but those
// always loaded: each is marked `defer_loading` in the tool list. Claude Code's
// are added to the deferred tools it lists in its environment message, so the
// model loads them with ToolSearch like the others; with tool search off there
// is no list, nothing could load the tool, and the request is left as it came.
// Where the protocol has a search tool its backend runs (Responses'), it is
// added instead, unless the client sends a search of its own, which finds only
// the tools it deferred. Gives the bytes of the definitions it deferred.
// Tools the rules drop are taken out of the request (dropTools): where tools
// can't be deferred, the model can't use them at all.

import { matches } from './skills.ts'

const HEAD = 'Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n'

// Each tool takes the first rule whose `name`, with `*` for any run of
// characters, matches its own; with none matching it is sent as it came.
export type ToolRule = { name: string; action: 'keep' | 'defer' | 'drop' }

type Block = { type: string; text?: string }
type Body = { tools?: { type?: string; name?: string; defer_loading?: boolean; [key: string]: unknown }[]; messages?: { role: string; content: string | Block[] }[] }

export const actionOf = (rules: readonly ToolRule[], name: string) => rules.find((r) => matches(r.name, name))?.action
export const deferredBy = (rules: readonly ToolRule[], name: string) => actionOf(rules, name) === 'defer'

// Whether Claude Code's tool search is on: a system message lists the deferred
// tools. Only system messages: a conversation that quotes the list is not one.
const envOf = (body: Body) => (body.messages ?? []).filter((m) => m.role === 'system')
const lists = (m: { role: string; content: string | Block[] }) => m.role === 'system' && (typeof m.content === 'string' ? [m.content] : m.content.map((b) => b.text ?? '')).some((t) => t.includes(HEAD))
export const searchOn = (body: Body, searchTool?: object): boolean => searchTool !== undefined || (body.messages ?? []).some(lists)
// The message listing the deferred tools, or -1.
export const toolListMessage = (body: Body): number => (body.messages ?? []).findIndex(lists)

// The tools never deferred, whatever the rules say: those that load the
// others, Codex's exec, which runs every other, with the wait that resumes
// its cells, and those a Claude Code session uses on most steps.
const ALWAYS_LOADED = ['ToolSearch', 'functions.exec', 'functions.wait', 'Bash', 'Edit', 'Read', 'Write']
const loaded = (t: { type?: string; name?: string }) => t.type === 'tool_search' || ALWAYS_LOADED.includes(t.name ?? '')

// The tools sent in full that `rules` would defer.
export const deferrable = (body: Body, rules: readonly ToolRule[]): string[] =>
  (body.tools ?? []).flatMap((t) => (t.name && !t.defer_loading && !loaded(t) && deferredBy(rules, t.name) ? [t.name] : []))

// The tools sent in full that `:shaver optimize` asks about deferring: all but
// those always loaded.
export const offerable = (body: Body): string[] =>
  (body.tools ?? []).flatMap((t) => (t.name && !t.defer_loading && !loaded(t) ? [t.name] : []))

// `rules` placing the `shown` tools: the `picked` ones given `action`, the
// others kept loaded. Those kept are named first, then come the rules' others
// but a catch-all, and with any picked to defer, a catch-all deferring the
// rest; tools are dropped only by name, so none Codex adds later is. A picked
// tool an earlier rule would still keep loaded is named first too. Rules for
// tools always loaded, which do nothing, are left out.
export function withPicked(rules: readonly ToolRule[], shown: readonly string[], picked: ReadonlySet<string>, action: 'defer' | 'drop'): ToolRule[] {
  const others = rules.filter((r) => r.name !== '*' && !shown.includes(r.name) && !ALWAYS_LOADED.includes(r.name))
  const out: ToolRule[] = [
    ...shown.filter((name) => !picked.has(name)).map((name) => ({ name, action: 'keep' as const })),
    ...others,
    ...(picked.size && action === 'defer' ? [{ name: '*', action }] : []),
  ]
  return [...[...picked].filter((name) => actionOf(out, name) !== action).map((name) => ({ name, action })), ...out]
}

// Takes the tools the rules drop out of `body`, but those always loaded.
// Gives the bytes of their definitions.
export function dropTools(body: Body, rules: readonly ToolRule[]): number {
  const drop = (t: { type?: string; name?: string }) => !!t.name && !loaded(t) && actionOf(rules, t.name) === 'drop'
  const bytes = (body.tools ?? []).filter(drop).reduce((n, t) => n + JSON.stringify(t).length, 0)
  if (bytes) body.tools = body.tools?.filter((t) => !drop(t))
  return bytes
}

export function forceDefer(body: Body, rules: readonly ToolRule[], searchTool?: Record<string, unknown>): number {
  if (!searchOn(body, searchTool)) return 0
  if (searchTool && body.tools?.some((t) => t.type === searchTool.type)) return 0
  const env = envOf(body)
  const defer = new Set(deferrable(body, rules))
  if (!defer.size) return 0
  const bytes = (body.tools ?? []).filter((t) => defer.has(t.name)).reduce((n, t) => n + JSON.stringify(t).length, 0)
  body.tools = body.tools?.map((t) => (defer.has(t.name) ? { ...t, defer_loading: true } : t))
  if (searchTool) body.tools?.push(searchTool)
  else {
    const list = (t: string) => t.replace(HEAD, HEAD + [...defer].join('\n') + '\n')
    for (const m of env) m.content = typeof m.content === 'string' ? list(m.content) : m.content.map((b) => (b.text?.includes(HEAD) ? { ...b, text: list(b.text) } : b))
  }
  return bytes
}

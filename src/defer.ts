// Defers the tools sent in full that the policy's rules defer, all but those
// always loaded: each is marked `defer_loading` in the tool list. Claude Code's
// are added to the deferred tools it lists in its environment message, so the
// model loads them with ToolSearch like the others; with tool search off there
// is no list, nothing could load the tool, and the request is left as it came.
// Over Responses, a client tool_search is added for Codex to answer. Gives the
// bytes of the definitions it deferred.

import { matches } from './skills.ts'

const HEAD = 'Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n'

// Each tool takes the first rule whose `name`, with `*` for any run of
// characters, matches its own; with none matching it is sent as it came.
export type ToolRule = { name: string; defer: boolean }

type Block = { type: string; text?: string }
type Body = { tools?: { type?: string; name?: string; defer_loading?: boolean; [key: string]: unknown }[]; messages?: { role: string; content: string | Block[] }[] }

export const deferredBy = (rules: readonly ToolRule[], name: string) => rules.find((r) => matches(r.name, name))?.defer === true

// Whether Claude Code's tool search is on: a system message lists the deferred
// tools. Only system messages: a conversation that quotes the list is not one.
const envOf = (body: Body) => (body.messages ?? []).filter((m) => m.role === 'system')
const lists = (m: { role: string; content: string | Block[] }) => m.role === 'system' && (typeof m.content === 'string' ? [m.content] : m.content.map((b) => b.text ?? '')).some((t) => t.includes(HEAD))
export const searchOn = (body: Body, responses = false): boolean => responses || (body.messages ?? []).some(lists)
// The message listing the deferred tools, or -1.
export const toolListMessage = (body: Body): number => (body.messages ?? []).findIndex(lists)

// The tools never deferred, whatever the rules say: those that load the
// others, and Codex's exec, which runs every other, with the wait that resumes
// its cells. The rules are shared by every harness, so a catch-all written in
// Claude Code reaches Codex's tools too.
const ALWAYS_LOADED = ['ToolSearch', 'functions.exec', 'functions.wait']
const loaded = (t: { type?: string; name?: string }) => t.type === 'tool_search' || ALWAYS_LOADED.includes(t.name ?? '')

// The tools sent in full that `rules` would defer.
export const deferrable = (body: Body, rules: readonly ToolRule[]): string[] =>
  (body.tools ?? []).flatMap((t) => (t.name && !t.defer_loading && !loaded(t) && deferredBy(rules, t.name) ? [t.name] : []))

// The tools `:shaver optimize` keeps loaded when it defers the rest: those a
// coding session uses on most steps.
export const CORE_TOOLS = ['Bash', 'Edit', 'Read', 'Write']

// The tools sent in full that `:shaver optimize` asks about deferring: all but
// those always loaded and the core ones.
export const offerable = (body: Body): string[] =>
  (body.tools ?? []).flatMap((t) => (t.name && !t.defer_loading && !loaded(t) && !CORE_TOOLS.includes(t.name) ? [t.name] : []))

// `rules` placing the `shown` tools: the `picked` ones deferred, the others
// kept loaded. Those kept are named first, then come the rules' others but a
// catch-all, the core tools kept where no rule names them, and with any
// picked, a catch-all deferring the rest. A picked tool an earlier rule would
// still keep loaded is named first too.
export function withDeferred(rules: readonly ToolRule[], shown: readonly string[], picked: ReadonlySet<string>): ToolRule[] {
  const others = rules.filter((r) => r.name !== '*' && !shown.includes(r.name))
  const out = [
    ...shown.filter((name) => !picked.has(name)).map((name) => ({ name, defer: false })),
    ...others,
    ...CORE_TOOLS.filter((n) => !others.some((r) => matches(r.name, n))).map((name) => ({ name, defer: false })),
    ...(picked.size ? [{ name: '*', defer: true }] : []),
  ]
  return [...[...picked].filter((name) => !deferredBy(out, name)).map((name) => ({ name, defer: true })), ...out]
}

export function forceDefer(body: Body, rules: readonly ToolRule[], responses = false): number {
  if (!searchOn(body, responses)) return 0
  const env = envOf(body)
  const defer = new Set(deferrable(body, rules))
  if (!defer.size) return 0
  const bytes = (body.tools ?? []).filter((t) => defer.has(t.name)).reduce((n, t) => n + JSON.stringify(t).length, 0)
  body.tools = body.tools?.map((t) => (defer.has(t.name) ? { ...t, defer_loading: true } : t))
  if (responses) {
    // Responses client tool search is a client-executed tool. The backend
    // returns a tool_search_call; the Codex client answers it with a
    // tool_search_output containing the selected schemas.
    if (!body.tools?.some((t) => t.type === 'tool_search')) body.tools?.push({
      type: 'tool_search', execution: 'client', description: 'Find tools to use for the current task.',
      parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'], additionalProperties: false },
    })
  } else {
    const list = (t: string) => t.replace(HEAD, HEAD + [...defer].join('\n') + '\n')
    for (const m of env) m.content = typeof m.content === 'string' ? list(m.content) : m.content.map((b) => (b.text?.includes(HEAD) ? { ...b, text: list(b.text) } : b))
  }
  return bytes
}

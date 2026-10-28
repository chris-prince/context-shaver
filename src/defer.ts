// Defers the tools Claude Code sends in full that the policy's rules defer,
// all but ToolSearch, which loads the others: each is marked `defer_loading`
// in the tool list and added to the deferred tools Claude Code lists in its
// environment message, so the model loads it with ToolSearch like the others.
// With tool search off there is no list, nothing could load the tool, and the
// request is left as it came. Gives the bytes of the definitions it deferred.

import { matches } from './skills.ts'

const HEAD = 'Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n'

// Each tool takes the first rule whose `name`, with `*` for any run of
// characters, matches its own; with none matching it is sent as it came.
export type ToolRule = { name: string; defer: boolean }

type Block = { type: string; text?: string }
type Body = { tools?: { name?: string; defer_loading?: boolean }[]; messages?: { role: string; content: string | Block[] }[] }

const deferredBy = (rules: readonly ToolRule[], name: string) => rules.find((r) => matches(r.name, name))?.defer === true

// Whether Claude Code's tool search is on: a system message lists the deferred
// tools. Only system messages: a conversation that quotes the list is not one.
const envOf = (body: Body) => (body.messages ?? []).filter((m) => m.role === 'system')
const lists = (m: { role: string; content: string | Block[] }) => m.role === 'system' && (typeof m.content === 'string' ? [m.content] : m.content.map((b) => b.text ?? '')).some((t) => t.includes(HEAD))
export const searchOn = (body: Body): boolean => (body.messages ?? []).some(lists)
// The message listing the deferred tools, or -1.
export const toolListMessage = (body: Body): number => (body.messages ?? []).findIndex(lists)

// The tools sent in full that `rules` would defer.
export const deferrable = (body: Body, rules: readonly ToolRule[]): string[] =>
  (body.tools ?? []).flatMap((t) => (t.name && !t.defer_loading && t.name !== 'ToolSearch' && deferredBy(rules, t.name) ? [t.name] : []))

// The tools `:shaver optimize` keeps loaded when it defers the rest: those a
// coding session uses on most steps.
export const CORE_TOOLS = ['Bash', 'Edit', 'Read', 'Write']

// `rules` with every tool they leave alone deferred, past the core ones; rules
// with a catch-all already place every tool, and stay as they are.
export const deferringAll = (rules: readonly ToolRule[]): ToolRule[] =>
  rules.some((r) => r.name === '*')
    ? [...rules]
    : [...rules, ...CORE_TOOLS.filter((n) => !rules.some((r) => matches(r.name, n))).map((name) => ({ name, defer: false })), { name: '*', defer: true }]

export function forceDefer(body: Body, rules: readonly ToolRule[]): number {
  if (!searchOn(body)) return 0
  const env = envOf(body)
  const defer = new Set(deferrable(body, rules))
  if (!defer.size) return 0
  const bytes = (body.tools ?? []).filter((t) => defer.has(t.name)).reduce((n, t) => n + JSON.stringify(t).length, 0)
  body.tools = body.tools?.map((t) => (defer.has(t.name) ? { ...t, defer_loading: true } : t))
  const list = (t: string) => t.replace(HEAD, HEAD + [...defer].join('\n') + '\n')
  for (const m of env) m.content = typeof m.content === 'string' ? list(m.content) : m.content.map((b) => (b.text?.includes(HEAD) ? { ...b, text: list(b.text) } : b))
  return bytes
}

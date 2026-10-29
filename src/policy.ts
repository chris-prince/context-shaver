// What to do to each kind of item, and when: a policy file of rules by kind
// (README.md, "Policy"). With no file there are no rules, and the proxy passes
// requests through.

import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import type { Clock, Item, Kind } from './items.ts'
import type { ToolRule } from './defer.ts'
import type { SkillRule } from './skills.ts'

export type Action = 'stub' | 'drop'
// Due once the item's step (or turn) is among the completed ones, leaving out
// the latest `wait`.
type Rule = { on: 'step' | 'turn'; wait: number; action: Action }
// `tool_list` says, by harness name, which tools it sends in full the proxy
// defers, first matching rule winning (defer.ts); `:shaver optimize` writes
// it. Its older forms, one list or rules with `defer` true or false for the
// action, and the older `tools_not_deferred`, naming the tools kept, every
// other deferred, are read as now (toolListsOf). `summary_threshold_tokens` is
// how many tokens of completed turns a record leaves uncovered before the
// proxy asks for the next (summary.ts); without it, none is made or applied.
// `memoir_threshold_tokens` is how many tokens the records can hold before the
// oldest are merged into the memoir (summary.ts); without it, none are.
// `skill_list` shortens the skills Claude Code lists to the model, first
// matching rule winning (skills.ts); `:shaver optimize` writes stubs into it.
type OlderToolRule = { name: string; defer: boolean }
export type Policy = Partial<Record<Kind, Rule[]>> & { tool_list?: (ToolRule | OlderToolRule)[] | Record<string, (ToolRule | OlderToolRule)[]>; tools_not_deferred?: string[]; summary_threshold_tokens?: number; memoir_threshold_tokens?: number; skill_list?: SkillRule[] }

// What each kind can be given. Only tool calls and skills have a stub.
const ACTIONS: Record<Kind, Action[]> = { tool: ['stub', 'drop'], skill: ['stub', 'drop'], tool_search: ['drop'], reasoning: ['drop'] }

export function parsePolicy(v: unknown): Policy {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('a policy is an object of rule lists by kind')
  for (const [kind, rules] of Object.entries(v)) {
    if (kind === 'tools_not_deferred') {
      if (!Array.isArray(rules) || !rules.every((n) => typeof n === 'string')) throw new Error('policy: tools_not_deferred is not a list of tool names')
      continue
    }
    if (kind === 'tool_list') {
      if (!rules || typeof rules !== 'object') throw new Error('policy: tool_list is not rule lists by harness')
      for (const list of Array.isArray(rules) ? [rules] : Object.values(rules)) {
        if (!Array.isArray(list)) throw new Error('policy: tool_list is not rule lists by harness')
        for (const r of list)
          if (typeof r?.name !== 'string' || !(typeof r.defer === 'boolean' || ['keep', 'defer'].includes(r.action)) || Object.keys(r).length !== 2) throw new Error(`policy: bad tool_list rule ${JSON.stringify(r)}`)
      }
      continue
    }
    if (kind === 'summary_threshold_tokens' || kind === 'memoir_threshold_tokens') {
      if (!Number.isInteger(rules) || (rules as number) <= 0) throw new Error(`policy: ${kind} is not a positive token count`)
      continue
    }
    if (kind === 'skill_list') {
      if (!Array.isArray(rules)) throw new Error('policy: skill_list is not a list of rules')
      // A stub keeps some sentences, or is a written line with the hash of what it replaces.
      const stub = (r: Record<string, unknown>) => (r.text === undefined ? Number.isInteger(r.sentences) && (r.sentences as number) >= 1 && r.replaces === undefined : typeof r.text === 'string' && typeof r.replaces === 'string' && r.sentences === undefined)
      for (const r of rules)
        if (typeof r?.match !== 'string' || !['keep', 'stub', 'drop'].includes(r.action) || (r.action === 'stub' ? !stub(r) : r.sentences !== undefined || r.text !== undefined || r.replaces !== undefined))
          throw new Error(`policy: bad skill_list rule ${JSON.stringify(r)}`)
      continue
    }
    if (!Object.hasOwn(ACTIONS, kind)) throw new Error(`policy: unknown kind ${kind}`)
    if (!Array.isArray(rules)) throw new Error(`policy: ${kind} is not a list of rules`)
    for (const r of rules)
      if ((r?.on !== 'step' && r?.on !== 'turn') || !Number.isInteger(r.wait) || r.wait < 0 || !ACTIONS[kind as Kind].includes(r.action))
        throw new Error(`policy: bad ${kind} rule ${JSON.stringify(r)}`)
  }
  return v as Policy
}

// Makes a policy file from the default if there is none, so the repo tracks
// only the default and edits to the file stay out of git.
export function seedPolicy(file: string, from: string): void {
  if (!existsSync(file) && existsSync(from)) copyFileSync(from, file)
}

// The tool rules a policy gives each harness: its `tool_list`; in the older
// forms, Claude Code's only, a single list or `tools_not_deferred` as rules
// keeping those and deferring the rest. A rule's older `defer` is its action.
export function toolListsOf(p: Policy): Record<string, ToolRule[]> {
  const now = (rs: (ToolRule | OlderToolRule)[]) => rs.map((r): ToolRule => ('defer' in r ? { name: r.name, action: r.defer ? 'defer' : 'keep' } : r))
  if (p.tool_list) return Array.isArray(p.tool_list) ? { claude: now(p.tool_list) } : Object.fromEntries(Object.entries(p.tool_list).map(([h, rs]) => [h, now(rs)]))
  if (p.tools_not_deferred) return { claude: [...p.tools_not_deferred.map((name) => ({ name, action: 'keep' as const })), { name: '*', action: 'defer' }] }
  return {}
}

// Whether `tool_list` is in one of its older forms, which a tool answer
// rewrites.
export const olderTools = (p: Policy) => Array.isArray(p.tool_list) || (!p.tool_list && p.tools_not_deferred !== undefined)
  || Object.values(p.tool_list ?? {}).some((rs) => rs.some((r: object) => 'defer' in r))

// The tool rules a policy gives `harness`; none without any.
export const toolRulesOf = (p: Policy, harness: string | undefined): ToolRule[] | undefined => (harness === undefined ? undefined : toolListsOf(p)[harness])

// A policy file's text with its top-level `name` set to `rules`, a rule to a
// line, or for lists by key, a list to each key, the rest of the text as it
// was, so edits by hand are kept. Without `name`, a top-level `replacing` has
// its key and value replaced by `name`'s; a file with neither gets `name`
// added last.
export function withList(text: string, name: 'skill_list' | 'tool_list', rules: readonly object[] | Record<string, readonly object[]>, replacing?: string): string {
  const one = (r: object) => `{ ${Object.entries(r).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`
  const listOf = (rs: readonly object[], pad: string) => (rs.length ? `[\n${rs.map((r) => pad + '  ' + one(r)).join(',\n')}\n${pad}]` : '[]')
  const lists = Object.entries(rules)
  const list = Array.isArray(rules) ? listOf(rules, '  ') : lists.length ? `{\n${lists.map(([k, rs]) => `    ${JSON.stringify(k)}: ${listOf(rs, '    ')}`).join(',\n')}\n  }` : '{}'
  const at = spanOf(text, name)
  if (at) return text.slice(0, at.value) + list + text.slice(at.end)
  const old = replacing === undefined ? undefined : spanOf(text, replacing)
  if (old) return text.slice(0, old.key) + `${JSON.stringify(name)}: ${list}` + text.slice(old.end)
  const close = text.lastIndexOf('}')
  const body = text.slice(0, close).trimEnd()
  return `${body}${body.endsWith('{') ? '' : ','}\n  ${JSON.stringify(name)}: ${list}\n${text.slice(close)}`
}

// Where a top-level key starts, and where its value starts and ends, read past
// strings; none if the text has no such key.
function spanOf(text: string, name: string): { key: number; value: number; end: number } | undefined {
  const string = (i: number) => {
    const end = /"(?:[^"\\]|\\.)*"/y
    end.lastIndex = i
    return end.exec(text)![0]
  }
  let depth = 0
  let key: { name: string; at: number } | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      const s = string(i)
      key = depth === 1 ? { name: JSON.parse(s), at: i } : undefined
      i += s.length - 1
    } else if (ch === ':' && depth === 1 && key?.name === name) {
      const start = i + 1 + (text.slice(i + 1).length - text.slice(i + 1).trimStart().length)
      let d = 0
      for (let j = start; j < text.length; j++) {
        if (text[j] === '"') j += string(j).length - 1
        else if (text[j] === '[' || text[j] === '{') d++
        else if (text[j] === ']' || text[j] === '}') {
          if (--d === 0) return { key: key.at, value: start, end: j + 1 }
        }
      }
      throw new Error(`policy: ${name} is not closed`)
    } else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    else if (ch === ',') key = undefined
  }
  return undefined
}

// The policy in a file, or none if there is no file.
export function loadPolicy(file: string): Policy | undefined {
  if (!existsSync(file)) return undefined
  return parsePolicy(JSON.parse(readFileSync(file, 'utf8')))
}

// What is due to an item at a clock: the strongest due rule's action, drop
// over stub.
export function treatment(rules: readonly Rule[] = [], it: Item, c: Clock): Action | undefined {
  const due = rules.filter((r) => (r.on === 'step' ? it.step && it.step <= c.steps - r.wait : it.turn && it.turn <= c.turns - r.wait))
  return due.some((r) => r.action === 'drop') ? 'drop' : due.length ? 'stub' : undefined
}

// What to do to each kind of part, and when, and to the tools and skills the
// harness sends: a policy file of rule lists (README.md, "Policy"). With no
// file there are no rules, and the proxy passes requests through.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Clock, Item, Kind } from './items.ts'
import type { ToolRule } from './defer.ts'
import type { SkillRule } from './skills.ts'

export type Action = 'stub' | 'drop'
// Due once the item's request (or turn) is among the completed ones, leaving
// out the latest few: `after` is "4 requests" or "1 turn", the unit taken
// singular or plural whatever the count.
type Rule = { action: Action; after: string }
const AFTER = /^(\d+) (request|turn)s?$/

// A rule's `after` as its unit and count; none if it is neither.
export function afterOf(r: Rule): { on: 'request' | 'turn'; wait: number } | undefined {
  const m = typeof r?.after === 'string' ? AFTER.exec(r.after) : null
  return m ? { on: m[2] as 'request' | 'turn', wait: Number(m[1]) } : undefined
}
// Of the prompts and the assistant's text: `summary_threshold_tokens` is how
// many tokens of completed turns a record leaves uncovered before the proxy
// asks for the next (summary.ts); without it, none is made or applied.
// `memoir_threshold_tokens` is how many tokens the records can hold before the
// oldest are merged into the memoir (summary.ts); without it, none are.
type Text = { summary_threshold_tokens?: number; memoir_threshold_tokens?: number }
export type PartRules = Partial<Record<Kind, Rule[]>> & { prompt_and_assistant_text?: Text }
// `conversation_shaver_rules` says, by kind, when the proxy stubs or drops a part of
// the conversation (trim.ts), and when it summarizes the rest.
// `tool_shaver_rules` says, by harness name, which tools it sends in full the
// proxy defers or drops, first matching rule winning (defer.ts); `shaver
// optimize` writes it. `skill_shaver_rules` shortens the skills the harness
// lists to the model, first matching rule winning (skills.ts); `shaver
// optimize` writes stubs into it. A file in an older form is put in this one
// when loaded (upgraded).
export type Policy = { conversation_shaver_rules?: PartRules; tool_shaver_rules?: Record<string, ToolRule[]>; skill_shaver_rules?: SkillRule[] }

// The policy's summary and memoir thresholds, if any.
export const textRules = (p: Policy): Text => p.conversation_shaver_rules?.prompt_and_assistant_text ?? {}

// What each kind can be given. Only tool calls and skills have a stub.
const ACTIONS: Record<Kind, Action[]> = { tool: ['stub', 'drop'], skill: ['stub', 'drop'], tool_search: ['drop'], reasoning: ['drop'] }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function parsePolicy(v: unknown): Policy {
  if (!isObject(v)) throw new Error('a policy is an object of rule lists')
  for (const [key, value] of Object.entries(v)) {
    if (key === 'conversation_shaver_rules') {
      if (!isObject(value)) throw new Error('policy: conversation_shaver_rules is not rule lists by kind')
      for (const [kind, rules] of Object.entries(value)) {
        if (kind === 'prompt_and_assistant_text') {
          if (!isObject(rules)) throw new Error('policy: prompt_and_assistant_text is not an object of token counts')
          for (const [k, n] of Object.entries(rules)) {
            if (k !== 'summary_threshold_tokens' && k !== 'memoir_threshold_tokens') throw new Error(`policy: unknown prompt_and_assistant_text key ${k}`)
            if (!Number.isInteger(n) || (n as number) <= 0) throw new Error(`policy: ${k} is not a positive token count`)
          }
          continue
        }
        if (!Object.hasOwn(ACTIONS, kind)) throw new Error(`policy: unknown part kind ${kind}`)
        if (!Array.isArray(rules)) throw new Error(`policy: ${kind} is not a list of rules`)
        for (const r of rules)
          if (!afterOf(r) || Object.keys(r).length !== 2 || !ACTIONS[kind as Kind].includes(r.action))
            throw new Error(`policy: bad ${kind} rule ${JSON.stringify(r)}`)
      }
    } else if (key === 'tool_shaver_rules') {
      if (!isObject(value) || !Object.values(value).every(Array.isArray)) throw new Error('policy: tool_shaver_rules is not rule lists by harness')
      for (const r of Object.values(value).flat())
        if (typeof r?.name !== 'string' || !['keep', 'defer', 'drop'].includes(r.action) || Object.keys(r).length !== 2) throw new Error(`policy: bad tool rule ${JSON.stringify(r)}`)
    } else if (key === 'skill_shaver_rules') {
      if (!Array.isArray(value)) throw new Error('policy: skill_shaver_rules is not a list of rules')
      // A stub keeps some sentences, or is a written line with the hash of what it replaces.
      const stub = (r: Record<string, unknown>) => (r.text === undefined ? Number.isInteger(r.sentences) && (r.sentences as number) >= 1 && r.replaces === undefined : typeof r.text === 'string' && typeof r.replaces === 'string' && r.sentences === undefined)
      for (const r of value)
        if (typeof r?.name !== 'string' || !['keep', 'stub', 'drop'].includes(r.action) || (r.action === 'stub' ? !stub(r) : r.sentences !== undefined || r.text !== undefined || r.replaces !== undefined))
          throw new Error(`policy: bad skill rule ${JSON.stringify(r)}`)
    } else throw new Error(`policy: unknown key ${key}`)
  }
  return v as Policy
}

// Skill rules with any in the older form, naming skills by `match`, put in
// the current one. Sessions save the rules they were shortened by (server.ts).
export const skillRulesNow = (rules: (SkillRule & { match?: string })[]): SkillRule[] =>
  rules.map(({ match, ...r }) => (match === undefined ? r : { ...r, name: match }))

// A policy in an older form put in the current one, or none if it is current.
// The older forms: rule lists by kind and the summary and memoir thresholds at
// the top level; `skill_list`, whose rules name skills by `match`;
// `tool_list`, one list for Claude Code or lists by harness, whose rules may
// have `defer` true or false for the action; and `tools_not_deferred`, naming
// the tools Claude Code keeps, every other deferred; and part rules timed by
// `on` ("step" or "turn") and `wait`, written as `after`, a step as a request.
export function upgraded(v: Record<string, unknown>): Record<string, unknown> | undefined {
  const old = ['skill_list', 'tool_list', 'tools_not_deferred', 'summary_threshold_tokens', 'memoir_threshold_tokens']
  const kinds = Object.keys(v).filter((k) => Object.hasOwn(ACTIONS, k))
  const conv = isObject(v.conversation_shaver_rules) ? v.conversation_shaver_rules : {}
  const onWait = (r: unknown) => isObject(r) && 'on' in r
  const timedOlder = [...kinds.map((k) => v[k]), ...Object.values(conv)].some((rs) => Array.isArray(rs) && rs.some(onWait))
  if (!kinds.length && !timedOlder && !old.some((k) => k in v)) return undefined
  const after = (wait: number, unit: string) => `${wait} ${unit}${wait === 1 ? '' : 's'}`
  const timed = (rs: unknown) => (Array.isArray(rs) ? rs.map((r) => (onWait(r) ? { action: r.action, after: after(r.wait, r.on === 'step' ? 'request' : r.on) } : r)) : rs)
  type Older = { name: string; defer?: boolean; action?: string }
  const now = (rs: Older[]) => rs.map((r) => (r.defer === undefined ? r : { name: r.name, action: r.defer ? 'defer' : 'keep' }))
  const tools = v.tool_list
    ? Array.isArray(v.tool_list) ? { claude: now(v.tool_list) } : Object.fromEntries(Object.entries(v.tool_list as Record<string, Older[]>).map(([h, rs]) => [h, now(rs)]))
    : v.tools_not_deferred && { claude: [...(v.tools_not_deferred as string[]).map((name) => ({ name, action: 'keep' })), { name: '*', action: 'defer' }] }
  const skills = v.skill_list && skillRulesNow(v.skill_list as SkillRule[])
  const { prompt_and_assistant_text: had, ...convKinds } = conv
  const text = { ...(isObject(had) && had), ...Object.fromEntries(['summary_threshold_tokens', 'memoir_threshold_tokens'].filter((k) => k in v).map((k) => [k, v[k]])) }
  const parts = {
    ...Object.fromEntries([...Object.entries(convKinds), ...kinds.map((k) => [k, v[k]])].map(([k, rs]) => [k, timed(rs)])),
    ...(Object.keys(text).length && { prompt_and_assistant_text: text }),
  }
  const rest = Object.fromEntries(Object.entries(v).filter(([k]) => !kinds.includes(k) && !old.includes(k) && (k !== 'conversation_shaver_rules' || !isObject(v[k]))))
  return {
    ...(Object.keys(parts).length && { conversation_shaver_rules: parts }),
    ...(tools && { tool_shaver_rules: tools }),
    ...(skills && { skill_shaver_rules: skills }),
    ...rest,
  }
}

// Makes a policy file from the default if there is none, so the repo tracks
// only the default and edits to the file stay out of git.
export function seedPolicy(file: string, from: string): void {
  if (!existsSync(file) && existsSync(from)) copyFileSync(from, file)
}

// The tool rules a policy gives `harness`; none without any.
export const toolRulesOf = (p: Policy, harness: string | undefined): ToolRule[] | undefined => (harness === undefined ? undefined : p.tool_shaver_rules?.[harness])

// A top-level value as policy text: a rule to a line, or for lists by key, a
// list to each key.
function valueText(v: unknown): string {
  const one = (r: object) => `{ ${Object.entries(r).map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(', ')} }`
  const listOf = (rs: readonly object[], pad: string) => (rs.length ? `[\n${rs.map((r) => pad + '  ' + one(r)).join(',\n')}\n${pad}]` : '[]')
  if (Array.isArray(v)) return listOf(v, '  ')
  if (!isObject(v)) return JSON.stringify(v)
  const lists = Object.entries(v as Record<string, object>)
  return lists.length ? `{\n${lists.map(([k, rs]) => `    ${JSON.stringify(k)}: ${Array.isArray(rs) ? listOf(rs, '    ') : one(rs)}`).join(',\n')}\n  }` : '{}'
}

// A policy file's text with its top-level `name` set to `rules`, the rest of
// the text as it was, so edits by hand are kept; a file without `name` gets it
// added last.
export function withList(text: string, name: 'skill_shaver_rules' | 'tool_shaver_rules', rules: readonly object[] | Record<string, readonly object[]>): string {
  const list = valueText(rules)
  const at = spanOf(text, name)
  if (at) return text.slice(0, at.value) + list + text.slice(at.end)
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

// The policy in a file, or none if there is no file. A file in an older form
// is rewritten in the current one, the old text kept beside it as `.old`.
export function loadPolicy(file: string): Policy | undefined {
  if (!existsSync(file)) return undefined
  const v = JSON.parse(readFileSync(file, 'utf8'))
  const now = isObject(v) ? upgraded(v) : undefined
  if (!now) return parsePolicy(v)
  const policy = parsePolicy(now)
  copyFileSync(file, `${file}.old`)
  writeFileSync(file, `{\n${Object.entries(now).map(([k, x]) => `  ${JSON.stringify(k)}: ${valueText(x)}`).join(',\n')}\n}\n`)
  return policy
}

// What is due to an item at a clock: the strongest due rule's action, drop
// over stub.
export function treatment(rules: readonly Rule[] = [], it: Item, c: Clock): Action | undefined {
  const due = rules.filter((r) => {
    const { on, wait } = afterOf(r)!
    return on === 'request' ? it.request && it.request <= c.requests - wait : it.turn && it.turn <= c.turns - wait
  })
  return due.some((r) => r.action === 'drop') ? 'drop' : due.length ? 'stub' : undefined
}

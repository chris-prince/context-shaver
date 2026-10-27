// What to do to each kind of item, and when: a policy file of rules by kind
// (README.md, "Policy"). With no file there are no rules, and the proxy passes
// requests through.

import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import type { Clock, Item, Kind } from './items.ts'
import type { SkillRule } from './skills.ts'

export type Action = 'stub' | 'drop'
// Due once the item's step (or turn) is among the completed ones, leaving out
// the latest `wait`.
type Rule = { on: 'step' | 'turn'; wait: number; action: Action }
// `tools_not_deferred` names the tools Claude Code sends in full that stay
// that way; the proxy defers the rest (defer.ts). `summary_threshold_tokens` is
// how many tokens of completed turns a record leaves uncovered before the
// proxy asks for the next (summary.ts); without it, none is made or applied.
// `memoir_threshold_tokens` is how many tokens the records can hold before the
// oldest are merged into the memoir (summary.ts); without it, none are.
// `skill_list` shortens the skills Claude Code lists to the model, first
// matching rule winning (skills.ts); `:shaver optimize` writes stubs into it.
export type Policy = Partial<Record<Kind, Rule[]>> & { tools_not_deferred?: string[]; summary_threshold_tokens?: number; memoir_threshold_tokens?: number; skill_list?: SkillRule[] }

// What each kind can be given. Only tool calls and skills have a stub.
const ACTIONS: Record<Kind, Action[]> = { tool: ['stub', 'drop'], skill: ['stub', 'drop'], tool_search: ['drop'], reasoning: ['drop'] }

export function parsePolicy(v: unknown): Policy {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('a policy is an object of rule lists by kind')
  for (const [kind, rules] of Object.entries(v)) {
    if (kind === 'tools_not_deferred') {
      if (!Array.isArray(rules) || !rules.every((n) => typeof n === 'string')) throw new Error('policy: tools_not_deferred is not a list of tool names')
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

// A policy file's text with its top-level `skill_list` set to `rules`, a rule
// to a line, the rest of the text as it was, so edits by hand are kept. A file
// with no `skill_list` gets one added last.
export function withSkillList(text: string, rules: readonly SkillRule[]): string {
  const one = (r: SkillRule) => `{ ${Object.entries(r).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`
  const list = rules.length ? `[\n${rules.map((r) => '    ' + one(r)).join(',\n')}\n  ]` : '[]'
  // The top-level key's value: where it starts and ends, read past strings.
  let depth = 0
  let key: string | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y
      end.lastIndex = i
      const s = end.exec(text)![0]
      key = depth === 1 ? JSON.parse(s) : undefined
      i += s.length - 1
    } else if (ch === ':' && depth === 1 && key === 'skill_list') {
      const start = i + 1 + (text.slice(i + 1).length - text.slice(i + 1).trimStart().length)
      let d = 0
      for (let j = start; j < text.length; j++) {
        if (text[j] === '"') {
          const end = /"(?:[^"\\]|\\.)*"/y
          end.lastIndex = j
          j += end.exec(text)![0].length - 1
        } else if (text[j] === '[' || text[j] === '{') d++
        else if (text[j] === ']' || text[j] === '}') {
          if (--d === 0) return text.slice(0, start) + list + text.slice(j + 1)
        }
      }
      throw new Error('policy: skill_list is not closed')
    } else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    else if (ch === ',') key = undefined
  }
  const close = text.lastIndexOf('}')
  const body = text.slice(0, close).trimEnd()
  return `${body}${body.endsWith('{') ? '' : ','}\n  "skill_list": ${list}\n${text.slice(close)}`
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

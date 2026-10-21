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
// `skill_list` shortens the skills Claude Code lists to the model, first
// matching rule winning (skills.ts).
export type Policy = Partial<Record<Kind, Rule[]>> & { tools_not_deferred?: string[]; summary_threshold_tokens?: number; skill_list?: SkillRule[] }

// What each kind can be given. Only tool calls and skills have a stub.
const ACTIONS: Record<Kind, Action[]> = { tool: ['stub', 'drop'], skill: ['stub', 'drop'], tool_search: ['drop'], reasoning: ['drop'] }

export function parsePolicy(v: unknown): Policy {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('a policy is an object of rule lists by kind')
  for (const [kind, rules] of Object.entries(v)) {
    if (kind === 'tools_not_deferred') {
      if (!Array.isArray(rules) || !rules.every((n) => typeof n === 'string')) throw new Error('policy: tools_not_deferred is not a list of tool names')
      continue
    }
    if (kind === 'summary_threshold_tokens') {
      if (!Number.isInteger(rules) || (rules as number) <= 0) throw new Error('policy: summary_threshold_tokens is not a positive token count')
      continue
    }
    if (kind === 'skill_list') {
      if (!Array.isArray(rules)) throw new Error('policy: skill_list is not a list of rules')
      for (const r of rules)
        if (typeof r?.match !== 'string' || !['keep', 'stub', 'drop'].includes(r.action) || (r.action === 'stub' ? !Number.isInteger(r.sentences) || r.sentences < 1 : r.sentences !== undefined))
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

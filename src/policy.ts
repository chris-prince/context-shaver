// What to do to each kind of item, and when: a policy file of rules by kind
// (README.md, "Policy"). With no file there are no rules, and the proxy passes
// requests through.

import { existsSync, readFileSync } from 'node:fs'
import type { Clock, Item, Kind } from './items.ts'

export type Action = 'stub' | 'drop'
// Due once the item's step (or turn) is among the completed ones, leaving out
// the latest `wait`.
export type Rule = { on: 'step' | 'turn'; wait: number; action: Action }
export type Policy = Partial<Record<Kind, Rule[]>>

// What each kind can be given. Only tool calls have a stub.
const ACTIONS: Record<Kind, Action[]> = { tool: ['stub', 'drop'], skill: ['drop'], search: ['drop'], reasoning: ['drop'] }

export function parsePolicy(v: unknown): Policy {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('a policy is an object of rule lists by kind')
  for (const [kind, rules] of Object.entries(v)) {
    if (!Object.hasOwn(ACTIONS, kind)) throw new Error(`policy: unknown kind ${kind}`)
    if (!Array.isArray(rules)) throw new Error(`policy: ${kind} is not a list of rules`)
    for (const r of rules)
      if ((r?.on !== 'step' && r?.on !== 'turn') || !Number.isInteger(r.wait) || r.wait < 0 || !ACTIONS[kind as Kind].includes(r.action))
        throw new Error(`policy: bad ${kind} rule ${JSON.stringify(r)}`)
  }
  return v as Policy
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

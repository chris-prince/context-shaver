import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cost, type Usage } from '../src/cost.ts'
import { dropTools, type ToolRule } from '../src/defer.ts'
import type { ApiMsg } from '../src/items.ts'
import { hash } from '../src/log.ts'
import { shaveSkills, type SkillRule } from '../src/skills.ts'
import { describe, observe, splitShaved, tokensOf, type Sent, type Stats } from '../src/stats.ts'

// One conversation sent twice, with the tool and skill policies changed as it
// goes and never shaved, against an API whose tokens are a third of the bytes
// and whose cache reads the parts a request shares, from the start, with the
// one before. Each request is sent as server.ts sends it: shaved, with what
// the shaves took out and the rules they took it out by.

const HOUR = 3600e3
const ends = { tools: 0, reasoning: 0 }
const third = <T>(xs: T[], n: number) => xs.slice(0, (xs.length * n) / 3)
const SKILL_NAMES = Array.from({ length: 9 }, (_, i) => `skill-${i}`)
const list = SKILL_NAMES.map((n) => `- ${n}: Does the ${n} things. ${'It explains at length when and how to use them. '.repeat(8)}`).join('\n')
const SKILLS: ApiMsg = { role: 'system', content: [{ type: 'text', text: `The following skills are available for use with the Skill tool:\n\n${list}\n\nmore` }] }
const TOOLS = Array.from({ length: 6 }, (_, i) => ({ name: `tool-${i}`, description: `Does tool ${i}'s work. `.repeat(30) }))
type Policy = { skills: SkillRule[]; tools: ToolRule[] }
const policy = (skills: number, tools: number): Policy => ({
  skills: third(SKILL_NAMES, skills).map((name) => ({ name, action: 'stub', sentences: 1 })),
  tools: third(TOOLS, tools).map((t) => ({ name: t.name, action: 'drop' })),
})
const NONE = policy(0, 0)
// Thirds of the skills, then of the tools, shaved: none, one, all, two; the
// tools a stage behind, then both at once. Three requests each.
const POLICIES = [policy(0, 0), policy(1, 0), policy(3, 1), policy(2, 3), policy(2, 2), policy(3, 3)]

const tokens = (bytes: number) => bytes / 3
const bodyAt = (n: number, p: Policy, base = false) => {
  const turns: ApiMsg[] = []
  for (let i = 0; i < n; i++) turns.push({ role: 'user', content: `question ${i} `.repeat(40) }, { role: 'assistant', content: `answer ${i} `.repeat(60) })
  const messages = base ? [SKILLS] : [SKILLS, ...turns, { role: 'user', content: `question ${n}` } as ApiMsg]
  const body = { model: 'claude-opus-5-5', system: 'You are a coding agent. '.repeat(100), tools: structuredClone(TOOLS), messages: structuredClone(messages) }
  const dropped = dropTools(body, p.tools, [])
  const shaved = shaveSkills(body, p.skills)
  return { body, dropped, shaved, p }
}
const sentOf = (b: ReturnType<typeof bodyAt>, time: string): Sent => {
  const d = describe(b.body, ends, time)
  if (b.dropped) d.defs.deferred = b.dropped
  if (b.shaved.cut) d.defs.skills = b.shaved.cut
  if (b.shaved.trimmed) splitShaved(d, b.shaved.trimmed)
  d.defs.shaves = { tools: hash(JSON.stringify(b.p.tools)), skills: hash(JSON.stringify(b.p.skills)) }
  return d
}
const sizes = (d: Sent) => [[d.defs.key, d.defs.systemPrompt + d.defs.tools], ...d.parts.map((p) => [p.key, p.bytes])] as Array<[string, number]>
const truth = (d: Sent) => sizes(d).reduce((n, [, b]) => n + tokens(b), 0)
// What the cache reads: the parts shared from the start with the request before.
function usageOf(prev: Sent | undefined, d: Sent): Usage {
  const was = prev ? sizes(prev) : []
  const now = sizes(d)
  let read = 0
  for (let i = 0; i < now.length && was[i]?.[0] === now[i][0]; i++) read += tokens(now[i][1])
  const write = truth(d) - read
  return { input_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: write, cache_creation: { ephemeral_1h_input_tokens: write }, output_tokens: 20 }
}

// The conversation's cost, and its stats after each stage.
function run(policies: Policy[]) {
  const lines: Array<{ stats: Stats; usage: Usage }> = []
  const after: Stats[] = []
  let prev: Sent | undefined
  let stats: Stats | undefined
  policies.forEach((p, stage) => {
    for (let j = 0; j < 3; j++) {
      const n = stage * 3 + j
      const d = sentOf(bodyAt(n, p), new Date(Date.UTC(2026, 9, 29, 10, n)).toISOString())
      const u = usageOf(prev, d)
      stats = observe(stats, d, truth(d), 20)
      lines.push({ stats, usage: u })
      prev = d
    }
    after.push(stats!)
  })
  return { c: cost(lines, HOUR)!, after }
}

test("shaver info's figures hold through successive tool and skill policy changes", () => {
  const shaved = run(POLICIES)
  const never = run(POLICIES.map(() => NONE))
  const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= 1e-6 + 0.01 * Math.abs(b), `${what}: ${a} vs ${b}`)
  // Without the shaver it costs what the same conversation never shaved does,
  close(shaved.c.without, never.c.actual, 'if no shaver')
  // and the shaves' savings are the difference, with nothing else saved.
  close(shaved.c.saved['tools-shaved'] + shaved.c.saved['skills-shaved'], never.c.actual - shaved.c.actual, 'tools-shaved + skills-shaved')
  close(Object.entries(shaved.c.saved).reduce((n, [t, v]) => n + (t.endsWith('-shaved') ? 0 : Math.abs(v)), 0), 0, 'the rest')
})

test("shaver optimize's measures from the journal hold through successive tool and skill policy changes", () => {
  const { after } = run(POLICIES)
  // After each stage, its base as sent, and as each policy would send it, as
  // optimize builds them: through the skill list.
  const base = (stage: number, p: Policy) => describe(bodyAt(stage * 3 + 2, p, true).body, ends, '')
  POLICIES.forEach((p, stage) => {
    for (const next of [...POLICIES, policy(0, 3), policy(3, 0)]) {
      const variant = base(stage, next)
      const n = tokensOf(after[stage], base(stage, p), variant)
      assert.ok(n !== undefined && Math.abs(n - truth(variant)) < 1e-6, `stage ${stage}: ${n} vs ${truth(variant)}`)
    }
  })
  // Before a request has sent the base a stage changed to, the journal can't
  // measure it, so optimize sends it.
  assert.equal(tokensOf(after[0], base(0, POLICIES[1]), base(0, POLICIES[2])), undefined)
})

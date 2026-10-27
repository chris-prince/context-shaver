// Shortens the skill list Claude Code sends in its environment message, by the
// policy's `skill_list` (policy.ts): each listed skill takes the first rule
// whose pattern matches its name, and is kept, stubbed, or dropped from the
// list. With no rule matching it is kept. A stub is the first sentences of the
// description, or a line `:shaver optimize` wrote for it (server.ts), which
// `replaces` names by the hash of the description it was written from; a
// description since changed is kept whole. A dropped skill can still be run as
// `/name`; the model just isn't told of it. Gives the bytes it took out.

import { hash } from './log.ts'

const HEAD = 'The following skills are available for use with the Skill tool:\n\n'

export type SkillRule = { match: string; action: 'keep' | 'stub' | 'drop'; sentences?: number; text?: string; replaces?: string }
export type Skill = { name: string; description: string }

// The hash a written line's `replaces` holds.
export const descriptionHash = (description: string) => hash(description).slice(0, 12)

type Block = { type: string; text?: string }
type Body = { messages?: { role: string; content: string | Block[] }[] }

// A pattern is a name, with `*` for any run of characters.
const matches = (pattern: string, name: string) => new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(name)

// The text up to the end of its nth sentence, or all of it if it has fewer.
function firstSentences(text: string, n: number): string {
  const ends = [...text.matchAll(/[.!?](?=\s|$)/g)]
  return ends.length > n ? text.slice(0, ends[n - 1].index + 1) : text
}

// A stub's description: the line written for it, if it is still the
// description's and shorter, else the first sentences, or the whole of it.
function stubOf(description: string, rule: SkillRule): string {
  if (rule.text === undefined) return firstSentences(description, rule.sentences!)
  return rule.replaces === descriptionHash(description) && rule.text.length < description.length ? rule.text : description
}

// Each entry is `- name: description`, its description sometimes running on
// over more lines; the list ends at a blank line.
function listAt(text: string): { from: number; end: number; entries: string[] } | undefined {
  const at = text.indexOf(HEAD)
  if (at < 0) return undefined
  const from = at + HEAD.length
  const end = text.indexOf('\n\n', from) < 0 ? text.length : text.indexOf('\n\n', from)
  return { from, end, entries: text.slice(from, end).split(/\n(?=- [\w:.-]+: )/) }
}

const skillOf = (entry: string): Skill | undefined => {
  const name = /^- ([\w:.-]+): /.exec(entry)?.[1]
  return name === undefined ? undefined : { name, description: entry.slice(name.length + 4) }
}

function shave(text: string, rules: readonly SkillRule[]): string {
  const list = listAt(text)
  if (!list) return text
  const { from, end } = list
  const at = from - HEAD.length
  const kept = list.entries.flatMap((entry) => {
    const skill = skillOf(entry)
    const rule = skill && rules.find((r) => matches(r.match, skill.name))
    if (rule?.action === 'drop') return []
    if (rule?.action === 'stub') return [`- ${skill!.name}: ` + stubOf(skill!.description, rule)]
    return [entry]
  })
  if (!kept.length) return text.slice(0, at) + text.slice(end).replace(/^\n\n/, '')
  return text.slice(0, from) + kept.join('\n') + text.slice(end)
}

export function shaveSkills(body: Body, rules: readonly SkillRule[]): number {
  let out = 0
  // Only system messages: a conversation that quotes the list is not one.
  for (const m of body.messages ?? []) {
    if (m.role !== 'system') continue
    const one = (t: string) => {
      const s = shave(t, rules)
      out += t.length - s.length
      return s
    }
    m.content = typeof m.content === 'string' ? one(m.content) : m.content.map((b) => (b.text?.includes(HEAD) ? { ...b, text: one(b.text) } : b))
  }
  return out
}

// The skills a request lists, as Claude Code sent them: the last list in its
// system messages.
export function skillsOf(body: Body): Skill[] {
  const texts = (body.messages ?? []).filter((m) => m.role === 'system').flatMap((m) => (typeof m.content === 'string' ? [m.content] : m.content.map((b) => b.text ?? '')))
  const list = texts.map(listAt).findLast((l) => l !== undefined)
  return list?.entries.flatMap((e) => skillOf(e) ?? []) ?? []
}

// The skills the rules keep whole, which `:shaver optimize` writes lines for;
// lines it wrote before don't count, so it writes those again.
export const keptWhole = (skills: readonly Skill[], rules: readonly SkillRule[]): Skill[] =>
  skills.filter((s) => {
    const rule = rules.find((r) => r.text === undefined && matches(r.match, s.name))
    return !rule || rule.action === 'keep'
  })

// The words a written line can have: as few as told apart neighbouring skills
// best in the probes (local/notes.md).
export const LINE_WORDS = 6

// What `:shaver optimize` asks a model for: a line for each skill, as a JSON
// object of lines by name.
export function linesPrompt(skills: readonly Skill[]): string {
  return [
    "Below is the list of skills an AI coding agent can load. The agent sees only each skill's name and a line about it, and has to decide from that line alone whether a task needs the skill. Write that line for every skill.",
    '',
    'Rules for each line:',
    `- At most ${LINE_WORDS} words. Don't repeat the skill's name.`,
    "- Say what kind of task the skill is for, in plain words a user's request might use.",
    '- Make it tell the skill apart from the others in this list. Where two skills are close, keep what separates them (staging or production, iOS or Android, one-off or recurring, which file type).',
    `- Keep a "don't use when" only if it's what separates the skill from a neighbour or from doing the task directly.`,
    '- Drop examples, how the skill works, and trigger-word lists.',
    '',
    'Reply with only a JSON object mapping each skill name to its line.',
    '',
    '<skills>',
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
    '</skills>',
  ].join('\n')
}

// The lines in a model's answer, by name, for the skills asked about: each a
// string of at most LINE_WORDS words. A skill missing, or with a line that
// isn't, has none.
export function linesOf(answer: string, skills: readonly Skill[]): Record<string, string> {
  let v: unknown
  try {
    v = JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1))
  } catch {
    return {}
  }
  const out: Record<string, string> = {}
  for (const { name } of skills) {
    const line = (v as Record<string, unknown>)?.[name]
    if (typeof line === 'string' && line.trim() && line.trim().split(/\s+/).length <= LINE_WORDS) out[name] = line.trim()
  }
  return out
}

// The rules with written lines: one stub for each line, ahead of the rest, in
// place of any lines written before.
export const withLines = (rules: readonly SkillRule[], skills: readonly Skill[], lines: Record<string, string>): SkillRule[] => [
  ...skills.filter((s) => lines[s.name]).map((s) => ({ match: s.name, action: 'stub' as const, text: lines[s.name], replaces: descriptionHash(s.description) })),
  ...rules.filter((r) => r.text === undefined),
]

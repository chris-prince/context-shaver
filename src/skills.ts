// Shortens the skill list Claude Code sends in its environment message, or
// Codex in its developer message, by the
// policy's `skill_list` (policy.ts): each listed skill takes the first rule
// whose pattern matches its name, and is kept, stubbed, or dropped from the
// list. With no rule matching it is kept. A stub is the first sentences of the
// description, or a line `:shaver optimize` wrote for it (server.ts), which
// `replaces` names by the hash of the description it was written from; a
// description since changed is kept whole. A dropped skill can still be run as
// `/name`; the model just isn't told of it. Gives the bytes it took out.

import { hash } from './log.ts'

// The lists harnesses send, each after its heading. Claude Code's ends at a
// blank line, an entry's description sometimes running on over more lines.
// Codex's ends at the first line that isn't an entry, each entry one line
// ending with where its SKILL.md is, which is kept as it is.
type Format = { head: string; end: RegExp; tail: RegExp }
const FORMATS: Format[] = [
  { head: 'The following skills are available for use with the Skill tool:\n\n', end: /\n\n/g, tail: /$/ },
  { head: '### Available skills\n', end: /\n(?!- )/g, tail: / \(file: [^()]*\)$/ },
]

export type SkillRule = { match: string; action: 'keep' | 'stub' | 'drop'; sentences?: number; text?: string; replaces?: string }
export type Skill = { name: string; description: string }

// The hash a written line's `replaces` holds.
export const descriptionHash = (description: string) => hash(description).slice(0, 12)

type Block = { type: string; text?: string }
type Body = { messages?: { role: string; content: string | Block[] }[]; system?: unknown }

// A pattern is a name, with `*` for any run of characters.
export const matches = (pattern: string, name: string) => new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(name)

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

// Each entry is `- name: description`, then its format's tail.
type List = { format: Format; at: number; from: number; end: number; entries: string[] }
function listAt(text: string): List | undefined {
  for (const format of FORMATS) {
    const at = text.indexOf(format.head)
    if (at < 0) continue
    const from = at + format.head.length
    format.end.lastIndex = from
    const end = format.end.exec(text)?.index ?? text.length
    return { format, at, from, end, entries: text.slice(from, end).split(/\n(?=- [\w:.-]+: )/) }
  }
}

const entryOf = (entry: string, format: Format): (Skill & { tail: string }) | undefined => {
  const name = /^- ([\w:.-]+): /.exec(entry)?.[1]
  if (name === undefined) return undefined
  const rest = entry.slice(name.length + 4)
  const tail = format.tail.exec(rest)?.[0] ?? ''
  return { name, description: rest.slice(0, rest.length - tail.length), tail }
}
const skillOf = (entry: string, format: Format): Skill | undefined => {
  const e = entryOf(entry, format)
  return e && { name: e.name, description: e.description }
}

// The text with its list shortened, and the bytes, as JSON counts them, of the
// entries it sent shortened.
function shave(text: string, rules: readonly SkillRule[]): { text: string; trimmed?: number } {
  const list = listAt(text)
  if (!list) return { text }
  const { at, from, end } = list
  let trimmed = 0
  const kept = list.entries.flatMap((entry) => {
    const skill = entryOf(entry, list.format)
    const rule = skill && rules.find((r) => matches(r.match, skill.name))
    if (rule?.action === 'drop') return []
    if (rule?.action !== 'stub') return [entry]
    const stub = `- ${skill!.name}: ` + stubOf(skill!.description, rule) + skill!.tail
    if (stub !== entry) trimmed += JSON.stringify(stub).length - 2
    return [stub]
  })
  if (!kept.length) return { text: text.slice(0, at) + text.slice(end).replace(/^\n\n/, ''), trimmed }
  return { text: text.slice(0, from) + kept.join('\n') + text.slice(end), trimmed }
}

const textsOf = (content: unknown): string[] => (typeof content === 'string' ? [content] : Array.isArray(content) ? content.map((b: Block) => b.text ?? '') : [])

// Only the system and system messages: a conversation that quotes the list
// is not one. Gives the bytes cut, and those of the entries shortened in the
// first list, the base's (listMessage); a later one is history.
export function shaveSkills(body: Body, rules: readonly SkillRule[]): { cut: number; trimmed?: number } {
  const out: { cut: number; trimmed?: number } = { cut: 0 }
  const one = (t: string) => {
    const s = shave(t, rules)
    out.cut += t.length - s.text.length
    out.trimmed ??= s.trimmed
    return s.text
  }
  const each = (content: string | Block[]) => (typeof content === 'string' ? one(content) : content.map((b) => (b.text !== undefined && listAt(b.text) ? { ...b, text: one(b.text) } : b)))
  if (typeof body.system === 'string' || Array.isArray(body.system)) body.system = each(body.system as string | Block[])
  for (const m of body.messages ?? []) if (m.role === 'system') m.content = each(m.content)
  return out
}

// The message holding a request's skill list, the first in its system
// messages, or -1 with none, as when the list is in the system: where its base
// ends, for `:shaver optimize`'s fork. Claude Code lists a skill again later in
// the conversation when its description changes, so a later list is history.
export const listMessage = (body: Body): number => (body.messages ?? []).findIndex((m) => m.role === 'system' && textsOf(m.content).some((t) => listAt(t)))

// The skills a request lists, as its harness sent them: every list in its
// system and system messages, a skill listed again taking its later entry.
export function skillsOf(body: Body): Skill[] {
  const texts = [...textsOf(body.system), ...(body.messages ?? []).filter((m) => m.role === 'system').flatMap((m) => textsOf(m.content))]
  const out = new Map<string, Skill>()
  for (const list of texts.map(listAt)) for (const s of list?.entries.flatMap((e) => skillOf(e, list.format) ?? []) ?? []) out.set(s.name, s)
  return [...out.values()]
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

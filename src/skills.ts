// Shortens the skill list Claude Code sends in its environment message, by the
// policy's `skill_list` (policy.ts): each listed skill takes the first rule
// whose pattern matches its name, and is kept, stubbed to the first sentences
// of its description, or dropped from the list. With no rule matching it is
// kept. A dropped skill can still be run as `/name`; the model just isn't told
// of it. Gives the bytes it took out.

const HEAD = 'The following skills are available for use with the Skill tool:\n\n'

export type SkillRule = { match: string; action: 'keep' | 'stub' | 'drop'; sentences?: number }

type Block = { type: string; text?: string }
type Body = { messages?: { role: string; content: string | Block[] }[] }

// A pattern is a name, with `*` for any run of characters.
const matches = (pattern: string, name: string) => new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(name)

// The text up to the end of its nth sentence, or all of it if it has fewer.
function firstSentences(text: string, n: number): string {
  const ends = [...text.matchAll(/[.!?](?=\s|$)/g)]
  return ends.length > n ? text.slice(0, ends[n - 1].index + 1) : text
}

// Each entry is `- name: description`, its description sometimes running on
// over more lines; the list ends at a blank line.
function shave(text: string, rules: readonly SkillRule[]): string {
  const at = text.indexOf(HEAD)
  if (at < 0) return text
  const from = at + HEAD.length
  const end = text.indexOf('\n\n', from) < 0 ? text.length : text.indexOf('\n\n', from)
  const kept = text
    .slice(from, end)
    .split(/\n(?=- [\w:.-]+: )/)
    .flatMap((entry) => {
      const name = /^- ([\w:.-]+): /.exec(entry)?.[1]
      const rule = name === undefined ? undefined : rules.find((r) => matches(r.match, name))
      if (rule?.action === 'drop') return []
      if (rule?.action === 'stub') return [`- ${name}: ` + firstSentences(entry.slice(name!.length + 4), rule.sentences!)]
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

// `shaver optimize`'s questions, answers and replies, apart from what the
// proxy measures and asks the model for, the policy file's I/O and the offer
// it holds (server.ts), so each rule here can be tested alone. It offers
// deferring the tools sent in full but those always loaded, or dropping them where
// they can't be deferred, and a line for each skill the policy keeps whole,
// asks which tools to defer or drop, then which skills to trim, and puts the
// ones picked in the policy file's text.

import { withPicked } from './defer.ts'
import type { Harness } from './harness.ts'
import { parsePolicy, withList } from './policy.ts'
import { withLines, type Skill } from './skills.ts'
import { counted } from './stats.ts'

// How replies end when they ask which items to change.
export const PICK = "Type 'all', 'none', a specific list (like '1 3 5-8'), or 'keep' (to leave as-is)."

// The question that ends a reply offering skill lines or tools to defer or
// drop, after a note on what it risks; a drop's warning comes with its table.
export const SKILLS_NOTE = 'Trimming skills is generally safe. But if a skill stops auto-loading, you can later disable its trim.'
export const TOOLS_NOTE = "Deferring tools is always safe. But don't defer tools you use regularly, it can raise costs."
export const askOf = (asking: 'skills' | 'tools', action: 'defer' | 'drop' = 'defer') =>
  `${asking === 'skills' ? `${SKILLS_NOTE}\n\nWhich skills should be trimmed?` : action === 'drop' ? 'Which tools should be dropped?' : `${TOOLS_NOTE}\n\nWhich tools should be deferred?`}\n${PICK}`

// A reply to PICK as the words of the command it is (command.ts): `all`,
// `none`, `keep`, or, for any text of only digits, dashes, commas and spaces,
// its pieces split by spaces, valid or not (numbersOf checks them). Any other
// reply is `invalid`, so it is asked again and never reaches the model.
export function pickWords(text: string): string {
  if (/^(?:all|none|keep)$/i.test(text)) return text.toLowerCase()
  if (/^[\d\s,-]+$/.test(text) && /\d/.test(text)) return text.replace(/\s*-\s*/g, '-').replace(/\d+/g, (d) => String(Number(d))).split(/[\s,]+/).filter(Boolean).join(' ')
  return 'invalid'
}

// The item numbers in pickWords's `answer`; or undefined if a piece isn't a
// number or a range written low to high (`3-5`), or is outside 1 to `n`.
function numbersOf(answer: string, n: number): number[] | undefined {
  if (!answer.split(' ').every((w) => /^\d+(?:-\d+)?$/.test(w))) return undefined
  const ends = answer.split(' ').map((w) => w.split('-').map(Number))
  if (ends.some(([a, b = a]) => a < 1 || b > n || b < a)) return undefined
  return ends.flatMap(([a, b = a]) => Array.from({ length: b - a + 1 }, (_, k) => a + k))
}

export const NOTHING = 'No changes to apply. Run `shaver optimize` again.'

// The tools part of an offer: the harness asked, whether its tools are
// deferred or dropped, the tools in its table, those that is done to already
// and the text showing them, or why there are none.
export type Tools = { harness: Pick<Harness, 'name'>; action: 'defer' | 'drop'; names: string[]; chosen: string[]; text: string } | string

// The skills part: the text showing them (skillsText's) or why there are
// none, the skills in its table, a line for each and those already trimmed.
export type Skills = { text: string; skills: Skill[]; lines: Record<string, string>; trimmed: string[] }

// What `shaver optimize` asked about, in the conversation `key`: its tools,
// then its skills, empty until they are shown.
export type Proposal = {
  key: string
  asking: 'skills' | 'tools'
  tools: Tools
  skills: Skill[]
  lines: Record<string, string>
  trimmed: string[]
}

// The reply asking which `tools` to defer or drop in the conversation `key`,
// and the offer it makes; undefined if there are none to ask about.
export function toolsAsked(key: string, tools: Tools): { reply: string; next: Proposal } | undefined {
  if (typeof tools === 'string') return undefined
  return { reply: [tools.text, '', askOf('tools', tools.action)].join('\n'), next: { key, asking: 'tools', tools, skills: [], lines: {}, trimmed: [] } }
}

// The reply asking which `skills` to trim after `shown`'s tools, and the offer
// it makes; or, with none, why, and the end.
export function skillsAsked(shown: Proposal, skills: Skills): { reply: string; next?: Proposal } {
  if (skills.skills.length) return { reply: [skills.text, '', askOf('skills')].join('\n'), next: { ...shown, asking: 'skills', skills: skills.skills, lines: skills.lines, trimmed: skills.trimmed } }
  return { reply: skills.text }
}

// What answering `answer` (pickWords's) to `shown` does to the policy file
// `text` at `file`: the reply, the file's text after it, and what is asked
// next, if anything. An answer names every item to have trimmed, deferred or
// dropped, so those not named are turned back; `keep` leaves them all as they are. A
// tool answer changes only its harness's rules. Its `next` asks about skills,
// whose question skillsAsked adds.
export function afterAnswer(shown: Proposal, answer: string, text: string, file: string): { reply: string; text: string; next?: Proposal } {
  const tools = typeof shown.tools === 'string' ? { harness: { name: '' }, action: 'defer' as const, names: [], chosen: [] } : shown.tools
  const items = shown.asking === 'skills' ? shown.skills.map((s) => s.name) : tools.names
  const on = new Set(shown.asking === 'skills' ? shown.trimmed : tools.chosen)
  const numbers = ['all', 'none', 'keep'].includes(answer) ? [] : numbersOf(answer, items.length)
  if (!numbers) return { reply: `All numbers must be between 1 and ${items.length}. Ranges must be stated as X-Y, smaller number first. Keywords are: all / none / keep.\n\n${askOf(shown.asking, tools.action)}`, text, next: shown }
  const picked = new Set(answer === 'all' ? items : answer === 'keep' ? on : items.filter((_, i) => numbers.includes(i + 1)))
  const changes = items.filter((name) => picked.has(name) !== on.has(name)).length
  let written = text
  const policy = parsePolicy(JSON.parse(text))
  if (changes && shown.asking === 'skills') {
    const lines = Object.fromEntries([...picked].map((name) => [name, shown.lines[name]]))
    written = withList(text, 'skill_shaver_rules', withLines(policy.skill_shaver_rules ?? [], shown.skills, lines))
  } else if (changes) {
    const { name } = tools.harness
    const lists = { ...policy.tool_shaver_rules, [name]: withPicked(policy.tool_shaver_rules?.[name] ?? [], items, picked, tools.action, tools.harness.alwaysLoaded) }
    written = withList(text, 'tool_shaver_rules', lists)
  }
  const done = [`Modified ${counted(changes, shown.asking === 'skills' ? 'skill' : 'tool')} in shaver policy file.`, file]
  if (shown.asking === 'tools') return { reply: done.join('\n'), text: written, next: { ...shown, asking: 'skills' } }
  return { reply: done.join('\n'), text: written }
}

const n = (x: number) => x.toLocaleString('en-US')
const cell = (s: string) => s.replace(/\|/g, '\\|')

// What the reply says at once, while the tools are measured.
export const ANALYZING_TOOLS = 'Analyzing tools...\n\n'

// The tokens `count` skills or tools add to every request as sent, `own`,
// and those the policy keeps out of it already, `blocked` (said only if
// any).
export type Measured = { own: number; blocked: number }
const adding = (count: number, noun: string, { own, blocked }: Measured) =>
  `${counted(count, noun)} currently add${count === 1 ? 's' : ''} ${n(own)} tokens on every request.${blocked > 0 ? `\nShaver already saves ${n(blocked)} additional tokens.` : ''}`
// What the line after a table says doing `verb` to every item saves, `more`.
const would = (verb: string, more: number) => `\n\n${verb} 'all' would save ${n(more)} more tokens on every request.`

// What the skills part says while the lines are asked for: first at once,
// then once the skills' tokens are known (undefined if measuring failed),
// and that lines are being written only if some are, `generating`.
export const ANALYZING = 'Analyzing skills...\n\n'
export const optimizing = (skills: number, measured: Measured | undefined, generating: boolean) =>
  `${measured ? adding(skills, 'skill', measured) : `${counted(skills, 'skill')} ${skills === 1 ? 'is' : 'are'} listed.`}\n${generating ? '\nGenerating optimized skill descriptions...\n\n' : ''}`

// The skills part of the offer: a table of `lined`, each with its line in
// `lines` and whether it is trimmed already, then the tokens trimming all
// saves, `saved` (or why it is unknown), unless all are. Each number is in
// its skill's cell, not a column of its own, so the table fits a terminal
// 63 columns wide; narrower than it fits, Claude Code shows it as a list.
export function skillsText(lined: readonly Skill[], lines: Record<string, string>, trimmed: ReadonlySet<string>, saved: number | Error): string {
  const table = [
    saved instanceof Error ? `Couldn't measure the savings (sending the base failed: ${saved.message}). Short skill descriptions:` : 'Current status:',
    '',
    '| Skill | Trimmed | Trimmed Description |',
    '| --- | --- | --- |',
    ...lined.map((s, i) => `| ${i + 1}. ${cell(s.name)} | ${trimmed.has(s.name) ? 'Yes' : 'No'} | ${cell(lines[s.name])} |`),
  ].join('\n')
  return saved instanceof Error || trimmed.size === lined.length ? table : table + would('Trimming', saved)
}

// The tools part of the offer: the tokens `names` add and those blocked
// already, a table of them, each with `action` done to it already or not,
// then the tokens doing it to all saves, `more`, unless it is done to all.
// Dropping is offered where tools can't be deferred, and warned of.
export function toolsText(names: readonly string[], chosen: readonly string[], measured: (Measured & { more: number }) | Error, action: 'defer' | 'drop' = 'defer'): string {
  const drop = action === 'drop'
  const table = [`| Tool | ${drop ? 'Dropped' : 'Deferred'} |`, '| --- | --- |', ...names.map((name, i) => `| ${i + 1}. ${cell(name)} | ${chosen.includes(name) ? 'Yes' : 'No'} |`)].join('\n')
  const warning = drop ? "Codex can't defer tools with ChatGPT sign-in, only drop them. The model can't use a dropped tool at all, so drop with caution.\n\n" : ''
  if (measured instanceof Error) return `${warning}Couldn't measure the savings (sending the base failed: ${measured.message}). Tools:\n\n${table}`
  const more = chosen.length === names.length ? '' : would(drop ? 'Dropping' : 'Deferring', measured.more)
  return `${warning}${adding(names.length, 'tool', measured)}\nCurrent status:\n\n${table}${more}`
}

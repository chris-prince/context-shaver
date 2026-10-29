// `:shaver optimize`'s questions, answers and replies, apart from what the
// proxy measures and asks the model for, the policy file's I/O and the offer
// it holds (server.ts), so each rule here can be tested alone. It offers
// deferring the tools sent in full but the core ones and a line for each
// skill the policy keeps whole, asks which tools to defer, then which skills
// to trim, and puts the ones picked in the policy file's text.

import { withDeferred } from './defer.ts'
import { parsePolicy, toolRulesOf, withList } from './policy.ts'
import { withLines, type Skill } from './skills.ts'
import { counted } from './stats.ts'

// How replies end when they ask which items to change.
export const PICK = "Type 'all', 'none', a specific list (like '1,3-5 8'), or 'keep' to leave as-is."

// The question that ends a reply offering skill lines or tools to defer.
export const askOf = (asking: 'skills' | 'tools') => `${asking === 'skills' ? 'Which skills should be trimmed?' : 'Which tools should be deferred?'}\n${PICK}`

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

const CLEAR = 'Run /clear in every claude/codex/opencode active session on this machine to make `shaver info` report skill savings accurately.'

// The tools part of an offer: the tools in its table, those deferred already
// and the text showing them, or why there are none.
export type Tools = { names: string[]; deferred: string[]; text: string } | string

// The skills part: the text showing them (skillsText's) or why there are
// none, the skills in its table, a line for each and those already trimmed.
export type Skills = { text: string; skills: Skill[]; lines: Record<string, string>; trimmed: string[] }

// What `:shaver optimize` asked about, in the conversation `key`: its tools,
// then its skills, empty until they are shown. `changed` counts the items
// answers changed so far.
export type Proposal = {
  key: string
  asking: 'skills' | 'tools'
  tools: Tools
  skills: Skill[]
  lines: Record<string, string>
  trimmed: string[]
  changed: number
}

// The reply asking which `tools` to defer in the conversation `key`, and the
// offer it makes; undefined if there are none to ask about.
export function toolsAsked(key: string, tools: Tools): { reply: string; next: Proposal } | undefined {
  if (typeof tools === 'string') return undefined
  return { reply: [tools.text, '', askOf('tools')].join('\n'), next: { key, asking: 'tools', tools, skills: [], lines: {}, trimmed: [], changed: 0 } }
}

// The reply asking which `skills` to trim after `shown`'s tools, and the offer
// it makes; or, with none, why, and the end.
export function skillsAsked(shown: Proposal, skills: Skills): { reply: string; next?: Proposal } {
  if (skills.skills.length) return { reply: [skills.text, '', askOf('skills')].join('\n'), next: { ...shown, asking: 'skills', skills: skills.skills, lines: skills.lines, trimmed: skills.trimmed } }
  return { reply: [skills.text, ...(shown.changed ? ['', CLEAR] : [])].join('\n') }
}

// What answering `answer` (pickWords's) to `shown` does to the policy file
// `text` at `file`: the reply, the file's text after it, and what is asked
// next, if anything. An answer names every item to have trimmed or deferred,
// so those not named are turned back; `keep` leaves them all as they are. A
// tool answer's `next` asks about skills, whose question skillsAsked adds.
export function afterAnswer(shown: Proposal, answer: string, text: string, file: string): { reply: string; text: string; next?: Proposal } {
  const tools = typeof shown.tools === 'string' ? { names: [], deferred: [] } : shown.tools
  const items = shown.asking === 'skills' ? shown.skills.map((s) => s.name) : tools.names
  const on = new Set(shown.asking === 'skills' ? shown.trimmed : tools.deferred)
  const numbers = ['all', 'none', 'keep'].includes(answer) ? [] : numbersOf(answer, items.length)
  if (!numbers) return { reply: `All numbers must be between 1 and ${items.length}. Ranges must be stated as X-Y, smaller number first.\n\n${askOf(shown.asking)}`, text, next: shown }
  const picked = new Set(answer === 'all' ? items : answer === 'keep' ? on : items.filter((_, i) => numbers.includes(i + 1)))
  const changes = items.filter((name) => picked.has(name) !== on.has(name)).length
  let written = text
  if (changes) {
    const policy = parsePolicy(JSON.parse(text))
    if (shown.asking === 'skills') {
      const lines = Object.fromEntries([...picked].map((name) => [name, shown.lines[name]]))
      // Lines for skills this session doesn't list stay.
      const elsewhere = new Set((policy.skill_list ?? []).filter((r) => r.text !== undefined && !items.includes(r.match)).map((r) => r.match))
      written = withList(text, 'skill_list', withLines(policy.skill_list ?? [], shown.skills, lines, elsewhere))
    } else written = withList(text, 'tool_list', withDeferred(toolRulesOf(policy) ?? [], items, picked), 'tools_not_deferred')
  }
  const done = [`Modified ${counted(changes, shown.asking === 'skills' ? 'skill' : 'tool')} in shaver policy file.`, file]
  const changed = shown.changed + changes
  if (shown.asking === 'tools') return { reply: done.join('\n'), text: written, next: { ...shown, asking: 'skills', changed } }
  return { reply: [...done, ...(changed ? ['', CLEAR] : [])].join('\n'), text: written }
}

const n = (x: number) => x.toLocaleString('en-US')
const cell = (s: string) => s.replace(/\|/g, '\\|')

// What the reply says at once, while the tools are measured.
export const ANALYZING_TOOLS = 'Analyzing tools...\n\n'

// What the skills part says while the lines are asked for: first at once,
// then once the skills' tokens are known, `own` (undefined if measuring
// failed).
export const ANALYZING = 'Analyzing skills...\n\n'
export const optimizing = (skills: number, own: number | undefined) =>
  `${counted(skills, 'skill')} ${own === undefined ? `${skills === 1 ? 'is' : 'are'} listed` : `add ${n(own)} tokens on every request`}. Optimizing...\n\n`

// The skills part of the offer: a table of `lined`, each with its line in
// `lines` and whether it is trimmed already, headed by the tokens the lines
// save, `saved` (or why it is unknown). If every line was sent already
// (`fresh` false), it says only how many skills use one. Each number is in
// its skill's cell, not a column of its own, so the table fits a terminal
// 63 columns wide; narrower than it fits, Claude Code shows it as a list.
export function skillsText(lined: readonly Skill[], lines: Record<string, string>, trimmed: ReadonlySet<string>, saved: number | Error, fresh: boolean): string {
  return [
    saved instanceof Error
      ? `Couldn't measure the savings (sending the base failed: ${saved.message}). Short skill descriptions:`
      : fresh
        ? `Can save ${n(saved)} tokens using short skill descriptions:`
        : `${counted(lined.length, 'skill')} use short descriptions:`,
    '',
    '| Skill | Trimmed | Trimmed Description |',
    '| --- | --- | --- |',
    ...lined.map((s, i) => `| ${i + 1}. ${cell(s.name)} | ${trimmed.has(s.name) ? 'Yes' : 'No'} | ${cell(lines[s.name])} |`),
  ].join('\n')
}

// The tools part of the offer: a table of `names`, each deferred already or
// not, headed by the tokens deferring them all saves, `saved` (or why it is
// unknown). If all are deferred, it says only how many load when needed.
export function toolsText(names: readonly string[], deferred: readonly string[], saved: number | Error): string {
  const table = ['| # | Tool | Deferred |', '| --- | --- | --- |', ...names.map((name, i) => `| ${i + 1} | ${cell(name)} | ${deferred.includes(name) ? 'Yes' : 'No'} |`)].join('\n')
  if (saved instanceof Error) return `Couldn't measure the savings (sending the base failed: ${saved.message}). Tools:\n\n${table}`
  const head = deferred.length < names.length ? `Can save ${n(saved)} tokens by deferring tools until the model needs them:` : `${counted(names.length, 'tool')} load only when the model needs them:`
  return `${head}\n\n${table}`
}

// What Claude Code's compaction keeps of a conversation besides its summary,
// as 2.1.327's source builds the request after one, checked against ten
// compactions logged here (2026-11-18): the base, untouched; the context it
// sends again, the first message's reminders (instructions, memory), the
// deferred tools' tool_addition blocks and its standing context in system
// messages (the environment, MCP servers' instructions, the skills listing,
// the deferred tools announced), as it last stood; the bodies of the
// skills invoked, newest first, to SKILL_BUDGET; and the files it reads again, the FILES
// newest by modification time of those it read or wrote (File), each over
// FILE_TOKENS a note instead, up to BUDGET
// in all, from a record of them it holds in memory, which outlasts a
// compaction: a file read before an earlier compaction can be restored by a
// later one, though no message still holds it. The
// last exchange, an answer and the results after it, it keeps whole; that
// comes in the next request, as what it adds, so it isn't counted here, nor
// are the files that answer reads, which the compaction leaves out (Phs's
// Lhs), as it does the plan, the instructions loaded and artifacts. It picks
// the newest before reading them from disk, and drops any it can't read, a
// file since deleted, rather than taking the next. Not
// modelled: the plan, todos and background agents it restores, and hooks'
// output on compacting.
//
// The proxy folds each request's messages as the client sent them into Keep,
// held in memory, and journals what keptTokens needs of it (Kept, Stats.keep):
// not where the fold got to, which changes every request, so a line holds the
// fold only when what it keeps changed; after a restart the first request
// folds its messages from the start, keeping the journaled files. The backtest each request's
// rebuilt messages: only those past the last folded, while the messages go on
// from it, so a request costs what it adds; a rewind or compaction, which
// changes what came before, folds them again from the start, keeping the
// files seen before it, as Claude Code does. Files are kept in characters and
// lines as a Read result shows them (fileTokens), the rest in bytes, its
// tokens worked out where the conversation's tokens a byte are known
// (keptTokens).

import { isReminder } from './log.ts'
import { blocks, type ApiMsg, type Block } from './items.ts'
import { keyOf } from './stats.ts'

// Claude Code's limits on the files a compaction reads again (hwt, ywt, khs).
const FILES = 5
const FILE_TOKENS = 5_000
const BUDGET = 50_000
// What a file restored costs past its contents: the tool call its attachment
// is shown as.
const CALL_BYTES = 120
// A file over FILE_TOKENS is restored as this note instead; a file known only
// as such a note is kept at TOO_LARGE bytes.
const note = (path: string) => `Note: ${path} was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.`
const TOO_LARGE = -1

// The standing context in system messages, by the line each part opens with:
// the latest of each is sent again, the deferred tools' as one list of them
// all, not each announcement (2026-11-18: summing those, seven compactions
// were predicted to keep up to five times the list).
// The skills listing among them: sent again since about 2.1.301, not by
// 2.1.300 and before (2026-11-18: all 18 compactions logged here).
const LATEST = ['# Environment\n', '# MCP Server Instructions', 'The following skills are available', 'You are powered by', 'The following deferred tools', 'The following tools just became available']
// A part that ends the one before it but isn't counted: the opening of the
// skills a compaction restores, counted in SKILLS_HEADER.
const SKIP = ['The following skills were invoked EARLIER']

// The skills a compaction restores (Ohs): their bodies, newest invoked first,
// each over SKILL_TOKENS cut to SKILL_CUT characters, up to SKILL_BUDGET in
// all, Claude Code counting 4 characters a token (2026-11-18: a skill of about
// 23K characters came back cut at 20,000).
const SKILL_TOKENS = 5_000
const SKILL_BUDGET = 25_000
const SKILL_CUT = SKILL_TOKENS * 4
const ccTokens = (chars: number) => chars / 4
// The message they're restored in, past their bodies: its opening, and each
// skill's "### Skill:" and "Path:" lines.
const SKILLS_HEADER = 700
const SKILL_LINES = 60
// A skill's body beside the Skill tool's result, and as a compaction restores it.
const SKILL_BODY = 'Base directory for this skill: '
const RESTORED_SKILL = /^### Skill: ([^\n]+)\nPath: [^\n]*\n/gm
// A restored file in the system message after a compaction.
const RESTORED = /Called the Read tool with the following input: (\{[^\n]*?\})|Note: (\S+) was read before the last conversation was summarized/g

// A file as a Read result shows it: path, characters (TOO_LARGE for a note),
// lines, and its modification time on disk when last read or written, where
// it could be looked up. Claude Code restores the newest by that time, not
// the last read (2026-11-18, two sessions run to tell them apart). Before
// 2026-11-18 a file was [path, JSON bytes], read in keptTokens at the
// conversation's tokens a byte.
export type File = [path: string, chars: number, lines?: number, mtime?: number]
// A Read, Write or edit awaiting its result: the file, and what the result
// makes it: null for a Read, which measures its result; a Write's size; an
// edit's change in characters and lines.
type Call = [path: string, size: null | { chars: number; lines: number; change?: true }]

// A skill invoked: its name and its body's characters.
export type Skill = [name: string, chars: number]

// `n`: the messages folded; `last`: the last one's key, which the next
// request's messages must hold at n - 1 to go on from them; `resent`: the
// bytes sent again besides the latest standing context, `latest`, by its
// opening line; `rounds`: the answers seen; `files`: newest touched last;
// `skills`: newest invoked last, carried across a compaction as files are;
// `calls`: the file calls awaiting their results, by id; `reads`: the files
// the last answer reads; `version`: Claude Code's, as the skills were
// invoked under it; `skillsFrom`: the first message after the latest version
// change. Before 2026-11-18 there were no `skills`, `version` or `skillsFrom`.
export type Keep = { n: number; last: string; resent: number; latest: Record<string, number>; rounds: number; files: File[]; skills: Skill[]; calls: Record<string, Call>; reads: string[]; version?: string; skillsFrom?: number }

// Claude Code's version, from its billing header in the system prompt.
// Claude Code holds the skills invoked in memory, so a compaction after it
// restarts restores none from before (2026-11-18: none restored after three
// updates; one restored 47 seconds after it was invoked). A version changed
// is a restart for sure; a restart without one isn't seen.
export const ccVersion = (system: unknown): string | undefined => /cc_version=(\d+\.\d+\.\d+)/.exec(JSON.stringify(system ?? ''))?.[1]

// A file's modification time on disk, in ms, or undefined where it can't be
// looked up: the proxy looks at the disk, the backtest at what the proxy
// journaled.
export type MtimeOf = (path: string) => number | undefined

// A file's tokens as a Read result shows it, numbered lines and all, fitted
// to 19 real Read results (2026-11-18: median error 6%, vs 9% at the
// conversation's tokens a byte).
export const fileTokens = (chars: number, lines: number) => 0.338 * chars + 3.24 * lines

// The files kept: more than are ever restored, past those the last answer
// reads. 12 fitted worse at a real compaction (2026-11-05: +63% vs +54%).
const KEPT_FILES = 30

// What keptTokens needs, as journaled: the answers counted only to two.
export type Kept = Omit<Keep, 'n' | 'last' | 'calls'>
export const kept = ({ n: _n, last: _last, calls: _calls, ...k }: Keep): Kept => ({ ...k, rounds: Math.min(k.rounds, 2) })

const bytes = (v: unknown) => JSON.stringify(v).length
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const newlines = (s: string) => s.split('\n').length - 1
// A file's text as a Read result shows it: each line numbered, "N\t".
function shown(content: string): { chars: number; lines: number } {
  const lines = newlines(content) + 1
  let numbers = 0
  for (let d = 1, from = 1; from <= lines; d++, from *= 10) numbers += (Math.min(lines, from * 10 - 1) - from + 1) * (d + 1)
  return { chars: content.length + numbers, lines }
}
// A Read result's text, or undefined where it holds none (an image).
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const ts = content.filter((c) => c?.type === 'text').map((c) => String(c.text))
  return ts.length ? ts.join('\n') : undefined
}

// An edit's change in characters and lines; a replace_all counted once, its
// count unknown.
type Edit = { old_string?: unknown; new_string?: unknown }
const delta = (es: Edit[]) => es.reduce((n, e) => typeof e.old_string === 'string' && typeof e.new_string === 'string'
  ? { chars: n.chars + e.new_string.length - e.old_string.length, lines: n.lines + newlines(e.new_string) - newlines(e.old_string), change: true as const }
  : n, { chars: 0, lines: 0, change: true as const })

// The file moved to newest, at `size`, or as it was where that's unknown,
// with its modification time now where it can be looked up.
function touch(k: Keep, path: string, size: { chars: number; lines?: number } | undefined, mtime: number | undefined): void {
  const i = k.files.findIndex(([p]) => p === path)
  const was = i >= 0 ? k.files.splice(i, 1)[0] : undefined
  const chars = size?.chars ?? was?.[1]
  if (chars === undefined || chars === 0) return
  const lines = size ? size.lines : was?.[2]
  const t = mtime ?? was?.[3]
  // Journaled, a missing line count reads back as null.
  k.files.push(t !== undefined ? [path, chars, lines ?? undefined, t] : lines !== undefined && lines !== null ? [path, chars, lines] : [path, chars])
  if (k.files.length > KEPT_FILES) k.files.shift()
}

// The skill moved to newest, at its body's characters.
function invoked(k: Keep, name: string, chars: number): void {
  const i = k.skills.findIndex(([n]) => n === name)
  if (i >= 0) k.skills.splice(i, 1)
  k.skills.push([name, chars])
}

// A system message's text, in the parts it opens: standing context, and
// files and skills a compaction restored.
function system(k: Keep, text: string, mtimeOf: MtimeOf | undefined): void {
  const marks: Array<{ at: number; kind: 'latest' | 'file' | 'skip' | 'skill'; key: string; note?: true; from?: number }> = []
  const opens = (hs: string[], kind: 'latest' | 'skip') => {
    for (const h of hs) for (let at = text.indexOf(h); at >= 0; at = text.indexOf(h, at + 1)) if (at === 0 || text[at - 1] === '\n') marks.push({ at, kind, key: h })
  }
  opens(LATEST, 'latest')
  opens(SKIP, 'skip')
  for (const m of text.matchAll(RESTORED_SKILL)) marks.push({ at: m.index, kind: 'skill', key: m[1], from: m.index + m[0].length })
  for (const m of text.matchAll(RESTORED)) {
    let path = m[2]
    if (m[1]) try { path = (JSON.parse(m[1]) as { file_path?: string }).file_path } catch { path = undefined }
    if (path) marks.push({ at: m.index, kind: 'file', key: path, ...(m[2] && { note: true as const }) })
  }
  marks.sort((a, b) => a.at - b.at)
  marks.forEach((m, i) => {
    const part = text.slice(m.at, marks[i + 1]?.at ?? text.length)
    if (m.kind === 'skip') return
    if (m.kind === 'latest') k.latest[m.key] = part.length
    else if (m.kind === 'skill') invoked(k, m.key, Math.max(0, part.length - (m.from! - m.at)))
    else touch(k, m.key, m.note ? { chars: TOO_LARGE } : { chars: Math.max(1, part.length - CALL_BYTES), lines: newlines(part) }, mtimeOf?.(m.key))
  })
}

function fold(k: Keep, m: ApiMsg, first: boolean, mtimeOf: MtimeOf | undefined): void {
  const bs = blocks(m) as Block[]
  if (first) k.resent += bs.filter((b) => isReminder(b)).reduce((n, b) => n + bytes(b), 0)
  k.resent += bs.filter((b) => b.type === 'tool_addition').reduce((n, b) => n + bytes(b), 0)
  if ((m.role as string) === 'system') for (const b of bs) if (b.type === 'text') system(k, String(b.text), mtimeOf)
  if (m.role === 'assistant') k.rounds++, (k.reads = [])
  // A skill's body: named by its directory, the first line's last part.
  if (m.role === 'user') for (const b of bs) {
    const text = b.type === 'text' ? String(b.text) : ''
    if (!text.startsWith(SKILL_BODY)) continue
    const name = text.slice(SKILL_BODY.length, (text.indexOf('\n') + 1 || text.length + 1) - 1).replace(/\/+$/, '').split('/').pop()
    if (name) invoked(k, name, text.length)
  }
  for (const b of bs) {
    const input = b.input as { file_path?: string; notebook_path?: string; content?: string; edits?: Edit[] } & Edit | undefined
    const path = input?.file_path ?? input?.notebook_path
    if (b.type === 'tool_use' && FILE_TOOLS.has(String(b.name)) && path) {
      const id = String(b.id)
      if (b.name === 'Read') (k.calls[id] = [path, null]), k.reads.push(path)
      // A file written is read as written; an edit changes the size last
      // known; a notebook edited stays as last read: each once it succeeds.
      else if (b.name === 'Write') k.calls[id] = [path, typeof input.content === 'string' ? shown(input.content) : { chars: 0, lines: 0, change: true }]
      else if (b.name === 'NotebookEdit') k.calls[id] = [path, { chars: 0, lines: 0, change: true }]
      else k.calls[id] = [path, delta(b.name === 'Edit' ? [input] : Array.isArray(input.edits) ? input.edits : [])]
    }
    const call = b.type === 'tool_result' ? k.calls[String(b.tool_use_id)] : undefined
    if (call) {
      const [file, size] = call
      // A call that failed leaves the file as it was.
      if (!b.is_error) {
        if (size === null) {
          const text = textOf(b.content)
          touch(k, file, text !== undefined ? { chars: text.length, lines: newlines(text) } : { chars: bytes(b.content) }, mtimeOf?.(file))
        } else if (!size.change) touch(k, file, size, mtimeOf?.(file))
        else {
          const was = k.files.find(([p]) => p === file)
          const lines = typeof was?.[2] === 'number' ? was[2] + size.lines : undefined
          const chars = was && was[1] !== TOO_LARGE ? Math.max(1, was[1] + size.chars + (lines !== undefined ? size.lines * (String(lines).length + 1) : 0)) : undefined
          touch(k, file, chars !== undefined ? { chars, ...(lines !== undefined && { lines }) } : undefined, mtimeOf?.(file))
        }
      }
      delete k.calls[String(b.tool_use_id)]
    }
  }
}

// The state with the messages from the last folded on folded in, or all of
// them where they don't go on from it, with the files seen before, and the
// skills invoked unless Claude Code's `version` changed (ccVersion).
export function folded(prev: Keep | Kept | undefined, msgs: readonly ApiMsg[], mtimeOf?: MtimeOf, version?: string): Keep {
  const goesOn = !!prev && 'n' in prev && prev.n > 0 && prev.n <= msgs.length && keyOf(msgs[prev.n - 1]) === prev.last
  const files = (prev?.files ?? []).map((f) => [...f] as File)
  const restarted = !!version && !!prev?.version && prev.version !== version
  const skills = restarted ? [] : (prev?.skills ?? []).map((s) => [...s] as Skill)
  const k: Keep = goesOn ? { ...(prev as Keep), latest: { ...prev.latest }, files, skills, calls: { ...(prev as Keep).calls }, reads: [...prev.reads] } : { n: 0, last: '', resent: 0, latest: {}, rounds: 0, files, skills, calls: {}, reads: [] }
  // Skills invoked before a restart are gone from Claude Code's memory, so a
  // record folded again from the start leaves out those before `skillsFrom`.
  const from = restarted ? (goesOn ? prev!.n : msgs.length) : prev?.skillsFrom
  if (from !== undefined) k.skillsFrom = from
  for (let i = k.n; i < msgs.length; i++) {
    const before = from !== undefined && i < from ? k.skills.map((s) => [...s] as Skill) : undefined
    fold(k, msgs[i], i === 0, mtimeOf)
    if (before) k.skills = before
  }
  const v = version ?? prev?.version
  if (v) k.version = v
  k.n = msgs.length
  k.last = msgs.length ? keyOf(msgs[msgs.length - 1]) : ''
  return k
}

// The FILES a compaction restores: newest by modification time where every
// candidate has one, else newest touched.
function restored(k: Kept): File[] {
  const reads = new Set(k.reads)
  const fs = k.files.filter(([p]) => !reads.has(p)).reverse()
  if (fs.every((f) => typeof f[3] === 'number')) fs.sort((a, b) => b[3]! - a[3]!)
  return fs.slice(0, FILES)
}

// What a compaction keeps past the base besides its summary and the last
// exchange, in tokens, at `ratio` tokens a byte for what isn't a file's text;
// undefined with fewer than two answers, which it doesn't compact.
export function keptTokens(k: Kept, ratio: number): number | undefined {
  if (k.rounds < 2) return undefined
  let files = 0
  for (const [path, chars, lines] of restored(k)) {
    const whole = chars === TOO_LARGE ? Infinity : typeof lines === 'number' ? fileTokens(chars, lines) : chars * ratio
    const t = (whole > FILE_TOKENS ? note(path).length * ratio : whole) + CALL_BYTES * ratio
    if (files + t <= BUDGET) files += t
  }
  return (k.resent + Object.values(k.latest).reduce((n, b) => n + b, 0)) * ratio + files + skillTokens(k, ratio)
}

// The skills a compaction restores, in tokens at `ratio`; journals from
// before 2026-11-18 hold none.
function skillTokens(k: Kept, ratio: number): number {
  let used = 0, chars = 0
  for (const [, c] of [...(k.skills ?? [])].reverse()) {
    const body = ccTokens(c) > SKILL_TOKENS ? SKILL_CUT : c
    if (used + ccTokens(body) > SKILL_BUDGET) continue
    used += ccTokens(body)
    chars += body + SKILL_LINES
  }
  return chars ? (chars + SKILLS_HEADER) * ratio : 0
}

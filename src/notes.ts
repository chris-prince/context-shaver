// The notes a harness puts in the conversation after the preamble (log.ts,
// kinds: `harness`), each sorted by how a trim or a summary should treat it:
//
// - latest: restates part of the current state, so a newer note with the same
//   keys replaces it (the working directory, the date).
// - forever: changes what the model can do or is told to do (tools added or
//   removed, skills, instructions), so it is never trimmed or summarized away.
// - file_note: about a file the model can read again (a file attached or
//   changed, or too large to restore), like a tool's result (before
//   2026-11-22, `tool`).
// - task_output: what a task the model started reports back (a background
//   task's notification, another agent's message), like a tool's result.
// - conversation: an event in the conversation (a turn aborted, a reminder),
//   never trimmed and summarized with its turn.
// - unrecognized: under no heading below, kept as forever is, and shown by its
//   first line (stats.ts) so it gets a heading. Of the notes given headings so
//   far, half were forever's and few conversation's; and a forever note
//   dropped loses a tool or an instruction, where a conversation one kept only
//   costs its size until it gets a heading.
//
// Notes in the preamble are never trimmed or summarized, whatever their
// category: only the ones after it are sorted here.
//
// One message can hold several notes, so a text block is cut at the headings,
// each starting the text or a line after a blank one. File contents and diffs
// in notes have numbered lines, so none of theirs reads as a heading.

import { createHash } from 'node:crypto'
import type { Block } from './items.ts'

export const CATEGORIES = ['latest', 'forever', 'file_note', 'task_output', 'conversation', 'unrecognized'] as const
export type Category = (typeof CATEGORIES)[number]
export type Note = { kind: string; category: Category; text: string; keys: string[] }

// Each heading as a regex source, its kind and category. The ones marked
// unseen come from another machine's sessions or the harness's source, not
// from the logs here.
export const NOTES: Array<[string, string, Category]> = [
  // Claude Code
  ['# Environment update', 'environment-update', 'latest'],
  ['The date has changed', 'date-change', 'latest'],
  // A nudge about one moment, spent once answered: kept, it would read as an
  // instruction still to follow.
  ["The user hasn't heard from you", 'unheard-reminder', 'conversation'],
  ['<total_tokens>', 'token-counter', 'latest'],
  ["The task tools haven't been used recently", 'task-tools-reminder', 'conversation'], // unseen
  ['The user named this session', 'session-name', 'latest'],
  ['The following skills are available', 'skills', 'forever'],
  // Each lists every skill invoked so far, so the newest has the others.
  ['The following skills were invoked EARLIER', 'skills-reread', 'latest'],
  ['Available agent types', 'agent-types', 'forever'],
  ['The following agent types are no longer available', 'agent-types', 'forever'],
  ['The following deferred tools', 'deferred-tools', 'forever'],
  ['The following tools just became available', 'tools-added', 'forever'],
  ['The following tools are no longer available', 'tools-removed', 'forever'],
  ['Definitions of the following tools were loaded earlier', 'tools-removed', 'forever'],
  ['The following tools have updated definitions', 'tools-updated', 'forever'],
  ['# MCP Server Instructions', 'mcp-instructions', 'forever'],
  ['While bypass permissions mode is active', 'permission-mode', 'forever'],
  ['Codebase and user instructions', 'agents-md', 'forever'],
  ['Contents of .*/memory/MEMORY\\.md', 'memory', 'forever'],
  // Only the files that changed, each replacing its earlier copy: keyed by file.
  ['Instruction files were re-read', 'instructions-reread', 'latest'],
  ['The session context was re-read', 'session-reread', 'latest'],
  ['As you answer the user', 'guidance', 'forever'],
  ['Attribution for git commits', 'git-attribution', 'forever'],
  ['From here on, do not add attribution lines', 'git-attribution', 'forever'],
  ['# Environment\\n', 'environment', 'latest'],
  ['You are powered by the model', 'model', 'latest'],
  ["Today's date is", 'date', 'latest'],
  ['Called the \\w+ tool with the following input', 'attached-file', 'file_note'],
  // The attached file's contents, when they come in a block of their own.
  ['Result of calling the \\w+ tool:', 'attached-file', 'file_note'],
  ['Note: .* changed on disk since you last read it', 'file-changed', 'file_note'],
  ['Note: .* was read before the last conversation was summarized', 'file-pointer', 'file_note'],
  ['\\[SYSTEM NOTIFICATION - NOT USER INPUT\\]', 'task-notification', 'task_output'],
  ['This is a side question from the user', 'side-question', 'conversation'],
  // Codex
  ['<collaboration_mode>', 'collaboration-mode', 'latest'],
  ['<permissions instructions>', 'permissions', 'latest'],
  ['<environment_context>', 'environment-context', 'forever'], // unseen after the preamble
  ['<skills_instructions>', 'skills', 'forever'],
  ['<multi_agent_role>', 'multi-agent', 'forever'],
  ['<multi_agent_mode>', 'multi-agent', 'forever'],
  ['<recommended_plugins>', 'plugins', 'forever'],
  ['# AGENTS.md instructions', 'agents-md', 'forever'],
  ['<turn_aborted>', 'turn-aborted', 'conversation'],
  ['Approved command prefix saved', 'approved-command', 'conversation'],
  ['You are now a newly spawned child agent', 'child-agent', 'forever'],
  // With an additional_tools item, which BLOCKS dedupes.
  ['This is an incremental tools update', 'tools-added', 'forever'],
  // Forever on the assumption that a path's instructions come once a session.
  ['<scoped-instructions', 'scoped-instructions', 'forever'], // unseen
  // OpenCode, unseen
  ['<available_skills>', 'skills', 'forever'],
  ['New skills are available', 'skills', 'forever'],
  ['The following skills have changed', 'skills', 'forever'],
]

const HEADS = NOTES.map(([h, kind, category]): [RegExp, string, Category] => [new RegExp('(?:^|\\n\\n)(?=' + h + ')', 'g'), kind, category])

// The fields an environment update sets, as keys: ` - Primary working
// directory: …` sets one, as does ` - The scratchpad directory announced
// earlier is no longer available`.
function fieldsOf(text: string): string[] {
  const out = [...text.matchAll(/^\s*- (?:The )?(.+?)(?::| announced earlier| is no longer)/gm)].map((m) => m[1].toLowerCase())
  return out.length ? out : ['environment-update']
}

// The files an instructions re-read gives, as keys: each `Contents of <path>
// (…):` one, and each `Instructions no longer present: <path>` one.
function filesOf(text: string): string[] {
  const out = [...text.matchAll(/^(?:Contents of (.+?) \(.*\):|Instructions no longer present: (.+))$/gm)].map((m) => 'instructions ' + (m[1] ?? m[2]).trim())
  return out.length ? out : ['instructions-reread']
}

const keysOf = (kind: string, text: string) =>
  kind === 'environment-update' ? fieldsOf(text) : kind === 'instructions-reread' ? filesOf(text) : [kind === 'date-change' ? 'date' : kind]

// A note text's notes, in order, their texts joined giving it back (less a
// <system-reminder> wrapper's opening). Text before the first heading is a
// note of its own, unrecognized.
export function notesOf(text: string): Note[] {
  return spansOf(text).map((s) => noteAt(text, s))
}

// Where in a note text each of its notes is, as notesOf finds them.
type Span = { kind: string; category: Category; from: number; to: number; keys: string[] }
const noteAt = (text: string, s: Span): Note => ({ kind: s.kind, category: s.category, text: text.slice(s.from, s.to), keys: [...s.keys] })

function spansOf(text: string): Span[] {
  const body = text.replace(/^<system-reminder>\s*/, '')
  if (!body.trim()) return []
  const off = text.length - body.length
  const starts: Array<[number, string, Category]> = []
  for (const [re, kind, category] of HEADS)
    for (const m of body.matchAll(re)) {
      const at = m.index + m[0].length
      if (!starts.some(([s]) => s === at)) starts.push([at, kind, category])
    }
  starts.sort((a, z) => a[0] - z[0])
  if (starts.length && !body.slice(0, starts[0][0]).trim()) starts[0][0] = 0
  else starts.unshift([0, 'unrecognized', 'unrecognized'])
  return starts.map(([at, kind, category], i) => {
    const to = starts[i + 1]?.[0] ?? body.length
    return { kind, category, from: off + at, to: off + to, keys: keysOf(kind, body.slice(at, to)) }
  })
}

export function joinedNotes(text: string, keep: readonly Note[]): string {
  const t = keep.map((n) => n.text.replace(/\s*<\/system-reminder>\s*$/, '').trimEnd()).join('\n\n')
  return /^<system-reminder>/.test(text) ? `<system-reminder>\n${t}\n</system-reminder>` : t
}

// A note block's notes. A block that isn't text is one: Claude Code's
// tool_addition and tool_removal, its deferred tools' changes, are forever;
// Codex's items go by their type. A compaction item holds the history before
// it, so it is forever too, and additional_tools declares tools, as
// tool_addition does (summary.ts keeps only each tool's newest definition).
const BLOCKS: Record<string, [string, Category]> = { tool_addition: ['tools-added', 'forever'], tool_removal: ['tools-removed', 'forever'] }
const ITEMS: Record<string, [string, Category]> = {
  compaction: ['compaction', 'forever'],
  compaction_trigger: ['compaction-trigger', 'conversation'], // unseen
  additional_tools: ['tools-added', 'forever'],
  agent_message: ['agent-message', 'task_output'],
}
// A note text's notes are found again on each pass over a request's messages
// (trim.ts, notesDue and withoutNotes), each time in a new block, so where
// they are is kept by the text's hash, for the last FOUND texts. Only spans
// and keys are kept, each key copied (a regex match holds on to the whole
// text it came from), so the memo stays small however long the notes. Each
// call gets notes of its own, as keptNotes (summary.ts) tells two blocks'
// notes apart by identity.
const FOUND = 1000
const found = new Map<string, Span[]>()
export function notesOfBlock(b: Block): Note[] {
  if (b.type === 'text') {
    const text = String(b.text)
    const h = createHash('sha1').update(text).digest('base64')
    let ss = found.get(h)
    if (!ss) {
      if (found.size >= FOUND) found.clear()
      ss = spansOf(text).map((s) => ({ ...s, keys: s.keys.map((k) => JSON.parse(JSON.stringify(k)) as string) }))
      found.set(h, ss)
    }
    return ss.map((s) => noteAt(text, s))
  }
  const type = b.type === 'item' ? String((b.item as { type?: unknown } | undefined)?.type) : b.type
  const [kind, category] = (b.type === 'item' ? ITEMS[type] : BLOCKS[type]) ?? [type, 'unrecognized']
  return [{ kind, category, text: '', keys: [kind] }]
}

// A note's first line, cut short, or for a block that isn't text its type:
// how an unrecognized one is shown.
export const firstLine = (n: Note) => n.text.trim().split('\n')[0].slice(0, 80) || `(${n.kind})`

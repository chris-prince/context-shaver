// The notes a harness puts in the conversation after the preamble (log.ts,
// kinds: `harness`), each sorted by how a trim or a summary should treat it:
//
// - latest: restates part of the current state, so a newer note with the same
//   keys replaces it (the working directory, the date).
// - forever: changes what the model can do or is told to do (tools added or
//   removed, skills, instructions), so it is never trimmed or summarized away.
// - tool: content the model can fetch again (a file attached or changed), like
//   a tool's result.
// - conversation: an event in the conversation (a background task done, a turn
//   aborted, a reminder), never trimmed and summarized with its turn.
// - unrecognized: under no heading below, treated as conversation, and shown
//   by its first line (stats.ts) so it gets a heading.
//
// Notes in the preamble are never trimmed or summarized, whatever their
// category: only the ones after it are sorted here.
//
// One message can hold several notes, so a text block is cut at the headings,
// each starting the text or a line after a blank one. File contents and diffs
// in notes have numbered lines, so none of theirs reads as a heading.

import type { Block } from './items.ts'

export const CATEGORIES = ['latest', 'forever', 'tool', 'conversation', 'unrecognized'] as const
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
  ['Called the \\w+ tool with the following input', 'attached-file', 'tool'],
  ['Note: .* changed on disk since you last read it', 'file-changed', 'tool'],
  ['Note: .* was read before the last conversation was summarized', 'file-pointer', 'tool'],
  ['\\[SYSTEM NOTIFICATION - NOT USER INPUT\\]', 'task-notification', 'conversation'],
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
  const body = text.replace(/^<system-reminder>\s*/, '')
  if (!body.trim()) return []
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
    const t = body.slice(at, starts[i + 1]?.[0])
    return { kind, category, text: t, keys: keysOf(kind, t) }
  })
}

// A note block's notes. A block that isn't text is one: a compaction item
// (Codex's, which holds the history before it) is conversation, and Claude
// Code's tool_addition and tool_removal, its deferred tools' changes, forever.
const BLOCKS: Record<string, [string, Category]> = { item: ['compaction', 'conversation'], tool_addition: ['tools-added', 'forever'], tool_removal: ['tools-removed', 'forever'] }
export function notesOfBlock(b: Block): Note[] {
  if (b.type === 'text') return notesOf(String(b.text))
  const [kind, category] = BLOCKS[b.type] ?? [b.type, 'unrecognized']
  return [{ kind, category, text: '', keys: [kind] }]
}

// A note's first line, cut short: how an unrecognized one is shown.
export const firstLine = (n: Note) => n.text.trim().split('\n')[0].slice(0, 80)

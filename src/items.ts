// The logical view of a Messages API request that a policy is written against:
// its clock, the steps and turns completed, and its items, each placed in its
// step and turn.
//
// A step is an assistant message with the tool results that answer it, counted
// from 1; every step but the latest is completed. A turn runs from a prompt,
// counted from 1; every turn but the current one is completed.

export type Block = { type: string; [k: string]: unknown }
export type ApiMsg = { role: 'user' | 'assistant' | 'system'; content: string | Block[] }

export const blocks = (m: ApiMsg): Block[] => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content)

// User text that is not a prompt: Claude Code's command rows, its interrupt
// marker and the context it adds in <system-reminder> tags, and the
// environment Codex sends again when it changes, as when the date does. Each
// tag is its harness's own, so one list serves every harness.
const NOT_A_PROMPT = /^\s*(<command-name>|<local-command-|\[Request interrupted|<system-reminder>|<environment_context>)/

export function isPrompt(m: ApiMsg): boolean {
  if (m.role !== 'user') return false
  const c = blocks(m)
  if (c.some((b) => b.type === 'tool_result')) return false
  return c.some((b) => (b.type === 'text' ? !NOT_A_PROMPT.test(String(b.text)) : b.type === 'image' || b.type === 'document'))
}

// Each message's turn, counting prompts from 1; messages before the first
// prompt are turn 0. The completed turns are those before the last prompt's.
export function turnsOf(msgs: readonly ApiMsg[]): { turnOf: number[]; completed: number } {
  let t = 0
  const turnOf = msgs.map((m) => (isPrompt(m) ? ++t : t))
  return { turnOf, completed: Math.max(0, t - 1) }
}

// Each message's step, counting assistant messages from 1, so a tool result
// shares the step of the call it answers; messages before the first are step
// 0. Every step but the latest is completed.
export function stepsOf(msgs: readonly ApiMsg[]): { stepOf: number[]; completed: number } {
  let s = 0
  const stepOf = msgs.map((m) => (m.role === 'assistant' ? ++s : s))
  return { stepOf, completed: Math.max(0, s - 1) }
}

// The completed steps and turns.
export type Clock = { steps: number; turns: number }

export const clockOf = (msgs: readonly ApiMsg[]): Clock => ({ steps: stepsOf(msgs).completed, turns: turnsOf(msgs).completed })

// A clock held to the conversation's, so one rewound to an earlier point never
// has its latest step or current turn trimmed.
export function heldTo(c: Clock, msgs: readonly ApiMsg[]): Clock {
  const now = clockOf(msgs)
  return { steps: Math.min(c.steps, now.steps), turns: Math.min(c.turns, now.turns) }
}

// What a policy decides about:
// - tool: a tool call with its results, by the call's id, or a Read sent as
//   system text (READ);
// - skill: a Skill call with its result and the skill's body, which Claude Code
//   sends as a text block beside the result;
// - tool_search: a ToolSearch call with its result, which loads the tools it found
//   (their definitions go with it);
// - reasoning: an assistant message's thinking, by the message's index.
export type Kind = 'tool' | 'skill' | 'tool_search' | 'reasoning'
export type Item = { kind: Kind; id: string; step: number; turn: number }

export const isThinking = (b: Block) => b.type === 'thinking' || b.type === 'redacted_thinking'
export const isSkillBody = (b: Block) => b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('Base directory for this skill:')

// The heading of the message heavy compaction's records go in (summary.ts).
export const SUMMARY_HEAD = "[shaver] My record of this session's earlier turns, compacted in my context:"
export const isSummary = (b: Block) => b.type === 'text' && typeof b.text === 'string' && b.text.startsWith(SUMMARY_HEAD)

// The client's half of what the core needs to know about its tools (DESIGN.md,
// "Protocols"): which tools' calls are skills and tool loads; which inputs of
// which tools are long text a stub can stand in for; and which tool runs shell
// commands, whose here-documents can be stubbed.
// `promptHeadings` cut the system prompt into the sections `:shaver info`
// shows (log.ts, sections); with none it is one row, `system-prompt`.
export type Conventions = { kinds: Record<string, Kind>; stubbedInputs: Record<string, string[]>; shell: string; promptHeadings: Array<[string, string]> }

// Claude Code's: an edit's old and new text and a write's content are stubbed
// (trim.ts, stubbedInput).
export const CLAUDE_CODE: Conventions = {
  kinds: { Skill: 'skill', ToolSearch: 'tool_search' },
  stubbedInputs: { Edit: ['old_string', 'new_string'], Write: ['content'] },
  shell: 'Bash',
  promptHeadings: [],
}

// A Read that Claude Code sends as a system message's text, as when it
// re-attaches the files read before a compaction: the call's input, then the
// result, the file's numbered lines, then the blank lines before what follows.
// Each is a tool call, `read:<message>:<n>`, the message's nth.
export const READ = /^(Called the Read tool with the following input: [^\n]*\nResult of calling the Read tool:\n)((?:\d+\t[^\n]*\n?)*)(\n*)/gm
export const readsOf = (m: ApiMsg): number => blocks(m).reduce((n, b) => n + (b.type === 'text' ? String(b.text).match(READ)?.length ?? 0 : 0), 0)

export function itemsOf(msgs: readonly ApiMsg[], conv: Conventions = CLAUDE_CODE): Item[] {
  const { stepOf } = stepsOf(msgs)
  const { turnOf } = turnsOf(msgs)
  const out: Item[] = []
  msgs.forEach((m, i) => {
    const at = { step: stepOf[i], turn: turnOf[i] }
    // Before the first response, a system message is the base.
    if (m.role === 'system' && at.step > 0) for (let n = 0; n < readsOf(m); n++) out.push({ kind: 'tool', id: `read:${i}:${n}`, ...at })
    if (m.role !== 'assistant' || typeof m.content === 'string') return
    if (m.content.some(isThinking)) out.push({ kind: 'reasoning', id: String(i), ...at })
    for (const b of m.content) if (b.type === 'tool_use') out.push({ kind: conv.kinds[String(b.name)] ?? 'tool', id: String(b.id), ...at })
  })
  return out
}

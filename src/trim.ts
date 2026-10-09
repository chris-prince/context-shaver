// What the proxy trims from a Messages API request, and whether trimming more
// pays. Pure functions over the request body.
//
// A conversation is trimmed up to its frontier: the steps whose tool calls are
// trimmed, and the completed turns whose reasoning is. A step is an assistant
// message with the tool results that answer it, counted from 1; a turn runs
// from a prompt, counted from 1. The frontier only moves forward, so every
// request of the conversation sends the same trimmed prefix and the prompt
// cache keeps reading it. The latest step's tool calls and the current turn's
// reasoning are never touched.

export type Block = { type: string; [k: string]: unknown }
export type ApiMsg = { role: 'user' | 'assistant' | 'system'; content: string | Block[] }

export type Options = {
  stripToolCalls: boolean
  dropToolCalls: boolean
  stripReasoning: boolean
  stripToolCallsWaitSteps: number
  stripReasoningWaitTurns: number
}

export type Frontier = { toolSteps: number; reasoningTurns: number }
// Where a frontier ends in the messages: the index of the first message past
// it, for tool calls and for reasoning.
export type Ends = { tools: number; reasoning: number }

// What stands in for trimmed content, a tool result or a long input: how many
// UTF-8 bytes of it were cut.
export const stub = (n: number) => `[CULLED ${n} B FROM CTX]`
export const STUB = /^\[CULLED \d+ B FROM CTX\]$/
export const bytes = (v: unknown) => Buffer.byteLength(typeof v === 'string' ? v : (JSON.stringify(v) ?? ''))

// The inputs stubbed when longer than the stub: an edit's old and new text and
// a write's content. The path stays, and the file has the text. A Bash command
// keeps its lines but has each here-document's body stubbed (stubHeredocs);
// other inputs are kept whole.
const STUBBED_INPUTS: Record<string, string[]> = { Edit: ['old_string', 'new_string'], Write: ['content'] }

// A here-document operator, `<<WORD` or `<<-WORD`, its word bare or quoted, but
// not a here-string (`<<<`). Its body runs from the next line to the line that
// is the word alone (after leading tabs, with `<<-`).
const HEREDOC = /(?<!<)<<(-?)[ \t]*(['"]?)([\w.-]+)\2/g
// A here-document whose body is a stub.
const STUBBED_HEREDOC = /(?<!<)<<-?[ \t]*(['"]?)([\w.-]+)\1[^\n]*\n\[CULLED \d+ B FROM CTX\]\n\t*\2$/m

// A command with each here-document body longer than its stub stubbed. Several
// operators on a line take their bodies in order; an unterminated one, or a
// `<<` that is no operator (inside a quoted string), finds no end line and is
// left alone.
export function stubHeredocs(command: string): string {
  const lines = command.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i++]
    out.push(line)
    for (const [, dash, , word] of line.matchAll(HEREDOC)) {
      const end = lines.findIndex((l, j) => j >= i && (dash ? l.replace(/^\t+/, '') : l) === word)
      if (end < 0) break
      const body = lines.slice(i, end).join('\n')
      const n = bytes(body)
      out.push(...(STUB.test(body) || n <= stub(n).length ? lines.slice(i, end) : [stub(n)]), lines[end])
      i = end + 1
    }
  }
  return out.join('\n')
}

// Whether an input value carries a stub: is one, or has a here-document that is.
export const isStubbed = (v: unknown) => typeof v === 'string' && (STUB.test(v) || STUBBED_HEREDOC.test(v))

// User text that is not a prompt: command rows, the interrupt marker, and
// context Claude Code adds in <system-reminder> tags.
const NOT_A_PROMPT = /^\s*(<command-name>|<local-command-|\[Request interrupted|<system-reminder>)/

const blocks = (m: ApiMsg): Block[] => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content)

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

// Where the frontier ends in the messages. Behind it, content is trimmed as far
// as it will be, so what is still whole there stays.
export function frontierEnd(msgs: readonly ApiMsg[], f: Frontier): Ends {
  const end = (of: number[], completed: number, n: number) => {
    const k = Math.min(n, completed)
    return k ? of.findIndex((t) => t > k) : 0
  }
  const steps = stepsOf(msgs)
  const turns = turnsOf(msgs)
  return { tools: end(steps.stepOf, steps.completed, f.toolSteps), reasoning: end(turns.turnOf, turns.completed, f.reasoningTurns) }
}

// Where the frontier goes if the conversation is trimmed now: every completed
// step or turn outside the waits, and never backwards.
export function candidate(msgs: readonly ApiMsg[], f: Frontier, o: Options): Frontier {
  const steps = stepsOf(msgs).completed
  const turns = turnsOf(msgs).completed
  return {
    toolSteps: o.stripToolCalls ? Math.max(f.toolSteps, steps - o.stripToolCallsWaitSteps) : f.toolSteps,
    reasoningTurns: o.stripReasoning ? Math.max(f.reasoningTurns, turns - o.stripReasoningWaitTurns) : f.reasoningTurns,
  }
}

export type Stripped = {
  msgs: ApiMsg[]
  results: number // tool results stubbed
  inputs: number // tool calls whose input is stubbed
  thinking: number // thinking blocks dropped
  dropped: number // tool calls dropped with their results
  origin: number[] // each message's index in the request as it came
}

function stubbedInput(name: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
  const long = (STUBBED_INPUTS[name] ?? []).filter((k) => {
    const v = input[k]
    return typeof v === 'string' && !STUB.test(v) && bytes(v) > stub(bytes(v)).length
  })
  const out = { ...input, ...Object.fromEntries(long.map((k) => [k, stub(bytes(input[k]))])) }
  if (name === 'Bash' && typeof input.command === 'string') {
    const command = stubHeredocs(input.command)
    if (command !== input.command) return { ...out, command }
  }
  return long.length ? out : undefined
}

// The messages trimmed up to the frontier. The frontier is held to the
// completed steps and turns, so a conversation rewound to an earlier point never
// has its latest step or current turn trimmed. Blocks keep every other field,
// cache_control included.
//
// With `drop`, tool calls behind the frontier are removed with their results
// instead of stubbed. A message left empty is removed; the API joins the
// neighbours that leaves in the same role. One left with thinking alone stays.
// A pair whose results are followed by a system message is kept, since a
// system message must follow a user one.
export function strip(msgs: readonly ApiMsg[], f: Frontier, drop = false): Stripped {
  const { stepOf, completed: steps } = stepsOf(msgs)
  const { turnOf, completed: turns } = turnsOf(msgs)
  const tools = Math.min(f.toolSteps, steps)
  const reasoning = Math.min(f.reasoningTurns, turns)
  const out: Stripped = { msgs: [], results: 0, inputs: 0, thinking: 0, dropped: 0, origin: [] }
  const droppedIds = new Set<unknown>()
  const keptIds = new Set<unknown>()
  msgs.forEach((m, i) => {
    if (m.role === 'user' && typeof m.content !== 'string' && msgs[i + 1]?.role === 'system')
      for (const b of m.content) if (b.type === 'tool_result') keptIds.add(b.tool_use_id)
  })
  msgs.forEach((m, i) => {
    const t = turnOf[i] ?? 0
    const s = stepOf[i] ?? 0
    const push = (m: ApiMsg) => (out.msgs.push(m), out.origin.push(i))
    if (typeof m.content === 'string' || m.role === 'system') return push(m)
    let content = m.content
    if (m.role === 'assistant' && t && t <= reasoning) {
      const kept = content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')
      // A message of thinking alone stays: an empty one is refused.
      if (kept.length && kept.length < content.length) {
        out.thinking += content.length - kept.length
        content = kept
      }
    }
    if (drop && s && s <= tools) {
      for (const b of content) if (b.type === 'tool_use' && !keptIds.has(b.id)) droppedIds.add(b.id)
      const kept = content.filter((b) => !droppedIds.has(b.type === 'tool_use' ? b.id : b.type === 'tool_result' ? b.tool_use_id : undefined))
      if (m.role === 'assistant') out.dropped += content.length - kept.length
      if (!kept.length) return
      content = kept
    } else if (m.role === 'assistant' && s && s <= tools) {
      content = content.map((b) => {
        if (b.type !== 'tool_use' || !b.input || typeof b.input !== 'object') return b
        const input = stubbedInput(String(b.name), b.input as Record<string, unknown>)
        if (!input) return b
        out.inputs++
        return { ...b, input }
      })
    } else if (m.role === 'user' && s && s <= tools) {
      content = content.map((b) => {
        const n = bytes(b.content ?? '')
        if (b.type !== 'tool_result' || n <= stub(n).length || STUB.test(String(b.content))) return b
        out.results++
        return { ...b, content: stub(n) }
      })
    }
    push(content === m.content ? m : { ...m, content })
  })
  return out
}

// --- The policy. ---

// Claude Code writes 1-hour cache entries: 2x input against 0.1x for a read, so
// a written character costs M + 1 = 20 reads. K is the warm requests expected
// to read what a trim saved before the cache next goes cold: 40 at an hour's
// TTL (mini-context's notes.md, "Light compaction").
export const M = 19
export const K = 40

export type Decision = {
  advanced: boolean
  cold: boolean
  savedChars: number // what this and every later request no longer sends
  rewriteChars: number // what keeping would read from the cache that advancing sends again
  extraChars: number // this request's extra cost, in cache-read characters
}

// Prices advancing against keeping, on this request. Keeping reads the whole
// history; advancing reads up to the first changed message and writes the
// rest, less what it saved. With R the characters from the first change on and
// S the characters saved, the extra cost is
//   (M + 1)(R - S) - R = M R - (M + 1) S
// and advancing pays when it is at most K S. On a cold cache both requests
// write everything, so advancing always pays: its extra is -(M + 1) S.
export function decide(before: readonly ApiMsg[], after: readonly ApiMsg[], cold: boolean): Decision {
  const a = before.map((m) => JSON.stringify(m).length)
  const b = after.map((m) => JSON.stringify(m).length)
  const first = a.findIndex((n, i) => JSON.stringify(before[i]) !== JSON.stringify(after[i]))
  const sum = (xs: number[]) => xs.reduce((x, y) => x + y, 0)
  const savedChars = sum(a) - sum(b)
  const rewriteChars = first < 0 ? 0 : sum(a.slice(first))
  if (first < 0 || savedChars <= 0) return { advanced: false, cold, savedChars: 0, rewriteChars: 0, extraChars: 0 }
  const extraChars = cold ? -(M + 1) * savedChars : M * rewriteChars - (M + 1) * savedChars
  return { advanced: extraChars <= K * savedChars, cold, savedChars, rewriteChars, extraChars }
}

// What the proxy trims from a Messages API request, and whether trimming more
// pays. Pure functions over the request body.
//
// A conversation is trimmed up to its frontier: the completed turns, counted
// by prompt from 1, whose tool calls and whose reasoning are trimmed. The
// frontier only moves forward, so every request of the conversation sends the
// same trimmed prefix and the prompt cache keeps reading it. The current turn
// (from the last prompt on) is never touched.

export type Block = { type: string; [k: string]: unknown }
export type ApiMsg = { role: 'user' | 'assistant' | 'system'; content: string | Block[] }

export type Options = {
  stripToolCalls: boolean
  stripReasoning: boolean
  stripToolCallsWaitTurns: number
  stripReasoningWaitTurns: number
}

export type Frontier = { tools: number; reasoning: number }

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

// Where the frontier ends in the messages, for tool calls and for reasoning:
// the index of the first message past it. Behind it, content is trimmed as far
// as it will be, so what is still whole there stays.
export function frontierEnd(msgs: readonly ApiMsg[], f: Frontier): Frontier {
  const { turnOf, completed } = turnsOf(msgs)
  const end = (n: number) => {
    const k = Math.min(n, completed)
    return k ? turnOf.findIndex((t) => t > k) : 0
  }
  return { tools: end(f.tools), reasoning: end(f.reasoning) }
}

// Where the frontier goes if the conversation is trimmed now: every completed
// turn outside the waits, and never backwards.
export function candidate(msgs: readonly ApiMsg[], f: Frontier, o: Options): Frontier {
  const { completed } = turnsOf(msgs)
  return {
    tools: o.stripToolCalls ? Math.max(f.tools, completed - o.stripToolCallsWaitTurns) : f.tools,
    reasoning: o.stripReasoning ? Math.max(f.reasoning, completed - o.stripReasoningWaitTurns) : f.reasoning,
  }
}

export type Stripped = {
  msgs: ApiMsg[]
  results: number // tool results stubbed
  inputs: number // tool calls whose input is stubbed
  thinking: number // thinking blocks dropped
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
// completed turns, so a conversation rewound to an earlier turn never has its
// current turn trimmed. Blocks keep every other field, cache_control included.
export function strip(msgs: readonly ApiMsg[], f: Frontier): Stripped {
  const { turnOf, completed } = turnsOf(msgs)
  const tools = Math.min(f.tools, completed)
  const reasoning = Math.min(f.reasoning, completed)
  const out: Stripped = { msgs: [], results: 0, inputs: 0, thinking: 0 }
  msgs.forEach((m, i) => {
    const t = turnOf[i] ?? 0
    if (t === 0 || typeof m.content === 'string' || m.role === 'system') return out.msgs.push(m)
    let content = m.content
    if (m.role === 'assistant' && t <= reasoning) {
      const kept = content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')
      // A message of thinking alone stays: an empty one is refused.
      if (kept.length && kept.length < content.length) {
        out.thinking += content.length - kept.length
        content = kept
      }
    }
    if (m.role === 'assistant' && t <= tools) {
      content = content.map((b) => {
        if (b.type !== 'tool_use' || !b.input || typeof b.input !== 'object') return b
        const input = stubbedInput(String(b.name), b.input as Record<string, unknown>)
        if (!input) return b
        out.inputs++
        return { ...b, input }
      })
    }
    if (m.role === 'user' && t <= tools) {
      content = content.map((b) => {
        const n = bytes(b.content ?? '')
        if (b.type !== 'tool_result' || n <= stub(n).length || STUB.test(String(b.content))) return b
        out.results++
        return { ...b, content: stub(n) }
      })
    }
    out.msgs.push(content === m.content ? m : { ...m, content })
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

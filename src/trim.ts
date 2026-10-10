// What the proxy sends in place of a Messages API request, and whether
// trimming more pays. Pure functions over the request body.
//
// A conversation is trimmed as its policy says (policy.ts) at its applied
// clock: the completed steps and turns the policy was last applied at. The
// clock only moves forward, so every request of the conversation sends the same
// trimmed prefix and the prompt cache keeps reading it; decide says when moving
// it pays. The latest step and the current turn are never touched.

import { heldTo, isSkillBody, isThinking, itemsOf, stepsOf, turnsOf, type ApiMsg, type Block, type Clock, type Kind } from './items.ts'
import { hash } from './log.ts'
import { treatment, type Action, type Policy } from './policy.ts'

// Where trimming ends in the messages: the index of the first message past
// the steps (or turns) the furthest-reaching rule covers, for tool calls and
// for reasoning.
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

export type Applied = {
  msgs: ApiMsg[]
  origin: number[] // each message's index in the request as it came
  treated: Map<string, { kind: Kind; action: Action }> // the items it changed, and how
}

// The messages with each item given what is due to it at the clock. Blocks keep
// every other field, cache_control included.
//
// - A stubbed tool call has its result and long inputs stubbed.
// - A dropped tool call goes with its results; a dropped skill also takes the
//   skill's body beside its result. A pair whose results a system message
//   follows is kept, since a system message must follow a user one: it gets
//   what else is due to it, a stub.
// - Dropped reasoning is the message's thinking, unless that would leave it
//   empty: an empty message is refused. One left empty by dropped calls is
//   removed; the API joins the neighbours that leaves in the same role.
export function apply(msgs: readonly ApiMsg[], policy: Policy, clock: Clock): Applied {
  const c = heldTo(clock, msgs)
  const undroppable = new Set<unknown>()
  msgs.forEach((m, i) => {
    if (m.role === 'user' && typeof m.content !== 'string' && msgs[i + 1]?.role === 'system')
      for (const b of m.content) if (b.type === 'tool_result') undroppable.add(b.tool_use_id)
  })
  const items = new Map(itemsOf(msgs).map((it) => [it.id, it]))
  const due = new Map<unknown, Action>()
  for (const it of items.values()) {
    const rules = policy[it.kind]
    let a = treatment(rules, it, c)
    if (a === 'drop' && undroppable.has(it.id)) a = treatment(rules?.filter((r) => r.action !== 'drop'), it, c)
    if (a) due.set(it.id, a)
  }
  const out: Applied = { msgs: [], origin: [], treated: new Map() }
  const mark = (id: unknown, action: Action) => out.treated.set(String(id), { kind: items.get(String(id))!.kind, action })
  const idOf = (b: Block) => (b.type === 'tool_use' ? b.id : b.type === 'tool_result' ? b.tool_use_id : undefined)
  msgs.forEach((m, i) => {
    const push = (m: ApiMsg) => (out.msgs.push(m), out.origin.push(i))
    if (typeof m.content === 'string' || m.role === 'system') return push(m)
    let content = m.content
    if (m.role === 'assistant' && due.get(String(i)) === 'drop') {
      const kept = content.filter((b) => !isThinking(b))
      if (kept.length && kept.length < content.length) {
        mark(i, 'drop')
        content = kept
      }
    }
    const skillDropped = content.some((b) => b.type === 'tool_result' && items.get(String(b.tool_use_id))?.kind === 'skill' && due.get(b.tool_use_id) === 'drop')
    content = content.filter((b) => {
      const gone = due.get(idOf(b)) === 'drop' || (skillDropped && isSkillBody(b))
      if (gone && b.type === 'tool_use') mark(b.id, 'drop')
      return !gone
    })
    content = content.map((b) => {
      if (due.get(idOf(b)) !== 'stub') return b
      if (b.type === 'tool_use' && b.input && typeof b.input === 'object') {
        const input = stubbedInput(String(b.name), b.input as Record<string, unknown>)
        return input ? (mark(b.id, 'stub'), { ...b, input }) : b
      }
      const n = bytes(b.content ?? '')
      if (b.type !== 'tool_result' || n <= stub(n).length || STUB.test(String(b.content))) return b
      mark(b.tool_use_id, 'stub')
      return { ...b, content: stub(n) }
    })
    if (!content.length) return
    push(content === m.content ? m : { ...m, content })
  })
  return out
}

// The items whose treatment differs between two applications, counted by
// kind and what they now get, as `tool:stub`.
export function transitions(before: Applied, after: Applied): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [id, t] of after.treated)
    if (before.treated.get(id)?.action !== t.action) out[`${t.kind}:${t.action}`] = (out[`${t.kind}:${t.action}`] ?? 0) + 1
  return out
}

// Where trimming ends at a clock. Behind it, content has had at least its
// first treatment.
export function trimmedEnd(msgs: readonly ApiMsg[], policy: Policy, clock: Clock): Ends {
  const c = heldTo(clock, msgs)
  const { stepOf } = stepsOf(msgs)
  const { turnOf } = turnsOf(msgs)
  const end = (rules: Policy[Kind]) =>
    Math.max(
      0,
      ...(rules ?? []).map((r) => {
        const [of, n] = r.on === 'step' ? [stepOf, c.steps - r.wait] : [turnOf, c.turns - r.wait]
        return n > 0 ? of.findIndex((x) => x > n) : 0
      }),
    )
  return { tools: end(policy.tool), reasoning: end(policy.reasoning) }
}

// --- When to move the applied clock. ---

// Claude Code writes 1-hour cache entries at 2x input. A read costs 0.1x on
// most models, so a written character costs M + 1 = 20 reads; the models in
// READ_COST read for less, and a write costs them more reads. K is the warm
// requests expected to read what a trim saved before the cache next goes cold:
// 40 at an hour's TTL (mini-context's notes.md, "Light compaction").
const READ_COST: Record<string, number> = { 'claude-opus-5-5': 0.05, 'claude-fable-5-1': 0.025, 'claude-mythos-5-1': 0.025 }
export const writeCost = (model: string) => 2 / (READ_COST[model] ?? 0.1) - 1 // M
export const K = 40

export type Decision = {
  advanced: boolean
  cold: boolean
  savedChars: number // what this and every later request no longer sends, sized by sizeOf
  rewriteChars: number // what keeping would read from the cache that advancing sends again, sized by sizeOf
  extraChars: number // this request's extra cost, in cache-read characters
}

// What a thinking block bills, which its length does not show: Claude Code
// sends it back with its thinking empty and the reasoning encrypted in its
// signature, and the API bills it as the reasoning, about the output tokens it
// took to generate. `thinking` holds those, by the signature's hash, for the
// blocks the proxy saw generated; any other is put at SIGNATURE_TOKENS a
// signature character. A message's size is its characters with each thinking
// block counted as its tokens' worth of text, at TEXT_TOKENS a character
// (both measured; notes.md, "Reasoning drops").
export const TEXT_TOKENS = 0.39
export const SIGNATURE_TOKENS = 0.13
export type Thinking = ReadonlyMap<string, number>

export function sizeOf(m: ApiMsg, thinking: Thinking): number {
  let n = JSON.stringify(m).length
  if (typeof m.content !== 'string')
    for (const b of m.content)
      if (b.type === 'thinking' && typeof b.signature === 'string') {
        const tokens = thinking.get(hash(b.signature)) ?? SIGNATURE_TOKENS * b.signature.length
        n += Math.round(tokens / TEXT_TOKENS) - b.signature.length
      }
  return n
}

// Prices advancing against keeping, on this request. Keeping reads the whole
// history; advancing reads up to the first changed message and writes the
// rest, less what it saved. With R the characters from the first change on and
// S the characters saved, both sized by sizeOf, the extra cost is
//   (M + 1)(R - S) - R = M R - (M + 1) S
// and advancing pays when it is at most K S. On a cold cache both requests
// write everything, so advancing always pays: its extra is -(M + 1) S.
export function decide(before: readonly ApiMsg[], after: readonly ApiMsg[], cold: boolean, model: string, thinking: Thinking = new Map()): Decision {
  const M = writeCost(model)
  const a = before.map((m) => sizeOf(m, thinking))
  const b = after.map((m) => sizeOf(m, thinking))
  const first = before.findIndex((m, i) => JSON.stringify(m) !== JSON.stringify(after[i]))
  const sum = (xs: number[]) => xs.reduce((x, y) => x + y, 0)
  const savedChars = sum(a) - sum(b)
  const rewriteChars = first < 0 ? 0 : sum(a.slice(first))
  if (first < 0 || savedChars <= 0) return { advanced: false, cold, savedChars: 0, rewriteChars: 0, extraChars: 0 }
  const extraChars = cold ? -(M + 1) * savedChars : M * rewriteChars - (M + 1) * savedChars
  return { advanced: extraChars <= K * savedChars, cold, savedChars, rewriteChars, extraChars }
}

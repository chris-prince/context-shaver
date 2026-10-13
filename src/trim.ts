// What the proxy sends in place of a Messages API request, and whether
// trimming more pays. Pure functions over the request body.
//
// A conversation is trimmed as its policy says (policy.ts) at its applied
// clock: the completed steps and turns the policy was last applied at. The
// clock only moves forward, so every request of the conversation sends the same
// trimmed prefix and the prompt cache keeps reading it; decide says when moving
// it pays. The latest step and the current turn are never touched.

import { blocks, heldTo, isSkillBody, isThinking, itemsOf, READ, readsOf, stepsOf, turnsOf, type ApiMsg, type Block, type Clock, type Item, type Kind } from './items.ts'
import { hash } from './log.ts'
import { treatment, type Action, type Policy } from './policy.ts'

// Where trimming ends in the messages: the index of the first message past
// the steps (or turns) the furthest-reaching rule covers, for tool calls and
// for reasoning.
type Ends = { tools: number; reasoning: number }

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
//   skill's body beside its result. The drops are made together, then the
//   messages checked against where the API takes a system message (README,
//   "What it trims"). A pair whose drop leaves one out of place, the pair just
//   before it or just after, is kept and stubbed instead.
//   So a drop is only refused for what the drops around it actually leave.
// - Dropped reasoning is the message's thinking, unless that would leave it
//   empty: an empty message is refused. One left empty by dropped calls is
//   removed; the API joins the neighbours that leaves in the same role.
export function apply(msgs: readonly ApiMsg[], policy: Policy, clock: Clock): Applied {
  const c = heldTo(clock, msgs)
  const items = new Map(itemsOf(msgs).map((it) => [it.id, it]))
  const undroppable = new Set<unknown>()
  for (;;) {
    const out = applyKeeping(msgs, policy, c, items, undroppable)
    const n = undroppable.size
    out.msgs.forEach((m, j) => {
      if (m.role !== 'system') return
      const i = out.origin[j]
      if (!['user', 'system'].includes(out.msgs[j - 1]?.role ?? 'user')) pairsOf(msgs[i - 1], undroppable)
      if (!['assistant', 'system', undefined].includes(out.msgs[j + 1]?.role)) pairsOf(msgs[i + 1], undroppable)
    })
    if (undroppable.size === n) return out
  }
}

// Adds the tool calls a message makes or answers.
function pairsOf(m: ApiMsg | undefined, to: Set<unknown>) {
  if (m && typeof m.content !== 'string')
    for (const b of m.content) if (b.type === 'tool_use') to.add(b.id)
    else if (b.type === 'tool_result') to.add(b.tool_use_id)
}

function applyKeeping(msgs: readonly ApiMsg[], policy: Policy, c: Clock, items: Map<string, Item>, undroppable: ReadonlySet<unknown>): Applied {
  const due = new Map<unknown, Action>()
  for (const it of items.values()) {
    const rules = policy[it.kind]
    let a = treatment(rules, it, c)
    // A stub leaves every message where it was, so it is allowed where the drop
    // was refused.
    if (a === 'drop' && undroppable.has(it.id)) a = 'stub'
    if (a) due.set(it.id, a)
  }
  const out: Applied = { msgs: [], origin: [], treated: new Map() }
  const mark = (id: unknown, action: Action) => out.treated.set(String(id), { kind: items.get(String(id))!.kind, action })
  const idOf = (b: Block) => (b.type === 'tool_use' ? b.id : b.type === 'tool_result' ? b.tool_use_id : undefined)
  msgs.forEach((m, i) => {
    const push = (m: ApiMsg) => (out.msgs.push(m), out.origin.push(i))
    if (m.role === 'system') {
      const r = readsOf(m) ? withReads(m, i, due, mark) : m
      return r && push(r)
    }
    if (typeof m.content === 'string') return push(m)
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

// A system message with each Read in its text given what is due to it: a
// stubbed one has its lines stubbed, a dropped one goes with the blank lines
// after it. A text left blank goes, and the message when nothing is left; a
// system message goes wherever one was allowed, so that needs no check.
function withReads(m: ApiMsg, i: number, due: ReadonlyMap<unknown, Action>, mark: (id: unknown, a: Action) => void): ApiMsg | undefined {
  let n = 0
  const bs = blocks(m)
  const content = bs.flatMap((b) => {
    if (b.type !== 'text') return [b]
    const text = String(b.text).replace(READ, (read, head: string, lines: string, gap: string) => {
      const id = `read:${i}:${n++}`
      const a = due.get(id)
      if (a === 'drop') return mark(id, a), ''
      const k = bytes(lines)
      if (a !== 'stub' || k <= stub(k).length) return read
      mark(id, a)
      return `${head}${stub(k)}\n${gap}`
    })
    return text === b.text ? [b] : text.trim() ? [{ ...b, text }] : []
  })
  if (!content.length) return undefined
  if (content.length === bs.length && content.every((b, j) => b === bs[j])) return m
  return typeof m.content === 'string' ? { ...m, content: String(content[0].text) } : { ...m, content }
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
// 40 at an hour's TTL (ctx-shaver's local/notes.md, "Light compaction").
const READ_COST: Record<string, number> = { 'claude-opus-5-5': 0.05, 'claude-fable-5-1': 0.025, 'claude-mythos-5-1': 0.025 }
export const writeCost = (model: string) => 2 / (READ_COST[model] ?? 0.1) - 1 // M
export const K = 40

// What a thinking block bills, which its length does not show: Claude Code
// sends it back with its thinking empty and the reasoning encrypted in its
// signature, and the API bills it as the reasoning, about the output tokens it
// took to generate. `thinking` holds those, by the signature's hash, for the
// blocks the proxy saw generated; any other is put at SIGNATURE_TOKENS a
// signature character. A block's size is its characters with a thinking block
// counted as its tokens' worth of text, at TEXT_TOKENS a character (both
// measured; local/notes.md, "Reasoning drops").
export const TEXT_TOKENS = 0.39
const SIGNATURE_TOKENS = 0.13
export type Thinking = ReadonlyMap<string, number>

export function sizeOf(b: Block, thinking: Thinking): number {
  const n = JSON.stringify(b).length
  if (b.type !== 'thinking' || typeof b.signature !== 'string') return n
  const tokens = thinking.get(hash(b.signature)) ?? SIGNATURE_TOKENS * b.signature.length
  return n + Math.round(tokens / TEXT_TOKENS) - b.signature.length
}

// The prompt cache keeps an entry for each prefix a request ended a breakpoint
// (a block with cache_control) at, for the TTL from when it was last written or
// read. A request reads the longest entry it finds by looking back from each
// of its breakpoints over at most LOOKBACK positions (a block, or a run of a
// message's tool_use or tool_result blocks), and writes from there to its
// last breakpoint; what follows that is plain input. Only the messages are
// tracked: a conversation's tools and system go in the seed, so changing them,
// or the model, finds no entry.
export const LOOKBACK = 20

// Each block of the messages: the hash of the prefix through it, which names
// its entry (cache_control left out, since it moves from request to request
// over the same prefix), its size, whether it is a breakpoint, and whether it
// continues the previous block's position, in a run of tool calls or results.
export type Position = { prefix: string; size: number; breakpoint: boolean; joined: boolean }

const uncontrolled = (k: string, v: unknown) => (k === 'cache_control' ? undefined : v)
export const seedOf = (model: string, tools: unknown, system: unknown) => hash(JSON.stringify([model, tools, system], uncontrolled))

export function positionsOf(msgs: readonly ApiMsg[], seed: string, thinking: Thinking): Position[] {
  let prefix = seed
  return msgs.flatMap((m) =>
    blocks(m).map((b, i, bs) => {
      prefix = hash(prefix + m.role + JSON.stringify(b, uncontrolled))
      const joined = (b.type === 'tool_use' || b.type === 'tool_result') && bs[i - 1]?.type === b.type
      return { prefix, size: sizeOf(b, thinking), breakpoint: b.cache_control !== undefined, joined }
    }),
  )
}

// The position the request reads through, given the live entries; -1 for none.
export function readThrough(pos: readonly Position[], live: ReadonlySet<string>): number {
  let r = -1
  pos.forEach((p, b) => {
    if (!p.breakpoint) return
    for (let j = b, n = 0; j > r && n <= LOOKBACK; n += pos[j--].joined ? 0 : 1)
      if (live.has(pos[j].prefix)) {
        r = j
        break
      }
  })
  return r
}

// What a request's messages cost, in cache reads: a written character costs
// M + 1 reads, and plain input half that (a 1-hour write is 2x input).
function costOf(pos: readonly Position[], r: number, M: number): number {
  const last = pos.findLastIndex((p) => p.breakpoint)
  return pos.reduce((n, p, i) => n + p.size * (i <= r ? 1 : i <= last ? M + 1 : (M + 1) / 2), 0)
}

export type Decision = {
  advanced: boolean
  cold: boolean // keeping reads nothing from the cache
  savedChars: number // what this and every later request no longer sends, sized by sizeOf
  rewriteChars: number // what keeping would read from the cache that advancing does not
  extraChars: number // this request's extra cost, in cache-read characters
}

// Prices advancing against keeping, on this request: each reads the longest
// live entry it finds and writes the rest (readThrough, costOf). Advancing
// pays when its extra cost is at most K S, with S the characters it saves
// every later request. Advancing reads no further than the first change, and
// less when no entry ends there or none is in reach of its breakpoints. With
// nothing cached both write everything, so advancing always pays. A request
// with no breakpoints in its messages (a side request branched off the
// conversation) reads nothing of them whatever is cached, so says nothing of
// the cache: it never advances.
export function decide(before: readonly ApiMsg[], after: readonly ApiMsg[], live: ReadonlySet<string>, seed: string, model: string, thinking: Thinking = new Map()): Decision {
  const M = writeCost(model)
  const a = positionsOf(before, seed, thinking)
  const b = positionsOf(after, seed, thinking)
  const sum = (ps: Position[]) => ps.reduce((n, p) => n + p.size, 0)
  const savedChars = sum(a) - sum(b)
  const [ra, rb] = [readThrough(a, live), readThrough(b, live)]
  const cold = ra < 0
  if (a.at(-1)?.prefix === b.at(-1)?.prefix || savedChars <= 0 || !a.some((p) => p.breakpoint)) return { advanced: false, cold, savedChars: 0, rewriteChars: 0, extraChars: 0 }
  const rewriteChars = sum(a.slice(0, ra + 1)) - sum(b.slice(0, rb + 1))
  const extraChars = costOf(b, rb, M) - costOf(a, ra, M)
  return { advanced: extraChars <= K * savedChars, cold, savedChars, rewriteChars, extraChars }
}

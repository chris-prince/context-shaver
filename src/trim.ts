// What the proxy sends in place of a Messages API request, and whether
// trimming more pays. Pure functions over the request body.
//
// A conversation is trimmed as its policy says (policy.ts) at its applied
// clock: the completed requests and turns the policy was last applied at. The
// clock only moves forward, so every request of the conversation sends the same
// trimmed prefix and the prompt cache keeps reading it; decide says when moving
// it pays. The latest request and the current turn are never touched.

import type { Model } from './models.ts'
import { blocks, CLAUDE_CODE, heldTo, isSkillBody, isThinking, itemsOf, READ, readsOf, requestsOf, turnsOf, type ApiMsg, type Block, type Clock, type Conventions, type Item, type Kind } from './items.ts'
import { hash } from './log.ts'
import { afterOf, treatment, type Action, type PartRules } from './policy.ts'

// Where trimming ends in the messages: the index of the first message past
// the requests (or turns) the furthest-reaching rule covers, for tool calls and
// for reasoning.
type Ends = { tools: number; reasoning: number }

// What stands in for trimmed content, a tool result or a long input: how many
// UTF-8 bytes of it were cut.
export const stub = (n: number) => `[CULLED ${n} B FROM CTX]`
export const STUB = /^\[CULLED \d+ B FROM CTX\]$/
export const bytes = (v: unknown) => Buffer.byteLength(typeof v === 'string' ? v : (JSON.stringify(v) ?? ''))

// The inputs stubbed when longer than the stub are the client's
// (Conventions.stubbedInputs): an edit's old and new text and a write's
// content. The path stays, and the file has the text. A shell command keeps its
// lines but has each here-document's body stubbed (stubHeredocs); other inputs
// are kept whole.

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

function stubbedInput(name: string, input: Record<string, unknown>, conv: Conventions): Record<string, unknown> | undefined {
  const long = (conv.stubbedInputs[name] ?? []).filter((k) => {
    const v = input[k]
    return typeof v === 'string' && !STUB.test(v) && bytes(v) > stub(bytes(v)).length
  })
  const out = { ...input, ...Object.fromEntries(long.map((k) => [k, stub(bytes(input[k]))])) }
  if (name === conv.shell && typeof input.command === 'string') {
    const command = stubHeredocs(input.command)
    if (command !== input.command) return { ...out, command }
  }
  return long.length ? out : undefined
}

// A skill's body with all but its first line, the skill's base directory,
// stubbed: the model can still read the skill's files, or invoke it again for
// the body.
function skillStub(text: string): string {
  const i = text.indexOf('\n')
  const rest = i < 0 ? '' : text.slice(i + 1)
  const n = bytes(rest)
  return STUB.test(rest) || n <= stub(n).length ? text : `${text.slice(0, i)}\n${stub(n)}`
}

export type Applied = {
  msgs: ApiMsg[]
  origin: number[] // each message's index in the request as it came
  treated: Map<string, { kind: Kind; action: Action }> // the items it changed, and how
}

// The messages with each item given what is due to it at the clock. Blocks keep
// every other field, cache_control included.
//
// - A stubbed tool call has its result and long inputs stubbed; a stubbed
//   skill has its body stubbed (skillStub).
// - A dropped tool call goes with its results; a dropped skill also takes the
//   skill's body beside its result. The drops are made together, then the
//   messages checked against where the API takes a system message (README,
//   "What it trims"). A pair whose drop leaves one out of place, the pair just
//   before it or just after, is kept and stubbed instead.
//   So a drop is only refused for what the drops around it actually leave.
// - Dropped reasoning is the message's thinking, unless that would leave it
//   empty: an empty message is refused. One left empty by dropped calls is
//   removed; the API joins the neighbours that leaves in the same role.
export function apply(msgs: readonly ApiMsg[], policy: PartRules, clock: Clock, conv: Conventions = CLAUDE_CODE): Applied {
  return applyAt(msgs, policy, heldTo(clock, msgs), conv)
}

// The messages trimmed as far as the policy ever takes them: every rule due.
export const fullyTrimmed = (msgs: readonly ApiMsg[], policy: PartRules, conv: Conventions = CLAUDE_CODE) => applyAt(msgs, policy, { requests: Infinity, turns: Infinity }, conv)

function applyAt(msgs: readonly ApiMsg[], policy: PartRules, c: Clock, conv: Conventions): Applied {
  const items = new Map(itemsOf(msgs, conv).map((it) => [it.id, it]))
  const undroppable = new Set<unknown>()
  for (;;) {
    const out = applyKeeping(msgs, policy, c, items, undroppable, conv)
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

function applyKeeping(msgs: readonly ApiMsg[], policy: PartRules, c: Clock, items: Map<string, Item>, undroppable: ReadonlySet<unknown>, conv: Conventions): Applied {
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
    const skill = content.find((b) => b.type === 'tool_result' && items.get(String(b.tool_use_id))?.kind === 'skill')?.tool_use_id
    const skillDue = skill === undefined ? undefined : due.get(skill)
    content = content.filter((b) => {
      const gone = due.get(idOf(b)) === 'drop' || (skillDue === 'drop' && isSkillBody(b))
      if (gone && b.type === 'tool_use') mark(b.id, 'drop')
      return !gone
    })
    content = content.map((b) => {
      if (skillDue === 'stub' && isSkillBody(b)) {
        const text = skillStub(String(b.text))
        return text === b.text ? b : (mark(skill, 'stub'), { ...b, text })
      }
      // A skill's result only names it; its body is what a stub cuts.
      if (due.get(idOf(b)) !== 'stub' || items.get(String(idOf(b)))?.kind === 'skill') return b
      if (b.type === 'tool_use' && b.input && typeof b.input === 'object') {
        const input = stubbedInput(String(b.name), b.input as Record<string, unknown>, conv)
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
export function trimmedEnd(msgs: readonly ApiMsg[], policy: PartRules, clock: Clock): Ends {
  const c = heldTo(clock, msgs)
  const { requestOf } = requestsOf(msgs)
  const { turnOf } = turnsOf(msgs)
  const end = (rules: PartRules[Kind]) =>
    Math.max(
      0,
      ...(rules ?? []).map((r) => {
        const { on, wait } = afterOf(r)!
        const [of, n] = on === 'request' ? [requestOf, c.requests - wait] : [turnOf, c.turns - wait]
        return n > 0 ? of.findIndex((x) => x > n) : 0
      }),
    )
  return { tools: end(policy.tool), reasoning: end(policy.reasoning) }
}

// --- When to move the applied clock. ---

// Claude Code writes 1-hour cache entries at 2x input. A read costs 0.1x on
// most models, so a written character costs M + 1 = 20 reads; the models
// priced to read for less (models.ts) pay more reads for a write. K was
// the warm requests expected to read what a trim saved before the cache next
// goes cold: 40 at an hour's TTL (context-shaver's local/notes.md, "Light
// compaction"). The proxy now asks the model (models.ts, horizon); K stays
// the horizon tests and replays of old logs assume. Automatic caching writes
// at the input price, so a written character costs half the reads, and a
// 5-minute write at 1.25x, unless the model prices its writes (models.ts).
export const writeCost = (m: Model, automatic = false) => (m.price?.write ? m.price.write / m.price.input : automatic ? 1 : m.ttl === 300 ? 1.25 : 2) / (m.price ? m.price.read / m.price.input : 0.1) - 1 // M
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
// of its breakpoints over at most the model's lookback (models.ts) of
// positions (a block, or a run of a
// message's tool_use or tool_result blocks), and writes from there to its
// last breakpoint; what follows that is plain input. Only the messages are
// tracked: a conversation's tools and system go in the seed, so changing them,
// or the model, finds no entry.

// Each block of the messages: the hash of the prefix through it, which names
// its entry (cache_control left out, since it moves from request to request
// over the same prefix), its size, whether it is a breakpoint, and whether it
// continues the previous block's position, in a run of tool calls or results.
export type Position = { prefix: string; size: number; breakpoint: boolean; joined: boolean }

// The seconds a request's entries last, by its breakpoints: an hour where each
// asks for "1h", else 5 minutes (the API's default, which Bedrock clients
// often keep); none without breakpoints.
export function markedTtl(body: { system?: unknown; tools?: unknown; messages?: unknown }): number | undefined {
  const marks: Array<{ ttl?: string } | undefined> = []
  JSON.stringify([body.system, body.tools, body.messages], (k, v) => (k === 'cache_control' && marks.push(v), v))
  return marks.length ? (marks.every((c) => c?.ttl === '1h') ? 3600 : 300) : undefined
}

const uncontrolled = (k: string, v: unknown) => (k === 'cache_control' ? undefined : v)
export const seedOf = (model: string, tools: unknown, system: unknown) => hash(JSON.stringify([model, tools, system], uncontrolled))

// With automatic caching (OpenAI's, and most others' behind Chat Completions),
// a request has no breakpoints of its own: the provider caches its prefix, and
// a later one reads the longest of it within 20 user or tool-result runs of its
// own end (measured on GPT-5.6; local/openai-design.md, "CacheModel"). That is
// modelled as one breakpoint, on the last block, with only each user message's
// end counted by the lookback (the rest joined); every such end of a request
// sent is an entry (server.ts, prepare).
export function positionsOf(msgs: readonly ApiMsg[], seed: string, thinking: Thinking, automatic = false): Position[] {
  let prefix = seed
  const pos = msgs.flatMap((m) =>
    blocks(m).map((b, i, bs) => {
      prefix = hash(prefix + m.role + JSON.stringify(b, uncontrolled))
      if (automatic) return { prefix, size: sizeOf(b, thinking), breakpoint: false, joined: m.role !== 'user' || i < bs.length - 1 }
      const joined = (b.type === 'tool_use' || b.type === 'tool_result') && bs[i - 1]?.type === b.type
      return { prefix, size: sizeOf(b, thinking), breakpoint: b.cache_control !== undefined, joined }
    }),
  )
  if (automatic && pos.length) pos[pos.length - 1].breakpoint = true
  return pos
}

// The position the request reads through, given the live entries; -1 for none.
export function readThrough(pos: readonly Position[], live: ReadonlySet<string>, lookback: number): number {
  let r = -1
  pos.forEach((p, b) => {
    if (!p.breakpoint) return
    for (let j = b, n = 0; j > r && n <= lookback; n += pos[j--].joined ? 0 : 1)
      if (live.has(pos[j].prefix)) {
        r = j
        break
      }
  })
  return r
}

// Claude Code's breakpoints are all on the last few messages, so a frontier
// move, which changes messages before them, finds no entry in reach and
// rewrites everything after the system prompt. The proxy adds one more where
// the messages as sent first differ from them settled (trimmed as far as the
// policy goes): no later move changes what is before it, so the entry there
// lets a move read up to its first change. It goes on the last block before
// that difference that can carry one (not thinking), with Claude Code's own
// settings. It is found on the messages as kept, before any move, so a move's
// own request reads the entry the requests before it wrote (settledEnd), and
// placed on the messages sent (anchored). The API takes 4 breakpoints: when
// the request has no spare, the caller frees the system prompt's first one
// (freedSystem). The caller keeps the request as it came when the prediction
// says the move reads less.
export function settledEnd(msgs: readonly ApiMsg[], final: readonly ApiMsg[], seed: string, thinking: Thinking): string | undefined {
  const [a, b] = [positionsOf(msgs, seed, thinking), positionsOf(final, seed, thinking)]
  const first = a.findIndex((p, i) => p.prefix !== b[i]?.prefix)
  const bs = msgs.flatMap(blocks)
  let k = (first < 0 ? a.length : first) - 1
  while (k >= 0 && isThinking(bs[k])) k--
  return a[k]?.prefix
}

export function anchored(msgs: readonly ApiMsg[], end: string | undefined, seed: string, thinking: Thinking): ApiMsg[] {
  const a = positionsOf(msgs, seed, thinking)
  const at: Array<[number, number]> = msgs.flatMap((m, i) => blocks(m).map((_, j): [number, number] => [i, j]))
  const marks = at.filter(([i, j]) => blocks(msgs[i])[j].cache_control !== undefined)
  const last = marks.at(-1)
  const k = a.findIndex((p) => p.prefix === end)
  if (k < 0 || !last || a[k].breakpoint) return [...msgs]
  const control = blocks(msgs[last[0]])[last[1]].cache_control
  return msgs.map((m, i) => (i === at[k][0] ? { ...m, content: blocks(m).map((bl, j) => (j === at[k][1] ? { ...bl, cache_control: control } : bl)) } : m))
}

// The system prompt with its first breakpoint taken out, freeing a slot for
// the anchor; undefined unless it has two. Claude Code puts one after its
// identity line, covering the tools, and one at the end of the system prompt.
// The first is read only when the system prompt changed and the tools did
// not: 3 requests in the logs of 2026-10-15, against 154 for the second.
export function freedSystem(system: unknown): unknown[] | undefined {
  if (!Array.isArray(system)) return
  const marked = system.flatMap((b, i) => (b?.cache_control ? [i] : []))
  if (marked.length < 2) return
  return system.map((b, i) => {
    if (i !== marked[0]) return b
    const { cache_control, ...rest } = b
    return rest
  })
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
// pays when its extra cost is at most H S, with S the characters it saves
// every later request and H the later requests expected (K unless given).
// Advancing reads no further than the first change, and less when no entry
// ends there or none is in reach of its breakpoints. With
// nothing cached both write everything, so advancing always pays. A request
// with no breakpoints in its messages (a side request branched off the
// conversation) reads nothing of them whatever is cached, so says nothing of
// the cache: it never advances.
export function decide(before: readonly ApiMsg[], after: readonly ApiMsg[], live: ReadonlySet<string>, seed: string, model: Model, thinking: Thinking = new Map(), automatic = false, horizon = K): Decision {
  const M = writeCost(model, automatic)
  const a = positionsOf(before, seed, thinking, automatic)
  const b = positionsOf(after, seed, thinking, automatic)
  const sum = (ps: Position[]) => ps.reduce((n, p) => n + p.size, 0)
  const savedChars = sum(a) - sum(b)
  const [ra, rb] = [readThrough(a, live, model.lookback), readThrough(b, live, model.lookback)]
  const cold = ra < 0
  if (a.at(-1)?.prefix === b.at(-1)?.prefix || savedChars <= 0 || !a.some((p) => p.breakpoint)) return { advanced: false, cold, savedChars: 0, rewriteChars: 0, extraChars: 0 }
  const rewriteChars = sum(a.slice(0, ra + 1)) - sum(b.slice(0, rb + 1))
  const extraChars = costOf(b, rb, M) - costOf(a, ra, M)
  return { advanced: extraChars <= horizon * savedChars, cold, savedChars, rewriteChars, extraChars }
}

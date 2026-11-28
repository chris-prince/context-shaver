// What the proxy sends in place of a Messages API request, and whether
// trimming more pays. Pure functions over the request body.
//
// A conversation is trimmed as its policy says (policy.ts) at its applied
// clock: the completed requests and turns the policy was last applied at. The
// clock only moves forward, so every request of the conversation sends the same
// trimmed prefix and the prompt cache keeps reading it; decide says when moving
// it pays. The latest request and the current turn are never touched.

import type { Model } from './models.ts'
import { blocks, CLAUDE_CODE, GROUP_KINDS, heldTo, isGroupKind, isSkillBody, isThinking, itemsOf, READ, READ_RESULT, readPairs, readsOf, requestsOf, turnsOf, type ApiMsg, type Block, type Clock, type Conventions, type Item, type Kind } from './items.ts'
import { hash, isNote, preambleEnd } from './log.ts'
import { joinedNotes, notesOfBlock } from './notes.ts'
import { afterOf, noteRulesFor, rulesFor, treatment, type Action, type PartRules } from './policy.ts'

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
//   before it or just after, is kept and stubbed instead; so, once the API
//   refused one in this conversation (`joins`), are the pairs whose drop
//   leaves a message's thinking beside the next one's (JOINED).
//   So a drop is only refused for what the drops around it actually leave.
// - Dropped reasoning is the message's thinking, unless that would leave it
//   empty: an empty message is refused. One left empty by dropped calls is
//   removed; the API joins the neighbours that leaves in the same role.
//
// `thinking` sizes reasoning for token rules (sizeOf).
export function apply(msgs: readonly ApiMsg[], policy: PartRules, clock: Clock, conv: Conventions = CLAUDE_CODE, thinking: Thinking = new Map(), joins = false): Applied {
  return applyAt(msgs, policy, heldTo(clock, msgs), conv, thinking, joins)
}

// The messages trimmed as far as the policy ever takes them: every rule due.
export const fullyTrimmed = (msgs: readonly ApiMsg[], policy: PartRules, conv: Conventions = CLAUDE_CODE, thinking: Thinking = new Map(), joins = false) =>
  applyAt(msgs, policy, { requests: Infinity, turns: Infinity }, conv, thinking, joins)

// The messages trimmed as far as more requests of the turn they're in take
// them: every rule timed in requests due, the turns as `turns` has them.
export const trimmedInTurn = (msgs: readonly ApiMsg[], policy: PartRules, turns: number, conv: Conventions = CLAUDE_CODE, thinking: Thinking = new Map(), joins = false) =>
  applyAt(msgs, policy, { requests: Infinity, turns }, conv, thinking, joins)

// Each item's tokens in the messages as they came: its blocks sized by sizeOf
// (thinking at its recorded tokens), at TEXT_TOKENS a character. A tool call's
// are its call and results, a skill's its body too, a Read's its text; where
// its call and output were counted (Thinking, `call:`), they are that.
//
// TODO: revisit the fixed TEXT_TOKENS rate for parts the API didn't count (all
// but thinking on Claude). Each response's usage gives the prompt's real tokens
// (input + cache read + cache write); saving the previous response's rate,
// (those tokens − thinking's) / (characters − thinking's), and using it here in
// place of TEXT_TOKENS (which stays the fallback for a first request) would
// size parts by their share of a known total.
// Pro: fits the conversation's real tokens per character, so a dense one (code,
// JSON, non-English) puts an "N tokens" boundary where it belongs; at the fixed
// rate a 20% error moves a 15000-token boundary by about 3000 tokens.
// Con: still splits by characters, so a dense part is undercounted against the
// prose around it (only counts for each part, as Codex gives, fix that); the
// rate comes a request late; one more value kept in state.
function tokensOf(msgs: readonly ApiMsg[], items: ReadonlyMap<string, Item>, thinking: Thinking): Map<string, number> {
  const out = new Map<string, number>()
  const add = (id: unknown, chars: number) => items.has(String(id)) && out.set(String(id), (out.get(String(id)) ?? 0) + chars * TEXT_TOKENS)
  msgs.forEach((m, i) => {
    const bs = blocks(m)
    if (m.role === 'system') {
      let n = 0
      for (const b of bs) if (b.type === 'text') for (const [read] of String(b.text).matchAll(READ)) add(`read:${i}:${n++}`, read.length)
      return
    }
    readPairs(m).forEach((j, n) => add(`read:${i}:${n}`, sizeOf(bs[j], thinking) + sizeOf(bs[j + 1], thinking)))
    const skill = bs.find((b) => b.type === 'tool_result' && items.get(String(b.tool_use_id))?.kind === 'skill')?.tool_use_id
    for (const b of bs)
      if (isThinking(b)) add(i, sizeOf(b, thinking))
      else if (b.type === 'tool_use') add(b.id, sizeOf(b, thinking))
      else if (b.type === 'tool_result') add(b.tool_use_id, sizeOf(b, thinking))
      else if (skill !== undefined && isSkillBody(b)) add(skill, sizeOf(b, thinking))
  })
  for (const id of out.keys()) if (thinking.has(`call:${id}`)) out.set(id, thinking.get(`call:${id}`)!)
  return out
}

// Each item's newer tokens at a clock: the tokens of the items of its kind
// after it in completed requests, which token rules are timed by. Counting
// only those keeps what a clock trims the same however the conversation goes
// on, and more is due as the clock moves.
function newerTokens(msgs: readonly ApiMsg[], items: ReadonlyMap<string, Item>, c: Clock, thinking: Thinking): Map<string, number> {
  const tokens = tokensOf(msgs, items, thinking)
  // The tool groups' kinds count as one kind, tool.
  const family = (k: Kind): Kind => (isGroupKind(k) ? 'tool' : k)
  const sums = new Map<Kind, number>()
  const out = new Map<string, number>()
  for (const it of [...items.values()].reverse()) {
    const n = sums.get(family(it.kind)) ?? 0
    out.set(it.id, n)
    if (it.request && it.request <= c.requests) sums.set(family(it.kind), n + (tokens.get(it.id) ?? 0))
  }
  return out
}

// The API's refusal of a drop that joined one message's thinking straight to
// the next's. Most routes take that join, so drops make it until one
// conversation's is refused; the server then trims it again with `joins` on,
// for the rest of that conversation, and sends it. The API quotes the block
// types in backticks ("`thinking` or `redacted_thinking` blocks …").
export const JOINED = /`?thinking`? or `?redacted_thinking`? blocks in the latest assistant message cannot be modified/

function applyAt(msgs: readonly ApiMsg[], policy: PartRules, c: Clock, conv: Conventions, thinking: Thinking, joins: boolean): Applied {
  const items = new Map(itemsOf(msgs, conv).map((it) => [it.id, it]))
  const newer = newerTokens(msgs, items, c, thinking)
  const undroppable = new Set<unknown>()
  for (;;) {
    const out = applyKeeping(msgs, policy, c, items, newer, undroppable, conv)
    const n = undroppable.size
    out.msgs.forEach((m, j) => {
      if (m.role !== 'system') return
      const i = out.origin[j]
      if (!['user', 'system'].includes(out.msgs[j - 1]?.role ?? 'user')) pairsOf(msgs[i - 1], undroppable)
      if (!['assistant', 'system', undefined].includes(out.msgs[j + 1]?.role)) pairsOf(msgs[i + 1], undroppable)
    })
    // The API joins assistant messages side by side, and on some routes
    // refuses a join that puts one message's thinking straight before the
    // next's (DESIGN.md, "The API constrains what can go"). A call dropped
    // after a message's thinking, with the next assistant message starting
    // with its own, makes that. Once the API has refused one in this
    // conversation (`joins`), the calls from the first message to the second
    // are kept and stubbed instead.
    if (joins) out.msgs.forEach((m, j) => {
      const next = out.msgs[j + 1]
      if (m.role !== 'assistant' || next?.role !== 'assistant') return
      const bs = blocks(m)
      if (!isThinking(bs[bs.length - 1]) || !isThinking(blocks(next)[0])) return
      for (let i = out.origin[j]; i < out.origin[j + 1]; i++) pairsOf(msgs[i], undroppable)
    })
    if (undroppable.size === n) return out
  }
}

// The harness's notes after the preamble due at the clock (notes.ts): a
// latest one once the request holding the last of its replacements, one for
// each of its keys, is completed, as with a rule of "0 requests"; a file note
// or a task's output by the drops of file_read's or command's rules
// (policy.ts, noteRulesFor), less a Read Claude Code attaches, which is a
// file_read item itself. By message, each block's notes to
// drop, by their place in notesOfBlock. They move only with the clock, so
// they go in a move a trim pays for (decide) or on a cold cache, and stay
// gone.
function notesDue(msgs: readonly ApiMsg[], policy: PartRules, c: Clock): Map<number, Map<number, Set<number>>> {
  const out = new Map<number, Map<number, Set<number>>>()
  const start = preambleEnd(msgs)
  if (start < 0) return out
  const { requestOf } = requestsOf(msgs)
  const { turnOf } = turnsOf(msgs)
  const next = new Map<string, number>() // each key's nearest latest note after, by message
  for (let i = msgs.length - 1; i >= start; i--) {
    const bs = blocks(msgs[i])
    const reads = new Set(readPairs(msgs[i]).flatMap((j) => [j, j + 1]))
    for (let j = bs.length - 1; j >= 0; j--) {
      if (!isNote(bs[j], msgs[i])) continue
      const read = reads.has(j) || (bs[j].type === 'text' && !!String(bs[j].text).match(READ))
      const ns = notesOfBlock(bs[j])
      for (let n = ns.length - 1; n >= 0; n--) {
        const rules = read ? undefined : noteRulesFor(policy, ns[n].category)
        if (rules) {
          if (treatment(rules, { request: requestOf[i], turn: turnOf[i] }, c) === 'drop') {
            if (!out.has(i)) out.set(i, new Map())
            const m = out.get(i)!
            if (!m.has(j)) m.set(j, new Set())
            m.get(j)!.add(n)
          }
          continue
        }
        if (ns[n].category !== 'latest') continue
        const by = ns[n].keys.map((k) => next.get(k))
        const r = by.every((x) => x !== undefined) ? requestOf[Math.max(...(by as number[]))] : 0
        if (r && r <= c.requests) {
          if (!out.has(i)) out.set(i, new Map())
          const m = out.get(i)!
          if (!m.has(j)) m.set(j, new Set())
          m.get(j)!.add(n)
        }
        for (const k of ns[n].keys) next.set(k, i)
      }
    }
  }
  return out
}

// A message without the notes given, by block and their place in it: a block
// left with none goes, and so does the message left with no block.
function withoutNotes(m: ApiMsg, gone: ReadonlyMap<number, ReadonlySet<number>>): ApiMsg | undefined {
  const content = blocks(m).flatMap((b, j): Block[] => {
    const drop = gone.get(j)
    if (!drop) return [b]
    const keep = notesOfBlock(b).filter((_, n) => !drop.has(n))
    return keep.length ? [{ ...b, text: joinedNotes(String(b.text), keep) }] : []
  })
  if (!content.length) return undefined
  return typeof m.content === 'string' ? { ...m, content: String(content[0].text) } : { ...m, content }
}

// Adds the tool calls a message makes or answers.
function pairsOf(m: ApiMsg | undefined, to: Set<unknown>) {
  if (m && typeof m.content !== 'string')
    for (const b of m.content) if (b.type === 'tool_use') to.add(b.id)
    else if (b.type === 'tool_result') to.add(b.tool_use_id)
}

function applyKeeping(msgs: readonly ApiMsg[], policy: PartRules, c: Clock, items: Map<string, Item>, newer: ReadonlyMap<string, number>, undroppable: ReadonlySet<unknown>, conv: Conventions): Applied {
  const due = new Map<unknown, Action>()
  for (const it of items.values()) {
    const rules = rulesFor(policy, it.kind)
    let a = treatment(rules, it, c, newer.get(it.id))
    // A stub leaves every message where it was, so it is allowed where the drop
    // was refused.
    if (a === 'drop' && undroppable.has(it.id)) a = 'stub'
    if (a) due.set(it.id, a)
  }
  const out: Applied = { msgs: [], origin: [], treated: new Map() }
  const mark = (id: unknown, action: Action) => out.treated.set(String(id), { kind: items.get(String(id))!.kind, action })
  const idOf = (b: Block) => (b.type === 'tool_use' ? b.id : b.type === 'tool_result' ? b.tool_use_id : undefined)
  const notes = notesDue(msgs, policy, c)
  msgs.forEach((m, i) => {
    const push = (m: ApiMsg) => (out.msgs.push(m), out.origin.push(i))
    const gone = notes.get(i)
    if (gone) {
      const kept = withoutNotes(m, gone)
      // A system message left empty goes. A user message can't: the messages
      // around it would then meet ones the API refuses together, so it keeps
      // a stub of its notes' text, when that is shorter than they are.
      if (!kept && m.role === 'system') return
      if (kept) m = kept
      else {
        const bs = blocks(m)
        const n = bytes(bs.map((b) => String(b.text)).join('\n'))
        if (n > stub(n).length) m = typeof m.content === 'string' ? { ...m, content: stub(n) } : { ...m, content: [{ ...bs[bs.length - 1], text: stub(n) }] }
      }
    }
    if (m.role === 'system') {
      const r = readsOf(m) ? withReads(m, i, due, mark) : m
      return r && push(r)
    }
    if (typeof m.content === 'string') return push(m)
    let content = readPairs(m).length ? withReadPairs(m.content, i, due, mark) : m.content
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

// A user message's blocks with each Read sent as a pair of reminders
// (readPairs) given what is due to it: a dropped one goes with both blocks, a
// stubbed one has its result's lines stubbed.
function withReadPairs(content: Block[], i: number, due: ReadonlyMap<unknown, Action>, mark: (id: unknown, a: Action) => void): Block[] {
  const pairs = readPairs({ role: 'user', content })
  if (!pairs.some((_, n) => due.has(`read:${i}:${n}`))) return content
  const out: Block[] = []
  for (let j = 0; j < content.length; j++) {
    const n = pairs.indexOf(j)
    const id = `read:${i}:${n}`
    const a = n < 0 ? undefined : due.get(id)
    if (a === 'drop') {
      mark(id, a)
      j++
      continue
    }
    out.push(content[j])
    if (a !== 'stub') continue
    const result = content[++j]
    const [, head, lines, tail] = String(result.text).match(READ_RESULT)!
    const k = bytes(lines)
    if (k <= stub(k).length) out.push(result)
    else out.push((mark(id, a), { ...result, text: `${head}${stub(k)}\n${tail}` }))
  }
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
// A token rule's reaches the request of the latest item it is due to.
export function trimmedEnd(msgs: readonly ApiMsg[], policy: PartRules, clock: Clock, conv: Conventions = CLAUDE_CODE, thinking: Thinking = new Map()): Ends {
  const c = heldTo(clock, msgs)
  const { requestOf } = requestsOf(msgs)
  const { turnOf } = turnsOf(msgs)
  const items = new Map(itemsOf(msgs, conv).map((it) => [it.id, it]))
  const newer = newerTokens(msgs, items, c, thinking)
  const end = (kind: Kind) =>
    Math.max(
      0,
      ...(rulesFor(policy, kind) ?? []).map((r) => {
        const { on, wait } = afterOf(r)!
        const latest = () => [...items.values()].findLast((it) => it.kind === kind && it.request && it.request <= c.requests && newer.get(it.id)! >= wait)?.request ?? 0
        const [of, n] = on === 'token' ? [requestOf, latest()] : on === 'request' ? [requestOf, c.requests - wait] : [turnOf, c.turns - wait]
        return n > 0 ? of.findIndex((x) => x > n) : 0
      }),
    )
  return { tools: Math.max(end('tool'), ...GROUP_KINDS.map(end)), reasoning: end('reasoning') }
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
// measured; local/notes.md, "Reasoning drops"). The map also holds the tokens
// tool calls billed where the API counted them, by `call:` and the call's id,
// which tokensOf takes in place of their size.
export const TEXT_TOKENS = 0.39
const SIGNATURE_TOKENS = 0.13
export type Thinking = ReadonlyMap<string, number> & { after?: ReadonlyMap<string, string> }

// A thinking block is bound while the messages before it are those of the
// prompt it was generated after, as sent. The API drops an unbound one
// unsaid and bills it nothing on a Claude Code sign-in, and elsewhere refuses
// it or drops it as asked (binding.ts), so in a request that's answered it
// costs nothing (local/notes.md, Past Work, "Mid-turn trims lose the turn's
// thinking"). `after` holds, by signature hash, the prefixesOf hash of the
// messages each block the proxy saw generated came after.
//
// BACKCOMPAT(2026-11-25)
//   Before: states kept no such hashes, and every thinking block counted.
//   Shim: a block with none recorded is counted as bound.
//   Remove when: conversations from before 2026-11-25 are no longer resumed.
export function unboundIn(msgs: readonly ApiMsg[], thinking: Thinking): Set<Block> {
  const out = new Set<Block>()
  const after = thinking.after
  if (!after?.size) return out
  let prefix = ''
  for (const m of msgs) {
    if (m.role === 'assistant')
      for (const b of blocks(m)) {
        const was = b.type === 'thinking' && typeof b.signature === 'string' ? after.get(hash(b.signature)) : undefined
        if (was !== undefined && was !== prefix) out.add(b)
      }
    prefix = prefixOf(prefix, m)
  }
  return out
}

// The hash naming the messages through `m`, given that of those before it:
// '' for none. A breakpoint is no part of it, nor whether a lone text block is
// sent as a string.
export const prefixOf = (before: string, m: ApiMsg) => hash(before + m.role + JSON.stringify(blocks(m), uncontrolled))
export const prefixesOf = (msgs: readonly ApiMsg[]) => msgs.reduce(prefixOf, '')

// `unbound`, the blocks unboundIn finds, count nothing.
export function sizeOf(b: Block, thinking: Thinking, unbound?: ReadonlySet<Block>): number {
  if (unbound?.has(b)) return 0
  // A breakpoint is no part of the prompt, as it's no part of the prefix.
  const n = JSON.stringify(b, uncontrolled).length
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
// `exact`: an explicit breakpoint under automatic caching, which finds only
// its own entry.
export type Position = { prefix: string; size: number; breakpoint: boolean; joined: boolean; exact?: boolean }

// The seconds a request's entries last, by its breakpoints: an hour where each
// asks for "1h", else 5 minutes (the API's default, which Bedrock clients
// often keep); none without breakpoints.
export function markedTtl(body: { system?: unknown; tools?: unknown; messages?: unknown }): number | undefined {
  const marks: Array<{ ttl?: string } | undefined> = []
  JSON.stringify([body.system, body.tools, body.messages], (k, v) => (k === 'cache_control' && marks.push(v), v))
  return marks.length ? (marks.every((c) => c?.ttl === '1h') ? 3600 : 300) : undefined
}

const uncontrolled = (k: string, v: unknown) => (k === 'cache_control' ? undefined : v)

// What a request's cache entries are named from: its model and the base the
// API caches. With breakpoint caching (Anthropic's) the API leaves deferred
// tools (defer_loading) and Claude Code's billing-header block out of the
// cached prefix: in the logs to 2026-11-22, requests that added a deferred
// tool, or changed the header's cc_version or cc_workload, still read the
// messages they shared with the request before (30K-43K tokens, 4 of 4 that
// shared more than the first two), so neither renames the entries.
export function seedOf(model: string, tools: unknown, system: unknown, breakpoints: boolean): string {
  if (!breakpoints) return wholeSeedOf(model, tools, system)
  const cached = Array.isArray(tools) ? tools.filter((t) => !t?.defer_loading) : tools
  const header = (b: { type?: string; text?: unknown } | undefined) => b?.type === 'text' && typeof b.text === 'string' && b.text.startsWith('x-anthropic-billing-header:')
  return wholeSeedOf(model, cached, Array.isArray(system) ? system.filter((b) => !header(b)) : system)
}

// BACKCOMPAT(2026-11-22)
//   Before: cache entries were named by the model, every tool definition and
//   the whole system prompt.
//   Shim: wholeSeedOf gives that old name, for the takeover in prepare
//   (server.ts).
//   Remove when: with that takeover.
export const wholeSeedOf = (model: string, tools: unknown, system: unknown) => hash(JSON.stringify([model, tools, system], uncontrolled))

// With automatic caching (OpenAI's, and most others' behind Chat Completions),
// a request has no breakpoints of its own: the provider caches its prefix, and
// a later one reads the longest of it within the model's lookback of its own
// end. That is modelled as one breakpoint, on the last block, which is the
// request's one entry (server.ts, prepare): only where a request ended, not
// at each user message's end, as Codex sends several user messages together
// (on sol, entries assumed at each one's end predicted reads after a trim
// that never came). The lookback counts user or tool-result runs, only each
// user message's end (the rest joined), as measured on GPT-5.6
// (local/openai-design.md, "CacheModel"); or with 'items', a model whose
// lookback counts input items (models.ts, lookbackCounts), every block, each
// an item but a message's parts after its first, which are few. A block
// marked there is an explicit breakpoint (OpenAI's prompt_cache_breakpoint,
// which the proxy puts on as an anchor), which looks up only the entry at its
// own end, however far back.
export function positionsOf(msgs: readonly ApiMsg[], seed: string, thinking: Thinking, automatic: boolean | 'items' = false, unbound = unboundIn(msgs, thinking)): Position[] {
  let prefix = seed
  const pos: Position[] = msgs.flatMap((m) =>
    blocks(m).map((b, i, bs) => {
      prefix = hash(prefix + m.role + JSON.stringify(b, uncontrolled))
      const breakpoint = b.cache_control !== undefined
      if (automatic) return { prefix, size: sizeOf(b, thinking, unbound), breakpoint, joined: automatic !== 'items' && (m.role !== 'user' || i < bs.length - 1), ...(breakpoint && { exact: true }) }
      const joined = (b.type === 'tool_use' || b.type === 'tool_result') && bs[i - 1]?.type === b.type
      return { prefix, size: sizeOf(b, thinking, unbound), breakpoint, joined }
    }),
  )
  if (automatic && pos.length) pos[pos.length - 1] = { ...pos[pos.length - 1], breakpoint: true, exact: false }
  return pos
}

// The entries a request writes or reads, by prefix: one at each breakpoint
// (with automatic caching, its end), and `r`, the one it reads through. An
// explicit breakpoint's entry is made only where the request writes past it,
// not where it reads through it (probe-codex-model-details.ts, breakpoints).
export const entriesOf = (pos: readonly Position[], r: number) => pos.filter((p, i) => (p.breakpoint && !(p.exact && i <= r)) || i === r).map((p) => p.prefix)

// What positionsOf counts the lookback in, for a model with or without automatic caching.
export const counting = (model: Model, automatic: boolean): boolean | 'items' => (automatic && model.lookbackCounts === 'items' ? 'items' : automatic)

// The position the request reads through, given the live entries; -1 for none.
export function readThrough(pos: readonly Position[], live: ReadonlySet<string>, lookback: number): number {
  let r = -1
  pos.forEach((p, b) => {
    if (!p.breakpoint) return
    if (p.exact) return void (b > r && live.has(p.prefix) && (r = b))
    for (let j = b, n = 0; j > r && n <= lookback; n += pos[j--].joined ? 0 : 1)
      if (live.has(pos[j].prefix)) {
        r = j
        break
      }
  })
  return r
}

// How far back from its breakpoint a read through position `r` found its
// entry, in the units lookback counts: 0 when the entry is on the breakpoint.
export function reachOf(pos: readonly Position[], r: number): number {
  const b = pos.findIndex((p, i) => i >= r && p.breakpoint)
  let n = 0
  for (let j = b; j > r; j--) n += pos[j].joined ? 0 : 1
  return b < 0 ? 0 : n
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
// says the move reads less. With `markable` (automatic caching, below), it
// goes on the last block before the difference that the protocol can mark.
// With `differing`, messages that match `final` throughout have none.
export type Markable = (b: Block, m: ApiMsg) => boolean
export function settledEnd(msgs: readonly ApiMsg[], final: readonly ApiMsg[], seed: string, thinking: Thinking, markable?: Markable, differing = false): string | undefined {
  const [a, b] = [positionsOf(msgs, seed, thinking), positionsOf(final, seed, thinking)]
  const first = a.findIndex((p, i) => p.prefix !== b[i]?.prefix)
  if (first < 0 && differing) return undefined
  const bs = msgs.flatMap((m) => blocks(m).map((bl) => [bl, m] as const))
  let k = (first < 0 ? a.length : first) - 1
  while (k >= 0 && (markable ? !markable(...bs[k]) : isThinking(bs[k][0]))) k--
  return a[k]?.prefix
}

// With automatic caching a request reads the newest entry within the model's
// lookback of its end (models.ts), and the lookback differs from one upstream
// to the next and from week to week: a trim whose first change is further
// back rewrites everything after the system prompt. Where the protocol can
// mark a block (protocol.ts, markable), every request carries up to three
// explicit breakpoints in its messages, so that what it reads doesn't rest on
// the lookback. An explicit breakpoint reads only the entry at its own end,
// however far back; a request makes an entry there where it writes past it,
// not where it reads through it, beside the one at its end; and the lookback
// from the end works as without it (probe-codex-model-details.ts,
// breakpoints, boundaries and kinds).
//   One is at settledEnd of the messages sent, the kept and the trimmed
//   alike: a trim's request writes past it, since its first change is at or
//   before it, and that entry is the one the next trim reads, right before
//   its own first change. No request need have ended there.
//   One is at settledEnd against the messages trimmed as far as more requests
//   of this turn take them (trimmedInTurn). The settled end is all a trim
//   reads when no entry is after it, and under a rule that waits for the turn
//   to end (reasoning's, by default) it stays where the turn began, so each
//   trim would rewrite all the turn has kept so far. While the turn lasts, the
//   next trim's first change is at this one instead: a trim's request writes
//   past it, and the next trim reads that entry. It's the last block the
//   protocol can mark that the turn's trims leave as it is, and messages with
//   nothing more due in the turn have none. In six sol runs, replayed, the
//   next trim began there after 38 of 39 trims of the main
//   conversation (the other at the settled end, a rule sized in tokens having
//   come due), and a trim's uncached tokens averaged 11.6K with this
//   breakpoint against 19.2K without.
//   The last is at the last block the protocol can mark whose prefix is a
//   live entry (liveEnd), the furthest the messages can read: on a trim the
//   boundary the last trim wrote, and otherwise mostly the last request's
//   end, which the lookback would find too unless the request adds more than
//   it reaches.
// Where two are one block, it's marked once. The system prompt's end is
// marked as well (markedSystem).
export function liveEnd(msgs: readonly ApiMsg[], live: ReadonlySet<string>, seed: string, thinking: Thinking, markable: Markable): string | undefined {
  const a = positionsOf(msgs, seed, thinking)
  const bs = msgs.flatMap((m) => blocks(m).map((bl) => [bl, m] as const))
  for (let k = a.length - 1; k >= 0; k--) if (live.has(a[k].prefix) && markable(...bs[k])) return a[k].prefix
}

// The block each marked copy anchored made was copied from, for a protocol
// that sends a block it was given as it came (responses.ts).
export const unmarked = new WeakMap<Block, Block>()

// The messages with a breakpoint at `end`, with the settings of the last one
// they have, or `explicit` (with automatic caching) with none.
export function anchored(msgs: readonly ApiMsg[], end: string | undefined, seed: string, thinking: Thinking, explicit = false): ApiMsg[] {
  const a = positionsOf(msgs, seed, thinking)
  const at: Array<[number, number]> = msgs.flatMap((m, i) => blocks(m).map((_, j): [number, number] => [i, j]))
  const marks = at.filter(([i, j]) => blocks(msgs[i])[j].cache_control !== undefined)
  const last = marks.at(-1)
  const k = a.findIndex((p) => p.prefix === end)
  const control = last ? blocks(msgs[last[0]])[last[1]].cache_control : explicit ? { type: 'ephemeral' } : undefined
  if (k < 0 || control === undefined || a[k].breakpoint) return [...msgs]
  const mark = (bl: Block) => {
    const copy = { ...bl, cache_control: control }
    unmarked.set(copy, bl)
    return copy
  }
  return msgs.map((m, i) => (i === at[k][0] ? { ...m, content: blocks(m).map((bl, j) => (j === at[k][1] ? mark(bl) : bl)) } : m))
}

// The system prompt with an explicit breakpoint on its last block with text,
// where the protocol can mark one under automatic caching. A request that
// finds no entry in its messages reads nothing, not the system prompt and
// tools either, as the lookback finds only an entry at a request's end: a
// trim with no block before its first change that the protocol can mark (a
// Codex sub-agent's messages start with an item it can't: responses.ts,
// markable), and a sub-agent's first request, whatever sub-agents with the
// same system prompt came before. Such a request writes past this breakpoint,
// which leaves an entry at the system prompt's end, and the next one reads it
// (probe-codex-model-details.ts, kinds). Entries are kept by the request's
// prompt_cache_key (the same probe, head-key: the same marked prompt under
// another key read nothing), which a conversation's requests share, and with
// them its sub-agents', which Codex sends under their parent's; a new
// conversation reads nothing of an earlier one's. In four sol runs
// without it, 4 of the 13 trims of sub-agents' conversations read
// nothing, each rewriting the 29.5K tokens of system prompt and tools, and so
// did the first request of each of the 5 sub-agents whose system prompt and
// tools an earlier one in its run had sent, 1 to 47 seconds after that one's
// latest request. The cache model starts after the system prompt (seedOf), so
// nothing in it changes.
export function markedSystem(system: unknown): unknown {
  if (!Array.isArray(system)) return system
  const k = system.findLastIndex((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')
  return system.map((b, i) => (i === k ? { ...b, cache_control: { type: 'ephemeral' } } : b))
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
// the cache: it never advances. Both prompts count as unbound only the
// thinking already unbound before the move: thinking the move itself would
// unbind keeps its tokens after it, so a move that throws away more of the
// turn's reasoning doesn't look the better for it. After the move that sizes
// the prompt a little high.
export function decide(before: readonly ApiMsg[], after: readonly ApiMsg[], live: ReadonlySet<string>, seed: string, model: Model, thinking: Thinking = new Map(), automatic = false, horizon = K): Decision {
  const M = writeCost(model, automatic)
  const unbound = unboundIn(before, thinking)
  const signatures = new Set([...unbound].map((bl) => bl.signature))
  const stillUnbound = new Set(after.flatMap(blocks).filter((bl) => bl.type === 'thinking' && signatures.has(bl.signature)))
  const a = positionsOf(before, seed, thinking, counting(model, automatic), unbound)
  const b = positionsOf(after, seed, thinking, counting(model, automatic), stillUnbound)
  const sum = (ps: Position[]) => ps.reduce((n, p) => n + p.size, 0)
  const savedChars = sum(a) - sum(b)
  const [ra, rb] = [readThrough(a, live, model.lookback), readThrough(b, live, model.lookback)]
  const cold = ra < 0
  if (a.at(-1)?.prefix === b.at(-1)?.prefix || savedChars <= 0 || !a.some((p) => p.breakpoint)) return { advanced: false, cold, savedChars: 0, rewriteChars: 0, extraChars: 0 }
  const rewriteChars = sum(a.slice(0, ra + 1)) - sum(b.slice(0, rb + 1))
  const extraChars = costOf(b, rb, M) - costOf(a, ra, M)
  return { advanced: extraChars <= horizon * savedChars, cold, savedChars, rewriteChars, extraChars }
}

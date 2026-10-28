// OpenAI's Responses protocol (/v1/responses), as Codex speaks it to OpenAI
// and to ChatGPT's backend (protocol.ts).
//
// A request's input is a list of items. Its leading developer messages, its
// tools item and the user messages that hold Codex's environment and AGENTS.md
// are its system. After those, a user message is a user message of its parts'
// blocks; a run of an answer's items, its reasoning, messages and tool calls,
// is one assistant message, reasoning as a thinking block and each call as a
// tool_use block; and a run of tool outputs is one user message of tool_result
// blocks. Any other item is a block that holds it, in a message of its side.
// Rendered back, every item the core left as it was is sent as it came: the
// cache is a prefix match on the bytes, so one sent differently costs a write.

import type { Usage } from './cost.ts'
import { blocks, type ApiMsg, type Block } from './items.ts'
import { CODEX_PREAMBLE, kinds, preambleEnd } from './log.ts'
import { eventReader, holding, openaiError, openaiUsage, type Canonical, type Content, type Counted, type Held, type Protocol, type Replying, type Wire } from './protocol.ts'

type Part = { type: string; text?: string; [k: string]: unknown }
type Item = { type: string; role?: string; content?: Part[]; call_id?: string; name?: string; arguments?: string; input?: string; output?: unknown; encrypted_content?: string; summary?: Part[]; [k: string]: unknown }
type Tool = { type?: string; name?: string; tools?: Tool[]; [k: string]: unknown }

const CALLS = new Set(['function_call', 'custom_tool_call'])
const OUTPUTS = new Set(['function_call_output', 'custom_tool_call_output'])

const textOf = (it: Item) => (it.content ?? []).map((p) => p.text ?? '').join('')
const isHead = (it: Item) => it.type === 'additional_tools' || (it.type === 'message' && (it.role === 'developer' || it.role === 'system' || (it.role === 'user' && CODEX_PREAMBLE.some((p) => textOf(it).startsWith(p)))))
// The side of the conversation an item is on: an answer's, a prompt's or a
// tool's output, or neither.
const sideOf = (it: Item): ApiMsg['role'] | 'output' =>
  it.type === 'message' ? (it.role === 'assistant' ? 'assistant' : it.role === 'user' ? 'user' : 'system') : it.type === 'reasoning' || it.type.endsWith('_call') ? 'assistant' : it.type.endsWith('_output') ? 'output' : 'system'

// An item's blocks: a message's parts, reasoning as a thinking block, a call
// as a tool_use block, an output as a tool_result block, and any other item a
// block that holds it.
function toBlocks(it: Item): Block[] {
  if (it.type === 'message') return (it.content ?? []).map((p) => (p.type === 'input_text' || p.type === 'output_text' ? { type: 'text', text: p.text ?? '' } : { ...p }))
  if (it.type === 'reasoning') return [{ type: 'thinking', thinking: (it.summary ?? []).map((p) => p.text ?? '').join('\n'), ...(typeof it.encrypted_content === 'string' && { signature: it.encrypted_content }) }]
  if (CALLS.has(it.type)) {
    let input: unknown = it.type === 'custom_tool_call' ? it.input : it.arguments
    if (it.type === 'function_call')
      try {
        input = JSON.parse(String(it.arguments))
      } catch {}
    return [{ type: 'tool_use', id: it.call_id, name: it.name, input }]
  }
  if (OUTPUTS.has(it.type)) return [{ type: 'tool_result', tool_use_id: it.call_id, content: it.output ?? '' }]
  return [{ type: 'item', item: it }]
}

// A tools item's tools and the request's own, each namespace's under its name.
const toolsOf = (ts: Tool[]): Tool[] => ts.flatMap((t) => (t.type === 'namespace' && t.tools ? toolsOf(t.tools).map((x) => ({ ...x, name: `${t.name}.${x.name}` })) : [{ name: t.name ?? t.type, ...t }]))

export function canonical(wire: Record<string, unknown>): Wire {
  const all = (typeof wire.input === 'string' ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: wire.input }] }] : wire.input ?? []) as Item[]
  const lead = all.findIndex((it) => !isHead(it))
  const head = lead < 0 ? all : all.slice(0, lead)
  const rest = lead < 0 ? [] : all.slice(lead)
  // Each message made, with the items it was made from; each block, with its
  // item and the part it was; and each call and output by its call's ID, for
  // a block the core changed.
  const from = new WeakMap<object, Item[]>()
  // The content each was made with: one given new content (a skill list
  // shortened, skills.ts, which after a compaction is in a message) is sent
  // as its blocks now are.
  const made = new WeakMap<object, unknown>()
  const srcOf = new WeakMap<object, { item: Item; part?: Part }>()
  const byCall = new Map<string, Item>()
  const byResult = new Map<string, Item>()
  const blocksOf = (it: Item): Block[] => {
    if (CALLS.has(it.type)) byCall.set(String(it.call_id), it)
    if (OUTPUTS.has(it.type)) byResult.set(String(it.call_id), it)
    return toBlocks(it).map((b, k) => (srcOf.set(b, { item: it, part: it.type === 'message' ? it.content?.[k] : undefined }), b))
  }
  const messages: ApiMsg[] = []
  for (let i = 0; i < rest.length; ) {
    const side = sideOf(rest[i])
    // An answer's items and a run of outputs are each one message; a prompt or
    // anything else is a message of its own.
    let j = i + 1
    if (side === 'assistant' || side === 'output') while (j < rest.length && sideOf(rest[j]) === side) j++
    const run = rest.slice(i, j)
    const msg: ApiMsg = { role: side === 'output' ? 'user' : side, content: run.flatMap(blocksOf) }
    from.set(msg, run)
    made.set(msg, msg.content)
    messages.push(msg)
    i = j
  }
  const tools = toolsOf([...((wire.tools ?? []) as Tool[]), ...head.flatMap((it) => (it.type === 'additional_tools' ? ((it.tools ?? []) as Tool[]) : []))])
  // Each system block with the head item and part it was, or none for the
  // instructions, so one whose text the core changed (a skill list it
  // shortened, skills.ts) is sent with its new text.
  const sources: ({ item: Item; k: number } | undefined)[] = []
  const system = head.flatMap((it) => (it.type === 'message' ? (it.content ?? []).map((p, k) => (sources.push({ item: it, k }), { type: 'text', text: p.text ?? '' })) : []))
  if (typeof wire.instructions === 'string') system.unshift({ type: 'text', text: wire.instructions }), sources.unshift(undefined)
  const said = system.map((b) => b.text)
  const body: Canonical = { model: String(wire.model ?? ''), messages, system, tools, stream: !!wire.stream, prompt_cache_key: wire.prompt_cache_key }

  // A message the core left is sent as it came. One it changed is its items
  // again, each the core left as it came: a message item whose parts it kept,
  // a call whose input it stubbed or an output it stubbed rebuilt from the one
  // it was; text it made (a record, summary.ts) is a message of its own.
  function renderMsg(m: ApiMsg): Item[] {
    const was = from.get(m)
    const old = made.get(m)
    if (was && m.content === old) return was
    // A message item given new text, part for part, keeps its other parts and fields.
    const item = was?.length === 1 && was[0].type === 'message' ? was[0] : undefined
    if (item && Array.isArray(m.content) && Array.isArray(old) && m.content.length === old.length)
      return [{ ...item, content: m.content.map((b, k) => (b === old[k] ? item.content![k] : { ...item.content![k], text: String(b.text) })) }]
    const out: Item[] = []
    let open: { src?: Item; role: string; parts: Part[]; same: boolean } | undefined
    const close = () => {
      if (open) out.push(open.src && open.same && open.parts.length === open.src.content?.length ? open.src : { ...(open.src ?? { type: 'message', role: open.role }), content: open.parts })
      open = undefined
    }
    for (const b of blocks(m)) {
      const s = srcOf.get(b)
      if (s?.part || (!s && b.type === 'text')) {
        const role = s?.item.role ?? (m.role === 'assistant' ? 'assistant' : 'user')
        if (!open || open.src !== s?.item) close(), (open = { src: s?.item, role, parts: [], same: true })
        const part = s?.part ?? { type: role === 'assistant' ? 'output_text' : 'input_text', text: String(b.text) }
        open.same &&= part === open.src?.content?.[open.parts.length]
        open.parts.push(part)
        continue
      }
      close()
      if (s) out.push(s.item)
      else if (b.type === 'tool_use') {
        const c = byCall.get(String(b.id)) ?? { type: 'function_call', call_id: String(b.id), name: String(b.name) }
        const input = typeof b.input === 'string' ? b.input : JSON.stringify(b.input)
        out.push(c.type === 'custom_tool_call' ? { ...c, input } : { ...c, arguments: input })
      } else if (b.type === 'tool_result') out.push({ ...(byResult.get(String(b.tool_use_id)) ?? { type: 'function_call_output', call_id: String(b.tool_use_id) }), output: b.content })
      else if (b.type === 'item') out.push(b.item as Item)
    }
    close()
    return out
  }

  const idsOf = (items: Item[]) => items.flatMap((it) => (typeof it.id === 'string' ? [it.id] : []))
  // A list of items' tokens, when the usage counted each of them.
  const counted = (msgs: readonly ApiMsg[], attribution: unknown): Counted | undefined => {
    const items = (attribution as { items?: Record<string, { input_tokens?: number }> } | undefined)?.items
    if (!items) return
    const tokensOf = (it: Item) => (typeof it.id === 'string' ? items[it.id]?.input_tokens : undefined)
    const sum = (its: Item[]) => (its.length && its.every((it) => tokensOf(it) !== undefined) ? its.reduce((n, it) => n + tokensOf(it)!, 0) : undefined)
    const rendered = msgs.map(renderMsg)
    const reasoning = new Map<string, number>()
    for (const it of rendered.flat()) if (it.type === 'reasoning' && typeof it.encrypted_content === 'string' && tokensOf(it) !== undefined) reasoning.set(it.encrypted_content, tokensOf(it)!)
    // A message's tokens by kind, each item's as counted. An item is mostly of
    // one kind; one that mixes them, a prompt with a reminder say, is split by
    // bytes as log.ts splits a message, but with no envelope, the blocks'
    // JSON alone, since an item has none.
    const responded = preambleEnd(msgs)
    const kindsOf = (its: Item[], i: number) => {
      if (sum(its) === undefined) return
      const out: Record<string, number> = {}
      for (const it of its) {
        const m: ApiMsg = { role: msgs[i].role, content: toBlocks(it) }
        const k = kinds(m.content.map((b) => JSON.stringify(b)).join(''), m, responded < 0 || i < responded).kinds
        const bytes = Object.values(k).reduce((a, b) => a + b, 0)
        for (const [kind, b] of Object.entries(k)) out[kind] = (out[kind] ?? 0) + (tokensOf(it)! * b) / bytes
      }
      return out
    }
    return { head: sum(head), messages: rendered.map(sum), kinds: rendered.map(kindsOf), reasoning }
  }
  // The head and instructions as they came, but for the parts whose text the
  // core changed; every other item is sent as it came.
  const headOf = (c: Canonical): { head: Item[]; instructions: unknown } => {
    const now = c.system as { text?: string }[] | undefined
    if (!Array.isArray(now) || now.length !== said.length) return { head, instructions: wire.instructions }
    const parts = new Map<Item, Part[]>()
    let instructions = wire.instructions
    now.forEach((b, i) => {
      if (b.text === said[i]) return
      const s = sources[i]
      if (!s) return void (instructions = b.text)
      const ps = parts.get(s.item) ?? [...(s.item.content ?? [])]
      ps[s.k] = { ...ps[s.k], text: b.text }
      parts.set(s.item, ps)
    })
    return { head: head.map((it) => (parts.has(it) ? { ...it, content: parts.get(it) } : it)), instructions }
  }
  const render = (c: Canonical) => {
    const h = headOf(c)
    return { ...wire, ...(h.instructions !== undefined && { instructions: h.instructions }), input: [...h.head, ...c.messages.flatMap(renderMsg)] }
  }
  return { body, render, ids: { head: idsOf(head), of: (m) => idsOf(renderMsg(m)) }, counted }
}

type Response = { output?: Item[]; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }; attribution?: unknown } }

// ChatGPT's backend doesn't say what it wrote. Measured through OpenRouter
// (local/notes.md, "Make Codex's cost and savings figures accurate"), OpenAI
// writes all a prompt's uncached tokens but 3, once it's past the cache's
// 1024-token minimum, so that's what it's taken to have written.
const inferred = (input: number, read: number) => (input >= 1024 ? Math.max(0, input - read - 3) : 0)

function usageOf(u: Response['usage']): Usage | undefined {
  if (!u?.input_tokens) return undefined
  const read = u.input_tokens_details?.cached_tokens ?? 0
  const written = u.input_tokens_details?.cache_write_tokens ?? inferred(u.input_tokens, read)
  return openaiUsage(u.input_tokens, read, written, u.output_tokens ?? 0)
}

// Codex usage journaled before writes were inferred holds none, so they're
// inferred as it's replayed. Usage that already has them is unchanged: it
// either wrote, or left 3 tokens or fewer uncached, which infer no writes.
export function withWrites(u: Usage): Usage {
  if (u.cache_creation_input_tokens) return u
  const read = u.cache_read_input_tokens ?? 0
  return openaiUsage(u.input_tokens + read, read, inferred(u.input_tokens + read, read), u.output_tokens ?? 0)
}

// The finished response: a stream's last event holds it whole.
const finished = (e: { type?: string; response?: Response }) => (e.type === 'response.completed' || e.type === 'response.incomplete' ? e.response : undefined)

function usageReader() {
  let usage: Usage | undefined
  let attribution: unknown
  const content: Content = { signatures: [], visibleChars: 0 }
  const read = (r: Response | undefined) => {
    if (!r) return
    usage = usageOf(r.usage) ?? usage
    attribution = r.usage?.attribution ?? attribution
    for (const it of r.output ?? [])
      if (it.type === 'reasoning') content.signatures.push(it.encrypted_content ?? '')
      else content.visibleChars += it.type === 'message' ? textOf(it).length : (it.name?.length ?? 0) + (it.input ?? it.arguments ?? '').length
  }
  return eventReader({ event: (e) => read(finished(e)), body: read, result: () => ({ usage, content, attribution }), final: (e) => !!finished(e) })
}

function replying(model: string, stream: boolean, context: number): Replying {
  const id = `resp_proxy_${Date.now()}`
  const item = (text: string) => ({ id: `msg_proxy_${id.slice('resp_proxy_'.length)}`, type: 'message', status: 'completed', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] })
  const usage = { input_tokens: context, input_tokens_details: { cached_tokens: context }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: context }
  const response = (text: string) => ({ id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model, output: [item(text)], usage })
  if (!stream) return { start: '', text: () => '', end: (text) => JSON.stringify(response(text)) }
  const event = (type: string, e: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...e })}\n\n`
  const { id: item_id } = item('')
  return {
    start: event('response.created', { response: { ...response(''), status: 'in_progress', output: [], usage: null } }) + event('response.output_item.added', { output_index: 0, item: { ...item(''), status: 'in_progress', content: [] } }),
    text: (delta) => event('response.output_text.delta', { item_id, output_index: 0, content_index: 0, delta }),
    end: (text) => event('response.output_item.done', { output_index: 0, item: item(text) }) + event('response.completed', { response: response(text) }),
  }
}

// A stream held from response.completed on, which ends the turn when the
// response calls no tool. Text added is a message item of its own.
function holdClose(write: (s: string) => void): Held {
  let next = 0
  let output: Item[] | undefined
  const see = (o: { type?: string; output_index?: number; response?: { output?: Item[] } }) => {
    if (o.type === 'response.output_item.added' && typeof o.output_index === 'number') next = Math.max(next, o.output_index + 1)
    if (o.type === 'response.completed') output = o.response?.output ?? []
  }
  const h = holding(write, see, (o) => o.type === 'response.completed')
  return {
    ...h,
    get ended() {
      return !!output && !output.some((it) => CALLS.has(it.type) || it.type === 'local_shell_call')
    },
    add(text) {
      const item = { id: `msg_proxy_${Date.now()}_${next}`, type: 'message', status: 'completed', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] }
      const event = (type: string, e: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...e })}\n\n`
      const at = next++
      return (
        event('response.output_item.added', { output_index: at, item: { ...item, status: 'in_progress', content: [] } }) +
        event('response.output_text.delta', { item_id: item.id, output_index: at, content_index: 0, delta: text }) +
        event('response.output_item.done', { output_index: at, item })
      )
    },
  }
}

export const RESPONSES: Protocol = {
  name: 'responses',
  serves: (p) => p === '/v1/responses' || p === '/responses',
  canonical,
  usageReader,
  replying,
  holdClose,
  error: openaiError,
  // Codex's limits and credits; its turn state is the turn's, not the account's.
  limits: /^x-codex-(?!turn-state)/,
  automatic: true,
  defers: false,
  // The summary fork's question is a user message of its own after the
  // request's items. ChatGPT's backend only streams, so it stays as it was.
  summaryFork: (sent, text) => ({ ...sent, input: [...(sent.input as Item[]), { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] }),
  summaryForkAnswer: (body) => {
    let r: Response | undefined
    for (const l of body.split('\n'))
      if (l.startsWith('data: '))
        try {
          r = finished(JSON.parse(l.slice(6))) ?? r
        } catch {}
    if (!r) r = JSON.parse(body) as Response
    const content: Block[] = (r.output ?? []).flatMap((it): Block[] => (it.type === 'message' ? [{ type: 'text', text: textOf(it) }] : CALLS.has(it.type) ? [{ type: 'tool_use', id: it.call_id, name: it.name, input: it.input ?? it.arguments }] : []))
    return { content, usage: usageOf(r.usage) }
  },
}

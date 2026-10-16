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

import type { IncomingHttpHeaders } from 'node:http'
import type { Usage } from './cost.ts'
import { blocks, type ApiMsg, type Block, type Conventions } from './items.ts'
import { eventReader, openaiError, openaiUsage, sessionConversation, type Canonical, type Content, type Protocol } from './protocol.ts'

type Part = { type: string; text?: string; [k: string]: unknown }
type Item = { type: string; role?: string; content?: Part[]; call_id?: string; name?: string; arguments?: string; input?: string; output?: unknown; encrypted_content?: string; summary?: Part[]; [k: string]: unknown }
type Tool = { type?: string; name?: string; tools?: Tool[]; [k: string]: unknown }

const CALLS = new Set(['function_call', 'custom_tool_call'])
const OUTPUTS = new Set(['function_call_output', 'custom_tool_call_output'])
// The user messages Codex makes before the first prompt.
const PREAMBLE = ['<environment_context>', '# AGENTS.md instructions']

const textOf = (it: Item) => (it.content ?? []).map((p) => p.text ?? '').join('')
const isHead = (it: Item) => it.type === 'additional_tools' || (it.type === 'message' && (it.role === 'developer' || it.role === 'system' || (it.role === 'user' && PREAMBLE.some((p) => textOf(it).startsWith(p)))))
// The side of the conversation an item is on: an answer's, a prompt's or a
// tool's output, or neither.
const sideOf = (it: Item): ApiMsg['role'] | 'output' =>
  it.type === 'message' ? (it.role === 'assistant' ? 'assistant' : it.role === 'user' ? 'user' : 'system') : it.type === 'reasoning' || it.type.endsWith('_call') ? 'assistant' : it.type.endsWith('_output') ? 'output' : 'system'

// A tools item's tools and the request's own, each namespace's under its name.
const toolsOf = (ts: Tool[]): Tool[] => ts.flatMap((t) => (t.type === 'namespace' && t.tools ? toolsOf(t.tools).map((x) => ({ ...x, name: `${t.name}.${x.name}` })) : [{ name: t.name ?? t.type, ...t }]))

export function canonical(wire: Record<string, unknown>): { body: Canonical; render(c: Canonical): unknown } {
  const all = (typeof wire.input === 'string' ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: wire.input }] }] : wire.input ?? []) as Item[]
  const lead = all.findIndex((it) => !isHead(it))
  const head = lead < 0 ? all : all.slice(0, lead)
  const rest = lead < 0 ? [] : all.slice(lead)
  // Each message made, with the items it was made from; each block, with its
  // item and the part it was; and each call and output by its call's ID, for
  // a block the core changed.
  const from = new WeakMap<object, Item[]>()
  const srcOf = new WeakMap<object, { item: Item; part?: Part }>()
  const byCall = new Map<string, Item>()
  const byResult = new Map<string, Item>()
  const made = (b: Block, item: Item, part?: Part) => (srcOf.set(b, { item, part }), b)
  const blocksOf = (it: Item): Block[] => {
    if (it.type === 'message') return (it.content ?? []).map((p) => made(p.type === 'input_text' || p.type === 'output_text' ? { type: 'text', text: p.text ?? '' } : { ...p }, it, p))
    if (it.type === 'reasoning')
      return [made({ type: 'thinking', thinking: (it.summary ?? []).map((p) => p.text ?? '').join('\n'), ...(typeof it.encrypted_content === 'string' && { signature: it.encrypted_content }) }, it)]
    if (CALLS.has(it.type)) {
      let input: unknown = it.type === 'custom_tool_call' ? it.input : it.arguments
      if (it.type === 'function_call')
        try {
          input = JSON.parse(String(it.arguments))
        } catch {}
      byCall.set(String(it.call_id), it)
      return [made({ type: 'tool_use', id: it.call_id, name: it.name, input }, it)]
    }
    if (OUTPUTS.has(it.type)) {
      byResult.set(String(it.call_id), it)
      return [made({ type: 'tool_result', tool_use_id: it.call_id, content: it.output ?? '' }, it)]
    }
    return [made({ type: 'item', item: it }, it)]
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
    messages.push(msg)
    i = j
  }
  const tools = toolsOf([...((wire.tools ?? []) as Tool[]), ...head.flatMap((it) => (it.type === 'additional_tools' ? ((it.tools ?? []) as Tool[]) : []))])
  const system = head.flatMap((it) => (it.type === 'message' ? (it.content ?? []).map((p) => ({ type: 'text', text: p.text ?? '' })) : []))
  if (typeof wire.instructions === 'string') system.unshift({ type: 'text', text: wire.instructions })
  const body: Canonical = { model: String(wire.model ?? ''), messages, system, tools, stream: !!wire.stream, prompt_cache_key: wire.prompt_cache_key }

  // A message the core left is sent as it came. One it changed is its items
  // again, each the core left as it came: a message item whose parts it kept,
  // a call whose input it stubbed or an output it stubbed rebuilt from the one
  // it was; text it made (a record, summary.ts) is a message of its own.
  function renderMsg(m: ApiMsg): Item[] {
    const was = from.get(m)
    if (was) return was
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

  return { body, render: (c) => ({ ...wire, input: [...head, ...c.messages.flatMap(renderMsg)] }) }
}

// The core's requirement of a conversation ID, made true here: Codex sends its
// session's ID as prompt_cache_key and as the session-id header.
const conversationId = (c: Canonical, headers: IncomingHttpHeaders) => sessionConversation('codex', c, [c.prompt_cache_key, headers['session-id']])

type Response = { output?: Item[]; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } } }

function usageOf(u: Response['usage']): Usage | undefined {
  if (!u?.input_tokens) return undefined
  return openaiUsage(u.input_tokens, u.input_tokens_details?.cached_tokens ?? 0, u.input_tokens_details?.cache_write_tokens ?? 0, u.output_tokens ?? 0)
}

// The finished response: a stream's last event holds it whole.
const finished = (e: { type?: string; response?: Response }) => (e.type === 'response.completed' || e.type === 'response.incomplete' ? e.response : undefined)

function usageReader() {
  let usage: Usage | undefined
  const content: Content = { signatures: [], visibleChars: 0 }
  const read = (r: Response | undefined) => {
    if (!r) return
    usage = usageOf(r.usage) ?? usage
    for (const it of r.output ?? [])
      if (it.type === 'reasoning') content.signatures.push(it.encrypted_content ?? '')
      else content.visibleChars += it.type === 'message' ? textOf(it).length : (it.name?.length ?? 0) + (it.input ?? it.arguments ?? '').length
  }
  return eventReader({ event: (e) => read(finished(e)), body: read, result: () => ({ usage, content }), final: (e) => !!finished(e) })
}

function reply(text: string, model: string, stream: boolean, context: number): string {
  const id = `resp_proxy_${Date.now()}`
  const item = { id: `msg_proxy_${Date.now()}`, type: 'message', status: 'completed', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] }
  const usage = { input_tokens: context, input_tokens_details: { cached_tokens: context }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: context }
  const response = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model, output: [item], usage }
  if (!stream) return JSON.stringify(response)
  const event = (type: string, e: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...e })}\n\n`
  return (
    event('response.created', { response: { ...response, status: 'in_progress', output: [], usage: null } }) +
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } }) +
    event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text }) +
    event('response.output_item.done', { output_index: 0, item }) +
    event('response.completed', { response })
  )
}

// Codex's tools are run from JavaScript, by one custom exec tool, so no call's
// input has fields of its own to stub, nor a shell command apart.
export const CODEX: Conventions = {
  kinds: {},
  stubbedInputs: {},
  shell: '',
  promptHeadings: [
    ['', 'system-prompt'],
    ['<skills_instructions>', 'skills'],
    ['<permissions instructions>', 'permissions'],
    ['<collaboration_mode>', 'collaboration-mode'],
    ['<recommended_plugins>', 'plugins'],
    ['<multi_agent_role>', 'multi-agent'],
    ['<multi_agent_mode>', 'multi-agent'],
    ['# AGENTS.md instructions', 'agents-md'],
    ['<environment_context>', 'other'],
  ],
}

export const RESPONSES: Protocol = {
  name: 'responses',
  serves: (p) => p === '/v1/responses' || p === '/responses',
  canonical,
  conversationId,
  usageReader,
  reply,
  error: openaiError,
  // Codex's limits and credits; its turn state is the turn's, not the account's.
  limits: /^x-codex-(?!turn-state)/,
  automatic: true,
  conventions: CODEX,
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

// OpenAI's Chat Completions protocol (/v1/chat/completions), as OpenCode
// speaks it to OpenRouter and OpenAI (protocol.ts).
//
// A request becomes the core's shape (items.ts): the leading system and
// developer messages are its system; a user message's parts are blocks; an
// assistant message is its reasoning as a thinking block, its text, and each
// tool call as a tool_use block; a run of tool messages is one user message of
// tool_result blocks. Rendered back, every message and block the core left as
// it was is sent as it came: the cache is a prefix match on the bytes, so one
// sent differently costs a write.

import type { IncomingHttpHeaders } from 'node:http'
import type { Usage } from './cost.ts'
import type { ApiMsg, Block, Conventions } from './items.ts'
import { hash } from './log.ts'
import type { Canonical, Content, Protocol } from './protocol.ts'

type Part = { type: string; text?: string; [k: string]: unknown }
type Call = { id: string; type: 'function'; function: { name: string; arguments: string } }
type WireMsg = { role: string; content?: string | Part[] | null; tool_calls?: Call[]; tool_call_id?: string; reasoning?: string; [k: string]: unknown }

const REASONING = ['reasoning', 'reasoning_content', 'reasoning_details'] as const

export function canonical(wire: Record<string, unknown>): { body: Canonical; render(c: Canonical): unknown } {
  const all = (wire.messages ?? []) as WireMsg[]
  const lead = all.findIndex((m) => m.role !== 'system' && m.role !== 'developer')
  const head = lead < 0 ? all : all.slice(0, lead)
  const rest = lead < 0 ? [] : all.slice(lead)
  // Each message made, with the wire messages it was made from; each block,
  // with the part, call or tool message; and each wire message by its blocks'
  // ids, for one the core changed.
  const from = new WeakMap<object, WireMsg[]>()
  const partOf = new WeakMap<object, unknown>()
  const msgOf = new WeakMap<object, WireMsg>()
  const byCall = new Map<string, WireMsg>()
  const byResult = new Map<string, WireMsg>()
  const made = (b: Block, src: unknown, m: WireMsg) => (partOf.set(b, src), msgOf.set(b, m), b)
  const messages: ApiMsg[] = []
  for (let i = 0; i < rest.length; i++) {
    const m = rest[i]
    if (m.role === 'tool') {
      const run: WireMsg[] = []
      while (rest[i]?.role === 'tool') run.push(rest[i++])
      i--
      for (const t of run) byResult.set(String(t.tool_call_id), t)
      const msg: ApiMsg = { role: 'user', content: run.map((t) => made({ type: 'tool_result', tool_use_id: t.tool_call_id, content: t.content ?? '' }, t, t)) }
      from.set(msg, run)
      messages.push(msg)
      continue
    }
    const content: Block[] = []
    const r = m.role === 'assistant' ? REASONING.find((k) => m[k] !== undefined) : undefined
    if (r) content.push(made({ type: 'thinking', thinking: typeof m[r] === 'string' ? m[r] : JSON.stringify(m[r]) }, r, m))
    for (const p of partsOf(m.content)) content.push(made(p.type === 'text' ? { type: 'text', text: p.text ?? '' } : { ...p }, p, m))
    for (const c of m.tool_calls ?? []) {
      let input: unknown = c.function.arguments
      try {
        input = JSON.parse(c.function.arguments)
      } catch {}
      byCall.set(c.id, m)
      content.push(made({ type: 'tool_use', id: c.id, name: c.function.name, input }, c, m))
    }
    const msg: ApiMsg = { role: m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : 'system', content }
    from.set(msg, [m])
    messages.push(msg)
  }
  const tools = ((wire.tools ?? []) as { function?: { name?: string } }[]).map((t) => ({ name: t.function?.name, ...t }))
  const system = head.flatMap((m) => partsOf(m.content).map((p) => ({ type: 'text', text: p.text ?? '' })))
  const body: Canonical = { model: String(wire.model ?? ''), messages, system, tools, stream: !!wire.stream, provider: (wire.provider as { order?: string[] } | undefined)?.order?.[0], prompt_cache_key: wire.prompt_cache_key, user: wire.user }

  // A message the core left is sent as it came. One it changed is rebuilt
  // from the wire message it was made from, each block it left sent as it came.
  function renderMsg(m: ApiMsg): WireMsg[] {
    const was = from.get(m)
    if (was) return was
    const bs: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
    if (bs.length && bs.every((b) => b.type === 'tool_result'))
      return bs.map((b) => (partOf.get(b) as WireMsg | undefined) ?? { ...(byResult.get(String(b.tool_use_id)) ?? { role: 'tool', tool_call_id: String(b.tool_use_id) }), content: b.content as string | Part[] })
    const base = bs.map((b) => msgOf.get(b) ?? (b.type === 'tool_use' ? byCall.get(String(b.id)) : undefined)).find(Boolean)
    const out: WireMsg = { ...(base ?? { role: m.role }) }
    const kept = bs.find((b) => b.type === 'thinking' && partOf.has(b))
    for (const k of REASONING) if (partOf.get(kept ?? {}) !== k) delete out[k]
    const parts = bs.filter((b) => b.type !== 'thinking' && b.type !== 'tool_use').map((b) => (partOf.get(b) as Part | undefined) ?? (b.type === 'text' ? { type: 'text', text: String(b.text) } : (b as Part)))
    const calls = bs.filter((b) => b.type === 'tool_use').map((b): Call => {
      const c = partOf.get(b) as Call | undefined
      if (c) return c
      const was = byCall.get(String(b.id))?.tool_calls?.find((x) => x.id === b.id)
      return { ...(was ?? { id: String(b.id), type: 'function' }), function: { name: String(b.name), arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input) } }
    })
    const text = parts.every((p) => p.type === 'text')
    out.content = typeof base?.content === 'string' && text ? parts.map((p) => p.text).join('') : parts.length ? parts : m.role === 'assistant' ? null : ''
    if (calls.length) out.tool_calls = calls
    else delete out.tool_calls
    return [out]
  }

  return {
    body,
    render(c) {
      const out: Record<string, unknown> = { ...wire, messages: [...head, ...c.messages.flatMap(renderMsg)] }
      // A stream reports its usage only when asked to.
      if (wire.stream) out.stream_options = { ...(wire.stream_options as object), include_usage: true }
      return out
    },
  }
}

const partsOf = (c: WireMsg['content']): Part[] => (typeof c === 'string' ? [{ type: 'text', text: c }] : c ?? [])

// The core's requirement of a conversation ID, made true here: OpenCode sends
// its session's ID as prompt_cache_key (to OpenAI) or user, or as a header; with
// none, the first message after the system's names the conversation, which two
// sessions started the same way share.
function conversationId(c: Canonical, headers: IncomingHttpHeaders): string {
  const first = hash(JSON.stringify(c.messages[0])).slice(0, 8)
  const session = [c.prompt_cache_key, c.user, headers['x-session-id'], headers['session_id']].find((v) => typeof v === 'string' && v)
  return `chat-${session ? `${session}-` : ''}${first}`
}

// A response's usage, from its last chunk for a stream (render asks for it), in
// the core's terms: what Chat Completions counts as the prompt is the
// uncached, read and written tokens together.
function usageOf(u: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } } | undefined): Usage | undefined {
  if (!u?.prompt_tokens) return undefined
  const read = u.prompt_tokens_details?.cached_tokens ?? 0
  const written = u.prompt_tokens_details?.cache_write_tokens ?? 0
  return { input_tokens: u.prompt_tokens - read - written, cache_read_input_tokens: read, cache_creation_input_tokens: written, output_tokens: u.completion_tokens ?? 0 }
}

function usageReader() {
  let usage: Usage | undefined
  const content: Content = { signatures: [], visibleChars: 0 }
  let buf = ''
  let streamed = false
  const dec = new TextDecoder()
  const line = (l: string) => {
    if (!l.startsWith('data: ')) return
    streamed = true
    try {
      const e = JSON.parse(l.slice(6))
      usage = usageOf(e.usage) ?? usage
      for (const ch of e.choices ?? []) {
        const d = ch.delta ?? {}
        if (typeof d.content === 'string') content.visibleChars += d.content.length
        for (const t of d.tool_calls ?? []) content.visibleChars += (t.function?.name?.length ?? 0) + (t.function?.arguments?.length ?? 0)
      }
    } catch {}
  }
  return {
    push(chunk: Uint8Array) {
      buf += dec.decode(chunk, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      lines.forEach(line)
    },
    end(): { usage?: Usage; content: Content } {
      if (streamed) return { usage, content }
      try {
        const b = JSON.parse(buf)
        return { usage: usageOf(b.usage), content }
      } catch {
        return { content }
      }
    },
  }
}

function reply(text: string, model: string, stream: boolean, context: number): string {
  const id = `chatcmpl-proxy-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const usage = { prompt_tokens: context, completion_tokens: 0, total_tokens: context, prompt_tokens_details: { cached_tokens: context } }
  if (!stream) return JSON.stringify({ id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage })
  const chunk = (choices: unknown[], extra = {}) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })}\n\n`
  return chunk([{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]) + chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]) + chunk([], { usage }) + 'data: [DONE]\n\n'
}

// OpenCode's tools, as its 2.x requests name them: edit's and write's text, and
// shell for shell commands. Its skill tool is left a plain tool until we see
// what its result holds; it has no tool-loading tool.
export const OPENCODE: Conventions = {
  kinds: {},
  stubbedInputs: { edit: ['oldString', 'newString'], write: ['content'] },
  shell: 'shell',
}

export const CHAT: Protocol = {
  name: 'chat',
  serves: (p) => p === '/v1/chat/completions' || p === '/chat/completions',
  canonical,
  conversationId,
  usageReader,
  reply,
  error: (status, message) => JSON.stringify({ error: { message, type: status === 403 ? 'permission_error' : status === 400 ? 'invalid_request_error' : 'api_error', code: status } }),
  automatic: true,
  conventions: OPENCODE,
  defers: false,
  forks: false,
}

// Anthropic's Messages protocol (/v1/messages), as Claude Code speaks it: the
// core's own shape, so a request is the core's as it comes (protocol.ts).

import type { IncomingHttpHeaders } from 'node:http'
import { reply } from './command.ts'
import type { Usage } from './cost.ts'
import { CLAUDE_CODE, type ApiMsg, type Block } from './items.ts'
import { eventReader, sessionConversation, type Canonical, type Content, type Protocol } from './protocol.ts'
import { summaryForkMessages } from './summary.ts'

// A conversation's ID. Claude Code sends the session ID with every request,
// and an agent ID (x-claude-code-agent-id) with each subagent's; the main loop
// sends none. But one agent can still send several histories: a WebSearch call
// is its own one-message request, and a compaction (/compact, or the automatic
// one) replaces the history with a summary and carries on from that. So the ID
// also takes a hash of the first message, which changes exactly when the
// history is a new one.
//
// The session ID keeps apart sessions whose first message is the same, as
// happens when two start with `:shaver info` in the same repo state: once the
// command is stripped, all that is left of it is the same reminders. Without a
// session ID (other clients), the first message is the ID alone.
function conversationId(c: Canonical, headers: IncomingHttpHeaders): string {
  const agent = headers['x-claude-code-agent-id'] as string | undefined
  let session: string | undefined
  try {
    session = JSON.parse((c.metadata as { user_id?: string } | undefined)?.user_id ?? '{}').session_id
  } catch {}
  return sessionConversation('claude', c, [session && `${session}-${agent ?? 'main'}`])
}

// The usage a response reports: message_start's, with message_delta's output
// tokens, for a stream; the body's for a plain response. Also its content's
// lengths: each thinking block's signature and the characters of everything
// else.
function usageReader() {
  let usage: Usage | undefined
  const content: Content = { signatures: [], visibleChars: 0 }
  return eventReader({
    event(e) {
      if (e.type === 'message_start') usage = { ...e.message?.usage }
      if (e.type === 'message_delta' && usage && e.usage?.output_tokens !== undefined) usage.output_tokens = e.usage.output_tokens
      if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') content.signatures.push('')
      if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') content.visibleChars += JSON.stringify(e.content_block.name).length
      if (e.type === 'content_block_delta') {
        const d = e.delta ?? {}
        if (d.type === 'signature_delta' && content.signatures.length) content.signatures[content.signatures.length - 1] += d.signature
        if (d.type === 'text_delta') content.visibleChars += d.text.length
        if (d.type === 'input_json_delta') content.visibleChars += d.partial_json.length
      }
    },
    body(b) {
      for (const c of b.content ?? [])
        if (c.type === 'thinking') content.signatures.push(c.signature ?? '')
        else content.visibleChars += c.type === 'text' ? c.text.length : c.type === 'tool_use' ? JSON.stringify(c.name).length + JSON.stringify(c.input).length : 0
      usage = b.usage
    },
    result: () => ({ usage, content }),
    final: (e) => e.type === 'message_stop',
  })
}

const errorType = (status: number) => (status === 403 ? 'permission_error' : status === 400 ? 'invalid_request_error' : 'api_error')

export const MESSAGES: Protocol = {
  name: 'messages',
  serves: (p) => p === '/v1/messages',
  canonical: (wire) => ({ body: wire as Canonical, render: (c) => c }),
  conversationId,
  usageReader,
  reply,
  error: (status, message) => JSON.stringify({ type: 'error', error: { type: errorType(status), message } }),
  limits: /^anthropic-ratelimit-unified-/,
  automatic: false,
  conventions: CLAUDE_CODE,
  defers: true,
  summaryFork: (sent, text) => ({ ...sent, messages: summaryForkMessages(sent.messages as ApiMsg[], text), stream: false }),
  summaryForkAnswer: (body) => {
    const o = JSON.parse(body) as { content?: Block[]; usage?: Usage }
    return { content: o.content ?? [], usage: o.usage }
  },
}

// What the proxy needs from each wire protocol it speaks (DESIGN.md,
// "Protocols"). The core trims, prices and journals one message model, the
// Messages shape (items.ts); a protocol turns its requests into that and back,
// and supplies what only it knows: how a conversation is named, what a
// response's usage is, and how an answer made here looks.

import type { IncomingHttpHeaders } from 'node:http'
import type { Usage } from './cost.ts'
import type { ApiMsg, Block, Conventions } from './items.ts'
import { hash } from './log.ts'
import type { Tool } from './stats.ts'

// A request in the core's shape. Fields the core doesn't read ride along.
// `provider` is the one it pins behind a router, which prices it (models.ts).
export type Canonical = { model: string; provider?: string; messages: ApiMsg[]; system?: unknown; tools?: Tool[]; stream?: boolean; [k: string]: unknown }

// A response's thinking blocks' signatures and the characters of everything
// else, for what its thinking bills (server.ts, thinkingOf).
export type Content = { signatures: string[]; visibleChars: number }

// done is whether the answer has fully arrived, whatever the stream still sends
// after it.
export type UsageReader = { push(chunk: Uint8Array): void; end(): { usage?: Usage; content: Content }; readonly done: boolean }

// A response read as it arrives: each event of a stream, or the body when it
// isn't streamed, then what was read. The answer is done at the event final
// picks out, or at a stream's closing data: [DONE].
export function eventReader(read: { event(e: any): void; body(b: any): void; result(): { usage?: Usage; content: Content }; final?(e: any): boolean }): UsageReader {
  let buf = ''
  let streamed = false
  let done = false
  const dec = new TextDecoder()
  const line = (l: string) => {
    if (!l.startsWith('data: ')) return
    streamed = true
    if (l.slice(6).trim() === '[DONE]') return void (done = true)
    try {
      const e = JSON.parse(l.slice(6))
      read.event(e)
      if (read.final?.(e)) done = true
    } catch {}
  }
  return {
    get done() {
      return done
    },
    push(chunk) {
      buf += dec.decode(chunk, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      lines.forEach(line)
    },
    end() {
      if (!streamed)
        try {
          read.body(JSON.parse(buf))
        } catch {}
      return read.result()
    },
  }
}

// What OpenAI's APIs count as input is the uncached, read and written tokens
// together; the core counts them apart.
export const openaiUsage = (input: number, read: number, written: number, output: number): Usage => ({ input_tokens: input - read - written, cache_read_input_tokens: read, cache_creation_input_tokens: written, output_tokens: output })

// An OpenAI client's conversation: its session, the first of the values that
// may name it, and its first message, which changes when the client compacts
// the history into a new one (messages.ts).
export function sessionConversation(prefix: string, c: Canonical, names: unknown[]): string {
  const session = names.find((v) => typeof v === 'string' && v)
  return `${prefix}-${session ? `${session}-` : ''}${hash(JSON.stringify(c.messages[0])).slice(0, 8)}`
}

export const openaiError = (status: number, message: string) => JSON.stringify({ error: { message, type: status === 403 ? 'permission_error' : status === 400 ? 'invalid_request_error' : 'api_error', code: status } })

export type Protocol = {
  name: 'messages' | 'chat' | 'responses'
  // Whether a request path is this protocol's, after any /via/ (via.ts).
  serves(path: string): boolean
  // The request as the core's, and how to put the core's back on the wire:
  // every message the core left as it was is sent as it came, byte for byte,
  // or the cache misses.
  canonical(wire: Record<string, unknown>): { body: Canonical; render(c: Canonical): unknown }
  // The core's requirement: one ID per conversation, the same on each of its
  // requests and on no other conversation's (server.ts, keyOf).
  conversationId(c: Canonical, headers: IncomingHttpHeaders): string
  usageReader(): UsageReader
  // A response holding just `text`, as Claude Code's `:shaver` answers are made
  // (command.ts), with `context` reported as the input read.
  reply(text: string, model: string, stream: boolean, context: number): string
  error(status: number, message: string): string
  // Headers of the account's usage limits, replayed on answers made here.
  limits?: RegExp
  // Whether the provider caches each request's prefix by itself, rather than
  // where breakpoints are marked (trim.ts, positionsOf).
  automatic: boolean
  conventions: Conventions
  // Whether tools can be deferred (defer.ts).
  defers: boolean
  // A heavy-compaction summary fork (summary.ts): the request as sent, with
  // `text` asked after its messages, so it reads the request's cache entry, and
  // not streamed where the API allows; and the summary fork's answer, from the
  // response's body, as blocks, with its usage.
  summaryFork(sent: Record<string, unknown>, text: string): Record<string, unknown>
  summaryForkAnswer(body: string): { content: Block[]; usage?: Usage }
}

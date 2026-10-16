// What the proxy needs from each wire protocol it speaks (DESIGN.md,
// "Protocols"). The core trims, prices and journals one message model, the
// Messages shape (items.ts); a protocol turns its requests into that and back,
// and supplies what only it knows: how a conversation is named, what a
// response's usage is, and how an answer made here looks.

import type { IncomingHttpHeaders } from 'node:http'
import type { Usage } from './cost.ts'
import type { ApiMsg, Block, Conventions } from './items.ts'
import type { Tool } from './stats.ts'

// A request in the core's shape. Fields the core doesn't read ride along.
// `provider` is the one it pins behind a router, which prices it (models.ts).
export type Canonical = { model: string; provider?: string; messages: ApiMsg[]; system?: unknown; tools?: Tool[]; stream?: boolean; [k: string]: unknown }

// A response's thinking blocks' signatures and the characters of everything
// else, for what its thinking bills (server.ts, thinkingOf).
export type Content = { signatures: string[]; visibleChars: number }

export type UsageReader = { push(chunk: Uint8Array): void; end(): { usage?: Usage; content: Content } }

export type Protocol = {
  name: 'messages' | 'chat'
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
  limitPrefix?: string
  // Whether the provider caches each request's prefix by itself, rather than
  // where breakpoints are marked (trim.ts, positionsOf).
  automatic: boolean
  conventions: Conventions
  // Whether tools can be deferred (defer.ts).
  defers: boolean
  // A heavy-compaction summary fork (summary.ts): the request as sent, not
  // streamed, with `text` asked after its messages, so it reads the request's
  // cache entry; and the summary fork's answer as blocks, with its usage.
  summaryFork(sent: Record<string, unknown>, text: string): Record<string, unknown>
  summaryForkAnswer(out: unknown): { content: Block[]; usage?: Usage }
}

// What the proxy needs from each wire protocol it speaks (DESIGN.md,
// "Protocols"). The core trims, prices and journals one message model, the
// Messages shape (items.ts); a protocol turns its requests into that and back,
// and supplies what only it knows: what a response's usage is, and how an
// answer made here looks. What the client sending it knows is its harness's
// (harness.ts).

import type { Usage } from './cost.ts'
import type { ApiMsg, Block } from './items.ts'
import type { Tool } from './stats.ts'

// A request in the core's shape. Fields the core doesn't read ride along.
// `provider` is the one it pins behind a router, which prices it (models.ts).
export type Canonical = { model: string; provider?: string; messages: ApiMsg[]; system?: unknown; tools?: Tool[]; stream?: boolean; [k: string]: unknown }

// A response's thinking blocks' signatures and the characters of everything
// else, for what its thinking bills (server.ts, thinkingOf).
export type Content = { signatures: string[]; visibleChars: number }

// done is whether the answer has fully arrived, whatever the stream still sends
// after it. attribution is the usage per input item, as the Responses API
// gives it, kept for the log.
export type Read = { usage?: Usage; content: Content; attribution?: unknown }
export type UsageReader = { push(chunk: Uint8Array): void; end(): Read; readonly done: boolean }

// A stream passed on as it arrives but for its close, which is held so text
// can be added before it: ended is whether the response ends the turn, add
// the events that add text to it, and rest what is held, to write after them.
export type Held = { push(chunk: Uint8Array): void; readonly ended: boolean; add(text: string): string; rest(): string }

// A response made here, in parts so a stream can show text before the rest is
// known: start, then text for each piece in turn, then end with all the text.
// A plain response is all in end.
export type Replying = { start: string; text(piece: string): string; end(all: string): string }

export const wholeReply = (r: Replying, text: string): string => r.start + r.text(text) + r.end(text)

// A stream's events written as they arrive, each seen, until the first that
// closes it: that one and all after it are held, for rest.
export function holding(write: (s: string) => void, see: (e: any) => void, closes: (e: any) => boolean): Pick<Held, 'push' | 'rest'> {
  const dec = new TextDecoder()
  let buf = ''
  let held = ''
  return {
    push(chunk) {
      buf += dec.decode(chunk, { stream: true })
      const events = buf.split('\n\n')
      buf = events.pop() ?? ''
      for (const e of events) {
        const data = e.split('\n').find((l) => l.startsWith('data: '))
        let o: unknown
        try {
          o = data && JSON.parse(data.slice(6))
        } catch {}
        if (o && typeof o === 'object') see(o)
        if (held || (o && typeof o === 'object' && closes(o))) held += e + '\n\n'
        else write(e + '\n\n')
      }
    },
    rest: () => held + buf,
  }
}

// A response read as it arrives: each event of a stream, or the body when it
// isn't streamed, then what was read. The answer is done at the event final
// picks out, or at a stream's closing data: [DONE].
export function eventReader(read: { event(e: any): void; body(b: any): void; result(): Read; final?(e: any): boolean }): UsageReader {
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

export const openaiError = (status: number, message: string) => JSON.stringify({ error: { message, type: status === 403 ? 'permission_error' : status === 400 ? 'invalid_request_error' : 'api_error', code: status } })

// What the API counted, from its usage per input item: the head's tokens and
// each message's, where it counted every item of it, with those tokens by
// kind (log.ts, kinds), and what each reasoning item sent back cost, by its
// encrypted content.
export type Counted = { head?: number; messages: Array<number | undefined>; kinds: Array<Record<string, number> | undefined>; reasoning: Map<string, number> }

export type Wire = { body: Canonical; render(c: Canonical): unknown; ids?: { head: string[]; of(m: ApiMsg): string[] }; counted?(msgs: readonly ApiMsg[], attribution: unknown): Counted | undefined }

export type Protocol = {
  name: 'messages' | 'chat' | 'responses'
  // Whether a request path is this protocol's, after any /via/ (via.ts).
  serves(path: string): boolean
  // The request as the core's, and how to put the core's back on the wire:
  // every message the core left as it was is sent as it came, byte for byte,
  // or the cache misses. Where the wire names its items, as Responses does,
  // ids gives the names: the head's (system and tools) and a message's, as
  // sent, for the log to match the API's usage per item (log.ts), and counted
  // reads that usage, for the stats and the cache model to use over estimates.
  canonical(wire: Record<string, unknown>): Wire
  usageReader(): UsageReader
  // A response holding just text, as Claude Code's `:shaver` answers are made
  // (command.ts), with `context` reported as the input read.
  replying(model: string, stream: boolean, context: number): Replying
  // A stream held at its close, for the answers to commands sent mid-turn.
  holdClose(write: (s: string) => void): Held
  error(status: number, message: string): string
  // Headers of the account's usage limits, replayed on answers made here.
  limits?: RegExp
  // Whether the provider caches each request's prefix by itself, rather than
  // where breakpoints are marked (trim.ts, positionsOf).
  automatic: boolean
  // Whether tools can be deferred (defer.ts), for a harness that loads them
  // (harness.ts).
  defers: boolean
  // A heavy-compaction summary fork (summary.ts): the request as sent, with
  // `text` asked after its messages, so it reads the request's cache entry, and
  // not streamed where the API allows; and the summary fork's answer, from the
  // response's body, as blocks, with its usage.
  summaryFork(sent: Record<string, unknown>, text: string): Record<string, unknown>
  summaryForkAnswer(body: string): { content: Block[]; usage?: Usage }
}

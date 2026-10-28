// `:shaver info`, `:shaver info all`, `:shaver policy` and `:shaver optimize`,
// typed as a prompt, are answered by the proxy and never reach the model, nor
// does the `y` or `n` answering `:shaver optimize`'s reply. Claude Code keeps the command and the proxy's
// reply in its history and sends them again with every
// later request, so the proxy strips each command, the system messages after
// it and the reply from every request it forwards. Dropping them leaves what
// came before next to what came after, a prompt or the end, so no system
// message is left after an assistant one. A command the model answered instead, with a tool call, stays,
// since dropping the call would orphan its result. A prompt can come with blocks
// that open with a tag: `<system-reminder>` with the instructions and context on
// a first prompt, a local command's `<command-name>` and its output, a `!`
// command's `<bash-input>` and output. They don't stop it being a command, and
// stripping it keeps them, so the model still reads them with the next prompt. A
// breakpoint on a stripped message moves to the message before it: Claude
// Code's prompt suggestion puts one on the last reply, and when that is the
// proxy's, the suggestion would otherwise read only the system prompt.
//
// A command sent while the model works is one the harness adds to the turn.
// Claude Code wraps it in MID_TURN's words: as the last block of the next user
// message, the one with the tool results, or from 2.1.312 as a system message
// after it. Codex and OpenCode send it as it was typed, a user message right
// after the tool results (`steeredAt`). That block or message is taken out of
// every request, so the model never sees it, and the command is answered at
// the turn's end (server.ts), as text added to the turn's last response,
// opening with `answeredMidTurn`'s words (the protocol's `holdClose`). That
// text is taken out of every later request too.

import { holding, type Held } from './protocol.ts'

export const COMMANDS = [':shaver info', ':shaver info all', ':shaver policy', ':shaver optimize']

// The answers to `:shaver optimize`, as the commands they are.
const ANSWERS: Record<string, string> = { y: ':shaver optimize yes', yes: ':shaver optimize yes', n: ':shaver optimize no', no: ':shaver optimize no' }

type Block = { type: string; text?: string; content?: unknown; cache_control?: unknown }
type Msg = { role: string; content: string | Block[] }

const marked = (m: Msg) => Array.isArray(m.content) && m.content.some((b) => b.cache_control !== undefined)

// The message with `control` on its last block that can carry one: thinking
// blocks can't.
function withControl<M extends Msg>(m: M, control: unknown): M {
  const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
  const at = content.findLastIndex((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')
  if (at < 0 || content[at].cache_control !== undefined) return m
  return { ...m, content: content.map((b, i) => (i === at ? { ...b, cache_control: control } : b)) }
}

// Any tag, so ones Claude Code adds later need no change here.
const isTagged = (b: Block) => b.type === 'text' && /^<[A-Za-z][\w-]*>/.test((b.text ?? '').trimStart())

// A user message's only text besides tagged blocks, trimmed, if it has one.
function promptOf(m: Msg): string | undefined {
  if (m.role !== 'user') return undefined
  const texts = typeof m.content === 'string' ? [m.content] : m.content.filter((b) => b.type === 'text' && !isTagged(b)).map((b) => b.text ?? '')
  return texts.length === 1 ? texts[0].trim() : undefined
}

// `text` split into words as a shell would: on whitespace, with a quoted run,
// single or double, kept as part of one word. Undefined if a quote is left open.
export function wordsOf(text: string): string[] | undefined {
  const words: string[] = []
  for (const m of text.matchAll(/(?:[^\s'"]+|'[^']*'|"[^"]*")+|(['"])/g)) {
    if (m[1]) return undefined
    words.push(m[0].replace(/'([^']*)'|"([^"]*)"/g, (_, single, double) => single ?? double))
  }
  return words
}

// The command a message is, if any: a user message whose only text, besides
// tagged blocks, is one. The colon is optional, and space may follow it, so
// `shaver info` and `: shaver info` count; the words after `shaver` are split
// by `wordsOf`. After `:shaver optimize`'s reply (`offered`), `y`, `yes`, `n` or
// `no` is one too.
export function commandOf(m: Msg, offered = false): string | undefined {
  const text = promptOf(m)
  if (text === undefined) return undefined
  const words = /^:?\s*shaver(?:\s|$)/.test(text) ? wordsOf(text.replace(/^:?\s*shaver/, '')) : undefined
  return COMMANDS.find((c) => words?.join('\0') === c.split(' ').slice(1).join('\0')) ?? (offered ? ANSWERS[text.toLowerCase()] : undefined)
}

const MID_TURN = /^The user sent a new message while you were working:\n([\s\S]*)\n\nThis is how Claude Code surfaces messages the user sends mid-turn\b/

// The command a block is, if it holds a message sent mid-turn that is one.
function midTurnOf(b: Block): string | undefined {
  const m = b.type === 'text' ? MID_TURN.exec(b.text ?? '') : null
  return m ? commandOf({ role: 'user', content: m[1] }) : undefined
}

// How the answer to a command sent mid-turn opens. Added to text the model
// wrote, as Chat Completions does, it follows a blank line.
export const answeredMidTurn = (command: string) => `[shaver] \`${command.slice(1)}\`, sent mid-turn:\n\n`
const ANSWERED = /(?:^|\n\n)\[shaver\] `shaver [^`\n]*`, sent mid-turn:\n/

const blocksOf = (m: Msg): Block[] => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content)

// OpenCode's result for a tool the user interrupted: the prompt after it is
// the next turn's, though it comes right after the results too.
const interrupted = (b: Block) => typeof b.content === 'string' && b.content.startsWith('{"error":{"type":"aborted"')

// Whether `msgs[i]` is a prompt Codex or OpenCode sent mid-turn: a user
// message right after one of tool results, none interrupted. Codex puts a
// `<turn_aborted>` message between them when the user interrupts.
function steeredAt(msgs: Msg[], i: number): boolean {
  const before = msgs[i - 1]
  if (msgs[i].role !== 'user' || before?.role !== 'user' || !Array.isArray(before.content) || !before.content.length) return false
  return before.content.every((b) => b.type === 'tool_result' && !interrupted(b))
}

// The commands sent mid-turn that the request's newest message brings: in its
// blocks or, from Claude Code 2.1.312, in system messages after it, or the
// message itself from Codex or OpenCode.
export function midTurnCommands(msgs: Msg[]): string[] {
  const i = msgs.findLastIndex((m) => m.role !== 'system')
  if (msgs[i]?.role !== 'user') return []
  const steered = steeredAt(msgs, i) ? commandOf(msgs[i]) : undefined
  if (steered) return [steered]
  return msgs.slice(i).flatMap(blocksOf).map(midTurnOf).filter((c) => c !== undefined)
}

// The message without commands sent mid-turn and the answers added for them,
// and the breakpoint on one taken out. An answer added to the model's text is
// cut from it. A user or assistant message they would leave empty stays as it
// is; a system message goes.
function withoutMidTurn<M extends Msg>(m: M): { m?: M; control?: unknown } {
  const blocks = blocksOf(m)
  const at = (b: Block) => (m.role === 'assistant' && b.type === 'text' ? ANSWERED.exec(b.text ?? '')?.index : undefined)
  const gone = (b: Block) => (m.role === 'assistant' ? at(b) === 0 : midTurnOf(b) !== undefined)
  const kept = blocks.filter((b) => !gone(b)).map((b) => (at(b) ? { ...b, text: (b.text ?? '').slice(0, at(b)) } : b))
  if (kept.every((b, i) => b === blocks[i]) && kept.length === blocks.length) return { m }
  if (!kept.length && m.role !== 'system') return { m }
  return { m: kept.length ? { ...m, content: kept } : undefined, control: blocks.find((b) => gone(b) && b.cache_control !== undefined)?.cache_control }
}

// Whether `msgs[i]` comes right after `:shaver optimize` and its reply, the
// system messages aside, or after a turn that ended with its answer.
function offeredAt(msgs: Msg[], i: number): boolean {
  const r = msgs.findLastIndex((m, j) => j < i && m.role !== 'system')
  const c = msgs.findLastIndex((m, j) => j < r && m.role !== 'system')
  if (r < 0 || msgs[r].role !== 'assistant') return false
  const last = Array.isArray(msgs[r].content) ? (msgs[r].content as Block[]).at(-1) : undefined
  const said = last?.type === 'text' ? (last.text ?? '') : ''
  const answer = answeredMidTurn(':shaver optimize')
  return (c >= 0 && commandOf(msgs[c]) === ':shaver optimize') || said.startsWith(answer) || said.includes('\n\n' + answer)
}

// The command a request asks for: its last message but for the system messages
// after it, which Claude Code sends after a session's first prompt. One sent
// mid-turn waits for the turn's end.
export function pendingCommand(msgs: Msg[]): string | undefined {
  const i = msgs.findLastIndex((m) => m.role !== 'system')
  return i >= 0 && !steeredAt(msgs, i) ? commandOf(msgs[i], offeredAt(msgs, i)) : undefined
}

// The messages with the pending command left out but for its tagged blocks, as
// they will be sent once it is answered.
export function withoutPending<M extends Msg>(msgs: M[]): M[] {
  const i = msgs.findLastIndex((m) => m.role !== 'system')
  const tagged = Array.isArray(msgs[i].content) ? (msgs[i].content as Block[]).filter(isTagged) : []
  return [...msgs.slice(0, i), ...(tagged.length ? [{ ...msgs[i], content: tagged }] : []), ...msgs.slice(i + 1)]
}

// The messages with each answered command and its reply removed, but for any
// tagged blocks the command came with. The system messages between them are kept,
// moved to just before the next reply (or to the end): on a first prompt they
// are Claude Code's whole preamble, and the API refuses a system message right
// before a user one. A command not yet answered, the last one, stays. Commands
// sent mid-turn and their answers go, the last ones too.
export function stripCommands<M extends Msg>(msgs: M[]): M[] {
  const out: M[] = []
  let moved: M[] = []
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'assistant') {
      out.push(...moved)
      moved = []
    }
    const steered = steeredAt(msgs, i) && commandOf(msgs[i]) !== undefined
    if (steered || !commandOf(msgs[i], offeredAt(msgs, i))) {
      // A breakpoint on what goes moves to the block before it.
      const { m, control } = steered ? { control: blocksOf(msgs[i]).find((b) => b.cache_control !== undefined)?.cache_control } : withoutMidTurn(msgs[i])
      if (m) out.push(m)
      if (control !== undefined && out.length) out[out.length - 1] = withControl(out[out.length - 1], control)
      continue
    }
    let j = i + 1
    while (j < msgs.length && msgs[j].role === 'system') j++
    const r = msgs[j]
    if (r?.role === 'assistant' && !(Array.isArray(r.content) && r.content.some((b) => b.type === 'tool_use'))) {
      const tagged = Array.isArray(msgs[i].content) ? (msgs[i].content as Block[]).filter(isTagged) : []
      if (tagged.length) out.push({ ...msgs[i], content: tagged })
      const control = [msgs[i], r].filter(marked).flatMap((m) => m.content as Block[]).find((b) => b.cache_control !== undefined)?.cache_control
      const k = out.findLastIndex((m) => m.role !== 'system')
      if (control !== undefined && k >= 0) out[k] = withControl(out[k], control)
      moved.push(...msgs.slice(i + 1, j))
      i = j
    } else out.push(msgs[i])
  }
  return [...out, ...moved]
}

// A response holding just `text`, as a stream of events or a plain message.
// No model ran, but Claude Code reads its context size from the last reply's
// usage, so `context` (the latest real request's input) is reported as cache
// reads, the input that adds least to its cost tally.
export function reply(text: string, model: string, stream: boolean, context: number): string {
  const usage = { input_tokens: 0, cache_read_input_tokens: context, output_tokens: 0 }
  const message = { id: `msg_proxy_${Date.now()}`, type: 'message', role: 'assistant', model, stop_sequence: null, usage }
  if (!stream) return JSON.stringify({ ...message, content: [{ type: 'text', text }], stop_reason: 'end_turn' })
  return [
    sse({ type: 'message_start', message: { ...message, content: [], stop_reason: null } }),
    textBlock(text, 0),
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }),
    sse({ type: 'message_stop' }),
  ].join('')
}

const sse = (e: Record<string, unknown>) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`

// A text block's events, as block `index` of a stream.
export const textBlock = (text: string, index: number) =>
  [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index },
  ]
    .map(sse)
    .join('')

// A Messages stream held from message_delta on, which ends the turn when its
// stop reason is end_turn. Text added is a block of its own.
export function closeHeld(write: (s: string) => void): Held {
  let last = -1
  let stop: unknown
  const see = (o: { type?: string; index?: number; delta?: { stop_reason?: unknown } }) => {
    if (o.type === 'content_block_start' && typeof o.index === 'number') last = Math.max(last, o.index)
    if (o.type === 'message_delta') stop = o.delta?.stop_reason
  }
  const h = holding(write, see, (o) => o.type === 'message_delta')
  return {
    ...h,
    get ended() {
      return stop === 'end_turn'
    },
    add: (text) => textBlock(text, ++last),
  }
}

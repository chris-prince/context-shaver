// `:shaver info`, `:shaver info all`, `:shaver policy` and `:shaver optimize`
// (with `apply` or `apply now`), typed as a prompt, are answered by the proxy
// and never reach the model. Claude Code keeps the command and the proxy's
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

export const COMMANDS = [':shaver info', ':shaver info all', ':shaver policy', ':shaver optimize', ':shaver optimize apply', ':shaver optimize apply now']

type Block = { type: string; text?: string; cache_control?: unknown }
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

// The command a message is, if any: a user message whose only text, besides
// tagged blocks, is one. `: shaver` counts as `:shaver`.
export function commandOf(m: Msg): string | undefined {
  if (m.role !== 'user') return undefined
  const texts = typeof m.content === 'string' ? [m.content] : m.content.filter((b) => b.type === 'text' && !isTagged(b)).map((b) => b.text ?? '')
  return texts.length === 1 ? COMMANDS.find((c) => c === texts[0].trim().replace(/^: shaver/, ':shaver')) : undefined
}

// The command a request asks for: its last message but for the system messages
// after it, which Claude Code sends after a session's first prompt.
export function pendingCommand(msgs: Msg[]): string | undefined {
  const last = msgs.findLast((m) => m.role !== 'system')
  return last && commandOf(last)
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
// before a user one. A command not yet answered, the last one, stays.
export function stripCommands<M extends Msg>(msgs: M[]): M[] {
  const out: M[] = []
  let moved: M[] = []
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'assistant') {
      out.push(...moved)
      moved = []
    }
    if (!commandOf(msgs[i])) {
      out.push(msgs[i])
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
  const events: Record<string, unknown>[] = [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } },
    { type: 'message_stop' },
  ]
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

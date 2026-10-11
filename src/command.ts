// `:shaver stats` and `:shaver policy`, typed as a prompt, are answered by the
// proxy and never reach the model. Claude Code keeps the command and the
// proxy's reply in its history and sends them again with every later request,
// so the proxy strips each command, the system messages after it and the reply
// from every request it forwards. Dropping them leaves what came before next to
// what came after, a prompt or the end, so no system message is left after an
// assistant one. A command the model answered instead, with a tool call, stays,
// since dropping the call would orphan its result. The first prompt of a session
// comes with `<system-reminder>` blocks holding the instructions and context;
// they don't stop it being a command, and stripping it keeps them.

export const COMMANDS = [':shaver stats', ':shaver policy']

type Block = { type: string; text?: string }
type Msg = { role: string; content: string | Block[] }

const isReminder = (b: Block) => b.type === 'text' && (b.text ?? '').trimStart().startsWith('<system-reminder>')

// The command a message is, if any: a user message whose only text, besides
// reminders, is one.
export function commandOf(m: Msg): string | undefined {
  if (m.role !== 'user') return undefined
  const texts = typeof m.content === 'string' ? [m.content] : m.content.filter((b) => b.type === 'text' && !isReminder(b)).map((b) => b.text ?? '')
  return texts.length === 1 ? COMMANDS.find((c) => c === texts[0].trim()) : undefined
}

// The command a request asks for: its last message but for the system messages
// after it, which Claude Code sends after a session's first prompt.
export function pendingCommand(msgs: Msg[]): string | undefined {
  const last = msgs.findLast((m) => m.role !== 'system')
  return last && commandOf(last)
}

// The messages with each answered command, the system messages after it and
// its reply removed, but for any reminders the command came with. A command not
// yet answered, the last one, stays.
export function stripCommands<M extends Msg>(msgs: M[]): M[] {
  const out: M[] = []
  for (let i = 0; i < msgs.length; i++) {
    if (!commandOf(msgs[i])) {
      out.push(msgs[i])
      continue
    }
    let j = i + 1
    while (j < msgs.length && msgs[j].role === 'system') j++
    const r = msgs[j]
    if (r?.role === 'assistant' && !(Array.isArray(r.content) && r.content.some((b) => b.type === 'tool_use'))) {
      const reminders = Array.isArray(msgs[i].content) ? (msgs[i].content as Block[]).filter(isReminder) : []
      if (reminders.length) out.push({ ...msgs[i], content: reminders })
      i = j
    } else out.push(msgs[i])
  }
  return out
}

// A response holding just `text`, as a stream of events or a plain message,
// with no usage, since no model ran.
export function reply(text: string, model: string, stream: boolean): string {
  const message = { id: `msg_proxy_${Date.now()}`, type: 'message', role: 'assistant', model, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
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

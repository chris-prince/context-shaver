// `:shaver stats`, typed as a prompt, is answered by the proxy and never
// reaches the model. Claude Code keeps the command and the proxy's reply in its
// history and sends them again with every later request, so the proxy strips
// each command, the system messages after it and the reply from every request
// it forwards. Dropping them leaves what came before next to what came after,
// a prompt or the end, so no system message is left after an assistant one.

export const COMMAND = ':shaver stats'

type Block = { type: string; text?: string }
type Msg = { role: string; content: string | Block[] }

// Whether a message is the command: a user message whose only text is it.
export function isCommand(m: Msg): boolean {
  if (m.role !== 'user') return false
  const texts = typeof m.content === 'string' ? [m.content] : m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '')
  return texts.length === 1 && texts[0].trim() === COMMAND
}

// The messages with each answered command, the system messages after it and
// its reply removed. A command not yet answered, the last one, stays.
export function stripCommands<M extends Msg>(msgs: M[]): M[] {
  const out: M[] = []
  for (let i = 0; i < msgs.length; i++) {
    if (!isCommand(msgs[i])) {
      out.push(msgs[i])
      continue
    }
    let j = i + 1
    while (j < msgs.length && msgs[j].role === 'system') j++
    if (j < msgs.length && msgs[j].role === 'assistant') i = j
    else out.push(msgs[i])
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

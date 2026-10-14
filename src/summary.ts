// Heavy compaction: a conversation's early turns replaced with a record of
// their memorable events (local/notes.md, "Heavy compaction").
//
// Making a record is kept apart from applying it. Once a request leaves
// `summarize_after_tokens` (policy.ts) uncovered, the proxy forks it after it is
// answered: the same request with instructions appended, which reads its cache
// entry and pays only for the instructions and the record. A record covers only
// complete arcs, so it ends where some turn starts, and the next fork asks from
// there on. Records are applied when the cache is cold, when everything is
// written anyway, and every request after sends the same.

import { blocks, isPrompt, SUMMARY_HEAD, type ApiMsg, type Block } from './items.ts'
import { hash } from './log.ts'
import { sizeOf, TEXT_TOKENS, type Applied, type Thinking } from './trim.ts'

// A record, ending before the turn whose prompt has this hash.
export type Summary = { endsBefore: number; prompt: string; text: string; time: string }

// The cache_control a prompt carries moves from request to request, so a
// prompt is known by the rest.
const promptHash = (m: ApiMsg) => hash(JSON.stringify(m, (k, v) => (k === 'cache_control' ? undefined : v)))

// Each turn's prompt index, by turn: prompts[t - 1] starts turn t.
const promptsOf = (msgs: readonly ApiMsg[]) => msgs.flatMap((m, i) => (isPrompt(m) ? [i] : []))

// The records that still fit the messages: each one's prompt is still there.
// One that doesn't (the conversation was rewound) goes with the ones after it.
export function validChain(chain: readonly Summary[], msgs: readonly ApiMsg[]): Summary[] {
  const prompts = promptsOf(msgs)
  const n = chain.findIndex((s) => {
    const i = prompts[s.endsBefore - 1]
    return i === undefined || promptHash(msgs[i]) !== s.prompt
  })
  return n < 0 ? [...chain] : chain.slice(0, n)
}

// The index of the first message each record covers: the first response for
// the first record, and the prompt its predecessor ends before for the rest.
export function startsOf(msgs: readonly ApiMsg[], chain: readonly Summary[]): number[] {
  const prompts = promptsOf(msgs)
  return chain.map((_, k) => (k ? prompts[chain[k - 1].endsBefore - 1] : msgs.findIndex((m) => m.role === 'assistant')))
}

// The messages with everything from the first response up to the last
// record's end replaced by the records, one assistant message each, oldest
// first. The messages before the first response (the preamble and the first
// prompt) stay. Assistant messages fit after them where a user one can't:
// they can end with a system message, which the API refuses before a user one.
export function summarized(a: Applied, msgs: readonly ApiMsg[], chain: readonly Summary[]): Applied {
  if (!chain.length) return a
  const starts = startsOf(msgs, chain)
  const to = promptsOf(msgs)[chain.at(-1)!.endsBefore - 1]
  const out: Applied = { msgs: [], origin: [], treated: a.treated }
  let placed = false
  a.msgs.forEach((m, j) => {
    const i = a.origin[j]
    if (i >= starts[0] && i < to) return
    if (i >= to && !placed) {
      chain.forEach((s, k) => (out.msgs.push({ role: 'assistant', content: [{ type: 'text', text: `${SUMMARY_HEAD}\n\n${s.text}` }] }), out.origin.push(starts[k])))
      placed = true
    }
    out.msgs.push(m), out.origin.push(i)
  })
  return out
}

// What a fork asks about: the turns from `start` (the last record's end, or
// the first) to the current one, each prompt quoted and hashed, and their
// characters in the messages as sent.
export type Fork = { start: number; current: number; prompts: Array<{ quote: string; hash: string }>; chars: number }

// The fork a request calls for: one when the turns completed since `from`
// (the turn the last fork was offered at, or the last record's end) hold at
// least `threshold` tokens in the messages as sent.
export function forkOf(a: Applied, msgs: readonly ApiMsg[], chain: readonly Summary[], offered: number, threshold: number, thinking: Thinking): Fork | undefined {
  const prompts = promptsOf(msgs)
  const current = prompts.length
  const start = chain.at(-1)?.endsBefore ?? 1
  const at = (t: number) => (t <= 1 ? msgs.findIndex((m) => m.role === 'assistant') : prompts[t - 1])
  const charsFrom = (t: number) =>
    a.msgs.reduce((n, m, j) => (a.origin[j] >= at(t) && a.origin[j] < prompts[current - 1] ? n + blocks(m).reduce((k, b) => k + sizeOf(b, thinking), 0) : n), 0)
  if (current <= start || at(1) < 0 || charsFrom(Math.max(start, Math.min(offered, current))) * TEXT_TOKENS < threshold) return
  const quote = (m: ApiMsg) => {
    const text = blocks(m).find((b: Block) => b.type === 'text' && !/^\s*<system-reminder>/.test(String(b.text)))?.text ?? '(an image)'
    const flat = String(text).replace(/\s+/g, ' ').trim()
    return flat.length > 100 ? flat.slice(0, 100) + '…' : flat
  }
  const turns = prompts.slice(start - 1, current).map((i) => ({ quote: quote(msgs[i]), hash: promptHash(msgs[i]) }))
  return { start, current, prompts: turns, chars: charsFrom(start) }
}

// The instructions a fork appends: local/prompts/arcs5.md, recast for a model
// compacting its own context rather than a transcript it is shown.
export function instructions(f: Fork): string {
  const list = f.prompts.map((p, k) => `[${f.start + k}] "${p.quote}"`)
  const current = list.pop()
  return `[ctx-shaver] This message is not from the user, and your answer will not be shown to them. Pause the task: don't call any tools, and answer with text only.

Compact the early part of this session into a record of its memorable events. Your record will replace the turns it covers in your context, so you can keep working from it and the messages that follow. ${f.start > 1 ? `Turns before [${f.start}] are already compacted; leave them out. ` : ''}Cover the turns that start with these prompts:

${list.join('\n')}

The latest prompt, still in progress:
${current}

Divide the work into arcs: stretches of the session spent on one goal, such as a feature, a bug hunt or a round of edits to one file. Keep the arcs in the order they happened. Give each arc a short title and, under it, terse bullets covering only its memorable points, told as they happened. Memorable points include:

- the goal that started the arc
- outcomes that landed: changes made, commits, results measured
- decisions the user made
- land mines: traps that were hit, such as a command that hung, a wrong assumption that looked right, or something the user had to correct

Tell each point as an event, not as a rule drawn from it. Write "I deleted \`old/\` without asking; the user had it restored (\`ed24806\`)", not "always ask before deleting". Report where things ended up rather than every step on the way, and leave out dead ends and intermediate versions unless they were land mines.

Stop at the last complete arc. If an arc is still in progress, leave it out entirely: it will be compacted later, once it is done.

End your record with one line naming the first turn your arcs do not cover:

Ends before: [<turn>]

If no arc is complete yet, answer with only that line, naming [${f.start}].

Your record must be at most a tenth the length of the turns it covers; the turns listed above, up to the latest, are about ${Math.round(f.chars).toLocaleString('en-US')} characters.

Keep exact identifiers you may need: paths, hashes, names, numbers, commands. Drop narration and tool output. Start directly with the first arc.`
}

// A fork's messages: the request's, with the instructions appended to the
// last message, which is the user's. They go after its blocks, so the prefix
// through its last breakpoint is the same and the fork reads its cache entry.
export function forkMessages(msgs: readonly ApiMsg[], text: string): ApiMsg[] {
  const last = msgs.at(-1)!
  return [...msgs.slice(0, -1), { ...last, content: [...blocks(last), { type: 'text', text }] }]
}

// The record a fork answered with, if it covers anything: its text without
// the closing line, ending before a turn after `start` and no later than the
// current one.
export function recordOf(content: readonly Block[], f: Fork, time: string): Summary | undefined {
  if (content.some((b) => b.type === 'tool_use')) return
  const text = content.filter((b) => b.type === 'text').map((b) => String(b.text)).join('')
  const m = [...text.matchAll(/^Ends before: \[(\d+)\]\s*$/gm)].at(-1)
  const n = Number(m?.[1])
  if (!m || n <= f.start || n > f.current) return
  const record = text.slice(0, m.index).trim()
  return record ? { endsBefore: n, prompt: f.prompts[n - f.start].hash, text: record, time } : undefined
}

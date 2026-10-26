// Heavy compaction: a conversation's early turns replaced with a record of
// their memorable events (local/notes.md, "Heavy compaction").
//
// Making a record is kept apart from applying it. Once a request leaves
// `summary_threshold_tokens` (policy.ts) uncovered, the proxy sends a summary
// fork of it after it is answered: the same request with instructions appended,
// which reads its cache entry and pays only for the instructions and the
// record. A record covers only complete arcs, so it ends where some turn
// starts, and the next summary fork asks from there on. Records are applied
// when the cache is cold, when everything is written anyway, and every request
// after sends the same.
//
// Once the records hold more than `memoir_threshold_tokens`, the oldest are
// merged into the memoir: their arcs' titles by date, one line each.

import { blocks, isPrompt, MEMOIR_FOOT, MEMOIR_HEAD, SUMMARY_HEAD, type ApiMsg, type Block } from './items.ts'
import { hash } from './log.ts'
import { sizeOf, type Applied, type Thinking } from './trim.ts'

// An arc of a record: the turn it starts at and its title, as the summary fork
// headed it, and when that turn's prompt was sent and the minutes to the arc's
// last request, where the stats know them.
export type Arc = { turn: number; title: string; time?: string; minutes?: number }

// A record, ending before the turn whose prompt has this hash; its arcs, if
// its headings read as arcs; and the output tokens its summary fork was billed.
export type Summary = { endsBefore: number; prompt: string; text: string; time: string; arcs?: Arc[]; tokens?: number }

// The cache_control a prompt carries moves from request to request, and the
// latest prompt comes as a block where later ones are a string, so a prompt is
// known by its blocks without it.
export const promptHash = (m: ApiMsg) => hash(JSON.stringify(typeof m.content === 'string' ? { ...m, content: [{ type: 'text', text: m.content }] } : m, (k, v) => (k === 'cache_control' ? undefined : v)))

// Each turn's prompt index, by turn: prompts[t - 1] starts turn t.
export const promptsOf = (msgs: readonly ApiMsg[]) => msgs.flatMap((m, i) => (isPrompt(m) ? [i] : []))

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
// The first `merged` records go as one message, the memoir, before the rest.
export function summarized(a: Applied, msgs: readonly ApiMsg[], chain: readonly Summary[], merged = 0): Applied {
  if (!chain.length) return a
  const starts = startsOf(msgs, chain)
  const to = promptsOf(msgs)[chain.at(-1)!.endsBefore - 1]
  const out: Applied = { msgs: [], origin: [], treated: a.treated }
  const push = (text: string, k: number) => (out.msgs.push({ role: 'assistant', content: [{ type: 'text', text }] }), out.origin.push(starts[k]))
  let placed = false
  a.msgs.forEach((m, j) => {
    const i = a.origin[j]
    if (i >= starts[0] && i < to) return
    if (i >= to && !placed) {
      if (merged) push(memoirOf(chain.slice(0, merged)), 0)
      chain.forEach((s, k) => k >= merged && push(`${SUMMARY_HEAD}\n\n${s.text}`, k))
      placed = true
    }
    out.msgs.push(m), out.origin.push(i)
  })
  return out
}

// What a summary fork asks about: the turns from `start` (the last record's
// end, or the first) to the current one, each prompt quoted and hashed, with
// when it was sent and when its turn's last request was, and their characters
// in the messages as sent.
export type SummaryFork = { start: number; current: number; prompts: Array<{ quote: string; hash: string; time?: string; end?: string }>; chars: number }

// The summary fork a request calls for: one when the turns completed since
// `from` (the turn the last summary fork was offered at, or the last record's
// end) hold at least `threshold` tokens before the frontier in the messages as
// sent, by each one's count in `tokens` (stats.ts, settled). `born` is when a
// message was first sent (stats.ts, bornOf). A turn's last request is the one
// its last message answered, which sent the message before it.
export function summaryForkOf(a: Applied, msgs: readonly ApiMsg[], chain: readonly Summary[], offered: number, threshold: number, thinking: Thinking, tokens: readonly number[], born: (m: ApiMsg) => string | undefined = () => undefined): SummaryFork | undefined {
  const prompts = promptsOf(msgs)
  const current = prompts.length
  const start = chain.at(-1)?.endsBefore ?? 1
  const at = (t: number) => (t <= 1 ? msgs.findIndex((m) => m.role === 'assistant') : prompts[t - 1])
  const covered = (t: number, j: number) => a.origin[j] >= at(t) && a.origin[j] < prompts[current - 1]
  const charsFrom = (t: number) => a.msgs.reduce((n, m, j) => (covered(t, j) ? n + blocks(m).reduce((k, b) => k + sizeOf(b, thinking), 0) : n), 0)
  const from = Math.max(start, Math.min(offered, current))
  if (current <= start || at(1) < 0 || tokens.reduce((n, k, j) => (covered(from, j) ? n + k : n), 0) < threshold) return
  const quote = (m: ApiMsg) => {
    const text = blocks(m).find((b: Block) => b.type === 'text' && !/^\s*<system-reminder>/.test(String(b.text)))?.text ?? '(an image)'
    const flat = String(text).replace(/\s+/g, ' ').trim()
    return flat.length > 100 ? flat.slice(0, 100) + '…' : flat
  }
  const timed = (k: string, v: string | undefined) => (v ? { [k]: v } : {})
  const turns = prompts.slice(start - 1, current).map((i, k) => {
    const next = prompts[start + k]
    return { quote: quote(msgs[i]), hash: promptHash(msgs[i]), ...timed('time', born(msgs[i])), ...timed('end', next === undefined ? undefined : born(msgs[Math.max(i, next - 2)])) }
  })
  return { start, current, prompts: turns, chars: charsFrom(start) }
}

// The instructions a summary fork appends: local/prompts/arcs6.md, recast for a
// model compacting its own context rather than a transcript it is shown.
export function instructions(f: SummaryFork): string {
  const list = f.prompts.map((p, k) => `[${f.start + k}] "${p.quote}"`)
  const current = list.pop()
  return `[shaver] This message is not from the user, and your answer will not be shown to them. Pause the task: don't call any tools, and answer with text only.

Compact the early part of this session into a record of its memorable events. Your record will replace the turns it covers in your context, so you can keep working from it and the messages that follow. ${f.start > 1 ? `Turns before [${f.start}] are already compacted; leave them out. ` : ''}Cover the turns that start with these prompts:

${list.join('\n')}

The latest prompt, still in progress:
${current}

Divide the work into arcs: stretches of the session spent on one goal, such as a feature, a bug hunt or a round of edits to one file. Keep the arcs in the order they happened. Start each arc with a heading line giving the number of the turn it starts at and a title of one sentence saying what the arc did:

## [<turn>] <title>

Make titles stand on their own; don't use unexplained custom terminology.

Under it, write terse bullets covering only the arc's memorable points, told as they happened. Memorable points include:

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

// A summary fork's messages: the request's, with the instructions appended to
// the last message, which is the user's. They go after its blocks, so the
// prefix through its last breakpoint is the same and the summary fork reads its
// cache entry.
export function summaryForkMessages(msgs: readonly ApiMsg[], text: string): ApiMsg[] {
  const last = msgs.at(-1)!
  return [...msgs.slice(0, -1), { ...last, content: [...blocks(last), { type: 'text', text }] }]
}

// The record a summary fork answered with, if it covers anything: its text
// without the closing line, ending before a turn after `start` and no later
// than the current one, and `tokens`, its output tokens.
export function recordOf(content: readonly Block[], f: SummaryFork, time: string, tokens?: number): Summary | undefined {
  if (content.some((b) => b.type === 'tool_use')) return
  const text = content.filter((b) => b.type === 'text').map((b) => String(b.text)).join('')
  const m = [...text.matchAll(/^Ends before: \[(\d+)\]\s*$/gm)].at(-1)
  const n = Number(m?.[1])
  if (!m || n <= f.start || n > f.current) return
  const record = text.slice(0, m.index).trim()
  if (!record) return
  const arcs = arcsOf(record, f, n)
  return { endsBefore: n, prompt: f.prompts[n - f.start].hash, text: record, time, ...(arcs && { arcs }), ...(tokens !== undefined && { tokens }) }
}

// A record's arcs, by their heading lines: one starts the record, and their
// turns rise within those it covers. Each arc runs to the next one's turn, and
// its minutes are its timed turns' own, from prompt to last request: not the
// gaps between them.
function arcsOf(record: string, f: SummaryFork, endsBefore: number): Arc[] | undefined {
  const heads = [...record.matchAll(/^## \[(\d+)\] (.+)$/gm)]
  const turns = heads.map((h) => Number(h[1]))
  if (heads[0]?.index !== 0 || turns[0] < f.start || turns.some((t, k) => k && t <= turns[k - 1]) || turns.at(-1)! >= endsBefore) return
  return heads.map((h, k) => {
    const { time } = f.prompts[turns[k] - f.start]
    const own = f.prompts.slice(turns[k] - f.start, (turns[k + 1] ?? endsBefore) - f.start).filter((p) => p.time && p.end)
    const ms = own.length ? own.reduce((n, p) => n + Date.parse(p.end!) - Date.parse(p.time!), 0) : undefined
    const minutes = ms === undefined ? undefined : Math.max(1, Math.round(ms / 60_000))
    return { turn: turns[k], title: h[2].trim(), ...(time && { time }), ...(minutes !== undefined && { minutes }) }
  })
}

// How many of the oldest records the memoir holds once `chain` is kept: the
// `merged` it held, and then as many more as it takes for the rest to hold at
// most `threshold` tokens. A record without arcs stops it.
export function mergedOf(chain: readonly Summary[], merged: number, threshold: number): number {
  let n = Math.min(merged, chain.length)
  const rest = (k: number) => chain.slice(k).reduce((t, s) => t + (s.tokens ?? 0), 0)
  while (n < chain.length && chain[n].arcs && rest(n) > threshold) n++
  return n
}

// A timestamp's local date, like 2026-10-25.
function localDate(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// The memoir of some records: each arc's title and minutes, under the date it
// started, each date once. An arc with no time takes its record's.
export function memoirOf(chain: readonly Summary[]): string {
  const lines: string[] = []
  let day = ''
  for (const s of chain)
    for (const a of s.arcs ?? []) {
      const d = localDate(a.time ?? s.time)
      if (d !== day) lines.push(...(day ? [''] : []), d), (day = d)
      lines.push(`- ${a.title}${a.minutes !== undefined ? ` (~${a.minutes} min)` : ''}`)
    }
  return `${MEMOIR_HEAD}\n\n${lines.join('\n')}\n\n${MEMOIR_FOOT}`
}

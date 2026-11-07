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
import { hash, isNote, preambleEnd } from './log.ts'
import { notesOfBlock, type Note } from './notes.ts'
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

// A turn: its prompt's index in the messages, and its internal ID (turnsOf).
// Records, summary forks and the logs name turns by ID.
export type Turn = { index: number; id: number }

// Each prompt's internal ID: the one `known` has for it, by the prompts up to
// it, so a prompt is the same turn only after the same prompts; or, new, the
// one `next` gives, which it adds to `known`. With IDs given in the order
// prompts are seen, a turn's ID is above those before it, and none is reused,
// even after a rewind.
export function turnsOf(msgs: readonly ApiMsg[], known: Record<string, number>, next: () => number): Turn[] {
  let key = ''
  return promptsOf(msgs).map((index) => {
    key = hash(key + promptHash(msgs[index]))
    return { index, id: (known[key] ??= next()) }
  })
}

// Turns numbered by position, turn 1 first: how logs from before internal IDs
// are replayed, and what a conversation's first request with them gives.
export const positional = (msgs: readonly ApiMsg[]): Turn[] => promptsOf(msgs).map((index, k) => ({ index, id: k + 1 }))

const indexOf = (turns: readonly Turn[], id: number) => turns.find((t) => t.id === id)?.index

// The records that still fit the messages: each one's prompt is still there.
// One that doesn't (the conversation was rewound) goes with the ones after it.
export function validChain(chain: readonly Summary[], msgs: readonly ApiMsg[], turns = positional(msgs)): Summary[] {
  const b = chainBreak(chain, msgs, turns)
  return b ? chain.slice(0, b.index) : [...chain]
}

// The first record that no longer fits the messages, by its index in the
// chain, and the hash of the prompt now where its own was, or none when its
// turn is gone; undefined when every record fits. The hash is checked too, for
// records from before internal IDs, which numbered turns by position.
export function chainBreak(chain: readonly Summary[], msgs: readonly ApiMsg[], turns = positional(msgs)): { index: number; found?: string } | undefined {
  for (const [index, s] of chain.entries()) {
    const i = indexOf(turns, s.endsBefore)
    const found = i === undefined ? undefined : promptHash(msgs[i])
    if (found !== s.prompt) return { index, ...(found && { found }) }
  }
}

// The index of the first message each record covers: the preamble's end
// (log.ts, preambleEnd) for the first record, and the prompt its predecessor ends before for the rest.
export function startsOf(msgs: readonly ApiMsg[], chain: readonly Summary[], turns = positional(msgs)): number[] {
  return chain.map((_, k) => (k ? indexOf(turns, chain[k - 1].endsBefore)! : preambleEnd(msgs)))
}

// The harness's notes in covered messages that a record can't stand in for
// (notes.ts): every forever one, and of the latest ones the newest for each
// key, as one system message, or none. Only the covered messages decide, so
// every request after sends the same. A block whose notes all stay is the
// block itself, which the wire formats send back as they got it.
export function keptNotes(covered: readonly ApiMsg[]): ApiMsg | undefined {
  const found = covered.flatMap((m) => blocks(m).filter((b) => isNote(b, m)).map((b) => ({ b, notes: notesOfBlock(b) })))
  const newest = new Map<string, Note>()
  for (const { notes } of found) for (const n of notes) if (n.category === 'latest') for (const k of n.keys) newest.set(k, n)
  const newestOf = new Set(newest.values())
  const kept = found.flatMap(({ b, notes }): Block[] => {
    const keep = notes.filter((n) => n.category === 'forever' || newestOf.has(n))
    if (!keep.length) return []
    if (keep.length === notes.length) return [b]
    const text = keep.map((n) => n.text.replace(/\s*<\/system-reminder>\s*$/, '').trimEnd()).join('\n\n')
    return [{ type: 'text', text: /^<system-reminder>/.test(String(b.text)) ? `<system-reminder>\n${text}\n</system-reminder>` : text }]
  })
  return kept.length ? { role: 'system', content: kept } : undefined
}

// The messages with everything from the preamble's end up to the last
// record's end replaced by the records, one assistant message each, oldest
// first. The messages before it (the preamble and the first prompt) stay. Assistant messages fit after them where a user one can't:
// they can end with a system message, which the API refuses before a user one.
// The first `merged` records go as one message, the memoir, before the rest.
// The covered notes that stay (keptNotes) go first, as a system message,
// which the harness's own come before an assistant one as.
export function summarized(a: Applied, msgs: readonly ApiMsg[], chain: readonly Summary[], merged = 0, turns = positional(msgs)): Applied {
  if (!chain.length) return a
  const starts = startsOf(msgs, chain, turns)
  const to = indexOf(turns, chain.at(-1)!.endsBefore)!
  const out: Applied = { msgs: [], origin: [], treated: a.treated }
  const push = (text: string, k: number) => (out.msgs.push({ role: 'assistant', content: [{ type: 'text', text }] }), out.origin.push(starts[k]))
  const notes = keptNotes(a.msgs.filter((_, j) => a.origin[j] >= starts[0] && a.origin[j] < to))
  let placed = false
  a.msgs.forEach((m, j) => {
    const i = a.origin[j]
    if (i >= starts[0] && i < to) return
    if (i >= to && !placed) {
      if (notes) out.msgs.push(notes), out.origin.push(starts[0])
      if (merged) push(memoirOf(chain.slice(0, merged)), 0)
      chain.forEach((s, k) => k >= merged && push(`${SUMMARY_HEAD}\n\n${s.text}`, k))
      placed = true
    }
    out.msgs.push(m), out.origin.push(i)
  })
  return out
}

// The messages of `a`, with the chain's first `from` records applied, that the
// records after them replace.
export function coveredBy(a: Applied, msgs: readonly ApiMsg[], chain: readonly Summary[], from: number, turns = positional(msgs)): ApiMsg[] {
  const start = startsOf(msgs, chain, turns)[from]
  const to = indexOf(turns, chain.at(-1)!.endsBefore)!
  return a.msgs.filter((_, j) => a.origin[j] >= start && a.origin[j] < to)
}

// What a summary fork asks about: the turns from `start` (the last record's
// end, or the first) to the current one, by ID, each prompt with its turn's
// ID, quoted and hashed, with when it was sent and when its turn's last
// request was, and their characters in the messages as sent. `recorded` is
// whether records already cover the turns before `start`.
export type SummaryFork = { start: number; current: number; recorded: boolean; prompts: Array<{ id: number; quote: string; hash: string; time?: string; end?: string }>; chars: number }

// The summary fork a request calls for: one when the turns completed since
// `from` (the turn the last summary fork was offered at, or the last record's
// end) hold at least `threshold` tokens of the user's and the assistant's text
// in the messages as sent, by each one's count in `tokens` (stats.ts,
// textTokens). `born` is when a
// message was first sent (stats.ts, bornOf). A turn's last request is the one
// its last message answered, which sent the message before it. With none, it
// says why (`skip`), and with too few tokens, how many the turns held.
export type ForkSkip = { skip: 'no-new-turn' | 'no-preamble' | 'below-threshold'; tokens?: number }
export function summaryForkOf(a: Applied, msgs: readonly ApiMsg[], chain: readonly Summary[], offered: number, threshold: number, thinking: Thinking, tokens: readonly number[], born: (m: ApiMsg) => string | undefined = () => undefined, turns = positional(msgs)): SummaryFork | ForkSkip {
  const current = turns.at(-1)?.id ?? 0
  const start = chain.at(-1)?.endsBefore ?? turns[0]?.id ?? 1
  // Where turn `t` starts: the first turn's at the preamble's end. A turn no
  // longer there (offered before a rewind) starts at the first one after it.
  const at = (t: number) => {
    const k = turns.findIndex((u) => u.id >= t)
    return k < 0 ? Infinity : k ? turns[k].index : preambleEnd(msgs)
  }
  const covered = (t: number, j: number) => a.origin[j] >= at(t) && a.origin[j] < turns.at(-1)!.index
  const charsFrom = (t: number) => a.msgs.reduce((n, m, j) => (covered(t, j) ? n + blocks(m).reduce((k, b) => k + sizeOf(b, thinking), 0) : n), 0)
  const from = Math.max(start, Math.min(offered, current))
  if (current <= start) return { skip: 'no-new-turn' }
  if (preambleEnd(msgs) < 0) return { skip: 'no-preamble' }
  const held = tokens.reduce((n, k, j) => (covered(from, j) ? n + k : n), 0)
  if (held < threshold) return { skip: 'below-threshold', tokens: held }
  const quote = (m: ApiMsg) => {
    const text = blocks(m).find((b: Block) => b.type === 'text' && !/^\s*<system-reminder>/.test(String(b.text)))?.text ?? '(an image)'
    const flat = String(text).replace(/\s+/g, ' ').trim()
    return flat.length > 100 ? flat.slice(0, 100) + '…' : flat
  }
  const timed = (k: string, v: string | undefined) => (v ? { [k]: v } : {})
  const listed = turns.filter((t) => t.id >= start)
  const prompts = listed.map(({ index: i, id }, k) => {
    const next = listed[k + 1]?.index
    return { id, quote: quote(msgs[i]), hash: promptHash(msgs[i]), ...timed('time', born(msgs[i])), ...timed('end', next === undefined ? undefined : born(msgs[Math.max(i, next - 2)])) }
  })
  return { start, current, recorded: chain.length > 0, prompts, chars: charsFrom(start) }
}

// The instructions a summary fork appends: local/prompts/arcs9g.md, with its
// placeholders filled in. `answered` is whether they follow the reply that
// ended the latest turn, as the user's next prompt would.
export function instructions(f: SummaryFork, answered = false): string {
  const list = f.prompts.map((p) => `[${p.id}] "${p.quote}"`)
  const current = list.pop()
  return `I need a record of our work so far for my journal, so that we can resume the work from it later. Write it as text only, without calling any tools; my journaling tool reads your answer automatically, so give only the record. Cover the memorable events of the turns that start with these prompts (each is prefixed by its turn's internal ID):

${list.join('\n')}

${f.recorded ? `Turns before [${f.start}] are already in my journal; leave them out.\n\n` : ''}${answered ? 'Exclude the turn of the following prompt, which you just answered, because its work may still be in progress, and my next prompt will likely carry on from it:' : 'The latest prompt, still in progress:'}
${current}

Divide the work into arcs: stretches of the session spent on one goal, such as a feature, a bug hunt or a round of edits to one file. Keep the arcs in the order they happened. Start each arc with a heading line giving the internal ID of the turn it starts at and a title of one sentence saying what the arc did:

## [<ID>] <title>

Make titles stand on their own; don't use unexplained custom terminology.

Under it, write terse bullets covering only the arc's memorable points, told as they happened. Memorable points include:

- the goal that started the arc
- outcomes that landed: changes made, commits, results measured
- decisions I made
- land mines: traps that were hit, such as a command that hung, a wrong assumption that looked right, or something I had to correct

Tell each point as an event, not as a rule drawn from it. Write "I deleted \`old/\` without asking; you had it restored (\`ed24806\`)", not "always ask before deleting". Report where things ended up rather than every step on the way, and leave out dead ends and intermediate versions unless they were land mines.

Stop at the last complete arc. An arc is still in progress if the latest turn carries on its work, such as testing, fixing or committing what it built. Leave an arc in progress out entirely: I'll ask for it later, once it is done.

End your record with one line giving the internal ID of the first turn your arcs do not cover:

Ends before: [<ID>]

If no arc is complete yet, answer with only that line, naming [${f.start}].

Your record must be at most a tenth the length of the turns it covers; the turns listed above, up to the latest, are about ${Math.round(f.chars).toLocaleString('en-US')} characters.

Keep the exact identifiers I, or you, might need: paths, hashes, names, numbers, commands. Drop narration and tool output. Start directly with the first arc.`
}

// A fork's messages: the request's, then, given the text of the reply that
// ended the turn, that text and the instructions in a user message of their own, as the
// user's next prompt would come. With no reply, the instructions are appended
// to the last message, the user's as a summary fork's is or a system one as
// Claude Code's base ends with (the API takes no message after a system one
// but an assistant's), or in one of their own after an assistant's. Either way
// they go after its blocks, so the prefix through its last breakpoint is the
// same and the fork reads its cache entry.
export function summaryForkMessages(msgs: readonly ApiMsg[], text: string, reply?: string[]): ApiMsg[] {
  if (reply) return [...msgs, { role: 'assistant', content: reply.map((t) => ({ type: 'text', text: t })) }, { role: 'user', content: [{ type: 'text', text }] }]
  const last = msgs.at(-1)!
  if (last.role === 'assistant') return [...msgs, { role: 'user', content: [{ type: 'text', text }] }]
  return [...msgs.slice(0, -1), { ...last, content: [...blocks(last), { type: 'text', text }] }]
}

// Where a turn the answer names is among those the fork listed; -1 if not.
const listedAt = (f: SummaryFork, id: number) => f.prompts.findIndex((p) => p.id === id)

// The record a summary fork answered with, if it covers anything: its text
// without the closing line, ending before a turn listed after `start`, and
// `tokens`, its output tokens.
export function recordOf(content: readonly Block[], f: SummaryFork, time: string, tokens?: number): Summary | undefined {
  if (rejectionOf(content, f)) return
  const text = textOf(content)
  const m = endLine(text)!
  const n = Number(m[1])
  const record = text.slice(0, m.index).trim()
  const arcs = arcsOf(record, f, n)
  return { endsBefore: n, prompt: f.prompts[listedAt(f, n)].hash, text: record, time, ...(arcs && { arcs }), ...(tokens !== undefined && { tokens }) }
}

// The stop reasons that mean the answer was cut off partway, by protocol:
// Messages (refusal, max_tokens), Chat Completions (length, content_filter)
// and Responses (its incomplete_details reasons, or its status).
const CUT_OFF = new Set(['refusal', 'max_tokens', 'length', 'content_filter', 'max_output_tokens', 'incomplete'])

// The record a cut-off answer still gives: its complete arcs. An answer cut
// off partway has no closing line, but every arc starts with its turn, so the
// arcs before the last heading are whole, and the record ends before that
// heading's turn. The last arc, the one cut off, is left for a later fork. Only
// for an answer whose `stop` says it was cut off, without a tool call or a
// closing line, and with at least one whole arc.
export function salvagedOf(content: readonly Block[], f: SummaryFork, time: string, stop: string | undefined, tokens?: number): Summary | undefined {
  if (!stop || !CUT_OFF.has(stop) || content.some((b) => b.type === 'tool_use')) return
  const text = textOf(content)
  if (endLine(text)) return
  const last = [...text.matchAll(/^## \[(\d+)\] (.+)$/gm)].at(-1)
  if (!last || !last.index) return
  const n = Number(last[1])
  if (listedAt(f, n) < 1) return
  const record = text.slice(0, last.index).trim()
  const arcs = arcsOf(record, f, n)
  if (!arcs) return
  return { endsBefore: n, prompt: f.prompts[listedAt(f, n)].hash, text: record, time, arcs, ...(tokens !== undefined && { tokens }) }
}

// Why a summary fork's answer gives no record, by a fixed reason, with the
// turn its closing line names when it has one; or undefined when it gives one.
// A line naming "Ends before" that isn't the closing line exactly is
// misformatted.
export type Rejection = { reason: 'tool-call' | 'no-ends-before' | 'ends-before-misformatted' | 'ends-before-out-of-range' | 'empty'; endsBefore?: number }
export function rejectionOf(content: readonly Block[], f: SummaryFork): Rejection | undefined {
  if (content.some((b) => b.type === 'tool_use')) return { reason: 'tool-call' }
  const text = textOf(content)
  const m = endLine(text)
  if (!m) return { reason: /ends before/i.test(text) ? 'ends-before-misformatted' : 'no-ends-before' }
  const n = Number(m[1])
  if (listedAt(f, n) < 1) return { reason: 'ends-before-out-of-range', endsBefore: n }
  if (!text.slice(0, m.index).trim()) return { reason: 'empty', endsBefore: n }
}

const textOf = (content: readonly Block[]) => content.filter((b) => b.type === 'text').map((b) => String(b.text)).join('')
const endLine = (text: string) => [...text.matchAll(/^Ends before: \[(\d+)\]\s*$/gm)].at(-1)

// A record's arcs, by their heading lines: one starts the record, and their
// turns, each one listed, rise within those it covers. Each arc runs to the
// next one's turn, and its minutes are its timed turns' own, from prompt to
// last request: not the gaps between them.
function arcsOf(record: string, f: SummaryFork, endsBefore: number): Arc[] | undefined {
  const heads = [...record.matchAll(/^## \[(\d+)\] (.+)$/gm)]
  const turns = heads.map((h) => Number(h[1]))
  const at = turns.map((t) => listedAt(f, t))
  if (heads[0]?.index !== 0 || at.some((k, j) => k < 0 || (j && k <= at[j - 1])) || at.at(-1)! >= listedAt(f, endsBefore)) return
  return heads.map((h, k) => {
    const { time } = f.prompts[at[k]]
    const own = f.prompts.slice(at[k], at[k + 1] ?? listedAt(f, endsBefore)).filter((p) => p.time && p.end)
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

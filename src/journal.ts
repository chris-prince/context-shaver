// A conversation's stats history: proxy-data/state/<key>.journal.jsonl, a line
// per counted request holding what it changed in the stats (stats.ts). The
// lines replayed from the start give the stats as they were after any
// request. A journal begun after the stats were holds them whole in its first
// line, so its history starts there.
//
// A line records results, not inputs, so a replay never reruns the counting.
// Its fields: the plain fields that changed, null for one gone (before
// 2026-10-24 one gone was left out, so replay kept it); for each record, the entries set
// and the keys deleted; and, when it changed, the message list, each run of
// messages kept from the previous list as [from, to) and each other message
// whole (`messages`; `parts` before 2026-11-07). A line
// also holds the request's usage as the API reported it (cache reads, cache
// writes by TTL, output), which the stats leave out and replay ignores.
//
// A request the proxy makes of its own, a fork (server.ts, forked), gets a
// line of its own, { fork: { time, kind, model, provider, usage, why } }, with
// no change to the stats, so replay skips it. Older journals have summary
// forks' as { summaryFork: { time, model, provider, usage } }.
//
// A request the API refused changed and answered as it came (server.ts) gets a
// line marked resent: true, its usage and its count as a request, with the
// rest of the stats as they were, since it went up untrimmed.
//
// Any other request the API answered gets a bare line, { bare: { time, model,
// provider, usage, why } }, with no change to the stats, so replay skips it:
// one sent as it came (a side request without tools, or one not read or not
// trimmed), one cut off before its answer ended, one answered with no usage,
// and one resent before the conversation had stats. It counts what it was
// billed, the same with and without the shaver, and not as a request. Before
// 2026-10-24 none of these were journaled.

import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Usage } from './cost.ts'
import { withWrites } from './responses.ts'
import type { Stats } from './stats.ts'
import { callIdsOf } from './items.ts'
import { messagesOf, objectsOf } from './log.ts'

// Every other field is plain, set whole when it changes: listing them let a
// new one go unjournaled (Stats.compacted, until 2026-10-24).
const RECORDS = ['tokens', 'bound', 'answers', 'thinking', 'seen'] as const
type Plain = Exclude<keyof Stats, (typeof RECORDS)[number] | 'messages'>
const plainOf = (s: Stats | undefined) => Object.keys(s ?? {}).filter((f) => f !== 'messages' && !(RECORDS as readonly string[]).includes(f)) as Plain[]

type Message = Stats['messages'][number]
type Ops = Array<[number, number] | Message>
export type Delta = {
  set?: Partial<Pick<Stats, Plain>>
  records?: Partial<Record<(typeof RECORDS)[number], { set?: Record<string, unknown>; del?: string[] }>>
  messages?: Ops
  // BACKCOMPAT(2026-11-07)
  //   Before: journal lines called `messages` `parts`.
  //   Shim: the field is still typed, and apply() reads it.
  //   Remove when: with apply()'s.
  parts?: Ops
  usage?: Usage
  cache?: CacheRead
  resent?: true
}
// why is set when the answer gave no usage, as on a bare line.
// A summary fork, or the request `shaver optimize` makes for skill lines.
export type ForkKind = 'summary' | 'optimize'
export type ForkLine = { time: string; kind: ForkKind; model: string; provider?: string; usage?: Usage; why?: Why }
export type Why = 'side' | 'unread' | 'untrimmed' | 'cut off' | 'no usage' | 'resent' | 'compaction'
export type BareLine = { time: string; model: string; provider?: string; usage?: Usage; why: Why }

// The request lines written since the proxy started (server.ts checks one is
// written for every answered request).
export let written = 0
const append = (file: string, line: object) => {
  appendFileSync(file, JSON.stringify(line) + '\n')
  written++
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function diff(prev: Stats | undefined, next: Stats): Delta {
  const d: Delta = {}
  for (const f of [...new Set([...plainOf(prev), ...plainOf(next)])].sort()) if (!prev || !same(prev[f], next[f])) (d.set ??= {})[f] = (next[f] ?? null) as never
  for (const f of RECORDS) {
    const a: Record<string, unknown> = prev?.[f] ?? {}
    const b: Record<string, unknown> = next[f]
    const set = Object.fromEntries(Object.entries(b).filter(([k, v]) => !same(a[k], v)))
    const del = Object.keys(a).filter((k) => !(k in b))
    if (Object.keys(set).length || del.length) (d.records ??= {})[f] = { ...(Object.keys(set).length && { set }), ...(del.length && { del }) }
  }
  if (!prev || !same(prev.messages, next.messages)) {
    // Where each message sits in the previous list, by its JSON.
    const at = new Map<string, number[]>()
    prev?.messages.forEach((p, i) => at.set(JSON.stringify(p), [...(at.get(JSON.stringify(p)) ?? []), i]))
    const ops: Ops = []
    for (const p of next.messages) {
      const found = at.get(JSON.stringify(p)) ?? []
      const last = ops[ops.length - 1]
      // Extend the run when this message follows it, else start one where the
      // message first sits.
      if (Array.isArray(last) && found.includes(last[1])) last[1]++
      else if (found.length) ops.push([found[0], found[0] + 1])
      else ops.push(p)
    }
    d.messages = ops
  }
  return d
}

// Applies a line to the stats before it, in place: copying the records, which
// every line changes, would cost a line as much as all the lines before it.
function apply(s: Stats | undefined, d: Delta): Stats {
  // BACKCOMPAT(2026-11-07)
  //   Before: journal lines called `messages` `parts`.
  //   Shim: `parts` is read when `messages` is missing.
  //   Remove when: journals from before 2026-11-07 are no longer read.
  const messages = (d.messages ?? d.parts)?.flatMap((op) => (Array.isArray(op) ? s!.messages.slice(op[0], op[1]) : [op]))
  s = Object.assign(s ?? ({} as Stats), d.set)
  for (const [k, v] of Object.entries(d.set ?? {})) if (v === null) delete s[k as keyof Stats]
  for (const f of RECORDS) {
    const r = d.records?.[f]
    const out: Record<string, unknown> = (s[f] ??= {} as never)
    Object.assign(out, r?.set)
    for (const k of r?.del ?? []) delete out[k]
  }
  if (messages) s.messages = messages
  return s
}

// Appends the change from prev, the stats the journal ends with, to next, the
// usage the request reported, and its cache read against the proxy's
// prediction.
export function record(file: string, prev: Stats | undefined, next: Stats, usage?: Usage, cache?: CacheRead): void {
  append(file, { ...diff(prev, next), ...(usage && { usage }), ...(cache && { cache }) })
}

// A request's cache read, in tokens: what the proxy predicted, the read if
// the server ignored its explicit breakpoints (where they'd read further),
// and what the API reported. Predictions are in message characters, so they
// convert at the request's own ratio, its tokens past the tool definitions
// over its message characters; the definitions count as read.
export type CacheRead = { predicted: number; unmarked?: number; read: number }
export function cacheRead(p: { chars: number; total: number; unmarked?: number }, s: Stats, read: number): CacheRead {
  const defs = s.defs ? (s.tokens[s.defs.key] ?? 0) : 0
  const ratio = p.total ? (s.inputTokens - defs) / p.total : 0
  const tokens = (chars: number) => Math.round(defs + chars * ratio)
  return { predicted: tokens(p.chars), ...(p.unmarked !== undefined && { unmarked: tokens(p.unmarked) }), read }
}

// Whether a read shows the server ignored the explicit breakpoints: they'd
// read at least IGNORED_GAP tokens further than lookback alone, and the read
// is nearer lookback's prediction than theirs without falling well below it
// (which is a cache miss, not an ignored mark).
export const IGNORED_GAP = 4096
export const ignoredMark = (c: CacheRead) =>
  c.unmarked !== undefined && c.predicted - c.unmarked >= IGNORED_GAP && c.read - c.unmarked < (c.predicted - c.unmarked) / 2 && c.read >= c.unmarked - IGNORED_GAP

// Appends a bare line.
export function recordBare(file: string, b: BareLine): void {
  append(file, { bare: b })
}

// Appends a resent request's line, given the stats the journal ends with, and
// returns the stats it leaves. A resent compaction request is marked, so the
// request after it is known to follow a compaction (stats.ts, compactedSince);
// one that isn't leaves a mark before it for the next request answered.
export function recordResent(file: string, prev: Stats, time: string, usage: Usage, compaction?: boolean): Stats {
  const set = { requests: prev.requests + 1, time, ...(compaction && { compaction: true }) }
  append(file, { set, usage, resent: true })
  return { ...prev, ...set }
}

// Appends a fork's line.
export function recordFork(file: string, f: ForkLine): void {
  append(file, { fork: f })
}

// A line's fork, if it is one, an older summary fork's line included.
// BACKCOMPAT(2026-10-23)
//   Before: a summary fork's journal line was { summaryFork }, with no kind.
//   Shim: forkOf reads it as a fork of kind "summary".
//   Remove when: journals from before 2026-10-23 are no longer read.
export const forkOf = (d: { fork?: ForkLine; summaryFork?: Omit<ForkLine, 'kind'> }): ForkLine | undefined => d.fork ?? (d.summaryFork && { ...d.summaryFork, kind: 'summary' })

// The journal's lines, parsed; none if there is none.
export function* linesOf(file: string): Generator<Delta & { fork?: ForkLine; summaryFork?: Omit<ForkLine, 'kind'>; bare?: BareLine }> {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) if (line) yield JSON.parse(line)
}

// The stats after each line of a journal, in order, each built from the one
// before, with the usage the line holds; none if there is none. Every line
// gives the same stats object, changed in place, so a caller that keeps a
// line's stats past the next one copies what it needs. A Codex journal's
// usage gets the cache writes ChatGPT's backend doesn't report (responses.ts).
// A line says too whether the request after it is the client's compaction
// (Stats.compaction), read from the next line before it's applied, since
// applying updates the one stats object in place.
export function* history(file: string): Generator<{ stats: Stats; usage?: Usage; resent?: true; compactsNext?: true }> {
  const codex = path.basename(file).startsWith('codex-')
  let s: Stats | undefined
  let held: Delta | undefined
  const line = (d: Delta, next?: Delta) => {
    s = apply(s, d)
    const compactsNext = next && (next.set && 'compaction' in next.set ? next.set.compaction === true : !!s.compaction)
    return { stats: s, usage: d.usage && codex ? withWrites(d.usage) : d.usage, ...(d.resent && { resent: d.resent }), ...(compactsNext && { compactsNext: true as const }) }
  }
  for (const d of linesOf(file)) {
    if (forkOf(d) || d.bare) continue
    if (held) yield line(held, d)
    held = d
  }
  if (held) yield line(held)
}

// The forks a journal records, in order.
export function* forks(file: string): Generator<ForkLine> {
  for (const d of linesOf(file)) {
    const f = forkOf(d)
    if (f) yield f
  }
}

// The prefix of the keys of a conversation's session (harness.ts,
// conversationId): its key less the first message's hash, and in a Claude Code
// main conversation, less "main" too, so its subagents' keys share it. A
// subagent's is its own agent's. A key with no session (only its harness's
// name and the hash) has none.
export function sessionOf(key: string): string | undefined {
  const own = key.slice(0, key.lastIndexOf('-') + 1)
  if (!own.slice(0, -1).includes('-')) return undefined
  return key.startsWith('claude-') && own.endsWith('-main-') ? own.slice(0, -'main-'.length) : own
}

// Each conversation's newest tool call (Stats.lastCall), kept in one file
// beside the journals, `{ key: call }`, so finding the conversation a new one
// goes on from opens no journal: a restart reads this file, and lists the
// journals' names to fill in the conversations it lacks (fill), from before
// it or a lost one, or a proxy's on another folder. A conversation in which
// none was found is null, so it isn't looked for again on every restart; it's
// set as its requests are described, as every conversation is.
export class LastCalls {
  private byKey: Record<string, string | null>
  private byCall = new Map<string, string>()
  private file: string
  constructor(file: string) {
    this.file = file
    try {
      this.byKey = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      this.byKey = {}
    }
    for (const [k, c] of Object.entries(this.byKey)) if (c) this.byCall.set(c, k)
  }
  set(key: string, call: string) {
    const was = this.byKey[key]
    if (was === call) return
    if (was && this.byCall.get(was) === key) this.byCall.delete(was)
    this.byKey[key] = call
    this.byCall.set(call, key)
    this.save()
  }
  // Each of the keys not in the table, with its newest call as `find` gives
  // it, or null; saved once, if any was missing.
  fill(keys: Iterable<string>, find: (key: string) => string | null): number {
    let added = 0
    for (const k of keys) {
      if (k in this.byKey) continue
      const c = find(k)
      this.byKey[k] = c
      if (c && !this.byCall.has(c)) this.byCall.set(c, k)
      added++
    }
    if (added) this.save()
    return added
  }
  private save() {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.byKey))
    renameSync(tmp, this.file)
  }
  // The conversation in another session that a new one goes on from, given
  // the tool call IDs of its first request: Claude Code goes on with a
  // conversation moved to the background or forked under a new session ID,
  // sending its history. So it is one of the same harness whose newest tool
  // call the request holds; the API gives a call its ID, so no other
  // conversation's messages hold it. A key in the same session, as a Codex
  // subagent forked with its parent's history, is none: that is the session's
  // already. Of more than one, the one whose call is newest in the request.
  continuedFrom(key: string, calls: readonly string[]): string | undefined {
    const harness = key.slice(0, key.indexOf('-') + 1)
    const same = (a: string, b: string) => {
      const s = sessionOf(a)
      return !!s && b.startsWith(s)
    }
    for (let i = calls.length - 1; i >= 0; i--) {
      const k = this.byCall.get(calls[i])
      if (k && k !== key && k.startsWith(harness) && !same(k, key) && !same(key, k)) return k
    }
    return undefined
  }
}

// The keys of the conversations journaled in a state folder, from their
// journals' names; not a journal moved aside (`.bad`) or kept from before a
// repair, whose names have a dot in the key.
export const journalKeys = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (f.endsWith('.journal.jsonl') && !f.slice(0, -'.journal.jsonl'.length).includes('.') ? [f.slice(0, -'.journal.jsonl'.length)] : []))

// A conversation's newest tool call, for one missing from LastCalls: its
// journal's last lastCall, or failing that the messages of the last request
// its log has (log.ts), newest first; null with neither. Only the files'
// ends are read, more of them only while no whole line is found.
export function newestCall(stateDir: string, logRoot: string, key: string): string | null {
  const journal = path.join(stateDir, `${key}.journal.jsonl`)
  const set = [...tailOf(journal, () => true).matchAll(/"lastCall":"([^"]+)"/g)].at(-1)
  if (set) return set[1]
  const dir = path.join(logRoot, key)
  const isRequest = (l: string) => l.includes('"event":"request"') && !l.includes('"bare":')
  const line = tailOf(path.join(dir, 'step_events.jsonl'), (t) => t.split('\n').slice(1).some(isRequest))
    .split('\n').slice(1).filter(isRequest).at(-1)
  if (!line) return null
  const objects = objectsOf(dir)
  for (const m of [...messagesOf(JSON.parse(line))].reverse()) {
    if (m.role !== 'assistant') continue
    const file = path.join(objects, `${m.hash}.json`)
    if (!existsSync(file)) continue
    const call = callIdsOf([JSON.parse(readFileSync(file, 'utf8'))]).at(-1)
    if (call) return call
  }
  return null
}

// A file's end, from 64KB back, doubling until `enough` says it holds what's
// wanted or it's the whole file; '' for none. The first line may be part of
// one.
function tailOf(file: string, enough: (tail: string) => boolean): string {
  if (!existsSync(file)) return ''
  const size = statSync(file).size
  const fd = openSync(file, 'r')
  try {
    for (let n = 64 * 1024; ; n *= 2) {
      const len = Math.min(n, size)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, size - len)
      const t = (len === size ? '\n' : '') + buf.toString('utf8')
      if (len === size || enough(t)) return t
    }
  } finally {
    closeSync(fd)
  }
}

// The conversation a request sent as it came is journaled with, given its own
// key: its own, if it has a journal, else its session's latest, since a side
// request's first message is its own, not the conversation's. A key with no
// session (only its harness's name and the hash) is its own. A Codex
// subagent's session is its parent's and more (harness.ts), so a key whose
// rest after the session holds a dash is another session's.
export function sideKey(dir: string, key: string): string {
  const session = key.slice(0, key.lastIndexOf('-') + 1)
  if (existsSync(path.join(dir, `${key}.journal.jsonl`)) || !session.slice(0, -1).includes('-')) return key
  const theirs = readdirSync(dir)
    .filter((f) => f.startsWith(session) && f.endsWith('.journal.jsonl') && !f.slice(session.length).includes('-'))
    .map((f) => ({ f, at: statSync(path.join(dir, f)).mtimeMs }))
    .sort((x, y) => x.at - y.at)
  return theirs.length ? theirs[theirs.length - 1].f.slice(0, -'.journal.jsonl'.length) : key
}

// The bare lines a journal records, in order.
export function* bareLines(file: string): Generator<BareLine> {
  for (const d of linesOf(file)) if (d.bare) yield d.bare
}

// How many of a journal's requests show the server ignored their explicit
// breakpoints (ignoredMark).
export function ignoredMarks(file: string): number {
  let n = 0
  for (const d of linesOf(file)) if (d.cache && ignoredMark(d.cache)) n++
  return n
}

export function* replay(file: string): Generator<Stats> {
  for (const { stats } of history(file)) yield stats
}

// The stats the journal ends with. A journal that won't replay is moved aside
// to <key>.journal.bad.jsonl and the stats start again, so trimming, which
// counts from them, never depends on it.
export function latest(file: string): Stats | undefined {
  let s: Stats | undefined
  try {
    for (s of replay(file));
    return s
  } catch (err) {
    renameSync(file, file.replace(/\.jsonl$/, '.bad.jsonl'))
    console.error(`shaver: journal moved aside, stats start again: ${file}:`, err)
    return undefined
  }
}

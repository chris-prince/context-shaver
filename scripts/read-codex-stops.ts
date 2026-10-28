// Shows, for each logged Responses request, where the cache read stopped, by
// the API's usage per input item (`attribution`, matched to the logged items
// by their IDs), and why: what the request shared with the one before (the
// most the cache could read), how much of that it read, and what it wrote.
// Ends with the tokens each cause cost, across the conversations given, and
// what the trims cost against what they saved.
//
// Usage: bin/node-wrapper scripts/read-codex-stops.ts [--since <ISO>] [--until <ISO>] [conversation dir ...]
// With none, every Codex conversation under proxy-data/logs. --since and
// --until keep only requests sent in that window, as to compare those before a
// change with those after; the request before the window is still what the
// first one in it is compared with.
//
// Causes, for the tokens the cache did not read:
//   first    the conversation's first request; nothing before it to read
//   unknown  the request before was logged without its items' IDs
//   head     the tools or instructions changed, so nothing after them matched
//   trim     a trim changed a message the request before had sent, and the
//            read fell back from there to an older entry
//   changed  a message the request before had sent changed, with no trim
//   expired  the read fell short after a gap longer than the model's TTL
//   short    the read fell short with no gap: the API read less than it had
// A read that reaches the last item the two requests share is whole: OpenAI
// never reads the tail of that item, the last few hundred tokens or less.
//
// A trim costs what it lost, written where it would have been read, and saves
// what it took out, read by every later request: both in tokens at the input
// price, by the request's model's prices and TTL (models.ts).

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { modelOf } from '../src/models.ts'

type Counts = { input_tokens: number; cached_tokens: number; cache_write_tokens: number; output_tokens: number }
type Part = { part: string; hash: string; ids?: string[] }
type Line = { event: string; time: string; model?: string; inputTokens?: number; cachedTokens?: number; predictedCachedChars?: number; headIds?: string[]; parts?: (Part & { bytes: number })[]; system?: { hash: string }[]; tools?: { hash: string }[]; attribution?: { items: Record<string, Counts> } }

// What a model reads and writes at, as a fraction of its input price, and its TTL in ms.
const cache = (name = '') => {
  const { price, ttl = 1800 } = modelOf(name)
  return price ? { READ: price.read / price.input, WRITE: (price.write ?? 1.25 * price.input) / price.input, TTL: ttl * 1000 } : { READ: 0.1, WRITE: 1.25, TTL: ttl * 1000 }
}
const { values, positionals } = parseArgs({ allowPositionals: true, options: { since: { type: 'string' }, until: { type: 'string' } } })
const [since, until] = [values.since ? Date.parse(values.since) : -Infinity, values.until ? Date.parse(values.until) : Infinity]
const logs = path.join(import.meta.dirname, '..', 'proxy-data', 'logs')
const dirs = positionals.length ? positionals : readdirSync(logs).filter((d) => d.startsWith('codex-')).map((d) => path.join(logs, d))

const lost: Record<string, number> = {}
const loss = (cause: string, n: number) => n > 0 && (lost[cause] = (lost[cause] ?? 0) + n)
let unnamed = 0
let all = 0
let read = 0
let trimCost = 0
let trimSaved = 0

for (const dir of dirs) {
  let lines: Line[]
  try {
    lines = readFileSync(path.join(dir, 'step_events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    continue
  }
  const named = lines.filter((l) => l.event === 'request' && l.attribution && l.headIds)
  if (!named.length) {
    if (lines.some((l) => l.attribution)) unnamed++
    continue
  }
  let heading = false
  const later = (l: Line) => named.length - named.indexOf(l) - 1
  // An earlier request with no IDs leaves nothing to compare the first named one with.
  let prev: { time: number; head: string; keys: string[]; ids: Record<string, number> } | undefined
  let unknown = lines.indexOf(named[0]) > lines.findIndex((l) => l.event === 'request')
  let trimmed = false
  for (const l of lines) {
    if (l.event === 'compaction') trimmed = true
    if (!named.includes(l)) continue
    const items = l.attribution!.items
    const parts = l.parts ?? []
    // The input in order, each item keyed by its ID and, for a message's, the
    // message's hash, so a trimmed message no longer matches.
    const order = [...l.headIds!.map((id) => ({ id, key: id, label: id.startsWith('at_') ? 'tools' : 'head' })), ...parts.flatMap((p, i) => (p.ids ?? []).map((id) => ({ id, key: `${id}:${p.hash}`, label: `part ${i + 1} ${p.part}` })))]
    const tokens = (k: number) => items[order[k].id]?.input_tokens ?? 0
    const head = [...l.headIds!, ...(l.system ?? []).map((s) => s.hash), ...(l.tools ?? []).map((t) => t.hash)].join()
    const time = Date.parse(l.time)
    const { READ, WRITE, TTL } = cache(l.model)

    const shown = time >= since && time <= until
    const lose = (cause: string, n: number) => shown && loss(cause, n)
    let common = 0
    let cause = unknown ? 'unknown' : 'first'
    let fell = 0
    let saved = 0
    if (prev) {
      if (head !== prev.head) {
        cause = 'head'
        for (let k = 0; k < Math.min(prev.keys.length, order.length); k++) lose(cause, tokens(k))
      } else {
        const keys = order.map((o) => o.key)
        common = keys.findIndex((k, i) => k !== prev!.keys[i])
        if (common < 0) common = keys.length
        cause = common >= prev.keys.length ? '' : trimmed ? 'trim' : 'changed'
        if (cause) for (let k = common; k < Math.min(prev.keys.length, order.length); k++) lose(cause, tokens(k))
        if (!cause) common = prev.keys.length
        // What the trim took out of the items the request before had sent.
        if (cause === 'trim') for (const [id, n] of Object.entries(prev.ids)) saved += Math.max(0, n - (items[id]?.input_tokens ?? 0))
      }
    }
    const could = order.slice(0, common).reduce((n, _, k) => n + tokens(k), 0)
    const cached = Object.values(items).reduce((n, c) => n + c.cached_tokens, 0)
    const wrote = Object.values(items).reduce((n, c) => n + c.cache_write_tokens, 0)
    const stop = order.findIndex((o) => (items[o.id]?.cached_tokens ?? 0) < (items[o.id]?.input_tokens ?? 0))
    if (prev && could > cached && stop >= 0 && stop < common - 1) {
      if (cause === 'trim') fell = could - cached
      else {
        const why = time - prev.time > TTL ? 'expired' : 'short'
        lose(why, could - cached)
        cause = cause ? `${cause}+${why}` : why
      }
    }
    lose('trim', fell)
    if (cause === 'first' || cause === 'unknown') lose(cause, (l.inputTokens ?? 0) - cached)
    if (cause === 'trim' && shown) {
      const lostHere = order.slice(common, prev!.keys.length).reduce((n, _, k) => n + tokens(common + k), 0) + fell
      trimCost += lostHere * (WRITE - READ)
      trimSaved += saved * later(l) * READ
    }
    const at = stop < 0 ? 'the end' : `${order[stop].label} (${items[order[stop].id].cached_tokens}/${items[order[stop].id].input_tokens})`
    // The proxy predicts message characters only, never the base's: the part
    // its prediction ends in.
    let left = l.predictedCachedChars ?? 0
    const predicted = left ? `part ${parts.findIndex((p) => (left -= p.bytes) < 0) + 1 || parts.length}` : 'base'
    const gap = prev ? `${Math.round((time - prev.time) / 1000)}s` : ''
    const keep = () => {
      prev = { time, head, keys: order.map((o) => o.key), ids: Object.fromEntries(order.map((o) => [o.id, tokens(order.indexOf(o))])) }
      trimmed = false
      unknown = false
    }
    if (!shown) {
      keep()
      continue
    }
    if (!heading) {
      console.log(`\n${path.basename(dir)}`)
      console.log('time      gap   input  cached  could  stop at                       cause    wrote  took out  predicted')
      heading = true
    }
    console.log(`${l.time.slice(11, 19)}  ${gap.padStart(5)}  ${String(l.inputTokens).padStart(6)}  ${String(cached).padStart(6)}  ${String(could).padStart(5)}  ${at.padEnd(28)}  ${(cause || 'ok').padEnd(7)}  ${String(wrote).padStart(5)}  ${String(saved || '').padStart(8)}  ${predicted}`)
    all += l.inputTokens ?? 0
    read += cached
    keep()
  }
}

console.log(`\nread ${read} of ${all} input tokens (${all ? Math.round((100 * read) / all) : 0}%); not read, by cause:`)
for (const [cause, n] of Object.entries(lost).sort((a, b) => b[1] - a[1])) console.log(`  ${cause.padEnd(8)} ${String(n).padStart(7)}`)
if (trimCost || trimSaved) console.log(`trims cost ${Math.round(trimCost)} and saved ${Math.round(trimSaved)}, in tokens at the input price`)
if (unnamed) console.log(`${unnamed} conversation(s) skipped: usage per item logged, but not the items' IDs`)

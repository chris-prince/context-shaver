// Shows, for each logged Responses request, where the cache read stopped, by
// the API's usage per input item (`attribution`, matched to the logged items
// by their IDs), and why: what the request shared with the one before (the
// most the cache could read), how much of that it read, and what it wrote.
// Ends with the tokens each cause cost, across the conversations given.
//
// Usage: bin/node-wrapper scripts/read-codex-stops.ts [conversation dir ...]
// With none, every Codex conversation under proxy-data/logs.
//
// Causes, for the tokens the cache did not read:
//   first    the conversation's first request; nothing before it to read
//   head     the tools or instructions changed, so nothing after them matched
//   trim     a trim changed a message the request before had sent
//   changed  a message the request before had sent changed, with no trim
//   expired  the read fell short after a gap longer than the TTL (30 min)
//   short    the read fell short with no gap: the API read less than it had
// A shortfall under one 128-token step is the read ending on a step, not lost.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

type Counts = { input_tokens: number; cached_tokens: number; cache_write_tokens: number; output_tokens: number }
type Part = { part: string; hash: string; ids?: string[] }
type Line = { event: string; time: string; inputTokens?: number; cachedTokens?: number; predictedCachedChars?: number; headIds?: string[]; parts?: (Part & { bytes: number })[]; system?: { hash: string }[]; tools?: { hash: string }[]; attribution?: { items: Record<string, Counts> } }

const STEP = 128
const TTL = 30 * 60_000
const logs = path.join(import.meta.dirname, '..', 'proxy-data', 'logs')
const dirs = process.argv.length > 2 ? process.argv.slice(2) : readdirSync(logs).filter((d) => d.startsWith('codex-')).map((d) => path.join(logs, d))

const lost: Record<string, number> = {}
const loss = (cause: string, n: number) => n > 0 && (lost[cause] = (lost[cause] ?? 0) + n)
let unnamed = 0
let all = 0
let read = 0

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
  console.log(`\n${path.basename(dir)}`)
  console.log('time      gap   input  cached  could  stop at                       cause    wrote  predicted')
  let prev: { time: number; head: string; keys: string[] } | undefined
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

    let common = 0
    let cause = 'first'
    if (prev) {
      if (head !== prev.head) {
        cause = 'head'
        for (let k = 0; k < Math.min(prev.keys.length, order.length); k++) loss(cause, tokens(k))
      } else {
        const keys = order.map((o) => o.key)
        common = keys.findIndex((k, i) => k !== prev!.keys[i])
        if (common < 0) common = keys.length
        cause = common >= prev.keys.length ? '' : trimmed ? 'trim' : 'changed'
        if (cause) for (let k = common; k < Math.min(prev.keys.length, order.length); k++) loss(cause, tokens(k))
        if (!cause) common = prev.keys.length
      }
    }
    const could = order.slice(0, common).reduce((n, _, k) => n + tokens(k), 0)
    const cached = Object.values(items).reduce((n, c) => n + c.cached_tokens, 0)
    const wrote = Object.values(items).reduce((n, c) => n + c.cache_write_tokens, 0)
    if (could - cached >= STEP) {
      const why = prev && time - prev.time > TTL ? 'expired' : 'short'
      loss(why, could - cached)
      cause = cause ? `${cause}+${why}` : why
    }
    if (cause === 'first') loss('first', (l.inputTokens ?? 0) - cached)

    const stop = order.findIndex((o) => (items[o.id]?.cached_tokens ?? 0) < (items[o.id]?.input_tokens ?? 0))
    const at = stop < 0 ? 'the end' : `${order[stop].label} (${items[order[stop].id].cached_tokens}/${items[order[stop].id].input_tokens})`
    // The proxy predicts message characters only, never the base's: the part
    // its prediction ends in.
    let left = l.predictedCachedChars ?? 0
    const predicted = left ? `part ${parts.findIndex((p) => (left -= p.bytes) < 0) + 1 || parts.length}` : 'base'
    const gap = prev ? `${Math.round((time - prev.time) / 1000)}s` : ''
    console.log(`${l.time.slice(11, 19)}  ${gap.padStart(5)}  ${String(l.inputTokens).padStart(6)}  ${String(cached).padStart(6)}  ${String(could).padStart(5)}  ${at.padEnd(28)}  ${(cause || 'ok').padEnd(7)}  ${String(wrote).padStart(5)}  ${predicted}`)
    all += l.inputTokens ?? 0
    read += cached
    prev = { time, head, keys: order.map((o) => o.key) }
    trimmed = false
  }
}

console.log(`\nread ${read} of ${all} input tokens (${all ? Math.round((100 * read) / all) : 0}%); not read, by cause:`)
for (const [cause, n] of Object.entries(lost).sort((a, b) => b[1] - a[1])) console.log(`  ${cause.padEnd(8)} ${String(n).padStart(7)}`)
if (unnamed) console.log(`${unnamed} conversation(s) skipped: usage per item logged, but not the items' IDs`)

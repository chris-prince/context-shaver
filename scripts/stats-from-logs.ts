// Replays a conversation's logs through src/stats.ts and prints what
// `:shaver info` would have said at a request. With --check-journal it also
// journals each request (src/journal.ts) and checks that replaying the journal
// gives the stats observed after every one.
//
// Usage: bin/node-wrapper scripts/stats-from-logs.ts <session dir> [--request N] [--check-journal]

import { mkdtempSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { describe, isSuggestion, observe, render, type Stats } from '../src/stats.ts'
import { record, replay } from '../src/journal.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { request: { type: 'string' }, 'check-journal': { type: 'boolean' } } })
const dir = positionals[0]
if (!dir) {
  console.error('usage: bin/node-wrapper scripts/stats-from-logs.ts <session dir> [--request N] [--check-journal]')
  process.exit(1)
}
const part = (h: string) => JSON.parse(readFileSync(path.join(dir, 'parts', h + '.json'), 'utf8'))
const events = readFileSync(path.join(dir, 'step_events.jsonl'), 'utf8')
  .split('\n')
  .flatMap((l) => {
    try {
      return [JSON.parse(l)]
    } catch {
      return []
    }
  })
// The answered request lines, with their tools, and the times of the requests
// a trim advanced on, which share their compaction line's time.
const reqs = events.filter((e) => e.event === 'request' && e.inputTokens && e.tools)
const advanced = new Set(events.filter((e) => e.event === 'compaction' && e.advanced).map((e) => e.time))
if (!reqs.length) {
  console.error(`no request lines with usage under ${dir}`)
  process.exit(1)
}
const last = values.request === undefined ? reqs.length - 1 : Number(values.request)
if (!(Number.isInteger(last) && 0 <= last && last < reqs.length)) {
  console.error(`request ${last} is out of range (0-${reqs.length - 1})`)
  process.exit(1)
}
const count = (s: Stats | undefined, r: any) => {
  const body = { model: r.model, messages: r.parts.map((p: { hash: string }) => part(p.hash)), system: r.system.map((x: { hash: string }) => part(x.hash)), tools: r.tools.map((t: { hash: string }) => part(t.hash)) }
  const sent = describe(body, r.trimmedEnd ?? r.frontierEnd ?? { tools: 0, reasoning: 0 }, r.time, advanced.has(r.time))
  if (isSuggestion(body.messages)) sent.suggestion = true
  return observe(s, sent, r.inputTokens, r.outputTokens ?? 0, apiCounts(r))
}
// What the API counted, as the proxy reads it (src/responses.ts, counted): the
// head's and each part's tokens, where the usage per item counted all of it.
const apiCounts = (r: any) => {
  const items = r.attribution?.items
  if (!items) return
  const sum = (ids: string[] | undefined) => (ids?.length && ids.every((id) => items[id]?.input_tokens !== undefined) ? ids.reduce((n, id) => n + items[id].input_tokens, 0) : undefined)
  return { defs: sum(r.headIds), parts: r.parts.map((p: { ids?: string[] }) => sum(p.ids)) }
}
const journal = path.join(mkdtempSync(path.join(tmpdir(), 'journal-')), 'journal.jsonl')
let s: Stats | undefined
for (const r of reqs.slice(0, last + 1)) {
  const next = count(s, r)
  if (values['check-journal'])
    record(journal, s, next, {
      input_tokens: r.inputTokens - r.cachedTokens - r.writtenTokens5m - r.writtenTokens60m,
      cache_read_input_tokens: r.cachedTokens,
      cache_creation_input_tokens: r.writtenTokens5m + r.writtenTokens60m,
      cache_creation: { ephemeral_5m_input_tokens: r.writtenTokens5m, ephemeral_1h_input_tokens: r.writtenTokens60m },
      output_tokens: r.outputTokens ?? 0,
    })
  s = next
}
// Counts the requests again alongside the journal's replay, so that neither
// side holds more than the stats after one request.
if (values['check-journal']) {
  let again: Stats | undefined
  let i = 0
  for (const replayed of replay(journal)) {
    again = count(again, reqs[i])
    if (!isDeepStrictEqual(again, replayed)) {
      console.error(`journal replay differs from the observed stats at request ${i}`)
      process.exit(1)
    }
    i++
  }
  if (i !== last + 1) {
    console.error(`journal replay ends at request ${i}, not ${last + 1}`)
    process.exit(1)
  }
  console.error(`journal replay matches the observed stats at all ${i} requests (${readFileSync(journal).length.toLocaleString('en-US')} bytes)`)
}
console.log(render(s!, path.basename(dir)))

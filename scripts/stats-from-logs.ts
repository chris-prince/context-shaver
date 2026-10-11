// Replays a conversation's logs through src/stats.ts and prints what
// `:shaver stats` would have said at a request, to compare with
// scripts/analyze-context.py's output for the same request. With
// --check-journal it also journals each request (src/journal.ts) and checks
// that replaying the journal gives the stats observed after every one.
//
// Usage: node scripts/stats-from-logs.ts <session dir> [--request N] [--check-journal]

import { mkdtempSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { describe, observe, render, type Stats } from '../src/stats.ts'
import { record, replay } from '../src/journal.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { request: { type: 'string' }, 'check-journal': { type: 'boolean' } } })
const dir = positionals[0]
if (!dir) {
  console.error('usage: node scripts/stats-from-logs.ts <session dir> [--request N] [--check-journal]')
  process.exit(1)
}
const part = (h: string) => JSON.parse(readFileSync(path.join(dir, 'parts', h + '.json'), 'utf8'))
// The request lines analyze-context.py reads: answered, with their tools.
const reqs = readFileSync(path.join(dir, 'step_events.jsonl'), 'utf8')
  .split('\n')
  .flatMap((l) => {
    try {
      const e = JSON.parse(l)
      return e.event === 'request' && e.inputTokens && e.tools ? [e] : []
    } catch {
      return []
    }
  })
const last = values.request === undefined ? reqs.length - 1 : Number(values.request)
const count = (s: Stats | undefined, r: any) => {
  const body = { model: r.model, messages: r.parts.map((p: { hash: string }) => part(p.hash)), system: r.system.map((x: { hash: string }) => part(x.hash)), tools: r.tools.map((t: { hash: string }) => part(t.hash)) }
  return observe(s, describe(body, r.trimmedEnd ?? r.frontierEnd ?? { tools: 0, reasoning: 0 }, r.time), r.inputTokens, r.outputTokens ?? 0)
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
if (!s) {
  console.error(`no request lines with usage under ${dir}`)
  process.exit(1)
}
console.log(render(s, path.basename(dir)))

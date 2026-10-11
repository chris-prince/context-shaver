// Replays a conversation's logs through src/stats.ts and prints what
// `:shaver stats` would have said at a request, to compare with
// scripts/analyze-context.py's output for the same request.
//
// Usage: node scripts/stats-from-logs.ts <session dir> [--request N]

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { describe, observe, render, type Stats } from '../src/stats.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { request: { type: 'string' } } })
const dir = positionals[0]
if (!dir) {
  console.error('usage: node scripts/stats-from-logs.ts <session dir> [--request N]')
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
let s: Stats | undefined
for (const r of reqs.slice(0, last + 1)) {
  const body = { model: r.model, messages: r.parts.map((p: { hash: string }) => part(p.hash)), system: r.system.map((x: { hash: string }) => part(x.hash)), tools: r.tools.map((t: { hash: string }) => part(t.hash)) }
  s = observe(s, describe(body, r.trimmedEnd ?? r.frontierEnd ?? { tools: 0, reasoning: 0 }, r.time), r.inputTokens, r.outputTokens ?? 0)
}
if (!s) {
  console.error(`no request lines with usage under ${dir}`)
  process.exit(1)
}
console.log(render(s, path.basename(dir)))

// Rewrites every kinds sidecar of one conversation with the current kinds(),
// so parts logged before a rule changed are attributed as new ones are.
// Usage: node scripts/refresh-kinds.ts logs-mini-ctx-claude/<conversation>
import { readFileSync, writeFileSync } from 'node:fs'
import { kinds } from '../src/log.ts'

const dir = process.argv[2]
const requests = readFileSync(`${dir}/step_events.jsonl`, 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l)).filter((e) => e.event === 'request')

// A part is preamble if any request sent it before the first assistant
// message, as the server decides per request.
const preamble = new Set<string>()
for (const r of requests) {
  const end = r.parts.findIndex((p: { part: string }) => p.part === 'assistant')
  r.parts.forEach((p: { hash: string }, i: number) => (end < 0 || i < end) && preamble.add(p.hash))
}

let n = 0
for (const h of new Set(requests.flatMap((r) => r.parts.map((p: { hash: string }) => p.hash)))) {
  const json = readFileSync(`${dir}/parts/${h}.json`, 'utf8')
  writeFileSync(`${dir}/parts/${h}.kinds.json`, JSON.stringify(kinds(json, JSON.parse(json), preamble.has(h))))
  n++
}
console.log(`rewrote ${n} sidecars`)

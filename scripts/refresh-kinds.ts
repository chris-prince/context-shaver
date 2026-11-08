// Rewrites every kinds sidecar of one conversation with the current kinds(),
// so messages logged before a rule changed are attributed as new ones are.
// Usage: bin/node-wrapper scripts/refresh-kinds.ts proxy-data/logs/<conversation>
import { readFileSync, writeFileSync } from 'node:fs'
import { kinds, messagesOf, objectsOf } from '../src/log.ts'

const dir = process.argv[2]
const objects = objectsOf(dir)
const requests = readFileSync(`${dir}/step_events.jsonl`, 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l)).filter((e) => e.event === 'request')

// A message is preamble if any request sent it before the first assistant
// message, as the server decides per request.
const preamble = new Set<string>()
for (const r of requests) {
  const messages = messagesOf(r)
  const end = messages.findIndex((p) => p.role === 'assistant')
  messages.forEach((p, i) => (end < 0 || i < end) && preamble.add(p.hash))
}

let n = 0
for (const h of new Set(requests.flatMap((r) => messagesOf(r).map((p) => p.hash)))) {
  const json = readFileSync(`${objects}/${h}.json`, 'utf8')
  writeFileSync(`${objects}/${h}.kinds.json`, JSON.stringify(kinds(json, JSON.parse(json), preamble.has(h))))
  n++
}
console.log(`rewrote ${n} sidecars`)

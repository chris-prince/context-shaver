// `shaver info` for any conversation, from its state files and log, with no
// proxy running: the same text the proxy answers with (src/info.ts).
//
// Usage: bin/node-wrapper scripts/info.ts <key> [--dir proxy-data] [--cache-ttl-seconds 3600]
//
// The key is the conversation's state and log folder name. Its summary records
// are checked against the messages of its last logged request, as the proxy
// checks them against the request asking, and the version is that request's
// proxy's. A summary fork in flight and requests the journal missed are known
// only to a running proxy, so neither is shown.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { infoText, journaled, summariesFrom } from '../src/info.ts'
import { LOG_DIR, objectsOf, receivedOf } from '../src/log.ts'
import { turnsOf, validChain } from '../src/summary.ts'
import type { ApiMsg } from '../src/items.ts'

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', default: path.resolve(import.meta.dirname, '..', 'proxy-data') },
    'cache-ttl-seconds': { type: 'string', default: '3600' },
  },
})
const key = positionals[0]
if (!key) throw new Error('usage: scripts/info.ts <key> [--dir proxy-data] [--cache-ttl-seconds 3600]')
const stateDir = path.join(a.dir, 'state')
const logDir = path.join(a.dir, LOG_DIR, key)
const { stats, cost } = journaled(stateDir, key, Number(a['cache-ttl-seconds']) * 1000)
if (!stats) throw new Error(`no journal for ${key} in ${stateDir}`)

const lines = existsSync(path.join(logDir, 'step_events.jsonl'))
  ? readFileSync(path.join(logDir, 'step_events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  : []
const requests = lines.filter((e) => e.event === 'request')
const last = requests.at(-1)
const sums = summariesFrom(stateDir, key)
let valid = 0
if (last && sums.chain.length) {
  const objects = objectsOf(logDir)
  const msgs: ApiMsg[] = receivedOf(lines).at(-1)!.map((h) => JSON.parse(readFileSync(path.join(objects, `${h}.json`), 'utf8')))
  const ids = JSON.parse(readFileSync(path.join(stateDir, `${key}.ids.json`), 'utf8'))
  valid = validChain(sums.chain, msgs, turnsOf(msgs, ids.turns, () => NaN)).length
}
const state = existsSync(path.join(stateDir, `${key}.json`)) ? JSON.parse(readFileSync(path.join(stateDir, `${key}.json`), 'utf8')) : {}
console.log(infoText(key, last?.version ?? 'unknown', stats, false, cost, sums, state.summarized ?? 0, { valid }))

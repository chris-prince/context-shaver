// `shaver info` for any conversation, from its state files and log, with no
// proxy running: the same text the proxy answers with (src/info.ts).
//
// Usage: bin/shaver-info <key> [--dir proxy-data] [--cache-ttl-seconds 3600]
//
// The key is the conversation's state and log folder name. Its summary records
// are checked against the messages of its last logged request, as the proxy
// checks them against the request asking, and the version is that request's
// proxy's. A summary fork in flight and requests the journal missed are known
// only to a running proxy, so neither is shown. The cost is the session's, its
// ancestor conversations and subagents included, as the proxy's is (src/info.ts,
// othersOf).

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { infoText, journaled, othersOf, summariesFrom } from '../src/info.ts'
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
const fail = (why: string): never => {
  console.error(why)
  process.exit(1)
}
if (!key) fail('usage: bin/shaver-info <key> [--dir proxy-data] [--cache-ttl-seconds 3600]; the key is a folder name under proxy-data/logs/')
const stateDir = path.join(a.dir, 'state')
const logDir = path.join(a.dir, LOG_DIR, key)
if (!existsSync(path.join(stateDir, `${key}.journal.jsonl`))) fail(`no journal for ${key} in ${stateDir}`)
const ttlMs = Number(a['cache-ttl-seconds']) * 1000
const { stats, cost } = journaled(stateDir, key, ttlMs)
// A journal of side requests only (a title, a recap: the bare lines) has no
// conversation stats to show.
if (!stats) fail(`${key} has only side requests journaled, so no conversation stats`)

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
  // A conversation from before internal IDs has no IDs file; as in the
  // proxy (idsOf, server.ts), none of its turns has an ID then.
  const idsFile = path.join(stateDir, `${key}.ids.json`)
  const ids = existsSync(idsFile) ? JSON.parse(readFileSync(idsFile, 'utf8')) : { turns: {} }
  valid = validChain(sums.chain, msgs, turnsOf(msgs, ids.turns, () => NaN)).length
}
const state = existsSync(path.join(stateDir, `${key}.json`)) ? JSON.parse(readFileSync(path.join(stateDir, `${key}.json`), 'utf8')) : {}
const others = othersOf(stateDir, key, (k) => journaled(stateDir, k, ttlMs))
console.log(infoText(key, last?.version ?? 'unknown', stats, false, cost, sums, state.summarized ?? 0, { valid }, others))

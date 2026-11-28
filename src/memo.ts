// Checks on the memos (trim.ts, notes.ts, stats.ts), on only where the
// backtest turns them on, or SHAVER_MEMO_CHECKS=1 for a run of the tests:
//
// - every hit is worked out again, and a value that differs throws;
// - the contents of the messages a request is prepared from are frozen, so
//   a change made in place to a block, or to a message's list of them, which
//   would leave a memo stale, throws where it's made (a message may be given
//   new content, as skills.ts and defer.ts do, and keyOf sees that);
// - each memo counts its lookups and misses, the misses on a key already
//   looked up in the request (an entry thrown out and needed again), and the
//   distinct contents missed on (more misses than those, and the same
//   content keeps coming in new objects).

import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'

export const checks = { on: process.env.SHAVER_MEMO_CHECKS === '1' }

type Tally = { lookups: number; misses: number; again: number; contents: number }
const tallies = new Map<string, Tally>()
let seen = new WeakMap<object, Set<string>>()
let contents = new Map<string, Set<string>>()

// What a memo kept for a request only, forgotten when the next starts.
export const perRequest: Array<() => void> = []

// A request starts: memos kept for one forget theirs, and what's been looked
// up and missed on is the request's own from here.
export function newRequest(): void {
  for (const forget of perRequest) forget()
  seen = new WeakMap()
  for (const [name, cs] of contents) tallies.get(name)!.contents += cs.size
  contents = new Map()
}

// A memo's lookup of `key` on `at`: `value` what it gave, from the memo if
// `hit`, and `fresh` what it would be worked out again.
export function checked<T>(name: string, at: object, key: string, hit: boolean, value: T, fresh: () => T, content: () => string): T {
  const t = tallies.get(name) ?? tallies.set(name, { lookups: 0, misses: 0, again: 0, contents: 0 }).get(name)!
  t.lookups++
  // By memo too: two memos can look up the same object by the same key.
  const keys = seen.get(at) ?? seen.set(at, new Set()).get(at)!
  const before = keys.has(name + '\0' + key)
  keys.add(name + '\0' + key)
  if (hit) {
    const v = fresh()
    if (!isDeepStrictEqual(v, value)) throw new Error(`memo ${name}: a hit gave ${JSON.stringify(value)}, worked out again ${JSON.stringify(v)}`)
    return value
  }
  t.misses++
  if (before) t.again++
  const cs = contents.get(name) ?? contents.set(name, new Set()).get(name)!
  cs.add(createHash('sha256').update(content()).digest('base64'))
  return value
}

// Messages with their contents frozen through.
export function contentsFrozen(msgs: readonly { content: unknown }[]): void {
  for (const m of msgs) deepFrozen(m.content)
}
function deepFrozen(v: unknown): void {
  if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return
  Object.freeze(v)
  for (const x of Object.values(v)) deepFrozen(x)
}

// The tallies, a line a memo, and a warning for each with misses again on
// more than 1% of its lookups.
export function report(): string[] {
  newRequest()
  const rows = [...tallies].map(([name, t]) => `  ${name}: ${t.lookups} lookups, ${t.misses} misses, ${t.again} again, ${t.contents} distinct contents missed on`)
  const warn = [...tallies].filter(([, t]) => t.again > t.lookups / 100).map(([name, t]) => `  WARNING ${name}: ${t.again} of ${t.lookups} lookups missed again`)
  return ['Memo checks', ...rows, ...warn]
}

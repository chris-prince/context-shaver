// Checks the journals against each harness's own record of the API calls it
// made, and lists every call no journal line accounts for.
//
//   bin/node-wrapper scripts/audit-journal.ts [--since <iso date>] [--verbose]
//
// Sources: Codex's rollout files (one token_count event per API call),
// OpenCode's log (one "stream" line per model call, tagged with its agent),
// and Claude Code's transcripts (one entry per main-loop request; its side
// requests leave no record there, so for Claude this only finds misses).
// A call matches a journal line in the same session when their times are
// within WINDOW and their input tokens agree.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { bareLines, history, summaryForks } from '../src/journal.ts'
import type { Usage } from '../src/cost.ts'

const WINDOW = 120_000
const SLOW = 30 * 60_000
// A :shaver command, which once could be typed with a space after the colon.
const COMMAND = /^\s*:\s*shaver\b/
const STATE = join(import.meta.dirname, '..', 'proxy-data', 'state')

type Call = { harness: string; session: string; time: number; input?: number; kind: string }
type Line = { session: string; time: number; input?: number; used: boolean }

const args = process.argv.slice(2)
const since = args.includes('--since') ? Date.parse(args[args.indexOf('--since') + 1]) : 0
const verbose = args.includes('--verbose')

function lines(file: string) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)] } catch { return [] }
  })
}

function walk(dir: string, out: string[] = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (p.endsWith('.jsonl')) out.push(p)
  }
  return out
}

const inputOf = (u?: Usage) => u && u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)

// Journal lines, by the session id in the key.
function journal(): Line[] {
  const out: Line[] = []
  for (const f of readdirSync(STATE).filter((f) => f.endsWith('.journal.jsonl'))) {
    const m = f.match(/^(claude|codex|opencode)-(.+?)-[0-9a-f]{8}\.journal\.jsonl$/)
    if (!m) continue
    const session = m[2].replace(/-(main|sub-.*)$/, '')
    const file = join(STATE, f)
    // A resent line keeps the stats before it, so its own size is its usage.
    for (const { stats: s, usage, resent } of history(file)) out.push({ session, time: Date.parse(s.time), input: resent ? inputOf(usage) : s.inputTokens, used: false })
    for (const k of summaryForks(file)) out.push({ session, time: Date.parse(k.time), input: inputOf(k.usage), used: false })
    // A bare line with no usage matches a call of any size.
    for (const b of bareLines(file)) out.push({ session, time: Date.parse(b.time), input: inputOf(b.usage), used: false })
  }
  return out
}

function codex(): Call[] {
  const out: Call[] = []
  for (const f of walk(join(homedir(), '.codex', 'sessions'))) {
    const es = lines(f)
    const session = es.find((e) => e.type === 'session_meta')?.payload?.id ?? ''
    // A token_usage_record is one per call, by its response id. Rollouts too
    // old to have them give a token_count per call, but Codex sends it again,
    // unchanged, when a task starts, so only one whose running total moved counts.
    // A :shaver command's reply, which the proxy gives itself, is recorded as
    // a call too, so it's told apart by the prompt before it.
    const records = es.some((e) => e.type === 'token_usage_record')
    const seen = new Set<string>()
    let total = 0, prompt = ''
    for (const e of es) {
      const p = e.payload
      if (e.type === 'response_item' && p?.type === 'message' && p.role === 'user') prompt = p.content?.map((c: { text?: string }) => c.text ?? '').join('') ?? ''
      let input: number | undefined
      if (records && e.type === 'token_usage_record' && !seen.has(p.response_id)) seen.add(p.response_id), (input = p.usage.input_tokens)
      if (!records && p?.type === 'token_count' && p.info && p.info.total_token_usage.input_tokens !== total) (total = p.info.total_token_usage.input_tokens), (input = p.info.last_token_usage.input_tokens)
      if (input !== undefined) out.push({ harness: 'codex', session, time: Date.parse(e.timestamp), input, kind: COMMAND.test(prompt) ? 'command' : 'call' })
    }
  }
  return out
}

// OpenCode's database has a step-finish part per main-loop call, compactions
// included, with the agent that made it; title requests leave no record.
function opencode(): Call[] {
  const db = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
  if (!existsSync(db)) return []
  const sql = `select p.session_id, p.time_created, json_extract(p.data,'$.tokens'), json_extract(m.data,'$.agent') from part p join message m on m.id = p.message_id where json_extract(p.data,'$.type') = 'step-finish'`
  const query = (q: string) => JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', db, q], { maxBuffer: 1 << 28 }).toString() || '[]') as Record<string, string | number>[]
  const input = (t: string) => {
    const n = JSON.parse(t)
    return n.input + n.cache.read + n.cache.write
  }
  const v1 = query(sql).map((r) => ({ harness: 'opencode', session: String(r.session_id), time: Number(r.time_created), input: input(String(Object.values(r)[2])), kind: String(Object.values(r)[3]) }))
  // OpenCode 2 has a row per call in session_message instead, and a row of its
  // own for each compaction, which gives no tokens.
  const rows = query(`select session_id, type, json_extract(data,'$.time.created') t, json_extract(data,'$.tokens') k, json_extract(data,'$.agent') a, coalesce(json_extract(data,'$.text'), json_extract(data,'$.content[0].text'), json_extract(data,'$.parts[0].text'), '') x from session_message where type in ('user','assistant','compaction') order by session_id, seq`)
  const v2: Call[] = []
  let prompt = ''
  for (const r of rows) {
    if (r.type === 'user') prompt = String(r.x)
    // A call that failed has no tokens; whether it reached the API, it doesn't say.
    else v2.push({ harness: 'opencode', session: String(r.session_id), time: Number(r.t ?? 0), input: r.k ? input(String(r.k)) : undefined, kind: r.type === 'compaction' ? 'compaction' : COMMAND.test(prompt) ? 'command' : r.k ? String(r.a) : 'error' })
  }
  return [...v1, ...v2]
}

function claude(): Call[] {
  const out: Call[] = []
  for (const f of walk(join(homedir(), '.claude', 'projects'))) {
    const seen = new Set<string>()
    for (const e of lines(f)) {
      const u = e.message?.usage
      if (e.type !== 'assistant' || !u || !e.requestId || seen.has(e.requestId)) continue
      seen.add(e.requestId)
      const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      out.push({ harness: 'claude', session: e.sessionId, time: Date.parse(e.timestamp), input, kind: e.isSidechain ? 'subagent' : 'main' })
    }
  }
  return out
}

const journaled = journal()
const bySession = new Map<string, Line[]>()
for (const l of journaled) (bySession.get(l.session) ?? bySession.set(l.session, []).get(l.session)!).push(l)

// Only calls the proxy could have seen count: a session with no journal ran
// without it, and one whose journal starts late ran without it till then.
const first = new Map([...bySession].map(([k, ls]) => [k, Math.min(...ls.map((l) => l.time))]))
const calls = [...codex(), ...opencode(), ...claude()].filter((c) => c.time >= since && first.has(c.session) && c.time >= first.get(c.session)!)
calls.sort((a, b) => a.time - b.time)

// A call's time is when its reply ended, a line's when the request came in, so
// the nearest unused line before it with the same input wins.
// A command's reply never reaches the API, so it has no line to match.
const missed: Call[] = []
for (const c of calls) {
  if (c.kind === 'command' || c.kind === 'error') continue
  const near = bySession.get(c.session)!.filter((l) => !l.used && l.time <= c.time + WINDOW && l.time >= c.time - SLOW)
  const same = near.filter((l) => c.input === undefined || l.input === undefined || l.input === c.input)
  const hit = same.sort((a, b) => Math.abs(a.time - c.time) - Math.abs(b.time - c.time))[0]
  if (hit) hit.used = true
  else missed.push(c)
}

const tally = new Map<string, { calls: number; missed: number }>()
for (const c of calls) {
  const k = `${c.harness} ${c.kind}`
  const t = tally.get(k) ?? tally.set(k, { calls: 0, missed: 0 }).get(k)!
  t.calls++
  if (missed.includes(c)) t.missed++
}
console.log('harness  kind          calls  missed')
for (const [k, t] of [...tally].sort()) {
  const [h, kind] = k.split(' ')
  console.log(`${h.padEnd(8)} ${kind.padEnd(12)} ${String(t.calls).padStart(6)} ${String(t.missed).padStart(7)}`)
}
if (verbose) for (const c of missed) console.log(new Date(c.time).toISOString(), c.harness, c.kind, c.session, c.input ?? '')
process.exitCode = missed.length ? 1 : 0

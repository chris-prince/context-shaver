// Checks our token counts and prices against each harness's own records.
//
// Claude Code writes `cost-state` lines to its session transcripts
// (~/.claude/projects/*/*.jsonl): per model, its token totals and the dollars
// it works out for them. This prices the same totals with our table (cost.ts,
// spent) and compares, per transcript and model, then summed per model. The
// totals are cumulative in a transcript, so only its last cost-state line is
// read. Claude Code's figure is its own estimate, not a bill.
//
// Codex logs each answer's usage as a `token_count` event in its rollout files
// ($CODEX_HOME/sessions, ~/.codex by default), with no dollars. OpenCode keeps
// each reply's tokens and dollar cost in its database
// (~/.local/share/opencode/opencode.db). For both, each record is matched to
// a request line in our logs (proxy-data/logs) of the same session with the
// same input (cached included), cached and output tokens; one that matches
// none means a count that differs, or a request that didn't go through the
// proxy. Cache writes aren't compared: for answers that don't report them we
// infer them (responses.ts, inferred). A matched OpenCode reply is priced
// with the model and provider our line logged (OpenCode only says the router,
// OpenRouter) and compared with its cost.
//
// Usage: bin/node-wrapper scripts/check-costs.ts [--days N] [--all]
//   --days N   only records from the last N days (default 30)
//   --all      print every Claude Code transcript and unmatched record, not
//              just transcripts that differ by over 1% and 10 unmatched a harness

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { spent } from '../src/cost.ts'
import { modelOf } from '../src/models.ts'

const { values } = parseArgs({ options: { days: { type: 'string', default: '30' }, all: { type: 'boolean' } } })
const since = Date.now() - Number(values.days) * 86_400_000
const pct = (a: number, b: number) => (b ? `${(((a - b) / b) * 100).toFixed(1)}%` : 'n/a')
const shown = (n: number) => (values.all ? n : Math.min(n, 10))

// ---- Claude Code: cost-state totals, priced with our table

type ModelUsage = { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; cacheCreationEphemeral5mInputTokens?: number; webSearchRequests?: number; costUSD: number }

const ccCost = (model: string, u: ModelUsage) =>
  spent(model, undefined, {
    input_tokens: u.inputTokens,
    cache_read_input_tokens: u.cacheReadInputTokens,
    cache_creation_input_tokens: u.cacheCreationInputTokens,
    cache_creation: { ephemeral_5m_input_tokens: u.cacheCreationEphemeral5mInputTokens ?? 0 },
    output_tokens: u.outputTokens,
    server_tool_use: { web_search_requests: u.webSearchRequests ?? 0 },
  })

function claudeCode(root: string) {
  console.log('== Claude Code')
  const sums = new Map<string, { theirs: number; ours: number; transcripts: number }>()
  let files = 0
  for (const project of existsSync(root) ? readdirSync(root) : []) {
    const dir = path.join(root, project)
    if (!statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name)
      if (!name.endsWith('.jsonl') || statSync(file).mtimeMs < since) continue
      let last: { modelUsage: Record<string, ModelUsage> } | undefined
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('"type":"cost-state"')) continue
        try { last = JSON.parse(line) } catch {}
      }
      if (!last) continue
      files++
      for (const [model, u] of Object.entries(last.modelUsage)) {
        if (!modelOf(model, undefined).price) {
          console.log(`${name} ${model}: no price in our table (Claude Code: $${u.costUSD.toFixed(4)})`)
          continue
        }
        const o = ccCost(model, u)
        const s = sums.get(model) ?? { theirs: 0, ours: 0, transcripts: 0 }
        sums.set(model, { theirs: s.theirs + u.costUSD, ours: s.ours + o, transcripts: s.transcripts + 1 })
        const split = u.cacheCreationEphemeral5mInputTokens === undefined ? ', no 5m/1h split' : ''
        if (values.all || Math.abs(o - u.costUSD) > 0.01 * u.costUSD)
          console.log(`${project}/${name} ${model}: Claude Code $${u.costUSD.toFixed(4)}, ours $${o.toFixed(4)} (${pct(o, u.costUSD)}; ${u.webSearchRequests ?? 0} web searches${split})`)
      }
    }
  }
  console.log(`${files} transcripts with cost-state lines, changed in the last ${values.days} days`)
  for (const [model, s] of sums)
    console.log(`${model}: ${s.transcripts} transcripts, Claude Code $${s.theirs.toFixed(2)}, ours $${s.ours.toFixed(2)} (${pct(s.ours, s.theirs)})`)
}

// ---- Codex and OpenCode: each record matched to one of our request lines

// A request's tokens: all input (cached included), cached, output.
type Counts = { input: number; cached: number; output: number }
type Ours = Counts & { time: string; model: string; provider?: string }
type Theirs = Counts & { time: string; cost?: number }
const keyOf = (c: Counts) => `${c.input}/${c.cached}/${c.output}`

// Our request lines with usage, by session, for one harness's log folders,
// named `<harness>-<session>-<hash>` (a session has one a conversation key).
function ourLines(logs: string, harness: string): Map<string, Ours[]> {
  const bySession = new Map<string, Ours[]>()
  for (const dir of existsSync(logs) ? readdirSync(logs) : []) {
    if (!dir.startsWith(`${harness}-`)) continue
    const file = path.join(logs, dir, 'step_events.jsonl')
    if (!existsSync(file) || statSync(file).mtimeMs < since) continue
    const session = dir.slice(harness.length + 1, dir.lastIndexOf('-'))
    const lines = bySession.get(session) ?? []
    // Any line with token counts is a call upstream: a request, a side
    // request, one resent as it came.
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"inputTokens"')) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      if (!j.inputTokens || Date.parse(j.time) < since) continue
      lines.push({ input: j.inputTokens, cached: j.cachedTokens ?? 0, output: j.outputTokens ?? 0, time: j.time, model: j.model, provider: j.provider })
    }
    bySession.set(session, lines)
  }
  return bySession
}

// Pairs each of theirs with one of ours of equal counts; what's left of each
// is unmatched.
function match(theirs: Theirs[], ours: Ours[]) {
  const free = new Map<string, Ours[]>()
  for (const o of ours) free.set(keyOf(o), [...(free.get(keyOf(o)) ?? []), o])
  const pairs: [Theirs, Ours][] = []
  const unmatched: Theirs[] = []
  for (const t of theirs) {
    const o = free.get(keyOf(t))?.shift()
    if (o) pairs.push([t, o])
    else unmatched.push(t)
  }
  return { pairs, unmatched, left: [...free.values()].flat() }
}

function report(name: string, theirs: Map<string, Theirs[]>, ours: Map<string, Ours[]>) {
  let records = 0, sessions = 0, lines = 0
  const pairs: [Theirs, Ours][] = []
  const unmatched: [string, Theirs, Ours | undefined][] = []
  let own = 0, left = 0
  for (const [session, t] of theirs) {
    const o = ours.get(session)
    if (!o?.length) continue
    sessions++
    records += t.length
    lines += o.length
    const m = match(t, o)
    pairs.push(...m.pairs)
    left += m.left.length
    for (const u of m.unmatched) {
      // The proxy's own answers (shaver commands) report all input as cached
      // and no output (command.ts, responses.ts), and aren't sent upstream.
      if (u.input === u.cached && !u.output) { own++; continue }
      // Shown beside our unmatched line nearest in time, if any.
      const near = m.left.reduce<Ours | undefined>((a, x) => (!a || Math.abs(Date.parse(x.time) - Date.parse(u.time)) < Math.abs(Date.parse(a.time) - Date.parse(u.time)) ? x : a), undefined)
      unmatched.push([session, u, near])
    }
  }
  console.log(`${sessions} ${name} sessions in the last ${values.days} days with our logs: ${records} ${name} records, ${lines} of our lines with tokens`)
  console.log(`${pairs.length} records match one of our lines exactly; ${own} are the proxy's own answers; ${unmatched.length} match none; ${left} of our lines match no record`)
  for (const [session, u, near] of unmatched.slice(0, shown(unmatched.length)))
    console.log(`  ${session} ${u.time}: ${name} input ${u.input}, cached ${u.cached}, output ${u.output}` +
      (near ? `; nearest of ours ${near.time}: input ${near.input}, cached ${near.cached}, output ${near.output}` : '; none of ours left'))
  return pairs
}

function codex(home: string, logs: string) {
  console.log(`\n== Codex`)
  const theirs = new Map<string, Theirs[]>()
  const walk = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.jsonl') ? [path.join(dir, e.name)] : [])) : []
  for (const file of walk(path.join(home, 'sessions'))) {
    if (statSync(file).mtimeMs < since) continue
    const session = path.basename(file, '.jsonl').slice(-36)
    const records: Theirs[] = []
    // A token_count event repeats the last one's usage when only rate limits
    // changed, so a record is one whose running total moved.
    let total = ''
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"type":"token_count"')) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      const info = j.payload?.info
      if (!info?.last_token_usage || JSON.stringify(info.total_token_usage) === total) continue
      total = JSON.stringify(info.total_token_usage)
      if (Date.parse(j.timestamp) < since) continue
      const u = info.last_token_usage
      records.push({ input: u.input_tokens, cached: u.cached_input_tokens ?? 0, output: u.output_tokens ?? 0, time: j.timestamp })
    }
    theirs.set(session, [...(theirs.get(session) ?? []), ...records])
  }
  report('Codex', theirs, ourLines(logs, 'codex'))
}

function opencode(db: string, logs: string) {
  console.log(`\n== OpenCode`)
  if (!existsSync(db)) return console.log(`no database at ${db}`)
  const theirs = new Map<string, Theirs[]>()
  // Replies are in `message` up to late Sep. 2026, in `session_message`
  // after, where the model is `{ id, providerID }`; the tokens are the same.
  const sql = new DatabaseSync(db, { readOnly: true })
  const tables = new Set((sql.prepare(`select name from sqlite_master where type = 'table'`).all() as { name: string }[]).map((t) => t.name))
  const rows = [
    ...(tables.has('message') ? sql.prepare(`select session_id, time_created, data from message where time_created >= ? and json_extract(data, '$.role') = 'assistant'`).all(since) : []),
    ...(tables.has('session_message') ? sql.prepare(`select session_id, time_created, data from session_message where time_created >= ? and type = 'assistant'`).all(since) : []),
  ] as { session_id: string; time_created: number; data: string }[]
  for (const r of rows) {
    const d = JSON.parse(r.data)
    const t = d.tokens
    if (!t?.input && !t?.cache?.read) continue
    // OpenCode's input is uncached, and its output leaves reasoning out.
    const rec = { input: t.input + (t.cache?.read ?? 0) + (t.cache?.write ?? 0), cached: t.cache?.read ?? 0, output: (t.output ?? 0) + (t.reasoning ?? 0), time: new Date(r.time_created).toISOString(), cost: d.cost ?? 0 }
    theirs.set(r.session_id, [...(theirs.get(r.session_id) ?? []), rec])
  }
  const pairs = report('OpenCode', theirs, ourLines(logs, 'opencode'))
  const sums = new Map<string, { theirs: number; ours: number; n: number }>()
  for (const [t, o] of pairs) {
    const label = `${o.model}${o.provider ? ` via ${o.provider}` : ''}`
    if (!modelOf(o.model, o.provider).price) {
      sums.set(`${label} (no price in our table)`, { theirs: (sums.get(`${label} (no price in our table)`)?.theirs ?? 0) + t.cost!, ours: 0, n: (sums.get(`${label} (no price in our table)`)?.n ?? 0) + 1 })
      continue
    }
    // Our line logs the cache write count only as a total of both lifetimes,
    // so writes are priced as OpenCode's: none apart for these models.
    const ours = spent(o.model, o.provider, { input_tokens: o.input - o.cached, cache_read_input_tokens: o.cached, output_tokens: o.output })
    const s = sums.get(label) ?? { theirs: 0, ours: 0, n: 0 }
    sums.set(label, { theirs: s.theirs + t.cost!, ours: s.ours + ours, n: s.n + 1 })
  }
  for (const [label, s] of sums)
    console.log(`${label}: ${s.n} matched replies, OpenCode $${s.theirs.toFixed(4)}, ours ${s.ours ? `$${s.ours.toFixed(4)} (${pct(s.ours, s.theirs)})` : '-'}`)
}

const logs = path.resolve(import.meta.dirname, '..', 'proxy-data', 'logs')
claudeCode(path.join(homedir(), '.claude', 'projects'))
codex(process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), logs)
opencode(path.join(homedir(), '.local', 'share', 'opencode', 'opencode.db'), logs)

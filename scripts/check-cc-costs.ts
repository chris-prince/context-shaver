// Checks src/models.ts's prices against Claude Code's own cost figures. Claude
// Code writes `cost-state` lines to its session transcripts
// (~/.claude/projects/*/*.jsonl): per model, its token totals and the dollars
// it works out for them. This prices the same totals with our table
// (cost.ts, spent) and prints both, per transcript and model, then summed per
// model. Claude Code's figure is its own estimate, not a bill.
//
// The totals are cumulative in a transcript, so only each transcript's last
// cost-state line is read.
//
// Usage: bin/node-wrapper scripts/check-cc-costs.ts [projects dir] [--days N] [--all]
//   --days N   only transcripts changed in the last N days (default 30)
//   --all      print every transcript's line, not just those that differ by over 1%

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { spent } from '../src/cost.ts'
import { modelOf } from '../src/models.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { days: { type: 'string', default: '30' }, all: { type: 'boolean' } } })
const root = positionals[0] ?? path.join(homedir(), '.claude', 'projects')
const since = Date.now() - Number(values.days) * 86_400_000

// webSearchRequests are billed per search (Claude Code adds $0.01 each); our
// table prices tokens only, so a transcript with searches shows that gap.
type ModelUsage = { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; cacheCreationEphemeral5mInputTokens?: number; webSearchRequests?: number; costUSD: number }

const ours = (model: string, u: ModelUsage) =>
  spent(model, undefined, {
    input_tokens: u.inputTokens,
    cache_read_input_tokens: u.cacheReadInputTokens,
    cache_creation_input_tokens: u.cacheCreationInputTokens,
    cache_creation: { ephemeral_5m_input_tokens: u.cacheCreationEphemeral5mInputTokens ?? 0 },
    output_tokens: u.outputTokens,
  })

const pct = (a: number, b: number) => (b ? `${(((a - b) / b) * 100).toFixed(1)}%` : 'n/a')
const sums = new Map<string, { theirs: number; ours: number; transcripts: number }>()
let files = 0

for (const project of readdirSync(root)) {
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
      const o = ours(model, u)
      const s = sums.get(model) ?? { theirs: 0, ours: 0, transcripts: 0 }
      sums.set(model, { theirs: s.theirs + u.costUSD, ours: s.ours + o, transcripts: s.transcripts + 1 })
      const searches = u.webSearchRequests ?? 0
      const split = u.cacheCreationEphemeral5mInputTokens === undefined ? ', no 5m/1h split' : ''
      if (values.all || Math.abs(o - u.costUSD) > 0.01 * u.costUSD)
        console.log(`${project}/${name} ${model}: Claude Code $${u.costUSD.toFixed(4)}, ours $${o.toFixed(4)} (${pct(o, u.costUSD)}; ${searches} web searches${split})`)
    }
  }
}

console.log(`\n${files} transcripts with cost-state lines, changed in the last ${values.days} days`)
for (const [model, s] of sums)
  console.log(`${model}: ${s.transcripts} transcripts, Claude Code $${s.theirs.toFixed(2)}, ours $${s.ours.toFixed(2)} (${pct(s.ours, s.theirs)})`)

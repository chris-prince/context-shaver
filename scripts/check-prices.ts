// Checks src/models.ts against what OpenRouter bills. For each model it sends a
// short prompt (under any caching minimum), a long one cold, and the long one
// again warm; Claude's long prompt is written once at each TTL, 5 minutes and
// the hour. Each line sets OpenRouter's billed prompt and output cost beside
// what our prices give for the same tokens, and says how many of the uncached
// tokens were written.
//
// With --lifetime it then checks how long an entry lasts unread, as
// mini-ctx-opencode's cache-ttl-probe.ts did: each delay gets its own prompt,
// written at the start and read once at the delay, so no read refreshes
// another's entry. The delays are around the TTL we count on (the model's, or
// the proxy's default hour): 1 minute, half of it, 2 minutes either side of it,
// and twice it, two of each. Only a miss inside it is a mismatch. It takes
// twice the TTL; run it in the background.
//
// Usage: bin/node-wrapper scripts/check-prices.ts <openrouter model>... [--provider p] [--lifetime]
//   e.g. openai/gpt-6-luna anthropic/claude-haiku-5.5, or
//   deepseek/deepseek-v4.1-flash --provider deepinfra

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { modelOf, type Model } from '../src/models.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { provider: { type: 'string' }, lifetime: { type: 'boolean' } } })
if (!positionals.length) {
  console.error('usage: bin/node-wrapper scripts/check-prices.ts <openrouter model>... [--provider p] [--lifetime]')
  process.exit(1)
}
const key = JSON.parse(readFileSync(path.join(homedir(), '.local/share/opencode/auth.json'), 'utf8')).openrouter.key
const provider = values.provider

// Our entry for an OpenRouter name: the name itself, or Anthropic's
// claude-opus-5.5 as claude-opus-5-5.
function ours(id: string): Model {
  const m = modelOf(id, provider)
  return m.price ? m : modelOf(id.split('/').at(-1)!.replace(/(\d+)\.(\d+)$/, '$1-$2'), provider)
}

// About 6,000 tokens, past every model's caching minimum, distinct per tag so
// no prompt reads another's entry.
const long = (tag: string) =>
  `[${tag}]\n` + Array.from({ length: 200 }, (_, n) => `${tag} line ${n}: the quick brown fox jumps over the lazy dog.`).join('\n')
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

type Usage = { prompt: number; cached: number; written: number; output: number; promptCost: number; outputCost: number; provider: string }

async function send(model: string, text: string, ttl?: '1h'): Promise<Usage> {
  const claude = model.startsWith('anthropic/')
  const ask = 'Reply with OK.'
  const content = claude ? [{ type: 'text', text, cache_control: { type: 'ephemeral', ...(ttl && { ttl }) } }, { type: 'text', text: ask }] : `${text}\n${ask}`
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      usage: { include: true },
      ...(provider && { provider: { order: [provider], allow_fallbacks: false } }),
      messages: [{ role: 'user', content }],
    }),
  })
  const j: any = await res.json()
  if (!res.ok) throw new Error(`${model}: ${JSON.stringify(j)}`)
  const u = j.usage
  return {
    prompt: u.prompt_tokens,
    cached: u.prompt_tokens_details?.cached_tokens ?? 0,
    written: u.prompt_tokens_details?.cache_write_tokens ?? 0,
    output: u.completion_tokens,
    promptCost: u.cost_details.upstream_inference_prompt_cost,
    outputCost: u.cost_details.upstream_inference_completions_cost,
    provider: j.provider,
  }
}

// What our prices give, as src/cost.ts counts them.
function priced(m: Model, u: Usage, ttl?: '1h') {
  const p = m.price!
  const write = p.write ?? p.input * (ttl ? 2 : 1.25)
  const times = p.long && u.prompt > p.long.over ? p.long.times : 1
  const uncached = u.prompt - u.cached - u.written
  return { prompt: times * (uncached * p.input + u.written * write + u.cached * p.read) / 1e6, output: times * (u.output * p.output) / 1e6 }
}

const $ = (n: number) => '$' + n.toFixed(8)
const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-8, 0.005 * Math.max(a, b))
let mismatches = 0

async function prices(model: string) {
  const m = ours(model)
  if (!m.price) {
    console.log(`${model}: no prices in src/models.ts`)
    mismatches++
    return
  }
  const t = tag()
  const runs: Array<[string, string, '1h'?]> = [
    ['short', `[${t}] Say nothing more.`],
    ['long, cold', long(t)],
    ['long, warm', long(t)],
  ]
  if (model.startsWith('anthropic/')) runs.push(['long, cold, 1h', long(t + '-1h'), '1h'], ['long, warm, 1h', long(t + '-1h'), '1h'])
  const lines = []
  let served = ''
  for (const [label, text, ttl] of runs) {
    const u = await send(model, text, ttl)
    const ourCost = priced(m, u, ttl)
    const ok = same(u.promptCost, ourCost.prompt) && same(u.outputCost, ourCost.output)
    if (!ok) mismatches++
    served = u.provider
    lines.push(
      [label.padEnd(15), String(u.prompt).padStart(6), String(u.cached).padStart(7), String(u.written).padStart(8), String(u.prompt - u.cached - u.written).padStart(9),
        $(u.promptCost).padStart(12), $(ourCost.prompt).padStart(12), $(u.outputCost).padStart(12), $(ourCost.output).padStart(12), ok ? 'ok' : 'MISMATCH'].join('  '),
    )
  }
  console.log(`${model} (served by ${served})`)
  console.log(['request'.padEnd(15), 'prompt', ' cached', ' written', ' uncached', 'billed in'.padStart(12), 'ours in'.padStart(12), 'billed out'.padStart(12), 'ours out'.padStart(12)].join('  '))
  for (const l of lines) console.log(l)
  console.log()
}

async function lifetime(model: string) {
  const m = ours(model)
  const ttl = (m.ttl ?? 3600) / 60
  const delays = [1, ttl / 2, ttl - 2, ttl + 2, 2 * ttl]
  // Claude Code writes at the hour; a shorter TTL is the 5-minute one.
  const anthropicTtl = model.startsWith('anthropic/') && ttl >= 60 ? '1h' : undefined
  console.log(`${model}: entries we count on lasting ${ttl} minutes; reading at ${delays.join(', ')} minutes, done in at most ${2 * ttl}`)
  const start = Date.now()
  // Once both prompts at a delay miss, later delays can only miss too, so
  // their waits end early and they're skipped.
  let gone = Infinity
  const waits = new Set<() => void>()
  const at = (min: number) =>
    new Promise<void>((r) => {
      const done = () => (waits.delete(done), clearTimeout(timer), r())
      const timer = setTimeout(done, Math.max(0, start + min * 60_000 - Date.now()))
      waits.add(done)
    })
  const results = await Promise.all(
    delays.map(async (d) => {
      const rs = await Promise.all(
        [0, 1].map(async () => {
          const text = long(tag())
          try {
            const w = await send(model, text, anthropicTtl)
            await at(d)
            if (d > gone) return { d, read: 0, error: '', skipped: true }
            const r = await send(model, text, anthropicTtl)
            return { d, read: r.cached / Math.max(1, w.written + w.cached), error: '', skipped: false }
          } catch (e) {
            return { d, read: 0, error: String(e), skipped: false }
          }
        }),
      )
      if (rs.every((r) => !r.error && !r.skipped && r.read < 0.1) && d < gone) {
        gone = d
        for (const done of [...waits]) done()
      }
      return rs
    }),
  )
  console.log(`${model} lifetime`)
  for (const d of delays) {
    const rs = results.flat().filter((r) => r.d === d)
    if (rs.every((r) => r.skipped)) {
      console.log(`  ${String(d).padStart(4)} min: skipped, gone by ${gone}`)
      continue
    }
    const got = rs.map((r) => (r.error ? 'error' : r.read > 0.9 ? 'read' : r.read < 0.1 ? 'miss' : `${Math.round(100 * r.read)}%`))
    // A miss inside the TTL counts warmth we don't get; a read past it only
    // means entries last longer than we count on.
    const ok = d > ttl || got.every((g) => g === 'read')
    if (!ok) mismatches++
    const note = d <= ttl ? (ok ? '' : '  MISMATCH: gone inside our TTL') : got.includes('read') ? '  (lasts longer than we count on)' : ''
    console.log(`  ${String(d).padStart(4)} min: ${got.join(', ')}${note}`)
    for (const r of rs) if (r.error) console.log(`    ${r.error}`)
  }
  console.log()
}

for (const model of positionals) await prices(model)
if (values.lifetime) await Promise.all(positionals.map(lifetime))
console.log(mismatches ? `${mismatches} mismatch(es)` : 'all match')
process.exit(mismatches ? 1 : 0)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describe, estimate, isSuggestion, observe, render, type Stats } from '../src/stats.ts'
import type { ApiMsg } from '../src/items.ts'

const ends = { tools: 0, reasoning: 0 }
const body = (messages: ApiMsg[]) => ({ model: 'm', messages, system: 'sys', tools: [{ name: 'Bash' }] })
const sum = (s: Stats) => s.parts.reduce((n, p) => n + s.tokens[p.key], 0) + s.tokens[s.defs.key]

test('a request adds up to its count; a new reply costs its answer\'s output', () => {
  const prompt: ApiMsg = { role: 'user', content: 'hi' }
  let s = observe(undefined, describe(body([prompt]), ends, '2026-10-11T10:00:00Z'), 1000, 40)
  assert.equal(sum(s), 1000)
  const reply: ApiMsg = { role: 'assistant', content: [{ type: 'text', text: 'hello there' }] }
  const next: ApiMsg = { role: 'user', content: 'more' }
  s = observe(s, describe(body([prompt, reply, next]), ends, '2026-10-11T10:01:00Z'), 1100, 0)
  assert.equal(sum(s), 1100)
  assert.equal(s.tokens[s.parts[1].key], 40)
  assert.equal(s.tokens[s.parts[2].key], 60)
  assert.equal(s.requests, 2)
})

test('a reply whose output is over what the request grew by gives back the excess', () => {
  const prompt: ApiMsg = { role: 'user', content: 'hi' }
  let s = observe(undefined, describe(body([prompt]), ends, '2026-10-11T10:00:00Z'), 1000, 40)
  const reply: ApiMsg = { role: 'assistant', content: [{ type: 'text', text: 'hello there' }] }
  const next: ApiMsg = { role: 'user', content: 'ok' }
  s = observe(s, describe(body([prompt, reply, next]), ends, '2026-10-11T10:01:00Z'), 1030, 0)
  assert.equal(sum(s), 1030)
  assert.equal(s.tokens[s.parts[1].key], 30)
  assert.equal(s.tokens[s.parts[2].key], 0)
})

test('a part a side request left out keeps its count when it comes back', () => {
  const a: ApiMsg = { role: 'user', content: 'a' }
  const b: ApiMsg = { role: 'assistant', content: [{ type: 'text', text: 'b' }] }
  const c: ApiMsg = { role: 'user', content: 'c' }
  let s = observe(undefined, describe(body([a, b, c]), ends, '2026-10-11T10:00:00Z'), 900, 0)
  const counted = s.tokens[s.parts[2].key]
  s = observe(s, describe(body([a]), ends, '2026-10-11T10:00:01Z'), s.tokens[s.parts[0].key] + s.tokens[s.defs.key], 0)
  s = observe(s, describe(body([a, b, c]), ends, '2026-10-11T10:00:02Z'), 900, 0)
  assert.equal(s.tokens[s.parts[2].key], counted)
})

test('a prompt suggestion is told apart by its last message', () => {
  const a: ApiMsg = { role: 'user', content: 'a' }
  const b: ApiMsg = { role: 'assistant', content: [{ type: 'text', text: 'b' }] }
  assert.equal(isSuggestion([a, b, { role: 'user', content: '[SUGGESTION MODE: Suggest what the user might naturally type next]' }]), true)
  assert.equal(isSuggestion([a, b, { role: 'user', content: [{ type: 'text', text: '[SUGGESTION MODE: …]' }] }]), true)
  assert.equal(isSuggestion([a, b, { role: 'user', content: 'what is [SUGGESTION MODE:]?' }]), false)
  assert.equal(isSuggestion([a, b]), false)
})

test('a loaded tool counts with the message that loads it, once, even when deferred later', () => {
  const big = { name: 'Big', description: 'x'.repeat(4000) }
  const prompt: ApiMsg = { role: 'user', content: 'hi' }
  const call: ApiMsg = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ToolSearch', input: {} }] }
  const result: ApiMsg = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'tool_reference', tool_name: 'Big' }] }] }
  const sent = (tools: object[]) => describe({ model: 'm', messages: [prompt, call, result], system: 'sys', tools }, ends, '2026-10-11T10:00:00Z')
  const first = sent([{ name: 'Bash' }, big])
  assert.equal(first.parts[2].kinds.toolsLoaded, JSON.stringify(big).length)
  let s = observe(undefined, first, 3000, 0)
  const loaded = s.tokens[s.parts[2].key]
  // Deferring the tool changes only the base; the message keeps its count.
  s = observe(s, sent([{ name: 'Bash' }, { ...big, defer_loading: true }]), 1900, 0)
  assert.equal(s.tokens[s.parts[2].key], loaded)
  assert.equal(sum(s), 1900)
})

test('render prints the stats from the state alone', () => {
  const s = observe(undefined, describe(body([{ role: 'user', content: 'hi' }]), ends, '2026-10-11T10:00:00Z'), 1000, 0)
  const out = render(s, 'session')
  assert.match(out, /^Session: session\nModel: m\n/)
  assert.match(out, /1 request across 1 turn, spanning 0m\n\nContext Summary\n  Tokens \(current\)\n    1,000 w\/o shaver\n    1,000 now\n        0 saved \(0%\)\n/)
  assert.match(out, /\n  Base +[\d,]+ +\( *\d+%\)\n  Session's fixed overhead\. If over 10k, shrink big items\./)
  assert.match(out, /\n  Conversation +[\d,]+ .*\n  Earlier turns.*\n    by age:\n      today .*\n    by type:\n      user /)
  assert.match(out, /\n  Frontier +0 +\( 0%\)\n  Recent turns, not yet eligible to trim\. Okay if large\.$/)
})

test('Base lists the system prompt, the tools and the preamble\'s sections, by name', () => {
  const preamble: ApiMsg = { role: 'system', content: '# Environment\nmacOS\nThe following skills are available:\n' + '- skill: does things\n'.repeat(20) }
  const s = observe(undefined, describe(body([preamble, { role: 'user', content: 'hi' }]), ends, '2026-10-11T10:00:00Z'), 1000, 0)
  const base = render(s, 'session').split('\n\n').find((b) => b.startsWith('  Base'))!.split('\n').slice(2).map((l) => l.replace(/ +[\d,]+ +\( *\d+%\)$/, ''))
  assert.deepEqual(base, ['    other', '    skills', '    system-prompt', '    tools'])
})

test('before any request is answered, the request is estimated from its bytes', () => {
  const s = estimate(describe(body([{ role: 'user', content: 'hi' }]), ends, '2026-10-11T10:00:00Z'))
  assert.ok(s.inputTokens > 0)
  assert.equal(Math.round(sum(s)), s.inputTokens)
  const out = render(s, 'session', true)
  assert.match(out, /0 requests across 0 turns, spanning 0m\n\nContext Summary \(estimated\)\n  Tokens \(current\)\n.*\n.*\n     +0 saved \(0%\)\n/)
})

test('an advance removes what the earlier parts cost less what they cost now', () => {
  const a: ApiMsg = { role: 'user', content: 'a'.repeat(400) }
  const b: ApiMsg = { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(400) }] }
  const c: ApiMsg = { role: 'user', content: 'c' }
  let s = observe(undefined, describe(body([a, b, c]), ends, '2026-10-11T10:00:00Z'), 1000, 0)
  const before = s.parts.reduce((n, p) => n + s.tokens[p.key], 0)
  const stub: ApiMsg = { role: 'assistant', content: [{ type: 'text', text: 'b' }] }
  const d: ApiMsg = { role: 'user', content: 'd' }
  // Side requests drop parts too; only an advance counts.
  assert.equal(observe(s, describe(body([a]), ends, '2026-10-11T10:00:30Z'), 500, 0).removedTokens, 0)
  s = observe(s, describe(body([a, stub, c, d]), ends, '2026-10-11T10:01:00Z', true), 900, 0)
  const kept = s.parts.slice(0, 3).reduce((n, p) => n + s.tokens[p.key], 0)
  assert.equal(s.removedTokens, before - kept)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bornFrom, bornOf, costLines, describe, estimate, isSuggestion, observe, render, settled, splitTrimmed, withoutSuggestion, type Stats } from '../src/stats.ts'
import { clockOf, SUMMARY_HEAD, type ApiMsg } from '../src/items.ts'

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

test('a prompt suggestion does not end the turn before it', () => {
  const p1: ApiMsg = { role: 'user', content: 'one' }
  const r1: ApiMsg = { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
  const p2: ApiMsg = { role: 'user', content: 'two' }
  const r2: ApiMsg = { role: 'assistant', content: [{ type: 'text', text: 'started a task' }] }
  const ask: ApiMsg = { role: 'user', content: '[SUGGESTION MODE: Suggest what the user might naturally type next]' }
  const turn2 = clockOf([p1, r1, p2])
  assert.deepEqual(clockOf(withoutSuggestion([p1, r1, p2, r2, ask])), { ...turn2, steps: 1 })
  // A background task's notice resumes the agent within the same turn.
  const notice: ApiMsg = { role: 'user', content: '<system-reminder>\nA background task finished.\n</system-reminder>' }
  assert.deepEqual(clockOf(withoutSuggestion([p1, r1, p2, r2, notice])), clockOf(withoutSuggestion([p1, r1, p2, r2, ask])))
  // A typed prompt ends it.
  assert.equal(clockOf([p1, r1, p2, r2, { role: 'user', content: 'three' }]).turns, turn2.turns + 1)
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
  // Model m has no price, so there is no cost to break down.
  assert.match(out, /1 request across 1 turn, spanning 0m\n\nShaver Summary\n  Savings Breakdown\n    MISSING: Shaver lacks cost details for model m\.\n\nContext Details\n\n  1,000 tokens, actual\n  1,000 tokens, if no shaver\n\n  0 summary creation requests\n\n  Base/)
  assert.match(out, /\n  Base +[\d,]+ +\( *\d+%\)\n  Session's fixed overhead\. Above 15k\? Run `shaver optimize`\./)
  assert.match(out, /\n  Conversation +[\d,]+ .*\n  Earlier turns.*\n    by type:\n      user .*\n    by age:\n      today /)
  assert.match(out, /\n  Frontier +0 +\( 0%\)\n  Recent turns, not yet eligible to trim\. Okay if large\.$/)
})

test('render names the provider only when a request pins one', () => {
  const pinned = observe(undefined, describe({ ...body([{ role: 'user', content: 'hi' }]), provider: 'deepinfra' }, ends, '2026-10-11T10:00:00Z'), 1000, 0)
  assert.match(render(pinned, 'session'), /^Session: session\nModel: m\nProvider: deepinfra\n\n/)
})

test('Base lists the system prompt, the tools and the preamble\'s sections, by name', () => {
  const preamble: ApiMsg = { role: 'system', content: '# Environment\nmacOS\nThe following skills are available:\n' + '- skill: does things\n'.repeat(20) }
  const s = observe(undefined, describe(body([preamble, { role: 'user', content: 'hi' }]), ends, '2026-10-11T10:00:00Z'), 1000, 0)
  const base = render(s, 'session').split('\n\n').find((b) => b.startsWith('  Base'))!.split('\n').slice(2).map((l) => l.replace(/ +[\d,]+ +\( *\d+%\)$/, ''))
  assert.deepEqual(base, ['    other', '    skills', '    system-prompt', '    tools'])
})

test("Base shows the skills the proxy shortened as skills-trimmed, Claude Code's from the preamble and Codex's from the system", () => {
  const baseOf = (s: Stats) => Object.fromEntries(render(s, 'session').split('\n\n').find((b) => b.startsWith('  Base'))!.split('\n').slice(2).map((l) => [l.trim().split(/ +/)[0], Number(l.match(/([\d,]+) +\(/)![1].replace(/,/g, ''))]))
  // Claude Code's system has a skills section of its own, which stays.
  const preamble: ApiMsg = { role: 'system', content: 'The following skills are available:\n' + '- skill: does things\n'.repeat(20) }
  const claude = describe(body([preamble, { role: 'user', content: 'hi' }]), ends, '2026-10-11T10:00:00Z')
  claude.defs.sections = { 'system-prompt': 300, skills: 100 }
  const listed = claude.parts[0].kinds['system:skills']
  splitTrimmed(claude, 200)
  assert.deepEqual(claude.defs.sections, { 'system-prompt': 300, skills: 100 })
  assert.equal(claude.parts[0].kinds['system:skills'], listed - 200)
  assert.equal(claude.parts[0].kinds['system:skills-trimmed'], 200)
  // Counted by kind, the part's tokens split as its bytes do.
  const s = observe(undefined, claude, 2000, 0, { parts: [listed, undefined], kinds: [{ 'system:skills': listed }, undefined] })
  assert.equal(s.parts[0].counted!['system:skills-trimmed'], 200)
  assert.ok(baseOf(s)['skills-trimmed'] > 0)
  // Codex's list is in the system until a compaction.
  const codex = describe(body([{ role: 'user', content: 'hi' }]), ends, '2026-10-11T10:00:00Z')
  codex.defs.sections = { 'system-prompt': 300, skills: 500 }
  splitTrimmed(codex, 200)
  assert.deepEqual(codex.defs.sections, { 'system-prompt': 300, skills: 300, 'skills-trimmed': 200 })
  assert.ok(baseOf(observe(undefined, codex, 2000, 0))['skills-trimmed'] > 0)
})

test('before any request is answered, the request is estimated from its bytes', () => {
  const s = estimate(describe(body([{ role: 'user', content: 'hi' }]), ends, '2026-10-11T10:00:00Z'))
  assert.ok(s.inputTokens > 0)
  assert.equal(Math.round(sum(s)), s.inputTokens)
  const out = render(s, 'session', true)
  assert.match(out, /0 requests across 0 turns, spanning 0m\n\nContext Details \(estimated\)\n\n  [\d,]+ tokens, actual\n  [\d,]+ tokens, if no shaver\n/)
})

test('the summaries line counts summary creation requests by what became of them, none as 0', () => {
  const s = estimate(describe(body([{ role: 'user', content: 'hi' }]), ends, '2026-10-11T10:00:00Z'))
  assert.match(render(s, 'session', true, undefined, { applied: 1, pending: 0, dropped: 0 }), /\n  1 summary creation request\n    1 applied, 0 pending, 0 dropped\n\n/)
  assert.match(render(s, 'session', true, undefined, { applied: 10, pending: 1, dropped: 2 }), /\n  13 summary creation requests\n    10 applied, 1 pending, 2 dropped\n\n/)
  assert.match(render(s, 'session', true), /\n  0 summary creation requests\n\n/)
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

  // The client's compaction leaves nothing taken out, on an advance too, and
  // says so for that request alone.
  for (const advanced of [false, true]) {
    const after = observe(s, { ...describe(body([a, { role: 'user', content: 'summary' }]), ends, '2026-10-11T10:02:00Z', advanced), compacted: true }, 300, 0)
    assert.deepEqual([after.removedTokens, after.compacted], [0, true])
    assert.equal(observe(after, describe(body([a, { role: 'user', content: 'summary' }, d]), ends, '2026-10-11T10:03:00Z'), 320, 0).compacted, undefined)
  }
})

test('a prompt suggestion counts its trim but not itself as a request or turn', () => {
  const a: ApiMsg = { role: 'user', content: 'a'.repeat(400) }
  const b: ApiMsg = { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(400) }] }
  const c: ApiMsg = { role: 'user', content: 'c' }
  const s1 = observe(undefined, describe(body([a, b, c]), ends, '2026-10-11T10:00:00Z'), 1000, 0)
  const before = s1.parts.reduce((n, p) => n + s1.tokens[p.key], 0)
  const stub: ApiMsg = { role: 'assistant', content: [{ type: 'text', text: 'b' }] }
  const ask: ApiMsg = { role: 'user', content: '[SUGGESTION MODE: Suggest what the user might naturally type next]'.repeat(20) }
  const s2 = observe(s1, { ...describe(body([a, stub, c, ask]), ends, '2026-10-11T10:00:10Z', true), suggestion: true }, 900, 10)
  assert.deepEqual([s2.requests, s2.turns, s2.suggestion], [1, s1.turns, true])
  assert.equal(s2.removedTokens, before - s2.parts.slice(0, 3).reduce((n, p) => n + s2.tokens[p.key], 0))
  // The next request leaves the suggestion's message out, and isn't
  // taking it out.
  const d: ApiMsg = { role: 'user', content: 'd' }
  const s3 = observe(s2, describe(body([a, stub, c, d]), ends, '2026-10-11T10:01:00Z', true), 700, 0)
  assert.deepEqual([s3.requests, s3.turns, s3.suggestion, s3.removedTokens], [2, s1.turns + 1, false, s2.removedTokens])
})

test('records show as their own type, each dated by the first message it covers', () => {
  const [a, c, e, g]: ApiMsg[] = ['a', 'c', 'e', 'g'].map((t) => ({ role: 'user', content: t }))
  const [b, d, f]: ApiMsg[] = ['b', 'd', 'f'].map((t) => ({ role: 'assistant', content: [{ type: 'text', text: t }] }))
  let s = observe(undefined, describe(body([a, b, c]), ends, '2026-10-08T10:00:00Z'), 1000, 0)
  s = observe(s, describe(body([a, b, c, d, e]), ends, '2026-10-11T10:00:00Z'), 1000, 0)
  s = observe(s, describe(body([a, b, c, d, e, f, g]), ends, '2026-10-13T09:00:00Z'), 1000, 0)
  // Two records, of turns 1-2 (from b) and turn 3 (from e).
  const record = (text: string): ApiMsg => ({ role: 'assistant', content: [{ type: 'text', text: `${SUMMARY_HEAD}\n\n${text}` }] })
  const sent = describe(body([a, record('turns 1-2'), record('turn 3'), g]), ends, '2026-10-13T10:00:00Z', true)
  sent.parts[1].born = bornOf(s, b)
  sent.parts[2].born = bornOf(s, e)
  s = observe(s, sent, 900, 0)
  const out = render(s, 'k', false)
  assert.match(out, /^ +summary /m)
  assert.doesNotMatch(out, /^ +assistant /m)
  assert.match(out, /^ +2 days ago .*\n +5 days ago /m)
})

test('a message sent trimmed, with no lineage, is dated by the first message after it with a date', () => {
  const prompt: ApiMsg = { role: 'user', content: 'go' }
  const reply: ApiMsg = { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: 's' }, { type: 'text', text: 'done' }] }
  const next: ApiMsg = { role: 'user', content: 'more' }
  // The reply went up without its thinking, so its own key was never seen.
  const s = observe(undefined, describe(body([prompt, { ...reply, content: [reply.content[1]] }, next]), ends, '2026-10-08T10:00:00Z'), 1000, 0)
  assert.equal(bornOf(s, reply), undefined)
  assert.equal(bornFrom(s, [prompt, reply, next], 1), '2026-10-08T10:00:00Z')
})

test('settled leaves out what the frontier holds, and only that', () => {
  const prompt: ApiMsg = { role: 'user', content: 'run it' }
  const call: ApiMsg = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] }
  const result: ApiMsg = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb\nc'.repeat(50) }] }
  const reply: ApiMsg = { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
  const next: ApiMsg = { role: 'user', content: 'thanks' }
  // The tools frontier starts at the result: the call before it is settled.
  const sent = describe(body([prompt, call, result, reply, next]), { tools: 2, reasoning: 0 }, '2026-10-11T10:00:00Z')
  const tokens = Object.fromEntries(sent.parts.map((p) => [p.key, 100]))
  const out = settled(sent, tokens)
  assert.equal(out[1], 100)
  assert.equal(out[3], 100)
  assert.equal(out[4], 100)
  // Only the result's message wrapper is left, as the stats count it.
  assert.ok(out[2] > 0 && out[2] < 10, `the result's settled share is ${out[2]}`)
  const s = observe(undefined, sent, 1000, 0)
  const frontier = Number(/\n  Frontier +([\d,]+)/.exec(render(s, 'x'))![1].replace(/,/g, ''))
  assert.ok(frontier > 0)
})

test('parts the API counted take its counts, and only the rest share what is left', () => {
  const prompt: ApiMsg = { role: 'user', content: 'hi' }
  let s = observe(undefined, describe(body([prompt]), ends, '2026-10-11T10:00:00Z'), 1000, 40)
  const reply: ApiMsg = { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'x'.repeat(5000) }, { type: 'text', text: 'hello' }] }
  const next: ApiMsg = { role: 'user', content: 'more' }
  s = observe(s, describe(body([prompt, reply, next]), ends, '2026-10-11T10:01:00Z'), 1100, 0, { defs: 900, parts: [100, 47, undefined] })
  assert.equal(sum(s), 1100)
  assert.equal(s.tokens[s.defs.key], 900)
  assert.equal(s.tokens[s.parts[0].key], 100)
  assert.equal(s.tokens[s.parts[1].key], 47)
  assert.equal(s.tokens[s.parts[2].key], 53)
})

test('a saving under half a cent is still listed in the breakdown', () => {
  const c = { without: 0.002, actual: 0.00193, saved: { 'skills-shaved': 0.00006, 'tools-shaved': 0.00001 }, compactions: 0, waitMs: 0 }
  const lines = costLines(c)
  assert.ok(lines.includes('    $0.00 ( 3%) base:skills-shaved'), lines.join('\n'))
  assert.ok(lines.includes('    $0.00 ( 1%) base:tools-shaved'), lines.join('\n'))
  assert.ok(!lines.includes('    none yet'))
  assert.ok(costLines({ ...c, saved: {} }).includes('    none yet'))
})

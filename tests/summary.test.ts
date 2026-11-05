import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isMemoir, isSummary, MEMOIR_FOOT, MEMOIR_HEAD, SUMMARY_HEAD, type ApiMsg } from '../src/items.ts'
import { preambleEnd } from '../src/log.ts'
import { apply } from '../src/trim.ts'
import { chainBreak, coveredBy, summaryForkMessages, summaryForkOf, instructions, memoirOf, mergedOf, promptHash, recordOf, rejectionOf, salvagedOf, startsOf, summarized, validChain, type SummaryFork, type Summary } from '../src/summary.ts'

const long = 'x'.repeat(4000)
// A session: the preamble, then four turns, each a prompt, a tool call, its
// result and a reply. The base ends with a system message, as Claude Code's does.
const session = (): ApiMsg[] => [
  { role: 'user', content: [{ type: 'text', text: '<system-reminder>skills</system-reminder>' }] },
  { role: 'user', content: 'turn one' },
  { role: 'system', content: 'environment' },
  ...[1, 2, 3, 4].flatMap((t): ApiMsg[] => [
    ...(t > 1 ? [{ role: 'user' as const, content: [{ type: 'text', text: `turn ${['', 'one', 'two', 'three', 'four'][t]}`, ...(t === 4 && { cache_control: { type: 'ephemeral' } }) }] }] : []),
    { role: 'assistant', content: [{ type: 'tool_use', id: `t${t}`, name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${t}`, content: long }] },
    { role: 'assistant', content: [{ type: 'text', text: `reply ${t}` }] },
  ]),
]
const none = (msgs: ApiMsg[]) => apply(msgs, {}, { requests: 0, turns: 0 })
// Each message's count as the stats have it: a tool result 1,000 tokens, the rest 100.
const counts = (msgs: ApiMsg[]) => msgs.map((m) => (JSON.stringify(m).includes('tool_result') ? 1000 : 100))
const forkOrSkip = (msgs: ApiMsg[], chain: Summary[] = [], offered = 0, threshold = 1000, tokens = counts(msgs)) => summaryForkOf(none(msgs), msgs, chain, offered, threshold, new Map(), tokens)
const summaryForkAt = (...args: Parameters<typeof forkOrSkip>) => {
  const f = forkOrSkip(...args)
  return 'skip' in f ? undefined : f
}

test('after a salvage, the next summary fork starts at the turn the cut-off answer was in, once new turns follow', () => {
  // The fork covering turns 1-3 is offered at turn 4 and cut off in arc [3].
  const f = summaryForkAt(session())!
  const cut = '## [1] Turn one\n- did one\n\n## [2] Turn two\n- did two\n\n## [3] Turn three\n- did th'
  const r = salvagedOf([{ type: 'text', text: cut }], f, 'now', 'refusal', 40)!
  assert.equal(r.endsBefore, 3)
  // No new turn since: the cut-off turns wait, rather than being asked again at once.
  assert.deepEqual(forkOrSkip(session(), [r], f.current), { skip: 'below-threshold', tokens: 0 })
  // Turn four ends and turn five starts: the next fork starts at turn three,
  // so the turn the cut-off answer was in is asked for again.
  const five: ApiMsg[] = [...session(), { role: 'user', content: 'turn five' }]
  const g = summaryForkAt(five, [r], f.current)!
  assert.equal(g.start, 3)
  assert.equal(g.current, 5)
  assert.deepEqual(g.prompts.map((p) => p.quote), ['turn three', 'turn four', 'turn five'])
  assert.match(instructions(g), /\[3\] "turn three"/)
})

test('an answer cut off partway keeps its whole arcs, ending before the arc it was cut off in', () => {
  const f = summaryForkAt(session())!
  const cut = '## [1] Turn one\n- did one\n\n## [2] Turn two\n- did two\n\n## [3] Turn three\n- did th'
  const r = salvagedOf([{ type: 'text', text: cut }], f, 'now', 'refusal', 40)!
  assert.equal(r.endsBefore, 3)
  assert.equal(r.prompt, f.prompts[3 - f.start].hash)
  assert.equal(r.text, '## [1] Turn one\n- did one\n\n## [2] Turn two\n- did two')
  assert.deepEqual(r.arcs?.map((a) => a.turn), [1, 2])
  assert.equal(r.tokens, 40)
  for (const stop of ['max_tokens', 'length', 'content_filter', 'max_output_tokens', 'incomplete']) assert.equal(salvagedOf([{ type: 'text', text: cut }], f, 'now', stop)?.endsBefore, 3)
  // Not cut off, or nothing whole to keep: no record.
  for (const stop of ['end_turn', 'stop', 'completed', undefined]) assert.equal(salvagedOf([{ type: 'text', text: cut }], f, 'now', stop), undefined)
  for (const text of ['## [1] Turn one\n- did o', 'preamble\n## [1] Turn one\n- one\n## [2] Turn two\n- tw', '## [2] Turn two\n- two\n## [1] Turn one\n- on', '## [1] Turn one\n- one\n## [9] Turn nine\n- ni', '## [1] Turn one\n- one\n\nEnds before: [2]'])
    assert.equal(salvagedOf([{ type: 'text', text }], f, 'now', 'refusal'), undefined, text)
  assert.equal(salvagedOf([{ type: 'text', text: cut }, { type: 'tool_use', id: 'z', name: 'Bash', input: {} }], f, 'now', 'refusal'), undefined)
})

test('a summary fork covers the completed turns from the last record on, once they are big enough', () => {
  const msgs = session()
  const f = summaryForkAt(msgs)!
  assert.deepEqual([f.start, f.current], [1, 4])
  assert.deepEqual(f.prompts.map((p) => p.quote), ['turn one', 'turn two', 'turn three', 'turn four'])
  assert.ok(f.chars > 3 * 4000 && f.chars < 4 * 4000) // turns 1–3, not the current one
  // Turns 1–3 hold 3,000 tokens of results and 800 of the rest.
  assert.equal(summaryForkAt(msgs, [], 0, 3800)?.start, 1)
  assert.equal(summaryForkAt(msgs, [], 0, 3801), undefined)
  // Counted in tokens, not characters: the same turns at a token each are too few.
  assert.equal(summaryForkAt(msgs, [], 0, 1000, msgs.map(() => 1)), undefined)
  // Offered at turn 3: only turn 3 counts towards the next, but it still asks from the start.
  assert.equal(summaryForkAt(msgs, [], 3, 1301), undefined)
  assert.equal(summaryForkAt(msgs, [], 3, 1300)?.start, 1)
  // With none, it says why.
  assert.deepEqual(forkOrSkip(msgs, [], 0, 3801), { skip: 'below-threshold', tokens: 3800 })
  assert.deepEqual(forkOrSkip(msgs, [{ endsBefore: 4 } as Summary]), { skip: 'no-new-turn' })
})

test("a summary fork's record is read back, and only one that covers a complete arc is kept", () => {
  const msgs = session()
  const f = summaryForkAt(msgs)!
  const r = recordOf([{ type: 'text', text: '## Arc\n- did it\n\nEnds before: [3]' }], f, 'now')!
  assert.equal(r.text, '## Arc\n- did it')
  assert.equal(r.endsBefore, 3)
  assert.deepEqual(validChain([r], msgs), [r])
  // Ending before the current turn, whose prompt later comes as a string.
  const r4 = recordOf([{ type: 'text', text: '## Arc\n- did it\n\nEnds before: [4]' }], f, 'now')!
  const later = msgs.map((m, i) => (i === 14 ? { role: 'user', content: 'turn four' } : m)) as ApiMsg[]
  assert.deepEqual(validChain([r4], later), [r4])
  for (const text of ['Ends before: [1]', 'no closing line', '## Arc\n\nEnds before: [5]']) assert.equal(recordOf([{ type: 'text', text }], f, 'now'), undefined)
  assert.equal(recordOf([{ type: 'text', text: 'x\nEnds before: [3]' }, { type: 'tool_use', id: 'z', name: 'Bash', input: {} }], f, 'now'), undefined)
  // Why each is refused, and nothing for one that's kept.
  const why = (text: string) => rejectionOf([{ type: 'text', text }], f)
  assert.equal(why('## Arc\n- did it\n\nEnds before: [3]'), undefined)
  assert.deepEqual(why('Ends before: [1]'), { reason: 'ends-before-out-of-range', endsBefore: 1 })
  assert.deepEqual(why('x\nEnds before: [5]'), { reason: 'ends-before-out-of-range', endsBefore: 5 })
  assert.deepEqual(why('no closing line'), { reason: 'no-ends-before' })
  assert.deepEqual(why('x\n**Ends before: [3]**'), { reason: 'ends-before-misformatted' })
  assert.deepEqual(why('\nEnds before: [3]'), { reason: 'empty', endsBefore: 3 })
  assert.deepEqual(rejectionOf([{ type: 'text', text: 'x\nEnds before: [3]' }, { type: 'tool_use', id: 'z', name: 'Bash', input: {} }], f), { reason: 'tool-call' })
  assert.match(instructions(f), /\[1\] "turn one"\n\[2\] "turn two"\n\[3\] "turn three"\n\nThe latest prompt, still in progress:\n\[4\] "turn four"/)
  assert.doesNotMatch(instructions(f), /already in my journal/)
  // After the reply that ended it, the latest turn is answered, and still left out.
  assert.match(instructions(f, true), /\n\nExclude the turn of the following prompt, which you just answered, because its work may still be in progress, and my next prompt will likely carry on from it:\n\[4\] "turn four"/)
  // A later record's instructions leave out the turns earlier records cover.
  assert.match(instructions({ ...f, start: 2, prompts: f.prompts.slice(1) }), /\[3\] "turn three"\n\nTurns before \[2\] are already in my journal; leave them out\.\n\nThe latest prompt, still in progress:\n\[4\] "turn four"/)
})

test('a summary fork appends its instructions after the breakpoint, so it reads the cached prefix', () => {
  const msgs = session()
  const out = summaryForkMessages(msgs.slice(0, -1), 'compact')
  assert.deepEqual(out.slice(0, -1), msgs.slice(0, -2))
  assert.deepEqual(out.at(-1)!.content, [{ type: 'tool_result', tool_use_id: 't4', content: long }, { type: 'text', text: 'compact' }])
})

test("a fork asks after the last message's blocks, or in a user message after an assistant's, leaving the rest as sent", () => {
  const base: ApiMsg[] = [{ role: 'user', content: 'hi' }, { role: 'system', content: [{ type: 'text', text: 'base', cache_control: { type: 'ephemeral' } }] }]
  assert.deepEqual(summaryForkMessages(base, 'ask'), [base[0], { role: 'system', content: [{ type: 'text', text: 'base', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'ask' }] }])
  const answered: ApiMsg[] = [...base, { role: 'assistant', content: 'ok' }]
  assert.deepEqual(summaryForkMessages(answered, 'ask'), [...answered, { role: 'user', content: [{ type: 'text', text: 'ask' }] }])

  // Given the text of the reply that ended the turn, as the user's next prompt: after it, in a message of its own.
  assert.deepEqual(summaryForkMessages(base, 'ask', ['done']), [...base, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, { role: 'user', content: [{ type: 'text', text: 'ask' }] }])
})

test('records replace the turns they cover, after the base, and go when their prompt does', () => {
  const msgs = session()
  const f = summaryForkAt(msgs)!
  const r1 = recordOf([{ type: 'text', text: 'one\nEnds before: [2]' }], f, 'now')!
  const r2 = recordOf([{ type: 'text', text: 'two\nEnds before: [3]' }], { ...f, start: 2, prompts: f.prompts.slice(1) }, 'now')!
  const out = summarized(none(msgs), msgs, [r1, r2])
  assert.deepEqual(out.msgs.slice(0, 3), msgs.slice(0, 3))
  // One message each, oldest first, each standing for the first message it covers.
  assert.deepEqual(out.msgs.slice(3, 5), [r1, r2].map((r) => ({ role: 'assistant', content: [{ type: 'text', text: `${SUMMARY_HEAD}\n\n${r.text}` }] })))
  assert.deepEqual(out.msgs.slice(5), msgs.slice(10))
  assert.deepEqual(startsOf(msgs, [r1, r2]), [3, 6])
  assert.deepEqual(out.origin, [0, 1, 2, 3, 6, ...msgs.slice(10).map((_, i) => 10 + i)])
  // The next summary fork asks from turn 3, and counts only what follows the
  // records.
  assert.equal(summaryForkAt(msgs, [r1, r2], 0, 1000)?.start, 3)
  // Rewound to turn 2 with a new prompt: the second record goes.
  const rewound = [...msgs.slice(0, 10), { role: 'user', content: 'turn three, again' }, ...msgs.slice(11)] as ApiMsg[]
  assert.deepEqual(validChain([r1, r2], rewound), [r1])
  // Where it breaks: the second record, with the prompt now in its place; and
  // past the end of a shorter conversation, no prompt.
  assert.deepEqual(chainBreak([r1, r2], rewound), { index: 1, found: promptHash(rewound[10]) })
  assert.deepEqual(chainBreak([r1, r2], msgs.slice(0, 8)), { index: 1 })
  assert.equal(chainBreak([r1, r2], msgs), undefined)
})

test("records keep the covered notes a record can't stand in for, as a system message before them", () => {
  const tools = { role: 'system', content: [{ type: 'tool_addition', tool: { name: 'Docs' } }] } as ApiMsg
  const cwd = (dir: string) => `# Environment update\n - Primary working directory: ${dir}`
  const older = { role: 'system', content: [{ type: 'text', text: cwd('/a') }] } as ApiMsg
  const mixed = { type: 'text', text: `<system-reminder>\nNote: /a/x.ts changed on disk since you last read it.\n     1\tx\n\n${cwd('/b')}\n</system-reminder>` }
  // A preamble with a heading, so the notes after it don't read as one
  // re-sent after a /compact (log.ts, preambleEnd).
  const msgs = session()
  msgs[2] = { role: 'system', content: '# Environment\n - Primary working directory: /p' }
  // Turn one's result is followed by the tools and the first move; turn two's
  // carries the second, in a reminder with a file's change, which goes.
  msgs.splice(5, 0, tools, older)
  ;(msgs[10].content as object[]).push(mixed)
  const f = summaryForkAt(msgs)!
  const r = recordOf([{ type: 'text', text: 'two\nEnds before: [3]' }], f, 'now')!
  const out = summarized(none(msgs), msgs, [r])
  const kept = out.msgs[3]
  assert.equal(kept.role, 'system')
  // The tools' block is the one sent; the move to /b replaces the one to /a.
  assert.equal((kept.content as object[])[0], tools.content[0])
  assert.deepEqual((kept.content as object[]).slice(1), [{ type: 'text', text: `<system-reminder>\n${cwd('/b')}\n</system-reminder>` }])
  assert.equal(out.msgs[4].role, 'assistant')
  assert.equal(out.origin[3], out.origin[4])
  // Covered turns without such notes leave nothing.
  assert.equal(summarized(none(session()), session(), [recordOf([{ type: 'text', text: 'one\nEnds before: [2]' }], summaryForkAt(session())!, 'now')!]).msgs[3].role, 'assistant')
})

test('after a /compact, records keep the preamble Claude Code puts after the exchange it kept', () => {
  const kept: ApiMsg[] = [
    { role: 'user', content: 'This session is being continued' },
    { role: 'assistant', content: 'the last reply before the compact' },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nCodebase and user instructions are shown below.\n</system-reminder>' }, { type: 'text', text: 'turn one' }] },
    { role: 'system', content: 'Note: a file changed.\n\nThe following skills are available for use' },
  ]
  const msgs = [...kept, ...session().slice(3)]
  assert.equal(preambleEnd(msgs), 4)
  const f = summaryForkAt(msgs)!
  const r = recordOf([{ type: 'text', text: 'one\nEnds before: [4]' }], f, 'now')!
  assert.deepEqual(summarized(none(msgs), msgs, [r]).msgs.slice(0, 5), [...kept, { role: 'assistant', content: [{ type: 'text', text: `${SUMMARY_HEAD}\n\n${r.text}` }] }])
  // With the preamble before the first response, or none, it ends there.
  assert.equal(preambleEnd(session()), 3)
  assert.equal(preambleEnd([kept[0], kept[1], { role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }]), 1)
})

test('the records added replace what was sent, past the records before them', () => {
  const msgs = session()
  const f = summaryForkAt(msgs)!
  const r1 = recordOf([{ type: 'text', text: 'one\nEnds before: [2]' }], f, 'now')!
  const r2 = recordOf([{ type: 'text', text: 'two\nEnds before: [3]' }], { ...f, start: 2 }, 'now')!
  const sent = summarized(none(msgs), msgs, [r1])
  // With r1 sent, r2 replaces turn 2: its prompt, call, result and reply.
  assert.deepEqual(coveredBy(sent, msgs, [r1, r2], 1), msgs.slice(6, 10))
  assert.deepEqual(coveredBy(none(msgs), msgs, [r1, r2], 0), msgs.slice(3, 10))
})

test("a record's arcs are read from its headings and dated by their turns' prompts", () => {
  const msgs = session()
  // Message i was first sent at minute i.
  const born = (m: ApiMsg) => new Date(Date.UTC(2026, 9, 25, 12, msgs.indexOf(m))).toISOString()
  const f = summaryForkOf(none(msgs), msgs, [], 0, 1000, new Map(), counts(msgs), born) as SummaryFork
  const r = recordOf([{ type: 'text', text: '## [1] Did one.\n- a\n\n## [2] Did two.\n- b\n\nEnds before: [3]' }], f, 'now', 900)!
  assert.equal(r.tokens, 900)
  // Turn 1's prompt is message 1, turn 2's message 6 and turn 3's message 10;
  // an arc's last request sent the message before its last, so arc 1 runs from
  // minute 1 to 4 and arc 2 from 6 to 8.
  assert.deepEqual(r.arcs, [
    { turn: 1, title: 'Did one.', time: born(msgs[1]), minutes: 3 },
    { turn: 2, title: 'Did two.', time: born(msgs[6]), minutes: 2 },
  ])
  // An arc over both turns counts their own minutes, not the gap between them.
  const both = recordOf([{ type: 'text', text: '## [1] Did both.\n- a\n\nEnds before: [3]' }], f, 'now')!
  assert.deepEqual(both.arcs, [{ turn: 1, title: 'Did both.', time: born(msgs[1]), minutes: 5 }])
  // No arcs without headings that start the record and rise within its turns.
  for (const text of ['- a\n\n## [1] Did one.', '## [2] Two.\n## [1] One.', '## [1] One.\n## [3] Three.', '## Arc\n- a'])
    assert.equal(recordOf([{ type: 'text', text: `${text}\n\nEnds before: [3]` }], f, 'now')!.arcs, undefined)
})

test('the oldest records merge into the memoir until the rest fit under the threshold', () => {
  const rec = (tokens: number, arcs = true): Summary => ({ endsBefore: 2, prompt: '', text: '', time: '', tokens, ...(arcs && { arcs: [] }) })
  const chain = [rec(6000), rec(6000), rec(6000), rec(6000)]
  assert.equal(mergedOf(chain, 0, 15000), 2)
  assert.equal(mergedOf(chain, 0, 24000), 0)
  // Never fewer than before, and not past one without arcs.
  assert.equal(mergedOf(chain, 3, 15000), 3)
  assert.equal(mergedOf([rec(6000), rec(6000, false), rec(6000), rec(6000)], 0, 15000), 1)
})

test('the memoir lists arc titles under their dates, before the records left', () => {
  const at = (d: number, h: number) => new Date(2026, 9, d, h).toISOString()
  const r1: Summary = { endsBefore: 2, prompt: '', text: 'one', time: at(16, 23), arcs: [{ turn: 1, title: 'Built A.', time: at(15, 9), minutes: 40 }, { turn: 1, title: 'Fixed B.', time: at(16, 10) }] }
  const r2: Summary = { endsBefore: 3, prompt: '', text: 'two', time: at(17, 9), arcs: [{ turn: 2, title: 'Tested C.', time: at(16, 20), minutes: 5 }] }
  assert.equal(memoirOf([r1, r2]), `${MEMOIR_HEAD}\n\n2026-10-15\n- Built A. (~40 min)\n\n2026-10-16\n- Fixed B.\n- Tested C. (~5 min)\n\n${MEMOIR_FOOT}`)
  const msgs = session()
  const r3: Summary = { endsBefore: 4, prompt: '', text: 'three', time: '' }
  const out = summarized(none(msgs), msgs, [r1, r2, r3], 2)
  assert.deepEqual(out.msgs.slice(3, 5), [memoirOf([r1, r2]), `${SUMMARY_HEAD}\n\nthree`].map((text) => ({ role: 'assistant', content: [{ type: 'text', text }] })))
  assert.deepEqual(out.origin.slice(3, 5), [3, 10])
})

test('records and the memoir are found by the fixed start of their headings, and by their old headings', () => {
  const text = (t: string) => ({ type: 'text', text: t })
  for (const t of [`${SUMMARY_HEAD}\n\nx`, '[shaver] Summary records: reworded\n\nx', "[shaver] My record of this session's earlier turns, compacted in my context:\n\nx"]) {
    assert.ok(isSummary(text(t)), t)
    assert.ok(!isMemoir(text(t)), t)
  }
  for (const t of [`${MEMOIR_HEAD}\n\nx`, '[shaver] Memoir records: reworded', "[shaver] My memoir: an overview of this session's work leading up to this point."]) {
    assert.ok(isMemoir(text(t)), t)
    assert.ok(!isSummary(text(t)), t)
  }
})

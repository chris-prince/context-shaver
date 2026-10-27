import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MEMOIR_FOOT, MEMOIR_HEAD, SUMMARY_HEAD, type ApiMsg } from '../src/items.ts'
import { apply } from '../src/trim.ts'
import { coveredBy, summaryForkMessages, summaryForkOf, instructions, memoirOf, mergedOf, recordOf, startsOf, summarized, validChain, type SummaryFork, type Summary } from '../src/summary.ts'

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
const none = (msgs: ApiMsg[]) => apply(msgs, {}, { steps: 0, turns: 0 })
// Each message's count as the stats have it: a tool result 1,000 tokens, the rest 100.
const counts = (msgs: ApiMsg[]) => msgs.map((m) => (JSON.stringify(m).includes('tool_result') ? 1000 : 100))
const summaryForkAt = (msgs: ApiMsg[], chain: Summary[] = [], offered = 0, threshold = 1000, tokens = counts(msgs)) => summaryForkOf(none(msgs), msgs, chain, offered, threshold, new Map(), tokens)

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
  assert.match(instructions(f), /\[1\] "turn one"\n\[2\] "turn two"\n\[3\] "turn three"\n\nThe latest prompt, still in progress:\n\[4\] "turn four"/)
})

test('a summary fork appends its instructions after the breakpoint, so it reads the cached prefix', () => {
  const msgs = session()
  const out = summaryForkMessages(msgs.slice(0, -1), 'compact')
  assert.deepEqual(out.slice(0, -1), msgs.slice(0, -2))
  assert.deepEqual(out.at(-1)!.content, [{ type: 'tool_result', tool_use_id: 't4', content: long }, { type: 'text', text: 'compact' }])
})

test('records replace the turns they cover, after the base, and go when their prompt does', () => {
  const msgs = session()
  const f = summaryForkAt(msgs)!
  const r1 = recordOf([{ type: 'text', text: 'one\nEnds before: [2]' }], f, 'now')!
  const r2 = recordOf([{ type: 'text', text: 'two\nEnds before: [3]' }], { ...f, start: 2 }, 'now')!
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
  const f = summaryForkOf(none(msgs), msgs, [], 0, 1000, new Map(), counts(msgs), born)!
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

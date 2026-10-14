import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ApiMsg } from '../src/items.ts'
import { apply } from '../src/trim.ts'
import { forkMessages, forkOf, instructions, recordOf, summarized, validChain, type Fork, type Summary } from '../src/summary.ts'

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
const forkAt = (msgs: ApiMsg[], chain: Summary[] = [], offered = 0, threshold = 1000) => forkOf(none(msgs), msgs, chain, offered, threshold, new Map())

test('a fork covers the completed turns from the last record on, once they are big enough', () => {
  const msgs = session()
  const f = forkAt(msgs)!
  assert.deepEqual([f.start, f.current], [1, 4])
  assert.deepEqual(f.prompts.map((p) => p.quote), ['turn one', 'turn two', 'turn three', 'turn four'])
  assert.ok(f.chars > 3 * 4000 && f.chars < 4 * 4000) // turns 1–3, not the current one
  assert.equal(forkAt(msgs, [], 0, 10_000), undefined)
  // Offered at turn 3: only turn 3 counts towards the next, but it still asks from the start.
  assert.equal(forkAt(msgs, [], 3, 2000), undefined)
  assert.equal(forkAt(msgs, [], 3, 1000)?.start, 1)
})

test("a fork's record is read back, and only one that covers a complete arc is kept", () => {
  const msgs = session()
  const f = forkAt(msgs)!
  const r = recordOf([{ type: 'text', text: '## Arc\n- did it\n\nEnds before: [3]' }], f, 'now')!
  assert.equal(r.text, '## Arc\n- did it')
  assert.equal(r.endsBefore, 3)
  assert.deepEqual(validChain([r], msgs), [r])
  for (const text of ['Ends before: [1]', 'no closing line', '## Arc\n\nEnds before: [5]']) assert.equal(recordOf([{ type: 'text', text }], f, 'now'), undefined)
  assert.equal(recordOf([{ type: 'text', text: 'x\nEnds before: [3]' }, { type: 'tool_use', id: 'z', name: 'Bash', input: {} }], f, 'now'), undefined)
  assert.match(instructions(f), /\[1\] "turn one"\n\[2\] "turn two"\n\[3\] "turn three"\n\nThe latest prompt, still in progress:\n\[4\] "turn four"/)
})

test('a fork appends its instructions after the breakpoint, so it reads the cached prefix', () => {
  const msgs = session()
  const out = forkMessages(msgs.slice(0, -1), 'compact')
  assert.deepEqual(out.slice(0, -1), msgs.slice(0, -2))
  assert.deepEqual(out.at(-1)!.content, [{ type: 'tool_result', tool_use_id: 't4', content: long }, { type: 'text', text: 'compact' }])
})

test('records replace the turns they cover, after the base, and go when their prompt does', () => {
  const msgs = session()
  const f = forkAt(msgs)!
  const r1 = recordOf([{ type: 'text', text: 'one\nEnds before: [2]' }], f, 'now')!
  const r2 = recordOf([{ type: 'text', text: 'two\nEnds before: [3]' }], { ...f, start: 2 }, 'now')!
  const out = summarized(none(msgs), msgs, [r1, r2])
  assert.deepEqual(out.msgs.slice(0, 3), msgs.slice(0, 3))
  assert.equal(out.msgs[3].role, 'assistant')
  assert.match(JSON.stringify(out.msgs[3].content), /one\\n\\ntwo/)
  assert.deepEqual(out.msgs.slice(4), msgs.slice(10))
  assert.deepEqual(out.origin, [0, 1, 2, 3, ...msgs.slice(10).map((_, i) => 10 + i)])
  // The next fork asks from turn 3, and counts only what follows the records.
  assert.equal(forkAt(msgs, [r1, r2], 0, 1000)?.start, 3)
  // Rewound to turn 2 with a new prompt: the second record goes.
  const rewound = [...msgs.slice(0, 10), { role: 'user', content: 'turn three, again' }, ...msgs.slice(11)] as ApiMsg[]
  assert.deepEqual(validChain([r1, r2], rewound), [r1])
})

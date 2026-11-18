import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ccVersion, fileTokens, folded, keptTokens, type MtimeOf } from '../src/compact-keep.ts'
import type { ApiMsg } from '../src/items.ts'

const RATIO = 0.25
const reminder = (text: string) => ({ type: 'text', text: '<system-reminder>' + text + '</system-reminder>' })
const prompt = (text: string): ApiMsg => ({ role: 'user', content: [{ type: 'text', text }] })
const system = (text: string): ApiMsg => ({ role: 'system', content: [{ type: 'text', text }] }) as unknown as ApiMsg
const call = (id: string, name: string, input: Record<string, unknown>): ApiMsg => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] })
const result = (id: string, content: string, is_error?: true): ApiMsg => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(is_error && { is_error }) }] })
const answer = (text: string): ApiMsg => ({ role: 'assistant', content: [{ type: 'text', text }] })
const read = (id: string, path: string, size: number): ApiMsg[] => [call(id, 'Read', { file_path: path }), result(id, 'x'.repeat(size))]
const bytes = (v: unknown) => JSON.stringify(v).length
const ENV = '# Environment\nYou have been invoked in the following environment:\n - cwd: /a\n'
const DEFERRED = 'The following deferred tools are now available via ToolSearch.\nAgent\n'
const LISTING = 'The following skills are available for use with the Skill tool:\n\n- demo: Does a demo\n'
const body = (name: string, size: number) => `Base directory for this skill: /skills/${name}\n\n# ${name}\n` + 'd'.repeat(size)
// A skill invoked: the Skill call, its result and its body beside it.
const skill = (id: string, name: string, size: number): ApiMsg[] => [
  call(id, 'Skill', { skill: name }),
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Launching skill: ' + name }, { type: 'text', text: body(name, size) }] },
]

// A conversation of several rounds that reads, writes and edits files, with
// standing context and deferred tools added along the way.
const conversation: ApiMsg[] = [
  { role: 'user', content: [reminder('instructions'), reminder('memory'), { type: 'text', text: 'first prompt' }] },
  system(ENV),
  ...read('r1', '/a.ts', 400),
  ...read('r2', '/b.ts', 800),
  answer('done'),
  prompt('second prompt'),
  { role: 'user', content: [{ type: 'tool_addition', tool: { definition: { name: 'Extra' } } }] as never },
  system(DEFERRED),
  system(LISTING),
  ...skill('s1', 'demo', 1000),
  ...read('r3', '/c.ts', 1200),
  call('w1', 'Write', { file_path: '/d.ts', content: 'y'.repeat(300) }),
  result('w1', 'ok'),
  ...read('r4', '/a.ts', 500),
  call('e1', 'Edit', { file_path: '/b.ts', old_string: 'a', new_string: 'bbbbb' }),
  result('e1', 'ok'),
  ...read('r5', '/missing.ts', 0).slice(0, 1),
  result('r5', 'no such file', true),
  system(ENV + ' - cwd: /b\n'),
  answer('done again'),
  prompt('third prompt'),
  ...read('r6', '/e.ts', 600),
]

test('folding each request on from the last gives what folding it whole does', () => {
  // Every request: the conversation up to each message, folded on from the
  // request before (some requests adding several messages).
  const mtimeOf: MtimeOf = (p) => (p === '/c.ts' ? undefined : p.length * 1000)
  let k = folded(undefined, conversation.slice(0, 1), mtimeOf)
  for (let n = 2; n <= conversation.length; n += n % 3 ? 1 : 2) {
    k = folded(k, conversation.slice(0, n), mtimeOf)
    assert.deepEqual(k, folded(undefined, conversation.slice(0, n), mtimeOf), `at ${n} messages`)
  }
})

test('messages that no longer go on from those folded are folded from the start, keeping the files seen', () => {
  const k = folded(undefined, conversation.slice(0, 10))
  assert.ok(k.files.length > 0)
  // A rewind: the last message edited. The files it still holds were seen.
  const rewound = [...conversation.slice(0, 9), prompt('edited')]
  assert.deepEqual(folded(k, rewound), folded(undefined, rewound))
  // Fewer messages than were folded, as after a compaction: everything from
  // the start but the files, which Claude Code still holds and can restore.
  const compacted = [prompt('summary'), prompt('next')]
  assert.deepEqual(folded(k, compacted), { ...folded(undefined, compacted), files: k.files, skills: k.skills })
})

test('it keeps the reminders, added tools and standing context as last stood, the skills invoked, and the newest files bar those the last answer reads', () => {
  const k = folded(undefined, conversation)
  const first = conversation[0].content as unknown[]
  const addition = (conversation.find((m) => JSON.stringify(m).includes('tool_addition'))!.content as unknown[])[0]
  // The reminders and the tool_addition.
  assert.equal(k.resent, bytes(first[0]) + bytes(first[1]) + bytes(addition))
  // The environment as it last stood, the deferred tools' list and the
  // skills listing.
  assert.deepEqual(k.latest, { '# Environment\n': (ENV + ' - cwd: /b\n').length, 'The following deferred tools': DEFERRED.length, 'The following skills are available': LISTING.length })
  // The skill, at its body's characters.
  assert.deepEqual(k.skills, [['demo', body('demo', 1000).length]])
  // Answers: nine tool calls and two texts.
  assert.equal(k.rounds, 11)
  // Newest last; /b.ts moved up when edited, its size changed by the edit;
  // the failed read left nothing. Sizes in characters and lines as a Read
  // result shows them: the file written, one line numbered "1\t".
  assert.deepEqual(k.files.map(([p]) => p), ['/c.ts', '/d.ts', '/a.ts', '/b.ts', '/e.ts'])
  assert.deepEqual(k.files.find(([p]) => p === '/d.ts'), ['/d.ts', 302, 1])
  assert.deepEqual(k.files.find(([p]) => p === '/b.ts'), ['/b.ts', 804, 0])
  // The last answer reads /e.ts, so the compaction leaves it to that answer.
  assert.deepEqual(k.reads, ['/e.ts'])
  // The tokens kept: what's sent again, then each other file with its call.
  const files = k.files.filter(([p]) => p !== '/e.ts').reduce((n, [, chars, lines]) => n + fileTokens(chars, lines!) + 120 * RATIO, 0)
  // The skill with its lines, and the message's opening.
  const skills = (body('demo', 1000).length + 60 + 700) * RATIO
  assert.equal(keptTokens(k, RATIO), (k.resent + (ENV + ' - cwd: /b\n').length + DEFERRED.length + LISTING.length) * RATIO + files + skills)
})

test('a skill invoked again moves to newest at its new size; after a compaction, the skills it restored are known', () => {
  const k = folded(undefined, [prompt('a'), ...skill('s1', 'one', 100), ...skill('s2', 'two', 200), ...skill('s3', 'one', 300), answer('b')])
  assert.deepEqual(k.skills, [['two', body('two', 200).length], ['one', body('one', 300).length]])
  // The message a compaction restores them in: each body after its lines,
  // up to the next part.
  const restored = system('The following skills were invoked EARLIER in this session (before the conversation was compacted).\n\n' +
    '### Skill: one\nPath: bundled:one\n' + body('one', 300) + '\n' + '### Skill: two\nPath: bundled:two\n' + body('two', 200) + '\n' + ENV)
  const after = folded(undefined, [prompt('summary'), restored, answer('a'), prompt('b'), answer('c')])
  assert.deepEqual(after.skills, [['one', body('one', 300).length + 1], ['two', body('two', 200).length + 1]])
  // The opening isn't counted as standing context; the environment is.
  assert.deepEqual(after.latest, { '# Environment\n': ENV.length })
  // Carried across a compaction, as files are.
  assert.deepEqual(folded(k, [prompt('summary'), prompt('next')]).skills, k.skills)
})

test('it restores the skills newest first, each over 5,000 tokens cut to 20,000 characters, up to 25,000 tokens in all', () => {
  const of = (skills: [string, number][]) => keptTokens({ resent: 0, latest: {}, rounds: 2, reads: [], files: [], skills }, RATIO)!
  // Over 5,000 tokens at 4 characters a token: cut to 20,000 characters.
  assert.equal(of([['big', 30_000]]), (20_000 + 60 + 700) * RATIO)
  // Seven of 4,000 tokens: the six newest fit in 25,000, the oldest doesn't.
  assert.equal(of(Array.from({ length: 7 }, (_, i) => ['s' + i, 16_000] as [string, number])), (6 * (16_000 + 60) + 700) * RATIO)
  // An older one of 1,000 tokens still fits, reaching 25,000 exactly.
  assert.equal(of([['small', 4_000], ...Array.from({ length: 6 }, (_, i) => ['s' + i, 16_000] as [string, number])]), (6 * (16_000 + 60) + (4_000 + 60) + 700) * RATIO)
  // Journals from before 2026-11-18 hold no skills.
  assert.equal(keptTokens({ resent: 0, latest: {}, rounds: 2, reads: [], files: [] } as never, RATIO), 0)
})

test('each announcement of deferred tools replaces the last, as the compaction sends one list', () => {
  const more = 'The following deferred tools are now available via ToolSearch.\nAgent\nMonitor\n'
  const k = folded(undefined, [prompt('a'), system(DEFERRED), answer('b'), prompt('c'), system(more), answer('d')])
  assert.deepEqual(k.latest, { 'The following deferred tools': more.length })
})

test('it restores the five newest files, each over 5,000 tokens as a note, up to 50,000 in all', () => {
  const k = folded(undefined, [prompt('one'), ...Array.from({ length: 8 }, (_, i) => read('r' + i, `/f${i}.ts`, 14_000)).flat(), prompt('two')])
  // Five of eight files, each just under 5,000 tokens (its call over it, so
  // the size alone decides).
  const each = fileTokens(14_000, 0) + 120 * RATIO
  assert.ok(fileTokens(14_000, 0) < 5000)
  assert.ok(Math.abs(keptTokens(k, RATIO)! - 5 * each) < 1e-6)
  // One over the limit is a note instead.
  const big = folded(undefined, [prompt('one'), ...read('r', '/big.ts', 30_000 / RATIO), prompt('two'), answer('ok')])
  assert.ok(keptTokens(big, RATIO)! < 100, String(keptTokens(big, RATIO)))
})

test('after a compaction, the files it restored are known, a note as too large', () => {
  const restored = system(
    'Called the Read tool with the following input: {"file_path":"/r.ts"}\nResult of calling the Read tool: ' + 'z'.repeat(2000) + '\n' +
    'Note: /n.ts was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.\n' +
    ENV,
  )
  const k = folded(undefined, [prompt('summary'), restored, answer('a'), prompt('b'), answer('c')])
  assert.deepEqual(k.files.map(([p]) => p), ['/r.ts', '/n.ts'])
  // Its part of the message, less its call: about the 2,000 of its contents.
  assert.ok(k.files[0][1] > 1900 && k.files[0][1] < 2100, String(k.files[0][1]))
  assert.equal(k.files[0][2], 2)
  // The environment isn't sent again, and the note stays a note.
  assert.equal(k.resent, 0)
  const notes = keptTokens(k, RATIO)! - (fileTokens(k.files[0][1], k.files[0][2]!) + 120 * RATIO)
  assert.ok(notes > 0 && notes < 100, String(notes))
})

test('with fewer than two answers it keeps nothing, since nothing is compacted', () => {
  assert.equal(keptTokens(folded(undefined, conversation.slice(0, 4)), RATIO), undefined)
})

test('an edit changes the size last known once it succeeds; a failed one, an unread file and a note are left as they were', () => {
  const edit = (id: string, path: string, old_string: string, new_string: string, failed?: true) => [call(id, 'Edit', { file_path: path, old_string, new_string }), result(id, failed ? 'not found' : 'ok', failed)]
  const k = folded(undefined, [
    prompt('one'),
    ...read('r1', '/a.ts', 1000),
    ...read('r2', '/b.ts', 1000),
    ...read('r3', '/big.ts', 30_000 / RATIO),
    // Grows /a.ts by 10 bytes, then a failed edit on it changes nothing.
    ...edit('e1', '/a.ts', 'x', 'x'.repeat(11)),
    ...edit('e2', '/a.ts', 'x', 'x'.repeat(500), true),
    // Shrinks /b.ts by 2 edits at once.
    call('m1', 'MultiEdit', { file_path: '/b.ts', edits: [{ old_string: 'xxxx', new_string: '' }, { old_string: 'xx', new_string: 'x' }] }),
    result('m1', 'ok'),
    // A file never read is still unknown; one read in full grows as any.
    ...edit('e3', '/unread.ts', 'a', 'b'),
    ...edit('e4', '/big.ts', 'x', 'xx'),
    // One a compaction restored as a note stays a note.
    system('Note: /noted.ts was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.'),
    ...edit('e5', '/noted.ts', 'x', 'xx'),
  ])
  assert.deepEqual(k.files.map(([p]) => p), ['/a.ts', '/b.ts', '/big.ts', '/noted.ts'])
  assert.equal(k.files[3][1], -1)
  assert.equal(k.files[0][1], 1000 + 10)
  assert.equal(k.files[1][1], 1000 - 5)
  assert.equal(k.files[2][1], 30_000 / RATIO + 1)
  // An edit that adds lines adds them, each with its number.
  const lined = folded(undefined, [prompt('one'), ...read('r1', '/a.ts', 1000), ...edit('e1', '/a.ts', 'x', 'x\nx\nx')])
  assert.deepEqual(lined.files[0], ['/a.ts', 1000 + 4 + 2 * 2, 2])
})

test('it restores the newest files by modification time where each has one, else the last touched', () => {
  // Seven files read in order, each a different size; the first read the
  // newest on disk.
  const reads = Array.from({ length: 7 }, (_, i) => read('r' + i, `/f${i}.ts`, 1000 * (i + 1))).flat()
  const msgs = [prompt('one'), ...reads, prompt('two'), answer('ok')]
  const tokens = (is: number[]) => is.reduce((n, i) => n + fileTokens(1000 * (i + 1), 0) + 120 * RATIO, 0)
  const byMtime = folded(undefined, msgs, (p) => 10_000 - Number(p.slice(2, 3)))
  assert.ok(Math.abs(keptTokens(byMtime, RATIO)! - tokens([0, 1, 2, 3, 4])) < 1e-6)
  // One without a time: the order touched.
  const partly = folded(undefined, msgs, (p) => (p === '/f3.ts' ? undefined : 10_000 - Number(p.slice(2, 3))))
  assert.ok(Math.abs(keptTokens(partly, RATIO)! - tokens([2, 3, 4, 5, 6])) < 1e-6)
  // The time stored is the file's when last read or written.
  assert.deepEqual(byMtime.files[0], ['/f0.ts', 1000, 0, 10_000])
})

test('a Write counts once it succeeds', () => {
  const k = folded(undefined, [prompt('one'), call('w1', 'Write', { file_path: '/w.ts', content: 'a\nb' }), result('w1', 'denied', true), call('w2', 'Write', { file_path: '/v.ts', content: 'a\nb' })])
  // The failed one left nothing; the other's result hasn't come.
  assert.deepEqual(k.files, [])
})

test('files journaled before 2026-11-18, as [path, JSON bytes], are counted at the conversation\'s tokens a byte', () => {
  const k = { resent: 0, latest: {}, rounds: 2, reads: [], files: [['/old.ts', 1000]] as [string, number][] }
  assert.equal(keptTokens(k, RATIO), (1000 + 120) * RATIO)
})

test('after Claude Code restarts at a new version, the skills invoked before are forgotten, the files not', () => {
  const system = [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.327.4de; cc_entrypoint=cli;' }]
  assert.equal(ccVersion(system), '2.1.327')
  assert.equal(ccVersion([{ type: 'text', text: 'You are Claude Code' }]), undefined)
  const msgs = [prompt('a'), ...skill('s1', 'one', 100), ...read('r1', '/a.ts', 400), answer('b')]
  const k = folded(undefined, msgs, undefined, '2.1.326')
  assert.deepEqual(k.skills.map(([n]) => n), ['one'])
  const more = [...msgs, prompt('c')]
  // The same version, or none known: the skills stay.
  assert.deepEqual(folded(k, more, undefined, '2.1.326').skills, k.skills)
  assert.deepEqual(folded(k, more).skills, k.skills)
  // A new version: they're gone until invoked again; the files and the
  // version kept.
  const after = folded(k, more, undefined, '2.1.327')
  assert.deepEqual(after.skills, [])
  assert.deepEqual(after.files, k.files)
  assert.equal(after.version, '2.1.327')
  assert.deepEqual(folded(after, [...more, ...skill('s2', 'one', 100)], undefined, '2.1.327').skills.map(([n]) => n), ['one'])
})

test('a record folded again from the start after a restart still leaves out the skills invoked before it', () => {
  const msgs = [prompt('a'), ...skill('s1', 'one', 100), ...read('r1', '/a.ts', 400), answer('b')]
  const k = folded(undefined, msgs, undefined, '2.1.326')
  const after = folded(k, [...msgs, prompt('c')], undefined, '2.1.327')
  assert.equal(after.skillsFrom, msgs.length)
  // The last message changed (so the fold starts over): 'one' stays out, a
  // skill invoked after the restart comes in.
  const changed = [...msgs, prompt('c2'), ...skill('s2', 'two', 100)]
  const again = folded(after, changed, undefined, '2.1.327')
  assert.deepEqual(again.skills.map(([n]) => n), ['two'])
  assert.equal(again.skillsFrom, msgs.length)
})

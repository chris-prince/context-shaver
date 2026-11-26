// Unbound thinking (trim.ts, unboundIn): a thinking block is bound while the
// messages before it are those it was generated after, and one unbound costs
// nothing, in sizes, cache reads and the savings trims are weighed by.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hash } from '../src/log.ts'
import type { ApiMsg } from '../src/items.ts'
import { modelOf } from '../src/models.ts'
import { decide, positionsOf, prefixesOf, unboundIn, type Thinking } from '../src/trim.ts'

const think = { type: 'thinking', thinking: '', signature: 's'.repeat(400) }
const ask = (text: string): ApiMsg => ({ role: 'user', content: [{ type: 'text', text }] })
const reply: ApiMsg = { role: 'assistant', content: [think, { type: 'tool_use', id: 'a', name: 'Read', input: {} }] }
const result = (text: string): ApiMsg => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: text }] })
// Its thinking billed 2000 tokens, generated after `before`.
const recorded = (before: readonly ApiMsg[]): Thinking => Object.assign(new Map([[hash(think.signature), 2000]]), { after: new Map([[hash(think.signature), prefixesOf(before)]]) })

test('thinking is bound while the messages before it are those it came after, and is unbound once they change', () => {
  const first = [ask('one'), result('x'.repeat(4000))]
  const t = recorded(first)
  assert.equal(unboundIn([...first, reply, ask('two')], t).size, 0)
  const trimmed = [ask('one'), result('[stub]'), reply, ask('two')]
  assert.deepEqual([...unboundIn(trimmed, t)], [think])
  // What comes after it doesn't unbind it.
  assert.equal(unboundIn([...first, reply, result('[stub]')], t).size, 0)
})

test('a breakpoint, or a lone text block sent as a string, leaves thinking bound', () => {
  const t = recorded([{ role: 'user', content: [{ type: 'text', text: 'one', cache_control: { type: 'ephemeral' } }] }])
  assert.equal(unboundIn([{ role: 'user', content: 'one' }, reply], t).size, 0)
  assert.equal(unboundIn([ask('one'), reply], t).size, 0)
})

test('thinking with nothing recorded of what it came after counts as bound', () => {
  const t: Thinking = new Map([[hash(think.signature), 2000]])
  assert.equal(unboundIn([ask('changed'), reply], t).size, 0)
  assert.equal(unboundIn([ask('changed'), reply], Object.assign(new Map(), { after: new Map([['other', 'x']]) })).size, 0)
})

test('unbound thinking is sized 0, bound thinking at its tokens', () => {
  const t = recorded([ask('one')])
  const size = (msgs: ApiMsg[]) => positionsOf(msgs, 's', t).find((_, i) => i === 1)!.size
  assert.ok(size([ask('one'), reply]) > 2000 / 0.39 - 100, 'bound: its 2000 tokens\' worth')
  assert.equal(size([ask('changed'), reply]), 0)
})

// A trim of thinking already unbound saves nothing of it: before, the stub
// before it had unbound it; dropping the reply's thinking saves only its
// characters' worth outside the thinking, which are none.
test('decide counts no saving for dropping thinking that was already unbound', () => {
  const t = recorded([ask('one'), result('x'.repeat(4000))])
  const marked = (msgs: ApiMsg[]): ApiMsg[] => msgs.map((m, i) => (i === msgs.length - 1 ? { ...m, content: [{ ...(m.content as any[])[0], cache_control: { type: 'ephemeral' } }] } : m))
  const before = marked([ask('one'), result('[stub]'), reply, ask('two')])
  const after = marked([ask('one'), result('[stub]'), { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] }, ask('two')])
  const live = new Set(positionsOf(before, 's', t).map((p) => p.prefix))
  assert.equal(decide(before, after, live, 's', modelOf('claude-opus-5-5'), t).savedChars, 0)
})

// A move that unbinds thinking saves only what it cuts, not the thinking:
// stubbing a result before bound thinking (2000 tokens) saves the result's
// characters, as before unbound thinking counted nothing.
test('decide counts no saving for thinking a move itself unbinds', () => {
  const first = [ask('one'), result('x'.repeat(4000))]
  const t = recorded(first)
  const marked = (msgs: ApiMsg[]): ApiMsg[] => msgs.map((m, i) => (i === msgs.length - 1 ? { ...m, content: [{ ...(m.content as any[])[0], cache_control: { type: 'ephemeral' } }] } : m))
  const before = marked([...first, reply, ask('two')])
  const after = marked([ask('one'), result('[stub]'), reply, ask('two')])
  const live = new Set(positionsOf(before, 's', t).map((p) => p.prefix))
  const cut = JSON.stringify(result('x'.repeat(4000)).content[0]).length - JSON.stringify(result('[stub]').content[0]).length
  assert.equal(decide(before, after, live, 's', modelOf('claude-opus-5-5'), t).savedChars, cut)
})

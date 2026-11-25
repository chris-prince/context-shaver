import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entryOf, MODELS, modelOf } from '../src/models.ts'

test('every table key is its own entry, and none is the end of another', () => {
  const norm = (s: string) => s.toLowerCase().replace(/[/._]/g, '-')
  for (const k of Object.keys(MODELS)) {
    assert.equal(entryOf(k), k)
    for (const o of Object.keys(MODELS)) if (o !== k) assert.ok(!norm(k).endsWith('-' + norm(o)) && norm(k) !== norm(o), `${k} ends with ${o}`)
  }
})

test("a router's or gateway's name finds its model by its end", () => {
  const cases: [string, string | undefined][] = [
    ['openai/gpt-6-luna', 'gpt-6-luna'],
    ['openai-gpt-6-luna', 'gpt-6-luna'],
    ['OpenAI/GPT-6-Luna', 'gpt-6-luna'],
    ['bedrock/claude-opus-4-6', 'claude-opus-4-6'],
    ['aws-claude-sonnet-4-6-1m', 'claude-sonnet-4-6'],
    ['claude-opus-4.6-1m', 'claude-opus-4-6'],
    ['anthropic/claude-opus-5.5', 'claude-opus-5-5'],
    ['global.openai.gpt-6.1-sol', 'gpt-6.1-sol'],
    ['openai/gpt-5.6-terra', 'gpt-5.6-terra'],
    // The longest key wins, and a match starts at a separator.
    ['gpt-6.2-sol', 'gpt-6.2-sol'],
    ['claude-opus-4-5', undefined],
    ['chatgpt-6-sol', undefined],
    ['constructor', undefined],
    ['openai/gpt-5.6', undefined],
  ]
  for (const [name, key] of cases) assert.equal(entryOf(name), key, name)
  assert.deepEqual(modelOf('openai/gpt-6.1-sol'), modelOf('gpt-6.1-sol'))
  assert.equal(modelOf('chatgpt-6-sol').price, undefined)
})

test("gpt-5.6-terra is OpenRouter's price, compacting at 90% of its 272K window", () => {
  const m = modelOf('gpt-5.6-terra')
  assert.deepEqual([m.price?.input, m.price?.output, m.price?.read, m.price?.write], [2, 12, 0.2, 2.5])
  assert.equal(m.compaction?.at, 244_800)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LAUNCH_DIR, LAUNCH_ID, launchVals, load, save } from '../src/launch-vals.ts'

const SCRIPT = path.resolve(import.meta.dirname, '../src/launch-vals.ts')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'launch-vals-'))

test('only the variables that bear on compaction are kept, and only those set', () => {
  const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000', CLAUDE_CONFIG_DIR: '/c', DISABLE_AUTO_COMPACT: '', ANTHROPIC_API_KEY: 'k', CODEX_HOME: '/x' }
  assert.deepEqual(launchVals('claude', env, [], '/w'), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000', CLAUDE_CONFIG_DIR: '/c', cwd: '/w' })
  assert.deepEqual(launchVals('codex', env, [], '/w'), { CODEX_HOME: '/x' })
  assert.deepEqual(launchVals('other', env, [], '/w'), {})
  // OpenCode reads these two relative to where it was started.
  assert.deepEqual(launchVals('opencode', { OPENCODE_CONFIG: 'oc.jsonc', OPENCODE_CONFIG_DIR: '/d', XDG_DATA_HOME: 'x', OPENCODE_DB: 'oc.db', OPENCODE_MODELS_PATH: 'm.json', XDG_CACHE_HOME: 'c' }, [], '/w'), { OPENCODE_CONFIG: '/w/oc.jsonc', OPENCODE_CONFIG_DIR: '/d', XDG_DATA_HOME: 'x', OPENCODE_DB: 'oc.db', OPENCODE_MODELS_PATH: '/w/m.json', cwd: '/w' })
})

test("Codex: the profile and the two limits from the command line, the last winning, none after --", () => {
  const args = ['-c', 'model_context_window=100000', '--profile', 'a', '-c', 'model="gpt"', '--config=model_context_window="400000"', '-p', 'b', 'exec', '--', '-p', 'c', '-c', 'model_auto_compact_token_limit=1']
  assert.deepEqual(launchVals('codex', {}, args, '/w'), { profile: 'b', model_context_window: '400000' })
  assert.deepEqual(launchVals('codex', {}, ['--profile=work', '-c', "model_auto_compact_token_limit = '300000'"], '/w'), { profile: 'work', model_auto_compact_token_limit: '300000' })
  // A prompt or another key's value is never kept.
  assert.deepEqual(launchVals('codex', {}, ['-c', 'model_providers.gw.http_headers.x-key="secret"', 'exec', 'do it'], '/w'), {})
})

test("OpenCode: of the user's own inline config, only compaction settings and whole model limits", () => {
  const content = JSON.stringify({
    compaction: { buffer: 30_000 },
    model: 'openrouter/x',
    provider: { openrouter: { options: { apiKey: 'secret' }, models: { x: { name: 'X', limit: { context: 500_000, output: 32_000 } }, y: { name: 'Y' } } } },
  })
  const vals = launchVals('opencode', { OPENCODE_CONFIG_CONTENT: content }, [], '/w')
  assert.deepEqual(JSON.parse(vals.OPENCODE_CONFIG_CONTENT), { compaction: { buffer: 30_000 }, provider: { openrouter: { models: { x: { limit: { context: 500_000, output: 32_000 } } } } } })
  for (const c of ['not json', '{"model":"x"}', '[1]']) assert.deepEqual(launchVals('opencode', { OPENCODE_CONFIG_CONTENT: c }, [], '/w'), { cwd: '/w' }, c)
})

test('values are saved under an ID named by them, and read back; none saved gives no ID', () => {
  const dir = tmp()
  assert.equal(save(dir, {}), undefined)
  assert.ok(!fs.existsSync(path.join(dir, LAUNCH_DIR)))
  const id = save(dir, { b: '2', a: '1' })!
  assert.match(id, LAUNCH_ID)
  // The same values, in any order, give the same file.
  assert.equal(save(dir, { a: '1', b: '2' }), id)
  assert.notEqual(save(dir, { a: '1', b: '3' }), id)
  assert.equal(fs.readdirSync(path.join(dir, LAUNCH_DIR)).length, 2)
  assert.deepEqual(load(dir, id), { a: '1', b: '2' })
  // An ID with no file, or not an ID, gives none.
  assert.equal(load(dir, 'ffffffffffffffff'), undefined)
  assert.equal(load(dir, '../../etc/passwd'), undefined)
})

test('run by a launcher, it prints the ID of what its environment and arguments hold, or nothing', () => {
  const dir = tmp()
  const run = (env: Record<string, string>, ...args: string[]) =>
    execFileSync(process.execPath, [SCRIPT, 'codex', dir, '--', ...args], { env: { PATH: process.env.PATH!, ...env }, encoding: 'utf8' }).trim()
  assert.equal(run({}, 'exec', 'hi'), '')
  const id = run({ CODEX_HOME: '/x' }, '-p', 'work', 'exec', 'hi')
  assert.match(id, LAUNCH_ID)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, LAUNCH_DIR, `${id}.json`), 'utf8')), { CODEX_HOME: '/x', profile: 'work' })
  // Run by a path through a symlink, as from a checkout reached through one.
  const link = path.join(tmp(), 'src')
  fs.symlinkSync(path.dirname(SCRIPT), link)
  const viaLink = execFileSync(process.execPath, [path.join(link, 'launch-vals.ts'), 'codex', dir, '--'], { env: { PATH: process.env.PATH!, CODEX_HOME: '/x' }, encoding: 'utf8' }).trim()
  assert.match(viaLink, LAUNCH_ID)
})

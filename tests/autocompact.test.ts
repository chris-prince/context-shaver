import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { autocompactAt, toml, withoutComments, type Asked } from '../src/autocompact.ts'

// Each case runs in a home of its own, with only the files it writes.
function home(files: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocompact-'))
  for (const [f, v] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), typeof v === 'string' ? v : JSON.stringify(v))
  }
  return dir
}
// The home is the proxy's own (os.homedir reads HOME); `launch` gives what
// the launcher passes on, the harness's environment and flags included.
function at(harness: string, files: Record<string, unknown> | string, r: Partial<Asked> & { values?: Record<string, string> } = {}) {
  const was = process.env.HOME
  process.env.HOME = typeof files === 'string' ? files : home(files)
  const { values, ...rest } = r
  try {
    return autocompactAt(harness, { model: '', headers: {}, upstream: '', ...(values && { launch: values }), ...rest })
  } finally {
    process.env.HOME = was
  }
}
const claude = (files: Record<string, unknown>, r: Partial<Asked> = {}) => at('claude', files, { model: 'claude-opus-5-5', ...r })

// The window shown in shaver info: guessed where it is the model's own, as no
// setting lowers it.
const g = (window: number) => ({ window, guessed: true })
const w = (window: number) => ({ window })

test('Claude Code: the window less 20K of output less 13K, on the model own window', () => {
  assert.deepEqual(claude({}), { at: 967_000, source: 'model', ...g(1_000_000) })
  assert.deepEqual(claude({}, { model: 'claude-haiku-4-5' }), { at: 167_000, source: 'model', ...g(200_000) })
  // 1M on an older model only once the session opts in.
  assert.deepEqual(claude({}, { model: 'claude-sonnet-4-6' }), { at: 167_000, source: 'model', ...g(200_000) })
  assert.deepEqual(claude({}, { model: 'claude-sonnet-4-6', headers: { 'anthropic-beta': 'x,context-1m-2025-08-07' } }), { at: 967_000, source: 'model-1m', ...g(1_000_000) })
  assert.deepEqual(claude({}, { model: 'claude-opus-4-5[1m]' }), { at: 967_000, source: 'model-1m', ...g(1_000_000) })
})

test('Claude Code: settings lower the window, per model or for all', () => {
  assert.deepEqual(claude({ '.claude/settings.json': { autoCompactWindow: 200_000 } }), { at: 167_000, source: 'settings', ...w(200_000) })
  // Only whole tokens from 100K to 1M; "auto" or any other value is none.
  assert.deepEqual(claude({ '.claude/settings.json': { autoCompactWindow: '400k' } }), { at: 967_000, source: 'model', ...g(1_000_000) })
  assert.deepEqual(claude({ '.claude/settings.json': { autoCompactWindow: 300 } }), { at: 967_000, source: 'model', ...g(1_000_000) })
  assert.deepEqual(claude({ '.claude/settings.json': { autoCompactWindow: 'auto' }, '.claude.json': { autoCompactWindowsCache: { 'claude-opus-5-5': 400_000 } } }), { at: 967_000, source: 'model', ...g(1_000_000) })
  const byModel = { '.claude/settings.json': { autoCompactWindow: 200_000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 500_000 } } } }
  assert.deepEqual(claude(byModel), { at: 467_000, source: 'settings', ...w(500_000) })
  assert.deepEqual(claude(byModel, { model: 'claude-fable-5-1' }), { at: 167_000, source: 'settings', ...w(200_000) })
  // Never above the model's own window, which is then still a guess.
  assert.deepEqual(claude({ '.claude/settings.json': { autoCompactWindow: 500_000 } }, { model: 'claude-haiku-4-5' }), { at: 167_000, source: 'settings', ...g(200_000) })
  // The project's settings, in the folder it was launched in, win.
  const h = home({ 'p/.claude/settings.json': { autoCompactWindow: 600_000 } })
  assert.deepEqual(claude({ '.claude/settings.json': { autoCompactWindow: 200_000 } }, { launch: { cwd: `${h}/p` } }), { at: 567_000, source: 'settings', ...w(600_000) })
})

test('Claude Code: the environment, then the window the server set, then none', () => {
  const set = { '.claude/settings.json': { autoCompactWindow: 200_000 } }
  assert.deepEqual(claude(set, { launch: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' } }), { at: 467_000, source: 'env', ...w(500_000) })
  assert.deepEqual(claude(set, { launch: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300k' } }), { at: 267_000, source: 'env', ...w(300_000) })
  assert.deepEqual(claude(set, { launch: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '50000' } }), { at: 67_000, source: 'env', ...w(100_000) })
  assert.deepEqual(claude({ '.claude/settings.json': { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' } } }), { at: 267_000, source: 'env', ...w(300_000) })
  assert.deepEqual(claude({ '.claude.json': { autoCompactWindowsCache: { 'claude-opus-5-5': 400_000 } } }), { at: 367_000, source: 'server', ...w(400_000) })
  assert.deepEqual(claude({}, { launch: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' } }), { at: 490_000, source: 'model+pct', ...g(1_000_000) })
  // Turned off, the window still shows.
  assert.deepEqual(claude(set, { launch: { DISABLE_AUTO_COMPACT: '1' } }), { at: null, source: 'env', ...w(200_000) })
  assert.deepEqual(claude({ '.claude.json': { autoCompactEnabled: false } }), { at: null, source: 'autoCompactEnabled', ...g(1_000_000) })
})

test('Codex: 90% of the window, or a lower configured limit', () => {
  const cache = { '.codex/models_cache.json': { models: [{ slug: 'gpt-6-luna', context_window: 272_000, max_context_window: 272_000, auto_compact_token_limit: null }] } }
  assert.deepEqual(at('codex', cache, { model: 'gpt-6-luna' }), { at: 244_800, source: 'models-cache', ...w(272_000) })
  assert.deepEqual(at('codex', { ...cache, '.codex/config.toml': 'model_auto_compact_token_limit = 100_000\n' }, { model: 'gpt-6-luna' }), { at: 100_000, source: 'config', ...w(272_000) })
  assert.deepEqual(at('codex', { ...cache, '.codex/config.toml': 'model_auto_compact_token_limit = 900000\n' }, { model: 'gpt-6-luna' }), { at: 244_800, source: 'models-cache', ...w(272_000) })
  assert.deepEqual(at('codex', { ...cache, '.codex/config.toml': 'model_context_window = 100000\n' }, { model: 'gpt-6-luna' }), { at: 90_000, source: 'config-window', ...w(100_000) })
  assert.equal(at('codex', cache, { model: 'other' }), undefined)
})

// opencode's model list as it saves it in its database (2.x): table kv, the
// list's JSON in body, and its digest in the :meta row too.
function saveCatalog(file: string, list: object, digest = 'd1', meta = true) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const put = db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
  put.run('models-dev:v2:catalog', JSON.stringify({ updatedAt: 1, digest, body: JSON.stringify(list) }))
  if (meta) put.run('models-dev:v2:catalog:meta', JSON.stringify({ updatedAt: 2, digest, etag: 'e' }))
  db.close()
}
const withCatalog = (list: object, files: Record<string, unknown> = {}) => {
  const h = home(files)
  saveCatalog(`${h}/.local/share/opencode/opencode.db`, list)
  return h
}

test('opencode: the window less a buffer, 15% and at least 16K by default', () => {
  const up = 'https://openrouter.ai/api/v1'
  const list = { openrouter: { models: { 'a/b': { limit: { context: 1_050_000, input: 922_000 } }, 'a/small': { limit: { context: 64_000 } } } } }
  const listed = withCatalog(list)
  assert.deepEqual(at('opencode', listed, { model: 'a/b', upstream: up }), { at: 783_700, source: 'models-cache', ...w(922_000) })
  assert.deepEqual(at('opencode', listed, { model: 'a/small', upstream: up }), { at: 48_000, source: 'models-cache', ...w(64_000) })
  const config = (c: object) => withCatalog(list, { '.config/opencode/opencode.jsonc': `// mine\n${JSON.stringify(c)}` })
  assert.deepEqual(at('opencode', config({ provider: { openrouter: { models: { 'a/b': { limit: { context: 100_000 } } } } } }), { model: 'a/b', upstream: up }), { at: 84_000, source: 'config', ...w(100_000) })
  assert.deepEqual(at('opencode', config({ compaction: { buffer: '10%' } }), { model: 'a/b', upstream: up }), { at: 829_800, source: 'models-cache+buffer', ...w(922_000) })
  assert.deepEqual(at('opencode', config({ compaction: { auto: false } }), { model: 'a/b', upstream: up }), { at: null, source: 'compaction.auto', ...w(922_000) })
  assert.equal(at('opencode', listed, { model: 'a/b', upstream: 'https://elsewhere.example' }), undefined)
})

test("opencode: its model list from its database, where it's kept since 2.x, not models.json", () => {
  const up = 'https://openrouter.ai/api/v1'
  const r = { model: 'a/b', upstream: up }
  const list = (context: number) => ({ openrouter: { models: { 'a/b': { limit: { context } } } } })
  // An old models.json alone isn't read.
  assert.equal(at('opencode', { '.cache/opencode/models.json': list(1_000_000) }, r), undefined)
  // The data folder moves with XDG_DATA_HOME; OPENCODE_DB names the file,
  // relative to that folder; ":memory:" keeps none.
  const h = home()
  saveCatalog(`${h}/data/opencode/oc.db`, list(200_000))
  assert.equal(at('opencode', h, { ...r, values: { XDG_DATA_HOME: `${h}/data` } }), undefined)
  assert.deepEqual(at('opencode', h, { ...r, values: { XDG_DATA_HOME: `${h}/data`, OPENCODE_DB: 'oc.db' } }), { at: 170_000, source: 'models-cache', ...w(200_000) })
  assert.deepEqual(at('opencode', h, { ...r, values: { OPENCODE_DB: `${h}/data/opencode/oc.db` } }), { at: 170_000, source: 'models-cache', ...w(200_000) })
  assert.equal(at('opencode', h, { ...r, values: { XDG_DATA_HOME: `${h}/data`, OPENCODE_DB: ':memory:' } }), undefined)
  // OPENCODE_MODELS_PATH's file is the list instead.
  fs.writeFileSync(`${h}/models.json`, JSON.stringify(list(100_000)))
  assert.deepEqual(at('opencode', h, { ...r, values: { XDG_DATA_HOME: `${h}/data`, OPENCODE_DB: 'oc.db', OPENCODE_MODELS_PATH: `${h}/models.json` } }), { at: 84_000, source: 'models-cache', ...w(100_000) })
})

test('opencode: its model list is read again once its digest moves', () => {
  const r = { model: 'a/b', upstream: 'https://openrouter.ai/api/v1' }
  const list = (context: number) => ({ openrouter: { models: { 'a/b': { limit: { context } } } } })
  const h = home()
  const db = `${h}/.local/share/opencode/opencode.db`
  saveCatalog(db, list(200_000), 'd1')
  assert.equal(at('opencode', h, r)?.window, 200_000)
  // The same digest, as on a refresh that found nothing new: kept as read.
  saveCatalog(db, list(300_000), 'd1')
  assert.equal(at('opencode', h, r)?.window, 200_000)
  saveCatalog(db, list(300_000), 'd2')
  assert.equal(at('opencode', h, r)?.window, 300_000)
})

test("opencode: a provider not known here, by the host its listed models are served from", () => {
  const up = 'https://api.example.com/v1'
  const list = {
    other: { models: { m: { api: { 'chat-completions': { base_url: 'https://other.example/v1' } }, limit: { context: 100_000 } } } },
    mine: { models: { m: { api: { 'chat-completions': { base_url: up }, messages: { base_url: 'https://api.example.com/anthropic/v1' } }, limit: { context: 200_000 } } } },
  }
  assert.deepEqual(at('opencode', withCatalog(list), { model: 'm', upstream: up }), { at: 170_000, source: 'models-cache', ...w(200_000) })
  assert.equal(at('opencode', withCatalog(list), { model: 'm', upstream: 'https://nowhere.example' }), undefined)
})

test('config formats: JSON with comments, and simple TOML', () => {
  assert.deepEqual(JSON.parse(withoutComments('{"a": "//x", /* c */ "b": [1,], // d\n}')), { a: '//x', b: [1] })
  assert.deepEqual(toml('a = 1 # n\n[t."x.y"]\nb = "s"\nc = true\n'), { a: 1, t: { 'x.y': { b: 's', c: true } } })
})

test("the harness's environment counts as its launcher passes it on, never the proxy's own", () => {
  const h = home({ 'elsewhere/claude/settings.json': { autoCompactWindow: 300_000 }, 'elsewhere/codex/config.toml': 'model_context_window = 100000\n' })
  const was = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME }
  process.env.CLAUDE_CONFIG_DIR = `${h}/elsewhere/claude`
  process.env.CODEX_HOME = `${h}/elsewhere/codex`
  try {
    // Set only in the proxy's environment, they don't count.
    assert.deepEqual(at('claude', h, { model: 'claude-opus-5-5' }), { at: 967_000, source: 'model', ...g(1_000_000) })
    assert.equal(at('codex', h, { model: 'gpt-6-luna' }), undefined)
  } finally {
    for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  // Passed on by the launcher, they do.
  assert.deepEqual(at('claude', h, { model: 'claude-opus-5-5', values: { CLAUDE_CONFIG_DIR: `${h}/elsewhere/claude` } }), { at: 267_000, source: 'settings', ...w(300_000) })
  assert.deepEqual(at('codex', h, { model: 'gpt-6-luna', values: { CODEX_HOME: `${h}/elsewhere/codex` } }), { at: 90_000, source: 'config-window', ...w(100_000) })
})

test("Codex: a profile's file layers over config.toml, and -c values win over both", () => {
  const files = { '.codex/models_cache.json': { models: [{ slug: 'gpt-6-luna', context_window: 272_000 }] }, '.codex/config.toml': 'model_context_window = 200000\n', '.codex/b.config.toml': 'model_context_window = 100000\n' }
  assert.deepEqual(at('codex', files, { model: 'gpt-6-luna' }), { at: 180_000, source: 'config-window', ...w(200_000) })
  assert.deepEqual(at('codex', files, { model: 'gpt-6-luna', values: { profile: 'b' } }), { at: 90_000, source: 'config-window', ...w(100_000) })
  assert.deepEqual(at('codex', files, { model: 'gpt-6-luna', values: { profile: 'none' } }), { at: 180_000, source: 'config-window', ...w(200_000) })
  assert.deepEqual(at('codex', files, { model: 'gpt-6-luna', values: { model_context_window: '150_000' } }), { at: 135_000, source: 'config-window', ...w(150_000) })
  assert.deepEqual(at('codex', files, { model: 'gpt-6-luna', values: { model_auto_compact_token_limit: '120000' } }), { at: 120_000, source: 'config', ...w(200_000) })
})

test("opencode: its config folder, project config turned off, and the user's own inline config, as passed on", () => {
  const up = 'https://openrouter.ai/api/v1'
  const listed = { openrouter: { models: { 'a/b': { limit: { context: 1_000_000 } } } } }
  const h = withCatalog(listed, { 'mine/opencode.json': { compaction: { buffer: 100_000 } }, 'p/.git/HEAD': '', 'p/opencode.json': { compaction: { buffer: 200_000 } } })
  const r = { model: 'a/b', upstream: up }
  const cwd = `${h}/p`
  assert.deepEqual(at('opencode', h, { ...r, values: { cwd } }), { at: 800_000, source: 'models-cache+buffer', ...w(1_000_000) })
  assert.deepEqual(at('opencode', h, { ...r, values: { cwd, OPENCODE_DISABLE_PROJECT_CONFIG: '1' } }), { at: 850_000, source: 'models-cache', ...w(1_000_000) })
  assert.deepEqual(at('opencode', h, { ...r, values: { cwd, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_CONFIG_DIR: `${h}/mine` } }), { at: 900_000, source: 'models-cache+buffer', ...w(1_000_000) })
  // The inline config counts last, over the project's.
  assert.deepEqual(at('opencode', h, { ...r, values: { cwd, OPENCODE_CONFIG_CONTENT: '{ // mine\n"compaction": {"buffer": 50000}}' } }), { at: 950_000, source: 'models-cache+buffer', ...w(1_000_000) })
})

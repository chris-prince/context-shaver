// Where the client compacts its conversation on its own, in prompt tokens, as
// its harness works it out from the model, the request's headers and the
// harness's own settings files, read here as the proxy runs on the same
// machine. Each rule is read from the harness's source (local/notes.md,
// "Where each harness compacts"): Claude Code 2.1.319, Codex 0.167.0 and
// opencode 2.2.5.
//
// `at` is null where the harness won't compact; no answer at all, where the
// harness or model isn't known well enough to say (models.ts's figure stands).
// `source` says which input decided the window, for the request log.
// `window` is the context window the harness works from, for shaver info;
// `guessed` where it is the model's as this file's own table has it, as no
// setting or file of the harness's says.
import fs from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import os from 'node:os'
import path from 'node:path'

export type Autocompact = { at: number | null; source: string; window?: number; guessed?: true }
export type Asked = { model: string; system?: unknown; messages?: unknown; headers: IncomingHttpHeaders; upstream: string }

// The variables bin/claude-via-shaver passes on from Claude Code's
// environment, URL-encoded, as Claude Code sends none of its own; dropped
// before the request goes upstream (server.ts, forwarded).
export const ENV_HEADER = 'x-shaver-env'

export function autocompactAt(harness: string | undefined, r: Asked): Autocompact | undefined {
  if (harness === 'claude') return claude(r)
  if (harness === 'codex') return codex(r)
  if (harness === 'opencode') return opencode(r)
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
const truthy = (v: unknown) => v !== undefined && !['', '0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase())
const home = () => os.homedir()

// Files as last read, read again only once changed.
const files = new Map<string, { mtimeMs: number; value: unknown }>()
function read(file: string | undefined, parse: (text: string) => unknown): unknown {
  if (!file) return
  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(file).mtimeMs
  } catch {
    return
  }
  const was = files.get(file)
  if (was?.mtimeMs === mtimeMs) return was.value
  let value: unknown
  try {
    value = parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  files.set(file, { mtimeMs, value })
  return value
}
const json = (file: string | undefined) => read(file, JSON.parse)
const jsonc = (file: string | undefined) => read(file, (t) => JSON.parse(withoutComments(t)))

// JSON with comments and trailing commas, as opencode's files are, made JSON.
export function withoutComments(t: string): string {
  let out = ''
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (c === '"') {
      const j = endOfString(t, i)
      out += t.slice(i, j)
      i = j - 1
    } else if (c === '/' && t[i + 1] === '/') while (i < t.length && t[i] !== '\n') i++
    else if (c === '/' && t[i + 1] === '*') {
      i = t.indexOf('*/', i + 2)
      if (i < 0) break
      i++
    } else out += c
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}
const endOfString = (t: string, i: number) => {
  let j = i + 1
  while (j < t.length && t[j] !== '"') j += t[j] === '\\' ? 2 : 1
  return j + 1
}

// The simple TOML Codex's config.toml holds: tables, and keys whose values
// are numbers, strings or booleans; arrays and inline tables are passed over.
export function toml(t: string): Obj {
  const root: Obj = {}
  let table = root
  const key = (k: string) => k.trim().replace(/^"(.*)"$|^'(.*)'$/, '$1$2')
  for (const raw of t.split('\n')) {
    const line = raw.replace(/\s#.*$|^#.*$/, '').trim()
    const head = /^\[([^[\]]+)\]$/.exec(line)
    if (head) {
      table = root
      for (const k of head[1].match(/"[^"]*"|'[^']*'|[^.]+/g) ?? []) table = (isObj(table[key(k)]) ? table[key(k)] : (table[key(k)] = {})) as Obj
      continue
    }
    const kv = /^("[^"]*"|'[^']*'|[\w-]+)\s*=\s*(.+)$/.exec(line)
    if (!kv) continue
    const v = kv[2].trim()
    const s = /^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/.exec(v)
    if (s) table[key(kv[1])] = s[1] ?? s[2]
    else if (v === 'true' || v === 'false') table[key(kv[1])] = v === 'true'
    else if (/^[+-]?[\d_]+(\.[\d_]+)?$/.test(v)) table[key(kv[1])] = Number(v.replace(/_/g, ''))
  }
  return root
}

// Every string in a value, so a working directory can be found in any block.
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (isObj(v)) for (const x of Object.values(v)) strings(x, out)
  return out
}
// The session's working directory, as its prompt names it: the system
// prompt, else the first messages, where Codex's environment context is.
function workdir(r: Asked, re: RegExp): string | undefined {
  const where = [r.system, Array.isArray(r.messages) ? r.messages.slice(0, 3) : undefined]
  for (const text of where.flatMap((w) => strings(w))) {
    const m = re.exec(text)
    if (m) return m[1].trim()
  }
}

// ---- Claude Code ----------------------------------------------------------
//
// It compacts once the prompt reaches the window less min(the model's max
// output, 20K) less 13K: 167K on a 200K window. Or, with
// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, that percentage of the window less the
// output if lower. The window is the model's context, lowered by the first of: CLAUDE_CODE_AUTO_COMPACT_WINDOW; the
// autoCompactWindow setting, per model under modelSettings or for all ("auto"
// is none); the window Anthropic's server sets the account, cached in
// ~/.claude.json. An experiment's window, which it gets from Anthropic's flag
// service, can't be seen from here. DISABLE_AUTO_COMPACT, DISABLE_COMPACT or
// autoCompactEnabled: false turns it off. Environment variables count from the
// launcher's header (ENV_HEADER) and from the settings files' `env`.
const CLAUDE_OUTPUT = 20_000 // min(max output, 20K): every Claude model's max output is above it
const CLAUDE_BUFFER = 13_000
const CLAUDE_WINDOW = 200_000
const CLAUDE_1M = 1_000_000
// The model's context, as Claude Code's built-in model table has it: 1M for
// the models with a native 1M window (and those after them); for the rest
// 200K, or 1M once the session opts in, by the [1m] suffix, or the context-1m
// beta header on the models that take it.
const NATIVE_1M = /claude-(opus-(4-[7-9]|[5-9])|sonnet-[5-9]|haiku-[5-9]|fable|mythos)/
const BETA_1M = /claude-(3-7-sonnet|sonnet-4-[0-6]|sonnet-4(?!-)|opus-4-6)/
function contextOf(model: string, beta: string, env: Obj): { context: number; source: string } {
  const m = model.toLowerCase()
  if (NATIVE_1M.test(m)) return { context: CLAUDE_1M, source: 'model' }
  const optIn = !truthy(env.CLAUDE_CODE_DISABLE_1M_CONTEXT) && (/\[1m\]$/.test(m) || (BETA_1M.test(m) && beta.includes('context-1m-')))
  return optIn ? { context: CLAUDE_1M, source: 'model-1m' } : { context: CLAUDE_WINDOW, source: 'model' }
}

function claude(r: Asked): Autocompact {
  const dir = process.env.CLAUDE_CONFIG_DIR
  const configDir = dir ?? path.join(home(), '.claude')
  const cwd = workdir(r, /Primary working directory: ([^\n]+)/)
  const managed = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json'
  // Lowest precedence first.
  const settings = [path.join(configDir, 'settings.json'), cwd && path.join(cwd, '.claude', 'settings.json'), cwd && path.join(cwd, '.claude', 'settings.local.json'), managed].map((f) => json(f || undefined)).filter(isObj)
  const env: Obj = { ...envOf(r.headers) }
  for (const s of settings) if (isObj(s.env)) Object.assign(env, s.env)
  const global = json(path.join(dir ?? home(), '.claude.json'))
  const off = truthy(env.DISABLE_AUTO_COMPACT) || truthy(env.DISABLE_COMPACT) ? 'env' : isObj(global) && global.autoCompactEnabled === false ? 'autoCompactEnabled' : undefined

  const key = settingsKey(r.model)
  const model = contextOf(r.model, String(r.headers['anthropic-beta'] ?? ''), env)
  const context = model.context
  let source = model.source
  let configured: number | undefined
  const fromEnv = env.CLAUDE_CODE_AUTO_COMPACT_WINDOW === undefined ? undefined : windowOf(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, true)
  if (typeof fromEnv === 'number') [configured, source] = [fromEnv, 'env']
  else {
    // As Claude Code merges them: a file's own window for all models drops
    // the per-model ones before it.
    let merged: { all?: unknown; byModel: Obj } = { byModel: {} }
    for (const s of settings) {
      const own: Obj = {}
      if (isObj(s.modelSettings))
        for (const [m, v] of Object.entries(s.modelSettings)) if (isObj(v) && v.autoCompactWindow !== undefined && (m === settingsKey(m) || !(settingsKey(m) in own))) own[settingsKey(m)] = v.autoCompactWindow
      merged = s.autoCompactWindow === undefined ? { all: merged.all, byModel: { ...merged.byModel, ...own } } : { all: s.autoCompactWindow, byModel: own }
    }
    const set = windowOf(Object.hasOwn(merged.byModel, key) ? merged.byModel[key] : merged.all, false)
    if (typeof set === 'number') [configured, source] = [set, 'settings']
    else if (set !== 'auto') {
      const cached = isObj(global) && isObj(global.autoCompactWindowsCache) ? global.autoCompactWindowsCache[key] : undefined
      const served = num(cached) ?? (isObj(cached) ? num(cached.default) : undefined)
      if (served) [configured, source] = [served, 'server']
    }
  }
  const whole = Math.min(context, configured ?? context)
  // A guess where the model's window stands, as no setting lowers it.
  const shown = { window: whole, ...((configured ?? Infinity) > context && { guessed: true as const }) }
  if (off) return { at: null, source: off, ...shown }
  const window = whole - CLAUDE_OUTPUT
  const pct = Number(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)
  const at = pct > 0 && pct <= 100 ? Math.min(Math.floor((window * pct) / 100), window - CLAUDE_BUFFER) : window - CLAUDE_BUFFER
  return { at, source: pct > 0 && pct <= 100 ? `${source}+pct` : source, ...shown }
}

// A model's name as settings key it: lowercase, without the [1m] suffix.
const settingsKey = (model: string) => model.trim().toLowerCase().replace(/\[1m\]$/, '')

// A window as Claude Code reads one. In settings, a whole number of tokens
// from 100K to 1M, or "auto" for none; anything else is dropped. In
// CLAUDE_CODE_AUTO_COMPACT_WINDOW, a size such as "200k" or 200000, taken
// into 100K-1M.
const CLAUDE_LEAST = 100_000
function windowOf(v: unknown, fromEnv: boolean): number | 'auto' | undefined {
  if (!fromEnv) return v === 'auto' ? 'auto' : Number.isInteger(v) && (v as number) >= CLAUDE_LEAST && (v as number) <= CLAUDE_1M ? (v as number) : undefined
  const t = String(v ?? '').trim().toLowerCase()
  const times = t.endsWith('m') ? 1e6 : t.endsWith('k') ? 1e3 : 1
  const n = Number(times === 1 ? t : t.slice(0, -1)) * times
  return num(n) && Math.min(Math.max(Math.round(n), CLAUDE_LEAST), CLAUDE_1M)
}

function envOf(headers: IncomingHttpHeaders): Obj {
  const v = headers[ENV_HEADER]
  return v ? Object.fromEntries(new URLSearchParams(String(v))) : {}
}

// ---- Codex ----------------------------------------------------------------
//
// It compacts once the context reaches its auto-compact limit: the model's
// auto_compact_token_limit, or model_auto_compact_token_limit in config.toml
// (the active profile's first), capped at 90% of the window. The window is
// the model's context_window (else max_context_window) from
// models_cache.json, or model_context_window in config.toml, capped at the
// max. With neither a window nor a limit, it never compacts. Values given as
// -c flags on its command line can't be seen from here.
function codex(r: Asked): Autocompact | undefined {
  const dir = process.env.CODEX_HOME ?? path.join(home(), '.codex')
  const config = read(path.join(dir, 'config.toml'), toml)
  const cfg = isObj(config) ? config : {}
  const profile = typeof cfg.profile === 'string' && isObj(cfg.profiles) && isObj(cfg.profiles[cfg.profile]) ? (cfg.profiles[cfg.profile] as Obj) : {}
  const setting = (k: string) => num(profile[k]) ?? num(cfg[k])
  const cache = json(path.join(dir, 'models_cache.json'))
  const models = Array.isArray(cache) ? cache : isObj(cache) && Array.isArray(cache.models) ? cache.models : []
  const m = models.find((x): x is Obj => isObj(x) && x.slug === r.model)
  const setWindow = setting('model_context_window')
  const setLimit = setting('model_auto_compact_token_limit')
  if (!m && !setWindow && !setLimit) return
  const max = num(m?.max_context_window)
  const window = setWindow ? (max ? Math.min(setWindow, max) : setWindow) : (num(m?.context_window) ?? max)
  const limit = setLimit ?? num(m?.auto_compact_token_limit)
  const cap = window && Math.floor((window * 9) / 10)
  const at = cap ? (limit ? Math.min(limit, cap) : cap) : (limit ?? null)
  return { at, source: setLimit && (!cap || setLimit < cap) ? 'config' : setWindow ? 'config-window' : 'models-cache', ...(window && { window }) }
}

// ---- opencode -------------------------------------------------------------
//
// It compacts once the prompt reaches the window less a buffer: the window is
// the smaller of the model's limit.input and limit.context (whichever is
// set), from opencode's config, else its cached model list (models.json);
// the buffer is compaction.buffer, in tokens or as "N%" of the window, else
// 15% of the window and at least 16K once the window is 32K or more.
// compaction.auto: false turns it off. Config documents count in turn, later
// ones winning: the global ones, OPENCODE_CONFIG, then the project's from its
// root down to the working directory. The model's provider is the one
// whose API the request goes to.
const OPENCODE_SHARE = 0.15
const OPENCODE_FLOOR = 16_000
const PROVIDERS: Record<string, string> = { 'openrouter.ai': 'openrouter', 'api.openai.com': 'openai', 'api.anthropic.com': 'anthropic' }

function opencode(r: Asked): Autocompact | undefined {
  const config = path.join(process.env.XDG_CONFIG_HOME ?? path.join(home(), '.config'), 'opencode')
  const cache = path.join(process.env.XDG_CACHE_HOME ?? path.join(home(), '.cache'), 'opencode', 'models.json')
  const cwd = workdir(r, /Working directory: ([^\n]+)/)
  const docs = [...['config.json', 'opencode.json', 'opencode.jsonc'].map((f) => path.join(config, f)), process.env.OPENCODE_CONFIG, ...projectFiles(cwd)].map((f) => jsonc(f)).filter(isObj)
  const listed = json(cache)
  const host = hostOf(r.upstream)
  const provider = (host && PROVIDERS[host]) ?? (isObj(listed) ? Object.keys(listed).find((p) => isObj(listed[p]) && hostOf(String((listed[p] as Obj).api ?? '')) === host) : undefined)
  if (!provider) return
  let limit: Obj | undefined
  for (const d of docs) {
    const ps = isObj(d.providers) ? d.providers : isObj(d.provider) ? d.provider : {}
    const p = ps[provider]
    const m = isObj(p) && isObj(p.models) ? p.models[r.model] : undefined
    if (isObj(m) && isObj(m.limit)) limit = { ...limit, ...m.limit }
  }
  let source = 'config'
  if (!limit) {
    const p = isObj(listed) ? listed[provider] : undefined
    const m = isObj(p) && isObj(p.models) ? p.models[r.model] : undefined
    if (isObj(m) && isObj(m.limit)) [limit, source] = [m.limit, 'models-cache']
  }
  const input = num(limit?.input)
  const context = num(limit?.context)
  const window = input && context ? Math.min(input, context) : (input ?? context)
  if (!window) return
  let auto: unknown
  let buffer: unknown
  for (const d of docs) {
    if (!isObj(d.compaction)) continue
    if (d.compaction.auto !== undefined) auto = d.compaction.auto
    const b = d.compaction.buffer ?? d.compaction.reserved
    if (b !== undefined) buffer = b
  }
  if (auto === false) return { at: null, source: 'compaction.auto', window }
  const n = typeof buffer === 'string' ? Math.round((window * Number.parseFloat(buffer)) / 100) : num(buffer)
  if (n !== undefined && n < window) return { at: window - n, source: `${source}+buffer`, window }
  return { at: window - Math.max(Math.floor(window * OPENCODE_SHARE), window >= 2 * OPENCODE_FLOOR ? OPENCODE_FLOOR : 0), source, window }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

// The project's config files from its root (the nearest directory up with
// .git, else the working directory) down to the working directory.
function projectFiles(cwd: string | undefined): string[] {
  if (!cwd) return []
  const dirs: string[] = []
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    dirs.unshift(d)
    if (fs.existsSync(path.join(d, '.git')) || path.dirname(d) === d) break
  }
  if (!fs.existsSync(path.join(dirs[0], '.git'))) dirs.splice(0, dirs.length - 1)
  return dirs.flatMap((d) => ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc'].map((f) => path.join(d, f)))
}

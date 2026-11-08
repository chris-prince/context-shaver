// What a harness was launched with that says where it compacts
// (autocompact.ts), as its launcher sees it: the environment variables that
// bear on it and, for Codex, the -p and -c values that do. The proxy can't
// read them from its own environment, as it is a long-running process another
// launcher may have started, and a wrapper the launcher stands in for may have
// set them for this harness alone.
//
// A launcher runs this as `node launch-vals.ts <harness> <data dir> -- <its
// arguments>`; it saves the values as JSON under <data dir>/launch-vals/,
// named by a hash of them, and prints that name, the ID, which the launcher
// puts in the harness's base URL as /launch-vals/<id> (via.ts). It prints
// nothing when there are none. The same values give the same file, so the
// folder holds one per set of values ever launched with, and needs no
// cleaning up. Only these values are saved, never the arguments or the rest
// of the environment, which may hold prompts or keys.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type LaunchVals = Record<string, string>
export const LAUNCH_DIR = 'launch-vals'
export const LAUNCH_ID = /^[0-9a-f]{16}$/

const VARS: Record<string, string[]> = {
  claude: ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'CLAUDE_CONFIG_DIR'],
  codex: ['CODEX_HOME'],
  opencode: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'OPENCODE_DB', 'OPENCODE_MODELS_PATH', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_CONFIG_PROJECT_DISABLE'],
}
// Paths the harness reads relative to where it was started. (OPENCODE_DB is
// relative to opencode's data folder instead.)
const RELATIVE = new Set(['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_MODELS_PATH'])
const CODEX_KEYS = ['model_context_window', 'model_auto_compact_token_limit']

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export function launchVals(harness: string, env: Record<string, string | undefined>, args: string[], cwd: string): LaunchVals {
  const vals: LaunchVals = {}
  for (const v of VARS[harness] ?? []) {
    const x = env[v]
    if (x) vals[v] = RELATIVE.has(v) ? path.resolve(cwd, x) : x
  }
  // Where the harness's project settings are, for those that read them.
  if (harness === 'claude' || harness === 'opencode') vals.cwd = cwd
  if (harness === 'codex') Object.assign(vals, codexFlags(args))
  if (harness === 'opencode') {
    const kept = opencodeKept(env.OPENCODE_CONFIG_CONTENT)
    if (kept) vals.OPENCODE_CONFIG_CONTENT = kept
  }
  return vals
}

// The profile, and the two limits as -c gives them, the last of each winning
// as in Codex, without the quotes TOML may have around them.
function codexFlags(args: string[]): LaunchVals {
  const vals: LaunchVals = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') break
    let v: string | undefined
    if (a === '-p' || a === '--profile') v = args[++i]
    else if (a.startsWith('--profile=')) v = a.slice('--profile='.length)
    if (v !== undefined) {
      if (v) vals.profile = v
      continue
    }
    if (a === '-c' || a === '--config') v = args[++i]
    else if (a.startsWith('--config=')) v = a.slice('--config='.length)
    const eq = v?.indexOf('=') ?? -1
    if (v === undefined || eq < 0) continue
    const k = v.slice(0, eq).trim()
    const m = /^"(.*)"$|^'(.*)'$/.exec(v.slice(eq + 1).trim())
    if (CODEX_KEYS.includes(k)) vals[k] = m ? (m[1] ?? m[2]) : v.slice(eq + 1).trim()
  }
  return vals
}

// Of the user's own OPENCODE_CONFIG_CONTENT, only its compaction settings and
// model limits, as the rest may hold keys; nothing from content that isn't JSON.
function opencodeKept(content: string | undefined): string | undefined {
  let mine: unknown
  try {
    mine = content && JSON.parse(content)
  } catch {
    return
  }
  if (!isObj(mine)) return
  const kept: Obj = {}
  if (isObj(mine.compaction)) kept.compaction = mine.compaction
  for (const key of ['provider', 'providers']) {
    const providers = mine[key]
    for (const [p, v] of Object.entries(isObj(providers) ? providers : {}))
      for (const [m, x] of Object.entries(isObj(v) && isObj(v.models) ? v.models : {}))
        if (isObj(x) && isObj(x.limit)) {
          const byKey = (kept[key] ??= {}) as Obj
          const models = ((byKey[p] ??= { models: {} }) as { models: Obj }).models
          models[m] = { limit: x.limit }
        }
  }
  return Object.keys(kept).length ? JSON.stringify(kept) : undefined
}

// Saves the values, if any, and gives their ID.
export function save(dir: string, vals: LaunchVals): string | undefined {
  const sorted = Object.fromEntries(Object.entries(vals).sort(([a], [b]) => (a < b ? -1 : 1)))
  if (!Object.keys(sorted).length) return
  const text = JSON.stringify(sorted, null, 2) + '\n'
  const id = createHash('sha256').update(text).digest('hex').slice(0, 16)
  const file = path.join(dir, LAUNCH_DIR, `${id}.json`)
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, file)
  }
  return id
}

// The values saved under an ID; none, with a warning the first time, where
// there is no such file, so the harness's defaults apply. A file never changes
// once written, so each is read once.
const loaded = new Map<string, LaunchVals>()
const warned = new Set<string>()
export function load(dir: string, id: string): LaunchVals | undefined {
  if (!LAUNCH_ID.test(id)) return
  if (loaded.has(id)) return loaded.get(id)
  const file = path.join(dir, LAUNCH_DIR, `${id}.json`)
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (isObj(v)) {
      const vals = Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'))
      loaded.set(id, vals)
      return vals
    }
  } catch {}
  if (!warned.has(id)) console.error(`shaver: no launch values in ${file}, so the harness's defaults are taken`)
  warned.add(id)
}

// Run as a script, though perhaps by a path through a symlink, which Node's
// module path has resolved.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [harness, dir, sep, ...args] = process.argv.slice(2)
  if (!harness || !dir || sep !== '--') {
    console.error('usage: launch-vals.ts <harness> <data dir> -- <arguments>')
    process.exit(2)
  }
  const id = save(dir, launchVals(harness, process.env, args, process.cwd()))
  if (id) console.log(id)
}

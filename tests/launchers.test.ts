// The launchers in bin/, each run from a checkout of its own in a temporary
// folder, with a fake harness that prints how it was run, so nothing here runs
// a real harness, starts a proxy or installs anything.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const PORT = '18999'

const roots: string[] = []
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }) })

// A checkout holding the given bin/ scripts, src/launch-vals.ts (which the
// launchers run, and which imports nothing of ours) and a run-proxy that
// exits with `proxy`: 0 as if the proxy started, 1 as if it could not.
function checkout(scripts: string[], proxy = 0) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launchers-')))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'co/bin'), { recursive: true })
  fs.mkdirSync(path.join(root, 'co/src'))
  for (const s of scripts) fs.copyFileSync(path.join(REPO, 'bin', s), path.join(root, 'co/bin', s))
  fs.copyFileSync(path.join(REPO, 'src/launch-vals.ts'), path.join(root, 'co/src/launch-vals.ts'))
  fs.writeFileSync(path.join(root, 'co/bin/run-proxy'), `#!/bin/sh\nexit ${proxy}\n`, { mode: 0o755 })
  return root
}
function script(file: string, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 })
  return file
}
// A Codex that prints how it was run: its path, then each argument.
const fakeCodex = (file: string) => script(file, `printf '%s\\n' "$0" "$@"`)

function run(root: string, cmd: string, args: string[], env: Record<string, string> = {}, cwd = REPO) {
  const r = spawnSync(path.join(root, 'co/bin', cmd), args, {
    cwd, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH!, HOME: root, SHAVER_PORT: PORT, ...env },
  })
  return { status: r.status, out: r.stdout.trimEnd().split('\n'), err: r.stderr }
}

// codex-via-shaver: where Codex is sent.

const VIA = `http://127.0.0.1:${PORT}/harness/codex`
function codexRun(args: string[], env: Record<string, string> = {}) {
  const root = checkout(['codex-via-shaver', 'node-wrapper'])
  const codex = fakeCodex(path.join(root, 'codex/codex'))
  return run(root, 'codex-via-shaver', args, { SHAVER_REAL_CODEX_LOCATIONS: codex, ...env })
}

test('codex-via-shaver: with no provider given, Codex is given the proxy as its OpenAI base URL, before its own arguments', () => {
  const { status, out } = codexRun(['exec', 'hi'])
  assert.equal(status, 0)
  assert.deepEqual(out.slice(1), ['-c', `openai_base_url="${VIA}/via/https%3A%2F%2Fchatgpt.com%2Fbackend-api%2Fcodex"`, 'exec', 'hi'])
})

test('codex-via-shaver: a compaction setting on the command line gives the base URL a launch-vals ID', () => {
  const { out } = codexRun(['-c', 'model_context_window=100000'])
  assert.match(out[2], new RegExp(`^openai_base_url="${VIA}/launch-vals/[0-9a-f]{16}/via/https%3A%2F%2Fchatgpt\\.com`))
})

test('codex-via-shaver: a provider given is chained to: its base_url goes through the proxy, and only its WebSockets are turned off, right after it', () => {
  const { status, out } = codexRun(['-c', 'model_provider=gw', '-c', 'model_providers.gw.base_url="https://gw.example/v1/"', 'exec', 'hi'])
  assert.equal(status, 0)
  assert.deepEqual(out.slice(1), [
    '-c', 'model_provider=gw',
    '-c', `model_providers.gw.base_url="${VIA}/via/https%3A%2F%2Fgw.example%2Fv1"`,
    '-c', 'model_providers.gw.supports_websockets=false',
    'exec', 'hi',
  ])
})

test('codex-via-shaver: --config and --config= forms, quoted or not, are read and kept in their form', () => {
  const { out } = codexRun(['--config', "model_provider='gw'", "--config=model_providers.gw.base_url='https://gw/v1'"])
  assert.deepEqual(out.slice(1), [
    '--config', "model_provider='gw'",
    `--config=model_providers.gw.base_url="${VIA}/via/https%3A%2F%2Fgw%2Fv1"`,
    '-c', 'model_providers.gw.supports_websockets=false',
  ])
})

test('codex-via-shaver: the last value of a key wins, as in Codex, and nothing after -- is read', () => {
  const { out } = codexRun([
    '-c', 'model_provider=a', '-c', 'model_provider=b',
    '-c', 'model_providers.a.base_url=https://a',
    '-c', 'model_providers.b.base_url=https://b1', '-c', 'model_providers.b.base_url=https://b2',
    '--', '-c', 'model_provider=c',
  ])
  assert.deepEqual(out.slice(1), [
    '-c', 'model_provider=a', '-c', 'model_provider=b',
    '-c', 'model_providers.a.base_url=https://a',
    '-c', 'model_providers.b.base_url=https://b1',
    '-c', `model_providers.b.base_url="${VIA}/via/https%3A%2F%2Fb2"`,
    '-c', 'model_providers.b.supports_websockets=false',
    '--', '-c', 'model_provider=c',
  ])
})

test('codex-via-shaver: a base URL already at the proxy keeps its gateway, and is not chained through the proxy again', () => {
  for (const [given, want] of [
    [`http://127.0.0.1:${PORT}/harness/codex/launch-vals/0123456789abcdef/via/https%3A%2F%2Fgw`, `${VIA}/via/https%3A%2F%2Fgw`],
    [`http://localhost:${PORT}/harness/codex/`, VIA],
  ]) {
    const { out } = codexRun(['-c', 'model_provider=gw', '-c', `model_providers.gw.base_url=${given}`])
    assert.equal(out[4], `model_providers.gw.base_url="${want}"`)
  }
})

test('codex-via-shaver: a provider given with no base_url to chain to stops the launch', () => {
  const { status, err } = codexRun(['-c', 'model_provider=gw'])
  assert.equal(status, 1)
  assert.match(err, /model_provider is gw, but no model_providers\.gw\.base_url is given/)
})

// codex-via-shaver: which Codex SHAVER_REAL_CODEX_LOCATIONS finds. The proxy
// "does not start", so Codex runs as found, with nothing added.

function found(locations: (root: string) => string, setup: (root: string) => void) {
  const root = checkout(['codex-via-shaver'], 1)
  setup(root)
  const r = run(root, 'codex-via-shaver', ['x'], { SHAVER_REAL_CODEX_LOCATIONS: locations(root) })
  return { ...r, root, ran: r.out[0] }
}

test('SHAVER_REAL_CODEX_LOCATIONS: of a glob, the newest version runs, by version and not by spelling', () => {
  const { ran, root, out } = found((r) => `${r}/v/*/codex`, (r) => {
    for (const v of ['0.9.0', '0.10.0', '0.2.0']) fakeCodex(`${r}/v/${v}/codex`)
  })
  assert.equal(ran, `${root}/v/0.10.0/codex`)
  assert.deepEqual(out.slice(1), ['x'])
})

test('SHAVER_REAL_CODEX_LOCATIONS: the first entry with a match wins, and ~ is home', () => {
  const { ran, root } = found((r) => `${r}/none/*/codex:~/a/codex:${r}/b/codex`, (r) => {
    fakeCodex(`${r}/a/codex`)
    fakeCodex(`${r}/b/codex`)
  })
  assert.equal(ran, `${root}/a/codex`)
})

test('SHAVER_REAL_CODEX_LOCATIONS: a match that is not executable, or is this script, is passed over', () => {
  const { ran, root } = found((r) => `${r}/v/*/codex`, (r) => {
    fakeCodex(`${r}/v/0.1.0/codex`)
    fakeCodex(`${r}/v/0.2.0/codex`)
    fs.chmodSync(`${r}/v/0.2.0/codex`, 0o644)
    fs.mkdirSync(`${r}/v/0.3.0`)
    fs.symlinkSync(`${r}/co/bin/codex-via-shaver`, `${r}/v/0.3.0/codex`)
  })
  assert.equal(ran, `${root}/v/0.1.0/codex`)
})

test('SHAVER_REAL_CODEX_LOCATIONS: with no match, the launch stops and says so', () => {
  const { status, err } = found((r) => `${r}/none/codex`, () => {})
  assert.equal(status, 1)
  assert.match(err, /has no executable Codex/)
})

// claude-via-shaver: ENABLE_TOOL_SEARCH is set to true only where unset; a
// value already set is kept, with nothing said.

test('claude-via-shaver: ENABLE_TOOL_SEARCH is true where unset or empty, and a value already set is kept, with nothing said', () => {
  const root = checkout(['claude-via-shaver', 'node-wrapper'])
  const claude = script(path.join(root, 'claude/claude'), 'printf "%s\\n" "$ENABLE_TOOL_SEARCH"')
  const ran = (env: Record<string, string>) => run(root, 'claude-via-shaver', [], { SHAVER_REAL_CLAUDE_LOCATIONS: claude, ...env })
  for (const [given, sent] of [[undefined, 'true'], ['', 'true'], ['true', 'true'], ['1', '1'], ['auto:10', 'auto:10'], ['auto', 'auto'], ['false', 'false']] as const) {
    const { status, out, err } = ran(given === undefined ? {} : { ENABLE_TOOL_SEARCH: given })
    assert.equal(status, 0)
    assert.deepEqual(out, [sent], `given ${given}`)
    assert.equal(err, '', `given ${given}`)
  }
})

// claude-via-shaver: CLAUDE_CODE_MAX_CONTEXT_TOKENS is left as the user has
// it, so a model the release doesn't recognize gets Claude Code's own 200K.

test('claude-via-shaver: CLAUDE_CODE_MAX_CONTEXT_TOKENS is left unset where unset, and a value set is kept', () => {
  const root = checkout(['claude-via-shaver', 'node-wrapper'])
  const claude = script(path.join(root, 'claude/claude'), 'printf "<%s>\\n" "${CLAUDE_CODE_MAX_CONTEXT_TOKENS-unset}"')
  for (const [given, want] of [[undefined, '<unset>'], ['', '<>'], ['400000', '<400000>']] as const) {
    const { status, out } = run(root, 'claude-via-shaver', [], { SHAVER_REAL_CLAUDE_LOCATIONS: claude, ...(given === undefined ? {} : { CLAUDE_CODE_MAX_CONTEXT_TOKENS: given }) })
    assert.equal(status, 0)
    assert.deepEqual(out, [want], `given ${given}`)
  }
})

// SHAVER_PRELAUNCH: run first, once, by its name for the launch; when it moves
// the checkout, the launcher runs again from it, without running it again.

test('claude-via-shaver: a prelaunch that moves the checkout is run once, then the launcher runs again from the new checkout', () => {
  const root = checkout(['claude-via-shaver', 'node-wrapper'])
  const git = (...args: string[]) => spawnSync('git', ['-C', path.join(root, 'co'), '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'pinned before')
  const ran = path.join(root, 'prelaunched')
  const prelaunch = script(path.join(root, 'prelaunch'), `echo "$*" >>'${ran}'\ngit -C '${root}/co' -c user.name=t -c user.email=t@t commit -q --allow-empty -m pinned`)
  const claude = script(path.join(root, 'claude/claude'), 'echo "ran, SHAVER_PRELAUNCHED=${SHAVER_PRELAUNCHED-unset}"')
  const { status, out } = run(root, 'claude-via-shaver', [], { SHAVER_REAL_CLAUDE_LOCATIONS: claude, SHAVER_PRELAUNCH: prelaunch })
  assert.equal(status, 0)
  assert.deepEqual(out, ['ran, SHAVER_PRELAUNCHED=unset'])
  assert.deepEqual(fs.readFileSync(ran, 'utf8').trimEnd().split('\n'), ['--prelaunch claude'])
})

test('codex-via-shaver: a prelaunch that moves the checkout is run once, then the launcher runs again from the new checkout', () => {
  const root = checkout(['codex-via-shaver', 'node-wrapper'])
  const git = (...args: string[]) => spawnSync('git', ['-C', path.join(root, 'co'), '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'pinned before')
  const ran = path.join(root, 'prelaunched')
  const prelaunch = script(path.join(root, 'prelaunch'), `echo "$*" >>'${ran}'\ngit -C '${root}/co' -c user.name=t -c user.email=t@t commit -q --allow-empty -m pinned`)
  const codex = script(path.join(root, 'codex/codex'), 'echo "ran, SHAVER_PRELAUNCHED=${SHAVER_PRELAUNCHED-unset}"')
  const { status, out } = run(root, 'codex-via-shaver', [], { SHAVER_REAL_CODEX_LOCATIONS: codex, SHAVER_PRELAUNCH: prelaunch })
  assert.equal(status, 0)
  assert.deepEqual(out, ['ran, SHAVER_PRELAUNCHED=unset'])
  assert.deepEqual(fs.readFileSync(ran, 'utf8').trimEnd().split('\n'), ['--prelaunch codex'])
})

// The loop guard: with no LOCATIONS, the harness is `codex` (or `claude`) as
// the login shell runs it. Here $SHELL stands in for that shell, running a
// wrapper that runs the launcher again, as a child or by exec.

for (const [launcher, harness] of [['codex-via-shaver', 'codex'], ['claude-via-shaver', 'claude']]) {
  for (const how of ['as a child', 'by exec']) {
    test(`${launcher}: a ${harness} that runs it again ${how} is stopped, not looped`, () => {
      const root = checkout([launcher], 1)
      const again = path.join(root, 'co/bin', launcher)
      const shell = script(path.join(root, 'shell'), how === 'by exec'
        ? `exec '${again}' "\${@:4}"`
        : `'${again}' "\${@:4}"; exit $?`)
      const { status, err } = run(root, launcher, [], { SHELL: shell })
      assert.equal(status, 1)
      assert.match(err, new RegExp(`run again by the ${harness} it ran`))
    })
  }
}

// The lock (pin_install). macOS has no flock(1), so a Python one stands in for
// it, first on the PATH; it takes flock(2) on the descriptor given, as
// flock(1) does. These test the script's use of the lock, not flock(1).

const python = spawnSync('python3', ['-c', 'import fcntl'], { stdio: 'ignore' }).status === 0
const FLOCK = `#!/usr/bin/env python3
import fcntl, sys
a = sys.argv[1:]
mode = fcntl.LOCK_SH if '-s' in a else fcntl.LOCK_EX
if '-n' in a: mode |= fcntl.LOCK_NB
try: fcntl.flock(int(a[-1]), mode)
except OSError:
    # A test's deploy tool finishes its switch to a new release just as the
    # lock is refused, so only a second look finds that release.
    import os
    t = os.environ.get('SWITCH_WHEN_REFUSED')
    if t: os.symlink(t, t + '.new'); os.replace(t + '.new', os.environ['SWITCH_LINK'])
    sys.exit(1)
`
// Exits 0 when an exclusive lock on the file can be taken now, as a deploy
// tool removing its release would take one.
const free = (file: string) =>
  spawnSync('python3', ['-c', 'import fcntl,sys; fcntl.flock(open(sys.argv[1]), fcntl.LOCK_EX | fcntl.LOCK_NB)', file]).status === 0
// Holds an exclusive lock on the file until killed, as a deploy tool removing
// its release would; resolves once it holds it.
function hold(file: string) {
  const p = spawn('python3', ['-c', 'import fcntl,sys,time; f=open(sys.argv[1]); fcntl.flock(f, fcntl.LOCK_EX); print("held", flush=True); time.sleep(60)', file])
  return new Promise<typeof p>((resolve) => p.stdout.once('data', () => resolve(p)))
}

function release(root: string, name: string) {
  const dir = path.join(root, 'releases', name)
  // Says where it ran from, and whether the release's lock was held then.
  script(path.join(dir, 'codex'), `echo "$0"; python3 -c 'import fcntl,sys; fcntl.flock(open(sys.argv[1]), fcntl.LOCK_EX | fcntl.LOCK_NB)' "$(dirname "$0")/.lk" 2>/dev/null && echo free || echo held`)
  fs.writeFileSync(path.join(dir, '.lk'), '')
}
function pinned(root: string) {
  fs.mkdirSync(path.join(root, 'flock-bin'))
  fs.writeFileSync(path.join(root, 'flock-bin/flock'), FLOCK, { mode: 0o755 })
  return (env: Record<string, string> = {}) => run(root, 'codex-via-shaver', [], {
    PATH: `${root}/flock-bin:${process.env.PATH}`,
    SHAVER_REAL_CODEX_LOCATIONS: `${root}/current/codex`, SHAVER_REAL_CODEX_LOCK: '.lk', ...env,
  })
}

test('SHAVER_REAL_CODEX_LOCK (with a stand-in for flock(1)): Codex runs from its release, locked while it runs, and the lock goes soon after', { skip: !python && 'no python3' }, async () => {
  const root = checkout(['codex-via-shaver'], 1)
  release(root, 'r1')
  fs.symlinkSync('releases/r1', path.join(root, 'current'))
  const { status, out } = pinned(root)()
  assert.equal(status, 0)
  assert.deepEqual(out, [`${root}/releases/r1/codex`, 'held'])
  // The process holding it looks every 5 seconds for Codex to have ended.
  const lk = path.join(root, 'releases/r1/.lk')
  const until = Date.now() + 8000
  while (!free(lk) && Date.now() < until) await new Promise((r) => setTimeout(r, 200))
  assert.ok(free(lk), 'the lock was still held 8 seconds after Codex ended')
})

test('SHAVER_REAL_CODEX_LOCK (with a stand-in for flock(1)): a release being removed is passed over for the one that replaces it, or else Codex runs as found', { skip: !python && 'no python3' }, async () => {
  const root = checkout(['codex-via-shaver'], 1)
  release(root, 'r1')
  release(root, 'r2')
  fs.symlinkSync('releases/r1', path.join(root, 'current'))
  const launch = pinned(root)
  const deploy = await hold(path.join(root, 'releases/r1/.lk'))
  try {
    // Never replaced: after its few tries, Codex runs as found.
    assert.equal(launch().out[0], `${root}/current/codex`)
    // Replaced while the launch first tries r1: a second look finds r2 and
    // locks it.
    const out = launch({ SWITCH_WHEN_REFUSED: `${root}/releases/r2`, SWITCH_LINK: `${root}/current` }).out
    assert.deepEqual(out, [`${root}/releases/r2/codex`, 'held'])
  } finally {
    deploy.kill()
  }
})

test('SHAVER_REAL_CODEX_LOCK: a release with no such file runs Codex as found', () => {
  const root = checkout(['codex-via-shaver'], 1)
  fakeCodex(path.join(root, 'releases/r1/codex'))
  fs.symlinkSync('releases/r1', path.join(root, 'current'))
  const { out } = run(root, 'codex-via-shaver', [], { SHAVER_REAL_CODEX_LOCATIONS: `${root}/current/codex`, SHAVER_REAL_CODEX_LOCK: '.lk' })
  assert.equal(out[0], `${root}/current/codex`)
})

// opencode-via-shaver: its providers merged over the user's own config. $SHELL
// stands in for the login shell running `opencode`, and prints the config it
// was given and its arguments.

function opencode(args: string[], env: Record<string, string> = {}, proxy = 0) {
  const root = checkout(['opencode-via-shaver', 'node-wrapper'], proxy)
  const shell = script(path.join(root, 'shell'), `printf '%s\\n' "\${OPENCODE_CONFIG_CONTENT-unset}"; printf '%s\\n' "\${@:4}"`)
  const r = run(root, 'opencode-via-shaver', args, { SHELL: shell, ...env })
  // The launch-vals ID in the base URLs depends on the folders the run saw,
  // so it is taken out; codex-via-shaver's tests check that one is added.
  const config = r.out[0] === 'unset' ? undefined : JSON.parse(r.out[0].replace(/\/launch-vals\/[0-9a-f]{16}/g, ''))
  return { ...r, config, args: r.out.slice(1).filter(Boolean) }
}
const OC = `http://127.0.0.1:${PORT}/harness/opencode`
const ours = {
  openrouter: { options: { baseURL: `${OC}/via/${encodeURIComponent('https://openrouter.ai/api/v1')}` } },
  openai: { options: { baseURL: `${OC}/via/${encodeURIComponent('https://api.openai.com/v1')}` } },
  anthropic: { options: { baseURL: `${OC}/via/${encodeURIComponent('https://api.anthropic.com/v1')}` } },
}

test('opencode-via-shaver: the user\'s OPENCODE_CONFIG_CONTENT is kept, with our base URLs merged in over it', () => {
  const mine = { theme: 'x', provider: { openai: { options: { apiKey: 'k', baseURL: 'https://elsewhere' }, models: { m: {} } }, other: { a: 1 } } }
  const { status, config } = opencode([], { OPENCODE_CONFIG_CONTENT: JSON.stringify(mine) })
  assert.equal(status, 0)
  assert.deepEqual(config, {
    theme: 'x',
    provider: {
      ...ours,
      openai: { options: { apiKey: 'k', baseURL: ours.openai.options.baseURL }, models: { m: {} } },
      other: { a: 1 },
    },
  })
})

test('opencode-via-shaver: an OPENCODE_CONFIG_CONTENT that is not a JSON object is left out, with a warning when it is not JSON', () => {
  const bad = opencode([], { OPENCODE_CONFIG_CONTENT: '{nope' })
  assert.deepEqual(bad.config, { provider: ours })
  assert.match(bad.err, /OPENCODE_CONFIG_CONTENT is not JSON/)
  assert.deepEqual(opencode([], { OPENCODE_CONFIG_CONTENT: '[1]' }).config, { provider: ours })
})

test('opencode-via-shaver: the TUI, run and mini get --standalone; other subcommands are passed as they are', () => {
  assert.deepEqual(opencode([]).args, ['--standalone'])
  assert.deepEqual(opencode(['run', 'hi']).args, ['run', '--standalone', 'hi'])
  assert.deepEqual(opencode(['-m', 'x']).args, ['--standalone', '-m', 'x'])
  assert.deepEqual(opencode([REPO]).args, ['--standalone', REPO])
  assert.deepEqual(opencode(['serve']).args, ['serve'])
})

test('opencode-via-shaver: when the proxy does not start, a config pointing at it is left out', () => {
  const { config, err } = opencode([], { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: ours }) }, 1)
  assert.equal(config, undefined)
  assert.match(err, /points at the proxy, so it is left out/)
})

// node-wrapper and a version manager's shims: a `node` and `npm` that fail in
// a folder whose .node-version names a version not installed, and run the
// real node elsewhere. The npm never runs the real one, and logs each call, so
// a test can check no install was tried.

function shims(root: string, broken = false) {
  const real = process.execPath
  const bad = broken ? 'true' : '[ -f .node-version ]'
  script(path.join(root, 'shims/node'), `if ${bad}; then echo "shim: version not installed" >&2; exit 1; fi\nexec '${real}' "$@"`)
  script(path.join(root, 'shims/npm'), `echo "$*" >>'${root}/npm-calls'\nif ${bad}; then echo "shim: version not installed" >&2; exit 1; fi\nexit 1`)
  return `${root}/shims:${process.env.PATH}`
}
const npmCalls = (root: string) => fs.existsSync(`${root}/npm-calls`) ? fs.readFileSync(`${root}/npm-calls`, 'utf8').trim().split('\n') : []

test('node-wrapper: a node shim that fails in the caller\'s folder is run from the checkout\'s, and the Node found runs in the caller\'s', () => {
  const root = checkout(['node-wrapper'])
  const caller = path.join(root, 'project')
  fs.mkdirSync(caller)
  fs.writeFileSync(path.join(caller, '.node-version'), '99.0.0\n')
  const env = { PATH: shims(root) }
  for (const cwd of [caller, root]) {
    const { status, out } = run(root, 'node-wrapper', ['-p', 'process.cwd()'], env, cwd)
    assert.equal(status, 0)
    assert.deepEqual(out, [cwd])
  }
  assert.deepEqual(npmCalls(root), [])
})

test('node-wrapper: an npm that does not run is reported as that, before any install is announced or tried', () => {
  const root = checkout(['node-wrapper'])
  const { status, err } = run(root, 'node-wrapper', ['-p', '1'], { PATH: shims(root, true) })
  assert.equal(status, 1)
  assert.match(err, /shim: version not installed\nnode-wrapper: Node 24 or newer is needed, and npm does not run here to install it/)
  assert.doesNotMatch(err, /installing it/)
  assert.deepEqual(npmCalls(root), ['--version'])
})

test('node-wrapper: with no npm at all, it says so', () => {
  const root = checkout(['node-wrapper'])
  // A PATH of only what the script runs, so no npm, wherever one is installed.
  const tools = path.join(root, 'tools')
  fs.mkdirSync(tools)
  for (const t of ['bash', 'dirname', 'readlink']) {
    const p = spawnSync('bash', ['-c', `type -P ${t}`], { encoding: 'utf8' }).stdout.trim()
    fs.symlinkSync(p, path.join(tools, t))
  }
  const { status, err } = run(root, 'node-wrapper', ['-p', '1'], { PATH: tools })
  assert.equal(status, 1)
  assert.match(err, /Node 24 or newer is needed, and there is no npm to install it with/)
})

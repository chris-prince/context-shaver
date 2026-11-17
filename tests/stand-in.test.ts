import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SCRIPT = path.resolve(import.meta.dirname, '../bin/codex-via-shaver')

// A checkout of its own whose proxy never starts, so a launch runs Codex as
// found, and a Codex that says how it was run. Each is removed after the tests.
const roots: string[] = []
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }) })
function checkout() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stand-in-')))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'co/bin'), { recursive: true })
  fs.copyFileSync(SCRIPT, path.join(root, 'co/bin/codex-via-shaver'))
  fs.writeFileSync(path.join(root, 'co/bin/run-proxy'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  return root
}
function install(dir: string, names = ['codex-code-mode-host']) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\necho "ran=$0 args=$*"\n', { mode: 0o755 })
  for (const n of names) fs.writeFileSync(path.join(dir, n), '#!/bin/sh\n', { mode: 0o755 })
}
const run = (root: string, args: string[], env: Record<string, string>) =>
  execFileSync(path.join(root, 'co/bin/codex-via-shaver'), args, {
    env: { PATH: process.env.PATH!, HOME: root, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
const runStub = (root: string, stub: string, args: string[] = []) =>
  execFileSync(stub, args, { env: { PATH: process.env.PATH!, HOME: root }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const standIn = (root: string, locations: string, env: Record<string, string> = {}) =>
  run(root, ['--stand-in'], { SHAVER_REAL_CODEX_LOCATIONS: locations, ...env })
const links = (dir: string) =>
  Object.fromEntries(fs.readdirSync(dir).filter(n => fs.lstatSync(path.join(dir, n)).isSymbolicLink()).map(n => [n, fs.readlinkSync(path.join(dir, n))]))

test('a stand-in links all beside Codex by the path matched, and its script runs the Codex found', () => {
  const root = checkout()
  install(path.join(root, 'svc/deploy-1'))
  fs.symlinkSync('deploy-1', path.join(root, 'svc/current'))
  const stub = standIn(root, `${root}/svc/current/codex`)
  assert.equal(path.dirname(path.dirname(stub)), path.join(root, 'co/proxy-data/stand-in'))
  assert.equal(path.basename(stub), 'codex')
  assert.deepEqual(links(path.dirname(stub)), { 'codex-code-mode-host': `${root}/svc/current/codex-code-mode-host` })
  assert.equal(runStub(root, stub, ['a1']), `ran=${root}/svc/current/codex args=a1`)
  // Made again for the same install, it is the same, its links untouched.
  const before = fs.lstatSync(path.join(path.dirname(stub), 'codex-code-mode-host')).ino
  assert.equal(standIn(root, `${root}/svc/current/codex`), stub)
  assert.equal(fs.lstatSync(path.join(path.dirname(stub), 'codex-code-mode-host')).ino, before)
})

test('a Codex that is itself a link is followed on the file, not on the directories above it', () => {
  const root = checkout()
  install(path.join(root, 'npm/lib/node_modules/codex/bin'))
  fs.mkdirSync(path.join(root, 'npm/bin'))
  fs.symlinkSync('../lib/node_modules/codex/bin/codex', path.join(root, 'npm/bin/codex'))
  fs.writeFileSync(path.join(root, 'npm/bin/other-tool'), '')
  const dir = path.dirname(standIn(root, `${root}/npm/bin/codex`))
  assert.deepEqual(Object.keys(links(dir)), ['codex-code-mode-host'])
  assert.equal(fs.realpathSync(path.join(dir, 'codex-code-mode-host')), path.join(root, 'npm/lib/node_modules/codex/bin/codex-code-mode-host'))
})

test('run for a newer install, its links follow it: a directory is replaced, not moved into, a name it lacks is removed, and none is left half made', () => {
  const root = checkout()
  install(path.join(root, 'cache/0.1.0'), ['codex-code-mode-host', 'gone'])
  fs.mkdirSync(path.join(root, 'cache/0.1.0/vendor'))
  const stub = standIn(root, `${root}/cache/*/codex`)
  const dir = path.dirname(stub)
  install(path.join(root, 'cache/0.2.0'), ['codex-code-mode-host', 'new'])
  fs.mkdirSync(path.join(root, 'cache/0.2.0/vendor'))
  assert.equal(runStub(root, stub), `ran=${root}/cache/0.2.0/codex args=`)
  assert.deepEqual(links(dir), {
    'codex-code-mode-host': `${root}/cache/0.2.0/codex-code-mode-host`,
    new: `${root}/cache/0.2.0/new`,
    vendor: `${root}/cache/0.2.0/vendor`,
  })
  assert.deepEqual(fs.readdirSync(path.join(root, 'cache/0.1.0/vendor')), [])
  assert.deepEqual(fs.readdirSync(path.join(dir, '.stand-in-tmp')), [])
})

test('while launches relink a stand-in for two installs at once, no file a wrapper looks for ever goes missing', async () => {
  const root = checkout()
  install(path.join(root, 'a'), ['codex-code-mode-host', 'only-a'])
  install(path.join(root, 'b'), ['codex-code-mode-host', 'only-b'])
  const dir = path.dirname(standIn(root, `${root}/a/codex`))
  const relink = (from: string) =>
    `for i in $(seq 60); do SHAVER_STAND_IN='${dir}' SHAVER_REAL_CODEX_LOCATIONS='${root}/${from}/codex' '${root}/co/bin/codex-via-shaver' >/dev/null 2>&1; done`
  const sh = (s: string) => new Promise<string>(resolve => {
    let out = ''
    const p = spawn('bash', ['-c', s], { env: { PATH: process.env.PATH!, HOME: root } })
    p.stdout.on('data', d => (out += d))
    p.on('close', () => resolve(out.trim()))
  })
  const done = path.join(root, 'done')
  const checks = sh(`n=0 miss=0; until [[ -e '${done}' ]]; do n=$((n+1)); [[ -x '${dir}/codex-code-mode-host' ]] || miss=$((miss+1)); done; echo "$n $miss"`)
  await Promise.all([sh(relink('a')), sh(relink('b'))])
  fs.writeFileSync(done, '')
  const [n, miss] = (await checks).split(' ').map(Number)
  assert.ok(n > 0)
  assert.equal(miss, 0, `${miss} of ${n} checks found no codex-code-mode-host`)
  assert.deepEqual(fs.readdirSync(dir).filter(f => /\.\d+$/.test(f)), [])
})

test('a stand-in keeps SHAVER_REAL_CODEX_LOCK only when it is set, to leave the caller its own otherwise', () => {
  const root = checkout()
  install(path.join(root, 'r'))
  const locations = `${root}/r/codex`
  for (const lock of [undefined, '']) {
    const stub = standIn(root, locations, lock === undefined ? {} : { SHAVER_REAL_CODEX_LOCK: lock })
    assert.doesNotMatch(fs.readFileSync(stub, 'utf8'), /SHAVER_REAL_CODEX_LOCK/)
  }
  const stub = standIn(root, locations, { SHAVER_REAL_CODEX_LOCK: '.deploy-lock' })
  assert.match(fs.readFileSync(stub, 'utf8'), /SHAVER_REAL_CODEX_LOCK=\.deploy-lock /)
})

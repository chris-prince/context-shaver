import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupOf, shellGroup } from '../src/tool-groups.ts'
import { kinds, toolGroups } from '../src/log.ts'

test('named tools fall in their groups across harnesses', () => {
  assert.equal(groupOf('Read', {}), 'file_read')
  assert.equal(groupOf('read', {}), 'file_read')
  assert.equal(groupOf('Edit', {}), 'file_edit')
  assert.equal(groupOf('apply_patch', 'x'), 'file_edit')
  assert.equal(groupOf('Grep', {}), 'file_search')
  assert.equal(groupOf('WebFetch', {}), 'web')
  assert.equal(groupOf('spawn_agent', {}), 'agent')
  assert.equal(groupOf('Agent', {}), 'agent')
  assert.equal(groupOf('ToolSearch', {}), 'other')
})

test('a shell command is a read or search only if every part is', () => {
  assert.equal(shellGroup('sed -n 1,50p src/a.ts'), 'file_read')
  assert.equal(shellGroup('cd /x && sed -n 1,50p a.ts | grep foo'), 'file_read')
  assert.equal(shellGroup('rg -n "a|b" src | head -20'), 'file_search')
  assert.equal(shellGroup('ls -la; wc -l src/*.ts'), 'file_search')
  assert.equal(shellGroup('cat a.ts && grep x b.ts'), 'file_read')
  assert.equal(shellGroup('grep -c x a 2>/dev/null'), 'file_search')
  assert.equal(shellGroup('rg "=>" src'), 'file_search')
  assert.equal(shellGroup('sed -n 1p a && node --test'), 'command')
  assert.equal(shellGroup('git log --oneline -3'), 'command')
  assert.equal(shellGroup('cat $(ls)'), 'command')
  assert.equal(shellGroup("python3 - <<'EOF'\nprint(1)\nEOF"), 'command')
  assert.equal(shellGroup('echo hi > out.txt'), 'file_edit')
  assert.equal(shellGroup("sed -i '' s/a/b/ f"), 'file_edit')
  assert.equal(shellGroup('npm test 2>&1 | tail -5'), 'command')
})

test("Codex's code-mode scripts take their calls' group", () => {
  assert.equal(groupOf('exec', 'const r=await tools.exec_command({cmd:"sed -n \'1,20p\' a.ts",workdir:"/x"}); text(r.output);'), 'file_read')
  assert.equal(groupOf('exec', 'await tools.exec_command({cmd:"rg x"}); await tools.exec_command({cmd:"node --test"})'), 'command')
  assert.equal(groupOf('exec', 'await tools.apply_patch({input:"*** Begin Patch"})'), 'file_edit')
  assert.equal(groupOf('exec_command', { cmd: 'ls' }), 'file_search')
  assert.equal(groupOf('shell', { command: ['bash', '-lc', 'cat a'] }), 'file_read')
  assert.equal(groupOf('shell', { command: ['git', 'status'] }), 'command')
})

test("kinds splits tool calls and results by their call's group when given them", () => {
  const call = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sed -n 1,9p a.ts' } }] }
  const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'line' }] }
  const orphan = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: 'x' }] }
  const groups = toolGroups([call, result])
  assert.deepEqual(Object.keys(kinds(JSON.stringify(call), call, false, groups).kinds), ['toolCalls:file_read', 'assistant'])
  assert.deepEqual(Object.keys(kinds(JSON.stringify(result), result, false, groups).kinds), ['toolResults:file_read', 'user'])
  assert.deepEqual(Object.keys(kinds(JSON.stringify(orphan), orphan, false, groups).kinds), ['toolResults', 'user'])
  assert.deepEqual(Object.keys(kinds(JSON.stringify(result), result).kinds), ['toolResults', 'user'])
})

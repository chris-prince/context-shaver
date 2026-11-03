import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NOTES, notesOf, notesOfBlock } from '../src/notes.ts'

// Each kind's opening, from the logs (shortened), or for the unseen ones from
// another machine's sessions or the harness's source.
const SAMPLES: Record<string, string> = {
  'environment-update': '# Environment update\n - Primary working directory: /p/local (was /p)',
  'date-change': "The date has changed. Today's date is now 2026-10-30. No need to mention it.",
  'unheard-reminder': "The user hasn't heard from you in a while — say in a few words what you're doing, then continue.",
  'token-counter': '<total_tokens>812345 tokens left</total_tokens>',
  'task-tools-reminder': "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate.",
  'session-name': 'The user named this session "finances". This may indicate what they are working on.',
  skills: 'The following skills are available for use with the Skill tool:\n\n- dataviz: Create charts',
  'skills-invoked': 'The following skills were invoked EARLIER in this session (before the conversation was compacted), not on the current turn.',
  'agent-types': 'Available agent types for the Agent tool:\n- claude: Catch-all',
  'deferred-tools': 'The following deferred tools are now available via ToolSearch.\nAgent\nMonitor',
  'tools-added': 'The following tools just became available and are ready to use:\nmcp__docs__batch',
  'tools-removed': 'The following tools are no longer available. Do not call them:\nmcp__docs__batch',
  'tools-updated': 'The following tools have updated definitions, which replace the earlier ones:\nBash',
  'mcp-instructions': '# MCP Server Instructions\n\nThe following MCP servers have provided instructions',
  'permission-mode': 'While bypass permissions mode is active:\n\nYou can do much of your work through the Bash tool',
  'agents-md': 'Codebase and user instructions are shown below. Be sure to adhere to these instructions.',
  memory: "Contents of /Users/u/.claude/projects/p/memory/MEMORY.md (user's auto-memory, persists across conversations):",
  'instructions-reread': 'Instruction files were re-read when this session started; these differ from their earlier copies',
  'session-reread': 'The session context was re-read when this session started; these values replace the earlier ones:',
  guidance: "As you answer the user's questions, you can use the following context:\n# userEmail",
  'git-attribution': 'Attribution for git commits and pull requests you create in this session:',
  environment: '# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /p',
  model: 'You are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5.',
  date: "Today's date is 2026-10-29.",
  'attached-file': 'Called the Read tool with the following input: {"file_path":"/p/a.ts"}',
  'file-changed': 'Note: /p/a.ts changed on disk since you last read it. That\'s usually deliberate.',
  'file-pointer': 'Note: /p/a.ts was read before the last conversation was summarized, but the contents are too large to include.',
  'task-notification': '[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<task-id>b1</task-id>',
  'side-question': 'This is a side question from the user. You must answer this question directly in a single response.',
  'collaboration-mode': '<collaboration_mode># Collaboration Mode: Default',
  permissions: '<permissions instructions>\nFilesystem sandboxing defines which files can be read or written.',
  'environment-context': '<environment_context>\n  <cwd>/p</cwd>\n</environment_context>',
  'multi-agent': '<multi_agent_role>You are `/root`, the primary agent.',
  plugins: '<recommended_plugins>\n- github',
  'approved-command': 'Approved command prefix saved:\n- ["git", "commit"]',
  'turn-aborted': '<turn_aborted>\nThe user interrupted the previous turn on purpose.',
}
// Kinds with more than one heading, and the sample of each other one.
const MORE = [
  '<skills_instructions>\n## Skills',
  '# AGENTS.md instructions for /p\n\n<INSTRUCTIONS>',
  '<multi_agent_mode>on</multi_agent_mode>',
  '<available_skills>\n<skill><id>a</id></skill>',
  'New skills are available:\n<skill><id>a</id></skill>',
  'The following skills have changed:\n<skill><id>a</id></skill>',
  'From here on, do not add attribution lines to commits.',
]

test('every heading has a sample that reads as its kind, alone and inside a reminder', () => {
  for (const [head, kind, category] of NOTES) {
    const sample = [SAMPLES[kind], ...MORE].find((s) => s && new RegExp('^' + head).test(s))
    assert.ok(sample, `no sample for ${head}`)
    for (const text of [sample, `<system-reminder>\n${sample}\n</system-reminder>`]) {
      const notes = notesOf(text)
      assert.equal(notes.length, 1, head)
      assert.equal(notes[0].kind, kind, head)
      assert.equal(notes[0].category, category, head)
    }
  }
})

test("a block is cut at each heading after a blank line, giving its text back, and a file's lines are no heading", () => {
  const file = `${SAMPLES['file-changed']}\n     1\t# Environment update\n     2\n\n     3\tThe date has changed`
  const text = `<system-reminder>\n${SAMPLES['unheard-reminder']}\n\n${file}\n\n${SAMPLES.date}\n</system-reminder>`
  const notes = notesOf(text)
  assert.deepEqual(notes.map((n) => n.kind), ['unheard-reminder', 'file-changed', 'date'])
  assert.equal(notes.map((n) => n.text).join(''), text.replace(/^<system-reminder>\s*/, ''))
  // A heading mid-line or straight after one line break starts nothing.
  assert.deepEqual(notesOf(`${SAMPLES.date} The date has changed.\nThe date has changed.`).map((n) => n.kind), ['date'])
})

test('text before the first heading is an unrecognized note, and blank text no note', () => {
  const notes = notesOf(`Something new from the harness.\n\n${SAMPLES.date}`)
  assert.deepEqual(notes.map((n) => [n.kind, n.category]), [['unrecognized', 'unrecognized'], ['date', 'latest']])
  assert.deepEqual(notesOf('<system-reminder>\n\n'), [])
})

test('an environment update is keyed by the fields it sets, and the date by one key', () => {
  const [update] = notesOf('# Environment update\n - Primary working directory: /p (was /q)\n - The scratchpad directory announced earlier is no longer available')
  assert.deepEqual(update.keys, ['primary working directory', 'scratchpad directory'])
  assert.deepEqual(notesOf(SAMPLES['date-change'])[0].keys, notesOf(SAMPLES.date)[0].keys)
})

test('blocks that are not text are one note each', () => {
  assert.deepEqual(notesOfBlock({ type: 'tool_addition', tool: { name: 'Docs' } }).map((n) => [n.kind, n.category]), [['tools-added', 'forever']])
  assert.deepEqual(notesOfBlock({ type: 'tool_removal', tool: { name: 'Docs' } }).map((n) => [n.kind, n.category]), [['tools-removed', 'forever']])
  assert.deepEqual(notesOfBlock({ type: 'item', item: { type: 'compaction' } }).map((n) => [n.kind, n.category]), [['compaction', 'conversation']])
  assert.deepEqual(notesOfBlock({ type: 'image' }).map((n) => n.category), ['unrecognized'])
})

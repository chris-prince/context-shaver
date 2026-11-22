// The group a tool call falls in, by what its output is rather than which
// tool made it: a file read through Read or through `sed -n` is file_read
// either way. Logged with each message's kinds (log.ts), as
// `toolCalls:<group>` and `toolResults:<group>`.
export type ToolGroup = 'file_read' | 'file_edit' | 'file_search' | 'command' | 'web' | 'agent' | 'other'

// Tool names, lowercased, across Claude Code, Codex and OpenCode. A shell
// tool's group comes from its command (shellGroup).
const NAMED: Record<string, ToolGroup> = {
  read: 'file_read',
  edit: 'file_edit', multiedit: 'file_edit', write: 'file_edit', notebookedit: 'file_edit', patch: 'file_edit', apply_patch: 'file_edit',
  grep: 'file_search', glob: 'file_search', list: 'file_search',
  webfetch: 'web', websearch: 'web', web_search: 'web',
  agent: 'agent', task: 'agent', sendmessage: 'agent', spawn_agent: 'agent', wait_agent: 'agent', send_message: 'agent',
  list_agents: 'agent', followup_task: 'agent', close_agent: 'agent', resume_agent: 'agent',
  write_stdin: 'command',
}
const SHELL = new Set(['bash', 'shell', 'monitor', 'exec_command', 'local_shell', 'container.exec'])

export function groupOf(name: string, input: unknown): ToolGroup {
  const n = name.toLowerCase()
  if (n === 'exec' && typeof input === 'string') return codeGroup(input)
  if (SHELL.has(n)) return shellGroup(commandOf(input))
  return NAMED[n] ?? 'other'
}

// A shell call's command: a string, or Codex's argv list, whose script is
// the last item of `bash -lc <script>`.
function commandOf(input: unknown): string {
  const i = (input ?? {}) as { command?: unknown; cmd?: unknown }
  const c = i.command ?? i.cmd
  if (!Array.isArray(c)) return typeof c === 'string' ? c : ''
  const argv = c.map(String)
  return /^(ba|z)?sh$/.test(argv[0] ?? '') && /^-\w*c$/.test(argv[1] ?? '') ? argv.slice(2).join(' ') : argv.join(' ')
}

// Codex's code mode sends a script that calls its tools (tools.exec_command
// and the like). The script's group is its calls' when they share one, else
// command.
function codeGroup(script: string): ToolGroup {
  const groups = new Set<ToolGroup>()
  for (const [, tool, args] of script.matchAll(/tools\.(\w+)\(\{([^]*?)\}\)/g)) {
    if (tool !== 'exec_command') { groups.add(NAMED[tool] ?? 'other'); continue }
    const cmd = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/.exec(args)
    let text = ''
    try { text = cmd ? JSON.parse(cmd[1]) : '' } catch { /* not a plain string literal */ }
    groups.add(shellGroup(text))
  }
  return groups.size === 1 ? [...groups][0] : 'command'
}

const READS = new Set(['cat', 'sed', 'head', 'tail', 'nl', 'less', 'bat'])
const SEARCHES = new Set(['grep', 'egrep', 'fgrep', 'rg', 'find', 'fd', 'ls', 'wc', 'tree'])
// Commands that only shape what others print.
const FILTERS = new Set(['sort', 'uniq', 'cut', 'tr', 'column', 'echo', 'printf', 'true'])

// Commands whose output, sent into a file, is the file's new text.
const WRITERS = new Set(['cat', 'echo', 'printf'])

// A shell command's group. Every part (split at &&, ||, ; and |) has to be a
// read, a search, a filter or a write for it to be anything but command. A
// write (cat, echo or printf into a file, sed -i, tee) makes it file_edit;
// else the first command of each pipeline decides, a read winning over a
// search. Any other command sending its output to a file is command, as is
// one fed a heredoc other than cat's or one with $( ) or backticks. Heredoc
// bodies and quoted text are set aside first, so a | or > in them counts for
// nothing.
export function shellGroup(text: string): ToolGroup {
  const command = text
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[^]*?\n\2(?=\n|$)/g, (m) => m.slice(0, m.indexOf('\n')))
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
  if (!command.trim() || /\$\(|`/.test(command)) return 'command'
  let read = false, search = false, edit = false
  for (const pipeline of command.split(/&&|\|\||;|\n/)) {
    const stages = pipeline.split('|').map((s) => s.trim().replace(/^(\w+=\S*(\s+|$))+/, '')).filter(Boolean)
    if (stages.length === 1 && /^cd\b/.test(stages[0])) continue
    for (const [i, s] of stages.entries()) {
      const word = s.split(/\s+/)[0].replace(/^.*\//, '')
      const into = /(^|[^\d&>])>>?\s*(?!&|\/dev\/null)[^\s|;&>]/.test(s)
      if ((word === 'sed' && /\s-i\b/.test(s)) || word === 'tee' || (into && WRITERS.has(word))) edit = true
      else if (into || s.includes('<<')) return 'command'
      else if (i === 0 && READS.has(word)) read = true
      else if (i === 0 && SEARCHES.has(word)) search = true
      else if (!READS.has(word) && !SEARCHES.has(word) && !FILTERS.has(word)) return 'command'
    }
  }
  return edit ? 'file_edit' : read ? 'file_read' : search ? 'file_search' : 'command'
}

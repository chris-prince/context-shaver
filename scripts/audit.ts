// Runs checks over the logged conversations and reports which need action.
// Each audit looks for a sign that an assumption in the proxy has stopped
// holding; a finding is a line for a person to look at. To add one, write a
// function from the conversations to findings and add it to AUDITS, with what
// to do about its findings: the report prints that under any audit that has
// some, so a reader needs nothing but the report and this file.
//
// Usage: bin/node-wrapper scripts/audit.ts [--since <date>] [--all]
// --since skips messages first logged before the date, so findings already
// looked at stop coming back. --all prints every finding, not the first 20.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { blocks, isPrompt, isSkillBody, READ, type ApiMsg } from '../src/items.ts'

const { values } = parseArgs({ options: { since: { type: 'string' }, all: { type: 'boolean' } } })
const since = values.since ? Date.parse(values.since) : 0
const logs = path.join(import.meta.dirname, '..', 'proxy-data', 'logs')

// A logged conversation: its harness, from the key's prefix, and each message
// once, with when it was first sent.
type Conversation = { key: string; harness: string; messages: Array<{ msg: ApiMsg; time: string }> }

function load(): Conversation[] {
  const out: Conversation[] = []
  for (const key of readdirSync(logs)) {
    const dir = path.join(logs, key)
    if (!existsSync(path.join(dir, 'step_events.jsonl'))) continue
    const seen = new Set<string>()
    const messages: Conversation['messages'] = []
    for (const line of readFileSync(path.join(dir, 'step_events.jsonl'), 'utf8').split('\n')) {
      if (!line) continue
      const e = JSON.parse(line)
      if (e.event !== 'request' || Date.parse(e.time) < since) continue
      for (const { hash } of e.parts ?? []) {
        if (seen.has(hash)) continue
        seen.add(hash)
        const file = path.join(dir, 'parts', hash + '.json')
        if (existsSync(file)) messages.push({ msg: JSON.parse(readFileSync(file, 'utf8')), time: e.time })
      }
    }
    const harness = ['claude', 'codex', 'opencode'].find((h) => key.startsWith(h + '-')) ?? 'unknown'
    out.push({ key, harness, messages })
  }
  return out
}

const texts = (m: ApiMsg) => blocks(m).flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
const where = (c: Conversation, time: string, text: string) =>
  `${c.key.slice(0, 48)} ${time.slice(0, 19)}  ${JSON.stringify(text.trimStart().split('\n')[0].slice(0, 80))}`

// The text the proxy recognizes by its start, shared by every harness, and the
// harnesses each piece belongs to. The shared list is safe while each piece
// only shows up in its own harnesses' traffic (src/items.ts, NOT_A_PROMPT).
const MARKERS: Array<[RegExp, string[]]> = [
  [/^\s*<command-name>/, ['claude']],
  [/^\s*<local-command-/, ['claude']],
  [/^\s*\[Request interrupted/, ['claude']],
  [/^\s*<system-reminder>/, ['claude']],
  [/^\s*\[SUGGESTION MODE:/, ['claude']],
  [/^Base directory for this skill:/, ['claude']],
  [new RegExp(READ.source, 'm'), ['claude']],
  [/^\s*<environment_context>/, ['codex']],
]

// A shared marker in another harness's conversation: that harness's own text
// is being skipped as not a prompt, or read as a Claude Code Read result. Also
// user text the proxy skips that no marker here accounts for, which means a
// marker was added to src/ without being added above.
function markersOutOfPlace(cs: Conversation[]): string[] {
  const found: string[] = []
  for (const c of cs)
    for (const { msg, time } of c.messages) {
      if (msg.role !== 'user') continue
      for (const text of texts(msg)) {
        const owners = MARKERS.find(([re]) => re.test(text))?.[1]
        if (owners && !owners.includes(c.harness)) found.push(`${owners.join('/')} marker in ${c.harness}: ${where(c, time, text)}`)
      }
      if (!isPrompt(msg) && !blocks(msg).some((b) => b.type === 'tool_result' || isSkillBody(b)) && texts(msg).some((t) => !MARKERS.some(([re]) => re.test(t))))
        found.push(`skipped with no marker listed here: ${where(c, time, texts(msg)[0] ?? '')}`)
    }
  return found
}

// Tags that open real prompts, which the model replies to as a turn: Claude
// Code's ! commands.
const PROMPT_TAGS = [/^\s*<bash-input>/]

// Prompts whose every counted block opens with a tag, as the text harnesses
// add usually does: each is either a prompt that quotes markup or harness text
// that wants a marker, as Codex's <environment_context> did before it had one.
// Prompts opening with a tag in PROMPT_TAGS are left out.
function taggedPrompts(cs: Conversation[]): string[] {
  const found: string[] = []
  for (const c of cs)
    for (const { msg, time } of c.messages) {
      if (!isPrompt(msg) || blocks(msg).some((b) => b.type === 'image' || b.type === 'document')) continue
      const counted = texts(msg).filter((t) => !MARKERS.some(([re]) => re.test(t)))
      if (counted.some((t) => PROMPT_TAGS.some((re) => re.test(t)))) continue
      if (counted.length && counted.every((t) => /^\s*(<[a-z_-]+[ >]|\[[A-Z][A-Z ]+[:\]])/.test(t))) found.push(where(c, time, counted[0]))
    }
  return found
}

const AUDITS: Array<{ name: string; run: (cs: Conversation[]) => string[]; todo: string }> = [
  {
    name: 'Shared markers stay in their own harness',
    run: markersOutOfPlace,
    todo: `For "<owner> marker in <harness>", look at the message in that conversation's logs.
- Text that harness adds, meaning the same as for the owner (not a prompt, or a
  Read result): add the harness to the marker's owners in MARKERS.
- A prompt the person typed, or harness text meaning something else: one shared
  list no longer fits. Give each harness its own markers (src/harness.ts) and
  have isPrompt and READ use the conversation's.
For "skipped with no marker listed here": find the marker in NOT_A_PROMPT
(src/items.ts) that matched it and add it to MARKERS with its harnesses.`,
  },
  {
    name: 'Prompts that open with a tag',
    run: taggedPrompts,
    todo: `Look at each message in that conversation's logs, and at the request after it.
- Text the harness adds, not typed by a person and not replied to as a turn:
  add its tag to NOT_A_PROMPT (src/items.ts) and to MARKERS here.
- A real prompt, which the model replies to as a turn: add its tag to
  PROMPT_TAGS here. If it's a prompt that merely quotes markup, nothing to
  change; rerun with --since a date after it.`,
  },
]

const cs = load()
console.log(`${cs.length} conversations, ${cs.reduce((n, c) => n + c.messages.length, 0)} messages${since ? ` since ${values.since}` : ''}\n`)
let failed = 0
for (const a of AUDITS) {
  const found = a.run(cs)
  console.log(`${found.length ? 'ACTION' : 'ok    '}  ${a.name}${found.length ? ` (${found.length})` : ''}`)
  for (const f of values.all ? found : found.slice(0, 20)) console.log(`        ${f}`)
  if (!values.all && found.length > 20) console.log(`        … ${found.length - 20} more; --all lists them`)
  if (found.length) console.log(`\n        What to do:\n${a.todo.replace(/^/gm, '        ')}\n`)
  if (found.length) failed++
}
process.exit(failed ? 1 : 0)

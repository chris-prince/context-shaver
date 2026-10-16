// Runs checks over the logged conversations and reports which need action.
// Each audit looks for a sign that an assumption in the proxy has stopped
// holding; a finding is a line for a person to look at. To add one, write a
// function from the conversations to findings and add it to AUDITS.
//
// Usage: node scripts/audit.ts [--since <date>] [--all]
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
// harness each piece belongs to. The shared list is safe while each piece only
// shows up in its own harness's traffic (src/items.ts, NOT_A_PROMPT).
const MARKERS: Array<[RegExp, string]> = [
  [/^\s*<command-name>/, 'claude'],
  [/^\s*<local-command-/, 'claude'],
  [/^\s*\[Request interrupted/, 'claude'],
  [/^\s*<system-reminder>/, 'claude'],
  [/^\s*\[SUGGESTION MODE:/, 'claude'],
  [/^Base directory for this skill:/, 'claude'],
  [new RegExp(READ.source, 'm'), 'claude'],
  [/^\s*<environment_context>/, 'codex'],
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
        const owner = MARKERS.find(([re]) => re.test(text))?.[1]
        if (owner && owner !== c.harness) found.push(`${owner} marker in ${c.harness}: ${where(c, time, text)}`)
      }
      if (!isPrompt(msg) && !blocks(msg).some((b) => b.type === 'tool_result' || isSkillBody(b)) && texts(msg).some((t) => !MARKERS.some(([re]) => re.test(t))))
        found.push(`skipped with no marker listed here: ${where(c, time, texts(msg)[0] ?? '')}`)
    }
  return found
}

// Prompts whose every counted block opens with a tag, as the text harnesses
// add usually does: each is either a prompt that quotes markup or harness text
// that wants a marker, as Codex's <environment_context> did before it had one.
function taggedPrompts(cs: Conversation[]): string[] {
  const found: string[] = []
  for (const c of cs)
    for (const { msg, time } of c.messages) {
      if (!isPrompt(msg) || blocks(msg).some((b) => b.type === 'image' || b.type === 'document')) continue
      const counted = texts(msg).filter((t) => !MARKERS.some(([re]) => re.test(t)))
      if (counted.length && counted.every((t) => /^\s*(<[a-z_-]+[ >]|\[[A-Z][A-Z ]+[:\]])/.test(t))) found.push(where(c, time, counted[0]))
    }
  return found
}

const AUDITS: Array<{ name: string; run: (cs: Conversation[]) => string[] }> = [
  { name: 'Shared markers stay in their own harness', run: markersOutOfPlace },
  { name: 'Prompts that open with a tag', run: taggedPrompts },
]

const cs = load()
console.log(`${cs.length} conversations, ${cs.reduce((n, c) => n + c.messages.length, 0)} messages${since ? ` since ${values.since}` : ''}\n`)
let failed = 0
for (const a of AUDITS) {
  const found = a.run(cs)
  console.log(`${found.length ? 'ACTION' : 'ok    '}  ${a.name}${found.length ? ` (${found.length})` : ''}`)
  for (const f of values.all ? found : found.slice(0, 20)) console.log(`        ${f}`)
  if (!values.all && found.length > 20) console.log(`        … ${found.length - 20} more; --all lists them`)
  if (found.length) failed++
}
process.exit(failed ? 1 : 0)

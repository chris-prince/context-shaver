// Runs checks over the logged conversations and reports which need action.
// Each audit looks for a sign that an assumption in the proxy has stopped
// holding; a finding is a line for a person to look at. To add one, write a
// function from the conversations to findings and add it to AUDITS, with what
// to do about its findings: the report prints that under any audit that has
// some, so a reader needs nothing but the report and this file. Findings
// already dealt with go in the audit's resolved list, with why; findings in a
// resolved window are counted but don't fail the run.
//
// Usage: bin/node-wrapper scripts/audit.ts [--since <date>] [--all]
// --since skips messages first logged before the date, so findings already
// looked at stop coming back. --all prints every finding, not the first 20.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { blocks, isPrompt, isSkillBody, READ, type ApiMsg } from '../src/items.ts'
import { messagesOf, objectsOf } from '../src/log.ts'

const { values } = parseArgs({ options: { since: { type: 'string' }, all: { type: 'boolean' } } })
const since = values.since ? Date.parse(values.since) : 0
const logs = path.join(import.meta.dirname, '..', 'proxy-data', 'logs')

// A logged conversation: its harness, from the key's prefix, each message
// once, with when it was first sent, and each request as the proxy sent it.
type Request = { time: string; protocol: string; breakpoints: number; last?: ApiMsg; count: number }
type Conversation = { key: string; harness: string; messages: Array<{ msg: ApiMsg; time: string }>; requests: Request[]; forks: Fork[] }
// A summary fork's step-event line (src/server.ts, summarize).
type Fork = { time: string; outcome: string; reason?: string; endsBefore?: number; foundEndsBefore?: number; arcs?: number | 'unparsed'; cutArcs?: number[]; answer?: string }

function load(): Conversation[] {
  const out: Conversation[] = []
  for (const key of readdirSync(logs)) {
    const dir = path.join(logs, key)
    if (!existsSync(path.join(dir, 'step_events.jsonl'))) continue
    const seen = new Set<string>()
    const messages: Conversation['messages'] = []
    const requests: Request[] = []
    const forks: Fork[] = []
    for (const line of readFileSync(path.join(dir, 'step_events.jsonl'), 'utf8').split('\n')) {
      if (!line) continue
      const e = JSON.parse(line)
      if (Date.parse(e.time) < since) continue
      if (e.event === 'summary') forks.push(e)
      if (e.event !== 'request') continue
      const sent = messagesOf(e) ?? []
      const lastFile = sent.length ? path.join(objectsOf(dir), sent[sent.length - 1].hash + '.json') : ''
      // BACKCOMPAT(2026-10-18)
      //   Before: request lines had no protocol; all were Messages.
      //   Shim: a missing protocol is read as messages.
      //   Remove when: logs from before 2026-10-18 are no longer read.
      requests.push({ time: e.time, protocol: e.protocol ?? 'messages', breakpoints: e.breakpoints, count: sent.length, last: lastFile && existsSync(lastFile) ? JSON.parse(readFileSync(lastFile, 'utf8')) : undefined })
      for (const { hash } of sent) {
        if (seen.has(hash)) continue
        seen.add(hash)
        const file = path.join(objectsOf(dir), hash + '.json')
        if (existsSync(file)) messages.push({ msg: JSON.parse(readFileSync(file, 'utf8')), time: e.time })
      }
    }
    const harness = ['claude', 'codex', 'opencode'].find((h) => key.startsWith(h + '-')) ?? 'unknown'
    out.push({ key, harness, messages, requests, forks })
  }
  return out
}

type Finding = { time: string; text: string }

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
function markersOutOfPlace(cs: Conversation[]): Finding[] {
  const found: Finding[] = []
  for (const c of cs)
    for (const { msg, time } of c.messages) {
      if (msg.role !== 'user') continue
      for (const text of texts(msg)) {
        const owners = MARKERS.find(([re]) => re.test(text))?.[1]
        if (owners && !owners.includes(c.harness)) found.push({ time, text: `${owners.join('/')} marker in ${c.harness}: ${where(c, time, text)}` })
      }
      if (!isPrompt(msg) && !blocks(msg).some((b) => b.type === 'tool_result' || isSkillBody(b)) && texts(msg).some((t) => !MARKERS.some(([re]) => re.test(t))))
        found.push({ time, text: `skipped with no marker listed here: ${where(c, time, texts(msg)[0] ?? '')}` })
    }
  return found
}

// Tags that open real prompts, which the model replies to as a turn: Claude
// Code's ! commands and pasted text.
const PROMPT_TAGS = [/^\s*<bash-input>/, /^\s*<pasted_content\b/]

// Prompts whose every counted block opens with a tag, as the text harnesses
// add usually does: each is either a prompt that quotes markup or harness text
// that wants a marker, as Codex's <environment_context> did before it had one.
// Prompts opening with a tag in PROMPT_TAGS are left out.
function taggedPrompts(cs: Conversation[]): Finding[] {
  const found: Finding[] = []
  for (const c of cs)
    for (const { msg, time } of c.messages) {
      if (!isPrompt(msg) || blocks(msg).some((b) => b.type === 'image' || b.type === 'document')) continue
      const counted = texts(msg).filter((t) => !MARKERS.some(([re]) => re.test(t)))
      if (counted.some((t) => PROMPT_TAGS.some((re) => re.test(t)))) continue
      if (counted.length && counted.every((t) => /^\s*(<[a-z_-]+[ >]|\[[A-Z][A-Z ]+[:\]])/.test(t))) found.push({ time, text: where(c, time, counted[0]) })
    }
  return found
}

// Messages requests of more than one message that the proxy sent with no
// cache breakpoint: nothing they send is cached, so each pays full input price
// for the whole prompt. Its web searches send one message with none, and are left out.
// Chat and Responses cache automatically, with no breakpoints to count.
function missingBreakpoints(cs: Conversation[]): Finding[] {
  const found: Finding[] = []
  for (const c of cs)
    for (const r of c.requests)
      if (r.protocol === 'messages' && r.breakpoints === 0 && r.count > 1)
        found.push({ time: r.time, text: `${r.count} messages, none marked: ${where(c, r.time, (r.last && texts(r.last)[0]) ?? '')}` })
  return found
}

// Summary forks whose answers depart from their instructions, which the proxy
// gets past but which mean the instructions or their parsing (src/summary.ts)
// have stopped fitting: rejected, for any reason; arcs written past the
// record's end, which it cut off (cutArcs); or a record kept without arcs, its
// headings not fitting its turns.
function offInstructions(cs: Conversation[]): Finding[] {
  const found: Finding[] = []
  for (const c of cs)
    for (const x of c.forks) {
      const why = [
        ...(x.outcome === 'rejected' ? [`rejected, ${x.reason ?? 'unknown'}${x.foundEndsBefore !== undefined ? ` (ends before [${x.foundEndsBefore}])` : ''}`] : []),
        ...(x.cutArcs?.length ? [`ends before [${x.endsBefore}], cut ${x.cutArcs.map((id) => `[${id}]`).join(', ')}`] : []),
        ...(x.arcs === 'unparsed' ? [`ends before [${x.endsBefore}], kept without arcs`] : []),
      ]
      if (why.length) found.push({ time: x.time, text: `${c.key.slice(0, 48)} ${x.time.slice(0, 19)}  ${why.join('; ')}${x.answer ? `, answer ${x.answer}` : ''}` })
    }
  return found
}

// A window of findings already dealt with: those logged from `from` (or the
// start) up to `until`, and why they need nothing more, usually a fix in the
// proxy or the harness.
type Resolved = { from?: string; until: string; why: string }

const AUDITS: Array<{ name: string; run: (cs: Conversation[]) => Finding[]; todo: string; resolved?: Resolved[] }> = [
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
  change; add it to resolved, with why.`,
  },
  {
    name: 'Messages requests send a cache breakpoint',
    run: missingBreakpoints,
    todo: `Look at the request in that conversation's logs, and at the requests around it.
- Its prefix was already cached by an earlier request (a side request like
  [SUGGESTION MODE…] sent after one that had a breakpoint): the proxy could
  add a breakpoint on its last message, which would read that prefix for 0.1x
  instead of paying 1x. Check first that the harness meant to cache nothing.
- The proxy dropped the breakpoint itself: a bug in src/messages.ts or
  src/trim.ts; compare the request with its received messages.
If it's neither: add the window to resolved, with why.`,
    resolved: [
      {
        until: '2026-10-15T03:00Z',
        why: `Claude Code sent 33, nearly all [SUGGESTION MODE…] or "The user stepped
away" side requests right after one that had a breakpoint, then stopped:
309 suggestion requests since, all with one. Taken as fixed in Claude Code.`,
      },
    ],
  },
  {
    name: 'Summary forks answer as their instructions ask',
    run: offInstructions,
    todo: `Read the fork's saved answer (in that conversation's logs) and the turns
it was asked about.
- Rejected: the answer couldn't be read as a record. If it says something the
  instructions allow, such as that nothing is complete, the parsing is wrong:
  fix rejectionOf or nothingComplete. If not, and it keeps happening, reword
  the instructions.
- Arcs cut past the end: an arc complete after one still in progress, written
  anyway. The record kept what came before the cut, and the cut arcs wait for
  a later fork. If it keeps happening, reword where a record ends.
- Kept without arcs: its headings don't fit its turns (arcsOf). The memoir
  still lists them, undated. A heading form the instructions allow means
  arcsOf is wrong; otherwise, if it keeps happening, reword the instructions.
If it needs nothing more, add the window to resolved, with why.`,
    resolved: [
      {
        from: '2026-11-05T23:47Z',
        until: '2026-11-05T23:48Z',
        why: `Rejected, ending before [1]: the answer was only "Ends before: [1]", the
fork's start, as the instructions ask when nothing is complete. Read as
nothing complete since a118a35.`,
      },
      {
        from: '2026-11-18T01:40Z',
        until: '2026-11-18T01:41Z',
        why: `Kept without arcs: two arcs started in turn [1090], one prompt's work on
two goals. Arcs can share a turn since 2026-11-24.`,
      },
    ],
  },
]

const cs = load()
console.log(`${cs.length} conversations, ${cs.reduce((n, c) => n + c.messages.length, 0)} messages${since ? ` since ${values.since}` : ''}\n`)
let failed = 0
for (const a of AUDITS) {
  const all = a.run(cs)
  const windows = a.resolved ?? []
  const inWindow = (f: Finding, w: Resolved) => Date.parse(f.time) >= (w.from ? Date.parse(w.from) : 0) && Date.parse(f.time) < Date.parse(w.until)
  const found = all.filter((f) => !windows.some((w) => inWindow(f, w))).map((f) => f.text)
  const resolved = all.length - found.length
  console.log(`${found.length ? 'ACTION' : 'ok    '}  ${a.name}${found.length ? ` (${found.length})` : ''}${resolved ? `  [${resolved} resolved]` : ''}`)
  for (const f of values.all ? found : found.slice(0, 20)) console.log(`        ${f}`)
  if (!values.all && found.length > 20) console.log(`        … ${found.length - 20} more; --all lists them`)
  if (found.length) console.log(`\n        What to do:\n${a.todo.replace(/^/gm, '        ')}\n`)
  if (found.length) failed++
}
process.exit(failed ? 1 : 0)

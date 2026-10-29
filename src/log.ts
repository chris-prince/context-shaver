// The one log: proxy-data/logs/<conversation>/step_events.jsonl, a line
// per model request and per trim decision, and parts/, each distinct message
// saved once (parts/<hash>.json) with its bytes split by kind
// (parts/<hash>.kinds.json). A request line lists its messages by hash, so the
// full and the trimmed version of a message are both on disk, joined by their
// lineage. The line also lists the top-level `system` blocks and the tool
// definitions, as sent, each saved once in parts/ beside the messages: a
// deferred tool is marked, since its definition costs nothing until a tool
// search loads it.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isMemoir, isPrompt, isSkillBody, isSummary, type ApiMsg, type Block } from './items.ts'
import { isStubbed, STUB } from './trim.ts'

export const LOG_DIR = 'logs'

// cyrb53, twice with different seeds: a 106-bit content hash, kept so part
// names match the plugin's earlier logs.
export function hash(s: string): string {
  const one = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed
    let h2 = 0x41c6ce57 ^ seed
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      h1 = Math.imul(h1 ^ c, 2654435761)
      h2 = Math.imul(h2 ^ c, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
  }
  return one(1) + one(2)
}

// A message's bytes by kind, summing to its JSON length, in the buckets
// `shaver info` reads: user, assistant, reasoning, tool calls
// and results each split into stubbed and not, what Claude Code injects, and
// other (content of an unknown type). The role/content wrapper rides with the
// role, a system message's with its text. A skill's body, which Claude Code
// sends as a text block beside the Skill call's result, is `toolResultsSkill`.
// `lineage` ties a trimmed message to
// the full one it replaced: its first tool_use id, or tool_result id, prefixed
// by role.
//
// Claude Code injects system messages and system-reminder blocks in user
// messages. Those of the preamble, the messages before the first response
// (CLAUDE.md, git status, the environment block), are `system`: fixed for the
// session, as the system prompt is, and the stats count them as base. Their
// text is cut at Claude Code's headings into `system:skills`,
// `system:agents-md` and the like, and the tools it adds there are
// `system:deferred-tools-list`; text under no heading stays `system`. A system
// message's own bytes join its first part.
// Later ones (environment updates, reminders) are `harness`.
export function kinds(json: string, m: ApiMsg, preamble = false): { kinds: Record<string, number>; lineage?: string } {
  const out: Record<string, number> = {}
  const add = (k: string, n: number) => n && (out[k] = (out[k] ?? 0) + n)
  const injected = preamble ? 'system' : 'harness'
  const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
  for (const b of content) {
    const k = isCompaction(b) ? 'harness' : m.role === 'system' || isReminder(b) ? injected : kindOf(b, m.role)
    if (k === 'system' && b.type === 'text') for (const [s, n] of sections(b)) add(s, n)
    else add(k === 'system' && b.type === 'tool_addition' ? 'system:deferred-tools-list' : k, JSON.stringify(b).length)
  }
  const envelope = m.role !== 'system' ? (out.summary ? 'summary' : out.memoir ? 'memoir' : m.role) : preamble ? (Object.keys(out)[0] ?? injected) : injected
  add(envelope, json.length - Object.values(out).reduce((a, b) => a + b, 0))
  const first = content.find((b) => b.type === 'tool_use' || b.type === 'tool_result')
  const id = first?.type === 'tool_use' ? first.id : first?.tool_use_id
  return { kinds: out, ...(typeof id === 'string' ? { lineage: `${m.role}:${id}` } : {}) }
}

// The user messages Codex makes before the first prompt (responses.ts).
export const CODEX_PREAMBLE = ['<environment_context>', '# AGENTS.md instructions']

// The headings Codex starts its developer and preamble messages with, as
// regex sources, and the section each starts. They lead its input, as its
// system (harness.ts), until a compaction; after one they follow the first
// prompt, as messages.
export const CODEX_HEADINGS: Array<[string, string]> = [
  ['<skills_instructions>', 'skills'],
  ['<permissions instructions>', 'permissions'],
  ['<collaboration_mode>', 'collaboration-mode'],
  ['<recommended_plugins>', 'plugins'],
  ['<multi_agent_role>', 'multi-agent'],
  ['<multi_agent_mode>', 'multi-agent'],
  ['# AGENTS.md instructions', 'agents-md'],
  ['<environment_context>', 'other'],
]

// The headings Claude Code starts each part of the preamble with, and Codex's,
// as regex sources, and the section each starts. The memory index comes
// inside the instructions reminder, after the rules files.
const HEADINGS: Array<[string, string]> = [
  ['The following skills are available', 'skills'],
  ['Available agent types', 'agent-types'],
  ['The following deferred tools', 'deferred-tools-list'],
  ['Codebase and user instructions', 'agents-md'],
  ['Contents of .*/memory/MEMORY\\.md', 'memory'],
  ['As you answer the user', 'guidance'],
  ['Attribution for git commits', 'git-attribution'],
  ['# Environment', 'other'],
  ['You are powered by the model', 'other'],
  ['While bypass permissions', 'other'],
  ["Today's date is", 'other'],
  ...CODEX_HEADINGS,
]

// A preamble text block's bytes by section. A section runs from its heading,
// at the start of a line, to the next; what comes before the first heading
// joins it.
export function sections(b: Block, headings = HEADINGS): Array<[string, number]> {
  const text = b.text as string
  const starts: Array<[number, string]> = []
  for (const [h, s] of headings) {
    const at = text.search(new RegExp('^' + h, 'm'))
    if (at >= 0) starts.push([at, 'system:' + s])
  }
  starts.sort((a, z) => a[0] - z[0])
  if (!starts.length) return [['system', JSON.stringify(b).length]]
  starts[0][0] = 0
  const out = starts.map(([at, s], i): [string, number] => [s, JSON.stringify(text.slice(at, starts[i + 1]?.[0])).length - 2])
  out[0][1] += JSON.stringify(b).length - out.reduce((n, [, m]) => n + m, 0)
  return out
}

// The index of the message that ends the preamble: the first response. After a
// /compact Claude Code keeps the last exchange before the compact and puts the
// preamble after it, with the first prompt, so when no message before the
// first response has a preamble heading and one up to the next prompt's
// message after it does, the preamble runs to the first response after that,
// or to the end if there's none yet.
export function preambleEnd(msgs: readonly ApiMsg[]): number {
  const first = msgs.findIndex((m) => m.role === 'assistant')
  if (first < 0) return first
  const headed = (m: ApiMsg) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content).some((b) => (m.role === 'system' || isReminder(b)) && b.type === 'text' && HEADINGS.some(([h]) => new RegExp('^' + h, 'm').test(String(b.text))))
  if (msgs.slice(0, first).some(headed)) return first
  const prompt = msgs.findIndex((m, i) => i > first && isPrompt(m))
  const at = prompt < 0 ? -1 : msgs.findIndex((m, i) => i > first && i <= prompt + 1 && headed(m))
  if (at < 0) return first
  const end = msgs.findIndex((m, i) => i > at && m.role === 'assistant')
  return end < 0 ? msgs.length : end
}

// Text the harness put in a user message: Claude Code's reminders, and Codex's
// preamble messages, which after a compaction come as user messages.
const isReminder = (b: Block) => b.type === 'text' && typeof b.text === 'string' && ['<system-reminder>', ...CODEX_PREAMBLE].some((p) => (b.text as string).startsWith(p))
// Codex's compaction item, which holds the history before it: conversation, not base.
const isCompaction = (b: Block) => b.type === 'item' && (b.item as { type?: string } | undefined)?.type === 'compaction'

function kindOf(b: Block, role: string): string {
  switch (b.type) {
    case 'text':
      return role === 'user' && isSkillBody(b) ? 'toolResultsSkill' : role === 'assistant' && isSummary(b) ? 'summary' : role === 'assistant' && isMemoir(b) ? 'memoir' : role
    case 'thinking':
    case 'redacted_thinking':
      return 'reasoning'
    case 'tool_use':
      return Object.values(b.input ?? {}).some(isStubbed) ? 'toolCallsStubbed' : 'toolCalls'
    case 'tool_result': {
      const c = b.content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => x?.text ?? '').join('') : ''
      return STUB.test(text) ? 'toolResultsStubbed' : 'toolResults'
    }
    default:
      return 'other'
  }
}

// Appends a line to the conversation's step_events.jsonl.
export function writeLine(dir: string, line: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  appendFileSync(path.join(dir, 'step_events.jsonl'), JSON.stringify(line) + '\n')
}

// The client's message hashes in each folder's last request line: received
// is logged as a change from them, since a long conversation's runs to
// thousands of hashes on every line.
const lastReceived = new Map<string, string[]>()

// A request line with received (the client's message hashes, server.ts) as
// { keep, add }: the first keep of the client's messages in the request line
// before (its received, else its parts), then add. keep is 0 after a restart.
export function withReceivedDelta(dir: string, line: Record<string, unknown>): Record<string, unknown> {
  const full = (line.received as string[] | undefined) ?? (line.parts as Array<{ hash: string }>).map((q) => q.hash)
  const before = lastReceived.get(dir) ?? []
  lastReceived.set(dir, full)
  if (!line.received) return line
  let keep = 0
  while (keep < full.length && full[keep] === before[keep]) keep++
  return { ...line, received: { keep, add: full.slice(keep) } }
}

// The client's message hashes for each request line, in order, read back
// from withReceivedDelta's form.
export function receivedOf(lines: ReadonlyArray<Record<string, any>>): string[][] {
  let before: string[] = []
  return lines.filter((e) => e.event === 'request').map((e) => (before = e.received ? [...before.slice(0, e.received.keep), ...e.received.add] : e.parts.map((q: { hash: string }) => q.hash)))
}

// Saves each message not saved before, with its kinds; returns the request's
// part list, each with the wire's names for its items when idsOf gives them.
export function writeParts(dir: string, msgs: readonly ApiMsg[], idsOf?: (m: ApiMsg) => string[]): Array<{ part: string; hash: string; bytes: number; ids?: string[] }> {
  const parts = path.join(dir, 'parts')
  mkdirSync(parts, { recursive: true })
  const responded = preambleEnd(msgs)
  return msgs.map((m, i) => {
    const json = JSON.stringify(m)
    const h = hash(json)
    const file = path.join(parts, `${h}.json`)
    if (!existsSync(file)) {
      writeFileSync(file, json)
      writeFileSync(path.join(parts, `${h}.kinds.json`), JSON.stringify(kinds(json, m, responded < 0 || i < responded)))
    }
    const ids = idsOf?.(m)
    return { part: m.role, hash: h, bytes: json.length, ...(ids?.length && { ids }) }
  })
}

// Saves each system block and tool definition not saved before; returns the
// request's lists of them.
export function writeDefs(dir: string, body: { system?: unknown; tools?: Array<{ name?: string; defer_loading?: boolean }> }) {
  const parts = path.join(dir, 'parts')
  mkdirSync(parts, { recursive: true })
  const save = (x: unknown) => {
    const json = JSON.stringify(x)
    const h = hash(json)
    const file = path.join(parts, `${h}.json`)
    if (!existsSync(file)) writeFileSync(file, json)
    return { hash: h, bytes: json.length }
  }
  const system: unknown[] = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : Array.isArray(body.system) ? body.system : []
  return {
    system: system.map(save),
    tools: (body.tools ?? []).map((t) => ({ name: t.name, ...save(t), ...(t.defer_loading ? { deferred: true } : {}) })),
  }
}

// What a request asked for besides its content, as the client sent it:
// thinking, effort, reasoning, output limits and the like. Left out are the
// content (saved as parts), the model (logged apart), and who is asking.
const NOT_PARAMS = new Set(['messages', 'input', 'system', 'instructions', 'tools', 'model', 'metadata', 'client_metadata', 'prompt_cache_key', 'user'])

export const paramsOf = (wire: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(wire).filter(([k]) => !NOT_PARAMS.has(k)))

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
import { isSkillBody, type ApiMsg, type Block } from './items.ts'
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
// ctx-shaver's analyze-context reads: user, assistant, reasoning, tool calls
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
// session, as the system prompt is, and analyze-context counts them as base.
// Later ones (environment updates, reminders) are `harness`.
export function kinds(json: string, m: ApiMsg, preamble = false): { kinds: Record<string, number>; lineage?: string } {
  const out: Record<string, number> = {}
  const add = (k: string, n: number) => n && (out[k] = (out[k] ?? 0) + n)
  const injected = preamble ? 'system' : 'harness'
  const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
  for (const b of content) {
    const k = b.type === 'text' && (m.role === 'system' || isReminder(b)) ? injected : kindOf(b, m.role)
    add(k, JSON.stringify(b).length)
  }
  add(m.role === 'system' ? injected : m.role, json.length - Object.values(out).reduce((a, b) => a + b, 0))
  const first = content.find((b) => b.type === 'tool_use' || b.type === 'tool_result')
  const id = first?.type === 'tool_use' ? first.id : first?.tool_use_id
  return { kinds: out, ...(typeof id === 'string' ? { lineage: `${m.role}:${id}` } : {}) }
}

const isReminder = (b: Block) => b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('<system-reminder>')

function kindOf(b: Block, role: string): string {
  switch (b.type) {
    case 'text':
      return role === 'user' && isSkillBody(b) ? 'toolResultsSkill' : role
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

// Saves each message not saved before, with its kinds; returns the request's
// part list.
export function writeParts(dir: string, msgs: readonly ApiMsg[]): Array<{ part: string; hash: string; bytes: number }> {
  const parts = path.join(dir, 'parts')
  mkdirSync(parts, { recursive: true })
  const responded = msgs.findIndex((m) => m.role === 'assistant')
  return msgs.map((m, i) => {
    const json = JSON.stringify(m)
    const h = hash(json)
    const file = path.join(parts, `${h}.json`)
    if (!existsSync(file)) {
      writeFileSync(file, json)
      writeFileSync(path.join(parts, `${h}.kinds.json`), JSON.stringify(kinds(json, m, responded < 0 || i < responded)))
    }
    return { part: m.role, hash: h, bytes: json.length }
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

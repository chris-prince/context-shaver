// The one log: logs-mini-ctx-claude/<conversation>/step_events.jsonl, a line
// per model request and per trim decision, and parts/, each distinct message
// saved once (parts/<hash>.json) with its bytes split by kind
// (parts/<hash>.kinds.json). A request line lists its messages by hash, so the
// full and the trimmed version of a message are both on disk, joined by their
// lineage. The system prompt and tool definitions are not logged.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { TOOL_RESULT_STUB_PREFIX, type ApiMsg, type Block } from './trim.ts'

export const LOG_DIR = 'logs-mini-ctx-claude'

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

const INPUT_STUB_IN = /\[\d+ characters removed from an earlier turn to save context\]/

// A message's bytes by kind, summing to its JSON length, in the buckets
// mini-context's analyze-context reads: user, assistant, reasoning, tool calls
// and results each split into stubbed and not, and other. The role/content
// wrapper rides with the role. `lineage` ties a trimmed message to the full one
// it replaced: its first tool_use id, or tool_result id, prefixed by role.
export function kinds(json: string, m: ApiMsg): { kinds: Record<string, number>; lineage?: string } {
  const out: Record<string, number> = {}
  const add = (k: string, n: number) => n && (out[k] = (out[k] ?? 0) + n)
  const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
  for (const b of content) add(kindOf(b, m.role), JSON.stringify(b).length)
  add(m.role, json.length - Object.values(out).reduce((a, b) => a + b, 0))
  const first = content.find((b) => b.type === 'tool_use' || b.type === 'tool_result')
  const id = first?.type === 'tool_use' ? first.id : first?.tool_use_id
  return { kinds: out, ...(typeof id === 'string' ? { lineage: `${m.role}:${id}` } : {}) }
}

function kindOf(b: Block, role: string): string {
  switch (b.type) {
    case 'text':
      return role === 'system' ? 'other' : role
    case 'thinking':
    case 'redacted_thinking':
      return 'reasoning'
    case 'tool_use':
      return INPUT_STUB_IN.test(JSON.stringify(b.input)) ? 'toolCallsStubbed' : 'toolCalls'
    case 'tool_result': {
      const c = b.content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => x?.text ?? '').join('') : ''
      return text.startsWith(TOOL_RESULT_STUB_PREFIX) ? 'toolResultsStubbed' : 'toolResults'
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
  return msgs.map((m) => {
    const json = JSON.stringify(m)
    const h = hash(json)
    const file = path.join(parts, `${h}.json`)
    if (!existsSync(file)) {
      writeFileSync(file, json)
      writeFileSync(path.join(parts, `${h}.kinds.json`), JSON.stringify(kinds(json, m)))
    }
    return { part: m.role, hash: h, bytes: json.length }
  })
}

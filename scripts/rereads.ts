// What the backtest (backtest-horizon.ts) needs to charge for re-reads: when
// each tool result is used again, and which logged results were re-reads.
//
// A result is used where a later response quotes one of its lines: a line of
// at least MIN_LINE characters, trimmed, in the response's text, reasoning or
// a call's input (an edit's old text, say). A quote counts for the newest
// result holding that line, so once a file is read again, later quotes count
// for the newer read. A response is that to the request before the one it is
// first sent in; the seeded first request's own messages are no one's.
//
// A logged result is a re-read of an earlier one when every line of it, of at
// least MIN_LINE characters and at least MIN_LINES of them, is in the earlier
// result: the agent fetched again only what it had seen. A view with lines it
// hadn't seen, wider or shifted, isn't one; an untrimmed run would have asked
// for those too (Nov 22, 2026: of 132 views of a file the proxy had removed,
// 57 were re-reads by this rule).
import { createHash } from 'node:crypto'
import type { ApiMsg, Block } from '../src/items.ts'

export const MIN_LINE = 30
export const MIN_LINES = 3

// `at`: the request it is first sent in; `chars`: its block's size.
export type Result = { id: string; at: number; chars: number }
// The response to request `at` quotes results `ids`.
export type Use = { at: number; ids: string[] }
// The response to request `at` fetched result `id` again, all of it in the
// earlier result `of`; `alone`: the response made no other call.
export type Reread = { at: number; id: string; of: string; alone: boolean }
export type Uses = { results: Map<string, Result>; uses: Use[]; rereads: Reread[] }

// A result's text, its lines each without a Read's line number (`  12→`).
const text = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : '')
const linesOf = (s: string, numbered: boolean) => s.split('\n').map((l) => (numbered ? l.replace(/^\s*\d+[→\t]/, '') : l).trim()).filter((l) => l.length >= MIN_LINE)
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [])
const quoted = (b: Block): string[] => (b.type === 'text' ? [String(b.text ?? '')] : b.type === 'thinking' ? [String(b.thinking ?? '')] : b.type === 'tool_use' ? strings(b.input) : [])

// `reqs`: each request's messages, untrimmed.
export function usesOf(reqs: readonly (readonly ApiMsg[])[]): Uses {
  const results = new Map<string, Result>()
  const uses: Use[] = []
  const rereads: Reread[] = []
  const seen = new Set<string>()
  // Each line: the results holding it, oldest first; each result's lines.
  const holders = new Map<string, string[]>()
  const held = new Map<string, Set<string>>()
  const callsIn = new Map<string, number>()
  reqs.forEach((msgs, n) => {
    for (const m of msgs) {
      if (typeof m.content === 'string') continue
      const key = createHash('sha1').update(JSON.stringify(m)).digest('hex')
      if (seen.has(key)) continue
      seen.add(key)
      if (m.role === 'assistant') {
        const calls = m.content.filter((b) => b.type === 'tool_use')
        for (const b of calls) callsIn.set(String(b.id), calls.length)
        if (!n) continue
        const ids = new Set<string>()
        for (const l of m.content.flatMap(quoted).flatMap((s) => linesOf(s, false))) {
          const id = holders.get(l)?.at(-1)
          if (id) ids.add(id)
        }
        if (ids.size) uses.push({ at: n - 1, ids: [...ids] })
        continue
      }
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue
        const id = String(b.tool_use_id)
        if (results.has(id)) continue
        const s = text(b.content)
        const lines = new Set(linesOf(s, /^\s*\d+→/m.test(s)))
        results.set(id, { id, at: n, chars: JSON.stringify(b).length })
        if (n && lines.size >= MIN_LINES) {
          // The newest earlier result holding every line, found among those
          // holding its rarest one.
          const rarest = [...lines].reduce((a, l) => ((holders.get(l)?.length ?? 0) < (holders.get(a)?.length ?? 0) ? l : a))
          const of = (holders.get(rarest) ?? []).findLast((r) => [...lines].every((l) => held.get(r)!.has(l)))
          if (of) rereads.push({ at: n - 1, id, of, alone: callsIn.get(id) === 1 })
        }
        held.set(id, lines)
        for (const l of lines) holders.get(l)?.push(id) ?? holders.set(l, [id])
      }
    }
  })
  return { results, uses, rereads }
}

// The results `msgs` holds whole: not dropped, nor stubbed or culled.
export function wholeIn(msgs: readonly ApiMsg[]): Set<string> {
  const out = new Set<string>()
  for (const m of msgs) {
    if (typeof m.content === 'string') continue
    for (const b of m.content) if (b.type === 'tool_result' && !/^\[CULLED \d+ B FROM CTX\]$/.test(text(b.content).trim())) out.add(String(b.tool_use_id))
  }
  return out
}

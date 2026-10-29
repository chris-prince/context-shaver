// The harness a request comes from (DESIGN.md, "Harnesses"): what it calls its
// tools and its system prompt's sections, and how it names its sessions,
// whatever wire protocol and model it uses. A wrapper declares it in the base
// URL, /harness/<name> before any /via/ (via.ts, route); without one, the
// headers each harness sends under its own name give it. With neither it is
// unknown, and the core trims with no conventions: no inputs stubbed, the
// system prompt one section.

import type { IncomingHttpHeaders } from 'node:http'
import { CLAUDE_CODE, type ApiMsg, type Conventions } from './items.ts'
import { CODEX_HEADINGS, hash } from './log.ts'
import type { Canonical } from './protocol.ts'

export type Harness = {
  name: 'claude' | 'codex' | 'opencode'
  // The prefix of the header names it sends.
  headers: string
  conventions: Conventions
  // Whether it has a tool that loads deferred tools, so the proxy can defer
  // others where the protocol can (defer.ts).
  defers: boolean
  // The tools `:shaver optimize` keeps loaded when it defers the rest: those a
  // coding session uses on most steps, where the proxy might defer them.
  core: string[]
  // Whether it sends again all it sent before, but after compacting, so a
  // request without the last message of the one before follows a compaction
  // (stats.ts, Sent.compacted).
  resends: boolean
  // Its session's ID, part of each conversation's (conversationId).
  session(c: Canonical, headers: IncomingHttpHeaders): unknown
}

// Claude Code sends the session ID with every request, and an agent ID
// (x-claude-code-agent-id) with each subagent's; the main loop sends none.
const CLAUDE: Harness = {
  name: 'claude',
  headers: 'x-claude-code-',
  conventions: CLAUDE_CODE,
  defers: true,
  core: ['Bash', 'Edit', 'Read', 'Write'],
  // It rewrites its last message's reminders on the next request.
  resends: false,
  session(c, headers) {
    try {
      const session = JSON.parse((c.metadata as { user_id?: string } | undefined)?.user_id ?? '{}').session_id
      return session && `${session}-${headers['x-claude-code-agent-id'] ?? 'main'}`
    } catch {}
  },
}

// Codex's tools are run from JavaScript, by one custom exec tool, so no call's
// input has fields of its own to stub, nor a shell command apart. It loads
// deferred tools with a client tool_search. It sends its session's ID as
// prompt_cache_key and as the session-id header.
const CODEX: Harness = {
  name: 'codex',
  headers: 'x-codex-',
  conventions: {
    kinds: { tool_search: 'tool_search' },
    stubbedInputs: {},
    shell: '',
    promptHeadings: [['', 'system-prompt'], ...CODEX_HEADINGS],
  },
  defers: true,
  // Its exec and wait are never deferred (defer.ts).
  core: [],
  // In 265 journaled requests to 2026-10-24, the 3 that left out the last
  // message before were those after its 3 compactions.
  resends: true,
  session: (c, headers) => c.prompt_cache_key ?? headers['session-id'],
}

// OpenCode's tools, as its 2.x requests name them: edit's and write's text, and
// shell for shell commands. Its skill tool is left a plain tool until we see
// what its result holds; it has no tool-loading tool. Every provider's requests
// carry its session's ID in x-opencode-session-id.
const OPENCODE: Harness = {
  name: 'opencode',
  headers: 'x-opencode-',
  conventions: {
    kinds: {},
    stubbedInputs: { edit: ['oldString', 'newString'], write: ['content'] },
    shell: 'shell',
    // OpenCode puts the skills, the rules files and the environment in its
    // system prompt. '' matches at the start, so the text before the first
    // heading is a section of its own.
    promptHeadings: [
      ['', 'system-prompt'],
      ['# Code Mode', 'tools-execute'],
      ['Skills provide specialized', 'skills'],
      ['Instructions from: ', 'agents-md'],
      ['Here is some useful information about the environment', 'other'],
    ],
  },
  defers: false,
  core: [],
  // Unchecked: no logged OpenCode session has compacted.
  resends: false,
  session: (_, headers) => headers['x-opencode-session-id'],
}

const HARNESSES = [CLAUDE, CODEX, OPENCODE]

export const NO_CONVENTIONS: Conventions = { kinds: {}, stubbedInputs: {}, shell: '', promptHeadings: [] }

// The harness a request declares, or else the one whose headers it sends; an
// error for a name declared that isn't one.
export function harnessOf(declared: string | undefined, headers: IncomingHttpHeaders): Harness | undefined | { error: string } {
  if (declared) return HARNESSES.find((h) => h.name === declared) ?? { error: `not a harness: /harness/${declared}` }
  return HARNESSES.find((h) => Object.keys(headers).some((k) => k.startsWith(h.headers)))
}

// A conversation's ID: its harness (or, unknown, its protocol), its session,
// and a hash of its first message. A session can send several histories: a
// Claude Code WebSearch call is its own one-message request, and a compaction
// replaces the history with a summary and carries on from that. The first
// message changes exactly when the history is a new one.
//
// The first message is hashed as the client sent it, before the proxy strips
// `:shaver` commands from it or moves a breakpoint onto it: the client sends
// it the same way on every request, so only the client can change the key.
// Its breakpoints are left out, so a client that marks the last message,
// which on a conversation's first request is the first, keeps the key.
//
// The session keeps apart conversations whose first message is the same, as
// happens when two Claude Code sessions start with the same prompt in the
// same repo state. An unknown harness's is the body's prompt_cache_key or
// user, if it sends one; with neither, the first message is the ID alone.
export function conversationId(h: Harness | undefined, protocol: string, c: Canonical, headers: IncomingHttpHeaders): string {
  const names = h ? [h.session(c, headers)] : [c.prompt_cache_key, c.user]
  const session = names.find((v) => typeof v === 'string' && v)
  return `${h?.name ?? protocol}-${session ? `${session}-` : ''}${hash(JSON.stringify(unmarked(c.messages[0]) ?? null)).slice(0, 8)}`
}

// A message without its blocks' breakpoints; one with none is itself.
function unmarked(m: ApiMsg | undefined): ApiMsg | undefined {
  if (!m || !Array.isArray(m.content) || !m.content.some((b) => b && typeof b === 'object' && 'cache_control' in b)) return m
  return { ...m, content: m.content.map((b) => {
    if (!b || typeof b !== 'object' || !('cache_control' in b)) return b
    const { cache_control: _, ...rest } = b
    return rest
  }) }
}

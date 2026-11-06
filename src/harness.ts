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
  // The tools never deferred or dropped, whatever the rules say (defer.ts).
  alwaysLoaded: readonly string[]
  // Whether it sends again all it sent before, but after compacting, so a
  // request without the last message of the one before follows a compaction
  // (stats.ts, Sent.compacted).
  resends: boolean
  // Its session's ID, part of each conversation's (conversationId).
  session(c: Canonical, headers: IncomingHttpHeaders): unknown
  // The prefixes of the headers of its own that are logged (loggedHeaders).
  logged: readonly string[]
  // Whether its headers say a request is a side request on the conversation
  // (stats.ts, isSideRequest); undefined where they don't say, or say
  // something not known yet.
  side?(headers: IncomingHttpHeaders): boolean | undefined
  // Whether they say it is its compaction (stats.ts, isCompaction), likewise.
  compaction?(headers: IncomingHttpHeaders): boolean | undefined
}

// Claude Code's x-claude-code-request-class, sent when
// CLAUDE_CODE_GATEWAY_HINT_HEADERS is on (bin/claude-via-shaver): its main
// loop's, subagents' and workflows' requests, and its side requests (the
// prompt suggestion and the recap are auxiliary). 2.1.318 has these six.
const LOOP_CLASSES = new Set(['main', 'subagent', 'workflow'])
const SIDE_CLASSES = new Set(['compaction', 'auxiliary', 'side_reply'])

// Claude Code sends the session ID with every request, and an agent ID
// (x-claude-code-agent-id) with each subagent's; the main loop sends none.
const CLAUDE: Harness = {
  name: 'claude',
  headers: 'x-claude-code-',
  conventions: CLAUDE_CODE,
  defers: true,
  // ToolSearch loads the others; the model uses the file and shell tools on
  // most requests, and leaves Skill uncalled when it's deferred.
  alwaysLoaded: ['ToolSearch', 'Skill', 'Bash', 'Edit', 'Read', 'Write'],
  // It rewrites its last message's reminders on the next request.
  resends: false,
  session(c, headers) {
    try {
      const session = JSON.parse((c.metadata as { user_id?: string } | undefined)?.user_id ?? '{}').session_id
      return session && `${session}-${headers['x-claude-code-agent-id'] ?? 'main'}`
    } catch {}
  },
  logged: ['x-claude-code-'],
  side(headers) {
    const c = String(headers['x-claude-code-request-class'] ?? '')
    return SIDE_CLASSES.has(c) ? true : LOOP_CLASSES.has(c) ? false : undefined
  },
  compaction(headers) {
    const c = String(headers['x-claude-code-request-class'] ?? '')
    return SIDE_CLASSES.has(c) || LOOP_CLASSES.has(c) ? c === 'compaction' : undefined
  },
}

// Codex's tools are run from JavaScript, by one custom exec tool, so no call's
// input has fields of its own to stub, nor a shell command apart. It loads
// the tools it defers with a client tool_search. It sends its session's ID as
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
  // exec runs every other tool, and wait resumes its cells.
  alwaysLoaded: ['functions.exec', 'functions.wait'],
  // In 265 journaled requests to 2026-10-24, the 3 that left out the last
  // message before were those after its 3 compactions.
  resends: true,
  session: (c, headers) => c.prompt_cache_key ?? headers['session-id'],
  logged: ['x-codex-', 'x-openai-'],
  // Each request's x-codex-turn-metadata has a request_kind: turn, or
  // compaction (0.166.0's two).
  side(headers) {
    try {
      const kind = JSON.parse(String(headers['x-codex-turn-metadata'])).request_kind
      return kind === 'compaction' ? true : kind === 'turn' ? false : undefined
    } catch {}
  },
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
  alwaysLoaded: [],
  // Unchecked: no logged OpenCode session has compacted.
  resends: false,
  session: (_, headers) => headers['x-opencode-session-id'],
  // It sends no header saying what kind a request is.
  logged: ['x-opencode-'],
}

const HARNESSES = [CLAUDE, CODEX, OPENCODE]

export const NO_CONVENTIONS: Conventions = { kinds: {}, stubbedInputs: {}, shell: '', promptHeadings: [] }

// The harness a request declares, or else the one whose headers it sends; an
// error for a name declared that isn't one.
export function harnessOf(declared: string | undefined, headers: IncomingHttpHeaders): Harness | undefined | { error: string } {
  if (declared) return HARNESSES.find((h) => h.name === declared) ?? { error: `not a harness: /harness/${declared}` }
  return HARNESSES.find((h) => Object.keys(headers).some((k) => k.startsWith(h.headers)))
}

// Names that say a header may carry a secret.
const SECRET = /auth|credential|key|password|secret|signature|ticket|token|cookie/i

// The harness's own headers, for the log: all under its prefixes, so new
// ones are seen, but those whose names say they may carry a secret.
export function loggedHeaders(h: Harness, headers: IncomingHttpHeaders): Record<string, string> | undefined {
  const out = Object.entries(headers).filter(([k, v]) => v !== undefined && h.logged.some((p) => k.startsWith(p)) && !SECRET.test(k))
  return out.length ? Object.fromEntries(out.map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)])) : undefined
}

// A conversation's ID: its harness (or, unknown, its protocol), its session,
// and a hash of its first message. A session can send several histories: a
// Claude Code WebSearch call is its own one-message request, and a compaction
// replaces the history with a summary and carries on from that. The first
// message changes exactly when the history is a new one.
//
// The first message is hashed as the client sent it, before the proxy strips
// `shaver` commands from it or moves a breakpoint onto it: the client sends
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

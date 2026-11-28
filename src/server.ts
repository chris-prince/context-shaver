// context-shaver: a local proxy between Claude Code and the Anthropic API that
// trims old tool output, long Edit/Write inputs and reasoning from each request
// it forwards. The stored session and the screen are untouched; only what is
// sent changes. See README.md.
//
// What is trimmed, and when, is the policy file's (policy.ts); with none, it
// passes requests through. Each conversation (keyed by its first message, so a
// subagent is its own) has an applied clock, saved under proxy-data/state/: the
// completed requests and turns every request is trimmed at. On each request the
// cost rule (trim.ts, decide) says whether moving it up to the conversation's
// clock pays: always on a cold cache, and on a warm one when what it saves
// outweighs what it rewrites, priced against the cache entries the
// conversation's requests left.

import { execFileSync } from 'node:child_process'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'
import { errorShape, hash, kinds, LOG_DIR, paramsOf, withReceivedDelta, writeDefs, writeLine, writeMessages, writePolicy } from './log.ts'
import { blocks, callIdsOf, clockNow, clockOf, heldTo, isPrompt, type ApiMsg, type Clock, type Conventions } from './items.ts'
import type { Canonical, Content, Counted, Protocol, UsageReader, Wire } from './protocol.ts'
import { MESSAGES } from './messages.ts'
import { drop as dropUnbound, dropAsked, fetchBound, UNBOUND } from './binding.ts'
import { fetchMarked, marking, on as codexBreakpoints } from './breakpoints.ts'
import { CHAT } from './chat.ts'
import { RESPONSES } from './responses.ts'
import { actionOf, dropTools, forceDefer, offerable, searchOn, toolListMessage, withPicked, type ToolRule } from './defer.ts'
import { keptWhole, LINE_WORDS, lineOf, linesOf, linesPrompt, listMessage, shaveSkills, skillsOf, withLines, type Skill, type SkillRule } from './skills.ts'
import { answeredMidTurn, midTurnCommands, pendingCommand, stripCommands, WARNING, withoutPending } from './command.ts'
import { afterAnswer, ANALYZING, ANALYZING_TOOLS, NOTHING, optimizing, skillsAsked, skillsText, toolsAsked, toolsText, type Proposal, type Skills } from './optimize.ts'
import { totals } from './totals.ts'
import { conversationId, harnessOf, loggedHeaders, NO_CONVENTIONS, type Harness } from './harness.ts'
import { autocompactAt } from './autocompact.ts'
import { load as loadLaunch, type LaunchVals } from './launch-vals.ts'
import { bornFrom, bornOf, compactedSince, counted, describe, estimate, isCompaction, isSideRequest, keyOf, observe, promptTokens, splitShaved, textTokens, tokensOf, withoutSideRequest, type Forks, type Sent, type Stats } from './stats.ts'
import { cacheRead, ignoredMarks, journalKeys, LastCalls, newestCall, record, recordBare, recordFork, recordResent, sideKey, written, type BareLine, type ForkKind, type ForkLine, type Why } from './journal.ts'
import { add, addBare, addResent, spent, type Cost, type Usage } from './cost.ts'
import { localHost, route } from './via.ts'
import { forcedTrimOf, loadPolicy, parsePolicy, seedPolicy, skillRulesNow, textRules, toolRulesOf, type Policy } from './policy.ts'
import { ccVersion, folded, kept, type Keep, type MtimeOf } from './compact-keep.ts'
import { lifetimeMs, modelOf } from './models.ts'
import { infoText, journaled, journalIn, othersOf, summariesFrom, summariesIn, type Outcome, type Summaries } from './info.ts'
import { anchored, apply, counting, entriesOf, freedSystem, decide, liveEnd, markedTtl, positionsOf, prefixesOf, reachOf, readThrough, seedOf, wholeSeedOf, fullyTrimmed, trimmedInTurn, settledEnd, TEXT_TOKENS, JOINED, transitions, trimmedEnd, unboundIn, type Decision, type Thinking } from './trim.ts'
import { arcsPastEnd, chainBreak, coveredBy, summaryForkOf, instructions, mergedOf, nothingComplete, recordOf, rejectionOf, salvagedOf, startsOf, summarized, turnsOf, validChain, type ForkSkip, type SummaryFork, type Summary, type Turn } from './summary.ts'

// A file's modification time in ms, or undefined where it can't be read.
const mtimeOf: MtimeOf = (p) => {
  if (!path.isAbsolute(p)) return undefined
  try { return statSync(p).mtimeMs } catch { return undefined }
}

const repoPolicy = path.resolve(import.meta.dirname, '..', 'policy.json')
const { values: a } = parseArgs({
  allowNegative: true,
  options: {
    port: { type: 'string', default: '18787' },
    upstream: { type: 'string', default: 'https://api.anthropic.com' },
    dir: { type: 'string', default: path.resolve(import.meta.dirname, '..', 'proxy-data') },
    policy: { type: 'string', default: repoPolicy },
    'log-step-events': { type: 'boolean', default: false },
    'cache-ttl-seconds': { type: 'string', default: '3600' },
  },
})

// SHAVER_MODE=passthrough sends every request on as it came and its answer
// back as it came (relay): to measure the unshaved path, such as a benchmark's
// baseline, with exact counts. The policy file and the proxy's state are
// neither read nor written; with --log-step-events each request is logged.
// Any other value is refused, so a typo can't shave a run meant not to be.
const mode = process.env.SHAVER_MODE ?? ''
if (mode && mode !== 'passthrough') {
  console.error(`shaver: SHAVER_MODE is "${mode}"; it can only be "passthrough", or unset to shave`)
  process.exit(1)
}
const passthrough = mode === 'passthrough'

// The repo's policy.json is made from policy.default.json the first time; a
// --policy file given is taken as it is.
if (!passthrough && a.policy === repoPolicy) seedPolicy(repoPolicy, path.resolve(import.meta.dirname, '..', 'policy.default.json'))
const loaded = passthrough ? undefined : loadPolicy(a.policy)
if (!loaded && !passthrough) console.error(`shaver: no policy at ${a.policy}, so requests pass through untrimmed`)
const policy = loaded ?? {}
const conversationRules = policy.conversation_shaver_rules ?? {}
const { summary_threshold_tokens: summaryAt, memoir_threshold_tokens: memoirAt } = textRules(policy)
const ttlMs = Number(a['cache-ttl-seconds']) * 1000
const stateDir = path.join(a.dir, 'state')
const logRoot = path.join(a.dir, LOG_DIR)
mkdirSync(stateDir, { recursive: true })
const lastCalls = new LastCalls(path.join(stateDir, 'last-calls.json'))
// The conversations journaled that the table lacks, filled from their journals
// and logs once; after that, only the folder's names are listed.
if (!passthrough) {
  const t = performance.now()
  const added = lastCalls.fill(journalKeys(stateDir), (k) => newestCall(stateDir, logRoot, k))
  if (added) console.error(`shaver: filled in last-calls.json for ${counted(added, 'conversation')}, in ${Math.round(performance.now() - t)}ms`)
}
// The commit this proxy started from, for bin/run-proxy to tell whether the
// checkout has moved on since; empty outside a git checkout.
const commit = (() => {
  try { return execFileSync('git', ['-C', import.meta.dirname, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
})()
// The version proxy.log, request lines and `shaver info` give: the commit's
// first 8 characters, marked +uncommitted when src/ differed from it at
// startup, when the code that runs was loaded.
const version = (() => {
  if (!commit) return 'unknown'
  let changed = true
  try { changed = !!execFileSync('git', ['-C', import.meta.dirname, 'status', '--porcelain', '.'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
  return commit.slice(0, 8) + (changed ? '+uncommitted' : '')
})()

// A conversation's applied clock; the cache entries its answered requests
// wrote or read, by prefix hash, with when (trim.ts, positionsOf); and the
// tokens each thinking block it was answered with bills, by the signature's
// hash (trim.ts, sizeOf), and the messages it came after, as hashed (trim.ts,
// unboundIn); the tokens each tool call's call and output items
// billed, by call id, where the API counted them (Codex; trim.ts, tokensOf);
// how many of its records it sends (summary.ts), how many of those as the
// memoir, and the turn the last summary fork was offered at; the skill rules
// its list was last shortened by, and when it took them; and whether its
// shaving is frozen (Frozen); and which of the API's refusals of thinking its
// route has given (Refusals). Its stats, for `shaver info`, are in its journal.
type SkillList = { rules: SkillRule[]; at: number }
type State = { applied: Clock; entries?: Record<string, number>; thinking?: Record<string, number>; thinkingAfter?: Record<string, string>; calls?: Record<string, number>; summarized?: number; merged?: number; offered?: number; skillList?: SkillList; frozen?: Frozen } & Refusals

// Refusals that change how a conversation is shaved from then on, since they
// come from its route, which stays: `joins`, a drop that joined thinking to
// thinking (trim.ts, JOINED), keeps such calls stubbed; `dropUnbound`, thinking
// left unbound (binding.ts, UNBOUND), asks the API to drop such blocks.
type Refusals = { joins?: boolean; dropUnbound?: boolean }

// A conversation's shaving is frozen when the API refuses a shaved request
// that the last one's shape is accepted for: from then on it is sent as that
// one was, no new records or trims, until a shave would save RETRY_STEP more
// tokens than `gap`, its saving when last refused, and is tried again; a shave
// accepted, or a proxy started since (`started`), ends it. `since` is the first
// refusal, `error` the API's words on the last.
type Frozen = { since: string; gap: number; started: string; error: string }
const RETRY_STEP = 10_000
const started = new Date().toISOString()

// The token counts trim.ts sizes items by: thinking by signature hash, and
// tool calls by `call:` and their id, with what each block came after
// (trim.ts, Thinking).
const recordedOf = (s: State | undefined): Thinking =>
  Object.assign(new Map([...Object.entries(s?.thinking ?? {}), ...Object.entries(s?.calls ?? {}).map(([id, n]) => [`call:${id}`, n] as const)]), { after: new Map(Object.entries(s?.thinkingAfter ?? {})) })

// The skill rules a conversation's list is shortened by: while its cache is
// warm the ones it has, so new ones don't rewrite it, unless lines from
// `shaver optimize` were applied since; else the policy's.
const skillListOf = (s: State | undefined, warm: boolean, now: number): SkillList | undefined =>
  s?.skillList && warm && s.skillList.at > skillsForcedAt ? s.skillList : policy.skill_shaver_rules && { rules: policy.skill_shaver_rules, at: now }

// A state saved before the applied clock, with a frontier, is read as none;
// one whose clock counts steps has them read as requests.
function load(key: string): State | undefined {
  try {
    const s: State = JSON.parse(readFileSync(path.join(stateDir, `${key}.json`), 'utf8'))
    if (s.skillList) s.skillList.rules = skillRulesNow(s.skillList.rules)
    if (s.applied) s.applied = clockNow(s.applied)
    return s.applied ? s : undefined
  } catch {
    return undefined
  }
}

// Two requests of a conversation can be in flight at once (a side request
// beside the main loop), each with the state it loaded, so the entries and
// thinking another saved meanwhile are kept: what one knows of the cache, the
// other doesn't undo. The clock and the rest are the later request's. A call's
// first count is kept: it was sent whole then, and may since be stubbed. A
// refusal either one had is kept too.
function save(key: string, s: State): void {
  const was = load(key)
  const entries: Record<string, number> = {}
  for (const [h, t] of [...Object.entries(was?.entries ?? {}), ...Object.entries(s.entries ?? {})]) if (Date.now() - t <= ttlMs) entries[h] = Math.max(t, entries[h] ?? 0)
  const joins = s.joins || was?.joins || undefined
  const dropUnbound = s.dropUnbound || was?.dropUnbound || undefined
  writeFileSync(path.join(stateDir, `${key}.json`), JSON.stringify({ ...s, entries, thinking: { ...was?.thinking, ...s.thinking }, thinkingAfter: { ...was?.thinkingAfter, ...s.thinkingAfter }, calls: { ...s.calls, ...was?.calls }, joins, dropUnbound }))
}

// A conversation's internal IDs (summary.ts, turnsOf): the last one given,
// which every request and fork moves on, and each turn's, by the prompts up to
// it. Read and written at once, so requests in flight together never share
// one. `next` false only looks the turns up: a turn not yet seen has none (NaN).
type Ids = { last: number; turns: Record<string, number> }
const idsFile = (key: string) => path.join(stateDir, `${key}.ids.json`)
function idsOf(key: string, msgs: readonly ApiMsg[], next = true): { id: number; turns: Turn[] } {
  let ids: Ids = { last: 0, turns: {} }
  try {
    ids = JSON.parse(readFileSync(idsFile(key), 'utf8'))
  } catch {}
  const was = ids.last
  const turns = turnsOf(msgs, ids.turns, () => (next ? ++ids.last : NaN))
  if (!next) return { id: was, turns }
  if (ids.last === was) ids.last++
  writeFileSync(idsFile(key), JSON.stringify(ids))
  return { id: ids.last, turns }
}

// A conversation's records and their spend (info.ts).
const summariesOf = (key: string) => summariesIn(stateDir, key)
const loadSummaries = (key: string): Summaries => summariesFrom(stateDir, key)

// Each conversation's stats as its journal ends (journal.ts) and its cost so
// far (cost.ts), replayed from the journal the first time they're asked for and
// kept up as requests are answered.
// keep: the fold of the client's messages so far (compact-keep.ts), of which
// the journal holds only what it keeps.
type Current = { stats?: Stats; cost?: Cost; keep?: Keep }
const current = new Map<string, Current>()
const journalOf = (key: string) => journalIn(stateDir, key)
function currentOf(key: string): Current {
  let c = current.get(key)
  if (!c) current.set(key, (c = journaled(stateDir, key, ttlMs)))
  return c
}

// The requests answered since the proxy started that no journal line was
// written for, which `shaver info` and proxy.log report.
let missed = 0

// Journals a request the API answered, a client's or a fork's, and reports it
// missed if that wrote no line.
function journaling(to: string, f: () => void): void {
  const before = written
  try {
    f()
  } finally {
    if (written === before) {
      missed++
      console.error(`${new Date().toISOString()} shaver: journal missed a request to ${to}`)
    }
  }
}
const latestOf = (key: string) => currentOf(key).stats

// What a request becomes: the body to send, and what to record once it is
// answered.
// Why an answered request sent no summary fork: summaryForkOf's reasons, with
// the threshold the turns fell short of, or the proxy's own.
type Skip = (ForkSkip & { threshold?: number }) | { skip: 'side-request' | 'no-breakpoint' | 'in-flight' | 'turn-continues' | 'draining' }
type Prepared = { body: Buffer; key: string; proto: Protocol; model: string; provider?: string; applied: Clock; entries: Record<string, number>; touched: string[]; thinking: Record<string, number>; thinkingAfter: Record<string, string>; summarized: number; merged: number; offered?: number; skillList?: SkillList; summaryFork?: (tokens: number[]) => SummaryFork | Skip; stats?: Stats; sent: Sent; suggestion: boolean; logDir?: string; logLine?: Record<string, unknown>; counted?: (attribution: unknown) => Counted | undefined; messages: ApiMsg[]; freeze: Freeze; predicted: Predicted; refusals: Refusals }

// The cache read the proxy predicts for a request, in message characters out
// of `total`; and, where it carries an explicit breakpoint that reads further
// than lookback alone would, the read if the server ignored it (`unmarked`);
// the read with no lookback limit, where that's more (`unbounded`); and the
// items back from its breakpoint the read's entry is, where it isn't on it
// (`reach`).
type Predicted = { chars: number; total: number; unmarked?: number; unbounded?: number; reach?: number }

// How a request stands to the freeze: `frozen`, sent as the last that worked;
// `retry`, a shave tried while frozen; or neither. `gap` is the tokens the shave
// saves over the last shape, `differs` whether it changes it at all (so a
// refused one has that shape to fall back on), `unfrozen` why a freeze ended,
// and `frozen` the freeze to save once it's answered.
type Freeze = { mode?: 'frozen' | 'retry'; gap: number; differs: boolean; unfrozen?: 'restart' | 'retry-worked'; frozen?: Frozen }

// Trims a request, given as the core's (protocol.ts). Only requests with tools
// are trimmed: those are the main loop and subagents. Side requests (Claude
// Code's titles, Codex's compactions) are sent as they came, and journaled
// bare (journal.ts).
//
// Where the cache writes an entry at each request's end by itself (automatic),
// the anchors are explicit breakpoints where the protocol can mark one and
// that's turned on (breakpoints.ts), and otherwise there are none.
// `side` and `compaction` are whether the harness's headers say it's a side
// request, and its compaction, where they say (harness.ts). `freeze` sends it
// shaped as the last request that worked, as when frozen (Frozen).
function prepare(proto: Protocol, h: Harness | undefined, key: string, body: Canonical, { render, ids, counted }: Wire, params: Record<string, unknown>, now: number, side?: boolean, compaction?: boolean, req: { headers: IncomingHttpHeaders; upstream: string; launch?: LaunchVals } = { headers: {}, upstream: '' }, freeze = false, also: Refusals = {}): Prepared | undefined {
  const msgs: ApiMsg[] | undefined = body.messages
  if (!Array.isArray(msgs) || !msgs.length || !body.tools?.length) return
  const conv = h?.conventions ?? NO_CONVENTIONS
  const auto = proto.automatic
  const markable = auto && marking(body.model) ? proto.markable : undefined
  const s = load(key)
  // Over the messages as received, so a side request's ask is a turn too.
  const { id: requestId, turns } = idsOf(key, msgs)
  const suggestion = isSideRequest(msgs, side)
  const own = withoutSideRequest(msgs, side)
  const held = heldTo(s?.applied ?? { requests: 0, turns: 0 }, own)
  const clock = clockOf(own)
  const marked = markedTtl(body)
  const model = { ...modelOf(body.model, body.provider), ...(marked && { ttl: marked }) }
  // Where the client compacts, as its harness works it out (autocompact.ts):
  // null where it won't; else models.ts's figure, where that can't be said.
  const ac = autocompactAt(h?.name, { model: body.model, ...req })
  const compactAt = ac ? ac.at : model.compaction?.at
  const entries = Object.fromEntries(Object.entries(s?.entries ?? {}).filter(([, t]) => now - t <= lifetimeMs(model.ttl, ttlMs)))
  const live = new Set(Object.keys(entries))
  // What it takes out of the base: deferred tools, and skills off the list.
  const toolRules = toolRulesOf(policy, h?.name)
  const dropped = h && toolRules ? dropTools(body, toolRules, h.alwaysLoaded) : 0
  const deferred = proto.defers && h?.defers && toolRules ? forceDefer(body, toolRules, h.alwaysLoaded, proto.searchTool) : 0
  const skillList = skillListOf(s, live.size > 0, now)
  const { cut: skills, trimmed: skillsTrimmed } = skillList ? shaveSkills(body, skillList.rules) : { cut: 0 }
  const seed = seedOf(body.model, body.tools, body.system, !auto)
  const thinking = recordedOf(s)
  // The refusals saved, with any this request has had (`also`).
  const refusals: Refusals = { joins: s?.joins || also.joins, dropUnbound: s?.dropUnbound || also.dropUnbound }
  const joins = !!refusals.joins
  // The records it sends, and how many of them as the memoir: as sent before,
  // and on a cold cache, all there are.
  const file = summaryAt ? loadSummaries(key) : undefined
  const broke = file && chainBreak(file.chain, msgs, turns)
  if (broke) noteBreak(key, file.chain, broke)
  const chain = !file ? [] : file.chain.slice(0, broke ? broke.index : undefined)
  const before = Math.min(s?.summarized ?? 0, chain.length)
  const mergedBefore = Math.min(s?.merged ?? 0, before)
  let records = before
  let merged = mergedBefore
  let keep = summarized(apply(msgs, conversationRules, held, conv, thinking, joins), msgs, chain.slice(0, records), merged, turns)
  // The shape the last request that worked was sent in: what a freeze sends.
  const still = keep
  const cold = (ps: ReturnType<typeof positionsOf>) => ps.some((q) => q.breakpoint) && readThrough(ps, live, model.lookback) < 0
  // BACKCOMPAT(2026-11-22)
  //   Before: cache entries were named by the model, every tool definition and
  //   the whole system prompt (wholeSeedOf), so a deferred tool loading or a
  //   Claude Code update made the proxy lose track of what was cached.
  //   Shim: when a request looks cold under today's names, its entries are
  //   looked up under the old names and saved again under today's.
  //   Remove when: upgrading from before 2026-11-22 is no longer supported.
  //   Each install needs it for its first hour on newer code. Without it, each
  //   conversation's first request after the upgrade looks cold once:
  //   everything due is trimmed and every summary record is sent.
  const named = positionsOf(keep.msgs, seed, thinking, counting(model, auto))
  if (cold(named)) {
    const whole = positionsOf(keep.msgs, wholeSeedOf(body.model, body.tools, body.system), thinking, counting(model, auto))
    whole.forEach((q, i) => {
      if (q.prefix in entries && !(named[i].prefix in entries)) (entries[named[i].prefix] = entries[q.prefix]), live.add(named[i].prefix)
    })
  }
  const allMerged = Math.min(file?.merged ?? 0, chain.length)
  let covers: string[] | undefined
  if ((records < chain.length || merged < allMerged) && cold(positionsOf(keep.msgs, seed, thinking, counting(model, auto)))) {
    if (records < chain.length) covers = coveredBy(keep, msgs, chain, records, turns).map(keyOf)
    records = chain.length
    merged = allMerged
    keep = summarized(apply(msgs, conversationRules, held, conv, thinking, joins), msgs, chain, merged, turns)
  }
  // With force_trim_before_autocompact, a prompt within its proximity of the
  // client's own compaction is sent as a cold cache would send it, every
  // record and every trim due, whatever the cache, if that saves at least
  // its least saving: so once it has fired, it fires again only when that
  // much more has come due. Not on a side request, the compaction among
  // them: its messages are never sent again.
  const stats = latestOf(key)
  const ft = forcedTrimOf(policy)
  const at = ft && stats && !suggestion ? compactAt ?? undefined : undefined
  const near = at ? promptTokens(stats!, keep.msgs) : 0
  let forced: { before: number; after: number; next: typeof keep } | undefined
  let skipped: { before: number; after: number } | undefined
  if (at && near >= at - ft!.proximity) {
    const full = summarized(apply(msgs, conversationRules, clock, conv, thinking, joins),msgs, chain, allMerged, turns)
    const after = promptTokens(stats!, full.msgs)
    if (near - after < ft!.saves) skipped = { before: Math.round(near), after: Math.round(after) }
    else {
      if (records < chain.length) covers = coveredBy(keep, msgs, chain, records, turns).map(keyOf)
      records = chain.length
      merged = allMerged
      forced = { before: Math.round(near), after: Math.round(after), next: full }
    }
  }
  // One more breakpoint where the messages stop matching them settled
  // (anchored), unless it leaves less read from the cache. With automatic
  // caching, where the protocol can mark one, up to three explicit ones on
  // whichever messages it goes on, the kept and the trimmed alike, whatever
  // the lookback would read (trim.ts, liveEnd): at their last live entry,
  // where they stop matching them settled, and where they stop matching them
  // trimmed as far as this turn's requests take them.
  // The messages settled, and trimmed that far, are built once for each set of
  // records applied: with automatic caching every candidate's boundaries are
  // found against them.
  const settled = new Map<string, ApiMsg[]>()
  const inTurn = new Map<string, ApiMsg[]>()
  const endOf = (base: typeof keep) => {
    if (auto && !markable) return undefined
    const k = `${records} ${merged}`
    if (!settled.has(k)) settled.set(k, summarized(fullyTrimmed(msgs, conversationRules, conv, thinking, joins), msgs, chain.slice(0, records), merged, turns).msgs)
    return settledEnd(base.msgs, settled.get(k)!, seed, thinking, markable)
  }
  const turnEndOf = (base: typeof keep) => {
    const k = `${records} ${merged}`
    if (!inTurn.has(k)) inTurn.set(k, summarized(trimmedInTurn(msgs, conversationRules, clock.turns, conv, thinking, joins), msgs, chain.slice(0, records), merged, turns).msgs)
    return settledEnd(base.msgs, inTurn.get(k)!, seed, thinking, markable, true)
  }
  let end = endOf(keep)
  const marks = (v: unknown) => JSON.stringify(v ?? null).split('"cache_control"').length - 1
  const spare = 4 - [body.system, body.tools, msgs].reduce((n: number, v) => n + marks(v), 0)
  const freed = spare > 0 ? undefined : freedSystem(body.system)
  const reads = (m: ApiMsg[]) => {
    const ps = positionsOf(m, seed, thinking, counting(model, auto))
    return ps.slice(0, readThrough(ps, live, model.lookback) + 1).reduce((n, q) => n + q.size, 0)
  }
  const anchor = (base: typeof keep) => {
    const m = base.msgs
    if (markable) return [liveEnd(m, live, seed, thinking, markable), endOf(base), turnEndOf(base)].reduce((x, e) => anchored(x, e, seed, thinking, true), m)
    if (auto || (spare <= 0 && !freed)) return m
    const x = anchored(m, end, seed, thinking)
    return reads(x) >= reads(m) ? x : m
  }
  let sent = keep
  let applied = held
  let next = keep
  let d: Decision | undefined
  // A compaction's messages are never sent again, so a trim on it pays only
  // where it costs no more on this request: no later ones share its savings.
  const horizon = isCompaction(msgs, compaction) ? 0 : model.horizon(latestOf(key)?.requests ?? 0, clock.requests - held.requests)
  if (forced) [sent, applied, next] = [forced.next, clock, forced.next]
  else if (clock.requests > held.requests || clock.turns > held.turns) {
    next = summarized(apply(msgs, conversationRules, clock, conv, thinking, joins),msgs, chain.slice(0, records), merged, turns)
    d = decide(anchor(keep), anchor(next), live, seed, model, thinking, auto, horizon)
    if (d.advanced) [sent, applied] = [next, clock]
  }
  // Frozen, it's sent as the last that worked was, but tried shaved once the
  // shave saves RETRY_STEP more than when last refused. A freeze from before
  // the proxy started is over.
  const restarted = !!s?.frozen && s.frozen.started !== started
  const frozen = restarted ? undefined : s?.frozen
  const gap = stats && sent !== still ? Math.round(promptTokens(stats, still.msgs) - promptTokens(stats, sent.msgs)) : 0
  const mode = freeze || (frozen && gap < frozen.gap + RETRY_STEP) ? 'frozen' : frozen ? 'retry' : undefined
  const freezing: Freeze = { ...(mode && { mode }), gap, differs: sent !== still, ...(restarted && { unfrozen: 'restart' as const }), ...(mode === 'frozen' && frozen && { frozen }) }
  if (restarted && !freeze) console.error(`${new Date(now).toISOString()} shaver: shaving unfrozen for ${key}: the proxy restarted`)
  if (mode === 'frozen' && sent !== still) {
    ;[sent, applied, next, records, merged, forced, d, covers] = [still, held, still, before, mergedBefore, undefined, undefined, undefined]
    end = endOf(still)
  }
  body.messages = anchor(sent)
  if (freed && marks(body.messages) > marks(sent.msgs)) body.system = freed
  // The entries this request writes or reads.
  const pos = positionsOf(body.messages, seed, thinking, counting(model, auto))
  const r = readThrough(pos, live, model.lookback)
  const touched = entriesOf(pos, r)
  const charsTo = (r: number) => pos.slice(0, r + 1).reduce((n, q) => n + q.size, 0)
  const predicted: Predicted = { chars: charsTo(r), total: charsTo(pos.length - 1) }
  // How far back the read relies on the lookback, and what it would read
  // with none, so the audit can tell when the lookback counted is off.
  const reach = r < 0 ? 0 : reachOf(pos, r)
  if (reach) predicted.reach = reach
  const unbounded = charsTo(readThrough(pos, live, Infinity))
  if (unbounded > predicted.chars) predicted.unbounded = unbounded
  if (pos.some((q) => q.exact)) {
    const unmarked = charsTo(readThrough(pos.map((q) => (q.exact ? { ...q, breakpoint: false } : q)), live, model.lookback))
    if (unmarked < predicted.chars) predicted.unmarked = unmarked
  }
  // Where trimming ends in the messages as sent, which drops shorten.
  const ends = trimmedEnd(msgs, conversationRules, applied, conv, thinking)
  const sentEnd = (end: number) => sent.origin.filter((i) => i < end).length
  const trimmed = { tools: sentEnd(ends.tools), reasoning: sentEnd(ends.reasoning) }
  const time = new Date(now).toISOString()
  // A record takes its turns' prompts out of the messages; the stats count them still.
  const described = { ...describe(body, trimmed, time, !!forced || d?.advanced || records > before || merged > mergedBefore, conv, h?.alwaysLoaded), turns: msgs.filter(isPrompt).length }
  if (deferred + dropped) described.defs.deferred = deferred + dropped
  if (skills) described.defs.skills = skills
  if (skillsTrimmed) splitShaved(described, skillsTrimmed)
  described.defs.shaves = { tools: hash(JSON.stringify(toolRules ?? [])), skills: hash(JSON.stringify(skillList?.rules ?? [])) }
  if (marked) described.ttl = marked
  if (ac) described.compactAt = ac.at
  if (req.launch?.ENABLE_TOOL_SEARCH !== undefined) described.toolSearchEnv = req.launch.ENABLE_TOOL_SEARCH
  if (ac?.window) described.window = ac.window
  if (ac?.guessed) described.windowGuessed = true
  if (covers) described.covers = covers
  const last = latestOf(key)
  // The newest tool call, by which a conversation going on in another session
  // is known as this one's (journal.ts, LastCalls); and on the first request,
  // whether this one goes on from one so, looked up before this one's call is
  // set, which may be the same.
  const calls = callIdsOf(msgs)
  const from = last || !calls.length ? undefined : lastCalls.continuedFrom(key, calls)
  if (from) described.from = from
  if (calls.length) {
    described.lastCall = calls.at(-1)
    lastCalls.set(key, calls.at(-1)!)
  }
  // What Claude Code's compaction would keep of its messages, folded on from
  // the last request's, each file's modification time looked up as its call
  // is answered (Claude Code's paths are absolute; the proxy is on its machine).
  if (h?.name === 'claude') {
    const c = currentOf(key)
    c.keep = folded(c.keep ?? last?.keep, own, mtimeOf, ccVersion(body.system))
    described.keep = kept(c.keep)
  }
  if (isCompaction(msgs, compaction)) described.compaction = true
  if (compactedSince(last, body.messages)) described.compacted = true
  // Each record is dated by the first message it covers, the memoir by its first record's.
  const starts = startsOf(msgs, chain.slice(0, records), turns)
  described.messages.filter((q) => q.kinds.memoir).forEach((q) => (q.born = bornFrom(latestOf(key), msgs, starts[0])))
  described.messages.filter((q) => q.kinds.summary).forEach((q, k) => (q.born = bornFrom(latestOf(key), msgs, starts[merged + k])))
  if (suggestion) described.suggestion = true
  const after = summaryAt && (model.summaryThreshold ?? summaryAt)
  // Whether to send a summary fork is known once the response's counts are in;
  // with none, why.
  const summaryFork = after
    ? (tokens: number[]): SummaryFork | Skip => {
        if (suggestion) return { skip: 'side-request' }
        if (!pos.some((q) => q.breakpoint)) return { skip: 'no-breakpoint' }
        // Whether the last fork offered made the last record, still in the messages.
        const recorded = !broke && file?.recordedAt !== undefined && file.recordedAt === s?.offered
        const f = summaryForkOf(sent, msgs, chain, s?.offered ?? 0, after, thinking, tokens, (m) => bornOf(latestOf(key), m), turns, recorded)
        return 'skip' in f && f.tokens !== undefined ? { ...f, threshold: after } : f
      }
    : undefined
  const p: Prepared = { body: Buffer.from(JSON.stringify(render(body))), key, proto, model: body.model, provider: body.provider, applied, entries, touched, thinking: s?.thinking ?? {}, thinkingAfter: s?.thinkingAfter ?? {}, summarized: records, merged, offered: s?.offered, skillList, summaryFork, stats: latestOf(key), sent: described, suggestion, messages: body.messages, freeze: freezing, predicted, refusals,...(counted && { counted: (at: unknown) => counted(body.messages, at) }) }
  if (a['log-step-events']) {
    p.logDir = path.join(logRoot, key)
    if (forced) writeLine(p.logDir, { event: 'autocompact-trim', time, at, beforeTokens: forced.before, afterTokens: forced.after, requests: clock.requests, turns: clock.turns })
    // A forced trim not sent: even in full it would save too little.
    if (skipped) writeLine(p.logDir, { event: 'autocompact-skip', time, at, beforeTokens: skipped.before, afterTokens: skipped.after, minSavedTokens: ft!.saves, requests: clock.requests, turns: clock.turns })
    if (d?.savedChars) {
      const context: Record<string, number> = {}
      for (const m of keep.msgs) for (const [k, n] of Object.entries(kinds(JSON.stringify(m), m).kinds)) context[k] = (context[k] ?? 0) + n
      writeLine(p.logDir, {
        event: 'compaction',
        time,
        advanced: d.advanced,
        cacheState: d.cold ? 'cold' : 'warm',
        savedChars: d.savedChars,
        rewriteChars: d.rewriteChars,
        extraChars: d.extraChars,
        requests: clock.requests,
        turns: clock.turns,
        transitions: transitions(keep, next),
        context,
        // To test the anchor breakpoint's efficacy: the decision without it,
        // or the entry it keeps, which lookback would otherwise still find.
        // Remove this (and the logged field) once we're confident in it.
        unanchored: (({ advanced, extraChars }) => ({ advanced, extraChars }))(decide(keep.msgs, next.msgs, new Set([...live].filter((e) => e !== end)), seed, model, thinking, auto, horizon)),
      })
    }
    const predictedCachedChars = predicted.chars
    // The messages as the client sent them, when they went up changed, so
    // what was taken (a newest answer's thinking, say) can be rebuilt.
    const changed = msgs.length !== body.messages.length || msgs.some((m, i) => JSON.stringify(m) !== JSON.stringify(body.messages[i]))
    p.logLine = { event: 'request', time, version, policy: writePolicy(p.logDir, policy), model: body.model, provider: body.provider, protocol: proto.name, params, ...(records && { summaries: records }), predictedCachedChars, ...(predicted.unmarked !== undefined && { predictedUnmarkedChars: predicted.unmarked }), breakpoints: pos.filter((q) => q.breakpoint).length, trimmedEnd: trimmed, id: requestId, turns: turns.map((t) => t.id), ...(ids && { headIds: ids.head }), messages: writeMessages(p.logDir, body.messages, conv.kinds, ids?.of), ...(changed && { received: writeMessages(p.logDir, msgs, conv.kinds).map((q) => q.hash) }), ...writeDefs(p.logDir, body as Parameters<typeof writeDefs>[1]) }
  }
  return p
}

// A conversation's key, which names its state, journal and log dir. A
// conversation is one message history that only grows: the proxy's applied
// clock counts requests and turns into it, and its cache entries are prefixes of
// it, so neither means anything for another history. The protocol makes the
// key unique among the conversations it serves (harness.ts, conversationId).

// The answer to `shaver policy`: the policy file as it is now, which may differ
// from what was loaded at startup if it was edited since.
function policyText(): string {
  try {
    return '`' + a.policy + '`:\n```json\n' + readFileSync(a.policy, 'utf8').trimEnd() + '\n```'
  } catch {
    return `Shaver policy file not found, should be at ${a.policy}`
  }
}

// The answer to `shaver info`: the conversation's latest answered request,
// from its journal (stats.ts), or before there is one, this request estimated
// as it will be sent once the command is answered, tools deferred.
function stats(proto: Protocol, h: Harness | undefined, key: string, body: Canonical): string {
  const sent = structuredClone({ ...body, messages: withoutPending(body.messages) })
  const toolRules = toolRulesOf(policy, h?.name)
  if (h && toolRules) dropTools(sent, toolRules, h.alwaysLoaded)
  if (proto.defers && h?.defers && toolRules) forceDefer(sent, toolRules, h.alwaysLoaded, proto.searchTool)
  const trimmed = policy.skill_shaver_rules ? shaveSkills(sent, policy.skill_shaver_rules).trimmed : undefined
  const { stats: s, cost: c } = currentOf(key)
  // `shaver optimize`'s requests are one-time work, so they aren't counted.
  const sums = loadSummaries(key)
  const valid = validChain(sums.chain, sent.messages, idsOf(key, sent.messages, false).turns).length
  const searchOff = h?.name === 'claude' && !searchOn(body, proto.searchTool)
  const live = { valid, inFlight: summaryForking.has(key), missed, ignoredMarks: ignoredMarks(journalOf(key)), searchOff }
  const others = othersOf(stateDir, key, currentOf)
  if (s) return infoText(key, version, s, false, c, sums, load(key)?.summarized ?? 0, live, others)
  const described = describe(sent, { tools: 0, reasoning: 0 }, new Date().toISOString(), false, h?.conventions ?? NO_CONVENTIONS, h?.alwaysLoaded)
  if (trimmed) splitShaved(described, trimmed)
  return infoText(key, version, estimate(described), true, c, sums, load(key)?.summarized ?? 0, live, others)
}

// What each thinking block of a response bills when sent back: the output
// tokens less the visible content's worth, shared among its blocks by
// signature length.
function thinkingOf(u: Usage | undefined, c: Content): Record<string, number> {
  const sigs = c.signatures.filter(Boolean)
  const total = sigs.reduce((n, sg) => n + sg.length, 0)
  if (!u?.output_tokens || !total) return {}
  const tokens = Math.max(0, u.output_tokens - TEXT_TOKENS * c.visibleChars)
  return Object.fromEntries(sigs.map((sg) => [hash(sg), Math.round((tokens * sg.length) / total)]))
}

// What each thinking block sent back billed, where the API counted it, in
// place of thinkingOf's guess: its count less its visible text's worth, which
// trim.ts's sizeOf counts apart.
function billedThinking(msgs: readonly ApiMsg[], billed: ReadonlyMap<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of msgs)
    for (const b of blocks(m)) {
      const n = typeof b.signature === 'string' ? billed.get(b.signature) : undefined
      if (b.type === 'thinking' && n !== undefined) out[hash(String(b.signature))] = Math.max(0, Math.round(n - TEXT_TOKENS * (JSON.stringify(b).length - String(b.signature).length)))
    }
  return out
}

// With the proxy's own header from bin/claude-via-shaver (autocompact.ts).
const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'keep-alive', 'upgrade'])
// The account's usage limits from the latest answer each protocol's API sent,
// which Claude Code shows in the status line. Answers made here carry them
// too, or the status line loses them for that turn.
const limits = new Map<Protocol, Record<string, string>>()
// The headers a request is sent on with: the client's, but for hop-by-hop
// ones, and the encoding of a body the proxy decompressed.
function forwarded(from: IncomingHttpHeaders, zstd: boolean): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(from)) if (!HOP.has(k) && !(zstd && k === 'content-encoding') && v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v
  return headers
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

function refuse(res: ServerResponse, proto: Protocol, status: 400 | 403, message: string): void {
  console.error(message)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(proto.error(status, message))
}

// Responses tool-search probes: this Codex request with the policy's
// deferrals, and tiny standalone ones (the client-executed round trip, a
// search the backend runs, and deferral inside a namespace) that take only
// its route, auth and model.
async function probeCodexToolSearch(context: { target: string; headers: Record<string, string>; model: string; real?: { body: Canonical; render: Wire['render']; rules: readonly ToolRule[]; always: readonly string[] } }): Promise<Record<string, unknown>> {
  const functionTool = {
    type: 'function', name: 'shaver_probe_confirm', description: 'Confirms this tool-search probe.', defer_loading: true,
    parameters: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false },
  }
  // A search the client answers, which both of Codex's routes accept.
  const searchTool = {
    type: 'tool_search', execution: 'client', description: 'Find tools to use for the current task.',
    parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'], additionalProperties: false },
  }
  const usage: Record<string, Record<string, number>> = {}
  const send = async (stage: string, body: Record<string, unknown>) => {
    const response = await fetch(context.target, {
      method: 'POST', headers: context.headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    })
    const text = await response.text()
    let data: any
    try { data = JSON.parse(text) } catch {
      // Codex's Responses backend requires streaming. Read its terminal event
      // into the same shape as a non-streaming Responses object; its output can
      // be empty with the items sent only as their own events.
      const items: unknown[] = []
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('data: ')) continue
        try {
          const event = JSON.parse(line.slice(6))
          if (event.type === 'response.completed' || event.type === 'response.failed' || event.type === 'response.incomplete') data = event.response
          else if (event.type === 'response.output_item.done') items.push(event.item)
          else if (event.type === 'error') data = { error: event.error }
        } catch { /* ignore non-JSON SSE data */ }
      }
      if (data && !data.output?.length && items.length) data.output = items
    }
    if (data?.usage) {
      const u = data.usage
      usage[stage] = Object.fromEntries(['input_tokens', 'input_tokens_details', 'output_tokens', 'total_tokens'].flatMap((k) =>
        typeof u[k] === 'number' ? [[k, u[k]]] : k === 'input_tokens_details' && typeof u[k]?.cached_tokens === 'number' ? [['cached_input_tokens', u[k].cached_tokens]] : []))
    }
    return { response, text, data }
  }
  const base = { model: context.model, store: false, stream: true, parallel_tool_calls: false, max_output_tokens: 48, reasoning: { context: 'all_turns' } }
  const ask = (text: string) => [{ role: 'user', content: [{ type: 'input_text', text }] }]
  // A search the backend runs itself, with no client round trip: execution
  // left off, and asked for as server.
  const hosted = async (stage: string, tool: Record<string, unknown>) => {
    try {
      const r = await send(stage, { ...base, input: ask('Find the harmless probe function and call it with marker set to probe.'), tools: [tool, functionTool], tool_choice: 'required' })
      if (!r.response.ok) return { http: r.response.status, error: r.data?.error?.message ?? r.text.slice(0, 1000) }
      return { output: r.data?.output?.map((item: any) => ({ type: item.type, name: item.name, execution: item.execution, status: item.status })) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  // Whether a deferred function inside a namespace, as Codex sends its tools,
  // is hidden: its input tokens should match the request without it.
  const nested = async (stage: string, tools: unknown[]) => {
    try {
      const r = await send(stage, { ...base, input: ask('Reply with ok.'), tools: [searchTool, ...tools] })
      return r.response.ok ? usage[stage]?.input_tokens : { http: r.response.status, error: r.data?.error?.message ?? r.text.slice(0, 1000) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  // The search the client answers, as Codex does.
  const client = async (): Promise<Record<string, unknown>> => {
    try {
      const first = await send('search', { ...base, input: ask('Find the harmless probe function so I can confirm tool search works.'), tools: [searchTool, functionTool], tool_choice: 'required' })
      if (!first.response.ok) return { result: 'rejected', stage: 'search', status: first.response.status, error: first.data?.error?.message ?? first.text.slice(0, 1000) }
      const searchCall = first.data?.output?.find((item: any) => item.type === 'tool_search_call' && item.execution === 'client')
      if (!searchCall?.call_id) return { result: 'inconclusive', stage: 'search', detail: 'Response did not contain a client tool_search_call.' }
      // The call as the backend sent it, which Codex answers: it names the field
      // the search is asked in.
      const search_call = Object.fromEntries(Object.entries(searchCall).filter(([k]) => !['id', 'call_id'].includes(k)))
      const second = await send('confirmation', {
        ...base,
        input: [
          ...first.data.output,
          { type: 'tool_search_output', execution: 'client', call_id: searchCall.call_id, status: 'completed', tools: [functionTool] },
          ...ask('Call shaver_probe_confirm now with marker set to probe.'),
        ],
        tool_choice: { type: 'function', name: 'shaver_probe_confirm' },
      })
      if (!second.response.ok) return { result: 'rejected', stage: 'confirmation', status: second.response.status, error: second.data?.error?.message ?? second.text.slice(0, 1000), search_call }
      const confirmed = second.data?.output?.some((item: any) => item.type === 'function_call' && item.name === 'shaver_probe_confirm')
      return { result: confirmed ? 'supported' : 'inconclusive', detail: confirmed ? 'Client tool-search round trip returned the probe function call; it was not executed.' : 'Follow-up did not return the probe function call.', response_status: second.data?.status, incomplete_details: second.data?.incomplete_details, error: second.data?.error, output: second.data?.output?.map((item: any) => ({ type: item.type, name: item.name, status: item.status })), search_call }
    } catch (error) {
      return { result: 'error', detail: error instanceof Error ? error.message : String(error) }
    }
  }
  // This Codex request as the proxy sends it, with one short message for its
  // history: the input tokens with the policy's deferrals and without, where
  // each deferred tool sits, and what the model does when asked for one.
  const real = async (): Promise<Record<string, unknown>> => {
    if (!context.real) return { result: 'skipped' }
    const { body, render, rules, always } = context.real
    const tools = (body.tools ?? []).map(({ defer_loading, ...t }) => t)
    const deferred = { ...body, tools: [...tools] }
    if (!forceDefer(deferred, rules, always, searchTool)) return { result: 'inconclusive', detail: 'The policy defers none of this request\'s tools.' }
    const names = (deferred.tools ?? []).filter((t) => t.defer_loading).map((t) => t.name)
    const loaded = { ...deferred, tools: (deferred.tools ?? []).map(({ defer_loading, ...t }) => t) }
    const asked = (c: Canonical, text: string) => render({ ...c, messages: [{ role: 'user', content: [{ type: 'text', text }] }] }) as any
    const sent = asked(deferred, 'Reply with ok.')
    const where: unknown[] = []
    const walk = (list: any[], at: string, prefix = '') => list.forEach((t) => t.type === 'namespace' && t.tools
      ? walk(t.tools, at, `${prefix}${t.name}.`)
      : names.includes(`${prefix}${t.name ?? t.type}`) && where.push({ name: `${prefix}${t.name ?? t.type}`, at, defer_loading: t.defer_loading ?? false }))
    walk(sent.tools ?? [], 'tools')
    for (const it of sent.input ?? []) if (it.type === 'additional_tools') walk(it.tools ?? [], 'input additional_tools')
    const tokens = async (stage: string, wire: any) => {
      const r = await send(stage, { ...wire, store: false, stream: true, max_output_tokens: 48 })
      return r.response.ok ? usage[stage]?.input_tokens : { http: r.response.status, error: r.data?.error?.message ?? r.text.slice(0, 1000) }
    }
    const call = async (stage: string, wire: any) => {
      const r = await send(stage, { ...wire, store: false, stream: true, max_output_tokens: 400 })
      return r.response.ok ? r.data?.output?.map((item: any) => ({ type: item.type, name: item.name, namespace: item.namespace, execution: item.execution })) : { http: r.response.status, error: r.data?.error?.message ?? r.text.slice(0, 1000) }
    }
    const ask = `Call your ${names[0]} tool now, with any valid arguments.`
    try {
      const input_tokens = { deferred: await tokens('real_deferred', sent), loaded: await tokens('real_loaded', asked(loaded, 'Reply with ok.')) }
      const asked_for = { tool: names[0], deferred: await call('real_asked', asked(deferred, ask)) }
      return { deferred: names, where, input_tokens, asked_for, detail: 'Deferral works if its input tokens are well below loaded, and asked_for starts with a tool_search_call.' }
    } catch (error) {
      return { result: 'error', detail: error instanceof Error ? error.message : String(error) }
    }
  }
  const loadedTool = { ...functionTool, defer_loading: undefined }
  const space = (tool: unknown) => ({ type: 'namespace', name: 'shaver_probe', description: 'Probe tools.', tools: [tool] })
  return {
    real: await real(),
    client: await client(),
    hosted: { bare: await hosted('hosted_bare', { type: 'tool_search' }), server: await hosted('hosted_server', { type: 'tool_search', execution: 'server' }) },
    namespace: {
      input_tokens: { none: await nested('nested_none', []), deferred: await nested('nested_deferred', [space(functionTool)]), loaded: await nested('nested_loaded', [space(loadedTool)]) },
      detail: 'Deferral inside a namespace works if deferred is near none and well below loaded.',
    },
    usage,
  }
}

// Codex's remote compaction, which is sent on as it came and journaled bare
// (not shaved: its answer replaces the history, so the history it's given is
// Codex's own).
const compacts = (url: string) => /^(\/v1)?\/responses\/compact$/.test(url.split('?')[0])

// The protocol a path is, after any /via/; Messages for any other path, which
// is passed through. ChatGPT's backend for Codex runs no tool search itself,
// so nothing is deferred there.
const protocolOf = (url: string, upstream = '') => {
  const p = compacts(url) ? RESPONSES : ([MESSAGES, CHAT, RESPONSES].find((p) => p.serves(url.split('?')[0])) ?? MESSAGES)
  return p === RESPONSES && /^https:\/\/chatgpt\.com(\/|$)/.test(upstream) ? { ...p, defers: false } : p
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const arrived = Date.now()
  // Codex's OpenAI provider compresses what it sends with zstd; it's read here
  // and sent on as it reads.
  const zstd = req.headers['content-encoding'] === 'zstd'
  const received = await readBody(req)
  const original = zstd ? zstdDecompressSync(received) : received
  let raw = original
  const r = route(req.url ?? '/', a.upstream)
  const proto = 'error' in r ? protocolOf('/') : protocolOf(r.url, r.upstream)
  if (!localHost(req.headers.host)) return refuse(res, proto, 403, `shaver proxy: refused a request for Host ${req.headers.host}`)
  if ('error' in r) return refuse(res, proto, 400, `shaver proxy: ${r.error}`)
  const { upstream, url } = r
  const h = harnessOf(r.harness, req.headers)
  if (h && 'error' in h) return refuse(res, proto, 400, `shaver proxy: ${h.error}`)
  // bin/run-proxy --restart and --stop stop the proxy with this. The header
  // keeps a web page from sending it: browsers send a custom header only after a
  // CORS check this proxy doesn't answer.
  if (req.method === 'POST' && url === '/shaver/shutdown' && req.headers['x-shaver'] === 'shutdown') {
    console.error('shaver: shutting down, as asked')
    return void res.end('stopping\n', () => process.exit(0))
  }
  // bin/run-proxy --when-idle asks this instead, to restart without cutting
  // off a reply or a summary fork; asked again, it's still the one drain.
  if (req.method === 'POST' && url === '/shaver/shutdown' && req.headers['x-shaver'] === 'drain') {
    if (!draining) console.error(`shaver: draining, as asked: ${open - 1} other requests open, ${summaryForking.size} summary forks running`)
    draining = true
    return void res.end('draining\n')
  }
  // bin/run-proxy asks this to tell whether the proxy on its port runs from its
  // repo (one from elsewhere is restarted, keeping logging) and from its commit.
  if (req.method === 'GET' && url === '/shaver/procinfo' && req.headers['x-shaver'] === 'procinfo') {
    return void res.end(`shaver repo: ${path.resolve(import.meta.dirname, '..')}\nshaver commit: ${commit}\nshaver logging: ${a['log-step-events'] ? 'on' : 'off'}\nshaver drains: yes\n`)
  }
  // A WebSocket a client tries first (Codex's and OpenCode's OpenAI providers)
  // is refused with 426, which sends it straight to HTTP: Codex retried a
  // refused one for ~8s first. Codex over WebSockets sends only what's new.
  if (req.headers.upgrade) return void res.writeHead(426).end()
  // While draining, a request is turned away to be retried, by when the proxy
  // replacing this one is usually up. Codex waits exactly the Retry-After a
  // fixed number of times, so 1s ran out after 95s; 5s outlasted a 3-minute
  // drain in both Codex and Claude Code, which retries for about 3 minutes
  // whatever it says.
  if (draining) {
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5', connection: 'close' })
    return void res.end(proto.error(503, 'shaver proxy: restarting; retry shortly'))
  }
  if (passthrough) return relay(req, res, received, original, upstream, url, proto, h)
  let p: Prepared | undefined
  // The request prepared again, shaped as the last that worked (Frozen).
  let again: (() => Prepared | undefined) | undefined
  // The request prepared again as first, under rules a refusal turned on.
  let rejoin: (() => Prepared | undefined) | undefined
  // Whether a prepared request sends the client's own system, tools and
  // messages, cache breakpoints aside: then a refusal of what's in them is the
  // client's doing, not the proxy's.
  let unchanged: ((q: Prepared) => boolean) | undefined
  // The conversation whose waiting commands are answered if this request's
  // response ends the turn, and the request as forwarded.
  let turnEnd: { key: string; body: Canonical; render: Wire['render'] } | undefined
  // Why a request the API answers would be journaled bare, if it's sent as it came.
  const compaction = compacts(url)
  let why: Why = compaction ? 'compaction' : 'side'
  let c: ReturnType<Protocol['canonical']> | undefined
  let params: Record<string, unknown> = {}
  // The conversation's key, from the messages as the client sent them, before any are stripped (harness.ts).
  let key: string | undefined
  // The harness's own headers, logged, and whether they say it's a side request.
  const logged = h && loggedHeaders(h, req.headers)
  const side = h?.side?.(req.headers)
  const served = req.method === 'POST' && (compaction || proto.serves(url.split('?')[0])) && raw.length > 0
  if (served) {
    // `shaver` commands are answered here; answered ones are stripped (command.ts).
    try {
      const wire = JSON.parse(raw.toString('utf8'))
      params = paramsOf(wire)
      c = proto.canonical(wire)
    } catch (err) {
      why = 'unread'
      console.error('shaver: request not read:', err)
    }
    const body = c?.body
    key = body && Array.isArray(body.messages) && body.messages.length ? conversationId(h, proto.name, body, req.headers) : undefined
    try {
      if (c && body && key && !compaction) {
        const msgs = stripCommands(body.messages)
        // Read before stripping: an answer to `shaver optimize` is one only after its reply.
        const command = body.tools?.length && pendingCommand(body.messages)
        if (command) {
          const r = proto.replying(body.model, !!body.stream, latestOf(key)?.inputTokens ?? 0, (body as { safeguards?: unknown }).safeguards)
          res.writeHead(200, { ...limits.get(proto), 'content-type': body.stream ? 'text/event-stream' : 'application/json' })
          res.write(r.start)
          // What an answer says before it's done shows at once in a stream.
          let said = ''
          const say = (t: string) => {
            said += t
            res.write(r.text(t))
          }
          const text = await answerOf(command, proto, h, key, { ...body, messages: msgs }, c.render, upstream + url, forwarded(req.headers, zstd), say).catch(internalError)
          return void res.end(r.text(text) + r.end(said + text))
        }
        // Commands sent mid-turn wait for a response that ends the turn.
        const mid = body.tools?.length ? midTurnCommands(body.messages) : []
        if (mid.length || waiting.size) {
          if (mid.length) waiting.set(key, [...(waiting.get(key) ?? []), ...mid])
          if (body.stream && waiting.has(key)) turnEnd = { key, body: structuredClone({ ...body, messages: msgs }), render: c.render }
        }
        if (msgs.length < body.messages.length || msgs.some((m, i) => m !== body.messages[i])) {
          body.messages = msgs
          raw = Buffer.from(JSON.stringify(c.render(body)))
        }
      }
    } catch (err) {
      console.error('shaver: commands left in:', err)
    }
    try {
      if (c && body && key && !compaction) {
        const k = key
        // Prepared again, it keeps the refusals the request has had so far.
        const prep = (w: NonNullable<typeof c>, freeze: boolean, also: Refusals = {}) => {
          const q = prepare(proto, h, k, w.body, w, params, Date.now(), side, h?.compaction?.(req.headers), { headers: req.headers, upstream, launch: r.launch ? loadLaunch(a.dir, r.launch) : undefined }, freeze, also)
          if (q?.logLine && logged) q.logLine.headers = logged
          return q
        }
        // The body as read, for preparing again: prepare changes the one it's given.
        const read = raw
        again = () => {
          try {
            return prep(proto.canonical(JSON.parse(read.toString('utf8'))), true, p?.refusals)
          } catch (err) {
            console.error('shaver: frozen request not prepared:', err)
          }
        }
        rejoin = () => {
          try {
            return prep(proto.canonical(JSON.parse(read.toString('utf8'))), false, { ...p?.refusals, joins: true })
          } catch (err) {
            console.error('shaver: request not prepared again:', err)
          }
        }
        unchanged = (q) => {
          const bare = (b: Buffer) => {
            const { system, tools, messages } = proto.canonical(JSON.parse(b.toString('utf8'))).body as Record<string, unknown>
            return JSON.stringify({ system, tools, messages }, (k, v) => (k === 'cache_control' ? undefined : v))
          }
          try {
            return bare(q.body) === bare(read)
          } catch {
            return false
          }
        }
        p = prep(c, false)
      }
    } catch (err) {
      why = 'untrimmed'
      console.error('shaver: request left untrimmed:', err)
    }
  }
  const headers = forwarded(req.headers, zstd)
  const abort = new AbortController()
  const usage = proto.usageReader()
  // A client that leaves once its answer is complete hasn't interrupted it:
  // Codex closes before the stream's last bytes, which are still read for the
  // usage.
  res.on('close', () => res.writableFinished || usage.done || abort.abort())
  // A served Messages request may ask for unbound thinking to be dropped (binding.ts).
  // A Responses one may carry explicit breakpoints (breakpoints.ts).
  const sender = served && proto.name === 'messages' ? fetchBound : proto.markable ? fetchMarked : fetch
  // `q`, the request prepared, says whether its conversation asks drop_block.
  const send = (body: Buffer | undefined, q?: Prepared) => {
    const init = { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body, signal: abort.signal }
    return sender === fetchBound ? fetchBound(upstream + url, init, !!q?.refusals.dropUnbound) : sender(upstream + url, init)
  }
  if (p?.freeze.mode === 'retry') console.error(`${new Date().toISOString()} shaver: shave tried again for ${p.key}, frozen since ${load(p.key)?.frozen?.since}: it saves ${p.freeze.gap} tokens a request`)
  let up = await send(p?.body ?? raw, p)
  // What was sent, in order, and how each went: the request shaved or frozen
  // (Frozen), then the original.
  const attempts: { sent: 'shaved' | 'frozen' | 'original'; status: number }[] = []
  const shapeOf = (q: Prepared | undefined) => (q?.freeze.mode === 'frozen' ? 'frozen' : 'shaved')
  // A changed request the API refuses is sent again as it came, so the proxy
  // never costs the user a turn, and journaled as resent.
  let resent: Prepared | undefined
  // The key a request is journaled bare under: its conversation's, or, with
  // none prepared, its side key. One not read has no conversation to go
  // with, so its harness's own.
  const bareKey = () => (p ?? resent)?.key ?? (key ? sideKey(stateDir, key) : `${h?.name ?? proto.name}-unread`)
  // A request the API refused is logged with what it asked for and the
  // API's answer, whether or not it's sent again.
  const failed = (status: number, text: string, more?: Record<string, unknown>) =>
    a['log-step-events'] && served && writeLine(path.join(logRoot, bareKey()), { event: 'failed', time: new Date(arrived).toISOString(), model: c?.body.model ?? 'unknown', provider: c?.body.provider, protocol: proto.name, params, status, error: text.slice(0, 2000), ...more })
  if ((p || raw !== original) && up.status === 400) {
    let text = await up.text()
    let shape = shapeOf(p)
    attempts.push({ sent: shape, status: 400 })
    // A shave refused for thinking it unbound turns on asking the API to drop
    // such thinking, for the rest of the conversation (binding.ts, Refusals),
    // and is sent again asking. So does a request the proxy left as it came,
    // as when Claude Code compacts and keeps thinking from before: the client
    // sends that thinking again, so the conversation's later requests need
    // the setting too. Then it's logged as the client's refusal (cause:
    // 'client'), not the shave's.
    if (p && sender === fetchBound && !p.refusals.dropUnbound && !dropUnbound.on && !dropUnbound.never && UNBOUND.test(text)) {
      p.refusals.dropUnbound = true
      const own = unchanged?.(p) ?? false
      console.error(`${new Date().toISOString()} shaver: ${own ? "client's request, sent unchanged," : 'shaved request'} refused for ${p.key} for thinking ${own ? 'the client' : 'it'} unbound; sent again asking the API to drop unbound thinking, and so for the rest of the conversation`)
      failed(400, text, { sent: shape, ...(own && { cause: 'client' }) })
      up = await send(p.body, p)
      attempts.push({ sent: shape, status: up.status })
      if (up.status === 400) text = await up.text()
    }
    // A drop refused for joining thinking to thinking turns on the rule that
    // keeps such calls, stubbed, for the rest of the conversation (trim.ts,
    // Refusals), and the request is trimmed again under it and sent.
    if (p && !p.refusals.joins && JOINED.test(text)) {
      console.error(`${new Date().toISOString()} shaver: shaved request refused for ${p.key} for thinking joined to thinking; trimmed again keeping such calls, stubbed, and so for the rest of the conversation`)
      failed(400, text, { sent: shape })
      const q = rejoin?.()
      if (q) {
        up = await send(q.body, q)
        attempts.push({ sent: shapeOf(q), status: up.status })
        p = q
        if (up.status === 400) text = await up.text()
      }
    }
    // A shave refused is sent as the last that worked, if that differs, and
    // the conversation's shaving frozen (Frozen).
    const q = up.status === 400 && p?.freeze.differs && p.freeze.mode !== 'frozen' ? again?.() : undefined
    if (p && q) {
      console.error(`${new Date().toISOString()} shaver: shaved request refused for ${p.key}, sent as the last that worked, shaving frozen (${p.freeze.gap} tokens a request not saved): ${errorShape(text)}`)
      failed(400, text, { sent: shape })
      const was = load(p.key)?.frozen
      q.freeze.frozen = { since: was?.started === started ? was.since : new Date(arrived).toISOString(), gap: q.freeze.gap, started, error: apiError(text) }
      up = await send(q.body, q)
      attempts.push({ sent: 'frozen', status: up.status })
      if (up.status !== 400) p = q
      else [text, shape] = [await up.text(), 'frozen']
    }
    if (up.status === 400) {
      console.error(`shaver: changed request refused, sent as it came: ${errorShape(text)}`)
      failed(up.status, text, { resent: true, sent: shape })
      ;[resent, p] = [p, undefined]
      up = await send(original)
      attempts.push({ sent: 'original', status: up.status })
    }
  } else if (p) attempts.push({ sent: shapeOf(p), status: up.status })
  // A shave tried while frozen and taken ends the freeze.
  if (p?.freeze.mode === 'retry' && up.status === 200) {
    p.freeze.unfrozen = 'retry-worked'
    console.error(`${new Date().toISOString()} shaver: shaving unfrozen for ${p.key}: the shave was taken (${p.freeze.gap} tokens a request saved)`)
  }
  const freezeLog = (q: Prepared | undefined) => q && (q.freeze.mode || q.freeze.unfrozen || attempts.length > 1) && { freeze: { ...(q.freeze.mode && { mode: q.freeze.mode }), gap: q.freeze.gap, ...(q.freeze.unfrozen && { unfrozen: q.freeze.unfrozen }), ...(q.freeze.frozen && { frozenSince: q.freeze.frozen.since }), attempts } }
  if (p?.logLine) Object.assign(p.logLine, freezeLog(p))
  const out = answerHeaders(up)
  const re = proto.limits
  if (re && up.status === 200 && Object.keys(out).some((k) => re.test(k))) limits.set(proto, Object.fromEntries(Object.entries(out).filter(([k]) => re.test(k))))
  // An error answer goes to proxy.log whether or not requests are logged, by
  // its shape only, since its text can quote the request; the step events,
  // with them logged, have the text.
  if (up.status >= 400) {
    const text = Buffer.from(await up.arrayBuffer())
    console.error(`${new Date().toISOString()} shaver: upstream answered ${up.status} to ${req.method} ${upstream}${url.split('?')[0]}: ${errorShape(text.toString('utf8'))}`)
    failed(up.status, text.toString('utf8'))
    res.writeHead(up.status, out)
    return void res.end(text)
  }
  res.writeHead(up.status, out)
  // The answer's state is saved once it is complete, before the client sees
  // its end: Codex sends the next request then, before the stream closes.
  // Every request the API answers is journaled: as answered once its answer
  // is complete, and bare when it was sent as it came or cut off, with the
  // usage read by then. A cut-off request leaves the state as it was, so its
  // trim is decided again and journaled with the next.
  let finished = false
  const finish = (cut: boolean) => {
    if (finished || !served || up.status !== 200) return
    finished = true
    // Its log says whether unbound thinking was asked to be dropped (binding.ts).
    const asked = dropAsked(up) ? { dropAsked: true } : undefined
    for (const q of [p, resent]) if (asked && q?.logLine) Object.assign(q.logLine, asked)
    journaling(url.split('?')[0], () => {
      const body = c?.body
      // A request sent as the client sent it, not as the proxy prepared it,
      // is logged with its messages whole.
      const whole = (event: string): WholeLog | undefined => (a['log-step-events'] && body ? { dir: path.join(logRoot, bareKey()), event, side: body, named: h?.conventions.kinds, protocol: proto.name, params, headers: logged, more: asked } : undefined)
      if (p && !cut) answered(p, usage, upstream + url, headers)
      else if (resent && !cut) {
        const w = whole('resent')
        answeredResent(resent, usage, w && { ...w, more: { ...asked, ...freezeLog(resent) } })
      }
      else {
        const q = p ?? resent
        const u = usage.end().usage
        const provider = q ? q.provider : body?.provider
        const b: BareLine = { time: q?.sent.time ?? new Date(arrived).toISOString(), model: q?.model ?? body?.model ?? 'unknown', ...(provider && { provider }), ...(u && { usage: u }), why: cut ? 'cut off' : why }
        const log = !a['log-step-events'] ? undefined : q ? q.logLine && { dir: q.logDir!, line: q.logLine } : whole('side')
        answeredBare(bareKey(), b, log)
      }
    })
  }
  // A response ending the turn gets the answers to the commands sent during
  // it, after the request is journaled, so `shaver info` counts it.
  const write = (s: string | Uint8Array) => res.destroyed || res.write(s)
  // A frozen conversation's turn ends with a warning that says so.
  const warning = p?.freeze.frozen && c?.body.stream ? frozenWarning(p.freeze.frozen, p.freeze.gap) : undefined
  const held = (turnEnd || warning) && proto.holdClose(write)
  try {
    if (up.body)
      for await (const chunk of up.body) {
        usage.push(chunk)
        if (usage.done) finish(false)
        if (held) held.push(chunk)
        else write(chunk)
      }
  } catch (err) {
    finish(true)
    throw err
  }
  if (held) {
    finish(false)
    if (held.ended && warning && !res.destroyed) write(held.add(warning))
    const commands = turnEnd && waiting.get(turnEnd.key)
    if (turnEnd && held.ended && commands && !res.destroyed) {
      waiting.delete(turnEnd.key)
      for (const command of commands) {
        let said = ''
        const text = await answerOf(command, proto, h, turnEnd.key, turnEnd.body, turnEnd.render, upstream + url, headers, (t) => (said += t)).catch(internalError)
        write(held.add(answeredMidTurn(command) + said + text))
      }
    }
    write(held.rest())
  }
  // An answer that isn't streamed is complete only here; it is journaled
  // before its end goes out, as a stream's is above.
  finish(false)
  res.end()
}

// The headers an answer goes back with: the API's, but for those of its
// encoding and length, which fetch has undone.
function answerHeaders(up: Response): Record<string, string> {
  const out: Record<string, string> = {}
  up.headers.forEach((v, k) => {
    if (k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding') out[k] = v
  })
  return out
}

// A request in passthrough mode (SHAVER_MODE): sent on byte for byte as it
// came, still compressed if it was, with the client's headers but hop-by-hop
// ones, and its answer passed back as it comes. Nothing of shaving is done:
// no trim, breakpoint, resend, fork, freeze or warning, and no `shaver`
// command is answered, so the API gets those as typed. No state is kept.
// With logging, a request the API answers or refuses gets a `passthrough`
// line in its conversation's log, its messages whole, with its usage or the
// API's error; `cut` marks one the client left before its answer was done.
// Kept apart from handle so shaving changes there can't reach it.
async function relay(req: IncomingMessage, res: ServerResponse, received: Buffer, read: Buffer, upstream: string, url: string, proto: Protocol, h: Harness | undefined): Promise<void> {
  const abort = new AbortController()
  const usage = proto.usageReader()
  res.on('close', () => res.writableFinished || usage.done || abort.abort())
  const time = new Date().toISOString()
  const up = await fetch(upstream + url, { method: req.method, headers: forwarded(req.headers, false), body: req.method === 'GET' || req.method === 'HEAD' ? undefined : received, signal: abort.signal })
  // Logged once: when the answer is complete, cut off or refused.
  const served = req.method === 'POST' && (compacts(url) || proto.serves(url.split('?')[0])) && read.length > 0
  let logged = false
  const log = (fields: () => Record<string, unknown>) => {
    if (logged || !served || !a['log-step-events']) return
    logged = true
    try {
      const more = fields()
      const wire = JSON.parse(read.toString('utf8'))
      const { body } = proto.canonical(wire)
      if (!Array.isArray(body.messages) || !body.messages.length) return
      const dir = path.join(logRoot, conversationId(h, proto.name, body, req.headers))
      const headers = h && loggedHeaders(h, req.headers)
      writeWhole({ dir, event: 'passthrough', side: body, named: h?.conventions.kinds, protocol: proto.name, params: paramsOf(wire), headers, more: { version, ...more } }, { time, model: body.model ?? 'unknown', provider: body.provider }, undefined)
    } catch (err) {
      console.error('shaver: passthrough request not logged:', err)
    }
  }
  const out = answerHeaders(up)
  if (up.status >= 400) {
    const text = Buffer.from(await up.arrayBuffer())
    console.error(`${new Date().toISOString()} shaver: upstream answered ${up.status} to ${req.method} ${upstream}${url.split('?')[0]}: ${errorShape(text.toString('utf8'))}`)
    log(() => ({ status: up.status, error: text.toString('utf8').slice(0, 2000) }))
    res.writeHead(up.status, out)
    return void res.end(text)
  }
  res.writeHead(up.status, out)
  const counts = (cut: boolean) => () => {
    const { usage: u, failure } = usage.end()
    return { status: up.status, ...usageFields(u), ...(failure && { failure }), ...(cut && { cut: true }) }
  }
  try {
    if (up.body)
      for await (const chunk of up.body) {
        usage.push(chunk)
        if (usage.done) log(counts(false))
        if (!res.destroyed) res.write(chunk)
      }
  } catch (err) {
    log(counts(true))
    throw err
  }
  log(counts(false))
  res.end()
}

// What answers a command, for the request `body` of conversation `key`, the
// command stripped; `say` gets any text ready before the rest, which follows it.
async function answerOf(command: string, proto: Protocol, h: Harness | undefined, key: string, body: Canonical, render: Wire['render'], target: string, headers: Record<string, string>, say: (text: string) => void): Promise<string> {
  if (command.startsWith(':shaver optimize')) return optimize(command, proto, h, key, body, render, target, headers, say)
  if (command === ':shaver probe-codex-tool-search') {
    if (proto.name !== 'responses' || h?.name !== 'codex') return 'This probe is available only through a Codex Responses session.'
    const probeHeaders = { ...headers }
    for (const name of ['accept', 'accept-encoding', 'content-length', 'content-type', 'host', 'connection']) delete probeHeaders[name]
    probeHeaders['content-type'] = 'application/json'
    probeHeaders.accept = 'application/json'
    const rules = toolRulesOf(policy, h.name)
    const result = await probeCodexToolSearch({ target, headers: probeHeaders, model: body.model, ...(rules && { real: { body, render, rules, always: h.alwaysLoaded } }) })
    return 'Codex tool-search probe:\n```json\n' + JSON.stringify(result, null, 2) + '\n```'
  }
  if (command === ':shaver policy') return policyText()
  if (command === ':shaver info all') return '```\n' + totals(stateDir, ttlMs) + '\n```'
  return stats(proto, h, key, body)
}

// Records an answered request: its stats, cost and cache entries, the
// conversation's state, any summary fork due and its log line.
function answered(p: Prepared, usage: UsageReader, target: string, headers: Record<string, string>): void {
  const { usage: u, content, attribution, reply, served, transformations, dropped, failure } = usage.end()
  // How the response said it failed goes in its log line, answered or bare.
  if (failure && p.logLine) p.logLine.failure = failure
  const now = Date.now()
  const entries = { ...p.entries, ...Object.fromEntries(p.touched.map((h) => [h, now])) }
  const inputTokens = u ? u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0
  // With no usage there are no counts to take the stats on from, so it's
  // journaled bare, and like one cut off leaves the state as it was, but with
  // automatic caching for its cache entries: the API answered, so it read the
  // prompt and cached it (on sol a request after one that failed partway read
  // it all). Breakpoint caching isn't known to do the same.
  if (!u || !inputTokens) {
    const state = p.proto.automatic ? load(p.key) : undefined
    if (state) save(p.key, { ...state, entries: Object.fromEntries(p.touched.map((h) => [h, now])) })
    return answeredBare(p.key, { time: p.sent.time, model: p.model, ...(p.provider && { provider: p.provider }), why: 'no usage' }, p.logLine && { dir: p.logDir!, line: p.logLine })
  }
  const c = attribution !== undefined ? p.counted?.(attribution) : undefined
  // Thinking sent unbound was dropped as if the API had said so (trim.ts,
  // unboundIn), and a Messages response's thinking is bound to what was sent,
  // unless that ends in a reply the response goes on.
  const unbound = unboundIn(p.messages, Object.assign(new Map(), { after: new Map(Object.entries(p.thinkingAfter)) }))
  const lost = [...new Set([...(dropped ?? []), ...p.messages.flatMap((m, i) => (blocks(m).some((b) => unbound.has(b)) ? [i] : []))])]
  const after = p.proto.name === 'messages' && p.messages.at(-1)?.role === 'user' ? prefixesOf(p.messages) : undefined
  const thinkingAfter = after ? Object.fromEntries(content.signatures.filter(Boolean).map((sg) => [hash(sg), after])) : {}
  const next = observe(p.stats, p.sent, inputTokens, u.output_tokens ?? 0, c && { defs: c.head, messages: c.messages, kinds: c.kinds }, lost, u.output_tokens_details?.thinking_tokens)
  const was = currentOf(p.key)
  record(journalOf(p.key), was.stats, next, u, cacheRead(p.predicted, next, u.cache_read_input_tokens ?? 0))
  current.set(p.key, { stats: next, cost: add(was.cost, was.stats, next, u, ttlMs) })
  // Where the protocol gives the reply, a fork asks as the user's next prompt
  // would, after a reply that ended the turn; so not while the turn goes on.
  const check = p.summaryFork && (draining ? { skip: 'draining' as const } : summaryForking.has(p.key) ? { skip: 'in-flight' as const } : reply?.ended === false ? { skip: 'turn-continues' as const } : p.summaryFork(textTokens(p.sent, next.tokens)))
  const due = check && !('skip' in check) ? check : undefined
  save(p.key, { applied: p.applied, entries, thinking: { ...p.thinking, ...thinkingOf(u, content), ...(c && billedThinking(p.messages, c.reasoning)) }, thinkingAfter: { ...p.thinkingAfter, ...thinkingAfter }, calls: c && Object.fromEntries(c.calls), summarized: p.summarized, merged: p.merged, offered: due?.current ?? p.offered, skillList: p.skillList, frozen: p.freeze.frozen, ...p.refusals })
  // A reply with no text leaves the instructions where they'd go without one.
  if (due) void summarize(p, due, target, headers, reply?.text.some((t) => t.trim()) ? reply.text : undefined)
  if (p.logDir && p.logLine) writeLine(p.logDir, { ...withReceivedDelta(p.logDir, p.logLine), ...usageFields(u), ...(attribution !== undefined && { attribution }), ...(served && { served }), ...(transformations && { inputTransformations: transformations }), ...(check && { summaryCheck: due ? 'sent' : check }) })
}

// A log line's counts from a request's usage.
const usageFields = (u: Usage | undefined) =>
  u && {
    inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    cachedTokens: u.cache_read_input_tokens ?? 0,
    writtenTokens60m: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    writtenTokens5m: (u.cache_creation_input_tokens ?? 0) - (u.cache_creation?.ephemeral_1h_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    ...(u.server_tool_use?.web_search_requests && { webSearches: u.server_tool_use.web_search_requests }),
  }

// Records a request answered as it came after its changed form was refused:
// its line in the journal and its cost. The proxy's state stays as it was,
// since none of this request's trim went up. A conversation with no journal
// yet has no stats to count it in, so it's journaled bare.
function answeredResent(p: Prepared, usage: UsageReader, log?: WholeLog): void {
  const { usage: u, failure } = usage.end()
  const was = currentOf(p.key)
  const b: BareLine = { time: p.sent.time, model: p.model, ...(p.provider && { provider: p.provider }), ...(u && { usage: u }), why: u ? 'resent' : 'no usage' }
  if (log && failure) log.more = { ...log.more, failure }
  if (!u || !was.stats) return answeredBare(p.key, b, log)
  const stats = recordResent(journalOf(p.key), was.stats, new Date().toISOString(), u, p.sent.compaction)
  current.set(p.key, { stats, cost: addResent(was.cost, stats, u) })
  if (log) writeWhole(log, b, usageFields(u))
}

// A request logged with its messages whole, as an event of its own: a side
// request, or one resent as it came.
type WholeLog = { dir: string; event: string; side: Canonical; named?: Conventions['kinds']; protocol: string; params: Record<string, unknown>; headers?: Record<string, string>; more?: Record<string, unknown> }

const writeWhole = (log: WholeLog, b: Pick<BareLine, 'time' | 'model' | 'provider'>, counts: Record<string, unknown> | undefined) =>
  writeLine(log.dir, { event: log.event, time: b.time, model: b.model, provider: b.provider, protocol: log.protocol, params: log.params, ...(log.headers && { headers: log.headers }), messages: writeMessages(log.dir, log.side.messages, log.named), ...writeDefs(log.dir, log.side as Parameters<typeof writeDefs>[1]), ...log.more, ...counts })

// The warning a frozen conversation's turns end with, for the user; taken out
// of later requests like a command's answer (command.ts).
// SHAVER_BUG_REPORT_URL, when set, is where it asks for reports.
const bugReportUrl = process.env.SHAVER_BUG_REPORT_URL || 'https://github.com/chris-prince/context-shaver/issues'
const updateCommand = `${path.resolve(import.meta.dirname, '..', 'bin', 'run-proxy')} --update`
const frozenWarning = (f: Frozen, gap: number) => {
  const since = new Date(f.since)
  return (
    WARNING +
    `shaving is paused for this session, and your context is ${Math.round(gap / 1000)}k tokens larger than it otherwise would be.\n\n` +
    `At ${localTime(since)}, the API refused a request that the shaver had modified, with this error:\n${f.error}\n\n` +
    'To let you keep working, new shaves are paused. Anything shaved before the error will remain shaved, but nothing new will be removed. Shaver will periodically show this warning if the problem continues.\n\n' +
    `Please report this problem at ${bugReportUrl} and include the full contents of this warning message. When you're told a fix is available, run ${updateCommand} to install it.`
  )
}

// A time as "3:18 AM on Sun. 2026-11-08", in the proxy's local time.
function localTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const day = d.toLocaleDateString('en-US', { weekday: 'short' })
  return `${time} on ${day}. ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// What the API said refusing a request, for the user: its error's message,
// cut short.
function apiError(text: string): string {
  let m: unknown
  try {
    m = JSON.parse(text)?.error?.message
  } catch {}
  return (typeof m === 'string' ? m : errorShape(text)).slice(0, 500)
}

// Records a request journaled bare (journal.ts): its line and its cost, and
// with logging its log line. A request the proxy prepared is logged as
// requests are, marked bare; one sent as it came with its messages whole,
// so the logs' request lines stay the conversation's.
function answeredBare(key: string, b: BareLine, log?: { dir: string; line: Record<string, unknown> } | WholeLog): void {
  const was = currentOf(key)
  recordBare(journalOf(key), b)
  current.set(key, { ...was, cost: addBare(was.cost, b) })
  if (!log) return
  const counts = { ...usageFields(b.usage), bare: b.why }
  if ('line' in log) writeLine(log.dir, { ...withReceivedDelta(log.dir, log.line), ...counts })
  else writeWhole(log, b, counts)
}

// The conversations with a summary fork under way, which get no second one.
const summaryForking = new Set<string>()
// Requests handle is still on, and whether a drain was asked for
// (bin/run-proxy --when-idle): then new requests are turned away (handle), no
// summary fork starts, and the proxy exits once no request is open and no
// fork runs, for run-proxy to start the one replacing it.
let open = 0
let draining = false
function drained(): void {
  if (!draining || open || summaryForking.size) return
  console.error('shaver: drained, exiting')
  process.exit(0)
}

// An error from a fork, marked with the step it failed at, and the response's
// body when it had one.
type Staged = Error & { stage: string; body?: string }
const staged = (err: unknown, stage: string, body?: string): Staged => Object.assign(err instanceof Error ? err : new Error(String(err)), { stage, ...(body !== undefined && { body }) })

// Sends a request the proxy makes of its own, a fork, and journals it as
// finish journals a client's: once the API answers 200, before the answer is
// used, with the usage its protocol reads in it, or marked cut off or no usage.
// Gives the answer and that usage; throws for any other status. With
// logging, each fork is logged as a `fork` line, whatever it answers.
async function forked(p: Pick<Prepared, 'key' | 'proto' | 'model' | 'provider'>, kind: ForkKind, body: Canonical, target: string, headers: Record<string, string>): Promise<{ text: string; usage?: Usage }> {
  const time = new Date().toISOString()
  // A fork is a request of the conversation's too: it has an internal ID.
  const { id } = idsOf(p.key, [])
  const log = (fields: Record<string, unknown>) =>
    a['log-step-events'] && writeLine(path.join(logRoot, p.key), { event: 'fork', kind, id, time, model: p.model, provider: p.provider, protocol: p.proto.name, params: paramsOf(body), ...fields })
  let r: Response
  try {
    r = await (p.proto.name === 'messages' ? fetchBound : fetch)(target, { method: 'POST', headers: { ...headers, accept: body.stream ? 'text/event-stream' : 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) })
  } catch (err) {
    log({ error: String(err).slice(0, 2000) })
    throw staged(err, 'fetch')
  }
  if (r.status !== 200) {
    const error = await r.text()
    log({ status: r.status, error: error.slice(0, 2000) })
    throw staged(new Error(`${r.status} ${error.slice(0, 500)}`), 'status', error)
  }
  let text: string | undefined
  let usage: Usage | undefined
  try {
    text = await r.text()
    const reader = p.proto.usageReader()
    reader.push(Buffer.from(text))
    usage = reader.end().usage
  } catch (err) {
    throw staged(err, text === undefined ? 'read' : 'usage', text)
  } finally {
    const why = text === undefined ? 'cut off' : 'no usage'
    const line: ForkLine = { time: new Date().toISOString(), kind, model: p.model, ...(p.provider && { provider: p.provider }), ...(usage ? { usage } : { why }) }
    journaling(`a ${kind} fork`, () => recordFork(journalOf(p.key), line))
    log({ status: r.status, ...(usage ? usageFields(usage) : { why }) })
  }
  return { text, usage }
}

// A summary fork's error for proxy.log, with nothing of the conversation: an
// upstream's error body or a parser's message can quote what it was sent or
// couldn't read, so only the error's name, its code, the status, and where in
// the code it was thrown. The whole error goes to the step events.
function bare(err: unknown): string {
  if (!(err instanceof Error)) return typeof err
  const code = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code
  const status = (err as Partial<Staged>).stage === 'status' ? /^\d{3}/.exec(err.message)?.[0] : undefined
  const frame = err.stack?.split('\n').find((l) => /^\s+at /.test(l))?.trim()
  return [err.name, typeof code === 'string' && code, status && `status ${status}`, frame].filter(Boolean).join(', ')
}

// Saves the last summary fork of a conversation that gave no record.
// A summary request's end, in the records file: what `change` makes of it,
// and its outcome counted.
function ended(key: string, outcome: Outcome, change: (s: Summaries) => Partial<Summaries> = () => ({})): void {
  const s = loadSummaries(key)
  writeFileSync(summariesOf(key), JSON.stringify({ ...s, ...change(s), outcomes: { ...s.outcomes, [outcome]: (s.outcomes?.[outcome] ?? 0) + 1 } }))
}
const failedFork = (key: string, failed: NonNullable<Forks['failed']> & { outcome: 'rejected' | 'failed' }) => ended(key, failed.outcome, () => ({ failed }))

// Saves a summary fork's response body that gave no record, beside the
// conversation's log, to read or parse again; gives its path there.
function savedAnswer(dir: string, time: string, body: string): string {
  const name = `forks/summary-${time.replace(/[:.]/g, '-')}.txt`
  mkdirSync(path.join(dir, 'forks'), { recursive: true })
  writeFileSync(path.join(dir, name), body)
  return name
}

// Logs where a conversation's records stopped fitting its messages, once
// for each way they're seen to break: always to proxy.log, and with logging,
// as a `summary-dropped` line. The records from there on are left out.
const breaks = new Map<string, string>()
function noteBreak(key: string, chain: readonly Summary[], b: { index: number; found?: string }): void {
  const seen = `${chain.length}:${b.index}:${b.found ?? ''}`
  if (breaks.get(key) === seen) return
  breaks.set(key, seen)
  const s = chain[b.index]
  console.error(`shaver: summary records for ${key}: ${chain.length - b.index} of ${chain.length} no longer fit, from record ${b.index + 1}, which ends before [${s.endsBefore}]: that turn's prompt ${b.found ? 'changed' : 'is gone'}`)
  if (a['log-step-events']) writeLine(path.join(logRoot, key), { event: 'summary-dropped', time: new Date().toISOString(), index: b.index, dropped: chain.length - b.index, records: chain.length, endsBefore: s.endsBefore, stored: s.prompt, found: b.found ?? null })
}

// Sends a summary fork of an answered request for a record of its turns
// (summary.ts): the request as sent, with the instructions asked after it, in
// its protocol's form, not streamed. Its cost goes to the conversation's
// records whatever it answers. Its record follows the ones the summary fork
// started after; any later ones no longer fit the messages. Then the oldest
// go into the memoir, if the records hold too many tokens.
async function summarize(p: Prepared, f: SummaryFork, target: string, headers: Record<string, string>, reply?: string[]): Promise<void> {
  const { key, logDir } = p
  summaryForking.add(key)
  const began = Date.now()
  const body = p.proto.summaryFork(JSON.parse(p.body.toString('utf8')), instructions(f, reply !== undefined), reply)
  const asked = { start: f.start, current: f.current, maxTokens: body.max_tokens, thinking: body.thinking }
  const before = loadSummaries(key)
  writeFileSync(summariesOf(key), JSON.stringify({ ...before, requests: before.requests + 1 }))
  const what = `shaver: summary fork for ${key}, turns ${f.start}-${f.current}:`
  // The step it's at, and the answer and why it stopped, once they're known.
  let stage = 'request'
  let answer: string | undefined
  let stop: string | undefined
  try {
    const { text, usage } = await forked(p, 'summary', body, target, headers)
    answer = text
    stage = 'write'
    if (usage) {
      const s = loadSummaries(key)
      writeFileSync(summariesOf(key), JSON.stringify({ ...s, spent: s.spent + spent(p.model, p.provider, usage) }))
    }
    stage = 'parse'
    const out = p.proto.summaryForkAnswer(text)
    stop = out.stop
    const time = new Date().toISOString()
    stage = 'record'
    // An answer cut off partway keeps its whole arcs (summary.ts, salvagedOf).
    const whole = recordOf(out.content, f, time, usage?.output_tokens)
    const record = whole ?? salvagedOf(out.content, f, time, stop, usage?.output_tokens)
    const salvaged = !whole && !!record
    // Nothing complete yet is the answer the instructions ask for then.
    const none = !record && nothingComplete(out.content, f)
    const rejected = record || none ? undefined : rejectionOf(out.content, f)
    const outcome: Outcome = salvaged ? 'salvaged' : record ? 'recorded' : none ? 'nothing-complete' : 'rejected'
    // Arcs written past the record's end, which the instructions ask for none of.
    const cutArcs = arcsPastEnd(out.content, f)
    stage = 'write'
    let merged: number | undefined
    if (record)
      ended(key, outcome, (s) => {
        const chain = [...s.chain.filter((r) => r.endsBefore <= f.start), record]
        merged = memoirAt ? mergedOf(chain, s.merged ?? 0, memoirAt) : 0
        // A salvage is shown as the last failure (shaver info), by its stop reason.
        const failed = salvaged ? { failed: { time, outcome: 'salvaged', reason: stop ?? 'unknown' } } : {}
        return { chain, merged, recordedAt: f.current, ...failed }
      })
    else if (none) ended(key, outcome)
    else failedFork(key, { time, outcome: 'rejected', reason: rejected?.reason ?? 'unknown' })
    const tokens = usage ? `, ${usage.output_tokens} output tokens` : ''
    // proxy.log has problems only: a fork that recorded is in the step events.
    if (rejected) console.error(`${what} rejected, ${rejected?.reason}${tokens}, stopped: ${stop ?? 'unknown'}`)
    if (salvaged) console.error(`${what} cut off (${stop})${tokens}; kept its whole arcs, ending before [${record!.endsBefore}]`)
    if (cutArcs.length && rejected?.reason !== 'arcs-past-end') console.error(`${what} wrote arcs past its end, ${cutArcs.map((id) => `[${id}]`).join(', ')}; left them out`)
    if (record && !record.arcs) console.error(`${what} kept without arcs: its headings don't fit its turns`)
    if (logDir) {
      // The answer is saved wherever it departs from the instructions, for scripts/audit.ts.
      const saved = salvaged || cutArcs.length || (record && !record.arcs)
      const why = rejected ? { reason: rejected.reason, ...(rejected.endsBefore !== undefined && { foundEndsBefore: rejected.endsBefore }), answer: savedAnswer(logDir, time, text) } : saved ? { answer: savedAnswer(logDir, time, text) } : undefined
      writeLine(logDir, { event: 'summary', time, outcome, ...asked, ms: Date.now() - began, endsBefore: record?.endsBefore, chars: record?.text.length ?? 0, arcs: record && (record.arcs?.length ?? 'unparsed'), merged, usage, stop, ...(cutArcs.length && { cutArcs }), ...why })
    }
  } catch (err) {
    const time = new Date().toISOString()
    const at = (err as Partial<Staged>).stage ?? stage
    const body = (err as Partial<Staged>).body ?? answer
    const error = String((err instanceof Error && err.stack) || err)
    console.error(`${what} failed at ${at}: ${bare(err)}`)
    try {
      failedFork(key, { time, outcome: 'failed', reason: at })
    } catch (e) {
      console.error(`${what} its failure could not be saved:`, e)
    }
    if (logDir) writeLine(logDir, { event: 'summary', time, outcome: 'failed', stage: at, ...asked, ms: Date.now() - began, stop, error: error.slice(0, 4000), ...(body !== undefined && { answer: savedAnswer(logDir, time, body) }) })
  } finally {
    summaryForking.delete(key)
    drained()
  }
}

// `shaver optimize` (optimize.ts) measures here, asks the session's own model
// for the skills' lines, and puts the items picked in the policy, in memory
// and on disk, for every session the proxy serves, at once.

// What it asked last, waiting for an answer in the conversation it asked in.
let proposal: Proposal | undefined

// The skills part of the offer in the conversation `key`, worked out while
// the tools are chosen: what it has said so far, shown with it, and where it
// says the rest once the tools are answered.
let skillsLater: { key: string; skills: Promise<Skills>; said: string; say?: (text: string) => void } | undefined

// Shows what `later` said so far with `say`, and the rest as it is said.
function sayingTo(later: NonNullable<typeof skillsLater>, say: (text: string) => void) {
  if (later.said) say(later.said)
  later.say = say
}

// Commands sent mid-turn, by conversation, waiting for a response that ends
// the turn (command.ts). Kept in memory, so a restart drops them.
const waiting = new Map<string, string[]>()

// When lines were last applied: a conversation that took its skill rules
// before then takes the policy's on its next request, warm or not.
let skillsForcedAt = 0

// The request's base as the proxy sends it, through the message holding the
// skill list, with the skill rules the session sends it with, or `rules`, and
// the policy's tool rules, or `tools`. Forks start from it, so they read what
// the session has cached of it.
function baseOf(proto: Protocol, h: Harness | undefined, key: string, body: Canonical, render: Wire['render'], rules = sessionRules(key, body), tools = toolRulesOf(policy, h?.name)): Record<string, unknown> {
  return render(canonicalBase(proto, h, key, body, rules, tools)) as Record<string, unknown>
}

function canonicalBase(proto: Protocol, h: Harness | undefined, key: string, body: Canonical, rules = sessionRules(key, body), tools = toolRulesOf(policy, h?.name)): Canonical {
  const fork: Canonical = structuredClone({ ...body, messages: body.messages.slice(0, Math.max(listMessage(body), toolListMessage(body)) + 1) })
  if (h && tools) dropTools(fork, tools, h.alwaysLoaded)
  if (proto.defers && h?.defers && tools) forceDefer(fork, tools, h.alwaysLoaded, proto.searchTool)
  if (rules) shaveSkills(fork, rules)
  return fork
}

function sessionRules(key: string, body: Canonical): readonly SkillRule[] | undefined {
  const now = Date.now()
  const s = load(key)
  const ttl = modelOf(body.model, body.provider).ttl
  return skillListOf(s, Object.values(s?.entries ?? {}).some((t) => now - t <= lifetimeMs(ttl, ttlMs)), now)?.rules
}

// The tokens a base holds, as its protocol's usage reports them: it is sent
// with a short question after it, so its answer costs little, and the
// question after the old and new bases alike drops out of their difference.
// No breakpoint is added at the base's end: Claude Code marks it only in a
// conversation's first request, and the next request after the lines change
// has none there to read an entry written at it.
async function promptOf(proto: Protocol, key: string, body: Canonical, base: Record<string, unknown>, target: string, headers: Record<string, string>): Promise<{ tokens: number; usage: Usage }> {
  const ask = proto.summaryFork(base, 'Reply with only: OK')
  if (proto === MESSAGES) ask.max_tokens = 16
  const { usage } = await forked({ key, proto, model: body.model, provider: body.provider }, 'optimize', ask, target, headers)
  if (!usage) throw new Error('no usage in the answer')
  return { tokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), usage }
}

const UNRETRIEVED = 'Shaver unable to retrieve skill details.'

// A command's answer threw: a bug, shown rather than breaking the stream.
function internalError(err: unknown): string {
  console.error('shaver: answering a command failed:', err)
  return `Shaver internal error: ${err instanceof Error ? err.message : err}`
}

async function optimize(command: string, proto: Protocol, h: Harness | undefined, key: string, body: Canonical, render: Wire['render'], target: string, headers: Record<string, string>, say: (text: string) => void): Promise<string> {
  if (command !== ':shaver optimize') {
    const shown = proposal?.key === key ? proposal : undefined
    if (!shown) return NOTHING
    // From the file as it is now, so edits by hand since the proxy started stay.
    let text: string
    try {
      text = readFileSync(a.policy, 'utf8')
    } catch {
      text = '{}\n'
    }
    const { reply, text: written, next } = afterAnswer(shown, command.slice(':shaver optimize '.length), text, a.policy)
    if (written !== text) {
      const now = parsePolicy(JSON.parse(written))
      writeFileSync(a.policy, written)
      if (shown.asking === 'skills') {
        policy.skill_shaver_rules = now.skill_shaver_rules
        skillsForcedAt = Date.now()
      } else policy.tool_shaver_rules = now.tool_shaver_rules
    }
    proposal = next
    const later = skillsLater?.key === key ? skillsLater : undefined
    if (shown.asking !== 'tools' || next?.asking !== 'skills' || !later) return reply
    say(`${reply}\n\n`)
    sayingTo(later, say)
    const asked = skillsAsked(next, await later.skills)
    proposal = asked.next
    skillsLater = undefined
    return asked.reply
  }
  // The tool rules as they are now, so a tools answer given while the skills
  // are measured doesn't change their base.
  const now = toolRulesOf(policy, h?.name) ?? []
  // Each base is measured from the journal's counts of the base as sent
  // (stats.ts, tokensOf), or sent, if the journal lacks them.
  const sent = (c: Canonical) => describe(c, { tools: 0, reasoning: 0 }, '', false, h?.conventions ?? NO_CONVENTIONS)
  const s = currentOf(key).stats
  const asSent = sent(canonicalBase(proto, h, key, body, undefined, now))
  const recorded = s && tokensOf(s, asSent, asSent) !== undefined ? s : undefined
  const measure = async (rules?: readonly SkillRule[], tools = now): Promise<{ tokens: number }> => {
    const fork = canonicalBase(proto, h, key, body, rules, tools)
    return recorded ? { tokens: Math.round(tokensOf(recorded, asSent, sent(fork))!) } : promptOf(proto, key, body, render(fork) as Record<string, unknown>, target, headers)
  }
  let base: ReturnType<typeof measure> | undefined
  const old = () => (base ??= measure())
  // The skills' lines are asked for while the tools are measured and chosen.
  const later = { key, said: '' } as NonNullable<typeof skillsLater>
  const relay = (text: string) => {
    later.said += text
    later.say?.(text)
  }
  const offer = toolOffer(proto, h, body)
  if (typeof offer !== 'string') say(ANALYZING_TOOLS)
  later.skills = skillsStage(proto, h, key, body, render, target, headers, relay, old, measure).catch((err) => ({ text: internalError(err), skills: [], lines: {}, trimmed: [] }))
  const none: Proposal = { key, asking: 'tools', tools: offer, skills: [], lines: {}, trimmed: [] }
  if (typeof offer === 'string') {
    say(`${offer}\n\n`)
    sayingTo(later, say)
    const { reply, next } = skillsAsked(none, await later.skills)
    proposal = next
    return reply
  }
  // The base as sent, without the offered tools, with none shaved, and with
  // the action done to all.
  const dropped = withPicked(now, offer.names, new Set(offer.names), 'drop', h!.alwaysLoaded)
  const measured = await Promise.all([old(), measure(undefined, dropped), measure(undefined, []), measure(undefined, offer.all)])
    .then(([o, w, whole, all]) => ({ own: o.tokens - w.tokens, blocked: whole.tokens - o.tokens, more: o.tokens - all.tokens }), (err: Error) => err)
  const { reply, next } = toolsAsked(key, { harness: h!, action: offer.action, names: offer.names, chosen: offer.chosen, text: toolsText(offer.names, offer.chosen, measured, offer.action) })!
  proposal = next
  skillsLater = later
  return reply
}

// The tools `shaver optimize` asks about deferring, or dropping where they
// can't be deferred, those the policy does that to already, and the rules
// doing it to them all, or why there are none.
function toolOffer(proto: Protocol, h: Harness | undefined, body: Canonical): { action: 'defer' | 'drop'; names: string[]; chosen: string[]; all: ToolRule[] } | string {
  // Responses with deferring off is ChatGPT's backend for Codex (protocolOf),
  // which runs no tool searches, so its tools can only be dropped.
  const action = proto.searchTool && !proto.defers ? 'drop' : 'defer'
  if ((action === 'defer' && !proto.defers) || !h?.defers) return "Shaver can't defer tools in this harness yet."
  if (action === 'defer' && !searchOn(body, proto.searchTool)) return 'Tool search is off, so no tools can be deferred. Start Claude Code with ENABLE_TOOL_SEARCH=true to turn it on.'
  const now = toolRulesOf(policy, h.name) ?? []
  const names = offerable(body, h.alwaysLoaded)
  if (!names.length) return `No tools but ${h.alwaysLoaded.join(', ')} are sent in full, so none can be ${action === 'drop' ? 'dropped' : 'deferred'}.`
  return { action, names, chosen: names.filter((name) => actionOf(now, name) === action), all: withPicked(now, names, new Set(names), action, h.alwaysLoaded) }
}

// The skills part of `shaver optimize`'s answer, with the skills in its
// table, a line for each, and those whose line is sent already. Lines are
// asked for only for the others.
async function skillsStage(proto: Protocol, h: Harness | undefined, key: string, body: Canonical, render: Wire['render'], target: string, headers: Record<string, string>, say: (text: string) => void, old: () => Promise<{ tokens: number }>, measure: (rules?: readonly SkillRule[]) => Promise<{ tokens: number }>): Promise<Skills> {
  const none = (text: string) => ({ text, skills: [], lines: {}, trimmed: [] })
  const listed = skillsOf(body)
  if (!listed.length) return none('No skills found in this session.')
  const shown = keptWhole(listed, policy.skill_shaver_rules ?? [])
  if (!shown.length) return none('All skills are already trimmed in shaver policy file, no changes needed.')
  const current: Record<string, string> = {}
  for (const s of shown) {
    const line = lineOf(s, policy.skill_shaver_rules ?? [])
    if (line !== undefined) current[s.name] = line
  }
  const generated = await linesFor(proto, h, key, body, render, target, headers, say, old, measure, shown, shown.filter((s) => current[s.name] === undefined))
  if (typeof generated === 'string') return none(generated)
  const lines = { ...current, ...generated }
  const lined = shown.filter((s) => lines[s.name])
  // Only if both answers were no JSON object or had every line too long.
  if (!lined.length) return none('Shaver skill optimization failed.')
  const saved = await Promise.all([old(), measure(withLines(policy.skill_shaver_rules ?? [], lined, lines))]).then(([o, w]) => o.tokens - w.tokens, (err: Error) => err)
  const trimmed = lined.filter((s) => current[s.name] !== undefined).map((s) => s.name)
  return { text: skillsText(lined, lines, new Set(trimmed), saved), skills: lined, lines, trimmed }
}

// Lines for `skills` from the session's model, or why there are none, saying
// what it is doing while it waits. The count and tokens it reports are for
// every skill in the table, `shown`, trimmed or not.
async function linesFor(proto: Protocol, h: Harness | undefined, key: string, body: Canonical, render: Wire['render'], target: string, headers: Record<string, string>, say: (text: string) => void, old: () => Promise<{ tokens: number }>, measure: (rules?: readonly SkillRule[]) => Promise<{ tokens: number }>, shown: Skill[], skills: Skill[]): Promise<Record<string, string> | string> {
  say(ANALYZING)
  // The lines are asked for while the skills' own tokens are measured: the
  // base as sent, without those skills' entries, and with no skill shaved.
  const without = measure([...shown.map((s) => ({ name: s.name, action: 'drop' as const })), ...(sessionRules(key, body) ?? [])])
  const whole = measure([])
  const asked = (async (): Promise<Record<string, string> | string> => {
    let lines: Record<string, string> = {}
    // A model's answer can leave skills out, so those are asked for once more.
    for (let tries = 0; tries < 2; tries++) {
      const ask = skills.filter((s) => !lines[s.name])
      if (!ask.length) break
      try {
        const { text } = await forked({ key, proto, model: body.model, provider: body.provider }, 'optimize', proto.summaryFork(baseOf(proto, h, key, body, render), linesPrompt(ask)), target, headers)
        const answer = proto.summaryForkAnswer(text).content.filter((b) => b.type === 'text').map((b) => String(b.text)).join('')
        lines = { ...lines, ...linesOf(answer, ask) }
      } catch (err) {
        console.error('shaver: asking for skill lines failed:', err)
        return UNRETRIEVED
      }
    }
    return lines
  })()
  const measured = await Promise.all([old(), without, whole]).then(([o, w, n]) => ({ own: o.tokens - w.tokens, blocked: n.tokens - o.tokens }), () => undefined)
  say(optimizing(shown.length, measured, skills.length > 0))
  return asked
}

const server = createServer((req, res) => {
  // A request is open until handle is done with it and its answer has gone
  // out: one its client left is still read to its end and journaled (handle).
  open++
  const closed = new Promise((ok) => res.on('close', ok))
  handle(req, res).catch((err) => {
    if (abortedBy(err)) return res.end()
    console.error('shaver:', err)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(protocolOf((req.url ?? '/').replace(/^\/via\/[^/?#]*/, '')).error(502, `shaver proxy: ${err}`))
    } else res.end()
  }).finally(async () => {
    await closed
    open--
    drained()
  })
})
// With port 0 the OS picks a free port as it binds; the line gives the one
// taken.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err
  console.error(`shaver: ${inUse(a.port)}`)
  process.exit(1)
}).listen(Number(a.port), '127.0.0.1', () => console.error(`shaver: version ${version}, listening on http://127.0.0.1:${(server.address() as AddressInfo).port}, forwarding to ${a.upstream}${passthrough ? ', passing every request through unmodified (SHAVER_MODE=passthrough)' : `${dropUnbound.on ? ', dropping unbound thinking (SHAVER_DROP_UNBOUND_THINKING=1)' : dropUnbound.never ? ', never dropping unbound thinking (SHAVER_DROP_UNBOUND_THINKING=0)' : ''}${codexBreakpoints ? '' : ', no explicit breakpoints on Codex (SHAVER_CODEX_BREAKPOINTS=0)'}`}`))

function inUse(port: string) {
  return `port ${port} is in use by another program. Set SHAVER_PORT=NNNN to an available port number.`
}

const abortedBy = (err: unknown) => err instanceof Error && err.name === 'AbortError'

// Node restores SIGHUP's default, undoing nohup, so the terminal that started
// the proxy closing would stop it. It stops on /shaver/shutdown instead.
process.on('SIGHUP', () => {})

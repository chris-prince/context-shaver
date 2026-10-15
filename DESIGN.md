# Design of ctx-shaver

The details behind the [README](README.md).

## Running

```bash
bin/claude-via-shaver [claude args ...]
```

`bin/claude-via-shaver` starts the proxy if nothing is listening on its port (8787,
or `CTX_SHAVER_PORT`), then runs `claude` with `ANTHROPIC_BASE_URL` pointing at
it. The proxy is left running for later sessions, with its output in
`proxy-data/proxy.log`. It starts the proxy with the repo's `policy.json` (see
[Policy](#policy)), and with logging off; to log (see [Logs](#logs)), start the
proxy first with `bin/run-proxy --log`. It also sets `ENABLE_TOOL_SEARCH=true`:
Claude Code turns its tool search off when the base URL isn't Anthropic's,
which sends every tool's definition on every request (about 26k more tokens).

To pick up changes to the proxy's code, restart it:

```bash
bin/run-proxy --restart
```

Sessions running through it carry on with their next request. Pass `--log` as
well to keep logging on, as the new proxy doesn't inherit it. To stop it, run
`bin/run-proxy --stop`.

Claude Code cannot reach the API while the proxy is down, so a session started
this way fails if the proxy is stopped.

To run the proxy by hand (Node 26 runs the TypeScript directly):

```bash
node src/server.ts [options]
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

It works with a claude.ai login as well as an API key: the proxy forwards the
headers as they come.

| Option | Default | |
| --- | --- | --- |
| `--port` | `8787` | Listens on 127.0.0.1 only |
| `--upstream` | `https://api.anthropic.com` | For requests that don't name one ([below](#when-the-model-is-already-proxied)) |
| `--dir` | the repo's `proxy-data/` | Where `state/` and `logs/` go |
| `--policy` | the repo's `policy.json` | The policy file to use (format documented below). If not specified, defaults to `policy.json` and if missing creates a local `policy.json` from `policy.default.json` |
| `--log-step-events` | off | Write the log (below) |
| `--cache-ttl-seconds` | `3600` | The cache TTL. Lower it only to test the cold path |

### When the model is already proxied

If `ANTHROPIC_BASE_URL` is already set when `claude-via-shaver` runs, say to a
company gateway, ctx-shaver goes in front of it rather than replacing it.
Claude Code's base URL becomes `http://127.0.0.1:8787/via/<upstream>`, the
upstream's base URL percent-encoded as one path segment, and
the proxy sends that session's requests there with the prefix stripped
(`src/via.ts`). The upstream may be `http` or `https`, and may have a path of
its own. One proxy serves sessions behind different upstreams; requests with no
`/via/` go to `--upstream`, and a `/via/` that doesn't name an `http(s)` base URL
is refused, never sent there instead. A base URL already through this proxy, as
a teammate session inherits, is left as it is.

Some setups set the base URL only after `claude` starts: a wrapper installed as
`claude` that runs its own proxy for each session, on a new port each time, and
then runs Claude Code. A launcher run before it can't see that URL, and the
wrapper replaces the one it's given, so ctx-shaver would be bypassed. If the
wrapper lets you choose the binary it runs (often an environment variable
naming its path), give it `claude-via-shaver` itself: run by the wrapper, it
sees the base URL the wrapper set and chains to it, as above. Tell it where the
real Claude Code is with `CTX_SHAVER_REAL_CLAUDE_LOCATION`, a path or a glob of
versioned installs, of which it takes the newest:

```bash
export CTX_SHAVER_REAL_CLAUDE_LOCATION='~/path/to/claude-code-*'
export <WRAPPER_BINARY_VAR>=~/ctx-shaver/bin/claude-via-shaver
claude [claude args ...]
```

Without `CTX_SHAVER_REAL_CLAUDE_LOCATION` it would run `claude`, the wrapper,
which would run it again; it notices and stops with an error instead. With it
set, start sessions through the wrapper, as above: `claude-via-shaver` run
directly would skip the wrapper and whatever it sets up.

The proxy serves only requests whose `Host` is `127.0.0.1` or `localhost`.
Since a request can name any upstream, a web page that reached the proxy by DNS
rebinding (which sends the page's own domain as `Host`) could otherwise read
whatever it had the proxy fetch from your network.

## Policy

The repo tracks only `policy.default.json`. When the proxy starts with the
repo's `policy.json` and there is none, it copies the default there; that copy
is ignored by git, so edit it freely. To go back to the default, delete it and
restart the proxy (`bin/run-proxy --restart`). To pass every request through
untrimmed, make it `{}`.

The policy file gives each kind of content a list of rules. A rule is due once
its item's step (`"on": "step"`) or turn (`"on": "turn"`) is among the
completed ones, leaving out the latest `wait`; the strongest due rule wins,
drop over stub. A kind with no rules is never trimmed.

```json
{
  "tool": [
    { "on": "step", "wait": 1, "action": "stub" },
    { "on": "step", "wait": 10, "action": "drop" }
  ],
  "skill": [{ "on": "turn", "wait": 0, "action": "drop" }],
  "reasoning": [{ "on": "turn", "wait": 0, "action": "drop" }]
}
```

| Kind | Item | Actions |
| --- | --- | --- |
| `tool` | A tool call with its results | `stub`, `drop` |
| `skill` | A `Skill` call, its result and the skill's text beside it | `stub`, `drop` |
| `tool_search` | A `ToolSearch` call and its result | `drop` |
| `reasoning` | An assistant message's thinking blocks | `drop` |

A stubbed skill keeps its call, its result (which only names it) and the first
line of its body, `Base directory for this skill: <path>`; the rest of the body
is stubbed. The model can still read the skill's files, or invoke it again for
the body. A skill loaded by slash command has no `Skill` call, so it is no item
and stays.

A Read that Claude Code sends as a system message's text is a `tool` item too:
after a compaction it re-attaches the files read before, each as `Called the
Read tool with the following input: …` with the file's numbered lines after.
A stub replaces the lines, a drop the whole Read; the rest of the message (the
skills list, the environment block) stays. In the base, before the first
response, it is left alone.

`tools_not_deferred` lists the tools Claude Code sends in full that should stay
that way. Every other one is marked `defer_loading` and added to the deferred
tools Claude Code lists in its environment message, so the model loads it with
`ToolSearch` when it needs it. `ToolSearch` itself is never deferred, listed or
not. Without the key nothing is deferred, and with tool search off (no
`ENABLE_TOOL_SEARCH`, so no list) neither. Changing the list rewrites the cache of open
sessions once.

`summary_threshold_tokens` turns on heavy compaction (below): a fork is made
once the completed turns past the last one offered hold that many tokens
before the frontier. The
default is 10000. Without the key no record is made or sent.

The proxy reads the file when it starts; restart it after editing.

## What it trims

Only requests that carry tools are trimmed: the main loop and subagents. Claude
Code's side requests pass through unchanged.

A conversation is one message history that only grows, and each has its own
state: the applied clock below counts steps and turns into it, and its cache
entries are prefixes of it, so neither carries over to another history. Its
key is the session ID, the agent ID and a hash of its first message:

- Claude Code sends the session ID with every request. It keeps apart sessions
  whose first message is the same, as when two start with `:shaver stats` in
  the same repo state: once the command is stripped, both first messages are
  the same reminders.
- Each subagent's requests carry `x-claude-code-agent-id`; the main loop's
  carry none and are keyed `main`.
- One agent can still send several histories. A WebSearch call is its own
  one-message request with no agent ID, and a compaction (`/compact`, or the
  automatic one) replaces the history with a summary and carries on from
  that, never sending the old messages again. The first message changes
  exactly then, so the new history starts fresh: nothing trimmed, nothing
  cached, a new journal. Keeping the old state would point its clock at turns
  the new history doesn't have, and count on cache entries it can't read.

Without a session ID (other clients), the first message alone is the key.

A step is an assistant message with the tool results that answer it. The
latest step, the one the model is answering, is never touched. A turn starts
at a prompt (user text that is not a tool result, a `<system-reminder>` or a
command row). The current turn, from the last prompt on, is never touched.

The API constrains what can go:

- a dropped call goes with its results;
- a system message (`role: "system"`, which Claude Code sends mid-conversation)
  must come after a user or a system message, and before an assistant message
  or at the end. Tested against the API on 2026-10-10:

  | Messages | Result |
  |---|---|
  | user, system | allowed |
  | user, system, system | allowed |
  | user, call, result, system | allowed |
  | user, assistant, system | 400: must follow a user message |
  | user, system, system, user | 400: must precede an assistant message |
  | user, call, result, system, user | 400: must precede an assistant message |

  The drops are made together and only then checked against this, so two
  pairs that are each due can go together when what remains is allowed. Where
  it isn't, the pair just before the system message (or just after) is
  stubbed instead, whatever the policy's stub rules say: a stub moves no
  message;
- a message whose only content is thinking keeps it, since an empty message is
  refused. One left empty by dropped calls is removed.

Each conversation has an applied clock, saved in
`proxy-data/state/<key>.json`: the completed steps and turns the policy was
last applied at. Every request is trimmed at it, so they all send the same
prefix and the prompt cache keeps reading it. The clock only moves forward.

If the API refuses a trimmed request (400), the proxy sends it again as it
came and logs the refusal to stderr.

## When the applied clock moves

On each request the proxy prices moving the applied clock up to the
conversation's (`src/trim.ts`, `decide`). Everything due by then goes in one
batch: a call the clock skipped past both rules for goes straight to dropped.
It prices each candidate, keeping and advancing, against the cache
entries the conversation's earlier requests left. They are saved in the
state with the time each was last written or read, and they expire after the
TTL. Each breakpoint (a block with `cache_control`) leaves an entry for the
prefix through it. A request reads the longest live entry it finds by looking
back at most 20 positions from each of its breakpoints. A position is a block,
or a message's run of `tool_use` or `tool_result` blocks. The request writes
from there to its last breakpoint. A written character costs M + 1 reads, where
M + 1 = 2 / read cost, because a 1-hour write is 2× input. So M = 19 at the
usual 0.1× read, 39 on Opus 5.5, and 79 on Fable and Mythos 5.1.

Advancing pays when its extra cost on this request is at most K·S read
characters, where S is the characters it saves every later request and K = 40.
Advancing reads no further than its first change. It reads less when no
entry ends there, and nothing when every entry is out of the breakpoints'
reach. When nothing is cached (the TTL lapsed, or the model, tools or system
prompt changed), both candidates write everything, so advancing always pays.
A request with no breakpoints in its messages (a side request branched off
the conversation) never advances: it reads none of them whatever is cached,
so it says nothing about whether advancing would pay.

Claude Code's message breakpoints are all near the end, so on their own an
advance finds no entry in reach of its first change and rewrites everything
after the system prompt. So the proxy adds one breakpoint of its own
(`anchored`), on the last block before the messages first differ from them
settled, trimmed as far as the policy ever takes them (`settledEnd`). No
advance changes anything before that block, so every request keeps its entry
live, and an advance reads through it and rewrites only from there. It is
found on the messages as kept, before the request's own advance, and it takes
Claude Code's settings and skips thinking blocks. The API allows 4
breakpoints per request, and Claude Code often sends 4 (two in the system
prompt, two in the messages). Then the added one replaces the system
prompt's first, which ends after the identity line. A request reads that
entry only when the system prompt changed but the tools did not, which the
logs show 3 times in 2,740 requests. Claude Code's message breakpoints stay,
because a step that adds more than 20 blocks puts the previous request's
entry out of the last one's lookback, and the one before it still reaches
it. A request where the swap would leave less read from the cache goes
without it. `decide` prices both candidates with it.

## Heavy compaction

A conversation's early turns can be replaced with a record of their memorable
events: the goal of each arc (a stretch spent on one goal), the outcomes that
landed, the user's decisions and the traps hit (`src/summary.ts`). Making a
record is kept apart from sending it.

- **Made while the cache is warm.** Once a request's completed turns, since
  the turn the last fork was offered at, hold `summary_threshold_tokens` tokens as
  sent before the frontier, counted as the stats count them from the API's
  usage, the proxy forks
  it after it is answered: the same request with
  instructions appended to its last message, after the breakpoint. The fork
  reads the request's cache entry and pays only for the instructions and the
  record. Claude Code never sees it, and only one runs at a time per
  conversation.
- **Made in parts.** The instructions list the uncovered turns by number, each
  with its prompt quoted, and ask for complete arcs only, ending with the turn
  the record stops before. A record ending where a turn starts leaves no tool
  call without its result. The next fork asks from that turn on. A fork that
  finds no complete arc, or calls a tool, makes no record.
- **Kept** in `proxy-data/state/<key>.summaries.json`, apart from the state,
  which a request answered while a fork runs would save over. Each record holds
  a hash of the prompt it stops before; when that prompt is no longer there
  (the conversation was rewound), it goes with the records after it.
- **Sent once the cache is cold.** A request that reads nothing from the cache
  writes everything anyway, so it takes all the records there are: everything
  from the first response to the last record's end is replaced by the records,
  one assistant message each, oldest first. The messages before the first
  response (the preamble and the first prompt) stay. Assistant messages fit
  after them where a user one can't, since they can end with a system message.
  Every request after sends the same records, so the cache keeps reading them.
  In `:shaver stats` each record counts as `summary` and is dated by the first
  message it replaced, so several records can fall in several age rows.

A fork's cost is in the session's actual cost in `:shaver stats`, which also
shows how many forks have been sent, answered or not, as `Summaries: N
creation requests`.

## Logs

With `--log-step-events` (which `bin/run-proxy --log` passes), logs go to
`proxy-data/logs/<key>/`:

- `step_events.jsonl`, with one line per event:
  - a `request` line for each answered request: usage, and the request's
    messages as sent, by hash. Of the usage, `writtenTokens60m` and
    `writtenTokens5m` are the tokens written to the cache for an hour and for
    5 minutes; an hour's write costs more. `predictedCachedChars` is the
    message characters the proxy expected the cache to serve, to check the
    model against `cachedTokens`; `breakpoints` is how many of the messages'
    blocks carry `cache_control` (with none, the messages are read from no
    entry, so the proxy holds trimming);
  - a `compaction` line for each decision that had something to trim:
    advanced, cache state, saved and rewrite characters, and `transitions`,
    the items whose treatment it changes (or would have, if deferred) by kind
    and treatment, as `{"tool:stub": 2, "reasoning:drop": 1}`;
  - a `summary` line for each fork: the turns it was offered (`start` to
    `current`), the turn its record ends before (none if it made none), the
    record's characters and the fork's usage. A request line's `summaries` is
    how many records it sent.
- `parts/`, where each distinct message is saved once, together with its bytes
  split by kind. A trimmed message shares a lineage with the original.

Scripts:

- Typing `:shaver stats` as a prompt shows the session's latest request,
  logged or not, in three sections: the base, the conversation before the
  frontier (by age, then by type), and the frontier. Every percentage is of
  the whole request. After each request the proxy counts its parts' tokens
  (`src/stats.ts`) and answers from those counts. Before any request is
  answered it shows the command's own request instead, as it will be sent,
  its count estimated from its bytes and marked so. It answers without calling
  the model, and strips the command and its answer from every later request
  (`src/command.ts`), keeping the system messages between them: after a first
  prompt those are Claude Code's whole preamble. A breakpoint on the command
  or its answer moves to the message before them. Claude Code's prompt
  suggestion puts its breakpoint on the last reply, and when that reply is the
  proxy's, stripping it would leave the suggestion reading only the system
  prompt.
  `:shaver policy` shows the policy file the same way, as it is on disk now.
  Each counted request appends what it changed to
  `proxy-data/state/<key>.journal.jsonl` (`src/journal.ts`), about 1 KB a
  request, with the usage the API reported for it: cache reads, cache writes
  by TTL, and output tokens. Replayed from the start, the journal gives the
  stats after any request. Claude Code's prompt suggestions, which it sends
  after a reply asking what the user will type next, are trimmed like any
  request but not counted: they would add a turn the user never took. The
  proxy keeps only each conversation's latest stats in memory,
  replaying the journal once after a restart; a journal that won't replay
  is moved aside to `<key>.journal.bad.jsonl` and the stats start again.
  Counting starts when the
  journal does, so a conversation begun under an older proxy counts its
  earlier messages by bytes.
- The stats also show the session's cost (`src/cost.ts`), from the journal
  alone, so it adds nothing to it: replayed once with the stats, then kept as
  a running total. Each request's actual uncached, cache-read, cache-write and
  output tokens come from its usage. Without the shaver the prompt would have
  been `inputTokens + removedTokens`; its split is estimated from the gap
  since the previous request and whether the trim advanced. After a gap longer
  than the cache TTL, both read only the shared prefix and write the rest. On
  a warm advance, which rewrites the cache, the shaverless prompt would have
  read everything the previous one sent. Otherwise it mirrors the actual
  request, with the trimmed-out tokens read on a hit and written on a miss.
  Output is the same in both. Dollars use a per-model price table; for an
  unknown model the costs are left out. Prompt suggestions and command replies
  are left out, as the journal leaves them out.
- `node scripts/stats-from-logs.ts <conversation dir> [--request N]
  [--check-journal]` replays a logged conversation through `src/stats.ts`
  and prints what `:shaver stats` would have said. `--check-journal` also
  checks that the journal replays to the same stats after every
  request.
- `python3 scripts/strip-savings.py [dir ...]` reports, per conversation, the savings
  against the cost of rewriting the cache.
- `node scripts/refresh-kinds.ts <conversation dir>` relabels a conversation's
  logged parts with the current part-type rules. The proxy labels a part once,
  when it first logs it, so run this after changing the rules in `src/log.ts`.
- `python3 scripts/reruns.py [conversation dir]` lists tool calls that fetched again
  output trimming had taken from the model: at least half their result lines
  were in earlier results stubbed or removed from the request they answered,
  and in none still whole. With each, the step wait that would have avoided it,
  and a histogram of those: what trimming too much costs.
- `python3 scripts/prompt-cost.py "<prompt start>" <session id> ...` compares one
  user prompt across sessions, such as runs of the same prompt under different
  policies: from the prompt to the next one, its steps, duration, cost, tool
  calls, trims applied and peak context.
- `[WAIT=<n>] node scripts/replay.ts <conversation dir> [from] [to]` replays
  one logged conversation under several policies with the model's actions
  held fixed: it rebuilds each request untrimmed, runs the proxy's logic on
  it, and prices the result with the cache model. WAIT, the drop wait the run
  used, also checks that the rebuild reproduces what the proxy sent.

Each request line logs the size of every part sent: its messages (`parts`),
system blocks (`system`) and tool definitions (`tools`, deferred ones marked).
The scripts turn bytes into tokens at the conversation's rate, its requests'
tokens over all the bytes they sent, and read only conversations logged with
those fields.

## Limits

- **Claude Code sends some requests twice in parallel** (the same history with
  a different tail). Both trim alike, but each logs its own decision, so
  `strip-savings.py` counts those advances twice.
- **Changes to Claude Code's request shape can make it trim less**: it only
  edits the block types it knows.
- **Claude Code has its own context clearing, off behind server-side flags.**
  Version 2.1.289 contains two kinds. Either would trim the same content
  this does if Anthropic turned it on for an account:
  - API-side: beta `context-management-2025-06-27` with
    `clear_tool_uses_20250919` and `clear_thinking_20251015`, gated by
    `tengu_zany_pike`. Once the cache is cold (65 minutes idle), it clears
    all but the last 5 tool results, if at least 20k tokens can go.
  - Client-side microcompact, gated by `tengu_time_based_microcompact`: old
    results become `[Old tool result content cleared]` once more than 20k
    tokens can be cleared.

  Signs it's on: a `context_management` field in requests, or those
  placeholders in tool results.

## Tests

```bash
node --test tests/*.test.ts
```

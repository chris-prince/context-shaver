# Design of context-shaver

The details behind the [README](README.md).

## Running

```bash
bin/claude-via-shaver [claude args ...]
```

`bin/claude-via-shaver` starts the proxy if nothing is listening on its port (8787,
or `SHAVER_PORT`), then runs `claude` with `ANTHROPIC_BASE_URL` pointing at
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

Sessions running through it carry on with their next request. The new proxy
keeps the old one's logging; pass `--log` or `--no-log` to choose. To stop it,
run `bin/run-proxy --stop`. `bin/run-proxy --update` fast-forwards the repo to
its upstream (fetch, then `merge --ff-only`, so no `pull.*` setting applies)
and restarts the proxy the same way, but only if that brought in new commits.
If the repo has local changes in the way or has diverged, it stops with git's
error and leaves the proxy running.

`bin/run-proxy`, and so each wrapper, asks a proxy already on the port which
repo it runs from. One from another repo, or too old to say, is restarted from
this one, keeping its logging in the same way. Whether or not requests are
logged, every 4xx or 5xx answer from the upstream goes to `proxy.log` with its
body, so the upstream's own error text is on record.

Claude Code cannot reach the API while the proxy is down, so a session started
this way fails if the proxy is stopped.

To run the proxy by hand (Node 24 or newer runs the TypeScript directly):

```bash
bin/node-wrapper src/server.ts [options]
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

It works with a claude.ai login as well as an API key: the proxy forwards the
headers as they come.

### Node

`bin/node-wrapper` runs Node with the arguments given, as `node` would: one
installed under `proxy-data/node` if there is one, else the `node` on the PATH
if it is 24 or newer. Otherwise it installs `node@24` there with npm first, so
every run from the checkout uses it from then on. Where npm's registry is
blocked, as behind some corporate proxies, it lists the `registry=` lines of
the `.npmrc` files it finds on the machine, each with its file, and on a
terminal asks which to install from; it uses none unasked. Setting a registry
npm can reach (`npm config set registry <url>`) avoids the question, and so
does `SHAVER_INSTALL_DEPS=1`: with that set, it asks nothing and tries each
listed registry in turn. Being a variable, it reaches the install through
`claude-via-shaver`, `codex-via-shaver` and any wrapper that runs them.
Deleting `proxy-data/node` makes the next run install the newest 24.x.
`bin/run-proxy` starts the proxy through it.

| Option | Default | |
| --- | --- | --- |
| `--port` | `8787` | Listens on 127.0.0.1 only |
| `--upstream` | `https://api.anthropic.com` | For requests that don't name one ([below](#when-the-model-is-already-proxied)) |
| `--dir` | the repo's `proxy-data/` | Where `state/` and `logs/` go |
| `--policy` | the repo's `policy.json` | The policy file to use (format documented below). If not specified, defaults to `policy.json` and if missing creates a local `policy.json` from `policy.default.json` |
| `--log-step-events` | off | Write the log (below) |
| `--cache-ttl-seconds` | `3600` | The longest cache TTL; a request's breakpoints or its model can make it shorter. Lower it only to test the cold path |

### When the model is already proxied

If `ANTHROPIC_BASE_URL` is already set when `claude-via-shaver` runs, say to a
company gateway, context-shaver goes in front of it rather than replacing it.
Claude Code's base URL becomes `http://127.0.0.1:8787/harness/claude/via/<upstream>`, the
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
wrapper replaces the one it's given, so context-shaver would be bypassed. If the
wrapper lets you choose the binary it runs (often an environment variable
naming its path), give it `claude-via-shaver` itself: run by the wrapper, it
sees the base URL the wrapper set and chains to it, as above. Tell it where the
real Claude Code is with `SHAVER_REAL_CLAUDE_LOCATIONS`: paths or globs of
versioned installs, separated by colons, as on `PATH`. The first with a match is
taken, and of a glob's matches the newest:

```bash
export SHAVER_REAL_CLAUDE_LOCATIONS='~/path/to/claude-code-*:~/other/claude'
export <WRAPPER_BINARY_VAR>=~/context-shaver/bin/claude-via-shaver
claude [claude args ...]
```

Without `SHAVER_REAL_CLAUDE_LOCATIONS` it would run `claude`, the wrapper,
which would run it again; it notices and stops with an error instead. With it
set, start sessions through the wrapper, as above: `claude-via-shaver` run
directly would skip the wrapper and whatever it sets up.

`codex-via-shaver` chains the same way, with `SHAVER_REAL_CODEX_LOCATIONS`.
A Codex wrapper sets its gateway with `-c` flags rather than the environment:
`model_provider` and that provider's `base_url`. When the arguments name a
provider, `codex-via-shaver` keeps it and its other settings, puts the proxy's
`/harness/codex/via/<upstream>` in its `base_url`, and turns off its
WebSockets; with a provider but no `base_url` to chain to, it stops with an
error.

```bash
export SHAVER_REAL_CODEX_LOCATIONS='~/path/to/codex/*/codex-<target>'
export <WRAPPER_BINARY_VAR>=~/context-shaver/bin/codex-via-shaver
codex [codex args ...]
```

Only a provider in the arguments is chained to; `codex-via-shaver` doesn't read
Codex's `config.toml`. With none in the arguments, it gives Codex its own
provider, straight to ChatGPT, and as `-c` flags win over `config.toml`, a proxy
set only there is bypassed, not chained to. To chain to one, name it in the
arguments, with its `base_url`:

```bash
codex-via-shaver -c model_provider=<name> \
  -c 'model_providers.<name>.base_url="<its base URL>"' [codex args ...]
```

A wrapper may also want the files a Codex install has beside Codex, beside the
binary it is given. `codex-via-shaver --stand-in` makes one with them: in
`proxy-data/stand-in/`, links to all beside the Codex that
`SHAVER_REAL_CODEX_LOCATIONS` finds, with Codex itself a script that runs
`codex-via-shaver` with that Codex. It prints that script's path, for the
wrapper to be given instead:

```bash
export SHAVER_REAL_CODEX_LOCATIONS='~/path/to/codex/*/codex-<target>'
export <WRAPPER_BINARY_VAR>=$(~/context-shaver/bin/codex-via-shaver --stand-in)
codex [codex args ...]
```

It is kept while it still matches the newest install, and made again when it
doesn't, so it follows a newer install.

The proxy serves only requests whose `Host` is `127.0.0.1` or `localhost`.
Since a request can name any upstream, a web page that reached the proxy by DNS
rebinding (which sends the page's own domain as `Host`) could otherwise read
whatever it had the proxy fetch from your network.

## Protocols

The proxy speaks Anthropic's Messages protocol (`/v1/messages`, Claude Code),
OpenAI's Chat Completions (`…/chat/completions`, OpenCode) and OpenAI's
Responses (`…/responses`, Codex); the request's path picks which
(`src/protocol.ts`). The trim, the policy, the cache model and the journal work
on one message model, the Messages shape (`src/items.ts`). A protocol turns its
requests into that and back (`src/messages.ts`, `src/chat.ts`,
`src/responses.ts`), and supplies what only it knows: what a response's usage
is and when its answer is complete, and how an answer made here looks.

What a request holds depends on three things apart. The protocol decides how
it is read and written. The model and its provider decide what the cache does
and what it costs (`src/models.ts`). The harness, the client sending it,
decides what the conversation is made of (`src/harness.ts`): its tools'
names and the inputs that can be stubbed, which tool runs shell commands, its
system prompt's sections, and its session's ID. OpenCode speaks all three
protocols, to any of their models, and its tools are its own on each.

A wrapper names its harness in the base URL, `/harness/<name>` before any
`/via/` (`claude`, `codex` or `opencode`). Without one, the harness is the one
whose own headers the request sends (`x-claude-code-…`, `x-codex-…`,
`x-opencode-…`): each sends them on purpose, to name itself and its session,
so they are not a guess from what its requests happen to look like. With
neither, the harness is unknown, and the core trims with no conventions: no
inputs stubbed, the system prompt one section. A `/harness/` that names none
is refused.

The conversation ID is the clearest thing a harness supplies: the core needs
one per conversation, the same on all its requests and on no other's, and
keys state, journals and logs on it. Claude Code's comes from its session and
agent IDs, OpenCode's from `x-opencode-session-id`, Codex's from
`prompt_cache_key` or the `session-id` header (What it trims).

A Chat Completions or Responses request is rebuilt only where the core changed
it: every message, item and block it left is sent as it came, since the cache
matches bytes. Chat Completions streams are asked for their usage
(`stream_options.include_usage`), which is otherwise left out. A Responses
request's input is a list of items: its leading developer messages, its tools
item and Codex's environment and AGENTS.md messages are the system; an answer's
reasoning, messages and tool calls are one assistant message, and a run of tool
outputs one user message of tool results.

A client may hang up once its answer is complete, before the stream's last
bytes: Codex does. That isn't an interruption, so the proxy keeps reading the
stream for the usage (`UsageReader.done`).

The cache differs too. Messages marks breakpoints; OpenAI and Chat Completions
providers cache each request's prefix themselves and read the longest part of it within
20 user or tool-result runs of the new request's end (measured on GPT-5.6), with
writes priced as input. `positionsOf` models that as one breakpoint at the end,
with entries at each user message's end. Summary forks work on both: each
protocol builds its own summary fork request and reads its answer. The anchor
breakpoint and tool deferral are Messages-only for now, and deferral is for a
harness with a tool that loads deferred tools: Claude Code, with ToolSearch.

`bin/opencode-via-shaver` and `bin/codex-via-shaver` run OpenCode and Codex
through the proxy as `claude-via-shaver` runs Claude Code, leaving their
configs alone. OpenCode reaches it through `/via/` with each provider's base
URL (OpenRouter's is `/via/https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1`; OpenAI's
and Anthropic's are set the same way), in `OPENCODE_CONFIG_CONTENT`, which
OpenCode merges over its config. Its background service doesn't read that, so
the TUI, `run` and `mini` get `--standalone`. Through OpenAI it uses Responses
and tries a WebSocket first, which the proxy refuses with 426; through
Anthropic it uses Messages. Codex keeps its own OpenAI provider, given the
proxy's address with `-c openai_base_url=...`, so it runs as it does without
the proxy: a provider of the proxy's own would get a custom provider's
defaults, which compact locally where Codex's compacts remotely. The proxy
answers its first WebSocket with 426, so it goes straight to HTTP (a refusal
passed on as the backend's 405 cost ~8s of retries), and reads the bodies it
compresses with zstd, sending them on uncompressed. To send every Codex
session through the proxy, put the address in `~/.codex/config.toml` instead:

```toml
openai_base_url = "http://127.0.0.1:8787/harness/codex/via/https%3A%2F%2Fchatgpt.com%2Fbackend-api%2Fcodex"
```

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

`skill_list` shortens the list of skills Claude Code gives the model in its
environment message, or Codex in its developer message (`### Available
skills`, each entry ending with where its SKILL.md is, which stays). On
Responses the core sees the head as the system, and a part it changed there is
sent with its new text, every other item as it came. Each rule has a `match`, a skill name with `*` for any
run of characters, and an `action`: `keep`, `drop`, or `stub` with `sentences`,
which keeps that many sentences of the description. Each skill takes the first
rule that matches it, so `keep` rules go before a broader `stub` or `drop`; a
skill no rule matches is kept. A dropped skill can still be run as `/name`, but
the model won't invoke it. The bytes taken out count as a base saving of their
own. A conversation keeps the rules it took while its cache is warm, so a
changed policy reaches it once the cache is cold.

A `stub` can instead carry `text`, a line written for the skill, and
`replaces`, the hash of the description it was written from. The line stands in
for that description only, and only when shorter, so a skill whose description
changed shows it whole until a new line is written. `:shaver optimize` writes
these lines: for each skill the rules keep whole, or gave a line before, it asks
the session's own model for one of at most 6 words that tells the skill from
the others, asking once more for any it left out. The question is a fork of the
request's base as the proxy sends it, through the message holding the skill
list (on Codex, the head alone), so it reads what the session has cached of
it: on Claude Code past a conversation's first request, the tools and system
prompt, since only that request marks the base's end. It shows the lines and
the tokens they save: the base is sent with the old lines and with the new,
each with a short question after it, and the difference of their prompt
tokens, as the API's usage reports them, is the saving. Then it asks whether
to apply them, giving what rewriting the warm sessions' caches would cost. A `y` or `n` as the next prompt is the answer, a command like the
others. `y` puts the lines first in `skill_list`, in memory and in the policy
file, and every session gets them from its next request. The file is read
again, and only its top-level `skill_list` value is rewritten, so edits by hand
elsewhere in it stay as they were. Probes found 6-word lines made the model
pick the right skill more often than the full descriptions, at about a tenth of
their tokens. Its requests' cost counts against the skill list's saving. A
session's stats start again only with a new conversation, so `y` suggests
`/clear`.

`summary_threshold_tokens` turns on heavy compaction (below): a summary fork is
made once the completed turns past the last one offered hold that many tokens
before the frontier. The default is 20000; a model can set its own
(`summaryThreshold` in `models.ts`, 7000 for DeepSeek at DeepInfra). Without the
key no record is made or sent.

`memoir_threshold_tokens` turns on the memoir (below): once the records hold
more than that many tokens, the oldest are merged into it. It is 15000 in the
default policy. Without the key no record is merged.

The proxy reads the file when it starts; restart it after editing.

## What it trims

Only requests that carry tools are trimmed: the main loop and subagents. Claude
Code's side requests pass through unchanged.

A conversation is one message history that only grows, and each has its own
state: the applied clock below counts steps and turns into it, and its cache
entries are prefixes of it, so neither carries over to another history. Its
key is `claude-`, the session ID, the agent ID and a hash of its first message
(`claude-<session>-<agent or main>-<hash>`); OpenCode's and Codex's start
`opencode-` and `codex-` with their session's ID (Protocols):

- Claude Code sends the session ID with every request. It keeps apart sessions
  whose first message is the same, as when two start with `:shaver info` in
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

Without a session ID, the key is the harness's name and the first message's
hash. An unknown harness's starts with its protocol's name (`messages-`,
`chat-` or `responses-`), and has the body's `prompt_cache_key` or `user` as
its session if it sends one.

A step is an assistant message with the tool results that answer it. The
latest step, the one the model is answering, is never touched. A turn starts
at a prompt (user text that is not a tool result, a `<system-reminder>` or a
command row). The current turn, from the last prompt on, is never touched.
Claude Code's prompt suggestion is not a prompt: it comes after a reply that
may not end the turn, as when a background task's notice resumes the agent,
so a turn ends only at the next prompt.

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
TTL: an hour if every breakpoint asks for `"ttl": "1h"`, else the API's
default of 5 minutes, which Bedrock clients often keep. Each breakpoint (a block with `cache_control`) leaves an entry for the
prefix through it. A request reads the longest live entry it finds by looking
back at most 20 positions from each of its breakpoints. A position is a block,
or a message's run of `tool_use` or `tool_result` blocks. The request writes
from there to its last breakpoint. A written character costs M + 1 reads, where
M + 1 = 2 / read cost, because a 1-hour write is 2× input. So M = 19 at the
usual 0.1× read, 39 on Opus 5.5, and 79 on Fable and Mythos 5.1. A 5-minute
write is 1.25× input, so M = 11.5 at the usual read.

Advancing pays when its extra cost on this request is at most H·S read
characters, where S is the characters it saves every later request and H, the
horizon, is the model's (`models.ts`) given the n requests before this one:
min(20, 0.6n) by default, and 5 for luna and DeepSeek V4.1 Flash, which did best
in backtests of logged sessions (`scripts/backtest-horizon.ts`).
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
  the turn the last summary fork was offered at, hold
  `summary_threshold_tokens` tokens as sent before the frontier, counted as the
  stats count them from the API's usage, the proxy sends a summary fork of it
  after it is answered: the same request with instructions appended to its last
  message, after the breakpoint. The summary fork reads the request's cache
  entry and pays only for the instructions and the record. Claude Code never
  sees it, and only one runs at a time per conversation.
- **Made in parts.** The instructions list the uncovered turns by number, each
  with its prompt quoted, and ask for complete arcs only, ending with the turn
  the record stops before. Each arc starts with a heading, `## [<turn>] <title>`,
  giving the turn it starts at and a one-sentence title that stands on its own.
  The model sees no times (neither protocol puts one on a part), so the proxy
  dates each arc itself when it keeps the record: by when its first turn's
  prompt was sent, and its minutes by its turns' own, from each prompt to its
  last request, leaving out the time between turns. The record also keeps the
  summary fork's output tokens. A record ending where a turn starts leaves no tool
  call without its result. The next summary fork asks from that turn on. A
  summary fork that finds no complete arc, or calls a tool, makes no record.
- **Kept** in `proxy-data/state/<key>.summaries.json`, apart from the state,
  which a request answered while a summary fork runs would save over. Each
  record holds a hash of the prompt it stops before; when that prompt is no
  longer there (the conversation was rewound), it goes with the records after
  it.
- **Sent once the cache is cold.** A request that reads nothing from the cache
  writes everything anyway, so it takes all the records there are: everything
  from the first response to the last record's end is replaced by the records,
  one assistant message each, oldest first. The messages before the first
  response (the preamble and the first prompt) stay. Assistant messages fit
  after them where a user one can't, since they can end with a system message.
  Every request after sends the same records, so the cache keeps reading them.
  In `:shaver info` each record counts as `summary` and is dated by the first
  message it replaced, so several records can fall in several age rows.
- **Merged into the memoir once they hold too much.** Each time a record is
  kept, if the records hold more than `memoir_threshold_tokens` by their output
  tokens, the oldest are merged until the rest fit. The memoir is one assistant
  message before the records left: a line saying it is an overview of the work
  leading up to this point, then each merged arc's title and minutes under the
  date it started, each date once, then a line saying the details are in the
  session transcripts and what follows is the active work. Like a new record,
  it is sent once the cache is cold. A record without arc headings (made before
  they were asked for) stops the merge, along with every record after it. In
  `:shaver info` the memoir counts as `memoir`.

A summary fork's cost is in the session's actual cost in `:shaver info`, which
also shows how many summary forks have been sent, answered or not, and what
became of them: their records the prompt now sends (applied), those still to
answer or waiting for a cold cache (pending), and the rest, which failed,
answered with nothing, were replaced or no longer fit the messages (dropped).

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
    entry, so the proxy holds trimming). On the Responses API it also has
    `attribution`, the usage per input item and block as the API gives it,
    keyed by the items' IDs. The IDs Codex sends with its items are logged
    too: the head's (tools and instructions) as `headIds`, and each part's
    with it as `ids`, as sent. One attribution entry is logged nowhere; it
    looks like the model's answer to the request itself. When the proxy
    changed the messages, `received` is them as the client sent them, by
    hash, so what a trim took (the newest answer's thinking, say) can be
    rebuilt. It is logged as `{ keep, add }`: how many hashes it shares at
    the start with the previous request line's, and the ones after those.
    The first line after a restart has no previous one and lists them all;
  - a `compaction` line for each decision that had something to trim:
    advanced, cache state, saved and rewrite characters, and `transitions`,
    the items whose treatment it changes (or would have, if deferred) by kind
    and treatment, as `{"tool:stub": 2, "reasoning:drop": 1}`;
  - a `summary` line for each summary fork: the turns it was offered (`start`
    to `current`), the turn its record ends before (none if it made none), the
    record's characters and the summary fork's usage. A request line's
    `summaries` is how many records it sent.
- `parts/`, where each distinct message is saved once, together with its bytes
  split by kind. A trimmed message shares a lineage with the original.

Scripts:

- Typing `:shaver info` as a prompt shows the session's latest request,
  logged or not, in three sections: the base, the conversation before the
  frontier (by type, then by age, newest first), and the frontier. Every percentage is of
  the whole request. After each request the proxy counts its parts' tokens
  (`src/stats.ts`) and answers from those counts. Where the API counts each
  input item, as the Responses API does, the base and each part it counted
  all of take its counts, and so does what a reasoning item costs to send
  back, for the trims; the rest share what is left by bytes, as every part
  does where the API gives only totals. Such a part also keeps its tokens by
  kind, each item's count going to its kind, so splitting it by kind needs no
  bytes either. Before any request is
  answered it shows the command's own request instead, as it will be sent,
  its count estimated from its bytes and marked so. It answers without calling
  the model, and strips the command and its answer from every later request
  (`src/command.ts`), keeping the system messages between them: after a first
  prompt those are Claude Code's whole preamble. Blocks that open with a tag,
  of any name (reminders, a local command and its output, a `!` command), don't
  stop a prompt being a command, and are kept when it is stripped, so the model
  reads them with the next prompt. A breakpoint on the command
  or its answer moves to the message before them. Claude Code's prompt
  suggestion puts its breakpoint on the last reply, and when that reply is the
  proxy's, stripping it would leave the suggestion reading only the system
  prompt.
  A command sent while the model works, which Claude Code adds to the turn
  (in the tool results' message, or from 2.1.312 as a system message after it),
  is taken out before the request goes on, so the model never sees it. The
  proxy keeps it, in memory, until a streamed response ends the turn, and adds
  the answer to that response as one more text block, before its close. That
  block and the command are stripped from every later request too, and a `y`
  or `n` after a mid-turn `:shaver optimize` answers it as usual.
  `:shaver policy` shows the policy file the same way, as it is on disk now.
  `:shaver info all` adds up the costs of every conversation with a journal
  (`src/totals.ts`), replaying each as its own `:shaver info` does, then one
  entry per harness and model. Requests that weren't journaled (side requests
  and requests cut off before 2026-10-24, and suggestion mode before
  2026-10-23) aren't counted.
  Each request the API answers appends what it changed to
  `proxy-data/state/<key>.journal.jsonl` (`src/journal.ts`), about 1 KB a
  request, with the usage the API reported for it: cache reads, cache writes
  by TTL, and output tokens. Replayed from the start, the journal gives the
  stats after any request. Each fork the proxy sends of its own (only
  summary forks so far) goes through one routine, `forked` in
  `src/server.ts`, which journals it as soon as the API answers 200, before
  its answer is used: a `fork` line with its kind, time, model and usage,
  or, with none read, why (`no usage`, or `cut off` if the answer broke
  off), as for a request. Stats replay skips fork lines; a summary fork's
  cost still comes from the conversation's summaries file. Before
  2026-10-24 the line was `summaryFork`, read now as a fork of kind
  summary. Claude Code's prompt suggestions, which it sends
  after a reply asking what the user will type next, are trimmed and
  journaled like any request, with what they cost and any trim they make,
  but marked, and not counted as requests or turns: the user took none.
  Before 2026-10-23 they weren't journaled, so a trim made on one went
  uncounted; `scripts/backfill-suggestions.ts` adds them back from a
  logged conversation's logs. A changed request the API refuses, answered as it came, adds a
  line marked resent: one more request, its usage, the stats otherwise as
  they were, and the same cost with or without the shaver. Any other request
  the API answers is journaled bare, with its time, model, usage if it
  came, and why: a side request without tools (Codex's compaction, Claude
  Code's titles), sent as it came and journaled with its session's main
  conversation; a request answered with no usage; or one cut off before
  its answer ended, whose state is left as it was, so its trim is decided
  again with the next. A bare line counts as no request and costs the same
  with or without the shaver, at its own model; with `--log`, a side
  request is logged too. A line writes null for a field that has gone, so
  replay drops it (before 2026-10-24 it was left out, so replay kept the
  old value). The proxy counts each request answered that wrote no line,
  logs it to `proxy.log` and shows the count in `:shaver info`; there
  should be none. `scripts/audit-journal.ts` checks the journals against
  the harnesses' own records of their API calls (Codex's rollouts,
  OpenCode's database, Claude Code's transcripts) and lists the calls with
  no line. The
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
  been `inputTokens + removedTokens`, plus the tool definitions the proxy
  deferred (`defs.deferred`) and the skill list it shortened (`defs.skills`),
  in bytes, at the base's tokens a byte (before 2026-10-21, `defs.deferred`
  held both), until
  the client compacts it itself: past the model's `compaction.at`, the
  shaverless prompt keeps its base and what that client's compaction keeps,
  then grows as the client's prompt grows. Claude Code's, at 165K, keeps 20%
  of the rest; each adds a request reading the whole prompt and writing a
  7.6K-token summary, and about 65 seconds of waiting, which the stats show
  as avoided; the figures come from five logged compactions. Codex's (v2,
  remote), at 90% of the window, keeps the user's messages, up to 64K
  tokens, and an ~800-token summary, and takes ~34 seconds (the figures in
  `models.ts`). Where the client compacts with the proxy, which for Codex
  shows as a request without the last message of the one before
  (`compacted`), the shaverless prompt compacts then too, to the client's
  size if it held more, and nothing taken out is left: both are cold past
  the base. The split is estimated from the gap
  since the previous request and whether the trim advanced. After a gap
  longer than the cache TTL (the request's, as the journal records it), both read only the shared prefix and write the
  rest. On a warm advance, which rewrites the cache, the shaverless prompt
  would have read everything the previous one sent, or the base after a
  compaction. Otherwise it mirrors the actual request, with the trimmed-out
  tokens read on a hit and written on a miss. Output is the same in both.
  Dollars use a per-model price table; for an
  unknown model the costs are left out.
  The saving is shown by type of trim. Each base shave's is what the request
  would cost without that shave alone, at the price the request without the
  shaver paid for it: read as far as its reads reach, from the front, and
  written past that. The rest is the conversation's: tool
  calls and results, reasoning, messages, summaries, or other. The summaries'
  type is net: what the parts their records replaced would have cost, less
  what sending the records and memoir costs and what the summary requests
  cost, so it starts negative and gains as later requests leave out what the
  records replaced. A request records the parts the records it adds replace;
  journals from before 2026-10-27 don't, so their summaries show only their
  cost. A replay works out what
  each request's trim took out of each, from the parts it dropped or changed
  and their tokens by kind. A request that trims still gains from the trims
  before it: they're credited what the request without the shaver paid for
  the tokens of theirs it still held, as a base shave is, shared by what
  each type has taken out so far. The trim's own types take what's left,
  its rewrite with it, shared by what it took out. Every other request is
  shared by what each type has taken out so far. When the request without
  the shaver compacts, what was taken out until then is cut to the share a
  compaction keeps, none for Codex's. That rule, and the byte split of a part's
  tokens where the API gives no count by kind, make the split an estimate. Command replies
  are left out, as the journal leaves them out.
- `bin/node-wrapper scripts/stats-from-logs.ts <conversation dir> [--request N]
  [--check-journal]` replays a logged conversation through `src/stats.ts`
  and prints what `:shaver info` would have said. `--check-journal` also
  checks that the journal replays to the same stats after every
  request.
- `bin/node-wrapper scripts/backfill-suggestions.ts <key>…`, with the proxy
  stopped, adds to each conversation's journal the prompt suggestions its
  logs hold and the journal doesn't, keeping the journal as
  `<key>.journal.jsonl.pre-backfill`.
- `python3 scripts/strip-savings.py [dir ...]` reports, per conversation, the savings
  against the cost of rewriting the cache.
- `bin/node-wrapper scripts/refresh-kinds.ts <conversation dir>` relabels a conversation's
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
- `bin/node-wrapper scripts/read-codex-stops.ts [conversation dir ...]` shows, for
  each Codex request logged with its items' IDs, where the cache read stopped
  (by the API's usage per item), how much of what the request shared with the
  one before it read, and why the rest was not read: the first request, the
  tools or instructions changing, a trim, a message changing, a gap past the
  TTL, or the API reading less than it had. It ends with the tokens each cause
  cost. With no directory, it reads every Codex conversation.
- `bin/node-wrapper scripts/audit.ts [--since <date>] [--all]` runs the checks listed in
  the script over every logged conversation and reports which need action,
  with what to do about each. It exits 1 when any check has findings.
  `--since` skips messages first logged before the date, so findings already
  looked at stop coming back.
- `[WAIT=<n>] bin/node-wrapper scripts/replay.ts <conversation dir> [from] [to]` replays
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
bin/node-wrapper --test tests/*.test.ts
```

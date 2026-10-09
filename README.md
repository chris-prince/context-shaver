# mini-context for Claude Code

A local proxy between Claude Code and the Anthropic API. On each request it
forwards, it trims old content as its policy file says. The committed
`policy.json`:

- stubs a tool call once it is a step old: its result, and long Edit/Write
  inputs (`old_string`, `new_string`, `content`) and Bash here-document
  bodies, each replaced with a stub that gives their size,
  `[CULLED 1234 B FROM CTX]`;
- drops a tool call, with its result, once it is 10 steps old;
- drops a loaded skill (the `Skill` call, its result and the skill's text) once
  its turn is over;
- drops reasoning (thinking blocks) from completed turns.

Only what is sent changes. The stored session and the TUI are untouched, and
it trims before every request, mid-turn included. It is the Claude Code
counterpart of `../mini-context` (OpenCode), whose `context` hook does the same
inside OpenCode.

## Running

```bash
bin/claude-mini [claude args ...]
```

`bin/claude-mini` starts the proxy if nothing is listening on its port (8787,
or `MINI_CTX_PORT`), then runs `claude` with `ANTHROPIC_BASE_URL` pointing at
it. The proxy is left running for later sessions, with its output in
`proxy.log`. It starts the proxy with logging on and the repo's
`policy.json`.

To pick up changes to the proxy's code, restart it:

```bash
bin/start-proxy --restart
```

Sessions running through it carry on with their next request.

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
| `--upstream` | `https://api.anthropic.com` | |
| `--dir` | the repo | Where `state/` and `logs-mini-ctx-claude/` go |
| `--policy` | the repo's `policy.json` | The policy (below). With no file there, requests pass through |
| `--log-step-events` | off | Write the log (below) |
| `--cache-ttl-seconds` | `3600` | The cache TTL. Lower it only to test the cold path |

## Policy

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
| `skill` | A `Skill` call, its result and the skill's text beside it | `drop` |
| `reasoning` | An assistant message's thinking blocks | `drop` |

The proxy reads the file when it starts; restart it after editing.

## What it trims

Only requests that carry tools are trimmed: the main loop and subagents. Claude
Code's side requests pass through unchanged. A conversation is keyed by its
first message, so each subagent is its own.

A step is an assistant message with the tool results that answer it. The
latest step, the one the model is answering, is never touched. A turn starts
at a prompt (user text that is not a tool result, a `<system-reminder>` or a
command row). The current turn, from the last prompt on, is never touched.

The API constrains what can go:

- a dropped call goes with its results;
- a pair whose results a system message follows is not dropped, since a system
  message must follow a user one; it gets a stub, if one is due;
- a message whose only content is thinking keeps it, since an empty message is
  refused. One left empty by dropped calls is removed.

Each conversation has an applied clock, saved in `state/<key>.json`: the
completed steps and turns the policy was last applied at. Every request is
trimmed at it, so they all send the same prefix and the prompt cache keeps
reading it. The clock only moves forward.

If the API refuses a trimmed request (400), the proxy sends it again as it
came and logs the refusal to stderr.

## When the applied clock moves

On each request the proxy prices moving the applied clock up to the
conversation's (`src/trim.ts`, `decide`). Everything due by then goes in one
batch: a call the clock skipped past both rules for goes straight to dropped.
Let R be the
characters from the first changed message onward, and S the characters saved.
Advancing costs M·R − (M+1)·S extra cache-read characters on this request,
with M = 19, because a 1-hour cache write is 2× and a read is 0.1×. Advancing
pays when that extra is at most K·S, with K = 40.

The cache is cold when the conversation's last answered request is older than
the TTL, was for another model, or is unknown. Nothing is cached then, so
trimming is free and the rule always advances.

## Logs

With `--log-step-events`, logs go to
`logs-mini-ctx-claude/<session>-<conversation>/`:

- `step_events.jsonl`, with one line per event:
  - a `request` line for each answered request: usage, and the request's
    messages as sent, by hash;
  - a `compaction` line for each decision that had something to trim:
    advanced, cache state, saved and rewrite characters, and `transitions`,
    the items whose treatment it changes (or would have, if deferred) by kind
    and treatment, as `{"tool:stub": 2, "reasoning:drop": 1}`.
- `parts/`, where each distinct message is saved once, together with its bytes
  split by kind. A trimmed message shares a lineage with the original.

Scripts:

- `scripts/analyze-context.py [conversation dir] [--request N]` breaks one
  request's tokens down by age and by part type.
- `scripts/strip-savings.py [dir ...]` reports, per conversation, the savings
  against the cost of rewriting the cache.
- `scripts/refresh-kinds.ts <conversation dir>` relabels a conversation's
  logged parts with the current part-type rules. The proxy labels a part once,
  when it first logs it, so run this after changing the rules in `src/log.ts`.
- `scripts/reruns.py [conversation dir]` lists tool calls the model ran again
  with the same input, split by whether the earlier result had been culled
  from what the model saw: what trimming too much costs.

Tokens are estimated from a per-conversation fit: inputTokens = base + rate·bytes.

## Limits

- **Claude Code sends some requests twice in parallel** (the same history with
  a different tail). Both trim alike, but each logs its own decision, so
  `strip-savings.py` counts those advances twice.
- **Not tested: whether `/context` and auto-compact see the trimmed size.**
  The usage the API reports counts what was sent.
- **Changes to Claude Code's request shape can make it trim less**: it only
  edits the block types it knows.

## Tests

```bash
node --test tests/*.test.ts
```

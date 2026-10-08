# mini-context for Claude Code

A local proxy between Claude Code and the Anthropic API. On each request it
forwards, it trims these from completed turns:

- old tool results, replaced with a stub that gives their size,
  `[CULLED 1234 B FROM CTX]`;
- long Edit/Write inputs (`old_string`, `new_string`, `content`), replaced with
  the same stub;
- reasoning (thinking blocks).

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
`proxy.log`. It starts the proxy with both wait turns at 1 and logging on; edit
`bin/start-proxy` to change them.

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
| `--[no-]strip-tool-calls` | on | Stub tool results and long Edit/Write inputs |
| `--[no-]strip-reasoning` | on | Drop thinking |
| `--strip-tool-calls-wait-turns` | `0` | The latest N completed turns keep their tool calls whole |
| `--strip-reasoning-wait-turns` | `0` | The latest N completed turns keep their thinking |
| `--log-step-events` | off | Write the log (below) |
| `--cache-ttl-seconds` | `3600` | The cache TTL. Lower it only to test the cold path |

## What it trims

Only requests that carry tools are trimmed: the main loop and subagents. Claude
Code's side requests pass through unchanged. A conversation is keyed by its
first message, so each subagent is its own.

A turn starts at a prompt (user text that is not a tool result, a
`<system-reminder>` or a command row). The current turn, from the last prompt
on, is never touched.

Each conversation has a frontier, saved in `state/<key>.json`: the completed
turns whose tool calls, and whose reasoning, are trimmed. Every request is
trimmed up to it, so they all send the same prefix and the prompt cache keeps
reading it. The frontier only moves forward.

If the API refuses a trimmed request (400), the proxy sends it again as it
came and logs the refusal to stderr.

## When the frontier moves

On each request the proxy prices moving the frontier up to the latest
completed turns, outside the waits (`src/trim.ts`, `decide`). Let R be the
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
    advanced, cache state, saved and rewrite characters, and counts.
- `parts/`, where each distinct message is saved once, together with its bytes
  split by kind. A trimmed message shares a lineage with the original.

Scripts:

- `scripts/analyze-context.py [conversation dir] [--request N]` breaks one
  request's tokens down by age and by part type.
- `scripts/strip-savings.py [dir ...]` reports, per conversation, the savings
  against the cost of rewriting the cache.

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

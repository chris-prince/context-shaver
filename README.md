# mini-context for Claude Code

A Claude Code plugin that keeps the conversation trimmed between turns. From
completed turns it removes:

- old tool results, replaced with a stub;
- long Edit/Write inputs (`old_string`, `new_string`, `content`), replaced with a
  stub that gives the length;
- reasoning (thinking blocks).

It is the Claude Code counterpart of `../mini-context` (OpenCode). Claude Code
has no view that applies only to what is sent, so the plugin trims by answering
the engine's compaction with the trimmed transcript instead of a summary.

## Loading

```bash
claude --plugin-dir <path to this repo>
```

Options go in a settings file (`--settings <file>` or `.claude/settings.json`):

```json
{ "pluginConfigs": { "mini-context": { "options": { "logStepEvents": true } } } }
```

| Option | Default | |
| --- | --- | --- |
| `stripToolCalls` | `true` | Stub tool results and long Edit/Write inputs |
| `stripReasoning` | `true` | Drop thinking |
| `stripToolCallsWaitTurns` | `0` | The latest N completed turns keep their tool calls whole |
| `stripReasoningWaitTurns` | `0` | The latest N completed turns keep their thinking |
| `logStepEvents` | `false` | Write the log (below) |
| `cacheTtlSeconds` | `3600` | The cache TTL. Lower it only to test the cold path |

## When it trims

The policy is the cost rule from `../mini-context` (`hooks/trim.ts`, `decide`).
Let R be the characters from the first changed message onward, and S the
characters saved. Advancing costs M·R − (M+1)·S extra cache-read characters on
the next request, with M = 19, because a 1-hour cache write is 2× and a read is
0.1×. Advancing pays when that extra is at most K·S, with K = 40.

- **Warm, at the end of each turn:** apply the rule, and if it pays, compact.
- **Cold, when a prompt arrives:** the cache is cold when the time since the
  main loop's last request is longer than the TTL. Nothing is cached, so
  trimming is free and the rule always advances.

  A compaction can run only between turns. It also has to run from inside one
  of the plugin's hooks: one started from a timer skips all of the plugin's
  hooks, and the engine writes a summary instead. So the plugin lets the prompt
  in, ends its turn before the first request is sent, compacts from that
  turn's `turn.complete` (leaving the empty turn out), then submits the prompt
  again as the user's.

  This applies only to a prompt typed at an idle composer, with no attachments,
  no `@`-mentions and no slash command, because only such a prompt can be sent
  again unchanged.

The wait turns apply on a cold cache too.

## Logs

When `logStepEvents` is on, logs go to `logs-mini-ctx-claude/<session>/` under
the working directory:

- `step_events.jsonl`, with one line per event:
  - a `request` line for each main-loop request: usage, and the request's
    messages by hash;
  - a `compaction` line for each decision that had something to trim:
    advanced, cache state, saved and rewrite characters, and counts.
- `parts/`, where each distinct message is saved once, together with its bytes
  split by kind. A trimmed message shares a lineage with the original, so both
  the full version and the edited version are on disk.

The system prompt and tool definitions are not visible to a plugin.

Scripts:

- `scripts/analyze-context.py [session dir] [--request N]` breaks one request's
  tokens down by age and by part type.
- `scripts/strip-savings.py [project dir ...]` reports, per session, the savings
  against the cost of rewriting the cache.

Tokens are estimated from a per-session fit: inputTokens = base + rate·bytes.

## Limits

- **Interactive sessions only.** The cold path resubmits through the composer.
- **A trim is permanent.** It rewrites the stored transcript, not just what is
  sent.
- **Stubbing an input loses that response's thinking**, even when
  `stripReasoning` is off: the engine cannot regroup a rebuilt tool-use row
  with its thinking.
- **The TUI reprints the transcript after each compaction**
  ("Conversation compacted").
- **The resubmitted cold prompt is labelled** "Prompt from the mini-context
  plugin".

## Tests

```bash
claude plugin validate .
claude plugin test .
```

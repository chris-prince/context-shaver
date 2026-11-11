# context-shaver instructions

## Numbers in tokens

**State sizes in tokens, not bytes or characters, whenever you can.** This
project works in tokens: prices, cache reads and writes, compaction limits and
trim savings are all counted in tokens. When only bytes or characters are
known, convert them (and say the figure is converted), rather than reporting
the raw bytes.

**Prefer recorded token counts, such as API usage fields, to conversions.**
Before converting chars to tokens, look for a logged count. For example, each
summary's real `usage.output_tokens` is in the `"event":"summary"` lines of
`step_events.jsonl`; estimating summary sizes from chars at 0.39 tokens/char
once missed the real ≈0.47 (thinking included).

## Developing while routed through context-shaver

Your own session may reach the model through the proxy on port 18787 (or
`SHAVER_PORT`). If that proxy goes down and doesn't come back, you can't
recover. So:

- `bin/run-proxy --restart` (or `--update`) is fine, but not from a sandboxed
  shell, such as Codex's: it can stop the proxy, and the new one then can't
  listen. Ask the user to restart it instead.
- Never stop it (`bin/run-proxy --stop`, `/shaver/shutdown`, killing its
  process) unless the user asks, and then warn them first that it cuts off your
  own session.

Run cache/trim experiments on a separate port (for example,
`bin/node-wrapper src/server.ts --port 18788 --cache-ttl-seconds 0`) with a
separate `--dir` for test state, and route only an isolated test client through
it. Preserve the user's live routing configuration.

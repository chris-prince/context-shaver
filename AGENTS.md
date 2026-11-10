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

Never stop or restart the proxy on port 18787 from an agent session. The agent
may depend on that listener for its own model connection and cannot recover if
it goes down. Do not use `bin/run-proxy --stop` or `--restart` against that port.

Run development and cache/trim experiments on a separate port (for example,
`bin/node-wrapper src/server.ts --port 18788 --cache-ttl-seconds 0`) with a
separate `--dir` for test state. Route only an isolated test client through it.
Before testing the actual desktop app, use a separately configured test app
session or a direct-connected control session so recovery does not depend on
the proxy being tested. Preserve the user's live routing configuration.

## The running proxy

**Never stop or restart the proxy on the default port (18787, or
`SHAVER_PORT`).** Your own model requests may be routed through it, as with a
Codex desktop app whose `openai_base_url` points at it. Stopping it cuts off
your session mid-task, and you cannot start it again. Do not run
`bin/run-proxy --stop`, `--restart` or `--update`, send `/shaver/shutdown`, or
kill its process. If the user asks for one of these, warn them that it will
interrupt your own session before you run it.

To test proxy changes, start a separate proxy on another port, such as
`bin/node-wrapper src/server.ts --port 18788`, point the test at that port, and
stop only that proxy afterward. Ask the user to restart the main proxy when a
change needs it.

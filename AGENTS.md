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

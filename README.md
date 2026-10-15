# ctx-shaver

Context is expensive, and managing it is annoying. `ctx-shaver` eliminates the
pain of thinking about context, while also automatically optimizing your token
use.

You use Claude Code exactly as you would normally. `ctx-shaver` runs in the
background as a local proxy, intelligently stubbing or dropping parts of your
context that are no longer needed.

## Features

- **Lower cost.** You stop paying, request after request, for content that no
  longer matters.
- **Automatic.** Trimming happens continuously, with no commands to run.
- **Fast.** Compaction happens instantly, with no pauses to slow you down.
- **Intelligent.** Cache-aware price modeling means you optimize for true costs,
  not just raw token counts.
- **Configurable.** What gets culled is up to you, controlled by a policy file.

## Quickstart

One-time setup:
```bash
git clone https://github.com/chris-prince/ctx-shaver ~/ctx-shaver
```

Then each time you start your CLI:
```bash
~/ctx-shaver/bin/claude-via-shaver
```

`claude-via-shaver` makes sure the local proxy is running (on 127.0.0.1:8787),
then runs `claude` with an env var to route model calls through the proxy. It
works with both claude.ai logins and Claude API keys. If your model calls are
already proxied (`ANTHROPIC_BASE_URL` is set, or a wrapper sets it), ctx-shaver
chains in front of that proxy (see DESIGN.md).

When running against the proxy, the prompt `:shaver info` will return details
on how ctx-shaver is doing this session and where your context is being spent.
`: shaver info`, with a space, works too.

ctx-shaver requires only bash and Node 26. It has been tested against Claude
Code 2.1.289.

See [DESIGN.md](DESIGN.md) for options, the policy file, how trimming works,
logs, and limits.

## License

MIT. See [LICENSE](LICENSE).

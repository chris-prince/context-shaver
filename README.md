# context-shaver

Context is expensive, and managing it is annoying. `context-shaver` eliminates
the pain of thinking about context, while also automatically optimizing your
token use. It works with Claude Code, Codex and OpenCode-via-OpenRouter.

You use your coding agent exactly as you would normally. `context-shaver` runs
in the background as a local proxy, intelligently stubbing or dropping parts of
your context that are no longer needed.

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
git clone https://github.com/chris-prince/context-shaver ~/context-shaver
```

Then each time you start your CLI, use the wrapper for it:
```bash
~/context-shaver/bin/claude-via-shaver     # Claude Code
~/context-shaver/bin/codex-via-shaver      # Codex
~/context-shaver/bin/opencode-via-shaver   # OpenCode
```

Each wrapper makes sure the local proxy is running (on 127.0.0.1:8787), then
runs your CLI with its model calls routed through the proxy, leaving the CLI's
own config untouched. `claude-via-shaver` works with both claude.ai logins and
Claude API keys. If Claude Code's model calls are already proxied
(`ANTHROPIC_BASE_URL` is set, or a wrapper sets it), context-shaver chains in
front of that proxy (see DESIGN.md).

When running against the proxy, the prompt `:shaver info` will return details
on how context-shaver is doing this session and where your context is being
spent. `: shaver info`, with a space, works too.

context-shaver requires only bash and Node 26. It has been tested most
thoroughly with Claude Code 2.x, and less so with Codex 0.x and OpenCode 2.x.

See [DESIGN.md](DESIGN.md) for options, the policy file, how trimming works,
logs, and limits.

## License

MIT. See [LICENSE](LICENSE).

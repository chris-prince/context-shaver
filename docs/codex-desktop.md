# Codex desktop

A local Codex desktop app can use context-shaver by routing its model requests
through the proxy. Running a wrapper in a chat's shell does not change that
chat's connection. An MCP server or skill also cannot intercept the app's model
requests.

## Test before changing app settings

Use Node 24 or newer and an existing Codex sign-in. First check that your Codex
executable works. If `codex --version` fails because its native binary is missing,
repair the CLI installation or select a working executable with
`SHAVER_REAL_CODEX_LOCATIONS`. Some macOS installations bundle it inside the app:

```bash
export SHAVER_REAL_CODEX_LOCATIONS='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
```

That path is an example, not a stable app API. Check it exists and runs before
using it; other installations have different layouts.

From the context-shaver checkout, run:

```bash
bin/node-wrapper scripts/check-codex-desktop.ts
```

This starts or reuses the local proxy, launches an isolated app-server, creates
an ephemeral read-only session, makes **one model request using your existing
sign-in**, and checks that `shaver info` recorded it. Normal model charges or
account limits apply. It does not modify your Codex configuration, change an
existing chat, or restart the desktop app. The proxy remains available afterward.

The app-server transport was tested on macOS with the ChatGPT-bundled
`codex-cli 0.167.0-alpha.3.2`: the upstream exact-response test and the subsequent
proxy status both passed. This verifies app-server routing, authentication and
streaming, not GUI activation or long-conversation trimming. A managed app can
supply different connection settings, so also verify the actual desktop chat.

## Enable in a local desktop app

1. Keep the proxy running independently of the app, on the same host as its
   app-server. For a first test, run `bin/node-wrapper src/server.ts` in a separate
   terminal and keep it open. The default port is 18787. If a proxy is already
   running, reuse it instead of starting a second one. Arrange login startup
   before relying on it across machine restarts.
2. Back up `~/.codex/config.toml` (or the active `CODEX_HOME` configuration), then
   add this **top-level** key before any TOML table. Replace an existing value
   rather than adding a duplicate:

   ```toml
   openai_base_url = "http://127.0.0.1:18787/harness/codex/via/https%3A%2F%2Fchatgpt.com%2Fbackend-api%2Fcodex"
   ```

   This example is for the built-in OpenAI provider with ChatGPT sign-in.
   Preserve an existing custom gateway/provider; use the chaining guidance in
   [DESIGN.md](../DESIGN.md) instead of replacing its upstream. Change the port
   in both the proxy startup and URL if necessary. Provider routing belongs in
   user configuration, not a repository's `.codex/config.toml`.
3. Restart the desktop app after saving, then send a normal prompt and
   `shaver info` in a test chat. Require a proxy-generated status showing the
   preceding request. Merely receiving a model answer or seeing the proxy listen
   does not prove the app used it. If the app ignores or overrides local provider
   settings, this configuration will not attach context-shaver to it.

OpenAI documents [the base URL override](https://learn.chatgpt.com/docs/config-file/config-advanced)
and [desktop configuration and restart](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway?gateway-auth=api-key).
The proxy must stay available while the app uses it; model calls fail when it is
down. No separate working CLI installation is required for normal GUI use once
the app itself routes through the proxy.

## Roll back

Restore your previous `openai_base_url` value, or remove just the added key if it
was absent, and restart the app. Preserve any other configuration changes made
since the backup. Stop the proxy with `bin/run-proxy --stop` only when no other
sessions depend on it. No stored conversation needs to be deleted or rewritten.

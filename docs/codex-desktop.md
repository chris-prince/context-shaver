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
streaming. The actual desktop-chat test below separately confirmed GUI routing.
A managed app can supply different connection settings, so verify your own chat.

## Enable in a local desktop app

1. Keep the proxy running independently of the app, on the same host as its
   app-server. From the checkout, run `bin/run-proxy`; it starts a detached proxy
   or reuses the existing one. The default port is 18787. Its diagnostic log is
   `proxy-data/proxy.log`. Arrange login startup before relying on it across
   machine restarts; starting a detached process does not install a login service.
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

## Confirmed desktop-chat test

A manual test on macOS confirmed routing in an actual desktop chat after applying
the user-level setting and restarting the app. The chat's matching proxy journal
advanced during successive tool/model round trips with successful upstream usage
records. This test was separate from the ephemeral app-server probe.

This confirms actual desktop-chat routing and working authentication for the
tested installation. It does not establish long-conversation trimming behavior
or that every desktop build or managed environment honors the setting. The
setting affects future requests; it does not rewrite saved chat history.

If `shaver info` does not return a proxy-generated status, check for a journal
matching your chat ID and confirm that it advances after a new prompt. Avoid
publishing raw journals or request headers: they can contain private content.
To check that the expected proxy is listening without making a model request:

```bash
curl --fail --max-time 5 -H 'x-shaver: procinfo' \
  http://127.0.0.1:18787/shaver/procinfo
```

A listener check alone does not establish chat routing. If a sandboxed shell
cannot reach localhost, repeat the check in a normal local terminal before
concluding the proxy is down.

## Authentication troubleshooting

An upstream `401 Unauthorized` indicates a rejected authentication attempt.
Check for new failures before treating a historical log entry as an ongoing
problem.

If failures persist, inspect `proxy-data/proxy.log` for new upstream errors and
run the isolated probe with the same sign-in. A successful probe establishes
only its own connection; confirm the actual chat separately. If the actual
chat continues to receive 401 responses, restore the previous base URL and
restart the app to test the normal connection. Use the app's sign-in flow if
the direct connection also fails; do not copy tokens into the proxy settings
or logs.

## Isolated long tool-history trimming test

The isolated follow-up passed using the real Codex app-server and upstream model
through a dedicated listener on port 18788 with its own temporary state directory.
The live proxy on 18787 and the desktop app configuration were left untouched.

The test used synthetic content only: an earlier user-provided fact, a native
shell tool reading a 1,800-line fixture, five short checkpoint turns, then a
second shell tool and an exact recall question. A test-only policy dropped tool
history after four requests and reasoning after zero turns; text summarization
was disabled. A zero proxy cache lifetime made pruning deterministic instead of
waiting for normal cache economics to permit it.

The isolated journal showed positive removed-token counts, including on the
final request, and no untrimmed fallback. Codex recalled the earlier fact exactly
and completed the post-trim native tool call. The test-owned proxy and app-server
were terminated afterward; no live proxy restart was needed.

This validates tool-history pruning through the app-server transport used by the
desktop app with this synthetic workload. It does not validate text summarization,
default warm-cache behavior, exhaustive long-session reliability, or actual GUI
trimming. Those remain separate tests. The earlier attempt to restart the live
proxy interrupted the control session and did not establish a trimming defect.

Do not stop or restart the proxy that carries your control chat. Use a separate
listener and state directory for development experiments, for example:

```bash
bin/node-wrapper src/server.ts --port 18788 \
  --dir /tmp/context-shaver-trim-test --cache-ttl-seconds 0
```

The zero cache lifetime is a test setting, not a production recommendation.
Route an isolated client through that listener. For an actual GUI test, keep a
separate control session connected directly and configure only the test app
session. Do not change global routing underneath unrelated active chats.

A passing GUI trim test must show that the test chat's removed-token count
increased, upstream accepted the trimmed request without an untrimmed fallback,
and the chat could recall an earlier test fact and complete a tool round trip
afterward. Distinguish tool/reasoning pruning from text summarization, and
report which actually ran. Until those checks pass, GUI trimming remains
unverified even if the isolated connection probe passes.

## Roll back

Restore your previous `openai_base_url` value, or remove just the added key if it
was absent, and restart the app. Preserve any other configuration changes made
since the backup. Stop the proxy with `bin/run-proxy --stop` only when no other
sessions depend on it. No stored conversation needs to be deleted or rewritten.

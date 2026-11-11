# Codex desktop

A local Codex desktop app can use context-shaver by routing its model requests
through the proxy. Running a wrapper in a chat's shell does not change that
chat's connection. An MCP server or skill also cannot intercept the app's model
requests.

## Enable

1. Keep the proxy running independently of the app, on the same host. From the
   checkout, run `bin/run-proxy`; it starts a detached proxy or reuses the
   existing one. The default port is 18787. Its diagnostic log is
   `proxy-data/proxy.log`. The app's model calls fail while the proxy is down,
   and nothing starts it again after a reboot, so start it at login before
   relying on it.
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

   The setting routes every Codex session through the proxy, the CLI's too.
   `codex-via-shaver` still works alongside it: its own `-c openai_base_url`
   takes precedence.
3. Restart the desktop app after saving.

OpenAI documents [the base URL override](https://learn.chatgpt.com/docs/config-file/config-advanced)
and [desktop configuration and restart](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway?gateway-auth=api-key).

## Check that it worked

Send a normal prompt in a test chat, then `shaver info`. Require a
proxy-generated status showing the preceding request. Merely receiving a model
answer or seeing the proxy listen does not prove the app used it. If the app
ignores or overrides local provider settings, this configuration will not
attach context-shaver to it. The setting affects future requests; it does not
rewrite saved chat history.

If `shaver info` does not return a proxy-generated status, check for a journal
in `proxy-data/logs/` matching your chat ID and confirm that it advances after a
new prompt. Avoid publishing raw journals or request headers: they can contain
private content. To check that the proxy is listening without making a model
request:

```bash
curl --fail --max-time 5 -H 'x-shaver: procinfo' \
  http://127.0.0.1:18787/shaver/procinfo
```

A listener check alone does not establish chat routing. If a sandboxed shell
cannot reach localhost, repeat the check in a normal local terminal before
concluding the proxy is down.

## Authentication troubleshooting

An upstream `401 Unauthorized` indicates a rejected authentication attempt.
Check `proxy-data/proxy.log` for new failures before treating a historical entry
as an ongoing problem. If the chat keeps receiving 401 responses, restore the
previous base URL and restart the app to test the normal connection. Use the
app's sign-in flow if the direct connection also fails; do not copy tokens into
the proxy settings or logs.

## Roll back

Restore your previous `openai_base_url` value, or remove just the added key if it
was absent, and restart the app. Preserve any other configuration changes made
since the backup. Stop the proxy with `bin/run-proxy --stop` only when no other
sessions depend on it. No stored conversation needs to be deleted or rewritten.

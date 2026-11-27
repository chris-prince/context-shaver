# Runs a benchmark's turns with Codex rather than Claude Code, for the bench
# runners (run.sh, local/bench/multiturn/run.sh) to source when
# BENCH_HARNESS=codex. The model is BENCH_MODEL (default gpt-6.1-sol), at
# BENCH_CODEX_EFFORT (default medium).
#
# Codex gets a home of its own in the run, with none of the user's config or
# history, signed in through the real auth file. With ChatGPT sign-in its
# requests go on to ChatGPT's Codex backend, as codex-via-shaver sends them;
# with CODEX_API_KEY set, to the OpenAI API, billed to that key.

# codex_home <dir>
codex_home() {
  mkdir -p "$1"
  ln -s ~/.codex/auth.json "$1/auth.json"
  printf 'model_reasoning_effort = "%s"\n' "${BENCH_CODEX_EFFORT:-medium}" >"$1/config.toml"
}

# codex_base <proxy port>: the base URL Codex is given, naming the harness and
# the upstream for the proxy. With DUMMY=1 it names no upstream, so the
# proxy's own, the dummy, answers.
codex_base() {
  local up=https://chatgpt.com/backend-api/codex
  [[ -z ${CODEX_API_KEY:-} ]] || up=https://api.openai.com/v1
  [[ -z ${DUMMY:-} ]] || { printf 'http://127.0.0.1:%s/harness/codex' "$1"; return; }
  printf 'http://127.0.0.1:%s/harness/codex/via/%s' "$1" \
    "$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$up")"
}

# codex_cmd <home> <base> <thread file>: sets cmd to one turn's command, the
# prompt on stdin, resuming the thread named in the thread file if there is
# one. Run it in the work directory, inside the sandbox; its --json output's
# thread.started line names the thread (codex_thread).
codex_cmd() {
  local resume=()
  [[ ! -s $3 ]] || resume=(resume "$(cat "$3")")
  cmd=(env CODEX_HOME="$1" codex exec ${resume[@]+"${resume[@]}"} -m "${BENCH_MODEL:-gpt-6.1-sol}"
    -c "openai_base_url=\"$2\"" --dangerously-bypass-approvals-and-sandbox
    --skip-git-repo-check --json -)
}

# codex_thread <turn output> <thread file>: saves the thread a first turn started.
codex_thread() {
  [[ -s $2 ]] || sed -n 's/.*"type":"thread.started","thread_id":"\([^"]*\)".*/\1/p' "$1" | head -1 >"$2"
}

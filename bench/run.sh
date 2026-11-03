#!/bin/bash
# A benchmark of one turn: Claude Code given one prompt on a fresh checkout of
# this repo, through a scratch proxy with the policy to try. macOS only
# (sandbox-exec, cp -c).
#   run.sh run <name> <policy>
# The task is set in the environment:
#   BENCH_COMMIT       the commit the checkout starts at. It has no later
#                      commits, so the run can't look ahead.
#   BENCH_PROMPT       a file holding the turn's prompt
#   BENCH_PATCH        a patch (git format-patch) committed on top, such as a
#                      feature to try that's newer than BENCH_COMMIT (optional)
#   BENCH_PROXY_COMMIT the commit the scratch proxy runs (optional; by default
#                      BENCH_COMMIT with BENCH_PATCH), such as one that reads a
#                      newer policy format. Not for live runs, whose proxy is
#                      the agent's own checkout.
#   BENCH_PROXY_PATCH  a patch for the scratch proxy's code only, on top of
#                      BENCH_PROXY_COMMIT if set (optional)
#   BENCH_SETUP        a script that adds what the turn starts from to each
#                      fresh run (optional), run as
#                      BENCH_SETUP <run dir> <projects dir> <session id>.
#                      The checkout is <run dir>/repo; a transcript written to
#                      <projects dir>/<session id>.jsonl is resumed.
#   BENCH_PROXY_CONVO_KEY
#                      the conversation key the setup's proxy-data holds the
#                      transcript's records under, for live runs (optional)
#   BENCH_RESULTS      where results/<name> go (default
#                      /private/tmp/shaver-bench/results)
#   BENCH_SCORER       a script that scores a finished run (optional), run as
#                      BENCH_SCORER <results>/<name>/repo <results>/<name>
set -euo pipefail
B=$(cd "$(dirname "$0")" && pwd)
REAL=$(cd "$B/.." && pwd)
: "${BENCH_COMMIT:?}" "${BENCH_PROMPT:?}"
RESULTS=${BENCH_RESULTS:-/private/tmp/shaver-bench/results}
# A fresh session ID for each run, so a run never shares one with the session
# that recorded it.
SID=$(uuidgen | tr A-Z a-z)
# Each run takes a free slot N, so runs can go at once: its own directory,
# outside the real repo so the run doesn't load its instruction files, and the
# ten ports from 8800+10N: +1 the proxy the run goes through, +2 the dummy
# upstream.
mkdir -p /private/tmp/shaver-bench
for SLOT in $(seq 0 9); do
  P0=$((8800 + 10 * SLOT))
  lsof -tiTCP:$P0-$((P0 + 9)) -sTCP:LISTEN >/dev/null && continue
  mkdir /private/tmp/shaver-bench/slot$SLOT.lock 2>/dev/null && break
  SLOT=
done
[[ -n $SLOT ]] || { echo "no free slot in /private/tmp/shaver-bench" >&2; exit 1; }
W=/private/tmp/shaver-bench/run$SLOT
RUN=$W/repo
# The scratch proxy's code, outside $W so the run can't read it.
PCODE=/private/tmp/shaver-bench/proxy$SLOT
esc() { sed 's/[^A-Za-z0-9]/-/g' <<<"$1"; }
PROJ=~/.claude/projects/$(esc "$RUN")
PORT=$((P0 + 1)) DUMMY_PORT=$((P0 + 2))
# A live run's proxy outlives claude -p, and may be one the agent restarted, so
# stop whatever is on the port with the slot, and the dummy upstream if the run
# stopped early.
done_slot() {
  lsof -tiTCP:$PORT -sTCP:LISTEN | xargs kill 2>/dev/null || true
  kill $(cat "$W/dummy.pid" 2>/dev/null) 2>/dev/null || true
  rmdir /private/tmp/shaver-bench/slot$SLOT.lock
}
trap done_slot EXIT

# A clone holding only the commit and what it descends from, with the patch
# committed on top.
checkout() { # <dir> <commit> [patch]
  git clone -q --no-local --no-tags --single-branch -b main "$REAL" "$1"
  git -C "$1" reset -q --hard "$2"
  git -C "$1" remote remove origin
  git -C "$1" reflog expire --expire=now --all
  git -C "$1" gc -q --prune=now
  [[ -z ${3:-} ]] || git -C "$1" am -q --committer-date-is-author-date "$3"
}

fresh() { # <policy>
  rm -rf "$W" "$PCODE" "$PROJ"
  mkdir -p "$W" "$PROJ"
  checkout "$RUN" "$BENCH_COMMIT" "${BENCH_PATCH:-}"
  # The scratch proxy runs the code as of the turn's start, apart from the
  # checkout the agent edits, unless BENCH_PROXY_COMMIT names other code.
  if [[ -n ${BENCH_PROXY_COMMIT:-} ]]; then checkout "$PCODE" "$BENCH_PROXY_COMMIT"
  else checkout "$PCODE" "$BENCH_COMMIT" "${BENCH_PATCH:-}"; fi
  [[ -z ${BENCH_PROXY_PATCH:-} ]] || git -C "$PCODE" am -q "$BENCH_PROXY_PATCH"
  [[ -z ${BENCH_SETUP:-} ]] || "$BENCH_SETUP" "$W" "$PROJ" "$SID"
  [[ -n ${ALLOW_LIVE_TESTING:-} && -n ${BENCH_PROXY_CONVO_KEY:-} && -f $PROJ/$SID.jsonl ]] && adopt "$1"
  return 0
}

# A live run's proxy keys the conversation by its first message, which names
# the run directory, so the setup's records are moved to the key a resume
# through the dummy upstream gets: everything the proxy keeps per conversation
# is named for its key, wherever it is. The resume's turn is undone.
adopt() { # <policy>
  local old=$BENCH_PROXY_CONVO_KEY
  cp "$PROJ/$SID.jsonl" "$W/transcript.tmp"
  node "$B/dummy.mjs" $DUMMY_PORT & echo $! >"$W/dummy.pid"
  proxy "$W/probe" "$1" http://127.0.0.1:$DUMMY_PORT
  agent 'say hi' >/dev/null 2>&1 || true
  kill "$(cat "$W/proxy.pid")" "$(cat "$W/dummy.pid")"
  rm "$W/dummy.pid"
  local new=$(ls "$W/probe/logs")
  [[ $new == claude-$SID-main-???????? ]] || { echo "no conversation key from the probe: $new" >&2; exit 1; }
  mv "$W/transcript.tmp" "$PROJ/$SID.jsonl"
  rm -rf "$W/probe" "$W/proxy.pid" "$W/proxy.log"
  local named=$(find "$RUN/proxy-data" -name "$old*" -prune)
  [[ -n $named ]] || { echo "nothing in the setup's proxy-data is named for $old" >&2; exit 1; }
  while IFS= read -r f; do mv "$f" "$(dirname "$f")/$new${f##*/$old}"; done <<<"$named"
}

# A live run goes through a proxy started from its own checkout by its own
# bin/run-proxy, with the policy as the checkout's policy.json, as a real
# session does, so the agent can restart it to try its fixes. Its logs stay in
# the checkout's proxy-data, linked from the run's proxy/.
live_proxy() { # <policy>
  cp "$1" "$RUN/policy.json"
  (cd "$RUN" && SHAVER_PORT=$PORT bin/run-proxy --log)
  ln -s repo/proxy-data "$W/proxy"
}

proxy() { # <dir> <policy> [upstream]
  "$PCODE/bin/node-wrapper" "$PCODE/src/server.ts" --port $PORT \
    --dir "$1" --policy "$2" --log-step-events ${3:+--upstream "$3"} >"$W/proxy.log" 2>&1 &
  echo $! >"$W/proxy.pid"
  for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && return; sleep 0.1; done
  echo "proxy did not start" >&2; exit 1
}

agent() { # <prompt>
  local deny=(--disallowedTools 'Bash(*run-proxy*)')
  [[ -n ${ALLOW_LIVE_TESTING:-} ]] && deny=()
  local session=(--session-id $SID)
  [[ -f $PROJ/$SID.jsonl ]] && session=(--resume $SID)
  (cd "$RUN" && env -u CLAUDECODE ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT ${ALLOW_LIVE_TESTING:+SHAVER_PORT=$PORT} \
    sandbox-exec -f "$B/sandbox.sb" -D REAL="$REAL" -D RUN="$W" -D HOME="$HOME" \
      -D BENCH=/private/tmp/shaver-bench \
      -D PROJECTS="$HOME/.claude/projects/$(esc "$REAL")" \
      -D SCRATCH="/private/tmp/claude-$(id -u)" -D OWN_SCRATCH="/private/tmp/claude-$(id -u)/$(esc "$RUN")" \
    claude -p "${session[@]}" --model claude-opus-5-5 --strict-mcp-config \
      ${MAX_TURNS:+--max-turns $MAX_TURNS} --permission-mode bypassPermissions ${deny[@]+"${deny[@]}"} \
      --output-format stream-json --verbose "$1")
}

case $1 in
run)
  name=$2 policy=$(cd "$(dirname "$3")" && pwd)/$(basename "$3")
  [[ -n ${ALLOW_LIVE_TESTING:-} && -n ${DUMMY:-} ]] && { echo "DUMMY doesn't go with ALLOW_LIVE_TESTING" >&2; exit 1; }
  [[ -n ${ALLOW_LIVE_TESTING:-} && -n ${BENCH_PROXY_COMMIT:-} ]] && { echo "BENCH_PROXY_COMMIT doesn't go with ALLOW_LIVE_TESTING: a live run goes through a proxy the agent starts from its own checkout, at BENCH_COMMIT" >&2; exit 1; }
  fresh "$policy"
  before=$(git -C "$REAL" status --porcelain; git -C "$REAL" rev-parse HEAD)
  # MAX_TURNS=N stops the run after N turns, for a short quota test.
  # ALLOW_LIVE_TESTING=1 runs it as a real session runs (live_proxy), and
  # lets the agent restart that proxy with bin/run-proxy. Without it the run
  # goes through a proxy of the turn's start's code, and run-proxy is denied.
  # PROMPT=text replaces BENCH_PROMPT, for a short test.
  # DUMMY=1 sends the run's requests to the dummy upstream, to check its first
  # request without reaching the API.
  [[ -n ${DUMMY:-} ]] && { mkdir "$W/bodies"; node "$B/dummy.mjs" $DUMMY_PORT "$W/bodies" & echo $! >"$W/dummy.pid"; }
  # The proxy starts empty: what the turn starts from is in the checkout's
  # proxy-data, as the task's data.
  if [[ -n ${ALLOW_LIVE_TESTING:-} ]]; then live_proxy "$policy"
  else proxy "$W/proxy" "$policy" ${DUMMY:+http://127.0.0.1:$DUMMY_PORT}; fi
  start=$(date +%s)
  date -u +%Y-%m-%dT%H:%M:%S >"$W/start"
  agent "${PROMPT:-$(cat "$BENCH_PROMPT")}" >"$W/agent.jsonl" 2>"$W/agent.err" || true
  echo "seconds $(( $(date +%s) - start ))" >"$W/time"
  kill $(cat "$W/dummy.pid" 2>/dev/null) 2>/dev/null || true
  lsof -tiTCP:$PORT -sTCP:LISTEN | xargs kill 2>/dev/null || true
  after=$(git -C "$REAL" status --porcelain; git -C "$REAL" rev-parse HEAD)
  [[ $before == "$after" ]] || echo "WARNING: the real repo changed during the run" >&2
  mkdir -p "$RESULTS"
  rm -rf "$RESULTS/$name"
  mv "$W" "$RESULTS/$name"
  [[ ! -f $PROJ/$SID.jsonl ]] || cp "$PROJ/$SID.jsonl" "$RESULTS/$name/transcript.jsonl"
  echo "results in $RESULTS/$name"
  [[ -z ${BENCH_SCORER:-} || -n ${DUMMY:-} ]] || "$BENCH_SCORER" "$RESULTS/$name/repo" "$RESULTS/$name"
  ;;
esac

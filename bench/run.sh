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
#   BENCH_CLAUDE_UPSTREAM
#                      the base URL the benchmarked Claude's requests go on to,
#                      such as a gateway (optional; default the proxy's own).
#                      Sent by /via/, so live runs' proxies honor it too, and
#                      passed to the agent, for BENCH_CLAUDE_COMMAND to use.
#   BENCH_CLAUDE_COMMAND, BENCH_CODEX_COMMAND, BENCH_OPENCODE_COMMAND
#                      how to run each harness on this machine, such as through
#                      a gateway (optional). Each one set is passed to the agent
#                      in its environment; the prompt says to use it.
#   BENCH_TEST_HARNESSES
#                      harnesses the agent may run to test its work, such as
#                      codex,opencode (optional). Each gets a home in the run,
#                      with its config and skills but none of its history,
#                      signed in through the real auth file.
#   BENCH_FIRST_REQUEST_TIMEOUT
#                      seconds to wait for the run's first request to reach the
#                      scratch proxy before stopping it (default 180)
# The agent also gets BENCH_AGENT_PORT, a port it may run a proxy of its own on,
# and TMPDIR, a temp directory of the run's own.
#
# How this machine runs the harnesses (the BENCH_*_COMMAND settings,
# BENCH_CLAUDE_UPSTREAM, and a PATH that finds the right claude) can go in a
# file of VAR=value lines named by BENCH_LOCAL_ENV, loaded at the start of every
# run. A value already set, such as a task's or one given on the command line,
# wins, except PATH, which the file may build on as PATH=…:$PATH.
set -euo pipefail
B=$(cd "$(dirname "$0")" && pwd)
REAL=$(cd "$B/.." && pwd)
LOCAL_ENV=${BENCH_LOCAL_ENV:-}
if [[ -n $LOCAL_ENV ]]; then
  [[ -f $LOCAL_ENV ]] || { echo "BENCH_LOCAL_ENV: no file $LOCAL_ENV" >&2; exit 1; }
  while IFS= read -r -d '' kv; do
    n=${kv%%=*}
    [[ -n ${!n+x} && $n != PATH ]] || export "$kv"
  done < <(bash -c 'set -a; . "$1"; env -0' _ "$LOCAL_ENV")
fi
: "${BENCH_COMMIT:?}" "${BENCH_PROMPT:?}"
RESULTS=${BENCH_RESULTS:-/private/tmp/shaver-bench/results}
# A fresh session ID for each run, so a run never shares one with the session
# that recorded it.
SID=$(uuidgen | tr A-Z a-z)
# Each run takes a free slot N, so runs can go at once: its own directory,
# outside the real repo so the run doesn't load its instruction files, and the
# ten ports from 8800+10N: +1 the proxy the run goes through, +2 the dummy
# upstream, +3 BENCH_AGENT_PORT.
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
PORT=$((P0 + 1)) DUMMY_PORT=$((P0 + 2)) AGENT_PORT=$((P0 + 3))
# A live run's proxy outlives claude -p, and may be one the agent restarted, so
# stop whatever is on the port with the slot, and on the agent's own port, and
# the dummy upstream if the run stopped early.
done_slot() {
  lsof -tiTCP:$PORT -sTCP:LISTEN | xargs kill 2>/dev/null || true
  lsof -tiTCP:$AGENT_PORT -sTCP:LISTEN | xargs kill 2>/dev/null || true
  kill $(cat "$W/dummy.pid" 2>/dev/null) 2>/dev/null || true
  unhome
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

# Each test harness runs through $W/bin/<name>, which points it at its home in
# $W/home/<name>; the sandbox keeps it out of its real data.
homes() {
  local h real
  for h in ${BENCH_TEST_HARNESSES//,/ }; do
    real=$(command -v "$h") || { echo "BENCH_TEST_HARNESSES: no $h on PATH" >&2; exit 1; }
    mkdir -p "$W/bin" "$W/home/$h"
    case $h in
      codex)
        local f
        for f in config.toml rules skills plugins; do
          [[ ! -e ~/.codex/$f ]] || cp -cR ~/.codex/$f "$W/home/codex/"
        done
        ln -s ~/.codex/auth.json "$W/home/codex/auth.json"
        printf '#!/bin/bash\nCODEX_HOME=%q exec %q "$@"\n' "$W/home/codex" "$real" >"$W/bin/codex" ;;
      opencode)
        # --standalone, as the background service runs outside the sandbox
        # (and on a fixed port), and service.json holds that service's
        # password. Sign-ins are in opencode.db with the history, so the run
        # gets its own database holding only them.
        mkdir -p "$W/home/opencode/config" "$W/home/opencode/data" "$W/home/opencode/state"
        cp -cR ~/.config/opencode "$W/home/opencode/config/"
        rm -f "$W/home/opencode/config/opencode/service.json"
        printf '#!/bin/bash\nXDG_CONFIG_HOME=%q XDG_DATA_HOME=%q XDG_STATE_HOME=%q exec %q --standalone "$@"\n' \
          "$W/home/opencode/config" "$W/home/opencode/data" "$W/home/opencode/state" "$real" >"$W/bin/opencode"
        chmod +x "$W/bin/opencode"
        (cd "$RUN" && "$W/bin/opencode" auth list >/dev/null)
        local t sql="ATTACH '$HOME/.local/share/opencode/opencode.db' AS real;"
        for t in credential account account_state control_account; do sql+="INSERT INTO $t SELECT * FROM real.$t;"; done
        sqlite3 "$W/home/opencode/data/opencode/opencode.db" "$sql" ;;
      *) echo "BENCH_TEST_HARNESSES: $h isn't codex or opencode" >&2; exit 1 ;;
    esac
    chmod +x "$W/bin/$h"
  done
}

# The homes hold copies of the user's config and sign-ins, so they don't
# outlive the run; the agent's proxy has recorded the test harnesses' requests.
unhome() { rm -rf "$W/home" "$W/bin"; }

fresh() { # <policy>
  rm -rf "$W" "$PCODE" "$PROJ"
  mkdir -p "$W/tmp" "$PROJ"
  checkout "$RUN" "$BENCH_COMMIT" "${BENCH_PATCH:-}"
  # The scratch proxy runs the code as of the turn's start, apart from the
  # checkout the agent edits, unless BENCH_PROXY_COMMIT names other code.
  if [[ -n ${BENCH_PROXY_COMMIT:-} ]]; then checkout "$PCODE" "$BENCH_PROXY_COMMIT"
  else checkout "$PCODE" "$BENCH_COMMIT" "${BENCH_PATCH:-}"; fi
  [[ -z ${BENCH_PROXY_PATCH:-} ]] || git -C "$PCODE" am -q "$BENCH_PROXY_PATCH"
  homes
  [[ -z ${BENCH_SETUP:-} ]] || "$BENCH_SETUP" "$W" "$PROJ" "$SID"
  [[ -n ${ALLOW_LIVE_TESTING:-} && -n ${BENCH_PROXY_CONVO_KEY:-} && -f $PROJ/$SID.jsonl ]] && adopt "$1"
  return 0
}

# A live run's proxy keys the conversation by its first message, which names
# the run directory, so the setup's records are moved to the key a resume
# through the dummy upstream gets: everything the proxy keeps per conversation
# is named for its key, wherever it is. The resume's turn is undone.
adopt() { # <policy>
  local old=$BENCH_PROXY_CONVO_KEY probing=1
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
  local cmds=(BENCH_AGENT_PORT=$AGENT_PORT) v
  for v in BENCH_CLAUDE_UPSTREAM BENCH_CLAUDE_COMMAND BENCH_CODEX_COMMAND BENCH_OPENCODE_COMMAND; do
    [[ -z ${!v:-} ]] || cmds+=("$v=${!v}")
  done
  [[ ! -d $W/bin ]] || cmds+=("PATH=$W/bin:$PATH")
  # The dummy upstream and adopt()'s probe answer here, so they skip /via/.
  local base=http://127.0.0.1:$PORT
  [[ -z ${BENCH_CLAUDE_UPSTREAM:-} || -n ${DUMMY:-} || -n ${probing:-} ]] ||
    base+=/via/$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$BENCH_CLAUDE_UPSTREAM")
  # The prompt goes on stdin, out of process listings, where a pkill -f or ps
  # pattern could match it.
  (cd "$RUN" && env -u CLAUDECODE ANTHROPIC_BASE_URL=$base TMPDIR=$W/tmp ${ALLOW_LIVE_TESTING:+SHAVER_PORT=$PORT} ${cmds[@]+"${cmds[@]}"} \
    sandbox-exec -f "$B/sandbox.sb" -D REAL="$REAL" -D RUN="$W" -D HOME="$HOME" \
      -D BENCH=/private/tmp/shaver-bench \
      -D PROJECTS="$HOME/.claude/projects/$(esc "$REAL")" \
      -D SCRATCH="/private/tmp/claude-$(id -u)" -D OWN_SCRATCH="/private/tmp/claude-$(id -u)/$(esc "$RUN")" \
    claude -p "${session[@]}" --model claude-opus-5-5 --strict-mcp-config \
      ${MAX_TURNS:+--max-turns $MAX_TURNS} --permission-mode bypassPermissions ${deny[@]+"${deny[@]}"} \
      --output-format stream-json --verbose <<<"$1")
}

# True once the proxy has logged one of the run's requests, and with DUMMY=1
# once the dummy upstream has had one.
reached() {
  [[ -n $(find "$W/proxy/logs" -newer "$W/start" -type f 2>/dev/null | head -1) ]] &&
    [[ -z ${DUMMY:-} || -n $(ls "$W/bodies") ]]
}
kill_tree() { local c; for c in $(pgrep -P "$1"); do kill_tree "$c"; done; kill "$1" 2>/dev/null || true; }

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
  # proxy-data, as the task's data. Its own upstream is the gateway too, for
  # what Claude Code sends to the base URL's origin, which drops /via/.
  up=${BENCH_CLAUDE_UPSTREAM:-}
  [[ -z ${DUMMY:-} ]] || up=http://127.0.0.1:$DUMMY_PORT
  if [[ -n ${ALLOW_LIVE_TESTING:-} ]]; then live_proxy "$policy"
  else proxy "$W/proxy" "$policy" $up; fi
  start=$(date +%s)
  date -u +%Y-%m-%dT%H:%M:%S >"$W/start"
  # A run whose requests go around the proxy (a launcher that sets its own base
  # URL, or another claude on PATH) measures nothing, and one stuck before its
  # first request would wait out any outer timeout, so either fails the run.
  agent "${PROMPT:-$(cat "$BENCH_PROMPT")}" >"$W/agent.jsonl" 2>"$W/agent.err" &
  apid=$! limit=${BENCH_FIRST_REQUEST_TIMEOUT:-180} waited=0
  while kill -0 $apid 2>/dev/null && ! reached; do
    ((waited++ < limit)) || { kill_tree $apid; break; }
    sleep 1
  done
  wait $apid || true
  bypass=
  reached || bypass="no request reached the scratch proxy$( ((waited <= limit)) || echo " in $limit s"); check PATH (claude is $(command -v claude)) and BENCH_CLAUDE_UPSTREAM"
  [[ -z $bypass ]] || echo "$bypass" >>"$W/agent.err"
  echo "seconds $(( $(date +%s) - start ))" >"$W/time"
  kill $(cat "$W/dummy.pid" 2>/dev/null) 2>/dev/null || true
  lsof -tiTCP:$PORT -sTCP:LISTEN | xargs kill 2>/dev/null || true
  after=$(git -C "$REAL" status --porcelain; git -C "$REAL" rev-parse HEAD)
  [[ $before == "$after" ]] || echo "WARNING: the real repo changed during the run" >&2
  mkdir -p "$RESULTS"
  rm -rf "$RESULTS/$name"
  unhome
  mv "$W" "$RESULTS/$name"
  [[ ! -f $PROJ/$SID.jsonl ]] || cp "$PROJ/$SID.jsonl" "$RESULTS/$name/transcript.jsonl"
  echo "results in $RESULTS/$name"
  [[ -z $bypass ]] || { echo "FAILED: $bypass" >&2; exit 1; }
  [[ -z ${BENCH_SCORER:-} || -n ${DUMMY:-} ]] || "$BENCH_SCORER" "$RESULTS/$name/repo" "$RESULTS/$name"
  ;;
esac

#!/usr/bin/env python3
"""Break down a request's context by age, then by part type.

Reads the proxy's logs under logs-mini-ctx-claude/<conversation>/: the `request`
lines of step_events.jsonl, each listing the request's messages by hash, and
beside each message its parts/<hash>.kinds.json, the message's bytes split by
kind (src/log.ts).

The log holds the messages but not the system prompt or tool definitions, so a
request's tokens are fitted across the session as base + rate x message bytes,
by least squares over the session's requests: `base` is the unseen system prompt
and tools, and `rate` turns a message's bytes by kind into tokens. Logged bytes
of kind `system` -- what Claude Code injects before the first response,
CLAUDE.md and the environment block among it -- are base too. What it injects
later shows as `harness`.

By age: base, then the message content grouped by how many calendar days (local
time) before the request each message first appeared -- oldest first, then
"today" -- and the frontier, the reasoning and tool calls and results still sent
whole past where the request's frontier ends (its `frontierEnd`, a message
index each for tools and reasoning). Behind that end, what is still whole is
trimmed as far as it will be, so it persists: a call with no input to stub, or
a result too short to stub. Requests logged before `frontierEnd`
count all of it as frontier. A trimmed message ages as the message it replaced: the two share a
lineage (role and tool id), and the earliest first appearance among the hashes
carrying it wins.

By part type: the same kinds, the frontier left out, since it is what the next
trims remove. What persists whole behind the frontier shows under its own kind:
toolCalls, toolResults and reasoning.

Usage:
    scripts/analyze-context.py                 # newest session, latest request
    scripts/analyze-context.py <session dir>   # a specific session
    scripts/analyze-context.py <session dir> --request 42
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import sys
from collections import defaultdict

# The kinds the frontier holds back, each with the frontier that trims it.
FRONTIER = {"reasoning": "reasoning", "toolCalls": "tools", "toolResults": "tools"}
TYPE_ORDER = ["base", "user", "harness", "assistant", "toolCalls", "toolCallsStubbed", "toolResults", "toolResultsStubbed", "reasoning", "other"]


def requests(session_dir: str) -> list[dict]:
    """The session's request lines with usage, in file order."""
    out = []
    try:
        lines = open(os.path.join(session_dir, "step_events.jsonl"), encoding="utf-8").read().splitlines()
    except OSError:
        return []
    for line in lines:
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("event") == "request" and e.get("inputTokens") and e.get("parts") is not None:
            out.append(e)
    return out


def newest_session(logs: str) -> str | None:
    files = glob.glob(os.path.join(logs, "*", "step_events.jsonl"))
    return os.path.dirname(max(files, key=os.path.getmtime)) if files else None


def local_date(stamp: str | None) -> dt.date | None:
    if not stamp:
        return None
    return dt.datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone().date()


def message_bytes(r: dict) -> int:
    return sum(p["bytes"] for p in r["parts"])


def fit(reqs: list[dict]) -> tuple[float, float] | None:
    """(base, rate) fitting inputTokens = base + rate x message bytes."""
    xs = [message_bytes(r) for r in reqs]
    ys = [r["inputTokens"] for r in reqs]
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None
    rate = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    return my - rate * mx, rate


def sidecar(parts_dir: str, h: str) -> dict:
    try:
        with open(os.path.join(parts_dir, h + ".kinds.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def percent(value: float, total: float) -> int:
    return int(value / total * 100 + 0.5) if total else 0


def row(label: str, value: float, total: float, show_percent: bool = True) -> str:
    line = f"  {label:<20}{value:>12,.0f}"
    return line + f"  ({percent(value, total):>2}%)" if show_percent else line


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("session", nargs="?", help="session dir (default: newest under --logs)")
    parser.add_argument("--request", type=int, help="request index to analyze (default: the latest)")
    parser.add_argument("--logs", default="logs-mini-ctx-claude", help="logs directory (default: logs-mini-ctx-claude)")
    args = parser.parse_args()

    session = args.session or newest_session(args.logs)
    reqs = requests(session) if session else []
    if not reqs:
        print(f"no request lines with usage under {session or args.logs}", file=sys.stderr)
        return 1
    index = len(reqs) - 1 if args.request is None else args.request
    if not 0 <= index < len(reqs):
        print(f"request {index} is out of range (0-{len(reqs) - 1})", file=sys.stderr)
        return 1
    request = reqs[index]
    model = request.get("model")
    fitted = fit([r for r in reqs if r.get("model") == model])
    if not fitted:
        print("too few requests of different sizes to fit base and rate", file=sys.stderr)
        return 1
    base_fit, rate = fitted

    parts_dir = os.path.join(session, "parts")
    seen: dict[str, str] = {}
    for r in reqs:
        for p in r["parts"]:
            seen.setdefault(p["hash"], r["time"])
    side = {h: sidecar(parts_dir, h) for h in seen}
    born_by_lineage: dict[str, str] = {}
    for h, t in seen.items():
        key = side[h].get("lineage")
        if key and (key not in born_by_lineage or t < born_by_lineage[key]):
            born_by_lineage[key] = t

    ref = local_date(request["time"])
    by_day: dict[int, float] = defaultdict(float)
    by_type: dict[str, float] = defaultdict(float)
    frontier = 0.0
    ends = request.get("frontierEnd")
    for i, p in enumerate(request["parts"]):
        h = p["hash"]
        kinds = side[h].get("kinds") or {p["part"]: p["bytes"]}
        key = side[h].get("lineage")
        day = local_date(born_by_lineage.get(key, seen[h]) if key else seen[h])
        for kind, n in kinds.items():
            if kind == "system":
                continue  # base, which the request's tokens leave below
            tokens = n * rate
            if kind in FRONTIER and not (ends and i < ends[FRONTIER[kind]]):
                frontier += tokens
                continue
            by_type[kind] += tokens
            by_day[(ref - day).days] += tokens

    total = float(request["inputTokens"])
    # The fit is approximate; the base is what the request's own tokens leave.
    base = total - frontier - sum(by_type.values())
    persist = total - frontier

    print(f"Date: {ref}")
    print(f"Request #{index} of {len(reqs)} in session {os.path.basename(session)}")
    print(f"Model: {model}")
    print(f"Fit: base {base_fit:,.0f} tokens, rate {rate:.3f} tokens per byte ({message_bytes(request):,} message bytes)")

    print("\nTokens by age (in calendar days, local time)")
    print(row("base", base, total))
    for d in sorted((d for d in by_day if d > 0), reverse=True):
        print(row(f"{d} day{'s' if d != 1 else ''} ago", by_day[d], total))
    if by_day.get(0):
        print(row("today", by_day[0], total))
    if frontier:
        print(row("frontier", frontier, total))
    print(row("TOTAL", total, total, show_percent=False))

    print("\nTokens by part type (frontier left out)")
    for key in TYPE_ORDER:
        value = base if key == "base" else by_type.get(key, 0.0)
        if key in ("reasoning", "other") and not value:
            continue
        print(row(key, value, persist))
    print(row("TOTAL", persist, persist, show_percent=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

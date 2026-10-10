#!/usr/bin/env python3
"""Break down a request's context by age, then by part type.

Reads the proxy's logs under proxy-data/logs/<conversation>/: the `request`
lines of step_events.jsonl, each listing the request's system blocks, tool
definitions and messages with their bytes, and beside each message its
parts/<hash>.kinds.json, the message's bytes split by kind (src/log.ts).

The base is the system prompt, the tools sent in full, and the preamble: what
Claude Code injects before the first response (CLAUDE.md and the environment
block among them), the kind src/log.ts calls `system`. Its tokens are the
conversation's first request's, as the API reported them, less its other
parts (the prompt among them, about 5%, shared by bytes); within the base,
they are split among those three by bytes. The rest of a request's reported tokens are
shared among the rest it sent by bytes. Deferred tools a tool search has
loaded since are `toolsLoaded`. What Claude Code injects later shows as
`harness`. Conversations logged from partway through, or before the system
blocks and tools were, sit outside the analysis.

By age: base, then the message content grouped by how many calendar days (local
time) before the request each message first appeared -- oldest first, then
"today" -- and the frontier, the reasoning and tool calls and results still sent
whole past where the request's trimming ends (its `trimmedEnd`, a message
index each for tools and reasoning: the furthest any of the policy's rules
reach). Behind that end, what is still whole has had its first treatment, so
it persists until a later rule drops it: a call with no input to stub, or a
result too short to stub. Requests logged without `trimmedEnd` (the older
`frontierEnd` meant the same) count all of it as frontier. A trimmed message ages as the message it replaced: the two share a
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

import defs

# The kinds the frontier holds back, each with the frontier that trims it.
FRONTIER = {"reasoning": "reasoning", "toolCalls": "tools", "toolResults": "tools"}
TYPE_ORDER = ["systemPrompt", "tools", "preamble", "toolsLoaded", "user", "harness", "assistant", "toolCalls", "toolCallsStubbed", "toolResults", "toolResultsStubbed", "toolResultsSkill", "reasoning", "other"]


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
        if e.get("event") == "request" and e.get("inputTokens") and e.get("tools") is not None:
            out.append(e)
    return out


def newest_session(logs: str) -> str | None:
    files = glob.glob(os.path.join(logs, "*", "step_events.jsonl"))
    return os.path.dirname(max(files, key=os.path.getmtime)) if files else None


def local_date(stamp: str | None) -> dt.date | None:
    if not stamp:
        return None
    return dt.datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone().date()


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
    parser.add_argument("--logs", default="proxy-data/logs", help="logs directory (default: proxy-data/logs)")
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
    total = float(request["inputTokens"])
    parts_dir = os.path.join(session, "parts")

    try:
        base, base_bytes = defs.base(session, reqs[: index + 1])
    except ValueError as e:
        print(e, file=sys.stderr)
        return 1
    by_type: dict[str, float] = defaultdict(float, {k: n * base / sum(base_bytes.values()) for k, n in base_bytes.items()})
    rest_bytes = defs.rest_bytes(session, request)
    rate = (total - base) / rest_bytes
    by_type["toolsLoaded"] = defs.def_bytes(session, request)["toolsLoaded"] * rate

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
    frontier = 0.0
    ends = request.get("trimmedEnd") or request.get("frontierEnd")
    for i, p in enumerate(request["parts"]):
        h = p["hash"]
        kinds = side[h].get("kinds") or {p["part"]: p["bytes"]}
        key = side[h].get("lineage")
        day = local_date(born_by_lineage.get(key, seen[h]) if key else seen[h])
        for kind, n in kinds.items():
            if kind == "system":
                continue
            tokens = n * rate
            if kind in FRONTIER and not (ends and i < ends[FRONTIER[kind]]):
                frontier += tokens
                continue
            by_type[kind] += tokens
            by_day[(ref - day).days] += tokens

    persist = total - frontier

    print(f"Date: {ref}")
    print(f"Request #{index} of {len(reqs)} in session {os.path.basename(session)}")
    print(f"Model: {model}")
    print(f"{total:,.0f} tokens: a base of {base:,.0f} (from the first request's count), and {total - base:,.0f} over {rest_bytes:,} bytes after it: {rate:.3f} tokens per byte")

    print("\nTokens by age (in calendar days, local time)")
    print(row("base", base, total))
    if by_type["toolsLoaded"]:
        print(row("tools loaded", by_type["toolsLoaded"], total))
    for d in sorted((d for d in by_day if d > 0), reverse=True):
        print(row(f"{d} day{'s' if d != 1 else ''} ago", by_day[d], total))
    if by_day.get(0):
        print(row("today", by_day[0], total))
    if frontier:
        print(row("frontier", frontier, total))
    print(row("TOTAL", total, total, show_percent=False))

    print("\nTokens by part type (frontier left out)")
    for key in TYPE_ORDER:
        value = by_type.get(key, 0.0)
        if key in ("toolsLoaded", "reasoning", "other") and not value:
            continue
        print(row(key, value, persist))
    print(row("TOTAL", persist, persist, show_percent=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

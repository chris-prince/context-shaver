#!/usr/bin/env python3
"""Break down a request's context by age, then by part type.

Reads the proxy's logs under proxy-data/logs/<conversation>/: the `request`
lines of step_events.jsonl, each listing the request's system blocks, tool
definitions and messages with their bytes, and beside each message its
parts/<hash>.kinds.json, the message's bytes split by kind (src/log.ts).

Each part's tokens come from the requests' reported counts, taken in order
(scripts/defs.py, part_tokens); within a part, its kinds share them by bytes,
as the system prompt and the tools sent in full share theirs. The base is the
system prompt, the tools sent in full, and what Claude Code injects before the
first response (CLAUDE.md and the environment block among them), the kind
src/log.ts calls `system`. Deferred tools a tool search has loaded since are
`toolsLoaded`. What Claude Code injects, as system messages or system-reminder
blocks, shows as `systemMessage` under base or non-base: src/log.ts's `system`
before the first response, `harness` after. Requests logged before the system blocks and tools were sit outside
the analysis.

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

By part type (pre-frontier only): the same kinds, the frontier left out, since it is what the next
trims remove, under base and non-base; every percentage is of the section's
total. What persists whole behind the frontier shows under its own kind:
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
import re
import sys
from collections import defaultdict

import defs

# The kinds the frontier holds back, each with the frontier that trims it.
FRONTIER = {"reasoning": "reasoning", "toolCalls": "tools", "toolResults": "tools"}
BASE_TYPES = ["systemPrompt", "tools", "preamble"]
# What Claude Code injects reads the same before the first response as after.
LABELS = {"preamble": "systemMessage", "harness": "systemMessage"}
REST_TYPES = ["toolsLoaded", "user", "harness", "assistant", "toolCalls", "toolCallsStubbed", "toolResults", "toolResultsStubbed", "toolResultsSkill", "reasoning", "other"]


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


def span(start: str, end: str) -> str:
    """The time between two ISO timestamps, like 1d 3h 5m, leaving out leading zero units: 17h 0m, 42m."""
    minutes = int((dt.datetime.fromisoformat(end.replace("Z", "+00:00")) - dt.datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds() // 60)
    hours, minutes = divmod(minutes, 60)
    days, hours = divmod(hours, 24)
    units = [(days, "d"), (hours, "h"), (minutes, "m")]
    while len(units) > 1 and not units[0][0]:
        units.pop(0)
    return " ".join(f"{n}{u}" for n, u in units)


def local_time(stamp: str) -> str:
    """An ISO timestamp as local date, time and zone, like 2026-10-10 14:21 PDT."""
    return dt.datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M %Z")


# User text that is not a prompt (src/items.ts, isPrompt).
NOT_A_PROMPT = re.compile(r"^\s*(<command-name>|<local-command-|\[Request interrupted|<system-reminder>)")


def is_prompt(m: dict) -> bool:
    if m.get("role") != "user":
        return False
    c = [{"type": "text", "text": m["content"]}] if isinstance(m["content"], str) else m["content"]
    if any(b.get("type") == "tool_result" for b in c):
        return False
    return any(not NOT_A_PROMPT.match(str(b.get("text"))) if b.get("type") == "text" else b.get("type") in ("image", "document") for b in c)


def turns(parts_dir: str, request: dict) -> int:
    """The prompts among the request's messages."""
    n = 0
    for p in request["parts"]:
        with open(os.path.join(parts_dir, p["hash"] + ".json"), encoding="utf-8") as f:
            n += is_prompt(json.load(f))
    return n


def sidecar(parts_dir: str, h: str) -> dict:
    try:
        with open(os.path.join(parts_dir, h + ".kinds.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def percent(value: float, total: float) -> int:
    return int(value / total * 100 + 0.5) if total else 0


def row(label: str, value: float, total: float, show_percent: bool = True, indent: int = 0) -> str:
    line = f"  {' ' * indent}{label:<20}{value:>12,.0f}"
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

    tokens = defs.part_tokens(session, reqs[: index + 1])[-1]
    d = defs.def_bytes(session, request)
    fixed = tokens["defs:" + json.dumps(defs.base_defs(request))]
    by_type: dict[str, float] = defaultdict(float)
    by_type["systemPrompt"] = fixed * d["systemPrompt"] / (d["systemPrompt"] + d["tools"])
    by_type["tools"] = fixed * d["tools"] / (d["systemPrompt"] + d["tools"])
    loaded = set().union(*(defs.referenced(os.path.join(session, "parts", p["hash"] + ".json")) for p in request["parts"]))
    by_type["toolsLoaded"] = sum(tokens["tool:" + t["hash"]] for t in request["tools"] if t.get("deferred") and t["name"] in loaded)

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
            share = tokens[h] * n / sum(kinds.values())
            if kind == "system":
                by_type["preamble"] += share
                continue
            if kind in FRONTIER and not (ends and i < ends[FRONTIER[kind]]):
                frontier += share
                continue
            by_type[kind] += share
            by_day[(ref - day).days] += share

    persist = total - frontier
    base = by_type["systemPrompt"] + by_type["tools"] + by_type["preamble"]

    print(f"Session: {os.path.basename(session)}")
    print(f"Model: {model}")
    print()
    print(local_time(request["time"]))
    print(f"{index + 1:,} requests across {turns(parts_dir, request):,} turns, spanning {span(reqs[0]['time'], request['time'])}")
    print(f"{total:,.0f} tokens")

    print("\nTokens by age (in calendar days, local time)")
    print(row("base", base, total))
    if by_type["toolsLoaded"]:
        print(row("toolsLoaded", by_type["toolsLoaded"], total))
    for d in sorted((d for d in by_day if d > 0), reverse=True):
        print(row(f"{d} day{'s' if d != 1 else ''} ago", by_day[d], total))
    if by_day.get(0):
        print(row("today", by_day[0], total))
    if frontier:
        print(row("frontier", frontier, total))
    print(row("TOTAL", total, total, show_percent=False))

    print("\nTokens by part type (pre-frontier only)")
    print(row("base", base, persist))
    for key in sorted(BASE_TYPES, key=lambda k: LABELS.get(k, k)):
        print(row(LABELS.get(key, key), by_type[key], persist, indent=2))
    print(row("non-base", persist - base, persist))
    for key in sorted(REST_TYPES, key=lambda k: LABELS.get(k, k)):
        value = by_type.get(key, 0.0)
        if key in ("toolsLoaded", "reasoning", "other") and not value:
            continue
        print(row(LABELS.get(key, key), value, persist, indent=2))
    print(row("TOTAL", persist, persist, show_percent=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

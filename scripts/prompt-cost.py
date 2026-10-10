#!/usr/bin/env python3
"""Compare what one user prompt cost across sessions, from the proxy's logs.

For each session given, finds the first user prompt starting with the given
text in the session's Claude Code transcript, and takes everything from that
prompt to the next one: one turn. Reports its steps (assistant messages), its
duration (the prompt to the last assistant message), its cost, its tool calls,
the trims the proxy decided and applied, and its peak context.

Cost is the proxy's request lines in that window, which include requests the
transcript doesn't record. Prices are per million input tokens: Opus 5.5 $4
(cache read 0.05x), Haiku 5.5 $0.10, Haiku $1, Sonnet $3, Opus $5 (cache read
0.1x); a 1-hour cache write 2x, a 5-minute one 1.25x, output 5x. Older logs
have only a total, writtenTokens, priced as all 1-hour.

Transcripts are read from ~/.claude/projects/<this directory, slugged>/, and
logs from logs-mini-ctx-claude/<session>-*/ under the current directory.

Usage:
    scripts/prompt-cost.py "<prompt start>" <session id> ...
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys
from datetime import datetime

LOGS = "logs-mini-ctx-claude"
PRICES = (("opus-5-5", 4.0, 0.05), ("haiku-5-5", 0.10, 0.1), ("haiku", 1.0, 0.1), ("sonnet", 3.0, 0.1), ("opus", 5.0, 0.1))


def ts(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def cost(r: dict) -> float:
    """A request line's cost in dollars."""
    m = (r.get("model") or "").lower()
    usd, read = next(((u, rd) for name, u, rd in PRICES if name in m), (5.0, 0.1))
    hour = r.get("writtenTokens60m", r.get("writtenTokens", 0))
    five = r.get("writtenTokens5m", 0)
    plain = r["inputTokens"] - r["cachedTokens"] - hour - five
    return usd / 1e6 * (plain + read * r["cachedTokens"] + 2 * hour + 1.25 * five + 5 * r["outputTokens"])


def is_prompt(e: dict) -> bool:
    if e.get("type") != "user" or e.get("isMeta"):
        return False
    c = e["message"]["content"]
    return not (isinstance(c, list) and any(b.get("type") == "tool_result" for b in c))


def text(e: dict) -> str:
    c = e["message"]["content"]
    return c if isinstance(c, str) else " ".join(b.get("text", "") for b in c if b.get("type") == "text")


def row(projects: str, start: str, sid: str) -> dict | None:
    ents = [json.loads(l) for l in open(os.path.join(projects, sid + ".jsonl"))]
    prompts = [i for i, e in enumerate(ents) if is_prompt(e) and not text(e).startswith("<command")]
    at = next((k for k, i in enumerate(prompts) if text(ents[i]).startswith(start)), None)
    if at is None:
        return None
    first = prompts[at]
    last = prompts[at + 1] if at + 1 < len(prompts) else len(ents)
    t0 = ts(ents[first]["timestamp"])
    t1 = ts(ents[last]["timestamp"]) if last < len(ents) else float("inf")
    steps, calls, end = set(), 0, t0
    for e in ents[first + 1 : last]:
        if e.get("type") == "assistant":
            steps.add(e["message"]["id"])
            calls += sum(b["type"] == "tool_use" for b in e["message"]["content"])
            end = max(end, ts(e["timestamp"]))
    lines = [json.loads(l) for f in glob.glob(f"{LOGS}/{sid}-*/step_events.jsonl") for l in open(f)]
    lines = [l for l in lines if t0 <= ts(l["time"]) < t1]
    reqs = [l for l in lines if l["event"] == "request" and "inputTokens" in l]
    trims = [l for l in lines if l["event"] == "compaction"]
    if not reqs:
        return None
    return {
        "session": sid[:8],
        "steps": len(steps),
        "requests": len(reqs),
        "minutes": (end - t0) / 60,
        "cost": sum(cost(r) for r in reqs),
        "calls": calls,
        "applied": sum(t["advanced"] for t in trims),
        "trims": len(trims),
        "peak": max(r["inputTokens"] for r in reqs),
    }


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__.split("Usage:")[1].strip(), file=sys.stderr)
        return 2
    start, sids = sys.argv[1], sys.argv[2:]
    projects = os.path.expanduser("~/.claude/projects/" + re.sub(r"[/.]", "-", os.getcwd()))
    print(f"{'session':8}  {'steps':>5}  {'reqs':>4}  {'minutes':>7}  {'cost':>6}  {'$/step':>6}  {'calls':>5}  {'trims':>7}  {'peak':>5}")
    for sid in sids:
        r = row(projects, start, sid)
        if not r:
            print(f"{sid[:8]:8}  no such prompt, or no logged requests for it")
            continue
        print(
            f"{r['session']:8}  {r['steps']:5}  {r['requests']:4}  {r['minutes']:7.1f}  ${r['cost']:5.2f}  "
            f"${r['cost'] / r['steps']:5.3f}  {r['calls']:5}  {r['applied']:3}/{r['trims']:<3}  {r['peak'] / 1e3:4.0f}k"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())

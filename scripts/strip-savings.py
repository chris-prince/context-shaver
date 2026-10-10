#!/usr/bin/env python3
"""Total what trimming saved and cost, per session, from the proxy's logs.

Reads proxy-data/logs/<conversation>/step_events.jsonl under each dir
given (default the current one, the proxy's default --dir when run from the
repo): its `request` lines (usage) and `compaction` lines (each decision, with
savedChars and rewriteChars). Characters become tokens at the session's rate:
its requests' tokens less their base (scripts/defs.py), over what they sent
besides it, in bytes. Sessions logged before the system blocks and tools were,
or from partway through, are left out.

  savings  Each request after an advance no longer sends what it saved: the
           characters saved so far, at the cache-read price when the request
           read the cache (cachedTokens over half its input), else the
           request's write price.
  rewrite  A warm advance makes the next request write what it would have read:
           the rewritten characters less those saved, at that request's write
           price minus read. A
           cold advance rewrites nothing the request would not write anyway.
  net      savings - rewrite; the percent is of what the session would have
           cost without trimming.

Prices are per million input tokens: Opus 5.5 $4, Haiku 5.5 $0.10, Haiku $1,
Sonnet $3, Opus $5 (default $5). A cache read is 0.1x (0.05x on Opus 5.5), a
1-hour cache write 2x, a 5-minute one 1.25x, output 5x. A request's write price is its writes' mix of the two, by writtenTokens60m
and writtenTokens5m. Older logs have only a total, writtenTokens, priced as all
1-hour, or that total with written1hTokens.

Usage:
    scripts/strip-savings.py [dir ...]
"""

from __future__ import annotations

import glob
import json
import os
import sys

import defs

LOGS = "proxy-data/logs"


def input_price(model: str | None) -> tuple[float, float]:
    """A model's price per input token, and its cache-read multiplier."""
    m = (model or "").lower()
    for name, usd, read in (("opus-5-5", 4.0, 0.05), ("haiku-5-5", 0.10, 0.1), ("haiku", 1.0, 0.1), ("sonnet", 3.0, 0.1), ("opus", 5.0, 0.1)):
        if name in m:
            return usd / 1e6, read
    return 5.0 / 1e6, 0.1


def written(l: dict) -> tuple[int, int]:
    """A request's cache writes as (1-hour, 5-minute) tokens."""
    if "writtenTokens60m" in l:
        return l["writtenTokens60m"], l.get("writtenTokens5m", 0)
    total = l.get("writtenTokens", 0)
    hour = l.get("written1hTokens", total)
    return hour, total - hour


def write_price(l: dict) -> float:
    """A request's cache-write multiplier, by the mix of 1-hour and 5-minute writes."""
    hour, five = written(l)
    return (2 * hour + 1.25 * five) / (hour + five) if hour + five else 2.0


def session_rate(session_dir: str, reqs: list[dict]) -> float:
    """Tokens per byte sent besides the base, over the session's requests."""
    base, _ = defs.base(session_dir, reqs)
    return sum(r["inputTokens"] - base for r in reqs) / sum(defs.rest_bytes(session_dir, r) for r in reqs)


def session_row(session_dir: str) -> dict | None:
    lines = []
    for text in open(os.path.join(session_dir, "step_events.jsonl"), encoding="utf-8"):
        try:
            lines.append(json.loads(text))
        except json.JSONDecodeError:
            pass
    # A turn's last request line is written after the turn's decision; each is
    # stamped when it happened (a request when sent).
    lines.sort(key=lambda l: l.get("time", ""))
    reqs = [l for l in lines if l.get("event") == "request" and l.get("inputTokens") and l.get("tools") is not None]
    if not reqs:
        return None
    try:
        rate = session_rate(session_dir, reqs)
    except ValueError as e:
        print(e, file=sys.stderr)
        return None
    cost = savings = rewrite = 0.0
    saved_tokens = 0.0  # what the advances so far took out of every request
    pending_rewrite = 0.0  # tokens the next request writes instead of reading
    advances = 0
    for l in lines:
        if l.get("event") == "compaction" and l.get("advanced"):
            advances += 1
            saved_tokens += l["savedChars"] * rate
            if l.get("cacheState") == "warm":
                pending_rewrite += (l["rewriteChars"] - l["savedChars"]) * rate
        elif l in reqs:
            p, read = input_price(l.get("model"))
            cached, (hour, five) = l.get("cachedTokens", 0), written(l)
            fresh = l["inputTokens"] - cached - hour - five
            w = write_price(l)
            cost += p * (fresh + read * cached + 2 * hour + 1.25 * five + 5 * l.get("outputTokens", 0))
            warm = cached > l["inputTokens"] / 2
            savings += saved_tokens * p * (read if warm else w)
            rewrite += pending_rewrite * p * (w - read)
            pending_rewrite = 0.0
    return {
        "session": os.path.basename(session_dir),
        "requests": len(reqs),
        "advances": advances,
        "cost": cost,
        "savings": savings,
        "rewrite": rewrite,
    }


def fmt(r: dict) -> list[str]:
    net = r["savings"] - r["rewrite"]
    without = r["cost"] + net
    usd = lambda x: f"${x:.4f}"
    return [
        r["session"],
        str(r["requests"]),
        str(r["advances"]),
        usd(r["cost"]),
        usd(r["savings"]),
        usd(r["rewrite"]),
        usd(net),
        f"{net / without * 100:.1f}%" if without else "-",
    ]


def main() -> int:
    rows = []
    for d in sys.argv[1:] or ["."]:
        for f in sorted(glob.glob(os.path.join(d, LOGS, "*", "step_events.jsonl"))):
            r = session_row(os.path.dirname(f))
            if r:
                rows.append(r)
    if not rows:
        print(f"no sessions with priced requests under {LOGS}/", file=sys.stderr)
        return 1
    total = {k: sum(r[k] for r in rows) for k in ("requests", "advances", "cost", "savings", "rewrite")}
    table = [["session", "requests", "advances", "cost", "savings", "rewrite", "net", "net %"]]
    table += [fmt(r) for r in rows] + [fmt({"session": "total", **total})]
    widths = [max(len(row[i]) for row in table) for i in range(len(table[0]))]
    for row in table:
        print("  ".join(c.ljust(widths[i]) if i == 0 else c.rjust(widths[i]) for i, c in enumerate(row)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

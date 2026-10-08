#!/usr/bin/env python3
"""Total what trimming saved and cost, per session, from the plugin's logs.

Reads logs-mini-ctx-claude/<session>/step_events.jsonl under each project dir
(default the current one): its `request` lines (usage) and `compaction` lines
(each decision, with savedChars and rewriteChars). Characters become tokens at
the session's fitted rate, as in analyze-context.py.

  savings  Each request after an advance no longer sends what it saved: the
           characters saved so far, at the cache-read price when the request
           read the cache (cachedTokens over half its input), else the write
           price.
  rewrite  A warm advance makes the next request write what it would have read:
           the rewritten characters less those saved, at write minus read. A
           cold advance rewrites nothing the request would not write anyway.
  net      savings - rewrite; the percent is of what the session would have
           cost without trimming.

Prices are per million input tokens: Haiku $1, Sonnet $3, Opus $5 (default $5).
A cache read is 0.1x, a 1-hour cache write 2x, output 5x.

Usage:
    scripts/strip-savings.py [project dir ...]
"""

from __future__ import annotations

import glob
import json
import os
import sys

LOGS = "logs-mini-ctx-claude"


def input_price(model: str | None) -> float:
    m = (model or "").lower()
    for name, usd in (("haiku", 1.0), ("sonnet", 3.0), ("opus", 5.0)):
        if name in m:
            return usd / 1e6
    return 5.0 / 1e6


def fit_rate(reqs: list[dict]) -> float | None:
    """Tokens per message byte, fitting inputTokens = base + rate x bytes."""
    xs = [sum(p["bytes"] for p in r["parts"]) for r in reqs]
    ys = [r["inputTokens"] for r in reqs]
    if len(xs) < 2:
        return None
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx if sxx else None


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
    reqs = [l for l in lines if l.get("event") == "request" and l.get("inputTokens") and l.get("parts") is not None]
    rate = fit_rate(reqs)
    if not reqs or not rate:
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
            p = input_price(l.get("model"))
            cached, written = l.get("cachedTokens", 0), l.get("writtenTokens", 0)
            fresh = l["inputTokens"] - cached - written
            cost += p * (fresh + 0.1 * cached + 2 * written + 5 * l.get("outputTokens", 0))
            warm = cached > l["inputTokens"] / 2
            savings += saved_tokens * p * (0.1 if warm else 2)
            rewrite += pending_rewrite * p * (2 - 0.1)
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

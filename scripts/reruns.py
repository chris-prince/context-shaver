#!/usr/bin/env python3
"""List tool calls that fetched again output trimming had taken from the model.

Reads a conversation's logs under logs-mini-ctx-claude/<conversation>/ (default
the newest). Each request's last assistant message is the response to the
request before it: one step, and that earlier request is what the model saw
when it made the step's calls. A result is read as first sent, whole, from the
first request to carry it.

A tool call's result is compared line by line with the results of earlier
steps, as the request it answered had them: whole, stubbed, or removed (its
call dropped). Lines under 8 characters (braces, blank, `fi`) are left out, and
each line counts once. A call is a "culled" rerun when at least half its lines
were in earlier results that were stubbed or removed and in none still whole:
output the model had seen and could no longer see. A "whole" repeat is one
with at least half its lines in results still whole: re-checking `git status`
or a file after an edit, the baseline the culled reruns stand against. Matching
content rather than commands catches a `sed -n` of the same file with another
range, and passes over a read that only continues an earlier one. A call that
re-reads one file beside several new ones can fall under half, so the culled
count is a floor.

Age is in steps from the earlier call to the rerun. The wait each rerun needed
is the least step wait that keeps whole enough of what it re-fetched to leave
under half its lines lost: each lost line counts from its youngest copy.

A heuristic section then lists the places the model said it lost output: an
assistant text sentence pairing a loss word (removed, cleared, ...) with a
context word (context, output, ...), or a tool call description starting
"Re-" or saying "again". These catch rereads the content match misses, but
also false hits, such as text that talks about trimming, or a test run again
after an edit. Each hit names its step, the parts file to open, the stubs in
the request it answered, and the step's tool calls, to confirm or deny it.
Thinking can't be searched: the API returns it signed but empty.

A last count is of the steps whose text or tool call descriptions say "cull",
the word the stub uses, a sharper signal than the loss words above.

Usage:
    scripts/reruns.py [conversation-dir]
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys
from collections import Counter

LOGS = "logs-mini-ctx-claude"
STUB = re.compile(r"^\[CULLED (\d+) B FROM CTX\]$")
# The wording before 2026-10-07, still in older logs.
OLD_STUB = re.compile(r"^\[Output from an earlier turn removed")
LOSS = re.compile(r"\b(removed|cleared|culled|dropped|trimmed|stripped|gone|no longer|can't (?:see|read)|cannot (?:see|read))\b", re.I)
CONTEXT = re.compile(r"\b(context|outputs?|results?)\b", re.I)
AGAIN = re.compile(r"^re-|\bre-?run\b|\bagain\b", re.I)
CULL = re.compile(r"cull", re.I)
MIN_LINE = 8
RERUN = 0.5


def requests(conv_dir: str) -> list[dict]:
    out = []
    for line in open(os.path.join(conv_dir, "step_events.jsonl"), encoding="utf-8"):
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("event") == "request" and e.get("parts") is not None:
            out.append(e)
    return out


def blocks(m: dict) -> list[dict]:
    c = m.get("content")
    return c if isinstance(c, list) else []


def is_stub(text: str) -> bool:
    return bool(STUB.match(text) or OLD_STUB.match(text))


def result_text(b: dict) -> str:
    c = b.get("content", "")
    return c if isinstance(c, str) else json.dumps(c)


def lines(text: str) -> set[str]:
    return {s for s in (l.strip() for l in text.splitlines()) if len(s) >= MIN_LINE}


def what(b: dict) -> str:
    inp = b.get("input") or {}
    return str(inp.get("command") or inp.get("file_path") or json.dumps(inp)).splitlines()[0][:70]


def main() -> int:
    if len(sys.argv) > 1:
        conv = os.path.normpath(sys.argv[1])
    else:
        files = glob.glob(os.path.join(LOGS, "*", "step_events.jsonl"))
        if not files:
            print(f"no conversations under {LOGS}/", file=sys.stderr)
            return 1
        conv = os.path.dirname(max(files, key=os.path.getmtime))
    reqs = requests(conv)
    if not reqs:
        print(f"no requests in {conv}", file=sys.stderr)
        return 1
    cache: dict[str, dict] = {}

    def load(h: str) -> dict:
        if h not in cache:
            cache[h] = json.load(open(os.path.join(conv, "parts", h + ".json"), encoding="utf-8"))
        return cache[h]

    sent = [[load(p["hash"]) for p in r["parts"]] for r in reqs]
    # Each result as first sent whole.
    first: dict[str, str] = {}
    for msgs in sent:
        for m in msgs:
            for b in blocks(m):
                if b.get("type") == "tool_result" and b["tool_use_id"] not in first and not is_stub(result_text(b)):
                    first[b["tool_use_id"]] = result_text(b)

    # Steps: (the request answered, the response, its parts file). A retried
    # request repeats the response before it; it is skipped.
    steps = []
    for k in range(1, len(reqs)):
        at = max((i for i, p in enumerate(reqs[k]["parts"]) if p["part"] == "assistant"), default=None)
        if at is None or (steps and steps[-1][2] == reqs[k]["parts"][at]["hash"]):
            continue
        steps.append((sent[k - 1], sent[k][at], reqs[k]["parts"][at]["hash"]))

    def results_in(msgs: list[dict]) -> dict[str, str]:
        return {b["tool_use_id"]: result_text(b) for m in msgs for b in blocks(m) if b.get("type") == "tool_result"}

    earlier: list[tuple[int, str]] = []  # (step, call id) of each call before this step
    rows, calls = [], 0
    for s, (answered, resp, _) in enumerate(steps, 1):
        shown = results_in(answered)
        visible: set[str] = set()
        hidden: dict[str, int] = {}  # line -> age of its youngest stubbed or removed copy
        for st, cid in earlier:
            if cid not in first:
                continue
            if cid in shown and not is_stub(shown[cid]):
                visible |= lines(first[cid])
            else:
                for l in lines(first[cid]):
                    hidden[l] = min(hidden.get(l, s - st), s - st)
        uses = [b for b in blocks(resp) if b.get("type") == "tool_use"]
        calls += len(uses)
        for b in uses:
            mine = lines(first.get(b["id"], ""))
            if not mine:
                continue
            lost = sorted(hidden[l] for l in mine - visible if l in hidden)
            row = {"step": s, "bytes": len(first[b["id"]].encode()), "tool": b.get("name"), "what": what(b)}
            if len(lost) >= RERUN * len(mine):
                # Keeping whole every result up to age w recovers the lost lines
                # that young; the rerun is avoided once under half stay lost.
                need = next(w for w in lost if sum(a > w for a in lost) < RERUN * len(mine))
                rows.append({**row, "culled": True, "seen": len(lost) / len(mine), "age": lost[-1], "wait": need})
            elif len(mine & visible) >= RERUN * len(mine):
                rows.append({**row, "culled": False, "seen": len(mine & visible) / len(mine)})
        earlier += [(s, b["id"]) for b in uses]

    print(f"Conversation: {os.path.basename(conv)}")
    print(f"{calls} tool calls in {len(steps)} steps; a rerun has >= {RERUN:.0%} of its result lines already seen\n")
    culled = [x for x in rows if x["culled"]]
    print(f"culled: {len(culled)} reruns, {sum(x['bytes'] for x in culled):,} result bytes fetched again")
    for x in culled:
        print(f"  step {x['step']:>3}  {x['seen']:4.0%} lost  oldest {x['age']:>3}  wait {x['wait']:>3}  {x['bytes']:>7,} B  {x['tool']:<6} {x['what']}")
    if culled:
        print("\n  step wait needed to avoid each:")
        for w, n in sorted(Counter(x["wait"] for x in culled).items()):
            print(f"  {w:>5}  {'#' * n} {n}")
    whole = [x for x in rows if not x["culled"]]
    print(f"\nwhole: {len(whole)} repeats, {sum(x['bytes'] for x in whole):,} result bytes fetched again")
    for x in whole:
        print(f"  step {x['step']:>3}  {x['seen']:4.0%} seen  {x['bytes']:>7,} B  {x['tool']:<6} {x['what']}")
    print()

    hits = []
    for s, (answered, resp, h) in enumerate(steps, 1):
        found = []
        for b in blocks(resp):
            if b.get("type") == "text":
                for sentence in re.split(r"(?<=[.!?])\s+", b.get("text", "")):
                    if LOSS.search(sentence) and CONTEXT.search(sentence):
                        found.append(("text", sentence))
            elif b.get("type") == "tool_use":
                d = (b.get("input") or {}).get("description") or ""
                if AGAIN.search(d):
                    found.append(("description", d))
        if found:
            stubs = sum(is_stub(t) for t in results_in(answered).values())
            hits.append((s, h, found, stubs, [what(b) for b in blocks(resp) if b.get("type") == "tool_use"]))

    print(f"HEURISTIC, unconfirmed: {len(hits)} steps where the model may say it lost output")
    print("  To confirm a hit, open its parts file and check that the text is about the")
    print("  model's own missing output and that a stubbed result it needed is in the")
    print("  request it answered. A hit with 0 stubs there is a false one.")
    for s, h, found, stubs, calls_here in hits:
        print(f"\n  step {s}: {os.path.join(conv, 'parts', h + '.json')}")
        print(f"    stubbed results in the request it answered: {stubs}")
        for kind, t in found:
            print(f"    {kind}: {t[:160]!r}")
        for c in calls_here:
            print(f"    call: {c}")

    culls = []
    for s, (_, resp, _) in enumerate(steps, 1):
        said = [b.get("text", "") for b in blocks(resp) if b.get("type") == "text"]
        said += [(b.get("input") or {}).get("description") or "" for b in blocks(resp) if b.get("type") == "tool_use"]
        found = [t for t in said if CULL.search(t)]
        if found:
            culls.append((s, found))
    print(f"\nSteps saying \"cull\": {len(culls)}")
    for s, found in culls:
        t = found[0]
        at = CULL.search(t).start()
        print(f"  step {s}: {t[max(0, at - 60):at + 60].replace(chr(10), ' ')!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

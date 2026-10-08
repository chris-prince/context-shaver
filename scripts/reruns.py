#!/usr/bin/env python3
"""List tool calls the model ran again, and whether trimming made it.

Reads a conversation's logs under logs-mini-ctx-claude/<conversation>/ (default
the newest): the messages as its latest request sent them, and for each
assistant message the request it answered, the context the model saw when it
made the call.

A rerun is a tool call whose name and input (less `description`) match an
earlier call's exactly. It is "culled" when that earlier call's result was a
stub in the request the model answered, and "whole" otherwise: re-checking
`git status` or a test after an edit reruns with the result whole, so the
whole reruns are the baseline the culled ones stand against. Exact matching
misses near-repeats, such as a `sed -n` on the same file with another range,
so the culled count is a floor.

Age is in steps, one per assistant message, from the earlier call to the rerun.
Bytes are the rerun's result, what the model fetched again; one trimmed since
is read from its stub.

A heuristic section then lists the places the model said it lost output: an
assistant text sentence pairing a loss word (removed, cleared, ...) with a
context word (context, output, ...), or a tool call description starting
"Re-" or saying "again". These catch near-repeats the exact match misses, but
also false hits, such as text that talks about trimming, or a test run again
after an edit. Each hit names its message, the parts file to open, the stubs
in the request it answered, and the step's tool calls, to confirm or deny it.
Thinking can't be searched: the API returns it signed but empty.

Usage:
    scripts/reruns.py [conversation-dir]
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys

LOGS = "logs-mini-ctx-claude"
STUB = re.compile(r"^\[CULLED (\d+) B FROM CTX\]$")
# The wording before 2026-10-07, still in older logs.
OLD_STUB = re.compile(r"^\[Output from an earlier turn removed")
LOSS = re.compile(r"\b(removed|cleared|culled|dropped|trimmed|stripped|gone|no longer|can't (?:see|read)|cannot (?:see|read))\b", re.I)
CONTEXT = re.compile(r"\b(context|outputs?|results?)\b", re.I)
AGAIN = re.compile(r"^re-|\bre-?run\b|\bagain\b", re.I)


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
    load = lambda h: json.load(open(os.path.join(conv, "parts", h + ".json"), encoding="utf-8"))
    # The request each assistant message answered: the one that sent every
    # message before it.
    answered = {len(r["parts"]): r for r in reqs}
    # Each message as first sent, before any trimming: the first request to
    # carry a message has it in the current turn, which is never trimmed.
    latest = reqs[-1]["parts"]
    sizes = sorted(answered)
    first = lambda i: next(answered[n] for n in sizes if n > i)
    msgs = [load(first(i)["parts"][i]["hash"]) for i in range(len(latest))]

    step, s = [], 0
    for m in msgs:
        s += m.get("role") == "assistant"
        step.append(s)
    # Each call's message index and its result's, by tool_use id.
    call_at, result_at = {}, {}
    for i, m in enumerate(msgs):
        for b in blocks(m):
            if b.get("type") == "tool_use":
                call_at[b["id"]] = i
            elif b.get("type") == "tool_result":
                result_at[b["tool_use_id"]] = i

    def result_in(msg: dict, tool_id: str) -> str | None:
        return next((result_text(b) for b in blocks(msg) if b.get("tool_use_id") == tool_id), None)

    seen: dict[str, str] = {}  # call key -> latest earlier call's id
    rows = []
    for i, m in enumerate(msgs):
        if m.get("role") != "assistant":
            continue
        for b in blocks(m):
            if b.get("type") != "tool_use":
                continue
            inp = {k: v for k, v in (b.get("input") or {}).items() if k != "description"}
            key = json.dumps([b.get("name"), inp], sort_keys=True)
            prev = seen.get(key)
            seen[key] = b["id"]
            r = answered.get(i)
            if not prev or prev not in result_at or not r:
                continue
            j = result_at[prev]
            seen_result = result_in(load(r["parts"][j]["hash"]), prev) if j < len(r["parts"]) else None
            mine = result_in(msgs[result_at[b["id"]]], b["id"]) if b["id"] in result_at else ""
            stub = STUB.match(mine or "")
            rows.append({
                "age": step[i] - step[call_at[prev]],
                "culled": seen_result is not None and is_stub(seen_result),
                "bytes": int(stub.group(1)) if stub else len((mine or "").encode()),
                "tool": b.get("name"),
                "what": (inp.get("command") or inp.get("file_path") or json.dumps(inp)).splitlines()[0][:70],
            })

    calls = sum(1 for m in msgs for b in blocks(m) if b.get("type") == "tool_use")
    print(f"Conversation: {os.path.basename(conv)}")
    print(f"{calls} tool calls in {step[-1] if step else 0} steps, {len(rows)} reruns\n")
    for name in ("culled", "whole"):
        group = [x for x in rows if x["culled"] == (name == "culled")]
        print(f"{name}: {len(group)} reruns, {sum(x['bytes'] for x in group):,} result bytes fetched again")
        for x in sorted(group, key=lambda x: -x["age"]):
            print(f"  {x['age']:>4} steps  {x['bytes']:>7,} B  {x['tool']:<6} {x['what']}")
        print()

    hits = []
    for i, m in enumerate(msgs):
        if m.get("role") != "assistant":
            continue
        found = []
        for b in blocks(m):
            if b.get("type") == "text":
                for sentence in re.split(r"(?<=[.!?])\s+", b.get("text", "")):
                    if LOSS.search(sentence) and CONTEXT.search(sentence):
                        found.append(("text", sentence))
            elif b.get("type") == "tool_use":
                d = (b.get("input") or {}).get("description") or ""
                if AGAIN.search(d):
                    found.append(("description", d))
        if not found:
            continue
        r = answered.get(i)
        stubs = sum(1 for p in r["parts"] for c in blocks(load(p["hash"]))
                    if c.get("type") == "tool_result" and is_stub(result_text(c))) if r else None
        calls_here = [(b.get("input") or {}).get("command") or (b.get("input") or {}).get("file_path") or b.get("name")
                      for b in blocks(m) if b.get("type") == "tool_use"]
        hits.append((i, found, stubs, calls_here))

    print(f"HEURISTIC, unconfirmed: {len(hits)} steps where the model may say it lost output")
    print("  To confirm a hit, open its parts file and check that the text is about the")
    print("  model's own missing output and that a stubbed result it needed is in the")
    print("  request it answered. A hit with 0 stubs there is a false one.")
    for i, found, stubs, calls_here in hits:
        print(f"\n  msg {i}, step {step[i]}: {os.path.join(conv, 'parts', latest[i]['hash'] + '.json')}")
        print(f"    stubbed results in the request it answered: {'unknown' if stubs is None else stubs}")
        for kind, s in found:
            print(f"    {kind}: {s[:160]!r}")
        for c in calls_here:
            print(f"    call: {str(c).splitlines()[0][:100]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

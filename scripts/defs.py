"""What a logged request sent besides its messages, in bytes, and each part's tokens.

A request line lists the top-level system blocks and the tool definitions
(src/log.ts). A deferred tool costs nothing until a tool search loads it: from
then on the request carries a tool_reference to it in a tool result, and the
API expands that to the tool's definition.
"""

from __future__ import annotations

import functools
import json
import os


@functools.lru_cache(maxsize=None)
def referenced(path: str) -> frozenset[str]:
    """The tools a saved message loads by tool_reference."""
    text = open(path, encoding="utf-8").read()
    if '"tool_reference"' not in text:
        return frozenset()
    content = json.loads(text)["content"]
    blocks = [c for b in content if isinstance(content, list) and b.get("type") == "tool_result" and isinstance(b.get("content"), list) for c in b["content"]]
    return frozenset(c["tool_name"] for c in blocks if c.get("type") == "tool_reference")


def def_bytes(session_dir: str, request: dict) -> dict[str, int]:
    """A request's system prompt, tools sent in full, and deferred tools it has loaded, in bytes."""
    loaded = set().union(*(referenced(os.path.join(session_dir, "parts", p["hash"] + ".json")) for p in request["parts"]))
    tools = request["tools"]
    return {
        "systemPrompt": sum(s["bytes"] for s in request["system"]),
        "tools": sum(t["bytes"] for t in tools if not t.get("deferred")),
        "toolsLoaded": sum(t["bytes"] for t in tools if t.get("deferred") and t["name"] in loaded),
    }


def base_defs(request: dict) -> tuple:
    """The system blocks and the tools sent in full, by hash."""
    return tuple(s["hash"] for s in request["system"]), tuple(t["hash"] for t in request["tools"] if not t.get("deferred"))


def message_key(m: dict) -> str:
    """A message as JSON without breakpoints. Claude Code sends a lone text
    block carrying one as an array, and as a string once the breakpoint moves
    on, so that becomes the string."""
    c = m["content"]
    if isinstance(c, list):
        c = [{k: v for k, v in b.items() if k != "cache_control"} for b in c]
        if len(c) == 1 and c[0].get("type") == "text" and len(c[0]) == 2:
            c = c[0]["text"]
    return json.dumps([m["role"], c], sort_keys=True)


def part_tokens(session_dir: str, reqs: list[dict]) -> list[dict[str, float]]:
    """Each request's parts' tokens, by hash, from the requests' reported counts.

    Taken in order, a request's count less what its parts already counted is
    what its new parts cost together. A new assistant message costs the output
    count of the request that answered with it (its input cost is within about
    15 tokens of that); the other new parts share what is left by bytes. The
    parts are the messages, keyed by hash; the system blocks and tools sent in
    full together, keyed `defs:` and their hashes; and each loaded deferred
    tool, keyed `tool:` and its hash. A message whose breakpoint moved is the
    same part under another hash.

    A trim that changes an earlier message unbinds the thinking of the replies
    after it, which the API then leaves out, so those replies are counted again
    with the new parts, at their bytes less the thinking. A request's counts
    are each part's latest, so its parts add up to its reported count.
    """
    parts = os.path.join(session_dir, "parts")
    plain = {h: message_key(json.load(open(os.path.join(parts, h + ".json"), encoding="utf-8"))) for r in reqs for h in {p["hash"] for p in r["parts"]}}
    known: dict[str, float] = {}  # by plain message, or defs:/tool: key
    thinking: dict[str, int] = {}  # counted replies' bound thinking, in bytes
    answered: set[int] = set()  # requests whose answer has its count
    out: list[dict[str, float]] = []
    for n, r in enumerate(reqs):
        msgs = [plain[p["hash"]] for p in r["parts"]]
        loaded = set().union(*(referenced(os.path.join(parts, p["hash"] + ".json")) for p in r["parts"]))
        sizes: dict[str, int] = {}
        count: dict[str, int] = {}
        for k, p in zip(msgs, r["parts"]):
            sizes[k] = p["bytes"]
            count[k] = count.get(k, 0) + 1
        full = [t for t in r["tools"] if not t.get("deferred")]
        sizes["defs:" + json.dumps(base_defs(r))] = sum(s["bytes"] for s in r["system"]) + sum(t["bytes"] for t in full)
        sizes.update({"tool:" + t["hash"]: t["bytes"] for t in r["tools"] if t.get("deferred") and t["name"] in loaded})
        new = [k for k in sizes if k not in known]
        first = next((i for i, k in enumerate(msgs) if k in new), len(msgs))
        for k in dict.fromkeys(msgs[first:]):
            if k not in new and k in thinking:
                new.append(k)
                sizes[k] -= thinking.pop(k)
        left = r["inputTokens"] - sum(known[k] * count.get(k, 1) for k in sizes if k not in new)
        for i, k in enumerate(msgs):
            # A reply first sent with its thinking trimmed off costs less than
            # its output, which counted the thinking.
            if k in new and k.startswith('["assistant"') and i and i >= (r.get("trimmedEnd") or {}).get("reasoning", 0):
                # Answered by the latest request ending with the message before
                # it. A later, trimmed version of that answer is not the answer.
                by = next((j for j in range(n - 1, -1, -1) if reqs[j]["parts"] and plain[reqs[j]["parts"][-1]["hash"]] == msgs[i - 1]), None)
                if by is not None and by not in answered and reqs[by].get("outputTokens"):
                    answered.add(by)
                    known[k] = reqs[by]["outputTokens"]
                    left -= known[k] * count[k]
                    t = len(json.dumps([b for b in json.loads(k)[1] if isinstance(b, dict) and b.get("type") == "thinking"], separators=(",", ":"), ensure_ascii=False))
                    if t > 2:
                        thinking[k] = t
                    new.remove(k)
        rest = sum(sizes[k] * count.get(k, 1) for k in new)
        for k in new:
            known[k] = left * sizes[k] / rest
        out.append({p["hash"]: known[k] for p, k in zip(r["parts"], msgs)} | {k: known[k] for k in sizes if not k.startswith("[")})
    return out

"""What a logged request sent besides its messages, in bytes, and each part's tokens.

A request line lists the top-level system blocks and the tool definitions
(src/log.ts). A deferred tool costs nothing until a tool search loads it: from
then on the request carries a tool_reference to it in a tool result, and the
API expands that to the tool's definition.

The base, the system blocks, the tools sent in full and the preamble (what
Claude Code injects before the first response, the kind src/log.ts calls
`system`), takes its tokens from the conversation's first request, as the API
reported them, less that request's other parts, shared by bytes.
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


def kind_bytes(session_dir: str, request: dict) -> dict[str, int]:
    """A request's message bytes by kind, from each message's sidecar."""
    out: dict[str, int] = {}
    for p in request["parts"]:
        try:
            with open(os.path.join(session_dir, "parts", p["hash"] + ".kinds.json"), encoding="utf-8") as f:
                kinds = json.load(f).get("kinds")
        except (OSError, json.JSONDecodeError):
            kinds = None
        for k, n in (kinds or {p["part"]: p["bytes"]}).items():
            out[k] = out.get(k, 0) + n
    return out


def base_defs(request: dict) -> tuple:
    """The system blocks and the tools sent in full, by hash."""
    return tuple(s["hash"] for s in request["system"]), tuple(t["hash"] for t in request["tools"] if not t.get("deferred"))


def base(session_dir: str, reqs: list[dict]) -> tuple[float, dict[str, int]]:
    """The base's tokens and its bytes by part, from the first of the conversation's requests.

    Raises ValueError when logging began partway through the conversation, or
    a request sent other system blocks or tools than the first.
    """
    first = reqs[0]
    if any(p["part"] == "assistant" for p in first["parts"]):
        raise ValueError(f"{session_dir} was logged from partway through, so its base has no exact count")
    for n, r in enumerate(reqs):
        if base_defs(r) != base_defs(first):
            raise ValueError(f"request {n} sent other system blocks or tools than the first, so its base has no exact count")
    defs, kinds = def_bytes(session_dir, first), kind_bytes(session_dir, first)
    parts = {"systemPrompt": defs["systemPrompt"], "tools": defs["tools"], "preamble": kinds.get("system", 0)}
    other = sum(n for k, n in kinds.items() if k != "system") + defs["toolsLoaded"]
    return first["inputTokens"] * sum(parts.values()) / (sum(parts.values()) + other), parts


def rest_bytes(session_dir: str, request: dict) -> int:
    """What a request sent besides its base, in bytes."""
    return def_bytes(session_dir, request)["toolsLoaded"] + sum(n for k, n in kind_bytes(session_dir, request).items() if k != "system")


def _plain(m: dict) -> str:
    """A message as JSON without breakpoints. Claude Code sends a lone text
    block carrying one as an array, and as a string once the breakpoint moves
    on, so that becomes the string."""
    c = m["content"]
    if isinstance(c, list):
        c = [{k: v for k, v in b.items() if k != "cache_control"} for b in c]
        if len(c) == 1 and c[0].get("type") == "text" and len(c[0]) == 2:
            c = c[0]["text"]
    return json.dumps([m["role"], c], sort_keys=True)


def part_tokens(session_dir: str, reqs: list[dict]) -> dict[str, float]:
    """Each part's tokens, by hash, from the requests' reported counts.

    Taken in order, a request's count less what its parts already counted is
    what its new parts cost together. A new assistant message costs the output
    count of the request that answered with it (its input cost is within about
    15 tokens of that); the other new parts share what is left by bytes. The
    parts are the messages, keyed by hash; the system blocks and tools sent in
    full together, keyed `defs:` and their hashes; and each loaded deferred
    tool, keyed `tool:` and its hash. A message whose breakpoint moved is the
    same part under another hash.
    """
    parts = os.path.join(session_dir, "parts")
    plain = {h: _plain(json.load(open(os.path.join(parts, h + ".json"), encoding="utf-8"))) for r in reqs for h in {p["hash"] for p in r["parts"]}}
    known: dict[str, float] = {}  # by plain message, or defs:/tool: key
    answered: set[int] = set()  # requests whose answer has its count
    out: dict[str, float] = {}
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
        left = r["inputTokens"] - sum(known[k] * count.get(k, 1) for k in sizes if k in known)
        new = [k for k in sizes if k not in known]
        for i, k in enumerate(msgs):
            if k in new and k.startswith('["assistant"') and i:
                # Answered by the latest request ending with the message before
                # it. A later, trimmed version of that answer is not the answer.
                by = next((j for j in range(n - 1, -1, -1) if reqs[j]["parts"] and plain[reqs[j]["parts"][-1]["hash"]] == msgs[i - 1]), None)
                if by is not None and by not in answered and reqs[by].get("outputTokens"):
                    answered.add(by)
                    known[k] = reqs[by]["outputTokens"]
                    left -= known[k] * count[k]
                    new.remove(k)
        rest = sum(sizes[k] * count.get(k, 1) for k in new)
        for k in new:
            known[k] = left * sizes[k] / rest
        for p, k in zip(r["parts"], msgs):
            out[p["hash"]] = known[k]
        out.update({k: known[k] for k in sizes if not k.startswith("[")})
    return out

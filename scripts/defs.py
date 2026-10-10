"""What a logged request sent besides its messages, in bytes.

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

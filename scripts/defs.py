"""What a logged request sent besides its messages, in bytes.

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

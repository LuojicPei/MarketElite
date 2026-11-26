from __future__ import annotations

import re
from collections.abc import Mapping

_WS_SANITIZE_RE = re.compile(r"[^A-Za-z0-9_\-]")


def resolve_workspace_id(headers: Mapping[str, str] | None = None, *, default: str = "default") -> str:
    """Resolve and sanitize workspace tenant identifier from X-Workspace-Id header.

    Falls back to ``"default"`` when omitted so existing single-user setups and API clients
    remain 100% compatible while public multi-user clients get isolated workspace storage.
    """
    if not headers:
        return default
    raw = ""
    for k, v in headers.items():
        if k.lower() == "x-workspace-id" and isinstance(v, str):
            raw = v.strip()
            break
    if not raw:
        return default
    cleaned = _WS_SANITIZE_RE.sub("", raw)[:48]
    return cleaned or default

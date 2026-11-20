from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import psycopg
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg_pool import AsyncConnectionPool

logger = logging.getLogger(__name__)


def enable_strict_checkpoint_serde() -> None:
    """Enforce LangGraph strict msgpack serialization mode cleanly."""
    os.environ.setdefault("LANGGRAPH_STRICT_MSGPACK", "true")


async def build_checkpointer(
    pg_pool: AsyncConnectionPool | None,
) -> tuple[BaseCheckpointSaver[Any], bool]:
    """Build durable AsyncPostgresSaver (with idempotent DDL setup) or InMemorySaver fallback."""
    enable_strict_checkpoint_serde()
    if pg_pool is None:
        return InMemorySaver(), False

    try:
        saver = AsyncPostgresSaver(conn=pg_pool)
        await asyncio.wait_for(saver.setup(), timeout=6.0)
        return saver, True
    except (psycopg.Error, OSError, asyncio.TimeoutError, RuntimeError, ValueError) as exc:
        logger.warning(
            "AsyncPostgresSaver setup unavailable (%s); using InMemorySaver fallback", exc
        )
        return InMemorySaver(), False

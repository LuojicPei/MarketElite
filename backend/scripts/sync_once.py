from __future__ import annotations

import asyncio
import json

import redis.asyncio as aioredis

from app.core.config import get_settings
from app.db.session import (
    create_db_engine,
    create_session_factory,
    ensure_windows_selector_event_loop,
)
from app.services.pipeline import run_full_pipeline_sync

ensure_windows_selector_event_loop()


async def _main() -> None:
    settings = get_settings()
    engine = create_db_engine(settings)
    factory = create_session_factory(engine)
    redis_client = aioredis.from_url(settings.redis_url, encoding="utf-8", decode_responses=True)
    try:
        summary = await run_full_pipeline_sync(factory, redis_client, settings, force_refresh=True)
        print(json.dumps(summary, indent=2, ensure_ascii=False))
    finally:
        await redis_client.aclose()
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(_main())

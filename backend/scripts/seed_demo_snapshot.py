from __future__ import annotations

import argparse
import asyncio
import json

import redis.asyncio as aioredis

from app.core.config import get_settings
from app.db.models import Base
from app.db.session import (
    create_db_engine,
    create_session_factory,
    ensure_windows_selector_event_loop,
)
from app.services.demo_seed import ensure_demo_snapshot_seeded

ensure_windows_selector_event_loop()


async def _main(force: bool) -> None:
    settings = get_settings()
    engine = create_db_engine(settings)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all, checkfirst=True)

    factory = create_session_factory(engine)
    redis_client = None
    try:
        redis_client = aioredis.from_url(settings.redis_url, encoding="utf-8", decode_responses=True)
        await redis_client.ping()
    except Exception:  # noqa: BLE001
        redis_client = None

    try:
        summary = await ensure_demo_snapshot_seeded(
            factory,
            redis_client,
            settings,
            force=force,
        )
        print(json.dumps(summary, indent=2, ensure_ascii=False))
    finally:
        if redis_client is not None:
            await redis_client.aclose()
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Seed MarketElite with a 0-Key sanitized demo snapshot when DB is empty."
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force inserting/recomputing demo snapshot rows even if DB already has bars.",
    )
    args = parser.parse_args()
    asyncio.run(_main(force=args.force))

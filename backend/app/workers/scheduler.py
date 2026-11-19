from __future__ import annotations

import logging
from typing import Any, ClassVar

import redis.asyncio as aioredis
from arq import cron
from arq.connections import RedisSettings

from app.core.config import get_settings
from app.db.session import (
    create_db_engine,
    create_session_factory,
    ensure_windows_selector_event_loop,
)
from app.workers.tasks import (
    job_full_bootstrap_sync,
    job_sync_calendars_and_cot,
    job_sync_equities_and_options,
    job_sync_macro_and_cboe,
)

# Psycopg3 async requires SelectorEventLoop on Windows before ARQ spawns event loop
ensure_windows_selector_event_loop()

logger = logging.getLogger(__name__)


async def startup(ctx: dict[str, Any]) -> None:
    """Initialize DB engine, SQLAlchemy session factory, and Redis client inside ARQ context."""
    settings = get_settings()
    engine = create_db_engine(settings)
    ctx["settings"] = settings
    ctx["db_engine"] = engine
    ctx["session_factory"] = create_session_factory(engine)
    ctx["redis"] = aioredis.from_url(
        settings.redis_url,
        encoding="utf-8",
        decode_responses=True,
    )
    logger.info("MarketElite ARQ worker started against %s", settings.redis_url)


async def shutdown(ctx: dict[str, Any]) -> None:
    """Cleanly dispose async DB engine and close Redis pool on worker exit."""
    redis_client = ctx.get("redis")
    if redis_client is not None:
        await redis_client.aclose()
    engine = ctx.get("db_engine")
    if engine is not None:
        await engine.dispose()
    logger.info("MarketElite ARQ worker shut down cleanly")


class WorkerSettings:
    """ARQ worker and cron configuration (run with: `arq app.workers.scheduler.WorkerSettings`)."""

    functions: ClassVar[list[Any]] = [
        job_sync_macro_and_cboe,
        job_sync_equities_and_options,
        job_sync_calendars_and_cot,
        job_full_bootstrap_sync,
    ]

    cron_jobs: ClassVar[list[Any]] = [
        # Refresh intraday US market bars, BTC, and SPY/QQQ GEX every 15m Mon-Fri
        cron(job_sync_equities_and_options, weekday={0, 1, 2, 3, 4}, minute={0, 15, 30, 45}),
        # Refresh FRED macro series and CBOE VIX term structure hourly at :05
        cron(job_sync_macro_and_cboe, minute={5}),
        # Refresh macro/earnings calendars and CFTC weekly positioning twice daily
        cron(job_sync_calendars_and_cot, hour={12, 22}, minute={10}),
    ]

    on_startup = startup
    on_shutdown = shutdown
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
    max_jobs = 4
    job_timeout = 180

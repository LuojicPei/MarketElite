from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import Settings, get_settings


def ensure_windows_selector_event_loop() -> None:
    """Psycopg3 async requires SelectorEventLoop on Windows before loop creation."""
    if os.name == "nt" and not isinstance(
        asyncio.get_event_loop_policy(), asyncio.WindowsSelectorEventLoopPolicy
    ):
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


def create_db_engine(settings: Settings | None = None) -> AsyncEngine:
    """Create configured async SQLAlchemy engine for PostgreSQL + psycopg3."""
    cfg = settings or get_settings()
    return create_async_engine(
        cfg.database_url,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
    )


def create_session_factory(engine: AsyncEngine | None = None) -> async_sessionmaker[AsyncSession]:
    """Create async session factory bound to an engine."""
    target_engine = engine or create_db_engine()
    return async_sessionmaker(target_engine, class_=AsyncSession, expire_on_commit=False)


async def get_db_session() -> AsyncIterator[AsyncSession]:
    """FastAPI/service async dependency yielding a clean SQLAlchemy session."""
    engine = create_db_engine()
    factory = create_session_factory(engine)
    try:
        async with factory() as session:
            yield session
    finally:
        await engine.dispose()

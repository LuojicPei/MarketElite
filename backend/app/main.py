from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Psycopg3 async requires SelectorEventLoop on Windows
if os.name == "nt":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from app.agents.checkpointer import build_checkpointer
from app.api.agent import router as agent_router
from app.api.health import router as health_router
from app.api.market import router as market_router
from app.api.trade import router as trade_router
from app.api.watchdog import router as watchdog_router
from app.core.clients import InfraManager
from app.core.config import get_settings
from app.core.telemetry import init_phoenix_telemetry
from app.db.models import UserWatchlistItem
from app.db.session import create_db_engine, create_session_factory
from app.mcp_servers.market_server import build_market_mcp_server, configure_mcp_dependencies
from app.services.news_discover import (
    shutdown_discover_tasks,
    startup_discover_warmup,
)
from app.services.resilience import DualTTLCache


def create_app() -> FastAPI:
    settings = get_settings()
    app_mcp = build_market_mcp_server()
    mcp_http_app = app_mcp.streamable_http_app()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        init_phoenix_telemetry(settings)
        infra = InfraManager(settings)
        await infra.startup()
        checkpointer, pg_checkpoint_ready = await build_checkpointer(infra.pg_pool)
        db_engine = create_db_engine(settings)
        async with db_engine.begin() as conn:
            await conn.run_sync(UserWatchlistItem.__table__.create, checkfirst=True)
        session_factory = create_session_factory(db_engine)
        configure_mcp_dependencies(
            settings=settings,
            session_factory=session_factory,
            redis_client=infra.redis,
        )
        app.state.infra = infra
        app.state.checkpointer = checkpointer
        app.state.pg_checkpoint_ready = pg_checkpoint_ready
        app.state.db_engine = db_engine
        app.state.session_factory = session_factory
        app.state.mcp = app_mcp
        async with app_mcp.session_manager.run():
            warmup_task: asyncio.Task[None] | None = None
            if not os.environ.get("PYTEST_CURRENT_TEST") and infra.redis is not None:
                warmup_task = asyncio.create_task(
                    startup_discover_warmup(DualTTLCache(infra.redis), settings)
                )
            try:
                yield
            finally:
                if warmup_task is not None and not warmup_task.done():
                    warmup_task.cancel()
                await shutdown_discover_tasks()
                await db_engine.dispose()
                await infra.shutdown()

    app = FastAPI(
        title=f"{settings.app_name} API",
        version="0.5.0",
        description="Production-grade US Equity Market Structure & Multi-Agent Risk Workstation",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health_router)
    app.include_router(market_router)
    app.include_router(agent_router)
    app.include_router(trade_router)
    app.include_router(watchdog_router)
    app.mount("/mcp-server", mcp_http_app)
    return app


app = create_app()

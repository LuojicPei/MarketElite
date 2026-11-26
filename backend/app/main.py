from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

# Psycopg3 async requires SelectorEventLoop on Windows
if os.name == "nt":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from app.agents.checkpointer import build_checkpointer
from app.api.agent import router as agent_router
from app.api.dataplatform import router as dataplatform_router
from app.api.health import router as health_router
from app.api.market import router as market_router
from app.api.trade import router as trade_router
from app.api.watchdog import router as watchdog_router
from app.core.clients import InfraManager
from app.core.config import get_settings
from app.core.telemetry import init_phoenix_telemetry
from app.db.models import EvalRun, ImportedHolding, InvestigatorThread, UserWatchlistItem
from app.db.session import create_db_engine, create_session_factory
from app.mcp_servers.market_server import build_market_mcp_server, configure_mcp_dependencies
from app.services.autopilot import WatchdogAutopilotManager
from app.services.news_discover import (
    shutdown_discover_tasks,
    startup_discover_warmup,
)
from app.services.pipeline import startup_market_bars_warmup
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
            await conn.run_sync(InvestigatorThread.__table__.create, checkfirst=True)
            await conn.run_sync(ImportedHolding.__table__.create, checkfirst=True)
            await conn.run_sync(EvalRun.__table__.create, checkfirst=True)
            await conn.execute(
                text(
                    "ALTER TABLE episodic_memories "
                    "ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE"
                )
            )
            await conn.execute(
                text(
                    "ALTER TABLE episodic_memories "
                    "ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE"
                )
            )
            for tbl in (
                "paper_trades",
                "watchdog_alerts",
                "episodic_memories",
                "user_watchlist_items",
                "investigator_threads",
            ):
                await conn.execute(
                    text(
                        f"ALTER TABLE {tbl} "
                        "ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(64) NOT NULL DEFAULT 'default'"
                    )
                )
            for tbl, cname, cols in (
                ("watchdog_alerts", "uq_watchdog_alert_key", "workspace_id, alert_key"),
                ("user_watchlist_items", "uq_user_watchlist_symbol", "workspace_id, symbol"),
                ("investigator_threads", "uq_investigator_thread_id", "workspace_id, thread_id"),
            ):
                await conn.execute(
                    text(
                        f"""
                        DO $$
                        BEGIN
                          IF (
                            SELECT COUNT(*) FROM information_schema.key_column_usage
                            WHERE table_name = '{tbl}' AND constraint_name = '{cname}'
                          ) = 1 THEN
                            ALTER TABLE {tbl} DROP CONSTRAINT {cname};
                            ALTER TABLE {tbl} ADD CONSTRAINT {cname} UNIQUE ({cols});
                          END IF;
                        END $$;
                        """
                    )
                )
        session_factory = create_session_factory(db_engine)
        configure_mcp_dependencies(
            settings=settings,
            session_factory=session_factory,
            redis_client=infra.redis,
        )
        autopilot = WatchdogAutopilotManager(session_factory, settings)
        app.state.infra = infra
        app.state.checkpointer = checkpointer
        app.state.pg_checkpoint_ready = pg_checkpoint_ready
        app.state.db_engine = db_engine
        app.state.session_factory = session_factory
        app.state.mcp = app_mcp
        app.state.autopilot = autopilot
        async with app_mcp.session_manager.run():
            warmup_task: asyncio.Task[None] | None = None
            bars_warmup_task: asyncio.Task[None] | None = None
            if not os.environ.get("PYTEST_CURRENT_TEST"):
                autopilot.start()
                if infra.redis is not None:
                    warmup_task = asyncio.create_task(
                        startup_discover_warmup(DualTTLCache(infra.redis), settings)
                    )
                bars_warmup_task = asyncio.create_task(
                    startup_market_bars_warmup(session_factory, infra.redis, settings)
                )
            try:
                yield
            finally:
                await autopilot.stop()
                for bg_task in (warmup_task, bars_warmup_task):
                    if bg_task is not None and not bg_task.done():
                        bg_task.cancel()
                await shutdown_discover_tasks()
                await db_engine.dispose()
                await infra.shutdown()

    app = FastAPI(
        title=f"{settings.app_name} API",
        version="1.0.0",
        description="Production-grade US Equity Market Structure, Data/Eval Governance & Multi-Agent Risk Workstation",
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
    app.include_router(dataplatform_router)
    app.include_router(market_router)
    app.include_router(agent_router)
    app.include_router(trade_router)
    app.include_router(watchdog_router)
    app.mount("/mcp-server", mcp_http_app)
    return app


app = create_app()

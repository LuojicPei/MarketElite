from __future__ import annotations

import time
from typing import Any

import httpx
import psycopg
from psycopg_pool import AsyncConnectionPool
import redis.asyncio as aioredis

from app.core.config import Settings


class InfraManager:
    """Manages async PostgreSQL pool and Redis client lifecycle plus health probes."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.pg_pool: AsyncConnectionPool | None = None
        self.redis: aioredis.Redis | None = None

    async def startup(self) -> None:
        """Initialize connection pools lazily without crashing app boot if containers are down."""
        try:
            self.pg_pool = AsyncConnectionPool(
                conninfo=self.settings.libpq_dsn,
                min_size=1,
                max_size=10,
                open=False,
                kwargs={"autocommit": True, "prepare_threshold": 0},
            )
            await self.pg_pool.open(wait=False)
        except Exception:
            self.pg_pool = None

        try:
            self.redis = aioredis.from_url(
                self.settings.redis_url,
                decode_responses=True,
                socket_connect_timeout=2.0,
                socket_timeout=2.0,
            )
        except Exception:
            self.redis = None

    async def shutdown(self) -> None:
        if self.pg_pool is not None:
            await self.pg_pool.close()
            self.pg_pool = None
        if self.redis is not None:
            await self.redis.aclose()
            self.redis = None

    async def probe_postgres(self) -> dict[str, Any]:
        started = time.perf_counter()
        try:
            if self.pg_pool is None:
                async with await psycopg.AsyncConnection.connect(
                    self.settings.libpq_dsn,
                    connect_timeout=2,
                ) as conn:
                    return await self._inspect_pg_connection(conn, started)

            async with self.pg_pool.connection(timeout=2.0) as conn:
                return await self._inspect_pg_connection(conn, started)
        except Exception as exc:
            return {
                "status": "down",
                "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                "pgvector_enabled": False,
                "detail": str(exc)[:180],
            }

    @staticmethod
    async def _inspect_pg_connection(conn: psycopg.AsyncConnection, started: float) -> dict[str, Any]:
        async with conn.cursor() as cur:
            await cur.execute("SELECT 1;")
            await cur.execute("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector');")
            row = await cur.fetchone()
            has_vector = bool(row and row[0])
        return {
            "status": "up",
            "latency_ms": round((time.perf_counter() - started) * 1000, 2),
            "pgvector_enabled": has_vector,
            "detail": "PostgreSQL + pgvector ready" if has_vector else "Connected (pgvector extension missing)",
        }

    async def probe_redis(self) -> dict[str, Any]:
        started = time.perf_counter()
        client = self.redis
        created_ephemeral = False
        try:
            if client is None:
                client = aioredis.from_url(
                    self.settings.redis_url,
                    decode_responses=True,
                    socket_connect_timeout=2.0,
                    socket_timeout=2.0,
                )
                created_ephemeral = True
            pong = await client.ping()
            return {
                "status": "up" if pong else "down",
                "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                "detail": "Redis PONG received" if pong else "Unexpected PING response",
            }
        except Exception as exc:
            return {
                "status": "down",
                "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                "detail": str(exc)[:180],
            }
        finally:
            if created_ephemeral and client is not None:
                await client.aclose()

    async def probe_phoenix(self) -> dict[str, Any]:
        started = time.perf_counter()
        if not self.settings.enable_telemetry:
            return {
                "status": "disabled",
                "latency_ms": 0.0,
                "ui_url": self.settings.phoenix_ui_url,
                "detail": "Telemetry disabled via ENABLE_TELEMETRY=false",
            }
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(self.settings.phoenix_ui_url)
            is_up = resp.status_code < 500
            return {
                "status": "up" if is_up else "down",
                "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                "ui_url": self.settings.phoenix_ui_url,
                "detail": f"HTTP {resp.status_code}",
            }
        except Exception as exc:
            return {
                "status": "down",
                "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                "ui_url": self.settings.phoenix_ui_url,
                "detail": str(exc)[:180],
            }

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agents.watchdog import reflect_on_trade, run_watchdog_scan
from app.core.config import Settings
from app.db.models import PaperTrade, TradeReview

logger = logging.getLogger(__name__)

_NY_TZ = ZoneInfo("America/New_York")


def _is_us_regular_or_extended_hours(now_utc: datetime) -> bool:
    ny = now_utc.astimezone(_NY_TZ)
    if ny.weekday() >= 5:
        return False
    mins = ny.hour * 60 + ny.minute
    return (4 * 60) <= mins <= (20 * 60)


class WatchdogAutopilotManager:
    """Lightweight in-process Watchdog & auto-reflection background loop cleanly bound to FastAPI lifespan."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        settings: Settings,
        *,
        enabled: bool = True,
        interval_seconds: int = 900,
        run_24_7: bool = True,
    ) -> None:
        self._session_factory = session_factory
        self._settings = settings
        self.enabled = enabled
        self.interval_seconds = max(60, min(3600, int(interval_seconds)))
        self.run_24_7 = run_24_7

        self._task: asyncio.Task[None] | None = None
        self._wake_event = asyncio.Event()
        self._run_lock = asyncio.Lock()

        self.running_now = False
        self.run_count = 0
        self.last_run_at: datetime | None = None
        self.next_run_at: datetime | None = (
            datetime.now(timezone.utc) + timedelta(seconds=self.interval_seconds) if enabled else None
        )
        self.last_summary: dict[str, Any] | None = None
        self.recent_runs: list[dict[str, Any]] = []

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._loop(), name="marketelite-watchdog-autopilot")

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task
        self._task = None

    def configure(
        self,
        *,
        enabled: bool | None = None,
        interval_seconds: int | None = None,
        run_24_7: bool | None = None,
    ) -> dict[str, Any]:
        if enabled is not None:
            self.enabled = bool(enabled)
        if interval_seconds is not None:
            self.interval_seconds = max(60, min(3600, int(interval_seconds)))
        if run_24_7 is not None:
            self.run_24_7 = bool(run_24_7)

        if self.enabled:
            self.next_run_at = datetime.now(timezone.utc) + timedelta(seconds=self.interval_seconds)
        else:
            self.next_run_at = None
        self._wake_event.set()
        return self.status()

    def status(self) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        remaining_sec: int | None = None
        if self.enabled and self.next_run_at is not None:
            remaining_sec = max(0, int((self.next_run_at - now).total_seconds()))
        return {
            "enabled": self.enabled,
            "status": "paused" if not self.enabled else ("scanning" if self.running_now else "online"),
            "interval_seconds": self.interval_seconds,
            "run_24_7": self.run_24_7,
            "market_window_open": _is_us_regular_or_extended_hours(now),
            "running_now": self.running_now,
            "run_count": self.run_count,
            "last_run_at": self.last_run_at.isoformat() if self.last_run_at else None,
            "next_run_at": self.next_run_at.isoformat() if self.next_run_at else None,
            "seconds_to_next_run": remaining_sec,
            "last_summary": self.last_summary,
            "recent_runs": self.recent_runs[:5],
        }

    async def run_once(self, *, trigger: str = "manual") -> dict[str, Any]:
        async with self._run_lock:
            self.running_now = True
            started = time.perf_counter()
            now = datetime.now(timezone.utc)
            reflected_count = 0
            try:
                scan_res = await run_watchdog_scan(
                    self._session_factory,
                    self._settings,
                    use_fast_llm=False,
                )

                # Auto-reflect any settled closed trades missing a POST_CLOSE review
                async with self._session_factory() as session:
                    reviewed_ids_stmt = select(TradeReview.paper_trade_id)
                    reviewed_ids = {
                        int(row[0]) for row in (await session.execute(reviewed_ids_stmt)).all()
                    }
                    closed_stmt = (
                        select(PaperTrade)
                        .where(PaperTrade.status == "closed")
                        .order_by(desc(PaperTrade.closed_at))
                        .limit(10)
                    )
                    missing_reviews = [
                        int(t.id)
                        for t in (await session.execute(closed_stmt)).scalars().all()
                        if int(t.id) not in reviewed_ids
                    ]

                for tid in missing_reviews[:3]:
                    try:
                        await reflect_on_trade(
                            self._session_factory,
                            self._settings,
                            tid,
                            horizon="POST_CLOSE",
                            use_fast_llm=False,
                        )
                        reflected_count += 1
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("Autopilot reflection skipped for trade %s: %s", tid, exc)

                elapsed_ms = int((time.perf_counter() - started) * 1000)
                summary = {
                    "ok": True,
                    "trigger": trigger,
                    "ran_at": now.isoformat(),
                    "scanned_symbols": int(scan_res.get("scanned_symbols", 0)),
                    "alerts_upserted": int(scan_res.get("alerts_upserted", 0)),
                    "reflected_count": reflected_count,
                    "duration_ms": elapsed_ms,
                    "error": None,
                }
                self.last_run_at = now
                self.run_count += 1
                self.last_summary = summary
                self.recent_runs = [summary, *self.recent_runs[:4]]
                if self.enabled:
                    self.next_run_at = now + timedelta(seconds=self.interval_seconds)
                return summary
            except Exception as exc:  # noqa: BLE001
                logger.warning("Autopilot tick error: %s", exc)
                elapsed_ms = int((time.perf_counter() - started) * 1000)
                err_summary = {
                    "ok": False,
                    "trigger": trigger,
                    "ran_at": now.isoformat(),
                    "scanned_symbols": 0,
                    "alerts_upserted": 0,
                    "reflected_count": reflected_count,
                    "duration_ms": elapsed_ms,
                    "error": str(exc),
                }
                self.last_run_at = now
                self.last_summary = err_summary
                self.recent_runs = [err_summary, *self.recent_runs[:4]]
                if self.enabled:
                    self.next_run_at = now + timedelta(seconds=self.interval_seconds)
                return err_summary
            finally:
                self.running_now = False

    async def _loop(self) -> None:
        # Initial short settle delay after server startup so migrations/seeders finish first
        try:
            await asyncio.sleep(8)
        except asyncio.CancelledError:
            return

        while True:
            try:
                now = datetime.now(timezone.utc)
                if self.enabled and (self.run_24_7 or _is_us_regular_or_extended_hours(now)):
                    due = self.next_run_at is None or now >= self.next_run_at or self.last_run_at is None
                    if due:
                        await self.run_once(trigger="scheduled")

                wait_sec = 30.0
                if self.enabled and self.next_run_at is not None:
                    delta = (self.next_run_at - datetime.now(timezone.utc)).total_seconds()
                    wait_sec = max(5.0, min(30.0, delta))

                self._wake_event.clear()
                try:
                    await asyncio.wait_for(self._wake_event.wait(), timeout=wait_sec)
                except asyncio.TimeoutError:
                    pass
            except asyncio.CancelledError:
                return
            except Exception as exc:  # noqa: BLE001
                logger.warning("Watchdog autopilot loop recovered: %s", exc)
                await asyncio.sleep(15)

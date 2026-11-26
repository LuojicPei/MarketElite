from __future__ import annotations

import asyncio
from datetime import date
from typing import Any

from app.core.config import Settings
from app.services.demo_seed import (
    _build_demo_bars_rows,
    _build_demo_gex_snapshots,
    _build_demo_macro_rows,
    _recent_business_days,
    ensure_demo_snapshot_seeded,
)


class _ScalarResult:
    def __init__(self, val: int) -> None:
        self._val = val

    def scalar_one(self) -> int:
        return self._val


class _CountOnlySession:
    def __init__(self, values: list[int]) -> None:
        self._values = list(values)
        self._idx = 0

    async def __aenter__(self) -> "_CountOnlySession":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        return None

    async def execute(self, _stmt: Any) -> _ScalarResult:
        val = self._values[self._idx]
        self._idx += 1
        return _ScalarResult(val)


def test_demo_snapshot_generators_produce_valid_sanitized_series() -> None:
    days = _recent_business_days(65, end_date=date(2026, 11, 27))
    assert len(days) == 65
    assert all(d.weekday() < 5 for d in days)

    bars = _build_demo_bars_rows(days)
    assert len(bars) >= 35 * 65
    assert all(
        b["low"] <= b["open"] <= b["high"]
        and b["low"] <= b["close"] <= b["high"]
        and b["volume"] > 0
        and b["source"] == "demo_snapshot"
        for b in bars
    )

    macro = _build_demo_macro_rows(days)
    assert len(macro) == 15 * 65
    assert all(m["source"] == "demo_snapshot" for m in macro)

    gex = _build_demo_gex_snapshots()
    assert len(gex) == 10
    assert all(
        g["put_wall"] < g["spot_price"] < g["call_wall"]
        and len(g["strike_profile_json"]) == 11
        for g in gex
    )


def test_ensure_demo_snapshot_seeded_skips_when_db_populated() -> None:
    settings = Settings(_env_file=None)

    def _sf() -> _CountOnlySession:
        return _CountOnlySession([1200, 14])

    res = asyncio.run(
        ensure_demo_snapshot_seeded(_sf, None, settings, force=False)  # type: ignore[arg-type]
    )
    assert res["status"] == "skipped"
    assert res["reason"] == "database_already_populated"
    assert res["market_daily_bars"] == 1200

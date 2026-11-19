from __future__ import annotations

import json
import time
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
from fastapi.testclient import TestClient
from typing_extensions import Self

from app.core.config import Settings
from app.main import create_app
from app.services.pipeline import OVERVIEW_CACHE_KEY
from app.services.providers.macro_feeds import MacroFeedsClient
from tests.test_resilience import InMemoryFakeRedis


class _FakeScalarResult:
    def __init__(self, items: list[object]) -> None:
        self._items = items

    def scalars(self) -> _FakeScalarResult:
        return self

    def all(self) -> list[object]:
        return self._items

    def scalar_one_or_none(self) -> object | None:
        return self._items[0] if self._items else None


class _FakeSession:
    def __init__(self, responses: list[list[object]]) -> None:
        self._responses = responses
        self._idx = 0

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def execute(self, stmt: object) -> _FakeScalarResult:
        items = self._responses[self._idx] if self._idx < len(self._responses) else []
        self._idx += 1
        return _FakeScalarResult(items)


def test_dashboard_overview_reads_redis_cache_fast() -> None:
    app = create_app()
    fake_redis = InMemoryFakeRedis()

    with TestClient(app) as client:
        app.state.infra.redis = fake_redis
        envelope = {
            "payload": {
                "generated_at": "2026-11-19T20:00:00+00:00",
                "regime_date": "2026-11-19",
                "regime": {"regime_label": "RISK_ON_EXPANSION"},
                "macro": {"net_liquidity": {"latest_billions": 6120.5}},
            },
            "fetched_at": "2026-11-19T20:00:00+00:00",
            "source": "marketelite_pipeline",
            "soft_expires_at": time.time() + 600,
        }
        fake_redis._store[OVERVIEW_CACHE_KEY] = (json.dumps(envelope), None)

        resp = client.get("/api/dashboard/overview")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["cache_source"] == "redis"
        assert body["regime"]["regime_label"] == "RISK_ON_EXPANSION"


def test_asset_detail_returns_bars_technicals_and_estimated_gex() -> None:
    app = create_app()

    fake_bars = [
        SimpleNamespace(
            trade_date=date(2026, 10, 1 + i),
            asset_class="etf",
            source="alpaca_sip_1d",
            open=580.0 + i * 0.4,
            high=582.0 + i * 0.4,
            low=579.0 + i * 0.4,
            close=581.0 + i * 0.4,
            volume=50_000_000.0 + i * 100_000.0,
            vwap=581.2 + i * 0.4,
        )
        for i in range(25)
    ]
    # Note: DB returns DESC order which endpoint reverses
    fake_bars_desc = list(reversed(fake_bars))
    fake_gex = SimpleNamespace(
        snapshot_time=datetime(2026, 11, 19, 19, 30, tzinfo=timezone.utc),
        spot_price=590.6,
        net_gex=2_450_000_000.0,
        call_wall=600.0,
        put_wall=575.0,
        zero_gamma=584.0,
        put_call_ratio=1.08,
        total_call_oi=120000,
        total_put_oi=129600,
        assumption_label="Estimated GEX (Dealer Positioning Assumption · OCC T+1/T+2 OI)",
        strike_profile_json=[{"strike": 590.0, "call_gex": 1.2e9, "put_gex": -0.4e9}],
        is_stale=False,
    )

    with TestClient(app) as client:
        app.state.session_factory = lambda: _FakeSession([fake_bars_desc, [fake_gex]])
        resp = client.get("/api/assets/SPY")
        assert resp.status_code == 200
        body = resp.json()
        assert body["symbol"] == "SPY"
        assert len(body["bars"]) == 25
        assert body["technicals"]["available"] is True
        assert body["technicals"]["rsi_14"] is not None
        assert "Estimated GEX" in body["options_gex"]["assumption_label"]
        assert body["options_gex"]["call_wall"] == 600.0

        app.state.session_factory = lambda: _FakeSession([[], []])
        resp_missing = client.get("/api/assets/UNKNOWN")
        assert resp_missing.status_code == 404


def test_list_tracked_assets_returns_latest_prices() -> None:
    app = create_app()
    rows = [
        SimpleNamespace(
            symbol="SPY",
            asset_class="etf",
            trade_date=date(2026, 11, 19),
            close=606.0,
            volume=42_000_000.0,
        ),
        SimpleNamespace(
            symbol="SPY",
            asset_class="etf",
            trade_date=date(2026, 11, 18),
            close=600.0,
            volume=39_000_000.0,
        ),
    ]
    with TestClient(app) as client:
        app.state.session_factory = lambda: _FakeSession([rows])
        resp = client.get("/api/assets")
        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 1
        assert body["assets"][0]["symbol"] == "SPY"
        assert body["assets"][0]["change_1d_pct"] == 1.0


async def test_fred_macro_calendar_parses_releases() -> None:
    upcoming = (date.today() + timedelta(days=5)).isoformat()
    payload = {"release_dates": [{"date": upcoming}, {"date": "2020-01-01"}]}
    transport = httpx.MockTransport(lambda req: httpx.Response(200, json=payload))
    async with httpx.AsyncClient(transport=transport) as client:
        feeds = MacroFeedsClient(
            Settings(_env_file=None, fred_api_key="test_key"),
            http_client=client,
        )
        events = await feeds.get_fred_macro_calendar()
        assert len(events) == 4
        assert all(ev["event_type"] == "macro" for ev in events)
        assert any("CPI" in ev["title"] for ev in events)

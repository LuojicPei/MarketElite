from __future__ import annotations

import asyncio
import json
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.agents.debate import DebateRunner
from app.core.config import Settings
from app.db.models import MarketDailyBar, PaperTrade, TradeReview
from app.main import create_app
from app.services.broker import (
    BrokerConfig,
    fetch_unified_broker_state,
    invalidate_broker_state_cache,
)
from app.services.portfolio_analytics import (
    build_portfolio_analytics,
    enrich_positions_with_structure,
)
from tests.test_phase1_t212_broker_agent import _make_fake_session_factory
from tests.test_resilience import InMemoryFakeRedis


def _sample_market_facts(**overrides: Any) -> dict[str, Any]:
    base = {
        "symbol": "NVDA",
        "spot_price": 165.0,
        "atr_14": 6.2,
        "atr_pct": 3.76,
        "ema_20": 160.5,
        "sma_50": 152.0,
        "sma_200": 135.0,
        "dist_50ma_pct": 8.55,
        "rsi_14": 54.0,
        "rvol_20": 1.65,
        "change_1d_pct": 2.4,
        "change_5d_pct": 5.1,
        "change_20d_pct": 11.2,
        "volume_price_tag": "Volume Expansion Up",
        "call_wall": 185.0,
        "put_wall": 150.0,
        "zero_gamma": 172.0,
        "net_gex": -450_000_000.0,
        "put_call_ratio": 1.15,
        "regime_label": "RISK_OFF_STRESS",
        "catalysts": [
            {
                "event_type": "earnings",
                "event_time": "2026-11-30T21:00:00+00:00",
                "symbol": "NVDA",
                "title": "NVDA Quarterly Earnings",
                "impact": "High",
            }
        ],
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# 1. Bull vs Bear CRO Debate Engine
# ---------------------------------------------------------------------------


def test_debate_runner_deterministic_stress_test_detects_gex_and_concentration(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.agents.debate.load_symbol_market_facts",
        AsyncMock(return_value=_sample_market_facts()),
    )
    monkeypatch.setattr(
        "app.agents.debate.fetch_unified_broker_state",
        AsyncMock(
            return_value={
                "broker": "sandbox",
                "broker_label": "本地拟真模拟盘 · 24/7 Sandbox",
                "currency": "GBP",
                "account": {"equity": 50_000.0, "buying_power": 30_000.0, "currency": "GBP"},
                "positions": [{"symbol": "NVDA", "qty": 80, "market_value": 13_200.0}],
            }
        ),
    )

    fake_sec = SimpleNamespace(
        search=AsyncMock(
            return_value={
                "chunks": [
                    {
                        "form_type": "10-Q",
                        "filing_date": "2026-08-26",
                        "section_title": "Item 1A Risk Factors",
                        "content": "Export control restrictions and supply bottlenecks remain material risks.",
                    }
                ]
            }
        )
    )
    monkeypatch.setattr("app.agents.debate.HybridSecRetriever", lambda *a, **kw: fake_sec)
    monkeypatch.setattr(
        "app.agents.debate.EpisodicMemoryRetriever.recall",
        AsyncMock(
            return_value=[
                {
                    "id": 9,
                    "symbol": "NVDA",
                    "title": "NVDA [遵守 1% 预算纪律]",
                    "lesson_text": "Respect Zero Gamma and earnings gap risk.",
                }
            ]
        ),
    )

    runner = DebateRunner(
        Settings(_env_file=None, llm_pro_api_key="", llm_fast_api_key=""),
        _make_fake_session_factory([]),
        broker_config=BrokerConfig(provider="sandbox"),
        redis_client=InMemoryFakeRedis(),
    )
    report = asyncio.run(
        runner.run_debate(
            symbol="NVDA",
            side="buy",
            risk_budget_pct=1.5,
            thesis_hint="突破 EMA20 回踩试多",
        )
    )

    assert report["mode"] == "deterministic_stress_test"
    assert report["symbol"] == "NVDA"
    assert report["currency"] == "GBP"
    assert report["cro_verdict"]["risk_budget_pct"] == pytest.approx(1.5)
    assert report["cro_verdict"]["max_safe_qty"] >= 1
    assert report["key_levels"]["put_wall"] == pytest.approx(150.0)
    assert report["key_levels"]["zero_gamma"] == pytest.approx(172.0)
    assert report["key_levels"]["call_wall"] == pytest.approx(185.0)
    risk_tags = report["bear_case"]["key_risk_tags"]
    assert "MACRO_HEADWIND" in risk_tags
    assert "NEGATIVE_GEX" in risk_tags
    assert "CATALYST_10D" in risk_tags
    assert "CONCENTRATION" in risk_tags
    assert report.get("regime_zh")
    assert isinstance(report.get("key_insights"), list) and len(report["key_insights"]) >= 3
    assert len(report["bear_case"].get("risk_tags_zh") or []) >= 4
    assert len(report["bull_case"]["catalysts"]) >= 4
    assert len(report["bear_case"]["counter_arguments"]) >= 4


def test_debate_runner_llm_adversarial_preserves_deterministic_sizing(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.agents.debate.load_symbol_market_facts",
        AsyncMock(return_value=_sample_market_facts(regime_label="GOLDILOCKS_EXPANSION", catalysts=[], zero_gamma=155.0)),
    )
    monkeypatch.setattr(
        "app.agents.debate.fetch_unified_broker_state",
        AsyncMock(
            return_value={
                "broker": "sandbox",
                "broker_label": "Sandbox",
                "currency": "USD",
                "account": {"equity": 100_000.0, "buying_power": 100_000.0, "currency": "USD"},
                "positions": [],
            }
        ),
    )
    monkeypatch.setattr(
        "app.agents.debate.HybridSecRetriever",
        lambda *a, **kw: SimpleNamespace(search=AsyncMock(return_value={"chunks": []})),
    )
    monkeypatch.setattr(
        "app.agents.debate.EpisodicMemoryRetriever.recall",
        AsyncMock(return_value=[]),
    )

    fake_llm = SimpleNamespace(
        ainvoke=AsyncMock(
            return_value=SimpleNamespace(
                content=json.dumps(
                    {
                        "verdict": "BULL_FAVORED_WITH_CAP",
                        "conviction_score": 78,
                        "bull_headline": "NVDA 站在 EMA20 与 Zero Gamma 上方，结构偏多。",
                        "bull_catalysts": ["RVOL 1.65x 放量确认", "上方 Call Wall 185 提供空间", "宏观体制扩张配合"],
                        "bear_headline": "估值弹性偏高，严防跌破 Put Wall。",
                        "bear_counter_arguments": ["短期涨幅 +11.2% 存在获利回吐", "若放量跌破 EMA20 需迅速止损"],
                        "key_insights": ["回踩 EMA20 不破可分批建仓", "严格锚定 put wall 止损"],
                        "cro_summary": "多方胜算占优，建议严格按 1% 预算执行。",
                    },
                    ensure_ascii=False,
                )
            )
        )
    )

    runner = DebateRunner(
        Settings(_env_file=None, llm_pro_api_key="sk-dummy"),
        _make_fake_session_factory([]),
        pro_llm=fake_llm,
    )
    report = asyncio.run(runner.run_debate(symbol="NVDA", side="buy", risk_budget_pct=1.0))
    assert report["mode"] == "llm_adversarial"
    assert report["verdict"] == "BULL_FAVORED_WITH_CAP"
    assert report["conviction_score"] == 78
    assert report["key_insights"] == ["回踩 EMA20 不破可分批建仓", "严格锚定 put wall 止损"]
    assert report.get("regime_zh")
    assert report["cro_verdict"]["max_risk_dollars"] == pytest.approx(1000.0)


# ---------------------------------------------------------------------------
# 2. Portfolio Position Structure Enrichment & Analytics
# ---------------------------------------------------------------------------


def test_enrich_positions_adds_estimated_bounds_for_unbracketed_t212_holdings() -> None:
    fake_bars = [
        SimpleNamespace(
            trade_date=date(2026, 10, 1) + timedelta(days=i),
            open=160.0,
            high=166.0,
            low=158.0,
            close=164.0,
            volume=30_000_000.0,
            vwap=162.5,
        )
        for i in range(30)
    ]
    fake_gex = SimpleNamespace(call_wall=190.0, put_wall=150.0, zero_gamma=162.0)

    sf = _make_fake_session_factory([[fake_bars, [fake_gex]]])
    positions = [
        {"symbol": "NVDA", "side": "long", "qty": 10, "avg_entry_price": 158.0, "current_price": 164.0},
        {
            "symbol": "NVDA",
            "side": "long",
            "qty": 5,
            "avg_entry_price": 158.0,
            "current_price": 164.0,
            "stop_loss_price": 148.0,
            "take_profit_price": 182.0,
        },
    ]
    out = asyncio.run(enrich_positions_with_structure(sf, positions))
    assert len(out) == 2
    assert out[0]["sl_is_estimated"] is True
    assert float(out[0]["stop_loss_price"]) < 158.0 < float(out[0]["take_profit_price"])
    assert out[0]["zero_gamma"] == pytest.approx(162.0)
    assert out[1]["sl_is_estimated"] is False
    assert out[1]["stop_loss_price"] == pytest.approx(148.0)
    assert out[1]["take_profit_price"] == pytest.approx(182.0)


def test_build_portfolio_analytics_computes_kpis_equity_curve_and_quadrants() -> None:
    t1 = PaperTrade(
        id=11,
        thread_id="t1",
        symbol="NVDA",
        side="buy",
        qty=20.0,
        entry_price=150.0,
        stop_loss_price=140.0,
        take_profit_price=180.0,
        risk_budget_pct=1.0,
        status="closed",
        realized_pnl=400.0,
        spy_benchmark_return_pct=1.2,
        regime_at_entry="GOLDILOCKS_EXPANSION",
        created_at=datetime(2026, 11, 10, 15, 0, tzinfo=timezone.utc),
        closed_at=datetime(2026, 11, 14, 15, 0, tzinfo=timezone.utc),
    )
    t2 = PaperTrade(
        id=12,
        thread_id="t2",
        symbol="TSLA",
        side="buy",
        qty=10.0,
        entry_price=300.0,
        stop_loss_price=285.0,
        take_profit_price=340.0,
        risk_budget_pct=1.0,
        status="closed",
        realized_pnl=-150.0,
        spy_benchmark_return_pct=-0.5,
        regime_at_entry="HIGH_VOL_TRANSITION",
        created_at=datetime(2026, 11, 15, 15, 0, tzinfo=timezone.utc),
        closed_at=datetime(2026, 11, 18, 15, 0, tzinfo=timezone.utc),
    )
    rev1 = TradeReview(
        id=1,
        paper_trade_id=11,
        horizon="POST_CLOSE",
        quadrant_outcome="GOOD_PROCESS_GOOD_OUTCOME",
        alpha_vs_spy_pct=12.13,
        regime_label="GOLDILOCKS_EXPANSION",
        lessons_markdown="Solid bracket execution",
        created_at=datetime(2026, 11, 14, 16, 0, tzinfo=timezone.utc),
    )
    spy_bars = [
        MarketDailyBar(symbol="SPY", asset_class="etf", source="alpaca", trade_date=date(2026, 11, 10), open=580, high=582, low=579, close=580.0, volume=1e7),
        MarketDailyBar(symbol="SPY", asset_class="etf", source="alpaca", trade_date=date(2026, 11, 14), open=585, high=587, low=584, close=586.0, volume=1e7),
        MarketDailyBar(symbol="SPY", asset_class="etf", source="alpaca", trade_date=date(2026, 11, 18), open=590, high=592, low=589, close=591.6, volume=1e7),
    ]

    sf = _make_fake_session_factory([[[t1, t2], [rev1], spy_bars]])
    analytics = asyncio.run(
        build_portfolio_analytics(
            session_factory=sf,
            broker="sandbox",
            account={"equity": 100_250.0, "currency": "USD"},
        )
    )

    assert analytics["has_sufficient_real_history"] is True
    kpis = analytics["kpis"]
    assert kpis["closed_trades"] == 2
    assert kpis["win_count"] == 1
    assert kpis["loss_count"] == 1
    assert kpis["win_rate_pct"] == pytest.approx(50.0)
    assert kpis["net_realized_pnl"] == pytest.approx(250.0)
    assert kpis["profit_factor"] == pytest.approx(400.0 / 150.0, abs=0.01)
    assert len(analytics["equity_curve"]) == 4  # initial + 2 trades + current mark-to-market
    assert len(analytics["quadrant_points"]) == 2
    assert analytics["quadrant_counts"]["GOOD_PROCESS_GOOD_OUTCOME"] == 1
    assert analytics["quadrant_counts"]["GOOD_PROCESS_BAD_OUTCOME"] == 1
    assert len(analytics["demo_preview"]["quadrant_points"]) == 6


# ---------------------------------------------------------------------------
# 3. Phase 2 FastAPI Endpoints Smoke Test
# ---------------------------------------------------------------------------


def test_phase2_api_debate_risk_structure_and_analytics_routes() -> None:
    app = create_app()
    fake_redis = InMemoryFakeRedis()

    with TestClient(app) as client:
        app.state.infra.redis = fake_redis

        debate_resp = client.post(
            "/api/agent/debate",
            headers={"X-Broker-Provider": "sandbox"},
            json={"symbol": "NVDA", "side": "buy", "risk_budget_pct": 1.5},
        )
        assert debate_resp.status_code == 200, debate_resp.text
        debate_data = debate_resp.json()
        assert debate_data["symbol"] == "NVDA"
        assert "bull_case" in debate_data and "bear_case" in debate_data
        assert "cro_verdict" in debate_data and "key_levels" in debate_data

        rs_resp = client.get(
            "/api/trade/risk-structure/NVDA?side=buy&risk_budget_pct=2.0",
            headers={"X-Broker-Provider": "sandbox"},
        )
        assert rs_resp.status_code == 200, rs_resp.text
        rs_data = rs_resp.json()
        assert rs_data["risk_sizing"]["risk_budget_pct"] == pytest.approx(2.0)
        assert rs_data["structure"]["spot_price"] > 0

        ana_resp = client.get(
            "/api/trade/analytics",
            headers={"X-Broker-Provider": "sandbox"},
        )
        assert ana_resp.status_code == 200, ana_resp.text
        ana_data = ana_resp.json()
        assert ana_data["status"] == "ok"
        assert "kpis" in ana_data and "equity_curve" in ana_data and "demo_preview" in ana_data


def test_fetch_unified_broker_state_alpaca_redis_cache_and_invalidation(monkeypatch) -> None:
    call_counter = {"account": 0, "positions": 0, "orders": 0}

    class _FakeAlpacaClient:
        def __init__(self, _settings: Any) -> None:
            pass

        async def get_account(self) -> dict[str, Any]:
            call_counter["account"] += 1
            return {"equity": "120000.0", "buying_power": "80000.0", "cash": "40000.0", "currency": "USD"}

        async def get_positions(self) -> list[dict[str, Any]]:
            call_counter["positions"] += 1
            return [{"symbol": "NVDA", "qty": "10", "avg_entry_price": "130.0", "current_price": "140.0"}]

        async def get_orders(self, status: str = "all", limit: int = 15) -> list[dict[str, Any]]:
            call_counter["orders"] += 1
            return []

    monkeypatch.setattr("app.services.broker.AlpacaClient", _FakeAlpacaClient)
    fake_redis = InMemoryFakeRedis()
    sf = _make_fake_session_factory([])
    settings = Settings(_env_file=None)
    cfg = BrokerConfig(provider="alpaca", workspace_id="ws-cache-test")

    async def _exercise() -> None:
        first = await fetch_unified_broker_state(
            session_factory=sf,
            settings=settings,
            redis_client=fake_redis,
            broker_cfg=cfg,
        )
        assert first["broker"] == "alpaca"
        assert call_counter == {"account": 1, "positions": 1, "orders": 1}

        # Second call hits Redis 45s snapshot cache without hitting Alpaca HTTP
        second = await fetch_unified_broker_state(
            session_factory=sf,
            settings=settings,
            redis_client=fake_redis,
            broker_cfg=cfg,
        )
        assert second["account"]["equity"] == "120000.0"
        assert call_counter == {"account": 1, "positions": 1, "orders": 1}

        # Invalidating cache forces fresh fetch
        await invalidate_broker_state_cache(fake_redis, cfg)
        await fetch_unified_broker_state(
            session_factory=sf,
            settings=settings,
            redis_client=fake_redis,
            broker_cfg=cfg,
        )
        assert call_counter == {"account": 2, "positions": 2, "orders": 2}

        # force_refresh=True bypasses warm cache
        await fetch_unified_broker_state(
            session_factory=sf,
            settings=settings,
            redis_client=fake_redis,
            broker_cfg=cfg,
            force_refresh=True,
        )
        assert call_counter == {"account": 3, "positions": 3, "orders": 3}

    asyncio.run(_exercise())

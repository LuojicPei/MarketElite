from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import httpx
from fastapi.testclient import TestClient
from typing_extensions import Self

from app.agents.watchdog import (
    EpisodicMemoryRetriever,
    classify_trade_quadrant,
    reflect_on_trade,
    run_watchdog_scan,
)
from app.api.trade import sync_paper_trade_statuses
from app.core.config import Settings
from app.db.models import (
    EpisodicMemory,
    MarketRegimeDaily,
    PaperTrade,
    TradeReview,
    WatchdogAlert,
)
from app.main import create_app
from app.services.pipeline import get_regime_history
from app.services.providers.alpaca import AlpacaClient
from tests.test_market_api import _FakeScalarResult


class _StatefulFakeSession:
    def __init__(self, responses: list[list[object]], *, store: dict[int, Any] | None = None) -> None:
        self._responses = responses
        self._idx = 0
        self._store = store if store is not None else {}
        self.added: list[object] = []
        self.committed = False

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def execute(self, stmt: object) -> _FakeScalarResult:
        items = self._responses[self._idx] if self._idx < len(self._responses) else []
        self._idx += 1
        return _FakeScalarResult(items)

    async def get(self, model: type[Any], pk: int) -> Any:
        return self._store.get((model, pk))

    def add(self, obj: Any) -> None:
        if getattr(obj, "id", None) is None:
            obj.id = len(self.added) + 1
        if getattr(obj, "created_at", None) is None:
            obj.created_at = datetime.now(timezone.utc)
        self.added.append(obj)

    async def refresh(self, obj: Any) -> None:
        if getattr(obj, "created_at", None) is None:
            obj.created_at = datetime.now(timezone.utc)

    async def commit(self) -> None:
        self.committed = True


def _make_bars(symbol: str, *, spike_last_vol: float = 1.0, crash_last_px: bool = False) -> list[Any]:
    out = []
    start = date(2026, 9, 1)
    px = 140.0
    for i in range(40):
        vol = 2_000_000.0 * (spike_last_vol if i == 39 else 1.0)
        if i == 39 and crash_last_px:
            px -= 7.0
        elif i > 0:
            px += 0.2
        out.append(
            SimpleNamespace(
                symbol=symbol,
                asset_class="equity",
                trade_date=start + timedelta(days=i),
                open=round(px - 0.5, 2),
                high=round(px + 1.0, 2),
                low=round(px - 1.0, 2),
                close=round(px, 2),
                volume=vol,
                vwap=round(px, 2),
                source="alpaca_sip_1d",
                fetched_at=datetime.now(timezone.utc),
            )
        )
    return out


def test_four_quadrant_attribution_distinguishes_process_from_luck() -> None:
    good_good = classify_trade_quadrant(
        side="buy",
        qty=20,
        entry_price=100.0,
        stop_loss_price=96.0,
        take_profit_price=110.0,
        risk_budget_pct=1.0,
        realized_pnl=180.0,
        spy_benchmark_return_pct=1.2,
        regime_at_entry="RISK_ON_EXPANSION",
    )
    assert good_good["quadrant"] == "GOOD_PROCESS_GOOD_OUTCOME"
    assert good_good["alpha_vs_spy_pct"] == 7.8

    good_bad = classify_trade_quadrant(
        side="buy",
        qty=20,
        entry_price=100.0,
        stop_loss_price=96.0,
        take_profit_price=110.0,
        risk_budget_pct=1.0,
        realized_pnl=-80.0,
        spy_benchmark_return_pct=0.5,
        regime_at_entry="NEUTRAL_ROTATION",
    )
    assert good_bad["quadrant"] == "GOOD_PROCESS_BAD_OUTCOME"

    bad_good = classify_trade_quadrant(
        side="buy",
        qty=50,
        entry_price=100.0,
        stop_loss_price=None,
        take_profit_price=None,
        risk_budget_pct=2.5,
        realized_pnl=240.0,
        spy_benchmark_return_pct=0.8,
        regime_at_entry="RISK_OFF_STRESS",
    )
    assert bad_good["quadrant"] == "BAD_PROCESS_GOOD_OUTCOME"

    bad_bad = classify_trade_quadrant(
        side="buy",
        qty=50,
        entry_price=100.0,
        stop_loss_price=None,
        take_profit_price=108.0,
        risk_budget_pct=3.0,
        realized_pnl=-500.0,
        spy_benchmark_return_pct=0.2,
        regime_at_entry="RISK_OFF_STRESS",
    )
    assert bad_bad["quadrant"] == "BAD_PROCESS_BAD_OUTCOME"


async def test_watchdog_scan_and_reflect_and_memory_recall() -> None:
    settings = Settings(llm_fast_api_key="", llm_pro_api_key="", llm_embedding_api_key="")
    latest_regime = SimpleNamespace(
        regime_label="RISK_OFF_STRESS",
        vix_spot=27.5,
        vix_3m=25.0,
        vix_term_ratio=1.10,
    )
    spy_bars_desc = list(reversed(_make_bars("SPY", spike_last_vol=2.6, crash_last_px=True)))
    spy_gex = SimpleNamespace(
        symbol="SPY",
        spot_price=140.0,
        net_gex=-420_000_000.0,
        zero_gamma=148.0,
        put_wall=135.0,
        call_wall=155.0,
    )

    # First query: latest_regime; 2nd: open_trade_syms; then per symbol (SPY first in universe -> bars, gex, then empty bars for other symbols, then upcoming macro)
    responses: list[list[object]] = [
        [latest_regime],
        [],
        spy_bars_desc,
        [spy_gex],
    ] + [[] for _ in range(30)]
    scan_session = _StatefulFakeSession(responses)
    res = await run_watchdog_scan(lambda: scan_session, settings, use_fast_llm=False)
    assert res["status"] == "ok"
    assert res["alerts_upserted"] >= 3  # vix_backwardation + rvol_spike + zero_gamma_breach
    assert scan_session.committed is True

    # Test reflect_on_trade creates TradeReview + EpisodicMemory cleanly
    trade = PaperTrade(
        id=42,
        thread_id="risk-NVDA-1",
        symbol="NVDA",
        side="buy",
        order_class="bracket",
        qty=10.0,
        entry_price=135.0,
        stop_loss_price=128.0,
        take_profit_price=150.0,
        risk_budget_pct=1.0,
        status="closed",
        regime_at_entry="RISK_ON_EXPANSION",
        rationale_summary="Call wall breakout setup",
        realized_pnl=150.0,
        spy_benchmark_return_pct=1.5,
        created_at=datetime.now(timezone.utc),
    )
    reflect_session = _StatefulFakeSession(
        responses=[[], []],  # no existing review, no existing memory
        store={(PaperTrade, 42): trade},
    )
    ref_out = await reflect_on_trade(lambda: reflect_session, settings, 42, use_fast_llm=False)
    assert ref_out["quadrant_outcome"] == "GOOD_PROCESS_GOOD_OUTCOME"
    assert any(isinstance(x, TradeReview) for x in reflect_session.added)
    assert any(isinstance(x, EpisodicMemory) for x in reflect_session.added)

    # Also exercise build_fast_llm signature cleanly against unreachable local endpoint
    fast_settings = Settings(
        _env_file=None,
        llm_fast_base_url="http://127.0.0.1:9/v1",
        llm_fast_api_key="dummy-key",
        llm_embedding_api_key="",
    )
    reflect_session_llm = _StatefulFakeSession(
        responses=[[], []],
        store={(PaperTrade, 42): trade},
    )
    # Without live network, build_fast_llm still instantiates cleanly and falls back gracefully on HTTP error
    ref_llm_out = await reflect_on_trade(
        lambda: reflect_session_llm, fast_settings, 42, use_fast_llm=True
    )
    assert ref_llm_out["quadrant_outcome"] == "GOOD_PROCESS_GOOD_OUTCOME"

    # Test EpisodicMemoryRetriever recalls by symbol & regime cleanly without embedding key
    fake_mem = EpisodicMemory(
        id=9,
        paper_trade_id=42,
        symbol="NVDA",
        regime_label="RISK_OFF_STRESS",
        quadrant_outcome="BAD_PROCESS_GOOD_OUTCOME",
        title="NVDA BUY [RISK_OFF]",
        lesson_text="Avoid sizing full 1% below Zero Gamma during VIX backwardation.",
        tags_json=["NVDA", "RISK_OFF_STRESS"],
        alpha_vs_spy_pct=-2.1,
        created_at=datetime.now(timezone.utc),
    )
    mem_session = _StatefulFakeSession(
        [
            [(fake_mem, 0.85)],  # websearch_to_tsquery
            [(fake_mem, 0.72)],  # OR tsquery fallback since len<4
            [fake_mem],  # recent fallback boost
        ]
    )
    retriever = EpisodicMemoryRetriever(settings, lambda: mem_session)
    recalled = await retriever.recall("Zero Gamma NVDA", symbol="NVDA", regime_label="RISK_OFF_STRESS")
    assert len(recalled) == 1
    assert recalled[0]["symbol"] == "NVDA"
    formatted = EpisodicMemoryRetriever.format_memories_for_prompt(recalled)
    assert "Zero Gamma" in formatted


async def test_sync_paper_trade_statuses_marks_tp_leg_closed_with_spy_alpha() -> None:
    def _handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v2/positions":
            return httpx.Response(200, json=[])
        if request.url.path == "/v2/orders/ord-123":
            return httpx.Response(
                200,
                json={
                    "id": "ord-123",
                    "symbol": "NVDA",
                    "side": "buy",
                    "qty": "10",
                    "filled_qty": "10",
                    "order_class": "bracket",
                    "type": "limit",
                    "status": "filled",
                    "filled_avg_price": "130.00",
                    "legs": [
                        {
                            "id": "leg-tp",
                            "side": "sell",
                            "type": "limit",
                            "status": "filled",
                            "filled_avg_price": "145.00",
                            "filled_at": "2026-11-20T15:30:00Z",
                        }
                    ],
                },
            )
        return httpx.Response(404, json={"message": "not found"})

    mock_http = httpx.AsyncClient(transport=httpx.MockTransport(_handler))
    settings = Settings(alpaca_api_key="k", alpaca_secret_key="s", alpaca_paper=True)
    alpaca = AlpacaClient(settings, http_client=mock_http)

    trade = PaperTrade(
        id=7,
        symbol="NVDA",
        side="buy",
        qty=10.0,
        entry_price=130.0,
        alpaca_order_id="ord-123",
        status="submitted",
        created_at=datetime(2026, 11, 10, tzinfo=timezone.utc),
    )
    spy_start = SimpleNamespace(close=580.0)
    spy_end = SimpleNamespace(close=591.6)  # +2.0% SPY return
    fake_session = _StatefulFakeSession([[trade], [spy_start], [spy_end]])

    res = await sync_paper_trade_statuses(lambda: fake_session, settings, alpaca_client=alpaca)
    await mock_http.aclose()

    assert res["updated"] == 1
    assert res["newly_closed_trade_ids"] == [7]
    assert trade.status == "closed"
    assert trade.realized_pnl == 150.0  # (145 - 130) * 10
    assert trade.spy_benchmark_return_pct == 2.0


def test_api_evals_and_watchdog_and_ensure_asset_routes(monkeypatch: Any) -> None:
    app = create_app()

    # Patch ensure_asset_persisted so endpoint test is deterministic and offline
    async def _fake_ensure(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "symbol": "AMD",
            "found": True,
            "bars_count": 260,
            "bars_status": "fetched",
            "gex_status": "fetched",
            "eps_status": "fetched",
        }

    monkeypatch.setattr("app.api.market.ensure_asset_persisted", _fake_ensure)

    with TestClient(app) as client:
        ensure_resp = client.post("/api/assets/amd/ensure")
        assert ensure_resp.status_code == 200
        assert ensure_resp.json()["symbol"] == "AMD"

        # Phase 5 golden eval API runs cleanly end-to-end
        eval_resp = client.post("/api/evals/run")
        assert eval_resp.status_code == 200
        ev = eval_resp.json()
        assert ev["total_cases"] == 32
        assert ev["passed_cases"] == 32
        assert ev["pass_rate_pct"] == 100.0

        # Watchdog alerts acknowledge API works cleanly
        alert = WatchdogAlert(
            id=5,
            alert_key="watchdog:rvol_spike:NVDA:2026-11-20",
            alert_type="rvol_spike",
            severity="high",
            symbol="NVDA",
            title="NVDA RVOL 2.5x",
            summary_markdown="High volume breakout.",
            metrics_json={"rvol_20": 2.5},
            regime_label="RISK_ON_EXPANSION",
            acknowledged=False,
            created_at=datetime.now(timezone.utc),
        )
        fake_session = _StatefulFakeSession([], store={(WatchdogAlert, 5): alert})
        app.state.session_factory = lambda: fake_session
        ack_resp = client.post("/api/watchdog/alerts/5/ack")
        assert ack_resp.status_code == 200
        assert alert.acknowledged is True


def test_alpaca_cancel_order_and_close_position_http() -> None:
    import asyncio

    def _handler(request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE" and request.url.path == "/v2/orders/ord-9":
            return httpx.Response(204)
        if request.method == "DELETE" and request.url.path == "/v2/positions/NVDA":
            return httpx.Response(200, json={"id": "close-1", "symbol": "NVDA", "side": "sell", "qty": "10", "status": "accepted"})
        return httpx.Response(404)

    async def _run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(_handler)) as http:
            client = AlpacaClient(
                Settings(alpaca_api_key="k", alpaca_secret_key="s", alpaca_paper=True),
                http_client=http,
            )
            c = await client.cancel_order("ord-9")
            assert c["status"] == "canceled"
            p = await client.close_position("NVDA")
            assert p["symbol"] == "NVDA"
            assert p["id"] == "close-1"

    asyncio.run(_run())


async def test_get_regime_history_uses_real_model_attributes() -> None:
    row = MarketRegimeDaily(
        regime_date=date(2026, 11, 20),
        regime_label="RISK_OFF_STRESS",
        fear_greed_score=32.8,
        fear_greed_label="Fear",
        vix_spot=28.44,
        vix_3m=27.03,
        vix_term_ratio=1.052,
        rsp_spy_ratio=0.295,
        pct_above_50ma=38.1,
        hy_oas=3.47,
        net_liquidity_billions=5824.43,
    )
    fake_session = _StatefulFakeSession([[row]])
    history = await get_regime_history(lambda: fake_session, limit=30)
    assert len(history) == 1
    assert history[0]["net_liquidity_bn"] == 5824.43
    assert history[0]["fear_greed_score"] == 32.8

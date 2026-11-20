from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import InMemorySaver

from app.agents.investigator import detect_trade_intent
from app.agents.risk_critic import RiskCriticRunner
from app.core.config import Settings
from app.main import create_app
from app.quant.risk import RiskSizingRequest, compute_risk_sizing, validate_bracket_prices
from app.services.providers.alpaca import AlpacaClient
from tests.test_market_api import _FakeSession
from tests.test_resilience import InMemoryFakeRedis


def test_risk_sizing_enforces_1pct_cap_and_bracket_invariants() -> None:
    res = compute_risk_sizing(
        RiskSizingRequest(
            symbol="NVDA",
            side="buy",
            account_equity=100_000.0,
            buying_power=100_000.0,
            spot_price=150.0,
            proposed_qty=200,
            entry_price=150.0,
            stop_loss_price=140.0,
            take_profit_price=170.0,
            atr_14=4.0,
            risk_budget_pct=1.0,
        )
    )
    # 1% of $100,000 = $1,000 max risk; $10 stop distance -> 100 shares cap (even if 200 proposed)
    assert res.max_risk_dollars == 1000.0
    assert res.max_safe_qty == 100
    assert res.recommended_qty == 100
    assert res.was_capped_by_risk is True
    assert res.bracket_valid is True
    assert res.risk_reward_ratio == 2.0

    bad = compute_risk_sizing(
        RiskSizingRequest(
            symbol="NVDA",
            side="buy",
            account_equity=100_000.0,
            buying_power=100_000.0,
            spot_price=150.0,
            proposed_qty=50,
            entry_price=150.0,
            stop_loss_price=155.0,  # Invalid SL above entry on BUY
            take_profit_price=170.0,
        )
    )
    assert bad.bracket_valid is False
    ok, _ = validate_bracket_prices(
        side="sell",
        entry_price=150.0,
        stop_loss_price=160.0,
        take_profit_price=130.0,
    )
    assert ok is True


class _CapturingCriticMockLLM:
    """Mock Reasoning LLM verifying context isolation and returning valid structured JSON."""

    def __init__(self) -> None:
        self.captured_message_counts: list[int] = []
        self.captured_prompts: list[str] = []

    async def ainvoke(self, messages: list[Any]) -> AIMessage:
        self.captured_message_counts.append(len(messages))
        self.captured_prompts.append(str(messages[-1].content))
        return AIMessage(
            content=json.dumps(
                {
                    "verdict": "CAUTION_REDUCED",
                    "summary": "逆风 Regime 下高波动风险，已强制缩仓至 1% 预算并设定止损。",
                    "counter_arguments": [
                        "4 天后将发布业绩/宏观事件，存在跳空穿止损风险",
                        "净伽马偏负，下跌波动可能被做市商对冲放大",
                    ],
                    "regime_alignment": "COUNTER_TREND",
                    "falsification_trigger": "有效跌破 $140.00 Put Wall 支撑位",
                    "suggested_stop_loss": 140.0,
                    "suggested_take_profit": 170.0,
                }
            )
        )


class _PersistingFakeSession(_FakeSession):
    def __init__(self, responses: list[list[object]]) -> None:
        super().__init__(responses)
        self.added: list[object] = []
        self.committed = False

    def add(self, obj: object) -> None:
        if getattr(obj, "id", None) is None:
            obj.id = len(self.added) + 1
        self.added.append(obj)

    async def commit(self) -> None:
        self.committed = True

    async def refresh(self, obj: object) -> None:
        return None


async def test_risk_critic_context_isolation_hitl_interrupt_and_bracket_submit(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.agents.risk_critic.get_market_regime_snapshot",
        AsyncMock(return_value="Regime Date: 2026-11-20 | Label: RISK_OFF_STRESS"),
    )
    monkeypatch.setattr(
        "app.agents.risk_critic.get_asset_structure",
        AsyncMock(return_value="Asset: NVDA | Price: $150.00 | ATR%=3.2%"),
    )

    submitted_orders: list[dict[str, Any]] = []

    def _alpaca_handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v2/account":
            return httpx.Response(
                200,
                json={"id": "acc-1", "status": "ACTIVE", "equity": "100000", "buying_power": "100000", "cash": "100000"},
            )
        if req.url.path == "/v2/positions":
            return httpx.Response(200, json=[])
        if req.url.path == "/v2/orders" and req.method == "POST":
            body = json.loads(req.content.decode("utf-8"))
            submitted_orders.append(body)
            return httpx.Response(
                200,
                json={
                    "id": "alpaca-ord-999",
                    "client_order_id": body.get("client_order_id"),
                    "symbol": body["symbol"],
                    "side": body["side"],
                    "qty": body["qty"],
                    "order_class": body["order_class"],
                    "type": body["type"],
                    "status": "accepted",
                    "submitted_at": "2026-11-20T15:30:00Z",
                    "legs": [{"id": "tp-leg"}, {"id": "sl-leg"}],
                },
            )
        return httpx.Response(404)

    settings = Settings(_env_file=None, alpaca_api_key="PKTEST", alpaca_secret_key="SKTEST")
    fake_bars = [
        SimpleNamespace(
            trade_date=date(2026, 10, 1) + timedelta(days=i),
            open=148.0,
            high=152.0,
            low=146.0,
            close=150.0,
            volume=50_000_000.0,
            vwap=149.5,
        )
        for i in range(30)
    ]
    fake_gex = SimpleNamespace(call_wall=170.0, put_wall=140.0, zero_gamma=154.0)
    fake_regime = SimpleNamespace(regime_label="RISK_OFF_STRESS")
    fake_cal = SimpleNamespace(
        event_type="earnings",
        event_time=datetime.now(timezone.utc) + timedelta(days=3),
        symbol="NVDA",
        title="NVDA Q3 Earnings",
        impact="High",
    )

    session = _PersistingFakeSession(
        [
            list(reversed(fake_bars)),
            [fake_gex],
            [fake_regime],
            [fake_cal],
            [],  # PaperTrade existing check
            [],  # PaperTrade update on resume
        ]
    )
    checkpointer = InMemorySaver()
    mock_llm = _CapturingCriticMockLLM()

    async with httpx.AsyncClient(transport=httpx.MockTransport(_alpaca_handler)) as http_client:
        alpaca_client = AlpacaClient(settings, http_client=http_client)
        runner = RiskCriticRunner(
            settings,
            session_factory=lambda: session,
            checkpointer=checkpointer,
            alpaca_client=alpaca_client,
            pro_llm=mock_llm,
        )

        # 1. Propose aggressive 200-share order -> must suspend at interrupt() and cap to 1% budget
        propose_res = await runner.propose_trade(
            thread_id="risk-nvda-test-1",
            symbol="NVDA",
            side="buy",
            proposed_qty=200,
            entry_price=150.0,
            stop_loss_price=140.0,
            take_profit_price=170.0,
            rationale="Emotional FOMO dip buy",
        )
        assert propose_res["status"] == "awaiting_approval"
        card = propose_res["approval_card"]
        assert card["risk_sizing"]["max_safe_qty"] == 100
        assert card["risk_sizing"]["recommended_qty"] == 100
        assert card["critique"]["verdict"] == "CAUTION_REDUCED"
        assert len(card["upcoming_catalysts"]) == 1
        # Verify strict context isolation: exactly 2 messages (System + cold Market Facts)
        assert mock_llm.captured_message_counts == [2]

        # 2. Resume attempting to sneak 999 shares -> deterministic node still caps at max_safe_qty (100)!
        resume_res = await runner.resume_trade(
            thread_id="risk-nvda-test-1",
            decision="approve",
            approved_qty=999,
            stop_loss_price=140.0,
            take_profit_price=170.0,
        )
        assert resume_res["status"] == "submitted"
        assert len(submitted_orders) == 1
        order_req = submitted_orders[0]
        assert order_req["symbol"] == "NVDA"
        assert order_req["order_class"] == "bracket"
        assert order_req["qty"] == "100"
        assert order_req["take_profit"] == {"limit_price": "170.00"}
        assert order_req["stop_loss"] == {"stop_price": "140.00"}

        # 3. Propose + Reject path must persist rejected status without touching Alpaca /v2/orders
        reject_session = _PersistingFakeSession(
            [
                list(reversed(fake_bars)),
                [fake_gex],
                [fake_regime],
                [fake_cal],
                [],
                [],
            ]
        )
        reject_runner = RiskCriticRunner(
            settings,
            session_factory=lambda: reject_session,
            checkpointer=checkpointer,
            alpaca_client=alpaca_client,
            pro_llm=mock_llm,
        )
        await reject_runner.propose_trade(
            thread_id="risk-nvda-reject-1",
            symbol="NVDA",
            side="buy",
            proposed_qty=50,
            entry_price=150.0,
            stop_loss_price=140.0,
            take_profit_price=170.0,
        )
        rej_res = await reject_runner.resume_trade(
            thread_id="risk-nvda-reject-1",
            decision="reject",
            note="Earnings too close",
        )
        assert rej_res["status"] == "rejected"
        assert len(submitted_orders) == 1  # Still only the first approved order!


def test_trade_api_admin_guard_and_intent_detector(monkeypatch) -> None:
    intent = detect_trade_intent("NVDA 今天能买吗，我计划买入 200 股", "NVDA")
    assert intent == {"detected": True, "symbol": "NVDA", "side": "buy", "proposed_qty": 200.0}
    assert detect_trade_intent("分析 SPY 当前宏观流动性", "SPY") == {"detected": False}

    test_settings = Settings(
        _env_file=None,
        app_env="production",
        admin_api_token="phase4-admin-secret",
    )
    monkeypatch.setattr("app.api.trade.get_settings", lambda: test_settings)

    app = create_app()
    with TestClient(app) as client:
        app.state.infra.redis = InMemoryFakeRedis()
        app.state.checkpointer = InMemorySaver()
        # Mocking runner.resume_trade cleanly to test 403 admin gate before touching checkpoints
        monkeypatch.setattr(
            RiskCriticRunner,
            "resume_trade",
            AsyncMock(return_value={"status": "submitted", "thread_id": "t-1", "receipt": {}}),
        )

        no_auth = client.post(
            "/api/trade/resume",
            json={"thread_id": "t-1", "decision": "approve", "approved_qty": 10},
        )
        assert no_auth.status_code == 403

        ok_auth = client.post(
            "/api/trade/resume",
            headers={"X-Admin-Token": "phase4-admin-secret"},
            json={"thread_id": "t-1", "decision": "approve", "approved_qty": 10},
        )
        assert ok_auth.status_code == 200
        assert ok_auth.json()["status"] == "submitted"

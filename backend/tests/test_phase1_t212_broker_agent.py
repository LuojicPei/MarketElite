from __future__ import annotations

import asyncio
import base64
import json
from datetime import date, datetime, timezone
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.agents.investigator import InvestigatorAgentRunner
from app.agents.watchdog import EpisodicMemoryRetriever
from app.core.config import Settings
from app.db.models import MarketDailyBar, PaperTrade
from app.db.session import create_db_engine, create_session_factory
from app.main import create_app
from app.services.broker import build_sandbox_state, resolve_broker_config
from app.services.providers.trading212 import Trading212Client, normalize_t212_ticker
from app.services.resilience import PermanentProviderError, TransientProviderError
from tests.test_resilience import InMemoryFakeRedis


class InMemoryFakeRedisWithSetex(InMemoryFakeRedis):
    """Extend test Redis double with setex used by Trading212Client."""

    async def setex(self, key: str, seconds: int, value: Any) -> bool:
        return await self.set(key, value, ex=seconds)


class _FakeExecuteResult:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def scalars(self) -> _FakeExecuteResult:
        return self

    def all(self) -> list[Any]:
        return self._rows

    def scalar_one_or_none(self) -> Any:
        return self._rows[0] if self._rows else None


class _FakeAsyncSession:
    def __init__(self, responses: list[list[Any]]) -> None:
        self._responses = responses
        self._idx = 0
        self.added: list[Any] = []
        self.committed = False

    async def __aenter__(self) -> _FakeAsyncSession:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    async def execute(self, stmt: Any) -> _FakeExecuteResult:
        rows = self._responses[self._idx] if self._idx < len(self._responses) else []
        self._idx += 1
        return _FakeExecuteResult(rows)

    def add(self, obj: Any) -> None:
        self.added.append(obj)

    async def commit(self) -> None:
        self.committed = True

    async def refresh(self, obj: Any) -> None:
        return None


def _make_fake_session_factory(responses_per_enter: list[list[list[Any]]]):
    queue = list(responses_per_enter)

    def _factory() -> _FakeAsyncSession:
        resps = queue.pop(0) if queue else []
        return _FakeAsyncSession(resps)

    return _factory


# ---------------------------------------------------------------------------
# 1. Trading212Client & ticker normalization
# ---------------------------------------------------------------------------


def test_normalize_t212_ticker_variants() -> None:
    assert normalize_t212_ticker("AAPL_US_EQ") == "AAPL"
    assert normalize_t212_ticker("NVDA_US_EQ") == "NVDA"
    assert normalize_t212_ticker("VWRA_LN_EQ", short_name="VWRA") == "VWRA"
    assert normalize_t212_ticker("MSFT") == "MSFT"


def test_trading212_client_summary_positions_history_and_cache() -> None:
    calls: list[str] = []
    auth_headers: list[str] = []
    hosts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        hosts.append(request.url.host)
        auth_headers.append(request.headers.get("Authorization", ""))
        path = request.url.path

        if path.endswith("/equity/account/summary"):
            return httpx.Response(
                200,
                json={
                    "currency": "GBP",
                    "totalValue": 25400.5,
                    "cash": {"availableToTrade": 3200.25, "reservedForOrders": 0.0},
                    "investments": {
                        "currentValue": 22200.25,
                        "totalCost": 19500.0,
                        "unrealizedProfitLoss": 2700.25,
                    },
                },
            )
        if path.endswith("/equity/positions"):
            return httpx.Response(
                200,
                json=[
                    {
                        "instrument": {
                            "ticker": "NVDA_US_EQ",
                            "shortName": "NVDA",
                            "name": "NVIDIA Corp",
                            "currency": "USD",
                        },
                        "quantity": 10.0,
                        "averagePricePaid": 135.0,
                        "currentPrice": 165.0,
                        "walletImpact": {
                            "currency": "GBP",
                            "totalCost": 1050.0,
                            "currentValue": 1280.0,
                            "unrealizedProfitLoss": 230.0,
                        },
                    }
                ],
            )
        if path.endswith("/equity/orders"):
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 987654,
                        "instrument": {"ticker": "AAPL_US_EQ", "shortName": "AAPL"},
                        "side": "BUY",
                        "type": "LIMIT",
                        "quantity": 2.0,
                        "limitPrice": 210.0,
                        "status": "NEW",
                        "createdAt": "2026-11-25T14:00:00Z",
                    }
                ],
            )
        if path.endswith("/equity/history/orders"):
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "order": {
                                "id": 555111,
                                "instrument": {"ticker": "MSFT_US_EQ", "shortName": "MSFT"},
                                "side": "BUY",
                                "type": "MARKET",
                                "status": "FILLED",
                                "filledQuantity": 3.0,
                                "createdAt": "2026-11-20T15:30:00Z",
                            },
                            "fill": {
                                "id": 777222,
                                "quantity": 3.0,
                                "price": 420.5,
                                "filledAt": "2026-11-20T15:30:02Z",
                                "walletImpact": {"currency": "GBP", "netValue": -995.0, "realisedProfitLoss": 0.0},
                            },
                        }
                    ],
                    "nextPagePath": None,
                },
            )
        if path.endswith("/equity/metadata/instruments"):
            return httpx.Response(
                200,
                json=[
                    {"ticker": "NVDA_US_EQ", "shortName": "NVDA", "name": "NVIDIA", "currencyCode": "USD"}
                ],
            )
        return httpx.Response(404, json={"error": "not found"})

    fake_redis = InMemoryFakeRedisWithSetex()
    expected_basic = "Basic " + base64.b64encode(b"key_id_123:secret_xyz").decode("ascii")

    async def _run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
            client = Trading212Client(
                api_key="key_id_123",
                api_secret="secret_xyz",
                env="demo",
                redis_client=fake_redis,
                http_client=http_client,
            )
            summary = await client.get_account_summary()
            # Second call hits Redis cache instead of issuing a second HTTP request
            summary_cached = await client.get_account_summary()
            summary_calls_before_probe = calls.count("/api/v0/equity/account/summary")
            positions = await client.get_positions()
            orders = await client.get_orders()
            history = await client.get_historical_orders()
            probe = await client.test_connection()

        assert summary["equity"] == pytest.approx(25400.5)
        assert summary["cash"] == pytest.approx(3200.25)
        assert summary["currency"] == "GBP"
        assert summary_cached["equity"] == pytest.approx(25400.5)
        assert summary_calls_before_probe == 1
        assert all(h == "demo.trading212.com" for h in hosts)
        assert all(a == expected_basic for a in auth_headers)

        assert len(positions) == 1
        assert positions[0]["symbol"] == "NVDA"
        assert float(positions[0]["qty"]) == pytest.approx(10.0)

        assert len(orders) == 1
        assert orders[0]["symbol"] == "AAPL"

        assert len(history) == 1
        assert history[0]["symbol"] == "MSFT"

        assert probe["ok"] is True
        assert probe["currency"] == "GBP"
        assert probe["positions_count"] == 1

    asyncio.run(_run())


def test_trading212_client_error_classification_401_and_429() -> None:
    def handler_401(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"errorMessage": "Invalid API credentials"})

    def handler_429(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"Retry-After": "12"}, json={"errorMessage": "Rate limit exceeded"})

    async def _run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler_401)) as c401:
            client_401 = Trading212Client(api_key="bad", api_secret="bad", env="live", http_client=c401)
            with pytest.raises(PermanentProviderError):
                await client_401.get_account_summary()

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler_429)) as c429:
            client_429 = Trading212Client(api_key="k", api_secret="s", env="live", http_client=c429)
            with pytest.raises(TransientProviderError):
                await client_429.get_account_summary()

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# 2. Broker Config & Local 24/7 Sandbox Mark-to-Market
# ---------------------------------------------------------------------------


def test_resolve_broker_config_headers_override_settings() -> None:
    settings = Settings(
        _env_file=None,
        broker_provider="sandbox",
        trading212_api_key="env_key",
        trading212_api_secret="env_secret",
        trading212_env="live",
        trading212_read_only=True,
    )
    cfg_default = resolve_broker_config(settings, {})
    assert cfg_default.provider == "sandbox"
    assert cfg_default.t212_api_key == "env_key"
    assert cfg_default.t212_read_only is True

    empty_settings = Settings(
        _env_file=None,
        broker_provider="sandbox",
        trading212_api_key="",
        trading212_api_secret="",
        trading212_env="live",
        trading212_read_only=True,
    )
    cfg_header = resolve_broker_config(
        empty_settings,
        {
            "X-Broker-Provider": "trading212",
            "X-T212-Api-Key": "t212_api_k",
            "X-T212-Api-Secret": "t212_api_s",
            "X-T212-Env": "demo",
        },
    )
    assert cfg_header.provider == "trading212"
    assert cfg_header.t212_api_key == "t212_api_k"
    assert cfg_header.t212_api_secret == "t212_api_s"
    assert cfg_header.t212_env == "demo"
    assert cfg_header.t212_read_only is True


def test_build_sandbox_state_computes_mark_to_market() -> None:
    filled_buy = PaperTrade(
        id=1,
        thread_id="t-sandbox-1",
        symbol="NVDA",
        side="buy",
        qty=10.0,
        entry_price=150.0,
        stop_loss_price=135.0,
        take_profit_price=185.0,
        risk_budget_pct=0.75,
        status="filled",
        alpaca_order_id="sandbox:NVDA:1",
        regime_at_entry="RISK_ON",
        rationale_summary="AI infrastructure capex demand",
        created_at=datetime(2026, 11, 20, 14, 0, tzinfo=timezone.utc),
    )
    latest_bar = MarketDailyBar(
        symbol="NVDA",
        asset_class="equity",
        source="alpaca_sip_1d",
        trade_date=date(2026, 11, 24),
        open=162.0,
        high=166.0,
        low=161.0,
        close=165.0,
        volume=42_000_000.0,
    )

    session_factory = _make_fake_session_factory([[[filled_buy], [latest_bar]]])

    async def _run() -> None:
        account, positions, orders = await build_sandbox_state(session_factory)
        assert float(account["cash"]) == pytest.approx(98500.0)
        assert float(account["equity"]) == pytest.approx(100150.0)
        assert len(positions) == 1
        assert positions[0]["symbol"] == "NVDA"
        assert float(positions[0]["qty"]) == pytest.approx(10.0)
        assert float(positions[0]["current_price"]) == pytest.approx(165.0)
        assert float(positions[0]["unrealized_pl"]) == pytest.approx(150.0)
        assert len(orders) == 1

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# 3. Investigator SSE tool_trace + memory_hit & Thread Persistence
# ---------------------------------------------------------------------------


def test_investigator_stream_emits_stage_memory_hit_and_tool_trace(monkeypatch) -> None:
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, AIMessageChunk
    from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
    from langchain_core.tools import tool as lc_tool

    @lc_tool
    async def get_watchlist_matrix() -> str:
        """Return watchlist snapshot for testing."""
        return json.dumps({"symbols": ["NVDA", "AAPL"], "note": "NVDA leading momentum"})

    monkeypatch.setattr(
        EpisodicMemoryRetriever,
        "recall",
        AsyncMock(
            return_value=[
                {
                    "id": 42,
                    "symbol": "NVDA",
                    "regime_label": "RISK_ON",
                    "quadrant_outcome": "GOOD_PROCESS_GOOD_OUTCOME",
                    "title": "NVDA BUY [优质执行与盈利]",
                    "lesson_text": "Respect earnings IV crush before adding full size.",
                    "similarity": 0.91,
                }
            ]
        ),
    )

    class _ScriptedToolChatModel(BaseChatModel):
        calls: list[int] = []

        @property
        def _llm_type(self) -> str:
            return "scripted-fake"

        def bind_tools(self, tools: Any, **kwargs: Any) -> _ScriptedToolChatModel:
            return self

        def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
            idx = len(self.calls)
            self.calls.append(idx)
            if idx == 0:
                msg = AIMessage(
                    content="",
                    tool_calls=[
                        {"name": "get_watchlist_matrix", "args": {}, "id": "call_wl_1", "type": "tool_call"}
                    ],
                )
            else:
                msg = AIMessage(content="NVDA 当前处于动能扩张期，参考历史记忆需防范财报后隐波回落。")
            return ChatResult(generations=[ChatGeneration(message=msg)])

        async def _agenerate(
            self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any
        ) -> ChatResult:
            return self._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

        async def _astream(
            self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any
        ):
            res = self._generate(messages, stop=stop, run_manager=run_manager, **kwargs)
            msg = res.generations[0].message
            if getattr(msg, "tool_calls", None):
                chunk = AIMessageChunk(
                    content="",
                    tool_call_chunks=[
                        {"name": "get_watchlist_matrix", "args": "{}", "id": "call_wl_1", "index": 0}
                    ],
                )
            else:
                chunk = AIMessageChunk(content=str(msg.content))
            if run_manager:
                await run_manager.on_llm_new_token(chunk.content, chunk=ChatGenerationChunk(message=chunk))
            yield ChatGenerationChunk(message=chunk)

    fake_llm = _ScriptedToolChatModel()
    monkeypatch.setattr("app.agents.investigator.build_pro_llm", lambda *args, **kwargs: fake_llm)
    monkeypatch.setattr("app.agents.investigator.build_fast_llm", lambda *args, **kwargs: fake_llm)

    runner = InvestigatorAgentRunner(
        settings=Settings(_env_file=None, llm_pro_api_key="sk-test-dummy", llm_fast_api_key="sk-test-dummy"),
        session_factory=_make_fake_session_factory([[], []]),
        tools=[get_watchlist_matrix],
    )

    events: list[dict[str, Any]] = []

    async def _collect() -> None:
        async for ev in runner.investigate_stream(query="分析 NVDA 与自选股强弱", symbol="NVDA"):
            events.append(ev)

    asyncio.run(_collect())

    event_types = [e["event"] for e in events]
    assert "status" in event_types
    assert any(e["event"] == "status" and "stage" in e["data"] for e in events)
    assert "memory_hit" in event_types
    assert "tool_trace" in event_types
    trace_events = [e for e in events if e["event"] == "tool_trace"]
    assert any(
        e["data"].get("status") == "ok"
        and e["data"].get("tool") == "get_watchlist_matrix"
        and "NVDA" in str(e["data"].get("output", ""))
        for e in trace_events
    ), f"trace_events={trace_events}"
    assert "token" in event_types
    done_ev = [e for e in events if e["event"] == "done"][-1]
    assert any(
        (t == "get_watchlist_matrix" or (isinstance(t, dict) and t.get("tool") == "get_watchlist_matrix"))
        for t in done_ev["data"]["tools_used"]
    )
    assert len(done_ev["data"]["memory_hits"]) == 1


# ---------------------------------------------------------------------------
# 4. API Routes: Trading212 Test, Sandbox HITL Propose -> Resume -> Close, Agent Threads
# ---------------------------------------------------------------------------


def test_api_trading212_test_sandbox_hitl_and_agent_threads(monkeypatch) -> None:
    app = create_app()
    fake_redis = InMemoryFakeRedisWithSetex()
    created_thread_id: str | None = None

    with TestClient(app) as client:
        app.state.infra.redis = fake_redis

        # A. Empty T212 credentials validation (before mocking test_connection)
        bad_resp = client.post(
            "/api/trade/trading212/test",
            json={"api_key": "", "api_secret": "", "env": "live"},
        )
        assert bad_resp.status_code in (400, 422, 502)

        monkeypatch.setattr(
            Trading212Client,
            "test_connection",
            AsyncMock(
                return_value={
                    "ok": True,
                    "env": "live",
                    "currency": "GBP",
                    "equity": 12500.0,
                    "cash": 2100.0,
                    "positions_count": 3,
                    "pending_orders_count": 1,
                    "message": "Trading212 LIVE connection verified (GBP 12,500.00)",
                }
            ),
        )

        # B. Verified T212 probe with credentials in body (save-free test)
        ok_resp = client.post(
            "/api/trade/trading212/test",
            json={"api_key": "t212_k", "api_secret": "t212_s", "env": "live"},
        )
        assert ok_resp.status_code == 200
        ok_body = ok_resp.json()
        assert ok_body["ok"] is True
        assert ok_body["currency"] == "GBP"

        # C. Sandbox ledger works offline 24/7
        ledger_resp = client.get("/api/trade/ledger", headers={"X-Broker-Provider": "sandbox"})
        assert ledger_resp.status_code == 200
        ledger = ledger_resp.json()
        assert (ledger.get("broker_provider") or ledger.get("provider") or ledger.get("broker")) in ("sandbox", "local_sandbox"), f"ledger keys={list(ledger.keys())}"
        assert "account" in ledger and "equity" in ledger["account"]

        try:
            # D. Sandbox HITL propose -> approve -> filled -> position close
            propose_resp = client.post(
                "/api/trade/propose",
                headers={"X-Broker-Provider": "sandbox"},
                json={
                    "symbol": "NVDA",
                    "side": "buy",
                    "proposed_qty": 1,
                    "entry_price": 160.0,
                    "stop_loss_price": 144.0,
                    "take_profit_price": 190.0,
                    "risk_budget_pct": 1.0,
                    "rationale": "Phase 1 sandbox E2E test order",
                },
            )
            assert propose_resp.status_code == 200, propose_resp.text
            proposal = propose_resp.json()
            assert proposal["status"] == "awaiting_approval"
            created_thread_id = proposal["thread_id"]

            resume_resp = client.post(
                "/api/trade/resume",
                headers={"X-Broker-Provider": "sandbox"},
                json={"thread_id": created_thread_id, "decision": "approve", "note": "Approved in pytest"},
            )
            assert resume_resp.status_code == 200, resume_resp.text
            resumed = resume_resp.json()
            assert resumed["status"] == "filled", f"resumed={resumed}"
            assert resumed["receipt"]["execution_mode"] == "local_sandbox"
            assert str(resumed["receipt"]["alpaca_order"]["id"]).startswith("sbx-")

            # Verify Trading212 read-only mode refuses remote close cleanly with 400
            t212_close = client.post(
                "/api/trade/positions/NVDA/close",
                headers={
                    "X-Broker-Provider": "trading212",
                    "X-T212-Api-Key": "k",
                    "X-T212-Api-Secret": "s",
                },
            )
            assert t212_close.status_code == 400

            # Close NVDA sandbox position
            sb_close = client.post(
                "/api/trade/positions/NVDA/close",
                headers={"X-Broker-Provider": "sandbox"},
            )
            assert sb_close.status_code == 200, sb_close.text
            assert sb_close.json()["status"] == "closed"

            # E. Agent threads listing and 404 handling
            threads_resp = client.get("/api/agent/threads")
            assert threads_resp.status_code == 200
            assert "threads" in threads_resp.json()

            missing_resp = client.get("/api/agent/threads/nonexistent_phase1_thread")
            assert missing_resp.status_code == 404
        finally:
            if created_thread_id:
                async def _cleanup() -> None:
                    engine = create_db_engine()
                    factory = create_session_factory(engine)
                    try:
                        async with factory() as s:
                            await s.execute(
                                delete(PaperTrade).where(PaperTrade.thread_id == created_thread_id)
                            )
                            await s.execute(
                                delete(PaperTrade).where(
                                    PaperTrade.rationale_summary == "Phase 1 sandbox E2E test order"
                                )
                            )
                            await s.commit()
                    finally:
                        await engine.dispose()

                asyncio.run(_cleanup())

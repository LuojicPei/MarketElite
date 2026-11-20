from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.tools import StructuredTool

from app.agents.investigator import InvestigatorAgentRunner, compute_tool_fingerprint
from app.core.config import Settings
from app.main import create_app
from app.mcp_servers.market_server import list_read_only_tools_metadata
from app.rag.hybrid_search import reciprocal_rank_fusion
from app.rag.sec_edgar import split_sec_filing_into_chunks
from app.services.llm_router import estimate_text_tokens, trim_messages_to_budget
from tests.test_market_api import _FakeSession
from tests.test_resilience import InMemoryFakeRedis


def test_sec_filing_html_chunker_detects_items_and_bounds_tokens() -> None:
    sample_html = """
    <html><head><script>console.log('noise')</script></head><body>
    <ix:header>Hidden XBRL metadata</ix:header>
    <div>Item 1A. Risk Factors</div>
    <p>""" + ("Export controls and supply chain bottlenecks could affect gross margin. " * 25) + """</p>
    <div>Item 7. Management's Discussion and Analysis</div>
    <p>""" + ("Data center revenue grew 94 percent year over year on strong AI accelerator demand. " * 25) + """</p>
    </body></html>
    """
    chunks = split_sec_filing_into_chunks(sample_html, max_tokens=220, overlap_tokens=30)
    assert len(chunks) >= 2
    sections = {c.section_title for c in chunks}
    assert any("Item 1A" in s for s in sections)
    assert any("Item 7" in s for s in sections)
    assert all("Hidden XBRL" not in c.content for c in chunks)
    assert all(c.token_estimate <= 260 for c in chunks)


def test_hybrid_rrf_fuses_vector_and_bm25_with_diversity() -> None:
    vec = [
        {"chunk_id": 10, "symbol": "NVDA", "form_type": "10-K", "filing_date": "2026-02-25", "section_title": "Item 1A. Risk Factors", "chunk_index": 0, "content": "Risk A"},
        {"chunk_id": 11, "symbol": "NVDA", "form_type": "10-K", "filing_date": "2026-02-25", "section_title": "Item 1A. Risk Factors", "chunk_index": 1, "content": "Risk B"},
        {"chunk_id": 12, "symbol": "NVDA", "form_type": "10-K", "filing_date": "2026-02-25", "section_title": "Item 1A. Risk Factors", "chunk_index": 2, "content": "Risk C"},
    ]
    lex = [
        {"chunk_id": 12, "symbol": "NVDA", "form_type": "10-K", "filing_date": "2026-02-25", "section_title": "Item 1A. Risk Factors", "chunk_index": 2, "content": "Risk C"},
        {"chunk_id": 20, "symbol": "NVDA", "form_type": "10-K", "filing_date": "2026-02-25", "section_title": "Item 7. Management's Discussion & Analysis", "chunk_index": 5, "content": "Revenue Drivers"},
    ]
    fused = reciprocal_rank_fusion(vec, lex, top_k=3, query="revenue risk")
    assert len(fused) == 3
    # Diversity capping allows at most 2 from Item 1A before promoting Item 7
    sections = [c.section_title for c in fused]
    assert "Item 7. Management's Discussion & Analysis" in sections


def test_context_budget_hard_trim_preserves_system_and_latest() -> None:
    sys_msg = SystemMessage(content="Core Regime Anchor")
    msgs = [sys_msg] + [
        HumanMessage(content=f"Turn {i}: " + ("market volatility analysis " * 30))
        for i in range(10)
    ]
    trimmed = trim_messages_to_budget(msgs, max_tokens=600)
    assert isinstance(trimmed[0], SystemMessage)
    assert "Turn 9" in str(trimmed[-1].content)
    assert len(trimmed) < len(msgs)
    total_tokens = sum(estimate_text_tokens(str(m.content)) for m in trimmed)
    assert total_tokens < 900


async def test_mcp_tools_are_strictly_read_only() -> None:
    tools = await list_read_only_tools_metadata()
    names = {t["name"] for t in tools}
    assert names == {
        "get_market_regime_snapshot",
        "get_asset_structure",
        "get_macro_and_earnings_calendar",
        "get_sec_filings_context",
    }
    forbidden_terms = ("order", "trade", "buy", "sell", "execute", "submit")
    for name in names:
        assert not any(term in name.lower() for term in forbidden_terms)


class _LoopingMockLLM:
    """Mock ChatModel triggering duplicate tool calls, failing tool calls, then forced synthesis."""

    def __init__(self) -> None:
        self.invocations = 0

    def bind_tools(self, tools: Any) -> _LoopingMockLLM:
        return self

    async def ainvoke(self, messages: list[Any]) -> AIMessage:
        self.invocations += 1
        sys_text = str(messages[0].content) if messages else ""
        if "[Guardrail Active:" in sys_text:
            return AIMessage(content="Synthesized fallback report grounded in SPY 736.33 observation.")

        if self.invocations == 1:
            return AIMessage(
                content="",
                tool_calls=[{"id": "c1", "name": "mock_asset", "args": {"symbol": "SPY"}}],
            )
        if self.invocations == 2:
            # Duplicate identical fingerprint -> Deadlock Guard must intercept!
            return AIMessage(
                content="",
                tool_calls=[{"id": "c2", "name": "mock_asset", "args": {"symbol": "SPY"}}],
            )
        return AIMessage(
            content="",
            tool_calls=[{"id": "c3", "name": "mock_failing_tool", "args": {"symbol": "SPY"}}],
        )


async def test_investigator_deadlock_guard_self_heal_and_force_synthesize(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.agents.investigator.get_market_regime_snapshot",
        AsyncMock(return_value="Regime Date: 2026-11-19 | Label: HIGH_VOL_TRANSITION"),
    )
    call_counter = 0

    async def _mock_asset(symbol: str) -> str:
        nonlocal call_counter
        call_counter += 1
        return f"{symbol} close=736.33, RVOL=1.03x"

    async def _mock_fail(symbol: str) -> str:
        raise ValueError(f"Simulated upstream glitch for {symbol}")

    tools = [
        StructuredTool.from_function(coroutine=_mock_asset, name="mock_asset", description="Read SPY"),
        StructuredTool.from_function(
            coroutine=_mock_fail, name="mock_failing_tool", description="Fail safely"
        ),
    ]
    settings = Settings(_env_file=None, agent_max_steps=3, agent_wall_timeout_seconds=10)
    runner = InvestigatorAgentRunner(
        settings,
        session_factory=lambda: _FakeSession([]),
        tools=tools,
        pro_llm=_LoopingMockLLM(),
        fast_llm=None,
    )

    events: list[dict[str, Any]] = []
    # Also ensure regime context works with zero network by patching inside state if needed
    async for ev in runner.investigate_stream(query="Analyze SPY structure", symbol="SPY"):
        events.append(ev)

    assert call_counter == 1  # Duplicate SPY call blocked cleanly by SHA-256 fingerprint guard!
    assert compute_tool_fingerprint("mock_asset", {"symbol": "SPY"}) == compute_tool_fingerprint(
        "mock_asset", {"symbol": "SPY"}
    )
    done_events = [e for e in events if e["event"] == "done"]
    assert len(done_events) == 1
    done_data = done_events[0]["data"]
    assert "Synthesized fallback report" in done_data["answer"]
    statuses = [t["status"] for t in done_data["tools_used"]]
    assert "ok" in statuses
    assert "blocked_duplicate" in statuses
    assert "error" in statuses


def test_agent_status_and_reentry_lock_409(monkeypatch) -> None:
    test_settings = Settings(_env_file=None, llm_pro_api_key="", llm_fast_api_key="")
    monkeypatch.setattr("app.api.agent.get_settings", lambda: test_settings)

    app = create_app()
    fake_redis = InMemoryFakeRedis()

    with TestClient(app) as client:
        app.state.infra.redis = fake_redis
        app.state.session_factory = lambda: _FakeSession([[SimpleNamespace()]])

        # Override count scalar cleanly using custom fake scalar
        class _CountResult:
            def scalar_one(self) -> int:
                return 2

        class _CountSession:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

            async def execute(self, stmt):
                return _CountResult()

        app.state.session_factory = lambda: _CountSession()

        status_resp = client.get("/api/agent/status")
        assert status_resp.status_code == 200
        s_body = status_resp.json()
        assert s_body["status"] == "llm_key_required"
        assert len(s_body["mcp_tools"]) == 4
        assert s_body["sec_cached_filings"] == 2

        # Hold thread lock manually -> concurrent request must receive 409 Conflict
        fake_redis._store["lock:run:thread-xyz"] = ("1", None)
        conflict_resp = client.post(
            "/api/agent/investigate",
            json={"thread_id": "thread-xyz", "query": "Check NVDA"},
        )
        assert conflict_resp.status_code == 409

        # Released thread without LLM key -> clean 503 with helpful hint (and lock released)
        fake_redis._store.pop("lock:run:thread-xyz", None)
        no_key_resp = client.post(
            "/api/agent/investigate",
            json={"thread_id": "thread-free", "query": "Check NVDA"},
        )
        assert no_key_resp.status_code == 503
        assert "lock:run:thread-free" not in fake_redis._store

        # Production mode hides localhost Phoenix URL from public clients
        prod_settings = Settings(
            _env_file=None,
            app_env="production",
            phoenix_ui_url="http://localhost:6007",
        )
        monkeypatch.setattr("app.api.agent.get_settings", lambda: prod_settings)
        prod_status = client.get("/api/agent/status")
        assert prod_status.status_code == 200
        assert prod_status.json()["phoenix_ui_url"] is None

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from app.agents.watchdog import EpisodicMemoryRetriever, reflect_portfolio_postmortem
from app.core.config import Settings
from app.db.models import EpisodicMemory, PaperTrade, WatchdogAlert
from app.main import create_app
from app.services.autopilot import WatchdogAutopilotManager
from tests.test_phase5_watchdog_memory_eval import _StatefulFakeSession


async def test_episodic_memory_retriever_prioritizes_pinned_rules_and_formats_iron_prefix() -> None:
    unpinned = EpisodicMemory(
        id=1,
        paper_trade_id=10,
        symbol="NVDA",
        regime_label="RISK_OFF_STRESS",
        quadrant_outcome="BAD_PROCESS_BAD_OUTCOME",
        title="Ordinary Lesson",
        lesson_text="Avoid chasing breakout on weak breadth.",
        tags_json=["NVDA"],
        alpha_vs_spy_pct=-2.1,
        is_pinned=False,
        is_active=True,
        created_at=datetime.now(timezone.utc),
    )
    pinned = EpisodicMemory(
        id=2,
        paper_trade_id=None,
        symbol="ALL",
        regime_label="RISK_OFF_STRESS",
        quadrant_outcome="IRON_RULE",
        title="Iron Defense Rule",
        lesson_text="Hard cap risk budget at 0.5% during stress regimes.",
        tags_json=["ALL", "PLAYBOOK"],
        alpha_vs_spy_pct=None,
        is_pinned=True,
        is_active=True,
        created_at=datetime.now(timezone.utc) - timedelta(days=5),
    )

    retriever = EpisodicMemoryRetriever(
        Settings(llm_api_key=None),
        lambda: _StatefulFakeSession([[(unpinned, 0.2)], [], [unpinned, pinned]]),
    )
    recalled = await retriever.recall(
        "",
        symbol="NVDA",
        regime_label="RISK_OFF_STRESS",
        top_k=4,
    )

    assert len(recalled) == 2
    assert recalled[0]["id"] == 2
    assert recalled[0]["is_pinned"] is True
    assert recalled[0]["is_active"] is True
    assert recalled[0]["score"] > recalled[1]["score"]

    formatted = EpisodicMemoryRetriever.format_memories_for_prompt(recalled)
    assert "[PINNED IRON RULE]" in formatted
    assert "Iron Defense Rule" in formatted


async def test_watchdog_autopilot_manager_lifecycle_configure_and_auto_reflect(monkeypatch: Any) -> None:
    scan_mock = AsyncMock(return_value={"scanned_symbols": 6, "alerts_upserted": 2})
    reflect_mock = AsyncMock(return_value={"quadrant": "GOOD_PROCESS_GOOD_OUTCOME"})
    monkeypatch.setattr("app.services.autopilot.run_watchdog_scan", scan_mock)
    monkeypatch.setattr("app.services.autopilot.reflect_on_trade", reflect_mock)

    closed_trade_unreviewed = PaperTrade(
        id=88,
        symbol="AAPL",
        side="buy",
        qty=5.0,
        entry_price=220.0,
        status="closed",
        realized_pnl=45.0,
        closed_at=datetime.now(timezone.utc),
        created_at=datetime.now(timezone.utc) - timedelta(days=2),
    )
    closed_trade_already_reviewed = PaperTrade(
        id=77,
        symbol="MSFT",
        side="buy",
        qty=4.0,
        entry_price=410.0,
        status="closed",
        realized_pnl=20.0,
        closed_at=datetime.now(timezone.utc) - timedelta(days=1),
        created_at=datetime.now(timezone.utc) - timedelta(days=3),
    )
    fake_session = _StatefulFakeSession(
        [[(77,)], [closed_trade_unreviewed, closed_trade_already_reviewed]]
    )

    mgr = WatchdogAutopilotManager(
        lambda: fake_session,
        Settings(),
        enabled=True,
        interval_seconds=900,
        run_24_7=True,
    )
    init_status = mgr.status()
    assert init_status["status"] == "online"
    assert init_status["interval_seconds"] == 900
    assert init_status["run_24_7"] is True
    assert init_status["seconds_to_next_run"] is not None

    paused = mgr.configure(enabled=False, interval_seconds=300, run_24_7=False)
    assert paused["status"] == "paused"
    assert paused["interval_seconds"] == 300
    assert paused["run_24_7"] is False
    assert paused["next_run_at"] is None

    mgr.configure(enabled=True, interval_seconds=300, run_24_7=True)
    summary = await mgr.run_once(trigger="manual")

    assert summary["ok"] is True
    assert summary["trigger"] == "manual"
    assert summary["scanned_symbols"] == 6
    assert summary["alerts_upserted"] == 2
    assert summary["reflected_count"] == 1
    reflect_mock.assert_awaited_once()
    assert reflect_mock.await_args.args[2] == 88
    assert mgr.status()["run_count"] == 1

    mgr.start()
    await asyncio.sleep(0.05)
    await mgr.stop()
    assert mgr._task is None


async def test_reflect_portfolio_postmortem_deterministic_diagnosis() -> None:
    t1 = PaperTrade(
        id=1,
        symbol="NVDA",
        side="buy",
        qty=10.0,
        entry_price=140.0,
        stop_loss_price=None,
        take_profit_price=160.0,
        risk_budget_pct=1.4,
        realized_pnl=-180.0,
        spy_benchmark_return_pct=0.8,
        regime_at_entry="RISK_OFF_STRESS",
        status="closed",
        created_at=datetime.now(timezone.utc) - timedelta(days=2),
    )
    t2 = PaperTrade(
        id=2,
        symbol="AAPL",
        side="buy",
        qty=8.0,
        entry_price=215.0,
        stop_loss_price=208.0,
        take_profit_price=235.0,
        risk_budget_pct=0.8,
        realized_pnl=240.0,
        spy_benchmark_return_pct=0.5,
        regime_at_entry="GOLDILOCKS_EXPANSION",
        status="closed",
        created_at=datetime.now(timezone.utc) - timedelta(days=1),
    )
    open_t3 = PaperTrade(
        id=3,
        symbol="MSFT",
        side="buy",
        qty=5.0,
        entry_price=420.0,
        stop_loss_price=405.0,
        take_profit_price=450.0,
        risk_budget_pct=1.0,
        status="filled",
        created_at=datetime.now(timezone.utc),
    )
    alert = WatchdogAlert(
        id=11,
        alert_key="watchdog-nvda-gex",
        alert_type="NEGATIVE_GEX_SPIKE",
        severity="high",
        symbol="NVDA",
        title="NVDA Negative GEX Flip",
        summary_markdown="Negative dealer gamma below 170.",
        regime_label="RISK_OFF_STRESS",
        acknowledged=False,
        created_at=datetime.now(timezone.utc),
    )
    pinned = EpisodicMemory(
        id=5,
        paper_trade_id=None,
        symbol="ALL",
        regime_label="RISK_OFF_STRESS",
        quadrant_outcome="IRON_RULE",
        title="Existing Iron Rule",
        lesson_text="Halve budget under stress.",
        tags_json=["ALL"],
        is_pinned=True,
        is_active=True,
        created_at=datetime.now(timezone.utc),
    )
    session = _StatefulFakeSession([[t1, t2, open_t3], [alert], [pinned]])

    report = await reflect_portfolio_postmortem(
        lambda: session,
        Settings(llm_api_key=None),
        use_fast_llm=False,
        lookback_limit=30,
    )

    assert report["status"] == "ok"
    assert report["mode"] == "deterministic_coach"
    assert report["closed_trades_analyzed"] == 2
    assert report["total_net_pnl"] == 60.0
    assert report["active_pinned_rules"] == 1
    assert len(report["regime_breakdown"]) == 2
    assert any("逆宏观体制做多失分" in p for p in report["failure_patterns"])
    assert any("风控边界执行缺口" in p for p in report["failure_patterns"])
    assert len(report["recommended_rules"]) >= 2
    assert "AI 周期组合诊断报告" in report["summary_markdown"]


def test_autopilot_postmortem_and_playbook_crud_routes(monkeypatch: Any) -> None:
    app = create_app()
    created_id: int | None = None

    with TestClient(app) as client:
        monkeypatch.setattr(
            app.state.autopilot,
            "run_once",
            AsyncMock(
                return_value={
                    "ok": True,
                    "trigger": "manual",
                    "ran_at": datetime.now(timezone.utc).isoformat(),
                    "scanned_symbols": 4,
                    "alerts_upserted": 1,
                    "reflected_count": 0,
                    "duration_ms": 12,
                    "error": None,
                }
            ),
        )

        st_resp = client.get("/api/watchdog/autopilot/status")
        assert st_resp.status_code == 200
        orig_interval = st_resp.json()["interval_seconds"]

        cfg_resp = client.post(
            "/api/watchdog/autopilot/config",
            json={"enabled": True, "interval_seconds": 300, "run_24_7": True},
        )
        assert cfg_resp.status_code == 200
        assert cfg_resp.json()["interval_seconds"] == 300
        assert cfg_resp.json()["enabled"] is True

        run_resp = client.post("/api/watchdog/autopilot/run-now")
        assert run_resp.status_code == 200
        assert run_resp.json()["last_run"]["alerts_upserted"] == 1

        # Restore original interval
        client.post(
            "/api/watchdog/autopilot/config",
            json={"interval_seconds": orig_interval},
        )

        pm_resp = client.post(
            "/api/reviews/portfolio-postmortem",
            json={"use_fast_llm": False, "lookback_limit": 20},
        )
        assert pm_resp.status_code == 200
        pm_data = pm_resp.json()
        assert pm_data["status"] == "ok"
        assert "recommended_rules" in pm_data

        try:
            create_resp = client.post(
                "/api/memories/playbook",
                json={
                    "symbol": "NVDA",
                    "regime_label": "RISK_OFF_STRESS",
                    "quadrant_outcome": "IRON_RULE",
                    "title": "__TEST_PHASE3_RULE__",
                    "lesson_text": "Never chase negative GEX spikes without ATR stop.",
                    "is_pinned": True,
                    "is_active": True,
                },
            )
            assert create_resp.status_code == 200
            created = create_resp.json()["memory"]
            created_id = int(created["id"])
            assert created["is_pinned"] is True
            assert created["is_active"] is True

            patch_resp = client.patch(
                f"/api/memories/playbook/{created_id}",
                json={"is_pinned": False, "is_active": False, "title": "__TEST_PHASE3_RULE_EDITED__"},
            )
            assert patch_resp.status_code == 200
            patched = patch_resp.json()["memory"]
            assert patched["is_pinned"] is False
            assert patched["is_active"] is False
            assert patched["title"] == "__TEST_PHASE3_RULE_EDITED__"

            rev_resp = client.get("/api/reviews?limit=30")
            assert rev_resp.status_code == 200
            matching = [m for m in rev_resp.json()["memories"] if m["id"] == created_id]
            assert len(matching) == 1
            assert matching[0]["is_pinned"] is False
            assert matching[0]["is_active"] is False
        finally:
            if created_id is not None:
                del_resp = client.delete(f"/api/memories/playbook/{created_id}")
                assert del_resp.status_code == 200
                assert del_resp.json()["deleted_id"] == created_id


def test_propose_trade_batch_validation_and_partial_queue(monkeypatch: Any) -> None:
    app = create_app()

    async def _fake_propose(
        self: Any,
        *,
        thread_id: str,
        symbol: str,
        side: str,
        proposed_qty: float,
        entry_price: float | None = None,
        risk_budget_pct: float = 1.0,
        rationale: str = "",
        **kwargs: Any,
    ) -> dict[str, Any]:
        if symbol == "BADSYM":
            raise ValueError("Missing market facts for BADSYM")
        return {
            "thread_id": thread_id,
            "trade_id": 501 if symbol == "NVDA" else 502,
            "approval_card": {
                "risk_sizing": {
                    "recommended_qty": proposed_qty,
                    "stop_loss_price": 150.0,
                    "take_profit_price": 190.0,
                },
                "critique": {"verdict": "APPROVE"},
            },
        }

    monkeypatch.setattr("app.api.trade.RiskCriticRunner.propose_trade", _fake_propose)

    with TestClient(app) as client:
        empty_resp = client.post("/api/trade/propose-batch", json={"items": []})
        assert empty_resp.status_code == 422

        too_many_resp = client.post(
            "/api/trade/propose-batch",
            json={"items": [{"symbol": f"S{i}", "proposed_qty": 1} for i in range(9)]},
        )
        assert too_many_resp.status_code == 422

        batch_resp = client.post(
            "/api/trade/propose-batch",
            json={
                "items": [
                    {"symbol": "nvda", "side": "buy", "proposed_qty": 5, "entry_price": 170.0},
                    {"symbol": "AAPL", "side": "buy", "proposed_qty": 4, "entry_price": 225.0},
                    {"symbol": "badsym", "side": "buy", "proposed_qty": 2},
                ],
                "risk_budget_pct": 1.0,
                "source_label": "UnitTestBatch",
            },
        )
        assert batch_resp.status_code == 200
        body = batch_resp.json()
        assert body["status"] == "ok"
        assert body["queued_count"] == 2
        assert body["failed_count"] == 1
        assert [p["symbol"] for p in body["proposals"]] == ["NVDA", "AAPL"]
        assert body["proposals"][0]["thread_id"].startswith("batch-NVDA-")
        assert body["errors"] == [{"symbol": "BADSYM", "detail": "Missing market facts for BADSYM"}]

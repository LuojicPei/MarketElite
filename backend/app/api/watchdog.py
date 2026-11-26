from __future__ import annotations

import importlib.util
import json
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import desc, select

from app.agents.watchdog import (
    EpisodicMemoryRetriever,
    reflect_on_trade,
    reflect_portfolio_postmortem,
    run_watchdog_scan,
)
from app.core.config import get_settings
from app.core.security import require_admin_token
from app.core.workspace import resolve_workspace_id
from app.db.models import EpisodicMemory, PaperTrade, TradeReview, WatchdogAlert
from app.services.autopilot import WatchdogAutopilotManager
from app.services.llm_router import resolve_llm_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["watchdog-reflection-memory"])


class ReflectRequest(BaseModel):
    horizon: str = Field(default="POST_CLOSE", pattern="^(POST_CLOSE|T\\+5|T\\+20)$")
    use_fast_llm: bool = Field(default=True)


class AutopilotConfigRequest(BaseModel):
    enabled: bool | None = None
    interval_seconds: int | None = Field(default=None, ge=60, le=3600)
    run_24_7: bool | None = None


class PortfolioPostmortemRequest(BaseModel):
    use_fast_llm: bool = Field(default=True)
    lookback_limit: int = Field(default=30, ge=5, le=100)


class PlaybookRuleCreateRequest(BaseModel):
    symbol: str = Field(default="ALL", min_length=1, max_length=24)
    regime_label: str = Field(default="HIGH_VOL_TRANSITION", min_length=2, max_length=48)
    quadrant_outcome: str = Field(default="IRON_RULE", min_length=2, max_length=64)
    title: str = Field(min_length=2, max_length=220)
    lesson_text: str = Field(min_length=4, max_length=2000)
    is_pinned: bool = Field(default=True)
    is_active: bool = Field(default=True)


class PlaybookRulePatchRequest(BaseModel):
    title: str | None = Field(default=None, min_length=2, max_length=220)
    lesson_text: str | None = Field(default=None, min_length=4, max_length=2000)
    regime_label: str | None = Field(default=None, min_length=2, max_length=48)
    is_pinned: bool | None = None
    is_active: bool | None = None


def _get_autopilot(request: Request) -> WatchdogAutopilotManager:
    ap = getattr(request.app.state, "autopilot", None)
    if ap is None:
        ap = WatchdogAutopilotManager(request.app.state.session_factory, get_settings())
        request.app.state.autopilot = ap
    return ap


@router.get("/watchdog/alerts")
async def list_watchdog_alerts(
    request: Request,
    limit: int = Query(default=20, ge=1, le=50),
    unacknowledged_only: bool = Query(default=False),
) -> dict[str, Any]:
    """List persisted intraday anomaly alerts produced by Phase 5 Watchdog."""
    session_factory = request.app.state.session_factory
    ws_id = resolve_workspace_id(request.headers)
    async with session_factory() as session:
        stmt = select(WatchdogAlert).where(WatchdogAlert.workspace_id == ws_id)
        if unacknowledged_only:
            stmt = stmt.where(WatchdogAlert.acknowledged.is_(False))
        stmt = stmt.order_by(desc(WatchdogAlert.created_at)).limit(limit)
        rows = list((await session.execute(stmt)).scalars().all())

    return {
        "count": len(rows),
        "alerts": [
            {
                "id": r.id,
                "alert_key": r.alert_key,
                "alert_type": r.alert_type,
                "severity": r.severity,
                "symbol": r.symbol,
                "title": r.title,
                "summary_markdown": r.summary_markdown,
                "metrics": r.metrics_json,
                "regime_label": r.regime_label,
                "acknowledged": r.acknowledged,
                "created_at": r.created_at.isoformat(),
            }
            for r in rows
        ],
    }


@router.post("/watchdog/scan")
async def trigger_watchdog_scan(
    request: Request,
    use_fast_llm: bool = Query(default=True),
) -> dict[str, Any]:
    """Run immediate Agent 3 Watchdog scan across persisted daily bars, GEX walls & catalysts."""
    try:
        settings, _ = resolve_llm_settings(get_settings(), request.headers)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await run_watchdog_scan(
        request.app.state.session_factory,
        settings,
        use_fast_llm=use_fast_llm,
        workspace_id=resolve_workspace_id(request.headers),
    )


@router.post("/watchdog/alerts/{alert_id}/ack")
async def acknowledge_watchdog_alert(alert_id: int, request: Request) -> dict[str, Any]:
    """Mark a Watchdog alert acknowledged so cockpit operators track reviewed anomalies."""
    ws_id = resolve_workspace_id(request.headers)
    async with request.app.state.session_factory() as session:
        alert = await session.get(WatchdogAlert, alert_id)
        if alert is None or (getattr(alert, "workspace_id", None) or "default") != ws_id:
            raise HTTPException(status_code=404, detail=f"WatchdogAlert id={alert_id} not found")
        alert.acknowledged = True
        await session.commit()
        return {"status": "ok", "id": alert.id, "acknowledged": True}


@router.get("/reviews")
async def list_trade_reviews(
    request: Request,
    limit: int = Query(default=20, ge=1, le=50),
) -> dict[str, Any]:
    """List post-trade 4-quadrant reflections and long-term episodic memories."""
    ws_id = resolve_workspace_id(request.headers)
    async with request.app.state.session_factory() as session:
        rev_stmt = (
            select(TradeReview, PaperTrade.symbol, PaperTrade.side, PaperTrade.realized_pnl)
            .join(PaperTrade, TradeReview.paper_trade_id == PaperTrade.id)
            .where(PaperTrade.workspace_id == ws_id)
            .order_by(desc(TradeReview.created_at))
            .limit(limit)
        )
        review_rows = (await session.execute(rev_stmt)).all()

        mem_stmt = (
            select(EpisodicMemory)
            .where(EpisodicMemory.workspace_id == ws_id)
            .order_by(desc(EpisodicMemory.is_pinned), desc(EpisodicMemory.is_active), desc(EpisodicMemory.created_at))
            .limit(limit)
        )
        mem_rows = list((await session.execute(mem_stmt)).scalars().all())

    return {
        "reviews": [
            {
                "id": rev.id,
                "paper_trade_id": rev.paper_trade_id,
                "symbol": sym,
                "side": side,
                "realized_pnl": pnl,
                "horizon": rev.horizon,
                "quadrant_outcome": rev.quadrant_outcome,
                "alpha_vs_spy_pct": rev.alpha_vs_spy_pct,
                "regime_label": rev.regime_label,
                "lessons_markdown": rev.lessons_markdown,
                "created_at": rev.created_at.isoformat(),
            }
            for rev, sym, side, pnl in review_rows
        ],
        "memories": [
            {
                "id": m.id,
                "paper_trade_id": m.paper_trade_id,
                "symbol": m.symbol,
                "regime_label": m.regime_label,
                "quadrant_outcome": m.quadrant_outcome,
                "title": m.title,
                "lesson_text": m.lesson_text,
                "tags": m.tags_json,
                "alpha_vs_spy_pct": m.alpha_vs_spy_pct,
                "is_pinned": bool(getattr(m, "is_pinned", False)),
                "is_active": bool(getattr(m, "is_active", True)),
                "created_at": m.created_at.isoformat(),
            }
            for m in mem_rows
        ],
    }


@router.post("/reviews/{trade_id}/reflect")
async def reflect_trade_endpoint(
    trade_id: int,
    payload: ReflectRequest,
    request: Request,
) -> dict[str, Any]:
    """Generate 4-quadrant attribution + episodic memory record for a PaperTrade."""
    try:
        settings, _ = resolve_llm_settings(get_settings(), request.headers)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        return await reflect_on_trade(
            request.app.state.session_factory,
            settings,
            trade_id,
            horizon=payload.horizon,
            use_fast_llm=payload.use_fast_llm,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/memories/recall")
async def recall_episodic_memories(
    request: Request,
    query: str = Query(default=""),
    symbol: str | None = Query(default=None),
    regime_label: str | None = Query(default=None),
    top_k: int = Query(default=4, ge=1, le=10),
) -> dict[str, Any]:
    """Query historical trade & regime lessons via BM25 + optional pgvector hybrid search."""
    settings = get_settings()
    ws_id = resolve_workspace_id(request.headers)
    retriever = EpisodicMemoryRetriever(settings, request.app.state.session_factory)
    items = await retriever.recall(
        query, symbol=symbol, regime_label=regime_label, top_k=top_k, workspace_id=ws_id
    )
    return {"count": len(items), "memories": items}


_REPO_ROOT = Path(__file__).resolve().parents[3]
_EVAL_SCRIPT = _REPO_ROOT / "evals" / "run_eval.py"
_EVAL_REPORT = _REPO_ROOT / "evals" / "latest_report.json"


def _run_eval_suite() -> dict[str, Any]:
    if not _EVAL_SCRIPT.exists():
        raise FileNotFoundError(f"Eval runner not found at {_EVAL_SCRIPT}")
    spec = importlib.util.spec_from_file_location("marketelite_eval_runner", _EVAL_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load eval runner module spec")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return dict(module.run_golden_eval(save_report=True))


@router.get("/evals/latest")
async def get_latest_eval_report() -> dict[str, Any]:
    """Return the latest persisted Phase 5 Golden Evaluation report (or compute on demand)."""
    if _EVAL_REPORT.exists():
        try:
            return json.loads(_EVAL_REPORT.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Recomputing eval report after read error: %s", exc)
    try:
        return _run_eval_suite()
    except (FileNotFoundError, RuntimeError) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/evals/run")
async def trigger_eval_suite(
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> dict[str, Any]:
    """Execute the 32-case Phase 5 Golden Benchmark and return pass-rate telemetry."""
    require_admin_token(get_settings(), x_admin_token, action_label="Golden Eval execution")
    try:
        return _run_eval_suite()
    except (FileNotFoundError, RuntimeError) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Phase 3: Watchdog Autopilot Control, Portfolio Post-Mortem & Playbook CRUD
# ---------------------------------------------------------------------------


@router.get("/watchdog/autopilot/status")
async def get_watchdog_autopilot_status(request: Request) -> dict[str, Any]:
    """Report continuous background Watchdog Autopilot state & next scan countdown."""
    return _get_autopilot(request).status()


@router.post("/watchdog/autopilot/config")
async def configure_watchdog_autopilot(
    payload: AutopilotConfigRequest,
    request: Request,
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> dict[str, Any]:
    """Toggle Watchdog Autopilot ON/OFF, interval_seconds, or 24/7 mode."""
    require_admin_token(get_settings(), x_admin_token, action_label="Watchdog Autopilot config")
    ap = _get_autopilot(request)
    return ap.configure(
        enabled=payload.enabled,
        interval_seconds=payload.interval_seconds,
        run_24_7=payload.run_24_7,
    )


@router.post("/watchdog/autopilot/run-now")
async def run_watchdog_autopilot_now(
    request: Request,
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> dict[str, Any]:
    """Trigger immediate Autopilot sweep (Watchdog anomalies + auto-reflection on closed trades)."""
    require_admin_token(get_settings(), x_admin_token, action_label="Watchdog Autopilot trigger")
    ap = _get_autopilot(request)
    run_summary = await ap.run_once(trigger="manual")
    return {**ap.status(), "last_run": run_summary}


@router.post("/reviews/portfolio-postmortem")
async def run_portfolio_postmortem_endpoint(
    payload: PortfolioPostmortemRequest,
    request: Request,
) -> dict[str, Any]:
    """Synthesize multi-trade macro regime attribution & candidate Playbook Iron Rules."""
    try:
        settings, _ = resolve_llm_settings(get_settings(), request.headers)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await reflect_portfolio_postmortem(
        request.app.state.session_factory,
        settings,
        use_fast_llm=payload.use_fast_llm,
        lookback_limit=payload.lookback_limit,
        workspace_id=resolve_workspace_id(request.headers),
    )


@router.post("/memories/playbook")
async def create_playbook_rule(
    payload: PlaybookRuleCreateRequest,
    request: Request,
) -> dict[str, Any]:
    """Create and persist a user-curated Playbook Iron Rule into episodic_memories."""
    ws_id = resolve_workspace_id(request.headers)
    sym = payload.symbol.upper().strip() or "ALL"
    reg = payload.regime_label.upper().strip() or "HIGH_VOL_TRANSITION"
    rule = EpisodicMemory(
        workspace_id=ws_id,
        paper_trade_id=None,
        symbol=sym,
        regime_label=reg,
        quadrant_outcome=payload.quadrant_outcome.upper().strip(),
        title=payload.title.strip(),
        lesson_text=payload.lesson_text.strip(),
        tags_json=[sym, reg, "PLAYBOOK", "IRON_RULE"],
        alpha_vs_spy_pct=None,
        is_pinned=payload.is_pinned,
        is_active=payload.is_active,
        embedding=None,
    )
    async with request.app.state.session_factory() as session:
        session.add(rule)
        await session.commit()
        await session.refresh(rule)

    return {
        "status": "ok",
        "memory": {
            "id": rule.id,
            "paper_trade_id": rule.paper_trade_id,
            "symbol": rule.symbol,
            "regime_label": rule.regime_label,
            "quadrant_outcome": rule.quadrant_outcome,
            "title": rule.title,
            "lesson_text": rule.lesson_text,
            "tags": rule.tags_json,
            "alpha_vs_spy_pct": rule.alpha_vs_spy_pct,
            "is_pinned": rule.is_pinned,
            "is_active": rule.is_active,
            "created_at": rule.created_at.isoformat(),
        },
    }


@router.patch("/memories/playbook/{memory_id}")
async def update_playbook_rule(
    memory_id: int,
    payload: PlaybookRulePatchRequest,
    request: Request,
) -> dict[str, Any]:
    """Pin, activate/mute, or edit an EpisodicMemory / Playbook Iron Rule."""
    ws_id = resolve_workspace_id(request.headers)
    async with request.app.state.session_factory() as session:
        rule = await session.get(EpisodicMemory, memory_id)
        if rule is None or (getattr(rule, "workspace_id", None) or "default") != ws_id:
            raise HTTPException(status_code=404, detail=f"Playbook rule id={memory_id} not found")
        if payload.title is not None:
            rule.title = payload.title.strip()
        if payload.lesson_text is not None:
            rule.lesson_text = payload.lesson_text.strip()
        if payload.regime_label is not None:
            rule.regime_label = payload.regime_label.upper().strip()
        if payload.is_pinned is not None:
            rule.is_pinned = bool(payload.is_pinned)
        if payload.is_active is not None:
            rule.is_active = bool(payload.is_active)
        await session.commit()
        await session.refresh(rule)

    return {
        "status": "ok",
        "memory": {
            "id": rule.id,
            "paper_trade_id": rule.paper_trade_id,
            "symbol": rule.symbol,
            "regime_label": rule.regime_label,
            "quadrant_outcome": rule.quadrant_outcome,
            "title": rule.title,
            "lesson_text": rule.lesson_text,
            "tags": rule.tags_json,
            "alpha_vs_spy_pct": rule.alpha_vs_spy_pct,
            "is_pinned": rule.is_pinned,
            "is_active": rule.is_active,
            "created_at": rule.created_at.isoformat(),
        },
    }


@router.delete("/memories/playbook/{memory_id}")
async def delete_playbook_rule(memory_id: int, request: Request) -> dict[str, Any]:
    """Delete an obsolete EpisodicMemory / Playbook rule."""
    ws_id = resolve_workspace_id(request.headers)
    async with request.app.state.session_factory() as session:
        rule = await session.get(EpisodicMemory, memory_id)
        if rule is None or (getattr(rule, "workspace_id", None) or "default") != ws_id:
            raise HTTPException(status_code=404, detail=f"Playbook rule id={memory_id} not found")
        await session.delete(rule)
        await session.commit()
    return {"status": "ok", "deleted_id": memory_id}

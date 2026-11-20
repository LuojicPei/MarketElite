from __future__ import annotations

import importlib.util
import json
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import desc, select

from app.agents.watchdog import (
    EpisodicMemoryRetriever,
    reflect_on_trade,
    run_watchdog_scan,
)
from app.core.config import get_settings
from app.db.models import EpisodicMemory, PaperTrade, TradeReview, WatchdogAlert

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["watchdog-reflection-memory"])


class ReflectRequest(BaseModel):
    horizon: str = Field(default="POST_CLOSE", pattern="^(POST_CLOSE|T\\+5|T\\+20)$")
    use_fast_llm: bool = Field(default=True)


@router.get("/watchdog/alerts")
async def list_watchdog_alerts(
    request: Request,
    limit: int = Query(default=20, ge=1, le=50),
    unacknowledged_only: bool = Query(default=False),
) -> dict[str, Any]:
    """List persisted intraday anomaly alerts produced by Phase 5 Watchdog."""
    session_factory = request.app.state.session_factory
    async with session_factory() as session:
        stmt = select(WatchdogAlert)
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
    settings = get_settings()
    return await run_watchdog_scan(
        request.app.state.session_factory,
        settings,
        use_fast_llm=use_fast_llm,
    )


@router.post("/watchdog/alerts/{alert_id}/ack")
async def acknowledge_watchdog_alert(alert_id: int, request: Request) -> dict[str, Any]:
    """Mark a Watchdog alert acknowledged so cockpit operators track reviewed anomalies."""
    async with request.app.state.session_factory() as session:
        alert = await session.get(WatchdogAlert, alert_id)
        if alert is None:
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
    async with request.app.state.session_factory() as session:
        rev_stmt = (
            select(TradeReview, PaperTrade.symbol, PaperTrade.side, PaperTrade.realized_pnl)
            .join(PaperTrade, TradeReview.paper_trade_id == PaperTrade.id)
            .order_by(desc(TradeReview.created_at))
            .limit(limit)
        )
        review_rows = (await session.execute(rev_stmt)).all()

        mem_stmt = select(EpisodicMemory).order_by(desc(EpisodicMemory.created_at)).limit(limit)
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
    settings = get_settings()
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
    retriever = EpisodicMemoryRetriever(settings, request.app.state.session_factory)
    items = await retriever.recall(query, symbol=symbol, regime_label=regime_label, top_k=top_k)
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
async def trigger_eval_suite() -> dict[str, Any]:
    """Execute the 32-case Phase 5 Golden Benchmark and return pass-rate telemetry."""
    try:
        return _run_eval_suite()
    except (FileNotFoundError, RuntimeError) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

from __future__ import annotations

import logging
import secrets
import time
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import desc, select

from app.agents.risk_critic import RiskCriticRunner
from app.api.agent import _check_guest_rate_limit
from app.core.config import get_settings
from app.db.models import PaperTrade
from app.services.providers.alpaca import AlpacaClient
from app.services.resilience import ProviderError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/trade", tags=["risk-critic-and-paper-trading"])


class TradeProposalRequest(BaseModel):
    """Structured trade proposal routed to context-isolated Risk Critic."""

    thread_id: str | None = Field(default=None, max_length=120)
    symbol: str = Field(min_length=1, max_length=16)
    side: str = Field(default="buy", pattern="^(buy|sell|BUY|SELL)$")
    proposed_qty: float = Field(gt=0, le=1_000_000)
    entry_price: float | None = Field(default=None, gt=0)
    stop_loss_price: float | None = Field(default=None, gt=0)
    take_profit_price: float | None = Field(default=None, gt=0)
    risk_budget_pct: float = Field(default=1.0, ge=0.1, le=2.0)
    rationale: str = Field(default="", max_length=1500)


class TradeResumeRequest(BaseModel):
    """Human-in-the-Loop (HITL) decision resuming a durable AsyncPostgresSaver thread."""

    thread_id: str = Field(min_length=3, max_length=120)
    decision: str = Field(pattern="^(approve|reject|APPROVE|REJECT)$")
    approved_qty: int | None = Field(default=None, ge=1, le=1_000_000)
    stop_loss_price: float | None = Field(default=None, gt=0)
    take_profit_price: float | None = Field(default=None, gt=0)
    limit_price: float | None = Field(default=None, gt=0)
    note: str = Field(default="", max_length=500)


def _execution_requires_admin(app_env: str, admin_token: str) -> bool:
    return bool(admin_token.strip() or app_env.lower() == "production")


@router.post("/propose")
async def propose_trade_with_critic(
    payload: TradeProposalRequest,
    request: Request,
) -> dict[str, Any]:
    """Run adversarial Risk Critic and suspend at HITL interrupt() checkpoint."""
    settings = get_settings()
    infra = request.app.state.infra
    client_ip = request.client.host if request.client else "unknown"
    await _check_guest_rate_limit(infra.redis, client_ip, settings.guest_chat_rpm)

    sym = payload.symbol.upper().strip()
    thread_id = (payload.thread_id or f"risk-{sym}-{int(time.time() * 1000)}").strip()
    runner = RiskCriticRunner(
        settings,
        request.app.state.session_factory,
        request.app.state.checkpointer,
    )
    try:
        result = await runner.propose_trade(
            thread_id=thread_id,
            symbol=sym,
            side=payload.side,
            proposed_qty=payload.proposed_qty,
            entry_price=payload.entry_price,
            stop_loss_price=payload.stop_loss_price,
            take_profit_price=payload.take_profit_price,
            risk_budget_pct=payload.risk_budget_pct,
            rationale=payload.rationale,
        )
        result["requires_admin_token"] = _execution_requires_admin(
            settings.app_env, settings.admin_api_token
        )
        result["checkpointer"] = (
            "postgres" if getattr(request.app.state, "pg_checkpoint_ready", False) else "memory"
        )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/resume")
async def resume_trade_hitl(
    payload: TradeResumeRequest,
    request: Request,
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> dict[str, Any]:
    """Resume suspended checkpoint and submit Alpaca Paper Bracket order on admin approval."""
    settings = get_settings()
    decision = payload.decision.lower().strip()
    if decision == "approve":
        expected = settings.admin_api_token.strip()
        if expected:
            if not x_admin_token or not secrets.compare_digest(x_admin_token.strip(), expected):
                raise HTTPException(
                    status_code=403,
                    detail="Valid X-Admin-Token required before executing Alpaca Paper order.",
                )
        elif settings.app_env.lower() == "production":
            raise HTTPException(
                status_code=403,
                detail="Order execution in production requires ADMIN_API_TOKEN configuration.",
            )

    runner = RiskCriticRunner(
        settings,
        request.app.state.session_factory,
        request.app.state.checkpointer,
    )
    try:
        return await runner.resume_trade(
            thread_id=payload.thread_id,
            decision=decision,
            approved_qty=payload.approved_qty,
            stop_loss_price=payload.stop_loss_price,
            take_profit_price=payload.take_profit_price,
            limit_price=payload.limit_price,
            note=payload.note,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/checkpoint/{thread_id}")
async def get_suspended_checkpoint(thread_id: str, request: Request) -> dict[str, Any]:
    """Load persisted HITL state from AsyncPostgresSaver so suspended cards survive page reloads."""
    settings = get_settings()
    runner = RiskCriticRunner(
        settings,
        request.app.state.session_factory,
        request.app.state.checkpointer,
    )
    graph = runner._build_graph()
    snap = await graph.aget_state({"configurable": {"thread_id": thread_id}})
    if not snap or not snap.values:
        raise HTTPException(status_code=404, detail=f"Checkpoint not found for {thread_id}")

    vals = dict(snap.values)
    return {
        "thread_id": thread_id,
        "next_nodes": list(snap.next or ()),
        "is_suspended": bool(snap.next),
        "requires_admin_token": _execution_requires_admin(
            settings.app_env, settings.admin_api_token
        ),
        "approval_card": {
            "type": "risk_critic_hitl_approval",
            "thread_id": thread_id,
            "symbol": vals.get("symbol"),
            "side": vals.get("side"),
            "rationale": vals.get("rationale", ""),
            "risk_sizing": vals.get("risk_sizing"),
            "critique": vals.get("critique"),
            "account": vals.get("account"),
            "existing_position": vals.get("existing_position"),
            "upcoming_catalysts": vals.get("upcoming_catalysts", []),
        },
        "execution_status": vals.get("execution_status"),
        "execution_receipt": vals.get("execution_receipt"),
    }


@router.get("/ledger")
async def get_paper_ledger(request: Request) -> dict[str, Any]:
    """Return Alpaca Paper account/positions/orders plus PostgreSQL PaperTrade HITL ledger."""
    settings = get_settings()
    alpaca = AlpacaClient(settings)

    account: dict[str, Any] | None = None
    positions: list[dict[str, Any]] = []
    orders: list[dict[str, Any]] = []
    alpaca_error: str | None = None

    try:
        account = await alpaca.get_account()
        positions = await alpaca.get_positions()
        orders = await alpaca.get_orders(status="all", limit=15)
    except (ProviderError, OSError) as exc:
        alpaca_error = str(exc)

    session_factory = request.app.state.session_factory
    async with session_factory() as session:
        stmt = select(PaperTrade).order_by(desc(PaperTrade.created_at)).limit(25)
        rows = list((await session.execute(stmt)).scalars().all())

    return {
        "checkpointer": (
            "postgres" if getattr(request.app.state, "pg_checkpoint_ready", False) else "memory"
        ),
        "requires_admin_token": _execution_requires_admin(
            settings.app_env, settings.admin_api_token
        ),
        "alpaca_error": alpaca_error,
        "account": account,
        "positions": positions,
        "orders": orders,
        "paper_trades": [
            {
                "id": r.id,
                "thread_id": r.thread_id,
                "symbol": r.symbol,
                "side": r.side,
                "order_class": r.order_class,
                "qty": r.qty,
                "entry_price": r.entry_price,
                "stop_loss_price": r.stop_loss_price,
                "take_profit_price": r.take_profit_price,
                "risk_budget_pct": r.risk_budget_pct,
                "alpaca_order_id": r.alpaca_order_id,
                "status": r.status,
                "regime_at_entry": r.regime_at_entry,
                "rationale_summary": r.rationale_summary,
                "created_at": r.created_at.isoformat(),
                "updated_at": r.updated_at.isoformat(),
            }
            for r in rows
        ],
    }

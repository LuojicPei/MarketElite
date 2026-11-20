from __future__ import annotations

import logging
import secrets
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import desc, select

from app.agents.risk_critic import RiskCriticRunner
from app.api.agent import _check_guest_rate_limit
from app.core.config import get_settings
from app.db.models import MarketDailyBar, PaperTrade
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
                "closed_at": r.closed_at.isoformat() if r.closed_at else None,
                "realized_pnl": r.realized_pnl,
                "spy_benchmark_return_pct": r.spy_benchmark_return_pct,
                "created_at": r.created_at.isoformat(),
                "updated_at": r.updated_at.isoformat(),
            }
            for r in rows
        ],
    }


def _assert_admin_if_required(settings: Any, x_admin_token: str | None) -> None:
    if not _execution_requires_admin(settings.app_env, settings.admin_api_token):
        return
    expected = settings.admin_api_token.strip()
    if expected:
        if not x_admin_token or not secrets.compare_digest(x_admin_token.strip(), expected):
            raise HTTPException(
                status_code=403,
                detail="Valid X-Admin-Token header required for live Paper order modifications.",
            )
    else:
        raise HTTPException(
            status_code=403,
            detail="Order management is locked in production unless ADMIN_API_TOKEN is set.",
        )


async def _compute_spy_benchmark_return_pct(
    session: Any,
    start_dt: datetime,
    end_dt: datetime,
) -> float | None:
    start_bar = (
        await session.execute(
            select(MarketDailyBar)
            .where(
                MarketDailyBar.symbol == "SPY",
                MarketDailyBar.trade_date >= start_dt.date(),
            )
            .order_by(MarketDailyBar.trade_date)
            .limit(1)
        )
    ).scalar_one_or_none()
    if start_bar is None:
        start_bar = (
            await session.execute(
                select(MarketDailyBar)
                .where(MarketDailyBar.symbol == "SPY")
                .order_by(desc(MarketDailyBar.trade_date))
                .limit(1)
            )
        ).scalar_one_or_none()
    end_bar = (
        await session.execute(
            select(MarketDailyBar)
            .where(
                MarketDailyBar.symbol == "SPY",
                MarketDailyBar.trade_date <= end_dt.date(),
            )
            .order_by(desc(MarketDailyBar.trade_date))
            .limit(1)
        )
    ).scalar_one_or_none()
    if start_bar and end_bar and float(start_bar.close) > 0:
        return round(((float(end_bar.close) / float(start_bar.close)) - 1.0) * 100.0, 2)
    return None


async def sync_paper_trade_statuses(
    session_factory: Any,
    settings: Any,
    *,
    alpaca_client: AlpacaClient | None = None,
) -> dict[str, Any]:
    """Synchronize PaperTrade rows against Alpaca orders/positions & record exits."""
    alpaca = alpaca_client or AlpacaClient(settings)
    positions = await alpaca.get_positions()
    open_pos_syms = {str(p.get("symbol", "")).upper() for p in positions}

    updated = 0
    closed_ids: list[int] = []
    async with session_factory() as session:
        rows = list(
            (
                await session.execute(
                    select(PaperTrade)
                    .where(
                        PaperTrade.alpaca_order_id.is_not(None),
                        PaperTrade.status.notin_(["rejected", "canceled", "expired"]),
                    )
                    .order_by(desc(PaperTrade.created_at))
                    .limit(40)
                )
            )
            .scalars()
            .all()
        )

        for row in rows:
            oid = (row.alpaca_order_id or "").strip()
            if not oid:
                continue
            try:
                order = await alpaca.get_order(oid)
            except ProviderError as exc:
                logger.warning("Failed syncing order %s: %s", oid, exc)
                continue

            status_raw = str(order.get("status", row.status)).lower().strip()
            filled_avg = order.get("filled_avg_price")
            if filled_avg is not None:
                try:
                    row.entry_price = float(filled_avg)
                except (TypeError, ValueError):
                    pass

            exit_price: float | None = None
            exit_dt: datetime | None = None
            for leg in order.get("legs") or []:
                leg_status = str(leg.get("status", "")).lower().strip()
                if leg_status == "filled" and leg.get("filled_avg_price") is not None:
                    try:
                        exit_price = float(leg["filled_avg_price"])
                        filled_at_str = str(leg.get("filled_at") or "")
                        if filled_at_str:
                            exit_dt = datetime.fromisoformat(filled_at_str.replace("Z", "+00:00"))
                    except (TypeError, ValueError):
                        pass

            if exit_price is not None:
                row.status = "closed"
                row.closed_at = exit_dt or datetime.now(timezone.utc)
                if row.entry_price is not None:
                    mult = 1.0 if row.side.lower() == "buy" else -1.0
                    row.realized_pnl = round((exit_price - float(row.entry_price)) * float(row.qty) * mult, 2)
                row.spy_benchmark_return_pct = await _compute_spy_benchmark_return_pct(
                    session, row.created_at, row.closed_at
                )
                closed_ids.append(row.id)
                updated += 1
            elif status_raw in {"canceled", "expired", "rejected"}:
                if row.status != status_raw:
                    row.status = status_raw
                    updated += 1
            elif status_raw == "filled":
                if row.symbol.upper() not in open_pos_syms and row.closed_at is None and row.status == "filled":
                    # Closed via manual close_position or external liquidation without child leg metadata
                    row.status = "closed"
                    row.closed_at = datetime.now(timezone.utc)
                    row.spy_benchmark_return_pct = await _compute_spy_benchmark_return_pct(
                        session, row.created_at, row.closed_at
                    )
                    closed_ids.append(row.id)
                    updated += 1
                elif row.status != "filled":
                    row.status = "filled"
                    updated += 1
            elif row.status != status_raw and status_raw:
                row.status = status_raw
                updated += 1

        await session.commit()

    return {
        "status": "ok",
        "checked": len(rows),
        "updated": updated,
        "newly_closed_trade_ids": closed_ids,
    }


@router.post("/orders/{order_id}/cancel")
async def cancel_paper_order(
    order_id: str,
    request: Request,
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> dict[str, Any]:
    """Cancel an open Alpaca Paper order and sync its PaperTrade record."""
    settings = get_settings()
    _assert_admin_if_required(settings, x_admin_token)
    alpaca = AlpacaClient(settings)
    try:
        res = await alpaca.cancel_order(order_id)
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=f"Alpaca cancel failed: {exc}") from exc

    async with request.app.state.session_factory() as session:
        rows = list(
            (
                await session.execute(
                    select(PaperTrade).where(PaperTrade.alpaca_order_id == order_id.strip())
                )
            )
            .scalars()
            .all()
        )
        for row in rows:
            row.status = "canceled"
            row.updated_at = datetime.now(timezone.utc)
        await session.commit()

    return {"status": "canceled", "alpaca": res, "updated_trades": len(rows)}


@router.post("/positions/{symbol}/close")
async def close_paper_position(
    symbol: str,
    request: Request,
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> dict[str, Any]:
    """Close an open Alpaca Paper position and mark open PaperTrade records closed."""
    settings = get_settings()
    _assert_admin_if_required(settings, x_admin_token)
    sym = symbol.upper().strip()
    if not sym:
        raise HTTPException(status_code=400, detail="Symbol is required")

    alpaca = AlpacaClient(settings)
    pos_entry: dict[str, Any] | None = None
    try:
        for p in await alpaca.get_positions():
            if str(p.get("symbol", "")).upper() == sym:
                pos_entry = p
                break
        close_order = await alpaca.close_position(sym)
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=f"Alpaca close position failed: {exc}") from exc

    now = datetime.now(timezone.utc)
    approx_exit_px: float | None = None
    if close_order.get("filled_avg_price"):
        try:
            approx_exit_px = float(close_order["filled_avg_price"])
        except (TypeError, ValueError):
            approx_exit_px = None
    elif pos_entry and pos_entry.get("current_price"):
        try:
            approx_exit_px = float(pos_entry["current_price"])
        except (TypeError, ValueError):
            approx_exit_px = None

    closed_trade_ids: list[int] = []
    async with request.app.state.session_factory() as session:
        open_trades = list(
            (
                await session.execute(
                    select(PaperTrade).where(
                        PaperTrade.symbol == sym,
                        PaperTrade.status.in_(["submitted", "filled", "accepted", "new"]),
                    )
                )
            )
            .scalars()
            .all()
        )
        for row in open_trades:
            row.status = "closed"
            row.closed_at = now
            if row.entry_price is not None and approx_exit_px is not None:
                mult = 1.0 if row.side.lower() == "buy" else -1.0
                row.realized_pnl = round(
                    (approx_exit_px - float(row.entry_price)) * float(row.qty) * mult, 2
                )
            elif pos_entry and pos_entry.get("unrealized_pl") is not None:
                try:
                    row.realized_pnl = round(float(pos_entry["unrealized_pl"]), 2)
                except (TypeError, ValueError):
                    pass
            row.spy_benchmark_return_pct = await _compute_spy_benchmark_return_pct(
                session, row.created_at, now
            )
            closed_trade_ids.append(row.id)
        await session.commit()

    return {
        "status": "closed",
        "symbol": sym,
        "close_order": close_order,
        "closed_trade_ids": closed_trade_ids,
    }


@router.post("/sync-status")
async def sync_paper_trades_endpoint(request: Request) -> dict[str, Any]:
    """Poll Alpaca order statuses and update local PaperTrade fills, exits, and SPY alpha."""
    settings = get_settings()
    try:
        return await sync_paper_trade_statuses(request.app.state.session_factory, settings)
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=f"Alpaca sync failed: {exc}") from exc

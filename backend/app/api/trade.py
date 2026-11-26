from __future__ import annotations

import logging
import secrets
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, desc, select

from app.agents.risk_critic import RiskCriticRunner, load_symbol_market_facts
from app.api.agent import _check_guest_rate_limit
from app.core.config import get_settings
from app.core.workspace import resolve_workspace_id
from app.db.models import ImportedHolding, MarketDailyBar, PaperTrade
from app.quant.risk import RiskSizingRequest, compute_risk_sizing
from app.services.broker import (
    compute_spy_benchmark_pct,
    fetch_unified_broker_state,
    invalidate_broker_state_cache,
    resolve_broker_config,
    sync_ibkr_history_to_ledger,
    sync_t212_history_to_ledger,
)
from app.services.llm_router import resolve_llm_settings
from app.services.portfolio_analytics import (
    build_portfolio_analytics,
    enrich_positions_with_structure,
)
from app.services.providers.alpaca import AlpacaClient
from app.services.providers.binance_ro import BinanceReadOnlyClient
from app.services.providers.ibkr_flex import IBKRFlexClient
from app.services.providers.portfolio_import import parse_holdings_input
from app.services.providers.trading212 import Trading212Client
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


class BatchTradeProposalItem(BaseModel):
    symbol: str = Field(min_length=1, max_length=16)
    side: str = Field(default="buy", pattern="^(buy|sell|BUY|SELL)$")
    proposed_qty: float = Field(gt=0, le=1_000_000)
    entry_price: float | None = Field(default=None, gt=0)
    rationale: str = Field(default="", max_length=600)


class BatchTradeProposalRequest(BaseModel):
    items: list[BatchTradeProposalItem] = Field(min_length=1, max_length=8)
    risk_budget_pct: float = Field(default=1.0, ge=0.25, le=2.0)
    source_label: str = Field(default="自选组合仓位推演仪批量拆单", max_length=120)


class Trading212TestRequest(BaseModel):
    api_key: str = Field(default="", max_length=512)
    api_secret: str = Field(default="", max_length=512)
    env: str = Field(default="live", pattern="^(live|demo|LIVE|DEMO)$")


class UnifiedBrokerTestRequest(BaseModel):
    provider: str = Field(min_length=2, max_length=32)
    api_key: str = Field(default="", max_length=512)
    api_secret: str = Field(default="", max_length=512)
    env: str = Field(default="live", max_length=24)
    flex_token: str = Field(default="", max_length=512)
    query_id: str = Field(default="", max_length=128)


class ImportHoldingsRequest(BaseModel):
    raw_text: str = Field(default="", max_length=50000)
    source_label: str = Field(default="通用券商导入 (CSV/手动)", max_length=64)
    replace_existing: bool = Field(default=False)


def _execution_requires_admin(app_env: str, admin_token: str) -> bool:
    return bool(admin_token.strip() or app_env.lower() == "production")


@router.post("/trading212/test")
async def test_trading212_connection(
    payload: Trading212TestRequest,
    request: Request,
) -> dict[str, Any]:
    """Validate Trading212 v0 API credentials (Live Invest/ISA or Demo Practice) safely."""
    settings = get_settings()
    api_key = payload.api_key.strip() or (request.headers.get("X-T212-Api-Key") or "").strip() or settings.trading212_api_key.strip()
    api_secret = payload.api_secret.strip() or (request.headers.get("X-T212-Api-Secret") or "").strip() or settings.trading212_api_secret.strip()
    env = payload.env.lower().strip() or (request.headers.get("X-T212-Env") or "live").lower().strip()

    client = Trading212Client(
        api_key=api_key,
        api_secret=api_secret,
        env=env,
        redis_client=request.app.state.infra.redis,
    )
    try:
        return await client.test_connection()
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/broker/test")
async def test_unified_broker_connection(
    payload: UnifiedBrokerTestRequest,
    request: Request,
) -> dict[str, Any]:
    """Unified multi-broker connection check across Trading212, IBKR Flex, Binance RO, Alpaca, Sandbox."""
    prov = payload.provider.strip().lower()
    settings = get_settings()
    redis_client = request.app.state.infra.redis

    if prov == "sandbox":
        return {
            "ok": True,
            "provider": "sandbox",
            "message": "本地 24/7 拟真模拟盘已就绪，免配置开箱即用。",
        }
    if prov == "csv_import":
        return {
            "ok": True,
            "provider": "csv_import",
            "message": "通用 CSV / 手动持仓导入引擎就绪（兼容 Robinhood / 富途 / 老虎 / Schwab）。",
        }
    if prov == "trading212":
        api_key = payload.api_key.strip() or (request.headers.get("X-T212-Api-Key") or "").strip() or settings.trading212_api_key.strip()
        api_secret = payload.api_secret.strip() or (request.headers.get("X-T212-Api-Secret") or "").strip() or settings.trading212_api_secret.strip()
        env = payload.env.lower().strip() or "live"
        try:
            res = await Trading212Client(
                api_key=api_key,
                api_secret=api_secret,
                env=env,
                redis_client=redis_client,
            ).test_connection()
            return {"ok": True, "provider": "trading212", **res}
        except ProviderError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    if prov == "ibkr":
        token = payload.flex_token.strip() or (request.headers.get("X-IBKR-Flex-Token") or "").strip()
        qid = payload.query_id.strip() or (request.headers.get("X-IBKR-Query-Id") or "").strip()
        try:
            snap = await IBKRFlexClient(
                flex_token=token,
                query_id=qid,
                redis_client=redis_client,
            ).get_snapshot(force_refresh=True)
            acct = snap["account"]
            return {
                "ok": True,
                "provider": "ibkr",
                "currency": acct.get("currency", "USD"),
                "equity": acct.get("equity"),
                "positions_count": len(snap.get("positions") or []),
                "message": f"IBKR Flex 握手成功（{acct.get('currency', 'USD')} 净值 {acct.get('equity', 0)} · {len(snap.get('positions') or [])} 个持仓）。",
            }
        except ProviderError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    if prov == "binance":
        api_key = payload.api_key.strip() or (request.headers.get("X-Binance-Api-Key") or "").strip()
        api_secret = payload.api_secret.strip() or (request.headers.get("X-Binance-Api-Secret") or "").strip()
        env = payload.env.lower().strip() or "global"
        try:
            snap = await BinanceReadOnlyClient(
                api_key=api_key,
                api_secret=api_secret,
                env=env,
                redis_client=redis_client,
            ).get_snapshot(force_refresh=True)
            acct = snap["account"]
            return {
                "ok": True,
                "provider": "binance",
                "currency": "USD",
                "equity": acct.get("equity"),
                "positions_count": len(snap.get("positions") or []),
                "message": f"Binance 只读现货连接成功（折合总资产 ${acct.get('equity', 0):,.2f} · {len(snap.get('positions') or [])} 项非零持仓）。",
            }
        except ProviderError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    if prov == "alpaca":
        try:
            acct = await AlpacaClient(settings).get_account()
            return {
                "ok": True,
                "provider": "alpaca",
                "currency": "USD",
                "equity": acct.get("equity"),
                "message": f"Alpaca Paper 连通成功（净值 ${float(acct.get('equity') or 0):,.2f}）。",
            }
        except ProviderError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    raise HTTPException(status_code=400, detail=f"Unsupported broker provider: {prov}")


@router.get("/broker/imported-holdings")
async def list_imported_holdings_endpoint(request: Request) -> dict[str, Any]:
    """List CSV / manually imported holdings scoped to the visitor's workspace."""
    ws_id = resolve_workspace_id(request.headers)
    async with request.app.state.session_factory() as session:
        rows = list(
            (
                await session.execute(
                    select(ImportedHolding)
                    .where(ImportedHolding.workspace_id == ws_id)
                    .order_by(desc(ImportedHolding.updated_at))
                )
            )
            .scalars()
            .all()
        )
    return {
        "workspace_id": ws_id,
        "count": len(rows),
        "holdings": [
            {
                "id": r.id,
                "source_label": r.source_label,
                "symbol": r.symbol,
                "side": r.side,
                "qty": r.qty,
                "avg_cost_price": r.avg_cost_price,
                "currency": r.currency,
                "updated_at": r.updated_at.isoformat(),
            }
            for r in rows
        ],
    }


@router.post("/broker/import-holdings")
async def import_holdings_endpoint(
    payload: ImportHoldingsRequest,
    request: Request,
) -> dict[str, Any]:
    """Parse flexible broker CSV / quick position lines into workspace imported holdings."""
    ws_id = resolve_workspace_id(request.headers)
    items = parse_holdings_input(
        payload.raw_text,
        default_source=payload.source_label.strip() or "通用券商导入",
    )
    if not items:
        raise HTTPException(
            status_code=400,
            detail="未识别到有效的持仓行。支持 CSV 表头（Symbol, Qty, Avg Cost）或快捷行（例如: NVDA 10 @ 135）。",
        )

    async with request.app.state.session_factory() as session:
        if payload.replace_existing:
            await session.execute(
                delete(ImportedHolding).where(ImportedHolding.workspace_id == ws_id)
            )

        upserted = 0
        for item in items:
            existing = (
                await session.execute(
                    select(ImportedHolding)
                    .where(
                        ImportedHolding.workspace_id == ws_id,
                        ImportedHolding.symbol == item["symbol"],
                        ImportedHolding.side == item["side"],
                    )
                    .limit(1)
                )
            ).scalar_one_or_none()
            if existing is not None:
                existing.qty = item["qty"]
                if item["avg_cost_price"] is not None:
                    existing.avg_cost_price = item["avg_cost_price"]
                existing.source_label = item["source_label"]
                existing.currency = item["currency"]
            else:
                session.add(
                    ImportedHolding(
                        workspace_id=ws_id,
                        source_label=item["source_label"],
                        symbol=item["symbol"],
                        side=item["side"],
                        qty=item["qty"],
                        avg_cost_price=item["avg_cost_price"],
                        currency=item["currency"],
                    )
                )
            upserted += 1
        await session.commit()

    return {
        "status": "ok",
        "workspace_id": ws_id,
        "imported_count": upserted,
        "symbols": [it["symbol"] for it in items],
    }


@router.delete("/broker/imported-holdings/{holding_id}")
async def delete_imported_holding_endpoint(holding_id: int, request: Request) -> dict[str, Any]:
    ws_id = resolve_workspace_id(request.headers)
    async with request.app.state.session_factory() as session:
        row = (
            await session.execute(
                select(ImportedHolding)
                .where(ImportedHolding.id == holding_id, ImportedHolding.workspace_id == ws_id)
                .limit(1)
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Imported holding id={holding_id} not found")
        await session.delete(row)
        await session.commit()
    return {"status": "ok", "deleted_id": holding_id}


@router.delete("/broker/imported-holdings")
async def clear_imported_holdings_endpoint(request: Request) -> dict[str, Any]:
    ws_id = resolve_workspace_id(request.headers)
    async with request.app.state.session_factory() as session:
        res = await session.execute(
            delete(ImportedHolding).where(ImportedHolding.workspace_id == ws_id)
        )
        await session.commit()
    return {"status": "ok", "deleted": int(getattr(res, "rowcount", 0) or 0)}


@router.post("/propose")
async def propose_trade_with_critic(
    payload: TradeProposalRequest,
    request: Request,
) -> dict[str, Any]:
    """Run adversarial Risk Critic and suspend at HITL interrupt() checkpoint."""
    base_settings = get_settings()
    try:
        settings, _ = resolve_llm_settings(base_settings, request.headers)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    infra = request.app.state.infra
    client_ip = request.client.host if request.client else "unknown"
    await _check_guest_rate_limit(infra.redis, client_ip, settings.guest_chat_rpm)

    broker_cfg = resolve_broker_config(settings, request.headers)
    sym = payload.symbol.upper().strip()
    thread_id = (payload.thread_id or f"risk-{sym}-{int(time.time() * 1000)}").strip()
    runner = RiskCriticRunner(
        settings,
        request.app.state.session_factory,
        request.app.state.checkpointer,
        broker_config=broker_cfg,
        redis_client=infra.redis,
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

    broker_cfg = resolve_broker_config(settings, request.headers)
    runner = RiskCriticRunner(
        settings,
        request.app.state.session_factory,
        request.app.state.checkpointer,
        broker_config=broker_cfg,
        redis_client=request.app.state.infra.redis,
    )
    try:
        res = await runner.resume_trade(
            thread_id=payload.thread_id,
            decision=decision,
            approved_qty=payload.approved_qty,
            stop_loss_price=payload.stop_loss_price,
            take_profit_price=payload.take_profit_price,
            limit_price=payload.limit_price,
            note=payload.note,
        )
        await invalidate_broker_state_cache(request.app.state.infra.redis, broker_cfg)
        return res
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/checkpoint/{thread_id}")
async def get_suspended_checkpoint(thread_id: str, request: Request) -> dict[str, Any]:
    """Load persisted HITL state from AsyncPostgresSaver so suspended cards survive page reloads."""
    settings = get_settings()
    broker_cfg = resolve_broker_config(settings, request.headers)
    runner = RiskCriticRunner(
        settings,
        request.app.state.session_factory,
        request.app.state.checkpointer,
        broker_config=broker_cfg,
        redis_client=request.app.state.infra.redis,
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
            "structure_levels": vals.get("structure_levels") or {},
            "account": vals.get("account"),
            "existing_position": vals.get("existing_position"),
            "upcoming_catalysts": vals.get("upcoming_catalysts", []),
        },
        "execution_status": vals.get("execution_status"),
        "execution_receipt": vals.get("execution_receipt"),
    }


@router.get("/ledger")
async def get_paper_ledger(
    request: Request,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Return active broker (Trading212 / Local Sandbox / Alpaca Paper) ledger + PaperTrade rows."""
    settings = get_settings()
    broker_cfg = resolve_broker_config(settings, request.headers)
    session_factory = request.app.state.session_factory
    unified = await fetch_unified_broker_state(
        session_factory=session_factory,
        settings=settings,
        redis_client=request.app.state.infra.redis,
        broker_cfg=broker_cfg,
        force_refresh=force_refresh,
    )

    enriched_positions = await enrich_positions_with_structure(
        session_factory, unified.get("positions", [])
    )

    ws_id = resolve_workspace_id(request.headers)
    async with session_factory() as session:
        stmt = (
            select(PaperTrade)
            .where(PaperTrade.workspace_id == ws_id)
            .order_by(desc(PaperTrade.created_at))
            .limit(40)
        )
        rows = list((await session.execute(stmt)).scalars().all())

    return {
        "checkpointer": (
            "postgres" if getattr(request.app.state, "pg_checkpoint_ready", False) else "memory"
        ),
        "requires_admin_token": _execution_requires_admin(
            settings.app_env, settings.admin_api_token
        ),
        "workspace_id": ws_id,
        "broker": unified.get("broker", "sandbox"),
        "broker_label": unified.get("broker_label", "本地拟真模拟盘"),
        "broker_profile": unified.get("broker_profile"),
        "read_only": bool(unified.get("read_only", False)),
        "currency": unified.get("currency", "USD"),
        "alpaca_error": unified.get("broker_error"),
        "broker_error": unified.get("broker_error"),
        "account": unified.get("account"),
        "positions": enriched_positions,
        "orders": unified.get("orders", []),
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
    """Cancel an open working order (Alpaca Paper or Local Sandbox)."""
    settings = get_settings()
    _assert_admin_if_required(settings, x_admin_token)
    broker_cfg = resolve_broker_config(settings, request.headers)
    oid = order_id.strip()

    if broker_cfg.provider == "trading212":
        raise HTTPException(
            status_code=400,
            detail="Trading212 当前为只读同步模式（未勾选 Orders - Execute），请在 Trading212 App 内撤单。",
        )

    res: dict[str, Any] = {"id": oid, "status": "canceled"}
    if broker_cfg.provider == "alpaca" and not oid.startswith("sbx-"):
        alpaca = AlpacaClient(settings)
        try:
            res = await alpaca.cancel_order(oid)
        except ProviderError as exc:
            raise HTTPException(status_code=502, detail=f"Alpaca cancel failed: {exc}") from exc

    async with request.app.state.session_factory() as session:
        rows = list(
            (
                await session.execute(
                    select(PaperTrade).where(PaperTrade.alpaca_order_id == oid)
                )
            )
            .scalars()
            .all()
        )
        for row in rows:
            row.status = "canceled"
            row.updated_at = datetime.now(timezone.utc)
        await session.commit()

    await invalidate_broker_state_cache(request.app.state.infra.redis, broker_cfg)
    return {"status": "canceled", "alpaca": res, "updated_trades": len(rows)}


@router.post("/positions/{symbol}/close")
async def close_paper_position(
    symbol: str,
    request: Request,
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> dict[str, Any]:
    """Close an open position (Alpaca Paper or Local 24/7 Sandbox) & compute SPY Alpha."""
    settings = get_settings()
    _assert_admin_if_required(settings, x_admin_token)
    broker_cfg = resolve_broker_config(settings, request.headers)
    sym = symbol.upper().strip()
    if not sym:
        raise HTTPException(status_code=400, detail="Symbol is required")

    if broker_cfg.provider in ("trading212", "ibkr", "binance", "csv_import"):
        raise HTTPException(
            status_code=400,
            detail="当前外部数据源处于只读同步模式（未赋予实盘下单权限），请在您使用的交易软件平仓后同步记录，或切换至「本地 24/7 模拟盘」演练平仓。",
        )

    now = datetime.now(timezone.utc)
    approx_exit_px: float | None = None
    pos_entry: dict[str, Any] | None = None
    close_order: dict[str, Any] = {"symbol": sym, "status": "filled"}

    if broker_cfg.provider == "alpaca":
        alpaca = AlpacaClient(settings)
        try:
            for p in await alpaca.get_positions():
                if str(p.get("symbol", "")).upper() == sym:
                    pos_entry = p
                    break
            close_order = await alpaca.close_position(sym)
        except ProviderError as exc:
            raise HTTPException(status_code=502, detail=f"Alpaca close position failed: {exc}") from exc

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
        if approx_exit_px is None:
            latest_bar = (
                await session.execute(
                    select(MarketDailyBar)
                    .where(MarketDailyBar.symbol == sym)
                    .order_by(desc(MarketDailyBar.trade_date))
                    .limit(1)
                )
            ).scalar_one_or_none()
            if latest_bar is not None and float(latest_bar.close) > 0:
                approx_exit_px = float(latest_bar.close)
                close_order["filled_avg_price"] = f"{approx_exit_px:.2f}"

        open_trades = list(
            (
                await session.execute(
                    select(PaperTrade).where(
                        PaperTrade.workspace_id == broker_cfg.workspace_id,
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
            row.spy_benchmark_return_pct = await compute_spy_benchmark_pct(
                session, row.created_at, now
            )
            closed_trade_ids.append(row.id)
        await session.commit()

    await invalidate_broker_state_cache(request.app.state.infra.redis, broker_cfg)
    return {
        "status": "closed",
        "symbol": sym,
        "close_order": close_order,
        "closed_trade_ids": closed_trade_ids,
    }


@router.post("/sync-status")
async def sync_paper_trades_endpoint(request: Request) -> dict[str, Any]:
    """Synchronize connected broker history/valuations, Alpaca orders, or Sandbox close valuations."""
    settings = get_settings()
    broker_cfg = resolve_broker_config(settings, request.headers)
    ws_id = broker_cfg.workspace_id
    if broker_cfg.provider == "trading212":
        if not broker_cfg.t212_api_key or not broker_cfg.t212_api_secret:
            raise HTTPException(
                status_code=400,
                detail="请先点击右上角「设置 → 数据源与交易账户接入」填写 Trading212 只读 API Key 与 Secret。",
            )
        try:
            res = await sync_t212_history_to_ledger(
                session_factory=request.app.state.session_factory,
                broker_cfg=broker_cfg,
                redis_client=request.app.state.infra.redis,
            )
            await invalidate_broker_state_cache(request.app.state.infra.redis, broker_cfg)
            return {
                "status": "ok",
                "broker": "trading212",
                "checked": res["fetched"],
                "updated": res["imported"],
                "newly_closed_trade_ids": [],
            }
        except ProviderError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    if broker_cfg.provider == "ibkr":
        if not broker_cfg.ibkr_flex_token or not broker_cfg.ibkr_query_id:
            raise HTTPException(
                status_code=400,
                detail="请先点击「设置 → 数据源与交易账户接入」填写 IBKR Flex Token 与 Query ID。",
            )
        try:
            res = await sync_ibkr_history_to_ledger(
                session_factory=request.app.state.session_factory,
                broker_cfg=broker_cfg,
                redis_client=request.app.state.infra.redis,
            )
            await invalidate_broker_state_cache(request.app.state.infra.redis, broker_cfg)
            return {
                "status": "ok",
                "broker": "ibkr",
                "checked": res["fetched"],
                "updated": res["imported"],
                "newly_closed_trade_ids": [],
            }
        except ProviderError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    if broker_cfg.provider in ("binance", "csv_import", "sandbox"):
        async with request.app.state.session_factory() as session:
            open_count = len(
                (
                    await session.execute(
                        select(PaperTrade).where(
                            PaperTrade.workspace_id == ws_id,
                            PaperTrade.status.in_(["submitted", "filled", "accepted", "new"]),
                        )
                    )
                )
                .scalars()
                .all()
            )
        await invalidate_broker_state_cache(request.app.state.infra.redis, broker_cfg)
        return {
            "status": "ok",
            "broker": broker_cfg.provider,
            "checked": open_count,
            "updated": 0,
            "newly_closed_trade_ids": [],
        }

    try:
        res = await sync_paper_trade_statuses(request.app.state.session_factory, settings)
        await invalidate_broker_state_cache(request.app.state.infra.redis, broker_cfg)
        return res
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=f"Alpaca sync failed: {exc}") from exc


@router.get("/risk-structure/{symbol}")
async def get_symbol_risk_structure(
    symbol: str,
    request: Request,
    side: str = Query(default="buy", pattern="^(buy|sell|BUY|SELL)$"),
    risk_budget_pct: float = Query(default=1.0, ge=0.25, le=2.0),
    entry_price: float | None = Query(default=None, gt=0),
    stop_loss: float | None = Query(default=None, gt=0),
    take_profit: float | None = Query(default=None, gt=0),
    proposed_qty: float = Query(default=50.0, gt=0),
) -> dict[str, Any]:
    """Compute live market structure + deterministic Bracket sizing preview before HITL submission."""
    settings = get_settings()
    session_factory = request.app.state.session_factory
    sym = symbol.upper().strip()
    if not sym:
        raise HTTPException(status_code=400, detail="Symbol is required")

    facts = await load_symbol_market_facts(session_factory, sym)
    spot = float(facts.get("spot_price") or entry_price or 0.0)
    if spot <= 0:
        raise HTTPException(status_code=404, detail=f"未找到 {sym} 行情记录，请先入库该标的。")

    broker_cfg = resolve_broker_config(settings, request.headers)
    unified = await fetch_unified_broker_state(
        session_factory=session_factory,
        settings=settings,
        redis_client=request.app.state.infra.redis,
        broker_cfg=broker_cfg,
    )
    account = unified.get("account") or {
        "equity": 100_000.0,
        "buying_power": 100_000.0,
        "currency": "USD",
    }
    equity = max(100.0, float(account.get("equity") or 100_000.0))
    buying_power = max(0.0, float(account.get("buying_power") or equity))

    sizing = compute_risk_sizing(
        RiskSizingRequest(
            symbol=sym,
            side=side.lower().strip(),
            account_equity=equity,
            buying_power=buying_power,
            spot_price=spot,
            proposed_qty=proposed_qty,
            entry_price=entry_price or spot,
            stop_loss_price=stop_loss,
            take_profit_price=take_profit,
            atr_14=facts.get("atr_14"),
            call_wall=facts.get("call_wall"),
            put_wall=facts.get("put_wall"),
            risk_budget_pct=risk_budget_pct,
        )
    )
    return {
        "symbol": sym,
        "side": side.lower().strip(),
        "broker": unified.get("broker", "sandbox"),
        "currency": unified.get("currency", "USD"),
        "account_equity": round(equity, 2),
        "buying_power": round(buying_power, 2),
        "structure": {
            "spot_price": round(spot, 2),
            "atr_14": facts.get("atr_14"),
            "atr_pct": facts.get("atr_pct"),
            "ema_20": facts.get("ema_20"),
            "sma_50": facts.get("sma_50"),
            "call_wall": facts.get("call_wall"),
            "put_wall": facts.get("put_wall"),
            "zero_gamma": facts.get("zero_gamma"),
            "net_gex": facts.get("net_gex"),
            "regime_label": facts.get("regime_label"),
        },
        "risk_sizing": sizing.to_dict(),
    }


@router.get("/analytics")
async def get_portfolio_analytics(request: Request) -> dict[str, Any]:
    """Compute Net Equity vs SPY curve, quantitative KPIs, and 2x2 Quadrant attribution points."""
    settings = get_settings()
    session_factory = request.app.state.session_factory
    broker_cfg = resolve_broker_config(settings, request.headers)
    unified = await fetch_unified_broker_state(
        session_factory=session_factory,
        settings=settings,
        redis_client=request.app.state.infra.redis,
        broker_cfg=broker_cfg,
    )
    return await build_portfolio_analytics(
        session_factory=session_factory,
        broker=str(unified.get("broker", "sandbox")),
        account=unified.get("account"),
        workspace_id=broker_cfg.workspace_id,
    )


@router.post("/propose-batch")
async def propose_trade_batch_to_hitl(
    payload: BatchTradeProposalRequest,
    request: Request,
) -> dict[str, Any]:
    """Disassemble a portfolio simulation plan into Risk Critic HITL pending_approval checkpoints."""
    base_settings = get_settings()
    try:
        settings, _ = resolve_llm_settings(base_settings, request.headers)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    infra = request.app.state.infra
    client_ip = request.client.host if request.client else "unknown"
    await _check_guest_rate_limit(infra.redis, client_ip, settings.guest_chat_rpm)

    broker_cfg = resolve_broker_config(settings, request.headers)
    runner = RiskCriticRunner(
        settings,
        request.app.state.session_factory,
        request.app.state.checkpointer,
        broker_config=broker_cfg,
        redis_client=infra.redis,
    )

    proposals: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    base_ts = int(time.time() * 1000)

    for idx, item in enumerate(payload.items):
        sym = item.symbol.upper().strip()
        thread_id = f"batch-{sym}-{base_ts}-{idx}"
        rationale = item.rationale.strip() or f"[{payload.source_label}] 拟拆单 {sym} ({item.side.upper()} {item.proposed_qty:g}股) 交 CRO 逐笔审验"
        try:
            res = await runner.propose_trade(
                thread_id=thread_id,
                symbol=sym,
                side=item.side.lower(),
                proposed_qty=item.proposed_qty,
                entry_price=item.entry_price,
                risk_budget_pct=payload.risk_budget_pct,
                rationale=rationale,
            )
            card = res.get("approval_card") or {}
            sizing = card.get("risk_sizing") or {}
            proposals.append(
                {
                    "thread_id": res.get("thread_id", thread_id),
                    "trade_id": res.get("trade_id"),
                    "symbol": sym,
                    "side": item.side.lower(),
                    "proposed_qty": item.proposed_qty,
                    "recommended_qty": sizing.get("recommended_qty"),
                    "stop_loss_price": sizing.get("stop_loss_price"),
                    "take_profit_price": sizing.get("take_profit_price"),
                    "verdict": (card.get("critique") or {}).get("verdict"),
                }
            )
        except ValueError as exc:
            errors.append({"symbol": sym, "detail": str(exc)})

    return {
        "status": "ok",
        "broker": broker_cfg.provider,
        "queued_count": len(proposals),
        "failed_count": len(errors),
        "proposals": proposals,
        "errors": errors,
    }

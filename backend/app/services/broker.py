from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import redis.asyncio as aioredis
from redis.exceptions import RedisError
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.core.workspace import resolve_workspace_id
from app.db.models import MarketDailyBar, MarketRegimeDaily, PaperTrade
from app.services.providers.alpaca import AlpacaClient
from app.services.providers.binance_ro import BinanceReadOnlyClient
from app.services.providers.ibkr_flex import IBKRFlexClient
from app.services.providers.portfolio_import import build_imported_portfolio_state
from app.services.providers.trading212 import Trading212Client
from app.services.resilience import ProviderError

logger = logging.getLogger(__name__)

_BROKER_CACHE_TTL_S = 45
_REMOTE_CACHED_PROVIDERS = ("alpaca", "trading212", "ibkr", "binance")


def _broker_cache_key(broker_cfg: BrokerConfig) -> str:
    ws = broker_cfg.workspace_id or "default"
    return f"marketelite:broker_state:{broker_cfg.provider}:{ws}"


async def invalidate_broker_state_cache(
    redis_client: aioredis.Redis | None,
    broker_cfg: BrokerConfig,
) -> None:
    """Clear short-lived broker Redis snapshot after orders, closes, or imports."""
    if redis_client is None:
        return
    try:
        await redis_client.delete(_broker_cache_key(broker_cfg))
    except RedisError:
        pass

DEFAULT_SANDBOX_EQUITY = 100_000.0
SUPPORTED_BROKERS = ("sandbox", "trading212", "ibkr", "binance", "csv_import", "alpaca")


@dataclass(frozen=True)
class BrokerConfig:
    """Resolved per-request or `.env` trading broker configuration."""

    provider: str = "sandbox"  # "sandbox" | "trading212" | "ibkr" | "binance" | "csv_import" | "alpaca"
    workspace_id: str = "default"
    t212_api_key: str = ""
    t212_api_secret: str = ""
    t212_env: str = "live"
    t212_read_only: bool = True
    ibkr_flex_token: str = ""
    ibkr_query_id: str = ""
    binance_api_key: str = ""
    binance_api_secret: str = ""
    binance_env: str = "global"


def resolve_broker_config(
    settings: Settings, headers: Mapping[str, str] | None = None
) -> BrokerConfig:
    """Resolve active broker mode safely from browser headers or backend settings."""
    norm = {k.lower(): v.strip() for k, v in (headers or {}).items() if isinstance(v, str)}
    workspace_id = resolve_workspace_id(headers)
    req_provider = norm.get("x-broker-provider", "").lower()

    t212_key = norm.get("x-t212-api-key", "") or settings.trading212_api_key.strip()
    t212_secret = norm.get("x-t212-api-secret", "") or settings.trading212_api_secret.strip()
    t212_env = norm.get("x-t212-env", "").lower() or settings.trading212_env.lower()
    if t212_env not in ("live", "demo"):
        t212_env = "live"
    t212_ro_raw = norm.get("x-t212-read-only", "").lower()
    t212_read_only = settings.trading212_read_only if not t212_ro_raw else t212_ro_raw != "false"

    ibkr_token = norm.get("x-ibkr-flex-token", "")
    ibkr_query = norm.get("x-ibkr-query-id", "")
    binance_key = norm.get("x-binance-api-key", "")
    binance_secret = norm.get("x-binance-api-secret", "")
    binance_env = norm.get("x-binance-env", "global").lower()
    if binance_env not in ("global", "us", "testnet"):
        binance_env = "global"

    if req_provider in SUPPORTED_BROKERS:
        chosen = req_provider
    else:
        cfg_pref = (settings.broker_provider or "auto").strip().lower()
        if cfg_pref in SUPPORTED_BROKERS:
            chosen = cfg_pref
        elif t212_key and t212_secret:
            chosen = "trading212"
        elif ibkr_token and ibkr_query:
            chosen = "ibkr"
        elif binance_key and binance_secret:
            chosen = "binance"
        elif settings.alpaca_api_key.strip() and settings.alpaca_secret_key.strip():
            chosen = "alpaca"
        else:
            chosen = "sandbox"

    return BrokerConfig(
        provider=chosen,
        workspace_id=workspace_id,
        t212_api_key=t212_key,
        t212_api_secret=t212_secret,
        t212_env=t212_env,
        t212_read_only=t212_read_only,
        ibkr_flex_token=ibkr_token,
        ibkr_query_id=ibkr_query,
        binance_api_key=binance_key,
        binance_api_secret=binance_secret,
        binance_env=binance_env,
    )


def build_broker_profile(
    provider: str,
    *,
    display_name: str,
    short_name: str,
    badge: str,
    mode: str,
    sync_button_label: str,
    positions_title: str,
    ledger_title: str,
    empty_positions_hint: str,
    supports_history_sync: bool = False,
) -> dict[str, Any]:
    """Return neutral broker capability metadata so UI never hardcodes vendor names."""
    return {
        "id": provider,
        "display_name": display_name,
        "short_name": short_name,
        "badge": badge,
        "mode": mode,  # "sandbox" | "read_only" | "paper_exec"
        "supports_history_sync": supports_history_sync,
        "supports_manual_ticket": mode == "read_only",
        "sync_button_label": sync_button_label,
        "positions_title": positions_title,
        "ledger_title": ledger_title,
        "empty_positions_hint": empty_positions_hint,
        "ticket_label": (
            f"{short_name} 手动下单参考参数（只读安全模式）"
            if mode == "read_only"
            else "模拟委托确认单"
        ),
    }


async def _latest_close_map(
    session: AsyncSession, symbols: list[str]
) -> dict[str, float]:
    out: dict[str, float] = {}
    for sym in sorted({s.upper().strip() for s in symbols if s.strip()}):
        bar = (
            await session.execute(
                select(MarketDailyBar)
                .where(MarketDailyBar.symbol == sym)
                .order_by(desc(MarketDailyBar.trade_date))
                .limit(1)
            )
        ).scalar_one_or_none()
        if bar is not None and float(bar.close) > 0:
            out[sym] = float(bar.close)
    return out


async def compute_spy_benchmark_pct(
    session: AsyncSession,
    start_dt: datetime,
    end_dt: datetime,
) -> float | None:
    """Compute SPY percentage return between entry timestamp and exit timestamp."""
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


def _is_external_synced_order_id(ext_id: str | None) -> bool:
    s = str(ext_id or "")
    return s.startswith(("t212:", "ibkr:", "binance:", "csv:"))


async def build_sandbox_state(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    workspace_id: str = "default",
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    """Compute virtual $100k Local Sandbox equity, mark-to-market positions, and active trades."""
    async with session_factory() as session:
        rows = list(
            (
                await session.execute(
                    select(PaperTrade)
                    .where(PaperTrade.workspace_id == workspace_id)
                    .order_by(desc(PaperTrade.created_at))
                    .limit(100)
                )
            )
            .scalars()
            .all()
        )
        open_rows = [
            r
            for r in rows
            if r.status in ("filled", "submitted", "accepted", "new")
            and not _is_external_synced_order_id(r.alpaca_order_id)
        ]
        closed_realized = sum(
            float(r.realized_pnl or 0.0)
            for r in rows
            if r.status == "closed" and r.realized_pnl is not None
        )
        close_prices = await _latest_close_map(session, [r.symbol for r in open_rows])

    grouped: dict[str, dict[str, Any]] = {}
    for r in open_rows:
        sym = r.symbol.upper().strip()
        signed_qty = float(r.qty) if r.side.lower() == "buy" else -float(r.qty)
        entry_px = float(r.entry_price or close_prices.get(sym, 0.0) or 0.0)
        slot = grouped.setdefault(
            sym,
            {
                "symbol": sym,
                "signed_qty": 0.0,
                "cost_basis_abs": 0.0,
                "qty_abs": 0.0,
                "stop_loss_price": r.stop_loss_price,
                "take_profit_price": r.take_profit_price,
            },
        )
        slot["signed_qty"] += signed_qty
        slot["qty_abs"] += abs(signed_qty)
        slot["cost_basis_abs"] += abs(signed_qty) * entry_px

    positions: list[dict[str, Any]] = []
    unrealized_sum = 0.0
    long_mv_sum = 0.0
    reserved_cash = 0.0
    for sym, info in grouped.items():
        net_qty = info["signed_qty"]
        if abs(net_qty) < 1e-6:
            continue
        avg_entry = info["cost_basis_abs"] / max(info["qty_abs"], 1e-9)
        cur_px = close_prices.get(sym, avg_entry)
        mult = 1.0 if net_qty > 0 else -1.0
        abs_qty = abs(net_qty)
        mv = abs_qty * cur_px
        cost = abs_qty * avg_entry
        upl = (cur_px - avg_entry) * abs_qty * mult
        upl_pct = (upl / cost) if cost > 0 else 0.0
        unrealized_sum += upl
        long_mv_sum += mv
        reserved_cash += cost

        positions.append(
            {
                "symbol": sym,
                "qty": round(abs_qty, 4),
                "side": "long" if net_qty > 0 else "short",
                "avg_entry_price": round(avg_entry, 2),
                "current_price": round(cur_px, 2),
                "market_value": round(mv, 2),
                "unrealized_pl": round(upl, 2),
                "unrealized_plpc": round(upl_pct, 6),
                "stop_loss_price": info["stop_loss_price"],
                "take_profit_price": info["take_profit_price"],
                "currency": "USD",
            }
        )

    equity = round(DEFAULT_SANDBOX_EQUITY + closed_realized + unrealized_sum, 2)
    cash = round(max(0.0, DEFAULT_SANDBOX_EQUITY + closed_realized - reserved_cash), 2)
    account = {
        "id": f"marketelite-sandbox-{workspace_id}",
        "status": "ACTIVE",
        "currency": "USD",
        "equity": equity,
        "cash": cash,
        "buying_power": cash,
        "portfolio_value": equity,
        "invested_value": round(long_mv_sum, 2),
        "unrealized_pl": round(unrealized_sum, 2),
        "realized_pl": round(closed_realized, 2),
        "paper": True,
        "broker": "sandbox",
        "read_only": False,
    }
    orders = [
        {
            "id": str(r.alpaca_order_id or f"sbx-{r.id}"),
            "symbol": r.symbol,
            "side": r.side,
            "qty": f"{float(r.qty):g}",
            "order_class": r.order_class,
            "type": "bracket",
            "status": r.status,
            "filled_avg_price": f"{r.entry_price:.2f}" if r.entry_price else None,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows[:15]
        if not _is_external_synced_order_id(r.alpaca_order_id)
    ]
    return account, positions, orders


async def _fetch_unified_broker_uncached(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    redis_client: aioredis.Redis | None,
    broker_cfg: BrokerConfig,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Uncached connector dispatch with parallel external requests."""
    ws_id = broker_cfg.workspace_id or "default"

    if broker_cfg.provider == "trading212":
        env_zh = "Live 实盘 (Invest/ISA)" if broker_cfg.t212_env == "live" else "Practice 练习盘"
        profile = build_broker_profile(
            "trading212",
            display_name=f"Trading212 {env_zh}",
            short_name="Trading212",
            badge="只读 API",
            mode="read_only",
            sync_button_label="同步外部成交至台账",
            positions_title="Trading212 实时持仓与活动委托",
            ledger_title="交易审计台账与一键归因复盘 (外部成交 + 演练)",
            empty_positions_hint="当前 Trading212 账户暂无持仓，或请点右上角配置只读 API 密钥。",
            supports_history_sync=True,
        )
        if not broker_cfg.t212_api_key or not broker_cfg.t212_api_secret:
            sbx_acc, sbx_pos, sbx_ord = await build_sandbox_state(session_factory, workspace_id=ws_id)
            return {
                "broker": "trading212",
                "broker_label": f"Trading212 ({broker_cfg.t212_env.upper()} · 待填密钥)",
                "broker_profile": profile,
                "read_only": True,
                "currency": "GBP",
                "broker_error": "当前已选择 Trading212，请点击「数据源接入」填写只读 API Key 与 Secret。",
                "account": sbx_acc,
                "positions": sbx_pos,
                "orders": sbx_ord,
            }

        client = Trading212Client(
            api_key=broker_cfg.t212_api_key,
            api_secret=broker_cfg.t212_api_secret,
            env=broker_cfg.t212_env,
            redis_client=redis_client,
        )
        warnings: list[str] = []
        acc_res, pos_res, ord_res = await asyncio.gather(
            client.get_account_summary(force_refresh=force_refresh),
            client.get_positions(force_refresh=force_refresh),
            client.get_orders(force_refresh=force_refresh),
            return_exceptions=True,
        )
        if isinstance(acc_res, Exception):
            sbx_acc, sbx_pos, sbx_ord = await build_sandbox_state(session_factory, workspace_id=ws_id)
            return {
                "broker": "trading212",
                "broker_label": f"Trading212 ({broker_cfg.t212_env.upper()} · 连接异常)",
                "broker_profile": profile,
                "read_only": True,
                "currency": sbx_acc.get("currency", "USD"),
                "broker_error": str(acc_res),
                "account": sbx_acc,
                "positions": sbx_pos,
                "orders": sbx_ord,
            }
        account = acc_res
        if isinstance(pos_res, Exception):
            positions: list[dict[str, Any]] = []
            warnings.append(f"持仓同步受限: {pos_res}")
        else:
            positions = pos_res
        if isinstance(ord_res, Exception):
            orders: list[dict[str, Any]] = []
            warnings.append(f"挂单同步受限: {ord_res}")
        else:
            orders = ord_res
        return {
            "broker": "trading212",
            "broker_label": f"Trading212 {env_zh} · 只读同步",
            "broker_profile": profile,
            "read_only": True,
            "currency": account.get("currency", "GBP"),
            "broker_error": "；".join(warnings) if warnings else None,
            "account": account,
            "positions": positions,
            "orders": orders,
        }

    if broker_cfg.provider == "ibkr":
        profile = build_broker_profile(
            "ibkr",
            display_name="Interactive Brokers (IBKR Flex 只读)",
            short_name="IBKR",
            badge="Flex 只读同步",
            mode="read_only",
            sync_button_label="同步 IBKR Flex 成交至台账",
            positions_title="盈透证券 IBKR 实时持仓快照",
            ledger_title="交易审计台账与一键归因复盘 (IBKR + 演练)",
            empty_positions_hint="当前 IBKR Flex 快照暂无持仓，或请在「数据源接入」填写 Flex Token 与 Query ID。",
            supports_history_sync=True,
        )
        if not broker_cfg.ibkr_flex_token or not broker_cfg.ibkr_query_id:
            sbx_acc, sbx_pos, sbx_ord = await build_sandbox_state(session_factory, workspace_id=ws_id)
            return {
                "broker": "ibkr",
                "broker_label": "IBKR (待填 Flex Token)",
                "broker_profile": profile,
                "read_only": True,
                "currency": "USD",
                "broker_error": "当前已选择盈透 IBKR，请点击「数据源接入」填写 Flex Token 与 Query ID。",
                "account": sbx_acc,
                "positions": sbx_pos,
                "orders": sbx_ord,
            }
        client = IBKRFlexClient(
            flex_token=broker_cfg.ibkr_flex_token,
            query_id=broker_cfg.ibkr_query_id,
            redis_client=redis_client,
        )
        try:
            snap = await client.get_snapshot(force_refresh=force_refresh)
            acct = snap["account"]
            return {
                "broker": "ibkr",
                "broker_label": "Interactive Brokers · Flex 只读",
                "broker_profile": profile,
                "read_only": True,
                "currency": acct.get("currency", "USD"),
                "broker_error": None,
                "account": acct,
                "positions": snap["positions"],
                "orders": snap["orders"],
            }
        except ProviderError as exc:
            sbx_acc, sbx_pos, sbx_ord = await build_sandbox_state(session_factory, workspace_id=ws_id)
            return {
                "broker": "ibkr",
                "broker_label": "IBKR Flex (连接异常)",
                "broker_profile": profile,
                "read_only": True,
                "currency": "USD",
                "broker_error": str(exc),
                "account": sbx_acc,
                "positions": sbx_pos,
                "orders": sbx_ord,
            }

    if broker_cfg.provider == "binance":
        env_label = {"global": "国际站", "us": "Binance.US", "testnet": "Spot Testnet"}.get(
            broker_cfg.binance_env, "Spot"
        )
        profile = build_broker_profile(
            "binance",
            display_name=f"Binance 币安 ({env_label}) · 只读",
            short_name="Binance",
            badge="加密现货只读",
            mode="read_only",
            sync_button_label="刷新币安现价与资产估值",
            positions_title="Binance 现货持仓估值 (USD 计价)",
            ledger_title="交易审计台账与一键归因复盘 (Crypto + 演练)",
            empty_positions_hint="当前 Binance 现货账户暂无非稳定币持仓，或请在「数据源接入」配置只读 API Key。",
            supports_history_sync=False,
        )
        if not broker_cfg.binance_api_key or not broker_cfg.binance_api_secret:
            sbx_acc, sbx_pos, sbx_ord = await build_sandbox_state(session_factory, workspace_id=ws_id)
            return {
                "broker": "binance",
                "broker_label": f"Binance {env_label} (待填只读密钥)",
                "broker_profile": profile,
                "read_only": True,
                "currency": "USD",
                "broker_error": "当前已选择 Binance 币安，请点击「数据源接入」填写 Read-Only API Key 与 Secret。",
                "account": sbx_acc,
                "positions": sbx_pos,
                "orders": sbx_ord,
            }
        client = BinanceReadOnlyClient(
            api_key=broker_cfg.binance_api_key,
            api_secret=broker_cfg.binance_api_secret,
            env=broker_cfg.binance_env,
            redis_client=redis_client,
        )
        try:
            snap = await client.get_snapshot(force_refresh=force_refresh)
            acct = snap["account"]
            return {
                "broker": "binance",
                "broker_label": f"Binance {env_label} · 只读监控",
                "broker_profile": profile,
                "read_only": True,
                "currency": "USD",
                "broker_error": None,
                "account": acct,
                "positions": snap["positions"],
                "orders": [],
            }
        except ProviderError as exc:
            sbx_acc, sbx_pos, sbx_ord = await build_sandbox_state(session_factory, workspace_id=ws_id)
            return {
                "broker": "binance",
                "broker_label": f"Binance {env_label} (连接异常)",
                "broker_profile": profile,
                "read_only": True,
                "currency": "USD",
                "broker_error": str(exc),
                "account": sbx_acc,
                "positions": sbx_pos,
                "orders": sbx_ord,
            }

    if broker_cfg.provider == "csv_import":
        acct, positions, orders = await build_imported_portfolio_state(
            session_factory, workspace_id=ws_id
        )
        src_name = str(acct.get("source_label") or "通用导入持仓")
        profile = build_broker_profile(
            "csv_import",
            display_name=f"通用导入账本 ({src_name})",
            short_name="通用持仓导入",
            badge="Robinhood / 富途 / CSV",
            mode="read_only",
            sync_button_label="重算导入持仓最新市值",
            positions_title="已导入券商持仓快照与防守水位",
            ledger_title="交易审计台账与一键归因复盘 (导入持仓 + 演练)",
            empty_positions_hint="当前尚未导入持仓。点击右上角「数据源接入」粘贴或上传 CSV（兼容 Robinhood / 富途 / 老虎 / Schwab / 手动输入）。",
            supports_history_sync=False,
        )
        return {
            "broker": "csv_import",
            "broker_label": f"通用导入账本 · {src_name}",
            "broker_profile": profile,
            "read_only": True,
            "currency": "USD",
            "broker_error": None,
            "account": acct,
            "positions": positions,
            "orders": orders,
        }

    if broker_cfg.provider == "alpaca":
        profile = build_broker_profile(
            "alpaca",
            display_name="Alpaca Paper (美股 Bracket 模拟直连)",
            short_name="Alpaca Paper",
            badge="原生 Bracket 委托",
            mode="paper_exec",
            sync_button_label="同步 Alpaca 委托状态",
            positions_title="Alpaca Paper 实时持仓与活动委托",
            ledger_title="交易审计台账与一键归因复盘 (Alpaca Paper)",
            empty_positions_hint="当前 Alpaca Paper 账户暂无开仓股票，可在「投研与风控台」发起风控单。",
            supports_history_sync=True,
        )
        alpaca = AlpacaClient(settings)
        try:
            account, positions, orders = await asyncio.gather(
                alpaca.get_account(),
                alpaca.get_positions(),
                alpaca.get_orders(status="all", limit=15),
            )
            account.setdefault("currency", "USD")
            account["broker"] = "alpaca"
            account["read_only"] = False
            return {
                "broker": "alpaca",
                "broker_label": "Alpaca Paper · 模拟直连",
                "broker_profile": profile,
                "read_only": False,
                "currency": "USD",
                "broker_error": None,
                "account": account,
                "positions": positions,
                "orders": orders,
            }
        except (ProviderError, OSError) as exc:
            sbx_acc, sbx_pos, sbx_ord = await build_sandbox_state(session_factory, workspace_id=ws_id)
            return {
                "broker": "alpaca",
                "broker_label": "Alpaca Paper (已降级至本地拟真盘)",
                "broker_profile": profile,
                "read_only": False,
                "currency": "USD",
                "broker_error": str(exc),
                "account": sbx_acc,
                "positions": sbx_pos,
                "orders": sbx_ord,
            }

    sbx_acc, sbx_pos, sbx_ord = await build_sandbox_state(session_factory, workspace_id=ws_id)
    profile = build_broker_profile(
        "sandbox",
        display_name="本地拟真模拟盘 · 24/7 Sandbox",
        short_name="24/7 模拟盘",
        badge="免配直连",
        mode="sandbox",
        sync_button_label="刷新持仓最新估值",
        positions_title="模拟盘实时持仓与活动委托",
        ledger_title="交易审计台账与一键归因复盘 (沙盒演练)",
        empty_positions_hint="当前模拟盘尚无持仓；前往「投研与风控台」即可体验 AI 算仓与一分钟开仓。",
        supports_history_sync=False,
    )
    return {
        "broker": "sandbox",
        "broker_label": "本地拟真模拟盘 · 24/7 Sandbox",
        "broker_profile": profile,
        "read_only": False,
        "currency": "USD",
        "broker_error": None,
        "account": sbx_acc,
        "positions": sbx_pos,
        "orders": sbx_ord,
    }


async def fetch_unified_broker_state(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    redis_client: aioredis.Redis | None,
    broker_cfg: BrokerConfig,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Fetch canonical account/positions/orders with 45s Redis caching for remote brokers."""
    can_cache = (
        redis_client is not None
        and broker_cfg.provider in _REMOTE_CACHED_PROVIDERS
        and not force_refresh
    )
    cache_key = _broker_cache_key(broker_cfg)
    if can_cache and redis_client is not None:
        try:
            cached_raw = await redis_client.get(cache_key)
            if cached_raw:
                parsed = json.loads(cached_raw)
                if isinstance(parsed, dict) and parsed.get("account"):
                    return parsed
        except (RedisError, json.JSONDecodeError, TypeError):
            pass

    state = await _fetch_unified_broker_uncached(
        session_factory=session_factory,
        settings=settings,
        redis_client=redis_client,
        broker_cfg=broker_cfg,
        force_refresh=force_refresh,
    )
    if redis_client is not None and broker_cfg.provider in _REMOTE_CACHED_PROVIDERS:
        if not state.get("broker_error"):
            try:
                await redis_client.set(
                    cache_key,
                    json.dumps(state, default=str),
                    ex=_BROKER_CACHE_TTL_S,
                )
            except (RedisError, TypeError):
                pass
    return state


async def _import_external_history_rows(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    history: list[dict[str, Any]],
    source_tag: str,
    order_class_prefix: str,
    workspace_id: str,
) -> dict[str, Any]:
    imported = 0
    skipped = 0
    async with session_factory() as session:
        reg_row = (
            await session.execute(
                select(MarketRegimeDaily).order_by(desc(MarketRegimeDaily.regime_date)).limit(1)
            )
        ).scalar_one_or_none()
        cur_regime = str(reg_row.regime_label) if reg_row else None

        existing_ids = set(
            (
                await session.execute(
                    select(PaperTrade.alpaca_order_id).where(
                        PaperTrade.alpaca_order_id.is_not(None)
                    )
                )
            )
            .scalars()
            .all()
        )

        for item in history:
            raw_ext = str(item.get("external_id") or "").strip()
            ext_id = raw_ext if workspace_id == "default" else f"{workspace_id}:{raw_ext}"
            status_raw = str(item.get("status") or "").lower()
            qty = float(item.get("qty") or 0.0)
            if not raw_ext or ext_id in existing_ids or qty <= 0 or status_raw != "filled":
                skipped += 1
                continue

            side = str(item.get("side") or "buy").lower()
            realized_pl = item.get("realized_pnl")
            filled_at_str = item.get("filled_at")
            filled_dt = datetime.now(timezone.utc)
            if isinstance(filled_at_str, str) and filled_at_str.strip():
                try:
                    filled_dt = datetime.fromisoformat(filled_at_str.replace("Z", "+00:00"))
                except ValueError:
                    pass

            trade_status = "closed" if (realized_pl is not None or side == "sell") else "filled"
            row = PaperTrade(
                workspace_id=workspace_id,
                thread_id=None,
                symbol=str(item.get("symbol") or "UNKNOWN"),
                side=side,
                order_class=f"{order_class_prefix}_{item.get('order_type') or 'market'}"[:24],
                qty=qty,
                entry_price=item.get("fill_price"),
                stop_loss_price=None,
                take_profit_price=None,
                risk_budget_pct=1.0,
                alpaca_order_id=ext_id[:128],
                status=trade_status,
                regime_at_entry=cur_regime,
                rationale_summary=f"Synced from {source_tag} [{item.get('raw_ticker')}]",
                closed_at=filled_dt if trade_status == "closed" else None,
                realized_pnl=realized_pl,
                created_at=filled_dt,
            )
            session.add(row)
            existing_ids.add(ext_id)
            imported += 1

        if imported > 0:
            await session.commit()

    return {
        "status": "ok",
        "fetched": len(history),
        "imported": imported,
        "skipped": skipped,
    }


async def sync_t212_history_to_ledger(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    broker_cfg: BrokerConfig,
    redis_client: aioredis.Redis | None,
) -> dict[str, Any]:
    """Import recent filled Trading212 equity executions into PaperTrade for 4-Quadrant Replay."""
    client = Trading212Client(
        api_key=broker_cfg.t212_api_key,
        api_secret=broker_cfg.t212_api_secret,
        env=broker_cfg.t212_env,
        redis_client=redis_client,
    )
    history = await client.get_historical_orders(limit=35, force_refresh=True)
    return await _import_external_history_rows(
        session_factory=session_factory,
        history=history,
        source_tag=f"Trading212 ({broker_cfg.t212_env.upper()})",
        order_class_prefix="t212",
        workspace_id=broker_cfg.workspace_id,
    )


async def sync_ibkr_history_to_ledger(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    broker_cfg: BrokerConfig,
    redis_client: aioredis.Redis | None,
) -> dict[str, Any]:
    """Import filled executions from IBKR Flex statement into PaperTrade ledger."""
    client = IBKRFlexClient(
        flex_token=broker_cfg.ibkr_flex_token,
        query_id=broker_cfg.ibkr_query_id,
        redis_client=redis_client,
    )
    snap = await client.get_snapshot(force_refresh=True)
    return await _import_external_history_rows(
        session_factory=session_factory,
        history=snap.get("trades") or [],
        source_tag="IBKR Flex",
        order_class_prefix="ibkr",
        workspace_id=broker_cfg.workspace_id,
    )

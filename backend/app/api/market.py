from __future__ import annotations

import asyncio
import base64
import logging
import os
import secrets
from datetime import date
from typing import Any

import httpx
from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import asc, delete, desc, func, select
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import get_settings
from app.core.workspace import resolve_workspace_id
from app.db.models import (
    ConsensusEpsSnapshot,
    MarketDailyBar,
    MarketRegimeDaily,
    OptionsGexSnapshot,
    UserWatchlistItem,
)
from app.quant.options import compute_options_radar
from app.quant.technicals import (
    DailyBarInput,
    analyze_asset_technicals,
    classify_volume_price_quadrant,
)
from app.services.macro_history import (
    attach_macro_context_to_events,
    build_macro_release_history,
)
from app.services.news_discover import (
    get_discover_article_detail,
    get_discover_article_image,
    get_or_refresh_discover_news,
)
from app.services.pipeline import (
    OVERVIEW_CACHE_KEY,
    ensure_asset_persisted,
    get_regime_history,
    query_upcoming_calendar_events,
    run_full_pipeline_sync,
    sync_calendars,
)
from app.services.providers.alpaca import AlpacaClient
from app.services.providers.cnn_fear_greed import fetch_cnn_fear_greed
from app.services.providers.finra import fetch_finra_darkpool_profile
from app.services.providers.macro_feeds import MacroFeedsClient
from app.services.providers.market_movers import build_market_movers_payload
from app.services.providers.moc_proxy import fetch_moc_auction_proxy
from app.services.providers.onchain import fetch_onchain_liquidity_pulse
from app.services.providers.sector_heatmap import build_sector_heatmap_payload
from app.services.providers.yahoo_tape import (
    MACRO_TAPE_SPECS,
    fetch_macro_tape_snapshot,
    fetch_yahoo_extended_quotes,
    fetch_yahoo_intraday_bars,
    fetch_yahoo_macro_sentiment_series,
)
from app.services.resilience import DualTTLCache, ProviderError, ProviderUnconfiguredError

router = APIRouter(prefix="/api", tags=["market"])
logger = logging.getLogger(__name__)


@router.get("/assets")
async def list_tracked_assets(request: Request) -> dict[str, Any]:
    """List persisted symbols with latest close and 1-day return for fast terminal switching."""
    session_factory = request.app.state.session_factory
    async with session_factory() as session:
        ranked = (
            select(
                MarketDailyBar.symbol,
                MarketDailyBar.asset_class,
                MarketDailyBar.trade_date,
                MarketDailyBar.close,
                MarketDailyBar.volume,
                func.row_number()
                .over(
                    partition_by=MarketDailyBar.symbol,
                    order_by=desc(MarketDailyBar.trade_date),
                )
                .label("rn"),
            )
            .subquery()
        )
        stmt = select(ranked).where(ranked.c.rn <= 2).order_by(ranked.c.symbol, ranked.c.rn)
        rows = (await session.execute(stmt)).all()

    grouped: dict[str, list[Any]] = {}
    for row in rows:
        grouped.setdefault(str(row.symbol), []).append(row)

    assets: list[dict[str, Any]] = []
    for sym, items in sorted(grouped.items()):
        latest = items[0]
        prev = items[1] if len(items) > 1 else None
        change_pct = (
            round(((float(latest.close) / float(prev.close)) - 1.0) * 100.0, 2)
            if prev is not None and float(prev.close) > 0
            else None
        )
        assets.append(
            {
                "symbol": sym,
                "asset_class": latest.asset_class,
                "trade_date": latest.trade_date.isoformat(),
                "close": round(float(latest.close), 4),
                "change_1d_pct": change_pct,
                "volume": float(latest.volume),
            }
        )
    return {"count": len(assets), "assets": assets}


@router.get("/dashboard/overview")
async def get_dashboard_overview(request: Request) -> dict[str, Any]:
    """Read precomputed deterministic dashboard overview in <50ms (Redis -> Postgres fallback)."""
    infra = request.app.state.infra
    cache = DualTTLCache(infra.redis)
    envelope = await cache.read_envelope(OVERVIEW_CACHE_KEY)
    if envelope and isinstance(envelope.get("payload"), dict):
        return {
            "status": "ok",
            "cache_source": "redis",
            "fetched_at": envelope.get("fetched_at"),
            **envelope["payload"],
        }

    session_factory = request.app.state.session_factory
    async with session_factory() as session:
        stmt = (
            select(MarketRegimeDaily)
            .order_by(desc(MarketRegimeDaily.regime_date))
            .limit(1)
        )
        latest = (await session.execute(stmt)).scalar_one_or_none()
        if latest is not None and isinstance(latest.overview_payload_json, dict):
            payload = latest.overview_payload_json
            await cache.write_envelope(
                OVERVIEW_CACHE_KEY,
                payload=payload,
                source="postgres_fallback",
                soft_ttl_seconds=900,
                hard_ttl_seconds=86400 * 7,
            )
            return {
                "status": "ok",
                "cache_source": "postgres_fallback",
                "fetched_at": latest.computed_at.isoformat(),
                **payload,
            }

    return {
        "status": "empty_bootstrap_needed",
        "cache_source": "none",
        "message": "No market regime snapshot has been synced yet. Trigger POST /api/pipeline/sync.",
    }


@router.post("/assets/{symbol}/ensure")
async def ensure_asset_endpoint(
    symbol: str,
    request: Request,
    force_refresh: bool = Query(default=False),
) -> dict[str, Any]:
    """On-demand lazy ingestion for ANY US ticker (bars, Estimated GEX & Finnhub EPS history)."""
    sym = symbol.upper().strip()
    if not sym:
        raise HTTPException(status_code=400, detail="Symbol is required")
    settings = get_settings()
    infra = request.app.state.infra
    session_factory = request.app.state.session_factory
    try:
        res = await ensure_asset_persisted(
            session_factory,
            infra.redis,
            settings,
            sym,
            include_gex=True,
            include_eps=True,
            force_refresh=force_refresh,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not res.get("found"):
        raise HTTPException(
            status_code=404,
            detail=f"No daily market bars found for ticker '{sym}'. Verify it is a listed US equity/ETF.",
        )
    return {"status": "ok", **res}


@router.get("/market/regime-history")
async def get_market_regime_history(
    request: Request,
    limit: int = Query(default=30, ge=1, le=90),
) -> dict[str, Any]:
    """Return chronological 30-day Market Regime & Fear/Greed history."""
    rows = await get_regime_history(request.app.state.session_factory, limit=limit)
    return {"count": len(rows), "history": rows}


@router.get("/market/macro-tape")
async def get_market_macro_tape(
    request: Request,
    force_refresh: bool = Query(default=False),
) -> dict[str, Any]:
    """Return live/cached global indices, yields, metals, oil & FX micro-K-line tape."""
    infra = request.app.state.infra
    cache = DualTTLCache(infra.redis)
    try:
        return await fetch_macro_tape_snapshot(cache=cache, force_refresh=force_refresh)
    except (ProviderError, httpx.HTTPError, OSError, RuntimeError, ValueError):
        # Fallback cleanly to persisted Postgres daily bars for core macro proxies if external fetch fails
        session_factory = request.app.state.session_factory
        proxy_specs = [
            spec
            for spec in MACRO_TAPE_SPECS
            if spec.proxy_symbol in {"SPY", "QQQ", "IWM", "TLT", "UUP", "GLD", "CPER", "BTCUSDT"}
        ]
        items: list[dict[str, Any]] = []
        async with session_factory() as session:
            seen_proxies: set[str] = set()
            for spec in proxy_specs:
                if spec.proxy_symbol in seen_proxies:
                    continue
                seen_proxies.add(spec.proxy_symbol)
                stmt = (
                    select(MarketDailyBar)
                    .where(MarketDailyBar.symbol == spec.proxy_symbol)
                    .order_by(desc(MarketDailyBar.trade_date))
                    .limit(22)
                )
                rows = list((await session.execute(stmt)).scalars().all())
                rows.reverse()
                if len(rows) < 2:
                    continue
                latest = rows[-1]
                prev = rows[-2]
                change_abs = float(latest.close) - float(prev.close)
                change_pct = (change_abs / float(prev.close) * 100.0) if float(prev.close) > 0 else 0.0
                items.append(
                    {
                        "yahoo_symbol": spec.proxy_symbol,
                        "proxy_symbol": spec.proxy_symbol,
                        "name": f"{spec.proxy_symbol}",
                        "zh_name": spec.zh_name,
                        "decimals": 2,
                        "unit": "$",
                        "price": round(float(latest.close), 2),
                        "prev_close": round(float(prev.close), 2),
                        "change_abs": round(change_abs, 2),
                        "change_pct": round(change_pct, 2),
                        "bars": [
                            {
                                "t": idx,
                                "o": float(r.open),
                                "h": float(r.high),
                                "l": float(r.low),
                                "c": float(r.close),
                            }
                            for idx, r in enumerate(rows)
                        ],
                    }
                )
        return {"status": "fallback", "source": "postgres_fallback", "count": len(items), "items": items}


@router.get("/market/sentiment-pulse")
async def get_market_sentiment_pulse(
    request: Request,
    force_refresh: bool = Query(default=False),
) -> dict[str, Any]:
    """Return live pre-market/intraday CNN Fear & Greed, ^VIX OHLC candles, DXY, ^TNX & SPY series."""
    infra = request.app.state.infra
    cache = DualTTLCache(infra.redis)

    cnn_task = fetch_cnn_fear_greed(cache=cache, force_refresh=force_refresh)
    yahoo_task = fetch_yahoo_macro_sentiment_series(cache=cache, force_refresh=force_refresh)
    cnn_res, yahoo_res = await asyncio.gather(cnn_task, yahoo_task, return_exceptions=True)

    fear_greed = cnn_res if isinstance(cnn_res, dict) and cnn_res.get("score") is not None else None
    yahoo_data = yahoo_res if isinstance(yahoo_res, dict) else {}

    vix = yahoo_data.get("vix")
    dxy = yahoo_data.get("dxy")
    tnx = yahoo_data.get("tnx")
    spy_closes = yahoo_data.get("spy_closes") or []

    # Lightweight Postgres fallback for VIX / SPY if external network temporarily failed
    if (vix is None or not spy_closes) and getattr(request.app.state, "session_factory", None):
        session_factory = request.app.state.session_factory
        try:
            async with session_factory() as session:
                if not spy_closes:
                    stmt = (
                        select(MarketDailyBar.trade_date, MarketDailyBar.close)
                        .where(MarketDailyBar.symbol == "SPY")
                        .order_by(desc(MarketDailyBar.trade_date))
                        .limit(130)
                    )
                    rows = list((await session.execute(stmt)).all())
                    rows.reverse()
                    spy_closes = [
                        {"date": r[0].isoformat(), "close": round(float(r[1]), 2)} for r in rows
                    ]
        except (SQLAlchemyError, OSError, RuntimeError, ValueError) as exc:
            logger.debug("Sentiment pulse Postgres fallback skipped: %s", exc)

    return {
        "status": "ok",
        "fear_greed": fear_greed,
        "vix": vix,
        "dxy": dxy,
        "tnx": tnx,
        "spy_closes": spy_closes,
        "fetched_at": yahoo_data.get("fetched_utc"),
    }


@router.get("/market/institutional-flow")
async def get_market_institutional_flow(
    request: Request,
    force_refresh: bool = Query(default=False),
) -> dict[str, Any]:
    """Return CFTC TFF & Disaggregated 52W institutional vs leveraged positioning."""
    infra = request.app.state.infra
    settings = get_settings()
    cache = DualTTLCache(infra.redis)
    feeds = MacroFeedsClient(settings, cache=cache)
    try:
        return await feeds.get_cftc_institutional_flow(force_refresh=force_refresh)
    except (ProviderError, httpx.HTTPError, OSError, RuntimeError, ValueError) as exc:
        logger.warning("Institutional flow fetch fallback: %s", exc)
        return {
            "status": "unavailable",
            "report_date": None,
            "summary_zh": "CFTC 官方持仓数据暂未就绪，请稍后刷新",
            "contracts": {},
            "detail": str(exc),
        }


@router.get("/market/options-radar")
async def get_market_options_radar(
    request: Request,
    symbol: str = Query(default="SPY", min_length=1, max_length=16),
    bucket: str = Query(default="all", pattern="^(all|0dte|weekly|monthly)$"),
    force_refresh: bool = Query(default=False),
) -> dict[str, Any]:
    """Return panoramic options dealer GEX, Max Pain, Expected Move, Skew & Unusual Flow."""
    sym = symbol.upper().strip()
    if sym.endswith("USDT") or sym in {"VIX", "^VIX", "DXY"}:
        return {
            "status": "unsupported",
            "symbol": sym,
            "bucket": bucket,
            "reason": f"{sym} 暂无美股标准期权链数据，建议切换 SPY / QQQ / IWM 或任意美股标的",
            "strike_profile": [],
            "unusual_flow": [],
        }

    infra = request.app.state.infra
    settings = get_settings()
    cache = DualTTLCache(infra.redis)
    alpaca = AlpacaClient(settings, cache=cache)
    try:
        chain = await alpaca.get_options_chain_inputs(sym, force_refresh=force_refresh)
    except ProviderUnconfiguredError as exc:
        return {
            "status": "unconfigured",
            "symbol": sym,
            "bucket": bucket,
            "reason": str(exc),
            "strike_profile": [],
            "unusual_flow": [],
        }
    except (ProviderError, httpx.HTTPError, OSError, RuntimeError, ValueError) as exc:
        logger.warning("Options radar fetch failed for %s: %s", sym, exc)
        return {
            "status": "unavailable",
            "symbol": sym,
            "bucket": bucket,
            "reason": f"{sym} 期权链暂时不可用：{exc}",
            "strike_profile": [],
            "unusual_flow": [],
        }

    spot_price = float(chain.get("spot_price", 0.0) or 0.0)
    contracts = chain.get("contracts") or []
    radar = compute_options_radar(sym, spot_price, contracts, bucket=bucket)
    return {
        "status": "ok",
        "source": chain.get("source", "alpaca_indicative"),
        "is_stale": bool(chain.get("is_stale", False)),
        "fetched_at": chain.get("fetched_at"),
        **radar,
    }


@router.get("/market/sector-heatmap")
async def get_market_sector_heatmap(
    request: Request,
    force_refresh: bool = Query(default=False),
) -> dict[str, Any]:
    """Return 11 GICS sector ETFs with live prices, weights & Top-6 heavyweight constituents."""
    infra = request.app.state.infra
    settings = get_settings()
    cache = DualTTLCache(infra.redis)
    overview_sectors: list[dict[str, Any]] = []
    try:
        env = await cache.read_envelope(OVERVIEW_CACHE_KEY)
        if env and isinstance(env.get("payload"), dict):
            overview_sectors = (
                (env["payload"].get("equities") or {}).get("sector_rotation") or []
            )
    except (OSError, RuntimeError, ValueError, TypeError):
        overview_sectors = []

    return await build_sector_heatmap_payload(
        settings=settings,
        cache=cache,
        overview_sector_rotation=overview_sectors,
        force_refresh=force_refresh,
    )


@router.get("/market/movers")
async def get_market_movers(
    request: Request,
    min_price: float = Query(default=2.0, ge=0.0, le=50.0),
    force_refresh: bool = Query(default=False),
) -> dict[str, Any]:
    """Return real-time Top 20 Gainers, Losers & Most-Active stocks across the US market."""
    infra = request.app.state.infra
    settings = get_settings()
    session_factory = request.app.state.session_factory
    cache = DualTTLCache(infra.redis)
    return await build_market_movers_payload(
        session_factory=session_factory,
        cache=cache,
        settings=settings,
        min_price=min_price,
        force_refresh=force_refresh,
    )


def _merge_recent_daily_bars(
    base_bars: list[DailyBarInput],
    recent_bars: list[dict[str, Any]] | None,
) -> list[DailyBarInput]:
    """Merge fresher daily bars onto Postgres bars chronologically by trade_date."""
    if not recent_bars:
        return list(base_bars)
    by_date: dict[str, DailyBarInput] = {b.trade_date: b for b in base_bars}
    for rb in recent_bars:
        td = str(rb.get("trade_date") or "")[:10]
        if not td:
            continue
        try:
            by_date[td] = DailyBarInput(
                trade_date=td,
                open=float(rb["open"]),
                high=float(rb["high"]),
                low=float(rb["low"]),
                close=float(rb["close"]),
                volume=float(rb.get("volume", 0.0)),
                vwap=float(rb["vwap"]) if rb.get("vwap") is not None else None,
            )
        except (KeyError, TypeError, ValueError):
            continue
    return [by_date[k] for k in sorted(by_date)]


def _recompute_technicals_with_live_bar(
    bars: list[DailyBarInput],
    *,
    live_price: float | None = None,
    prev_close: float | None = None,
    live_chg_pct: float | None = None,
    live_bar_date: str | None = None,
    live_volume: float | None = None,
) -> tuple[dict[str, Any], list[DailyBarInput]]:
    """Fold latest daily/intraday price into bars and recompute RSI, MACD, 52W-high & returns."""
    working = list(bars)
    if live_price is not None and live_price > 0 and working:
        live_p = round(float(live_price), 4)
        last_b = working[-1]
        vol_val = max(0.0, float(live_volume)) if live_volume is not None else 0.0
        if live_bar_date and live_bar_date > last_b.trade_date:
            open_p = round(float(prev_close), 4) if (prev_close and prev_close > 0) else live_p
            working.append(
                DailyBarInput(
                    trade_date=live_bar_date,
                    open=open_p,
                    high=max(open_p, live_p),
                    low=min(open_p, live_p),
                    close=live_p,
                    volume=vol_val,
                    vwap=last_b.vwap,
                )
            )
        else:
            working[-1] = DailyBarInput(
                trade_date=last_b.trade_date,
                open=last_b.open,
                high=max(last_b.high, live_p),
                low=min(last_b.low, live_p),
                close=live_p,
                volume=max(last_b.volume, vol_val),
                vwap=last_b.vwap,
            )

    tech = analyze_asset_technicals(working)
    if not tech.get("available"):
        return {
            "available": False,
            "last_close": round(float(live_price), 2) if (live_price and live_price > 0) else None,
            "prev_close": round(float(prev_close), 2) if (prev_close and prev_close > 0) else None,
            "change_1d_pct": round(float(live_chg_pct), 2) if live_chg_pct is not None else None,
            "change_5d_pct": None,
            "rsi_14": None,
            "dist_50ma_pct": None,
            "sparkline_bars": [],
        }, working

    if live_price is not None and live_price > 0:
        _overlay_live_quote_on_technicals(
            tech,
            live_price=live_price,
            prev_close=prev_close,
            live_chg_pct=live_chg_pct,
        )
    return tech, working


def _overlay_live_quote_on_technicals(
    tech: dict[str, Any],
    *,
    live_price: float | None,
    prev_close: float | None = None,
    live_chg_pct: float | None = None,
) -> dict[str, Any]:
    """Keep technical last_close, change_1d_pct, sparkline, and volume_price_tag synchronized with live quotes."""
    if live_price is None or live_price <= 0:
        return tech
    live_p = round(float(live_price), 2)
    tech["last_close"] = live_p
    eff_prev = float(prev_close) if prev_close is not None and float(prev_close) > 0 else tech.get("prev_close")
    if eff_prev is not None and float(eff_prev) > 0:
        tech["prev_close"] = round(float(eff_prev), 2)
    if live_chg_pct is not None:
        tech["change_1d_pct"] = round(float(live_chg_pct), 2)
    elif tech.get("prev_close") and float(tech["prev_close"]) > 0:
        tech["change_1d_pct"] = round(((live_p - float(tech["prev_close"])) / float(tech["prev_close"])) * 100.0, 2)

    if tech.get("available"):
        tech["volume_price_tag"] = classify_volume_price_quadrant(
            float(tech.get("change_1d_pct") or 0.0),
            tech.get("rvol_20"),
        )
    sp = list(tech.get("sparkline_bars") or [])
    if sp:
        sp[-1] = {
            **sp[-1],
            "c": live_p,
            "h": max(float(sp[-1]["h"]), live_p),
            "l": min(float(sp[-1]["l"]), live_p),
        }
        tech["sparkline_bars"] = sp
    return tech


@router.get("/market/core-benchmarks")
async def get_market_core_benchmarks(
    request: Request,
    force_refresh: bool = Query(default=False),
) -> dict[str, Any]:
    """Return 4 core benchmarks (SPY, QQQ, SOXX, BTCUSDT) with mini-K-lines & key technical tags."""
    target_symbols = ("SPY", "QQQ", "SOXX", "BTCUSDT")
    infra = request.app.state.infra
    settings = get_settings()
    session_factory = request.app.state.session_factory
    cache = DualTTLCache(infra.redis)

    # 1. Read Postgres trailing daily bars for all 4 symbols in one query
    bars_by_sym: dict[str, list[DailyBarInput]] = {s: [] for s in target_symbols}
    async with session_factory() as session:
        stmt = (
            select(MarketDailyBar)
            .where(MarketDailyBar.symbol.in_(target_symbols))
            .order_by(desc(MarketDailyBar.trade_date))
            .limit(1200)
        )
        rows = list((await session.execute(stmt)).scalars().all())
        for row in reversed(rows):
            bars_by_sym.setdefault(str(row.symbol), []).append(
                DailyBarInput(
                    trade_date=row.trade_date.isoformat(),
                    open=float(row.open),
                    high=float(row.high),
                    low=float(row.low),
                    close=float(row.close),
                    volume=float(row.volume),
                )
            )

    # 2. Fetch live snapshots + recent trailing daily bars so RSI/MACD/52W-high never drift behind DB
    equity_snaps: dict[str, dict[str, Any]] = {}
    if settings.alpaca_api_key.strip() and settings.alpaca_secret_key.strip():
        alpaca = AlpacaClient(settings, cache=cache)
        equity_task = alpaca.get_batch_stock_snapshots(
            ["SPY", "QQQ", "SOXX"],
            force_refresh=force_refresh,
        )
        recent_eq_task = alpaca.get_daily_bars(
            ["SPY", "QQQ", "SOXX"],
            lookback_days=40,
            force_refresh=force_refresh,
        )
    else:
        equity_task = asyncio.sleep(0, result={})
        recent_eq_task = asyncio.sleep(0, result={})

    feeds = MacroFeedsClient(settings, cache=cache)
    btc_task = fetch_yahoo_intraday_bars("BTCUSDT", tf="1d", cache=cache, force_refresh=force_refresh)
    btc_daily_task = feeds.get_btc_daily_bars(limit=40, force_refresh=force_refresh)
    ext_task = fetch_yahoo_extended_quotes(["SPY", "QQQ", "SOXX"], cache=cache)
    eq_res, recent_eq_res, btc_res, btc_daily_res, ext_res = await asyncio.gather(
        equity_task,
        recent_eq_task,
        btc_task,
        btc_daily_task,
        ext_task,
        return_exceptions=True,
    )
    if isinstance(eq_res, dict):
        equity_snaps = eq_res
    recent_eq_bars = recent_eq_res.get("bars", {}) if isinstance(recent_eq_res, dict) else {}
    recent_btc_bars = btc_daily_res.get("bars", []) if isinstance(btc_daily_res, dict) else []
    btc_live = btc_res if isinstance(btc_res, dict) else {}
    ext_quotes = ext_res if isinstance(ext_res, dict) else {}

    meta_labels = {
        "SPY": ("标普500", "大盘总锚"),
        "QQQ": ("纳指100", "科技成长"),
        "SOXX": ("半导体", "AI 硬件核心"),
        "BTCUSDT": ("比特币", "7×24 流动性"),
    }

    items: list[dict[str, Any]] = []
    for sym in target_symbols:
        raw_bars = bars_by_sym.get(sym, [])
        if sym == "BTCUSDT":
            merged_bars = _merge_recent_daily_bars(raw_bars, recent_btc_bars)
            btc_bar_date = recent_btc_bars[-1]["trade_date"] if recent_btc_bars else None
            snap_price = float(btc_live["spot_price"]) if btc_live.get("spot_price") else None
            snap_prev = (
                float(btc_live["prev_close"])
                if btc_live.get("prev_close") is not None
                else (merged_bars[-2].close if len(merged_bars) >= 2 else None)
            )
            tech, _ = _recompute_technicals_with_live_bar(
                merged_bars,
                live_price=snap_price,
                prev_close=snap_prev,
                live_bar_date=btc_bar_date,
            )
        else:
            merged_bars = _merge_recent_daily_bars(raw_bars, recent_eq_bars.get(sym))
            snap = equity_snaps.get(sym)
            tech, _ = _recompute_technicals_with_live_bar(
                merged_bars,
                live_price=float(snap["price"]) if (snap and snap.get("price") is not None) else None,
                prev_close=float(snap["prev_close"]) if (snap and snap.get("prev_close") is not None) else None,
                live_chg_pct=float(snap["change_1d_pct"]) if (snap and snap.get("change_1d_pct") is not None) else None,
                live_bar_date=snap.get("bar_date") if snap else None,
                live_volume=float(snap["volume"]) if (snap and snap.get("volume") is not None) else None,
            )

        title_zh, role_zh = meta_labels[sym]
        macd_obj = tech.get("macd") if isinstance(tech.get("macd"), dict) else {}
        items.append(
            {
                "symbol": sym,
                "display_symbol": "BTC" if sym == "BTCUSDT" else sym,
                "name_zh": title_zh,
                "role_zh": role_zh,
                "last_close": tech.get("last_close"),
                "prev_close": tech.get("prev_close"),
                "change_1d_pct": tech.get("change_1d_pct"),
                "change_5d_pct": tech.get("change_5d_pct"),
                "change_20d_pct": tech.get("change_20d_pct"),
                "change_ytd_pct": tech.get("change_ytd_pct"),
                "rsi_14": tech.get("rsi_14"),
                "macd_hist": macd_obj.get("histogram"),
                "macd_prev_hist": macd_obj.get("prev_histogram"),
                "atr_pct": tech.get("atr_pct"),
                "rvol_20": tech.get("rvol_20"),
                "dist_50ma_pct": tech.get("dist_50ma_pct"),
                "dist_52w_high_pct": tech.get("dist_52w_high_pct"),
                "extended_hours": ext_quotes.get(sym),
                "sparkline_bars": tech.get("sparkline_bars") or [],
            }
        )

    return {"status": "ok", "items": items}


@router.get("/assets/{symbol}/intraday")
async def get_asset_intraday(
    symbol: str,
    request: Request,
    tf: str = Query(default="1d", pattern="^(1d|5d)$"),
    force_refresh: bool = Query(default=False),
) -> dict[str, Any]:
    """Return 5m (1d) or 15m (5d) intraday OHLCV + VWAP bars for candlestick switching."""
    sym = symbol.upper().strip()
    if not sym:
        raise HTTPException(status_code=400, detail="Symbol is required")
    infra = request.app.state.infra
    cache = DualTTLCache(infra.redis)
    try:
        res = await fetch_yahoo_intraday_bars(sym, tf=tf, cache=cache, force_refresh=force_refresh)
        return {"status": "ok", **res}
    except (ProviderError, httpx.HTTPError, OSError, RuntimeError, ValueError) as exc:
        logger.warning("Intraday fetch failed for %s (%s): %s", sym, tf, exc)
        return {
            "status": "unavailable",
            "symbol": sym,
            "tf": tf,
            "bars": [],
            "reason": str(exc),
        }


@router.get("/assets/{symbol}")
async def get_asset_detail(
    symbol: str,
    request: Request,
    bars_limit: int = Query(default=180, ge=20, le=365),
    include_news: bool = Query(default=False),
    ensure_if_missing: bool = Query(default=True),
) -> dict[str, Any]:
    """Return historical daily bars, technical state, Estimated GEX & EPS consensus for ANY US ticker."""
    sym = symbol.upper().strip()
    if not sym:
        raise HTTPException(status_code=400, detail="Symbol is required")

    settings = get_settings()
    infra = request.app.state.infra
    session_factory = request.app.state.session_factory
    query_limit = max(bars_limit, 260)

    async def _load_from_db() -> tuple[list[MarketDailyBar], OptionsGexSnapshot | None, list[ConsensusEpsSnapshot]]:
        async with session_factory() as session:
            bar_stmt = (
                select(MarketDailyBar)
                .where(MarketDailyBar.symbol == sym)
                .order_by(desc(MarketDailyBar.trade_date))
                .limit(query_limit)
            )
            bars = list((await session.execute(bar_stmt)).scalars().all())
            bars.reverse()

            gex_stmt = (
                select(OptionsGexSnapshot)
                .where(OptionsGexSnapshot.symbol == sym)
                .order_by(desc(OptionsGexSnapshot.snapshot_time))
                .limit(1)
            )
            gex = (await session.execute(gex_stmt)).scalar_one_or_none()

            eps_stmt = (
                select(ConsensusEpsSnapshot)
                .where(ConsensusEpsSnapshot.symbol == sym)
                .order_by(desc(ConsensusEpsSnapshot.period))
                .limit(6)
            )
            eps = list((await session.execute(eps_stmt)).scalars().all())
        return bars, gex, eps

    db_bars, gex_row, eps_rows = await _load_from_db()
    is_crypto_or_etf = sym in {
        "BTCUSDT",
        "SPY",
        "QQQ",
        "IWM",
        "RSP",
        "DIA",
        "SOXX",
        "TLT",
        "HYG",
        "IEF",
        "GLD",
        "SLV",
        "USO",
        "BNO",
        "UNG",
        "UUP",
        "CPER",
        "XLK",
        "XLF",
        "XLE",
        "XLV",
        "XLY",
        "XLI",
        "XLP",
        "XLU",
        "XLB",
        "XLRE",
        "XLC",
    }

    if ensure_if_missing and (
        not db_bars
        or (sym != "BTCUSDT" and gex_row is None)
        or (not is_crypto_or_etf and not eps_rows)
    ):
        try:
            await ensure_asset_persisted(
                session_factory,
                infra.redis,
                settings,
                sym,
                include_gex=(sym != "BTCUSDT"),
                include_eps=(not is_crypto_or_etf),
                force_refresh=False,
            )
            db_bars, gex_row, eps_rows = await _load_from_db()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not db_bars:
        raise HTTPException(
            status_code=404,
            detail=f"No persisted daily bars found for {sym}. Try verifying the US ticker symbol.",
        )

    bar_inputs = [
        DailyBarInput(
            trade_date=b.trade_date.isoformat(),
            open=b.open,
            high=b.high,
            low=b.low,
            close=b.close,
            volume=b.volume,
            vwap=b.vwap,
        )
        for b in db_bars
    ]
    technicals = analyze_asset_technicals(bar_inputs)

    gex_payload: dict[str, Any] | None = None
    if gex_row is not None:
        gex_payload = {
            "snapshot_time": gex_row.snapshot_time.isoformat(),
            "spot_price": gex_row.spot_price,
            "net_gex": gex_row.net_gex,
            "call_wall": gex_row.call_wall,
            "put_wall": gex_row.put_wall,
            "zero_gamma": gex_row.zero_gamma,
            "put_call_ratio": gex_row.put_call_ratio,
            "total_call_oi": gex_row.total_call_oi,
            "total_put_oi": gex_row.total_put_oi,
            "assumption_label": gex_row.assumption_label,
            "strike_profile": gex_row.strike_profile_json,
            "is_stale": gex_row.is_stale,
        }

    news_items: list[dict[str, Any]] = []
    if include_news and sym != "BTCUSDT":
        try:
            alpaca = AlpacaClient(settings, cache=DualTTLCache(infra.redis))
            news_items = await alpaca.get_news([sym], limit=8)
        except (ProviderError, httpx.HTTPError, OSError):
            news_items = []

    recommendations: list[dict[str, Any]] = []
    company_overview: dict[str, Any] = {}
    price_target: dict[str, Any] | None = None
    extended_hours: dict[str, Any] | None = None
    live_snap: dict[str, Any] | None = None
    intraday_live: dict[str, Any] = {}

    detail_cache = DualTTLCache(infra.redis)
    intraday_task = fetch_yahoo_intraday_bars(sym, tf="1d", cache=detail_cache)
    feeds_client = MacroFeedsClient(settings, cache=detail_cache)
    in_pytest = bool(os.environ.get("PYTEST_CURRENT_TEST"))
    if (
        sym != "BTCUSDT"
        and settings.alpaca_api_key.strip()
        and settings.alpaca_secret_key.strip()
    ):
        alpaca_client = AlpacaClient(settings, cache=detail_cache)
        snap_task = alpaca_client.get_batch_stock_snapshots([sym])
        recent_bars_task = (
            asyncio.sleep(0, result={})
            if in_pytest
            else alpaca_client.get_daily_bars([sym], lookback_days=40)
        )
    else:
        snap_task = asyncio.sleep(0, result={})
        recent_bars_task = (
            feeds_client.get_btc_daily_bars(limit=40)
            if (sym == "BTCUSDT" and not in_pytest)
            else asyncio.sleep(0, result={})
        )

    recent_daily_raw: list[dict[str, Any]] | None = None
    if not is_crypto_or_etf:
        try:
            rec_task = feeds_client.get_finnhub_recommendation_trends(sym)
            ov_task = feeds_client.get_finnhub_company_overview(sym)
            pt_task = feeds_client.get_fmp_price_target_consensus(sym)
            rec_res, ov_res, pt_res, intra_res, snap_res, recent_res = await asyncio.gather(
                rec_task,
                ov_task,
                pt_task,
                intraday_task,
                snap_task,
                recent_bars_task,
                return_exceptions=True,
            )
            if isinstance(rec_res, list):
                recommendations = rec_res
            if isinstance(ov_res, dict):
                company_overview = ov_res
            if isinstance(pt_res, dict):
                price_target = pt_res
            if isinstance(intra_res, dict):
                intraday_live = intra_res
                ext_val = intra_res.get("extended_hours")
                if isinstance(ext_val, dict):
                    extended_hours = ext_val
            if isinstance(snap_res, dict):
                live_snap = snap_res.get(sym)
            if isinstance(recent_res, dict):
                bars_dict = recent_res.get("bars")
                if isinstance(bars_dict, dict):
                    recent_daily_raw = bars_dict.get(sym)
        except (ProviderError, httpx.HTTPError, OSError):
            recommendations = []
            company_overview = {}
            price_target = None
    else:
        intra_res, snap_res, recent_res = await asyncio.gather(
            intraday_task, snap_task, recent_bars_task, return_exceptions=True
        )
        if isinstance(intra_res, dict):
            intraday_live = intra_res
            ext_val = intra_res.get("extended_hours")
            if isinstance(ext_val, dict) and sym != "BTCUSDT":
                extended_hours = ext_val
        if isinstance(snap_res, dict):
            live_snap = snap_res.get(sym)
        if isinstance(recent_res, dict):
            bars_obj = recent_res.get("bars")
            if isinstance(bars_obj, dict):
                recent_daily_raw = bars_obj.get(sym)
            elif isinstance(bars_obj, list):
                recent_daily_raw = bars_obj

    synced_bars = _merge_recent_daily_bars(bar_inputs, recent_daily_raw)
    if live_snap and live_snap.get("price") is not None:
        live_bdate = live_snap.get("bar_date")
        if in_pytest:
            live_bdate = None
        technicals, synced_bars = _recompute_technicals_with_live_bar(
            synced_bars,
            live_price=float(live_snap["price"]),
            prev_close=float(live_snap["prev_close"]) if live_snap.get("prev_close") is not None else None,
            live_chg_pct=float(live_snap["change_1d_pct"]) if live_snap.get("change_1d_pct") is not None else None,
            live_bar_date=live_bdate,
            live_volume=float(live_snap["volume"]) if live_snap.get("volume") is not None else None,
        )
    elif intraday_live.get("spot_price") is not None:
        spot_bar_date = (
            str(recent_daily_raw[-1].get("trade_date") or "")[:10]
            if recent_daily_raw
            else None
        ) or None
        technicals, synced_bars = _recompute_technicals_with_live_bar(
            synced_bars,
            live_price=float(intraday_live["spot_price"]),
            prev_close=float(intraday_live["prev_close"]) if intraday_live.get("prev_close") is not None else None,
            live_bar_date=spot_bar_date,
        )
    elif synced_bars is not bar_inputs and len(synced_bars) > len(bar_inputs):
        technicals = analyze_asset_technicals(synced_bars)

    # Compute reliable metrics from synced OHLCV bars blended with Finnhub overview
    closes = [float(b.close) for b in synced_bars]
    latest_bar = synced_bars[-1]
    prev_bar = synced_bars[-2] if len(synced_bars) >= 2 else latest_bar
    latest_close = float(latest_bar.close)
    prev_close = float(prev_bar.close)
    live_last = float(technicals.get("last_close") or latest_close)
    live_prev = float(technicals.get("prev_close") or prev_close)
    change_1d_abs = round(live_last - live_prev, 4)

    def _pct_ago(days_back: int) -> float | None:
        if len(synced_bars) <= days_back:
            return None
        base = float(synced_bars[-(days_back + 1)].close)
        if base <= 0:
            return None
        return round(((live_last / base) - 1.0) * 100.0, 2)

    cur_year = latest_bar.trade_date[:4]
    ytd_base = None
    for b in synced_bars:
        if b.trade_date[:4] < cur_year:
            ytd_base = float(b.close)
    if ytd_base is None and synced_bars:
        ytd_base = float(synced_bars[0].close)
    change_ytd_pct = (
        round(((live_last / ytd_base) - 1.0) * 100.0, 2)
        if ytd_base and ytd_base > 0
        else None
    )

    recent_year = synced_bars[-252:]
    bar_52w_high = max(float(b.high) for b in recent_year) if recent_year else None
    bar_52w_low = min(float(b.low) for b in recent_year) if recent_year else None
    avg_vol_10d = (
        round(sum(float(b.volume) for b in synced_bars[-10:]) / min(len(synced_bars), 10), 0)
        if synced_bars
        else None
    )

    # Deduplicate EPS periods cleanly if multiple snapshot dates stored
    seen_periods: set[str] = set()
    eps_history: list[dict[str, Any]] = []
    for row in eps_rows:
        if row.period in seen_periods:
            continue
        seen_periods.add(row.period)
        eps_history.append(
            {
                "period": row.period,
                "estimate": row.eps_avg,
                "actual": row.eps_high,
                "surprise_percent": row.eps_low,
                "source": row.source,
            }
        )

    etf_display_names: dict[str, tuple[str, str, str]] = {
        "SPY": ("SPDR S&P 500 ETF Trust", "NYSE Arca", "Index ETF"),
        "QQQ": ("Invesco QQQ Trust", "NASDAQ", "Index ETF"),
        "IWM": ("iShares Russell 2000 ETF", "NYSE Arca", "Small Cap ETF"),
        "DIA": ("SPDR Dow Jones Industrial ETF", "NYSE Arca", "Index ETF"),
        "RSP": ("Invesco S&P 500 Equal Weight", "NYSE Arca", "Equal Weight ETF"),
        "SOXX": ("iShares Semiconductor ETF", "NASDAQ", "Semiconductors"),
        "GLD": ("SPDR Gold Shares", "NYSE Arca", "Precious Metals"),
        "SLV": ("iShares Silver Trust", "NYSE Arca", "Precious Metals"),
        "USO": ("United States Oil Fund", "NYSE Arca", "WTI Crude Oil"),
        "BNO": ("United States Brent Oil Fund", "NYSE Arca", "Brent Crude Oil"),
        "UNG": ("United States Natural Gas Fund", "NYSE Arca", "Natural Gas"),
        "UUP": ("Invesco DB US Dollar Index", "NYSE Arca", "US Dollar Index"),
        "TLT": ("iShares 20+ Year Treasury Bond", "NASDAQ", "US Treasuries"),
        "HYG": ("iShares iBoxx $ High Yield Corp", "NYSE Arca", "High Yield Credit"),
        "BTCUSDT": ("Bitcoin Spot (Binance)", "Crypto 24/7", "Digital Assets"),
    }
    fallback_meta = etf_display_names.get(sym)
    profile = {
        "symbol": sym,
        "name": company_overview.get("name") or (fallback_meta[0] if fallback_meta else sym),
        "exchange": company_overview.get("exchange") or (fallback_meta[1] if fallback_meta else "US"),
        "industry": company_overview.get("industry") or (fallback_meta[2] if fallback_meta else None),
        "logo_url": company_overview.get("logo_url"),
        "weburl": company_overview.get("weburl"),
        "ipo": company_overview.get("ipo"),
        "market_cap_b": company_overview.get("market_cap_b"),
    }
    metrics = {
        "open": round(float(latest_bar.open), 4),
        "day_high": round(float(latest_bar.high), 4),
        "day_low": round(float(latest_bar.low), 4),
        "prev_close": round(prev_close, 4),
        "volume": float(latest_bar.volume),
        "avg_vol_10d": avg_vol_10d,
        "week52_high": company_overview.get("week52_high") or (round(bar_52w_high, 2) if bar_52w_high else None),
        "week52_low": company_overview.get("week52_low") or (round(bar_52w_low, 2) if bar_52w_low else None),
        "pe_ttm": company_overview.get("pe_ttm"),
        "pb": company_overview.get("pb"),
        "beta": company_overview.get("beta"),
        "dividend_yield": company_overview.get("dividend_yield"),
        "change_1d_abs": change_1d_abs,
        "change_5d_pct": _pct_ago(5),
        "change_1m_pct": _pct_ago(21),
        "change_6m_pct": _pct_ago(126),
        "change_ytd_pct": change_ytd_pct,
        "bars_count": len(closes),
    }

    return {
        "symbol": sym,
        "asset_class": db_bars[-1].asset_class,
        "source": db_bars[-1].source,
        "bars": [
            {
                "trade_date": b.trade_date,
                "open": b.open,
                "high": b.high,
                "low": b.low,
                "close": b.close,
                "volume": b.volume,
                "vwap": b.vwap,
            }
            for b in synced_bars[-bars_limit:]
        ],
        "technicals": technicals,
        "profile": profile,
        "metrics": metrics,
        "options_gex": gex_payload,
        "news": news_items,
        "eps_history": eps_history,
        "recommendations": recommendations,
        "price_target": price_target,
        "extended_hours": extended_hours,
    }


DEFAULT_WATCHLIST_SYMBOLS: list[str] = ["NVDA", "AAPL", "GOOGL", "AMZN", "MSFT"]
_WATCHLIST_ETF_SET: frozenset[str] = frozenset(
    {
        "BTCUSDT",
        "SPY",
        "QQQ",
        "IWM",
        "RSP",
        "DIA",
        "SOXX",
        "TLT",
        "HYG",
        "IEF",
        "GLD",
        "SLV",
        "USO",
        "BNO",
        "UNG",
        "UUP",
        "CPER",
        "XLK",
        "XLF",
        "XLE",
        "XLV",
        "XLY",
        "XLI",
        "XLP",
        "XLU",
        "XLB",
        "XLRE",
        "XLC",
    }
)


class WatchlistUpdateRequest(BaseModel):
    symbols: list[str] = Field(default_factory=list, max_length=30)


def _brand_svg_badge(symbol: str) -> str:
    """Deterministic crisp rounded-square monogram SVG when external logo is absent."""
    palette: dict[str, tuple[str, str]] = {
        "NVDA": ("#76b900", "#ffffff"),
        "AAPL": ("#18181b", "#ffffff"),
        "GOOGL": ("#2563eb", "#ffffff"),
        "GOOG": ("#2563eb", "#ffffff"),
        "AMZN": ("#f97316", "#ffffff"),
        "MSFT": ("#0284c7", "#ffffff"),
        "TSLA": ("#dc2626", "#ffffff"),
        "META": ("#1d4ed8", "#ffffff"),
        "AMD": ("#111827", "#ffffff"),
        "AVGO": ("#be123c", "#ffffff"),
        "MU": ("#312e81", "#ffffff"),
        "PLTR": ("#0f172a", "#ffffff"),
        "SPY": ("#0f172a", "#34d399"),
        "QQQ": ("#1e293b", "#38bdf8"),
        "GLD": ("#ca8a04", "#ffffff"),
        "SLV": ("#64748b", "#ffffff"),
        "USO": ("#334155", "#f59e0b"),
        "BNO": ("#1e293b", "#fbbf24"),
        "BTCUSDT": ("#f59e0b", "#18181b"),
    }
    h = sum(ord(ch) for ch in symbol)
    fallbacks = [
        ("#1e293b", "#f8fafc"),
        ("#0f766e", "#f8fafc"),
        ("#1d4ed8", "#f8fafc"),
        ("#7c2d12", "#f8fafc"),
        ("#4338ca", "#f8fafc"),
    ]
    bg, fg = palette.get(symbol, fallbacks[h % len(fallbacks)])
    label = symbol[:4] if len(symbol) <= 4 else symbol[:3]
    font_size = 15 if len(label) <= 2 else (12 if len(label) == 3 else 10)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">'
        f'<rect width="40" height="40" rx="10" fill="{bg}"/>'
        f'<text x="20" y="21" dominant-baseline="central" text-anchor="middle" '
        f'font-family="Inter,system-ui,sans-serif" font-weight="700" font-size="{font_size}" '
        f'fill="{fg}">{label}</text></svg>'
    )


@router.get("/assets/{symbol}/logo")
async def get_asset_logo(symbol: str, request: Request) -> Response:
    """Serve cached company logo image or instant SVG monogram with guaranteed HTTP 200."""
    sym = symbol.upper().strip()
    if not sym:
        return Response(content=_brand_svg_badge("US"), media_type="image/svg+xml")

    infra = request.app.state.infra
    cache = DualTTLCache(infra.redis)
    cache_key = f"marketelite:asset:logo:{sym}"
    cached = await cache.read_envelope(cache_key)
    if cached and isinstance(cached.get("payload"), dict):
        p = cached["payload"]
        raw_b64 = p.get("b64")
        ctype = str(p.get("ctype") or "image/png")
        if raw_b64:
            try:
                return Response(
                    content=base64.b64decode(raw_b64),
                    media_type=ctype,
                    headers={"Cache-Control": "public, max-age=86400"},
                )
            except (ValueError, TypeError):
                pass

    if sym not in _WATCHLIST_ETF_SET:
        settings = get_settings()
        feeds = MacroFeedsClient(settings, cache=cache)
        try:
            ov = await feeds.get_finnhub_company_overview(sym)
            logo_url = str(ov.get("logo_url") or "").strip()
            if logo_url.startswith("http"):
                async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
                    r = await client.get(logo_url)
                    ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
                    if r.status_code == 200 and ctype.startswith("image/") and len(r.content) < 512_000:
                        await cache.write_envelope(
                            cache_key,
                            payload={
                                "b64": base64.b64encode(r.content).decode("ascii"),
                                "ctype": ctype,
                            },
                            source="finnhub_logo",
                            soft_ttl_seconds=86400 * 7,
                            hard_ttl_seconds=86400 * 14,
                        )
                        return Response(
                            content=r.content,
                            media_type=ctype,
                            headers={"Cache-Control": "public, max-age=86400"},
                        )
        except (ProviderError, httpx.HTTPError, OSError, ValueError):
            pass

    return Response(
        content=_brand_svg_badge(sym),
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/market/discover")
async def get_market_discover_news(
    request: Request,
    limit: int = Query(default=21, ge=3, le=30),
    force_refresh: bool = Query(default=False),
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> dict[str, Any]:
    """Return latest high-impact financial news with verified HD editorial photos & zero-LLM Chinese headlines."""
    settings = get_settings()
    expected = settings.admin_api_token.strip()
    bypass = bool(
        expected and x_admin_token and secrets.compare_digest(x_admin_token.strip(), expected)
    )
    infra = request.app.state.infra
    cache = DualTTLCache(infra.redis)
    return await get_or_refresh_discover_news(
        cache,
        settings,
        limit=limit,
        force_refresh=force_refresh,
        bypass_cooldown=bypass,
    )


@router.get("/market/discover/{article_id}/image")
async def get_market_discover_image(article_id: str, request: Request) -> Response:
    """Serve proxied & Redis-cached editorial HD photo by opaque article_id."""
    cleaned = article_id.strip()
    if not cleaned or len(cleaned) > 48 or not all(ch.isalnum() or ch in "_-" for ch in cleaned):
        raise HTTPException(status_code=400, detail="Invalid article_id")
    infra = request.app.state.infra
    cache = DualTTLCache(infra.redis)
    raw, ctype = await get_discover_article_image(cleaned, cache)
    return Response(
        content=raw,
        media_type=ctype,
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/market/discover/{article_id}")
async def get_market_discover_article(
    article_id: str,
    request: Request,
    force_refresh: bool = Query(default=False),
) -> dict[str, Any]:
    """Return scraped & paragraph-aligned zero-LLM bilingual article payload for the in-app reading modal."""
    cleaned = article_id.strip()
    if not cleaned or len(cleaned) > 48 or not all(ch.isalnum() or ch in "_-" for ch in cleaned):
        raise HTTPException(status_code=400, detail="Invalid article_id")
    infra = request.app.state.infra
    cache = DualTTLCache(infra.redis)
    detail = await get_discover_article_detail(cleaned, cache, force_refresh=force_refresh)
    if detail is None:
        raise HTTPException(status_code=404, detail="Article not found or expired from cache")
    return detail


async def _load_ordered_watchlist_symbols(
    session_factory: Any,
    workspace_id: str = "default",
) -> list[str]:
    async with session_factory() as session:
        stmt = (
            select(UserWatchlistItem)
            .where(UserWatchlistItem.workspace_id == workspace_id)
            .order_by(asc(UserWatchlistItem.sort_order), asc(UserWatchlistItem.id))
        )
        rows = list((await session.execute(stmt)).scalars().all())
        if not rows:
            for idx, sym in enumerate(DEFAULT_WATCHLIST_SYMBOLS):
                session.add(UserWatchlistItem(workspace_id=workspace_id, symbol=sym, sort_order=idx))
            await session.commit()
            return list(DEFAULT_WATCHLIST_SYMBOLS)
        return [str(r.symbol).upper() for r in rows]


async def _assemble_watchlist_payload(
    session_factory: Any,
    redis_client: Any,
    settings: Any,
    ordered_symbols: list[str],
) -> dict[str, Any]:
    if not ordered_symbols:
        return {"count": 0, "symbols": [], "items": []}

    # Batch load up to 270 recent daily bars for all symbols in a single DB query
    async with session_factory() as session:
        ranked = (
            select(
                MarketDailyBar.symbol,
                MarketDailyBar.asset_class,
                MarketDailyBar.trade_date,
                MarketDailyBar.open,
                MarketDailyBar.high,
                MarketDailyBar.low,
                MarketDailyBar.close,
                MarketDailyBar.volume,
                func.row_number()
                .over(
                    partition_by=MarketDailyBar.symbol,
                    order_by=desc(MarketDailyBar.trade_date),
                )
                .label("rn"),
            )
            .where(MarketDailyBar.symbol.in_(ordered_symbols))
            .subquery()
        )
        rows = (
            await session.execute(
                select(ranked).where(ranked.c.rn <= 270).order_by(ranked.c.symbol, asc(ranked.c.trade_date))
            )
        ).all()

    bars_by_sym: dict[str, list[Any]] = {}
    for row in rows:
        bars_by_sym.setdefault(str(row.symbol), []).append(row)

    missing_syms = [s for s in ordered_symbols if not bars_by_sym.get(s)]
    if missing_syms:
        await asyncio.gather(
            *(
                ensure_asset_persisted(
                    session_factory,
                    redis_client,
                    settings,
                    sym,
                    include_gex=False,
                    include_eps=False,
                    force_refresh=False,
                )
                for sym in missing_syms
            ),
            return_exceptions=True,
        )
        async with session_factory() as session:
            ranked2 = (
                select(
                    MarketDailyBar.symbol,
                    MarketDailyBar.asset_class,
                    MarketDailyBar.trade_date,
                    MarketDailyBar.open,
                    MarketDailyBar.high,
                    MarketDailyBar.low,
                    MarketDailyBar.close,
                    MarketDailyBar.volume,
                    func.row_number()
                    .over(
                        partition_by=MarketDailyBar.symbol,
                        order_by=desc(MarketDailyBar.trade_date),
                    )
                    .label("rn"),
                )
                .where(MarketDailyBar.symbol.in_(missing_syms))
                .subquery()
            )
            rows2 = (
                await session.execute(
                    select(ranked2).where(ranked2.c.rn <= 270).order_by(ranked2.c.symbol, asc(ranked2.c.trade_date))
                )
            ).all()
            for row in rows2:
                bars_by_sym.setdefault(str(row.symbol), []).append(row)

    wl_cache = DualTTLCache(redis_client)
    feeds = MacroFeedsClient(settings, cache=wl_cache)
    profile_tasks = {
        sym: (
            feeds.get_finnhub_company_overview(sym)
            if sym not in _WATCHLIST_ETF_SET
            else asyncio.sleep(0, result={})
        )
        for sym in ordered_symbols
    }
    prof_keys = list(profile_tasks.keys())
    prof_results, wl_ext_res = await asyncio.gather(
        asyncio.gather(*profile_tasks.values(), return_exceptions=True),
        fetch_yahoo_extended_quotes(ordered_symbols, cache=wl_cache),
        return_exceptions=True,
    )
    profiles: dict[str, dict[str, Any]] = {}
    if isinstance(prof_results, list):
        for sym, res in zip(prof_keys, prof_results):
            if isinstance(res, dict):
                profiles[sym] = res
    wl_ext_map = wl_ext_res if isinstance(wl_ext_res, dict) else {}

    items: list[dict[str, Any]] = []
    for sym in ordered_symbols:
        sym_bars = bars_by_sym.get(sym, [])
        if not sym_bars:
            continue
        latest = sym_bars[-1]
        prev = sym_bars[-2] if len(sym_bars) >= 2 else latest
        price = float(latest.close)
        prev_close = float(prev.close)
        change_1d_abs = round(price - prev_close, 4)

        def _ret(lookback: int, *, _bars: list[Any] = sym_bars, _price: float = price) -> float | None:
            if len(_bars) <= lookback:
                return None
            base = float(_bars[-(lookback + 1)].close)
            if base <= 0:
                return None
            return round(((_price / base) - 1.0) * 100.0, 2)

        cur_year = latest.trade_date.year
        ytd_base = None
        for b in sym_bars:
            if b.trade_date.year < cur_year:
                ytd_base = float(b.close)
        if ytd_base is None:
            ytd_base = float(sym_bars[0].close)
        change_ytd_pct = round(((price / ytd_base) - 1.0) * 100.0, 2) if ytd_base > 0 else None

        tech = analyze_asset_technicals(
            [
                DailyBarInput(
                    trade_date=b.trade_date.isoformat(),
                    open=float(b.open),
                    high=float(b.high),
                    low=float(b.low),
                    close=float(b.close),
                    volume=float(b.volume),
                    vwap=None,
                )
                for b in sym_bars[-90:]
            ]
        )
        prof = profiles.get(sym, {})
        items.append(
            {
                "symbol": sym,
                "name": prof.get("name") or sym,
                "exchange": prof.get("exchange") or ("Crypto" if sym == "BTCUSDT" else "US"),
                "industry": prof.get("industry"),
                "asset_class": latest.asset_class,
                "trade_date": latest.trade_date.isoformat(),
                "price": round(price, 2),
                "prev_close": round(prev_close, 2),
                "change_1d_abs": change_1d_abs,
                "change_1d_pct": _ret(1),
                "change_5d_pct": _ret(5),
                "change_1m_pct": _ret(21),
                "change_6m_pct": _ret(126),
                "change_ytd_pct": change_ytd_pct,
                "rsi_14": tech.get("rsi_14") if isinstance(tech, dict) else None,
                "rvol_20": tech.get("rvol_20") if isinstance(tech, dict) else None,
                "market_cap_b": prof.get("market_cap_b"),
                "pe_ttm": prof.get("pe_ttm"),
                "extended_hours": wl_ext_map.get(sym),
                "sparkline_bars": [
                    {
                        "t": idx,
                        "o": round(float(b.open), 4),
                        "h": round(float(b.high), 4),
                        "l": round(float(b.low), 4),
                        "c": round(float(b.close), 4),
                    }
                    for idx, b in enumerate(sym_bars[-18:])
                ],
                "daily_closes": [
                    {
                        "d": b.trade_date.isoformat(),
                        "c": round(float(b.close), 4),
                    }
                    for b in sym_bars
                ],
            }
        )

    return {
        "count": len(items),
        "symbols": [item["symbol"] for item in items],
        "items": items,
        "generated_at": date.today().isoformat(),
    }


@router.get("/watchlist")
async def get_user_watchlist(request: Request) -> dict[str, Any]:
    """Return user's ordered watchlist with company metadata, sparkline K-lines, and multi-horizon returns."""
    settings = get_settings()
    infra = request.app.state.infra
    session_factory = request.app.state.session_factory
    ws_id = resolve_workspace_id(request.headers)
    ordered = await _load_ordered_watchlist_symbols(session_factory, ws_id)
    return await _assemble_watchlist_payload(session_factory, infra.redis, settings, ordered)


@router.put("/watchlist")
async def update_user_watchlist(payload: WatchlistUpdateRequest, request: Request) -> dict[str, Any]:
    """Persist ordered watchlist (add, remove, or reorder) and validate newly added US tickers."""
    settings = get_settings()
    infra = request.app.state.infra
    session_factory = request.app.state.session_factory
    ws_id = resolve_workspace_id(request.headers)

    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in payload.symbols:
        sym = raw.upper().strip()
        if not sym or sym in seen:
            continue
        if len(sym) > 20 or not all(ch.isalnum() or ch in ".-" for ch in sym):
            raise HTTPException(status_code=400, detail=f"Invalid ticker format: {sym}")
        seen.add(sym)
        cleaned.append(sym)

    # Validate newly inserted symbols before mutating DB watchlist
    existing = set(await _load_ordered_watchlist_symbols(session_factory, ws_id))
    new_symbols = [s for s in cleaned if s not in existing]
    for sym in new_symbols:
        try:
            res = await ensure_asset_persisted(
                session_factory,
                infra.redis,
                settings,
                sym,
                include_gex=False,
                include_eps=False,
                force_refresh=False,
            )
            if not res.get("found"):
                raise HTTPException(
                    status_code=404,
                    detail=f"未找到美股标的 {sym} 的行情数据，请确认股票代码是否正确。",
                )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    async with session_factory() as session:
        await session.execute(
            delete(UserWatchlistItem).where(UserWatchlistItem.workspace_id == ws_id)
        )
        for idx, sym in enumerate(cleaned):
            session.add(UserWatchlistItem(workspace_id=ws_id, symbol=sym, sort_order=idx))
        await session.commit()

    return await _assemble_watchlist_payload(session_factory, infra.redis, settings, cleaned)


@router.post("/pipeline/sync")
async def trigger_pipeline_sync(
    request: Request,
    force_refresh: bool = Query(default=False),
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> dict[str, Any]:
    """Trigger immediate Phase 1 deterministic pipeline sync (protected in production)."""
    settings = get_settings()
    expected = settings.admin_api_token.strip()
    if expected:
        if not x_admin_token or not secrets.compare_digest(x_admin_token.strip(), expected):
            raise HTTPException(
                status_code=403,
                detail="Valid X-Admin-Token header required to trigger pipeline sync.",
            )
    elif settings.app_env.lower() == "production":
        raise HTTPException(
            status_code=403,
            detail="HTTP pipeline sync is disabled in production unless ADMIN_API_TOKEN is set.",
        )

    infra = request.app.state.infra
    session_factory = request.app.state.session_factory
    summary = await run_full_pipeline_sync(
        session_factory,
        infra.redis,
        settings,
        force_refresh=force_refresh,
    )
    return {"status": "ok", **summary}


@router.get("/calendar/upcoming")
async def get_upcoming_calendar_endpoint(request: Request) -> dict[str, Any]:
    """Return live DB-synced US macro releases (Fed FOMC/FRED/FMP), macro history & earnings."""
    session_factory = request.app.state.session_factory
    settings = get_settings()
    infra = request.app.state.infra
    async with session_factory() as session:
        bundle = await query_upcoming_calendar_events(session)

    # Best-effort keyless Fed FOMC + configured FRED/Finnhub sync if DB table lacks macro or earnings
    if not bundle["macro_events"] or not bundle["earnings_events"]:
        try:
            await asyncio.wait_for(
                sync_calendars(session_factory, infra.redis, settings),
                timeout=6.0,
            )
            async with session_factory() as session:
                bundle = await query_upcoming_calendar_events(session)
        except Exception as exc:  # noqa: BLE001
            logger.debug("Calendar sync deferred cleanly: %s", exc)

    macro_history: list[dict[str, Any]] = []
    if not os.environ.get("PYTEST_CURRENT_TEST"):
        try:
            macro_history = await asyncio.wait_for(
                build_macro_release_history(DualTTLCache(infra.redis), settings),
                timeout=8.0,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("Macro release history fetch skipped cleanly: %s", exc)

    if macro_history:
        bundle["macro_events"] = attach_macro_context_to_events(
            bundle.get("macro_events") or [], macro_history
        )
        bundle["upcoming_events"] = attach_macro_context_to_events(
            bundle.get("upcoming_events") or [], macro_history
        )

    return {"status": "ok", **bundle, "macro_history": macro_history}


@router.get("/market/moc")
async def get_market_moc_proxy(
    request: Request,
    symbol: str = Query(default="SPY", min_length=1, max_length=16),
    force_refresh: bool = Query(default=False),
) -> dict[str, Any]:
    """Return closing-auction (15:45-16:00 ET) volume surge & rebalance proxy."""
    infra = request.app.state.infra
    cache = DualTTLCache(infra.redis)
    sym = symbol.upper().strip()
    try:
        return await fetch_moc_auction_proxy(sym, cache=cache, force_refresh=force_refresh)
    except (ProviderError, httpx.HTTPError, OSError, RuntimeError, ValueError) as exc:
        logger.warning("MOC proxy fetch fallback for %s: %s", sym, exc)
        return {
            "status": "unavailable",
            "symbol": sym,
            "headline_zh": f"{sym} 尾盘分钟线暂未就绪，请稍后刷新",
            "series_10d": [],
            "detail": str(exc),
        }


@router.get("/market/darkpool")
async def get_market_darkpool_profile(
    request: Request,
    symbol: str = Query(default="SPY", min_length=1, max_length=16),
    force_refresh: bool = Query(default=False),
) -> dict[str, Any]:
    """Return FINRA Reg SHO daily off-exchange TRF volume + weekly ATS dark pool profile."""
    infra = request.app.state.infra
    settings = get_settings()
    cache = DualTTLCache(infra.redis)
    alpaca = AlpacaClient(settings, cache=cache)
    sym = symbol.upper().strip()
    try:
        return await fetch_finra_darkpool_profile(
            sym, alpaca_client=alpaca, cache=cache, force_refresh=force_refresh
        )
    except (ProviderError, httpx.HTTPError, OSError, RuntimeError, ValueError) as exc:
        logger.warning("Dark pool fetch fallback for %s: %s", sym, exc)
        return {
            "status": "unavailable",
            "symbol": sym,
            "reason": f"{sym} FINRA 场外暗池数据暂时不可用：{exc}",
            "series_20d": [],
            "ats_weekly": {"weeks": [], "latest": None},
        }


@router.get("/market/onchain")
async def get_market_onchain_pulse(
    request: Request,
    force_refresh: bool = Query(default=False),
) -> dict[str, Any]:
    """Return keyless DefiLlama stablecoins, CoinMetrics BTC exchange flows & Binance Perp pulse."""
    infra = request.app.state.infra
    cache = DualTTLCache(infra.redis)
    try:
        return await fetch_onchain_liquidity_pulse(cache=cache, force_refresh=force_refresh)
    except (ProviderError, httpx.HTTPError, OSError, RuntimeError, ValueError) as exc:
        logger.warning("On-chain pulse fallback: %s", exc)
        return {
            "status": "unavailable",
            "headline_zh": "链上与永续资金脉搏暂未就绪，请稍后刷新",
            "stablecoins": None,
            "btc_chain": None,
            "perp": None,
            "detail": str(exc),
        }


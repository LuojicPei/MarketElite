from __future__ import annotations

import secrets
from typing import Any

import httpx
from fastapi import APIRouter, Header, HTTPException, Query, Request
from sqlalchemy import desc, func, select

from app.core.config import get_settings
from app.db.models import (
    ConsensusEpsSnapshot,
    MarketDailyBar,
    MarketRegimeDaily,
    OptionsGexSnapshot,
)
from app.quant.technicals import DailyBarInput, analyze_asset_technicals
from app.services.pipeline import (
    OVERVIEW_CACHE_KEY,
    ensure_asset_persisted,
    get_regime_history,
    run_full_pipeline_sync,
)
from app.services.providers.alpaca import AlpacaClient
from app.services.providers.macro_feeds import MacroFeedsClient
from app.services.providers.yahoo_tape import MACRO_TAPE_SPECS, fetch_macro_tape_snapshot
from app.services.resilience import DualTTLCache, ProviderError

router = APIRouter(prefix="/api", tags=["market"])


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
    if not is_crypto_or_etf:
        try:
            feeds = MacroFeedsClient(settings, cache=DualTTLCache(infra.redis))
            recommendations = await feeds.get_finnhub_recommendation_trends(sym)
        except (ProviderError, httpx.HTTPError, OSError):
            recommendations = []

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

    return {
        "symbol": sym,
        "asset_class": db_bars[-1].asset_class,
        "source": db_bars[-1].source,
        "bars": [
            {
                "trade_date": b.trade_date.isoformat(),
                "open": b.open,
                "high": b.high,
                "low": b.low,
                "close": b.close,
                "volume": b.volume,
                "vwap": b.vwap,
            }
            for b in db_bars[-bars_limit:]
        ],
        "technicals": technicals,
        "options_gex": gex_payload,
        "news": news_items,
        "eps_history": eps_history,
        "recommendations": recommendations,
    }


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

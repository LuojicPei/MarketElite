from __future__ import annotations

import secrets
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from sqlalchemy import desc, func, select

from app.core.config import get_settings
from app.db.models import MarketDailyBar, MarketRegimeDaily, OptionsGexSnapshot
from app.quant.technicals import DailyBarInput, analyze_asset_technicals
from app.services.pipeline import OVERVIEW_CACHE_KEY, run_full_pipeline_sync
from app.services.providers.alpaca import AlpacaClient
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


@router.get("/assets/{symbol}")
async def get_asset_detail(
    symbol: str,
    request: Request,
    bars_limit: int = Query(default=180, ge=20, le=365),
    include_news: bool = Query(default=False),
) -> dict[str, Any]:
    """Return historical daily bars, technical state, and latest Estimated GEX for a ticker."""
    sym = symbol.upper().strip()
    if not sym:
        raise HTTPException(status_code=400, detail="Symbol is required")

    session_factory = request.app.state.session_factory
    query_limit = max(bars_limit, 260)
    async with session_factory() as session:
        bar_stmt = (
            select(MarketDailyBar)
            .where(MarketDailyBar.symbol == sym)
            .order_by(desc(MarketDailyBar.trade_date))
            .limit(query_limit)
        )
        db_bars = list((await session.execute(bar_stmt)).scalars().all())
        db_bars.reverse()

        gex_stmt = (
            select(OptionsGexSnapshot)
            .where(OptionsGexSnapshot.symbol == sym)
            .order_by(desc(OptionsGexSnapshot.snapshot_time))
            .limit(1)
        )
        gex_row = (await session.execute(gex_stmt)).scalar_one_or_none()

    if not db_bars:
        raise HTTPException(
            status_code=404,
            detail=f"No persisted daily bars found for {sym}. Run pipeline sync first.",
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
    if include_news:
        try:
            alpaca = AlpacaClient(get_settings())
            news_items = await alpaca.get_news([sym], limit=8)
        except ProviderError:
            news_items = []

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

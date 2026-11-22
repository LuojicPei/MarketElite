from __future__ import annotations

import asyncio
import base64
import secrets
from datetime import date
from typing import Any

import httpx
from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import asc, delete, desc, func, select

from app.core.config import get_settings
from app.db.models import (
    ConsensusEpsSnapshot,
    MarketDailyBar,
    MarketRegimeDaily,
    OptionsGexSnapshot,
    UserWatchlistItem,
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
    company_overview: dict[str, Any] = {}
    if not is_crypto_or_etf:
        feeds = MacroFeedsClient(settings, cache=DualTTLCache(infra.redis))
        try:
            rec_task = feeds.get_finnhub_recommendation_trends(sym)
            ov_task = feeds.get_finnhub_company_overview(sym)
            rec_res, ov_res = await asyncio.gather(rec_task, ov_task, return_exceptions=True)
            if isinstance(rec_res, list):
                recommendations = rec_res
            if isinstance(ov_res, dict):
                company_overview = ov_res
        except (ProviderError, httpx.HTTPError, OSError):
            recommendations = []
            company_overview = {}

    # Compute reliable metrics from persisted OHLCV bars blended with Finnhub overview
    closes = [float(b.close) for b in db_bars]
    latest_bar = db_bars[-1]
    prev_bar = db_bars[-2] if len(db_bars) >= 2 else latest_bar
    latest_close = float(latest_bar.close)
    prev_close = float(prev_bar.close)
    change_1d_abs = round(latest_close - prev_close, 4)

    def _pct_ago(days_back: int) -> float | None:
        if len(db_bars) <= days_back:
            return None
        base = float(db_bars[-(days_back + 1)].close)
        if base <= 0:
            return None
        return round(((latest_close / base) - 1.0) * 100.0, 2)

    cur_year = latest_bar.trade_date.year
    ytd_base = None
    for b in db_bars:
        if b.trade_date.year < cur_year:
            ytd_base = float(b.close)
    if ytd_base is None and db_bars:
        ytd_base = float(db_bars[0].close)
    change_ytd_pct = (
        round(((latest_close / ytd_base) - 1.0) * 100.0, 2)
        if ytd_base and ytd_base > 0
        else None
    )

    recent_year = db_bars[-252:]
    bar_52w_high = max(float(b.high) for b in recent_year) if recent_year else None
    bar_52w_low = min(float(b.low) for b in recent_year) if recent_year else None
    avg_vol_10d = (
        round(sum(float(b.volume) for b in db_bars[-10:]) / min(len(db_bars), 10), 0)
        if db_bars
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
        "profile": profile,
        "metrics": metrics,
        "options_gex": gex_payload,
        "news": news_items,
        "eps_history": eps_history,
        "recommendations": recommendations,
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


async def _load_ordered_watchlist_symbols(session_factory: Any) -> list[str]:
    async with session_factory() as session:
        stmt = select(UserWatchlistItem).order_by(asc(UserWatchlistItem.sort_order), asc(UserWatchlistItem.id))
        rows = list((await session.execute(stmt)).scalars().all())
        if not rows:
            for idx, sym in enumerate(DEFAULT_WATCHLIST_SYMBOLS):
                session.add(UserWatchlistItem(symbol=sym, sort_order=idx))
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

    feeds = MacroFeedsClient(settings, cache=DualTTLCache(redis_client))
    profile_tasks = {
        sym: (
            feeds.get_finnhub_company_overview(sym)
            if sym not in _WATCHLIST_ETF_SET
            else asyncio.sleep(0, result={})
        )
        for sym in ordered_symbols
    }
    prof_keys = list(profile_tasks.keys())
    prof_results = await asyncio.gather(*profile_tasks.values(), return_exceptions=True)
    profiles: dict[str, dict[str, Any]] = {}
    for sym, res in zip(prof_keys, prof_results):
        if isinstance(res, dict):
            profiles[sym] = res

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
    ordered = await _load_ordered_watchlist_symbols(session_factory)
    return await _assemble_watchlist_payload(session_factory, infra.redis, settings, ordered)


@router.put("/watchlist")
async def update_user_watchlist(payload: WatchlistUpdateRequest, request: Request) -> dict[str, Any]:
    """Persist ordered watchlist (add, remove, or reorder) and validate newly added US tickers."""
    settings = get_settings()
    infra = request.app.state.infra
    session_factory = request.app.state.session_factory

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
    existing = set(await _load_ordered_watchlist_symbols(session_factory))
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
        await session.execute(delete(UserWatchlistItem))
        for idx, sym in enumerate(cleaned):
            session.add(UserWatchlistItem(symbol=sym, sort_order=idx))
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

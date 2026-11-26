from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Sequence
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx
import redis.asyncio as aioredis
from sqlalchemy import desc, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.db.models import (
    ConsensusEpsSnapshot,
    EconomicCalendarEvent,
    MacroSeriesPoint,
    MarketDailyBar,
    MarketRegimeDaily,
    OptionsGexSnapshot,
    PaperTrade,
    UserWatchlistItem,
)
from app.quant.macro import (
    compute_fear_greed_index,
    compute_net_liquidity_series,
    compute_vix_term_structure,
    compute_yield_and_credit_snapshot,
)
from app.quant.options import compute_estimated_gex
from app.quant.technicals import (
    DailyBarInput,
    analyze_asset_technicals,
    classify_market_regime,
    compute_cross_asset_correlations,
    compute_market_breadth,
    compute_sector_rotation,
)
from app.services.macro_history import build_macro_release_history
from app.services.news_discover import get_or_refresh_discover_news
from app.services.providers.alpaca import (
    CORE_INDEX_ETFS,
    DEFAULT_EQUITY_UNIVERSE,
    SECTOR_ETFS,
    AlpacaClient,
)
from app.services.providers.cboe import CboeClient
from app.services.providers.cnn_fear_greed import fetch_cnn_fear_greed
from app.services.providers.fred import FRED_CORE_SERIES, FredClient
from app.services.providers.macro_feeds import MacroFeedsClient
from app.services.resilience import (
    DualTTLCache,
    ProviderError,
    ProviderUnconfiguredError,
    RedisCircuitBreaker,
)

logger = logging.getLogger(__name__)

OVERVIEW_CACHE_KEY = "marketelite:dashboard:overview"
PROVIDER_STATE_KEY = "marketelite:pipeline:provider_states"


def _to_float_or_none(val: Any) -> float | None:
    if val is None or val == "":
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _parse_event_dt(raw: str) -> datetime:
    text = (raw or "").strip()
    if text:
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                return datetime.strptime(text[:19], fmt).replace(tzinfo=timezone.utc)
            except ValueError:
                continue
    return datetime.now(timezone.utc)


def _make_cache(redis_client: aioredis.Redis | None) -> DualTTLCache:
    cb = RedisCircuitBreaker(redis_client, failure_threshold=5, window_seconds=60, cooldown_seconds=60)
    return DualTTLCache(redis_client, circuit_breaker=cb)


async def _upsert_macro_points(
    session: AsyncSession,
    series_id: str,
    observations: Sequence[dict[str, Any]],
    source: str,
) -> int:
    if not observations:
        return 0
    now = datetime.now(timezone.utc)
    rows = []
    for item in observations:
        try:
            obs_date = date.fromisoformat(str(item["obs_date"])[:10])
            val = float(item["value"])
        except (KeyError, TypeError, ValueError):
            continue
        rows.append(
            {
                "series_id": series_id,
                "obs_date": obs_date,
                "value": val,
                "source": source,
                "fetched_at": now,
            }
        )
    if not rows:
        return 0

    stmt = pg_insert(MacroSeriesPoint).values(rows)
    stmt = stmt.on_conflict_do_update(
        constraint="uq_macro_series_id_date",
        set_={"value": stmt.excluded.value, "source": stmt.excluded.source, "fetched_at": now},
    )
    await session.execute(stmt)
    return len(rows)


async def _upsert_daily_bars(
    session: AsyncSession,
    symbol: str,
    asset_class: str,
    bars: Sequence[dict[str, Any]],
    source: str,
) -> int:
    if not bars:
        return 0
    now = datetime.now(timezone.utc)
    rows = []
    for b in bars:
        try:
            trade_date = date.fromisoformat(str(b["trade_date"])[:10])
            rows.append(
                {
                    "symbol": symbol.upper(),
                    "asset_class": asset_class,
                    "trade_date": trade_date,
                    "open": float(b["open"]),
                    "high": float(b["high"]),
                    "low": float(b["low"]),
                    "close": float(b["close"]),
                    "volume": float(b.get("volume", 0.0)),
                    "vwap": _to_float_or_none(b.get("vwap")),
                    "trade_count": int(b["trade_count"]) if b.get("trade_count") is not None else None,
                    "source": source,
                    "fetched_at": now,
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    if not rows:
        return 0

    stmt = pg_insert(MarketDailyBar).values(rows)
    stmt = stmt.on_conflict_do_update(
        constraint="uq_market_daily_bars_symbol_date",
        set_={
            "open": stmt.excluded.open,
            "high": stmt.excluded.high,
            "low": stmt.excluded.low,
            "close": stmt.excluded.close,
            "volume": stmt.excluded.volume,
            "vwap": stmt.excluded.vwap,
            "trade_count": stmt.excluded.trade_count,
            "source": stmt.excluded.source,
            "fetched_at": now,
        },
    )
    await session.execute(stmt)
    return len(rows)


async def sync_macro_and_cboe(
    session_factory: async_sessionmaker[AsyncSession],
    redis_client: aioredis.Redis | None,
    settings: Settings,
    *,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Fetch FRED macro/credit/liquidity series + CBOE VIX term structure into PostgreSQL."""
    cache = _make_cache(redis_client)
    fred = FredClient(settings, cache=cache)
    cboe = CboeClient(cache=cache)
    counts: dict[str, int] = {}
    errors: list[str] = []

    async with session_factory() as session:
        for sid in FRED_CORE_SERIES:
            try:
                res = await fred.get_series(sid, force_refresh=force_refresh)
                counts[sid] = await _upsert_macro_points(
                    session, sid, res["observations"], str(res.get("source", "fred"))
                )
            except (ProviderError, httpx.HTTPError) as exc:
                errors.append(f"fred:{sid}: {exc}")

        for idx_code in ("VIX9D", "VIX", "VIX3M"):
            try:
                res = await cboe.get_vix_series(idx_code, force_refresh=force_refresh)
                counts[idx_code] = await _upsert_macro_points(
                    session, idx_code, res["observations"], "cboe_csv"
                )
            except (ProviderError, ValueError, httpx.HTTPError) as exc:
                errors.append(f"cboe:{idx_code}: {exc}")

        await session.commit()

    return {"status": "partial" if errors else "ok", "upserted": counts, "errors": errors}


async def sync_btc_and_cftc(
    session_factory: async_sessionmaker[AsyncSession],
    redis_client: aioredis.Redis | None,
    settings: Settings,
    *,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Fetch keyless Binance BTCUSDT daily bars and CFTC COT positioning."""
    cache = _make_cache(redis_client)
    feeds = MacroFeedsClient(settings, cache=cache)
    result: dict[str, Any] = {"btc_bars": 0, "cot_contracts": 0, "errors": []}

    try:
        btc_res = await feeds.get_btc_daily_bars(limit=300, force_refresh=force_refresh)
        async with session_factory() as session:
            result["btc_bars"] = await _upsert_daily_bars(
                session, "BTCUSDT", "crypto", btc_res["bars"], "binance_vision"
            )
            await session.commit()
    except (ProviderError, httpx.HTTPError) as exc:
        result["errors"].append(f"binance: {exc}")

    try:
        cot_res = await feeds.get_cftc_cot(force_refresh=force_refresh)
        result["cot_contracts"] = len(cot_res.get("cot", {}))
    except (ProviderError, httpx.HTTPError) as exc:
        result["errors"].append(f"cftc: {exc}")

    result["status"] = "partial" if result["errors"] else "ok"
    return result


async def sync_equities_and_breadth(
    session_factory: async_sessionmaker[AsyncSession],
    redis_client: aioredis.Redis | None,
    settings: Settings,
    *,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Fetch core US index, sector, macro-proxy, and breadth equity daily bars via Alpaca."""
    cache = _make_cache(redis_client)
    alpaca = AlpacaClient(settings, cache=cache)
    try:
        res = await alpaca.get_daily_bars(
            list(DEFAULT_EQUITY_UNIVERSE), lookback_days=420, force_refresh=force_refresh
        )
    except ProviderUnconfiguredError as exc:
        return {"status": "unconfigured", "reason": str(exc), "symbols_updated": 0}
    except (ProviderError, httpx.HTTPError) as exc:
        return {"status": "error", "reason": str(exc), "symbols_updated": 0}

    bars_by_sym: dict[str, list[dict[str, Any]]] = res.get("bars", {})
    updated = 0
    async with session_factory() as session:
        for sym, bar_list in bars_by_sym.items():
            asset_class = "etf" if sym in (CORE_INDEX_ETFS + SECTOR_ETFS) else "equity"
            n = await _upsert_daily_bars(session, sym, asset_class, bar_list, "alpaca_sip_1d")
            if n > 0:
                updated += 1
        await session.commit()
    return {"status": "ok", "symbols_updated": updated, "is_stale": res.get("is_stale", False)}


async def sync_options_gex(
    session_factory: async_sessionmaker[AsyncSession],
    redis_client: aioredis.Redis | None,
    settings: Settings,
    *,
    symbols: tuple[str, ...] = ("SPY", "QQQ"),
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Compute and persist Estimated GEX snapshots joining Alpaca indicative Greeks + OCC OI."""
    cache = _make_cache(redis_client)
    alpaca = AlpacaClient(settings, cache=cache)
    snapshots_saved: dict[str, Any] = {}
    errors: list[str] = []

    async with session_factory() as session:
        for sym in symbols:
            try:
                chain = await alpaca.get_options_chain_inputs(sym, force_refresh=force_refresh)
                gex = compute_estimated_gex(
                    sym, float(chain["spot_price"]), chain["contracts"]
                )
                row = OptionsGexSnapshot(
                    symbol=gex.symbol,
                    spot_price=gex.spot_price,
                    net_gex=gex.net_gex,
                    call_wall=gex.call_wall,
                    put_wall=gex.put_wall,
                    zero_gamma=gex.zero_gamma,
                    put_call_ratio=gex.put_call_ratio,
                    total_call_oi=gex.total_call_oi,
                    total_put_oi=gex.total_put_oi,
                    contracts_analyzed=gex.contracts_analyzed,
                    assumption_label=gex.assumption_label,
                    strike_profile_json=gex.strike_profile,
                    source=str(chain.get("source", "alpaca_indicative")),
                    is_stale=bool(chain.get("is_stale", False)),
                )
                session.add(row)
                snapshots_saved[sym] = {
                    "net_gex": gex.net_gex,
                    "call_wall": gex.call_wall,
                    "put_wall": gex.put_wall,
                    "zero_gamma": gex.zero_gamma,
                }
            except ProviderUnconfiguredError as exc:
                return {"status": "unconfigured", "reason": str(exc), "snapshots": {}}
            except (ProviderError, httpx.HTTPError) as exc:
                errors.append(f"{sym}: {exc}")
        await session.commit()

    return {
        "status": "partial" if errors else "ok",
        "snapshots": snapshots_saved,
        "errors": errors,
    }


async def sync_calendars(
    session_factory: async_sessionmaker[AsyncSession],
    redis_client: aioredis.Redis | None,
    settings: Settings,
) -> dict[str, Any]:
    """Fetch upcoming US macro events (Fed/FRED/FMP) and earnings (Finnhub) into economic_calendar."""
    cache = _make_cache(redis_client)
    feeds = MacroFeedsClient(settings, cache=cache)
    events: list[dict[str, Any]] = []
    states: dict[str, str] = {}

    watchlist_syms: set[str] = set()
    try:
        async with session_factory() as session:
            wl_rows = (await session.execute(select(UserWatchlistItem.symbol))).scalars().all()
            watchlist_syms = {str(s).upper().strip() for s in wl_rows if s}
    except Exception as exc:  # noqa: BLE001
        logger.debug("Watchlist read skipped during calendar sync: %s", exc)

    # 1. Keyless official Federal Reserve FOMC schedule (never requires third-party key)
    try:
        fomc_events = await feeds.get_fed_fomc_calendar()
        events.extend(fomc_events)
        states["fed_fomc"] = f"ok ({len(fomc_events)})"
    except (ProviderError, httpx.HTTPError) as exc:
        states["fed_fomc"] = f"error: {exc}"

    # 2. FMP Economic Calendar (if Pro tier available)
    try:
        macro_events = await feeds.get_fmp_economic_calendar()
        events.extend(macro_events)
        states["fmp"] = f"ok ({len(macro_events)})"
    except ProviderUnconfiguredError:
        states["fmp"] = "unconfigured"
    except (ProviderError, httpx.HTTPError) as exc:
        err_text = str(exc)
        if "HTTP 402" in err_text or "HTTP 403" in err_text:
            states["fmp"] = "free_tier_gated_using_fred"
        else:
            states["fmp"] = f"error: {err_text}"

    # 3. Free official FRED Release Dates (CPI / PPI / NFP / PCE / Retail Sales / GDP)
    try:
        fred_events = await feeds.get_fred_macro_calendar()
        events.extend(fred_events)
        states["fred_calendar"] = f"ok ({len(fred_events)})"
    except ProviderUnconfiguredError:
        states["fred_calendar"] = "unconfigured"
    except (ProviderError, httpx.HTTPError) as exc:
        states["fred_calendar"] = f"error: {exc}"

    # 4. Finnhub corporate earnings prioritizing core + watchlist symbols
    try:
        earn_events = await feeds.get_finnhub_earnings_calendar(extra_symbols=watchlist_syms)
        events.extend(earn_events)
        states["finnhub"] = f"ok ({len(earn_events)})"
    except ProviderUnconfiguredError:
        states["finnhub"] = "unconfigured"
    except (ProviderError, httpx.HTTPError) as exc:
        states["finnhub"] = f"error: {exc}"

    if not events:
        return {"status": "skipped", "states": states, "upserted": 0}

    now = datetime.now(timezone.utc)
    # Deduplicate by event_key within same batch cleanly
    dedup_rows: dict[str, dict[str, Any]] = {}
    for ev in events:
        key = str(ev["event_key"])[:160]
        dedup_rows[key] = {
            "event_key": key,
            "event_type": str(ev.get("event_type", "macro")),
            "event_time": _parse_event_dt(str(ev.get("event_time", ""))),
            "symbol": ev.get("symbol"),
            "country": str(ev.get("country", "US")),
            "title": str(ev.get("title", ""))[:255],
            "impact": str(ev.get("impact", "Medium")),
            "actual": _to_float_or_none(ev.get("actual")),
            "estimate": _to_float_or_none(ev.get("estimate")),
            "previous": _to_float_or_none(ev.get("previous")),
            "eps_actual": _to_float_or_none(ev.get("eps_actual")),
            "eps_estimate": _to_float_or_none(ev.get("eps_estimate")),
            "revenue_estimate": _to_float_or_none(ev.get("revenue_estimate")),
            "source": str(ev.get("source", "fmp")),
            "fetched_at": now,
        }
    rows = list(dedup_rows.values())

    async with session_factory() as session:
        stmt = pg_insert(EconomicCalendarEvent).values(rows)
        stmt = stmt.on_conflict_do_update(
            constraint="uq_economic_calendar_event_key",
            set_={
                "event_time": stmt.excluded.event_time,
                "title": stmt.excluded.title,
                "impact": stmt.excluded.impact,
                "source": stmt.excluded.source,
                "actual": stmt.excluded.actual,
                "estimate": stmt.excluded.estimate,
                "eps_actual": stmt.excluded.eps_actual,
                "eps_estimate": stmt.excluded.eps_estimate,
                "fetched_at": now,
            },
        )
        await session.execute(stmt)
        await session.commit()

    return {"status": "ok", "states": states, "upserted": len(rows)}


def _serialize_calendar_event(ev: EconomicCalendarEvent) -> dict[str, Any]:
    return {
        "event_key": ev.event_key,
        "event_type": ev.event_type,
        "event_time": ev.event_time.isoformat(),
        "symbol": ev.symbol,
        "title": ev.title,
        "impact": ev.impact,
        "actual": ev.actual,
        "estimate": ev.estimate,
        "previous": ev.previous,
        "eps_actual": ev.eps_actual,
        "eps_estimate": ev.eps_estimate,
        "source": ev.source,
    }


async def query_upcoming_calendar_events(
    session: AsyncSession,
    *,
    macro_limit: int = 80,
    earnings_limit: int = 120,
) -> dict[str, Any]:
    """Read upcoming macro releases and focus/watchlist corporate earnings from PostgreSQL."""
    now_utc = datetime.now(timezone.utc)
    macro_stmt = (
        select(EconomicCalendarEvent)
        .where(
            EconomicCalendarEvent.event_type == "macro",
            EconomicCalendarEvent.event_time >= now_utc - timedelta(days=2),
        )
        .order_by(EconomicCalendarEvent.event_time)
        .limit(macro_limit)
    )
    macro_rows = list((await session.execute(macro_stmt)).scalars().all())
    macro_rows.sort(
        key=lambda ev: (
            0 if (ev.impact or "").lower() == "high" else 1,
            0 if ev.event_time >= now_utc - timedelta(hours=6) else 1,
            ev.event_time,
        )
    )

    wl_syms = {
        str(s).upper().strip()
        for s in (await session.execute(select(UserWatchlistItem.symbol))).scalars().all()
        if s
    }
    trade_syms = {
        str(s).upper().strip()
        for s in (
            await session.execute(
                select(PaperTrade.symbol).where(
                    PaperTrade.status.in_(["submitted", "filled", "accepted", "pending_hitl"])
                )
            )
        )
        .scalars()
        .all()
        if s
    }
    focus_earn_symbols: set[str] = {
        *DEFAULT_EQUITY_UNIVERSE,
        "AMD",
        "PLTR",
        "TSM",
        "NFLX",
        "COIN",
        "ORCL",
        "CRM",
        "MU",
        "INTC",
        "JPM",
        "GS",
        "LLY",
        "BRK.B",
        *wl_syms,
        *trade_syms,
    }

    earn_stmt = (
        select(EconomicCalendarEvent)
        .where(
            EconomicCalendarEvent.event_type == "earnings",
            EconomicCalendarEvent.event_time >= now_utc - timedelta(days=1),
            EconomicCalendarEvent.symbol.in_(focus_earn_symbols),
        )
        .order_by(EconomicCalendarEvent.event_time)
        .limit(earnings_limit)
    )
    earn_rows = list((await session.execute(earn_stmt)).scalars().all())
    earn_rows.sort(
        key=lambda ev: (
            0 if (ev.symbol or "").upper() in wl_syms else 1,
            0 if (ev.impact or "").lower() == "high" else 1,
            ev.event_time,
        )
    )

    merged_cal = macro_rows[:40] + earn_rows[:24]
    merged_cal.sort(
        key=lambda ev: (
            0 if (ev.event_type == "macro" and (ev.impact or "").lower() == "high") else 1,
            ev.event_time,
        )
    )
    return {
        "watchlist_symbols": sorted(wl_syms),
        "macro_events": [_serialize_calendar_event(ev) for ev in macro_rows],
        "earnings_events": [_serialize_calendar_event(ev) for ev in earn_rows[:30]],
        "upcoming_events": [_serialize_calendar_event(ev) for ev in merged_cal],
    }


async def _load_macro_series_map(
    session: AsyncSession,
    series_ids: Sequence[str],
    limit_per_series: int = 300,
) -> dict[str, list[tuple[date, float]]]:
    out: dict[str, list[tuple[date, float]]] = {}
    for sid in series_ids:
        stmt = (
            select(MacroSeriesPoint.obs_date, MacroSeriesPoint.value)
            .where(MacroSeriesPoint.series_id == sid)
            .order_by(desc(MacroSeriesPoint.obs_date))
            .limit(limit_per_series)
        )
        res = await session.execute(stmt)
        pts = [(row[0], float(row[1])) for row in res.all()]
        pts.reverse()
        out[sid] = pts
    return out


async def _load_bars_map(
    session: AsyncSession,
    symbols: Sequence[str],
    limit_per_symbol: int = 280,
) -> dict[str, list[DailyBarInput]]:
    out: dict[str, list[DailyBarInput]] = {}
    for sym in symbols:
        stmt = (
            select(MarketDailyBar)
            .where(MarketDailyBar.symbol == sym.upper())
            .order_by(desc(MarketDailyBar.trade_date))
            .limit(limit_per_symbol)
        )
        res = await session.execute(stmt)
        bars = [
            DailyBarInput(
                trade_date=b.trade_date.isoformat(),
                open=b.open,
                high=b.high,
                low=b.low,
                close=b.close,
                volume=b.volume,
                vwap=b.vwap,
            )
            for b in res.scalars().all()
        ]
        bars.reverse()
        if bars:
            out[sym.upper()] = bars
    return out


async def build_and_persist_overview(
    session_factory: async_sessionmaker[AsyncSession],
    redis_client: aioredis.Redis | None,
    settings: Settings,
    *,
    provider_states: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble full deterministic Market Regime & Overview payload and save to Postgres + Redis."""
    cache = _make_cache(redis_client)
    macro_ids = list(FRED_CORE_SERIES) + ["VIX9D", "VIX", "VIX3M"]
    all_symbols = list(DEFAULT_EQUITY_UNIVERSE) + ["BTCUSDT"]

    async with session_factory() as session:
        macro_map = await _load_macro_series_map(session, macro_ids)
        bars_map = await _load_bars_map(session, all_symbols)

        gex_map: dict[str, dict[str, Any]] = {}
        for g_sym in ("SPY", "QQQ"):
            stmt = (
                select(OptionsGexSnapshot)
                .where(OptionsGexSnapshot.symbol == g_sym)
                .order_by(desc(OptionsGexSnapshot.snapshot_time))
                .limit(1)
            )
            snap = (await session.execute(stmt)).scalar_one_or_none()
            if snap is not None:
                gex_map[g_sym] = {
                    "symbol": snap.symbol,
                    "snapshot_time": snap.snapshot_time.isoformat(),
                    "spot_price": snap.spot_price,
                    "net_gex": snap.net_gex,
                    "call_wall": snap.call_wall,
                    "put_wall": snap.put_wall,
                    "zero_gamma": snap.zero_gamma,
                    "put_call_ratio": snap.put_call_ratio,
                    "total_call_oi": snap.total_call_oi,
                    "total_put_oi": snap.total_put_oi,
                    "contracts_analyzed": snap.contracts_analyzed,
                    "assumption_label": snap.assumption_label,
                    "strike_profile": snap.strike_profile_json,
                    "is_stale": snap.is_stale,
                }

        cal_bundle = await query_upcoming_calendar_events(session)
        upcoming = cal_bundle["upcoming_events"]

    def _latest_val(sid: str) -> float | None:
        pts = macro_map.get(sid, [])
        return pts[-1][1] if pts else None

    net_liq = compute_net_liquidity_series(
        macro_map.get("WALCL", []),
        macro_map.get("WTREGEN", []),
        macro_map.get("RRPONTSYD", []),
    )

    hyg_closes = [b.close for b in bars_map.get("HYG", [])]
    lqd_closes = [b.close for b in bars_map.get("LQD", [])]
    yield_credit = compute_yield_and_credit_snapshot(
        dgs2=_latest_val("DGS2"),
        dgs10=_latest_val("DGS10"),
        dfii10=_latest_val("DFII10"),
        t10y2y=_latest_val("T10Y2Y"),
        hy_oas=_latest_val("BAMLH0A0HYM2"),
        ig_oas=_latest_val("BAMLC0A0CM"),
        sofr=_latest_val("SOFR"),
        wresbal_millions=_latest_val("WRESBAL"),
        hyg_closes=hyg_closes,
        lqd_closes=lqd_closes,
    )

    vix_spot = _latest_val("VIX") or _latest_val("VIXCLS")
    vix_struct = compute_vix_term_structure(
        vix9d=_latest_val("VIX9D"),
        vix=vix_spot,
        vix3m=_latest_val("VIX3M"),
    )

    core_technicals = {
        sym: analyze_asset_technicals(bars_map.get(sym, []))
        for sym in list(CORE_INDEX_ETFS) + ["BTCUSDT"]
    }
    spy_bars = bars_map.get("SPY", [])
    rsp_bars = bars_map.get("RSP", [])
    breadth = compute_market_breadth(
        {k: v for k, v in bars_map.items() if k != "BTCUSDT"},
        spy_bars=spy_bars,
        rsp_bars=rsp_bars,
    )
    sector_rotation = compute_sector_rotation(bars_map, spy_bars=spy_bars)
    cross_corr = compute_cross_asset_correlations(
        {
            k: bars_map[k]
            for k in ("SPY", "QQQ", "UUP", "GLD", "CPER", "TLT", "BTCUSDT")
            if k in bars_map
        }
    )

    spy_tech = core_technicals.get("SPY", {})
    soxx_tech = core_technicals.get("SOXX", {})
    btc_tech = core_technicals.get("BTCUSDT", {})

    # Align SPY daily close onto Net Liquidity timeline for direct macro-vs-market divergence reading
    spy_bars_sorted = sorted(spy_bars, key=lambda b: b.trade_date)
    if net_liq.get("series") and spy_bars_sorted:
        spy_dates = [b.trade_date for b in spy_bars_sorted]
        spy_closes_arr = [b.close for b in spy_bars_sorted]
        spy_idx = 0
        for pt in net_liq["series"]:
            pt_date = str(pt["date"])
            while spy_idx + 1 < len(spy_dates) and spy_dates[spy_idx + 1] <= pt_date:
                spy_idx += 1
            if spy_dates[spy_idx] <= pt_date or spy_idx == 0:
                pt["spy_close"] = round(float(spy_closes_arr[spy_idx]), 2)

    spy_20d = spy_tech.get("change_20d_pct") if isinstance(spy_tech, dict) else None
    soxx_20d = soxx_tech.get("change_20d_pct") if isinstance(soxx_tech, dict) else None
    soxx_rel_20d = (
        round(float(soxx_20d) - float(spy_20d), 2)
        if (soxx_20d is not None and spy_20d is not None)
        else None
    )

    fear_greed: dict[str, Any] | None = None
    try:
        cnn_fg = await fetch_cnn_fear_greed(cache=cache)
        if cnn_fg.get("score") is not None:
            fear_greed = cnn_fg
    except (ProviderError, httpx.HTTPError, OSError, ValueError):
        fear_greed = None

    if fear_greed is None:
        fear_greed = compute_fear_greed_index(
            spy_dist_200ma_pct=_to_float_or_none(spy_tech.get("dist_200ma_pct")),
            spy_20d_return_pct=_to_float_or_none(spy_20d),
            pct_above_50ma=_to_float_or_none(breadth.get("pct_above_50ma")),
            rsp_spy_20d_delta_pct=_to_float_or_none(breadth.get("rsp_spy_20d_delta_pct")),
            vix_spot=_to_float_or_none(vix_struct.get("vix")),
            vix_vix3m_ratio=_to_float_or_none(vix_struct.get("vix_vix3m_ratio")),
            hy_oas=_to_float_or_none(yield_credit.get("hy_oas")),
            hyg_lqd_20d_delta_pct=_to_float_or_none(yield_credit.get("hyg_lqd_20d_delta_pct")),
            soxx_spy_20d_delta_pct=soxx_rel_20d,
            btc_20d_return_pct=_to_float_or_none(btc_tech.get("change_20d_pct")),
        )
        fear_greed["source"] = "internal"

    spy_gex_net = _to_float_or_none(gex_map.get("SPY", {}).get("net_gex"))
    regime = classify_market_regime(
        net_liq_delta_20d=_to_float_or_none(net_liq.get("delta_20d_billions")),
        hy_oas=_to_float_or_none(yield_credit.get("hy_oas")),
        vix_spot=_to_float_or_none(vix_struct.get("vix")),
        vix_term_ratio=_to_float_or_none(vix_struct.get("vix_vix3m_ratio")),
        spy_dist_50ma_pct=_to_float_or_none(spy_tech.get("dist_50ma_pct")),
        pct_above_50ma=_to_float_or_none(breadth.get("pct_above_50ma")),
        spy_net_gex=spy_gex_net,
    )

    cot_env = await cache.read_envelope("marketelite:cftc:cot:legacy")
    cot_payload = cot_env.get("payload", {}) if cot_env else {}

    today_date = date.today()
    generated_at = datetime.now(timezone.utc).isoformat()

    overview: dict[str, Any] = {
        "generated_at": generated_at,
        "regime_date": today_date.isoformat(),
        "provider_states": provider_states or {},
        "regime": {
            **regime,
            "fear_greed": fear_greed,
        },
        "macro": {
            "net_liquidity": net_liq,
            "yield_credit": yield_credit,
            "vix_structure": vix_struct,
        },
        "equities": {
            "core_indices": core_technicals,
            "breadth": breadth,
            "sector_rotation": sector_rotation,
            "cross_asset_correlations": cross_corr,
        },
        "options_gex": gex_map,
        "positioning_and_calendar": {
            "cot": cot_payload,
            "upcoming_events": upcoming,
        },
    }

    async with session_factory() as session:
        stmt = pg_insert(MarketRegimeDaily).values(
            regime_date=today_date,
            regime_label=str(regime["regime_label"]),
            net_liquidity_billions=_to_float_or_none(net_liq.get("latest_billions")),
            net_liquidity_delta_20d=_to_float_or_none(net_liq.get("delta_20d_billions")),
            yield_spread_10y2y=_to_float_or_none(yield_credit.get("yield_spread_10y2y")),
            hy_oas=_to_float_or_none(yield_credit.get("hy_oas")),
            hyg_lqd_ratio=_to_float_or_none(yield_credit.get("hyg_lqd_ratio")),
            vix_spot=_to_float_or_none(vix_struct.get("vix")),
            vix_3m=_to_float_or_none(vix_struct.get("vix3m")),
            vix_term_ratio=_to_float_or_none(vix_struct.get("vix_vix3m_ratio")),
            vix_structure_state=str(vix_struct.get("structure_state", "")),
            fear_greed_score=_to_float_or_none(fear_greed.get("score")),
            fear_greed_label=str(fear_greed.get("label", "")),
            fear_greed_components_json=dict(fear_greed.get("components", {})),
            rsp_spy_ratio=_to_float_or_none(breadth.get("rsp_spy_ratio")),
            pct_above_50ma=_to_float_or_none(breadth.get("pct_above_50ma")),
            pct_above_200ma=_to_float_or_none(breadth.get("pct_above_200ma")),
            sector_rotation_json=sector_rotation,
            cross_asset_corr_json=cross_corr,
            cot_positioning_json=cot_payload,
            overview_payload_json=overview,
            computed_at=datetime.now(timezone.utc),
        )
        stmt = stmt.on_conflict_do_update(
            constraint="uq_market_regime_daily_date",
            set_={
                "regime_label": stmt.excluded.regime_label,
                "net_liquidity_billions": stmt.excluded.net_liquidity_billions,
                "net_liquidity_delta_20d": stmt.excluded.net_liquidity_delta_20d,
                "yield_spread_10y2y": stmt.excluded.yield_spread_10y2y,
                "hy_oas": stmt.excluded.hy_oas,
                "hyg_lqd_ratio": stmt.excluded.hyg_lqd_ratio,
                "vix_spot": stmt.excluded.vix_spot,
                "vix_3m": stmt.excluded.vix_3m,
                "vix_term_ratio": stmt.excluded.vix_term_ratio,
                "vix_structure_state": stmt.excluded.vix_structure_state,
                "fear_greed_score": stmt.excluded.fear_greed_score,
                "fear_greed_label": stmt.excluded.fear_greed_label,
                "fear_greed_components_json": stmt.excluded.fear_greed_components_json,
                "rsp_spy_ratio": stmt.excluded.rsp_spy_ratio,
                "pct_above_50ma": stmt.excluded.pct_above_50ma,
                "pct_above_200ma": stmt.excluded.pct_above_200ma,
                "sector_rotation_json": stmt.excluded.sector_rotation_json,
                "cross_asset_corr_json": stmt.excluded.cross_asset_corr_json,
                "cot_positioning_json": stmt.excluded.cot_positioning_json,
                "overview_payload_json": stmt.excluded.overview_payload_json,
                "computed_at": stmt.excluded.computed_at,
            },
        )
        await session.execute(stmt)
        await session.commit()

    await cache.write_envelope(
        OVERVIEW_CACHE_KEY,
        payload=overview,
        source="marketelite_pipeline",
        soft_ttl_seconds=900,
        hard_ttl_seconds=86400 * 7,
    )
    return overview


async def run_full_pipeline_sync(
    session_factory: async_sessionmaker[AsyncSession],
    redis_client: aioredis.Redis | None,
    settings: Settings,
    *,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Run all deterministic Phase 1 ingestion jobs and build overview cache snapshot."""
    macro_res = await sync_macro_and_cboe(
        session_factory, redis_client, settings, force_refresh=force_refresh
    )
    btc_cot_res = await sync_btc_and_cftc(
        session_factory, redis_client, settings, force_refresh=force_refresh
    )
    eq_res = await sync_equities_and_breadth(
        session_factory, redis_client, settings, force_refresh=force_refresh
    )
    gex_res = await sync_options_gex(
        session_factory, redis_client, settings, force_refresh=force_refresh
    )
    cal_res = await sync_calendars(session_factory, redis_client, settings)

    states = {
        "macro_cboe": macro_res.get("status", "unknown"),
        "btc_cftc": btc_cot_res.get("status", "unknown"),
        "equities": eq_res.get("status", "unknown"),
        "options_gex": gex_res.get("status", "unknown"),
        "calendars": cal_res.get("status", "unknown"),
    }
    overview = await build_and_persist_overview(
        session_factory, redis_client, settings, provider_states=states
    )
    try:
        discover_res = await get_or_refresh_discover_news(
            _make_cache(redis_client),
            settings,
            limit=21,
            force_refresh=force_refresh,
        )
        states["discover_news"] = f"ok:{discover_res.get('count', 0)}"
    except (httpx.HTTPError, ValueError, TypeError, OSError) as exc:  # pragma: no cover - best-effort news warmup
        logger.warning("Discover news warmup skipped: %s", exc)
        states["discover_news"] = "skipped"

    return {
        "states": states,
        "details": {
            "macro_cboe": macro_res,
            "btc_cftc": btc_cot_res,
            "equities": eq_res,
            "options_gex": gex_res,
            "calendars": cal_res,
        },
        "regime_label": overview["regime"]["regime_label"],
        "generated_at": overview["generated_at"],
    }


_VALID_TICKER_RE = re.compile(r"^[A-Z0-9.\-]{1,12}$")


async def ensure_asset_persisted(
    session_factory: async_sessionmaker[AsyncSession],
    redis_client: aioredis.Redis | None,
    settings: Settings,
    symbol: str,
    *,
    include_gex: bool = True,
    include_eps: bool = True,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """On-demand ingestion for ANY US ticker (bars + Estimated GEX + Finnhub EPS history)."""
    sym = symbol.upper().strip()
    if not _VALID_TICKER_RE.match(sym):
        raise ValueError(f"Invalid ticker symbol '{symbol}'. Expected 1-12 alphanumeric chars.")

    cache = _make_cache(redis_client)
    now = datetime.now(timezone.utc)
    bars_status = "cached"
    gex_status = "skipped"
    eps_status = "skipped"

    async with session_factory() as session:
        existing_bars = list(
            (
                await session.execute(
                    select(MarketDailyBar)
                    .where(MarketDailyBar.symbol == sym)
                    .order_by(desc(MarketDailyBar.trade_date))
                    .limit(260)
                )
            )
            .scalars()
            .all()
        )
        existing_gex = (
            await session.execute(
                select(OptionsGexSnapshot)
                .where(OptionsGexSnapshot.symbol == sym)
                .order_by(desc(OptionsGexSnapshot.snapshot_time))
                .limit(1)
            )
        ).scalar_one_or_none()
        existing_eps = list(
            (
                await session.execute(
                    select(ConsensusEpsSnapshot)
                    .where(ConsensusEpsSnapshot.symbol == sym)
                    .order_by(desc(ConsensusEpsSnapshot.fetched_at))
                    .limit(4)
                )
            )
            .scalars()
            .all()
        )

    need_bars = force_refresh or len(existing_bars) < 20
    if not need_bars and existing_bars:
        age_hours = (now - existing_bars[0].fetched_at).total_seconds() / 3600.0
        if age_hours > 24.0:
            need_bars = True

    bars_count = len(existing_bars)
    if need_bars:
        fetched_bars: list[dict[str, Any]] = []
        asset_class = "etf" if sym in (CORE_INDEX_ETFS + SECTOR_ETFS) else "equity"
        source = "alpaca_sip_1d"
        try:
            if sym == "BTCUSDT":
                asset_class = "crypto"
                source = "coingecko_1d"
                feeds = MacroFeedsClient(settings, cache=cache)
                btc_res = await feeds.get_btc_daily_bars(days=365, force_refresh=force_refresh)
                fetched_bars = list(btc_res.get("bars", []))
            else:
                alpaca = AlpacaClient(settings, cache=cache)
                bar_res = await alpaca.get_daily_bars(
                    [sym], lookback_days=420, force_refresh=force_refresh
                )
                fetched_bars = list((bar_res.get("bars") or {}).get(sym, []))
        except ProviderUnconfiguredError as exc:
            bars_status = f"unconfigured: {exc}"
        except (ProviderError, httpx.HTTPError) as exc:
            bars_status = f"error: {exc}"

        if fetched_bars:
            async with session_factory() as session:
                bars_count = await _upsert_daily_bars(session, sym, asset_class, fetched_bars, source)
                await session.commit()
            bars_status = "fetched"
        elif bars_count == 0:
            return {
                "symbol": sym,
                "found": False,
                "bars_count": 0,
                "bars_status": bars_status if bars_status != "cached" else "not_found",
                "gex_status": "skipped",
                "eps_status": "skipped",
            }

    if include_gex and sym != "BTCUSDT":
        need_gex = force_refresh or existing_gex is None
        if not need_gex and existing_gex is not None:
            gex_age_min = (now - existing_gex.snapshot_time).total_seconds() / 60.0
            need_gex = gex_age_min > 30.0
        if need_gex:
            try:
                alpaca = AlpacaClient(settings, cache=cache)
                chain = await alpaca.get_options_chain_inputs(sym, force_refresh=force_refresh)
                gex = compute_estimated_gex(sym, float(chain["spot_price"]), chain["contracts"])
                async with session_factory() as session:
                    session.add(
                        OptionsGexSnapshot(
                            symbol=gex.symbol,
                            spot_price=gex.spot_price,
                            net_gex=gex.net_gex,
                            call_wall=gex.call_wall,
                            put_wall=gex.put_wall,
                            zero_gamma=gex.zero_gamma,
                            put_call_ratio=gex.put_call_ratio,
                            total_call_oi=gex.total_call_oi,
                            total_put_oi=gex.total_put_oi,
                            contracts_analyzed=gex.contracts_analyzed,
                            assumption_label=gex.assumption_label,
                            strike_profile_json=gex.strike_profile,
                            source=str(chain.get("source", "alpaca_indicative")),
                            is_stale=bool(chain.get("is_stale", False)),
                        )
                    )
                    await session.commit()
                gex_status = "fetched"
            except ProviderUnconfiguredError:
                gex_status = "unconfigured"
            except (ProviderError, httpx.HTTPError, ValueError) as exc:
                gex_status = f"unavailable: {exc}"
        else:
            gex_status = "cached"

    if include_eps and sym not in ("BTCUSDT", *CORE_INDEX_ETFS, *SECTOR_ETFS):
        need_eps = force_refresh or not existing_eps
        if not need_eps and existing_eps:
            eps_age_hours = (now - existing_eps[0].fetched_at).total_seconds() / 3600.0
            need_eps = eps_age_hours > 12.0
        if need_eps:
            try:
                feeds = MacroFeedsClient(settings, cache=cache)
                eps_rows = await feeds.get_finnhub_company_eps_history(sym, limit=4)
                if eps_rows:
                    today = date.today()
                    db_rows = [
                        {
                            "symbol": sym,
                            "snapshot_date": today,
                            "period": str(r["period"])[:32],
                            "eps_avg": _to_float_or_none(r.get("estimate")),
                            "eps_high": _to_float_or_none(r.get("actual")),
                            "eps_low": _to_float_or_none(r.get("surprise_percent")),
                            "number_analysts": None,
                            "source": "finnhub_earnings",
                            "fetched_at": now,
                        }
                        for r in eps_rows
                    ]
                    async with session_factory() as session:
                        stmt = pg_insert(ConsensusEpsSnapshot).values(db_rows)
                        stmt = stmt.on_conflict_do_update(
                            constraint="uq_consensus_eps_symbol_date_period",
                            set_={
                                "eps_avg": stmt.excluded.eps_avg,
                                "eps_high": stmt.excluded.eps_high,
                                "eps_low": stmt.excluded.eps_low,
                                "fetched_at": now,
                            },
                        )
                        await session.execute(stmt)
                        await session.commit()
                    eps_status = "fetched"
                else:
                    eps_status = "empty"
            except ProviderUnconfiguredError:
                eps_status = "unconfigured"
            except (ProviderError, httpx.HTTPError) as exc:
                eps_status = f"unavailable: {exc}"
        else:
            eps_status = "cached"

    return {
        "symbol": sym,
        "found": True,
        "bars_count": bars_count,
        "bars_status": bars_status,
        "gex_status": gex_status,
        "eps_status": eps_status,
    }


async def get_regime_history(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    limit: int = 30,
) -> list[dict[str, Any]]:
    """Return chronological 30-day Regime & Fear/Greed history from market_regime_daily."""
    async with session_factory() as session:
        rows = list(
            (
                await session.execute(
                    select(MarketRegimeDaily)
                    .order_by(desc(MarketRegimeDaily.regime_date))
                    .limit(max(1, min(limit, 90)))
                )
            )
            .scalars()
            .all()
        )
    rows.reverse()
    return [
        {
            "regime_date": r.regime_date.isoformat(),
            "regime_label": r.regime_label,
            "fear_greed_score": r.fear_greed_score,
            "fear_greed_label": r.fear_greed_label,
            "vix_spot": r.vix_spot,
            "vix_3m": r.vix_3m,
            "vix_term_ratio": r.vix_term_ratio,
            "rsp_spy_ratio": r.rsp_spy_ratio,
            "pct_above_50ma": r.pct_above_50ma,
            "hy_oas": r.hy_oas,
            "net_liquidity_bn": r.net_liquidity_billions,
        }
        for r in rows
    ]


async def _sync_extra_watchlist_bars(
    session_factory: async_sessionmaker[AsyncSession],
    redis_client: aioredis.Redis | None,
    settings: Settings,
) -> int:
    """Keep custom watchlist tickers outside DEFAULT_EQUITY_UNIVERSE fresh in DB."""
    if not (settings.alpaca_api_key.strip() and settings.alpaca_secret_key.strip()):
        return 0
    async with session_factory() as session:
        rows = (
            await session.execute(select(UserWatchlistItem.symbol).distinct())
        ).scalars().all()
    universe_set = {s.upper() for s in DEFAULT_EQUITY_UNIVERSE} | {"BTCUSDT"}
    extra_syms = sorted(
        {str(s).upper().strip() for s in rows if str(s).strip()} - universe_set
    )
    if not extra_syms:
        return 0
    cache = _make_cache(redis_client)
    alpaca = AlpacaClient(settings, cache=cache)
    res = await alpaca.get_daily_bars(extra_syms, lookback_days=40, force_refresh=False)
    bars_by_sym: dict[str, list[dict[str, Any]]] = res.get("bars", {})
    updated = 0
    async with session_factory() as session:
        for sym, bar_list in bars_by_sym.items():
            n = await _upsert_daily_bars(session, sym, "equity", bar_list, "alpaca_sip_1d")
            if n > 0:
                updated += 1
        await session.commit()
    return updated


async def startup_market_bars_warmup(
    session_factory: async_sessionmaker[AsyncSession],
    redis_client: aioredis.Redis | None,
    settings: Settings,
    interval_seconds: float = 1800.0,
) -> None:
    """Keep Postgres daily bars, GEX, and overview aligned when worker daemon is absent."""
    await asyncio.sleep(2.5)
    while True:
        try:
            async with session_factory() as session:
                spy_latest = (
                    await session.execute(
                        select(func.max(MarketDailyBar.trade_date)).where(
                            MarketDailyBar.symbol == "SPY"
                        )
                    )
                ).scalar_one_or_none()
                btc_latest = (
                    await session.execute(
                        select(func.max(MarketDailyBar.trade_date)).where(
                            MarketDailyBar.symbol == "BTCUSDT"
                        )
                    )
                ).scalar_one_or_none()

            has_alpaca = bool(
                settings.alpaca_api_key.strip() and settings.alpaca_secret_key.strip()
            )
            if spy_latest is None and not has_alpaca:
                from app.services.demo_seed import ensure_demo_snapshot_seeded

                seed_res = await ensure_demo_snapshot_seeded(
                    session_factory, redis_client, settings, force=False
                )
                logger.info("0-Key cold start demo snapshot check: %s", seed_res)

            today_utc = datetime.now(timezone.utc).date()
            btc_stale = btc_latest is None or btc_latest < today_utc
            eq_stale = spy_latest is None or (today_utc - spy_latest).days >= 2

            btc_res = await sync_btc_and_cftc(
                session_factory, redis_client, settings, force_refresh=btc_stale
            )
            eq_res = await sync_equities_and_breadth(
                session_factory, redis_client, settings, force_refresh=eq_stale
            )
            extra_n = await _sync_extra_watchlist_bars(session_factory, redis_client, settings)
            await sync_calendars(session_factory, redis_client, settings)
            await build_macro_release_history(_make_cache(redis_client), settings)
            await build_and_persist_overview(
                session_factory,
                redis_client,
                settings,
                provider_states={
                    "btc_cftc": btc_res.get("status", "unknown"),
                    "equities": eq_res.get("status", "unknown"),
                },
            )
            logger.info(
                "Background market bars warmup synced: btc=%s eq=%s extra_watchlist=%d (prev spy=%s btc=%s)",
                btc_res.get("status"),
                eq_res.get("status"),
                extra_n,
                spy_latest,
                btc_latest,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - keep loop alive across transient provider hiccups
            logger.warning("Background market bars warmup skipped: %s", exc)
        await asyncio.sleep(max(300.0, float(interval_seconds)))

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import date, datetime, timezone
from typing import Any

import httpx
import redis.asyncio as aioredis
from sqlalchemy import desc, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.db.models import (
    EconomicCalendarEvent,
    MacroSeriesPoint,
    MarketDailyBar,
    MarketRegimeDaily,
    OptionsGexSnapshot,
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
from app.services.providers.alpaca import (
    CORE_INDEX_ETFS,
    DEFAULT_EQUITY_UNIVERSE,
    SECTOR_ETFS,
    AlpacaClient,
)
from app.services.providers.cboe import CboeClient
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
    """Fetch upcoming US macro events (FMP) and earnings (Finnhub) into economic_calendar."""
    cache = _make_cache(redis_client)
    feeds = MacroFeedsClient(settings, cache=cache)
    events: list[dict[str, Any]] = []
    states: dict[str, str] = {}

    try:
        macro_events = await feeds.get_fmp_economic_calendar()
        events.extend(macro_events)
        states["fmp"] = "ok"
    except ProviderUnconfiguredError:
        states["fmp"] = "unconfigured"
    except (ProviderError, httpx.HTTPError) as exc:
        err_text = str(exc)
        if "HTTP 402" in err_text or "HTTP 403" in err_text:
            states["fmp"] = "free_tier_gated_using_fred"
        else:
            states["fmp"] = f"error: {err_text}"

    if states.get("fmp") != "ok":
        try:
            fred_events = await feeds.get_fred_macro_calendar()
            events.extend(fred_events)
            states["fred_calendar"] = f"ok ({len(fred_events)})"
        except ProviderUnconfiguredError:
            states["fred_calendar"] = "unconfigured"
        except (ProviderError, httpx.HTTPError) as exc:
            states["fred_calendar"] = f"error: {exc}"

    try:
        earn_events = await feeds.get_finnhub_earnings_calendar()
        events.extend(earn_events)
        states["finnhub"] = "ok"
    except ProviderUnconfiguredError:
        states["finnhub"] = "unconfigured"
    except (ProviderError, httpx.HTTPError) as exc:
        states["finnhub"] = f"error: {exc}"

    if not events:
        return {"status": "skipped", "states": states, "upserted": 0}

    now = datetime.now(timezone.utc)
    rows = []
    for ev in events:
        rows.append(
            {
                "event_key": str(ev["event_key"])[:160],
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
        )

    async with session_factory() as session:
        stmt = pg_insert(EconomicCalendarEvent).values(rows)
        stmt = stmt.on_conflict_do_update(
            constraint="uq_economic_calendar_event_key",
            set_={
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

        macro_stmt = (
            select(EconomicCalendarEvent)
            .where(
                EconomicCalendarEvent.event_type == "macro",
                EconomicCalendarEvent.event_time >= datetime.now(timezone.utc),
            )
            .order_by(EconomicCalendarEvent.event_time)
            .limit(10)
        )
        earn_stmt = (
            select(EconomicCalendarEvent)
            .where(
                EconomicCalendarEvent.event_type == "earnings",
                EconomicCalendarEvent.event_time >= datetime.now(timezone.utc),
            )
            .order_by(EconomicCalendarEvent.event_time)
            .limit(12)
        )
        merged_cal = list((await session.execute(macro_stmt)).scalars().all()) + list(
            (await session.execute(earn_stmt)).scalars().all()
        )
        merged_cal.sort(key=lambda ev: ev.event_time)
        upcoming = [
            {
                "event_key": ev.event_key,
                "event_type": ev.event_type,
                "event_time": ev.event_time.isoformat(),
                "symbol": ev.symbol,
                "title": ev.title,
                "impact": ev.impact,
                "estimate": ev.estimate,
                "previous": ev.previous,
                "eps_estimate": ev.eps_estimate,
            }
            for ev in merged_cal
        ]

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
    spy_20d = spy_tech.get("change_20d_pct") if isinstance(spy_tech, dict) else None
    soxx_20d = soxx_tech.get("change_20d_pct") if isinstance(soxx_tech, dict) else None
    soxx_rel_20d = (
        round(float(soxx_20d) - float(spy_20d), 2)
        if (soxx_20d is not None and spy_20d is not None)
        else None
    )

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

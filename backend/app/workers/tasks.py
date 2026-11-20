from __future__ import annotations

import logging
from typing import Any

from app.agents.watchdog import reflect_on_trade, run_watchdog_scan
from app.api.trade import sync_paper_trade_statuses
from app.services.pipeline import (
    build_and_persist_overview,
    run_full_pipeline_sync,
    sync_btc_and_cftc,
    sync_calendars,
    sync_equities_and_breadth,
    sync_macro_and_cboe,
    sync_options_gex,
)

logger = logging.getLogger(__name__)


async def job_sync_macro_and_cboe(ctx: dict[str, Any]) -> dict[str, Any]:
    """Scheduled ARQ job: sync FRED liquidity/credit series + CBOE VIX term structure."""
    res = await sync_macro_and_cboe(ctx["session_factory"], ctx["redis"], ctx["settings"])
    await build_and_persist_overview(ctx["session_factory"], ctx["redis"], ctx["settings"])
    return res


async def job_sync_equities_and_options(ctx: dict[str, Any]) -> dict[str, Any]:
    """Scheduled ARQ job: sync 15m-delayed SIP bars, BTC, and SPY/QQQ Estimated GEX."""
    btc = await sync_btc_and_cftc(ctx["session_factory"], ctx["redis"], ctx["settings"])
    eq = await sync_equities_and_breadth(ctx["session_factory"], ctx["redis"], ctx["settings"])
    gex = await sync_options_gex(ctx["session_factory"], ctx["redis"], ctx["settings"])
    overview = await build_and_persist_overview(
        ctx["session_factory"],
        ctx["redis"],
        ctx["settings"],
        provider_states={
            "btc_cftc": btc.get("status", "unknown"),
            "equities": eq.get("status", "unknown"),
            "options_gex": gex.get("status", "unknown"),
        },
    )
    return {
        "btc": btc.get("status"),
        "equities": eq.get("status"),
        "options_gex": gex.get("status"),
        "regime_label": overview["regime"]["regime_label"],
    }


async def job_sync_calendars_and_cot(ctx: dict[str, Any]) -> dict[str, Any]:
    """Scheduled ARQ job: sync FMP macro calendar, Finnhub earnings, and CFTC COT."""
    cal = await sync_calendars(ctx["session_factory"], ctx["redis"], ctx["settings"])
    cftc = await sync_btc_and_cftc(ctx["session_factory"], ctx["redis"], ctx["settings"])
    await build_and_persist_overview(ctx["session_factory"], ctx["redis"], ctx["settings"])
    return {"calendars": cal, "btc_cftc": cftc}


async def job_full_bootstrap_sync(
    ctx: dict[str, Any], force_refresh: bool = False
) -> dict[str, Any]:
    """Manual / startup ARQ job executing the complete Phase 1 deterministic sync."""
    logger.info("Executing ARQ full Phase 1 bootstrap sync (force_refresh=%s)", force_refresh)
    return await run_full_pipeline_sync(
        ctx["session_factory"],
        ctx["redis"],
        ctx["settings"],
        force_refresh=force_refresh,
    )


async def job_run_watchdog_and_reflect(ctx: dict[str, Any]) -> dict[str, Any]:
    """Scheduled Phase 5 job: intraday anomaly alerts + closed trade reflections."""
    session_factory = ctx["session_factory"]
    settings = ctx["settings"]
    scan_res = await run_watchdog_scan(session_factory, settings, use_fast_llm=True)
    sync_res = await sync_paper_trade_statuses(session_factory, settings)
    reflected = 0
    for trade_id in sync_res.get("newly_closed_trade_ids", []):
        try:
            await reflect_on_trade(session_factory, settings, int(trade_id), use_fast_llm=True)
            reflected += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("Post-close reflection failed for trade %s: %s", trade_id, exc)
    return {
        "scan": scan_res,
        "trade_sync": sync_res,
        "reflected": reflected,
    }

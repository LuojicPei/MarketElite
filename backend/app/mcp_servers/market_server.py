from __future__ import annotations

import contextvars
import logging
from datetime import datetime, timezone
from typing import Any

import httpx
import redis.asyncio as aioredis
from mcp.server.fastmcp import FastMCP
from pydantic import Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings, get_settings
from app.db.models import (
    EconomicCalendarEvent,
    EpisodicMemory,
    MarketDailyBar,
    MarketRegimeDaily,
    OptionsGexSnapshot,
    UserWatchlistItem,
    WatchdogAlert,
)
from app.db.session import create_db_engine, create_session_factory
from app.quant.technicals import DailyBarInput, analyze_asset_technicals
from app.rag.hybrid_search import HybridSecRetriever
from app.services.broker import BrokerConfig, fetch_unified_broker_state
from app.services.llm_router import estimate_text_tokens
from app.services.pipeline import OVERVIEW_CACHE_KEY, ensure_asset_persisted
from app.services.providers.alpaca import AlpacaClient
from app.services.resilience import DualTTLCache, ProviderError

logger = logging.getLogger(__name__)

_BROKER_OVERRIDE_CTX: contextvars.ContextVar[BrokerConfig | None] = contextvars.ContextVar(
    "market_mcp_broker_override", default=None
)


def set_request_broker_context(cfg: BrokerConfig | None) -> contextvars.Token[BrokerConfig | None]:
    """Bind caller broker credentials (e.g. Trading212 / Sandbox) for read-only MCP lookups."""
    return _BROKER_OVERRIDE_CTX.set(cfg)


def reset_request_broker_context(token: contextvars.Token[BrokerConfig | None]) -> None:
    _BROKER_OVERRIDE_CTX.reset(token)


class _McpRuntimeContext:
    settings: Settings | None = None
    session_factory: async_sessionmaker[AsyncSession] | None = None
    redis: aioredis.Redis | None = None


_RUNTIME = _McpRuntimeContext()


def configure_mcp_dependencies(
    *,
    settings: Settings,
    session_factory: async_sessionmaker[AsyncSession],
    redis_client: aioredis.Redis | None,
) -> None:
    """Bind FastAPI runtime DB/Redis resources cleanly for in-process FastMCP tools."""
    _RUNTIME.settings = settings
    _RUNTIME.session_factory = session_factory
    _RUNTIME.redis = redis_client


def _get_runtime() -> tuple[Settings, async_sessionmaker[AsyncSession], aioredis.Redis | None]:
    settings = _RUNTIME.settings or get_settings()
    if _RUNTIME.session_factory is None:
        engine = create_db_engine(settings)
        _RUNTIME.session_factory = create_session_factory(engine)
    return settings, _RUNTIME.session_factory, _RUNTIME.redis


def _truncate_to_token_budget(text: str, max_tokens: int = 340) -> str:
    if estimate_text_tokens(text) <= max_tokens:
        return text
    lines = text.splitlines()
    kept: list[str] = []
    for line in lines:
        candidate = "\n".join([*kept, line])
        if estimate_text_tokens(candidate) > max_tokens:
            break
        kept.append(line)
    if kept:
        return "\n".join(kept) + "\n...[compressed to fit budget]"
    return text[: max_tokens * 3] + "..."


async def get_market_regime_snapshot() -> str:
    """Read precomputed US Market Regime, Fed Net Liquidity, VIX term structure & top/bottom sectors (~250 tokens)."""
    _, session_factory, redis_client = _get_runtime()
    payload: dict[str, Any] | None = None

    if redis_client is not None:
        env = await DualTTLCache(redis_client).read_envelope(OVERVIEW_CACHE_KEY)
        if env and isinstance(env.get("payload"), dict):
            payload = env["payload"]

    if payload is None:
        async with session_factory() as session:
            stmt = select(MarketRegimeDaily).order_by(desc(MarketRegimeDaily.regime_date)).limit(1)
            latest = (await session.execute(stmt)).scalar_one_or_none()
            if latest and isinstance(latest.overview_payload_json, dict):
                payload = latest.overview_payload_json

    if not payload:
        return "Regime snapshot unavailable. Ask operator to run POST /api/pipeline/sync."

    regime = payload.get("regime", {})
    macro = payload.get("macro", {})
    liq = macro.get("net_liquidity", {})
    yc = macro.get("yield_credit", {})
    vix = macro.get("vix_structure", {})
    breadth = payload.get("equities", {}).get("breadth", {})
    sectors = payload.get("equities", {}).get("sector_rotation", [])

    top_secs = ", ".join(
        f"{s['symbol']}({s.get('return_20d_pct')}%)" for s in sectors[:3] if s.get("symbol")
    )
    bot_secs = ", ".join(
        f"{s['symbol']}({s.get('return_20d_pct')}%)" for s in sectors[-3:] if s.get("symbol")
    )

    text = "\n".join(
        [
            f"Regime Date: {payload.get('regime_date')} | Label: {regime.get('regime_label')}",
            f"Drivers: {'; '.join(regime.get('drivers', [])) or 'Balanced'}",
            (
                f"Fear & Greed: {regime.get('fear_greed', {}).get('score')} "
                f"({regime.get('fear_greed', {}).get('label')})"
            ),
            (
                f"Fed Net Liquidity: ${liq.get('latest_billions')}B "
                f"(20D delta: {liq.get('delta_20d_billions')}B)"
            ),
            (
                f"Rates & Credit: 10Y-2Y={yc.get('yield_spread_10y2y')}%, "
                f"HY_OAS={yc.get('hy_oas')}% ({yc.get('credit_state')}), "
                f"HYG/LQD={yc.get('hyg_lqd_ratio')}"
            ),
            (
                f"Volatility: VIX={vix.get('vix')}, VIX3M={vix.get('vix3m')}, "
                f"Ratio={vix.get('vix_vix3m_ratio')} ({vix.get('structure_state')})"
            ),
            (
                f"Breadth: >50MA={breadth.get('pct_above_50ma')}%, "
                f">200MA={breadth.get('pct_above_200ma')}%, "
                f"RSP/SPY 20D={breadth.get('rsp_spy_20d_delta_pct')}%"
            ),
            f"20D Sectors Top: [{top_secs}] | Laggards: [{bot_secs}]",
        ]
    )
    return _truncate_to_token_budget(text, max_tokens=280)


async def get_asset_structure(
    symbol: str = Field(description="US stock, ETF, or BTCUSDT ticker symbol, e.g. SPY, QQQ, NVDA."),
) -> str:
    """Return compressed deterministic technicals, RVOL 4-quadrant state, Estimated GEX walls & headlines (~280 tokens)."""
    settings, session_factory, redis_client = _get_runtime()
    sym = symbol.upper().strip()
    if not sym or len(sym) > 16:
        raise ValueError("Ticker symbol must be 1-16 characters.")

    async with session_factory() as session:
        bar_stmt = (
            select(MarketDailyBar)
            .where(MarketDailyBar.symbol == sym)
            .order_by(desc(MarketDailyBar.trade_date))
            .limit(260)
        )
        db_bars = list((await session.execute(bar_stmt)).scalars().all())
        db_bars.reverse()

        gex_stmt = (
            select(OptionsGexSnapshot)
            .where(OptionsGexSnapshot.symbol == sym)
            .order_by(desc(OptionsGexSnapshot.snapshot_time))
            .limit(1)
        )
        gex = (await session.execute(gex_stmt)).scalar_one_or_none()

    if not db_bars or (sym != "BTCUSDT" and gex is None):
        try:
            await ensure_asset_persisted(
                session_factory,
                redis_client,
                settings,
                sym,
                include_gex=(sym != "BTCUSDT"),
                include_eps=True,
                force_refresh=False,
            )
        except (ProviderError, httpx.HTTPError, ValueError, OSError, RuntimeError) as exc:  # pragma: no cover - defensive runtime fallback
            logger.warning("On-demand ensure_asset_persisted warning for %s: %s", sym, exc)

        async with session_factory() as session:
            bar_stmt = (
                select(MarketDailyBar)
                .where(MarketDailyBar.symbol == sym)
                .order_by(desc(MarketDailyBar.trade_date))
                .limit(260)
            )
            db_bars = list((await session.execute(bar_stmt)).scalars().all())
            db_bars.reverse()
            gex_stmt = (
                select(OptionsGexSnapshot)
                .where(OptionsGexSnapshot.symbol == sym)
                .order_by(desc(OptionsGexSnapshot.snapshot_time))
                .limit(1)
            )
            gex = (await session.execute(gex_stmt)).scalar_one_or_none()

    if not db_bars:
        return f"No daily bars persisted in PostgreSQL for {sym} after live lookup."

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
        for b in db_bars
    ]
    tech = analyze_asset_technicals(bars)
    macd = tech.get("macd") or {}

    lines = [
        f"Asset: {sym} (as of {tech.get('as_of_date')}, source={db_bars[-1].source})",
        (
            f"Price: ${tech.get('last_close')} | 1D={tech.get('change_1d_pct')}% | "
            f"5D={tech.get('change_5d_pct')}% | 20D={tech.get('change_20d_pct')}%"
        ),
        (
            f"Trend: Dist 50MA={tech.get('dist_50ma_pct')}%, "
            f"Dist 200MA={tech.get('dist_200ma_pct')}%, "
            f"EMA20={tech.get('ema_20')}"
        ),
        (
            f"Momentum & Vol: RSI14={tech.get('rsi_14')}, "
            f"MACD Hist={macd.get('histogram')}, ATR%={tech.get('atr_pct')}%"
        ),
        (
            f"Volume Structure: RVOL(20)={tech.get('rvol_20')}x "
            f"[{tech.get('rvol_basis')}] -> {tech.get('volume_price_tag')}"
        ),
    ]

    if gex is not None:
        lines.append(
            f"Estimated GEX ($/1% move, Dealer Assumption): Net=${gex.net_gex / 1e9:.2f}B, "
            f"Call Wall=${gex.call_wall}, Put Wall=${gex.put_wall}, "
            f"Zero Gamma=${gex.zero_gamma}, P/C OI={gex.put_call_ratio}"
        )

    try:
        news = await AlpacaClient(settings).get_news([sym], limit=3)
        if news:
            headlines = " | ".join(f"[{n['source']}] {n['headline']}" for n in news[:2])
            lines.append(f"Headlines: {headlines}")
    except ProviderError:
        pass

    return _truncate_to_token_budget("\n".join(lines), max_tokens=300)


async def get_macro_and_earnings_calendar(
    days_ahead: int = Field(default=14, ge=1, le=60, description="Lookahead horizon in days."),
    symbol: str | None = Field(default=None, description="Optional ticker to filter earnings."),
) -> str:
    """Return upcoming US macro data releases (CPI/NFP/PCE/GDP) and major earnings (~220 tokens)."""
    _, session_factory, _ = _get_runtime()
    now = datetime.now(timezone.utc)
    sym_filter = symbol.upper().strip() if symbol else None

    async with session_factory() as session:
        stmt = (
            select(EconomicCalendarEvent)
            .where(EconomicCalendarEvent.event_time >= now)
            .order_by(EconomicCalendarEvent.event_time)
            .limit(40)
        )
        events = list((await session.execute(stmt)).scalars().all())

    if sym_filter:
        filtered = [
            ev for ev in events if ev.event_type == "macro" or ev.symbol == sym_filter
        ][:8]
    else:
        filtered = [ev for ev in events if ev.event_type == "macro"][:5] + [
            ev for ev in events if ev.event_type == "earnings" and ev.impact == "High"
        ][:5]

    if not filtered:
        return "No upcoming macro or high-impact earnings found in lookahead window."

    lines = ["Upcoming Catalysts:"]
    for ev in filtered[:10]:
        est_txt = f" (EPS Est ${ev.eps_estimate:.2f})" if ev.eps_estimate is not None else ""
        lines.append(
            f"- {ev.event_time.date().isoformat()} [{ev.event_type.upper()}|{ev.impact}] "
            f"{ev.title}{est_txt}"
        )
    return _truncate_to_token_budget("\n".join(lines), max_tokens=240)


async def get_sec_filings_context(
    symbol: str = Field(description="US equity ticker symbol, e.g. AAPL, NVDA, MSFT."),
    query: str = Field(description="Specific question or financial topic to retrieve."),
    form_type: str | None = Field(
        default=None, description="Optional filing form filter: '10-K' or '10-Q'."
    ),
    top_k: int = Field(default=4, ge=1, le=6, description="Max chunks to return."),
) -> str:
    """Lazy-load recent 10-K/10-Q from SEC EDGAR and retrieve cited passages via pgvector+BM25 RRF (~360 tokens)."""
    settings, session_factory, _ = _get_runtime()
    retriever = HybridSecRetriever(settings, session_factory)
    result = await retriever.search(
        symbol=symbol,
        query=query,
        form_type=form_type,
        top_k=top_k,
        auto_ingest=True,
    )
    chunks = result.get("chunks", [])
    if not chunks:
        return f"No SEC filing passages found for {symbol.upper()} matching query '{query}'."

    lines = [f"SEC Hybrid RAG ({result['mode']}) for {symbol.upper()}:"]
    for ch in chunks:
        excerpt = str(ch["content"])[:320].strip()
        lines.append(
            f"[{ch['symbol']} {ch['form_type']} {ch['filing_date']} · {ch['section_title']}]: "
            f"{excerpt}..."
        )
    return _truncate_to_token_budget("\n".join(lines), max_tokens=360)


async def get_account_positions_snapshot() -> str:
    """Read active broker account equity, cash, open holdings and unrealized P&L snapshot (~320 tokens)."""
    from app.services.broker import resolve_broker_config

    settings, session_factory, redis_client = _get_runtime()
    broker_cfg = _BROKER_OVERRIDE_CTX.get() or resolve_broker_config(settings)
    state = await fetch_unified_broker_state(
        session_factory=session_factory,
        settings=settings,
        redis_client=redis_client,
        broker_cfg=broker_cfg,
        force_refresh=False,
    )
    acc = state.get("account") or {}
    ccy = str(state.get("currency") or acc.get("currency") or "USD")
    positions = state.get("positions") or []
    working = state.get("orders") or []

    lines = [
        f"Active Account: {state.get('broker_label')} | ReadOnly={state.get('read_only')} | Currency={ccy}",
        (
            f"Equity={acc.get('equity', 0):,.2f} {ccy} | Cash={acc.get('cash', 0):,.2f} {ccy} | "
            f"UnrealizedPnL={acc.get('unrealized_pl', 0):+.2f} {ccy}"
        ),
    ]
    if state.get("broker_error"):
        lines.append(f"Account Notice: {state['broker_error']}")
    if not positions:
        lines.append("Open Positions: None (0 holdings).")
    else:
        lines.append(f"Open Positions ({len(positions)}):")
        for p in positions[:12]:
            plpc = float(p.get("unrealized_plpc", 0.0)) * 100.0
            lines.append(
                f"- {p.get('symbol')}: qty={p.get('qty')}, avg=${p.get('avg_entry_price')}, "
                f"now=${p.get('current_price')}, value={p.get('market_value'):,.2f} {p.get('currency', ccy)}, "
                f"PnL={p.get('unrealized_pl', 0):+.2f} ({plpc:+.1f}%)"
            )
    if working:
        lines.append(f"Active Working Items: {len(working)}")
    return _truncate_to_token_budget("\n".join(lines), max_tokens=340)


async def get_watchlist_matrix() -> str:
    """Read user's watched symbols with 1D/5D/YTD performance, RSI14 and RVOL20 (~340 tokens)."""
    _, session_factory, _ = _get_runtime()
    async with session_factory() as session:
        ws_id = (_BROKER_OVERRIDE_CTX.get().workspace_id if _BROKER_OVERRIDE_CTX.get() else "default")
        wl_rows = list(
            (
                await session.execute(
                    select(UserWatchlistItem)
                    .where(UserWatchlistItem.workspace_id == ws_id)
                    .order_by(UserWatchlistItem.sort_order)
                )
            )
            .scalars()
            .all()
        )
        syms = [r.symbol for r in wl_rows] or ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "TSLA"]
        lines = [f"User Watchlist Matrix ({len(syms)} symbols):"]
        for sym in syms[:14]:
            bars = list(
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
            if len(bars) < 2:
                lines.append(f"- {sym}: insufficient bars")
                continue
            bars.reverse()
            tech = analyze_asset_technicals(
                [
                    DailyBarInput(
                        trade_date=b.trade_date.isoformat(),
                        open=b.open,
                        high=b.high,
                        low=b.low,
                        close=b.close,
                        volume=b.volume,
                        vwap=b.vwap,
                    )
                    for b in bars
                ]
            )
            yr_prefix = bars[-1].trade_date.isoformat()[:4]
            prev_yr_bars = [b for b in bars if b.trade_date.isoformat() < f"{yr_prefix}-01-01"]
            ytd_base = float(prev_yr_bars[-1].close) if prev_yr_bars else float(bars[0].close)
            ytd_pct = ((float(bars[-1].close) / ytd_base) - 1.0) * 100.0 if ytd_base > 0 else 0.0
            lines.append(
                f"- {sym}: ${tech.get('last_close')} | 1D={tech.get('change_1d_pct'):+.2f}% | "
                f"5D={tech.get('change_5d_pct'):+.2f}% | YTD={ytd_pct:+.1f}% | "
                f"RSI={tech.get('rsi_14')} | RVOL={tech.get('rvol_20')}x"
            )
    return _truncate_to_token_budget("\n".join(lines), max_tokens=360)


async def get_watchdog_and_memories(
    symbol: str | None = Field(default=None, description="Optional ticker filter, e.g. NVDA."),
) -> str:
    """Read active intraday Watchdog anomaly alerts and recalled historical lessons (~320 tokens)."""
    _, session_factory, _ = _get_runtime()
    sym_filter = symbol.upper().strip() if symbol else None
    ws_id = (_BROKER_OVERRIDE_CTX.get().workspace_id if _BROKER_OVERRIDE_CTX.get() else "default")
    async with session_factory() as session:
        al_stmt = (
            select(WatchdogAlert)
            .where(WatchdogAlert.workspace_id == ws_id)
            .order_by(WatchdogAlert.acknowledged.asc(), desc(WatchdogAlert.created_at))
        )
        if sym_filter:
            al_stmt = al_stmt.where(WatchdogAlert.symbol.in_([sym_filter, "SPY"]))
        alerts = list((await session.execute(al_stmt.limit(5))).scalars().all())

        mem_stmt = (
            select(EpisodicMemory)
            .where(
                EpisodicMemory.workspace_id == ws_id,
                EpisodicMemory.is_active.is_(True),
            )
            .order_by(desc(EpisodicMemory.is_pinned), desc(EpisodicMemory.created_at))
        )
        if sym_filter:
            mem_stmt = mem_stmt.where(EpisodicMemory.symbol == sym_filter)
        memories = list((await session.execute(mem_stmt.limit(4))).scalars().all())

    lines: list[str] = []
    if alerts:
        lines.append(f"Intraday Watchdog Alerts ({len(alerts)}):")
        for al in alerts:
            ack_tag = "ACKED" if al.acknowledged else "UNACKED"
            lines.append(f"- [{al.severity.upper()}|{ack_tag}] {al.symbol or 'MACRO'}: {al.title}")
    else:
        lines.append("Intraday Watchdog Alerts: None recorded.")

    if memories:
        lines.append(f"Historical Attribution Lessons ({len(memories)}):")
        for m in memories:
            alpha_s = f", Alpha={m.alpha_vs_spy_pct:+.2f}%" if m.alpha_vs_spy_pct is not None else ""
            lines.append(
                f"- [{m.symbol}|{m.regime_label}|{m.quadrant_outcome}{alpha_s}] {m.title}: "
                f"{m.lesson_text[:150]}"
            )
    else:
        lines.append("Historical Attribution Lessons: None yet.")

    return _truncate_to_token_budget("\n".join(lines), max_tokens=340)


async def compare_assets_structure(
    symbols_csv: str = Field(
        description="Comma-separated US tickers to compare side-by-side (max 4), e.g. 'NVDA,LITE,AAPL'."
    ),
) -> str:
    """Compare up to 4 tickers side-by-side across price trend, RSI, RVOL, and Estimated GEX (~360 tokens)."""
    syms = [s.strip().upper() for s in (symbols_csv or "").split(",") if s.strip()][:4]
    if not syms:
        return "Provide 1-4 comma-separated tickers, e.g. 'NVDA,AAPL,TSLA'."
    parts: list[str] = [f"Side-by-Side Comparison ({', '.join(syms)}):"]
    for sym in syms:
        summary = await get_asset_structure(symbol=sym)
        compact = " | ".join(line.strip() for line in summary.splitlines()[:4])
        parts.append(f"[{sym}] {compact}")
    return _truncate_to_token_budget("\n".join(parts), max_tokens=380)


def build_market_mcp_server() -> FastMCP:
    """Create a fresh read-only FastMCP server instance (isolated session manager per ASGI app)."""
    server = FastMCP(
        name="MarketElite Read-Only Research Tools",
        instructions=(
            "Read-only US equity market structure, deterministic quant metrics, "
            "portfolio & watchlist awareness, alerts/memories, macro/earnings calendar, "
            "and SEC EDGAR hybrid RAG tools."
        ),
        streamable_http_path="/mcp",
        json_response=True,
        stateless_http=True,
    )
    server.tool()(get_market_regime_snapshot)
    server.tool()(get_asset_structure)
    server.tool()(get_macro_and_earnings_calendar)
    server.tool()(get_sec_filings_context)
    server.tool()(get_account_positions_snapshot)
    server.tool()(get_watchlist_matrix)
    server.tool()(get_watchdog_and_memories)
    server.tool()(compare_assets_structure)
    return server


mcp = build_market_mcp_server()


async def list_read_only_tools_metadata() -> list[dict[str, str]]:
    """Inspect registered FastMCP tools safely for `/api/agent/status` and tests."""
    registered = await mcp.list_tools()
    return [
        {
            "name": tool.name,
            "description": (tool.description or "").strip(),
        }
        for tool in registered
    ]

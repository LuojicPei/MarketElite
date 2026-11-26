from __future__ import annotations

import logging
import math
from datetime import date, datetime, timedelta, timezone
from typing import Any

import redis.asyncio as aioredis
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.db.models import (
    ConsensusEpsSnapshot,
    EconomicCalendarEvent,
    EpisodicMemory,
    MacroSeriesPoint,
    MarketDailyBar,
    MarketRegimeDaily,
    OptionsGexSnapshot,
    PaperTrade,
    SecFilingChunk,
    SecFilingDocument,
    TradeReview,
    UserWatchlistItem,
    WatchdogAlert,
)
from app.services.providers.alpaca import (
    CORE_INDEX_ETFS,
    DEFAULT_EQUITY_UNIVERSE,
    MACRO_PROXIES,
    SECTOR_ETFS,
)

logger = logging.getLogger(__name__)

_EXTRA_DEMO_TICKERS: tuple[str, ...] = ("AMD", "PLTR", "TSM", "BTCUSDT")

_ANCHOR_PRICES: dict[str, tuple[float, float]] = {
    "SPY": (588.0, 0.0085),
    "QQQ": (512.0, 0.0110),
    "SOXX": (228.0, 0.0165),
    "IWM": (224.0, 0.0125),
    "RSP": (181.0, 0.0075),
    "XLK": (236.0, 0.0120),
    "XLY": (214.0, 0.0115),
    "XLC": (99.0, 0.0105),
    "XLF": (49.5, 0.0090),
    "XLI": (138.0, 0.0095),
    "XLE": (91.0, 0.0130),
    "XLB": (93.0, 0.0100),
    "XLU": (80.0, 0.0080),
    "XLP": (82.0, 0.0065),
    "XLV": (148.0, 0.0078),
    "XLRE": (43.5, 0.0092),
    "HYG": (79.8, 0.0032),
    "LQD": (109.2, 0.0040),
    "UUP": (29.4, 0.0045),
    "GLD": (246.0, 0.0095),
    "CPER": (27.8, 0.0120),
    "TLT": (92.5, 0.0098),
    "AAPL": (232.0, 0.0135),
    "MSFT": (428.0, 0.0128),
    "NVDA": (142.0, 0.0225),
    "AMZN": (212.0, 0.0150),
    "META": (592.0, 0.0170),
    "GOOGL": (182.0, 0.0145),
    "TSLA": (338.0, 0.0280),
    "AVGO": (176.0, 0.0210),
    "JPM": (244.0, 0.0110),
    "LLY": (792.0, 0.0155),
    "XOM": (118.0, 0.0120),
    "UNH": (584.0, 0.0115),
    "V": (310.0, 0.0095),
    "COST": (962.0, 0.0110),
    "HD": (412.0, 0.0105),
    "PG": (174.0, 0.0072),
    "MA": (526.0, 0.0098),
    "MRK": (102.0, 0.0115),
    "NFLX": (886.0, 0.0165),
    "CRM": (328.0, 0.0155),
    "AMD": (144.0, 0.0235),
    "PLTR": (64.0, 0.0290),
    "TSM": (196.0, 0.0195),
    "BTCUSDT": (94800.0, 0.0260),
}

_GEX_DEMO_SYMBOLS: tuple[str, ...] = (
    "SPY",
    "QQQ",
    "NVDA",
    "AAPL",
    "TSLA",
    "MSFT",
    "AMZN",
    "META",
    "AVGO",
    "AMD",
)


def _recent_business_days(count: int = 65, *, end_date: date | None = None) -> list[date]:
    cursor = end_date or date.today()
    days: list[date] = []
    while len(days) < count:
        if cursor.weekday() < 5:
            days.append(cursor)
        cursor -= timedelta(days=1)
    days.reverse()
    return days


def _asset_class_for_symbol(symbol: str) -> str:
    if symbol == "BTCUSDT":
        return "crypto"
    if symbol in CORE_INDEX_ETFS or symbol in SECTOR_ETFS or symbol in MACRO_PROXIES:
        return "etf"
    return "equity"


def _build_demo_bars_rows(days: list[date]) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    rows: list[dict[str, Any]] = []
    all_symbols = tuple(dict.fromkeys(list(DEFAULT_EQUITY_UNIVERSE) + list(_EXTRA_DEMO_TICKERS)))
    n = len(days)

    for sym_idx, sym in enumerate(all_symbols):
        end_px, vol_scale = _ANCHOR_PRICES.get(sym, (100.0, 0.014))
        asset_class = _asset_class_for_symbol(sym)
        is_defensive = sym in {"TLT", "LQD", "XLU", "XLP", "UUP"}
        trend_total = -0.025 if is_defensive else 0.085 + (sym_idx % 5) * 0.012
        base_vol = 42_000_000.0 if sym in {"SPY", "QQQ", "NVDA", "TSLA"} else 8_500_000.0
        if sym == "BTCUSDT":
            base_vol = 31_000.0

        prev_close = end_px / (1.0 + trend_total)
        phase = (sym_idx + 1) * 0.7
        for i, d in enumerate(days):
            progress = (i + 1) / max(1, n)
            wave = math.sin(progress * math.pi * 4.5 + phase) * vol_scale * 0.85
            drift = trend_total / max(1, n)
            ret = drift + wave
            if i == n - 1:
                close_px = end_px
            else:
                close_px = max(1.0, prev_close * (1.0 + ret))
            open_px = max(1.0, prev_close * (1.0 + math.sin(i + phase) * vol_scale * 0.22))
            hi = max(open_px, close_px) * (1.0 + vol_scale * 0.48)
            lo = min(open_px, close_px) * (1.0 - vol_scale * 0.44)
            vol_boost = 1.48 if (i >= n - 2 and not is_defensive) else (0.9 + ((i + sym_idx) % 4) * 0.08)
            volume = round(base_vol * vol_boost, 2)
            vwap = round((open_px + hi + lo + close_px) / 4.0, 4)
            rows.append(
                {
                    "symbol": sym,
                    "asset_class": asset_class,
                    "trade_date": d,
                    "open": round(open_px, 4),
                    "high": round(hi, 4),
                    "low": round(lo, 4),
                    "close": round(close_px, 4),
                    "volume": volume,
                    "vwap": vwap,
                    "trade_count": int(18_000 + (i % 7) * 2_400),
                    "source": "demo_snapshot",
                    "fetched_at": now,
                }
            )
            prev_close = close_px
    return rows


def _build_demo_macro_rows(days: list[date]) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    rows: list[dict[str, Any]] = []
    n = len(days)

    series_specs: dict[str, tuple[float, float]] = {
        "WALCL": (6985.0, 95.0),
        "WTREGEN": (805.0, -35.0),
        "RRPONTSYD": (315.0, -55.0),
        "WRESBAL": (3185.0, 55.0),
        "SOFR": (4.58, -0.04),
        "DGS2": (4.22, -0.05),
        "DGS10": (4.31, 0.04),
        "DFII10": (1.94, 0.02),
        "T10Y2Y": (0.09, 0.09),
        "BAMLH0A0HYM2": (3.18, -0.14),
        "BAMLC0A0CM": (0.91, -0.04),
        "VIX9D": (15.1, -0.4),
        "VIX": (16.1, -0.6),
        "VIXCLS": (16.1, -0.6),
        "VIX3M": (18.2, -0.2),
    }

    for sid_idx, (sid, (start_val, total_delta)) in enumerate(series_specs.items()):
        for i, d in enumerate(days):
            p = i / max(1, n - 1)
            jitter = math.sin(p * math.pi * 3.0 + sid_idx) * abs(total_delta) * 0.12
            val = start_val + total_delta * p + jitter
            rows.append(
                {
                    "series_id": sid,
                    "obs_date": d,
                    "value": round(val, 4),
                    "source": "demo_snapshot",
                    "fetched_at": now,
                }
            )
    return rows


def _build_demo_gex_snapshots() -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    snaps: list[dict[str, Any]] = []
    for idx, sym in enumerate(_GEX_DEMO_SYMBOLS):
        spot = _ANCHOR_PRICES[sym][0]
        step = max(1.0, round(spot * 0.015, 0))
        put_wall = round(spot - step * 3, 2)
        zero_gamma = round(spot - step * 0.6, 2)
        call_wall = round(spot + step * 3.5, 2)
        profile: list[dict[str, Any]] = []
        for k in range(-5, 6):
            strike = round(spot + k * step, 2)
            call_gex = round(max(0.0, (4 - abs(k - 2)) * 28_000_000.0 + idx * 1_500_000.0), 2)
            put_gex = round(-max(0.0, (4 - abs(k + 2)) * 16_000_000.0), 2)
            profile.append(
                {
                    "strike": strike,
                    "call_gex": call_gex,
                    "put_gex": put_gex,
                    "net_gex": round(call_gex + put_gex, 2),
                    "call_oi": 14_000 + max(0, k + 5) * 2_800,
                    "put_oi": 11_000 + max(0, 5 - k) * 2_400,
                }
            )
        snaps.append(
            {
                "symbol": sym,
                "snapshot_time": now,
                "spot_price": spot,
                "net_gex": round(240_000_000.0 + idx * 35_000_000.0, 2),
                "call_wall": call_wall,
                "put_wall": put_wall,
                "zero_gamma": zero_gamma,
                "put_call_ratio": round(0.84 + (idx % 3) * 0.08, 2),
                "total_call_oi": 420_000 + idx * 18_000,
                "total_put_oi": 355_000 + idx * 15_000,
                "contracts_analyzed": 180 + idx * 12,
                "assumption_label": "Demo Snapshot · Sample Estimated GEX (Apply Free Alpaca Key for Live Greeks)",
                "strike_profile_json": profile,
                "source": "demo_snapshot",
                "is_stale": False,
            }
        )
    return snaps


async def ensure_demo_snapshot_seeded(
    session_factory: async_sessionmaker[AsyncSession],
    redis_client: aioredis.Redis | None,
    settings: Settings,
    *,
    force: bool = False,
) -> dict[str, Any]:
    """Populate a sanitized 0-Key demo snapshot when Postgres is empty, without touching existing live data."""
    async with session_factory() as session:
        bars_count = int((await session.execute(select(func.count(MarketDailyBar.id)))).scalar_one() or 0)
        regime_count = int(
            (await session.execute(select(func.count(MarketRegimeDaily.id)))).scalar_one() or 0
        )

    if not force and bars_count >= 50 and regime_count >= 1:
        return {
            "status": "skipped",
            "reason": "database_already_populated",
            "market_daily_bars": bars_count,
            "market_regime_daily": regime_count,
        }

    days = _recent_business_days(65)
    bar_rows = _build_demo_bars_rows(days)
    macro_rows = _build_demo_macro_rows(days)
    gex_rows = _build_demo_gex_snapshots()
    now = datetime.now(timezone.utc)

    async with session_factory() as session:
        # 1. Market Daily Bars
        for offset in range(0, len(bar_rows), 500):
            batch = bar_rows[offset : offset + 500]
            stmt = pg_insert(MarketDailyBar).values(batch).on_conflict_do_nothing(
                index_elements=["symbol", "trade_date"]
            )
            await session.execute(stmt)

        # 2. Macro Series Points
        for offset in range(0, len(macro_rows), 500):
            batch = macro_rows[offset : offset + 500]
            stmt = pg_insert(MacroSeriesPoint).values(batch).on_conflict_do_nothing(
                index_elements=["series_id", "obs_date"]
            )
            await session.execute(stmt)

        # 3. Options GEX Snapshots (seed if none present)
        existing_gex = int(
            (await session.execute(select(func.count(OptionsGexSnapshot.id)))).scalar_one() or 0
        )
        if force or existing_gex == 0:
            session.add_all([OptionsGexSnapshot(**item) for item in gex_rows])

        # 4. Upcoming Calendar Events (relative to today)
        cal_rows = [
            {
                "event_key": "demo:macro:cpi_release",
                "event_type": "macro",
                "event_time": now + timedelta(days=3),
                "symbol": None,
                "country": "US",
                "title": "[Demo] US CPI Inflation Release",
                "impact": "High",
                "estimate": 2.7,
                "previous": 2.6,
                "source": "demo_snapshot",
                "fetched_at": now,
            },
            {
                "event_key": "demo:macro:fomc_minutes",
                "event_type": "macro",
                "event_time": now + timedelta(days=6),
                "symbol": None,
                "country": "US",
                "title": "[Demo] Federal Reserve FOMC Minutes",
                "impact": "High",
                "source": "demo_snapshot",
                "fetched_at": now,
            },
            {
                "event_key": "demo:earnings:nvda",
                "event_type": "earnings",
                "event_time": now + timedelta(days=9),
                "symbol": "NVDA",
                "country": "US",
                "title": "[Demo] NVDA Quarterly Earnings Watch",
                "impact": "High",
                "eps_estimate": 0.89,
                "source": "demo_snapshot",
                "fetched_at": now,
            },
            {
                "event_key": "demo:macro:nfp_jobs",
                "event_type": "macro",
                "event_time": now + timedelta(days=12),
                "symbol": None,
                "country": "US",
                "title": "[Demo] US Nonfarm Payrolls (NFP)",
                "impact": "High",
                "estimate": 175.0,
                "previous": 168.0,
                "source": "demo_snapshot",
                "fetched_at": now,
            },
        ]
        await session.execute(
            pg_insert(EconomicCalendarEvent).values(cal_rows).on_conflict_do_nothing(
                index_elements=["event_key"]
            )
        )

        # 5. Consensus EPS Snapshots
        today_d = date.today()
        eps_rows = [
            {
                "symbol": sym,
                "snapshot_date": today_d,
                "period": "0Q",
                "eps_avg": avg_eps,
                "eps_high": round(avg_eps * 1.12, 2),
                "eps_low": round(avg_eps * 0.91, 2),
                "number_analysts": 34,
                "source": "demo_snapshot",
                "fetched_at": now,
            }
            for sym, avg_eps in (("NVDA", 0.89), ("AAPL", 2.36), ("MSFT", 3.14), ("AVGO", 1.52))
        ]
        await session.execute(
            pg_insert(ConsensusEpsSnapshot).values(eps_rows).on_conflict_do_nothing(
                index_elements=["symbol", "snapshot_date", "period"]
            )
        )

        # 6. Default Watchlist
        wl_count = int(
            (await session.execute(select(func.count(UserWatchlistItem.id)))).scalar_one() or 0
        )
        if wl_count == 0:
            wl_syms = ["SPY", "QQQ", "NVDA", "AAPL", "MSFT", "TSLA", "AMZN", "META", "AVGO", "BTCUSDT"]
            wl_rows = [
                {
                    "workspace_id": "default",
                    "symbol": s,
                    "sort_order": idx,
                    "created_at": now,
                }
                for idx, s in enumerate(wl_syms)
            ]
            await session.execute(
                pg_insert(UserWatchlistItem).values(wl_rows).on_conflict_do_nothing(
                    index_elements=["workspace_id", "symbol"]
                )
            )

        # 7. Sample SEC Filing Excerpts for 0-Token Hybrid RAG Demo
        sec_count = int(
            (await session.execute(select(func.count(SecFilingDocument.id)))).scalar_one() or 0
        )
        if sec_count == 0:
            doc = SecFilingDocument(
                symbol="NVDA",
                cik="0001045810",
                accession_number="0001045810-99-000001-demo",
                form_type="10-K",
                filing_date=today_d - timedelta(days=35),
                report_date=today_d - timedelta(days=60),
                primary_document="demo-nvda-10k.htm",
                source_url="https://www.sec.gov/edgar/browse/?CIK=0001045810",
                chunk_count=2,
                has_embeddings=False,
                ingested_at=now,
            )
            session.add(doc)
            await session.flush()
            session.add_all(
                [
                    SecFilingChunk(
                        filing_id=doc.id,
                        symbol="NVDA",
                        form_type="10-K",
                        filing_date=doc.filing_date,
                        section_title="Item 1A Risk Factors (Demo Snapshot)",
                        chunk_index=0,
                        content=(
                            "[Demo Snapshot] Supply chain concentration at leading-edge foundry partners, "
                            "export control licensing requirements across advanced data center accelerators, "
                            "and rapid architecture transitions remain material operating risks affecting quarterly gross margin."
                        ),
                        token_estimate=42,
                        embedding=None,
                    ),
                    SecFilingChunk(
                        filing_id=doc.id,
                        symbol="NVDA",
                        form_type="10-K",
                        filing_date=doc.filing_date,
                        section_title="Item 7 MD&A Revenue & Liquidity (Demo Snapshot)",
                        chunk_index=1,
                        content=(
                            "[Demo Snapshot] Data center compute and networking demand drove operating cash flow "
                            "expansion while capital expenditures and working capital commitments reflect next-generation rack transitions."
                        ),
                        token_estimate=34,
                        embedding=None,
                    ),
                ]
            )

        # 8. Sanitized Sandbox Trades, Reviews, Alerts & Playbook Rules
        pt_count = int(
            (
                await session.execute(
                    select(func.count(PaperTrade.id)).where(PaperTrade.workspace_id == "default")
                )
            ).scalar_one()
            or 0
        )
        if pt_count == 0:
            t1 = PaperTrade(
                workspace_id="default",
                thread_id="demo-nvda-win",
                symbol="NVDA",
                side="buy",
                order_class="bracket",
                qty=12.0,
                entry_price=134.0,
                stop_loss_price=127.5,
                take_profit_price=147.0,
                risk_budget_pct=1.0,
                alpaca_order_id="sbx-demo-nvda-1",
                status="closed",
                regime_at_entry="RISK_ON_EXPANSION",
                rationale_summary="[Demo] 站稳 Zero Gamma 与 20 日均线放量介入，按 1% 预算锁定止损。",
                created_at=now - timedelta(days=14),
                closed_at=now - timedelta(days=9),
                realized_pnl=156.0,
                spy_benchmark_return_pct=1.8,
            )
            t2 = PaperTrade(
                workspace_id="default",
                thread_id="demo-qqq-loss",
                symbol="QQQ",
                side="buy",
                order_class="bracket",
                qty=8.0,
                entry_price=508.0,
                stop_loss_price=498.0,
                take_profit_price=528.0,
                risk_budget_pct=1.0,
                alpaca_order_id="sbx-demo-qqq-2",
                status="closed",
                regime_at_entry="HIGH_VOL_TRANSITION",
                rationale_summary="[Demo] 高波动震荡区提前半仓试多，触及机械止损线果断离场。",
                created_at=now - timedelta(days=7),
                closed_at=now - timedelta(days=4),
                realized_pnl=-80.0,
                spy_benchmark_return_pct=-0.6,
            )
            t3 = PaperTrade(
                workspace_id="default",
                thread_id="demo-aapl-win",
                symbol="AAPL",
                side="buy",
                order_class="bracket",
                qty=10.0,
                entry_price=221.0,
                stop_loss_price=215.0,
                take_profit_price=233.0,
                risk_budget_pct=1.0,
                alpaca_order_id="sbx-demo-aapl-3",
                status="closed",
                regime_at_entry="RISK_ON_EXPANSION",
                rationale_summary="[Demo] 回踩 Put Wall 缩量企稳介入，分批到达 Call Wall 前止盈。",
                created_at=now - timedelta(days=5),
                closed_at=now - timedelta(days=1),
                realized_pnl=110.0,
                spy_benchmark_return_pct=1.1,
            )
            session.add_all([t1, t2, t3])
            await session.flush()

            session.add_all(
                [
                    TradeReview(
                        paper_trade_id=t1.id,
                        horizon="POST_CLOSE",
                        quadrant_outcome="GOOD_PROCESS_GOOD_OUTCOME",
                        alpha_vs_spy_pct=7.9,
                        regime_label="RISK_ON_EXPANSION",
                        lessons_markdown="[Demo] 顺应正伽马与 20EMA 支撑进场，严格执行 1% 止损与 2R 止盈。",
                        created_at=now - timedelta(days=9),
                    ),
                    TradeReview(
                        paper_trade_id=t2.id,
                        horizon="POST_CLOSE",
                        quadrant_outcome="GOOD_PROCESS_BAD_OUTCOME",
                        alpha_vs_spy_pct=-1.37,
                        regime_label="HIGH_VOL_TRANSITION",
                        lessons_markdown="[Demo] 虽出现常规回撤扫损，但单笔亏损精准控制在净值 0.08% 以内，合规执行风控纪律。",
                        created_at=now - timedelta(days=4),
                    ),
                    TradeReview(
                        paper_trade_id=t3.id,
                        horizon="POST_CLOSE",
                        quadrant_outcome="GOOD_PROCESS_GOOD_OUTCOME",
                        alpha_vs_spy_pct=3.88,
                        regime_label="RISK_ON_EXPANSION",
                        lessons_markdown="[Demo] 依赖 Put Wall 下沿防守大幅改善盈亏比，止盈贴近上方 Call Wall 阻力。",
                        created_at=now - timedelta(days=1),
                    ),
                ]
            )

        wa_count = int(
            (
                await session.execute(
                    select(func.count(WatchdogAlert.id)).where(WatchdogAlert.workspace_id == "default")
                )
            ).scalar_one()
            or 0
        )
        if wa_count == 0:
            await session.execute(
                pg_insert(WatchdogAlert)
                .values(
                    [
                        {
                            "workspace_id": "default",
                            "alert_key": "demo:alert:nvda_volume",
                            "alert_type": "VOLUME_SURGE",
                            "severity": "medium",
                            "symbol": "NVDA",
                            "title": "[演示哨兵] NVDA 量能放大并接近上方 Call Wall 阻力区",
                            "summary_markdown": "示例监控：检测到相对成交量放大，注意评估分批止盈或上移移动止损。",
                            "metrics_json": {"rvol_20": 1.52, "source": "demo_snapshot"},
                            "regime_label": "RISK_ON_EXPANSION",
                            "acknowledged": False,
                            "created_at": now - timedelta(hours=2),
                        },
                        {
                            "workspace_id": "default",
                            "alert_key": "demo:alert:spy_catalyst",
                            "alert_type": "UPCOMING_CATALYST",
                            "severity": "high",
                            "symbol": "SPY",
                            "title": "[演示哨兵] 未来 72 小时临近重要通胀宏观事件窗口",
                            "summary_markdown": "示例监控：CPI 数据窗口临近，建议核对高弹性多头头寸是否需要收紧止损或降仓。",
                            "metrics_json": {"window_hours": 72, "source": "demo_snapshot"},
                            "regime_label": "NEUTRAL_ROTATION",
                            "acknowledged": False,
                            "created_at": now - timedelta(hours=1),
                        },
                    ]
                )
                .on_conflict_do_nothing(index_elements=["workspace_id", "alert_key"])
            )

        mem_count = int(
            (
                await session.execute(
                    select(func.count(EpisodicMemory.id)).where(EpisodicMemory.workspace_id == "default")
                )
            ).scalar_one()
            or 0
        )
        if mem_count == 0:
            session.add_all(
                [
                    EpisodicMemory(
                        workspace_id="default",
                        symbol="ALL",
                        regime_label="HIGH_VOL_TRANSITION",
                        quadrant_outcome="IRON_RULE",
                        title="单笔最大止损硬约束 1% 账户净值",
                        lesson_text="[Demo Iron Rule] 无论看好程度多高，入场前必须根据止损距离倒算股数，绝不允许单笔交易潜在亏超总净值 1%~2%。",
                        tags_json=["position_sizing", "risk_limit"],
                        is_pinned=True,
                        is_active=True,
                    ),
                    EpisodicMemory(
                        workspace_id="default",
                        symbol="ALL",
                        regime_label="RISK_OFF_STRESS",
                        quadrant_outcome="IRON_RULE",
                        title="负伽马区（跌破 Zero Gamma）禁止一把梭哈追涨",
                        lesson_text="[Demo Iron Rule] 当标的价格处于做市商 Zero Gamma 下方时，日内波动幅度成倍放大，必须降半仓或等待收盘站稳 EMA20。",
                        tags_json=["zero_gamma", "negative_gex"],
                        is_pinned=True,
                        is_active=True,
                    ),
                ]
            )

        await session.commit()

    # Build canonical overview snapshot via the deterministic pipeline engine
    from app.services.pipeline import build_and_persist_overview

    if redis_client is not None:
        from app.services.resilience import DualTTLCache

        cache = DualTTLCache(redis_client)
        existing_cot = await cache.read_envelope("marketelite:cftc:cot:legacy")
        if existing_cot is None:
            await cache.write_envelope(
                "marketelite:cftc:cot:legacy",
                payload={
                    "source": "demo_snapshot",
                    "report_date": days[-1].isoformat(),
                    "contracts": [
                        {"symbol": "ES", "name": "E-Mini S&P 500", "leveraged_net": 18420, "asset_mgr_net": 142600},
                        {"symbol": "NQ", "name": "Nasdaq 100 Mini", "leveraged_net": 9410, "asset_mgr_net": 68400},
                    ],
                },
                source="demo_snapshot",
                soft_ttl_seconds=3600,
                hard_ttl_seconds=86400 * 7,
            )

    overview = await build_and_persist_overview(
        session_factory,
        redis_client,
        settings,
        provider_states={
            "mode": "demo_snapshot",
            "equities": "demo_snapshot",
            "macro": "demo_snapshot",
            "options_gex": "demo_snapshot",
        },
    )

    return {
        "status": "seeded",
        "mode": "demo_snapshot",
        "bars_inserted": len(bar_rows),
        "macro_points_inserted": len(macro_rows),
        "gex_snapshots": len(gex_rows),
        "regime_label": overview.get("regime", {}).get("regime_label"),
        "regime_date": overview.get("regime_date"),
    }

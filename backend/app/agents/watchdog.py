from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx
from openai import OpenAIError
from sqlalchemy import desc, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.db.models import (
    EconomicCalendarEvent,
    EpisodicMemory,
    MarketDailyBar,
    MarketRegimeDaily,
    OptionsGexSnapshot,
    PaperTrade,
    TradeReview,
    WatchdogAlert,
)
from app.quant.technicals import DailyBarInput, analyze_asset_technicals
from app.services.llm_router import LLMUnconfiguredError, build_fast_llm, embed_texts
from app.services.providers.alpaca import DEFAULT_EQUITY_UNIVERSE

logger = logging.getLogger(__name__)

_MEMORY_STOPWORDS = frozenset(
    {
        "the",
        "and",
        "for",
        "with",
        "from",
        "that",
        "this",
        "what",
        "when",
        "how",
        "are",
        "was",
    }
)


def _or_tsquery(text: str) -> str:
    terms = [
        t.lower()
        for t in re.findall(r"[a-zA-Z0-9]{2,}", text or "")
        if t.lower() not in _MEMORY_STOPWORDS
    ]
    return " | ".join(list(dict.fromkeys(terms))[:10])


def classify_trade_quadrant(
    *,
    side: str,
    qty: float,
    entry_price: float | None,
    stop_loss_price: float | None,
    take_profit_price: float | None,
    risk_budget_pct: float,
    realized_pnl: float | None,
    spy_benchmark_return_pct: float | None,
    regime_at_entry: str | None,
) -> dict[str, Any]:
    """Deterministic 4-quadrant attribution separating Process Discipline from Market Luck."""
    process_score = 100
    notes: list[str] = []

    if risk_budget_pct > 1.05:
        process_score -= 35
        notes.append(f"单笔风险预算 {risk_budget_pct:.2f}% 超过 1.0% 硬上限。")
    else:
        notes.append(f"严格执行 <= {risk_budget_pct:.2f}% 风险预算控制。")

    if stop_loss_price is None or stop_loss_price <= 0:
        process_score -= 35
        notes.append("缺少预设止损价，未遵守 Bracket 风控纪律。")
    if take_profit_price is None or take_profit_price <= 0:
        process_score -= 15
        notes.append("缺少目标止盈位。")

    regime = (regime_at_entry or "UNKNOWN").upper()
    norm_side = side.lower().strip()
    if regime in ("RISK_OFF_STRESS", "LIQUIDITY_TIGHTENING") and norm_side == "buy":
        process_score -= 15
        notes.append(f"在 {regime} 宏观逆风环境下顺势做多敞口偏激进。")
    else:
        notes.append(f"交易方向与入场 Regime ({regime}) 保持兼容。")

    good_process = process_score >= 70

    trade_return_pct: float | None = None
    notional = (float(entry_price) * float(qty)) if entry_price and qty else 0.0
    if realized_pnl is not None and notional > 0:
        trade_return_pct = round((float(realized_pnl) / notional) * 100.0, 2)

    alpha_vs_spy_pct: float | None = None
    if trade_return_pct is not None and spy_benchmark_return_pct is not None:
        alpha_vs_spy_pct = round(trade_return_pct - float(spy_benchmark_return_pct), 2)

    pnl_val = float(realized_pnl) if realized_pnl is not None else 0.0
    good_outcome = pnl_val > 0.0 or (
        pnl_val >= 0.0 and alpha_vs_spy_pct is not None and alpha_vs_spy_pct > 0.0
    )

    if good_process and good_outcome:
        quadrant = "GOOD_PROCESS_GOOD_OUTCOME"
        quadrant_cn = "高纪律盈利（可执行复制）"
    elif good_process and not good_outcome:
        quadrant = "GOOD_PROCESS_BAD_OUTCOME"
        quadrant_cn = "合规止损（纪律正确但市场波动触发止损）"
    elif not good_process and good_outcome:
        quadrant = "BAD_PROCESS_GOOD_OUTCOME"
        quadrant_cn = "侥幸盈利（违反风控规则但因行情获利，警惕幸存者偏差）"
    else:
        quadrant = "BAD_PROCESS_BAD_OUTCOME"
        quadrant_cn = "双输复盘（违背风控纪律导致亏损）"

    return {
        "quadrant": quadrant,
        "quadrant_cn": quadrant_cn,
        "process_score": max(0, process_score),
        "good_process": good_process,
        "good_outcome": good_outcome,
        "trade_return_pct": trade_return_pct,
        "alpha_vs_spy_pct": alpha_vs_spy_pct,
        "process_notes": notes,
    }


class EpisodicMemoryRetriever:
    """Hybrid BM25 (PostgreSQL tsvector) + optional pgvector recall for past trade lessons."""

    def __init__(
        self,
        settings: Settings,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self._settings = settings
        self._session_factory = session_factory

    async def recall(
        self,
        query: str,
        *,
        symbol: str | None = None,
        regime_label: str | None = None,
        top_k: int = 3,
    ) -> list[dict[str, Any]]:
        """Retrieve relevant historical trade & regime lessons safely even without Embedding API."""
        sym = symbol.upper().strip() if symbol else None
        reg = regime_label.upper().strip() if regime_label else None
        search_seed = " ".join(part for part in (sym or "", reg or "", query or "") if part).strip()

        query_vec: list[float] | None = None
        if search_seed:
            try:
                vecs = await embed_texts([search_seed], self._settings)
                if vecs:
                    query_vec = vecs[0]
            except (OpenAIError, httpx.HTTPError, ValueError, RuntimeError, TimeoutError, OSError) as exc:
                logger.warning("Episodic memory embedding skipped: %s", exc)

        fused: dict[int, dict[str, Any]] = {}
        async with self._session_factory() as session:
            # 1. PostgreSQL BM25 full-text search
            if search_seed:
                ts_q = func.websearch_to_tsquery("english", search_seed)
                lex_rank = func.ts_rank_cd(EpisodicMemory.search_tsv, ts_q, 32).label("lex_score")
                lex_stmt = (
                    select(EpisodicMemory, lex_rank)
                    .where(EpisodicMemory.search_tsv.op("@@")(ts_q))
                    .order_by(lex_rank.desc())
                    .limit(12)
                )
                lex_rows = list((await session.execute(lex_stmt)).all())
                if len(lex_rows) < 4:
                    or_text = _or_tsquery(search_seed)
                    if or_text:
                        or_q = func.to_tsquery("english", or_text)
                        or_rank = func.ts_rank_cd(EpisodicMemory.search_tsv, or_q, 32).label(
                            "lex_score"
                        )
                        or_stmt = (
                            select(EpisodicMemory, or_rank)
                            .where(EpisodicMemory.search_tsv.op("@@")(or_q))
                            .order_by(or_rank.desc())
                            .limit(12)
                        )
                        seen_ids = {int(r.id) for r, _ in lex_rows}
                        for mem, sc in (await session.execute(or_stmt)).all():
                            if int(mem.id) not in seen_ids:
                                lex_rows.append((mem, sc))
                                seen_ids.add(int(mem.id))

                for rank_idx, (mem, _sc) in enumerate(lex_rows, start=1):
                    mid = int(mem.id)
                    entry = fused.setdefault(
                        mid,
                        {"row": mem, "score": 0.0},
                    )
                    entry["score"] += 1.0 / (60 + rank_idx)

            # 2. Optional dense vector cosine search
            if query_vec is not None:
                dist_expr = EpisodicMemory.embedding.cosine_distance(query_vec).label("vec_dist")
                vec_stmt = (
                    select(EpisodicMemory, dist_expr)
                    .where(EpisodicMemory.embedding.is_not(None))
                    .order_by(dist_expr)
                    .limit(10)
                )
                for rank_idx, (mem, _dist) in enumerate(
                    (await session.execute(vec_stmt)).all(), start=1
                ):
                    mid = int(mem.id)
                    entry = fused.setdefault(mid, {"row": mem, "score": 0.0})
                    entry["score"] += 1.0 / (60 + rank_idx)

            # 3. Direct symbol / regime / recent fallback so Chinese queries still match symbol+regime memories
            recent_stmt = select(EpisodicMemory).order_by(desc(EpisodicMemory.created_at)).limit(20)
            for mem in (await session.execute(recent_stmt)).scalars().all():
                mid = int(mem.id)
                boost = 0.0
                if sym and mem.symbol.upper() == sym:
                    boost += 0.02
                if reg and mem.regime_label.upper() == reg:
                    boost += 0.015
                if mem.quadrant_outcome.startswith("BAD_PROCESS"):
                    boost += 0.005  # prioritize mistake lessons slightly higher
                if mid in fused or boost > 0.0:
                    entry = fused.setdefault(mid, {"row": mem, "score": 0.001})
                    entry["score"] += boost

        ranked = sorted(fused.values(), key=lambda x: float(x["score"]), reverse=True)[:top_k]
        return [
            {
                "id": item["row"].id,
                "paper_trade_id": item["row"].paper_trade_id,
                "symbol": item["row"].symbol,
                "regime_label": item["row"].regime_label,
                "quadrant_outcome": item["row"].quadrant_outcome,
                "title": item["row"].title,
                "lesson_text": item["row"].lesson_text,
                "tags": item["row"].tags_json or [],
                "alpha_vs_spy_pct": item["row"].alpha_vs_spy_pct,
                "score": round(float(item["score"]), 5),
                "created_at": item["row"].created_at.isoformat(),
            }
            for item in ranked
        ]

    @staticmethod
    def format_memories_for_prompt(memories: list[dict[str, Any]]) -> str:
        if not memories:
            return ""
        lines = ["Historical Episodic Lessons (Post-Trade Attribution):"]
        for m in memories:
            alpha = (
                f", Alpha={m['alpha_vs_spy_pct']:+.2f}% vs SPY"
                if m.get("alpha_vs_spy_pct") is not None
                else ""
            )
            lines.append(
                f"- [{m['symbol']} | {m['regime_label']} | {m['quadrant_outcome']}{alpha}] "
                f"{m['title']}: {m['lesson_text'][:220]}"
            )
        return "\n".join(lines)


async def run_watchdog_scan(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    *,
    symbols: list[str] | None = None,
    use_fast_llm: bool = True,
) -> dict[str, Any]:
    """Scan local market bars, GEX walls, VIX term structure & upcoming catalysts for anomalies."""
    now = datetime.now(timezone.utc)
    today_iso = date.today().isoformat()
    candidates_to_upsert: list[dict[str, Any]] = []
    scanned_symbols: list[str] = []

    async with session_factory() as session:
        latest_regime = (
            await session.execute(
                select(MarketRegimeDaily).order_by(desc(MarketRegimeDaily.regime_date)).limit(1)
            )
        ).scalar_one_or_none()
        regime_label = latest_regime.regime_label if latest_regime else "UNKNOWN"

        # 1. VIX Term Structure Backwardation check
        if (
            latest_regime
            and latest_regime.vix_term_ratio is not None
            and float(latest_regime.vix_term_ratio) > 1.01
        ):
            ratio = float(latest_regime.vix_term_ratio)
            candidates_to_upsert.append(
                {
                    "alert_key": f"watchdog:vix_backwardation:MACRO:{today_iso}",
                    "alert_type": "vix_backwardation",
                    "severity": "high",
                    "symbol": "SPY",
                    "title": f"VIX 期限结构倒挂警戒 (VIX/VIX3M = {ratio:.2f}x)",
                    "summary_markdown": (
                        f"现货 VIX 相对 VIX3M 比率升至 **{ratio:.2f}x**（>1.01 倒挂区间），"
                        "反映机构短期对冲需求急剧升温，系统 Regime 处于高波动避险状态，应压缩单笔风险敞口并优先观察 Put Wall 支撑。"
                    ),
                    "metrics_json": {
                        "vix_spot": latest_regime.vix_spot,
                        "vix_3m": latest_regime.vix_3m,
                        "vix_term_ratio": ratio,
                    },
                    "regime_label": regime_label,
                    "acknowledged": False,
                    "created_at": now,
                }
            )

        # 2. Target equity universe + active PaperTrade symbols
        target_syms = list(
            dict.fromkeys(
                [*(symbols or []), *DEFAULT_EQUITY_UNIVERSE]
            )
        )
        open_trade_syms = list(
            (
                await session.execute(
                    select(PaperTrade.symbol).where(
                        PaperTrade.status.in_(["submitted", "filled", "accepted", "pending_hitl"])
                    )
                )
            )
            .scalars()
            .all()
        )
        for s in open_trade_syms:
            su = str(s).upper().strip()
            if su and su not in target_syms:
                target_syms.append(su)

        for sym in target_syms:
            if sym == "BTCUSDT":
                continue
            scanned_symbols.append(sym)
            bars = list(
                (
                    await session.execute(
                        select(MarketDailyBar)
                        .where(MarketDailyBar.symbol == sym)
                        .order_by(desc(MarketDailyBar.trade_date))
                        .limit(90)
                    )
                )
                .scalars()
                .all()
            )
            if len(bars) < 25:
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
            rvol = float(tech.get("rvol_20") or 0.0)
            chg1 = float(tech.get("change_1d_pct") or 0.0)
            spot = float(tech.get("last_close") or 0.0)

            if rvol >= 1.8:
                severity = "high" if rvol >= 2.4 else "medium"
                vp_tag = str(tech.get("volume_price_tag") or "")
                candidates_to_upsert.append(
                    {
                        "alert_key": f"watchdog:rvol_spike:{sym}:{today_iso}",
                        "alert_type": "rvol_spike",
                        "severity": severity,
                        "symbol": sym,
                        "title": f"{sym} 异常放量异动 (RVOL {rvol:.2f}x | 涨跌 {chg1:+.2f}%)",
                        "summary_markdown": (
                            f"**{sym}** 最新收盘 **${spot:.2f}**（日涨跌 **{chg1:+.2f}%**），"
                            f"20 日相对成交量 **RVOL = {rvol:.2f}x**，触发量价四象限信号 `{vp_tag}`。"
                        ),
                        "metrics_json": {
                            "last_close": spot,
                            "change_1d_pct": chg1,
                            "rvol_20": rvol,
                            "volume_price_tag": vp_tag,
                        },
                        "regime_label": regime_label,
                        "acknowledged": False,
                        "created_at": now,
                    }
                )

            gex = (
                await session.execute(
                    select(OptionsGexSnapshot)
                    .where(OptionsGexSnapshot.symbol == sym)
                    .order_by(desc(OptionsGexSnapshot.snapshot_time))
                    .limit(1)
                )
            ).scalar_one_or_none()
            if (
                gex is not None
                and gex.zero_gamma is not None
                and gex.net_gex < 0
                and spot > 0
                and spot < float(gex.zero_gamma)
            ):
                candidates_to_upsert.append(
                    {
                        "alert_key": f"watchdog:zero_gamma_breach:{sym}:{today_iso}",
                        "alert_type": "zero_gamma_breach",
                        "severity": "high",
                        "symbol": sym,
                        "title": f"{sym} 跌破 Zero Gamma (${gex.zero_gamma:.2f}) 且处于负 GEX 区间",
                        "summary_markdown": (
                            f"**{sym}** 现价 **${spot:.2f}** 低于估算 **Zero Gamma (${gex.zero_gamma:.2f})**，"
                            f"且净 Estimated GEX 为 **${gex.net_gex / 1e6:+.1f}M / 1% Move**（基于做市商静态对冲假设 & OCC OI），"
                            f"做市商顺势对冲会放大日内双向波动。下方 Put Wall 参考 **${gex.put_wall or 0:.2f}**。"
                        ),
                        "metrics_json": {
                            "spot_price": spot,
                            "zero_gamma": gex.zero_gamma,
                            "net_gex": gex.net_gex,
                            "put_wall": gex.put_wall,
                            "call_wall": gex.call_wall,
                        },
                        "regime_label": regime_label,
                        "acknowledged": False,
                        "created_at": now,
                    }
                )

        # 3. High-impact macro event within next 24h
        upcoming_macro = list(
            (
                await session.execute(
                    select(EconomicCalendarEvent).where(
                        EconomicCalendarEvent.event_type == "macro",
                        EconomicCalendarEvent.impact == "High",
                        EconomicCalendarEvent.event_time >= now,
                        EconomicCalendarEvent.event_time <= now + timedelta(hours=24),
                    )
                )
            )
            .scalars()
            .all()
        )
        for ev in upcoming_macro[:3]:
            candidates_to_upsert.append(
                {
                    "alert_key": f"watchdog:macro_event:{ev.event_key}:{today_iso}",
                    "alert_type": "macro_event",
                    "severity": "medium",
                    "symbol": "SPY",
                    "title": f"24 小时内高影响宏观事件：{ev.title}",
                    "summary_markdown": (
                        f"即将发布高影响宏观数据 **{ev.title}**（时间 `{ev.event_time.isoformat()}`）。"
                        "事件前期权隐含波动率常升水，新建头寸需防跳空风险。"
                    ),
                    "metrics_json": {
                        "event_key": ev.event_key,
                        "event_time": ev.event_time.isoformat(),
                        "estimate": ev.estimate,
                        "previous": ev.previous,
                    },
                    "regime_label": regime_label,
                    "acknowledged": False,
                    "created_at": now,
                }
            )

        # Optional Fast-Tier LLM brief enrichment for up to 2 highest-severity alerts
        if use_fast_llm and candidates_to_upsert:
            try:
                fast_llm = build_fast_llm(settings, temperature=0.1)
                for item in candidates_to_upsert[:2]:
                    resp = await fast_llm.ainvoke(
                        [
                            {
                                "role": "system",
                                "content": "你是 MarketElite 盘中风控哨兵。仅根据给定指标用两句简洁中文总结异常风险与操作纪律，禁止编造数字。",
                            },
                            {
                                "role": "user",
                                "content": f"标题: {item['title']}\n指标: {item['metrics_json']}\n体制: {regime_label}",
                            },
                        ]
                    )
                    text = resp.content if isinstance(resp.content, str) else str(resp.content)
                    if text.strip():
                        item["summary_markdown"] = text.strip()
            except (LLMUnconfiguredError, OpenAIError, httpx.HTTPError, ValueError, RuntimeError, TimeoutError, OSError) as exc:
                logger.info("Watchdog using deterministic alert copy: %s", exc)

        if candidates_to_upsert:
            stmt = pg_insert(WatchdogAlert).values(candidates_to_upsert)
            stmt = stmt.on_conflict_do_update(
                constraint="uq_watchdog_alert_key",
                set_={
                    "severity": stmt.excluded.severity,
                    "title": stmt.excluded.title,
                    "summary_markdown": stmt.excluded.summary_markdown,
                    "metrics_json": stmt.excluded.metrics_json,
                    "regime_label": stmt.excluded.regime_label,
                    "created_at": now,
                },
            )
            await session.execute(stmt)
            await session.commit()

    return {
        "status": "ok",
        "scanned_symbols": len(scanned_symbols),
        "alerts_upserted": len(candidates_to_upsert),
        "regime_label": regime_label,
        "scanned_at": now.isoformat(),
    }


async def reflect_on_trade(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    trade_id: int,
    *,
    horizon: str = "POST_CLOSE",
    use_fast_llm: bool = True,
) -> dict[str, Any]:
    """Perform 4-quadrant attribution on a PaperTrade and persist TradeReview + EpisodicMemory."""
    async with session_factory() as session:
        trade = await session.get(PaperTrade, trade_id)
        if trade is None:
            raise ValueError(f"PaperTrade id={trade_id} not found.")

        attr = classify_trade_quadrant(
            side=trade.side,
            qty=float(trade.qty),
            entry_price=trade.entry_price,
            stop_loss_price=trade.stop_loss_price,
            take_profit_price=trade.take_profit_price,
            risk_budget_pct=float(trade.risk_budget_pct),
            realized_pnl=trade.realized_pnl,
            spy_benchmark_return_pct=trade.spy_benchmark_return_pct,
            regime_at_entry=trade.regime_at_entry,
        )

        notes_str = "；".join(attr["process_notes"])
        fallback_lesson = (
            f"### {trade.symbol} 交易复盘（{attr['quadrant_cn']}）\n"
            f"- **纪律评分**: {attr['process_score']}/100（过程判定：`{'合规则' if attr['good_process'] else '偏离纪律'}`）\n"
            f"- **收益与 Alpha**: 已实现盈亏 `{trade.realized_pnl if trade.realized_pnl is not None else '未平仓/估算'} USD`，"
            f"相对 SPY Alpha `{attr['alpha_vs_spy_pct'] if attr['alpha_vs_spy_pct'] is not None else 'N/A'}%`\n"
            f"- **核心归因**: {notes_str}\n"
            f"- **长期经验关键词**: `{trade.symbol}`, `{trade.regime_at_entry or 'UNKNOWN'}`, `{attr['quadrant']}`"
        )
        lessons_markdown = fallback_lesson

        if use_fast_llm:
            try:
                fast_llm = build_fast_llm(settings, temperature=0.1)
                prompt = (
                    f"标的: {trade.symbol} ({trade.side.upper()} {trade.qty} 股)\n"
                    f"入场 Regime: {trade.regime_at_entry}\n"
                    f"入场价/止损/止盈: {trade.entry_price} / {trade.stop_loss_price} / {trade.take_profit_price}\n"
                    f"已实现盈亏: {trade.realized_pnl} USD | SPY 同期回报: {trade.spy_benchmark_return_pct}%\n"
                    f"四象限归因: {attr['quadrant']} ({attr['quadrant_cn']})\n"
                    f"纪律检查: {notes_str}\n"
                    f"原始理由: {trade.rationale_summary}"
                )
                resp = await fast_llm.ainvoke(
                    [
                        {
                            "role": "system",
                            "content": "你是机构交易复盘教练。严格基于给定交易事实，生成 3 条精炼中文经验教训（Markdown 列表），重点指出过程合规性与下一次如何改进。",
                        },
                        {"role": "user", "content": prompt},
                    ]
                )
                llm_text = resp.content if isinstance(resp.content, str) else str(resp.content)
                if llm_text.strip():
                    lessons_markdown = f"### {trade.symbol} AI 复盘备忘 ({attr['quadrant_cn']})\n{llm_text.strip()}"
            except (LLMUnconfiguredError, OpenAIError, httpx.HTTPError, ValueError, RuntimeError, TimeoutError, OSError) as exc:
                logger.info("Using deterministic post-close reflection template: %s", exc)

        # Upsert or append TradeReview for (trade_id, horizon)
        existing_review = (
            await session.execute(
                select(TradeReview)
                .where(
                    TradeReview.paper_trade_id == trade.id,
                    TradeReview.horizon == horizon.upper().strip(),
                )
                .limit(1)
            )
        ).scalar_one_or_none()

        if existing_review is None:
            review = TradeReview(
                paper_trade_id=trade.id,
                horizon=horizon.upper().strip(),
                quadrant_outcome=attr["quadrant"],
                alpha_vs_spy_pct=attr["alpha_vs_spy_pct"],
                regime_label=trade.regime_at_entry,
                lessons_markdown=lessons_markdown,
            )
            session.add(review)
        else:
            review = existing_review
            review.quadrant_outcome = attr["quadrant"]
            review.alpha_vs_spy_pct = attr["alpha_vs_spy_pct"]
            review.regime_label = trade.regime_at_entry
            review.lessons_markdown = lessons_markdown

        # Persist searchable EpisodicMemory entry
        mem_title = f"{trade.symbol} {trade.side.upper()} [{attr['quadrant_cn']}]"
        lesson_plain = re.sub(r"[#`*]+", "", lessons_markdown).strip()
        lesson_plain = (
            f"{lesson_plain} | Keywords: {trade.symbol} {trade.side} "
            f"{trade.regime_at_entry or 'UNKNOWN'} {attr['quadrant']} stop_loss bracket"
        )
        tags = [
            trade.symbol.upper(),
            (trade.regime_at_entry or "UNKNOWN").upper(),
            attr["quadrant"],
            "GOOD_PROCESS" if attr["good_process"] else "BAD_PROCESS",
        ]

        vec: list[float] | None = None
        try:
            vecs = await embed_texts([f"{mem_title}\n{lesson_plain}"], settings)
            if vecs:
                vec = vecs[0]
        except (OpenAIError, httpx.HTTPError, ValueError, RuntimeError, TimeoutError, OSError):
            vec = None

        existing_mem = (
            await session.execute(
                select(EpisodicMemory)
                .where(EpisodicMemory.paper_trade_id == trade.id)
                .limit(1)
            )
        ).scalar_one_or_none()
        if existing_mem is None:
            memory = EpisodicMemory(
                paper_trade_id=trade.id,
                symbol=trade.symbol.upper(),
                regime_label=(trade.regime_at_entry or "UNKNOWN").upper(),
                quadrant_outcome=attr["quadrant"],
                title=mem_title[:240],
                lesson_text=lesson_plain,
                tags_json=tags,
                alpha_vs_spy_pct=attr["alpha_vs_spy_pct"],
                embedding=vec,
            )
            session.add(memory)
        else:
            existing_mem.regime_label = (trade.regime_at_entry or "UNKNOWN").upper()
            existing_mem.quadrant_outcome = attr["quadrant"]
            existing_mem.title = mem_title[:240]
            existing_mem.lesson_text = lesson_plain
            existing_mem.tags_json = tags
            existing_mem.alpha_vs_spy_pct = attr["alpha_vs_spy_pct"]
            if vec is not None:
                existing_mem.embedding = vec

        await session.commit()
        await session.refresh(review)

        return {
            "status": "ok",
            "review_id": review.id,
            "paper_trade_id": trade.id,
            "symbol": trade.symbol,
            "horizon": review.horizon,
            "quadrant_outcome": review.quadrant_outcome,
            "quadrant_cn": attr["quadrant_cn"],
            "process_score": attr["process_score"],
            "alpha_vs_spy_pct": review.alpha_vs_spy_pct,
            "lessons_markdown": review.lessons_markdown,
            "created_at": review.created_at.isoformat(),
        }

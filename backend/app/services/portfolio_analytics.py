from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agents.watchdog import classify_trade_quadrant
from app.db.models import MarketDailyBar, OptionsGexSnapshot, PaperTrade, TradeReview
from app.quant.risk import _default_stop_loss, _default_take_profit
from app.quant.technicals import DailyBarInput, analyze_asset_technicals
from app.services.broker import DEFAULT_SANDBOX_EQUITY


async def enrich_positions_with_structure(
    session_factory: async_sessionmaker[AsyncSession],
    positions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Attach ATR/GEX safety bounds (sl_ref / tp_ref) onto live Sandbox/T212/Alpaca positions."""
    if not positions:
        return positions

    syms = sorted({str(p.get("symbol", "")).upper().strip() for p in positions if p.get("symbol")})
    struct_map: dict[str, dict[str, float | None]] = {}

    async with session_factory() as session:
        for sym in syms:
            bars = list(
                (
                    await session.execute(
                        select(MarketDailyBar)
                        .where(MarketDailyBar.symbol == sym)
                        .order_by(desc(MarketDailyBar.trade_date))
                        .limit(45)
                    )
                )
                .scalars()
                .all()
            )
            atr_14: float | None = None
            if bars:
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
                raw_atr = tech.get("atr_14")
                atr_14 = float(raw_atr) if raw_atr is not None else None

            gex = (
                await session.execute(
                    select(OptionsGexSnapshot)
                    .where(OptionsGexSnapshot.symbol == sym)
                    .order_by(desc(OptionsGexSnapshot.snapshot_time))
                    .limit(1)
                )
            ).scalar_one_or_none()

            struct_map[sym] = {
                "atr_14": atr_14,
                "call_wall": float(gex.call_wall) if gex and gex.call_wall else None,
                "put_wall": float(gex.put_wall) if gex and gex.put_wall else None,
                "zero_gamma": float(gex.zero_gamma) if gex and gex.zero_gamma else None,
            }

    enriched: list[dict[str, Any]] = []
    for raw in positions:
        pos = dict(raw)
        sym = str(pos.get("symbol", "")).upper().strip()
        meta = struct_map.get(sym, {})
        side = "sell" if str(pos.get("side", "long")).lower() == "short" else "buy"
        avg_entry = float(pos.get("avg_entry_price") or pos.get("current_price") or 0.0)
        cur_px = float(pos.get("current_price") or avg_entry or 0.0)
        anchor = avg_entry if avg_entry > 0 else cur_px

        explicit_sl = pos.get("stop_loss_price")
        explicit_tp = pos.get("take_profit_price")
        sl_estimated = False
        sl_val = float(explicit_sl) if explicit_sl is not None and float(explicit_sl) > 0 else None
        tp_val = float(explicit_tp) if explicit_tp is not None and float(explicit_tp) > 0 else None

        if anchor > 0 and sl_val is None:
            sl_estimated = True
            sl_val = _default_stop_loss(
                side=side,
                entry=anchor,
                atr_14=meta.get("atr_14"),
                call_wall=meta.get("call_wall"),
                put_wall=meta.get("put_wall"),
            )
        if anchor > 0 and sl_val is not None and tp_val is None:
            tp_val = _default_take_profit(
                side=side,
                entry=anchor,
                stop_loss=sl_val,
                call_wall=meta.get("call_wall"),
                put_wall=meta.get("put_wall"),
            )

        pos["stop_loss_price"] = sl_val
        pos["take_profit_price"] = tp_val
        pos["sl_is_estimated"] = sl_estimated
        pos["zero_gamma"] = meta.get("zero_gamma")
        pos["call_wall"] = meta.get("call_wall")
        pos["put_wall"] = meta.get("put_wall")
        enriched.append(pos)

    return enriched


def _build_demo_analytics_preview(currency: str, base_equity: float) -> dict[str, Any]:
    """Deterministic institutional showcase for Net Equity & 2x2 Quadrant Matrix when history is sparse."""
    base = round(max(1000.0, float(base_equity or DEFAULT_SANDBOX_EQUITY)), 2)
    points_rel = [
        ("T-14D", 0.0, 0.0),
        ("T-12D", 1.1, 0.4),
        ("T-10D", 2.4, 0.9),
        ("T-8D", 1.7, 1.3),
        ("T-6D", 3.6, 1.1),
        ("T-4D", 5.2, 1.8),
        ("T-2D", 4.7, 2.2),
        ("今日", 6.85, 2.4),
    ]
    curve: list[dict[str, Any]] = []
    peak = base
    max_dd = 0.0
    for label, p_pct, spy_pct in points_rel:
        eq = round(base * (1.0 + p_pct / 100.0), 2)
        peak = max(peak, eq)
        dd = round(((eq / peak) - 1.0) * 100.0, 2) if peak > 0 else 0.0
        max_dd = min(max_dd, dd)
        curve.append(
            {
                "date": label,
                "equity": eq,
                "portfolio_return_pct": p_pct,
                "spy_return_pct": spy_pct,
                "drawdown_pct": dd,
            }
        )

    quadrant_points = [
        {
            "trade_id": 901,
            "symbol": "NVDA",
            "side": "buy",
            "qty": 32,
            "quadrant": "GOOD_PROCESS_GOOD_OUTCOME",
            "quadrant_cn": "高纪律盈利",
            "process_score": 92,
            "return_pct": 8.4,
            "alpha_vs_spy_pct": 6.1,
            "realized_pnl": round(base * 0.024, 2),
            "regime_label": "GOLDILOCKS_EXPANSION",
            "closed_at": "演示样本",
        },
        {
            "trade_id": 902,
            "symbol": "MSFT",
            "side": "buy",
            "qty": 18,
            "quadrant": "GOOD_PROCESS_GOOD_OUTCOME",
            "quadrant_cn": "高纪律盈利",
            "process_score": 88,
            "return_pct": 4.9,
            "alpha_vs_spy_pct": 3.4,
            "realized_pnl": round(base * 0.015, 2),
            "regime_label": "GOLDILOCKS_EXPANSION",
            "closed_at": "演示样本",
        },
        {
            "trade_id": 903,
            "symbol": "TSLA",
            "side": "buy",
            "qty": 20,
            "quadrant": "GOOD_PROCESS_BAD_OUTCOME",
            "quadrant_cn": "合规止损",
            "process_score": 85,
            "return_pct": -2.1,
            "alpha_vs_spy_pct": -2.5,
            "realized_pnl": round(-base * 0.008, 2),
            "regime_label": "HIGH_VOL_TRANSITION",
            "closed_at": "演示样本",
        },
        {
            "trade_id": 904,
            "symbol": "AAPL",
            "side": "buy",
            "qty": 25,
            "quadrant": "GOOD_PROCESS_GOOD_OUTCOME",
            "quadrant_cn": "高纪律盈利",
            "process_score": 95,
            "return_pct": 6.2,
            "alpha_vs_spy_pct": 4.7,
            "realized_pnl": round(base * 0.021, 2),
            "regime_label": "NEUTRAL_ROTATION",
            "closed_at": "演示样本",
        },
        {
            "trade_id": 905,
            "symbol": "META",
            "side": "buy",
            "qty": 12,
            "quadrant": "BAD_PROCESS_GOOD_OUTCOME",
            "quadrant_cn": "侥幸盈利",
            "process_score": 52,
            "return_pct": 3.1,
            "alpha_vs_spy_pct": 1.2,
            "realized_pnl": round(base * 0.011, 2),
            "regime_label": "RISK_OFF_STRESS",
            "closed_at": "演示样本",
        },
        {
            "trade_id": 906,
            "symbol": "AMD",
            "side": "buy",
            "qty": 30,
            "quadrant": "BAD_PROCESS_BAD_OUTCOME",
            "quadrant_cn": "双输复盘",
            "process_score": 40,
            "return_pct": -4.8,
            "alpha_vs_spy_pct": -5.3,
            "realized_pnl": round(-base * 0.014, 2),
            "regime_label": "RISK_OFF_STRESS",
            "closed_at": "演示样本",
        },
    ]

    counts = {
        "GOOD_PROCESS_GOOD_OUTCOME": 3,
        "GOOD_PROCESS_BAD_OUTCOME": 1,
        "BAD_PROCESS_GOOD_OUTCOME": 1,
        "BAD_PROCESS_BAD_OUTCOME": 1,
    }
    return {
        "currency": currency,
        "kpis": {
            "closed_trades": 6,
            "win_count": 4,
            "loss_count": 2,
            "win_rate_pct": 66.7,
            "gross_profit": round(base * 0.071, 2),
            "gross_loss": round(base * 0.022, 2),
            "net_realized_pnl": round(base * 0.049, 2),
            "profit_factor": 3.23,
            "avg_process_score": 75.3,
            "portfolio_return_pct": 6.85,
            "spy_return_pct": 2.4,
            "excess_alpha_pct": 4.45,
            "max_drawdown_pct": round(max_dd, 2),
        },
        "equity_curve": curve,
        "quadrant_points": quadrant_points,
        "quadrant_counts": counts,
    }


async def build_portfolio_analytics(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    broker: str,
    account: dict[str, Any] | None,
    workspace_id: str = "default",
) -> dict[str, Any]:
    """Build Net Equity vs SPY curve, quantitative KPIs, and 2x2 Quadrant scatter data."""
    currency = str((account or {}).get("currency") or "USD").upper()
    current_equity = float((account or {}).get("equity") or DEFAULT_SANDBOX_EQUITY)

    async with session_factory() as session:
        trades = list(
            (
                await session.execute(
                    select(PaperTrade)
                    .where(PaperTrade.workspace_id == workspace_id)
                    .order_by(PaperTrade.created_at.asc())
                    .limit(200)
                )
            )
            .scalars()
            .all()
        )
        reviews = list(
            (
                await session.execute(
                    select(TradeReview)
                    .join(PaperTrade, TradeReview.paper_trade_id == PaperTrade.id)
                    .where(PaperTrade.workspace_id == workspace_id)
                    .order_by(TradeReview.created_at.asc())
                    .limit(200)
                )
            )
            .scalars()
            .all()
        )
        spy_bars = list(
            (
                await session.execute(
                    select(MarketDailyBar)
                    .where(MarketDailyBar.symbol == "SPY")
                    .order_by(MarketDailyBar.trade_date.asc())
                    .limit(180)
                )
            )
            .scalars()
            .all()
        )

    review_by_trade: dict[int, TradeReview] = {}
    for rev in reviews:
        review_by_trade[int(rev.paper_trade_id)] = rev

    closed_trades = [t for t in trades if t.status == "closed"]

    win_count = 0
    loss_count = 0
    gross_profit = 0.0
    gross_loss = 0.0
    quadrant_points: list[dict[str, Any]] = []
    quadrant_counts = {
        "GOOD_PROCESS_GOOD_OUTCOME": 0,
        "GOOD_PROCESS_BAD_OUTCOME": 0,
        "BAD_PROCESS_GOOD_OUTCOME": 0,
        "BAD_PROCESS_BAD_OUTCOME": 0,
    }
    process_scores: list[int] = []

    for t in closed_trades:
        pnl = float(t.realized_pnl or 0.0)
        if pnl > 0:
            win_count += 1
            gross_profit += pnl
        elif pnl < 0:
            loss_count += 1
            gross_loss += abs(pnl)

        attr = classify_trade_quadrant(
            side=t.side,
            qty=float(t.qty),
            entry_price=t.entry_price,
            stop_loss_price=t.stop_loss_price,
            take_profit_price=t.take_profit_price,
            risk_budget_pct=float(t.risk_budget_pct),
            realized_pnl=t.realized_pnl,
            spy_benchmark_return_pct=t.spy_benchmark_return_pct,
            regime_at_entry=t.regime_at_entry,
        )
        rev = review_by_trade.get(int(t.id))
        q_code = rev.quadrant_outcome if rev else attr["quadrant"]
        if q_code not in quadrant_counts:
            q_code = attr["quadrant"]
        quadrant_counts[q_code] += 1
        p_score = int(attr["process_score"])
        process_scores.append(p_score)

        ret_pct = attr["trade_return_pct"]
        if ret_pct is None:
            ret_pct = round((pnl / max(1.0, current_equity)) * 100.0, 2)
        q_cn_map = {
            "GOOD_PROCESS_GOOD_OUTCOME": "高纪律盈利",
            "GOOD_PROCESS_BAD_OUTCOME": "合规止损",
            "BAD_PROCESS_GOOD_OUTCOME": "侥幸盈利",
            "BAD_PROCESS_BAD_OUTCOME": "双输复盘",
        }
        closed_dt = t.closed_at or t.updated_at or t.created_at
        quadrant_points.append(
            {
                "trade_id": t.id,
                "symbol": t.symbol,
                "side": t.side,
                "qty": float(t.qty),
                "quadrant": q_code,
                "quadrant_cn": q_cn_map.get(q_code, q_code),
                "process_score": p_score,
                "return_pct": round(float(ret_pct), 2),
                "alpha_vs_spy_pct": (
                    rev.alpha_vs_spy_pct if rev and rev.alpha_vs_spy_pct is not None else attr["alpha_vs_spy_pct"]
                ),
                "realized_pnl": round(pnl, 2),
                "regime_label": t.regime_at_entry or "UNKNOWN",
                "closed_at": closed_dt.strftime("%m-%d %H:%M") if closed_dt else "—",
            }
        )

    # Also surface open reviewed trades if any exist cleanly? No, quadrant chart maps closed/settled outcomes.
    net_realized = round(gross_profit - gross_loss, 2)
    base_equity = DEFAULT_SANDBOX_EQUITY if broker == "sandbox" else max(100.0, current_equity - net_realized)

    # Build chronological equity curve vs SPY
    spy_by_date: dict[str, float] = {b.trade_date.isoformat(): float(b.close) for b in spy_bars}
    latest_spy = float(spy_bars[-1].close) if spy_bars else None

    def _spy_on_or_before(iso_day: str) -> float | None:
        if iso_day in spy_by_date:
            return spy_by_date[iso_day]
        prev = [float(b.close) for b in spy_bars if b.trade_date.isoformat() <= iso_day]
        return prev[-1] if prev else (float(spy_bars[0].close) if spy_bars else None)

    equity_curve: list[dict[str, Any]] = []
    peak_eq = base_equity
    max_dd_pct = 0.0
    spy_anchor: float | None = None

    if closed_trades:
        first_dt = (closed_trades[0].created_at or datetime.now(timezone.utc)).date().isoformat()
        spy_anchor = _spy_on_or_before(first_dt)
        equity_curve.append(
            {
                "date": first_dt,
                "equity": round(base_equity, 2),
                "portfolio_return_pct": 0.0,
                "spy_return_pct": 0.0,
                "drawdown_pct": 0.0,
            }
        )
        running_eq = base_equity
        for idx, t in enumerate(closed_trades, start=1):
            running_eq = round(running_eq + float(t.realized_pnl or 0.0), 2)
            peak_eq = max(peak_eq, running_eq)
            dd = round(((running_eq / peak_eq) - 1.0) * 100.0, 2) if peak_eq > 0 else 0.0
            max_dd_pct = min(max_dd_pct, dd)
            c_day = ((t.closed_at or t.updated_at or t.created_at)).date().isoformat()
            spy_px = _spy_on_or_before(c_day)
            spy_ret = (
                round(((spy_px / spy_anchor) - 1.0) * 100.0, 2)
                if (spy_px and spy_anchor and spy_anchor > 0)
                else 0.0
            )
            port_ret = round(((running_eq / base_equity) - 1.0) * 100.0, 2) if base_equity > 0 else 0.0
            label = c_day if not equity_curve or equity_curve[-1]["date"] != c_day else f"{c_day} #{idx}"
            equity_curve.append(
                {
                    "date": label,
                    "equity": running_eq,
                    "portfolio_return_pct": port_ret,
                    "spy_return_pct": spy_ret,
                    "drawdown_pct": dd,
                }
            )
        # Current mark-to-market snapshot endpoint
        peak_eq = max(peak_eq, current_equity)
        live_dd = round(((current_equity / peak_eq) - 1.0) * 100.0, 2) if peak_eq > 0 else 0.0
        max_dd_pct = min(max_dd_pct, live_dd)
        live_port_ret = round(((current_equity / base_equity) - 1.0) * 100.0, 2) if base_equity > 0 else 0.0
        live_spy_ret = (
            round(((latest_spy / spy_anchor) - 1.0) * 100.0, 2)
            if (latest_spy and spy_anchor and spy_anchor > 0)
            else 0.0
        )
        equity_curve.append(
            {
                "date": "当前净值",
                "equity": round(current_equity, 2),
                "portfolio_return_pct": live_port_ret,
                "spy_return_pct": live_spy_ret,
                "drawdown_pct": live_dd,
            }
        )
    else:
        live_port_ret = round(((current_equity / base_equity) - 1.0) * 100.0, 2) if base_equity > 0 else 0.0
        live_spy_ret = 0.0
        equity_curve = [
            {
                "date": "期初基准",
                "equity": round(base_equity, 2),
                "portfolio_return_pct": 0.0,
                "spy_return_pct": 0.0,
                "drawdown_pct": 0.0,
            },
            {
                "date": "当前净值",
                "equity": round(current_equity, 2),
                "portfolio_return_pct": live_port_ret,
                "spy_return_pct": 0.0,
                "drawdown_pct": 0.0,
            },
        ]

    total_closed = len(closed_trades)
    win_rate = round((win_count / total_closed) * 100.0, 1) if total_closed > 0 else 0.0
    profit_factor: float | None = None
    if gross_loss > 0:
        profit_factor = round(gross_profit / gross_loss, 2)
    elif gross_profit > 0:
        profit_factor = 9.99

    avg_process = round(sum(process_scores) / len(process_scores), 1) if process_scores else None
    port_final_ret = equity_curve[-1]["portfolio_return_pct"] if equity_curve else 0.0
    spy_final_ret = equity_curve[-1]["spy_return_pct"] if equity_curve else 0.0

    return {
        "status": "ok",
        "broker": broker,
        "currency": currency,
        "has_sufficient_real_history": total_closed >= 2,
        "kpis": {
            "closed_trades": total_closed,
            "win_count": win_count,
            "loss_count": loss_count,
            "win_rate_pct": win_rate,
            "gross_profit": round(gross_profit, 2),
            "gross_loss": round(gross_loss, 2),
            "net_realized_pnl": net_realized,
            "profit_factor": profit_factor,
            "avg_process_score": avg_process,
            "portfolio_return_pct": port_final_ret,
            "spy_return_pct": spy_final_ret,
            "excess_alpha_pct": round(port_final_ret - spy_final_ret, 2),
            "max_drawdown_pct": round(max_dd_pct, 2),
        },
        "equity_curve": equity_curve,
        "quadrant_points": quadrant_points,
        "quadrant_counts": quadrant_counts,
        "demo_preview": _build_demo_analytics_preview(currency, current_equity),
    }

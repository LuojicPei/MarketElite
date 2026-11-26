from __future__ import annotations

import itertools
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import numpy as np


@dataclass(frozen=True)
class DailyBarInput:
    """Normalized chronological daily OHLCV bar input."""

    trade_date: str
    open: float
    high: float
    low: float
    close: float
    volume: float
    vwap: float | None = None


SECTOR_BUCKETS: dict[str, tuple[str, str]] = {
    "XLK": ("Technology", "Offensive"),
    "XLY": ("Consumer Discretionary", "Offensive"),
    "XLC": ("Communication Services", "Offensive"),
    "XLF": ("Financials", "Cyclical"),
    "XLI": ("Industrials", "Cyclical"),
    "XLE": ("Energy", "Cyclical"),
    "XLB": ("Materials", "Cyclical"),
    "XLU": ("Utilities", "Defensive"),
    "XLP": ("Consumer Staples", "Defensive"),
    "XLV": ("Health Care", "Defensive"),
    "XLRE": ("Real Estate", "Defensive"),
}


def compute_sma(values: Sequence[float], window: int) -> float | None:
    """Compute Simple Moving Average of the trailing `window` observations."""
    if window <= 0 or len(values) < window:
        return None
    arr = np.asarray(values[-window:], dtype=np.float64)
    return float(np.mean(arr))


def compute_ema(values: Sequence[float], span: int) -> float | None:
    """Compute Exponential Moving Average using standard multiplier 2 / (span + 1)."""
    if span <= 0 or len(values) < span:
        return None
    alpha = 2.0 / (span + 1.0)
    ema = float(np.mean(np.asarray(values[:span], dtype=np.float64)))
    for price in values[span:]:
        ema = (float(price) - ema) * alpha + ema
    return ema


def compute_rsi(closes: Sequence[float], period: int = 14) -> float | None:
    """Compute Wilder's Relative Strength Index (0..100)."""
    if len(closes) < period + 1:
        return None
    arr = np.asarray(closes, dtype=np.float64)
    deltas = np.diff(arr)
    gains = np.where(deltas > 0.0, deltas, 0.0)
    losses = np.where(deltas < 0.0, -deltas, 0.0)

    avg_gain = float(np.mean(gains[:period]))
    avg_loss = float(np.mean(losses[:period]))

    for g, loss in zip(gains[period:], losses[period:]):
        avg_gain = ((avg_gain * (period - 1)) + float(g)) / period
        avg_loss = ((avg_loss * (period - 1)) + float(loss)) / period

    if avg_loss == 0.0:
        return 100.0 if avg_gain > 0.0 else 50.0
    rs = avg_gain / avg_loss
    return round(100.0 - (100.0 / (1.0 + rs)), 2)


def compute_macd(
    closes: Sequence[float],
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
) -> dict[str, float] | None:
    """Compute MACD line, signal line, and histogram."""
    if len(closes) < slow + signal:
        return None
    arr = np.asarray(closes, dtype=np.float64)
    alpha_fast = 2.0 / (fast + 1.0)
    alpha_slow = 2.0 / (slow + 1.0)
    alpha_sig = 2.0 / (signal + 1.0)

    ema_fast = float(arr[0])
    ema_slow = float(arr[0])
    macd_series: list[float] = []
    for price in arr:
        p = float(price)
        ema_fast = (p - ema_fast) * alpha_fast + ema_fast
        ema_slow = (p - ema_slow) * alpha_slow + ema_slow
        macd_series.append(ema_fast - ema_slow)

    sig_track = float(np.mean(np.asarray(macd_series[:signal], dtype=np.float64)))
    hist_list: list[float] = [macd_series[signal - 1] - sig_track]
    for val in macd_series[signal:]:
        sig_track = (val - sig_track) * alpha_sig + sig_track
        hist_list.append(val - sig_track)

    macd_val = macd_series[-1]
    hist = hist_list[-1]
    prev_histogram = hist_list[-2] if len(hist_list) >= 2 else hist
    return {
        "macd": round(macd_val, 4),
        "signal": round(sig_track, 4),
        "histogram": round(hist, 4),
        "prev_histogram": round(prev_histogram, 4),
    }


def compute_bollinger_bands(
    closes: Sequence[float],
    period: int = 20,
    num_std: float = 2.0,
) -> dict[str, float] | None:
    """Compute Bollinger Bands (middle SMA, upper/lower bands, and width %)."""
    if period <= 1 or len(closes) < period:
        return None
    window = np.asarray(closes[-period:], dtype=np.float64)
    mid = float(np.mean(window))
    std = float(np.std(window, ddof=0))
    upper = mid + num_std * std
    lower = mid - num_std * std
    bw = ((upper - lower) / mid) * 100.0 if mid > 0 else 0.0
    return {
        "upper": round(upper, 4),
        "middle": round(mid, 4),
        "lower": round(lower, 4),
        "bandwidth_pct": round(bw, 2),
    }


def compute_atr(
    highs: Sequence[float],
    lows: Sequence[float],
    closes: Sequence[float],
    period: int = 14,
) -> float | None:
    """Compute Wilder Average True Range (ATR)."""
    n = min(len(highs), len(lows), len(closes))
    if n < period + 1:
        return None
    trs: list[float] = []
    for idx in range(1, n):
        hl = float(highs[idx]) - float(lows[idx])
        hc = abs(float(highs[idx]) - float(closes[idx - 1]))
        lc = abs(float(lows[idx]) - float(closes[idx - 1]))
        trs.append(max(hl, hc, lc))

    atr_val = float(np.mean(np.asarray(trs[:period], dtype=np.float64)))
    for tr in trs[period:]:
        atr_val = ((atr_val * (period - 1)) + tr) / period
    return round(atr_val, 4)


def compute_rvol(volumes: Sequence[float], window: int = 20) -> float | None:
    """Compute Relative Volume = latest bar volume / trailing `window`-day average volume."""
    if len(volumes) < window + 1:
        return None
    baseline = np.asarray(volumes[-(window + 1) : -1], dtype=np.float64)
    avg_vol = float(np.mean(baseline))
    if avg_vol <= 0.0:
        return None
    return round(float(volumes[-1]) / avg_vol, 3)


def _session_rvol(bars: Sequence[DailyBarInput], window: int = 20) -> tuple[float | None, str]:
    """Use last completed full session for RVOL when today's bar is still in-progress."""
    volumes = [b.volume for b in bars]
    if len(bars) < window + 2:
        return compute_rvol(volumes, window), "current_bar"

    latest_date = bars[-1].trade_date
    try:
        ny_now = datetime.now(ZoneInfo("America/New_York"))
    except KeyError:
        ny_now = datetime.now(timezone.utc)

    is_partial_ny_session = (
        latest_date == ny_now.date().isoformat()
        and (ny_now.hour < 16 or (ny_now.hour == 16 and ny_now.minute < 15))
    )
    if is_partial_ny_session:
        return compute_rvol(volumes[:-1], window), "last_closed_session"
    return compute_rvol(volumes, window), "current_bar"


def classify_volume_price_quadrant(change_1d_pct: float, rvol_20: float | None) -> str:
    """Classify price change vs RVOL into 4 deterministic volume-price regimes."""
    if rvol_20 is None:
        return "Unclassified (Insufficient Volume History)"
    elevated_vol = rvol_20 >= 1.2
    if change_1d_pct >= 0.0 and elevated_vol:
        return "Volume Expansion Up (Accumulation / Breakout)"
    if change_1d_pct >= 0.0 and not elevated_vol:
        return "Low-Volume Drift Up (Thin Conviction)"
    if change_1d_pct < 0.0 and elevated_vol:
        return "Volume Expansion Down (Distribution / Stress)"
    return "Low-Volume Pullback (Orderly Digestion)"


def _pct_change(closes: Sequence[float], lookback: int) -> float | None:
    if len(closes) <= lookback or closes[-(lookback + 1)] == 0:
        return None
    prev = float(closes[-(lookback + 1)])
    curr = float(closes[-1])
    return round(((curr / prev) - 1.0) * 100.0, 2)


def analyze_asset_technicals(bars: Sequence[DailyBarInput]) -> dict[str, object]:
    """Compute full deterministic technical summary for one symbol from consolidated daily bars."""
    if not bars:
        return {"available": False}

    closes = [b.close for b in bars]
    highs = [b.high for b in bars]
    lows = [b.low for b in bars]

    last_close = float(closes[-1])
    change_1d = _pct_change(closes, 1)
    change_5d = _pct_change(closes, 5)
    change_20d = _pct_change(closes, 20)

    latest_yr = bars[-1].trade_date[:4]
    ytd_base: float | None = None
    for b in reversed(bars):
        if b.trade_date[:4] < latest_yr:
            ytd_base = float(b.close)
            break
    if ytd_base is None:
        for b in bars:
            if b.trade_date.startswith(latest_yr):
                ytd_base = float(b.close)
                break
    change_ytd = (
        round(((last_close / ytd_base) - 1.0) * 100.0, 2)
        if (ytd_base and ytd_base > 0)
        else None
    )

    sma_50 = compute_sma(closes, 50)
    sma_200 = compute_sma(closes, 200)
    ema_5 = compute_ema(closes, 5)
    ema_9 = compute_ema(closes, 9)
    ema_10 = compute_ema(closes, 10)
    ema_20 = compute_ema(closes, 20)
    rsi_14 = compute_rsi(closes, 14)
    macd_val = compute_macd(closes)
    bollinger_val = compute_bollinger_bands(closes, 20, 2.0)
    atr_14 = compute_atr(highs, lows, closes, 14)
    rvol_20, rvol_basis = _session_rvol(bars, 20)

    dist_50 = round(((last_close / sma_50) - 1.0) * 100.0, 2) if sma_50 else None
    dist_200 = round(((last_close / sma_200) - 1.0) * 100.0, 2) if sma_200 else None
    atr_pct = round((atr_14 / last_close) * 100.0, 2) if (atr_14 and last_close > 0) else None
    high_52w = max(highs[-252:]) if highs else None
    dist_52w_high = (
        round(((last_close / high_52w) - 1.0) * 100.0, 2)
        if (high_52w and high_52w > 0)
        else None
    )
    prev_close = round(float(closes[-2]), 4) if len(closes) >= 2 else round(last_close, 4)
    sparkline_bars = [
        {
            "t": idx,
            "o": round(float(b.open), 4),
            "h": round(float(b.high), 4),
            "l": round(float(b.low), 4),
            "c": round(float(b.close), 4),
        }
        for idx, b in enumerate(bars[-18:])
    ]

    return {
        "available": True,
        "as_of_date": bars[-1].trade_date,
        "last_close": round(last_close, 4),
        "prev_close": prev_close,
        "change_1d_pct": change_1d,
        "change_5d_pct": change_5d,
        "change_20d_pct": change_20d,
        "change_ytd_pct": change_ytd,
        "ema_5": round(ema_5, 4) if ema_5 is not None else None,
        "ema_9": round(ema_9, 4) if ema_9 is not None else None,
        "ema_10": round(ema_10, 4) if ema_10 is not None else None,
        "ema_20": round(ema_20, 4) if ema_20 is not None else None,
        "sma_50": round(sma_50, 4) if sma_50 is not None else None,
        "sma_200": round(sma_200, 4) if sma_200 is not None else None,
        "dist_50ma_pct": dist_50,
        "dist_200ma_pct": dist_200,
        "high_52w": round(float(high_52w), 4) if high_52w is not None else None,
        "dist_52w_high_pct": dist_52w_high,
        "rsi_14": rsi_14,
        "macd": macd_val,
        "bollinger": bollinger_val,
        "atr_14": atr_14,
        "atr_pct": atr_pct,
        "rvol_20": rvol_20,
        "rvol_basis": rvol_basis,
        "volume_price_tag": classify_volume_price_quadrant(change_1d or 0.0, rvol_20),
        "sparkline_bars": sparkline_bars,
    }


def compute_market_breadth(
    universe_bars: Mapping[str, Sequence[DailyBarInput]],
    *,
    spy_bars: Sequence[DailyBarInput] | None = None,
    rsp_bars: Sequence[DailyBarInput] | None = None,
) -> dict[str, object]:
    """Compute RSP/SPY ratio and % of tracked liquid universe above 50MA & 200MA."""
    above_50 = 0
    total_50 = 0
    above_200 = 0
    total_200 = 0
    advances = 0
    declines = 0

    for bars in universe_bars.values():
        if len(bars) < 2:
            continue
        closes = [b.close for b in bars]
        if closes[-1] > closes[-2]:
            advances += 1
        elif closes[-1] < closes[-2]:
            declines += 1

        sma50 = compute_sma(closes, 50)
        if sma50 is not None:
            total_50 += 1
            if closes[-1] > sma50:
                above_50 += 1

        sma200 = compute_sma(closes, 200)
        if sma200 is not None:
            total_200 += 1
            if closes[-1] > sma200:
                above_200 += 1

    rsp_spy_ratio: float | None = None
    rsp_spy_20d_delta_pct: float | None = None
    if spy_bars and rsp_bars:
        n = min(len(spy_bars), len(rsp_bars))
        if n > 0 and spy_bars[-1].close > 0:
            rsp_spy_ratio = round(rsp_bars[-1].close / spy_bars[-1].close, 4)
            if n >= 21 and spy_bars[-21].close > 0:
                prev_ratio = rsp_bars[-21].close / spy_bars[-21].close
                if prev_ratio > 0:
                    rsp_spy_20d_delta_pct = round(((rsp_spy_ratio / prev_ratio) - 1.0) * 100.0, 2)

    return {
        "universe_tracked_50ma": total_50,
        "universe_tracked_200ma": total_200,
        "pct_above_50ma": round((above_50 / total_50) * 100.0, 1) if total_50 > 0 else None,
        "pct_above_200ma": round((above_200 / total_200) * 100.0, 1) if total_200 > 0 else None,
        "advances": advances,
        "declines": declines,
        "adv_dec_ratio": round(advances / declines, 2) if declines > 0 else None,
        "rsp_spy_ratio": rsp_spy_ratio,
        "rsp_spy_20d_delta_pct": rsp_spy_20d_delta_pct,
    }


def compute_sector_rotation(
    sector_bars: Mapping[str, Sequence[DailyBarInput]],
    *,
    spy_bars: Sequence[DailyBarInput] | None = None,
) -> list[dict[str, object]]:
    """Rank 11 SPDR sectors across Offensive, Cyclical, and Defensive buckets."""
    spy_20d = _pct_change([b.close for b in spy_bars], 20) if spy_bars else None
    rows: list[dict[str, object]] = []
    for ticker, (name, bucket) in SECTOR_BUCKETS.items():
        bars = sector_bars.get(ticker, ())
        closes = [b.close for b in bars]
        r1 = _pct_change(closes, 1)
        r5 = _pct_change(closes, 5)
        r20 = _pct_change(closes, 20)
        rel_20 = round(r20 - spy_20d, 2) if (r20 is not None and spy_20d is not None) else None
        rvol_val, _ = _session_rvol(bars, 20)
        rows.append(
            {
                "symbol": ticker,
                "name": name,
                "bucket": bucket,
                "last_close": round(closes[-1], 2) if closes else None,
                "return_1d_pct": r1,
                "return_5d_pct": r5,
                "return_20d_pct": r20,
                "rel_spy_20d_pct": rel_20,
                "rvol_20": rvol_val,
            }
        )
    rows.sort(key=lambda r: float(r["return_20d_pct"] or -999.0), reverse=True)
    return rows


def compute_cross_asset_correlations(
    asset_bars: Mapping[str, Sequence[DailyBarInput]],
    *,
    anchor_symbol: str = "SPY",
    windows: tuple[int, ...] = (20, 60),
) -> dict[str, dict[str, float | None]]:
    """Compute rolling 20D/60D return Pearson correlations of UUP/GLD/CPER/TLT/BTC vs SPY."""
    anchor_list = asset_bars.get(anchor_symbol, ())
    if len(anchor_list) < 25:
        return {}

    anchor_returns: dict[str, float] = {}
    for prev_b, curr_b in itertools.pairwise(anchor_list):
        if prev_b.close > 0:
            anchor_returns[curr_b.trade_date] = (curr_b.close / prev_b.close) - 1.0

    results: dict[str, dict[str, float | None]] = {}
    for sym, bars in asset_bars.items():
        if sym == anchor_symbol or len(bars) < 25:
            continue
        sym_returns: dict[str, float] = {}
        for prev_b, curr_b in itertools.pairwise(bars):
            if prev_b.close > 0:
                sym_returns[curr_b.trade_date] = (curr_b.close / prev_b.close) - 1.0

        common_dates = sorted(set(anchor_returns) & set(sym_returns))
        corrs: dict[str, float | None] = {}
        for w in windows:
            if len(common_dates) < w:
                corrs[f"corr_{w}d"] = None
                continue
            window_dates = common_dates[-w:]
            x = np.asarray([anchor_returns[d] for d in window_dates], dtype=np.float64)
            y = np.asarray([sym_returns[d] for d in window_dates], dtype=np.float64)
            if np.std(x) < 1e-12 or np.std(y) < 1e-12:
                corrs[f"corr_{w}d"] = 0.0
            else:
                corr = float(np.corrcoef(x, y)[0, 1])
                corrs[f"corr_{w}d"] = round(corr, 3)
        results[sym] = corrs
    return results


def classify_market_regime(
    *,
    net_liq_delta_20d: float | None,
    hy_oas: float | None,
    vix_spot: float | None,
    vix_term_ratio: float | None,
    spy_dist_50ma_pct: float | None,
    pct_above_50ma: float | None,
    spy_net_gex: float | None = None,
) -> dict[str, object]:
    """Classify overall US Equity Market Structure Regime deterministically (0 LLM tokens)."""
    reasons: list[str] = []
    stress_points = 0
    support_points = 0

    if vix_term_ratio is not None:
        if vix_term_ratio > 1.02:
            stress_points += 2
            reasons.append(f"VIX term backwardation ({vix_term_ratio:.2f})")
        elif vix_term_ratio < 0.94:
            support_points += 1
            reasons.append(f"VIX term contango ({vix_term_ratio:.2f})")

    if vix_spot is not None:
        if vix_spot >= 24.0:
            stress_points += 2
            reasons.append(f"Elevated VIX spot ({vix_spot:.1f})")
        elif vix_spot <= 17.0:
            support_points += 1

    if hy_oas is not None:
        if hy_oas >= 4.75:
            stress_points += 2
            reasons.append(f"Widening HY OAS ({hy_oas:.2f}%)")
        elif hy_oas < 3.6:
            support_points += 1

    if net_liq_delta_20d is not None:
        if net_liq_delta_20d < -100.0:
            stress_points += 1
            reasons.append(f"Net Liquidity draining ({net_liq_delta_20d:+.1f}B / 20D)")
        elif net_liq_delta_20d > 50.0:
            support_points += 1
            reasons.append(f"Net Liquidity expanding ({net_liq_delta_20d:+.1f}B / 20D)")

    if spy_dist_50ma_pct is not None:
        if spy_dist_50ma_pct < -1.5:
            stress_points += 1
            reasons.append(f"SPY below 50SMA ({spy_dist_50ma_pct:+.1f}%)")
        elif spy_dist_50ma_pct > 1.0:
            support_points += 1

    if pct_above_50ma is not None and pct_above_50ma < 35.0:
        stress_points += 1
        reasons.append(f"Weak breadth ({pct_above_50ma:.0f}% > 50MA)")

    if spy_net_gex is not None and spy_net_gex < 0:
        reasons.append("Estimated Dealer Net GEX negative (amplified move regime)")

    if stress_points >= 4:
        label = "RISK_OFF_STRESS"
    elif stress_points >= 2 and (net_liq_delta_20d or 0.0) < -100.0:
        label = "LIQUIDITY_TIGHTENING"
    elif stress_points >= 2:
        label = "HIGH_VOL_TRANSITION"
    elif support_points >= 3 and stress_points == 0:
        label = "RISK_ON_EXPANSION"
    else:
        label = "NEUTRAL_ROTATION"

    return {
        "regime_label": label,
        "stress_score": stress_points,
        "support_score": support_points,
        "drivers": reasons or ["Balanced macro, credit, and volatility structure"],
    }

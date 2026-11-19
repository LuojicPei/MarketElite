from __future__ import annotations

from collections.abc import Sequence
from datetime import date


def _clamp(val: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, val))


def _linear_scale(val: float, low_in: float, high_in: float) -> float:
    """Map `val` linearly from [low_in, high_in] into [0, 100], clamped."""
    if high_in == low_in:
        return 50.0
    ratio = (val - low_in) / (high_in - low_in)
    return _clamp(ratio * 100.0, 0.0, 100.0)


def compute_net_liquidity_series(
    walcl_points: Sequence[tuple[date, float]],
    wtregen_points: Sequence[tuple[date, float]],
    rrpontsyd_points: Sequence[tuple[date, float]],
) -> dict[str, object]:
    """Compute US Fed Net Liquidity = WALCL - WTREGEN - RRPONTSYD (in USD Billions).

    FRED unit normalization:
    - WALCL: Millions of USD -> / 1000.0 for Billions
    - WTREGEN: Millions of USD -> / 1000.0 for Billions
    - RRPONTSYD: Already Billions of USD
    """
    if not walcl_points or not wtregen_points or not rrpontsyd_points:
        return {
            "series": [],
            "latest_billions": None,
            "latest_date": None,
            "delta_5d_billions": None,
            "delta_20d_billions": None,
        }

    w_map = dict(sorted(walcl_points))
    t_map = dict(sorted(wtregen_points))
    r_map = dict(sorted(rrpontsyd_points))

    min_common_start = max(min(w_map), min(t_map), min(r_map))
    all_dates = sorted(
        d for d in (set(w_map) | set(t_map) | set(r_map)) if d >= min_common_start
    )

    last_w: float | None = None
    last_t: float | None = None
    last_r: float | None = None

    # Seed latest values strictly before min_common_start if needed
    for d in sorted(w_map):
        if d <= min_common_start:
            last_w = w_map[d]
    for d in sorted(t_map):
        if d <= min_common_start:
            last_t = t_map[d]
    for d in sorted(r_map):
        if d <= min_common_start:
            last_r = r_map[d]

    series: list[dict[str, object]] = []
    for obs_date in all_dates:
        if obs_date in w_map:
            last_w = w_map[obs_date]
        if obs_date in t_map:
            last_t = t_map[obs_date]
        if obs_date in r_map:
            last_r = r_map[obs_date]
        if last_w is None or last_t is None or last_r is None:
            continue

        walcl_b = last_w / 1000.0
        tga_b = last_t / 1000.0
        rrp_b = last_r
        net_liq_b = walcl_b - tga_b - rrp_b
        series.append(
            {
                "date": obs_date.isoformat(),
                "walcl_b": round(walcl_b, 2),
                "tga_b": round(tga_b, 2),
                "rrp_b": round(rrp_b, 2),
                "net_liquidity_b": round(net_liq_b, 2),
            }
        )

    if not series:
        return {
            "series": [],
            "latest_billions": None,
            "latest_date": None,
            "delta_5d_billions": None,
            "delta_20d_billions": None,
        }

    latest_val = float(series[-1]["net_liquidity_b"])
    ref_5 = float(series[max(0, len(series) - 6)]["net_liquidity_b"])
    ref_20 = float(series[max(0, len(series) - 21)]["net_liquidity_b"])

    return {
        "series": series[-90:],
        "latest_billions": round(latest_val, 2),
        "latest_date": series[-1]["date"],
        "delta_5d_billions": round(latest_val - ref_5, 2) if len(series) > 1 else 0.0,
        "delta_20d_billions": round(latest_val - ref_20, 2) if len(series) > 1 else 0.0,
    }


def compute_yield_and_credit_snapshot(
    *,
    dgs2: float | None = None,
    dgs10: float | None = None,
    dfii10: float | None = None,
    t10y2y: float | None = None,
    hy_oas: float | None = None,
    ig_oas: float | None = None,
    sofr: float | None = None,
    wresbal_millions: float | None = None,
    hyg_closes: Sequence[float] | None = None,
    lqd_closes: Sequence[float] | None = None,
) -> dict[str, object]:
    """Summarize Treasury curve, real rate, reserve adequacy, and credit spreads."""
    spread = t10y2y
    if spread is None and dgs10 is not None and dgs2 is not None:
        spread = round(dgs10 - dgs2, 4)

    hyg_lqd_ratio: float | None = None
    hyg_lqd_20d_delta_pct: float | None = None
    if hyg_closes and lqd_closes:
        n = min(len(hyg_closes), len(lqd_closes))
        if n > 0 and lqd_closes[-1] > 0:
            hyg_lqd_ratio = round(hyg_closes[-1] / lqd_closes[-1], 4)
            if n >= 21 and lqd_closes[-21] > 0:
                prev_ratio = hyg_closes[-21] / lqd_closes[-21]
                if prev_ratio > 0:
                    hyg_lqd_20d_delta_pct = round(((hyg_lqd_ratio / prev_ratio) - 1.0) * 100.0, 2)

    if hy_oas is None:
        credit_state = "Unknown"
    elif hy_oas < 3.5:
        credit_state = "Compressed (Risk-On)"
    elif hy_oas <= 4.75:
        credit_state = "Normal"
    elif hy_oas <= 6.0:
        credit_state = "Elevated Spread"
    else:
        credit_state = "Credit Stress"

    return {
        "dgs2": dgs2,
        "dgs10": dgs10,
        "dfii10": dfii10,
        "yield_spread_10y2y": round(spread, 3) if spread is not None else None,
        "hy_oas": hy_oas,
        "ig_oas": ig_oas,
        "sofr": sofr,
        "wresbal_billions": round(wresbal_millions / 1000.0, 2)
        if wresbal_millions is not None
        else None,
        "hyg_lqd_ratio": hyg_lqd_ratio,
        "hyg_lqd_20d_delta_pct": hyg_lqd_20d_delta_pct,
        "credit_state": credit_state,
    }


def compute_vix_term_structure(
    *,
    vix9d: float | None,
    vix: float | None,
    vix3m: float | None,
) -> dict[str, object]:
    """Evaluate VIX/VIX3M and VIX9D/VIX term structure (Contango vs Backwardation)."""
    ratio_3m: float | None = None
    ratio_9d: float | None = None
    state = "Unavailable"

    if vix is not None and vix3m is not None and vix3m > 0:
        ratio_3m = round(vix / vix3m, 4)
        if ratio_3m < 0.95:
            state = "Contango (Calm)"
        elif ratio_3m <= 1.02:
            state = "Flat (Transition)"
        else:
            state = "Backwardation (Stress)"
    elif vix is not None:
        state = "Spot Only (VIX3M Pending)"

    if vix9d is not None and vix is not None and vix > 0:
        ratio_9d = round(vix9d / vix, 4)

    return {
        "vix9d": round(vix9d, 2) if vix9d is not None else None,
        "vix": round(vix, 2) if vix is not None else None,
        "vix3m": round(vix3m, 2) if vix3m is not None else None,
        "vix_vix3m_ratio": ratio_3m,
        "vix9d_vix_ratio": ratio_9d,
        "structure_state": state,
    }


def compute_fear_greed_index(
    *,
    spy_dist_200ma_pct: float | None = None,
    spy_20d_return_pct: float | None = None,
    pct_above_50ma: float | None = None,
    rsp_spy_20d_delta_pct: float | None = None,
    vix_spot: float | None = None,
    vix_vix3m_ratio: float | None = None,
    hy_oas: float | None = None,
    hyg_lqd_20d_delta_pct: float | None = None,
    soxx_spy_20d_delta_pct: float | None = None,
    btc_20d_return_pct: float | None = None,
) -> dict[str, object]:
    """Deterministic multi-pillar Fear & Greed composite index (0=Extreme Fear, 100=Extreme Greed).

    Replaces brittle CNN web scraping with transparent internal market metrics.
    """
    weighted_components: list[tuple[str, float, float]] = []
    details: dict[str, float | None] = {}

    # 1. Momentum (weight 0.25)
    mom_parts: list[float] = []
    if spy_dist_200ma_pct is not None:
        mom_parts.append(_linear_scale(spy_dist_200ma_pct, -8.0, 12.0))
    if spy_20d_return_pct is not None:
        mom_parts.append(_linear_scale(spy_20d_return_pct, -6.0, 6.0))
    if mom_parts:
        val = round(sum(mom_parts) / len(mom_parts), 2)
        weighted_components.append(("momentum", val, 0.25))
        details["momentum"] = val

    # 2. Breadth (weight 0.20)
    breadth_parts: list[float] = []
    if pct_above_50ma is not None:
        breadth_parts.append(_linear_scale(pct_above_50ma, 20.0, 85.0))
    if rsp_spy_20d_delta_pct is not None:
        breadth_parts.append(_linear_scale(rsp_spy_20d_delta_pct, -4.0, 4.0))
    if breadth_parts:
        val = round(sum(breadth_parts) / len(breadth_parts), 2)
        weighted_components.append(("breadth", val, 0.20))
        details["breadth"] = val

    # 3. Volatility inverted (weight 0.25)
    vol_parts: list[float] = []
    if vix_spot is not None:
        vol_parts.append(_linear_scale(-vix_spot, -35.0, -12.0))
    if vix_vix3m_ratio is not None:
        vol_parts.append(_linear_scale(-vix_vix3m_ratio, -1.12, -0.82))
    if vol_parts:
        val = round(sum(vol_parts) / len(vol_parts), 2)
        weighted_components.append(("volatility", val, 0.25))
        details["volatility"] = val

    # 4. Credit Appetite (weight 0.15)
    credit_parts: list[float] = []
    if hy_oas is not None:
        credit_parts.append(_linear_scale(-hy_oas, -6.5, -2.5))
    if hyg_lqd_20d_delta_pct is not None:
        credit_parts.append(_linear_scale(hyg_lqd_20d_delta_pct, -2.5, 2.5))
    if credit_parts:
        val = round(sum(credit_parts) / len(credit_parts), 2)
        weighted_components.append(("credit", val, 0.15))
        details["credit"] = val

    # 5. Risk Beta Appetite (weight 0.15)
    beta_parts: list[float] = []
    if soxx_spy_20d_delta_pct is not None:
        beta_parts.append(_linear_scale(soxx_spy_20d_delta_pct, -8.0, 8.0))
    if btc_20d_return_pct is not None:
        beta_parts.append(_linear_scale(btc_20d_return_pct, -20.0, 25.0))
    if beta_parts:
        val = round(sum(beta_parts) / len(beta_parts), 2)
        weighted_components.append(("risk_appetite", val, 0.15))
        details["risk_appetite"] = val

    if not weighted_components:
        return {
            "score": None,
            "label": "Unavailable",
            "components": details,
        }

    total_weight = sum(w for _, _, w in weighted_components)
    composite = round(sum(score * w for _, score, w in weighted_components) / total_weight, 1)

    if composite < 25.0:
        label = "Extreme Fear"
    elif composite < 45.0:
        label = "Fear"
    elif composite <= 55.0:
        label = "Neutral"
    elif composite <= 75.0:
        label = "Greed"
    else:
        label = "Extreme Greed"

    return {
        "score": composite,
        "label": label,
        "components": details,
    }

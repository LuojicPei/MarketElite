from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date
from typing import Any


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


def _percentile_rank(series: Sequence[float], latest_value: float) -> float | None:
    if len(series) < 4:
        return None
    low = min(series)
    high = max(series)
    if high - low <= 1e-9:
        return 50.0
    return round(((latest_value - low) / (high - low)) * 100.0, 1)


def _decode_contract_positioning(
    key: str,
    meta: dict[str, Any],
    rm_net: float,
    rm_wow: float | None,
    lev_net: float,
    lev_wow: float | None,
    lev_pct_52w: float | None,
) -> tuple[str, str, str, str]:
    """Return (crowded_signal, badge_zh, headline_zh, detail_zh) in plain Chinese."""
    divergence = (rm_net > 0 and lev_net < 0) or (rm_net < 0 and lev_net > 0)

    if lev_pct_52w is not None and lev_pct_52w <= 15.0 and lev_net < 0:
        signal = "squeeze_risk"
        badge = "空头极端拥挤 · 逼空高危"
    elif lev_pct_52w is not None and lev_pct_52w >= 85.0 and lev_net > 0:
        signal = "crowded_long"
        badge = "杠杆多头偏挤"
    elif lev_pct_52w is not None and lev_pct_52w <= 20.0:
        signal = "defensive_skew"
        badge = "近一年偏空警戒"
    elif rm_net > 0 and lev_net > 0:
        signal = "aligned_long"
        badge = "双边共识做多"
    elif divergence:
        signal = "fighting"
        badge = "资管 vs 对冲对抗"
    else:
        signal = "balanced"
        badge = "多空相对均衡"

    if key == "VX":
        if lev_net < 0 and (lev_wow is None or lev_wow <= 0):
            headline = "对冲基金持续做空 VIX 收租，压低隐波"
        elif lev_net < 0 and lev_wow is not None and lev_wow > 5000:
            headline = "对冲基金本周回补 VIX 空单！避险升温预警"
        else:
            headline = "VIX 期货杠杆盘平仓防守，波动风险升高"
        detail = (
            "对冲基金常态通过做空 VIX 赚取时间衰减收益；一旦杠杆空单大幅回补（本周变动转大额正值），"
            "往往对应机构紧急对冲尾部黑天鹅。"
        )
        return signal, badge, headline, detail

    if key == "ZN":
        if rm_net > 0 and lev_net < 0:
            headline = "资管大手笔抢购美债锁定高息，对冲基金做空基差套利"
        else:
            headline = "美债期货长短端机构博弈利率拐点"
        detail = (
            "10Y 美债期货中，公募养老金普遍持有现货/期货多头对冲股票或锁息，"
            "对冲基金负持仓常含国债现货+期货基差套利头寸，需结合周变动观察真实抛压。"
        )
        return signal, badge, headline, detail

    rm_label = str(meta.get("real_money_label", "长线资管"))
    lev_label = str(meta.get("leveraged_label", "对冲基金"))
    if rm_net > 0 and lev_net < 0:
        headline = f"{rm_label}逢低建仓买多，{lev_label}加杠杆净空对峙"
    elif rm_net > 0 and lev_net > 0:
        headline = f"{rm_label}与{lev_label}罕见共振净做多"
    elif rm_net < 0 and lev_net < 0:
        headline = "长短线机构一致偏空收缩风险敞口"
    else:
        headline = f"{rm_label}减持偏谨慎，{lev_label}短线偏多"

    wow_parts: list[str] = []
    if rm_wow is not None:
        wow_parts.append(f"{rm_label}本周{'加多' if rm_wow >= 0 else '减仓'} {abs(rm_wow) / 1000:.1f}K 手")
    if lev_wow is not None:
        wow_parts.append(f"{lev_label}本周{'净增' if lev_wow >= 0 else '加空'} {abs(lev_wow) / 1000:.1f}K 手")
    if lev_pct_52w is not None:
        wow_parts.append(f"杠杆持仓处近52周 {lev_pct_52w:.0f}% 分位")
    detail = "；".join(wow_parts) if wow_parts else "机构与杠杆资金保持结构性换手。"
    return signal, badge, headline, detail


def build_institutional_flow_summary(
    contracts_meta: Mapping[str, Mapping[str, Any]],
    weekly_series_by_symbol: Mapping[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    """Compute multi-group institutional positioning, 52W extremes, and 26W scissors series."""
    contracts_out: dict[str, dict[str, Any]] = {}
    latest_report_date: str | None = None
    squeeze_names: list[str] = []
    aligned_long_names: list[str] = []
    fighting_names: list[str] = []

    for key, meta in contracts_meta.items():
        rows = sorted(
            weekly_series_by_symbol.get(key, []),
            key=lambda x: str(x.get("report_date", "")),
        )
        if not rows:
            continue

        latest = rows[-1]
        prev = rows[-2] if len(rows) >= 2 else None
        rep_date = str(latest.get("report_date", ""))[:10]
        if rep_date and (latest_report_date is None or rep_date > latest_report_date):
            latest_report_date = rep_date

        rm_long = float(latest.get("real_money_long", 0.0) or 0.0)
        rm_short = float(latest.get("real_money_short", 0.0) or 0.0)
        rm_net = rm_long - rm_short
        rm_prev = (
            float(prev.get("real_money_long", 0.0) or 0.0)
            - float(prev.get("real_money_short", 0.0) or 0.0)
            if prev
            else None
        )
        rm_wow = round(rm_net - rm_prev, 0) if rm_prev is not None else None

        lev_long = float(latest.get("leveraged_long", 0.0) or 0.0)
        lev_short = float(latest.get("leveraged_short", 0.0) or 0.0)
        lev_spread = float(latest.get("leveraged_spread", 0.0) or 0.0)
        lev_net = lev_long - lev_short
        lev_prev = (
            float(prev.get("leveraged_long", 0.0) or 0.0)
            - float(prev.get("leveraged_short", 0.0) or 0.0)
            if prev
            else None
        )
        lev_wow = round(lev_net - lev_prev, 0) if lev_prev is not None else None

        dl_long = float(latest.get("dealer_long", 0.0) or 0.0)
        dl_short = float(latest.get("dealer_short", 0.0) or 0.0)
        dl_net = dl_long - dl_short
        dl_prev = (
            float(prev.get("dealer_long", 0.0) or 0.0)
            - float(prev.get("dealer_short", 0.0) or 0.0)
            if prev
            else None
        )
        dl_wow = round(dl_net - dl_prev, 0) if dl_prev is not None else None

        oi = float(latest.get("open_interest", 0.0) or 0.0)
        rm_series = [
            float(r.get("real_money_long", 0.0) or 0.0) - float(r.get("real_money_short", 0.0) or 0.0)
            for r in rows[-52:]
        ]
        lev_series = [
            float(r.get("leveraged_long", 0.0) or 0.0) - float(r.get("leveraged_short", 0.0) or 0.0)
            for r in rows[-52:]
        ]

        rm_pct_52w = _percentile_rank(rm_series, rm_net)
        lev_pct_52w = _percentile_rank(lev_series, lev_net)

        signal, badge, headline_zh, detail_zh = _decode_contract_positioning(
            key, meta, rm_net, rm_wow, lev_net, lev_wow, lev_pct_52w
        )

        if signal == "squeeze_risk":
            squeeze_names.append(key)
        elif signal == "aligned_long":
            aligned_long_names.append(key)
        elif signal == "fighting":
            fighting_names.append(key)

        contracts_out[key] = {
            "symbol": key,
            "name": str(meta.get("name", key)),
            "name_zh": str(meta.get("name_zh", key)),
            "asset_bucket": str(meta.get("bucket", "宏观")),
            "report_date": rep_date,
            "open_interest": round(oi, 0),
            "divergence": (rm_net > 0 and lev_net < 0) or (rm_net < 0 and lev_net > 0),
            "crowded_signal": signal,
            "crowded_badge_zh": badge,
            "headline_zh": headline_zh,
            "detail_zh": detail_zh,
            "real_money": {
                "label": str(meta.get("real_money_label", "长线资管")),
                "long": round(rm_long, 0),
                "short": round(rm_short, 0),
                "net": round(rm_net, 0),
                "wow_change": rm_wow,
                "pct_oi": round((rm_net / oi) * 100.0, 2) if oi > 0 else None,
                "long_short_ratio": round(rm_long / rm_short, 2) if rm_short > 0 else None,
                "percentile_52w": rm_pct_52w,
            },
            "leveraged": {
                "label": str(meta.get("leveraged_label", "对冲基金")),
                "long": round(lev_long, 0),
                "short": round(lev_short, 0),
                "spread": round(lev_spread, 0),
                "net": round(lev_net, 0),
                "wow_change": lev_wow,
                "pct_oi": round((lev_net / oi) * 100.0, 2) if oi > 0 else None,
                "long_short_ratio": round(lev_long / lev_short, 2) if lev_short > 0 else None,
                "percentile_52w": lev_pct_52w,
            },
            "dealer": {
                "label": str(meta.get("dealer_label", "投行自营/做市")),
                "long": round(dl_long, 0),
                "short": round(dl_short, 0),
                "net": round(dl_net, 0),
                "wow_change": dl_wow,
            },
            "series_26w": [
                {
                    "date": str(r.get("report_date", ""))[:10],
                    "real_money_net": round(
                        float(r.get("real_money_long", 0.0) or 0.0)
                        - float(r.get("real_money_short", 0.0) or 0.0),
                        0,
                    ),
                    "leveraged_net": round(
                        float(r.get("leveraged_long", 0.0) or 0.0)
                        - float(r.get("leveraged_short", 0.0) or 0.0),
                        0,
                    ),
                    "dealer_net": round(
                        float(r.get("dealer_long", 0.0) or 0.0)
                        - float(r.get("dealer_short", 0.0) or 0.0),
                        0,
                    ),
                }
                for r in rows[-26:]
            ],
        }

    if squeeze_names:
        summary_zh = f"聪明钱分歧剧烈：{', '.join(squeeze_names)} 对冲基金空单极度拥挤，谨防逼空急拉"
    elif fighting_names:
        summary_zh = f"机构博弈分化：{', '.join(fighting_names)} 出现长线资管拿货、对冲基金加杠杆做空对峙"
    elif aligned_long_names:
        summary_zh = f"顺风共识：{', '.join(aligned_long_names)} 获资管与杠杆资金双边净增"
    else:
        summary_zh = "华尔街长短线资金持仓整体处于历史中性区间"

    return {
        "report_date": latest_report_date,
        "summary_zh": summary_zh,
        "contracts": contracts_out,
    }

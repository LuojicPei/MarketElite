from __future__ import annotations

import itertools
import math
from dataclasses import asdict, dataclass
from typing import Any


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def bs_gamma(
    spot: float,
    strike: float,
    time_to_expiry_years: float,
    iv: float,
    risk_free_rate: float = 0.045,
) -> float:
    """Compute Black-Scholes option gamma (shared for European calls and puts)."""
    if spot <= 0.0 or strike <= 0.0 or time_to_expiry_years <= 0.0 or iv <= 0.0:
        return 0.0
    sqrt_t = math.sqrt(time_to_expiry_years)
    denom = iv * sqrt_t
    if denom <= 0.0:
        return 0.0
    d1 = (math.log(spot / strike) + (risk_free_rate + 0.5 * iv * iv) * time_to_expiry_years) / denom
    return _norm_pdf(d1) / (spot * denom)


@dataclass(frozen=True)
class OptionContractInput:
    """Normalized option contract data joining Alpaca indicative Greeks with OCC OI."""

    contract_symbol: str
    option_type: str  # "call" or "put"
    strike: float
    open_interest: int
    gamma: float | None = None
    iv: float | None = None
    time_to_expiry_years: float | None = None
    volume: int | None = None
    expiration_date: str | None = None
    dte: int | None = None
    delta: float | None = None
    theta: float | None = None
    vega: float | None = None
    last_price: float | None = None


@dataclass(frozen=True)
class StrikeGexProfile:
    """Aggregated call, put, and net Estimated GEX at a single strike."""

    strike: float
    call_gex: float
    put_gex: float
    net_gex: float
    call_oi: int
    put_oi: int


@dataclass(frozen=True)
class EstimatedGexResult:
    """Deterministic dealer gamma exposure estimate with explicit assumption guardrails."""

    symbol: str
    spot_price: float
    net_gex: float
    call_wall: float | None
    put_wall: float | None
    zero_gamma: float | None
    put_call_ratio: float | None
    total_call_oi: int
    total_put_oi: int
    contracts_analyzed: int
    assumption_label: str
    strike_profile: list[dict[str, float | int]]


def _contract_gamma(contract: OptionContractInput, spot: float) -> float:
    if contract.gamma is not None and contract.gamma > 0.0:
        return float(contract.gamma)
    if contract.iv is not None and contract.time_to_expiry_years is not None:
        return bs_gamma(spot, contract.strike, contract.time_to_expiry_years, contract.iv)
    return 0.0


def _reprice_net_gex(contracts: list[OptionContractInput], candidate_spot: float) -> float:
    total = 0.0
    for c in contracts:
        if c.open_interest <= 0 or c.iv is None or c.time_to_expiry_years is None:
            continue
        gamma = bs_gamma(candidate_spot, c.strike, c.time_to_expiry_years, c.iv)
        sign = 1.0 if c.option_type.lower() == "call" else -1.0
        total += sign * (candidate_spot**2) * c.open_interest * 100.0 * gamma * 0.01
    return total


def _estimate_zero_gamma(
    contracts: list[OptionContractInput],
    strike_rows: list[StrikeGexProfile],
    spot_price: float,
) -> float | None:
    """Estimate Zero Gamma (Gamma Flip) via B-S repricing grid or strike profile crossing."""
    bs_ready = any(
        c.open_interest > 0 and c.iv is not None and c.iv > 0 and c.time_to_expiry_years is not None
        for c in contracts
    )
    if bs_ready and spot_price > 0:
        low = spot_price * 0.85
        high = spot_price * 1.15
        steps = 60
        step_size = (high - low) / steps
        prev_s = low
        prev_val = _reprice_net_gex(contracts, prev_s)
        best_cross: float | None = None
        best_dist = float("inf")
        for idx in range(1, steps + 1):
            curr_s = low + idx * step_size
            curr_val = _reprice_net_gex(contracts, curr_s)
            if (prev_val <= 0.0 <= curr_val) or (prev_val >= 0.0 >= curr_val):
                denom = curr_val - prev_val
                ratio = abs(prev_val / denom) if abs(denom) > 1e-12 else 0.5
                cross = prev_s + ratio * (curr_s - prev_s)
                dist = abs(cross - spot_price)
                if dist < best_dist:
                    best_dist = dist
                    best_cross = round(cross, 2)
            prev_s, prev_val = curr_s, curr_val
        if best_cross is not None:
            return best_cross

    if len(strike_rows) < 2:
        return None
    best_cross = None
    best_dist = float("inf")
    for prev_row, curr_row in itertools.pairwise(strike_rows):
        v1, v2 = prev_row.net_gex, curr_row.net_gex
        if (v1 < 0.0 < v2) or (v1 > 0.0 > v2):
            ratio = abs(v1) / (abs(v1) + abs(v2))
            cross = prev_row.strike + ratio * (curr_row.strike - prev_row.strike)
            dist = abs(cross - spot_price)
            if dist < best_dist:
                best_dist = dist
                best_cross = round(cross, 2)
    return best_cross


def compute_estimated_gex(
    symbol: str,
    spot_price: float,
    contracts: list[OptionContractInput],
    *,
    max_profile_strikes: int = 36,
) -> EstimatedGexResult:
    """Compute Estimated GEX (Spot^2 * OI * 100 * Gamma) under standard dealer sign convention.

    Convention: Dealers assumed net long calls (+1) and net short puts (-1),
    normalized to dollar gamma exposure per 1% spot move (`* 0.01`).
    """
    assumption = "Estimated GEX ($ / 1% Move · Dealer Positioning · OCC T+1/T+2 OI)"
    if spot_price <= 0.0 or not contracts:
        return EstimatedGexResult(
            symbol=symbol.upper(),
            spot_price=spot_price,
            net_gex=0.0,
            call_wall=None,
            put_wall=None,
            zero_gamma=None,
            put_call_ratio=None,
            total_call_oi=0,
            total_put_oi=0,
            contracts_analyzed=0,
            assumption_label=assumption,
            strike_profile=[],
        )

    by_strike: dict[float, dict[str, float | int]] = {}
    total_call_oi = 0
    total_put_oi = 0
    analyzed = 0

    for c in contracts:
        if c.open_interest <= 0 or c.strike <= 0:
            continue
        gamma = _contract_gamma(c, spot_price)
        if gamma <= 0.0:
            continue

        analyzed += 1
        # Dollar Gamma per 1% spot move: Spot^2 * OI * 100 * Gamma * 0.01
        raw_gex = (spot_price**2) * float(c.open_interest) * 100.0 * gamma * 0.01
        bucket = by_strike.setdefault(
            round(float(c.strike), 4),
            {"call_gex": 0.0, "put_gex": 0.0, "call_oi": 0, "put_oi": 0},
        )
        opt_type = c.option_type.lower()
        if opt_type == "call":
            bucket["call_gex"] = float(bucket["call_gex"]) + raw_gex
            bucket["call_oi"] = int(bucket["call_oi"]) + int(c.open_interest)
            total_call_oi += int(c.open_interest)
        elif opt_type == "put":
            bucket["put_gex"] = float(bucket["put_gex"]) - raw_gex
            bucket["put_oi"] = int(bucket["put_oi"]) + int(c.open_interest)
            total_put_oi += int(c.open_interest)

    strike_rows = [
        StrikeGexProfile(
            strike=strike,
            call_gex=round(float(vals["call_gex"]), 2),
            put_gex=round(float(vals["put_gex"]), 2),
            net_gex=round(float(vals["call_gex"]) + float(vals["put_gex"]), 2),
            call_oi=int(vals["call_oi"]),
            put_oi=int(vals["put_oi"]),
        )
        for strike, vals in sorted(by_strike.items())
    ]

    net_gex = round(sum(row.net_gex for row in strike_rows), 2)
    call_rows = [r for r in strike_rows if r.call_gex > 0]
    put_rows = [r for r in strike_rows if r.put_gex < 0]
    call_wall = max(call_rows, key=lambda r: r.call_gex).strike if call_rows else None
    put_wall = min(put_rows, key=lambda r: r.put_gex).strike if put_rows else None
    zero_gamma = _estimate_zero_gamma(contracts, strike_rows, spot_price)
    put_call_ratio = round(total_put_oi / total_call_oi, 4) if total_call_oi > 0 else None

    # Keep strikes clustered near spot for compact UI bar-chart payloads
    sorted_by_proximity = sorted(strike_rows, key=lambda r: abs(r.strike - spot_price))
    top_profile = sorted(sorted_by_proximity[:max_profile_strikes], key=lambda r: r.strike)

    return EstimatedGexResult(
        symbol=symbol.upper(),
        spot_price=round(spot_price, 4),
        net_gex=net_gex,
        call_wall=call_wall,
        put_wall=put_wall,
        zero_gamma=zero_gamma,
        put_call_ratio=put_call_ratio,
        total_call_oi=total_call_oi,
        total_put_oi=total_put_oi,
        contracts_analyzed=analyzed,
        assumption_label=assumption,
        strike_profile=[asdict(r) for r in top_profile],
    )


def _contract_dte(c: OptionContractInput) -> int:
    if c.dte is not None:
        return max(0, int(c.dte))
    if c.time_to_expiry_years is not None:
        return max(0, round(c.time_to_expiry_years * 365.0))
    return 14


def _select_bucket_contracts(
    contracts: list[OptionContractInput],
    bucket: str,
) -> tuple[list[OptionContractInput], dict[str, int]]:
    norm = bucket.lower().strip()
    c_0dte = [c for c in contracts if _contract_dte(c) <= 2]
    c_weekly = [c for c in contracts if _contract_dte(c) <= 8]
    c_monthly = [c for c in contracts if _contract_dte(c) > 8]
    counts = {
        "all": len(contracts),
        "0dte": len(c_0dte),
        "weekly": len(c_weekly),
        "monthly": len(c_monthly),
    }
    if norm == "0dte":
        return c_0dte or c_weekly, counts
    if norm == "weekly":
        return c_weekly or contracts, counts
    if norm == "monthly":
        return c_monthly or contracts, counts
    return contracts, counts


def _compute_max_pain(
    contracts: list[OptionContractInput],
    spot_price: float,
) -> float | None:
    """Find candidate settlement strike minimizing total Call + Put intrinsic payout."""
    priced_strikes = sorted(
        {
            round(float(c.strike), 2)
            for c in contracts
            if c.open_interest > 0 and c.strike > 0 and (spot_price <= 0 or abs(c.strike - spot_price) <= spot_price * 0.25)
        }
    )
    if not priced_strikes:
        return None
    best_strike: float | None = None
    best_payout = float("inf")
    for target in priced_strikes:
        payout = 0.0
        for c in contracts:
            if c.open_interest <= 0 or c.strike <= 0:
                continue
            if c.option_type.lower() == "call" and target > c.strike:
                payout += (target - c.strike) * c.open_interest * 100.0
            elif c.option_type.lower() == "put" and target < c.strike:
                payout += (c.strike - target) * c.open_interest * 100.0
        if payout < best_payout:
            best_payout = payout
            best_strike = target
    return best_strike


def compute_options_radar(
    symbol: str,
    spot_price: float,
    contracts: list[OptionContractInput],
    *,
    bucket: str = "all",
    max_profile_strikes: int = 34,
) -> dict[str, Any]:
    """Compute panoramic options dealer positioning, Max Pain, Expected Move, Skew & Unusual Flow."""
    sym = symbol.upper().strip()
    filtered, bucket_counts = _select_bucket_contracts(contracts, bucket)
    gex_res = compute_estimated_gex(
        sym,
        spot_price,
        filtered,
        max_profile_strikes=max_profile_strikes,
    )

    # Anchor nearest active expiry in the selected bucket for Max Pain & Expected Move
    expiries = sorted(
        {( _contract_dte(c), c.expiration_date ) for c in filtered if c.expiration_date}
    )
    anchor_dte = expiries[0][0] if expiries else (min((_contract_dte(c) for c in filtered), default=5) or 5)
    anchor_expiry = expiries[0][1] if expiries else None
    anchor_contracts = (
        [c for c in filtered if c.expiration_date == anchor_expiry]
        if anchor_expiry
        else filtered
    )

    max_pain = _compute_max_pain(anchor_contracts or filtered, spot_price)

    # ATM IV & Expected Move
    atm_ivs = [
        float(c.iv)
        for c in (anchor_contracts or filtered)
        if c.iv is not None and 0.02 < float(c.iv) < 3.5 and spot_price > 0 and abs(c.strike - spot_price) / spot_price <= 0.025
    ]
    if not atm_ivs:
        atm_ivs = [
            float(c.iv)
            for c in filtered
            if c.iv is not None and 0.02 < float(c.iv) < 3.5 and spot_price > 0 and abs(c.strike - spot_price) / spot_price <= 0.05
        ]
    atm_iv = (sum(atm_ivs) / len(atm_ivs)) if atm_ivs else None
    atm_iv_pct = round(atm_iv * 100.0, 2) if atm_iv is not None else None

    eff_dte = max(1, anchor_dte)
    if atm_iv is not None and spot_price > 0:
        expected_move_abs = round(spot_price * atm_iv * math.sqrt(eff_dte / 365.0), 2)
        expected_move_pct = round((expected_move_abs / spot_price) * 100.0, 2)
        expected_low = round(spot_price - expected_move_abs, 2)
        expected_high = round(spot_price + expected_move_abs, 2)
    else:
        expected_move_abs = None
        expected_move_pct = None
        expected_low = None
        expected_high = None

    # 25-Delta IV Skew (OTM Put IV minus OTM Call IV in percentage points)
    put_25d_ivs = [
        float(c.iv) * 100.0
        for c in filtered
        if c.option_type.lower() == "put"
        and c.iv is not None
        and 0.02 < float(c.iv) < 3.5
        and (
            (c.delta is not None and -0.38 <= float(c.delta) <= -0.15)
            or (c.delta is None and spot_price > 0 and 0.90 * spot_price <= c.strike <= 0.97 * spot_price)
        )
    ]
    call_25d_ivs = [
        float(c.iv) * 100.0
        for c in filtered
        if c.option_type.lower() == "call"
        and c.iv is not None
        and 0.02 < float(c.iv) < 3.5
        and (
            (c.delta is not None and 0.15 <= float(c.delta) <= 0.38)
            or (c.delta is None and spot_price > 0 and 1.03 * spot_price <= c.strike <= 1.10 * spot_price)
        )
    ]
    iv_skew_25d = (
        round((sum(put_25d_ivs) / len(put_25d_ivs)) - (sum(call_25d_ivs) / len(call_25d_ivs)), 2)
        if put_25d_ivs and call_25d_ivs
        else None
    )

    # Aggregate Strike OI + Volume + IV Smile onto gex_res.strike_profile
    total_call_vol = 0
    total_put_vol = 0
    strike_agg: dict[float, dict[str, Any]] = {}
    for c in filtered:
        s_key = round(float(c.strike), 4)
        vol = int(c.volume or 0)
        slot = strike_agg.setdefault(
            s_key,
            {"call_vol": 0, "put_vol": 0, "call_ivs": [], "put_ivs": []},
        )
        if c.option_type.lower() == "call":
            total_call_vol += vol
            slot["call_vol"] += vol
            if c.iv is not None and 0.02 < float(c.iv) < 3.5:
                slot["call_ivs"].append(float(c.iv) * 100.0)
        elif c.option_type.lower() == "put":
            total_put_vol += vol
            slot["put_vol"] += vol
            if c.iv is not None and 0.02 < float(c.iv) < 3.5:
                slot["put_ivs"].append(float(c.iv) * 100.0)

    enriched_profile: list[dict[str, Any]] = []
    for row in gex_res.strike_profile:
        s_key = round(float(row["strike"]), 4)
        extra = strike_agg.get(s_key, {})
        c_ivs = extra.get("call_ivs") or []
        p_ivs = extra.get("put_ivs") or []
        enriched_profile.append(
            {
                **row,
                "call_vol": int(extra.get("call_vol", 0)),
                "put_vol": int(extra.get("put_vol", 0)),
                "call_iv": round(sum(c_ivs) / len(c_ivs), 2) if c_ivs else None,
                "put_iv": round(sum(p_ivs) / len(p_ivs), 2) if p_ivs else None,
            }
        )

    put_call_vol_ratio = round(total_put_vol / total_call_vol, 4) if total_call_vol > 0 else None

    # Unusual Options Flow Radar (Vol > OI & Notional Premium)
    flow_candidates: list[dict[str, Any]] = []
    for c in filtered:
        vol = int(c.volume or 0)
        if vol < 10:
            continue
        oi = max(int(c.open_interest or 0), 1)
        vol_oi = round(vol / oi, 2)
        price = float(c.last_price) if c.last_price is not None and c.last_price > 0 else 0.0
        est_prem = round(vol * price * 100.0, 0) if price > 0 else None
        # Prioritize fresh sweeps (Vol > OI) with meaningful notional size
        score = min(vol_oi, 20.0) * math.log1p(vol) * (1.5 if vol > oi else 0.6)
        flow_candidates.append(
            {
                "contract_symbol": c.contract_symbol,
                "option_type": c.option_type.lower(),
                "strike": round(float(c.strike), 2),
                "expiration_date": c.expiration_date,
                "dte": _contract_dte(c),
                "volume": vol,
                "open_interest": int(c.open_interest or 0),
                "vol_oi_ratio": vol_oi,
                "iv_pct": round(float(c.iv) * 100.0, 1) if c.iv is not None else None,
                "delta": round(float(c.delta), 2) if c.delta is not None else None,
                "last_price": round(price, 2) if price > 0 else None,
                "est_premium_usd": est_prem,
                "_score": score,
            }
        )
    flow_candidates.sort(key=lambda item: float(item["_score"]), reverse=True)
    unusual_flow = [
        {k: v for k, v in item.items() if k != "_score"}
        for item in flow_candidates[:8]
    ]

    if gex_res.net_gex >= 0:
        dealer_regime = "positive_pinning"
        dealer_regime_zh = "正 Gamma 护盘模式：做市商逢跌买入、逢涨卖出，盘面易缩波钉盘"
    else:
        dealer_regime = "negative_amplifying"
        dealer_regime_zh = "负 Gamma 放大模式：做市商被迫追涨杀跌，突破后极易加速单边"

    summary_parts: list[str] = []
    if max_pain is not None:
        summary_parts.append(f"近期最大痛点 ${max_pain:.0f}")
    if gex_res.call_wall is not None and gex_res.put_wall is not None:
        summary_parts.append(f"核心箱体 Put墙 ${gex_res.put_wall:.0f} ~ Call墙 ${gex_res.call_wall:.0f}")
    if expected_low is not None and expected_high is not None and expected_move_pct is not None:
        summary_parts.append(f"{eff_dte}日隐含波动区间 ${expected_low:.1f}–${expected_high:.1f} (±{expected_move_pct:.1f}%)")
    if iv_skew_25d is not None and iv_skew_25d >= 4.0:
        summary_parts.append(f"看跌保护偏贵(Skew +{iv_skew_25d:.1f}%)")
    battle_summary_zh = "；".join(summary_parts) if summary_parts else dealer_regime_zh

    return {
        "symbol": sym,
        "bucket": bucket.lower().strip(),
        "bucket_counts": bucket_counts,
        "spot_price": gex_res.spot_price,
        "anchor_expiry": anchor_expiry,
        "anchor_dte": eff_dte,
        "net_gex": gex_res.net_gex,
        "call_wall": gex_res.call_wall,
        "put_wall": gex_res.put_wall,
        "zero_gamma": gex_res.zero_gamma,
        "max_pain": max_pain,
        "atm_iv_pct": atm_iv_pct,
        "expected_move_abs": expected_move_abs,
        "expected_move_pct": expected_move_pct,
        "expected_low": expected_low,
        "expected_high": expected_high,
        "iv_skew_25d": iv_skew_25d,
        "put_call_ratio": gex_res.put_call_ratio,
        "put_call_vol_ratio": put_call_vol_ratio,
        "total_call_oi": gex_res.total_call_oi,
        "total_put_oi": gex_res.total_put_oi,
        "total_call_vol": total_call_vol,
        "total_put_vol": total_put_vol,
        "contracts_analyzed": gex_res.contracts_analyzed,
        "dealer_regime": dealer_regime,
        "dealer_regime_zh": dealer_regime_zh,
        "battle_summary_zh": battle_summary_zh,
        "strike_profile": enriched_profile,
        "unusual_flow": unusual_flow,
    }

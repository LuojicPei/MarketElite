from __future__ import annotations

import itertools
import math
from dataclasses import asdict, dataclass


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
        total += sign * (candidate_spot**2) * c.open_interest * 100.0 * gamma
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

    Convention: Dealers assumed net long calls (+1) and net short puts (-1).
    """
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
            assumption_label="Estimated GEX (Dealer Positioning Assumption · OCC T+1/T+2 OI)",
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
        raw_gex = (spot_price**2) * float(c.open_interest) * 100.0 * gamma
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
        assumption_label="Estimated GEX (Dealer Positioning Assumption · OCC T+1/T+2 OI)",
        strike_profile=[asdict(r) for r in top_profile],
    )

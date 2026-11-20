from __future__ import annotations

import math
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class RiskSizingRequest:
    """Inputs for deterministic 1%-risk position sizing and Alpaca bracket validation."""

    symbol: str
    side: str
    account_equity: float
    buying_power: float
    spot_price: float
    proposed_qty: float
    entry_price: float | None = None
    stop_loss_price: float | None = None
    take_profit_price: float | None = None
    atr_14: float | None = None
    call_wall: float | None = None
    put_wall: float | None = None
    risk_budget_pct: float = 1.0
    max_position_pct: float = 25.0


@dataclass(frozen=True)
class RiskSizingResult:
    """Deterministic position sizing and bracket-invariant output (0 LLM arithmetic)."""

    symbol: str
    side: str
    account_equity: float
    buying_power: float
    risk_budget_pct: float
    max_risk_dollars: float
    entry_price: float
    stop_loss_price: float
    take_profit_price: float
    stop_distance: float
    proposed_qty: int
    max_safe_qty: int
    recommended_qty: int
    was_capped_by_risk: bool
    was_capped_by_buying_power: bool
    estimated_notional: float
    estimated_risk_dollars: float
    risk_reward_ratio: float
    bracket_valid: bool
    warnings: list[str]

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _default_stop_loss(
    *,
    side: str,
    entry: float,
    atr_14: float | None,
    call_wall: float | None,
    put_wall: float | None,
) -> float:
    base_step = max(entry * 0.02, (atr_14 or entry * 0.015) * 1.5, 0.25)
    if side == "buy":
        candidate = entry - base_step
        if put_wall is not None and entry * 0.85 <= put_wall < entry * 0.99:
            wall_stop = put_wall * 0.995
            if entry - wall_stop <= base_step * 1.8:
                candidate = min(candidate, wall_stop)
        return round(max(0.01, candidate), 2)

    candidate = entry + base_step
    if call_wall is not None and entry * 1.01 < call_wall <= entry * 1.15:
        wall_stop = call_wall * 1.005
        if wall_stop - entry <= base_step * 1.8:
            candidate = max(candidate, wall_stop)
    return round(candidate, 2)


def _default_take_profit(
    *,
    side: str,
    entry: float,
    stop_loss: float,
    call_wall: float | None,
    put_wall: float | None,
) -> float:
    stop_dist = max(0.05, abs(entry - stop_loss))
    if side == "buy":
        target = entry + 2.0 * stop_dist
        if call_wall is not None and call_wall >= entry + 1.8 * stop_dist:
            target = min(target, call_wall)
        return round(max(entry + 0.02, target), 2)

    target = entry - 2.0 * stop_dist
    if put_wall is not None and 0.01 < put_wall <= entry - 1.8 * stop_dist:
        target = max(target, put_wall)
    return round(max(0.01, target), 2)


def validate_bracket_prices(
    *,
    side: str,
    entry_price: float,
    stop_loss_price: float,
    take_profit_price: float,
) -> tuple[bool, str | None]:
    """Validate Alpaca equity bracket ordering constraints with minimum $0.01 separation."""
    norm_side = side.lower().strip()
    if entry_price <= 0 or stop_loss_price <= 0 or take_profit_price <= 0:
        return False, "Entry, stop-loss, and take-profit prices must all be positive."
    if norm_side == "buy":
        if stop_loss_price > entry_price - 0.01:
            return False, "BUY bracket requires stop_loss_price <= entry_price - 0.01."
        if take_profit_price < entry_price + 0.01:
            return False, "BUY bracket requires take_profit_price >= entry_price + 0.01."
        return True, None
    if norm_side == "sell":
        if stop_loss_price < entry_price + 0.01:
            return False, "SELL bracket requires stop_loss_price >= entry_price + 0.01."
        if take_profit_price > entry_price - 0.01:
            return False, "SELL bracket requires take_profit_price <= entry_price - 0.01."
        return True, None
    return False, f"Unsupported order side: {side}"


def compute_risk_sizing(req: RiskSizingRequest) -> RiskSizingResult:
    """Compute strict 1%-equity-at-risk integer shares and bracket invariants deterministically."""
    sym = req.symbol.upper().strip()
    side = req.side.lower().strip()
    if side not in ("buy", "sell"):
        raise ValueError("Order side must be 'buy' or 'sell'.")
    if req.account_equity <= 0:
        raise ValueError("Account equity must be positive.")

    entry = round(float(req.entry_price or req.spot_price), 2)
    if entry <= 0:
        raise ValueError("Entry or spot price must be positive.")

    stop_loss = (
        round(float(req.stop_loss_price), 2)
        if req.stop_loss_price is not None and req.stop_loss_price > 0
        else _default_stop_loss(
            side=side,
            entry=entry,
            atr_14=req.atr_14,
            call_wall=req.call_wall,
            put_wall=req.put_wall,
        )
    )
    take_profit = (
        round(float(req.take_profit_price), 2)
        if req.take_profit_price is not None and req.take_profit_price > 0
        else _default_take_profit(
            side=side,
            entry=entry,
            stop_loss=stop_loss,
            call_wall=req.call_wall,
            put_wall=req.put_wall,
        )
    )

    warnings: list[str] = []
    bracket_ok, bracket_err = validate_bracket_prices(
        side=side,
        entry_price=entry,
        stop_loss_price=stop_loss,
        take_profit_price=take_profit,
    )
    if not bracket_ok and bracket_err:
        warnings.append(bracket_err)

    raw_stop_dist = abs(entry - stop_loss)
    min_sizing_stop = max(0.05, (req.atr_14 or entry * 0.01) * 0.5)
    effective_stop_dist = max(raw_stop_dist, min_sizing_stop)
    if raw_stop_dist < min_sizing_stop:
        warnings.append(
            f"Stop distance (${raw_stop_dist:.2f}) is tighter than 0.5*ATR floor; "
            f"sizing conservatively with ${effective_stop_dist:.2f} denominator."
        )

    budget_pct = max(0.1, min(2.0, float(req.risk_budget_pct)))
    max_risk_dollars = round(req.account_equity * (budget_pct / 100.0), 2)
    qty_by_risk = math.floor(max_risk_dollars / effective_stop_dist)

    max_pos_notional = min(
        max(0.0, req.buying_power) * 0.95,
        req.account_equity * (max(1.0, min(100.0, req.max_position_pct)) / 100.0),
    )
    qty_by_power = math.floor(max_pos_notional / entry)
    max_safe_qty = max(0, min(qty_by_risk, qty_by_power))

    proposed_int = max(1, math.floor(req.proposed_qty))
    recommended_qty = min(proposed_int, max_safe_qty)

    capped_risk = proposed_int > qty_by_risk
    capped_bp = proposed_int > qty_by_power and qty_by_power < qty_by_risk

    if capped_risk:
        warnings.append(
            f"Proposed {proposed_int} shares breaches {budget_pct:.1f}% risk cap "
            f"(${max_risk_dollars:,.2f}); capped to <= {qty_by_risk} shares."
        )
    if capped_bp:
        warnings.append(
            f"Position exceeds {req.max_position_pct:.0f}% single-name / buying-power cap "
            f"(${max_pos_notional:,.2f}); capped to <= {qty_by_power} shares."
        )
    if max_safe_qty < 1:
        warnings.append(
            "Max safe integer quantity is < 1 share given stop distance and 1% risk budget."
        )

    reward_dist = abs(take_profit - entry)
    rr_ratio = round(reward_dist / raw_stop_dist, 2) if raw_stop_dist > 0 else 0.0
    if bracket_ok and rr_ratio < 1.5:
        warnings.append(f"Sub-optimal Reward/Risk ratio ({rr_ratio:.2f}x < 1.50x minimum).")

    return RiskSizingResult(
        symbol=sym,
        side=side,
        account_equity=round(req.account_equity, 2),
        buying_power=round(req.buying_power, 2),
        risk_budget_pct=budget_pct,
        max_risk_dollars=max_risk_dollars,
        entry_price=entry,
        stop_loss_price=stop_loss,
        take_profit_price=take_profit,
        stop_distance=round(raw_stop_dist, 4),
        proposed_qty=proposed_int,
        max_safe_qty=max_safe_qty,
        recommended_qty=recommended_qty,
        was_capped_by_risk=capped_risk,
        was_capped_by_buying_power=capped_bp,
        estimated_notional=round(recommended_qty * entry, 2),
        estimated_risk_dollars=round(recommended_qty * raw_stop_dist, 2),
        risk_reward_ratio=rr_ratio,
        bracket_valid=bracket_ok and recommended_qty >= 1,
        warnings=warnings,
    )

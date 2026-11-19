from __future__ import annotations

from datetime import date, timedelta

from app.quant.macro import (
    compute_fear_greed_index,
    compute_net_liquidity_series,
    compute_vix_term_structure,
    compute_yield_and_credit_snapshot,
)
from app.quant.options import OptionContractInput, bs_gamma, compute_estimated_gex
from app.quant.technicals import (
    DailyBarInput,
    analyze_asset_technicals,
    classify_market_regime,
    classify_volume_price_quadrant,
    compute_atr,
    compute_cross_asset_correlations,
    compute_ema,
    compute_macd,
    compute_market_breadth,
    compute_rsi,
    compute_rvol,
    compute_sector_rotation,
    compute_sma,
)


def _make_bars(
    closes: list[float],
    *,
    volume: float = 1_000_000.0,
    start_date: date = date(2026, 1, 1),
) -> list[DailyBarInput]:
    bars: list[DailyBarInput] = []
    for idx, c in enumerate(closes):
        d = (start_date + timedelta(days=idx)).isoformat()
        bars.append(
            DailyBarInput(
                trade_date=d,
                open=c * 0.995,
                high=c * 1.01,
                low=c * 0.99,
                close=c,
                volume=volume,
            )
        )
    return bars


def test_net_liquidity_unit_normalization_and_forward_fill() -> None:
    # WALCL & WTREGEN in Millions; RRPONTSYD in Billions
    walcl = [
        (date(2026, 10, 7), 7_000_000.0),
        (date(2026, 10, 14), 7_050_000.0),
    ]
    wtregen = [
        (date(2026, 10, 7), 800_000.0),
        (date(2026, 10, 14), 750_000.0),
    ]
    rrp = [
        (date(2026, 10, 7), 200.0),
        (date(2026, 10, 8), 180.0),  # Forward-fills WALCL/WTREGEN from 10-07
        (date(2026, 10, 14), 150.0),
    ]

    res = compute_net_liquidity_series(walcl, wtregen, rrp)
    series = res["series"]
    assert len(series) == 3
    # (7000 - 800) - 200 = 6000.0B
    assert series[0]["net_liquidity_b"] == 6000.0
    # Forward-filled on Oct 8: (7000 - 800) - 180 = 6020.0B
    assert series[1]["net_liquidity_b"] == 6020.0
    # Oct 14: (7050 - 750) - 150 = 6150.0B
    assert res["latest_billions"] == 6150.0
    assert res["delta_20d_billions"] == 150.0


def test_yield_credit_and_vix_term_structure() -> None:
    yc = compute_yield_and_credit_snapshot(
        dgs2=4.1,
        dgs10=4.35,
        dfii10=2.05,
        hy_oas=3.1,
        ig_oas=0.9,
        hyg_closes=[76.0] * 20 + [79.8],
        lqd_closes=[108.0] * 21,
    )
    assert yc["yield_spread_10y2y"] == 0.25
    assert yc["credit_state"] == "Compressed (Risk-On)"
    assert float(yc["hyg_lqd_20d_delta_pct"]) > 0.0

    calm = compute_vix_term_structure(vix9d=13.5, vix=14.2, vix3m=16.5)
    assert calm["structure_state"] == "Contango (Calm)"
    assert float(calm["vix_vix3m_ratio"]) < 0.95

    stress = compute_vix_term_structure(vix9d=29.0, vix=26.5, vix3m=22.0)
    assert stress["structure_state"] == "Backwardation (Stress)"
    assert float(stress["vix_vix3m_ratio"]) > 1.02


def test_bs_gamma_and_estimated_gex_walls_and_zero_gamma() -> None:
    g_atm = bs_gamma(580.0, 580.0, 30 / 365, 0.16)
    g_otm = bs_gamma(580.0, 620.0, 30 / 365, 0.16)
    assert g_atm > g_otm > 0.0

    contracts = [
        OptionContractInput("SPY_P550", "put", 550.0, 12000, iv=0.22, time_to_expiry_years=30 / 365),
        OptionContractInput("SPY_P560", "put", 560.0, 45000, iv=0.20, time_to_expiry_years=30 / 365),
        OptionContractInput("SPY_C580", "call", 580.0, 18000, iv=0.16, time_to_expiry_years=30 / 365),
        OptionContractInput("SPY_P580", "put", 580.0, 14000, iv=0.17, time_to_expiry_years=30 / 365),
        OptionContractInput("SPY_C600", "call", 600.0, 52000, iv=0.14, time_to_expiry_years=30 / 365),
    ]
    gex = compute_estimated_gex("SPY", 580.0, contracts)
    assert "Estimated GEX" in gex.assumption_label
    assert gex.call_wall == 600.0
    assert gex.put_wall == 560.0
    assert gex.zero_gamma is not None
    assert 555.0 <= gex.zero_gamma <= 600.0
    assert gex.total_call_oi == 70000
    assert gex.total_put_oi == 71000
    assert gex.put_call_ratio is not None and gex.put_call_ratio > 1.0


def test_technicals_rvol_quadrants_breadth_sectors_and_correlations() -> None:
    uptrend_closes = [100.0 + i * 0.6 for i in range(210)]
    bars_up = _make_bars(uptrend_closes, volume=1_000_000.0)
    # Give latest bar a high-volume surge
    bars_up[-1] = DailyBarInput(
        trade_date=bars_up[-1].trade_date,
        open=bars_up[-1].open,
        high=bars_up[-1].high * 1.01,
        low=bars_up[-1].low,
        close=bars_up[-1].close * 1.015,
        volume=1_800_000.0,
    )

    assert compute_sma([1.0, 2.0, 3.0, 4.0], 4) == 2.5
    assert compute_ema([10.0, 11.0, 12.0, 13.0, 14.0], 3) is not None
    rsi_up = compute_rsi(uptrend_closes, 14)
    assert rsi_up is not None and rsi_up > 75.0
    macd_up = compute_macd(uptrend_closes)
    assert macd_up is not None and macd_up["macd"] > 0.0
    atr_up = compute_atr(
        [b.high for b in bars_up],
        [b.low for b in bars_up],
        [b.close for b in bars_up],
    )
    assert atr_up is not None and atr_up > 0.0
    rvol_val = compute_rvol([b.volume for b in bars_up], 20)
    assert rvol_val == 1.8

    assert "Accumulation" in classify_volume_price_quadrant(1.2, 1.5)
    assert "Drift" in classify_volume_price_quadrant(0.5, 0.8)
    assert "Distribution" in classify_volume_price_quadrant(-1.5, 1.6)
    assert "Pullback" in classify_volume_price_quadrant(-0.4, 0.9)

    summary = analyze_asset_technicals(bars_up)
    assert summary["available"] is True
    assert float(summary["dist_200ma_pct"]) > 0.0

    # Cross-asset correlations: identical up-move asset vs inverse asset
    spy_closes = [100.0 * (1.005**i) * (0.99 if i % 2 else 1.01) for i in range(70)]
    inv_closes = [100.0 * (0.995**i) * (1.01 if i % 2 else 0.99) for i in range(70)]
    corr_res = compute_cross_asset_correlations(
        {
            "SPY": _make_bars(spy_closes),
            "QQQ": _make_bars([c * 1.2 for c in spy_closes]),
            "TLT": _make_bars(inv_closes),
        },
        windows=(20, 60),
    )
    assert corr_res["QQQ"]["corr_20d"] == 1.0
    assert float(corr_res["TLT"]["corr_60d"]) < -0.9

    breadth = compute_market_breadth(
        {"SPY": bars_up, "QQQ": bars_up, "TLT": _make_bars([200.0 - i * 0.4 for i in range(60)])},
        spy_bars=bars_up,
        rsp_bars=bars_up,
    )
    assert breadth["rsp_spy_ratio"] is not None
    assert breadth["pct_above_50ma"] == 66.7

    sectors = compute_sector_rotation({"XLK": bars_up, "XLU": _make_bars([70.0] * 30)}, spy_bars=bars_up)
    assert len(sectors) == 11
    assert sectors[0]["symbol"] == "XLK"


def test_fear_greed_and_regime_classification_extremes() -> None:
    fg_greed = compute_fear_greed_index(
        spy_dist_200ma_pct=9.0,
        spy_20d_return_pct=4.5,
        pct_above_50ma=78.0,
        rsp_spy_20d_delta_pct=2.5,
        vix_spot=13.0,
        vix_vix3m_ratio=0.84,
        hy_oas=2.9,
        hyg_lqd_20d_delta_pct=1.8,
        soxx_spy_20d_delta_pct=5.5,
        btc_20d_return_pct=18.0,
    )
    assert 70.0 <= float(fg_greed["score"]) <= 100.0

    regime_on = classify_market_regime(
        net_liq_delta_20d=120.0,
        hy_oas=3.0,
        vix_spot=14.0,
        vix_term_ratio=0.87,
        spy_dist_50ma_pct=3.5,
        pct_above_50ma=72.0,
        spy_net_gex=5_000_000_000.0,
    )
    assert regime_on["regime_label"] == "RISK_ON_EXPANSION"

    fg_fear = compute_fear_greed_index(
        spy_dist_200ma_pct=-6.0,
        spy_20d_return_pct=-5.5,
        pct_above_50ma=24.0,
        rsp_spy_20d_delta_pct=-3.0,
        vix_spot=31.0,
        vix_vix3m_ratio=1.09,
        hy_oas=5.9,
        hyg_lqd_20d_delta_pct=-2.1,
        soxx_spy_20d_delta_pct=-6.0,
        btc_20d_return_pct=-15.0,
    )
    assert 0.0 <= float(fg_fear["score"]) <= 30.0

    regime_off = classify_market_regime(
        net_liq_delta_20d=-180.0,
        hy_oas=5.8,
        vix_spot=29.0,
        vix_term_ratio=1.08,
        spy_dist_50ma_pct=-4.2,
        pct_above_50ma=25.0,
        spy_net_gex=-3_000_000_000.0,
    )
    assert regime_off["regime_label"] == "RISK_OFF_STRESS"

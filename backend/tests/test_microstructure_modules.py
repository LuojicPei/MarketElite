from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from app.main import create_app
from app.services.providers.finra import build_darkpool_profile, parse_finra_cnms_text
from app.services.providers.moc_proxy import compute_moc_proxy_from_bars, get_next_rebalance_window
from app.services.providers.onchain import (
    interpret_mvrv,
    parse_binance_perp_pulse,
    parse_coinmetrics_btc,
    parse_defillama_stablecoins,
    synthesize_onchain_diagnosis,
)

_NY = ZoneInfo("America/New_York")


def _make_day_15m_bars(day: date, *, total_bars: int = 26, tail_vol: float = 1_000_000, tail_jump_pct: float = 0.0) -> list[dict]:
    start_dt = datetime(day.year, day.month, day.day, 9, 30, tzinfo=_NY)
    bars: list[dict] = []
    price = 500.0
    for idx in range(total_bars):
        dt = start_dt + timedelta(minutes=15 * idx)
        is_last = idx == total_bars - 1
        vol = tail_vol if is_last else 300_000
        close_p = price * (1.0 + tail_jump_pct / 100.0) if is_last else price
        bars.append(
            {
                "ts": int(dt.timestamp()),
                "o": price,
                "c": close_p,
                "v": vol,
            }
        )
    return bars


def test_moc_proxy_detects_closing_surge_and_half_day() -> None:
    bars: list[dict] = []
    start = date(2026, 11, 9)
    trading_days = [
        start + timedelta(days=i)
        for i in range(18)
        if (start + timedelta(days=i)).weekday() < 5
    ][:10]

    for idx, d in enumerate(trading_days):
        if idx == len(trading_days) - 1:
            # OpEx / rebalance closing volume spike on final day
            bars.extend(_make_day_15m_bars(d, total_bars=26, tail_vol=3_600_000, tail_jump_pct=0.28))
        else:
            bars.extend(_make_day_15m_bars(d, total_bars=26, tail_vol=900_000, tail_jump_pct=0.02))

    now_ny = datetime(2026, 11, 20, 17, 0, tzinfo=_NY)
    res = compute_moc_proxy_from_bars("SPY", bars, now_ny=now_ny)
    assert res["status"] == "ok"
    assert len(res["series_10d"]) == 10
    assert res["latest"]["tail_share_pct"] > 30.0
    assert res["surge_ratio"] >= 1.5
    assert res["impulse_label_zh"] == "放量尾盘抢筹"
    assert "无法直接获取" in res["methodology_note_zh"]

    # Verify half-day (Black Friday 13:00 ET, 14 regular 15m bars -> final bar 12:45 ET)
    bf_bars = _make_day_15m_bars(date(2026, 11, 27), total_bars=14, tail_vol=1_400_000, tail_jump_pct=-0.2)
    bf_res = compute_moc_proxy_from_bars("SPY", bars + bf_bars, now_ny=datetime(2026, 11, 27, 14, 0, tzinfo=_NY))
    assert bf_res["latest"]["is_half_day"] is True
    assert bf_res["latest"]["tail_window_et"] == "12:45–13:00"

    # Rebalance calendar returns non-negative days_away
    nxt = get_next_rebalance_window(date(2026, 11, 26))
    assert nxt["days_away"] >= 0
    assert nxt["title_zh"]


def test_moc_proxy_skips_incomplete_mid_session() -> None:
    bars = _make_day_15m_bars(date(2026, 11, 24), total_bars=26, tail_vol=900_000)
    # Current session only has bars up to 11:00 ET
    mid_bars = _make_day_15m_bars(date(2026, 11, 25), total_bars=6, tail_vol=300_000)
    res = compute_moc_proxy_from_bars("QQQ", bars + mid_bars, now_ny=datetime(2026, 11, 25, 11, 15, tzinfo=_NY))
    assert res["status"] == "ok"
    assert res["intraday_status"] == "mid_session_waiting"
    assert len(res["series_10d"]) == 1
    assert res["series_10d"][0]["date"] == "2026-11-24"


def test_finra_cnms_parser_and_darkpool_profile() -> None:
    raw = (
        "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n"
        "20261125|SPY|12149172.3|15160|26001751.8|B,Q,N\n"
        "20261125|NVDA|62739216|432715|164628520|B,Q,N\n"
        "20261125|9999\n"
    )
    parsed = parse_finra_cnms_text(raw)
    assert "SPY" in parsed
    assert "NVDA" in parsed
    assert "9999" not in parsed
    assert parsed["SPY"][0] == 12149172.3
    assert parsed["SPY"][2] == 26001751.8

    daily_pts = []
    for i in range(10):
        d = (date(2026, 11, 10) + timedelta(days=i)).isoformat()
        daily_pts.append(
            {
                "date": d,
                "label": d[5:],
                "close": 700.0 + i * 2.0,
                "consolidated_volume": 70_000_000,
                "trf_total_volume": 28_000_000 if i < 9 else 35_000_000,
                "short_volume": 13_000_000 if i < 9 else 16_000_000,
                "short_exempt_volume": 10_000,
                "off_exchange_pct": 40.0 if i < 9 else 50.0,
                "short_ratio_pct": 46.4 if i < 9 else 45.7,
            }
        )
    ats = {
        "weeks": [
            {
                "week_start_date": "2026-10-12",
                "total_shares": 48_147_874,
                "total_notional_usd": 37_153_668_352,
                "total_trades": 469_185,
                "avg_trade_usd": 79188,
            }
        ],
        "latest": {
            "week_start_date": "2026-10-12",
            "total_shares": 48_147_874,
            "total_notional_usd": 37_153_668_352,
            "total_trades": 469_185,
            "avg_trade_usd": 79188,
        },
    }
    prof = build_darkpool_profile("SPY", daily_pts, ats)
    assert prof["status"] == "ok"
    assert prof["signal_tone"] == "bullish"
    assert "承接托底" in prof["headline_zh"]
    assert prof["latest"]["avg_off_exchange_20d"] == 41.0
    assert prof["ats_weekly"]["latest"]["avg_trade_usd"] == 79188


def test_onchain_parsers_and_synthesis() -> None:
    st = parse_defillama_stablecoins(
        {
            "peggedAssets": [
                {
                    "symbol": "USDT",
                    "name": "Tether",
                    "circulating": {"peggedUSD": 175e9},
                    "circulatingPrevWeek": {"peggedUSD": 173e9},
                    "circulatingPrevMonth": {"peggedUSD": 170e9},
                }
            ]
        },
        [
            {"date": "1795564800", "totalCirculatingUSD": {"peggedUSD": 280e9}},
            {"date": "1795651200", "totalCirculatingUSD": {"peggedUSD": 282e9}},
        ],
    )
    assert st["total_circulating_b"] == 175.0
    assert st["delta_7d_b"] == 2.0
    assert len(st["series_35d"]) == 2

    cm = parse_coinmetrics_btc(
        [
            {
                "time": "2026-11-24T00:00:00Z",
                "PriceUSD": "60800.5",
                "CapMVRVCur": "1.126",
                "FlowInExUSD": "1500000000",
                "FlowOutExUSD": "1650000000",
                "SplyExNtv": "2709516",
                "AdrActCnt": "680127",
                "TxCnt": "519029",
            }
        ]
    )
    assert cm["latest"]["netflow_m"] == -150.0
    assert cm["mvrv_meta"]["zone"] == "healthy_accumulation"
    assert interpret_mvrv(0.95)["zone"] == "deep_value"
    assert interpret_mvrv(3.1)["zone"] == "overheated"

    bn = parse_binance_perp_pulse(
        {"lastFundingRate": "0.0001", "markPrice": "60820"},
        [{"timestamp": 1795651200000, "sumOpenInterestValue": "5760000000", "sumOpenInterest": "96000"}],
        [{"timestamp": 1795651200000, "buySellRatio": "1.08"}],
        [{"longAccount": "0.62"}],
        [{"fundingTime": 1795651200000, "fundingRate": "0.0001"}],
    )
    assert bn["funding_rate_pct"] == 0.01
    assert bn["taker_buy_sell_ratio"] == 1.08
    assert bn["top_trader_long_pct"] == 62.0

    tone, headline = synthesize_onchain_diagnosis(st, cm, bn)
    assert tone == "bullish"
    assert "买盘弹药扩充" in headline
    assert "提币囤货" in headline


def test_microstructure_endpoints_contract(monkeypatch) -> None:
    async def fake_moc(symbol: str, *, cache=None, force_refresh=False):
        return {
            "status": "ok",
            "symbol": symbol,
            "headline_zh": "MOCK MOC",
            "series_10d": [],
            "methodology_note_zh": "估算口径",
        }

    async def fake_darkpool(symbol: str, *, alpaca_client=None, cache=None, force_refresh=False):
        return {
            "status": "ok",
            "symbol": symbol,
            "headline_zh": "MOCK DARKPOOL",
            "series_20d": [],
            "ats_weekly": {"weeks": [], "latest": None},
            "methodology_note_zh": "FINRA口径",
        }

    async def fake_onchain(*, cache=None, force_refresh=False):
        return {
            "status": "ok",
            "headline_zh": "MOCK ONCHAIN",
            "stablecoins": None,
            "btc_chain": None,
            "perp": None,
            "methodology_note_zh": "链上口径",
        }

    monkeypatch.setattr("app.api.market.fetch_moc_auction_proxy", fake_moc)
    monkeypatch.setattr("app.api.market.fetch_finra_darkpool_profile", fake_darkpool)
    monkeypatch.setattr("app.api.market.fetch_onchain_liquidity_pulse", fake_onchain)

    app = create_app()
    with TestClient(app) as client:
        r_moc = client.get("/api/market/moc?symbol=qqq")
        assert r_moc.status_code == 200
        assert r_moc.json()["symbol"] == "QQQ"

        r_dp = client.get("/api/market/darkpool?symbol=nvda")
        assert r_dp.status_code == 200
        assert r_dp.json()["symbol"] == "NVDA"

        r_oc = client.get("/api/market/onchain")
        assert r_oc.status_code == 200
        assert r_oc.json()["headline_zh"] == "MOCK ONCHAIN"

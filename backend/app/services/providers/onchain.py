from __future__ import annotations

import asyncio
import math
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from app.services.resilience import DualTTLCache, raise_for_provider_response

_DEFILLAMA_STABLE_URL = "https://stablecoins.llama.fi/stablecoins?includePrices=false"
_DEFILLAMA_CHARTS_URL = "https://stablecoins.llama.fi/stablecoincharts/all"
_COINMETRICS_BTC_URL = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics"
_BINANCE_FUNDING_HIST_URL = "https://fapi.binance.com/fapi/v1/fundingRate"
_BINANCE_PREMIUM_URL = "https://fapi.binance.com/fapi/v1/premiumIndex"
_BINANCE_OI_HIST_URL = "https://fapi.binance.com/futures/data/openInterestHist"
_BINANCE_TAKER_URL = "https://fapi.binance.com/futures/data/takerlongshortRatio"
_BINANCE_TOP_LS_URL = "https://fapi.binance.com/futures/data/topLongShortPositionRatio"

_ONCHAIN_DISCLOSURE_ZH = (
    "数据与口径说明：全部采用免 Key 公共源直连 —— 全球稳定币市值及 7D/30D 变动源自 "
    "DefiLlama Stablecoins；BTC 交易所充提净流（FlowIn/Out）、存量与 MVRV 估值源自 "
    "Coin Metrics Community API（按日聚合全网及交易所合计，不含特定个人/做市商钱包实体标签）；"
    "永续资金费率、未平仓合约(OI)与主动买卖比源自 Binance Public Futures 接口。"
)


def _safe_float(val: Any) -> float | None:
    try:
        if val is None or val == "":
            return None
        num = float(val)
        return num if math.isfinite(num) else None
    except (TypeError, ValueError):
        return None


def interpret_mvrv(mvrv: float | None) -> dict[str, str]:
    """Translate Coin Metrics CapMVRVCur into a beginner-friendly valuation zone."""
    if mvrv is None:
        return {"zone": "unknown", "label_zh": "暂缺", "hint_zh": "等待链上估值同步"}
    if mvrv < 1.0:
        return {
            "zone": "deep_value",
            "label_zh": "历史深坑低估区",
            "hint_zh": "全网持币平均处于轻微浮亏，历史上往往对应中长期低吸区域",
        }
    if mvrv < 1.8:
        return {
            "zone": "healthy_accumulation",
            "label_zh": "健康温和区",
            "hint_zh": "全网适度盈利，泡沫极轻，筹码锁定度较好",
        }
    if mvrv < 2.6:
        return {
            "zone": "bull_expansion",
            "label_zh": "牛市扩张盈利区",
            "hint_zh": "多头普遍盈利，顺势持仓但留意阶段性获利回吐",
        }
    return {
        "zone": "overheated",
        "label_zh": "高泡沫警示区",
        "hint_zh": "全网普遍大幅浮盈，极易触发集中获利了结砸盘",
    }


def parse_defillama_stablecoins(
    assets_json: dict[str, Any],
    charts_json: list[dict[str, Any]],
) -> dict[str, Any]:
    """Parse DefiLlama stablecoin supply deltas + trailing 35D circulating series."""
    pegged = assets_json.get("peggedAssets") or []
    total_now = 0.0
    total_prev_w = 0.0
    total_prev_m = 0.0
    breakdown: list[dict[str, Any]] = []

    for idx, asset in enumerate(pegged):
        circ = _safe_float((asset.get("circulating") or {}).get("peggedUSD")) or 0.0
        prev_w = _safe_float((asset.get("circulatingPrevWeek") or {}).get("peggedUSD")) or circ
        prev_m = _safe_float((asset.get("circulatingPrevMonth") or {}).get("peggedUSD")) or circ
        total_now += circ
        total_prev_w += prev_w
        total_prev_m += prev_m
        if idx < 4:
            breakdown.append(
                {
                    "symbol": str(asset.get("symbol") or ""),
                    "name": str(asset.get("name") or ""),
                    "circulating_b": round(circ / 1e9, 2),
                    "delta_7d_b": round((circ - prev_w) / 1e9, 2),
                    "delta_30d_b": round((circ - prev_m) / 1e9, 2),
                }
            )

    delta_7d_b = round((total_now - total_prev_w) / 1e9, 2)
    delta_30d_b = round((total_now - total_prev_m) / 1e9, 2)

    series: list[dict[str, Any]] = []
    for pt in charts_json[-35:]:
        ts_raw = _safe_float(pt.get("date"))
        usd_val = _safe_float((pt.get("totalCirculatingUSD") or {}).get("peggedUSD"))
        if ts_raw is None or usd_val is None or usd_val <= 0:
            continue
        d_iso = datetime.fromtimestamp(int(ts_raw), tz=timezone.utc).strftime("%Y-%m-%d")
        series.append(
            {
                "date": d_iso,
                "label": d_iso[5:],
                "total_b": round(usd_val / 1e9, 2),
            }
        )

    return {
        "total_circulating_b": round(total_now / 1e9, 2),
        "delta_7d_b": delta_7d_b,
        "delta_30d_b": delta_30d_b,
        "delta_7d_pct": round(((total_now - total_prev_w) / total_prev_w) * 100.0, 2) if total_prev_w > 0 else 0.0,
        "breakdown": breakdown,
        "series_35d": series,
    }


def parse_coinmetrics_btc(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Parse Coin Metrics Community daily BTC exchange flows, reserves, MVRV & active addresses."""
    series: list[dict[str, Any]] = []
    for r in rows[-35:]:
        d_iso = str(r.get("time") or "")[:10]
        if not d_iso:
            continue
        price = _safe_float(r.get("PriceUSD"))
        mvrv = _safe_float(r.get("CapMVRVCur"))
        flow_in = _safe_float(r.get("FlowInExUSD"))
        flow_out = _safe_float(r.get("FlowOutExUSD"))
        sply_ex = _safe_float(r.get("SplyExNtv"))
        active_addr = _safe_float(r.get("AdrActCnt"))
        tx_cnt = _safe_float(r.get("TxCnt"))
        netflow_m = (
            round((flow_in - flow_out) / 1e6, 2)
            if flow_in is not None and flow_out is not None
            else None
        )
        series.append(
            {
                "date": d_iso,
                "label": d_iso[5:],
                "price_usd": round(price, 1) if price is not None else None,
                "mvrv": round(mvrv, 3) if mvrv is not None else None,
                "flow_in_m": round(flow_in / 1e6, 2) if flow_in is not None else None,
                "flow_out_m": round(flow_out / 1e6, 2) if flow_out is not None else None,
                "netflow_m": netflow_m,
                "exchange_reserve_btc": round(sply_ex, 0) if sply_ex is not None else None,
                "active_addresses": int(round(active_addr)) if active_addr is not None else None,
                "tx_count": int(round(tx_cnt)) if tx_cnt is not None else None,
            }
        )

    latest = series[-1] if series else None
    net_7d_m = (
        round(sum(p["netflow_m"] for p in series[-7:] if p["netflow_m"] is not None), 2)
        if any(p["netflow_m"] is not None for p in series[-7:])
        else None
    )
    mvrv_meta = interpret_mvrv(latest["mvrv"] if latest else None)
    return {
        "latest": latest,
        "netflow_7d_m": net_7d_m,
        "mvrv_meta": mvrv_meta,
        "series_35d": series,
    }


def parse_binance_perp_pulse(
    premium: dict[str, Any] | None,
    oi_hist: list[dict[str, Any]] | None,
    taker_hist: list[dict[str, Any]] | None,
    top_ls_hist: list[dict[str, Any]] | None,
    funding_hist: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    """Parse Binance BTCUSDT perpetual leverage, funding rate, OI & taker buy/sell aggression."""
    funding_raw = _safe_float((premium or {}).get("lastFundingRate"))
    funding_pct = round(funding_raw * 100.0, 4) if funding_raw is not None else None
    funding_apr_pct = round(funding_raw * 3 * 365 * 100.0, 2) if funding_raw is not None else None

    if funding_pct is None:
        lev_label = "暂缺"
    elif funding_pct >= 0.03:
        lev_label = "多头过热警戒"
    elif funding_pct >= 0.01:
        lev_label = "温和偏多"
    elif funding_pct <= -0.01:
        lev_label = "空头付费情绪"
    else:
        lev_label = "杠杆温和冷静"

    oi_by_date: dict[str, dict[str, Any]] = {}
    for row in oi_hist or []:
        ts_ms = _safe_float(row.get("timestamp"))
        oi_usd = _safe_float(row.get("sumOpenInterestValue"))
        oi_btc = _safe_float(row.get("sumOpenInterest"))
        if ts_ms is None or oi_usd is None:
            continue
        d_iso = datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%d")
        oi_by_date[d_iso] = {
            "date": d_iso,
            "label": d_iso[5:],
            "oi_usd_b": round(oi_usd / 1e9, 2),
            "oi_btc": round(oi_btc, 0) if oi_btc is not None else None,
        }

    for row in taker_hist or []:
        ts_ms = _safe_float(row.get("timestamp"))
        ratio = _safe_float(row.get("buySellRatio"))
        if ts_ms is None or ratio is None:
            continue
        d_iso = datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%d")
        bucket = oi_by_date.setdefault(d_iso, {"date": d_iso, "label": d_iso[5:]})
        bucket["taker_buy_sell_ratio"] = round(ratio, 3)

    for row in funding_hist or []:
        ts_ms = _safe_float(row.get("fundingTime"))
        fr = _safe_float(row.get("fundingRate"))
        if ts_ms is None or fr is None:
            continue
        d_iso = datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%d")
        if d_iso in oi_by_date:
            oi_by_date[d_iso]["funding_pct"] = round(fr * 100.0, 4)

    series = sorted(oi_by_date.values(), key=lambda x: x["date"])[-30:]
    latest_oi = series[-1] if series else None
    latest_taker = next(
        (row.get("taker_buy_sell_ratio") for row in reversed(series) if row.get("taker_buy_sell_ratio") is not None),
        None,
    )
    latest_top_ls = (top_ls_hist or [])[-1] if top_ls_hist else None

    return {
        "symbol": "BTCUSDT",
        "mark_price": _safe_float((premium or {}).get("markPrice")),
        "funding_rate_pct": funding_pct,
        "funding_apr_pct": funding_apr_pct,
        "leverage_label_zh": lev_label,
        "open_interest_usd_b": latest_oi.get("oi_usd_b") if latest_oi else None,
        "open_interest_btc": latest_oi.get("oi_btc") if latest_oi else None,
        "taker_buy_sell_ratio": latest_taker,
        "top_trader_long_pct": (
            round(_safe_float(latest_top_ls.get("longAccount")) * 100.0, 1)
            if latest_top_ls and _safe_float(latest_top_ls.get("longAccount")) is not None
            else None
        ),
        "series_30d": series,
    }


def synthesize_onchain_diagnosis(
    stablecoins: dict[str, Any] | None,
    btc_chain: dict[str, Any] | None,
    perp: dict[str, Any] | None,
) -> tuple[str, str]:
    """Generate beginner-readable overall posture badge and one-line synthesis."""
    st_7d = (stablecoins or {}).get("delta_7d_b")
    net_latest = ((btc_chain or {}).get("latest") or {}).get("netflow_m")
    mvrv = ((btc_chain or {}).get("latest") or {}).get("mvrv")
    fr = (perp or {}).get("funding_rate_pct")

    positives = 0
    negatives = 0
    parts: list[str] = []

    if st_7d is not None:
        if st_7d >= 0.5:
            positives += 1
            parts.append(f"稳定币7日净增 +{st_7d:.1f}B（买盘弹药扩充）")
        elif st_7d <= -0.5:
            negatives += 1
            parts.append(f"稳定币7日净缩 {st_7d:.1f}B（场外弹药回吐）")
        else:
            parts.append(f"稳定币7日平稳（{st_7d:+.1f}B）")

    if net_latest is not None:
        if net_latest <= -50:
            positives += 1
            parts.append(f"BTC 交易所大额净流出 {net_latest:.0f}M（提币囤货）")
        elif net_latest >= 150:
            negatives += 1
            parts.append(f"BTC 交易所大额净流入 +{net_latest:.0f}M（留意充币抛压）")
        else:
            direction = "净流出" if net_latest < 0 else "净流入"
            parts.append(f"交易所充提{direction}温和（{net_latest:+.1f}M）")

    if mvrv is not None:
        mvrv_label = interpret_mvrv(mvrv)["label_zh"]
        parts.append(f"MVRV {mvrv:.2f}（{mvrv_label}）")
        if mvrv >= 2.8:
            negatives += 1

    if fr is not None:
        if fr >= 0.03:
            negatives += 1
            parts.append("永续杠杆偏热")
        else:
            parts.append(f"永续费率冷静（{fr:+.4f}%）")

    if negatives >= 2:
        tone = "bearish"
    elif positives >= 2 and negatives == 0:
        tone = "bullish"
    elif positives >= 1 and negatives >= 1:
        tone = "warning"
    else:
        tone = "neutral"

    headline = " · ".join(parts) if parts else "链上与永续资金脉搏已同步"
    return tone, headline


async def fetch_onchain_liquidity_pulse(
    *,
    cache: DualTTLCache | None = None,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Fetch keyless DefiLlama stablecoins, CoinMetrics BTC exchange flows & Binance Perp pulse."""
    cache_key = "marketelite:onchain:pulse:v1"

    async def _fetch() -> dict[str, Any]:
        start_cm = (datetime.now(timezone.utc) - timedelta(days=40)).strftime("%Y-%m-%d")
        async with httpx.AsyncClient(timeout=14.0, follow_redirects=True) as client:
            async def _get_defillama() -> dict[str, Any] | None:
                r1, r2 = await asyncio.gather(
                    client.get(_DEFILLAMA_STABLE_URL),
                    client.get(_DEFILLAMA_CHARTS_URL),
                )
                raise_for_provider_response(r1, "defillama_stablecoins")
                raise_for_provider_response(r2, "defillama_charts")
                return parse_defillama_stablecoins(r1.json(), r2.json())

            async def _get_coinmetrics() -> dict[str, Any] | None:
                r = await client.get(
                    _COINMETRICS_BTC_URL,
                    params={
                        "assets": "btc",
                        "metrics": "PriceUSD,CapMVRVCur,FlowInExUSD,FlowOutExUSD,SplyExNtv,AdrActCnt,TxCnt",
                        "frequency": "1d",
                        "start_time": start_cm,
                        "page_size": 100,
                    },
                )
                raise_for_provider_response(r, "coinmetrics_btc")
                return parse_coinmetrics_btc((r.json() or {}).get("data") or [])

            async def _get_binance_perp() -> dict[str, Any] | None:
                rp, roi, rtk, rls, rfr = await asyncio.gather(
                    client.get(_BINANCE_PREMIUM_URL, params={"symbol": "BTCUSDT"}),
                    client.get(_BINANCE_OI_HIST_URL, params={"symbol": "BTCUSDT", "period": "1d", "limit": 30}),
                    client.get(_BINANCE_TAKER_URL, params={"symbol": "BTCUSDT", "period": "1d", "limit": 30}),
                    client.get(_BINANCE_TOP_LS_URL, params={"symbol": "BTCUSDT", "period": "1d", "limit": 7}),
                    client.get(_BINANCE_FUNDING_HIST_URL, params={"symbol": "BTCUSDT", "limit": 90}),
                )
                raise_for_provider_response(rp, "binance_premium")
                return parse_binance_perp_pulse(
                    rp.json(),
                    roi.json() if roi.status_code == 200 else [],
                    rtk.json() if rtk.status_code == 200 else [],
                    rls.json() if rls.status_code == 200 else [],
                    rfr.json() if rfr.status_code == 200 else [],
                )

            dl_res, cm_res, bn_res = await asyncio.gather(
                _get_defillama(),
                _get_coinmetrics(),
                _get_binance_perp(),
                return_exceptions=True,
            )

        degraded_sources: list[str] = []
        stablecoins = None if isinstance(dl_res, Exception) else dl_res
        btc_chain = None if isinstance(cm_res, Exception) else cm_res
        perp = None if isinstance(bn_res, Exception) else bn_res
        if isinstance(dl_res, Exception):
            degraded_sources.append(f"DefiLlama({dl_res})")
        if isinstance(cm_res, Exception):
            degraded_sources.append(f"CoinMetrics({cm_res})")
        if isinstance(bn_res, Exception):
            degraded_sources.append(f"BinancePerp({bn_res})")

        if stablecoins is None and btc_chain is None and perp is None:
            return {
                "status": "unavailable",
                "signal_tone": "neutral",
                "headline_zh": "链上与永续数据源暂未响应，请稍后刷新",
                "stablecoins": None,
                "btc_chain": None,
                "perp": None,
                "degraded_sources": degraded_sources,
                "methodology_note_zh": _ONCHAIN_DISCLOSURE_ZH,
            }

        tone, headline = synthesize_onchain_diagnosis(stablecoins, btc_chain, perp)
        return {
            "status": "ok" if not degraded_sources else "partial",
            "signal_tone": tone,
            "headline_zh": headline,
            "stablecoins": stablecoins,
            "btc_chain": btc_chain,
            "perp": perp,
            "degraded_sources": degraded_sources,
            "methodology_note_zh": _ONCHAIN_DISCLOSURE_ZH,
        }

    if cache is None:
        return await _fetch()

    res = await cache.get_or_fetch(
        cache_key,
        provider="onchain_pulse",
        fetcher=_fetch,
        soft_ttl_seconds=900,
        hard_ttl_seconds=86400 * 2,
        force_refresh=force_refresh,
    )
    payload = dict(res.data or {})
    payload["is_stale"] = res.is_stale
    payload["fetched_at"] = res.fetched_at
    return payload

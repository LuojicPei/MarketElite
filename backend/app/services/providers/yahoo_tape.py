from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from app.services.resilience import DualTTLCache, ProviderError, raise_for_provider_response


@dataclass(frozen=True)
class MacroTapeSpec:
    yahoo_symbol: str
    proxy_symbol: str
    name: str
    zh_name: str
    decimals: int
    unit: str
    cnbc_symbol: str | None = None


MACRO_TAPE_SPECS: tuple[MacroTapeSpec, ...] = (
    MacroTapeSpec("^GSPC", "SPY", "S&P 500", "标普 500", 2, ""),
    MacroTapeSpec("^DJI", "DIA", "Dow 30", "道琼斯 30", 2, ""),
    MacroTapeSpec("^IXIC", "QQQ", "Nasdaq", "纳斯达克", 2, ""),
    MacroTapeSpec("^RUT", "IWM", "Russell 2000", "罗素 2000", 2, ""),
    MacroTapeSpec("^TNX", "TLT", "10-Yr Bond", "10年美债", 4, "%"),
    MacroTapeSpec("^VIX", "SPY", "VIX", "恐慌指数", 2, ""),
    MacroTapeSpec("DX-Y.NYB", "UUP", "DXY Dollar", "美元指数", 2, ""),
    MacroTapeSpec("JPY=X", "UUP", "USD/JPY", "美元/日元", 3, ""),
    MacroTapeSpec("^N225", "SPY", "Nikkei 225", "日经 225", 2, ""),
    MacroTapeSpec("^KS11", "SOXX", "KOSPI", "韩国 KOSPI", 2, ""),
    MacroTapeSpec("000001.SS", "SPY", "SSE Index", "上证指数", 2, ""),
    MacroTapeSpec("GC=F", "GLD", "Gold", "黄金", 2, "$", "@GC.1"),
    MacroTapeSpec("SI=F", "SLV", "Silver", "白银", 2, "$", "@SI.1"),
    MacroTapeSpec("CL=F", "USO", "WTI Crude", "WTI 原油", 2, "$", "@CL.1"),
    MacroTapeSpec("BZ=F", "BNO", "Brent Crude", "布伦特油", 2, "$", "@LCO.1"),
    MacroTapeSpec("NG=F", "UNG", "Nat Gas", "天然气", 3, "$", "@NG.1"),
    MacroTapeSpec("BTC-USD", "BTCUSDT", "Bitcoin", "比特币", 0, "$"),
)

_CNBC_QUOTE_URL = "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol"

_YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
_DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
}


def _coalesce_ohlc_bars(
    timestamps: list[Any],
    opens: list[Any],
    highs: list[Any],
    lows: list[Any],
    closes: list[Any],
    *,
    max_candles: int = 26,
) -> list[dict[str, float | int]]:
    """Filter nulls and aggregate OHLC into clean micro-candlesticks for sparkline rendering."""
    raw: list[dict[str, float | int]] = []
    n = min(len(timestamps), len(closes))
    for i in range(n):
        c_val = closes[i]
        if c_val is None:
            continue
        c = float(c_val)
        o = float(opens[i]) if i < len(opens) and opens[i] is not None else c
        h = float(highs[i]) if i < len(highs) and highs[i] is not None else max(o, c)
        l_val = float(lows[i]) if i < len(lows) and lows[i] is not None else min(o, c)
        raw.append(
            {
                "t": int(timestamps[i]),
                "o": round(o, 5),
                "h": round(max(h, o, c), 5),
                "l": round(min(l_val, o, c), 5),
                "c": round(c, 5),
            }
        )

    if len(raw) <= max_candles:
        return raw

    bucket_size = (len(raw) + max_candles - 1) // max_candles
    merged: list[dict[str, float | int]] = []
    for idx in range(0, len(raw), bucket_size):
        chunk = raw[idx : idx + bucket_size]
        if not chunk:
            continue
        merged.append(
            {
                "t": int(chunk[-1]["t"]),
                "o": float(chunk[0]["o"]),
                "h": max(float(b["h"]) for b in chunk),
                "l": min(float(b["l"]) for b in chunk),
                "c": float(chunk[-1]["c"]),
            }
        )
    return merged


def _parse_float_str(val: Any) -> float | None:
    if val is None:
        return None
    s = str(val).replace(",", "").replace("%", "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


async def _fetch_cnbc_live_quotes(
    client: httpx.AsyncClient,
    symbols: list[str],
) -> dict[str, dict[str, float]]:
    """Fetch active front-month futures live quotes in a single call to avoid Yahoo premature rollovers."""
    if not symbols:
        return {}
    try:
        resp = await client.get(
            _CNBC_QUOTE_URL,
            params={
                "symbols": "|".join(symbols),
                "requestMethod": "itv",
                "noform": "1",
                "partnerId": "2",
                "fund": "1",
                "exthrs": "1",
                "output": "json",
            },
            timeout=6.0,
        )
        if resp.status_code != 200:
            return {}
        quotes = (resp.json().get("FormattedQuoteResult") or {}).get("FormattedQuote") or []
        out: dict[str, dict[str, float]] = {}
        for q in quotes:
            sym = str(q.get("symbol") or "").strip()
            last_p = _parse_float_str(q.get("last"))
            if not sym or last_p is None:
                continue
            prev_p = _parse_float_str(q.get("previous_day_closing"))
            chg_p = _parse_float_str(q.get("change"))
            if prev_p is None and chg_p is not None:
                prev_p = last_p - chg_p
            if prev_p is not None and prev_p > 0:
                out[sym] = {"price": last_p, "prev_close": prev_p}
        return out
    except (httpx.HTTPError, OSError, ValueError, KeyError, TypeError):
        return {}


async def _fetch_single_spec(
    client: httpx.AsyncClient,
    spec: MacroTapeSpec,
    cnbc_overrides: dict[str, dict[str, float]] | None = None,
) -> dict[str, Any] | None:
    url = _YAHOO_CHART_URL.format(symbol=spec.yahoo_symbol)
    try:
        resp = await client.get(
            url,
            params={"range": "1d", "interval": "15m"},
            timeout=8.0,
        )
        raise_for_provider_response(resp, "yahoo_finance")
        payload = resp.json()
        result_list = payload.get("chart", {}).get("result") or []
        if not result_list:
            return None
        res0 = result_list[0]
        meta = res0.get("meta") or {}
        quote = ((res0.get("indicators") or {}).get("quote") or [{}])[0]
        bars = _coalesce_ohlc_bars(
            res0.get("timestamp") or [],
            quote.get("open") or [],
            quote.get("high") or [],
            quote.get("low") or [],
            quote.get("close") or [],
        )
        if len(bars) < 6:
            resp_5d = await client.get(
                url,
                params={"range": "5d", "interval": "1h"},
                timeout=8.0,
            )
            if 200 <= resp_5d.status_code < 300:
                res_5d = (resp_5d.json().get("chart", {}).get("result") or [None])[0]
                if res_5d:
                    q5 = ((res_5d.get("indicators") or {}).get("quote") or [{}])[0]
                    alt_bars = _coalesce_ohlc_bars(
                        res_5d.get("timestamp") or [],
                        q5.get("open") or [],
                        q5.get("high") or [],
                        q5.get("low") or [],
                        q5.get("close") or [],
                    )
                    if len(alt_bars) > len(bars):
                        bars = alt_bars

        price_raw = meta.get("regularMarketPrice")
        price = float(price_raw) if price_raw is not None else (float(bars[-1]["c"]) if bars else None)
        if price is None:
            return None

        prev_raw = meta.get("previousClose") or meta.get("chartPreviousClose")
        prev_close = float(prev_raw) if prev_raw is not None else (float(bars[0]["o"]) if bars else price)

        live_override = (cnbc_overrides or {}).get(spec.cnbc_symbol or "")
        if live_override and live_override.get("price"):
            live_p = float(live_override["price"])
            live_prev = float(live_override["prev_close"])
            if bars:
                # Preserve intraday sparkline shape while aligning contract basis if Yahoo rolled early
                ref_last = float(bars[-1]["c"])
                if ref_last > 0 and abs(live_p - ref_last) / ref_last > 0.005:
                    shift = live_p - ref_last
                    bars = [
                        {
                            "t": int(b["t"]),
                            "o": round(float(b["o"]) + shift, 5),
                            "h": round(float(b["h"]) + shift, 5),
                            "l": round(float(b["l"]) + shift, 5),
                            "c": round(float(b["c"]) + shift, 5),
                        }
                        for b in bars
                    ]
                else:
                    last_b = dict(bars[-1])
                    last_b["c"] = round(live_p, 5)
                    last_b["h"] = round(max(float(last_b["h"]), live_p), 5)
                    last_b["l"] = round(min(float(last_b["l"]), live_p), 5)
                    bars = [*bars[:-1], last_b]
            price = live_p
            prev_close = live_prev

        change_abs = price - prev_close
        change_pct = (change_abs / prev_close * 100.0) if prev_close > 0 else 0.0

        return {
            "yahoo_symbol": spec.yahoo_symbol,
            "proxy_symbol": spec.proxy_symbol,
            "name": spec.name,
            "zh_name": spec.zh_name,
            "decimals": spec.decimals,
            "unit": spec.unit,
            "price": round(price, spec.decimals),
            "prev_close": round(prev_close, spec.decimals),
            "change_abs": round(change_abs, spec.decimals),
            "change_pct": round(change_pct, 2),
            "bars": bars,
        }
    except (ProviderError, httpx.HTTPError, OSError, ValueError, KeyError, TypeError):
        return None


async def fetch_macro_tape_snapshot(
    *,
    cache: DualTTLCache | None = None,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Return global multi-asset ticker strip with live active front-month futures & OHLC micro-bars."""
    cache_key = "marketelite:macro:tape:v3"

    async def _fetch_all() -> dict[str, Any]:
        cnbc_syms = [s.cnbc_symbol for s in MACRO_TAPE_SPECS if s.cnbc_symbol]
        async with httpx.AsyncClient(headers=_DEFAULT_HEADERS, timeout=8.0) as client:
            cnbc_quotes = await _fetch_cnbc_live_quotes(client, cnbc_syms)
            results = await asyncio.gather(
                *(_fetch_single_spec(client, spec, cnbc_quotes) for spec in MACRO_TAPE_SPECS),
                return_exceptions=False,
            )
        items = [item for item in results if item is not None]
        if not items:
            raise RuntimeError("No macro tape symbols returned from Yahoo Finance")
        return {"count": len(items), "items": items}

    if cache is None:
        data = await _fetch_all()
        return {"status": "ok", "source": "yahoo_cnbc_live", "is_stale": False, **data}

    res = await cache.get_or_fetch(
        cache_key,
        provider="yahoo_finance",
        fetcher=_fetch_all,
        soft_ttl_seconds=30,
        hard_ttl_seconds=1800,
        force_refresh=force_refresh,
    )
    return {
        "status": "ok",
        "source": res.source,
        "is_stale": res.is_stale,
        "fetched_at": res.fetched_at,
        **(res.data or {"count": 0, "items": []}),
    }


_NY_TZ = ZoneInfo("America/New_York")


async def _fetch_daily_ohlc_with_spot(
    client: httpx.AsyncClient,
    symbol: str,
    *,
    range_str: str = "4mo",
    decimals: int = 2,
) -> dict[str, Any] | None:
    """Fetch daily OHLC bars plus live/pre-market spot quote from Yahoo Finance."""
    url = _YAHOO_CHART_URL.format(symbol=symbol)
    try:
        resp = await client.get(
            url,
            params={"range": range_str, "interval": "1d"},
            timeout=9.0,
        )
        raise_for_provider_response(resp, "yahoo_finance")
        result_list = (resp.json().get("chart") or {}).get("result") or []
        if not result_list:
            return None
        res0 = result_list[0]
        meta = res0.get("meta") or {}
        quote = ((res0.get("indicators") or {}).get("quote") or [{}])[0]
        timestamps = res0.get("timestamp") or []
        opens = quote.get("open") or []
        highs = quote.get("high") or []
        lows = quote.get("low") or []
        closes = quote.get("close") or []

        by_date: dict[str, dict[str, Any]] = {}
        for idx in range(min(len(timestamps), len(closes))):
            c_raw = closes[idx]
            if c_raw is None:
                continue
            dt_ny = datetime.fromtimestamp(int(timestamps[idx]), tz=_NY_TZ)
            t_date = dt_ny.date().isoformat()
            c_val = round(float(c_raw), decimals)
            o_val = round(float(opens[idx]), decimals) if idx < len(opens) and opens[idx] is not None else c_val
            h_val = round(float(highs[idx]), decimals) if idx < len(highs) and highs[idx] is not None else max(o_val, c_val)
            l_val = round(float(lows[idx]), decimals) if idx < len(lows) and lows[idx] is not None else min(o_val, c_val)
            by_date[t_date] = {
                "trade_date": t_date,
                "open": o_val,
                "high": max(h_val, o_val, c_val),
                "low": min(l_val, o_val, c_val),
                "close": c_val,
            }

        bars = [by_date[k] for k in sorted(by_date)]
        if not bars:
            return None

        live_raw = meta.get("regularMarketPrice")
        live_price = round(float(live_raw), decimals) if live_raw is not None else float(bars[-1]["close"])

        market_time_raw = meta.get("regularMarketTime")
        if market_time_raw is not None:
            live_date = datetime.fromtimestamp(int(market_time_raw), tz=_NY_TZ).date().isoformat()
            if live_date == bars[-1]["trade_date"]:
                prev_close_ref = (
                    round(float(meta["previousClose"]), decimals)
                    if meta.get("previousClose") is not None
                    else (float(bars[-2]["close"]) if len(bars) >= 2 else float(bars[-1]["open"]))
                )
                bars[-1]["close"] = live_price
                bars[-1]["high"] = round(max(float(bars[-1]["high"]), live_price), decimals)
                bars[-1]["low"] = round(min(float(bars[-1]["low"]), live_price), decimals)
            elif live_date > bars[-1]["trade_date"]:
                prev_close_ref = (
                    round(float(meta["previousClose"]), decimals)
                    if meta.get("previousClose") is not None
                    else float(bars[-1]["close"])
                )
                bars.append(
                    {
                        "trade_date": live_date,
                        "open": live_price,
                        "high": live_price,
                        "low": live_price,
                        "close": live_price,
                    }
                )
            else:
                prev_close_ref = float(bars[-2]["close"]) if len(bars) >= 2 else float(bars[-1]["close"])
        else:
            prev_close_ref = (
                round(float(meta["previousClose"]), decimals)
                if meta.get("previousClose") is not None
                else (float(bars[-2]["close"]) if len(bars) >= 2 else float(bars[-1]["close"]))
            )

        change_abs = round(live_price - prev_close_ref, decimals)
        change_pct = round((change_abs / prev_close_ref) * 100.0, 2) if prev_close_ref > 0 else 0.0

        peak_bar = max(bars, key=lambda b: float(b["high"]))
        low_bar = min(bars, key=lambda b: float(b["low"]))

        return {
            "symbol": symbol,
            "price": live_price,
            "prev_close": round(prev_close_ref, decimals),
            "change_abs": change_abs,
            "change_pct": change_pct,
            "as_of_date": bars[-1]["trade_date"],
            "peak_high": round(float(peak_bar["high"]), decimals),
            "peak_date": peak_bar["trade_date"],
            "period_low": round(float(low_bar["low"]), decimals),
            "period_low_date": low_bar["trade_date"],
            "bars": bars,
        }
    except (ProviderError, httpx.HTTPError, OSError, ValueError, KeyError, TypeError):
        return None


async def fetch_yahoo_macro_sentiment_series(
    *,
    cache: DualTTLCache | None = None,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Fetch live + daily OHLC bars for ^VIX (4mo), DX-Y.NYB (1mo), ^TNX (1mo), and SPY (6mo)."""
    cache_key = "marketelite:yahoo:sentiment_macro_pulse:v1"

    async def _fetch_all() -> dict[str, Any]:
        async with httpx.AsyncClient(headers=_DEFAULT_HEADERS, timeout=9.0) as client:
            vix_res, dxy_res, tnx_res, spy_res = await asyncio.gather(
                _fetch_daily_ohlc_with_spot(client, "^VIX", range_str="4mo", decimals=2),
                _fetch_daily_ohlc_with_spot(client, "DX-Y.NYB", range_str="1mo", decimals=2),
                _fetch_daily_ohlc_with_spot(client, "^TNX", range_str="1mo", decimals=3),
                _fetch_daily_ohlc_with_spot(client, "SPY", range_str="6mo", decimals=2),
            )
        return {
            "vix": vix_res,
            "dxy": dxy_res,
            "tnx": tnx_res,
            "spy_closes": [
                {"date": b["trade_date"], "close": b["close"]}
                for b in ((spy_res or {}).get("bars") or [])
            ],
            "fetched_utc": datetime.now(timezone.utc).isoformat(),
        }

    if cache is None:
        return await _fetch_all()

    res = await cache.get_or_fetch(
        cache_key,
        provider="yahoo_finance",
        fetcher=_fetch_all,
        soft_ttl_seconds=180,
        hard_ttl_seconds=86400 * 3,
        force_refresh=force_refresh,
    )
    data = dict(res.data or {})
    data["is_stale"] = res.is_stale
    return data


def _to_yahoo_symbol(symbol: str) -> str:
    sym = symbol.upper().strip()
    if sym == "BTCUSDT":
        return "BTC-USD"
    return sym.replace(".", "-")


def _parse_intraday_result(
    res0: dict[str, Any],
    *,
    last_day_only: bool,
    is_crypto: bool = False,
) -> tuple[list[dict[str, Any]], float | None, float | None, dict[str, Any] | None]:
    meta = res0.get("meta") or {}
    timestamps = res0.get("timestamp") or []
    quote = ((res0.get("indicators") or {}).get("quote") or [{}])[0]
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []

    ctp = meta.get("currentTradingPeriod") or {}
    pre_p = ctp.get("pre") or {}
    reg_p = ctp.get("regular") or {}
    post_p = ctp.get("post") or {}
    reg_start = int(reg_p.get("start") or 0)
    reg_end = int(reg_p.get("end") or 0)
    pre_start = int(pre_p.get("start") or 0)
    post_end = int(post_p.get("end") or 0)

    def _classify_session(ts_s: int, ny_dt: datetime) -> str:
        if is_crypto:
            return "regular"
        # Use currentTradingPeriod when it actually spans this bar's session
        # (handles US half-days). During overnight / weekends / 5D prior days,
        # Yahoo advances currentTradingPeriod forward, so fall back to ET clock.
        if reg_start and reg_end:
            effective_pre = pre_start or (reg_start - 19800)
            effective_post_end = (post_end + 3600) if post_end else (reg_end + 18000)
            if effective_pre <= ts_s <= effective_post_end:
                if reg_start <= ts_s < reg_end:
                    return "regular"
                if ts_s < reg_start:
                    return "pre"
                return "post"
        mins = ny_dt.hour * 60 + ny_dt.minute
        if 240 <= mins < 570:
            return "pre"
        if 570 <= mins < 960:
            return "regular"
        if 960 <= mins <= 1205:
            return "post"
        return "regular"

    ny_tz = ZoneInfo("America/New_York")
    parsed: list[dict[str, Any]] = []
    n = min(len(timestamps), len(closes))
    for i in range(n):
        c_val = closes[i]
        if c_val is None:
            continue
        ts_sec = int(timestamps[i])
        ny_dt = datetime.fromtimestamp(ts_sec, tz=timezone.utc).astimezone(ny_tz)
        ny_day = ny_dt.date().isoformat()
        c = float(c_val)
        o = float(opens[i]) if i < len(opens) and opens[i] is not None else c
        h = float(highs[i]) if i < len(highs) and highs[i] is not None else max(o, c)
        l_val = float(lows[i]) if i < len(lows) and lows[i] is not None else min(o, c)
        v = float(volumes[i]) if i < len(volumes) and volumes[i] is not None else 0.0
        parsed.append(
            {
                "time": ts_sec,
                "ny_date": ny_day,
                "session": _classify_session(ts_sec, ny_dt),
                "open": round(o, 4),
                "high": round(max(h, o, c), 4),
                "low": round(min(l_val, o, c), 4),
                "close": round(c, 4),
                "volume": round(v, 2),
            }
        )

    # Capture latest regular-session close across full multi-day payload BEFORE 1D trim
    full_reg_close: float | None = None
    for row in parsed:
        if row.get("session") == "regular":
            full_reg_close = float(row["close"])

    if last_day_only and parsed:
        latest_day = parsed[-1]["ny_date"]
        parsed = [row for row in parsed if row["ny_date"] == latest_day]

    # Per-session cumulative VWAP
    curr_day: str | None = None
    cum_pv = 0.0
    cum_v = 0.0
    last_reg_close: float | None = None
    for row in parsed:
        if row["ny_date"] != curr_day:
            curr_day = str(row["ny_date"])
            cum_pv = 0.0
            cum_v = 0.0
        if row.get("session") == "regular":
            last_reg_close = float(row["close"])
        tp = (float(row["high"]) + float(row["low"]) + float(row["close"])) / 3.0
        vol = float(row["volume"])
        if vol > 0:
            cum_pv += tp * vol
            cum_v += vol
        row["vwap"] = round(cum_pv / cum_v, 4) if cum_v > 0 else round(float(row["close"]), 4)
        row.pop("ny_date", None)

    spot = float(meta["regularMarketPrice"]) if meta.get("regularMarketPrice") is not None else None
    prev_close = (
        float(meta["previousClose"])
        if meta.get("previousClose") is not None
        else (full_reg_close if full_reg_close is not None else None)
    )

    extended_info: dict[str, Any] | None = None
    if parsed:
        last_bar = parsed[-1]
        last_sess = str(last_bar.get("session") or "regular")
        last_ext_price = round(float(last_bar["close"]), 2)
        if last_sess == "pre":
            ref_base = full_reg_close or prev_close or spot or last_ext_price
            ext_chg = round(((last_ext_price / ref_base) - 1.0) * 100.0, 2) if ref_base > 0 else None
            extended_info = {
                "session": "pre",
                "label_zh": "盘前",
                "price": last_ext_price,
                "change_pct": ext_chg,
                "regular_price": round(ref_base, 2),
            }
        elif last_sess == "post":
            ref_base = last_reg_close or spot or full_reg_close or last_ext_price
            ext_chg = round(((last_ext_price / ref_base) - 1.0) * 100.0, 2) if ref_base > 0 else None
            extended_info = {
                "session": "post",
                "label_zh": "盘后",
                "price": last_ext_price,
                "change_pct": ext_chg,
                "regular_price": round(ref_base, 2),
            }

    return parsed, spot, prev_close, extended_info


async def fetch_yahoo_intraday_bars(
    symbol: str,
    *,
    tf: str = "1d",
    cache: DualTTLCache | None = None,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Fetch 5m (1d) or 15m (5d) intraday + Pre/Post-Market OHLCV and VWAP for any ticker."""
    sym = symbol.upper().strip()
    norm_tf = "5d" if tf.lower().strip() == "5d" else "1d"
    is_crypto = sym.endswith("USDT")
    cache_key = f"marketelite:yahoo:intraday:{sym}:{norm_tf}:v3"

    async def _fetch() -> dict[str, Any]:
        y_sym = _to_yahoo_symbol(sym)
        url = _YAHOO_CHART_URL.format(symbol=y_sym)
        range_str, interval_str = ("5d", "15m") if norm_tf == "5d" else ("2d", "5m")
        params: dict[str, str] = {"range": range_str, "interval": interval_str}
        if not is_crypto:
            params["includePrePost"] = "true"
        async with httpx.AsyncClient(headers=_DEFAULT_HEADERS, timeout=10.0) as client:
            resp = await client.get(url, params=params)
            raise_for_provider_response(resp, "yahoo_finance")
            res_list = (resp.json().get("chart") or {}).get("result") or []
            if not res_list:
                return {"symbol": sym, "tf": norm_tf, "interval": interval_str, "bars": []}
            bars, spot, prev_close, extended_info = _parse_intraday_result(
                res_list[0],
                last_day_only=(norm_tf == "1d"),
                is_crypto=is_crypto,
            )
            return {
                "symbol": sym,
                "tf": norm_tf,
                "interval": interval_str,
                "spot_price": round(spot, 4) if spot is not None else None,
                "prev_close": round(prev_close, 4) if prev_close is not None else None,
                "extended_hours": extended_info if not is_crypto else None,
                "bars": bars,
            }

    if cache is None:
        return await _fetch()

    res = await cache.get_or_fetch(
        cache_key,
        provider="yahoo_finance",
        fetcher=_fetch,
        soft_ttl_seconds=60,
        hard_ttl_seconds=86400,
        force_refresh=force_refresh,
    )
    data = dict(res.data or {})
    data["is_stale"] = res.is_stale
    return data


async def fetch_yahoo_extended_quotes(
    symbols: list[str],
    *,
    cache: DualTTLCache | None = None,
) -> dict[str, dict[str, Any]]:
    """Fetch lightweight pre-market / after-hours quote snapshot per equity symbol."""
    clean = [
        s.upper().strip()
        for s in symbols
        if s and not s.upper().endswith("USDT")
    ]
    if not clean:
        return {}

    async def _one(sym: str) -> tuple[str, dict[str, Any] | None]:
        try:
            res = await fetch_yahoo_intraday_bars(sym, tf="1d", cache=cache)
            ext = res.get("extended_hours")
            if isinstance(ext, dict):
                return sym, ext
            return sym, None
        except (ProviderError, httpx.HTTPError, OSError, ValueError):
            return sym, None

    pairs = await asyncio.gather(*(_one(s) for s in clean), return_exceptions=False)
    return {sym: info for sym, info in pairs if info is not None}

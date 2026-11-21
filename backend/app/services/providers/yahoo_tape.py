from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

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


MACRO_TAPE_SPECS: tuple[MacroTapeSpec, ...] = (
    MacroTapeSpec("^GSPC", "SPY", "S&P 500", "标普 500", 2, ""),
    MacroTapeSpec("^DJI", "DIA", "Dow 30", "道琼斯 30", 2, ""),
    MacroTapeSpec("^IXIC", "QQQ", "Nasdaq", "纳斯达克", 2, ""),
    MacroTapeSpec("^RUT", "IWM", "Russell 2000", "罗素 2000", 2, ""),
    MacroTapeSpec("^TNX", "TLT", "10-Yr Bond", "10年美债", 4, "%"),
    MacroTapeSpec("^VIX", "SPY", "VIX", "恐慌指数", 2, ""),
    MacroTapeSpec("DX-Y.NYB", "UUP", "DXY Dollar", "美元指数", 2, ""),
    MacroTapeSpec("GC=F", "GLD", "Gold", "黄金", 2, "$"),
    MacroTapeSpec("SI=F", "SLV", "Silver", "白银", 2, "$"),
    MacroTapeSpec("CL=F", "USO", "WTI Crude", "WTI 原油", 2, "$"),
    MacroTapeSpec("BZ=F", "BNO", "Brent Crude", "布伦特油", 2, "$"),
    MacroTapeSpec("HG=F", "CPER", "Copper", "精铜期货", 3, "$"),
    MacroTapeSpec("NG=F", "UNG", "Nat Gas", "天然气", 3, "$"),
    MacroTapeSpec("BTC-USD", "BTCUSDT", "Bitcoin", "比特币", 0, "$"),
    MacroTapeSpec("ETH-USD", "BTCUSDT", "Ethereum", "以太坊", 2, "$"),
)

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


async def _fetch_single_spec(
    client: httpx.AsyncClient,
    spec: MacroTapeSpec,
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

        prev_raw = meta.get("chartPreviousClose") or meta.get("previousClose")
        prev_close = float(prev_raw) if prev_raw is not None else (float(bars[0]["o"]) if bars else price)
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
    """Return global multi-asset ticker strip with real OHLC micro-bars and prev-close reference."""
    cache_key = "marketelite:macro:tape:v1"

    async def _fetch_all() -> dict[str, Any]:
        async with httpx.AsyncClient(headers=_DEFAULT_HEADERS, timeout=8.0) as client:
            results = await asyncio.gather(
                *(_fetch_single_spec(client, spec) for spec in MACRO_TAPE_SPECS),
                return_exceptions=False,
            )
        items = [item for item in results if item is not None]
        if not items:
            raise RuntimeError("No macro tape symbols returned from Yahoo Finance")
        return {"count": len(items), "items": items}

    if cache is None:
        data = await _fetch_all()
        return {"status": "ok", "source": "yahoo_finance", "is_stale": False, **data}

    res = await cache.get_or_fetch(
        cache_key,
        provider="yahoo_finance",
        fetcher=_fetch_all,
        soft_ttl_seconds=120,
        hard_ttl_seconds=86400 * 3,
        force_refresh=force_refresh,
    )
    return {
        "status": "ok",
        "source": res.source,
        "is_stale": res.is_stale,
        "fetched_at": res.fetched_at,
        **(res.data or {"count": 0, "items": []}),
    }

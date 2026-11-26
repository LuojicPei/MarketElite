from __future__ import annotations

import asyncio
import base64
import json
import math
import zlib
from datetime import date, datetime, timedelta
from statistics import mean, pstdev
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from redis.exceptions import RedisError

from app.services.providers.alpaca import AlpacaClient
from app.services.providers.moc_proxy import _us_market_holidays
from app.services.resilience import DualTTLCache, raise_for_provider_response

_NY_TZ = ZoneInfo("America/New_York")
_CNMS_URL_TEMPLATE = "https://cdn.finra.org/equity/regsho/daily/CNMSshvol{ymd}.txt"
_FINRA_ATS_URL = "https://api.finra.org/data/group/otcMarket/name/weeklySummary"
_YAHOO_DAILY_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

_DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ),
}

# In-process LRU cache of parsed daily CNMS maps: ymd -> dict[symbol, [short_vol, exempt_vol, trf_total_vol]]
_CNMS_DAY_MEMO: dict[str, dict[str, list[float]]] = {}
_CNMS_MISS_MEMO: set[str] = set()

_DARKPOOL_DISCLOSURE_ZH = (
    "数据与口径说明：每日场外总成交与做空成交源自美国 FINRA 官方免费公开 Reg SHO TRF 日频文件"
    "（每个美股交易日盘后约 18:00 ET 更新，非盘中逐笔点位；且日内做空成交包含做市商常规对冲，"
    "单日偏高不直接等同看空，需结合 20 日偏离与股价支撑判断）。周度 ATS 暗池单笔均额源自 FINRA "
    "OTCT Weekly Summary（按 FINRA 监管披露规则存在约 2 周披露滞后，卡片已标明统计周日期）。"
)


def _safe_float(val: Any) -> float | None:
    try:
        if val is None or val == "":
            return None
        num = float(val)
        return num if math.isfinite(num) else None
    except (TypeError, ValueError):
        return None


def parse_finra_cnms_text(raw_text: str) -> dict[str, list[float]]:
    """
    Parse FINRA CNMS daily short-sale volume pipe-delimited file into
    `{symbol: [short_vol, short_exempt_vol, trf_total_vol]}`.
    """
    parsed: dict[str, list[float]] = {}
    for line in raw_text.splitlines():
        if not line or line.startswith("Date|"):
            continue
        parts = line.split("|")
        if len(parts) < 5:
            continue
        sym = parts[1].strip().upper()
        if not sym or sym.isdigit():
            continue
        short_vol = _safe_float(parts[2])
        exempt_vol = _safe_float(parts[3]) or 0.0
        trf_total = _safe_float(parts[4])
        if short_vol is None or trf_total is None or trf_total <= 0:
            continue
        parsed[sym] = [round(short_vol, 2), round(exempt_vol, 2), round(trf_total, 2)]
    return parsed


def _recent_candidate_trading_days(count_calendar_days: int = 38) -> list[date]:
    today_ny = datetime.now(_NY_TZ).date()
    holidays_cache: dict[int, set[date]] = {}
    days: list[date] = []
    for delta in range(0, count_calendar_days):
        d = today_ny - timedelta(days=delta)
        if d.weekday() >= 5:
            continue
        h = holidays_cache.setdefault(d.year, _us_market_holidays(d.year))
        if d in h:
            continue
        days.append(d)
    return days


async def _load_cnms_day_map(
    ymd: str,
    *,
    client: httpx.AsyncClient,
    cache: DualTTLCache | None,
    age_days: int,
) -> dict[str, list[float]] | None:
    if ymd in _CNMS_DAY_MEMO:
        return _CNMS_DAY_MEMO[ymd]
    if ymd in _CNMS_MISS_MEMO and age_days > 1:
        return None

    redis_client = getattr(cache, "_redis", None)
    redis_key = f"marketelite:finra:cnms:b64z1:{ymd}"
    if redis_client is not None:
        try:
            raw_blob = await redis_client.get(redis_key)
            if raw_blob:
                if raw_blob == "__MISS__":
                    if age_days > 1:
                        _CNMS_MISS_MEMO.add(ymd)
                    return None
                raw_bytes = base64.b64decode(raw_blob.encode("ascii") if isinstance(raw_blob, str) else raw_blob)
                decompressed = zlib.decompress(raw_bytes).decode("utf-8")
                decoded = json.loads(decompressed)
                if isinstance(decoded, dict) and decoded:
                    if len(_CNMS_DAY_MEMO) > 45:
                        _CNMS_DAY_MEMO.clear()
                    _CNMS_DAY_MEMO[ymd] = decoded
                    return decoded
        except (OSError, zlib.error, ValueError, RedisError):
            pass

    url = _CNMS_URL_TEMPLATE.format(ymd=ymd)
    try:
        resp = await client.get(url, timeout=8.0)
    except httpx.HTTPError:
        return None

    if resp.status_code in (403, 404):
        if age_days > 1:
            _CNMS_MISS_MEMO.add(ymd)
        if redis_client is not None:
            ttl = 1800 if age_days <= 1 else 86400 * 7
            try:
                await redis_client.setex(redis_key, ttl, "__MISS__")
            except (OSError, RedisError):
                pass
        return None

    if resp.status_code != 200:
        return None

    day_map = parse_finra_cnms_text(resp.text)
    if not day_map:
        return None

    if len(_CNMS_DAY_MEMO) > 45:
        _CNMS_DAY_MEMO.clear()
    _CNMS_DAY_MEMO[ymd] = day_map

    if redis_client is not None:
        try:
            compressed = zlib.compress(json.dumps(day_map, separators=(",", ":")).encode("utf-8"), level=6)
            b64_str = base64.b64encode(compressed).decode("ascii")
            ttl = 21600 if age_days <= 2 else 86400 * 14
            await redis_client.setex(redis_key, ttl, b64_str)
        except (OSError, zlib.error, ValueError, RedisError):
            pass

    return day_map


async def _fetch_daily_equity_ohlcv(
    symbol: str,
    *,
    alpaca_client: AlpacaClient | None,
) -> dict[str, dict[str, float]]:
    """Return `{YYYY-MM-DD: {'close': float, 'volume': float}}` covering ~45 trading days."""
    daily_map: dict[str, dict[str, float]] = {}

    try:
        url = _YAHOO_DAILY_URL.format(symbol=symbol)
        async with httpx.AsyncClient(headers=_DEFAULT_HEADERS, timeout=10.0) as client:
            resp = await client.get(url, params={"range": "3mo", "interval": "1d"})
            if resp.status_code == 200:
                res_list = (resp.json().get("chart") or {}).get("result") or []
                if res_list:
                    node = res_list[0]
                    ts_list = node.get("timestamp") or []
                    q = ((node.get("indicators") or {}).get("quote") or [{}])[0]
                    closes = q.get("close") or []
                    vols = q.get("volume") or []
                    for i, ts_val in enumerate(ts_list):
                        cl = _safe_float(closes[i] if i < len(closes) else None)
                        vo = _safe_float(vols[i] if i < len(vols) else None)
                        if cl is None or cl <= 0 or vo is None or vo <= 0:
                            continue
                        dt_ny = datetime.fromtimestamp(int(ts_val), tz=_NY_TZ).strftime("%Y-%m-%d")
                        daily_map[dt_ny] = {"close": round(cl, 2), "volume": float(vo)}
    except (httpx.HTTPError, ValueError):
        pass

    if daily_map or alpaca_client is None:
        return daily_map

    try:
        bar_res = await alpaca_client.get_daily_bars([symbol], lookback_days=75)
        bars = (bar_res.get("bars") or {}).get(symbol) or []
        for b in bars:
            d_str = str(b.get("date", ""))[:10]
            cl = _safe_float(b.get("close"))
            vo = _safe_float(b.get("volume"))
            if d_str and cl and vo and vo > 0:
                daily_map[d_str] = {"close": round(cl, 2), "volume": float(vo)}
    except Exception:
        pass

    return daily_map


async def _fetch_finra_ats_weekly(
    symbol: str, *, cache: DualTTLCache | None, force_refresh: bool
) -> dict[str, Any]:
    """Fetch FINRA OTCT Weekly Summary ATS dark pool stats for `symbol`."""
    sym = symbol.upper().strip()
    cache_key = f"marketelite:finra:ats_weekly:{sym}:v1"

    async def _fetch() -> dict[str, Any]:
        today_ny = datetime.now(_NY_TZ).date()
        start_d = (today_ny - timedelta(days=130)).isoformat()
        end_d = today_ny.isoformat()
        payload = {
            "compareFilters": [
                {"compareType": "EQUAL", "fieldName": "issueSymbolIdentifier", "fieldValue": sym},
                {"compareType": "EQUAL", "fieldName": "summaryTypeCode", "fieldValue": "ATS_W_SMBL"},
            ],
            "dateRangeFilters": [
                {"fieldName": "weekStartDate", "startDate": start_d, "endDate": end_d}
            ],
            "limit": 16,
        }
        async with httpx.AsyncClient(headers={"Accept": "application/json"}, timeout=10.0) as client:
            resp = await client.post(_FINRA_ATS_URL, json=payload)
            if resp.status_code == 204 or not resp.text.strip():
                return {"weeks": [], "latest": None}
            raise_for_provider_response(resp, "finra_ats")
            rows = resp.json()
            if not isinstance(rows, list):
                return {"weeks": [], "latest": None}

        weeks: list[dict[str, Any]] = []
        for row in rows:
            wk = str(row.get("weekStartDate") or "")[:10]
            shares = _safe_float(row.get("totalWeeklyShareQuantity"))
            notional = _safe_float(row.get("totalNotionalSum"))
            trades = _safe_float(row.get("totalWeeklyTradeCount"))
            if not wk or shares is None or shares <= 0:
                continue
            avg_trade_usd = (
                round(notional / trades, 0) if (notional and trades and trades > 0) else None
            )
            weeks.append(
                {
                    "week_start_date": wk,
                    "last_reported_date": str(row.get("lastReportedDate") or "")[:10] or None,
                    "last_update_date": str(row.get("lastUpdateDate") or "")[:10] or None,
                    "total_shares": int(round(shares)),
                    "total_notional_usd": round(notional, 0) if notional is not None else None,
                    "total_trades": int(round(trades)) if trades is not None else None,
                    "avg_trade_usd": avg_trade_usd,
                    "tier": row.get("tierDescription") or row.get("tierIdentifier"),
                }
            )
        weeks.sort(key=lambda w: w["week_start_date"])
        recent_weeks = weeks[-6:]
        return {"weeks": recent_weeks, "latest": recent_weeks[-1] if recent_weeks else None}

    if cache is None:
        return await _fetch()

    try:
        res = await cache.get_or_fetch(
            cache_key,
            provider="finra_ats",
            fetcher=_fetch,
            soft_ttl_seconds=21600,
            hard_ttl_seconds=86400 * 7,
            force_refresh=force_refresh,
        )
        return dict(res.data or {"weeks": [], "latest": None})
    except Exception:
        return {"weeks": [], "latest": None}


def build_darkpool_profile(
    symbol: str,
    daily_points: list[dict[str, Any]],
    ats_summary: dict[str, Any],
) -> dict[str, Any]:
    """Assemble clean FINRA TRF + ATS diagnostics and plain-Chinese interpretation."""
    if not daily_points:
        return {
            "status": "unavailable",
            "symbol": symbol,
            "reason": f"未在 FINRA 公开 TRF 名单中检索到 {symbol} 的近期场外成交记录（可能为非美股NMS挂牌代码或极低频OTC）",
            "series_20d": [],
            "ats_weekly": ats_summary,
            "methodology_note_zh": _DARKPOOL_DISCLOSURE_ZH,
        }

    pts = sorted(daily_points, key=lambda p: p["date"])[-20:]
    latest = pts[-1]
    off_list = [p["off_exchange_pct"] for p in pts if p.get("off_exchange_pct") is not None]
    short_list = [p["short_ratio_pct"] for p in pts]

    avg_off_20d = round(mean(off_list), 2) if off_list else None
    avg_short_20d = round(mean(short_list), 2) if short_list else None
    short_std = pstdev(short_list) if len(short_list) >= 3 else 0.0
    short_z = (
        round((latest["short_ratio_pct"] - avg_short_20d) / max(short_std, 0.5), 2)
        if avg_short_20d is not None
        else 0.0
    )

    off_latest = latest.get("off_exchange_pct")
    off_diff_pp = (
        round(off_latest - avg_off_20d, 1)
        if off_latest is not None and avg_off_20d is not None
        else None
    )

    closes = [p["close"] for p in pts if p.get("close")]
    ret_5d_pct: float | None = None
    if len(closes) >= 6 and closes[-6] > 0:
        ret_5d_pct = round(((closes[-1] - closes[-6]) / closes[-6]) * 100.0, 2)

    if short_z >= 1.5 and ret_5d_pct is not None and ret_5d_pct < 0:
        signal_tone = "bearish"
        headline_zh = (
            f"{symbol} 场外做空成交占比升至 {latest['short_ratio_pct']:.1f}%（高于20日均值 +{short_z:.1f}σ）"
            f"且近5日走弱（{ret_5d_pct:+.1f}%），留意机构对冲或派发压力"
        )
    elif off_diff_pp is not None and off_diff_pp >= 3.0 and ret_5d_pct is not None and ret_5d_pct >= 0:
        signal_tone = "bullish"
        headline_zh = (
            f"{symbol} 场外暗池占比活跃（{off_latest:.1f}%，高于均值 +{off_diff_pp:.1f}pct）"
            f"且股价稳住（5日 {ret_5d_pct:+.1f}%），偏向机构暗中承接托底"
        )
    elif abs(short_z) >= 1.5:
        signal_tone = "warning"
        tag = "显著偏高" if short_z > 0 else "显著回落"
        headline_zh = (
            f"{symbol} 场外做空成交占比{tag}（{latest['short_ratio_pct']:.1f}% · {short_z:+.1f}σ），"
            f"当前场外总占比 {off_latest:.1f}%"
            if off_latest is not None
            else f"{symbol} 场外做空成交占比{tag}（{latest['short_ratio_pct']:.1f}% · {short_z:+.1f}σ）"
        )
    else:
        signal_tone = "neutral"
        off_txt = f"场外占比 {off_latest:.1f}%、" if off_latest is not None else ""
        headline_zh = (
            f"{symbol} 场外暗池交投平稳：{off_txt}做空成交比 {latest['short_ratio_pct']:.1f}%"
            f"（贴近20日均值 {avg_short_20d:.1f}%）"
        )

    return {
        "status": "ok",
        "symbol": symbol,
        "latest_date": latest["date"],
        "latest": {
            **latest,
            "avg_off_exchange_20d": avg_off_20d,
            "off_exchange_diff_pp": off_diff_pp,
            "avg_short_ratio_20d": avg_short_20d,
            "short_ratio_z": short_z,
            "ret_5d_pct": ret_5d_pct,
        },
        "signal_tone": signal_tone,
        "headline_zh": headline_zh,
        "series_20d": pts,
        "ats_weekly": ats_summary,
        "methodology_note_zh": _DARKPOOL_DISCLOSURE_ZH,
    }


async def fetch_finra_darkpool_profile(
    symbol: str = "SPY",
    *,
    alpaca_client: AlpacaClient | None = None,
    cache: DualTTLCache | None = None,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Fetch FINRA Reg SHO daily TRF volume + OTCT weekly ATS dark pool summary for `symbol`."""
    sym = symbol.upper().strip() or "SPY"
    if sym.endswith("USDT") or sym in {"VIX", "^VIX", "DXY", "BTC", "ETH"}:
        return {
            "status": "unsupported",
            "symbol": sym,
            "reason": f"{sym} 非美国证监会/FINRA 监管的 NMS 股票或 ETF，无美股暗池（TRF/ATS）数据；请搜索 SPY、QQQ 或任意美股代码",
            "series_20d": [],
            "ats_weekly": {"weeks": [], "latest": None},
            "methodology_note_zh": _DARKPOOL_DISCLOSURE_ZH,
        }

    candidate_days = _recent_candidate_trading_days(38)
    today_ny = datetime.now(_NY_TZ).date()

    async def _collect_trf() -> dict[str, dict[str, float]]:
        sem = asyncio.Semaphore(6)
        results: dict[str, dict[str, float]] = {}

        async with httpx.AsyncClient(headers=_DEFAULT_HEADERS) as client:
            async def _one(d: date) -> None:
                ymd = d.strftime("%Y%m%d")
                iso = d.isoformat()
                age = (today_ny - d).days
                async with sem:
                    day_map = await _load_cnms_day_map(
                        ymd, client=client, cache=cache, age_days=age
                    )
                if day_map and sym in day_map:
                    sv, sev, tot = day_map[sym]
                    results[iso] = {
                        "short_volume": sv,
                        "short_exempt_volume": sev,
                        "trf_total_volume": tot,
                    }

            await asyncio.gather(*(_one(d) for d in candidate_days))
        return results

    trf_by_date, ohlcv_by_date, ats_summary = await asyncio.gather(
        _collect_trf(),
        _fetch_daily_equity_ohlcv(sym, alpaca_client=alpaca_client),
        _fetch_finra_ats_weekly(sym, cache=cache, force_refresh=force_refresh),
    )

    daily_points: list[dict[str, Any]] = []
    for d_iso, trf in sorted(trf_by_date.items()):
        bar = ohlcv_by_date.get(d_iso)
        trf_tot = trf["trf_total_volume"]
        short_v = trf["short_volume"]
        cons_vol = float(bar["volume"]) if bar and bar.get("volume", 0) > 0 else None
        if cons_vol is not None and cons_vol < trf_tot:
            cons_vol = trf_tot
        off_pct = round((trf_tot / cons_vol) * 100.0, 2) if cons_vol else None
        short_ratio = round((short_v / trf_tot) * 100.0, 2) if trf_tot > 0 else 0.0
        daily_points.append(
            {
                "date": d_iso,
                "label": d_iso[5:],
                "close": bar["close"] if bar else None,
                "consolidated_volume": int(round(cons_vol)) if cons_vol else None,
                "trf_total_volume": int(round(trf_tot)),
                "short_volume": int(round(short_v)),
                "short_exempt_volume": int(round(trf["short_exempt_volume"])),
                "off_exchange_pct": off_pct,
                "short_ratio_pct": short_ratio,
            }
        )

    return build_darkpool_profile(sym, daily_points, ats_summary)

from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from statistics import mean
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from app.services.resilience import DualTTLCache, raise_for_provider_response

_NY_TZ = ZoneInfo("America/New_York")
_YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
_DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json,text/plain,*/*",
}

_MOC_DISCLOSURE_ZH = (
    "口径说明：交易所 15:50 ET 官方实时 MOC 未成交挂单净差额（NYSE NOI / Nasdaq NOII）"
    "属收费版权流，本平台无法直接获取。本模块展示的「尾盘量能占比」与「尾盘冲量方向」"
    "均由系统基于分钟线（常规时段最后 15 分钟成交量 ÷ 全天常规总成交量）实时算出的"
    "量化代理指标（Proxy），仅作尾盘异动辅助监控，不代表交易所官方委托盘口。"
)


def _safe_float(val: Any) -> float | None:
    try:
        if val is None or val == "":
            return None
        num = float(val)
        return num if math.isfinite(num) else None
    except (TypeError, ValueError):
        return None


def _nth_weekday(year: int, month: int, weekday: int, nth: int) -> date:
    """Return the nth (1-based) target weekday in a calendar month."""
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    day = 1 + offset + (nth - 1) * 7
    return date(year, month, day)


def _last_weekday_of_month(year: int, month: int, weekday: int) -> date:
    """Return the final occurrence of `weekday` (Mon=0..Sun=6) in `month`."""
    next_month = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    cursor = next_month - timedelta(days=1)
    while cursor.weekday() != weekday:
        cursor -= timedelta(days=1)
    return cursor


def _observed_date(d: date) -> date:
    if d.weekday() == 5:
        return d - timedelta(days=1)
    if d.weekday() == 6:
        return d + timedelta(days=1)
    return d


def _us_market_holidays(year: int) -> set[date]:
    """Compute major NYSE/Nasdaq full-day closures (aligned with frontend marketEvents.ts)."""
    holidays = {
        _observed_date(date(year, 1, 1)),
        _nth_weekday(year, 1, 0, 3),  # MLK Day
        _nth_weekday(year, 2, 0, 3),  # Presidents Day
        _last_weekday_of_month(year, 5, 0),  # Memorial Day
        _observed_date(date(year, 6, 19)),  # Juneteenth
        _observed_date(date(year, 7, 4)),  # Independence Day
        _nth_weekday(year, 9, 0, 1),  # Labor Day
        _nth_weekday(year, 11, 3, 4),  # Thanksgiving
        _observed_date(date(year, 12, 25)),  # Christmas
    }
    # Good Friday (Butcher's Easter algorithm minus 2 days)
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    easter = date(year, month, day)
    holidays.add(easter - timedelta(days=2))
    return holidays


def get_next_rebalance_window(ref_date: date | None = None) -> dict[str, Any]:
    """Identify the nearest structural US closing-auction / rebalance event from `ref_date` (ET)."""
    today_ny = ref_date or datetime.now(_NY_TZ).date()
    candidates: list[dict[str, Any]] = []

    for offset_m in range(0, 4):
        raw_m = today_ny.month - 1 + offset_m
        yr = today_ny.year + raw_m // 12
        mo = (raw_m % 12) + 1
        holidays = _us_market_holidays(yr)

        next_mo = date(yr + 1, 1, 1) if mo == 12 else date(yr, mo + 1, 1)
        trading_days: list[date] = []
        cur = date(yr, mo, 1)
        while cur < next_mo:
            if cur.weekday() < 5 and cur not in holidays:
                trading_days.append(cur)
            cur += timedelta(days=1)

        if not trading_days:
            continue

        last_td = trading_days[-1]
        is_quarter = mo in (3, 6, 9, 12)

        if is_quarter and len(trading_days) >= 3:
            pension_start = trading_days[-3]
            if pension_start >= today_ny:
                candidates.append(
                    {
                        "title_zh": "季末养老金 60/40 再平衡",
                        "tag_zh": "强调仓窗口",
                        "date": pension_start.isoformat(),
                        "days_away": (pension_start - today_ny).days,
                        "impact": "high",
                    }
                )
        if last_td >= today_ny:
            candidates.append(
                {
                    "title_zh": "季末机构尾盘再平衡" if is_quarter else "月末机构尾盘再平衡",
                    "tag_zh": "MOC 调仓",
                    "date": last_td.isoformat(),
                    "days_away": (last_td - today_ny).days,
                    "impact": "high" if is_quarter else "medium",
                }
            )

        if mo in (3, 6, 9, 12):
            quad = _nth_weekday(yr, mo, 4, 3)
            if quad in holidays:
                quad -= timedelta(days=1)
            if quad >= today_ny:
                candidates.append(
                    {
                        "title_zh": "四巫日 + 指数季调尾盘竞价",
                        "tag_zh": "极高换手",
                        "date": quad.isoformat(),
                        "days_away": (quad - today_ny).days,
                        "impact": "high",
                    }
                )

        if mo in (2, 5, 8, 11) and last_td >= today_ny:
            candidates.append(
                {
                    "title_zh": "MSCI 全球指数成分调仓生效",
                    "tag_zh": "指数尾盘",
                    "date": last_td.isoformat(),
                    "days_away": (last_td - today_ny).days,
                    "impact": "medium",
                }
            )

        if mo == 6:
            russell = _last_weekday_of_month(yr, 6, 4)
            if russell in holidays:
                russell -= timedelta(days=1)
            if russell >= today_ny:
                candidates.append(
                    {
                        "title_zh": "罗素指数年度重平衡收盘",
                        "tag_zh": "中小盘爆量",
                        "date": russell.isoformat(),
                        "days_away": (russell - today_ny).days,
                        "impact": "high",
                    }
                )

    if not candidates:
        return {
            "title_zh": "常规月末再平衡",
            "tag_zh": "MOC 窗口",
            "date": today_ny.isoformat(),
            "days_away": 15,
            "impact": "medium",
        }

    candidates.sort(key=lambda c: (c["days_away"], 0 if c["impact"] == "high" else 1))
    return candidates[0]


def compute_moc_proxy_from_bars(
    symbol: str,
    bars: list[dict[str, Any]],
    *,
    now_ny: datetime | None = None,
) -> dict[str, Any]:
    """
    Pure deterministic calculator computing closing-auction volume surge & impulse proxy
    from regular-trading-hours 15m intraday bars (`09:30–16:00 ET`).
    """
    ref_now = now_ny or datetime.now(_NY_TZ)
    by_day: dict[str, list[dict[str, Any]]] = {}

    for bar in bars:
        ts_s = bar.get("ts")
        vol = _safe_float(bar.get("v"))
        close_p = _safe_float(bar.get("c"))
        open_p = _safe_float(bar.get("o"))
        if ts_s is None or vol is None or close_p is None or close_p <= 0:
            continue
        dt_ny = datetime.fromtimestamp(int(ts_s), tz=_NY_TZ)
        # Keep regular US equity session bars only (09:30 <= bar_start < 16:00)
        hhmm = dt_ny.hour * 60 + dt_ny.minute
        if hhmm < 9 * 60 + 30 or hhmm >= 16 * 60:
            continue
        day_key = dt_ny.strftime("%Y-%m-%d")
        by_day.setdefault(day_key, []).append(
            {
                "ts": int(ts_s),
                "hhmm": hhmm,
                "time_et": dt_ny.strftime("%H:%M"),
                "o": open_p if open_p and open_p > 0 else close_p,
                "c": close_p,
                "v": max(0.0, vol),
            }
        )

    day_sessions: list[dict[str, Any]] = []
    intraday_status = "closed_ready"
    intraday_status_zh = "已采样最新收盘尾盘 15m 数据"

    sorted_days = sorted(by_day.keys())
    for day_key in sorted_days:
        day_bars = sorted(by_day[day_key], key=lambda b: b["ts"])
        if len(day_bars) < 8:
            # Skip incomplete early-morning session if still mid-day
            if day_key == ref_now.strftime("%Y-%m-%d") and ref_now.hour * 60 + ref_now.minute < 15 * 60 + 45:
                intraday_status = "mid_session_waiting"
                intraday_status_zh = "美股盘中进行中 · 将于 15:45 ET 开启今日尾盘采样，先展示近10个已收盘交易日"
            continue

        last_bar = day_bars[-1]
        is_today = day_key == ref_now.strftime("%Y-%m-%d")
        # Regular full day closing bar starts at 15:45 ET (945); Black Friday half-day ends 12:45 ET (765)
        if is_today and last_bar["hhmm"] < 12 * 60 + 45:
            intraday_status = "mid_session_waiting"
            intraday_status_zh = "美股盘中进行中 · 将于 15:45 ET 开启今日尾盘采样，先展示近10个已收盘交易日"
            continue

        # Exclude incomplete current afternoon if market is between 13:15 and 15:45 on a non-half-day
        if is_today and 13 * 60 + 15 <= last_bar["hhmm"] < 15 * 60 + 45 and ref_now.hour * 60 + ref_now.minute < 16 * 60:
            intraday_status = "mid_session_waiting"
            intraday_status_zh = "美股盘中进行中 · 将于 15:45 ET 开启今日尾盘采样，先展示近10个已收盘交易日"
            continue

        total_vol = sum(b["v"] for b in day_bars)
        if total_vol <= 0:
            continue

        tail_vol = last_bar["v"]
        prev_ref = day_bars[-2]["c"] if len(day_bars) >= 2 else last_bar["o"]
        tail_ret_pct = ((last_bar["c"] - prev_ref) / prev_ref) * 100.0 if prev_ref > 0 else 0.0
        tail_share_pct = (tail_vol / total_vol) * 100.0

        day_sessions.append(
            {
                "date": day_key,
                "label": day_key[5:],
                "tail_window_et": f"{last_bar['time_et']}–{'13:00' if last_bar['hhmm'] == 765 else '16:00'}",
                "is_half_day": last_bar["hhmm"] == 765,
                "close_price": round(last_bar["c"], 2),
                "total_volume": int(round(total_vol)),
                "tail_volume": int(round(tail_vol)),
                "tail_share_pct": round(tail_share_pct, 2),
                "tail_return_pct": round(tail_ret_pct, 3),
                "direction": (
                    "up" if tail_ret_pct >= 0.05 else "down" if tail_ret_pct <= -0.05 else "flat"
                ),
            }
        )

    recent_sessions = day_sessions[-10:]
    if not recent_sessions:
        next_rebal = get_next_rebalance_window(ref_now.date())
        return {
            "status": "unavailable",
            "symbol": symbol,
            "intraday_status": intraday_status,
            "intraday_status_zh": "暂无足够的分钟线尾盘数据",
            "latest": None,
            "baseline_avg_tail_pct": None,
            "alert_threshold_pct": None,
            "surge_ratio": None,
            "signal_tone": "neutral",
            "headline_zh": f"{symbol} 尾盘分钟线暂未就绪，请稍后刷新",
            "impulse_label_zh": "暂缺",
            "next_rebalance": next_rebal,
            "series_10d": [],
            "methodology_note_zh": _MOC_DISCLOSURE_ZH,
        }

    baseline_avg = round(mean(s["tail_share_pct"] for s in recent_sessions), 2)
    alert_threshold = round(max(18.0, baseline_avg * 1.5), 2)
    latest = recent_sessions[-1]
    surge_ratio = round(latest["tail_share_pct"] / max(baseline_avg, 0.1), 2)
    tail_ret = latest["tail_return_pct"]

    if surge_ratio >= 1.45 and tail_ret >= 0.08:
        impulse_label_zh = "放量尾盘抢筹"
        signal_tone = "bullish"
    elif surge_ratio >= 1.45 and tail_ret <= -0.08:
        impulse_label_zh = "放量尾盘抛压"
        signal_tone = "bearish"
    elif surge_ratio >= 1.45:
        impulse_label_zh = "放量多空剧烈换手"
        signal_tone = "warning"
    elif tail_ret >= 0.12:
        impulse_label_zh = "温和偏买"
        signal_tone = "bullish"
    elif tail_ret <= -0.12:
        impulse_label_zh = "温和偏卖"
        signal_tone = "bearish"
    else:
        impulse_label_zh = "尾盘平稳均衡"
        signal_tone = "neutral"

    next_rebal = get_next_rebalance_window(ref_now.date())
    days_away = int(next_rebal.get("days_away", 99))

    if surge_ratio >= 1.5:
        headline_zh = (
            f"近期尾盘明显放量（{latest['date'][5:]} 占全天 {latest['tail_share_pct']:.1f}% · "
            f"10日均值 {surge_ratio:.2f}x），呈现{impulse_label_zh}特征"
        )
    elif days_away <= 3:
        signal_tone = "warning" if signal_tone == "neutral" else signal_tone
        headline_zh = (
            f"临近{next_rebal['title_zh']}（{days_away}天后）· "
            f"近1日尾盘占比 {latest['tail_share_pct']:.1f}%（暂处常规区间），谨防末尾10分钟被动盘脉冲"
        )
    else:
        headline_zh = (
            f"{symbol} 尾盘资金平稳 · 近1日最后15分钟占全天 {latest['tail_share_pct']:.1f}%"
            f"（10日均值 {baseline_avg:.1f}%），{impulse_label_zh}"
        )

    return {
        "status": "ok",
        "symbol": symbol,
        "intraday_status": intraday_status,
        "intraday_status_zh": intraday_status_zh,
        "latest": latest,
        "baseline_avg_tail_pct": baseline_avg,
        "alert_threshold_pct": alert_threshold,
        "surge_ratio": surge_ratio,
        "signal_tone": signal_tone,
        "headline_zh": headline_zh,
        "impulse_label_zh": impulse_label_zh,
        "next_rebalance": next_rebal,
        "series_10d": recent_sessions,
        "methodology_note_zh": _MOC_DISCLOSURE_ZH,
    }


async def fetch_moc_auction_proxy(
    symbol: str = "SPY",
    *,
    cache: DualTTLCache | None = None,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Fetch 1-month regular-session 15m bars and compute Market-on-Close volume proxy."""
    sym = symbol.upper().strip() or "SPY"
    if sym.endswith("USDT") or sym in {"VIX", "^VIX", "DXY", "BTC", "ETH"}:
        return {
            "status": "unsupported",
            "symbol": sym,
            "reason": f"{sym} 非美股常规交易时段标的，无纽交所/纳斯达克尾盘集合竞价窗口",
            "series_10d": [],
            "next_rebalance": get_next_rebalance_window(),
            "methodology_note_zh": _MOC_DISCLOSURE_ZH,
        }

    cache_key = f"marketelite:moc:proxy:{sym}:v1"

    async def _fetch() -> dict[str, Any]:
        url = _YAHOO_CHART_URL.format(symbol=sym)
        async with httpx.AsyncClient(headers=_DEFAULT_HEADERS, timeout=12.0) as client:
            resp = await client.get(
                url,
                params={"range": "1mo", "interval": "15m", "includePrePost": "false"},
            )
            raise_for_provider_response(resp, "yahoo_moc_proxy")
            results = (resp.json().get("chart") or {}).get("result") or []
            if not results:
                return compute_moc_proxy_from_bars(sym, [])
            node = results[0]
            ts_list = node.get("timestamp") or []
            quote = ((node.get("indicators") or {}).get("quote") or [{}])[0]
            opens = quote.get("open") or []
            closes = quote.get("close") or []
            vols = quote.get("volume") or []
            bars = [
                {
                    "ts": ts_list[i],
                    "o": opens[i] if i < len(opens) else None,
                    "c": closes[i] if i < len(closes) else None,
                    "v": vols[i] if i < len(vols) else None,
                }
                for i in range(len(ts_list))
            ]
            return compute_moc_proxy_from_bars(sym, bars)

    if cache is None:
        return await _fetch()

    res = await cache.get_or_fetch(
        cache_key,
        provider="moc_proxy",
        fetcher=_fetch,
        soft_ttl_seconds=300,
        hard_ttl_seconds=86400 * 2,
        force_refresh=force_refresh,
    )
    payload = dict(res.data or {})
    payload["is_stale"] = res.is_stale
    payload["fetched_at"] = res.fetched_at
    return payload

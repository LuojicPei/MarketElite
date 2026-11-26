from __future__ import annotations

import asyncio
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from bs4 import BeautifulSoup

from app.core.config import Settings
from app.quant.macro import build_institutional_flow_summary
from app.services.resilience import (
    DualTTLCache,
    ProviderError,
    ProviderUnconfiguredError,
    raise_for_provider_response,
)

CFTC_COT_CONTRACTS: dict[str, tuple[str, str]] = {
    "ES": ("13874A", "E-mini S&P 500"),
    "NQ": ("209742", "E-mini Nasdaq-100"),
    "ZN": ("043602", "10-Year U.S. Treasury Note"),
    "GC": ("088691", "Gold COMEX"),
}

CFTC_INSTITUTIONAL_CONTRACTS: dict[str, dict[str, str]] = {
    "ES": {
        "code": "13874A",
        "dataset": "tff",
        "name": "E-mini S&P 500",
        "name_zh": "标普 500 期货",
        "bucket": "核心股指",
        "real_money_label": "长线资管 (养老/公募)",
        "leveraged_label": "对冲基金 / 杠杆热钱",
        "dealer_label": "华尔街投行自营",
    },
    "NQ": {
        "code": "209742",
        "dataset": "tff",
        "name": "E-mini Nasdaq-100",
        "name_zh": "纳指 100 期货",
        "bucket": "科技成长",
        "real_money_label": "长线资管 (养老/公募)",
        "leveraged_label": "对冲基金 / 杠杆热钱",
        "dealer_label": "华尔街投行自营",
    },
    "ZN": {
        "code": "043602",
        "dataset": "tff",
        "name": "10Y U.S. Treasury Note",
        "name_zh": "10年美债期货",
        "bucket": "无风险利率",
        "real_money_label": "长线资管 (锁息买盘)",
        "leveraged_label": "对冲基金 (含基差套利)",
        "dealer_label": "一级交易商做市",
    },
    "VX": {
        "code": "1170E1",
        "dataset": "tff",
        "name": "CBOE VIX Futures",
        "name_zh": "VIX 恐慌期货",
        "bucket": "波动率情绪",
        "real_money_label": "长线资管 (尾部对冲)",
        "leveraged_label": "对冲基金 (波动率空头)",
        "dealer_label": "投行做市商",
    },
    "GC": {
        "code": "088691",
        "dataset": "disagg",
        "name": "Gold COMEX",
        "name_zh": "COMEX 黄金期货",
        "bucket": "避险贵金属",
        "real_money_label": "黄金掉期大行/商业",
        "leveraged_label": "对冲基金 / CTA趋势盘",
        "dealer_label": "实业矿商套保盘",
    },
    "BTC": {
        "code": "133741",
        "dataset": "tff",
        "name": "CME Bitcoin Futures",
        "name_zh": "CME 比特币期货",
        "bucket": "高Beta风向",
        "real_money_label": "合规资管/ETF做市",
        "leveraged_label": "对冲基金 (含套利杠杆)",
        "dealer_label": "CME做市机构",
    },
}


class MacroFeedsClient:
    """Async clients for Binance Vision (BTC), CFTC Socrata COT, Finnhub, and FMP."""

    def __init__(
        self,
        settings: Settings,
        cache: DualTTLCache | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._settings = settings
        self._cache = cache
        self._http_client = http_client

    async def _fetch_btc_daily_bars_raw(self, limit: int = 300) -> list[dict[str, Any]]:
        url = "https://data-api.binance.vision/api/v3/klines"
        params = {"symbol": "BTCUSDT", "interval": "1d", "limit": limit}

        async def _execute(client: httpx.AsyncClient) -> list[dict[str, Any]]:
            resp = await client.get(url, params=params, timeout=15.0)
            raise_for_provider_response(resp, "binance")
            raw_rows = resp.json()
            bars: list[dict[str, Any]] = []
            for row in raw_rows:
                open_ms = int(row[0])
                trade_date = datetime.fromtimestamp(open_ms / 1000.0, tz=timezone.utc).date()
                bars.append(
                    {
                        "trade_date": trade_date.isoformat(),
                        "open": float(row[1]),
                        "high": float(row[2]),
                        "low": float(row[3]),
                        "close": float(row[4]),
                        "volume": float(row[5]),
                        "vwap": None,
                        "trade_count": int(row[8]),
                    }
                )
            return bars

        if self._http_client is not None:
            return await _execute(self._http_client)
        async with httpx.AsyncClient() as client:
            return await _execute(client)

    async def get_btc_daily_bars(
        self, *, limit: int = 300, force_refresh: bool = False
    ) -> dict[str, Any]:
        """Fetch BTCUSDT 7x24 liquidity canary daily klines from Binance Vision."""
        cache_key = f"marketelite:binance:btcusdt:1d:{limit}"
        if self._cache is None:
            bars = await self._fetch_btc_daily_bars_raw(limit=limit)
            return {"bars": bars, "is_stale": False, "source": "binance_vision"}

        res = await self._cache.get_or_fetch(
            cache_key,
            provider="binance",
            fetcher=lambda: self._fetch_btc_daily_bars_raw(limit=limit),
            soft_ttl_seconds=900,
            hard_ttl_seconds=86400 * 3,
            force_refresh=force_refresh,
        )
        return {
            "bars": res.data,
            "is_stale": res.is_stale,
            "cache_status": res.cache_status,
            "stale_reason": res.stale_reason,
            "fetched_at": res.fetched_at,
            "source": "binance_vision",
        }

    async def _fetch_cftc_cot_raw(self) -> dict[str, Any]:
        url = "https://publicreporting.cftc.gov/resource/6dca-aqww.json"
        codes = ",".join(f"'{code}'" for code, _ in CFTC_COT_CONTRACTS.values())
        params = {
            "$where": f"cftc_contract_market_code in({codes})",
            "$order": "report_date_as_yyyy_mm_dd DESC",
            "$limit": 60,
        }

        async def _execute(client: httpx.AsyncClient) -> dict[str, Any]:
            resp = await client.get(url, params=params, timeout=20.0)
            raise_for_provider_response(resp, "cftc")
            records = resp.json()
            grouped: dict[str, list[dict[str, Any]]] = {k: [] for k in CFTC_COT_CONTRACTS}
            code_to_key = {code: key for key, (code, _) in CFTC_COT_CONTRACTS.items()}
            for rec in records:
                code = str(rec.get("cftc_contract_market_code", ""))
                key = code_to_key.get(code)
                if not key:
                    continue
                nc_long = float(rec.get("noncomm_positions_long_all", 0) or 0)
                nc_short = float(rec.get("noncomm_positions_short_all", 0) or 0)
                c_long = float(rec.get("comm_positions_long_all", 0) or 0)
                c_short = float(rec.get("comm_positions_short_all", 0) or 0)
                oi = float(rec.get("open_interest_all", 0) or 0)
                net_nc = nc_long - nc_short
                grouped[key].append(
                    {
                        "report_date": str(rec.get("report_date_as_yyyy_mm_dd", ""))[:10],
                        "noncomm_long": nc_long,
                        "noncomm_short": nc_short,
                        "noncomm_net": net_nc,
                        "comm_net": c_long - c_short,
                        "open_interest": oi,
                        "noncomm_net_pct_oi": round((net_nc / oi) * 100.0, 2) if oi > 0 else None,
                    }
                )

            summary: dict[str, Any] = {}
            for key, (_, name) in CFTC_COT_CONTRACTS.items():
                hist = grouped.get(key, [])
                if not hist:
                    continue
                latest = hist[0]
                prev = hist[1] if len(hist) > 1 else None
                wow_delta = (
                    round(latest["noncomm_net"] - prev["noncomm_net"], 0) if prev else None
                )
                summary[key] = {
                    "contract": name,
                    "report_date": latest["report_date"],
                    "noncomm_net": latest["noncomm_net"],
                    "wow_change": wow_delta,
                    "noncomm_net_pct_oi": latest["noncomm_net_pct_oi"],
                    "open_interest": latest["open_interest"],
                }
            return summary

        if self._http_client is not None:
            return await _execute(self._http_client)
        async with httpx.AsyncClient() as client:
            return await _execute(client)

    async def get_cftc_cot(self, *, force_refresh: bool = False) -> dict[str, Any]:
        """Fetch weekly CFTC Commitments of Traders positioning summary."""
        cache_key = "marketelite:cftc:cot:legacy"
        if self._cache is None:
            data = await self._fetch_cftc_cot_raw()
            return {"cot": data, "is_stale": False, "source": "cftc_socrata"}

        res = await self._cache.get_or_fetch(
            cache_key,
            provider="cftc",
            fetcher=self._fetch_cftc_cot_raw,
            soft_ttl_seconds=3600 * 12,
            hard_ttl_seconds=86400 * 10,
            force_refresh=force_refresh,
        )
        return {
            "cot": res.data,
            "is_stale": res.is_stale,
            "cache_status": res.cache_status,
            "stale_reason": res.stale_reason,
            "fetched_at": res.fetched_at,
            "source": "cftc_socrata",
        }

    async def _fetch_cftc_institutional_flow_raw(self) -> dict[str, Any]:
        tff_codes = [
            meta["code"]
            for meta in CFTC_INSTITUTIONAL_CONTRACTS.values()
            if meta["dataset"] == "tff"
        ]
        disagg_codes = [
            meta["code"]
            for meta in CFTC_INSTITUTIONAL_CONTRACTS.values()
            if meta["dataset"] == "disagg"
        ]
        code_to_key = {meta["code"]: key for key, meta in CFTC_INSTITUTIONAL_CONTRACTS.items()}

        async def _execute(client: httpx.AsyncClient) -> dict[str, Any]:
            tff_url = "https://publicreporting.cftc.gov/resource/gpe5-46if.json"
            disagg_url = "https://publicreporting.cftc.gov/resource/72hh-3qpy.json"
            tff_where = "cftc_contract_market_code in(" + ",".join(f"'{c}'" for c in tff_codes) + ")"
            disagg_where = "cftc_contract_market_code in(" + ",".join(f"'{c}'" for c in disagg_codes) + ")"

            tff_task = client.get(
                tff_url,
                params={
                    "$where": tff_where,
                    "$order": "report_date_as_yyyy_mm_dd DESC",
                    "$limit": 360,
                },
                timeout=22.0,
            )
            disagg_task = client.get(
                disagg_url,
                params={
                    "$where": disagg_where,
                    "$order": "report_date_as_yyyy_mm_dd DESC",
                    "$limit": 80,
                },
                timeout=22.0,
            )
            tff_resp, disagg_resp = await asyncio.gather(tff_task, disagg_task)
            raise_for_provider_response(tff_resp, "cftc_tff")
            raise_for_provider_response(disagg_resp, "cftc_disagg")

            series_by_key: dict[str, list[dict[str, Any]]] = {
                k: [] for k in CFTC_INSTITUTIONAL_CONTRACTS
            }

            for rec in tff_resp.json() or []:
                key = code_to_key.get(str(rec.get("cftc_contract_market_code", "")))
                if not key:
                    continue
                series_by_key[key].append(
                    {
                        "report_date": str(rec.get("report_date_as_yyyy_mm_dd", ""))[:10],
                        "real_money_long": float(rec.get("asset_mgr_positions_long", 0) or 0),
                        "real_money_short": float(rec.get("asset_mgr_positions_short", 0) or 0),
                        "leveraged_long": float(rec.get("lev_money_positions_long", 0) or 0),
                        "leveraged_short": float(rec.get("lev_money_positions_short", 0) or 0),
                        "leveraged_spread": float(rec.get("lev_money_positions_spread", 0) or 0),
                        "dealer_long": float(rec.get("dealer_positions_long_all", 0) or 0),
                        "dealer_short": float(rec.get("dealer_positions_short_all", 0) or 0),
                        "open_interest": float(rec.get("open_interest_all", 0) or 0),
                    }
                )

            for rec in disagg_resp.json() or []:
                key = code_to_key.get(str(rec.get("cftc_contract_market_code", "")))
                if not key:
                    continue
                series_by_key[key].append(
                    {
                        "report_date": str(rec.get("report_date_as_yyyy_mm_dd", ""))[:10],
                        "real_money_long": float(rec.get("swap_positions_long_all", 0) or 0),
                        "real_money_short": float(rec.get("swap__positions_short_all", 0) or 0),
                        "leveraged_long": float(rec.get("m_money_positions_long_all", 0) or 0),
                        "leveraged_short": float(rec.get("m_money_positions_short_all", 0) or 0),
                        "leveraged_spread": float(rec.get("m_money_positions_spread", 0) or 0),
                        "dealer_long": float(rec.get("prod_merc_positions_long", 0) or 0),
                        "dealer_short": float(rec.get("prod_merc_positions_short", 0) or 0),
                        "open_interest": float(rec.get("open_interest_all", 0) or 0),
                    }
                )

            return build_institutional_flow_summary(CFTC_INSTITUTIONAL_CONTRACTS, series_by_key)

        if self._http_client is not None:
            return await _execute(self._http_client)
        async with httpx.AsyncClient() as client:
            return await _execute(client)

    async def get_cftc_institutional_flow(self, *, force_refresh: bool = False) -> dict[str, Any]:
        """Fetch CFTC TFF & Disaggregated 52-week multi-group institutional positioning."""
        cache_key = "marketelite:cftc:tff:institutional:v1"
        if self._cache is None:
            data = await self._fetch_cftc_institutional_flow_raw()
            return {"status": "ok", **data, "is_stale": False, "source": "cftc_tff_disagg"}

        res = await self._cache.get_or_fetch(
            cache_key,
            provider="cftc_tff",
            fetcher=self._fetch_cftc_institutional_flow_raw,
            soft_ttl_seconds=3600 * 12,
            hard_ttl_seconds=86400 * 10,
            force_refresh=force_refresh,
        )
        payload = res.data if isinstance(res.data, dict) else {}
        return {
            "status": "ok",
            **payload,
            "is_stale": res.is_stale,
            "cache_status": res.cache_status,
            "fetched_at": res.fetched_at,
            "source": "cftc_tff_disagg",
        }

    async def get_fmp_economic_calendar(
        self, *, days_ahead: int = 21, days_back: int = 7
    ) -> list[dict[str, Any]]:
        """Fetch US high/medium impact macro events from FMP /stable/economic-calendar."""
        api_key = self._settings.fmp_api_key.strip()
        if not api_key:
            raise ProviderUnconfiguredError("FMP_API_KEY is not configured")

        from_date = (date.today() - timedelta(days=days_back)).isoformat()
        to_date = (date.today() + timedelta(days=min(days_ahead, 60))).isoformat()
        url = "https://financialmodelingprep.com/stable/economic-calendar"
        params = {"from": from_date, "to": to_date, "apikey": api_key}

        async def _fetch() -> list[dict[str, Any]]:
            async def _exec(client: httpx.AsyncClient) -> list[dict[str, Any]]:
                resp = await client.get(url, params=params, timeout=15.0)
                raise_for_provider_response(resp, "fmp")
                rows = resp.json()
                if not isinstance(rows, list):
                    return []
                events: list[dict[str, Any]] = []
                for item in rows:
                    country = str(item.get("country", "")).upper()
                    if country != "US":
                        continue
                    events.append(
                        {
                            "event_key": (
                                f"fmp:{item.get('date', '')}:{item.get('event', '')}"
                            )[:155],
                            "event_type": "macro",
                            "event_time": str(item.get("date", "")),
                            "symbol": None,
                            "country": country,
                            "title": str(item.get("event", "Macro Release"))[:250],
                            "impact": str(item.get("impact", "Medium")),
                            "actual": item.get("actual"),
                            "estimate": item.get("estimate"),
                            "previous": item.get("previous"),
                            "source": "fmp",
                        }
                    )
                return events

            if self._http_client is not None:
                return await _exec(self._http_client)
            async with httpx.AsyncClient() as client:
                return await _exec(client)

        if self._cache is None:
            return await _fetch()
        res = await self._cache.get_or_fetch(
            f"marketelite:fmp:calendar:{from_date}:{to_date}",
            provider="fmp",
            fetcher=_fetch,
            soft_ttl_seconds=3600 * 6,
            hard_ttl_seconds=86400 * 3,
        )
        return list(res.data)

    async def get_finnhub_earnings_calendar(
        self,
        *,
        days_ahead: int = 45,
        days_back: int = 3,
        extra_symbols: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Fetch upcoming US earnings events from Finnhub, prioritizing core + watchlist tickers."""
        api_key = self._settings.finnhub_api_key.strip()
        if not api_key:
            raise ProviderUnconfiguredError("FINNHUB_API_KEY is not configured")

        from_date = (date.today() - timedelta(days=days_back)).isoformat()
        to_date = (date.today() + timedelta(days=days_ahead)).isoformat()
        url = "https://finnhub.io/api/v1/calendar/earnings"
        params = {"from": from_date, "to": to_date, "token": api_key}
        et_tz = ZoneInfo("America/New_York")

        async def _fetch() -> list[dict[str, Any]]:
            async def _exec(client: httpx.AsyncClient) -> list[dict[str, Any]]:
                resp = await client.get(url, params=params, timeout=15.0)
                raise_for_provider_response(resp, "finnhub")
                items = resp.json().get("earningsCalendar", [])
                focus_tickers = {
                    "SPY",
                    "QQQ",
                    "NVDA",
                    "AAPL",
                    "MSFT",
                    "AMZN",
                    "META",
                    "GOOGL",
                    "GOOG",
                    "TSLA",
                    "AVGO",
                    "AMD",
                    "PLTR",
                    "TSM",
                    "NFLX",
                    "COIN",
                    "ORCL",
                    "CRM",
                    "MU",
                    "INTC",
                    "JPM",
                    "GS",
                    "LLY",
                    *(s.upper() for s in (extra_symbols or set()) if s),
                }
                items_sorted = sorted(
                    items,
                    key=lambda x: (
                        0 if str(x.get("symbol", "")).upper() in focus_tickers else 1,
                        str(x.get("date", "9999-12-31")),
                        0 if x.get("revenueEstimate") else 1,
                    ),
                )
                events: list[dict[str, Any]] = []
                for item in items_sorted[:250]:
                    sym = str(item.get("symbol", "")).upper()
                    dt_str = str(item.get("date", ""))[:10]
                    if not sym or not dt_str:
                        continue
                    try:
                        d_obj = date.fromisoformat(dt_str)
                    except ValueError:
                        continue
                    hour_tag = str(item.get("hour", "")).lower().strip()
                    hr, mn = (8, 0) if hour_tag == "bmo" else (16, 5)
                    ev_utc = datetime(d_obj.year, d_obj.month, d_obj.day, hr, mn, tzinfo=et_tz).astimezone(
                        timezone.utc
                    )
                    events.append(
                        {
                            "event_key": f"finnhub:earn:{sym}:{dt_str}",
                            "event_type": "earnings",
                            "event_time": ev_utc.isoformat(),
                            "symbol": sym,
                            "country": "US",
                            "title": f"{sym} Q{item.get('quarter', '')} {item.get('year', '')} Earnings",
                            "impact": "High" if sym in focus_tickers else "Medium",
                            "eps_actual": item.get("epsActual"),
                            "eps_estimate": item.get("epsEstimate"),
                            "revenue_estimate": item.get("revenueEstimate"),
                            "source": "finnhub",
                        }
                    )
                return events

            if self._http_client is not None:
                return await _exec(self._http_client)
            async with httpx.AsyncClient() as client:
                return await _exec(client)

        if self._cache is None:
            return await _fetch()
        res = await self._cache.get_or_fetch(
            f"marketelite:finnhub:earnings:{from_date}:{to_date}",
            provider="finnhub",
            fetcher=_fetch,
            soft_ttl_seconds=3600 * 6,
            hard_ttl_seconds=86400 * 3,
        )
        return list(res.data)

    async def get_finnhub_company_eps_history(
        self, symbol: str, *, limit: int = 4
    ) -> list[dict[str, Any]]:
        """Fetch historical quarterly EPS actual vs consensus estimate & surprise from Finnhub."""
        api_key = self._settings.finnhub_api_key.strip()
        if not api_key:
            raise ProviderUnconfiguredError("FINNHUB_API_KEY is not configured")

        sym = symbol.upper().strip()
        url = "https://finnhub.io/api/v1/stock/earnings"
        params = {"symbol": sym, "limit": limit, "token": api_key}

        async def _fetch() -> list[dict[str, Any]]:
            async def _exec(client: httpx.AsyncClient) -> list[dict[str, Any]]:
                resp = await client.get(url, params=params, timeout=15.0)
                raise_for_provider_response(resp, "finnhub")
                rows = resp.json()
                if not isinstance(rows, list):
                    return []
                out: list[dict[str, Any]] = []
                for r in rows[:limit]:
                    period = str(r.get("period", "")).strip()
                    if not period:
                        continue
                    out.append(
                        {
                            "symbol": sym,
                            "period": period,
                            "quarter": r.get("quarter"),
                            "year": r.get("year"),
                            "actual": r.get("actual"),
                            "estimate": r.get("estimate"),
                            "surprise": r.get("surprise"),
                            "surprise_percent": r.get("surprisePercent"),
                            "source": "finnhub",
                        }
                    )
                return out

            if self._http_client is not None:
                return await _exec(self._http_client)
            async with httpx.AsyncClient() as client:
                return await _exec(client)

        if self._cache is None:
            return await _fetch()
        res = await self._cache.get_or_fetch(
            f"marketelite:finnhub:company_eps:{sym}",
            provider="finnhub",
            fetcher=_fetch,
            soft_ttl_seconds=3600 * 6,
            hard_ttl_seconds=86400 * 3,
        )
        return list(res.data)

    async def get_finnhub_recommendation_trends(
        self, symbol: str
    ) -> list[dict[str, Any]]:
        """Fetch analyst Buy/Hold/Sell consensus recommendation trends from Finnhub."""
        api_key = self._settings.finnhub_api_key.strip()
        if not api_key:
            raise ProviderUnconfiguredError("FINNHUB_API_KEY is not configured")

        sym = symbol.upper().strip()
        url = "https://finnhub.io/api/v1/stock/recommendation"
        params = {"symbol": sym, "token": api_key}

        async def _fetch() -> list[dict[str, Any]]:
            async def _exec(client: httpx.AsyncClient) -> list[dict[str, Any]]:
                resp = await client.get(url, params=params, timeout=15.0)
                raise_for_provider_response(resp, "finnhub")
                rows = resp.json()
                if not isinstance(rows, list):
                    return []
                return [
                    {
                        "symbol": sym,
                        "period": str(r.get("period", "")),
                        "strong_buy": int(r.get("strongBuy", 0) or 0),
                        "buy": int(r.get("buy", 0) or 0),
                        "hold": int(r.get("hold", 0) or 0),
                        "sell": int(r.get("sell", 0) or 0),
                        "strong_sell": int(r.get("strongSell", 0) or 0),
                    }
                    for r in rows[:4]
                ]

            if self._http_client is not None:
                return await _exec(self._http_client)
            async with httpx.AsyncClient() as client:
                return await _exec(client)

        if self._cache is None:
            return await _fetch()
        res = await self._cache.get_or_fetch(
            f"marketelite:finnhub:rec:{sym}",
            provider="finnhub",
            fetcher=_fetch,
            soft_ttl_seconds=3600 * 6,
            hard_ttl_seconds=86400 * 3,
        )
        return list(res.data)

    async def get_fmp_price_target_consensus(
        self, symbol: str
    ) -> dict[str, Any] | None:
        """Fetch Wall Street consensus target price (mean/median/high/low) via FMP."""
        api_key = self._settings.fmp_api_key.strip()
        sym = symbol.upper().strip()
        if not api_key or not sym:
            return None

        url = "https://financialmodelingprep.com/stable/price-target-consensus"
        params = {"symbol": sym, "apikey": api_key}

        async def _fetch() -> dict[str, Any] | None:
            async def _exec(client: httpx.AsyncClient) -> dict[str, Any] | None:
                resp = await client.get(url, params=params, timeout=10.0)
                if resp.status_code != 200:
                    return None
                rows = resp.json()
                if not isinstance(rows, list) or not rows:
                    return None
                row = rows[0] if isinstance(rows[0], dict) else {}

                def _num(v: Any) -> float | None:
                    if v is None or isinstance(v, bool):
                        return None
                    try:
                        val = float(v)
                        return round(val, 2) if val > 0 else None
                    except (TypeError, ValueError):
                        return None

                consensus = _num(row.get("targetConsensus"))
                median = _num(row.get("targetMedian"))
                high = _num(row.get("targetHigh"))
                low = _num(row.get("targetLow"))
                if consensus is None and median is None:
                    return None
                return {
                    "symbol": sym,
                    "target_consensus": consensus or median,
                    "target_median": median or consensus,
                    "target_high": high,
                    "target_low": low,
                    "source": "fmp",
                }

            if self._http_client is not None:
                return await _exec(self._http_client)
            async with httpx.AsyncClient() as client:
                return await _exec(client)

        if self._cache is None:
            return await _fetch()
        try:
            res = await self._cache.get_or_fetch(
                f"marketelite:fmp:price_target:{sym}",
                provider="fmp",
                fetcher=_fetch,
                soft_ttl_seconds=3600 * 12,
                hard_ttl_seconds=86400 * 7,
            )
            return dict(res.data) if isinstance(res.data, dict) else None
        except ProviderError:
            return None

    async def get_fred_macro_calendar(
        self, *, days_ahead: int = 90, days_back: int = 3
    ) -> list[dict[str, Any]]:
        """Fetch official upcoming CPI/PPI/NFP/PCE/Retail/GDP release dates via free FRED API."""
        api_key = self._settings.fred_api_key.strip()
        if not api_key:
            raise ProviderUnconfiguredError("FRED_API_KEY is required for FRED release schedule")

        releases: dict[int, tuple[str, str]] = {
            10: ("US Consumer Price Index (CPI)", "High"),
            46: ("US Producer Price Index (PPI)", "Medium"),
            50: ("US Employment Situation (NFP)", "High"),
            54: ("US Personal Income & Outlays (PCE)", "High"),
            9: ("US Advance Retail Sales", "Medium"),
            53: ("US Gross Domestic Product (GDP)", "High"),
        }
        et_tz = ZoneInfo("America/New_York")
        start_d = date.today() - timedelta(days=days_back)
        end_d = date.today() + timedelta(days=days_ahead)

        async def _fetch() -> list[dict[str, Any]]:
            async def _exec(client: httpx.AsyncClient) -> list[dict[str, Any]]:
                out: list[dict[str, Any]] = []
                for rid, (title, impact) in releases.items():
                    resp = await client.get(
                        "https://api.stlouisfed.org/fred/release/dates",
                        params={
                            "release_id": rid,
                            "api_key": api_key,
                            "file_type": "json",
                            "include_release_dates_with_no_data": "true",
                            "sort_order": "desc",
                            "limit": 16,
                        },
                        timeout=15.0,
                    )
                    raise_for_provider_response(resp, "fred")
                    for row in resp.json().get("release_dates", []):
                        dt_raw = str(row.get("date", ""))[:10]
                        if not dt_raw:
                            continue
                        try:
                            d = date.fromisoformat(dt_raw)
                        except ValueError:
                            continue
                        if start_d <= d <= end_d:
                            et_dt = datetime(d.year, d.month, d.day, 8, 30, tzinfo=et_tz)
                            out.append(
                                {
                                    "event_key": f"fred:rel:{rid}:{dt_raw}",
                                    "event_type": "macro",
                                    "event_time": et_dt.astimezone(timezone.utc).isoformat(),
                                    "symbol": None,
                                    "country": "US",
                                    "title": title,
                                    "impact": impact,
                                    "actual": None,
                                    "estimate": None,
                                    "previous": None,
                                    "source": "fred_releases",
                                }
                            )
                return out

            if self._http_client is not None:
                return await _exec(self._http_client)
            async with httpx.AsyncClient() as client:
                return await _exec(client)

        if self._cache is None:
            return await _fetch()
        res = await self._cache.get_or_fetch(
            f"marketelite:fred:macro_cal:{start_d.isoformat()}:{end_d.isoformat()}",
            provider="fred",
            fetcher=_fetch,
            soft_ttl_seconds=3600 * 12,
            hard_ttl_seconds=86400 * 5,
        )
        return list(res.data)

    async def get_fed_fomc_calendar(
        self, *, days_ahead: int = 365, days_back: int = 3
    ) -> list[dict[str, Any]]:
        """Fetch official keyless FOMC meeting schedule straight from federalreserve.gov."""
        url = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
        month_lookup = {
            "january": 1,
            "jan": 1,
            "february": 2,
            "feb": 2,
            "march": 3,
            "mar": 3,
            "april": 4,
            "apr": 4,
            "may": 5,
            "june": 6,
            "jun": 6,
            "july": 7,
            "jul": 7,
            "august": 8,
            "aug": 8,
            "september": 9,
            "sep": 9,
            "sept": 9,
            "october": 10,
            "oct": 10,
            "november": 11,
            "nov": 11,
            "december": 12,
            "dec": 12,
        }
        et_tz = ZoneInfo("America/New_York")
        start_d = date.today() - timedelta(days=days_back)
        end_d = date.today() + timedelta(days=days_ahead)

        async def _fetch() -> list[dict[str, Any]]:
            async def _exec(client: httpx.AsyncClient) -> list[dict[str, Any]]:
                resp = await client.get(
                    url,
                    timeout=15.0,
                    headers={"User-Agent": self._settings.sec_edgar_user_agent},
                )
                raise_for_provider_response(resp, "fed_fomc")
                soup = BeautifulSoup(resp.text, "html.parser")
                out: list[dict[str, Any]] = []
                for panel in soup.select("div.panel.panel-default"):
                    heading = panel.select_one("h4, .panel-heading")
                    year_match = re.search(r"(20\d{2})\s+FOMC", heading.get_text(" ", strip=True) if heading else "")
                    if not year_match:
                        continue
                    year = int(year_match.group(1))
                    for row in panel.select(".fomc-meeting"):
                        m_el = row.select_one(".fomc-meeting__month")
                        d_el = row.select_one(".fomc-meeting__date")
                        if not m_el or not d_el:
                            continue
                        m_raw = m_el.get_text(" ", strip=True).lower()
                        d_raw = d_el.get_text(" ", strip=True)
                        # Cross-month meetings look like "Apr/May" or "Jan/Feb" -> decision date uses second month
                        month_tokens = [tok.strip() for tok in m_raw.split("/") if tok.strip()]
                        target_month = month_lookup.get(month_tokens[-1]) if month_tokens else None
                        day_nums = [int(x) for x in re.findall(r"\d{1,2}", d_raw)]
                        if not target_month or not day_nums:
                            continue
                        decision_day = day_nums[-1]
                        has_sep = "*" in d_raw
                        try:
                            dec_date = date(year, target_month, decision_day)
                        except ValueError:
                            continue
                        if not (start_d <= dec_date <= end_d):
                            continue
                        et_dt = datetime(dec_date.year, dec_date.month, dec_date.day, 14, 0, tzinfo=et_tz)
                        out.append(
                            {
                                "event_key": f"fed:fomc:{dec_date.isoformat()}",
                                "event_type": "macro",
                                "event_time": et_dt.astimezone(timezone.utc).isoformat(),
                                "symbol": None,
                                "country": "US",
                                "title": (
                                    "FOMC Rate Decision & SEP Projections"
                                    if has_sep
                                    else "FOMC Rate Decision"
                                ),
                                "impact": "High",
                                "actual": None,
                                "estimate": None,
                                "previous": None,
                                "source": "federalreserve_gov",
                            }
                        )
                return out

            if self._http_client is not None:
                return await _exec(self._http_client)
            async with httpx.AsyncClient(follow_redirects=True) as client:
                return await _exec(client)

        if self._cache is None:
            return await _fetch()
        res = await self._cache.get_or_fetch(
            "marketelite:fed:fomc_calendar",
            provider="fed_fomc",
            fetcher=_fetch,
            soft_ttl_seconds=86400,
            hard_ttl_seconds=86400 * 14,
        )
        return list(res.data)

    @staticmethod
    def _normalize_exchange(raw: str | None) -> str:
        text = (raw or "").upper()
        if "NASDAQ" in text:
            return "NASDAQ"
        if "NEW YORK STOCK EXCHANGE" in text or text.strip() == "NYSE":
            return "NYSE"
        if "ARCA" in text:
            return "NYSE Arca"
        if "BATS" in text or "CBOE" in text:
            return "CBOE"
        return raw.strip() if raw and raw.strip() else "US"

    async def get_finnhub_company_overview(self, symbol: str) -> dict[str, Any]:
        """Fetch & cache Finnhub company profile2 + valuation metrics for Watchlist & Stock Detail."""
        sym = symbol.upper().strip()
        api_key = self._settings.finnhub_api_key.strip()
        if not api_key or not sym:
            return {}

        async def _fetch() -> dict[str, Any]:
            async def _exec(client: httpx.AsyncClient) -> dict[str, Any]:
                prof_task = client.get(
                    "https://finnhub.io/api/v1/stock/profile2",
                    params={"symbol": sym, "token": api_key},
                    timeout=10.0,
                )
                met_task = client.get(
                    "https://finnhub.io/api/v1/stock/metric",
                    params={"symbol": sym, "metric": "all", "token": api_key},
                    timeout=10.0,
                )
                prof_resp, met_resp = await asyncio.gather(prof_task, met_task, return_exceptions=True)

                prof_json: dict[str, Any] = {}
                if isinstance(prof_resp, httpx.Response) and prof_resp.status_code == 200:
                    data = prof_resp.json()
                    if isinstance(data, dict):
                        prof_json = data

                met_json: dict[str, Any] = {}
                if isinstance(met_resp, httpx.Response) and met_resp.status_code == 200:
                    data = met_resp.json()
                    if isinstance(data, dict) and isinstance(data.get("metric"), dict):
                        met_json = data["metric"]

                def _num(val: Any) -> float | None:
                    if val is None or isinstance(val, bool):
                        return None
                    try:
                        return float(val)
                    except (TypeError, ValueError):
                        return None

                mkt_cap_m = _num(prof_json.get("marketCapitalization"))
                return {
                    "symbol": sym,
                    "name": prof_json.get("name") or sym,
                    "exchange": self._normalize_exchange(prof_json.get("exchange")),
                    "industry": prof_json.get("finnhubIndustry") or None,
                    "logo_url": prof_json.get("logo") or None,
                    "weburl": prof_json.get("weburl") or None,
                    "ipo": prof_json.get("ipo") or None,
                    "country": prof_json.get("country") or "US",
                    "market_cap_b": round(mkt_cap_m / 1000.0, 2) if mkt_cap_m else None,
                    "week52_high": _num(met_json.get("52WeekHigh")),
                    "week52_low": _num(met_json.get("52WeekLow")),
                    "pe_ttm": _num(met_json.get("peBasicExclExtraTTM") or met_json.get("peTTM")),
                    "pb": _num(met_json.get("pbQuarterly") or met_json.get("pbAnnual")),
                    "beta": _num(met_json.get("beta")),
                    "dividend_yield": _num(met_json.get("dividendYieldIndicatedAnnual")),
                    "avg_vol_10d_m": _num(met_json.get("10DayAverageTradingVolume")),
                }

            if self._http_client is not None:
                return await _exec(self._http_client)
            async with httpx.AsyncClient() as client:
                return await _exec(client)

        if self._cache is None:
            return await _fetch()
        res = await self._cache.get_or_fetch(
            f"marketelite:finnhub:overview:{sym}",
            provider="finnhub",
            fetcher=_fetch,
            soft_ttl_seconds=3600 * 12,
            hard_ttl_seconds=86400 * 7,
        )
        return dict(res.data or {})

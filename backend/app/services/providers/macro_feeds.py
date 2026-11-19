from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx

from app.core.config import Settings
from app.services.resilience import (
    DualTTLCache,
    ProviderUnconfiguredError,
    raise_for_provider_response,
)

CFTC_COT_CONTRACTS: dict[str, tuple[str, str]] = {
    "ES": ("13874A", "E-mini S&P 500"),
    "NQ": ("209742", "E-mini Nasdaq-100"),
    "ZN": ("043602", "10-Year U.S. Treasury Note"),
    "GC": ("088691", "Gold COMEX"),
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
        self, *, days_ahead: int = 14, days_back: int = 3
    ) -> list[dict[str, Any]]:
        """Fetch upcoming US earnings events from Finnhub."""
        api_key = self._settings.finnhub_api_key.strip()
        if not api_key:
            raise ProviderUnconfiguredError("FINNHUB_API_KEY is not configured")

        from_date = (date.today() - timedelta(days=days_back)).isoformat()
        to_date = (date.today() + timedelta(days=days_ahead)).isoformat()
        url = "https://finnhub.io/api/v1/calendar/earnings"
        params = {"from": from_date, "to": to_date, "token": api_key}

        async def _fetch() -> list[dict[str, Any]]:
            async def _exec(client: httpx.AsyncClient) -> list[dict[str, Any]]:
                resp = await client.get(url, params=params, timeout=15.0)
                raise_for_provider_response(resp, "finnhub")
                items = resp.json().get("earningsCalendar", [])
                events: list[dict[str, Any]] = []
                for item in items[:150]:
                    sym = str(item.get("symbol", "")).upper()
                    dt_str = str(item.get("date", ""))
                    if not sym or not dt_str:
                        continue
                    events.append(
                        {
                            "event_key": f"finnhub:earn:{sym}:{dt_str}",
                            "event_type": "earnings",
                            "event_time": f"{dt_str}T21:00:00+00:00",
                            "symbol": sym,
                            "country": "US",
                            "title": f"{sym} Q{item.get('quarter', '')} {item.get('year', '')} Earnings",
                            "impact": "High" if sym in {"SPY", "NVDA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "TSLA", "AVGO"} else "Medium",
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

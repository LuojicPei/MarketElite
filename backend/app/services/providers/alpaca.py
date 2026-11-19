from __future__ import annotations

import hashlib
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx

from app.core.config import Settings
from app.quant.options import OptionContractInput
from app.services.resilience import (
    DualTTLCache,
    ProviderUnconfiguredError,
    raise_for_provider_response,
)

CORE_INDEX_ETFS: tuple[str, ...] = ("SPY", "QQQ", "SOXX", "IWM", "RSP")
SECTOR_ETFS: tuple[str, ...] = (
    "XLK",
    "XLY",
    "XLC",
    "XLF",
    "XLI",
    "XLE",
    "XLB",
    "XLU",
    "XLP",
    "XLV",
    "XLRE",
)
MACRO_PROXIES: tuple[str, ...] = ("HYG", "LQD", "UUP", "GLD", "CPER", "TLT")
LIQUID_BREADTH_STOCKS: tuple[str, ...] = (
    "AAPL",
    "MSFT",
    "NVDA",
    "AMZN",
    "META",
    "GOOGL",
    "TSLA",
    "AVGO",
    "JPM",
    "LLY",
    "XOM",
    "UNH",
    "V",
    "COST",
    "HD",
    "PG",
    "MA",
    "MRK",
    "NFLX",
    "CRM",
)

DEFAULT_EQUITY_UNIVERSE: tuple[str, ...] = (
    CORE_INDEX_ETFS + SECTOR_ETFS + MACRO_PROXIES + LIQUID_BREADTH_STOCKS
)


class AlpacaClient:
    """Async Alpaca Market Data + Trading API client (SIP 15m-delayed bars & Indicative Options)."""

    DATA_BASE = "https://data.alpaca.markets"

    def __init__(
        self,
        settings: Settings,
        cache: DualTTLCache | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._settings = settings
        self._cache = cache
        self._http_client = http_client

    @property
    def trading_base(self) -> str:
        return (
            "https://paper-api.alpaca.markets"
            if self._settings.alpaca_paper
            else "https://api.alpaca.markets"
        )

    def _headers(self) -> dict[str, str]:
        key = self._settings.alpaca_api_key.strip()
        secret = self._settings.alpaca_secret_key.strip()
        if not key or not secret:
            raise ProviderUnconfiguredError(
                "ALPACA_API_KEY and ALPACA_SECRET_KEY are required for Alpaca feeds"
            )
        return {
            "APCA-API-KEY-ID": key,
            "APCA-API-SECRET-KEY": secret,
        }

    async def _fetch_daily_bars_raw(
        self,
        symbols: list[str],
        *,
        lookback_days: int = 420,
    ) -> dict[str, list[dict[str, Any]]]:
        headers = self._headers()
        now = datetime.now(timezone.utc)
        # Keep `end` >= 16 minutes delayed so Free Tier consolidated SIP bars never trigger 403
        end_dt = now - timedelta(minutes=16)
        start_dt = now - timedelta(days=lookback_days)

        collected: dict[str, list[dict[str, Any]]] = {sym: [] for sym in symbols}

        async def _execute(client: httpx.AsyncClient) -> dict[str, list[dict[str, Any]]]:
            page_token: str | None = None
            while True:
                params: dict[str, Any] = {
                    "symbols": ",".join(symbols),
                    "timeframe": "1Day",
                    "start": start_dt.isoformat(),
                    "end": end_dt.isoformat(),
                    "adjustment": "split",
                    "feed": "sip",
                    "limit": 10000,
                    "sort": "asc",
                }
                if page_token:
                    params["page_token"] = page_token
                resp = await client.get(
                    f"{self.DATA_BASE}/v2/stocks/bars",
                    headers=headers,
                    params=params,
                    timeout=20.0,
                )
                raise_for_provider_response(resp, "alpaca")
                body = resp.json()
                bars_map = body.get("bars", {})
                for sym, bar_list in bars_map.items():
                    for b in bar_list:
                        ts = str(b.get("t", ""))[:10]
                        if not ts:
                            continue
                        collected.setdefault(sym, []).append(
                            {
                                "trade_date": ts,
                                "open": float(b["o"]),
                                "high": float(b["h"]),
                                "low": float(b["l"]),
                                "close": float(b["c"]),
                                "volume": float(b["v"]),
                                "vwap": float(b["vw"]) if b.get("vw") is not None else None,
                                "trade_count": int(b["n"]) if b.get("n") is not None else None,
                            }
                        )
                page_token = body.get("next_page_token")
                if not page_token:
                    break
            return collected

        if self._http_client is not None:
            return await _execute(self._http_client)
        async with httpx.AsyncClient() as client:
            return await _execute(client)

    async def get_daily_bars(
        self,
        symbols: list[str],
        *,
        lookback_days: int = 420,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """Fetch consolidated 1Day SIP bars (>=15m delayed) with DualTTLCache resilience."""
        normalized = sorted({s.upper().strip() for s in symbols if s.strip()})
        self._headers()
        if self._cache is None:
            bars = await self._fetch_daily_bars_raw(normalized, lookback_days=lookback_days)
            return {"bars": bars, "is_stale": False, "source": "alpaca_sip_1d"}

        key_sig = ",".join(normalized)
        sig_hash = hashlib.sha256(key_sig.encode("utf-8")).hexdigest()[:12]
        cache_key = f"marketelite:alpaca:bars:{len(normalized)}:{sig_hash}:{lookback_days}"
        res = await self._cache.get_or_fetch(
            cache_key,
            provider="alpaca",
            fetcher=lambda: self._fetch_daily_bars_raw(normalized, lookback_days=lookback_days),
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
            "source": "alpaca_sip_1d",
        }

    async def _fetch_options_chain_raw(self, symbol: str) -> dict[str, Any]:
        headers = self._headers()
        sym = symbol.upper().strip()
        today = date.today()
        max_exp = today + timedelta(days=60)

        async def _execute(client: httpx.AsyncClient) -> dict[str, Any]:
            # 1. Trading API /v2/options/contracts -> OCC open_interest + strike + type
            contracts_by_occ: dict[str, dict[str, Any]] = {}
            next_token: str | None = None
            pages = 0
            while pages < 4:
                params: dict[str, Any] = {
                    "underlying_symbols": sym,
                    "status": "active",
                    "expiration_date_gte": today.isoformat(),
                    "expiration_date_lte": max_exp.isoformat(),
                    "limit": 1000,
                }
                if next_token:
                    params["page_token"] = next_token
                c_resp = await client.get(
                    f"{self.trading_base}/v2/options/contracts",
                    headers=headers,
                    params=params,
                    timeout=20.0,
                )
                raise_for_provider_response(c_resp, "alpaca_contracts")
                c_body = c_resp.json()
                for c in c_body.get("option_contracts", []):
                    occ = c.get("symbol")
                    if occ:
                        contracts_by_occ[occ] = c
                next_token = c_body.get("next_page_token")
                pages += 1
                if not next_token:
                    break

            # 2. Data API /v1beta1/options/snapshots/{symbol}?feed=indicative -> Greeks & IV
            snapshots: dict[str, dict[str, Any]] = {}
            snap_token: str | None = None
            snap_pages = 0
            while snap_pages < 4:
                s_params: dict[str, Any] = {
                    "feed": "indicative",
                    "expiration_date_gte": today.isoformat(),
                    "expiration_date_lte": max_exp.isoformat(),
                    "limit": 1000,
                }
                if snap_token:
                    s_params["page_token"] = snap_token
                s_resp = await client.get(
                    f"{self.DATA_BASE}/v1beta1/options/snapshots/{sym}",
                    headers=headers,
                    params=s_params,
                    timeout=20.0,
                )
                raise_for_provider_response(s_resp, "alpaca_options_snap")
                s_body = s_resp.json()
                snapshots.update(s_body.get("snapshots", {}))
                snap_token = s_body.get("next_page_token")
                snap_pages += 1
                if not snap_token:
                    break

            # 3. Underlying spot price (delayed snapshot or latest bar)
            spot_resp = await client.get(
                f"{self.DATA_BASE}/v2/stocks/{sym}/bars/latest",
                headers=headers,
                params={"feed": "iex"},
                timeout=15.0,
            )
            raise_for_provider_response(spot_resp, "alpaca")
            spot_price = float(spot_resp.json().get("bar", {}).get("c", 0.0))

            joined: list[dict[str, Any]] = []
            for occ, meta in contracts_by_occ.items():
                oi_raw = meta.get("open_interest")
                try:
                    oi = int(float(oi_raw)) if oi_raw is not None else 0
                except (TypeError, ValueError):
                    oi = 0
                if oi <= 0:
                    continue

                snap = snapshots.get(occ, {})
                greeks = snap.get("greeks") or {}
                exp_str = str(meta.get("expiration_date", ""))
                tte_years: float | None = None
                if exp_str:
                    try:
                        days_to_exp = max(1, (date.fromisoformat(exp_str) - today).days)
                        tte_years = days_to_exp / 365.0
                    except ValueError:
                        tte_years = None

                joined.append(
                    {
                        "contract_symbol": occ,
                        "option_type": str(meta.get("type", "")).lower(),
                        "strike": float(meta.get("strike_price", 0.0)),
                        "open_interest": oi,
                        "gamma": float(greeks["gamma"]) if greeks.get("gamma") is not None else None,
                        "iv": (
                            float(snap["impliedVolatility"])
                            if snap.get("impliedVolatility") is not None
                            else None
                        ),
                        "time_to_expiry_years": tte_years,
                    }
                )

            return {
                "symbol": sym,
                "spot_price": spot_price,
                "contracts": joined,
            }

        if self._http_client is not None:
            return await _execute(self._http_client)
        async with httpx.AsyncClient() as client:
            return await _execute(client)

    async def get_options_chain_inputs(
        self,
        symbol: str,
        *,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """Fetch joined Indicative Greeks + OCC Open Interest inputs for compute_estimated_gex."""
        self._headers()
        sym = symbol.upper().strip()
        cache_key = f"marketelite:alpaca:optchain:{sym}"
        if self._cache is None:
            raw = await self._fetch_options_chain_raw(sym)
            contracts = [OptionContractInput(**c) for c in raw["contracts"]]
            return {
                "symbol": sym,
                "spot_price": raw["spot_price"],
                "contracts": contracts,
                "is_stale": False,
                "source": "alpaca_indicative",
            }

        res = await self._cache.get_or_fetch(
            cache_key,
            provider="alpaca_options",
            fetcher=lambda: self._fetch_options_chain_raw(sym),
            soft_ttl_seconds=1200,
            hard_ttl_seconds=86400 * 2,
            force_refresh=force_refresh,
        )
        contracts = [OptionContractInput(**c) for c in res.data.get("contracts", [])]
        return {
            "symbol": sym,
            "spot_price": float(res.data.get("spot_price", 0.0)),
            "contracts": contracts,
            "is_stale": res.is_stale,
            "cache_status": res.cache_status,
            "stale_reason": res.stale_reason,
            "fetched_at": res.fetched_at,
            "source": "alpaca_indicative",
        }

    async def get_news(self, symbols: list[str], limit: int = 10) -> list[dict[str, Any]]:
        """Fetch recent Alpaca news headlines for requested US symbols."""
        headers = self._headers()

        async def _execute(client: httpx.AsyncClient) -> list[dict[str, Any]]:
            resp = await client.get(
                f"{self.DATA_BASE}/v1beta1/news",
                headers=headers,
                params={
                    "symbols": ",".join(s.upper() for s in symbols),
                    "limit": min(50, limit * 3),
                    "sort": "desc",
                    "exclude_contentless": "true",
                },
                timeout=15.0,
            )
            raise_for_provider_response(resp, "alpaca_news")
            items = resp.json().get("news", [])
            cleaned: list[dict[str, Any]] = []
            noise_markers = ("CSE:", "(CSE:", "TSXV:", "(TSX-V:", "OTCPK:")
            for item in items:
                text_blob = f"{item.get('headline', '')} {item.get('summary', '')}"
                if any(marker in text_blob for marker in noise_markers):
                    continue
                cleaned.append(
                    {
                        "id": str(item.get("id", "")),
                        "headline": item.get("headline", ""),
                        "source": item.get("source", ""),
                        "url": item.get("url", ""),
                        "symbols": item.get("symbols", []),
                        "created_at": item.get("created_at", ""),
                    }
                )
                if len(cleaned) >= limit:
                    break
            return cleaned

        if self._http_client is not None:
            return await _execute(self._http_client)
        async with httpx.AsyncClient() as client:
            return await _execute(client)

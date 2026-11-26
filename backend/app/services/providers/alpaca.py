from __future__ import annotations

import asyncio
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
        max_exp = today + timedelta(days=45)

        async def _execute(client: httpx.AsyncClient) -> dict[str, Any]:
            # 1. Trading API /v2/options/contracts -> OCC open_interest + strike + type
            contracts_by_occ: dict[str, dict[str, Any]] = {}
            next_token: str | None = None
            pages = 0
            while pages < 6:
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

            # 2. Data API /v1beta1/options/snapshots/{symbol}?feed=indicative -> Greeks, IV, Volume & Quotes
            snapshots: dict[str, dict[str, Any]] = {}
            snap_token: str | None = None
            snap_pages = 0
            while snap_pages < 6:
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

            # 3. Underlying spot price (delayed latest trade/bar snapshot)
            spot_price = 0.0
            snap_resp = await client.get(
                f"{self.DATA_BASE}/v2/stocks/{sym}/snapshot",
                headers=headers,
                params={"feed": "iex"},
                timeout=15.0,
            )
            if snap_resp.status_code == 200:
                s_data = snap_resp.json() or {}
                spot_price = float(
                    (s_data.get("latestTrade") or {}).get("p")
                    or (s_data.get("dailyBar") or {}).get("c")
                    or (s_data.get("prevDailyBar") or {}).get("c")
                    or 0.0
                )
            if spot_price <= 0.0:
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

                snap = snapshots.get(occ, {})
                daily_bar = snap.get("dailyBar") or {}
                prev_bar = snap.get("prevDailyBar") or {}
                try:
                    vol = int(float(daily_bar.get("v") or prev_bar.get("v") or 0))
                except (TypeError, ValueError):
                    vol = 0

                if oi <= 0 and vol <= 0:
                    continue

                greeks = snap.get("greeks") or {}
                quote = snap.get("latestQuote") or {}
                trade = snap.get("latestTrade") or {}
                bid = quote.get("bp")
                ask = quote.get("ap")
                mid_quote = (
                    (float(bid) + float(ask)) / 2.0
                    if bid is not None and ask is not None and float(ask) > 0
                    else None
                )
                last_price = trade.get("p") or daily_bar.get("c") or mid_quote

                exp_str = str(meta.get("expiration_date", ""))
                days_to_exp: int | None = None
                tte_years: float | None = None
                if exp_str:
                    try:
                        days_to_exp = max(0, (date.fromisoformat(exp_str) - today).days)
                        tte_years = max(1, days_to_exp) / 365.0
                    except ValueError:
                        tte_years = None

                joined.append(
                    {
                        "contract_symbol": occ,
                        "option_type": str(meta.get("type", "")).lower(),
                        "strike": float(meta.get("strike_price", 0.0)),
                        "open_interest": oi,
                        "volume": vol,
                        "expiration_date": exp_str or None,
                        "dte": days_to_exp,
                        "gamma": float(greeks["gamma"]) if greeks.get("gamma") is not None else None,
                        "delta": float(greeks["delta"]) if greeks.get("delta") is not None else None,
                        "theta": float(greeks["theta"]) if greeks.get("theta") is not None else None,
                        "vega": float(greeks["vega"]) if greeks.get("vega") is not None else None,
                        "iv": (
                            float(snap["impliedVolatility"])
                            if snap.get("impliedVolatility") is not None
                            else None
                        ),
                        "last_price": float(last_price) if last_price is not None else None,
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
        """Fetch joined Indicative Greeks + OCC Open Interest inputs for GEX & Options Radar."""
        self._headers()
        sym = symbol.upper().strip()
        cache_key = f"marketelite:alpaca:optchain:v2:{sym}"
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
            soft_ttl_seconds=600,
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

    async def get_batch_stock_snapshots(
        self,
        symbols: list[str],
        *,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """Fetch latest daily/intraday price & 1D change snapshots for up to 100 tickers via IEX."""
        headers = self._headers()
        normalized = sorted({s.upper().strip() for s in symbols if s.strip()})
        if not normalized:
            return {}
        sig_hash = hashlib.sha256(",".join(normalized).encode("utf-8")).hexdigest()[:12]
        cache_key = f"marketelite:alpaca:snapshots:{len(normalized)}:{sig_hash}"

        async def _fetch_all() -> dict[str, dict[str, Any]]:
            async def _execute(client: httpx.AsyncClient) -> dict[str, dict[str, Any]]:
                out: dict[str, dict[str, Any]] = {}
                chunks = [normalized[i : i + 45] for i in range(0, len(normalized), 45)]
                tasks = [
                    client.get(
                        f"{self.DATA_BASE}/v2/stocks/snapshots",
                        headers=headers,
                        params={"symbols": ",".join(chunk), "feed": "iex"},
                        timeout=18.0,
                    )
                    for chunk in chunks
                ]
                responses = await asyncio.gather(*tasks)
                for resp in responses:
                    raise_for_provider_response(resp, "alpaca_snapshots")
                    body = resp.json() or {}
                    for sym, snap in body.items():
                        daily = snap.get("dailyBar") or {}
                        prev = snap.get("prevDailyBar") or {}
                        trade = snap.get("latestTrade") or {}
                        curr_price = trade.get("p") or daily.get("c") or prev.get("c")
                        prev_close = prev.get("c")
                        chg_pct: float | None = None
                        if curr_price is not None and prev_close and float(prev_close) > 0:
                            chg_pct = round(
                                ((float(curr_price) - float(prev_close)) / float(prev_close)) * 100.0,
                                2,
                            )
                        out[sym] = {
                            "price": round(float(curr_price), 2) if curr_price is not None else None,
                            "prev_close": round(float(prev_close), 2) if prev_close is not None else None,
                            "change_1d_pct": chg_pct,
                            "volume": int(float(daily.get("v") or prev.get("v") or 0)),
                            "bar_date": str(daily.get("t") or prev.get("t") or "")[:10] or None,
                        }
                return out

            if self._http_client is not None:
                return await _execute(self._http_client)
            async with httpx.AsyncClient() as client:
                return await _execute(client)

        if self._cache is None:
            return await _fetch_all()

        res = await self._cache.get_or_fetch(
            cache_key,
            provider="alpaca_snapshots",
            fetcher=_fetch_all,
            soft_ttl_seconds=120,
            hard_ttl_seconds=86400,
            force_refresh=force_refresh,
        )
        return res.data if isinstance(res.data, dict) else {}

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

    async def get_account(self) -> dict[str, Any]:
        """Fetch Alpaca Paper/Live account balances (equity, buying_power, cash)."""
        headers = self._headers()
        url = f"{self.trading_base}/v2/account"

        async def _execute(client: httpx.AsyncClient) -> dict[str, Any]:
            resp = await client.get(url, headers=headers, timeout=15.0)
            raise_for_provider_response(resp, "alpaca_trading")
            data = resp.json()
            return {
                "id": str(data.get("id", "")),
                "status": str(data.get("status", "UNKNOWN")),
                "currency": str(data.get("currency", "USD")),
                "equity": float(data.get("equity", 0.0) or 0.0),
                "cash": float(data.get("cash", 0.0) or 0.0),
                "buying_power": float(data.get("buying_power", 0.0) or 0.0),
                "portfolio_value": float(data.get("portfolio_value", 0.0) or 0.0),
                "paper": self._settings.alpaca_paper,
            }

        if self._http_client is not None:
            return await _execute(self._http_client)
        async with httpx.AsyncClient() as client:
            return await _execute(client)

    async def get_positions(self) -> list[dict[str, Any]]:
        """Fetch currently open Alpaca Paper positions."""
        headers = self._headers()
        url = f"{self.trading_base}/v2/positions"

        async def _execute(client: httpx.AsyncClient) -> list[dict[str, Any]]:
            resp = await client.get(url, headers=headers, timeout=15.0)
            raise_for_provider_response(resp, "alpaca_trading")
            rows = resp.json()
            if not isinstance(rows, list):
                return []
            return [
                {
                    "symbol": str(p.get("symbol", "")),
                    "qty": float(p.get("qty", 0.0) or 0.0),
                    "side": str(p.get("side", "")),
                    "avg_entry_price": float(p.get("avg_entry_price", 0.0) or 0.0),
                    "current_price": float(p.get("current_price", 0.0) or 0.0),
                    "market_value": float(p.get("market_value", 0.0) or 0.0),
                    "unrealized_pl": float(p.get("unrealized_pl", 0.0) or 0.0),
                    "unrealized_plpc": float(p.get("unrealized_plpc", 0.0) or 0.0),
                }
                for p in rows
            ]

        if self._http_client is not None:
            return await _execute(self._http_client)
        async with httpx.AsyncClient() as client:
            return await _execute(client)

    async def get_orders(self, *, status: str = "all", limit: int = 20) -> list[dict[str, Any]]:
        """Fetch recent Alpaca Paper orders (including bracket child legs)."""
        headers = self._headers()
        url = f"{self.trading_base}/v2/orders"

        async def _execute(client: httpx.AsyncClient) -> list[dict[str, Any]]:
            resp = await client.get(
                url,
                headers=headers,
                params={"status": status, "limit": limit, "nested": "true"},
                timeout=15.0,
            )
            raise_for_provider_response(resp, "alpaca_trading")
            rows = resp.json()
            if not isinstance(rows, list):
                return []
            return [
                {
                    "id": str(o.get("id", "")),
                    "client_order_id": o.get("client_order_id"),
                    "symbol": str(o.get("symbol", "")),
                    "side": str(o.get("side", "")),
                    "qty": str(o.get("qty", "")),
                    "order_class": str(o.get("order_class", "simple")),
                    "type": str(o.get("type", "")),
                    "status": str(o.get("status", "")),
                    "filled_avg_price": o.get("filled_avg_price"),
                    "created_at": o.get("created_at"),
                }
                for o in rows
            ]

        if self._http_client is not None:
            return await _execute(self._http_client)
        async with httpx.AsyncClient() as client:
            return await _execute(client)

    async def submit_bracket_order(
        self,
        *,
        symbol: str,
        qty: int,
        side: str,
        take_profit_price: float,
        stop_loss_price: float,
        limit_price: float | None = None,
        client_order_id: str | None = None,
        time_in_force: str = "day",
    ) -> dict[str, Any]:
        """Submit deterministic Alpaca OrderClass.BRACKET order (ONLY from HITL execution node)."""
        if qty < 1:
            raise ValueError("Bracket orders require integer qty >= 1.")
        norm_side = side.lower().strip()
        if norm_side not in ("buy", "sell"):
            raise ValueError("Side must be 'buy' or 'sell'.")

        headers = self._headers()
        url = f"{self.trading_base}/v2/orders"
        payload: dict[str, Any] = {
            "symbol": symbol.upper().strip(),
            "qty": str(int(qty)),
            "side": norm_side,
            "type": "limit" if limit_price is not None else "market",
            "time_in_force": time_in_force,
            "order_class": "bracket",
            "take_profit": {"limit_price": f"{float(take_profit_price):.2f}"},
            "stop_loss": {"stop_price": f"{float(stop_loss_price):.2f}"},
        }
        if limit_price is not None:
            payload["limit_price"] = f"{float(limit_price):.2f}"
        if client_order_id:
            payload["client_order_id"] = client_order_id[:48]

        async def _execute(client: httpx.AsyncClient) -> dict[str, Any]:
            resp = await client.post(url, headers=headers, json=payload, timeout=20.0)
            raise_for_provider_response(resp, "alpaca_trading")
            data = resp.json()
            return {
                "id": str(data.get("id", "")),
                "client_order_id": data.get("client_order_id"),
                "symbol": str(data.get("symbol", "")),
                "side": str(data.get("side", "")),
                "qty": str(data.get("qty", "")),
                "order_class": str(data.get("order_class", "bracket")),
                "type": str(data.get("type", "")),
                "status": str(data.get("status", "")),
                "submitted_at": data.get("submitted_at"),
                "legs": data.get("legs") or [],
            }

        if self._http_client is not None:
            return await _execute(self._http_client)
        async with httpx.AsyncClient() as client:
            return await _execute(client)

    async def get_order(self, order_id: str) -> dict[str, Any]:
        """Fetch a single Alpaca Paper order (with nested bracket legs)."""
        headers = self._headers()
        oid = order_id.strip()
        url = f"{self.trading_base}/v2/orders/{oid}"

        async def _execute(client: httpx.AsyncClient) -> dict[str, Any]:
            resp = await client.get(url, headers=headers, params={"nested": "true"}, timeout=15.0)
            raise_for_provider_response(resp, "alpaca_trading")
            data = resp.json()
            legs = [
                {
                    "id": str(leg.get("id", "")),
                    "side": str(leg.get("side", "")),
                    "type": str(leg.get("type", "")),
                    "status": str(leg.get("status", "")),
                    "limit_price": leg.get("limit_price"),
                    "stop_price": leg.get("stop_price"),
                    "filled_avg_price": leg.get("filled_avg_price"),
                    "filled_qty": leg.get("filled_qty"),
                    "filled_at": leg.get("filled_at"),
                }
                for leg in (data.get("legs") or [])
            ]
            return {
                "id": str(data.get("id", oid)),
                "client_order_id": data.get("client_order_id"),
                "symbol": str(data.get("symbol", "")),
                "side": str(data.get("side", "")),
                "qty": str(data.get("qty", "")),
                "filled_qty": str(data.get("filled_qty", "0")),
                "order_class": str(data.get("order_class", "simple")),
                "type": str(data.get("type", "")),
                "status": str(data.get("status", "")),
                "filled_avg_price": data.get("filled_avg_price"),
                "created_at": data.get("created_at"),
                "filled_at": data.get("filled_at"),
                "canceled_at": data.get("canceled_at"),
                "expired_at": data.get("expired_at"),
                "legs": legs,
            }

        if self._http_client is not None:
            return await _execute(self._http_client)
        async with httpx.AsyncClient() as client:
            return await _execute(client)

    async def cancel_order(self, order_id: str) -> dict[str, Any]:
        """Cancel an open Alpaca Paper order by ID."""
        headers = self._headers()
        oid = order_id.strip()
        url = f"{self.trading_base}/v2/orders/{oid}"

        async def _execute(client: httpx.AsyncClient) -> dict[str, Any]:
            resp = await client.delete(url, headers=headers, timeout=15.0)
            raise_for_provider_response(resp, "alpaca_trading")
            return {
                "order_id": oid,
                "status": "canceled",
                "http_status": resp.status_code,
            }

        if self._http_client is not None:
            return await _execute(self._http_client)
        async with httpx.AsyncClient() as client:
            return await _execute(client)

    async def close_position(
        self,
        symbol: str,
        *,
        qty: float | None = None,
        percentage: float | None = None,
    ) -> dict[str, Any]:
        """Close an open Alpaca Paper position (full or partial liquidation)."""
        headers = self._headers()
        sym = symbol.upper().strip()
        url = f"{self.trading_base}/v2/positions/{sym}"
        params: dict[str, str] = {}
        if qty is not None:
            params["qty"] = str(qty)
        elif percentage is not None:
            params["percentage"] = str(percentage)

        async def _execute(client: httpx.AsyncClient) -> dict[str, Any]:
            resp = await client.delete(url, headers=headers, params=params or None, timeout=20.0)
            raise_for_provider_response(resp, "alpaca_trading")
            data = resp.json() if resp.content else {}
            return {
                "id": str(data.get("id", "")),
                "client_order_id": data.get("client_order_id"),
                "symbol": str(data.get("symbol", sym)),
                "side": str(data.get("side", "")),
                "qty": str(data.get("qty", "")),
                "status": str(data.get("status", "accepted")),
                "filled_avg_price": data.get("filled_avg_price"),
                "submitted_at": data.get("submitted_at"),
            }

        if self._http_client is not None:
            return await _execute(self._http_client)
        async with httpx.AsyncClient() as client:
            return await _execute(client)

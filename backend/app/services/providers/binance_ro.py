from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from typing import Any
from urllib.parse import urlencode

import httpx
import redis.asyncio as aioredis
from redis.exceptions import RedisError

from app.services.resilience import (
    PermanentProviderError,
    ProviderError,
    ProviderUnconfiguredError,
    TransientProviderError,
    raise_for_provider_response,
)

logger = logging.getLogger(__name__)

_STABLECOINS = {"USDT", "USDC", "FDUSD", "BUSD", "TUSD", "USD", "DAI"}


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        if val is None or val == "":
            return default
        return float(val)
    except (TypeError, ValueError):
        return default


class BinanceReadOnlyClient:
    """Async Read-Only Binance Spot client supporting Global, Binance.US, and Spot Testnet."""

    ENDPOINTS = {
        "global": "https://api.binance.com",
        "us": "https://api.binance.us",
        "testnet": "https://testnet.binance.vision",
    }

    def __init__(
        self,
        *,
        api_key: str,
        api_secret: str,
        env: str = "global",
        redis_client: aioredis.Redis | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = api_key.strip()
        self._api_secret = api_secret.strip()
        norm_env = str(env).strip().lower()
        self._env = norm_env if norm_env in self.ENDPOINTS else "global"
        self._redis = redis_client
        self._http_client = http_client

    @property
    def base_url(self) -> str:
        return self.ENDPOINTS[self._env]

    def _validate(self) -> tuple[str, str]:
        if not self._api_key or not self._api_secret:
            raise ProviderUnconfiguredError("Binance API Key 与 API Secret 均不能为空。")
        return self._api_key, self._api_secret

    def _sign_query(self, params: dict[str, Any]) -> str:
        _, secret = self._validate()
        query = urlencode(params)
        sig = hmac.new(secret.encode("utf-8"), query.encode("utf-8"), hashlib.sha256).hexdigest()
        return f"{query}&signature={sig}"

    def _cache_scope(self) -> str:
        sig = f"{self._env}:{self._api_key}:{self._api_secret}"
        return hashlib.sha256(sig.encode("utf-8")).hexdigest()[:12]

    async def _read_cache(self, key: str) -> dict[str, Any] | None:
        if self._redis is None:
            return None
        try:
            raw = await self._redis.get(key)
            if raw:
                return json.loads(raw)
        except (RedisError, json.JSONDecodeError) as exc:
            logger.debug("Binance cache read skipped: %s", exc)
        return None

    async def _write_cache(self, key: str, payload: dict[str, Any], ttl: int) -> None:
        if self._redis is None:
            return
        try:
            await self._redis.setex(key, ttl, json.dumps(payload, default=str))
        except RedisError as exc:
            logger.debug("Binance cache write skipped: %s", exc)

    async def get_snapshot(self, *, force_refresh: bool = False) -> dict[str, Any]:
        """Fetch read-only spot balances marked against live USDT ticker prices."""
        scope = self._cache_scope()
        fresh_key = f"binance:snap:{scope}:fresh"
        stale_key = f"binance:snap:{scope}:stale"

        if not force_refresh:
            cached = await self._read_cache(fresh_key)
            if cached is not None:
                return cached

        api_key, _ = self._validate()
        signed_qs = self._sign_query({"timestamp": int(time.time() * 1000), "recvWindow": 10000})
        owns_client = self._http_client is None
        client = self._http_client or httpx.AsyncClient(timeout=15.0)
        try:
            acct_resp = await client.get(
                f"{self.base_url}/api/v3/account?{signed_qs}",
                headers={"X-MBX-APIKEY": api_key, "Accept": "application/json"},
            )
            if acct_resp.status_code in (401, 403):
                raise PermanentProviderError(
                    "Binance Read-Only API 鉴权失败（401/403），请核对 Key/Secret 与 IP 白名单、仅启用 Reading 权限。"
                )
            raise_for_provider_response(acct_resp, "binance")
            acct_payload = acct_resp.json()

            price_resp = await client.get(
                f"{self.base_url}/api/v3/ticker/price",
                headers={"Accept": "application/json"},
            )
            raise_for_provider_response(price_resp, "binance")
            ticker_prices = {
                str(item.get("symbol", "")).upper(): _safe_float(item.get("price"))
                for item in price_resp.json()
                if isinstance(item, dict)
            }

            cash_usd = 0.0
            invested_usd = 0.0
            positions: list[dict[str, Any]] = []

            for bal in acct_payload.get("balances") or []:
                asset = str(bal.get("asset") or "").upper().strip()
                qty = _safe_float(bal.get("free")) + _safe_float(bal.get("locked"))
                if not asset or qty <= 1e-8:
                    continue
                if asset in _STABLECOINS:
                    cash_usd += qty
                    continue

                usd_px = (
                    ticker_prices.get(f"{asset}USDT")
                    or ticker_prices.get(f"{asset}USD")
                    or ticker_prices.get(f"{asset}USDC")
                    or 0.0
                )
                mv = qty * usd_px
                # Filter dust positions (< $1) when valued cleanly
                if usd_px > 0 and mv < 1.0:
                    continue
                if usd_px <= 0 and qty < 0.001:
                    continue

                invested_usd += mv
                positions.append(
                    {
                        "symbol": f"{asset}-USD" if usd_px > 0 else asset,
                        "raw_ticker": asset,
                        "qty": round(qty, 6),
                        "side": "long",
                        "avg_entry_price": round(usd_px, 4),
                        "current_price": round(usd_px, 4),
                        "market_value": round(mv, 2),
                        "unrealized_pl": 0.0,
                        "unrealized_plpc": 0.0,
                        "currency": "USD",
                        "read_only": True,
                    }
                )

            positions.sort(key=lambda p: p["market_value"], reverse=True)
            equity = round(cash_usd + invested_usd, 2)
            snapshot = {
                "account": {
                    "id": f"binance-{self._env}",
                    "status": "ACTIVE",
                    "currency": "USD",
                    "equity": equity,
                    "cash": round(cash_usd, 2),
                    "buying_power": round(cash_usd, 2),
                    "portfolio_value": equity,
                    "invested_value": round(invested_usd, 2),
                    "unrealized_pl": 0.0,
                    "broker": "binance",
                    "read_only": True,
                },
                "positions": positions[:30],
                "orders": [],
            }
            await self._write_cache(fresh_key, snapshot, 60)
            await self._write_cache(stale_key, snapshot, 3600)
            return snapshot
        except httpx.HTTPError as exc:
            stale = await self._read_cache(stale_key)
            if stale is not None:
                return stale
            raise TransientProviderError(f"连接 Binance Spot API 失败: {exc}") from exc
        except ProviderError:
            stale = await self._read_cache(stale_key)
            if stale is not None:
                return stale
            raise
        finally:
            if owns_client:
                await client.aclose()

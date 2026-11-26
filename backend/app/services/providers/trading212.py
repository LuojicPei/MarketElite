from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Any

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

_TICKER_SUFFIX_RE = re.compile(r"_(US|UK|L|DE|FR|NL|ES|CH|CA)_(?:EQ|ETF)$", re.IGNORECASE)
_INSTRUMENTS_MEM_CACHE: dict[str, dict[str, Any]] = {}


def normalize_t212_ticker(raw_ticker: str, short_name: str | None = None) -> str:
    """Convert Trading212 instrument tickers (e.g. AAPL_US_EQ) to MarketElite uppercase symbols."""
    if short_name and re.fullmatch(r"[A-Za-z0-9.\-]{1,12}", short_name.strip()):
        return short_name.strip().upper()
    cleaned = (raw_ticker or "").strip().upper()
    if not cleaned:
        return "UNKNOWN"
    stripped = _TICKER_SUFFIX_RE.sub("", cleaned)
    if stripped != cleaned:
        return stripped
    if "_" in cleaned:
        return cleaned.split("_", 1)[0]
    return cleaned


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        if val is None or val == "":
            return default
        return float(val)
    except (TypeError, ValueError):
        return default


class Trading212Client:
    """Async read-first Trading212 v0 API client (supports Live Invest/ISA & Demo Practice)."""

    LIVE_BASE = "https://live.trading212.com/api/v0"
    DEMO_BASE = "https://demo.trading212.com/api/v0"

    def __init__(
        self,
        *,
        api_key: str,
        api_secret: str,
        env: str = "live",
        redis_client: aioredis.Redis | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = api_key.strip()
        self._api_secret = api_secret.strip()
        self._env = "demo" if str(env).strip().lower() == "demo" else "live"
        self._redis = redis_client
        self._http_client = http_client

    @property
    def env(self) -> str:
        return self._env

    @property
    def base_url(self) -> str:
        return self.DEMO_BASE if self._env == "demo" else self.LIVE_BASE

    def _auth(self) -> tuple[str, str]:
        if not self._api_key or not self._api_secret:
            raise ProviderUnconfiguredError(
                "Trading212 API Key 和 API Secret 均不能为空。"
            )
        return (self._api_key, self._api_secret)

    def _cache_scope(self) -> str:
        sig = f"{self._env}:{self._api_key}:{self._api_secret}"
        return hashlib.sha256(sig.encode("utf-8")).hexdigest()[:12]

    async def _cache_get(self, suffix: str) -> Any | None:
        if self._redis is None:
            return None
        key = f"marketelite:t212:{self._cache_scope()}:{suffix}"
        try:
            raw = await self._redis.get(key)
            return json.loads(raw) if raw else None
        except (RedisError, json.JSONDecodeError, TypeError):
            return None

    async def _cache_set(self, suffix: str, value: Any, ttl_seconds: int) -> None:
        if self._redis is None:
            return
        key = f"marketelite:t212:{self._cache_scope()}:{suffix}"
        try:
            await self._redis.setex(key, ttl_seconds, json.dumps(value, ensure_ascii=False))
        except (RedisError, TypeError, ValueError):
            pass

    async def _request_json(self, path: str, *, params: dict[str, Any] | None = None) -> Any:
        auth = self._auth()
        url = f"{self.base_url}{path}"

        async def _do(client: httpx.AsyncClient) -> Any:
            resp = await client.get(
                url,
                auth=auth,
                params=params,
                headers={"Accept": "application/json"},
                timeout=16.0,
            )
            if resp.status_code in (401, 403):
                raise PermanentProviderError(
                    f"Trading212 鉴权或权限不足（HTTP {resp.status_code}），"
                    "请检查 Key / Secret、环境（Live vs Demo）及是否勾选 Account data / Portfolio / History - Orders / Orders - Read。"
                )
            if resp.status_code == 429:
                reset_ts = resp.headers.get("x-ratelimit-reset")
                hint = f"（重置时间戳 {reset_ts}）" if reset_ts else ""
                raise TransientProviderError(
                    f"触发 Trading212 接口频控（429 Too Many Requests）{hint}，请稍候 10~30 秒再同步。"
                )
            raise_for_provider_response(resp, "trading212")
            return resp.json() if resp.text else {}

        try:
            if self._http_client is not None:
                return await _do(self._http_client)
            async with httpx.AsyncClient(follow_redirects=True) as client:
                return await _do(client)
        except httpx.TimeoutException as exc:
            raise TransientProviderError(f"Trading212 请求超时：{exc}") from exc
        except httpx.HTTPError as exc:
            raise TransientProviderError(f"Trading212 网络异常：{exc}") from exc

    async def get_instruments_map(self, *, force_refresh: bool = False) -> dict[str, dict[str, Any]]:
        """Fetch Trading212 metadata instruments map keyed by raw ticker (e.g. AAPL_US_EQ)."""
        if not force_refresh:
            cached = await self._cache_get("instruments_v1")
            if isinstance(cached, dict) and cached:
                return cached
            if self._env in _INSTRUMENTS_MEM_CACHE and _INSTRUMENTS_MEM_CACHE[self._env]:
                return _INSTRUMENTS_MEM_CACHE[self._env]

        try:
            raw_list = await self._request_json("/equity/metadata/instruments")
        except ProviderError as exc:
            logger.info("Trading212 metadata instruments skipped (%s)", exc)
            return _INSTRUMENTS_MEM_CACHE.get(self._env, {})

        mapped: dict[str, dict[str, Any]] = {}
        if isinstance(raw_list, list):
            for item in raw_list:
                if not isinstance(item, dict):
                    continue
                ticker = str(item.get("ticker", "")).strip()
                if not ticker:
                    continue
                short_name = str(item.get("shortName") or "").strip() or None
                mapped[ticker] = {
                    "symbol": normalize_t212_ticker(ticker, short_name),
                    "name": str(item.get("name") or short_name or ticker),
                    "currency": str(item.get("currencyCode") or "USD").upper(),
                    "type": str(item.get("type") or "STOCK"),
                }
        if mapped:
            _INSTRUMENTS_MEM_CACHE[self._env] = mapped
            await self._cache_set("instruments_v1", mapped, ttl_seconds=43200)
        return mapped

    async def get_account_summary(self, *, force_refresh: bool = False) -> dict[str, Any]:
        """Fetch and normalize Trading212 account cash, total value, unrealized/realized P&L & currency."""
        if not force_refresh:
            cached = await self._cache_get("account_summary_v1")
            if isinstance(cached, dict) and cached:
                return cached

        raw: dict[str, Any] = {}
        try:
            res = await self._request_json("/equity/account/summary")
            if isinstance(res, dict):
                raw = res
        except PermanentProviderError as exc:
            if "404" in str(exc):
                cash_res = await self._request_json("/equity/account/cash")
                info_res = await self._request_json("/equity/account/info")
                raw = {**(cash_res if isinstance(cash_res, dict) else {}), **(info_res if isinstance(info_res, dict) else {})}
            else:
                raise

        cash_obj = raw.get("cash") if isinstance(raw.get("cash"), dict) else {}
        inv_obj = raw.get("investments") if isinstance(raw.get("investments"), dict) else {}

        currency = str(
            raw.get("currency")
            or raw.get("currencyCode")
            or "GBP"
        ).upper()
        available_cash = _safe_float(
            cash_obj.get("availableToTrade")
            if "availableToTrade" in cash_obj
            else raw.get("free"),
            0.0,
        )
        invested_val = _safe_float(
            inv_obj.get("currentValue")
            if "currentValue" in inv_obj
            else (_safe_float(raw.get("invested")) + _safe_float(raw.get("ppl"))),
            0.0,
        )
        total_equity = _safe_float(
            raw.get("totalValue") if "totalValue" in raw else raw.get("total"),
            round(available_cash + invested_val, 2),
        )
        unrealized_pl = _safe_float(
            inv_obj.get("unrealizedProfitLoss")
            if "unrealizedProfitLoss" in inv_obj
            else raw.get("ppl"),
            0.0,
        )
        realized_pl = _safe_float(
            inv_obj.get("realizedProfitLoss")
            if "realizedProfitLoss" in inv_obj
            else raw.get("result"),
            0.0,
        )

        normalized = {
            "id": str(raw.get("id") or f"t212-{self._env}"),
            "status": "ACTIVE",
            "currency": currency,
            "equity": round(total_equity, 2),
            "cash": round(available_cash, 2),
            "buying_power": round(available_cash, 2),
            "portfolio_value": round(total_equity, 2),
            "invested_value": round(invested_val, 2),
            "unrealized_pl": round(unrealized_pl, 2),
            "realized_pl": round(realized_pl, 2),
            "paper": self._env == "demo",
            "broker": "trading212",
            "env": self._env,
            "read_only": True,
        }
        await self._cache_set("account_summary_v1", normalized, ttl_seconds=25)
        return normalized

    async def get_positions(self, *, force_refresh: bool = False) -> list[dict[str, Any]]:
        """Fetch and normalize open Trading212 positions with clean symbol mapping."""
        if not force_refresh:
            cached = await self._cache_get("positions_v1")
            if isinstance(cached, list):
                return cached

        raw_positions = await self._request_json("/equity/positions")
        inst_map = await self.get_instruments_map(force_refresh=False)

        rows: list[dict[str, Any]] = []
        if isinstance(raw_positions, list):
            for p in raw_positions:
                if not isinstance(p, dict):
                    continue
                inst = p.get("instrument") if isinstance(p.get("instrument"), dict) else {}
                wallet = p.get("walletImpact") if isinstance(p.get("walletImpact"), dict) else {}
                raw_ticker = str(inst.get("ticker") or p.get("ticker") or "").strip()
                meta = inst_map.get(raw_ticker, {})
                sym = meta.get("symbol") or normalize_t212_ticker(raw_ticker, inst.get("shortName"))

                qty = _safe_float(p.get("quantity"), 0.0)
                if qty <= 0:
                    continue
                avg_entry = _safe_float(
                    p.get("averagePricePaid")
                    if "averagePricePaid" in p
                    else p.get("averagePrice"),
                    0.0,
                )
                cur_px = _safe_float(p.get("currentPrice"), avg_entry)

                # Prefer wallet impact (account currency) when supplied, else quote currency product
                total_cost = _safe_float(wallet.get("totalCost"), qty * avg_entry)
                market_val = _safe_float(wallet.get("currentValue"), qty * cur_px)
                upl = _safe_float(
                    wallet.get("unrealizedProfitLoss")
                    if "unrealizedProfitLoss" in wallet
                    else p.get("ppl"),
                    market_val - total_cost,
                )
                upl_pct = (upl / total_cost) if total_cost > 0 else (
                    ((cur_px - avg_entry) / avg_entry) if avg_entry > 0 else 0.0
                )

                rows.append(
                    {
                        "symbol": sym,
                        "raw_ticker": raw_ticker,
                        "name": str(inst.get("name") or meta.get("name") or sym),
                        "qty": round(qty, 6),
                        "side": "long",
                        "avg_entry_price": round(avg_entry, 4),
                        "current_price": round(cur_px, 4),
                        "market_value": round(market_val, 2),
                        "unrealized_pl": round(upl, 2),
                        "unrealized_plpc": round(upl_pct, 6),
                        "currency": str(
                            wallet.get("currency")
                            or inst.get("currency")
                            or meta.get("currency")
                            or "USD"
                        ).upper(),
                        "instrument_currency": str(
                            inst.get("currency") or meta.get("currency") or "USD"
                        ).upper(),
                    }
                )

        rows.sort(key=lambda r: float(r.get("market_value", 0)), reverse=True)
        await self._cache_set("positions_v1", rows, ttl_seconds=25)
        return rows

    async def get_orders(self, *, force_refresh: bool = False) -> list[dict[str, Any]]:
        """Fetch currently working/pending Trading212 orders (requires Orders - Read)."""
        if not force_refresh:
            cached = await self._cache_get("orders_v1")
            if isinstance(cached, list):
                return cached

        raw_orders = await self._request_json("/equity/orders")
        inst_map = await self.get_instruments_map(force_refresh=False)
        out: list[dict[str, Any]] = []
        if isinstance(raw_orders, list):
            for ord_item in raw_orders:
                if not isinstance(ord_item, dict):
                    continue
                inst = ord_item.get("instrument") if isinstance(ord_item.get("instrument"), dict) else {}
                raw_ticker = str(inst.get("ticker") or ord_item.get("ticker") or "").strip()
                meta = inst_map.get(raw_ticker, {})
                sym = meta.get("symbol") or normalize_t212_ticker(raw_ticker, inst.get("shortName"))

                raw_qty = _safe_float(ord_item.get("quantity"), 0.0)
                side_raw = str(ord_item.get("side") or "").strip().lower()
                side = side_raw if side_raw in ("buy", "sell") else ("sell" if raw_qty < 0 else "buy")
                qty_abs = abs(raw_qty) if raw_qty != 0 else _safe_float(ord_item.get("value"), 0.0)
                ord_type = str(ord_item.get("type") or "MARKET").lower()
                out.append(
                    {
                        "id": str(ord_item.get("id") or ""),
                        "symbol": sym,
                        "raw_ticker": raw_ticker,
                        "side": side,
                        "qty": f"{qty_abs:g}",
                        "order_class": "t212_" + ord_type,
                        "type": ord_type,
                        "status": str(ord_item.get("status") or "new").lower(),
                        "limit_price": ord_item.get("limitPrice"),
                        "stop_price": ord_item.get("stopPrice"),
                        "filled_avg_price": ord_item.get("filledValue"),
                        "created_at": ord_item.get("createdAt") or ord_item.get("creationTime"),
                    }
                )
        await self._cache_set("orders_v1", out, ttl_seconds=25)
        return out

    async def get_historical_orders(
        self, *, limit: int = 35, force_refresh: bool = False
    ) -> list[dict[str, Any]]:
        """Fetch filled/historical Trading212 equity orders for ledger import & post-trade attribution."""
        if not force_refresh:
            cached = await self._cache_get(f"history_orders_{limit}_v1")
            if isinstance(cached, list):
                return cached

        raw_payload = await self._request_json(
            "/equity/history/orders", params={"limit": max(1, min(50, limit))}
        )
        inst_map = await self.get_instruments_map(force_refresh=False)
        items = raw_payload.get("items", []) if isinstance(raw_payload, dict) else (
            raw_payload if isinstance(raw_payload, list) else []
        )

        out: list[dict[str, Any]] = []
        for entry in items:
            if not isinstance(entry, dict):
                continue
            ord_obj = entry.get("order") if isinstance(entry.get("order"), dict) else entry
            fill_obj = entry.get("fill") if isinstance(entry.get("fill"), dict) else {}
            wallet = (
                fill_obj.get("walletImpact")
                if isinstance(fill_obj.get("walletImpact"), dict)
                else {}
            )
            inst = ord_obj.get("instrument") if isinstance(ord_obj.get("instrument"), dict) else {}
            raw_ticker = str(inst.get("ticker") or ord_obj.get("ticker") or "").strip()
            meta = inst_map.get(raw_ticker, {})
            sym = meta.get("symbol") or normalize_t212_ticker(raw_ticker, inst.get("shortName"))

            raw_qty = _safe_float(
                fill_obj.get("quantity")
                or ord_obj.get("filledQuantity")
                or ord_obj.get("quantity"),
                0.0,
            )
            side_raw = str(ord_obj.get("side") or "").strip().lower()
            side = side_raw if side_raw in ("buy", "sell") else ("sell" if raw_qty < 0 else "buy")
            qty_abs = abs(raw_qty)
            fill_px = _safe_float(
                fill_obj.get("price") or ord_obj.get("fillPrice") or ord_obj.get("limitPrice"),
                0.0,
            )
            realized_pnl = (
                _safe_float(wallet.get("realizedProfitLoss"), 0.0)
                if wallet.get("realizedProfitLoss") is not None
                else (
                    _safe_float(ord_obj.get("fillResult"), 0.0)
                    if ord_obj.get("fillResult") is not None
                    else None
                )
            )
            filled_at = (
                fill_obj.get("filledAt")
                or ord_obj.get("dateExecuted")
                or ord_obj.get("dateModified")
                or ord_obj.get("createdAt")
            )
            out.append(
                {
                    "external_id": f"t212:{ord_obj.get('id') or fill_obj.get('id') or ''}",
                    "order_id": str(ord_obj.get("id") or ""),
                    "symbol": sym,
                    "raw_ticker": raw_ticker,
                    "side": side,
                    "qty": round(qty_abs, 6),
                    "fill_price": round(fill_px, 4) if fill_px > 0 else None,
                    "realized_pnl": round(realized_pnl, 2) if realized_pnl is not None else None,
                    "order_type": str(ord_obj.get("type") or "MARKET").lower(),
                    "status": str(ord_obj.get("status") or "FILLED").lower(),
                    "filled_at": filled_at,
                    "currency": str(wallet.get("currency") or inst.get("currency") or "GBP").upper(),
                }
            )

        await self._cache_set(f"history_orders_{limit}_v1", out, ttl_seconds=60)
        return out

    async def test_connection(self) -> dict[str, Any]:
        """Validate Trading212 credentials & permissions cleanly for Settings diagnostics."""
        summary = await self.get_account_summary(force_refresh=True)
        positions_count = 0
        warnings: list[str] = []
        try:
            positions = await self.get_positions(force_refresh=True)
            positions_count = len(positions)
        except ProviderError as exc:
            warnings.append(f"Portfolio 未开启或限流: {exc}")

        try:
            orders = await self.get_orders(force_refresh=True)
            pending_count = len(orders)
        except ProviderError as exc:
            pending_count = 0
            warnings.append(f"Orders - Read 未开启或限流: {exc}")

        return {
            "ok": True,
            "env": self._env,
            "currency": summary["currency"],
            "equity": summary["equity"],
            "cash": summary["cash"],
            "unrealized_pl": summary.get("unrealized_pl", 0.0),
            "positions_count": positions_count,
            "pending_orders_count": pending_count,
            "warnings": warnings,
        }

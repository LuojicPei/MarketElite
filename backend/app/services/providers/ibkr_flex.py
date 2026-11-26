from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
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


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        if val is None or val == "":
            return default
        return float(val)
    except (TypeError, ValueError):
        return default


def _normalize_ibkr_symbol(raw_sym: str) -> str:
    sym = (raw_sym or "").strip().upper()
    if " " in sym:
        sym = sym.split(" ", 1)[0]
    return sym or "UNKNOWN"


class IBKRFlexClient:
    """Async Interactive Brokers Flex Web Service v3 Read-Only client.

    Designed specifically for public-web multi-user deployments: users supply a read-only
    IBKR Flex Token + Query ID without needing a local TWS/Gateway proxy.
    """

    DEFAULT_ENDPOINT = (
        "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService"
    )

    def __init__(
        self,
        *,
        flex_token: str,
        query_id: str,
        redis_client: aioredis.Redis | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._token = flex_token.strip()
        self._query_id = query_id.strip()
        self._redis = redis_client
        self._http_client = http_client

    def _validate(self) -> tuple[str, str]:
        if not self._token or not self._query_id:
            raise ProviderUnconfiguredError(
                "Interactive Brokers Flex Token 与 Query ID 均不能为空。"
            )
        return self._token, self._query_id

    def _cache_scope(self) -> str:
        sig = f"{self._token}:{self._query_id}"
        return hashlib.sha256(sig.encode("utf-8")).hexdigest()[:12]

    async def _read_cache(self, cache_key: str) -> dict[str, Any] | None:
        if self._redis is None:
            return None
        try:
            raw = await self._redis.get(cache_key)
            if raw:
                return json.loads(raw)
        except (RedisError, json.JSONDecodeError) as exc:
            logger.debug("IBKR cache read failed: %s", exc)
        return None

    async def _write_cache(self, cache_key: str, payload: dict[str, Any], ttl: int) -> None:
        if self._redis is None:
            return
        try:
            await self._redis.setex(cache_key, ttl, json.dumps(payload, default=str))
        except RedisError as exc:
            logger.debug("IBKR cache write failed: %s", exc)

    async def _fetch_xml(self) -> str:
        token, query_id = self._validate()
        params = {"t": token, "q": query_id, "v": "3"}
        owns_client = self._http_client is None
        client = self._http_client or httpx.AsyncClient(timeout=20.0)
        try:
            send_resp = await client.get(
                f"{self.DEFAULT_ENDPOINT}/SendRequest",
                params=params,
                headers={"User-Agent": "MarketElite/1.0"},
            )
            raise_for_provider_response(send_resp, "ibkr_flex")
            try:
                root = ET.fromstring(send_resp.text)
            except ET.ParseError as exc:
                raise TransientProviderError(
                    f"IBKR Flex SendRequest 返回了无法解析的响应: {exc}"
                ) from exc

            status = (root.findtext("Status") or "").strip().lower()
            if status != "success":
                err_code = (root.findtext("ErrorCode") or "").strip()
                err_msg = (root.findtext("ErrorMessage") or "IBKR Flex authorization failed").strip()
                if err_code in ("1018", "1019", "1021"):
                    raise TransientProviderError(
                        f"IBKR 报表仍在排队生成中 ({err_code}: {err_msg})，请稍后重试。"
                    )
                raise PermanentProviderError(
                    f"IBKR Flex 鉴权或配置异常 ({err_code or 'ERR'}): {err_msg}"
                )

            ref_code = (root.findtext("ReferenceCode") or "").strip()
            base_url = (root.findtext("Url") or f"{self.DEFAULT_ENDPOINT}/GetStatement").strip()
            if not ref_code:
                raise PermanentProviderError("IBKR Flex 未返回 ReferenceCode。")

            # IBKR may take ~1s to materialize statement XML (code 1019)
            stmt_xml = ""
            for attempt in range(3):
                get_resp = await client.get(
                    base_url,
                    params={"q": ref_code, "t": token, "v": "3"},
                    headers={"User-Agent": "MarketElite/1.0"},
                )
                raise_for_provider_response(get_resp, "ibkr_flex")
                text = get_resp.text
                if "<FlexQueryResponse" in text or "<FlexStatements" in text:
                    stmt_xml = text
                    break
                if "1019" in text and attempt < 2:
                    await asyncio.sleep(0.8)
                    continue
                raise PermanentProviderError(
                    "IBKR Flex GetStatement 返回异常状态，请确认 Query 已启用 XML 输出与持仓段。"
                )
            return stmt_xml
        except httpx.HTTPError as exc:
            raise TransientProviderError(f"无法连接 IBKR Flex 服务: {exc}") from exc
        finally:
            if owns_client:
                await client.aclose()

    @staticmethod
    def parse_flex_xml(xml_text: str) -> dict[str, Any]:
        """Parse IBKR Flex XML statement into normalized account, positions, and historical trades."""
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError as exc:
            raise PermanentProviderError(f"IBKR Flex XML 格式解析失败: {exc}") from exc

        stmt_el = root.find(".//FlexStatement")
        acct_info = root.find(".//AccountInformation")
        currency = (
            (acct_info.attrib.get("currency") if acct_info is not None else None)
            or (stmt_el.attrib.get("currency") if stmt_el is not None else None)
            or "USD"
        ).upper()
        acct_id = (
            (acct_info.attrib.get("accountId") if acct_info is not None else None)
            or (stmt_el.attrib.get("accountId") if stmt_el is not None else None)
            or "ibkr-flex"
        )

        # Cash and NAV detection
        ending_cash: float | None = None
        for cash_el in root.findall(".//CashReportCurrency"):
            c_cur = (cash_el.attrib.get("currency") or "").upper()
            if c_cur in ("BASE_SUMMARY", currency, "USD"):
                ending_cash = _safe_float(cash_el.attrib.get("endingCash"))
                if c_cur == "BASE_SUMMARY":
                    break

        eq_el = root.find(".//EquitySummaryByReportDateInBase")
        nav_total = _safe_float(eq_el.attrib.get("total")) if eq_el is not None else None
        if ending_cash is None and eq_el is not None:
            ending_cash = _safe_float(eq_el.attrib.get("cash"))

        positions: list[dict[str, Any]] = []
        mv_sum = 0.0
        upl_sum = 0.0
        for pos_el in root.findall(".//OpenPosition"):
            qty = _safe_float(pos_el.attrib.get("position"))
            if abs(qty) < 1e-6:
                continue
            raw_sym = pos_el.attrib.get("symbol") or pos_el.attrib.get("underlyingSymbol") or ""
            sym = _normalize_ibkr_symbol(raw_sym)
            mark_px = _safe_float(pos_el.attrib.get("markPrice"))
            cost_px = _safe_float(
                pos_el.attrib.get("costBasisPrice") or pos_el.attrib.get("openPrice"),
                mark_px,
            )
            mv = _safe_float(pos_el.attrib.get("positionValue"), abs(qty) * mark_px)
            upl = _safe_float(
                pos_el.attrib.get("fifoPnlUnrealized"),
                (mark_px - cost_px) * qty,
            )
            cost_total = abs(qty) * cost_px
            upl_pct = (upl / cost_total) if cost_total > 0 else 0.0
            pos_ccy = (pos_el.attrib.get("currency") or currency).upper()

            mv_sum += mv
            upl_sum += upl
            positions.append(
                {
                    "symbol": sym,
                    "raw_ticker": raw_sym or sym,
                    "qty": round(abs(qty), 4),
                    "side": "long" if qty > 0 else "short",
                    "avg_entry_price": round(cost_px, 4),
                    "current_price": round(mark_px, 4),
                    "market_value": round(mv, 2),
                    "unrealized_pl": round(upl, 2),
                    "unrealized_plpc": round(upl_pct, 6),
                    "currency": pos_ccy,
                    "asset_category": pos_el.attrib.get("assetCategory", "STK"),
                    "read_only": True,
                }
            )

        trades: list[dict[str, Any]] = []
        for idx, tr_el in enumerate(root.findall(".//Trade")):
            raw_sym = tr_el.attrib.get("symbol") or ""
            qty = abs(_safe_float(tr_el.attrib.get("quantity")))
            if not raw_sym or qty <= 0:
                continue
            buy_sell = (tr_el.attrib.get("buySell") or "BUY").strip().lower()
            side = "sell" if buy_sell.startswith("s") else "buy"
            px = _safe_float(tr_el.attrib.get("tradePrice"))
            realized = (
                _safe_float(tr_el.attrib.get("fifoPnlRealized"))
                if tr_el.attrib.get("fifoPnlRealized") not in (None, "")
                else None
            )
            trade_dt = tr_el.attrib.get("dateTime") or tr_el.attrib.get("tradeDate") or ""
            ext_id = tr_el.attrib.get("ibOrderID") or tr_el.attrib.get("tradeID") or f"flex-{idx}"
            trades.append(
                {
                    "external_id": f"ibkr:{ext_id}",
                    "symbol": _normalize_ibkr_symbol(raw_sym),
                    "raw_ticker": raw_sym,
                    "side": side,
                    "order_type": (tr_el.attrib.get("orderType") or "LMT").lower(),
                    "status": "filled",
                    "qty": qty,
                    "fill_price": round(px, 4) if px > 0 else None,
                    "realized_pnl": realized,
                    "filled_at": trade_dt or datetime.now(timezone.utc).isoformat(),
                }
            )

        cash_val = round(ending_cash if ending_cash is not None else 0.0, 2)
        equity_val = round(nav_total if (nav_total is not None and nav_total > 0) else (cash_val + mv_sum), 2)
        account = {
            "id": acct_id,
            "status": "ACTIVE",
            "currency": currency,
            "equity": equity_val,
            "cash": cash_val,
            "buying_power": max(0.0, cash_val),
            "portfolio_value": equity_val,
            "invested_value": round(mv_sum, 2),
            "unrealized_pl": round(upl_sum, 2),
            "broker": "ibkr",
            "read_only": True,
        }
        return {
            "account": account,
            "positions": positions,
            "orders": trades[:15],
            "trades": trades,
        }

    async def get_snapshot(self, *, force_refresh: bool = False) -> dict[str, Any]:
        """Fetch parsed IBKR Flex snapshot with short TTL caching and stale fallback."""
        scope = self._cache_scope()
        fresh_key = f"ibkr:snap:{scope}:fresh"
        stale_key = f"ibkr:snap:{scope}:stale"

        if not force_refresh:
            cached = await self._read_cache(fresh_key)
            if cached is not None:
                return cached

        try:
            xml_text = await self._fetch_xml()
            parsed = self.parse_flex_xml(xml_text)
            await self._write_cache(fresh_key, parsed, 90)
            await self._write_cache(stale_key, parsed, 3600)
            return parsed
        except ProviderError:
            stale = await self._read_cache(stale_key)
            if stale is not None:
                return stale
            raise

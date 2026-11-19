from __future__ import annotations

import csv
import io
from datetime import datetime
from typing import Any

import httpx

from app.services.resilience import (
    DualTTLCache,
    TransientProviderError,
    raise_for_provider_response,
)

CBOE_VIX_CSV_URLS: dict[str, str] = {
    "VIX": "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv",
    "VIX9D": "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX9D_History.csv",
    "VIX3M": "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX3M_History.csv",
}


def _parse_cboe_date(raw: str) -> str | None:
    text = raw.strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def parse_cboe_vix_csv(csv_text: str, limit: int = 260) -> list[dict[str, Any]]:
    """Parse official CBOE VIX/VIX9D/VIX3M daily historical CSV into normalized records."""
    reader = csv.reader(io.StringIO(csv_text.strip()))
    header = next(reader, None)
    if not header:
        return []

    lower_header = [h.strip().lower() for h in header]
    date_idx = 0
    if "close" in lower_header:
        close_idx = lower_header.index("close")
    else:
        close_idx = len(header) - 1

    rows: list[dict[str, Any]] = []
    for row in reader:
        if len(row) <= close_idx:
            continue
        parsed_date = _parse_cboe_date(row[date_idx])
        if parsed_date is None:
            continue
        val_raw = row[close_idx].strip()
        if not val_raw:
            continue
        try:
            rows.append({"obs_date": parsed_date, "value": float(val_raw)})
        except ValueError:
            continue
    return rows[-limit:]


class CboeClient:
    """Async keyless client for CBOE CDN VIX / VIX9D / VIX3M term structure CSVs."""

    def __init__(
        self,
        cache: DualTTLCache | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._cache = cache
        self._http_client = http_client

    async def _fetch_index_raw(self, index_code: str, limit: int = 260) -> list[dict[str, Any]]:
        url = CBOE_VIX_CSV_URLS[index_code]

        async def _execute(client: httpx.AsyncClient) -> list[dict[str, Any]]:
            resp = await client.get(url, timeout=15.0)
            raise_for_provider_response(resp, "cboe")
            parsed = parse_cboe_vix_csv(resp.text, limit=limit)
            if not parsed:
                raise TransientProviderError(f"Empty CBOE CSV returned for {index_code}")
            return parsed

        if self._http_client is not None:
            return await _execute(self._http_client)
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
            "Accept": "text/csv,text/plain,*/*",
        }
        async with httpx.AsyncClient(follow_redirects=True, headers=headers) as client:
            return await _execute(client)

    async def get_vix_series(
        self,
        index_code: str,
        *,
        limit: int = 260,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """Fetch CBOE volatility index history via DualTTLCache."""
        code = index_code.upper()
        if code not in CBOE_VIX_CSV_URLS:
            raise ValueError(f"Unsupported CBOE VIX index: {code}")

        cache_key = f"marketelite:cboe:{code}:{limit}"
        if self._cache is None:
            rows = await self._fetch_index_raw(code, limit=limit)
            return {
                "series_id": code,
                "observations": rows,
                "is_stale": False,
                "source": "cboe_csv",
            }

        res = await self._cache.get_or_fetch(
            cache_key,
            provider="cboe",
            fetcher=lambda: self._fetch_index_raw(code, limit=limit),
            soft_ttl_seconds=1800,
            hard_ttl_seconds=86400 * 5,
            force_refresh=force_refresh,
        )
        return {
            "series_id": code,
            "observations": res.data,
            "is_stale": res.is_stale,
            "cache_status": res.cache_status,
            "stale_reason": res.stale_reason,
            "fetched_at": res.fetched_at,
            "source": "cboe_csv",
        }

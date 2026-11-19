from __future__ import annotations

import csv
import io
from datetime import date, timedelta
from typing import Any

import httpx

from app.core.config import Settings
from app.services.resilience import (
    DualTTLCache,
    TransientProviderError,
    raise_for_provider_response,
)

FRED_CORE_SERIES: tuple[str, ...] = (
    "WALCL",
    "WTREGEN",
    "RRPONTSYD",
    "WRESBAL",
    "SOFR",
    "DGS2",
    "DGS10",
    "T10Y2Y",
    "DFII10",
    "BAMLH0A0HYM2",
    "BAMLC0A0CM",
    "VIXCLS",
)


class FredClient:
    """Async FRED client supporting official JSON API and keyless `fredgraph.csv` fallback."""

    def __init__(
        self,
        settings: Settings,
        cache: DualTTLCache | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._settings = settings
        self._cache = cache
        self._http_client = http_client

    async def _fetch_raw_observations(
        self,
        series_id: str,
        lookback_days: int = 420,
    ) -> list[dict[str, Any]]:
        start_date = (date.today() - timedelta(days=lookback_days)).isoformat()
        api_key = self._settings.fred_api_key.strip()

        async def _execute(client: httpx.AsyncClient) -> list[dict[str, Any]]:
            if api_key:
                url = "https://api.stlouisfed.org/fred/series/observations"
                params = {
                    "series_id": series_id,
                    "api_key": api_key,
                    "file_type": "json",
                    "observation_start": start_date,
                    "sort_order": "asc",
                }
                resp = await client.get(url, params=params, timeout=15.0)
                raise_for_provider_response(resp, "fred")
                payload = resp.json()
                rows: list[dict[str, Any]] = []
                for obs in payload.get("observations", []):
                    val_str = str(obs.get("value", "")).strip()
                    if not val_str or val_str == ".":
                        continue
                    try:
                        rows.append({"obs_date": str(obs["date"]), "value": float(val_str)})
                    except (KeyError, ValueError):
                        continue
                return rows

            # Keyless CSV fallback supported directly by FRED
            csv_url = "https://fred.stlouisfed.org/graph/fredgraph.csv"
            resp = await client.get(
                csv_url,
                params={"id": series_id, "cosd": start_date},
                timeout=15.0,
            )
            raise_for_provider_response(resp, "fred_csv")
            reader = csv.reader(io.StringIO(resp.text))
            header = next(reader, None)
            if not header or len(header) < 2:
                raise TransientProviderError(f"Unexpected FRED CSV header for {series_id}")
            rows = []
            for item in reader:
                if len(item) < 2:
                    continue
                obs_date, val_str = item[0].strip(), item[1].strip()
                if not val_str or val_str == ".":
                    continue
                try:
                    rows.append({"obs_date": obs_date, "value": float(val_str)})
                except ValueError:
                    continue
            return rows

        if self._http_client is not None:
            return await _execute(self._http_client)
        async with httpx.AsyncClient() as client:
            return await _execute(client)

    async def get_series(
        self,
        series_id: str,
        *,
        lookback_days: int = 420,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """Fetch FRED series through DualTTLCache + Redis circuit breaker when available."""
        cache_key = f"marketelite:fred:{series_id}:{lookback_days}"
        if self._cache is None:
            obs = await self._fetch_raw_observations(series_id, lookback_days)
            return {
                "series_id": series_id,
                "observations": obs,
                "is_stale": False,
                "source": "fred_api" if self._settings.fred_api_key.strip() else "fred_csv",
            }

        res = await self._cache.get_or_fetch(
            cache_key,
            provider="fred",
            fetcher=lambda: self._fetch_raw_observations(series_id, lookback_days),
            soft_ttl_seconds=3600,
            hard_ttl_seconds=86400 * 7,
            force_refresh=force_refresh,
        )
        return {
            "series_id": series_id,
            "observations": res.data,
            "is_stale": res.is_stale,
            "cache_status": res.cache_status,
            "stale_reason": res.stale_reason,
            "fetched_at": res.fetched_at,
            "source": "fred_api" if self._settings.fred_api_key.strip() else "fred_csv",
        }

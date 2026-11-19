from __future__ import annotations

import time
from typing import Any

import httpx
import pytest

from app.core.config import Settings
from app.services.providers.cboe import parse_cboe_vix_csv
from app.services.providers.fred import FredClient
from app.services.resilience import (
    DualTTLCache,
    PermanentProviderError,
    RedisCircuitBreaker,
    TransientProviderError,
    raise_for_provider_response,
)


class InMemoryFakeRedis:
    """Minimal async Redis test double supporting get/set/incr/expire/delete with TTL."""

    def __init__(self) -> None:
        self._store: dict[str, tuple[Any, float | None]] = {}

    def _evict_if_expired(self, key: str) -> None:
        entry = self._store.get(key)
        if entry is None:
            return
        _, expires_at = entry
        if expires_at is not None and time.time() >= expires_at:
            del self._store[key]

    async def get(self, key: str) -> Any:
        self._evict_if_expired(key)
        entry = self._store.get(key)
        return entry[0] if entry is not None else None

    async def set(self, key: str, value: Any, ex: int | None = None, nx: bool = False) -> bool:
        self._evict_if_expired(key)
        if nx and key in self._store:
            return False
        expires_at = (time.time() + ex) if ex is not None else None
        self._store[key] = (value, expires_at)
        return True

    async def incr(self, key: str) -> int:
        self._evict_if_expired(key)
        entry = self._store.get(key)
        if entry is None:
            new_val = 1
            expires_at = None
        else:
            new_val = int(entry[0]) + 1
            expires_at = entry[1]
        self._store[key] = (new_val, expires_at)
        return new_val

    async def expire(self, key: str, seconds: int) -> bool:
        entry = self._store.get(key)
        if entry is None:
            return False
        self._store[key] = (entry[0], time.time() + seconds)
        return True

    async def delete(self, *keys: str) -> int:
        deleted = 0
        for key in keys:
            if key in self._store:
                del self._store[key]
                deleted += 1
        return deleted

    async def aclose(self) -> None:
        return None


async def test_dual_ttl_cache_fresh_hit_and_stale_fallback_on_429() -> None:
    redis = InMemoryFakeRedis()
    cb = RedisCircuitBreaker(redis, failure_threshold=5, window_seconds=60, cooldown_seconds=60)
    cache = DualTTLCache(redis, cb, retry_attempts=2, retry_min_wait=0.0, retry_max_wait=0.0)

    calls = 0

    async def fetch_ok() -> dict[str, Any]:
        nonlocal calls
        calls += 1
        return {"spy_close": 592.5}

    res1 = await cache.get_or_fetch(
        "k:spy",
        provider="alpaca",
        fetcher=fetch_ok,
        soft_ttl_seconds=60,
        hard_ttl_seconds=3600,
    )
    assert res1.data == {"spy_close": 592.5}
    assert not res1.is_stale
    assert res1.cache_status == "refreshed"

    # Second read within soft TTL should come straight from cache
    res2 = await cache.get_or_fetch(
        "k:spy",
        provider="alpaca",
        fetcher=fetch_ok,
        soft_ttl_seconds=60,
        hard_ttl_seconds=3600,
    )
    assert res2.cache_status == "fresh_cache"
    assert calls == 1

    # Force soft expiry & simulate upstream HTTP 429
    fail_attempts = 0

    async def fetch_429() -> dict[str, Any]:
        nonlocal fail_attempts
        fail_attempts += 1
        resp = httpx.Response(429, text="rate limited")
        raise_for_provider_response(resp, "alpaca")
        return {}

    res3 = await cache.get_or_fetch(
        "k:spy",
        provider="alpaca",
        fetcher=fetch_429,
        soft_ttl_seconds=60,
        hard_ttl_seconds=3600,
        force_refresh=True,
    )
    assert fail_attempts == 2
    assert res3.is_stale is True
    assert res3.cache_status == "stale_fallback"
    assert "[Stale Cache]" in (res3.stale_reason or "")
    assert res3.data == {"spy_close": 592.5}


async def test_circuit_breaker_opens_after_five_transient_failures() -> None:
    redis = InMemoryFakeRedis()
    cb = RedisCircuitBreaker(redis, failure_threshold=5, window_seconds=60, cooldown_seconds=60)
    cache = DualTTLCache(redis, cb, retry_attempts=1, retry_min_wait=0.0, retry_max_wait=0.0)

    await cache.write_envelope(
        "k:fred:walcl",
        payload={"value": 6900000.0},
        source="fred",
        soft_ttl_seconds=60,
        hard_ttl_seconds=3600,
    )

    upstream_calls = 0

    async def fetch_503() -> dict[str, Any]:
        nonlocal upstream_calls
        upstream_calls += 1
        raise TransientProviderError("FRED 503 Service Unavailable")

    for _ in range(5):
        res = await cache.get_or_fetch(
            "k:fred:walcl",
            provider="fred",
            fetcher=fetch_503,
            soft_ttl_seconds=60,
            hard_ttl_seconds=3600,
            force_refresh=True,
        )
        assert res.is_stale is True

    assert upstream_calls == 5
    assert await cb.is_open("fred") is True

    # 6th call must short-circuit immediately without hitting upstream
    res_short = await cache.get_or_fetch(
        "k:fred:walcl",
        provider="fred",
        fetcher=fetch_503,
        soft_ttl_seconds=60,
        hard_ttl_seconds=3600,
        force_refresh=True,
    )
    assert upstream_calls == 5
    assert res_short.is_stale is True
    assert res_short.cache_status == "stale_circuit_open"
    assert res_short.data == {"value": 6900000.0}


async def test_permanent_error_is_not_retried() -> None:
    redis = InMemoryFakeRedis()
    cb = RedisCircuitBreaker(redis)
    cache = DualTTLCache(redis, cb, retry_attempts=3, retry_min_wait=0.0, retry_max_wait=0.0)

    attempts = 0

    async def fetch_401() -> dict[str, Any]:
        nonlocal attempts
        attempts += 1
        raise_for_provider_response(httpx.Response(401, text="Unauthorized"), "finnhub")
        return {}

    with pytest.raises(PermanentProviderError):
        await cache.get_or_fetch("k:earn", provider="finnhub", fetcher=fetch_401)

    assert attempts == 1


async def test_fred_csv_keyless_fallback_and_cboe_parser() -> None:
    csv_body = "observation_date,WALCL\n2026-10-07,6950000.0\n2026-10-14,.\n2026-10-21,6980000.5\n"
    transport = httpx.MockTransport(lambda req: httpx.Response(200, text=csv_body))
    async with httpx.AsyncClient(transport=transport) as client:
        fred = FredClient(Settings(fred_api_key=""), http_client=client)
        res = await fred.get_series("WALCL")
        assert res["source"] == "fred_csv"
        assert res["observations"] == [
            {"obs_date": "2026-10-07", "value": 6950000.0},
            {"obs_date": "2026-10-21", "value": 6980000.5},
        ]

    cboe_csv = "DATE,OPEN,HIGH,LOW,CLOSE\n10/20/2026,15.2,16.1,14.8,15.4\n2026-10-21,15.4,15.8,14.9,15.1\n"
    parsed = parse_cboe_vix_csv(cboe_csv)
    assert parsed == [
        {"obs_date": "2026-10-20", "value": 15.4},
        {"obs_date": "2026-10-21", "value": 15.1},
    ]

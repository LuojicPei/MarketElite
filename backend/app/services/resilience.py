from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Generic, TypeVar

import httpx
import redis.asyncio as aioredis
from redis.exceptions import RedisError
from tenacity import (
    AsyncRetrying,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

logger = logging.getLogger(__name__)

T = TypeVar("T")

TRANSIENT_HTTP_STATUSES = frozenset({429, 500, 502, 503, 504})
PERMANENT_HTTP_STATUSES = frozenset({400, 401, 403, 404, 422})


class ProviderError(Exception):
    """Base error for external market data providers."""


class TransientProviderError(ProviderError):
    """Temporary error eligible for exponential backoff retry (429, 5xx, timeout)."""


class PermanentProviderError(ProviderError):
    """Non-retryable error such as bad request, auth error, or invalid ticker."""


class ProviderUnconfiguredError(PermanentProviderError):
    """Raised when required provider credentials are missing from `.env`."""


class CircuitOpenError(ProviderError):
    """Raised when a provider circuit breaker is open and no stale cache is available."""


@dataclass(frozen=True)
class CacheResult(Generic[T]):
    """Envelope returned by DualTTLCache with explicit freshness and stale metadata."""

    data: T
    fetched_at: str
    source: str
    is_stale: bool
    cache_status: str
    stale_reason: str | None = None


def raise_for_provider_response(response: httpx.Response, provider: str) -> None:
    """Classify HTTP status codes into transient vs permanent provider errors."""
    status = response.status_code
    if 200 <= status < 300:
        return
    body_preview = response.text[:240] if response.text else ""
    msg = f"{provider} HTTP {status}: {body_preview}"
    if status in TRANSIENT_HTTP_STATUSES:
        raise TransientProviderError(msg)
    if status in PERMANENT_HTTP_STATUSES:
        raise PermanentProviderError(msg)
    if status >= 500:
        raise TransientProviderError(msg)
    raise PermanentProviderError(msg)


async def run_with_transient_retry(
    operation: Callable[[], Awaitable[T]],
    *,
    max_attempts: int = 3,
    min_wait_seconds: float = 0.5,
    max_wait_seconds: float = 8.0,
) -> T:
    """Execute async fetcher with exponential backoff strictly on transient errors."""
    try:
        async for attempt in AsyncRetrying(
            retry=retry_if_exception_type(
                (TransientProviderError, httpx.TimeoutException, httpx.TransportError)
            ),
            stop=stop_after_attempt(max_attempts),
            wait=wait_exponential(multiplier=0.5, min=min_wait_seconds, max=max_wait_seconds),
            reraise=True,
        ):
            with attempt:
                return await operation()
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        raise TransientProviderError(str(exc)) from exc
    raise RuntimeError("Unreachable retry exit")


class RedisCircuitBreaker:
    """Sliding-window Redis circuit breaker (trips for 60s after 5 failures in 60s)."""

    def __init__(
        self,
        redis_client: aioredis.Redis | None,
        *,
        failure_threshold: int = 5,
        window_seconds: int = 60,
        cooldown_seconds: int = 60,
        key_prefix: str = "marketelite:cb",
    ) -> None:
        self._redis = redis_client
        self._failure_threshold = failure_threshold
        self._window_seconds = window_seconds
        self._cooldown_seconds = cooldown_seconds
        self._prefix = key_prefix

    def _state_key(self, provider: str) -> str:
        return f"{self._prefix}:{provider}:state"

    def _fail_key(self, provider: str) -> str:
        return f"{self._prefix}:{provider}:failures"

    async def is_open(self, provider: str) -> bool:
        """Return True when circuit is currently open for provider."""
        if self._redis is None:
            return False
        try:
            state = await self._redis.get(self._state_key(provider))
            return state == "open"
        except RedisError as exc:
            logger.warning("Redis circuit check failed for %s: %s", provider, exc)
            return False

    async def record_success(self, provider: str) -> None:
        """Reset failure counters and close circuit after successful fetch."""
        if self._redis is None:
            return
        try:
            await self._redis.delete(self._state_key(provider), self._fail_key(provider))
        except RedisError as exc:
            logger.warning("Redis circuit reset failed for %s: %s", provider, exc)

    async def record_failure(self, provider: str) -> bool:
        """Increment failure window counter; return True if breaker tripped open."""
        if self._redis is None:
            return False
        fail_key = self._fail_key(provider)
        state_key = self._state_key(provider)
        try:
            count = await self._redis.incr(fail_key)
            if count == 1:
                await self._redis.expire(fail_key, self._window_seconds)
            if count >= self._failure_threshold:
                await self._redis.set(state_key, "open", ex=self._cooldown_seconds)
                logger.warning(
                    "Circuit breaker OPENED for %s (%s failures in %ss, cooldown=%ss)",
                    provider,
                    count,
                    self._window_seconds,
                    self._cooldown_seconds,
                )
                return True
            return False
        except RedisError as exc:
            logger.warning("Redis circuit failure write failed for %s: %s", provider, exc)
            return False


class DualTTLCache:
    """Soft-TTL / Hard-TTL Redis cache paired with circuit breaker & stale fallback."""

    def __init__(
        self,
        redis_client: aioredis.Redis | None,
        circuit_breaker: RedisCircuitBreaker | None = None,
        *,
        retry_attempts: int = 3,
        retry_min_wait: float = 0.5,
        retry_max_wait: float = 8.0,
    ) -> None:
        self._redis = redis_client
        self._cb = circuit_breaker or RedisCircuitBreaker(redis_client)
        self._retry_attempts = retry_attempts
        self._retry_min_wait = retry_min_wait
        self._retry_max_wait = retry_max_wait
        self._locks: dict[str, asyncio.Lock] = {}

    def _get_lock(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    async def read_envelope(self, cache_key: str) -> dict[str, Any] | None:
        """Read serialized JSON envelope from Redis if available."""
        if self._redis is None:
            return None
        try:
            raw = await self._redis.get(cache_key)
            if not raw:
                return None
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else None
        except (RedisError, json.JSONDecodeError) as exc:
            logger.warning("Failed reading cache key %s: %s", cache_key, exc)
            return None

    async def write_envelope(
        self,
        cache_key: str,
        *,
        payload: Any,
        source: str,
        soft_ttl_seconds: int,
        hard_ttl_seconds: int,
    ) -> dict[str, Any]:
        """Persist payload into Redis under Hard-TTL with explicit Soft-TTL expiry timestamp."""
        now_epoch = time.time()
        fetched_at = datetime.now(timezone.utc).isoformat()
        envelope = {
            "payload": payload,
            "fetched_at": fetched_at,
            "source": source,
            "soft_expires_at": now_epoch + soft_ttl_seconds,
        }
        if self._redis is not None:
            try:
                await self._redis.set(
                    cache_key,
                    json.dumps(envelope, default=str),
                    ex=max(hard_ttl_seconds, soft_ttl_seconds),
                )
            except RedisError as exc:
                logger.warning("Failed writing cache key %s: %s", cache_key, exc)
        return envelope

    async def get_or_fetch(
        self,
        cache_key: str,
        *,
        provider: str,
        fetcher: Callable[[], Awaitable[Any]],
        soft_ttl_seconds: int = 900,
        hard_ttl_seconds: int = 86400,
        force_refresh: bool = False,
    ) -> CacheResult[Any]:
        """Return fresh cache, refresh after Soft-TTL, or serve Stale Cache if upstream fails."""
        envelope = await self.read_envelope(cache_key)
        now_epoch = time.time()
        if (
            not force_refresh
            and envelope is not None
            and now_epoch < float(envelope.get("soft_expires_at", 0.0))
        ):
            return CacheResult(
                data=envelope["payload"],
                fetched_at=str(envelope.get("fetched_at", "")),
                source=str(envelope.get("source", provider)),
                is_stale=False,
                cache_status="fresh_cache",
            )

        lock = self._get_lock(cache_key)
        async with lock:
            # Double-check after acquiring per-key lock to prevent cache stampede
            envelope = await self.read_envelope(cache_key)
            now_epoch = time.time()
            if (
                not force_refresh
                and envelope is not None
                and now_epoch < float(envelope.get("soft_expires_at", 0.0))
            ):
                return CacheResult(
                    data=envelope["payload"],
                    fetched_at=str(envelope.get("fetched_at", "")),
                    source=str(envelope.get("source", provider)),
                    is_stale=False,
                    cache_status="fresh_cache",
                )

            if await self._cb.is_open(provider):
                if envelope is not None:
                    return CacheResult(
                        data=envelope["payload"],
                        fetched_at=str(envelope.get("fetched_at", "")),
                        source=str(envelope.get("source", provider)),
                        is_stale=True,
                        cache_status="stale_circuit_open",
                        stale_reason=f"[Stale Cache] {provider} circuit breaker open",
                    )
                raise CircuitOpenError(f"Circuit breaker open for {provider} and no cached data")

            try:
                payload = await run_with_transient_retry(
                    fetcher,
                    max_attempts=self._retry_attempts,
                    min_wait_seconds=self._retry_min_wait,
                    max_wait_seconds=self._retry_max_wait,
                )
            except PermanentProviderError as exc:
                logger.warning("Permanent provider error for %s (%s): %s", provider, cache_key, exc)
                if envelope is not None:
                    return CacheResult(
                        data=envelope["payload"],
                        fetched_at=str(envelope.get("fetched_at", "")),
                        source=str(envelope.get("source", provider)),
                        is_stale=True,
                        cache_status="stale_permanent_error",
                        stale_reason=f"[Stale Cache] {exc}",
                    )
                raise
            except TransientProviderError as exc:
                await self._cb.record_failure(provider)
                logger.warning("Transient provider error for %s (%s): %s", provider, cache_key, exc)
                if envelope is not None:
                    return CacheResult(
                        data=envelope["payload"],
                        fetched_at=str(envelope.get("fetched_at", "")),
                        source=str(envelope.get("source", provider)),
                        is_stale=True,
                        cache_status="stale_fallback",
                        stale_reason=f"[Stale Cache] {exc}",
                    )
                raise

            await self._cb.record_success(provider)
            written = await self.write_envelope(
                cache_key,
                payload=payload,
                source=provider,
                soft_ttl_seconds=soft_ttl_seconds,
                hard_ttl_seconds=hard_ttl_seconds,
            )
            return CacheResult(
                data=written["payload"],
                fetched_at=str(written["fetched_at"]),
                source=provider,
                is_stale=False,
                cache_status="refreshed",
            )

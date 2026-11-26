from __future__ import annotations

import math
from typing import Any

import httpx

from app.services.resilience import DualTTLCache, raise_for_provider_response

CNN_FEAR_GREED_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"

CNN_BROWSER_HEADERS: dict[str, str] = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Referer": "https://edition.cnn.com/",
    "Origin": "https://edition.cnn.com",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
}

CNN_PILLAR_SPECS: tuple[tuple[str, str], ...] = (
    ("market_momentum_sp500", "momentum"),
    ("stock_price_strength", "strength"),
    ("stock_price_breadth", "breadth"),
    ("put_call_options", "put_call"),
    ("market_volatility_vix", "volatility"),
    ("junk_bond_demand", "junk_bond"),
    ("safe_haven_demand", "safe_haven"),
)


def _safe_float(val: Any) -> float | None:
    if val is None or val == "":
        return None
    try:
        num = float(val)
        return num if math.isfinite(num) else None
    except (TypeError, ValueError):
        return None


def _normalize_rating(raw: Any, score: float | None = None) -> str:
    text = str(raw or "").strip().lower()
    mapping = {
        "extreme fear": "Extreme Fear",
        "fear": "Fear",
        "neutral": "Neutral",
        "greed": "Greed",
        "extreme greed": "Extreme Greed",
    }
    if text in mapping:
        return mapping[text]
    if score is None:
        return "Unavailable"
    if score < 25.0:
        return "Extreme Fear"
    if score < 45.0:
        return "Fear"
    if score <= 55.0:
        return "Neutral"
    if score <= 75.0:
        return "Greed"
    return "Extreme Greed"


def parse_cnn_fear_greed_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Normalize official CNN Fear & Greed JSON (headline + 7 pillars) cleanly."""
    fg = payload.get("fear_and_greed") or {}
    score = _safe_float(fg.get("score"))
    rating = _normalize_rating(fg.get("rating"), score)

    components: dict[str, float | None] = {}
    component_ratings: dict[str, str] = {}
    component_raw_values: dict[str, float | None] = {}

    for cnn_key, short_key in CNN_PILLAR_SPECS:
        block = payload.get(cnn_key)
        if not isinstance(block, dict):
            continue
        p_score = _safe_float(block.get("score"))
        if p_score is not None:
            components[short_key] = round(p_score, 1)
        else:
            components[short_key] = None
        component_ratings[short_key] = _normalize_rating(block.get("rating"), p_score)
        pts = block.get("data")
        if isinstance(pts, list) and pts:
            last_pt = pts[-1]
            if isinstance(last_pt, dict):
                raw_y = _safe_float(last_pt.get("y"))
                component_raw_values[short_key] = round(raw_y, 3) if raw_y is not None else None

    hist_block = (payload.get("fear_and_greed_historical") or {}).get("data") or []
    recent_history: list[dict[str, Any]] = []
    for pt in hist_block[-30:]:
        if not isinstance(pt, dict):
            continue
        x_val = _safe_float(pt.get("x"))
        y_val = _safe_float(pt.get("y"))
        if x_val is None or y_val is None:
            continue
        recent_history.append(
            {
                "t_ms": int(x_val),
                "score": round(y_val, 1),
                "rating": _normalize_rating(pt.get("rating"), y_val),
            }
        )

    prev_close = _safe_float(fg.get("previous_close"))
    prev_week = _safe_float(fg.get("previous_1_week"))
    prev_month = _safe_float(fg.get("previous_1_month"))
    prev_year = _safe_float(fg.get("previous_1_year"))

    return {
        "source": "cnn_live",
        "score": round(score, 1) if score is not None else None,
        "label": rating,
        "timestamp": fg.get("timestamp"),
        "previous_close": round(prev_close, 1) if prev_close is not None else None,
        "previous_1_week": round(prev_week, 1) if prev_week is not None else None,
        "previous_1_month": round(prev_month, 1) if prev_month is not None else None,
        "previous_1_year": round(prev_year, 1) if prev_year is not None else None,
        "components": components,
        "component_ratings": component_ratings,
        "component_raw_values": component_raw_values,
        "recent_history": recent_history,
    }


async def fetch_cnn_fear_greed(
    *,
    cache: DualTTLCache | None = None,
    http_client: httpx.AsyncClient | None = None,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Fetch live CNN Fear & Greed Index (including pre-market updates) with DualTTLCache."""
    cache_key = "marketelite:cnn:fear_greed:v1"

    async def _fetch_raw() -> dict[str, Any]:
        if http_client is not None:
            resp = await http_client.get(
                CNN_FEAR_GREED_URL,
                headers=CNN_BROWSER_HEADERS,
                timeout=8.0,
            )
            raise_for_provider_response(resp, "cnn_fear_greed")
            return parse_cnn_fear_greed_payload(resp.json())

        async with httpx.AsyncClient(headers=CNN_BROWSER_HEADERS, timeout=8.0) as client:
            resp = await client.get(CNN_FEAR_GREED_URL)
            raise_for_provider_response(resp, "cnn_fear_greed")
            return parse_cnn_fear_greed_payload(resp.json())

    if cache is None:
        return await _fetch_raw()

    res = await cache.get_or_fetch(
        cache_key,
        provider="cnn_fear_greed",
        fetcher=_fetch_raw,
        soft_ttl_seconds=180,
        hard_ttl_seconds=86400 * 3,
        force_refresh=force_refresh,
    )
    data = dict(res.data or {})
    data["is_stale"] = res.is_stale
    data["cache_status"] = res.cache_status
    return data

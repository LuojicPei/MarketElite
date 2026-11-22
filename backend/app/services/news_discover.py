from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlparse

import httpx

from app.core.config import Settings
from app.services.llm_router import LLMUnconfiguredError, build_fast_llm
from app.services.resilience import DualTTLCache

logger = logging.getLogger(__name__)

DISCOVER_CACHE_KEY = "marketelite:news:discover:v1"
_TR_CACHE_PREFIX = "marketelite:news:tr:"
_IMG_URL_PREFIX = "marketelite:news:imgurl:"
_IMG_BYTES_PREFIX = "marketelite:news:imgbytes:"

_LOGO_URL_BLOCKLIST = (
    "finnhub/logo",
    "reuters_logo",
    "logobbg",
    "yahoo_finance_en-us",
    "default_image",
    "placeholder",
    "favicon",
    "avatar",
    ".svg",
)

_LIFESTYLE_NOISE_PATTERNS = (
    "american dream",
    "moved abroad",
    "pizza chains",
    "first class is over",
    "retirement portfolio was so simple",
    "save $",
    "zodiac",
    "horoscope",
    "recipe",
)

_STOPWORDS = frozenset(
    {
        "about",
        "after",
        "amid",
        "before",
        "between",
        "could",
        "first",
        "from",
        "have",
        "into",
        "more",
        "most",
        "over",
        "says",
        "since",
        "stocks",
        "stock",
        "market",
        "markets",
        "shares",
        "than",
        "that",
        "their",
        "there",
        "these",
        "this",
        "what",
        "when",
        "where",
        "which",
        "while",
        "will",
        "with",
        "your",
    }
)


def is_editorial_photo_url(url: str | None) -> bool:
    """Return True only when URL looks like a real HTTP(S) editorial news photo, not a generic logo."""
    if not url or not isinstance(url, str):
        return False
    cleaned = url.strip()
    parsed = urlparse(cleaned)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return False
    lowered = cleaned.lower()
    return not any(marker in lowered for marker in _LOGO_URL_BLOCKLIST)


def make_article_id(url: str, headline: str) -> str:
    """Create a stable deterministic short ID for news deduplication and image proxying."""
    digest = hashlib.sha256(f"{url.strip()}|{headline.strip()}".encode()).hexdigest()
    return f"disc_{digest[:16]}"


def _extract_topic_tokens(headline: str) -> set[str]:
    tokens = re.findall(r"[A-Za-z0-9]{4,}|S&P|AI|Fed", headline)
    return {t.lower() for t in tokens if t.lower() not in _STOPWORDS}


def _parse_iso_ts(raw_val: Any) -> datetime:
    if isinstance(raw_val, (int, float)) and raw_val > 1_000_000_000:
        return datetime.fromtimestamp(float(raw_val), tz=timezone.utc)
    if isinstance(raw_val, str) and raw_val.strip():
        s = raw_val.strip()
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            try:
                dt = parsedate_to_datetime(s)
                return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
            except (TypeError, ValueError):
                pass
    return datetime.now(timezone.utc)


def _infer_category_zh(headline: str) -> str:
    low = headline.lower()
    if any(k in low for k in ("fed", "rate", "yield", "treasury", "inflation", "cpi", "pce")):
        return "美联储与利率"
    if any(k in low for k in ("ai", "nvidia", "chip", "gpu", "semiconductor", "openai", "anthropic", "gemini", "apple")):
        return "科技与 AI"
    if any(k in low for k in ("oil", "iran", "opec", "saudi", "tariff", "trade", "china", "war")):
        return "地缘与能源"
    if any(k in low for k in ("s&p", "nasdaq", "dow", "wall street", "rally", "sell-off", "correction", "hedge fund")):
        return "美股大盘"
    return "市场要闻"


def _deterministic_importance_score(item: dict[str, Any], now_utc: datetime) -> float:
    low = item["headline"].lower()
    score = 0.0
    if any(p in low for p in _LIFESTYLE_NOISE_PATTERNS):
        score -= 40.0
    boost_keywords = (
        "s&p",
        "nasdaq",
        "dow",
        "fed",
        "powell",
        "rate",
        "treasury",
        "yield",
        "inflation",
        "cpi",
        "nvidia",
        "nvda",
        "ai",
        "chip",
        "semiconductor",
        "apple",
        "alphabet",
        "google",
        "microsoft",
        "amazon",
        "meta",
        "anthropic",
        "openai",
        "oil",
        "iran",
        "tariff",
        "hedge fund",
        "earnings",
        "correction",
        "sell-off",
        "rally",
    )
    for kw in boost_keywords:
        if kw in low:
            score += 6.0
    # Favor multi-source corroborated stories & editorial CNBC/SeekingAlpha/Yahoo sources
    score += min(18.0, (item.get("source_count", 1) - 1) * 3.0)
    src = str(item.get("source", "")).lower()
    if "cnbc" in src or "bloomberg" in src or "barron" in src or "wsj" in src:
        score += 5.0
    # Slight recency bonus over 72h window
    try:
        pub = datetime.fromisoformat(str(item["published_at"]).replace("Z", "+00:00"))
        age_hours = max(0.0, (now_utc - pub).total_seconds() / 3600.0)
        score += max(0.0, 10.0 - age_hours * 0.25)
    except ValueError:
        pass
    return score


async def _verify_image_url(client: httpx.AsyncClient, url: str) -> bool:
    """Confirm remote image responds 200/206 with an image/* Content-Type."""
    try:
        async with client.stream(
            "GET",
            url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                ),
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            },
            timeout=4.0,
        ) as resp:
            if resp.status_code not in (200, 206):
                return False
            ctype = resp.headers.get("content-type", "").lower()
            return ctype.startswith("image/")
    except (httpx.HTTPError, OSError):
        return False


async def fetch_discover_candidates(
    settings: Settings,
    *,
    http_client: httpx.AsyncClient | None = None,
    verify_images: bool = True,
) -> list[dict[str, Any]]:
    """Aggregate real-time market news across Finnhub & Yahoo Search with verified HD photos."""
    api_key = settings.finnhub_api_key.strip()
    today = date.today()
    from_day = (today - timedelta(days=3)).isoformat()
    to_day = today.isoformat()

    async def _run(client: httpx.AsyncClient) -> list[dict[str, Any]]:
        tasks: list[tuple[str, Any]] = []
        if api_key:
            tasks.append(
                (
                    "fh_general",
                    client.get(
                        "https://finnhub.io/api/v1/news",
                        params={"category": "general", "token": api_key},
                        timeout=12.0,
                    ),
                )
            )
            for sym in ("SPY", "NVDA", "AAPL"):
                tasks.append(
                    (
                        f"fh_{sym}",
                        client.get(
                            "https://finnhub.io/api/v1/company-news",
                            params={"symbol": sym, "from": from_day, "to": to_day, "token": api_key},
                            timeout=12.0,
                        ),
                    )
                )
        for q in ("stock market", "Federal Reserve", "Nvidia"):
            tasks.append(
                (
                    f"yf_{q}",
                    client.get(
                        "https://query1.finance.yahoo.com/v1/finance/search",
                        params={"q": q, "newsCount": 10},
                        headers={"User-Agent": "Mozilla/5.0"},
                        timeout=12.0,
                    ),
                )
            )

        raw_responses = await asyncio.gather(
            *(t[1] for t in tasks), return_exceptions=True
        )

        # Collect ALL headlines (even logo-only Reuters/Bloomberg ones) to compute grounded topic corroboration,
        # while collecting photo candidates only from items with real non-logo editorial images.
        all_corpus: list[tuple[str, set[str]]] = []
        photo_candidates: list[dict[str, Any]] = []
        seen_urls_or_titles: set[str] = set()

        def _add_candidate(
            *,
            headline: str,
            url: str,
            image_url: str | None,
            source: str,
            published_at: datetime,
            summary: str = "",
        ) -> None:
            hl = " ".join(str(headline or "").split())
            link = str(url or "").strip()
            src = str(source or "Market Wire").strip() or "Market Wire"
            if not hl or not link:
                return
            toks = _extract_topic_tokens(hl)
            if toks:
                all_corpus.append((src, toks))
            if not is_editorial_photo_url(image_url):
                return
            dedup_key = hl[:64].lower()
            if dedup_key in seen_urls_or_titles or link in seen_urls_or_titles:
                return
            seen_urls_or_titles.add(dedup_key)
            seen_urls_or_titles.add(link)
            photo_candidates.append(
                {
                    "id": make_article_id(link, hl),
                    "headline": hl,
                    "summary": " ".join(str(summary or "").split())[:280],
                    "source": src,
                    "url": link,
                    "image_url": str(image_url).strip(),
                    "published_at": published_at.astimezone(timezone.utc).isoformat(),
                    "_tokens": toks,
                }
            )

        for (tag, _), res in zip(tasks, raw_responses, strict=False):
            if isinstance(res, BaseException) or res.status_code != 200:
                continue
            try:
                body = res.json()
            except ValueError:
                continue

            if tag.startswith("fh_"):
                if not isinstance(body, list):
                    continue
                for row in body:
                    if not isinstance(row, dict):
                        continue
                    _add_candidate(
                        headline=str(row.get("headline", "")),
                        url=str(row.get("url", "")),
                        image_url=row.get("image"),
                        source=str(row.get("source", "")),
                        published_at=_parse_iso_ts(row.get("datetime")),
                        summary=str(row.get("summary", "")),
                    )
            elif tag.startswith("yf_") and isinstance(body, dict):
                for row in body.get("news", []):
                    if not isinstance(row, dict):
                        continue
                    resolutions = (row.get("thumbnail") or {}).get("resolutions") or []
                    chosen_img: str | None = None
                    if isinstance(resolutions, list):
                        # Pick crisp HD resolution (>= 480px wide, avoid 140x140 tiny thumbs)
                        ordered = sorted(
                            [r for r in resolutions if isinstance(r, dict) and r.get("url")],
                            key=lambda r: int(r.get("width") or 0),
                            reverse=True,
                        )
                        for r in ordered:
                            w = int(r.get("width") or 0)
                            if w == 0 or w >= 450:
                                chosen_img = str(r["url"])
                                break
                        if chosen_img is None and ordered:
                            chosen_img = str(ordered[0]["url"])
                    _add_candidate(
                        headline=str(row.get("title", "")),
                        url=str(row.get("link", "")),
                        image_url=chosen_img,
                        source=str(row.get("publisher", "Yahoo Finance")),
                        published_at=_parse_iso_ts(row.get("providerPublishTime")),
                    )

        # Compute grounded source corroboration count from actual retrieved wires
        now_utc = datetime.now(timezone.utc)
        for item in photo_candidates:
            toks: set[str] = item.pop("_tokens", set())
            matched_sources: list[str] = [item["source"]]
            seen_src = {item["source"].lower()}
            if len(toks) >= 2:
                for other_src, other_toks in all_corpus:
                    if other_src.lower() in seen_src:
                        continue
                    if len(toks & other_toks) >= 2:
                        seen_src.add(other_src.lower())
                        matched_sources.append(other_src)
                        if len(matched_sources) >= 6:
                            break
            item["sources"] = matched_sources
            item["source_count"] = len(matched_sources)
            item["_score"] = _deterministic_importance_score(item, now_utc)

        photo_candidates.sort(
            key=lambda x: (x["_score"], x["published_at"]),
            reverse=True,
        )
        top_pool = photo_candidates[:24]
        for x in top_pool:
            x.pop("_score", None)

        if verify_images and top_pool:
            checks = await asyncio.gather(
                *(_verify_image_url(client, item["image_url"]) for item in top_pool),
                return_exceptions=True,
            )
            verified = [
                item
                for item, ok in zip(top_pool, checks, strict=False)
                if ok is True
            ]
            # Keep verified items first; only keep unverified if fewer than 6 passed (avoids empty shelf in restricted networks)
            if len(verified) >= 6:
                return verified[:20]
        return top_pool[:20]

    if http_client is not None:
        return await _run(http_client)
    async with httpx.AsyncClient(follow_redirects=True) as client:
        return await _run(client)


def _strip_json_fences(raw_text: str) -> str:
    txt = raw_text.strip()
    if txt.startswith("```"):
        txt = re.sub(r"^```(?:json)?\s*", "", txt, flags=re.IGNORECASE)
        txt = re.sub(r"\s*```$", "", txt)
    return txt.strip()


async def _translate_and_rank_with_llm(
    candidates: list[dict[str, Any]],
    settings: Settings,
    *,
    limit: int,
) -> list[dict[str, Any]]:
    """Use Fast Tier LLM to select market-critical news and translate headlines into crisp Chinese."""
    if not candidates:
        return []
    llm = build_fast_llm(settings, temperature=0.1)
    compact_input = [
        {
            "id": item["id"],
            "source": item["source"],
            "headline": item["headline"],
            "summary": item.get("summary", "")[:140],
        }
        for item in candidates[:20]
    ]
    prompt = (
        f"你是资深美股财经编辑。请从以下候选全球资讯中挑选最具市场影响力的 {min(limit, len(compact_input))} 条新闻"
        "（优先美股大盘、美联储利率、AI与半导体、核心个股财报、宏观地缘与大宗商品；剔除无关生活八卦/个人理财鸡汤）。\n"
        "请为每条新闻输出：\n"
        "- id: 原始 id（必须与输入完全一致）\n"
        "- title_zh: 地道、凝练、专业的中文财经新闻标题（不超过28个汉字，保留 S&P 500、Nasdaq、AI、GPU、Fed、GLP-1、Nvidia、Alphabet 等专有名词或代码）\n"
        "- category_zh: 简短中文分类（仅限：宏观要闻 / 美股大盘 / 科技与 AI / 地缘与能源 / 利率与政策 / 个股动向）\n"
        "- summary_zh: 一句话中文提要（不超过45个汉字）\n\n"
        "严格仅返回 JSON 数组，不要包含 Markdown 围栏或多余说明。\n"
        + json.dumps(compact_input, ensure_ascii=False)
    )
    response = await llm.ainvoke(prompt)
    raw = response.content if isinstance(response.content, str) else str(response.content)
    parsed = json.loads(_strip_json_fences(raw))
    if not isinstance(parsed, list):
        raise TypeError("LLM discover output is not a JSON array")

    by_id = {item["id"]: item for item in candidates}
    selected: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for row in parsed:
        if not isinstance(row, dict):
            continue
        aid = str(row.get("id", "")).strip()
        base = by_id.get(aid)
        if not base or aid in seen_ids:
            continue
        title_zh = " ".join(str(row.get("title_zh", "")).split())
        if not title_zh:
            continue
        seen_ids.add(aid)
        selected.append(
            {
                **base,
                "title_zh": title_zh,
                "category_zh": str(row.get("category_zh") or _infer_category_zh(base["headline"])).strip(),
                "summary_zh": " ".join(str(row.get("summary_zh", "")).split()),
            }
        )
        if len(selected) >= limit:
            break
    return selected


async def get_or_refresh_discover_news(
    cache: DualTTLCache,
    settings: Settings,
    *,
    limit: int = 12,
    force_refresh: bool = False,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Return cached translated HD-image Discover news carousel items, refreshing safely in background TTL."""
    if not force_refresh:
        cached = await cache.read_envelope(DISCOVER_CACHE_KEY)
        if cached and isinstance(cached.get("payload"), dict):
            payload = cached["payload"]
            items = list(payload.get("items") or [])[:limit]
            if items and not cached.get("is_stale"):
                return {
                    "status": "ok",
                    "cache_source": "redis",
                    "fetched_at": cached.get("fetched_at"),
                    "translated": bool(payload.get("translated", True)),
                    "count": len(items),
                    "items": items,
                }

    candidates = await fetch_discover_candidates(settings, http_client=http_client)
    curated: list[dict[str, Any]] = []
    translated_flag = False

    if candidates:
        # Check per-article translation cache first
        untranslated: list[dict[str, Any]] = []
        pre_translated: dict[str, dict[str, str]] = {}
        for item in candidates:
            tr_env = await cache.read_envelope(f"{_TR_CACHE_PREFIX}{item['id']}")
            if tr_env and isinstance(tr_env.get("payload"), dict) and tr_env["payload"].get("title_zh"):
                pre_translated[item["id"]] = dict(tr_env["payload"])
            else:
                untranslated.append(item)

        if len(pre_translated) >= limit and not force_refresh:
            for item in candidates:
                tr = pre_translated.get(item["id"])
                if tr:
                    curated.append({**item, **tr})
                if len(curated) >= limit:
                    break
            translated_flag = True
        else:
            try:
                curated = await _translate_and_rank_with_llm(
                    candidates, settings, limit=limit
                )
                translated_flag = bool(curated)
                for row in curated:
                    await cache.write_envelope(
                        f"{_TR_CACHE_PREFIX}{row['id']}",
                        payload={
                            "title_zh": row["title_zh"],
                            "category_zh": row["category_zh"],
                            "summary_zh": row.get("summary_zh", ""),
                        },
                        source="llm_fast_translate",
                        soft_ttl_seconds=86400 * 7,
                        hard_ttl_seconds=86400 * 14,
                    )
            except (
                LLMUnconfiguredError,
                httpx.HTTPError,
                json.JSONDecodeError,
                ValueError,
                TypeError,
                KeyError,
                OSError,
            ) as exc:
                logger.warning("Discover headline LLM translation skipped (%s); using deterministic fallback", exc)
                curated = []

        # Deterministic backfill if LLM was unconfigured, failed, or returned fewer than requested
        if len(curated) < min(limit, len(candidates)):
            existing_ids = {c["id"] for c in curated}
            for item in candidates:
                if item["id"] in existing_ids:
                    continue
                tr = pre_translated.get(item["id"])
                if tr:
                    curated.append({**item, **tr})
                    translated_flag = True
                else:
                    curated.append(
                        {
                            **item,
                            "title_zh": item["headline"],
                            "category_zh": _infer_category_zh(item["headline"]),
                            "summary_zh": item.get("summary", ""),
                        }
                    )
                if len(curated) >= limit:
                    break

    # Register safe server-side image proxy mapping and strip raw image_url leakage if desired
    final_items: list[dict[str, Any]] = []
    for item in curated[:limit]:
        await cache.write_envelope(
            f"{_IMG_URL_PREFIX}{item['id']}",
            payload={"url": item["image_url"], "source": item["source"]},
            source="news_discover",
            soft_ttl_seconds=86400 * 3,
            hard_ttl_seconds=86400 * 7,
        )
        final_items.append(
            {
                "id": item["id"],
                "title_zh": item["title_zh"],
                "headline_en": item["headline"],
                "summary_zh": item.get("summary_zh", ""),
                "category_zh": item.get("category_zh") or _infer_category_zh(item["headline"]),
                "source": item["source"],
                "sources": item.get("sources") or [item["source"]],
                "source_count": int(item.get("source_count") or 1),
                "url": item["url"],
                "image_proxy_url": f"/api/market/discover/{item['id']}/image",
                "published_at": item["published_at"],
            }
        )

    if final_items:
        await cache.write_envelope(
            DISCOVER_CACHE_KEY,
            payload={"items": final_items, "translated": translated_flag},
            source="news_discover",
            soft_ttl_seconds=1200,
            hard_ttl_seconds=86400 * 2,
        )
        return {
            "status": "ok",
            "cache_source": "live",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "translated": translated_flag,
            "count": len(final_items),
            "items": final_items,
        }

    # Stale cache rescue if network completely offline
    stale_env = await cache.read_envelope(DISCOVER_CACHE_KEY)
    if stale_env and isinstance(stale_env.get("payload"), dict):
        items = list(stale_env["payload"].get("items") or [])[:limit]
        return {
            "status": "ok",
            "cache_source": "redis_stale",
            "fetched_at": stale_env.get("fetched_at"),
            "translated": bool(stale_env["payload"].get("translated", True)),
            "count": len(items),
            "items": items,
        }

    return {
        "status": "empty",
        "cache_source": "none",
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "translated": False,
        "count": 0,
        "items": [],
    }


def fallback_editorial_svg(label: str = "MarketElite") -> bytes:
    """Clean editorial gradient SVG card returned only when remote image CDN fails."""
    safe = re.sub(r"[^A-Za-z0-9 &.-]", "", label)[:24] or "MarketElite"
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">'
        "<defs>"
        '<linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">'
        '<stop offset="0%" stop-color="#09090b"/>'
        '<stop offset="55%" stop-color="#18181b"/>'
        '<stop offset="100%" stop-color="#064e3b"/>'
        "</linearGradient>"
        "</defs>"
        '<rect width="640" height="360" fill="url(#g)"/>'
        '<path d="M0,250 Q160,180 320,220 T640,140" fill="none" stroke="#34d399" stroke-opacity="0.45" stroke-width="3"/>'
        '<text x="320" y="185" dominant-baseline="middle" text-anchor="middle" '
        'font-family="Georgia,serif" font-style="italic" font-size="28" fill="#f4f4f5">'
        f"{safe}</text>"
        "</svg>"
    )
    return svg.encode("utf-8")


async def get_discover_article_image(
    article_id: str,
    cache: DualTTLCache,
    *,
    http_client: httpx.AsyncClient | None = None,
) -> tuple[bytes, str]:
    """Fetch & Redis-cache verified news article photo bytes via opaque article_id (zero SSRF)."""
    import base64

    bytes_key = f"{_IMG_BYTES_PREFIX}{article_id}"
    cached_bytes = await cache.read_envelope(bytes_key)
    if cached_bytes and isinstance(cached_bytes.get("payload"), dict):
        b64 = cached_bytes["payload"].get("b64")
        ctype = str(cached_bytes["payload"].get("ctype") or "image/jpeg")
        if b64:
            try:
                return base64.b64decode(b64), ctype
            except ValueError:
                pass

    meta_env = await cache.read_envelope(f"{_IMG_URL_PREFIX}{article_id}")
    meta = meta_env.get("payload") if meta_env else None
    if not isinstance(meta, dict) or not is_editorial_photo_url(meta.get("url")):
        return fallback_editorial_svg(), "image/svg+xml"

    target_url = str(meta["url"])
    label = str(meta.get("source") or "MarketElite")

    async def _fetch_raw(client: httpx.AsyncClient) -> tuple[bytes, str] | None:
        try:
            resp = await client.get(
                target_url,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                    ),
                    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                },
                timeout=10.0,
            )
            ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
            if resp.status_code == 200 and ctype.startswith("image/") and 1024 <= len(resp.content) <= 5_000_000:
                return resp.content, ctype
        except (httpx.HTTPError, OSError):
            return None
        return None

    fetched: tuple[bytes, str] | None
    if http_client is not None:
        fetched = await _fetch_raw(http_client)
    else:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            fetched = await _fetch_raw(client)

    if fetched is not None:
        raw_bytes, ctype = fetched
        await cache.write_envelope(
            bytes_key,
            payload={"b64": base64.b64encode(raw_bytes).decode("ascii"), "ctype": ctype},
            source="news_discover_image",
            soft_ttl_seconds=3600 * 6,
            hard_ttl_seconds=86400 * 3,
        )
        return raw_bytes, ctype

    return fallback_editorial_svg(label), "image/svg+xml"

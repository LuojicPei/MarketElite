from __future__ import annotations

import asyncio
import base64
import hashlib
import html
import json
import logging
import re
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

from app.core.config import Settings
from app.services.free_translate import translate_en_to_zh_free
from app.services.resilience import DualTTLCache

logger = logging.getLogger(__name__)

DISCOVER_CACHE_KEY = "marketelite:news:discover:v3"
DISCOVER_COOLDOWN_KEY = "marketelite:news:discover:cooldown:v3"
_META_PREFIX = "marketelite:news:meta:v3:"
_ARTICLE_PREFIX = "marketelite:news:article:v3:"
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
    "first class is over",
    "retirement portfolio was so simple",
    "rachel cruze",
    "save $",
    "zodiac",
    "horoscope",
    "recipe",
)

_BOILERPLATE_PREFIXES = (
    "in this article",
    "watch live",
    "read more",
    "sign up for",
    "subscribe to",
    "click here",
    "follow ",
    "disclosure:",
    "copyright ",
    "all rights reserved",
    "terms of use",
    "privacy policy",
    "story continues",
    "recommended stories",
    "this article was originally",
    "for more information",
)

_BLOCKED_CARD_URL_MARKERS = (
    "/make-it/",
    "/investingclub/",
    "/pro/",
    "finnhub.io/api/news",
    "seekingalpha.com",
    "benzinga.com",
    "wsj.com",
    "barrons.com",
    "bloomberg.com",
)

_PAYWALL_MARKERS = (
    "create a free account to continue",
    "subscribe to unlock",
    "already a subscriber? sign in",
    "become a seeking alpha member",
    "continue reading with a subscription",
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
    """Create a stable deterministic short ID for news deduplication, reading modal, and image proxy."""
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
        return "利率与政策"
    if any(
        k in low
        for k in ("ai", "nvidia", "chip", "gpu", "semiconductor", "openai", "anthropic", "gemini", "apple")
    ):
        return "科技与 AI"
    if any(k in low for k in ("oil", "iran", "opec", "saudi", "tariff", "trade", "china", "war")):
        return "地缘与能源"
    if any(k in low for k in ("s&p", "nasdaq", "dow", "wall street", "rally", "sell-off", "correction", "hedge fund")):
        return "美股大盘"
    return "宏观要闻"


def _deterministic_importance_score(item: dict[str, Any], now_utc: datetime) -> float:
    low = item["headline"].lower()
    link_low = item["url"].lower()
    score = 0.0
    if "/make-it/" in link_low or any(p in low for p in _LIFESTYLE_NOISE_PATTERNS):
        score -= 50.0
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
        "pce",
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
    # Reward genuine multi-outlet corroboration
    score += min(18.0, (item.get("source_count", 1) - 1) * 3.0)
    link_low = item["url"].lower()
    src = str(item.get("source", "")).lower()
    # Strongly prioritize open full-text URLs so in-app reading displays full multi-paragraph articles
    if "cnbc.com/" in link_low or "finance.yahoo.com/" in link_low:
        score += 18.0
    elif "cnbc" in src or "yahoo" in src:
        score += 12.0
    if any(p in src for p in ("seekingalpha", "benzinga", "barron", "wsj")):
        score -= 18.0
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


async def _scrape_article_html(client: httpx.AsyncClient, url: str) -> str:
    try:
        resp = await client.get(
            url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                ),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=7.0,
        )
        if resp.status_code == 200 and "text/html" in resp.headers.get("content-type", "").lower():
            return resp.text
    except (httpx.HTTPError, OSError):
        return ""
    return ""


async def _verify_candidate_media_and_text(
    client: httpx.AsyncClient,
    item: dict[str, Any],
    *,
    verify_images: bool,
    verify_full_text: bool,
) -> tuple[bool, list[str]]:
    img_task = _verify_image_url(client, item["image_url"]) if verify_images else asyncio.sleep(0, result=True)
    if verify_full_text:
        html_task = _scrape_article_html(client, item["url"])
        img_ok, raw_html = await asyncio.gather(img_task, html_task, return_exceptions=True)
        if img_ok is not True or not isinstance(raw_html, str) or not raw_html:
            return False, []
        paras, paywall = extract_article_paragraphs(raw_html)
        if paywall or len(paras) < 4:
            return False, []
        return True, paras
    img_ok = await img_task
    return bool(img_ok is True), []


async def fetch_discover_candidates(
    settings: Settings,
    *,
    http_client: httpx.AsyncClient | None = None,
    verify_images: bool = True,
    verify_full_text: bool = False,
) -> list[dict[str, Any]]:
    """Aggregate real-time market news across Finnhub & Yahoo Search with verified HD photos and full-text articles."""
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
        for q in (
            "stock market",
            "S&P 500 Nasdaq",
            "Federal Reserve",
            "Nvidia",
            "Wall Street stocks",
            "artificial intelligence",
            "interest rates",
            "oil prices",
        ):
            tasks.append(
                (
                    f"yf_{q}",
                    client.get(
                        "https://query1.finance.yahoo.com/v1/finance/search",
                        params={"q": q, "newsCount": 12},
                        headers={"User-Agent": "Mozilla/5.0"},
                        timeout=12.0,
                    ),
                )
            )

        raw_responses = await asyncio.gather(*(t[1] for t in tasks), return_exceptions=True)

        all_corpus: list[dict[str, Any]] = []
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
            hl = " ".join(html.unescape(str(headline or "")).split())
            link = str(url or "").strip()
            src = str(source or "Market Wire").strip() or "Market Wire"
            if not hl or not link:
                return
            pub_iso = published_at.astimezone(timezone.utc).isoformat()
            toks = _extract_topic_tokens(hl)
            if toks:
                all_corpus.append(
                    {
                        "source": src,
                        "headline": hl,
                        "url": link,
                        "published_at": pub_iso,
                        "tokens": toks,
                    }
                )
            link_low = link.lower()
            if any(m in link_low for m in _BLOCKED_CARD_URL_MARKERS) or any(
                p in hl.lower() for p in _LIFESTYLE_NOISE_PATTERNS
            ):
                return
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
                    "summary": " ".join(html.unescape(str(summary or "")).split())[:500],
                    "source": src,
                    "url": link,
                    "image_url": str(image_url).strip(),
                    "published_at": pub_iso,
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

        now_utc = datetime.now(timezone.utc)
        for item in photo_candidates:
            toks: set[str] = item.pop("_tokens", set())
            matched_sources: list[str] = [item["source"]]
            related_articles: list[dict[str, str]] = []
            seen_src = {item["source"].lower()}
            if len(toks) >= 2:
                for other in all_corpus:
                    other_src = other["source"]
                    if other["url"] == item["url"] or other_src.lower() in seen_src:
                        continue
                    if len(toks & other["tokens"]) >= 2:
                        seen_src.add(other_src.lower())
                        matched_sources.append(other_src)
                        if len(related_articles) < 4:
                            related_articles.append(
                                {
                                    "source": other_src,
                                    "headline": other["headline"],
                                    "url": other["url"],
                                    "published_at": other["published_at"],
                                }
                            )
                        if len(matched_sources) >= 6:
                            break
            item["sources"] = matched_sources
            item["source_count"] = len(matched_sources)
            item["related_articles"] = related_articles
            item["_score"] = _deterministic_importance_score(item, now_utc)

        photo_candidates.sort(
            key=lambda x: (x["_score"], x["published_at"]),
            reverse=True,
        )
        top_pool = photo_candidates[:32]
        for x in top_pool:
            x.pop("_score", None)

        if (verify_images or verify_full_text) and top_pool:
            checks = await asyncio.gather(
                *(
                    _verify_candidate_media_and_text(
                        client,
                        item,
                        verify_images=verify_images,
                        verify_full_text=verify_full_text,
                    )
                    for item in top_pool
                ),
                return_exceptions=True,
            )
            verified: list[dict[str, Any]] = []
            for item, res in zip(top_pool, checks, strict=False):
                if isinstance(res, BaseException):
                    continue
                ok, paras = res
                if ok:
                    if paras:
                        item["pre_extracted_en"] = paras
                    verified.append(item)
            if verify_full_text and verified:
                return verified[:18]
            if len(verified) >= 6:
                return verified[:18]
        return top_pool[:18]

    if http_client is not None:
        return await _run(http_client)
    async with httpx.AsyncClient(follow_redirects=True) as client:
        return await _run(client)


async def get_or_refresh_discover_news(
    cache: DualTTLCache,
    settings: Settings,
    *,
    limit: int = 12,
    force_refresh: bool = False,
    bypass_cooldown: bool = False,
    verify_full_text: bool | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Return cached zero-LLM Chinese Discover news items with cooldown guard against public spam."""
    if not force_refresh or not bypass_cooldown:
        cached = await cache.read_envelope(DISCOVER_CACHE_KEY)
        if cached and isinstance(cached.get("payload"), dict):
            payload = cached["payload"]
            items = list(payload.get("items") or [])[:limit]
            if items:
                if not force_refresh and not cached.get("is_stale"):
                    return {
                        "status": "ok",
                        "cache_source": "redis",
                        "fetched_at": cached.get("fetched_at"),
                        "translated": bool(payload.get("translated", True)),
                        "count": len(items),
                        "items": items,
                    }
                if force_refresh and not bypass_cooldown:
                    cooldown = await cache.read_envelope(DISCOVER_COOLDOWN_KEY)
                    if cooldown and not cooldown.get("is_stale"):
                        return {
                            "status": "ok",
                            "cache_source": "redis_cooldown",
                            "fetched_at": cached.get("fetched_at"),
                            "translated": bool(payload.get("translated", True)),
                            "count": len(items),
                            "items": items,
                        }

    should_verify_full_text = (
        verify_full_text if verify_full_text is not None else (http_client is None)
    )
    candidates = await fetch_discover_candidates(
        settings,
        http_client=http_client,
        verify_full_text=should_verify_full_text,
    )
    selected = candidates[:limit]

    # Collect all headlines, summaries, and related-article titles for zero-LLM batch translation
    texts_to_translate: list[str] = []
    offsets: list[tuple[int, int, list[tuple[int, int]]]] = []
    for item in selected:
        hl_idx = len(texts_to_translate)
        texts_to_translate.append(item["headline"])
        sum_idx = -1
        if item.get("summary"):
            sum_idx = len(texts_to_translate)
            texts_to_translate.append(item["summary"])
        rel_pairs: list[tuple[int, int]] = []
        for r_idx, rel in enumerate(item.get("related_articles") or []):
            rt_idx = len(texts_to_translate)
            texts_to_translate.append(rel["headline"])
            rel_pairs.append((r_idx, rt_idx))
        offsets.append((hl_idx, sum_idx, rel_pairs))

    translated_list, translated_flag = await translate_en_to_zh_free(
        texts_to_translate,
        cache=cache,
        http_client=http_client,
    )

    final_items: list[dict[str, Any]] = []
    meta_writes = []
    for item, (hl_idx, sum_idx, rel_pairs) in zip(selected, offsets, strict=False):
        title_zh = translated_list[hl_idx] if hl_idx < len(translated_list) else item["headline"]
        summary_zh = (
            translated_list[sum_idx]
            if 0 <= sum_idx < len(translated_list)
            else ""
        )
        rel_items: list[dict[str, str]] = []
        raw_rels = item.get("related_articles") or []
        for r_idx, rt_idx in rel_pairs:
            rel_raw = raw_rels[r_idx]
            rel_items.append(
                {
                    "source": rel_raw["source"],
                    "title_zh": translated_list[rt_idx] if rt_idx < len(translated_list) else rel_raw["headline"],
                    "headline_en": rel_raw["headline"],
                    "url": rel_raw["url"],
                    "published_at": rel_raw["published_at"],
                }
            )

        clean_item = {
            "id": item["id"],
            "title_zh": title_zh,
            "headline_en": item["headline"],
            "summary_zh": summary_zh,
            "summary_en": item.get("summary", ""),
            "category_zh": _infer_category_zh(item["headline"]),
            "source": item["source"],
            "sources": item.get("sources") or [item["source"]],
            "source_count": int(item.get("source_count") or 1),
            "url": item["url"],
            "image_proxy_url": f"/api/market/discover/{item['id']}/image",
            "published_at": item["published_at"],
            "related_articles": rel_items,
            "pre_extracted_en": item.get("pre_extracted_en") or [],
        }
        final_items.append(clean_item)

        meta_writes.append(
            cache.write_envelope(
                f"{_IMG_URL_PREFIX}{item['id']}",
                payload={"url": item["image_url"], "source": item["source"]},
                source="news_discover",
                soft_ttl_seconds=86400 * 3,
                hard_ttl_seconds=86400 * 7,
            )
        )
        meta_writes.append(
            cache.write_envelope(
                f"{_META_PREFIX}{item['id']}",
                payload=clean_item,
                source="news_discover",
                soft_ttl_seconds=86400 * 3,
                hard_ttl_seconds=86400 * 7,
            )
        )

    if meta_writes:
        await asyncio.gather(*meta_writes, return_exceptions=True)

    if final_items:
        # Strip heavy/internal fields from public shelf response to keep homepage JSON slim
        shelf_items = [
            {k: v for k, v in it.items() if k not in {"summary_en", "pre_extracted_en"}}
            for it in final_items
        ]
        await asyncio.gather(
            cache.write_envelope(
                DISCOVER_CACHE_KEY,
                payload={"items": shelf_items, "translated": translated_flag},
                source="news_discover_free",
                soft_ttl_seconds=1800,
                hard_ttl_seconds=86400 * 3,
            ),
            cache.write_envelope(
                DISCOVER_COOLDOWN_KEY,
                payload={"locked": True},
                source="news_discover_cooldown",
                soft_ttl_seconds=180,
                hard_ttl_seconds=300,
            ),
        )
        return {
            "status": "ok",
            "cache_source": "live",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "translated": translated_flag,
            "count": len(shelf_items),
            "items": shelf_items,
        }

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


def _clean_paragraph_text(text: str) -> str:
    return " ".join(html.unescape(str(text or "")).split())


def extract_article_paragraphs(html_text: str) -> tuple[list[str], bool]:
    """Extract readable article body paragraphs cleanly from CNBC/Yahoo/news HTML.

    Returns (paragraphs, paywall_detected).
    """
    if not html_text:
        return [], False
    low_all = html_text.lower()
    paywall = any(marker in low_all for marker in _PAYWALL_MARKERS)

    soup = BeautifulSoup(html_text, "html.parser")
    for junk in soup.select("script, style, nav, footer, aside, header, noscript, figure"):
        junk.decompose()

    selectors = (
        "div.ArticleBody-articleBody p, div[data-module='ArticleBody'] p",
        "div.caas-body p, div.atoms-wrapper p",
        "div.article-body p, div.entry-content p, main article p, article p",
    )
    paras: list[str] = []
    seen_low: set[str] = set()
    for sel in selectors:
        nodes = soup.select(sel)
        for node in nodes:
            txt = _clean_paragraph_text(node.get_text(" ", strip=True))
            if len(txt) < 35:
                continue
            txt_low = txt.lower()
            if any(txt_low.startswith(pref) for pref in _BOILERPLATE_PREFIXES):
                continue
            if txt_low in seen_low:
                continue
            seen_low.add(txt_low)
            paras.append(txt)
        if len(paras) >= 3:
            break

    # Fallback: parse Schema.org JSON-LD articleBody if DOM paragraphs missing
    if len(paras) < 3:
        raw_soup = BeautifulSoup(html_text, "html.parser")
        for script in raw_soup.select('script[type="application/ld+json"]'):
            try:
                data = json.loads(script.get_text() or "{}")
            except ValueError:
                continue
            blocks = data if isinstance(data, list) else [data]
            for blk in blocks:
                if not isinstance(blk, dict):
                    continue
                body = blk.get("articleBody")
                if isinstance(body, str) and len(body.strip()) > 120:
                    chunks = [
                        _clean_paragraph_text(c)
                        for c in re.split(r"(?:\n+|\.\s+(?=[A-Z]))", body)
                        if len(_clean_paragraph_text(c)) >= 40
                    ]
                    if len(chunks) >= 2:
                        paras = chunks
                        break
            if len(paras) >= 3:
                break

    return paras[:22], paywall


async def get_discover_article_detail(
    article_id: str,
    cache: DualTTLCache,
    *,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any] | None:
    """Fetch, extract, and zero-LLM translate full article paragraphs (aligned EN/ZH) for the reading modal."""
    art_cache_key = f"{_ARTICLE_PREFIX}{article_id}"
    cached = await cache.read_envelope(art_cache_key)
    if cached and isinstance(cached.get("payload"), dict) and not cached.get("is_stale"):
        return {**cached["payload"], "cached": True}

    meta_env = await cache.read_envelope(f"{_META_PREFIX}{article_id}")
    meta: dict[str, Any] | None = (
        dict(meta_env["payload"]) if meta_env and isinstance(meta_env.get("payload"), dict) else None
    )
    if meta is None:
        shelf_env = await cache.read_envelope(DISCOVER_CACHE_KEY)
        if shelf_env and isinstance(shelf_env.get("payload"), dict):
            for candidate in shelf_env["payload"].get("items") or []:
                if isinstance(candidate, dict) and candidate.get("id") == article_id:
                    meta = dict(candidate)
                    break
    if meta is None:
        return None

    target_url = str(meta.get("url") or "").strip()
    pre_extracted = [
        _clean_paragraph_text(str(p))
        for p in (meta.get("pre_extracted_en") or [])
        if len(_clean_paragraph_text(str(p))) >= 30
    ]
    extracted_paras: list[str] = pre_extracted
    paywall_hit = False

    if len(extracted_paras) < 3 and target_url.startswith("http"):
        if http_client is not None:
            raw_html = await _scrape_article_html(http_client, target_url)
        else:
            async with httpx.AsyncClient(follow_redirects=True) as scrape_client:
                raw_html = await _scrape_article_html(scrape_client, target_url)
        extracted_paras, paywall_hit = extract_article_paragraphs(raw_html)

    if len(extracted_paras) >= 3:
        access_status = "full"
        en_paras = extracted_paras
    else:
        access_status = "summary_only"
        fallback_text = _clean_paragraph_text(str(meta.get("summary_en") or ""))
        if not fallback_text or len(fallback_text) < 20:
            fallback_text = _clean_paragraph_text(str(meta.get("headline_en") or ""))
        en_paras = [fallback_text] if fallback_text else []
        if paywall_hit and extracted_paras:
            en_paras = extracted_paras[:2]

    zh_paras, _ = await translate_en_to_zh_free(
        en_paras,
        cache=cache,
        http_client=http_client,
    )

    aligned_paragraphs = [
        {
            "index": idx,
            "en": en_p,
            "zh": zh_p,
        }
        for idx, (en_p, zh_p) in enumerate(zip(en_paras, zh_paras, strict=False))
    ]

    result = {
        "status": "ok",
        "id": article_id,
        "title_zh": meta.get("title_zh") or meta.get("headline_en"),
        "headline_en": meta.get("headline_en", ""),
        "category_zh": meta.get("category_zh", "宏观要闻"),
        "source": meta.get("source", ""),
        "sources": meta.get("sources") or [meta.get("source", "")],
        "source_count": int(meta.get("source_count") or 1),
        "url": target_url,
        "image_proxy_url": meta.get("image_proxy_url") or f"/api/market/discover/{article_id}/image",
        "published_at": meta.get("published_at", ""),
        "access_status": access_status,
        "paragraphs": aligned_paragraphs,
        "related_articles": meta.get("related_articles") or [],
        "cached": False,
    }

    if aligned_paragraphs:
        await cache.write_envelope(
            art_cache_key,
            payload=result,
            source="news_discover_article_free",
            soft_ttl_seconds=86400 * 2,
            hard_ttl_seconds=86400 * 7,
        )

    return result


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

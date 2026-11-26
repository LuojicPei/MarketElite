from __future__ import annotations

import asyncio
import base64
import hashlib
import html
import json
import logging
import re
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup, NavigableString, Tag

from app.core.config import Settings
from app.services.free_translate import _needs_retry_zh, translate_en_to_zh_free
from app.services.resilience import DualTTLCache

logger = logging.getLogger(__name__)

DISCOVER_CACHE_KEY = "marketelite:news:discover:v10"
DISCOVER_COOLDOWN_KEY = "marketelite:news:discover:cooldown:v10"
_META_PREFIX = "marketelite:news:meta:v9:"
_ARTICLE_PREFIX = "marketelite:news:article:v9:"
_IMG_URL_PREFIX = "marketelite:news:imgurl:v9:"
_IMG_BYTES_PREFIX = "marketelite:news:imgbytes:v9:"

_PREWARM_TASKS: set[asyncio.Task[Any]] = set()
_ACTIVE_PREWARM_IDS: set[str] = set()
_INFLIGHT_ARTICLE_TASKS: dict[str, tuple[asyncio.AbstractEventLoop, asyncio.Task[dict[str, Any] | None]]] = {}

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
    "affair",
    "polymarket",
    "prediction market",
    "exit odds",
    "gossip",
)

_BOILERPLATE_PREFIXES = (
    "in this article",
    "watch live",
    "watch now",
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
    "image source:",
    "https://",
    "http://",
)

_TERMINAL_PROMO_MARKERS = (
    "should you buy stock in",
    "before you buy stock in",
    "related:",
    "related stories",
    "read next:",
    "read the original story",
    "recommended stories",
    "for updates and corrections, email",
)

_PROMO_AD_SUBSTRINGS = (
    "(sponsor)",
    "(sponsored)",
    "fisher investments",
    "learn more here",
    "continue »",
    "see the 10 stocks",
    "stock advisor returns as of",
    "motley fool stock advisor",
    "consider when netflix made this list",
    "get the stocktwits daily rip",
    "missed ai's \"act 1\"",
    "has no position in any of the stocks mentioned",
    "the motley fool has a disclosure policy",
    "has positions in any of the stocks",
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
    if re.search(r"\b(?:fed|federal reserve|rates?|yields?|treasury|inflation|cpi|pce|fomc)\b", low):
        return "利率与政策"
    if re.search(r"\b(?:oil|crude|brent|iran|iranian|opec|saudi|tariff|tariffs|war|strikes?)\b", low):
        return "地缘与能源"
    if re.search(
        r"\b(?:ai|artificial intelligence|nvidia|nvda|chips?|gpus?|semiconductors?|openai|anthropic|gemini|apple)\b",
        low,
    ):
        return "科技与 AI"
    if re.search(r"(?:\bs&p\b|\bnasdaq\b|\bdow\b|\bwall street\b|\brally\b|\bsell-off\b|\bcorrection\b|\bhedge funds?\b|\bdividend stocks?\b)", low):
        return "美股大盘"
    return "宏观要闻"


def _parse_rss_feed(xml_text: str, default_source: str) -> list[dict[str, Any]]:
    """Parse RSS/Atom XML into candidate news dicts, pulling media/enclosure/description photos."""
    if not xml_text or "<" not in xml_text:
        return []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []

    out: list[dict[str, Any]] = []
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub_raw = (item.findtext("pubDate") or item.findtext("{http://purl.org/dc/elements/1.1/}date") or "").strip()
        desc_raw = (item.findtext("description") or "").strip()
        src_el = item.find("source")
        src_name = (src_el.text.strip() if src_el is not None and src_el.text else "") or default_source

        # Strip Google News outlet suffix ("Headline - Reuters") cleanly
        if default_source == "Google News" and " - " in title:
            parts = title.rsplit(" - ", 1)
            if len(parts[1]) <= 36:
                title = parts[0].strip()
                if not src_name or src_name == "Google News":
                    src_name = parts[1].strip()

        img_url: str | None = None
        for tag_end in ("}content", "}thumbnail", "enclosure"):
            for el in item:
                if el.tag.endswith(tag_end):
                    cand = (el.attrib.get("url") or "").strip()
                    if cand and is_editorial_photo_url(cand):
                        img_url = cand
                        break
            if img_url:
                break
        if not img_url and desc_raw and "<img" in desc_raw.lower():
            m = re.search(r'<img[^>]+src=["\'](https?://[^"\']+)["\']', desc_raw, flags=re.IGNORECASE)
            if m and is_editorial_photo_url(m.group(1)):
                img_url = m.group(1)

        desc_plain = BeautifulSoup(desc_raw, "html.parser").get_text(" ", strip=True) if desc_raw else ""
        if title and link:
            out.append(
                {
                    "headline": title,
                    "url": link,
                    "image_url": img_url,
                    "source": src_name,
                    "published_at": _parse_iso_ts(pub_raw),
                    "summary": desc_plain[:500],
                }
            )
    return out


def _deterministic_importance_score(item: dict[str, Any], now_utc: datetime) -> float:
    low = item["headline"].lower()
    link_low = item["url"].lower()
    score = 0.0
    if "/make-it/" in link_low or any(p in low for p in _LIFESTYLE_NOISE_PATTERNS):
        score -= 80.0
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
            score += 5.0
    # Reward genuine multi-outlet corroboration without shutting out independent exclusives
    score += min(14.0, (item.get("source_count", 1) - 1) * 3.0)
    src = str(item.get("source", "")).lower()
    tier1_outlets = (
        "reuters",
        "bloomberg",
        "wsj",
        "wall street journal",
        "cnbc",
        "marketwatch",
        "financial times",
        "yahoo",
        "associated press",
        "ap news",
        "barron",
        "fiscal.ai",
        "investor's business daily",
    )
    if any(t in src for t in tier1_outlets):
        score += 10.0
    if item.get("image_url"):
        score += 8.0
    try:
        pub = datetime.fromisoformat(str(item["published_at"]).replace("Z", "+00:00"))
        age_hours = max(0.0, (now_utc - pub).total_seconds() / 3600.0)
        # Strong continuous recency curve: breaking (<3h) wins sharply; multi-day stale fades out
        score += 28.0 - age_hours * 1.4
    except ValueError:
        pass
    return score


_PAYWALL_DIRECT_DOMAINS = (
    "wsj.com",
    "barrons.com",
    "ft.com",
    "bloomberg.com",
    "investing.com",
    "seekingalpha.com",
    "investors.com",
    "news.google.com",
)


def _extract_og_image(html_text: str) -> str | None:
    """Extract highest-signal social/editorial image meta URL from article HTML."""
    if not html_text:
        return None
    for pat in (
        r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\'](https?://[^"\']+)["\']',
        r'<meta[^>]+content=["\'](https?://[^"\']+)["\'][^>]+property=["\']og:image["\']',
        r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\'](https?://[^"\']+)["\']',
        r'<meta[^>]+content=["\'](https?://[^"\']+)["\'][^>]+name=["\']twitter:image["\']',
    ):
        m = re.search(pat, html_text, flags=re.IGNORECASE)
        if m:
            cand = html.unescape(m.group(1).strip())
            if is_editorial_photo_url(cand):
                return cand
    return None


async def _verify_image_url(client: httpx.AsyncClient, url: str) -> bool:
    """Confirm remote image responds 200/206 with an image/* Content-Type."""
    try:
        parsed = urlparse(url)
        referer = f"{parsed.scheme}://{parsed.netloc}/" if parsed.scheme and parsed.netloc else ""
        async with client.stream(
            "GET",
            url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                ),
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                **({"Referer": referer} if referer else {}),
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
            timeout=5.5,
        )
        if resp.status_code == 200 and "text/html" in resp.headers.get("content-type", "").lower():
            try:
                return resp.content.decode("utf-8")
            except UnicodeDecodeError:
                return resp.text or resp.content.decode("utf-8", errors="replace")
    except (httpx.HTTPError, OSError):
        return ""
    return ""


async def _verify_candidate_media_and_text(
    client: httpx.AsyncClient,
    item: dict[str, Any],
    *,
    verify_images: bool,
    verify_full_text: bool,
) -> tuple[bool, list[dict[str, Any]]]:
    has_img = bool(item.get("image_url"))
    existing_blocks = list(item.get("pre_extracted_blocks") or [])
    existing_content = [b for b in existing_blocks if b.get("type") in {"paragraph", "list", "quote"}]
    need_html = (verify_full_text and len(existing_content) < 3) or not has_img

    img_task = (
        _verify_image_url(client, str(item["image_url"]))
        if (verify_images and has_img)
        else asyncio.sleep(0, result=has_img)
    )
    html_task = (
        _scrape_article_html(client, item["url"])
        if need_html
        else asyncio.sleep(0, result="")
    )
    img_ok, raw_html = await asyncio.gather(img_task, html_task, return_exceptions=True)
    raw_html_str = raw_html if isinstance(raw_html, str) else ""

    # Populate missing photo dynamically via og:image / twitter:image from open article HTML
    if (not has_img or img_ok is not True) and raw_html_str:
        og_img = _extract_og_image(raw_html_str)
        if og_img and (not verify_images or await _verify_image_url(client, og_img)):
            item["image_url"] = og_img
            has_img = True
            img_ok = True

    if not has_img or (verify_images and img_ok is not True):
        return False, []

    if len(existing_content) >= 3:
        return True, existing_blocks

    if verify_full_text:
        if not raw_html_str:
            return False, []
        blocks, paywall = extract_article_structure(raw_html_str)
        content_blocks = [b for b in blocks if b["type"] in {"paragraph", "list", "quote"}]
        if paywall or len(content_blocks) < 3:
            return False, []
        return True, blocks

    return True, []


async def fetch_discover_candidates(
    settings: Settings,
    *,
    http_client: httpx.AsyncClient | None = None,
    verify_images: bool = True,
    verify_full_text: bool = False,
) -> list[dict[str, Any]]:
    """Aggregate real-time market news across Alpaca, Finnhub, RSS wires & Yahoo Search with strict freshness."""
    api_key = settings.finnhub_api_key.strip()
    alpaca_key = settings.alpaca_api_key.strip()
    alpaca_secret = settings.alpaca_secret_key.strip()
    today = date.today()
    from_day = (today - timedelta(days=2)).isoformat()
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
                        timeout=10.0,
                    ),
                )
            )
            for sym in ("SPY", "QQQ", "NVDA", "AAPL"):
                tasks.append(
                    (
                        f"fh_{sym}",
                        client.get(
                            "https://finnhub.io/api/v1/company-news",
                            params={"symbol": sym, "from": from_day, "to": to_day, "token": api_key},
                            timeout=10.0,
                        ),
                    )
                )
        if alpaca_key and alpaca_secret:
            alpaca_data_base = (getattr(settings, "alpaca_data_base_url", None) or "https://data.alpaca.markets").rstrip("/")
            tasks.append(
                (
                    "alpaca_news",
                    client.get(
                        f"{alpaca_data_base}/v1beta1/news",
                        params={
                            "symbols": "SPY,QQQ,NVDA,AAPL,TSLA,MSFT,AMZN,META",
                            "limit": 30,
                            "sort": "desc",
                            "include_content": "true",
                            "exclude_contentless": "true",
                        },
                        headers={
                            "APCA-API-KEY-ID": alpaca_key,
                            "APCA-API-SECRET-KEY": alpaca_secret,
                        },
                        timeout=10.0,
                    ),
                )
            )

        rss_sources = (
            ("rss_cnbc", "CNBC", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114"),
            ("rss_cnbc_inv", "CNBC", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839069"),
            ("rss_yf", "Yahoo Finance", "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC,^IXIC,^DJI,SPY,QQQ,NVDA,AAPL,MSFT,TSLA,AMZN,META&region=US&lang=en-US"),
            ("rss_mw", "MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories"),
        )
        for tag, _src_label, rss_url in rss_sources:
            tasks.append(
                (
                    tag,
                    client.get(
                        rss_url,
                        headers={"User-Agent": "Mozilla/5.0"},
                        timeout=8.0,
                    ),
                )
            )

        for q in ("stock market", "Federal Reserve", "Nvidia", "Wall Street", "S&P 500", "Treasury yields"):
            tasks.append(
                (
                    f"yf_{q}",
                    client.get(
                        "https://query1.finance.yahoo.com/v1/finance/search",
                        params={"q": q, "newsCount": 10},
                        headers={"User-Agent": "Mozilla/5.0"},
                        timeout=8.0,
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
            allow_no_photo: bool = False,
            pre_extracted_blocks: list[dict[str, Any]] | None = None,
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
            if any(
                m in link_low
                for m in ("/make-it/", "/investingclub/", "/pro/", "/live/", "live-updates", "finnhub.io/api/news")
            ):
                return
            if any(p in hl.lower() for p in _LIFESTYLE_NOISE_PATTERNS):
                return
            has_pre = bool(pre_extracted_blocks and len([b for b in pre_extracted_blocks if b.get("type") in {"paragraph", "quote", "list"}]) >= 3)
            if not has_pre and any(dom in link_low for dom in _PAYWALL_DIRECT_DOMAINS):
                return
            clean_img = str(image_url).strip() if image_url else ""
            if clean_img and not is_editorial_photo_url(clean_img):
                return
            if not clean_img and not allow_no_photo:
                return
            dedup_key = hl[:64].lower()
            if dedup_key in seen_urls_or_titles or link in seen_urls_or_titles:
                return
            seen_urls_or_titles.add(dedup_key)
            seen_urls_or_titles.add(link)
            cand: dict[str, Any] = {
                "id": make_article_id(link, hl),
                "headline": hl,
                "summary": " ".join(html.unescape(str(summary or "")).split())[:500],
                "source": src,
                "url": link,
                "image_url": clean_img,
                "published_at": pub_iso,
                "_tokens": toks,
            }
            if has_pre and pre_extracted_blocks:
                cand["pre_extracted_blocks"] = pre_extracted_blocks
            photo_candidates.append(cand)

        rss_tag_to_source = {tag: src_label for tag, src_label, _ in rss_sources}

        for (tag, _), res in zip(tasks, raw_responses, strict=False):
            if isinstance(res, BaseException) or res.status_code != 200:
                continue

            if tag in rss_tag_to_source:
                parsed_rss = _parse_rss_feed(res.text, rss_tag_to_source[tag])
                for item in parsed_rss:
                    _add_candidate(
                        headline=item["headline"],
                        url=item["url"],
                        image_url=item["image_url"],
                        source=item["source"],
                        published_at=item["published_at"],
                        summary=item["summary"],
                        allow_no_photo=bool(item["source"] in {"CNBC", "Yahoo Finance"}),
                    )
                continue

            try:
                body = res.json()
            except ValueError:
                continue

            if tag == "alpaca_news" and isinstance(body, dict):
                for row in body.get("news") or []:
                    if not isinstance(row, dict):
                        continue
                    imgs = row.get("images") or []
                    chosen_img = None
                    if isinstance(imgs, list):
                        for size_pref in ("large", "small", "thumb"):
                            for im in imgs:
                                if isinstance(im, dict) and im.get("size") == size_pref:
                                    u = im.get("url")
                                    if u and is_editorial_photo_url(u):
                                        chosen_img = u
                                        break
                            if chosen_img:
                                break
                        if not chosen_img:
                            for im in imgs:
                                u = im.get("url") if isinstance(im, dict) else None
                                if u and is_editorial_photo_url(u):
                                    chosen_img = u
                                    break
                    raw_content = str(row.get("content") or "")
                    pre_blocks: list[dict[str, Any]] | None = None
                    if len(raw_content) >= 200:
                        parsed_blocks, pw = extract_article_structure(raw_content)
                        if not pw and len([b for b in parsed_blocks if b.get("type") in {"paragraph", "quote", "list"}]) >= 3:
                            pre_blocks = parsed_blocks
                    src_raw = str(row.get("source") or "Market Wire")
                    src_clean = "Alpaca Wire" if src_raw.lower() == "fiscal.ai" else src_raw
                    _add_candidate(
                        headline=str(row.get("headline", "")),
                        url=str(row.get("url", "")),
                        image_url=chosen_img,
                        source=src_clean,
                        published_at=_parse_iso_ts(row.get("created_at") or row.get("updated_at")),
                        summary=str(row.get("summary", "")),
                        allow_no_photo=bool(pre_blocks),
                        pre_extracted_blocks=pre_blocks,
                    )
            elif tag.startswith("fh_"):
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
        fresh_cutoff_48h = now_utc - timedelta(hours=48)
        fresh_cutoff_72h = now_utc - timedelta(hours=72)

        fresh_items: list[dict[str, Any]] = []
        extended_items: list[dict[str, Any]] = []
        for item in photo_candidates:
            pub_dt = _parse_iso_ts(item.get("published_at"))
            if pub_dt >= fresh_cutoff_48h:
                fresh_items.append(item)
            elif pub_dt >= fresh_cutoff_72h:
                extended_items.append(item)

        pool_candidates = fresh_items if len(fresh_items) >= 6 else (fresh_items + extended_items)
        if not pool_candidates:
            pool_candidates = photo_candidates

        for item in pool_candidates:
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

        pool_candidates.sort(
            key=lambda x: (x["_score"], x["published_at"]),
            reverse=True,
        )

        # Enforce multi-outlet diversity: cap any single outlet to max 4 picks before relaxing
        diversified: list[dict[str, Any]] = []
        overflow: list[dict[str, Any]] = []
        src_counts: dict[str, int] = {}
        for x in pool_candidates:
            x.pop("_score", None)
            sk = str(x.get("source") or "").lower()
            if src_counts.get(sk, 0) < 4:
                src_counts[sk] = src_counts.get(sk, 0) + 1
                diversified.append(x)
            else:
                overflow.append(x)
        top_pool = (diversified + overflow)[:56]

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
                ok, blocks = res
                if ok:
                    if blocks:
                        item["pre_extracted_blocks"] = blocks
                    verified.append(item)
            if verify_full_text and verified:
                return verified[:24]
            if len(verified) >= 1:
                return verified[:24]
        return [it for it in top_pool if it.get("image_url")][:24] or top_pool[:24]

    if http_client is not None:
        return await _run(http_client)
    async with httpx.AsyncClient(follow_redirects=True) as client:
        return await _run(client)


async def _heal_cached_discover_items(
    items: list[dict[str, Any]],
    cache: DualTTLCache,
    *,
    full_payload: dict[str, Any] | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    """Repair any cached Discover cards left in English by earlier transient NMT failures."""
    repair_refs: list[tuple[int, str, str]] = []
    repair_texts: list[str] = []
    for idx, it in enumerate(items):
        en_hl = str(it.get("headline_en") or "").strip()
        zh_hl = str(it.get("title_zh") or "").strip()
        if en_hl and _needs_retry_zh(zh_hl, en_hl):
            repair_refs.append((idx, "title_zh", en_hl))
            repair_texts.append(en_hl)
        en_sum = str(it.get("summary_en") or "").strip()
        zh_sum = str(it.get("summary_zh") or "").strip()
        if en_sum and _needs_retry_zh(zh_sum, en_sum):
            repair_refs.append((idx, "summary_zh", en_sum))
            repair_texts.append(en_sum)
        for r_idx, rel in enumerate(it.get("related_articles") or []):
            r_en = str(rel.get("headline_en") or "").strip()
            r_zh = str(rel.get("title_zh") or "").strip()
            if r_en and _needs_retry_zh(r_zh, r_en):
                repair_refs.append((idx, f"rel:{r_idx}", r_en))
                repair_texts.append(r_en)

    if not repair_texts:
        return items, True

    zh_vals, _ = await translate_en_to_zh_free(
        repair_texts,
        cache=cache,
        http_client=http_client,
    )
    changed = False
    for (idx, field, en_src), zh_val in zip(repair_refs, zh_vals, strict=False):
        if zh_val and not _needs_retry_zh(zh_val, en_src):
            if field.startswith("rel:"):
                r_i = int(field.split(":", 1)[1])
                rels = items[idx].get("related_articles") or []
                if 0 <= r_i < len(rels):
                    rels[r_i]["title_zh"] = zh_val
                    changed = True
            else:
                items[idx][field] = zh_val
                changed = True

    all_titles_ok = all(
        not _needs_retry_zh(str(it.get("title_zh") or ""), str(it.get("headline_en") or ""))
        for it in items
        if it.get("headline_en")
    )
    if changed and full_payload is not None:
        all_cached_items = list(full_payload.get("items") or [])
        by_id = {str(it.get("id") or ""): it for it in items if it.get("id")}
        merged = [by_id.get(str(it.get("id") or ""), it) for it in all_cached_items]
        await cache.write_envelope(
            DISCOVER_CACHE_KEY,
            payload={"items": merged, "translated": all_titles_ok},
            source="news_discover_free",
            soft_ttl_seconds=900 if all_titles_ok else 60,
            hard_ttl_seconds=7200 if all_titles_ok else 600,
        )
    return items, all_titles_ok


async def get_or_refresh_discover_news(
    cache: DualTTLCache,
    settings: Settings,
    *,
    limit: int = 21,
    force_refresh: bool = False,
    bypass_cooldown: bool = False,
    verify_full_text: bool | None = None,
    pretranslate_bg: bool | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Return cached zero-LLM Chinese Discover news items and silently pre-translate bodies in background."""
    should_prewarm = pretranslate_bg if pretranslate_bg is not None else (http_client is None)
    now_epoch = datetime.now(timezone.utc).timestamp()
    if not force_refresh or not bypass_cooldown:
        cached = await cache.read_envelope(DISCOVER_CACHE_KEY)
        if cached and isinstance(cached.get("payload"), dict):
            payload = cached["payload"]
            items = list(payload.get("items") or [])[:limit]
            recorded_limit = payload.get("requested_limit")
            has_enough_for_limit = (
                True
                if recorded_limit is None
                else (len(items) >= limit or int(recorded_limit) >= limit)
            )
            if items and has_enough_for_limit:
                soft_fresh = now_epoch < float(cached.get("soft_expires_at") or 0.0)
                if not force_refresh and soft_fresh:
                    items, all_ok = await _heal_cached_discover_items(
                        items,
                        cache,
                        full_payload=payload,
                        http_client=http_client,
                    )
                    if should_prewarm:
                        schedule_discover_pretranslate([str(it.get("id", "")) for it in items], cache)
                    return {
                        "status": "ok",
                        "cache_source": "redis",
                        "fetched_at": cached.get("fetched_at"),
                        "translated": all_ok,
                        "count": len(items),
                        "items": items,
                    }
                if force_refresh and not bypass_cooldown:
                    cooldown = await cache.read_envelope(DISCOVER_COOLDOWN_KEY)
                    cd_fresh = bool(cooldown and now_epoch < float(cooldown.get("soft_expires_at") or 0.0))
                    if cooldown and cd_fresh:
                        items, all_ok = await _heal_cached_discover_items(
                            items,
                            cache,
                            full_payload=payload,
                            http_client=http_client,
                        )
                        if should_prewarm:
                            schedule_discover_pretranslate([str(it.get("id", "")) for it in items], cache)
                        return {
                            "status": "ok",
                            "cache_source": "redis_cooldown",
                            "fetched_at": cached.get("fetched_at"),
                            "translated": all_ok,
                            "count": len(items),
                            "items": items,
                        }

    should_verify_full_text = True if verify_full_text is None else bool(verify_full_text)
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
        sum_src = str(item.get("summary") or "").strip()
        if not sum_src:
            for blk in item.get("pre_extracted_blocks") or []:
                btype = blk.get("type")
                if btype in {"paragraph", "quote"} and blk.get("en"):
                    plain_lead = _plain_text(str(blk["en"]))
                    if len(plain_lead) >= 24:
                        sum_src = plain_lead[:260].rsplit(" ", 1)[0] if len(plain_lead) > 260 else plain_lead
                        break
                elif btype == "callout" and blk.get("items_en"):
                    plain_lead = _plain_text(str((blk.get("items_en") or [""])[0]))
                    if len(plain_lead) >= 18:
                        sum_src = plain_lead[:260]
                        break
            if sum_src:
                item["summary"] = sum_src
        sum_idx = -1
        if sum_src:
            sum_idx = len(texts_to_translate)
            texts_to_translate.append(sum_src)
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
            "pre_extracted_blocks": item.get("pre_extracted_blocks") or [],
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
            {k: v for k, v in it.items() if k not in {"summary_en", "pre_extracted_blocks"}}
            for it in final_items
        ]
        ok_titles = sum(
            1
            for it in shelf_items
            if not it.get("headline_en")
            or not _needs_retry_zh(str(it.get("title_zh") or ""), str(it.get("headline_en") or ""))
        )
        all_titles_ok = ok_titles >= max(1, len(shelf_items) - 1)
        effective_translated = bool(translated_flag and all_titles_ok)
        await asyncio.gather(
            cache.write_envelope(
                DISCOVER_CACHE_KEY,
                payload={"items": shelf_items, "translated": effective_translated, "requested_limit": limit},
                source="news_discover_free",
                soft_ttl_seconds=900 if all_titles_ok else 45,
                hard_ttl_seconds=7200 if all_titles_ok else 300,
            ),
            cache.write_envelope(
                DISCOVER_COOLDOWN_KEY,
                payload={"locked": True},
                source="news_discover_cooldown",
                soft_ttl_seconds=90 if all_titles_ok else 15,
                hard_ttl_seconds=180 if all_titles_ok else 45,
            ),
        )
        if should_prewarm:
            schedule_discover_pretranslate([str(it.get("id", "")) for it in shelf_items], cache)
        return {
            "status": "ok",
            "cache_source": "live",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "translated": effective_translated,
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
    cleaned = html.unescape(str(text or ""))
    cleaned = re.sub(r"\bHTML_TAG_(?:START|END)\b", " ", cleaned)
    return " ".join(cleaned.split())


def _plain_text(serialized: str) -> str:
    return _clean_paragraph_text(re.sub(r"</?b>", "", serialized))


def _is_promo_or_boilerplate(plain_txt: str) -> bool:
    low = plain_txt.lower()
    if any(low.startswith(pref) for pref in _BOILERPLATE_PREFIXES):
        return True
    return any(sub in low for sub in _PROMO_AD_SUBSTRINGS)


def _hits_terminal_promo(plain_txt: str) -> bool:
    low = plain_txt.lower()
    return any(low.startswith(m) for m in _TERMINAL_PROMO_MARKERS)


def _serialize_inline_bold(node: Tag) -> tuple[str, int]:
    """Serialize Tag into clean plain text preserving real inline <strong>/<b> emphasis as <b>...</b>."""
    parts: list[str] = []
    bold_chars = 0

    def _walk(el: Any, inside_bold: bool = False) -> None:
        nonlocal bold_chars
        if isinstance(el, NavigableString):
            txt = html.unescape(str(el))
            if txt:
                parts.append(txt)
                if inside_bold:
                    bold_chars += len(txt.strip())
            return
        if not isinstance(el, Tag):
            return
        name = el.name.lower()
        if name in {"script", "style", "svg", "button", "figure", "figcaption"}:
            return
        if name in {"strong", "b"} and not inside_bold:
            inner_txt = _clean_paragraph_text(el.get_text(" ", strip=True))
            if inner_txt:
                parts.append(f"<b>{inner_txt}</b>")
                bold_chars += len(inner_txt)
            return
        if name == "br":
            parts.append(" ")
            return
        for child in el.children:
            _walk(child, inside_bold)
        if name in {"div", "p", "time", "h2", "h3", "h4", "li"}:
            parts.append(" ")

    _walk(node)
    joined = _clean_paragraph_text("".join(parts))
    joined = re.sub(r"<b>\s+", "<b>", joined)
    joined = re.sub(r"\s+</b>", "</b>", joined)
    joined = re.sub(r"([A-Za-z0-9,;:])<b>", r"\1 <b>", joined)
    joined = re.sub(r"</b>([A-Za-z0-9])", r"</b> \1", joined)
    return joined, bold_chars


def extract_article_structure(html_text: str) -> tuple[list[dict[str, Any]], bool]:
    """Extract clean, structured editorial blocks (callout, heading, quote, list, paragraph) without ads/clutter.

    Expands Yahoo 'read-more-wrapper' sections automatically and preserves inline <b> emphasis.
    Returns (blocks, paywall_detected).
    """
    if not html_text:
        return [], False
    low_all = html_text.lower()
    paywall = any(marker in low_all for marker in _PAYWALL_MARKERS)

    soup = BeautifulSoup(html_text, "html.parser")

    # 1. Extract CNBC executive Key Points callout before stripping article widgets
    key_points_en: list[str] = []
    seen_plain: set[str] = set()
    for kp_node in soup.select("div.RenderKeyPoints-list li, div[data-testid='key-points'] li"):
        txt = _clean_paragraph_text(kp_node.get_text(" ", strip=True))
        if len(txt) >= 15 and txt.lower() not in seen_plain and not _is_promo_or_boilerplate(txt):
            seen_plain.add(txt.lower())
            key_points_en.append(txt)

    # 2. Clean non-article chrome, inline ads, videos, and 'Story Continues' button wrappers (keep read-more-wrapper!)
    for junk in soup.select(
        "script, style, nav, footer, aside, header, noscript, figure, figcaption, button, form, iframe, svg,"
        "[class*='RelatedQuotes'], [class*='InlineVideo'], [class*='InlineImage'], [class*='MobileAdhesion'],"
        "[class*='RenderKeyPoints'], [data-testid='key-points'], [class*='Promo'], [class*='Recirculation'],"
        "[data-testid='inarticle-ad'], [data-testid='ad-container'], [class*='sdaContainer'],"
        "[class*='caas-da'], [class*='caas-readmore'], [class*='image-container'], [class*='image-wrapper']"
    ):
        junk.decompose()

    for el in list(soup.find_all(class_=True)):
        cls_str = " ".join(el.get("class") or []).lower()
        if "readmore" in cls_str and "read-more-wrapper" not in cls_str:
            el.decompose()

    root: Tag | None = None
    for sel in (
        "div.ArticleBody-articleBody",
        "div[data-module='ArticleBody']",
        "div.body",
        "div.caas-body",
        "div.atoms-wrapper",
        "div.article-body",
        "main article",
        "article",
    ):
        found = soup.select_one(sel)
        if found is not None:
            root = found
            break

    blocks: list[dict[str, Any]] = []
    if key_points_en:
        blocks.append({"type": "callout", "items_en": key_points_en[:6]})

    if root is not None:
        stop_walking = False

        def _visit(container: Tag) -> None:
            nonlocal stop_walking
            if stop_walking or len(blocks) >= 36:
                return
            for child in container.children:
                if stop_walking or len(blocks) >= 36:
                    return
                if not isinstance(child, Tag):
                    continue
                tag_name = child.name.lower()

                if tag_name in {"h2", "h3", "h4"}:
                    h_txt = _clean_paragraph_text(child.get_text(" ", strip=True))
                    if not h_txt or len(h_txt) < 4:
                        continue
                    if _hits_terminal_promo(h_txt):
                        stop_walking = True
                        return
                    if _is_promo_or_boilerplate(h_txt) or h_txt.lower() in seen_plain:
                        continue
                    seen_plain.add(h_txt.lower())
                    blocks.append({"type": "heading", "en": h_txt})
                    continue

                if tag_name == "blockquote":
                    q_txt = _clean_paragraph_text(child.get_text(" ", strip=True))
                    if len(q_txt) >= 18 and not _is_promo_or_boilerplate(q_txt) and q_txt.lower() not in seen_plain:
                        seen_plain.add(q_txt.lower())
                        blocks.append({"type": "quote", "en": q_txt})
                    continue

                if tag_name in {"ul", "ol"}:
                    li_items: list[str] = []
                    for li in child.find_all("li", recursive=False):
                        li_rich, _ = _serialize_inline_bold(li)
                        li_plain = _plain_text(li_rich)
                        if len(li_plain) < 15 or _is_promo_or_boilerplate(li_plain):
                            continue
                        if _hits_terminal_promo(li_plain):
                            stop_walking = True
                            break
                        if li_plain.lower() not in seen_plain:
                            seen_plain.add(li_plain.lower())
                            li_items.append(li_rich)
                    if li_items:
                        # Promote Yahoo's opening bullet summary right into callout box if none yet
                        has_body_yet = any(b["type"] in {"paragraph", "heading"} for b in blocks)
                        if not has_body_yet and not key_points_en and tag_name == "ul":
                            blocks.insert(0, {"type": "callout", "items_en": li_items[:5]})
                        else:
                            blocks.append({"type": "list", "ordered": tag_name == "ol", "items_en": li_items[:8]})
                    continue

                if tag_name == "p":
                    rich_txt, bold_chars = _serialize_inline_bold(child)
                    plain_txt = _plain_text(rich_txt)
                    if not plain_txt:
                        continue
                    if _hits_terminal_promo(plain_txt):
                        stop_walking = True
                        return
                    if _is_promo_or_boilerplate(plain_txt):
                        continue
                    # Promote standalone short all-bold paragraphs to section headings
                    if (
                        bold_chars >= max(6, int(len(plain_txt) * 0.8))
                        and 6 <= len(plain_txt) <= 95
                        and not plain_txt.endswith((".", "!", "?"))
                    ):
                        if plain_txt.lower() not in seen_plain:
                            seen_plain.add(plain_txt.lower())
                            blocks.append({"type": "heading", "en": plain_txt})
                        continue
                    if len(plain_txt) < 28 or plain_txt.lower() in seen_plain:
                        continue
                    seen_plain.add(plain_txt.lower())
                    # Drop bold wrapper if >70% of paragraph was bolded unnecessarily
                    final_en = plain_txt if bold_chars > len(plain_txt) * 0.7 else rich_txt
                    blocks.append({"type": "paragraph", "en": final_en})
                    continue

                _visit(child)

        _visit(root)

    # JSON-LD fallback if DOM structure yielded fewer than 3 content blocks
    body_count = sum(1 for b in blocks if b["type"] in {"paragraph", "quote", "list"})
    if body_count < 3:
        raw_soup = BeautifulSoup(html_text, "html.parser")
        for script in raw_soup.select('script[type="application/ld+json"]'):
            try:
                data = json.loads(script.get_text() or "{}")
            except ValueError:
                continue
            ld_list = data if isinstance(data, list) else [data]
            for blk in ld_list:
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
                        blocks = [{"type": "paragraph", "en": ch} for ch in chunks[:22]]
                        break
            if sum(1 for b in blocks if b["type"] == "paragraph") >= 3:
                break

    return blocks, paywall


def extract_article_paragraphs(html_text: str) -> tuple[list[str], bool]:
    """Compatibility helper returning plain text paragraphs extracted from structured article blocks."""
    blocks, paywall = extract_article_structure(html_text)
    paras: list[str] = []
    for blk in blocks:
        if blk["type"] in {"paragraph", "quote", "heading"}:
            paras.append(_plain_text(blk["en"]))
        elif blk["type"] in {"callout", "list"}:
            paras.extend(_plain_text(it) for it in (blk.get("items_en") or []))
    return paras[:22], paywall


def _article_translation_stats(payload: dict[str, Any]) -> tuple[int, int]:
    """Return (translated_slots, total_slots) across blocks/paragraphs for cache healing."""
    total = 0
    ok = 0
    for blk in payload.get("blocks") or []:
        btype = str(blk.get("type") or "")
        if btype in {"callout", "list"}:
            ens = blk.get("items_en") or []
            zhs = blk.get("items_zh") or []
            for idx, en_txt in enumerate(ens):
                en_s = str(en_txt or "").strip()
                if not en_s:
                    continue
                total += 1
                zh_s = str(zhs[idx] if idx < len(zhs) else "").strip()
                if not _needs_retry_zh(zh_s, en_s):
                    ok += 1
        else:
            en_s = str(blk.get("en") or "").strip()
            if not en_s:
                continue
            total += 1
            zh_s = str(blk.get("zh") or "").strip()
            if not _needs_retry_zh(zh_s, en_s):
                ok += 1
    return ok, total


def _article_title_needs_repair(payload: dict[str, Any]) -> bool:
    en_title = str(payload.get("headline_en") or "").strip()
    zh_title = str(payload.get("title_zh") or "").strip()
    return bool(en_title) and _needs_retry_zh(zh_title, en_title)


def _article_needs_repair(payload: dict[str, Any]) -> bool:
    if _article_title_needs_repair(payload):
        return True
    ok, total = _article_translation_stats(payload)
    if total == 0:
        return False
    return ok < total


def _is_article_cache_healthy(payload: dict[str, Any]) -> bool:
    if _article_title_needs_repair(payload):
        return False
    ok, total = _article_translation_stats(payload)
    if total == 0:
        return True
    return (ok / total) >= 0.85


async def _repair_cached_article_payload(
    article_id: str,
    payload: dict[str, Any],
    cache: DualTTLCache,
    *,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Incrementally translate any English-leftover headline/blocks inside a cached article payload."""
    blocks = [dict(b) for b in (payload.get("blocks") or [])]
    new_title_zh = str(payload.get("title_zh") or "").strip()
    headline_en = str(payload.get("headline_en") or "").strip()
    title_dirty = _article_title_needs_repair(payload)
    changed = False

    if title_dirty:
        meta_env = await cache.read_envelope(f"{_META_PREFIX}{article_id}")
        meta_payload = meta_env.get("payload") if meta_env and isinstance(meta_env.get("payload"), dict) else None
        meta_title_zh = str((meta_payload or {}).get("title_zh") or "").strip()
        if meta_title_zh and not _needs_retry_zh(meta_title_zh, headline_en):
            new_title_zh = meta_title_zh
            changed = True
            title_dirty = False

    repair_texts: list[str] = []
    repair_refs: list[tuple[int, int | None, str]] = []
    if title_dirty and headline_en:
        repair_refs.append((-1, None, headline_en))
        repair_texts.append(headline_en)

    for b_idx, blk in enumerate(blocks):
        btype = str(blk.get("type") or "")
        if btype in {"callout", "list"}:
            ens = list(blk.get("items_en") or [])
            zhs = list(blk.get("items_zh") or [])
            while len(zhs) < len(ens):
                zhs.append(ens[len(zhs)])
            blk["items_zh"] = zhs
            for i_idx, en_txt in enumerate(ens):
                en_s = str(en_txt or "").strip()
                if en_s and _needs_retry_zh(str(zhs[i_idx]), en_s):
                    repair_refs.append((b_idx, i_idx, en_s))
                    repair_texts.append(en_s)
        else:
            en_s = str(blk.get("en") or "").strip()
            zh_s = str(blk.get("zh") or "").strip()
            if en_s and _needs_retry_zh(zh_s, en_s):
                repair_refs.append((b_idx, None, en_s))
                repair_texts.append(en_s)

    if not repair_texts and not changed:
        return payload

    if repair_texts:
        zh_vals, _ = await translate_en_to_zh_free(
            repair_texts,
            cache=cache,
            http_client=http_client,
        )
        for (b_idx, i_idx, en_s), zh_val in zip(repair_refs, zh_vals, strict=False):
            if zh_val and not _needs_retry_zh(zh_val, en_s):
                if b_idx == -1:
                    new_title_zh = zh_val
                elif i_idx is not None:
                    blocks[b_idx]["items_zh"][i_idx] = zh_val
                else:
                    blocks[b_idx]["zh"] = zh_val
                changed = True

    if changed:
        rebuilt_paras: list[dict[str, Any]] = []
        for blk in blocks:
            if blk.get("type") in {"paragraph", "quote"}:
                rebuilt_paras.append(
                    {
                        "index": len(rebuilt_paras),
                        "en": _plain_text(str(blk.get("en") or "")),
                        "zh": _plain_text(str(blk.get("zh") or "")),
                    }
                )
        updated = {
            **payload,
            "title_zh": new_title_zh or payload.get("title_zh"),
            "blocks": blocks,
            "paragraphs": rebuilt_paras,
        }
        healthy = _is_article_cache_healthy(updated)
        await cache.write_envelope(
            f"{_ARTICLE_PREFIX}{article_id}",
            payload=updated,
            source="news_discover_article_free",
            soft_ttl_seconds=86400 * 2 if healthy else 45,
            hard_ttl_seconds=86400 * 7 if healthy else 300,
        )
        return updated
    return payload


async def _compute_and_cache_article_detail(
    article_id: str,
    cache: DualTTLCache,
    *,
    force_refresh: bool = False,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any] | None:
    """Compute, free-translate, and cache structured editorial blocks for a single article."""
    art_cache_key = f"{_ARTICLE_PREFIX}{article_id}"
    if not force_refresh:
        cached = await cache.read_envelope(art_cache_key)
        if cached and isinstance(cached.get("payload"), dict):
            now_epoch = datetime.now(timezone.utc).timestamp()
            soft_fresh = now_epoch < float(cached.get("soft_expires_at") or 0.0)
            if soft_fresh or not cached.get("soft_expires_at"):
                payload = dict(cached["payload"])
                if _article_needs_repair(payload):
                    payload = await _repair_cached_article_payload(
                        article_id,
                        payload,
                        cache,
                        http_client=http_client,
                    )
                return {**payload, "cached": True}

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
    extracted_blocks: list[dict[str, Any]] = list(meta.get("pre_extracted_blocks") or [])
    paywall_hit = False

    content_count = sum(1 for b in extracted_blocks if b.get("type") in {"paragraph", "quote", "list"})
    if content_count < 3 and target_url.startswith("http"):
        if http_client is not None:
            raw_html = await _scrape_article_html(http_client, target_url)
        else:
            async with httpx.AsyncClient(follow_redirects=True) as scrape_client:
                raw_html = await _scrape_article_html(scrape_client, target_url)
        extracted_blocks, paywall_hit = extract_article_structure(raw_html)
        content_count = sum(1 for b in extracted_blocks if b.get("type") in {"paragraph", "quote", "list"})

    if content_count >= 3:
        access_status = "full"
        source_blocks = extracted_blocks
    else:
        access_status = "summary_only"
        fallback_text = _clean_paragraph_text(str(meta.get("summary_en") or ""))
        if not fallback_text or len(fallback_text) < 20:
            fallback_text = _clean_paragraph_text(str(meta.get("headline_en") or ""))
        source_blocks = [{"type": "paragraph", "en": fallback_text}] if fallback_text else []
        if paywall_hit and extracted_blocks:
            source_blocks = extracted_blocks[:2]

    headline_en_val = str(meta.get("headline_en") or "").strip()
    raw_title_zh = str(meta.get("title_zh") or "").strip()
    title_needs_tx = bool(headline_en_val) and _needs_retry_zh(raw_title_zh, headline_en_val)

    # Flatten all text slots for single batched zero-LLM translation
    en_slots: list[str] = []
    title_slot_idx: int | None = None
    if title_needs_tx:
        title_slot_idx = len(en_slots)
        en_slots.append(headline_en_val)

    block_slots: list[tuple[str, int | list[int]]] = []
    for blk in source_blocks:
        btype = str(blk.get("type") or "paragraph")
        if btype in {"callout", "list"}:
            indices: list[int] = []
            for item_en in blk.get("items_en") or []:
                indices.append(len(en_slots))
                en_slots.append(str(item_en))
            block_slots.append((btype, indices))
        else:
            idx = len(en_slots)
            en_slots.append(str(blk.get("en") or ""))
            block_slots.append((btype, idx))

    zh_slots, _ = await translate_en_to_zh_free(
        en_slots,
        cache=cache,
        http_client=http_client,
    )

    resolved_title_zh = raw_title_zh
    if title_slot_idx is not None and title_slot_idx < len(zh_slots):
        candidate_title_zh = zh_slots[title_slot_idx]
        if candidate_title_zh and not _needs_retry_zh(candidate_title_zh, headline_en_val):
            resolved_title_zh = candidate_title_zh
    if not resolved_title_zh:
        resolved_title_zh = headline_en_val

    structured_blocks: list[dict[str, Any]] = []
    aligned_paragraphs: list[dict[str, Any]] = []
    for raw_blk, (btype, slot_ref) in zip(source_blocks, block_slots, strict=False):
        if isinstance(slot_ref, list):
            items_en = [en_slots[i] for i in slot_ref]
            items_zh = [zh_slots[i] if i < len(zh_slots) else en_slots[i] for i in slot_ref]
            entry: dict[str, Any] = {
                "type": btype,
                "items_en": items_en,
                "items_zh": items_zh,
            }
            if btype == "list":
                entry["ordered"] = bool(raw_blk.get("ordered", False))
            structured_blocks.append(entry)
        else:
            en_txt = en_slots[slot_ref]
            zh_txt = zh_slots[slot_ref] if slot_ref < len(zh_slots) else en_txt
            structured_blocks.append(
                {
                    "type": btype,
                    "en": en_txt,
                    "zh": zh_txt,
                }
            )
            if btype in {"paragraph", "quote"}:
                aligned_paragraphs.append(
                    {
                        "index": len(aligned_paragraphs),
                        "en": _plain_text(en_txt),
                        "zh": _plain_text(zh_txt),
                    }
                )

    result = {
        "status": "ok",
        "id": article_id,
        "title_zh": resolved_title_zh,
        "headline_en": meta.get("headline_en", ""),
        "category_zh": meta.get("category_zh", "宏观要闻"),
        "source": meta.get("source", ""),
        "sources": meta.get("sources") or [meta.get("source", "")],
        "source_count": int(meta.get("source_count") or 1),
        "url": target_url,
        "image_proxy_url": meta.get("image_proxy_url") or f"/api/market/discover/{article_id}/image",
        "published_at": meta.get("published_at", ""),
        "access_status": access_status,
        "blocks": structured_blocks,
        "paragraphs": aligned_paragraphs,
        "related_articles": meta.get("related_articles") or [],
        "cached": False,
    }

    if structured_blocks:
        healthy = _is_article_cache_healthy(result)
        await cache.write_envelope(
            art_cache_key,
            payload=result,
            source="news_discover_article_free",
            soft_ttl_seconds=86400 * 2 if healthy else 45,
            hard_ttl_seconds=86400 * 7 if healthy else 300,
        )

    return result


async def get_discover_article_detail(
    article_id: str,
    cache: DualTTLCache,
    *,
    force_refresh: bool = False,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any] | None:
    """Return structured bilingual article blocks, coalescing concurrent user/background requests."""
    art_cache_key = f"{_ARTICLE_PREFIX}{article_id}"
    if not force_refresh:
        cached = await cache.read_envelope(art_cache_key)
        if cached and isinstance(cached.get("payload"), dict):
            now_epoch = datetime.now(timezone.utc).timestamp()
            soft_fresh = now_epoch < float(cached.get("soft_expires_at") or 0.0)
            if soft_fresh or not cached.get("soft_expires_at"):
                payload = dict(cached["payload"])
                if not _article_needs_repair(payload):
                    return {**payload, "cached": True}

    loop = asyncio.get_running_loop()
    task_key = f"{article_id}:{'force' if force_refresh else 'norm'}"
    existing = _INFLIGHT_ARTICLE_TASKS.get(task_key)
    if existing is not None and existing[0] is loop and not existing[1].done():
        return await asyncio.shield(existing[1])

    task = loop.create_task(
        _compute_and_cache_article_detail(
            article_id,
            cache,
            force_refresh=force_refresh,
            http_client=http_client,
        )
    )
    _INFLIGHT_ARTICLE_TASKS[task_key] = (loop, task)
    try:
        return await asyncio.shield(task)
    finally:
        cur = _INFLIGHT_ARTICLE_TASKS.get(task_key)
        if cur is not None and cur[1] is task:
            _INFLIGHT_ARTICLE_TASKS.pop(task_key, None)


async def pretranslate_discover_articles(
    article_ids: list[str],
    cache: DualTTLCache,
    *,
    concurrency: int = 2,
    http_client: httpx.AsyncClient | None = None,
) -> int:
    """Pre-translate Discover article bodies sequentially/bounded in priority order for instant modal opens."""
    cleaned_ids = [aid.strip() for aid in article_ids if aid and aid.strip()]
    if not cleaned_ids:
        return 0

    sem = asyncio.Semaphore(max(1, concurrency))
    warmed = 0

    async def _warm_one(aid: str) -> None:
        nonlocal warmed
        async with sem:
            try:
                res = await get_discover_article_detail(aid, cache, http_client=http_client)
                if res and res.get("status") == "ok":
                    warmed += 1
            except (httpx.HTTPError, ValueError, TypeError, OSError) as exc:
                logger.debug("Pre-translate skipped for %s: %s", aid, exc)

    # First prioritize Slide 1 (top 3 cards) before warming remaining carousel slides
    front_batch = cleaned_ids[:3]
    rest_batch = cleaned_ids[3:]
    await asyncio.gather(*(_warm_one(aid) for aid in front_batch), return_exceptions=True)
    if rest_batch:
        await asyncio.gather(*(_warm_one(aid) for aid in rest_batch), return_exceptions=True)
    return warmed


def schedule_discover_pretranslate(article_ids: list[str], cache: DualTTLCache) -> None:
    """Spawn non-blocking background pre-translation task while deduplicating already active IDs."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    pending_ids = [aid.strip() for aid in article_ids if aid and aid.strip() and aid not in _ACTIVE_PREWARM_IDS]
    if not pending_ids:
        return

    _ACTIVE_PREWARM_IDS.update(pending_ids)

    async def _runner() -> None:
        try:
            await pretranslate_discover_articles(pending_ids, cache, concurrency=2)
        except asyncio.CancelledError:
            raise
        except (httpx.HTTPError, ValueError, TypeError, OSError) as exc:
            logger.debug("Discover background pre-translate halted: %s", exc)
        finally:
            for aid in pending_ids:
                _ACTIVE_PREWARM_IDS.discard(aid)

    task = loop.create_task(_runner())
    _PREWARM_TASKS.add(task)
    task.add_done_callback(_PREWARM_TASKS.discard)


async def startup_discover_warmup(cache: DualTTLCache, settings: Settings) -> None:
    """Warm homepage Discover 21-item shelf & full Chinese bodies on startup and every 15 minutes."""
    first_cycle = True
    while True:
        try:
            await asyncio.sleep(1.0 if first_cycle else 900.0)
            res = await get_or_refresh_discover_news(
                cache,
                settings,
                limit=21,
                force_refresh=not first_cycle,
                bypass_cooldown=not first_cycle,
                pretranslate_bg=False,
            )
            ids = [str(it.get("id", "")) for it in (res.get("items") or [])]
            if ids:
                await pretranslate_discover_articles(ids, cache, concurrency=2)
            first_cycle = False
        except asyncio.CancelledError:
            raise
        except (httpx.HTTPError, ValueError, TypeError, OSError) as exc:
            logger.warning("Discover background warmup cycle skipped: %s", exc)
            first_cycle = False
            await asyncio.sleep(120.0)


async def shutdown_discover_tasks() -> None:
    """Cancel any active Discover pre-warm background tasks cleanly on shutdown."""
    tasks = list(_PREWARM_TASKS)
    for t in tasks:
        t.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    _PREWARM_TASKS.clear()
    _ACTIVE_PREWARM_IDS.clear()
    _INFLIGHT_ARTICLE_TASKS.clear()


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
            parsed = urlparse(target_url)
            referer = f"{parsed.scheme}://{parsed.netloc}/" if parsed.scheme and parsed.netloc else ""
            resp = await client.get(
                target_url,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                    ),
                    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    **({"Referer": referer} if referer else {}),
                },
                timeout=10.0,
            )
            ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
            if resp.status_code == 200 and ctype.startswith("image/") and 512 <= len(resp.content) <= 15_000_000:
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

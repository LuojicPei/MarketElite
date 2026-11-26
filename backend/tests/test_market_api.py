from __future__ import annotations

import asyncio
import json
import time
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi.testclient import TestClient
from typing_extensions import Self

from app.core.config import Settings
from app.main import create_app
from app.services.free_translate import polish_finance_zh, translate_en_to_zh_free
from app.services.news_discover import (
    _META_PREFIX,
    DISCOVER_CACHE_KEY,
    DISCOVER_COOLDOWN_KEY,
    _infer_category_zh,
    extract_article_paragraphs,
    extract_article_structure,
    fetch_discover_candidates,
    get_discover_article_detail,
    get_discover_article_image,
    is_editorial_photo_url,
    make_article_id,
    pretranslate_discover_articles,
)
from app.services.pipeline import OVERVIEW_CACHE_KEY
from app.services.providers.macro_feeds import MacroFeedsClient
from app.services.resilience import DualTTLCache
from tests.test_resilience import InMemoryFakeRedis


class _FakeScalarResult:
    def __init__(self, items: list[object]) -> None:
        self._items = items

    def scalars(self) -> _FakeScalarResult:
        return self

    def all(self) -> list[object]:
        return self._items

    def scalar_one_or_none(self) -> object | None:
        return self._items[0] if self._items else None


class _FakeSession:
    def __init__(self, responses: list[list[object]]) -> None:
        self._responses = responses
        self._idx = 0

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def execute(self, stmt: object) -> _FakeScalarResult:
        items = self._responses[self._idx] if self._idx < len(self._responses) else []
        self._idx += 1
        return _FakeScalarResult(items)


def test_dashboard_overview_reads_redis_cache_fast() -> None:
    app = create_app()
    fake_redis = InMemoryFakeRedis()

    with TestClient(app) as client:
        app.state.infra.redis = fake_redis
        envelope = {
            "payload": {
                "generated_at": "2026-11-19T20:00:00+00:00",
                "regime_date": "2026-11-19",
                "regime": {"regime_label": "RISK_ON_EXPANSION"},
                "macro": {"net_liquidity": {"latest_billions": 6120.5}},
            },
            "fetched_at": "2026-11-19T20:00:00+00:00",
            "source": "marketelite_pipeline",
            "soft_expires_at": time.time() + 600,
        }
        fake_redis._store[OVERVIEW_CACHE_KEY] = (json.dumps(envelope), None)

        resp = client.get("/api/dashboard/overview")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["cache_source"] == "redis"
        assert body["regime"]["regime_label"] == "RISK_ON_EXPANSION"


def test_asset_detail_returns_bars_technicals_and_estimated_gex() -> None:
    app = create_app()

    fake_bars = [
        SimpleNamespace(
            trade_date=date(2026, 10, 1 + i),
            asset_class="etf",
            source="alpaca_sip_1d",
            open=580.0 + i * 0.4,
            high=582.0 + i * 0.4,
            low=579.0 + i * 0.4,
            close=581.0 + i * 0.4,
            volume=50_000_000.0 + i * 100_000.0,
            vwap=581.2 + i * 0.4,
        )
        for i in range(25)
    ]
    # Note: DB returns DESC order which endpoint reverses
    fake_bars_desc = list(reversed(fake_bars))
    fake_gex = SimpleNamespace(
        snapshot_time=datetime(2026, 11, 19, 19, 30, tzinfo=timezone.utc),
        spot_price=590.6,
        net_gex=2_450_000_000.0,
        call_wall=600.0,
        put_wall=575.0,
        zero_gamma=584.0,
        put_call_ratio=1.08,
        total_call_oi=120000,
        total_put_oi=129600,
        assumption_label="Estimated GEX (Dealer Positioning Assumption · OCC T+1/T+2 OI)",
        strike_profile_json=[{"strike": 590.0, "call_gex": 1.2e9, "put_gex": -0.4e9}],
        is_stale=False,
    )

    with TestClient(app) as client:
        app.state.session_factory = lambda: _FakeSession([fake_bars_desc, [fake_gex]])
        resp = client.get("/api/assets/SPY")
        assert resp.status_code == 200
        body = resp.json()
        assert body["symbol"] == "SPY"
        assert len(body["bars"]) == 25
        assert body["technicals"]["available"] is True
        assert body["technicals"]["rsi_14"] is not None
        assert "Estimated GEX" in body["options_gex"]["assumption_label"]
        assert body["options_gex"]["call_wall"] == 600.0

        app.state.session_factory = lambda: _FakeSession([[], []])
        resp_missing = client.get("/api/assets/UNKNOWN")
        assert resp_missing.status_code == 404


def test_list_tracked_assets_returns_latest_prices() -> None:
    app = create_app()
    rows = [
        SimpleNamespace(
            symbol="SPY",
            asset_class="etf",
            trade_date=date(2026, 11, 19),
            close=606.0,
            volume=42_000_000.0,
        ),
        SimpleNamespace(
            symbol="SPY",
            asset_class="etf",
            trade_date=date(2026, 11, 18),
            close=600.0,
            volume=39_000_000.0,
        ),
    ]
    with TestClient(app) as client:
        app.state.session_factory = lambda: _FakeSession([rows])
        resp = client.get("/api/assets")
        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 1
        assert body["assets"][0]["symbol"] == "SPY"
        assert body["assets"][0]["change_1d_pct"] == 1.0


async def test_fred_macro_calendar_parses_releases() -> None:
    upcoming = (date.today() + timedelta(days=5)).isoformat()
    payload = {"release_dates": [{"date": upcoming}, {"date": "2020-01-01"}]}
    transport = httpx.MockTransport(lambda req: httpx.Response(200, json=payload))
    async with httpx.AsyncClient(transport=transport) as client:
        feeds = MacroFeedsClient(
            Settings(_env_file=None, fred_api_key="test_key"),
            http_client=client,
        )
        events = await feeds.get_fred_macro_calendar()
        assert len(events) == 6
        assert all(ev["event_type"] == "macro" for ev in events)
        assert any("CPI" in ev["title"] for ev in events)
        assert any("PPI" in ev["title"] for ev in events)


def test_pipeline_sync_requires_admin_token_when_configured_or_prod(monkeypatch) -> None:
    app = create_app()
    prod_settings = Settings(_env_file=None, app_env="production", admin_api_token="topsecret-123")
    monkeypatch.setattr("app.api.market.get_settings", lambda: prod_settings)

    with TestClient(app) as client:
        unauth = client.post("/api/pipeline/sync")
        assert unauth.status_code == 403

        wrong = client.post("/api/pipeline/sync", headers={"X-Admin-Token": "wrong"})
        assert wrong.status_code == 403


def test_is_editorial_photo_url_filters_logos_and_bad_schemes() -> None:
    assert is_editorial_photo_url("https://image.cnbcfm.com/api/v1/image/10855.jpg")
    assert is_editorial_photo_url("https://media.zenfs.com/en/24_7_wall_st/photo.jpg")
    assert not is_editorial_photo_url("https://static2.finnhub.io/file/finnhub/logo/reuters_logo.jpeg")
    assert not is_editorial_photo_url("https://data.bloomberglp.com/company/logobbg-wht.png")
    assert not is_editorial_photo_url("https://s.yimg.com/rz/stage/p/yahoo_finance_en-US_h_p_finance_2.png")
    assert not is_editorial_photo_url("javascript:alert(1)")
    assert not is_editorial_photo_url("")


async def test_fetch_discover_candidates_clusters_sources_and_filters_logos() -> None:
    now_ts = int(time.time()) - 1800

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if "finnhub.io/api/v1/news" in url:
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 1,
                        "source": "CNBC",
                        "datetime": now_ts,
                        "headline": "S&P 500 correction deepens as Treasury yields jump",
                        "summary": "Equities slid amid sticky inflation data.",
                        "url": "https://www.cnbc.com/sp500-correction",
                        "image": "https://image.cnbcfm.com/api/v1/image/12345.jpg",
                    },
                    {
                        "id": 2,
                        "source": "Reuters",
                        "datetime": now_ts - 60,
                        "headline": "Treasury yields jump again weighing on S&P 500 index",
                        "summary": "Bond traders repriced Fed cuts.",
                        "url": "https://www.reuters.com/sp500-yields",
                        "image": "https://static2.finnhub.io/file/finnhub/logo/reuters_logo.jpeg",
                    },
                    {
                        "id": 3,
                        "source": "CNBC",
                        "datetime": now_ts - 120,
                        "headline": "I never wanted the American Dream and moved abroad",
                        "summary": "Lifestyle story.",
                        "url": "https://www.cnbc.com/lifestyle",
                        "image": "https://image.cnbcfm.com/api/v1/image/99999.jpg",
                    },
                ],
            )
        if "query1.finance.yahoo.com/v1/finance/search" in url:
            return httpx.Response(
                200,
                json={
                    "news": [
                        {
                            "title": "Nvidia chips demand stays strong despite volatility",
                            "publisher": "24/7 Wall St.",
                            "link": "https://finance.yahoo.com/news/nvda-chips",
                            "providerPublishTime": now_ts - 300,
                            "thumbnail": {
                                "resolutions": [
                                    {"width": 140, "url": "https://media.zenfs.com/small.jpg"},
                                    {"width": 1000, "url": "https://media.zenfs.com/hd-nvda.jpg"},
                                ]
                            },
                        }
                    ]
                },
            )
        if "image.cnbcfm.com" in url or "media.zenfs.com" in url:
            return httpx.Response(200, content=b"x" * 2048, headers={"content-type": "image/jpeg"})
        return httpx.Response(200, json=[])

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        items = await fetch_discover_candidates(
            Settings(_env_file=None, finnhub_api_key="test_fh"),
            http_client=client,
            verify_images=True,
        )
    assert len(items) == 2
    assert all("American Dream" not in x["headline"] for x in items)
    sp_item = next(x for x in items if "S&P 500" in x["headline"])
    assert sp_item["source_count"] >= 2
    assert "Reuters" in sp_item["sources"]
    assert sp_item["related_articles"][0]["source"] == "Reuters"
    nvda_item = next(x for x in items if "Nvidia" in x["headline"])
    assert nvda_item["image_url"] == "https://media.zenfs.com/hd-nvda.jpg"
    assert nvda_item["source"] == "24/7 Wall St."


async def test_discover_endpoint_and_image_proxy(monkeypatch) -> None:
    app = create_app()
    fake_redis = InMemoryFakeRedis()
    cache = DualTTLCache(fake_redis)

    sample_id = make_article_id("https://cnbc.com/sp500", "S&P 500 rally")
    await cache.write_envelope(
        DISCOVER_CACHE_KEY,
        payload={
            "translated": True,
            "items": [
                {
                    "id": sample_id,
                    "title_zh": "标普 500 止跌企稳 科技股引领反弹",
                    "headline_en": "S&P 500 rally",
                    "summary_zh": "美股三大指数收涨。",
                    "category_zh": "美股大盘",
                    "source": "CNBC",
                    "sources": ["CNBC", "Reuters"],
                    "source_count": 2,
                    "url": "https://cnbc.com/sp500",
                    "image_proxy_url": f"/api/market/discover/{sample_id}/image",
                    "published_at": datetime.now(timezone.utc).isoformat(),
                    "related_articles": [],
                }
            ],
        },
        source="news_discover_free",
        soft_ttl_seconds=600,
        hard_ttl_seconds=3600,
    )
    await cache.write_envelope(
        DISCOVER_COOLDOWN_KEY,
        payload={"locked": True},
        source="cooldown",
        soft_ttl_seconds=180,
        hard_ttl_seconds=300,
    )

    with TestClient(app) as client:
        app.state.infra = SimpleNamespace(redis=fake_redis)
        resp = client.get("/api/market/discover?limit=12")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["count"] == 1
        assert body["items"][0]["title_zh"] == "标普 500 止跌企稳 科技股引领反弹"

        # Public force_refresh within cooldown must return cached result without re-scraping
        cd_resp = client.get("/api/market/discover?limit=12&force_refresh=true")
        assert cd_resp.status_code == 200
        assert cd_resp.json()["cache_source"] == "redis_cooldown"

        bad_img = client.get("/api/market/discover/bad$id/image")
        assert bad_img.status_code == 400

        missing_art = client.get("/api/market/discover/disc_doesnotexist")
        assert missing_art.status_code == 404

    raw, ctype = await get_discover_article_image("disc_missing1234", cache)
    assert ctype == "image/svg+xml"
    assert b"<svg" in raw


def test_polish_finance_zh_and_article_extraction() -> None:
    polished = polish_finance_zh(
        "标准普尔 500 指数和字母表表现亮眼，个人消费支出数据公布。",
        "S&P 500 and Alphabet shine as PCE report drops.",
    )
    assert "标普 500" in polished
    assert "Alphabet" in polished
    assert "PCE" in polished

    sample_html = """
    <html><body>
      <div class="ArticleBody-articleBody">
        <p>In this article</p>
        <p>Stocks fell sharply on Monday as Treasury yields climbed to multi-month highs across the curve.</p>
        <p>Alphabet outperformed megacap peers while investors reassessed artificial intelligence capital expenditure.</p>
        <p>Federal Reserve officials emphasized patience ahead of the upcoming core PCE inflation reading.</p>
      </div>
    </body></html>
    """
    paras, paywall = extract_article_paragraphs(sample_html)
    assert paywall is False
    assert len(paras) == 3
    assert "In this article" not in paras[0]


async def test_free_translate_and_article_modal_detail() -> None:
    fake_redis = InMemoryFakeRedis()
    cache = DualTTLCache(fake_redis)
    sample_id = make_article_id("https://www.cnbc.com/story-1", "Market story")
    await cache.write_envelope(
        f"{_META_PREFIX}{sample_id}",
        payload={
            "id": sample_id,
            "title_zh": "美债收益率飙升拖累大盘",
            "headline_en": "Treasury yields surge weighing on stocks",
            "category_zh": "美股大盘",
            "source": "CNBC",
            "sources": ["CNBC", "Reuters"],
            "source_count": 2,
            "url": "https://www.cnbc.com/story-1",
            "image_proxy_url": f"/api/market/discover/{sample_id}/image",
            "published_at": datetime.now(timezone.utc).isoformat(),
            "related_articles": [],
        },
        source="news_discover",
        soft_ttl_seconds=600,
        hard_ttl_seconds=3600,
    )

    def handler(req: httpx.Request) -> httpx.Response:
        u = str(req.url)
        if "cnbc.com/story-1" in u:
            html_doc = """
            <html><body><div class="ArticleBody-articleBody">
              <p>S&amp;P 500 declined two percent on Tuesday as bond yields surged higher across maturities.</p>
              <p>Alphabet held steady while semiconductor equities faced broad institutional profit taking.</p>
              <p>Traders are monitoring core PCE inflation metrics closely before the Federal Reserve decision.</p>
            </div></body></html>
            """
            return httpx.Response(200, text=html_doc, headers={"content-type": "text/html"})
        if "clients5.google.com/translate_a/t" in u:
            qs = (
                parse_qs(req.content.decode("utf-8")).get("q", [])
                if req.method == "POST" and req.content
                else req.url.params.get_list("q")
            )
            if len(qs) == 1:
                return httpx.Response(200, json=["字母表在人工智能收益下上涨"])
            return httpx.Response(
                200,
                json=[
                    "标准普尔 500 指数周二下跌 2%，各期限债券收益率飙升。",
                    "字母表保持稳定，而半导体股票面临广泛的机构获利回吐。",
                    "在美联储做决定前，交易员正密切关注核心个人消费支出通胀指标。",
                ],
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        texts, ok = await translate_en_to_zh_free(
            ["Alphabet rose on AI gains"], cache=None, http_client=client
        )
        assert ok is True
        assert "Alphabet" in texts[0]
        detail = await get_discover_article_detail(sample_id, cache, http_client=client)
        assert detail is not None
        assert detail["access_status"] == "full"
        assert len(detail["paragraphs"]) == 3
        assert "标普 500" in detail["paragraphs"][0]["zh"]
        assert "Alphabet" in detail["paragraphs"][1]["zh"]
        assert "PCE" in detail["paragraphs"][2]["zh"]
        # Second read hits cache immediately
        cached_detail = await get_discover_article_detail(sample_id, cache, http_client=client)
        assert cached_detail is not None and cached_detail["cached"] is True


async def test_verify_full_text_filters_paywall_and_short_stubs() -> None:
    now_ts = int(time.time()) - 600

    def handler(req: httpx.Request) -> httpx.Response:
        u = str(req.url)
        if "finnhub.io/api/v1/news" in u:
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 10,
                        "source": "CNBC",
                        "datetime": now_ts,
                        "headline": "Fed signals patience on interest rates amid S&P 500 volatility",
                        "summary": "Rates focus.",
                        "url": "https://www.cnbc.com/2026/11/22/open-full-article.html",
                        "image": "https://image.cnbcfm.com/api/v1/image/1001.jpg",
                    },
                    {
                        "id": 11,
                        "source": "CNBC",
                        "datetime": now_ts - 30,
                        "headline": "Short stub article behind paywall on Nasdaq",
                        "summary": "Stub.",
                        "url": "https://www.cnbc.com/2026/11/22/short-stub.html",
                        "image": "https://image.cnbcfm.com/api/v1/image/1002.jpg",
                    },
                ],
            )
        if "open-full-article.html" in u:
            return httpx.Response(
                200,
                headers={"content-type": "text/html"},
                text="""
                <html><body><div class="ArticleBody-articleBody">
                  <p>Stocks swung sharply on Monday as Federal Reserve policy expectations shifted across Wall Street trading desks.</p>
                  <p>The S&amp;P 500 slipped early before stabilizing around key technical support levels highlighted by institutional strategists.</p>
                  <p>Treasury yields remained elevated ahead of this week's core inflation and employment revisions.</p>
                  <p>Semiconductor shares showed resilience late in the session even as broader growth names stayed under pressure.</p>
                </div></body></html>
                """,
            )
        if "short-stub.html" in u:
            return httpx.Response(
                200,
                headers={"content-type": "text/html"},
                text='<html><body><div class="ArticleBody-articleBody"><p>Create a free account to continue reading this exclusive article.</p></div></body></html>',
            )
        if "image.cnbcfm.com" in u:
            return httpx.Response(200, content=b"imgbytes" * 300, headers={"content-type": "image/jpeg"})
        return httpx.Response(200, json={})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        items = await fetch_discover_candidates(
            Settings(_env_file=None, finnhub_api_key="test_fh"),
            http_client=client,
            verify_images=True,
            verify_full_text=True,
        )
    assert len(items) == 1
    assert "open-full-article.html" in items[0]["url"]
    assert len(items[0]["pre_extracted_blocks"]) == 4
    assert "&amp;" not in items[0]["pre_extracted_blocks"][1]["en"]


def test_extract_article_structure_expands_readmore_and_strips_ads() -> None:
    yahoo_like_html = """
    <html><body>
      <div class="RenderKeyPoints-list">
        <ul>
          <li>S&amp;P 500 entered correction territory after five consecutive weeks of declines.</li>
          <li>Federal Reserve officials flagged patience on rate cuts ahead of core PCE data.</li>
        </ul>
      </div>
      <div class="body yf-v6n2s3">
        <div class="bodyItems-wrapper">
          <p>HTML_TAG_START Despite solid earnings, <strong>Nvidia</strong> fell sharply amid export curbs. HTML_TAG_END</p>
          <p>Released: The Definitive Guide to Retirement Income from Fisher Investments. Learn More Here › (sponsor)</p>
          <h2>1. Why yields jumped</h2>
          <p>Treasury yields rose sharply on sticky inflation expectations and sovereign debt supply.</p>
        </div>
        <div class="readmore yf-11souuj"><button class="readmore-button"><span>Story Continues</span></button></div>
        <div class="read-more-wrapper" data-testid="read-more">
          <h2>2. Institutional positioning</h2>
          <p>Hedge funds reduced gross leverage while rotating defensively into consumer staples and utilities.</p>
          <blockquote>"Investors should stay disciplined when volatility spikes across mega-cap tech."</blockquote>
          <h2>Should you buy stock in Nvidia right now?</h2>
          <p>Before you buy stock in Nvidia, consider this: The Motley Fool Stock Advisor team picked 10 best stocks.</p>
        </div>
      </div>
    </body></html>
    """
    blocks, paywall = extract_article_structure(yahoo_like_html)
    assert paywall is False
    types = [b["type"] for b in blocks]
    assert types == ["callout", "paragraph", "heading", "paragraph", "heading", "paragraph", "quote"]
    assert len(blocks[0]["items_en"]) == 2
    assert "HTML_TAG_START" not in blocks[1]["en"]
    assert "<b>Nvidia</b>" in blocks[1]["en"]
    # Fisher Investments sponsor promo and Motley Fool trailing pitch must be excluded
    all_text = " ".join(
        [str(b.get("en", "")) for b in blocks]
        + [" ".join(b.get("items_en", [])) for b in blocks]
    )
    assert "Fisher Investments" not in all_text
    assert "Motley Fool Stock Advisor" not in all_text
    assert "Institutional positioning" in all_text
    assert (
        _infer_category_zh("Saudi Arabia, Bahrain report new attacks as Iran remains open to a deal")
        == "地缘与能源"
    )
    polished_anth = polish_finance_zh("1. 人为IPO套现", "1. Anthropic IPO cash-out")
    assert "Anthropic" in polished_anth


async def test_pretranslate_discover_articles_populates_cache_and_coalesces() -> None:
    fake_redis = InMemoryFakeRedis()
    cache = DualTTLCache(fake_redis)
    art_id = make_article_id("https://www.cnbc.com/2026/prewarm.html", "Prewarm Story")
    await cache.write_envelope(
        f"{_META_PREFIX}{art_id}",
        payload={
            "id": art_id,
            "title_zh": "标普 500 预热测试",
            "headline_en": "Prewarm Story",
            "category_zh": "美股大盘",
            "source": "CNBC",
            "sources": ["CNBC"],
            "source_count": 1,
            "url": "https://www.cnbc.com/2026/prewarm.html",
            "image_proxy_url": f"/api/market/discover/{art_id}/image",
            "published_at": datetime.now(timezone.utc).isoformat(),
            "related_articles": [],
            "pre_extracted_blocks": [
                {"type": "paragraph", "en": "Equities rebounded sharply on Tuesday morning."},
                {"type": "paragraph", "en": "Tech megacaps led the recovery across Wall Street."},
                {"type": "paragraph", "en": "Treasury yields stabilized following macro data."},
            ],
        },
        source="news_discover",
        soft_ttl_seconds=600,
        hard_ttl_seconds=3600,
    )

    translate_calls = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal translate_calls
        if "clients5.google.com/translate_a/t" in str(req.url):
            translate_calls += 1
            return httpx.Response(
                200,
                json=["周二早盘股市大幅反弹。", "科技巨头领涨华尔街。", "宏观数据公布后美债收益率趋稳。"],
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        # Concurrent calls on same article_id coalesce into 1 translation batch
        r1, r2 = await asyncio.gather(
            get_discover_article_detail(art_id, cache, http_client=client),
            get_discover_article_detail(art_id, cache, http_client=client),
        )
        assert r1 is not None and r2 is not None
        assert translate_calls == 1
        warmed = await pretranslate_discover_articles([art_id], cache, http_client=client)
        assert warmed == 1
        assert translate_calls == 1  # Already warm in Redis cache!


async def test_fed_fomc_and_fred_ppi_calendar_parsers() -> None:
    from datetime import date, timedelta

    from app.services.providers.macro_feeds import MacroFeedsClient

    today = date.today()
    future_date = today + timedelta(days=10)
    month_name = future_date.strftime("%B")
    day_num = future_date.day

    sample_fed_html = f"""
    <html><body>
      <div class="panel panel-default">
        <div class="panel-heading"><h4>{future_date.year} FOMC Meetings</h4></div>
        <div class="fomc-meeting">
          <div class="fomc-meeting__month">{month_name}</div>
          <div class="fomc-meeting__date">{day_num}*</div>
        </div>
      </div>
    </body></html>
    """

    seen_release_ids: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if "federalreserve.gov/monetarypolicy/fomccalendars.htm" in url:
            return httpx.Response(200, text=sample_fed_html)
        if "api.stlouisfed.org/fred/release/dates" in url:
            rid = req.url.params.get("release_id", "")
            seen_release_ids.append(rid)
            return httpx.Response(200, json={"release_dates": [{"date": future_date.isoformat()}]})
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        feeds = MacroFeedsClient(
            Settings(_env_file=None, fred_api_key="demo-fred-key"),
            cache=None,
            http_client=client,
        )
        fomc = await feeds.get_fed_fomc_calendar()
        assert len(fomc) == 1
        assert "SEP Projections" in fomc[0]["title"]
        assert fomc[0]["source"] == "federalreserve_gov"

        fred_cal = await feeds.get_fred_macro_calendar()
        # Includes 10(CPI), 46(PPI), 50(NFP), 54(PCE), 9(Retail), 53(GDP)
        assert {"10", "46", "50", "54", "9", "53"}.issubset(set(seen_release_ids))
        assert any("PPI" in ev["title"] for ev in fred_cal)
        assert any("Retail Sales" in ev["title"] for ev in fred_cal)


async def test_cnn_fear_greed_parser_and_sentiment_pulse_endpoint(monkeypatch: object) -> None:
    from app.services.providers.cnn_fear_greed import parse_cnn_fear_greed_payload

    sample_cnn = {
        "fear_and_greed": {
            "score": 15.68,
            "rating": "extreme fear",
            "timestamp": "2026-11-24T12:37:25+00:00",
            "previous_close": 16.97,
            "previous_1_week": 25.95,
            "previous_1_month": 16.69,
            "previous_1_year": 13.69,
        },
        "market_momentum_sp500": {"score": 3.2, "rating": "extreme fear", "data": [{"x": 1, "y": 7237.1}]},
        "stock_price_strength": {"score": 28.6, "rating": "fear", "data": [{"x": 1, "y": -6.4}]},
        "stock_price_breadth": {"score": 17.6, "rating": "extreme fear", "data": [{"x": 1, "y": 281.7}]},
        "put_call_options": {"score": 8.8, "rating": "extreme fear", "data": [{"x": 1, "y": 0.9}]},
        "market_volatility_vix": {"score": 29.5, "rating": "fear", "data": [{"x": 1, "y": 28.88}]},
        "junk_bond_demand": {"score": 18.2, "rating": "extreme fear", "data": [{"x": 1, "y": 1.27}]},
        "safe_haven_demand": {"score": 6.4, "rating": "extreme fear", "data": [{"x": 1, "y": -6.75}]},
    }
    parsed = parse_cnn_fear_greed_payload(sample_cnn)
    assert parsed["source"] == "cnn_live"
    assert parsed["score"] == 15.7
    assert parsed["label"] == "Extreme Fear"
    assert parsed["previous_close"] == 17.0
    assert parsed["components"]["put_call"] == 8.8
    assert parsed["component_raw_values"]["put_call"] == 0.9
    assert parsed["component_raw_values"]["safe_haven"] == -6.75

    async def _fake_cnn(*, cache: object = None, http_client: object = None, force_refresh: bool = False) -> dict[str, object]:
        return parsed

    async def _fake_yahoo(*, cache: object = None, force_refresh: bool = False) -> dict[str, object]:
        return {
            "vix": {
                "symbol": "^VIX",
                "price": 28.91,
                "prev_close": 27.5,
                "change_abs": 1.41,
                "change_pct": 5.13,
                "peak_high": 40.2,
                "peak_date": "2026-11-18",
                "bars": [
                    {"trade_date": "2026-11-18", "open": 31.0, "high": 40.2, "low": 29.8, "close": 35.1},
                    {"trade_date": "2026-11-24", "open": 27.5, "high": 29.4, "low": 26.8, "close": 28.91},
                ],
            },
            "dxy": {"symbol": "DX-Y.NYB", "price": 103.87, "change_abs": -0.03, "change_pct": -0.03},
            "tnx": {"symbol": "^TNX", "price": 4.91, "change_abs": 0.04, "change_pct": 0.82},
            "spy_closes": [{"date": "2026-11-18", "close": 710.2}, {"date": "2026-11-24", "close": 715.87}],
            "fetched_utc": "2026-11-24T12:40:00+00:00",
        }

    import app.api.market as market_api_mod

    monkeypatch.setattr(market_api_mod, "fetch_cnn_fear_greed", _fake_cnn)
    monkeypatch.setattr(market_api_mod, "fetch_yahoo_macro_sentiment_series", _fake_yahoo)

    app = create_app()
    fake_redis = InMemoryFakeRedis()
    with TestClient(app) as client:
        app.state.infra.redis = fake_redis
        resp = client.get("/api/market/sentiment-pulse")
        assert resp.status_code == 200
        body = resp.json()
        assert body["fear_greed"]["score"] == 15.7
        assert body["vix"]["peak_high"] == 40.2
        assert len(body["vix"]["bars"]) == 2
        assert body["dxy"]["price"] == 103.87
        assert len(body["spy_closes"]) == 2


async def test_institutional_flow_options_radar_and_sector_heatmap(monkeypatch: object) -> None:
    from app.quant.options import OptionContractInput
    from app.services.providers.alpaca import AlpacaClient
    from app.services.providers.macro_feeds import MacroFeedsClient

    tff_rows = [
        {
            "cftc_contract_market_code": "13874A",
            "report_date_as_yyyy_mm_dd": f"2026-10-{10 + i:02d}T00:00:00.000",
            "asset_mgr_positions_long": str(1_100_000 + i * 10000),
            "asset_mgr_positions_short": "220000",
            "lev_money_positions_long": "180000",
            "lev_money_positions_short": str(360000 + i * 15000),
            "lev_money_positions_spread": "45000",
            "dealer_positions_long_all": "120000",
            "dealer_positions_short_all": "480000",
            "open_interest_all": "3200000",
        }
        for i in range(6)
    ]
    disagg_rows = [
        {
            "cftc_contract_market_code": "088691",
            "report_date_as_yyyy_mm_dd": f"2026-10-{10 + i:02d}T00:00:00.000",
            "swap_positions_long_all": "40000",
            "swap__positions_short_all": "210000",
            "m_money_positions_long_all": str(210000 + i * 5000),
            "m_money_positions_short_all": "55000",
            "m_money_positions_spread": "30000",
            "prod_merc_positions_long": "30000",
            "prod_merc_positions_short": "80000",
            "open_interest_all": "520000",
        }
        for i in range(6)
    ]

    def cftc_handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if "gpe5-46if.json" in url:
            return httpx.Response(200, json=tff_rows)
        if "72hh-3qpy.json" in url:
            return httpx.Response(200, json=disagg_rows)
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(cftc_handler)) as client:
        feeds = MacroFeedsClient(Settings(_env_file=None), cache=None, http_client=client)
        flow = await feeds.get_cftc_institutional_flow()
        assert flow["contracts"]["ES"]["real_money"]["net"] > 900_000
        assert flow["contracts"]["ES"]["leveraged"]["net"] < -200_000
        assert flow["contracts"]["ES"]["leveraged"]["percentile_52w"] == 0.0
        assert flow["contracts"]["ES"]["crowded_signal"] == "squeeze_risk"
        assert flow["contracts"]["GC"]["real_money"]["net"] == -170_000.0
        assert len(flow["contracts"]["ES"]["series_26w"]) == 6

    async def _fake_opt_inputs(self: AlpacaClient, symbol: str, *, force_refresh: bool = False) -> dict[str, object]:
        return {
            "symbol": symbol,
            "spot_price": 715.0,
            "contracts": [
                OptionContractInput("SPY261127C00720000", "call", 720.0, 9000, volume=18000, expiration_date="2026-11-27", dte=3, iv=0.20, delta=0.35, last_price=5.2),
                OptionContractInput("SPY261127P00700000", "put", 700.0, 14000, volume=22000, expiration_date="2026-11-27", dte=3, iv=0.27, delta=-0.26, last_price=2.9),
            ],
            "source": "alpaca_indicative",
            "is_stale": False,
        }

    async def _fake_inst(self: MacroFeedsClient, *, force_refresh: bool = False) -> dict[str, object]:
        return {"status": "ok", "report_date": "2026-11-17", "summary_zh": "test", "contracts": {"ES": {"symbol": "ES"}}}

    async def _fake_heatmap(**kwargs: object) -> dict[str, object]:
        return {
            "status": "ok",
            "source": "alpaca_snapshots",
            "summary_zh": "今日主线领涨：能源(+1.8%)",
            "sectors": [{"symbol": "XLK", "short_zh": "科技", "market_weight_pct": 31.5, "return_1d_pct": -1.8, "constituents": []}],
        }

    import app.api.market as market_api_mod

    monkeypatch.setattr(AlpacaClient, "get_options_chain_inputs", _fake_opt_inputs)
    monkeypatch.setattr(MacroFeedsClient, "get_cftc_institutional_flow", _fake_inst)
    monkeypatch.setattr(market_api_mod, "build_sector_heatmap_payload", _fake_heatmap)

    app = create_app()
    fake_redis = InMemoryFakeRedis()
    with TestClient(app) as client:
        app.state.infra.redis = fake_redis
        r_inst = client.get("/api/market/institutional-flow")
        assert r_inst.status_code == 200
        assert r_inst.json()["contracts"]["ES"]["symbol"] == "ES"

        r_opt = client.get("/api/market/options-radar?symbol=NVDA&bucket=weekly")
        assert r_opt.status_code == 200
        opt_body = r_opt.json()
        assert opt_body["symbol"] == "NVDA"
        assert opt_body["max_pain"] is not None
        assert opt_body["iv_skew_25d"] == 7.0
        assert len(opt_body["unusual_flow"]) == 2

        r_btc = client.get("/api/market/options-radar?symbol=BTCUSDT&bucket=all")
        assert r_btc.status_code == 200
        assert r_btc.json()["status"] == "unsupported"

        r_sec = client.get("/api/market/sector-heatmap")
        assert r_sec.status_code == 200
        assert r_sec.json()["sectors"][0]["symbol"] == "XLK"


async def test_intraday_vwap_and_core_benchmarks_endpoint(monkeypatch: object) -> None:
    from app.services.providers.yahoo_tape import _parse_intraday_result

    sample_chart = {
        "meta": {"regularMarketPrice": 718.5, "previousClose": 715.0},
        "timestamp": [1795530600, 1795530900, 1795531200],
        "indicators": {
            "quote": [
                {
                    "open": [715.2, 716.5, 717.8],
                    "high": [717.0, 718.2, 719.0],
                    "low": [715.0, 716.0, 717.5],
                    "close": [716.5, 717.8, 718.5],
                    "volume": [100000, 150000, 200000],
                }
            ]
        },
    }
    bars, spot, prev_c, ext_info = _parse_intraday_result(sample_chart, last_day_only=True)
    assert spot == 718.5
    assert prev_c == 715.0
    assert ext_info is None
    assert len(bars) == 3
    assert bars[-1]["session"] == "regular"
    assert bars[-1]["vwap"] > 715.0

    # Verify pre/post extended hours session tagging and extended_hours summary
    ext_chart = {
        "meta": {
            "regularMarketPrice": 155.38,
            "previousClose": 152.0,
            "currentTradingPeriod": {
                "pre": {"start": 1795507200, "end": 1795527000},
                "regular": {"start": 1795527000, "end": 1795550400},
                "post": {"start": 1795550400, "end": 1795564800},
            },
        },
        "timestamp": [1795525200, 1795530600, 1795552200],
        "indicators": {
            "quote": [
                {
                    "open": [153.0, 155.0, 152.2],
                    "high": [153.5, 155.8, 152.5],
                    "low": [152.8, 154.5, 151.8],
                    "close": [153.2, 155.38, 151.95],
                    "volume": [10000, 200000, 35000],
                }
            ]
        },
    }
    ext_bars, _, _, ext_meta = _parse_intraday_result(ext_chart, last_day_only=True)
    assert [b["session"] for b in ext_bars] == ["pre", "regular", "post"]
    assert ext_meta is not None and ext_meta["session"] == "post"
    assert ext_meta["price"] == 151.95

    async def _fake_intraday(symbol: str, *, tf: str = "1d", cache: object = None, force_refresh: bool = False) -> dict[str, object]:
        return {
            "symbol": symbol,
            "tf": tf,
            "interval": "5m" if tf == "1d" else "15m",
            "spot_price": 718.5 if symbol != "BTCUSDT" else 62100.0,
            "prev_close": 715.0 if symbol != "BTCUSDT" else 61500.0,
            "bars": bars,
        }

    import app.api.market as market_api_mod
    from app.services.providers.alpaca import AlpacaClient

    monkeypatch.setattr(market_api_mod, "fetch_yahoo_intraday_bars", _fake_intraday)

    async def _fake_snaps(self: AlpacaClient, symbols: list[str], *, force_refresh: bool = False) -> dict[str, object]:
        return {
            "SPY": {"price": 718.5, "prev_close": 715.0, "change_1d_pct": 0.49},
            "QQQ": {"price": 649.0, "prev_close": 644.0, "change_1d_pct": 0.78},
            "SOXX": {"price": 141.0, "prev_close": 138.0, "change_1d_pct": 2.17},
        }

    monkeypatch.setattr(AlpacaClient, "get_batch_stock_snapshots", _fake_snaps)

    app = create_app()
    fake_redis = InMemoryFakeRedis()
    with TestClient(app) as client:
        app.state.infra.redis = fake_redis
        r_intra = client.get("/api/assets/SPY/intraday?tf=1d")
        assert r_intra.status_code == 200
        assert len(r_intra.json()["bars"]) == 3
        assert r_intra.json()["bars"][0]["vwap"] > 0

        r_bench = client.get("/api/market/core-benchmarks")
        assert r_bench.status_code == 200
        items = r_bench.json()["items"]
        assert [it["symbol"] for it in items] == ["SPY", "QQQ", "SOXX", "BTCUSDT"]
        assert items[0]["last_close"] == 718.5
        assert items[3]["display_symbol"] == "BTC"


def test_movers_excludes_leveraged_etfs() -> None:
    from app.services.providers.market_movers import _rank_top20, is_leveraged_or_inverse_etf

    assert is_leveraged_or_inverse_etf("SOXL") is True
    assert is_leveraged_or_inverse_etf("NVD", "GraniteShares 2x Short NVDA", "反向做空ETF") is True
    assert is_leveraged_or_inverse_etf("CUSTOMX", "Direxion Daily AI Bull 2X Shares", "科技") is True
    assert is_leveraged_or_inverse_etf("NVDA", "英伟达", "AI算力") is False
    assert is_leveraged_or_inverse_etf("SPY", "标普500ETF", "核心宽基") is False

    ranked = _rank_top20(
        [
            {"symbol": "SOXL", "name_zh": "3x做多半导体", "theme_zh": "杠杆ETF", "price": 45.0, "change_1d_pct": 12.0},
            {"symbol": "NVD", "name_zh": "GraniteShares 2x Short NVDA", "theme_zh": "反向做空ETF", "price": 18.0, "change_1d_pct": 9.0},
            {"symbol": "SPDN", "name_zh": "Direxion Bear 1X", "theme_zh": "反向做空ETF", "price": 11.0, "change_1d_pct": 5.0},
            {"symbol": "NVDA", "name_zh": "英伟达", "theme_zh": "AI算力", "price": 135.0, "change_1d_pct": 4.2},
            {"symbol": "AAPL", "name_zh": "苹果", "theme_zh": "七姐妹", "price": 225.0, "change_1d_pct": 1.8},
        ],
        min_price=2.0,
        sort_key="change_1d_pct",
        reverse=True,
    )
    assert [r["symbol"] for r in ranked] == ["NVDA", "AAPL"]


def test_overlay_live_quote_updates_volume_price_tag() -> None:
    from app.api.market import _overlay_live_quote_on_technicals

    stale_tech = {
        "available": True,
        "last_close": 722.29,
        "prev_close": 689.81,
        "change_1d_pct": 4.71,
        "rvol_20": 1.514,
        "volume_price_tag": "Volume Expansion Up (Accumulation / Breakout)",
        "sparkline_bars": [{"t": 0, "o": 720.0, "h": 724.0, "l": 719.0, "c": 722.29}],
    }
    updated = _overlay_live_quote_on_technicals(
        dict(stale_tech),
        live_price=716.67,
        prev_close=718.91,
        live_chg_pct=-0.31,
    )
    assert updated["last_close"] == 716.67
    assert updated["change_1d_pct"] == -0.31
    assert updated["volume_price_tag"].startswith("Volume Expansion Down")


async def test_yahoo_tape_cnbc_front_month_brent_override() -> None:
    from app.services.providers.yahoo_tape import (
        MacroTapeSpec,
        _fetch_cnbc_live_quotes,
        _fetch_single_spec,
    )

    def handler(req: httpx.Request) -> httpx.Response:
        u = str(req.url)
        if "quote.cnbc.com" in u:
            return httpx.Response(
                200,
                json={
                    "FormattedQuoteResult": {
                        "FormattedQuote": [
                            {"symbol": "@LCO.1", "last": "95.24", "previous_day_closing": "94.61", "change": "+0.63"}
                        ]
                    }
                },
            )
        if "query1.finance.yahoo.com/v8/finance/chart/BZ=F" in u:
            return httpx.Response(
                200,
                json={
                    "chart": {
                        "result": [
                            {
                                "meta": {"regularMarketPrice": 91.18, "previousClose": 90.64},
                                "timestamp": [1795665000 + i * 900 for i in range(6)],
                                "indicators": {
                                    "quote": [
                                        {
                                            "open": [91.0] * 6,
                                            "high": [91.3] * 6,
                                            "low": [90.9] * 6,
                                            "close": [91.05, 91.08, 91.10, 91.12, 91.15, 91.18],
                                        }
                                    ]
                                },
                            }
                        ]
                    }
                },
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        cnbc = await _fetch_cnbc_live_quotes(client, ["@LCO.1"])
        assert cnbc["@LCO.1"]["price"] == 95.24
        brent = await _fetch_single_spec(
            client,
            MacroTapeSpec("BZ=F", "BNO", "Brent Crude", "布伦特油", 2, "$", "@LCO.1"),
            cnbc,
        )
        assert brent is not None
        assert brent["price"] == 95.24
        assert brent["prev_close"] == 94.61
        assert abs(brent["bars"][-1]["c"] - 95.24) < 0.05


async def test_discover_heals_poisoned_english_article_cache() -> None:
    from app.services.news_discover import _ARTICLE_PREFIX, make_article_id

    fake_redis = InMemoryFakeRedis()
    cache = DualTTLCache(fake_redis)
    art_id = make_article_id("https://www.cnbc.com/story-heal", "Poisoned story")

    # Simulate an old broken Redis cache entry whose title_zh and zh fields still contain English
    en_title = "Fed officials signal patience on inflation"
    en_text = "Federal Reserve policymakers signaled patience as equity markets absorbed fresh inflation data."
    await cache.write_envelope(
        f"{_ARTICLE_PREFIX}{art_id}",
        payload={
            "status": "ok",
            "id": art_id,
            "title_zh": en_title,
            "headline_en": en_title,
            "category_zh": "宏观政策",
            "source": "CNBC",
            "sources": ["CNBC"],
            "source_count": 1,
            "url": "https://www.cnbc.com/story-heal",
            "image_proxy_url": f"/api/market/discover/{art_id}/image",
            "published_at": datetime.now(timezone.utc).isoformat(),
            "access_status": "full",
            "blocks": [{"type": "paragraph", "en": en_text, "zh": en_text}],
            "paragraphs": [{"index": 0, "en": en_text, "zh": en_text}],
            "related_articles": [],
            "cached": False,
        },
        source="news_discover_article_free",
        soft_ttl_seconds=86400 * 2,
        hard_ttl_seconds=86400 * 7,
    )

    def handler(req: httpx.Request) -> httpx.Response:
        if "clients5.google.com/translate_a/t" in str(req.url):
            return httpx.Response(
                200,
                json=[
                    "美联储官员对通胀释放耐心信号",
                    "美联储决策者在股市消化新通胀数据之际释放耐心信号。",
                ],
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        healed = await get_discover_article_detail(art_id, cache, http_client=client)
        assert healed is not None
        assert "美联储" in healed["title_zh"]
        assert "美联储" in healed["paragraphs"][0]["zh"]
        assert "美联储" in healed["blocks"][0]["zh"]


def test_recompute_technicals_with_live_bars_updates_rsi_rvol_and_52w() -> None:
    from app.api.market import _merge_recent_daily_bars, _recompute_technicals_with_live_bar
    from app.quant.technicals import DailyBarInput

    # 35 rising days peaking at 200 on bar 25, then pulling back
    base_bars = [
        DailyBarInput(
            trade_date=f"2026-10-{idx + 1:02d}",
            open=100.0 + idx * 2.0,
            high=102.0 + idx * 2.0,
            low=99.0 + idx * 2.0,
            close=101.0 + idx * 2.0,
            volume=1_000_000.0,
        )
        for idx in range(30)
    ]
    stale_tech, _ = _recompute_technicals_with_live_bar(base_bars)
    assert stale_tech["rsi_14"] > 80.0

    # Merge two fresh pullback daily bars (avoiding stale RSI freeze) + live same-day tick
    recent = [
        {
            "trade_date": "2026-10-30",
            "open": 159.0,
            "high": 160.0,
            "low": 149.0,
            "close": 150.0,
            "volume": 2_000_000.0,
        },
        {
            "trade_date": "2026-10-31",
            "open": 150.0,
            "high": 151.0,
            "low": 139.0,
            "close": 140.0,
            "volume": 2_500_000.0,
        },
    ]
    merged = _merge_recent_daily_bars(base_bars, recent)
    assert len(merged) == 31
    live_tech, synced = _recompute_technicals_with_live_bar(
        merged,
        live_price=138.0,
        prev_close=150.0,
        live_bar_date="2026-10-31",
        live_volume=500_000.0,  # smaller IEX partial vol must not clobber 2.5M SIP vol
    )
    assert len(synced) == 31
    assert live_tech["rsi_14"] < stale_tech["rsi_14"] - 20.0
    assert live_tech["dist_52w_high_pct"] < -13.0
    assert live_tech["rvol_20"] is not None


async def test_build_macro_release_history_and_attach_events(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services.macro_history import (
        attach_macro_context_to_events,
        build_macro_release_history,
    )
    from app.services.providers.fred import FredClient

    fake_series = {
        "DFEDTARU": [
            {"obs_date": "2026-09-10", "value": 3.75},
            {"obs_date": "2026-09-17", "value": 4.0},
            {"obs_date": "2026-10-30", "value": 4.0},
        ],
        "DFEDTARL": [
            {"obs_date": "2026-09-10", "value": 3.5},
            {"obs_date": "2026-09-17", "value": 3.75},
            {"obs_date": "2026-10-30", "value": 3.75},
        ],
        "PAYEMS": [
            {"obs_date": "2026-08-01", "value": 159000.0},
            {"obs_date": "2026-09-01", "value": 159080.0},
            {"obs_date": "2026-10-01", "value": 159245.0},
        ],
        "UNRATE": [
            {"obs_date": "2026-09-01", "value": 4.2},
            {"obs_date": "2026-10-01", "value": 4.1},
        ],
        "CPIAUCSL": [
            {"obs_date": "2025-09-01", "value": 325.0},
            {"obs_date": "2025-10-01", "value": 326.0},
            {"obs_date": "2026-09-01", "value": 334.75},
            {"obs_date": "2026-10-01", "value": 336.432},
        ],
        "CPILFESL": [
            {"obs_date": "2025-10-01", "value": 328.0},
            {"obs_date": "2026-10-01", "value": 338.824},
        ],
        "PCEPI": [
            {"obs_date": "2025-10-01", "value": 129.0},
            {"obs_date": "2026-10-01", "value": 132.703},
        ],
        "PCEPILFE": [
            {"obs_date": "2025-09-01", "value": 127.0},
            {"obs_date": "2025-10-01", "value": 127.5},
            {"obs_date": "2026-09-01", "value": 130.5},
            {"obs_date": "2026-10-01", "value": 131.325},
        ],
        "PPIFIS": [
            {"obs_date": "2025-10-01", "value": 155.0},
            {"obs_date": "2026-09-01", "value": 159.5},
            {"obs_date": "2026-10-01", "value": 160.27},
        ],
        "A191RL1Q225SBEA": [
            {"obs_date": "2026-04-01", "value": 2.2},
            {"obs_date": "2026-07-01", "value": 4.3},
        ],
        "RSAFS": [
            {"obs_date": "2025-10-01", "value": 720000.0},
            {"obs_date": "2026-09-01", "value": 746000.0},
            {"obs_date": "2026-10-01", "value": 748238.0},
        ],
    }

    async def fake_get_series(self: FredClient, series_id: str, **kwargs: object) -> dict[str, object]:
        return {"series_id": series_id, "observations": fake_series.get(series_id, [])}

    monkeypatch.setattr(FredClient, "get_series", fake_get_series)
    cache = DualTTLCache(InMemoryFakeRedis())
    history = await build_macro_release_history(cache, Settings())
    ids = [h["id"] for h in history]
    assert ids == ["fomc", "nfp", "cpi", "pce", "ppi", "gdp", "retail"]

    nfp = next(h for h in history if h["id"] == "nfp")
    assert nfp["latest_display"] == "+16.5万"
    assert "4.1%" in (nfp["secondary_badge"] or "")

    cpi = next(h for h in history if h["id"] == "cpi")
    assert cpi["latest_display"] == "+3.20%"
    assert "+3.30%" in (cpi["secondary_badge"] or "")

    events = [
        {"event_type": "macro", "title": "US Employment Situation (NFP)", "previous": None},
        {"event_type": "macro", "title": "US Consumer Price Index (CPI)", "previous": None},
        {"event_type": "macro", "title": "FOMC Rate Decision & SEP Projections", "previous": None},
    ]
    enriched = attach_macro_context_to_events(events, history)
    assert "16.5万" in enriched[0]["previous_summary"]
    assert "+3.20%" in enriched[1]["previous_summary"]
    assert "3.75%-4.00%" in enriched[2]["previous_summary"]










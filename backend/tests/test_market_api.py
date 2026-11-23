from __future__ import annotations

import json
import time
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
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
        assert len(events) == 4
        assert all(ev["event_type"] == "macro" for ev in events)
        assert any("CPI" in ev["title"] for ev in events)


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
            qs = req.url.params.get_list("q")
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






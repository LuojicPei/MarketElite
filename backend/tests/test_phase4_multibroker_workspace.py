from __future__ import annotations

from urllib.parse import parse_qs

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.workspace import resolve_workspace_id
from app.main import create_app
from app.services.broker import resolve_broker_config
from app.services.providers.binance_ro import BinanceReadOnlyClient
from app.services.providers.ibkr_flex import IBKRFlexClient
from app.services.providers.portfolio_import import parse_holdings_input
from app.services.resilience import PermanentProviderError


async def test_ibkr_flex_client_send_and_parse_xml() -> None:
    sample_xml = """<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="Portfolio" type="AF">
  <FlexStatements count="1">
    <FlexStatement accountId="U1234567" currency="USD">
      <AccountInformation accountId="U1234567" currency="USD" />
      <CashReportCurrency currency="BASE_SUMMARY" endingCash="12500.50" />
      <OpenPositions>
        <OpenPosition symbol="MSFT" assetCategory="STK" position="10" markPrice="430.0" costBasisPrice="400.0" positionValue="4300.0" fifoPnlUnrealized="300.0" currency="USD" />
      </OpenPositions>
      <Trades>
        <Trade symbol="NVDA" buySell="SELL" quantity="5" tradePrice="175.0" ibOrderID="9991" fifoPnlRealized="120.0" dateTime="2026-11-24T15:30:00Z" orderType="LMT" />
      </Trades>
    </FlexStatement>
  </FlexStatements>
</FlexQueryResponse>"""

    def _handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/SendRequest"):
            return httpx.Response(
                200,
                text=(
                    "<FlexStatementResponse timestamp='2026'>"
                    "<Status>Success</Status>"
                    "<ReferenceCode>REF-99</ReferenceCode>"
                    "<Url>https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</Url>"
                    "</FlexStatementResponse>"
                ),
            )
        if req.url.path.endswith("/GetStatement"):
            return httpx.Response(200, text=sample_xml)
        return httpx.Response(404)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(_handler))
    client = IBKRFlexClient(flex_token="tok-1", query_id="q-2", http_client=http_client)
    snap = await client.get_snapshot(force_refresh=True)
    await http_client.aclose()

    assert snap["account"]["broker"] == "ibkr"
    assert snap["account"]["cash"] == 12500.5
    assert snap["account"]["equity"] == 16800.5
    assert len(snap["positions"]) == 1
    assert snap["positions"][0]["symbol"] == "MSFT"
    assert snap["positions"][0]["unrealized_pl"] == 300.0
    assert snap["trades"][0]["external_id"] == "ibkr:9991"


async def test_binance_readonly_client_signs_and_filters_dust() -> None:
    captured_headers: dict[str, str] = {}
    captured_qs: dict[str, list[str]] = {}

    def _handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/v3/account":
            captured_headers.update({k.lower(): v for k, v in req.headers.items()})
            captured_qs.update(parse_qs(req.url.query.decode("utf-8")))
            return httpx.Response(
                200,
                json={
                    "balances": [
                        {"asset": "USDT", "free": "5000.0", "locked": "0.0"},
                        {"asset": "BTC", "free": "0.5", "locked": "0.0"},
                        {"asset": "SOL", "free": "10.0", "locked": "0.0"},
                        {"asset": "ETH", "free": "0.00001", "locked": "0.0"},
                    ]
                },
            )
        if req.url.path == "/api/v3/ticker/price":
            return httpx.Response(
                200,
                json=[
                    {"symbol": "BTCUSDT", "price": "90000.0"},
                    {"symbol": "SOLUSDT", "price": "200.0"},
                    {"symbol": "ETHUSDT", "price": "3000.0"},
                ],
            )
        return httpx.Response(404)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(_handler))
    client = BinanceReadOnlyClient(
        api_key="bn-key",
        api_secret="bn-secret",
        env="global",
        http_client=http_client,
    )
    snap = await client.get_snapshot(force_refresh=True)
    await http_client.aclose()

    assert captured_headers["x-mbx-apikey"] == "bn-key"
    assert "signature" in captured_qs
    assert snap["account"]["cash"] == 5000.0
    assert snap["account"]["equity"] == 52000.0
    assert [p["symbol"] for p in snap["positions"]] == ["BTC-USD", "SOL-USD"]

    def _unauthorized(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"code": -2015, "msg": "Invalid API-key"})

    http_401 = httpx.AsyncClient(transport=httpx.MockTransport(_unauthorized))
    bad_client = BinanceReadOnlyClient(api_key="bad", api_secret="bad", http_client=http_401)
    with pytest.raises(PermanentProviderError):
        await bad_client.get_snapshot(force_refresh=True)
    await http_401.aclose()


def test_portfolio_import_parses_csv_and_quick_lines() -> None:
    csv_text = """Ticker,Shares,Avg Cost,Currency
NVDA,10,$135.50,USD
NVDA,10,$145.50,USD
AAPL,5,210,USD
CASH,1000,1,USD
TOTAL,,"""
    rows = parse_holdings_input(csv_text, default_source="Robinhood")
    by_sym = {r["symbol"]: r for r in rows}
    assert set(by_sym.keys()) == {"NVDA", "AAPL"}
    assert by_sym["NVDA"]["qty"] == 20.0
    assert by_sym["NVDA"]["avg_cost_price"] == 140.5
    assert by_sym["AAPL"]["avg_cost_price"] == 210.0

    quick_rows = parse_holdings_input("TSLA 8 @ 310\nMSFT, 4, 420")
    assert len(quick_rows) == 2
    assert quick_rows[0]["symbol"] == "TSLA"
    assert quick_rows[0]["avg_cost_price"] == 310.0
    assert quick_rows[1]["symbol"] == "MSFT"
    assert quick_rows[1]["qty"] == 4.0


def test_workspace_resolution_and_multibroker_isolation_routes() -> None:
    assert resolve_workspace_id({}) == "default"
    assert resolve_workspace_id({"X-Workspace-Id": "ws user!@#99"}) == "wsuser99"

    cfg_ibkr = resolve_broker_config(
        Settings(),
        {
            "X-Broker-Provider": "ibkr",
            "X-IBKR-Flex-Token": "ftok",
            "X-IBKR-Query-Id": "fqid",
            "X-Workspace-Id": "ws-alpha",
        },
    )
    assert cfg_ibkr.provider == "ibkr"
    assert cfg_ibkr.workspace_id == "ws-alpha"
    assert cfg_ibkr.ibkr_flex_token == "ftok"

    app = create_app()
    iso_ws = "__test_phase4_iso_ws__"
    iso_headers = {"X-Workspace-Id": iso_ws}
    rule_id: int | None = None

    with TestClient(app) as client:
        try:
            # Verify neutral broker_profile metadata for sandbox & csv_import
            sbx_res = client.get(
                "/api/trade/ledger",
                headers={**iso_headers, "X-Broker-Provider": "sandbox"},
            )
            assert sbx_res.status_code == 200
            assert sbx_res.json()["broker_profile"]["id"] == "sandbox"
            assert sbx_res.json()["workspace_id"] == iso_ws

            # Unified broker test check for sandbox & csv_import
            t1 = client.post("/api/trade/broker/test", json={"provider": "sandbox"})
            assert t1.status_code == 200
            assert t1.json()["ok"] is True

            t2 = client.post("/api/trade/broker/test", json={"provider": "csv_import"})
            assert t2.status_code == 200
            assert t2.json()["ok"] is True

            # Import CSV holdings exclusively into iso_ws
            imp_resp = client.post(
                "/api/trade/broker/import-holdings",
                headers=iso_headers,
                json={
                    "raw_text": "NVDA 5 @ 150\nAAPL, 3, 215",
                    "source_label": "Robinhood Export",
                    "replace_existing": True,
                },
            )
            assert imp_resp.status_code == 200
            assert imp_resp.json()["imported_count"] == 2

            # Isolated workspace ledger sees imported holdings when X-Broker-Provider=csv_import
            csv_ledger = client.get(
                "/api/trade/ledger",
                headers={**iso_headers, "X-Broker-Provider": "csv_import"},
            )
            assert csv_ledger.status_code == 200
            csv_body = csv_ledger.json()
            assert csv_body["broker_profile"]["id"] == "csv_import"
            assert {p["symbol"] for p in csv_body["positions"]} == {"NVDA", "AAPL"}

            # Playbook rule created in iso_ws is invisible to default workspace
            pb_resp = client.post(
                "/api/memories/playbook",
                headers=iso_headers,
                json={
                    "symbol": "NVDA",
                    "regime_label": "RISK_OFF_STRESS",
                    "title": "__TEST_ISO_RULE__",
                    "lesson_text": "Isolated workspace Playbook rule.",
                },
            )
            assert pb_resp.status_code == 200
            rule_id = int(pb_resp.json()["memory"]["id"])

            default_reviews = client.get("/api/reviews?limit=30")
            assert default_reviews.status_code == 200
            assert all(m["id"] != rule_id for m in default_reviews.json()["memories"])

            iso_reviews = client.get("/api/reviews?limit=30", headers=iso_headers)
            assert iso_reviews.status_code == 200
            assert any(m["id"] == rule_id for m in iso_reviews.json()["memories"])
        finally:
            if rule_id is not None:
                client.delete(f"/api/memories/playbook/{rule_id}", headers=iso_headers)
            client.delete("/api/trade/broker/imported-holdings", headers=iso_headers)

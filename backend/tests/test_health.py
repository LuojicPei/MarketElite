from __future__ import annotations

from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


def test_health_endpoint_masks_secrets_and_reports_components(monkeypatch) -> None:
    secret_value = "super_secret_alpaca_token_12345"
    test_settings = Settings(
        alpaca_api_key="PKTESTKEY123",
        alpaca_secret_key=secret_value,
        fred_api_key="fred_secret_999",
    )
    monkeypatch.setattr("app.api.health.get_settings", lambda: test_settings)

    app = create_app()
    with TestClient(app) as client:
        infra = app.state.infra
        monkeypatch.setattr(
            infra,
            "probe_postgres",
            AsyncMock(
                return_value={
                    "status": "up",
                    "latency_ms": 1.2,
                    "pgvector_enabled": True,
                    "detail": "PostgreSQL + pgvector ready",
                }
            ),
        )
        monkeypatch.setattr(
            infra,
            "probe_redis",
            AsyncMock(
                return_value={
                    "status": "up",
                    "latency_ms": 0.6,
                    "detail": "Redis PONG received",
                }
            ),
        )
        monkeypatch.setattr(
            infra,
            "probe_phoenix",
            AsyncMock(
                return_value={
                    "status": "up",
                    "latency_ms": 2.4,
                    "ui_url": "http://localhost:6006",
                    "detail": "HTTP 200",
                }
            ),
        )

        resp = client.get("/health")
        assert resp.status_code == 200
        payload = resp.json()

        assert payload["status"] == "ok"
        assert payload["components"]["postgres"]["pgvector_enabled"] is True
        assert payload["components"]["redis"]["status"] == "up"
        assert payload["components"]["phoenix"]["status"] == "up"

        # Ensure secrets never appear in serialized response
        raw_text = resp.text
        assert secret_value not in raw_text
        assert "fred_secret_999" not in raw_text
        assert "PKTESTKEY123" not in raw_text

        by_id = {item["id"]: item for item in payload["integrations"]}
        assert by_id["alpaca"]["configured"] is True
        assert by_id["fred"]["configured"] is True
        assert by_id["finnhub"]["configured"] is False


def test_system_architecture_endpoint_returns_four_stages() -> None:
    app = create_app()
    with TestClient(app) as client:
        resp = client.get("/api/system/architecture")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["stages"]) == 4
        assert [s["id"] for s in data["stages"]] == [
            "base",
            "investigator",
            "critic",
            "watchdog",
        ]

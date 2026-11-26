from __future__ import annotations

import json
import time
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.services.dataplatform import (
    build_lineage_graph,
    inspect_redis_and_circuits,
    run_data_quality_audit,
)
from app.services.news_discover import DISCOVER_CACHE_KEY
from tests.test_resilience import InMemoryFakeRedis


class _FakeRedisExtended(InMemoryFakeRedis):
    """Test double extending InMemoryFakeRedis with keys/ttl/info for Data Platform probes."""

    async def keys(self, pattern: str = "*") -> list[str]:
        prefix = pattern.rstrip("*")
        return [k for k in list(self._store.keys()) if k.startswith(prefix)]

    async def ttl(self, key: str) -> int:
        self._evict_if_expired(key)
        entry = self._store.get(key)
        if entry is None or entry[1] is None:
            return -1
        return max(0, int(entry[1] - time.time()))

    async def info(self, section: str = "memory") -> dict[str, str]:
        return {"used_memory_human": "2.40M"}


class _FakeDqSession:
    """Deterministic sequential async session double driving all 6 DQ queries cleanly."""

    def __init__(self, *, dirty_mode: bool = False) -> None:
        self.dirty_mode = dirty_mode
        self._scalar_idx = 0
        self._exec_idx = 0
        today = date.today()
        # scalar sequence in run_data_quality_audit:
        # 1: total_bars, 2: bad_bars, 3: gex_cnt, 4: bad_gex, 5: null_zg,
        # 6..11: workspace nulls across 6 tables
        if dirty_mode:
            self._scalars = [500, 3, 10, 2, 1, 0, 2, 0, 0, 0, 0]
            self._execs = [
                [("SPY", 30), ("QQQ", 5)],  # core_counts (QQQ/SOXX/NVDA/AAPL short)
                [("WALCL", today - timedelta(days=30)), ("DGS10", today)],  # stale macro + missing TGA/RRP/DGS2
            ]
        else:
            self._scalars = [800, 0, 12, 0, 1, 0, 0, 0, 0, 0, 0]
            self._execs = [
                [("SPY", 60), ("QQQ", 60), ("SOXX", 60), ("NVDA", 60), ("AAPL", 60)],
                [
                    ("WALCL", today - timedelta(days=4)),
                    ("WTREGEN", today - timedelta(days=2)),
                    ("RRPONTSYD", today - timedelta(days=1)),
                    ("DGS10", today - timedelta(days=1)),
                    ("DGS2", today - timedelta(days=1)),
                ],
            ]

    async def scalar(self, _stmt: object) -> int:
        val = self._scalars[self._scalar_idx] if self._scalar_idx < len(self._scalars) else 0
        self._scalar_idx += 1
        return val

    async def execute(self, _stmt: object) -> SimpleNamespace:
        rows = self._execs[self._exec_idx] if self._exec_idx < len(self._execs) else []
        self._exec_idx += 1
        return SimpleNamespace(all=lambda: rows)


async def test_redis_circuit_and_lineage_propagation() -> None:
    redis = _FakeRedisExtended()
    now_s = time.time()

    # Fresh overview envelope
    await redis.set(
        "marketelite:dashboard:overview",
        json.dumps(
            {
                "payload": {},
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "soft_expires_at": now_s + 600,
                "source": "pipeline",
            }
        ),
    )
    # Stale grace on-chain envelope + open circuit breaker for alpaca
    await redis.set(
        "marketelite:onchain:pulse:v1",
        json.dumps(
            {
                "payload": {},
                "fetched_at": (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat(),
                "soft_expires_at": now_s - 60,
                "source": "onchain_pulse",
            }
        ),
    )
    await redis.set("marketelite:cb:alpaca:state", "open", ex=55)
    await redis.set("marketelite:cb:alpaca:failures", "5", ex=55)

    settings = Settings()
    snap = await inspect_redis_and_circuits(redis, settings, now_epoch=now_s)
    assert snap["open_circuit_breakers"] == 1
    assert snap["fresh_envelopes"] == 1
    assert snap["stale_envelopes"] == 1
    assert snap["used_memory_human"] == "2.40M"

    alpaca_row = next(p for p in snap["providers"] if p["id"] == "alpaca")
    assert alpaca_row["circuit_state"] == "open"
    assert alpaca_row["recent_failures"] == 5

    lineage = build_lineage_graph(
        catalog=[
            {"table": "market_daily_bars", "row_count": 2500, "sla_status": "healthy"},
            {"table": "market_regime_daily", "row_count": 30, "sla_status": "healthy"},
            {"table": "sec_filing_chunks", "row_count": 120, "sla_status": "healthy"},
            {"table": "episodic_memories", "row_count": 12, "sla_status": "healthy"},
            {"table": "investigator_threads", "row_count": 6, "sla_status": "healthy"},
        ],
        cache_snapshot=snap,
        settings=settings,
    )
    node_map = {n["id"]: n for n in lineage["nodes"]}
    assert node_map["ods_alpaca"]["status"] == "circuit_open"
    assert node_map["dwd_cache"]["status"] == "degraded"
    assert len(lineage["edges"]) >= 18


async def test_data_quality_audit_catches_dirty_and_clean_states() -> None:
    redis = _FakeRedisExtended()
    items_21 = [
        {"title_zh": f"第{i}条美股重磅资讯测试" if i < 20 else "Un-translated English headline", "source": "CNBC"}
        for i in range(21)
    ]
    await redis.set(DISCOVER_CACHE_KEY, json.dumps({"payload": {"items": items_21}}))
    await redis.set("marketelite:onchain:pulse:v1", json.dumps({"payload": {"degraded_sources": ["Mempool"]}}))

    dirty_res = await run_data_quality_audit(_FakeDqSession(dirty_mode=True), redis)  # type: ignore[arg-type]
    by_id = {c["id"]: c for c in dirty_res["checks"]}
    assert by_id["DQ-01"]["status"] == "fail"
    assert by_id["DQ-02"]["status"] == "warn"
    assert by_id["DQ-03"]["status"] == "fail"
    assert by_id["DQ-04"]["status"] == "warn"
    assert by_id["DQ-05"]["status"] == "fail"
    assert "user_watchlist_items(2)" in by_id["DQ-05"]["detail_zh"]
    assert by_id["DQ-06"]["status"] == "warn"
    assert dirty_res["health_score"] < 50.0

    # Clean state: 21 Chinese titles + 3 microstructure caches with zero degraded sources
    clean_items = [{"title_zh": f"第{i}条全中文资讯", "source": "Reuters"} for i in range(21)]
    await redis.set(DISCOVER_CACHE_KEY, json.dumps({"payload": {"items": clean_items}}))
    await redis.set("marketelite:onchain:pulse:v1", json.dumps({"payload": {"degraded_sources": []}}))
    await redis.set("marketelite:moc:proxy:SPY:v1", json.dumps({"payload": {"status": "ok"}}))
    await redis.set("marketelite:finra:ats_weekly:SPY:v1", json.dumps({"payload": {"weeks": []}}))

    clean_res = await run_data_quality_audit(_FakeDqSession(dirty_mode=False), redis)  # type: ignore[arg-type]
    assert all(c["status"] == "pass" for c in clean_res["checks"])
    assert clean_res["health_score"] == 100.0


def test_dataplatform_api_and_admin_guard(monkeypatch) -> None:
    fake_redis = _FakeRedisExtended()

    class _EmptyResult:
        def mappings(self) -> _EmptyResult:
            return self

        def one(self) -> dict[str, object]:
            return {"row_count": 0, "distinct_entities": 0, "min_dt": None, "max_dt": None}

        def all(self) -> list[object]:
            return []

        def scalars(self) -> _EmptyResult:
            return self

    class _FakeSession:
        async def __aenter__(self) -> _FakeSession:
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def execute(self, _stmt: object) -> _EmptyResult:
            return _EmptyResult()

        async def scalar(self, _stmt: object) -> int:
            return 0

    async def fake_rag_debug(*args, **kwargs) -> dict[str, object]:
        return {
            "status": "ok",
            "elapsed_ms": 12.3,
            "symbol": "NVDA",
            "query": "gross margin",
            "chunks": [],
        }

    monkeypatch.setattr("app.api.dataplatform.debug_hybrid_rag_search", fake_rag_debug)
    monkeypatch.setattr(
        "app.api.dataplatform.get_settings",
        lambda: Settings(admin_api_token="secret-dp-token"),
    )

    app = create_app()
    with TestClient(app) as client:
        app.state.infra.redis = fake_redis
        app.state.session_factory = lambda: _FakeSession()

        r_ov = client.get("/api/dataplatform/overview")
        assert r_ov.status_code == 200
        body = r_ov.json()
        assert body["status"] == "ok"
        assert body["kpis"]["total_tables"] == 16
        assert body["access_mode"]["requires_admin_token"] is True
        assert len(body["lineage"]["nodes"]) >= 15

        r_rag = client.get("/api/dataplatform/rag-governance")
        assert r_rag.status_code == 200
        assert r_rag.json()["sec_corpus"]["total_chunks"] == 0

        r_dq_unauth = client.post("/api/dataplatform/quality/run")
        assert r_dq_unauth.status_code == 403

        r_dq_auth = client.post(
            "/api/dataplatform/quality/run",
            headers={"X-Admin-Token": "secret-dp-token"},
        )
        assert r_dq_auth.status_code == 200

        r_dbg_unauth = client.post(
            "/api/dataplatform/rag-debug",
            json={"symbol": "NVDA", "query": "gross margin"},
        )
        assert r_dbg_unauth.status_code == 403

        r_dbg = client.post(
            "/api/dataplatform/rag-debug",
            headers={"X-Admin-Token": "secret-dp-token"},
            json={"symbol": "NVDA", "query": "gross margin"},
        )
        assert r_dbg.status_code == 200
        assert r_dbg.json()["symbol"] == "NVDA"

        # Circuit reset & domain sync enforce X-Admin-Token
        r_unauth = client.post("/api/dataplatform/circuits/alpaca/reset")
        assert r_unauth.status_code == 403

        r_sync_unauth = client.post(
            "/api/dataplatform/sync-domain",
            json={"domain": "macro", "force_refresh": False},
        )
        assert r_sync_unauth.status_code == 403

        r_auth = client.post(
            "/api/dataplatform/circuits/alpaca/reset",
            headers={"X-Admin-Token": "secret-dp-token"},
        )
        assert r_auth.status_code == 200
        assert r_auth.json()["provider"] == "alpaca"


def test_public_showcase_readonly_locks_mutations_while_allowing_reads(monkeypatch) -> None:
    fake_redis = _FakeRedisExtended()

    class _EmptyRes:
        def mappings(self) -> _EmptyRes:
            return self

        def one(self) -> dict[str, object]:
            return {"row_count": 0, "distinct_entities": 0, "min_dt": None, "max_dt": None}

        def all(self) -> list[object]:
            return []

        def scalars(self) -> _EmptyRes:
            return self

    class _ReadSession:
        async def __aenter__(self) -> _ReadSession:
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def execute(self, _stmt: object) -> _EmptyRes:
            return _EmptyRes()

        async def scalar(self, _stmt: object) -> int:
            return 0

    locked_settings = Settings(public_showcase_readonly=True, admin_api_token="")
    monkeypatch.setattr("app.api.dataplatform.get_settings", lambda: locked_settings)
    monkeypatch.setattr("app.api.watchdog.get_settings", lambda: locked_settings)

    app = create_app()
    with TestClient(app) as client:
        app.state.infra.redis = fake_redis
        app.state.session_factory = lambda: _ReadSession()

        # Public GET showcase routes remain accessible
        assert client.get("/api/dataplatform/overview").status_code == 200
        assert client.get("/api/dataplatform/access-mode").json()["requires_admin_token"] is True
        assert client.get("/api/evals/latest").status_code == 200

        # Mutating / compute POST routes are strictly locked even without ADMIN_API_TOKEN
        assert client.post("/api/dataplatform/quality/run").status_code == 403
        assert client.post("/api/dataplatform/rag-debug", json={"symbol": "AMD", "query": "margin"}).status_code == 403
        assert client.post("/api/dataplatform/evals/run", json={}).status_code == 403
        assert client.post("/api/evals/run").status_code == 403
        assert client.post("/api/watchdog/autopilot/run-now").status_code == 403

from __future__ import annotations

from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.services.eval_engine import (
    _extract_meaningful_numbers,
    compute_runs_diff,
    run_full_eval_suite,
)
from tests.test_dataplatform import _FakeRedisExtended


async def test_full_four_track_eval_engine_runs_offline_and_computes_metrics() -> None:
    report = await run_full_eval_suite(
        settings=Settings(),
        session_factory=None,
        pass_k_trials=3,
        use_live_judge=False,
        trigger_source="pytest",
        save_file_report=False,
    )

    assert report["suite_version"] == "v2.0-4track"
    assert report["total_cases"] == 54
    assert report["passed_cases"] == 54
    assert report["pass_rate_pct"] == 100.0

    tracks = report["tracks"]
    assert tracks["track1"]["passed"] == 32
    assert tracks["track2"]["passed"] == 8
    assert tracks["track2"]["metrics"]["avg_mrr"] >= 0.75
    assert tracks["track2"]["metrics"]["avg_recall_at_3"] == 1.0
    assert tracks["track2"]["metrics"]["avg_faithfulness"] >= 0.9

    assert tracks["track3"]["passed"] == 6
    assert tracks["track3"]["metrics"]["pass_k_trials"] == 3
    assert tracks["track3"]["metrics"]["pass_at_1_pct"] == 100.0
    assert tracks["track3"]["metrics"]["pass_pow_k_pct"] == 100.0

    assert tracks["track4"]["passed"] == 8
    assert tracks["track4"]["metrics"]["safety_block_rate_pct"] == 100.0
    assert tracks["track4"]["metrics"]["counterfactual_flip_rate_pct"] == 100.0


def test_numeric_extractor_and_regression_diff_detector() -> None:
    ctx_nums = _extract_meaningful_numbers("[10-K 2026-02-26 · Item 7] Revenue reached $47.5 billion and margin 62.4%.")
    ans_nums = _extract_meaningful_numbers("营收达到 $47.5 billion，预计飙升至 $99.9 billion 且毛利率达 88.2%。")
    assert "47.5" in ctx_nums
    assert sorted(ans_nums - ctx_nums) == ["88.2", "99.9"]

    baseline = {
        "run_key": "eval-base",
        "pass_rate_pct": 100.0,
        "duration_ms": 180.0,
        "tracks": {
            "track1": {"title_zh": "Track 1", "pass_rate_pct": 100.0},
            "track2": {"title_zh": "Track 2", "pass_rate_pct": 100.0},
        },
        "results": [
            {"id": "REG-01", "track": "track1", "name": "Regime", "passed": True, "observed": {"ok": 1}},
            {"id": "RAG-F05", "track": "track2", "name": "Faithfulness", "passed": True, "observed": {"ok": 1}},
            {"id": "AGT-02", "track": "track3", "name": "Deadlock", "passed": False, "observed": {"ok": 0}},
        ],
    }
    candidate = {
        "run_key": "eval-cand",
        "pass_rate_pct": 66.7,
        "duration_ms": 210.0,
        "tracks": {
            "track1": {"title_zh": "Track 1", "pass_rate_pct": 100.0},
            "track2": {"title_zh": "Track 2", "pass_rate_pct": 0.0},
        },
        "results": [
            {"id": "REG-01", "track": "track1", "name": "Regime", "passed": True, "observed": {"ok": 1}},
            {"id": "RAG-F05", "track": "track2", "name": "Faithfulness", "passed": False, "observed": {"ok": 0}},
            {"id": "AGT-02", "track": "track3", "name": "Deadlock", "passed": True, "observed": {"ok": 1}},
        ],
    }
    diff = compute_runs_diff(candidate, baseline)
    assert diff["regression_detected"] is True
    assert diff["overall_delta_pct"] == -33.3
    assert [c["id"] for c in diff["newly_regressed"]] == ["RAG-F05"]
    assert [c["id"] for c in diff["newly_fixed"]] == ["AGT-02"]
    assert diff["track_deltas"]["track2"]["delta_pct"] == -100.0


def test_dataplatform_eval_endpoints_and_baseline_guard(monkeypatch) -> None:
    fake_redis = _FakeRedisExtended()

    class _EmptyResult:
        def scalars(self) -> _EmptyResult:
            return self

        def all(self) -> list[object]:
            return []

        def first(self) -> None:
            return None

        def one(self) -> dict[str, object]:
            return {"row_count": 0, "distinct_entities": 0, "min_dt": None, "max_dt": None}

        def mappings(self) -> _EmptyResult:
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

        def add(self, _obj: object) -> None:
            return None

        async def commit(self) -> None:
            return None

    async def fake_pin_baseline(_sf, run_key: str) -> dict[str, object]:
        return {
            "id": 1,
            "run_key": run_key,
            "is_baseline": True,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

    async def fake_compare(_sf, *, candidate_key: str, baseline_key: str) -> dict[str, object]:
        return {
            "candidate_run_key": candidate_key,
            "baseline_run_key": baseline_key,
            "overall_delta_pct": 0.0,
            "regression_detected": False,
            "newly_regressed": [],
            "newly_fixed": [],
            "track_deltas": {},
        }

    monkeypatch.setattr("app.api.dataplatform.pin_eval_baseline", fake_pin_baseline)
    monkeypatch.setattr("app.api.dataplatform.compare_eval_runs_by_key", fake_compare)
    monkeypatch.setattr(
        "app.api.dataplatform.get_settings",
        lambda: Settings(admin_api_token="secret-eval-token"),
    )

    app = create_app()
    with TestClient(app) as client:
        app.state.infra.redis = fake_redis
        app.state.session_factory = lambda: _FakeSession()

        r_mode = client.get("/api/dataplatform/access-mode")
        assert r_mode.status_code == 200
        assert r_mode.json()["requires_admin_token"] is True
        assert r_mode.json()["admin_configured"] is True

        r_verify_bad = client.post(
            "/api/dataplatform/admin/verify",
            headers={"X-Admin-Token": "wrong-pass"},
        )
        assert r_verify_bad.status_code == 403

        r_verify_ok = client.post(
            "/api/dataplatform/admin/verify",
            headers={"X-Admin-Token": "secret-eval-token"},
        )
        assert r_verify_ok.status_code == 200
        assert r_verify_ok.json()["unlocked"] is True

        r_run_unauth = client.post(
            "/api/dataplatform/evals/run",
            json={"tracks": ["track1", "track2", "track3", "track4"], "pass_k_trials": 3},
        )
        assert r_run_unauth.status_code == 403

        r_run = client.post(
            "/api/dataplatform/evals/run",
            headers={"X-Admin-Token": "secret-eval-token"},
            json={"tracks": ["track1", "track2", "track3", "track4"], "pass_k_trials": 3},
        )
        assert r_run.status_code == 200
        body = r_run.json()
        assert body["total_cases"] == 54
        assert body["passed_cases"] == 54

        r_pin_unauth = client.post("/api/dataplatform/evals/runs/eval-test-01/baseline")
        assert r_pin_unauth.status_code == 403

        r_pin_auth = client.post(
            "/api/dataplatform/evals/runs/eval-test-01/baseline",
            headers={"X-Admin-Token": "secret-eval-token"},
        )
        assert r_pin_auth.status_code == 200
        assert r_pin_auth.json()["baseline"]["is_baseline"] is True

        r_cmp = client.get("/api/dataplatform/evals/compare?candidate=eval-2&baseline=eval-1")
        assert r_cmp.status_code == 200
        assert r_cmp.json()["diff"]["regression_detected"] is False

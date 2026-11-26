from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.core.config import get_settings
from app.core.security import build_access_mode_snapshot, require_admin_token
from app.services.dataplatform import (
    build_data_catalog,
    build_finops_telemetry,
    build_lineage_graph,
    debug_hybrid_rag_search,
    inspect_rag_and_memory,
    inspect_redis_and_circuits,
    run_data_quality_audit,
)
from app.services.eval_engine import (
    compare_eval_runs_by_key,
    get_eval_run_detail,
    list_eval_runs,
    pin_eval_baseline,
    run_full_eval_suite,
)
from app.services.news_discover import get_or_refresh_discover_news
from app.services.pipeline import (
    build_and_persist_overview,
    run_full_pipeline_sync,
    sync_btc_and_cftc,
    sync_calendars,
    sync_equities_and_breadth,
    sync_macro_and_cboe,
    sync_options_gex,
)
from app.services.resilience import DualTTLCache

router = APIRouter(prefix="/api/dataplatform", tags=["dataplatform"])


@router.get("/access-mode")
async def get_dataplatform_access_mode() -> dict[str, Any]:
    """Return public read-only showcase mode & admin lock status without leaking credentials."""
    return {"status": "ok", **build_access_mode_snapshot(get_settings())}


@router.post("/admin/verify")
async def verify_dataplatform_admin_token(
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> dict[str, Any]:
    """Verify X-Admin-Token header cleanly so UI can unlock Admin controls."""
    settings = get_settings()
    require_admin_token(settings, x_admin_token, action_label="Admin console unlock")
    return {"status": "ok", "unlocked": True, **build_access_mode_snapshot(settings)}


class RagDebugRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=16)
    query: str = Field(min_length=2, max_length=400)
    form_type: str | None = Field(default=None, max_length=12)
    top_k: int = Field(default=5, ge=1, le=10)
    allow_ingest: bool = False


class DomainSyncRequest(BaseModel):
    domain: str = Field(
        pattern="^(macro|equities_gex|calendars_cot|discover_news|full)$"
    )
    force_refresh: bool = False


class MultiTrackEvalRequest(BaseModel):
    tracks: list[str] = Field(default_factory=lambda: ["track1", "track2", "track3", "track4"])
    pass_k_trials: int = Field(default=3, ge=2, le=5)
    use_live_judge: bool = False
    mark_baseline: bool = False
    notes: str = Field(default="", max_length=255)


@router.get("/overview")
async def get_dataplatform_overview(request: Request) -> dict[str, Any]:
    """Return full live Postgres 15-table catalog, Redis cache/circuit probes, DQ audit & 4-layer lineage."""
    infra = request.app.state.infra
    session_factory = request.app.state.session_factory
    settings = get_settings()

    cache_snap = await inspect_redis_and_circuits(infra.redis, settings)
    async with session_factory() as session:
        catalog = await build_data_catalog(session)
        quality = await run_data_quality_audit(session, infra.redis)
        finops = await build_finops_telemetry(session, settings, cache_snap)

    lineage = build_lineage_graph(
        catalog=catalog,
        cache_snapshot=cache_snap,
        settings=settings,
    )
    total_pg_rows = sum(int(t["row_count"]) for t in catalog)
    healthy_tables = sum(1 for t in catalog if t["sla_status"] == "healthy")

    return {
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "access_mode": build_access_mode_snapshot(settings),
        "kpis": {
            "total_tables": len(catalog),
            "healthy_tables": healthy_tables,
            "total_pg_rows": total_pg_rows,
            "redis_keys": cache_snap["total_keys"],
            "open_circuit_breakers": cache_snap["open_circuit_breakers"],
            "fresh_envelopes": cache_snap["fresh_envelopes"],
            "stale_envelopes": cache_snap["stale_envelopes"],
            "dq_health_score": quality["health_score"],
            "phoenix_ui_url": settings.phoenix_ui_url if settings.enable_telemetry else None,
        },
        "catalog": catalog,
        "quality": quality,
        "lineage": lineage,
        "cache_and_circuits": cache_snap,
        "finops": finops,
    }


@router.post("/quality/run")
async def run_dataplatform_quality_endpoint(
    request: Request,
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> dict[str, Any]:
    """Trigger on-demand execution of all 6 deterministic financial Data Quality probes."""
    require_admin_token(get_settings(), x_admin_token, action_label="Data Quality audit run")
    infra = request.app.state.infra
    session_factory = request.app.state.session_factory
    async with session_factory() as session:
        quality = await run_data_quality_audit(session, infra.redis)
    return {"status": "ok", **quality}


@router.get("/rag-governance")
async def get_dataplatform_rag_governance(request: Request) -> dict[str, Any]:
    """Return SEC EDGAR chunk/pgvector coverage + Episodic Memory distribution."""
    session_factory = request.app.state.session_factory
    async with session_factory() as session:
        payload = await inspect_rag_and_memory(session)
    return {"status": "ok", **payload}


@router.post("/rag-debug")
async def debug_dataplatform_rag_endpoint(
    payload: RagDebugRequest,
    request: Request,
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> dict[str, Any]:
    """Execute Hybrid Search (pgvector + BM25 RRF) diagnostic query (Admin locked in Showcase)."""
    settings = get_settings()
    require_admin_token(settings, x_admin_token, action_label="Hybrid RAG live debug")
    session_factory = request.app.state.session_factory
    return await debug_hybrid_rag_search(
        session_factory,
        settings,
        symbol=payload.symbol,
        query=payload.query,
        form_type=payload.form_type,
        top_k=payload.top_k,
        allow_ingest=payload.allow_ingest,
    )


@router.post("/circuits/{provider}/reset")
async def reset_provider_circuit_endpoint(
    provider: str,
    request: Request,
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> dict[str, Any]:
    """Clear Redis circuit breaker state & failure counter for a specific provider."""
    settings = get_settings()
    require_admin_token(settings, x_admin_token, action_label="Provider circuit breaker reset")
    clean_p = provider.strip().lower()
    if not clean_p or not all(ch.isalnum() or ch == "_" for ch in clean_p):
        raise HTTPException(status_code=400, detail="Invalid provider identifier.")
    infra = request.app.state.infra
    deleted = 0
    if infra.redis is not None:
        deleted = int(
            await infra.redis.delete(
                f"marketelite:cb:{clean_p}:state",
                f"marketelite:cb:{clean_p}:failures",
            )
        )
    return {"status": "ok", "provider": clean_p, "keys_cleared": deleted}


@router.post("/sync-domain")
async def sync_dataplatform_domain_endpoint(
    payload: DomainSyncRequest,
    request: Request,
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> dict[str, Any]:
    """Trigger scoped pipeline synchronization for a specific data domain."""
    settings = get_settings()
    require_admin_token(settings, x_admin_token, action_label="Data domain pipeline sync")
    infra = request.app.state.infra
    session_factory = request.app.state.session_factory
    t0 = time.perf_counter()

    if payload.domain == "macro":
        detail = await sync_macro_and_cboe(
            session_factory, infra.redis, settings, force_refresh=payload.force_refresh
        )
        await build_and_persist_overview(session_factory, infra.redis, settings)
    elif payload.domain == "equities_gex":
        btc = await sync_btc_and_cftc(
            session_factory, infra.redis, settings, force_refresh=payload.force_refresh
        )
        eq = await sync_equities_and_breadth(
            session_factory, infra.redis, settings, force_refresh=payload.force_refresh
        )
        gex = await sync_options_gex(
            session_factory, infra.redis, settings, force_refresh=payload.force_refresh
        )
        await build_and_persist_overview(session_factory, infra.redis, settings)
        detail = {"btc": btc.get("status"), "equities": eq.get("status"), "gex": gex.get("status")}
    elif payload.domain == "calendars_cot":
        cal = await sync_calendars(session_factory, infra.redis, settings)
        cftc = await sync_btc_and_cftc(
            session_factory, infra.redis, settings, force_refresh=payload.force_refresh
        )
        await build_and_persist_overview(session_factory, infra.redis, settings)
        detail = {"calendars": cal, "cftc": cftc.get("status")}
    elif payload.domain == "discover_news":
        res = await get_or_refresh_discover_news(
            DualTTLCache(infra.redis),
            settings,
            limit=21,
            force_refresh=payload.force_refresh,
            bypass_cooldown=payload.force_refresh,
        )
        detail = {"count": res.get("count", 0), "translated": res.get("translated")}
    else:
        detail = await run_full_pipeline_sync(
            session_factory, infra.redis, settings, force_refresh=payload.force_refresh
        )

    return {
        "status": "ok",
        "domain": payload.domain,
        "elapsed_ms": round((time.perf_counter() - t0) * 1000.0, 1),
        "detail": detail,
    }


@router.get("/evals/runs")
async def list_dataplatform_eval_runs(
    request: Request,
    limit: int = Query(default=15, ge=1, le=50),
) -> dict[str, Any]:
    """List persisted 4-Track EvalRuns, active Golden Baseline & newest diff."""
    session_factory = request.app.state.session_factory
    data = await list_eval_runs(session_factory, limit=limit)
    if not data.get("runs"):
        settings = get_settings()
        fresh = await run_full_eval_suite(
            settings=settings,
            session_factory=session_factory,
            trigger_source="auto_bootstrap",
            notes="Initial 4-Track Golden Baseline",
            mark_baseline=True,
        )
        data = await list_eval_runs(session_factory, limit=limit)
        if data.get("latest_report") is None:
            data["latest_report"] = fresh
    return {"status": "ok", **data}


@router.get("/evals/runs/{run_key}")
async def get_dataplatform_eval_run_detail(
    run_key: str,
    request: Request,
) -> dict[str, Any]:
    """Fetch complete persisted EvalRun report payload by run_key."""
    session_factory = request.app.state.session_factory
    detail = await get_eval_run_detail(session_factory, run_key.strip())
    if detail is None:
        raise HTTPException(status_code=404, detail=f"EvalRun `{run_key}` not found.")
    return {"status": "ok", **detail}


@router.post("/evals/run")
async def run_dataplatform_eval_suite(
    payload: MultiTrackEvalRequest,
    request: Request,
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> dict[str, Any]:
    """Execute 4-Track MarketElite Eval suite, persist EvalRun to PG & diff against baseline."""
    settings = get_settings()
    require_admin_token(settings, x_admin_token, action_label="4-Track Evaluation execution")
    session_factory = request.app.state.session_factory
    report = await run_full_eval_suite(
        settings=settings,
        session_factory=session_factory,
        tracks=payload.tracks,
        pass_k_trials=payload.pass_k_trials,
        use_live_judge=payload.use_live_judge,
        trigger_source="manual_ui",
        mark_baseline=payload.mark_baseline,
        notes=payload.notes,
        save_file_report=True,
    )
    return report


@router.post("/evals/runs/{run_key}/baseline")
async def pin_dataplatform_eval_baseline(
    run_key: str,
    request: Request,
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
) -> dict[str, Any]:
    """Pin an existing EvalRun as the canonical Golden Regression Baseline."""
    settings = get_settings()
    require_admin_token(settings, x_admin_token, action_label="Golden Baseline pin")
    updated = await pin_eval_baseline(request.app.state.session_factory, run_key.strip())
    if updated is None:
        raise HTTPException(status_code=404, detail=f"EvalRun `{run_key}` not found.")
    return {"status": "ok", "baseline": updated}


@router.get("/evals/compare")
async def compare_dataplatform_eval_runs(
    request: Request,
    candidate: str = Query(min_length=3, max_length=64),
    baseline: str = Query(min_length=3, max_length=64),
) -> dict[str, Any]:
    """Compute exact pass-rate, track-by-track & case-level diff between two EvalRuns."""
    diff = await compare_eval_runs_by_key(
        request.app.state.session_factory,
        candidate_key=candidate.strip(),
        baseline_key=baseline.strip(),
    )
    if diff is None:
        raise HTTPException(status_code=404, detail="Candidate or baseline EvalRun not found.")
    return {"status": "ok", "diff": diff}

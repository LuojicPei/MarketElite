from __future__ import annotations

import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from redis.exceptions import RedisError
from sqlalchemy import desc, func, select

from app.agents.debate import DebateRunner
from app.agents.investigator import InvestigatorAgentRunner
from app.core.config import get_settings
from app.core.workspace import resolve_workspace_id
from app.db.models import InvestigatorThread, SecFilingDocument
from app.mcp_servers.market_server import list_read_only_tools_metadata
from app.rag.hybrid_search import HybridSecRetriever
from app.services.broker import resolve_broker_config
from app.services.llm_router import (
    LLMUnconfiguredError,
    fetch_available_models,
    resolve_llm_settings,
    test_llm_connection,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["agent-and-rag"])


class SecSearchRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=16, description="US equity ticker symbol")
    query: str = Field(min_length=2, max_length=400, description="Search query over 10-K/10-Q")
    form_type: str | None = Field(default=None, pattern="^(10-K|10-Q|8-K)?$")
    top_k: int = Field(default=5, ge=1, le=8)
    auto_ingest: bool = Field(default=True)


class ChatTurn(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(min_length=1, max_length=6000)


class InvestigateRequest(BaseModel):
    thread_id: str = Field(min_length=3, max_length=120)
    query: str = Field(min_length=2, max_length=2000)
    symbol: str | None = Field(default=None, max_length=16)
    history: list[ChatTurn] = Field(default_factory=list)


class TestConnectionRequest(BaseModel):
    api_key: str = Field(default="", max_length=512)
    base_url: str = Field(min_length=8, max_length=512)
    model: str = Field(min_length=1, max_length=160)


class FetchModelsRequest(BaseModel):
    api_key: str = Field(default="", max_length=512)
    base_url: str = Field(min_length=8, max_length=512)


class DebateRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=16)
    side: str = Field(default="buy", pattern="^(buy|sell|BUY|SELL)$")
    risk_budget_pct: float = Field(default=1.0, ge=0.25, le=2.0)
    thesis_hint: str = Field(default="", max_length=600)


def _friendly_llm_test_error(exc: Exception) -> str:
    raw = str(exc)
    low = raw.lower()
    if "401" in low or "invalid_api_key" in low or "authentication" in low or "unauthorized" in low:
        return f"API Key 无效或无权访问：{raw[:180]}"
    if "402" in low or "insufficient" in low or "balance" in low or "quota" in low or "429" in low:
        return f"额度不足或触发频控：{raw[:180]}"
    if "404" in low or "does not exist" in low or "not found" in low:
        return f"模型名称不存在或 Base URL 路径有误：{raw[:180]}"
    if "timeout" in low or "connect" in low or "dns" in low or "name or service" in low:
        return f"无法连通模型接口（网络/URL 异常）：{raw[:180]}"
    return f"连接测试失败：{raw[:200]}"


def _format_sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


async def _check_guest_rate_limit(redis_client: Any, client_ip: str, limit_rpm: int) -> None:
    if redis_client is None:
        return
    bucket = int(time.time() // 60)
    key = f"marketelite:ratelimit:agent:{client_ip}:{bucket}"
    try:
        count = await redis_client.incr(key)
        if count == 1:
            await redis_client.expire(key, 65)
        if int(count) > limit_rpm:
            raise HTTPException(
                status_code=429,
                detail=f"Rate limit exceeded ({limit_rpm} req/min). Wait before retrying.",
            )
    except RedisError as exc:
        logger.warning("Rate limit check degraded gracefully: %s", exc)


@router.get("/agent/status")
async def get_agent_status(request: Request) -> dict[str, Any]:
    """Report FastMCP read-only tools, LLM router configuration, SEC cache & Phoenix UI status."""
    base_settings = get_settings()
    try:
        settings, key_source = resolve_llm_settings(base_settings, request.headers)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    session_factory = request.app.state.session_factory
    async with session_factory() as session:
        cached_filings = (
            await session.execute(select(func.count(SecFilingDocument.id)))
        ).scalar_one()

    tools = await list_read_only_tools_metadata()
    llm_pro_ready = bool(settings.llm_pro_api_key.strip() or settings.llm_fast_api_key.strip())
    llm_fast_ready = bool(settings.llm_fast_api_key.strip() or settings.llm_pro_api_key.strip())

    is_prod_local_phoenix = settings.app_env.lower() == "production" and (
        "localhost" in settings.phoenix_ui_url or "127.0.0.1" in settings.phoenix_ui_url
    )

    return {
        "status": "ready" if llm_pro_ready else "llm_key_required",
        "key_source": key_source,
        "llm_pro_ready": llm_pro_ready,
        "llm_fast_ready": llm_fast_ready,
        "llm_pro_model": settings.llm_pro_model,
        "llm_fast_model": settings.llm_fast_model,
        "telemetry_enabled": settings.enable_telemetry,
        "phoenix_ui_url": None if is_prod_local_phoenix else settings.phoenix_ui_url,
        "mcp_endpoint": "/mcp-server/mcp",
        "mcp_tools": tools,
        "sec_cached_filings": int(cached_filings or 0),
        "limits": {
            "max_steps": settings.agent_max_steps,
            "wall_timeout_seconds": settings.agent_wall_timeout_seconds,
            "max_context_tokens": settings.agent_max_context_tokens,
            "guest_rpm": settings.guest_chat_rpm,
        },
    }


@router.post("/agent/test-connection")
async def test_agent_connection(
    payload: TestConnectionRequest, request: Request
) -> dict[str, Any]:
    """Validate browser-supplied OpenAI-compatible API Key / Base URL / Model live."""
    base_settings = get_settings()
    header_key = (request.headers.get("X-LLM-Api-Key") or "").strip()
    api_key = payload.api_key.strip() or header_key
    try:
        return await test_llm_connection(
            api_key=api_key,
            base_url=payload.base_url,
            model=payload.model,
            app_env=base_settings.app_env,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=_friendly_llm_test_error(exc)) from exc


@router.post("/agent/models")
async def list_byok_models(
    payload: FetchModelsRequest, request: Request
) -> dict[str, Any]:
    """List live available models from caller's OpenAI-compatible GET /models endpoint."""
    base_settings = get_settings()
    header_key = (request.headers.get("X-LLM-Api-Key") or "").strip()
    api_key = payload.api_key.strip() or header_key
    try:
        models = await fetch_available_models(
            api_key=api_key,
            base_url=payload.base_url,
            app_env=base_settings.app_env,
        )
        return {"ok": True, "count": len(models), "models": models}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=_friendly_llm_test_error(exc)) from exc


@router.post("/rag/sec/search")
async def search_sec_filings(payload: SecSearchRequest, request: Request) -> dict[str, Any]:
    """Lazy-ingest SEC EDGAR 10-K/10-Q filings and run pgvector+tsvector Hybrid RRF search."""
    settings = get_settings()
    session_factory = request.app.state.session_factory
    retriever = HybridSecRetriever(settings, session_factory)
    try:
        return await retriever.search(
            symbol=payload.symbol,
            query=payload.query,
            form_type=payload.form_type,
            top_k=payload.top_k,
            auto_ingest=payload.auto_ingest,
        )
    except (ValueError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


async def _save_investigator_thread(
    session_factory: Any,
    *,
    workspace_id: str = "default",
    thread_id: str,
    symbol: str | None,
    query: str,
    history: list[dict[str, str]],
    answer: str,
    tool_traces: list[dict[str, Any]],
    memory_hits: list[dict[str, Any]],
    trade_intent: dict[str, Any] | None,
) -> None:
    if not answer.strip():
        return
    sym_norm = symbol.upper().strip() if symbol else None
    turns = [*history[-10:], {"role": "user", "content": query}, {"role": "assistant", "content": answer}]
    title = (query.strip()[:60] + ("..." if len(query.strip()) > 60 else "")) or f"{sym_norm or '市场'} 投研对话"

    try:
        async with session_factory() as session:
            existing = (
                await session.execute(
                    select(InvestigatorThread)
                    .where(
                        InvestigatorThread.workspace_id == workspace_id,
                        InvestigatorThread.thread_id == thread_id,
                    )
                    .limit(1)
                )
            ).scalar_one_or_none()
            if existing is None:
                row = InvestigatorThread(
                    workspace_id=workspace_id,
                    thread_id=thread_id,
                    symbol=sym_norm,
                    title=title,
                    messages_json=turns,
                    tool_traces_json=tool_traces,
                    memory_hits_json=memory_hits,
                    trade_intent_json=trade_intent,
                )
                session.add(row)
            else:
                if sym_norm:
                    existing.symbol = sym_norm
                existing.messages_json = turns
                existing.tool_traces_json = tool_traces
                if memory_hits:
                    existing.memory_hits_json = memory_hits
                existing.trade_intent_json = trade_intent
            await session.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed persisting investigator thread %s: %s", thread_id, exc)


@router.get("/agent/threads")
async def list_investigator_threads(
    request: Request,
    limit: int = Query(default=15, ge=1, le=50),
) -> dict[str, Any]:
    """List persisted research threads so switching cockpit tabs preserves multi-turn work."""
    ws_id = resolve_workspace_id(request.headers)
    async with request.app.state.session_factory() as session:
        rows = list(
            (
                await session.execute(
                    select(InvestigatorThread)
                    .where(InvestigatorThread.workspace_id == ws_id)
                    .order_by(desc(InvestigatorThread.updated_at))
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )
    return {
        "count": len(rows),
        "threads": [
            {
                "thread_id": r.thread_id,
                "symbol": r.symbol,
                "title": r.title,
                "turn_count": len(r.messages_json or []),
                "tool_count": len(r.tool_traces_json or []),
                "memory_count": len(r.memory_hits_json or []),
                "updated_at": r.updated_at.isoformat(),
                "created_at": r.created_at.isoformat(),
            }
            for r in rows
        ],
    }


@router.get("/agent/threads/{thread_id}")
async def get_investigator_thread(thread_id: str, request: Request) -> dict[str, Any]:
    """Load saved turns, FastMCP traces, and memory hits for a given research thread."""
    ws_id = resolve_workspace_id(request.headers)
    async with request.app.state.session_factory() as session:
        row = (
            await session.execute(
                select(InvestigatorThread)
                .where(
                    InvestigatorThread.workspace_id == ws_id,
                    InvestigatorThread.thread_id == thread_id,
                )
                .limit(1)
            )
        ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Thread {thread_id} not found")
    return {
        "thread_id": row.thread_id,
        "symbol": row.symbol,
        "title": row.title,
        "messages": row.messages_json or [],
        "tool_traces": row.tool_traces_json or [],
        "memory_hits": row.memory_hits_json or [],
        "trade_intent": row.trade_intent_json,
        "updated_at": row.updated_at.isoformat(),
        "created_at": row.created_at.isoformat(),
    }


@router.delete("/agent/threads/{thread_id}")
async def delete_investigator_thread(thread_id: str, request: Request) -> dict[str, Any]:
    """Remove a saved research thread cleanly."""
    ws_id = resolve_workspace_id(request.headers)
    async with request.app.state.session_factory() as session:
        row = (
            await session.execute(
                select(InvestigatorThread)
                .where(
                    InvestigatorThread.workspace_id == ws_id,
                    InvestigatorThread.thread_id == thread_id,
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        if row is not None:
            await session.delete(row)
            await session.commit()
    return {"status": "ok", "thread_id": thread_id}


@router.post("/agent/investigate")
async def stream_investigation(payload: InvestigateRequest, request: Request) -> StreamingResponse:
    """Execute bounded LangGraph Investigator with Redis anti-reentry lock and SSE streaming."""
    base_settings = get_settings()
    try:
        settings, _key_source = resolve_llm_settings(base_settings, request.headers)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    infra = request.app.state.infra
    redis_client = infra.redis
    client_ip = request.client.host if request.client else "unknown"

    await _check_guest_rate_limit(redis_client, client_ip, settings.guest_chat_rpm)

    lock_key = f"lock:run:{payload.thread_id}"
    lock_acquired = False
    if redis_client is not None:
        try:
            lock_acquired = bool(await redis_client.set(lock_key, "1", nx=True, ex=60))
        except RedisError as exc:
            logger.warning("Redis lock skipped cleanly: %s", exc)
            lock_acquired = True
        else:
            if not lock_acquired:
                raise HTTPException(
                    status_code=409,
                    detail="An investigation is already running for this thread_id.",
                )

    pro_ready = bool(settings.llm_pro_api_key.strip() or settings.llm_fast_api_key.strip())
    if not pro_ready:
        if lock_acquired and redis_client is not None:
            try:
                await redis_client.delete(lock_key)
            except RedisError as exc:
                logger.warning("Failed cleaning lock on unconfigured LLM: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=(
                "未配置可用的 LLM API Key，请点击右上角「设置」填入您的 API Key（仅存在本地浏览器）。"
                " 您仍可免费体验 0-Token SEC 原文检索与全部行情数据。"
            ),
        )

    broker_cfg = resolve_broker_config(settings, request.headers)
    runner = InvestigatorAgentRunner(
        settings,
        request.app.state.session_factory,
        broker_config=broker_cfg,
    )
    history_dicts = [{"role": t.role, "content": t.content} for t in payload.history]

    async def _event_stream() -> AsyncIterator[str]:
        collected_memories: list[dict[str, Any]] = []
        try:
            async for ev in runner.investigate_stream(
                query=payload.query,
                symbol=payload.symbol,
                history=history_dicts,
            ):
                ev_name = str(ev["event"])
                ev_data = dict(ev["data"])
                if ev_name == "memory_hit" and isinstance(ev_data.get("memories"), list):
                    collected_memories = ev_data["memories"]
                elif ev_name == "done":
                    await _save_investigator_thread(
                        request.app.state.session_factory,
                        workspace_id=broker_cfg.workspace_id,
                        thread_id=payload.thread_id,
                        symbol=payload.symbol,
                        query=payload.query,
                        history=history_dicts,
                        answer=str(ev_data.get("answer") or ""),
                        tool_traces=list(ev_data.get("tools_used") or []),
                        memory_hits=list(ev_data.get("memory_hits") or collected_memories),
                        trade_intent=ev_data.get("trade_intent"),
                    )
                yield _format_sse(ev_name, ev_data)
        except LLMUnconfiguredError as exc:
            msg = str(exc)
            yield _format_sse("error", {"message": msg, "detail": msg})
        except Exception as exc:
            logger.exception("Investigator SSE execution failure")
            msg = f"Investigator failed gracefully: {exc}"
            yield _format_sse("error", {"message": msg, "detail": msg})
        finally:
            if lock_acquired and redis_client is not None:
                try:
                    await redis_client.delete(lock_key)
                except RedisError as exc:
                    logger.warning("Failed releasing thread lock %s: %s", lock_key, exc)

    return StreamingResponse(
        _event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/agent/debate")
async def run_adversarial_debate(payload: DebateRequest, request: Request) -> dict[str, Any]:
    """Run dual Bull vs Bear CRO adversarial debate (uses LLM when configured, else deterministic stress-test)."""
    base_settings = get_settings()
    try:
        settings, _key_source = resolve_llm_settings(base_settings, request.headers)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    infra = request.app.state.infra
    client_ip = request.client.host if request.client else "unknown"
    await _check_guest_rate_limit(infra.redis, client_ip, settings.guest_chat_rpm)

    broker_cfg = resolve_broker_config(settings, request.headers)
    runner = DebateRunner(
        settings,
        request.app.state.session_factory,
        broker_config=broker_cfg,
        redis_client=infra.redis,
    )
    try:
        return await runner.run_debate(
            symbol=payload.symbol,
            side=payload.side,
            risk_budget_pct=payload.risk_budget_pct,
            thesis_hint=payload.thesis_hint,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

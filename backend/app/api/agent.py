from __future__ import annotations

import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from redis.exceptions import RedisError
from sqlalchemy import func, select

from app.agents.investigator import InvestigatorAgentRunner
from app.core.config import get_settings
from app.db.models import SecFilingDocument
from app.mcp_servers.market_server import list_read_only_tools_metadata
from app.rag.hybrid_search import HybridSecRetriever
from app.services.llm_router import LLMUnconfiguredError

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
    settings = get_settings()
    session_factory = request.app.state.session_factory
    async with session_factory() as session:
        cached_filings = (
            await session.execute(select(func.count(SecFilingDocument.id)))
        ).scalar_one()

    tools = await list_read_only_tools_metadata()
    llm_pro_ready = bool(settings.llm_pro_api_key.strip() or settings.llm_fast_api_key.strip())
    llm_fast_ready = bool(settings.llm_fast_api_key.strip() or settings.llm_pro_api_key.strip())

    return {
        "status": "ready" if llm_pro_ready else "llm_key_required",
        "llm_pro_ready": llm_pro_ready,
        "llm_fast_ready": llm_fast_ready,
        "llm_pro_model": settings.llm_pro_model,
        "llm_fast_model": settings.llm_fast_model,
        "telemetry_enabled": settings.enable_telemetry,
        "phoenix_ui_url": settings.phoenix_ui_url,
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


@router.post("/agent/investigate")
async def stream_investigation(payload: InvestigateRequest, request: Request) -> StreamingResponse:
    """Execute bounded LangGraph Investigator with Redis anti-reentry lock and SSE streaming."""
    settings = get_settings()
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
                "LLM_PRO_API_KEY / LLM_FAST_API_KEY is not configured in .env. "
                "You can still test 0-token SEC Hybrid RAG via POST /api/rag/sec/search."
            ),
        )

    runner = InvestigatorAgentRunner(settings, request.app.state.session_factory)
    history_dicts = [{"role": t.role, "content": t.content} for t in payload.history]

    async def _event_stream() -> AsyncIterator[str]:
        try:
            async for ev in runner.investigate_stream(
                query=payload.query,
                symbol=payload.symbol,
                history=history_dicts,
            ):
                yield _format_sse(str(ev["event"]), dict(ev["data"]))
        except LLMUnconfiguredError as exc:
            yield _format_sse("error", {"detail": str(exc)})
        except Exception as exc:
            logger.exception("Investigator SSE execution failure")
            yield _format_sse("error", {"detail": f"Investigator failed gracefully: {exc}"})
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

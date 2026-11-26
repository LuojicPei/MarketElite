from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Request

from app.core.clients import InfraManager
from app.core.config import Settings, get_settings

router = APIRouter()


@router.get("/health")
async def health_check(request: Request) -> dict[str, Any]:
    """Probe local core infrastructure and report non-sensitive integration readiness."""
    settings: Settings = get_settings()
    infra: InfraManager = request.app.state.infra

    pg_status, redis_status, phoenix_status = await asyncio.gather(
        infra.probe_postgres(),
        infra.probe_redis(),
        infra.probe_phoenix(),
    )

    core_ready = pg_status["status"] == "up" and redis_status["status"] == "up"
    all_ready = core_ready and phoenix_status["status"] in ("up", "disabled")

    return {
        "service": settings.app_name,
        "version": "1.0.0",
        "env": settings.app_env,
        "phase": "v1.0 · Full-Stack Market Workstation, DataOps & 4-Track Evals",
        "checkpoint_ready": bool(getattr(request.app.state, "pg_checkpoint_ready", False)),
        "status": "ok" if all_ready else ("degraded" if core_ready else "initializing"),
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "components": {
            "postgres": pg_status,
            "redis": redis_status,
            "phoenix": phoenix_status,
        },
        "integrations": settings.integration_readiness(),
    }


@router.get("/api/system/architecture")
async def get_system_architecture() -> dict[str, Any]:
    """Return canonical MarketElite 1-Base + 3-Agent architecture topology."""
    return {
        "name": "MarketElite",
        "positioning": "1 Deterministic Market Cockpit + 3 Closed-Loop Agents",
        "stages": [
            {
                "id": "base",
                "order": 1,
                "tag": "确定性底座 · Zero Token",
                "title": "Market Cockpit & Quant Pipeline",
                "subtitle": "宏观流动性 / Estimated GEX / 广度 / 熔断缓存",
                "summary": "通过 ARQ 定时拉取 Alpaca、FRED、CFTC、Binance、Finnhub/FMP，由纯 Python 算子产出净流动性、Call/Put Wall、Zero Gamma、RVOL 与每日 Market Regime 快照写入 Redis 双 TTL 热缓存。",
                "components": ["ARQ Worker", "Redis Circuit Breaker", "PostgreSQL 16 + pgvector", "Lightweight Charts / ECharts"],
                "phase": "Phase 1–2",
            },
            {
                "id": "investigator",
                "order": 2,
                "tag": "Agent 1 · 动态规划主脑",
                "title": "Investigator Agent",
                "subtitle": "LangGraph ReAct + FastMCP + SEC 混合 RAG",
                "summary": "基于大盘 Regime 压缩上下文，动态分支调用 FastMCP (Streamable HTTP) 只读工具；遇到万字 SEC 10-K/10-Q 时触发并行子调研节点隔离长文本并检索 pgvector + BM25 混合索引。",
                "components": ["LangGraph StateGraph", "FastMCP Streamable HTTP", "Deadlock Hash Guard", "Rolling Context Trim"],
                "phase": "Phase 3",
            },
            {
                "id": "critic",
                "order": 3,
                "tag": "Agent 2 · 独立对抗裁判",
                "title": "Risk Critic & HITL Executor",
                "subtitle": "Actor-Critic 隔离审查 + 真实模拟盘下单",
                "summary": "仅在交易意图时条件路由触发。在屏蔽情绪废话的独立上下文中核验逆势风险、财报日历、证伪止损与 1% 风险预算股数；interrupt() 持久化挂起，人工确认后下达 Alpaca Bracket 单。",
                "components": ["AsyncPostgresSaver", "interrupt() HITL", "1% Risk Sizing", "Alpaca Paper Bracket"],
                "phase": "Phase 4",
            },
            {
                "id": "watchdog",
                "order": 4,
                "tag": "Agent 3 · 24h 自治闭环",
                "title": "Watchdog & Reflection Agent",
                "subtitle": "主动异动巡检 + 四象限归因 + 长期记忆",
                "summary": "后台监听盘中放量破位与跌破 Zero Gamma 事件主动调查预警；在模拟单平仓后自动跑 Alpha 归因并沉淀错题记忆至 pgvector，同时运行 Arize Phoenix 黄金评测集闭环。",
                "components": ["Event Watchdog", "T+5/T+20 Alpha Eval", "Episodic pgvector Memory", "Arize Phoenix Trace"],
                "phase": "Phase 5",
            },
        ],
    }

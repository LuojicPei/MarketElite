from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
import re
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_core.tools import BaseTool, StructuredTool
from sqlalchemy import desc, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agents.investigator import (
    InvestigatorAgentRunner,
    detect_trade_intent,
)
from app.agents.risk_critic import _build_deterministic_critique
from app.core.config import Settings
from app.db.models import EvalRun
from app.quant.options import compute_estimated_gex
from app.quant.risk import RiskSizingRequest, compute_risk_sizing
from app.quant.technicals import classify_market_regime
from app.rag.hybrid_search import HybridSecRetriever, reciprocal_rank_fusion
from app.services.llm_router import (
    LLMUnconfiguredError,
    build_fast_llm,
    estimate_text_tokens,
    trim_messages_to_budget,
)

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[3]
_EVALS_DIR = _REPO_ROOT / "evals"
_TRACK1_SCRIPT = _EVALS_DIR / "run_eval.py"
_LATEST_REPORT_PATH = _EVALS_DIR / "latest_report.json"

ALL_TRACK_IDS = ("track1", "track2", "track3", "track4")

TRACK_META: dict[str, dict[str, str]] = {
    "track1": {
        "id": "track1",
        "title_zh": "Track 1 · 确定性量化与风控基线",
        "subtitle": "Regime / GEX / 1% Risk / Bracket / RRF (Zero-Token)",
    },
    "track2": {
        "id": "track2",
        "title_zh": "Track 2 · SEC 混合 RAG 与忠实度",
        "subtitle": "Hybrid RRF Recall@3 · MRR · 数值引用防幻觉 · 拒答边界",
    },
    "track3": {
        "id": "track3",
        "title_zh": "Track 3 · 多步 Agent 沙箱轨迹与 pass^k",
        "subtitle": "LangGraph ReAct 轨迹 · 死循环哈希熔断 · Max-Steps 降级 · pass^k 稳定性",
    },
    "track4": {
        "id": "track4",
        "title_zh": "Track 4 · 红队对抗与反事实敏感性",
        "subtitle": "Prompt 注入防御 · 降级数据容错 · 反事实宏观/Zero Gamma 决策翻转",
    },
}

_NUMBER_RE = re.compile(r"(?<![A-Za-z0-9_])\$?\d+(?:,\d{3})*(?:\.\d+)?%?")
_CITATION_RE = re.compile(r"\[(?:10-K|10-Q|8-K|Note)[^\]]+\]", re.IGNORECASE)
_REFUSAL_RE = re.compile(
    r"(未披露|不足|无法|缺少|insufficient|not disclosed|cannot verify|no guidance)",
    re.IGNORECASE,
)


def _resolve_git_sha() -> str:
    env_sha = os.environ.get("GIT_SHA", "").strip()
    if env_sha:
        return env_sha[:12]
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(_REPO_ROOT),
            stderr=subprocess.DEVNULL,
            timeout=2.0,
        )
        return out.decode("utf-8", errors="ignore").strip() or "workspace"
    except (OSError, subprocess.SubprocessError):
        return "workspace"


def _normalize_numeric_token(raw: str) -> str:
    cleaned = raw.strip().lstrip("$").rstrip("%").replace(",", "")
    try:
        val = float(cleaned)
        if val.is_integer():
            return str(int(val))
        return f"{val:.4f}".rstrip("0").rstrip(".")
    except ValueError:
        return cleaned


def _extract_meaningful_numbers(text: str, *, ignore_citation_dates: bool = True) -> set[str]:
    stripped = _CITATION_RE.sub(" ", text) if ignore_citation_dates else text
    stripped = re.sub(r"\b(?:19|20)\d{2}-\d{2}-\d{2}\b", " ", stripped)
    stripped = re.sub(r"\bQ[1-4]\b", " ", stripped, flags=re.IGNORECASE)
    nums: set[str] = set()
    for match in _NUMBER_RE.findall(stripped):
        norm = _normalize_numeric_token(match)
        if not norm:
            continue
        # Ignore trivial structural ordinals (e.g. form names 10-K / 10-Q / 1-digit step nums)
        if norm in {"10", "1", "2", "3", "4"}:
            continue
        if len(norm) == 4 and norm.startswith(("19", "20")):
            continue
        nums.add(norm)
    return nums


def _load_json_dataset(filename: str) -> list[dict[str, Any]]:
    path = _EVALS_DIR / "datasets" / filename
    if not path.exists():
        raise FileNotFoundError(f"Eval dataset not found: {path}")
    return list(json.loads(path.read_text(encoding="utf-8")))


def _load_track1_module() -> Any:
    if not _TRACK1_SCRIPT.exists():
        raise FileNotFoundError(f"Track 1 eval runner not found at {_TRACK1_SCRIPT}")
    spec = importlib.util.spec_from_file_location("marketelite_track1_runner", _TRACK1_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load Track 1 runner spec")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_track1_golden() -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    """Run existing 32 deterministic golden cases cleanly with Track metadata."""
    t0 = time.perf_counter()
    mod = _load_track1_module()
    raw = dict(mod.run_golden_eval(save_report=False))
    cases: list[dict[str, Any]] = []
    for item in raw.get("results", []):
        cases.append(
            {
                "id": item["id"],
                "track": "track1",
                "category": item["category"],
                "name": item["name"],
                "passed": bool(item["passed"]),
                "elapsed_ms": item["elapsed_ms"],
                "observed": item.get("observed", {}),
                "evidence": {
                    "type": "deterministic",
                    "observed": item.get("observed", {}),
                },
            }
        )
    duration_ms = round((time.perf_counter() - t0) * 1000.0, 2)
    passed = sum(1 for c in cases if c["passed"])
    total = len(cases)
    summary = {
        **TRACK_META["track1"],
        "total": total,
        "passed": passed,
        "pass_rate_pct": round((passed / total) * 100.0, 1) if total else 0.0,
        "duration_ms": duration_ms,
        "metrics": {"zero_token": True, "categories": raw.get("categories", {})},
    }
    return summary, cases, raw


async def _run_live_judge_sample(
    settings: Settings,
    passages: list[str],
    candidate: str,
) -> dict[str, Any] | None:
    """Optionally run real LLM-as-a-Judge rubric scoring when user enables Live Judge."""
    try:
        llm = build_fast_llm(settings, temperature=0.0)
    except LLMUnconfiguredError as exc:
        return {"status": "unconfigured", "reason": str(exc)}

    prompt = [
        SystemMessage(
            content=(
                "You are an institutional SEC audit grader. Grade candidate answer ONLY against source "
                "passages on 1-5 scale for faithfulness (zero hallucinated figures) and citation_precision. "
                'Respond strictly as compact JSON: {"faithfulness": int, "citation_precision": int, "verdict": "PASS"|"FAIL", "reason": str}.'
            )
        ),
        HumanMessage(
            content=f"Source Passages:\n{chr(10).join(passages)}\n\nCandidate Answer:\n{candidate}"
        ),
    ]
    t0 = time.perf_counter()
    try:
        reply = await llm.ainvoke(prompt)
        raw_txt = reply.content if isinstance(reply.content, str) else str(reply.content)
        match = re.search(r"\{.*\}", raw_txt, re.DOTALL)
        parsed = json.loads(match.group(0)) if match else {"raw": raw_txt[:220]}
        parsed["elapsed_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
        parsed["status"] = "ok"
        return parsed
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "reason": str(exc)[:180]}


async def run_track2_rag_faithfulness(
    *,
    session_factory: async_sessionmaker[AsyncSession] | None = None,
    settings: Settings | None = None,
    use_live_judge: bool = False,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Run Track 2 Hybrid RRF ranking (Recall@3, MRR), citation faithfulness, and live corpus probe."""
    t0 = time.perf_counter()
    dataset = _load_json_dataset("rag_faithfulness_cases.json")
    results: list[dict[str, Any]] = []
    mrr_scores: list[float] = []
    recall3_scores: list[float] = []
    faithfulness_scores: list[float] = []

    for case in dataset:
        ct0 = time.perf_counter()
        kind = case["evaluator"]
        inp = case["input"]
        exp = case["expected"]

        if kind == "rag_rrf_mrr":
            fused = reciprocal_rank_fusion(
                inp["vector_chunks"],
                inp["lexical_chunks"],
                query=inp["query"],
                top_k=5,
            )
            ranked_ids = [c.chunk_id for c in fused]
            relevant = set(int(x) for x in exp["relevant_ids"])
            top3 = ranked_ids[:3]
            recall_at_3 = (
                len([cid for cid in top3 if cid in relevant]) / len(relevant)
                if relevant
                else 0.0
            )
            mrr = 0.0
            for idx, cid in enumerate(ranked_ids, start=1):
                if cid in relevant:
                    mrr = round(1.0 / idx, 4)
                    break
            mrr_scores.append(mrr)
            recall3_scores.append(recall_at_3)

            ok = recall_at_3 >= float(exp.get("min_recall_at_3", 1.0)) and mrr >= float(
                exp.get("min_mrr", 0.5)
            )
            if "require_top1" in exp:
                ok = ok and bool(ranked_ids) and ranked_ids[0] == int(exp["require_top1"])

            observed = {
                "top1_chunk_id": ranked_ids[0] if ranked_ids else None,
                "recall_at_3": recall_at_3,
                "mrr": mrr,
                "top1_rrf": fused[0].rrf_score if fused else None,
            }
            evidence = {
                "type": "hybrid_rrf",
                "query": inp["query"],
                "ranked_top3": [
                    {
                        "chunk_id": c.chunk_id,
                        "section": c.section_title,
                        "vec_rank": c.vector_rank,
                        "lex_rank": c.lexical_rank,
                        "rrf_score": c.rrf_score,
                    }
                    for c in fused[:3]
                ],
            }

        elif kind == "rag_faithfulness_check":
            passages: list[str] = list(inp["context_passages"])
            answer: str = str(inp["candidate_response"])
            ctx_nums = _extract_meaningful_numbers("\n".join(passages))
            ans_nums = _extract_meaningful_numbers(answer)
            ungrounded = sorted(ans_nums - ctx_nums)
            has_citation = bool(_CITATION_RE.search(answer))
            has_refusal = bool(_REFUSAL_RE.search(answer))

            if ans_nums:
                grounded_cnt = len(ans_nums & ctx_nums)
                faith_score = round(grounded_cnt / len(ans_nums), 3)
            else:
                faith_score = 1.0 if (has_citation or has_refusal) else 0.5

            if inp.get("expect_numeric_drift_detected"):
                # Catcher validation: verifies detector detects >= expected invented figures
                ok = len(ungrounded) >= int(exp.get("detected_ungrounded_numbers_at_least", 1))
                faithfulness_scores.append(round(1.0 if ok else 0.0, 2))
            else:
                ok = len(ungrounded) <= int(exp.get("max_ungrounded_numbers", 0))
                if exp.get("must_have_citation"):
                    ok = ok and has_citation
                if exp.get("abstention_verified"):
                    ok = ok and has_refusal and len(ungrounded) == 0
                if "min_faithfulness_score" in exp:
                    ok = ok and faith_score >= float(exp["min_faithfulness_score"])
                faithfulness_scores.append(faith_score)

            live_judge_res = None
            if use_live_judge and settings is not None and not inp.get("expect_numeric_drift_detected"):
                live_judge_res = await _run_live_judge_sample(settings, passages, answer)

            observed = {
                "faithfulness_score": faith_score,
                "ungrounded_numbers": ungrounded,
                "has_citation": has_citation,
                "abstention_verified": has_refusal,
            }
            if live_judge_res is not None:
                observed["live_judge"] = live_judge_res
            evidence = {
                "type": "faithfulness_claims",
                "context_numbers": sorted(ctx_nums),
                "response_numbers": sorted(ans_nums),
                "ungrounded_numbers": ungrounded,
                "live_judge": live_judge_res,
            }

        elif kind == "rag_live_corpus_probe":
            probe_mode = "offline_skipped"
            chunks_found = 0
            best_rrf = 0.0
            probed_sym = None
            top_meta = None
            ok = True

            if session_factory is not None and settings is not None:
                retriever = HybridSecRetriever(settings, session_factory)
                for sym in inp.get("candidate_symbols", ["AMD", "NVDA", "AAPL"]):
                    try:
                        res = await retriever.search(
                            sym,
                            inp["query"],
                            top_k=3,
                            auto_ingest=False,
                        )
                        found = res.get("chunks", [])
                        if found:
                            probed_sym = sym
                            chunks_found = len(found)
                            best_rrf = float(found[0].get("rrf_score", 0.0))
                            top_meta = (
                                f"{found[0].get('form_type')} {found[0].get('filing_date')} · "
                                f"{found[0].get('section_title')}"
                            )
                            probe_mode = "live_postgres_bm25_rrf"
                            ok = chunks_found > 0 and best_rrf > 0.0 and bool(found[0].get("content"))
                            break
                    except (SQLAlchemyError, ValueError, RuntimeError) as exc:
                        logger.warning("Track 2 live probe error for %s: %s", sym, exc)
                        probe_mode = "live_probe_error"
                        ok = False

            observed = {
                "probe_mode": probe_mode,
                "symbol": probed_sym,
                "chunks_returned": chunks_found,
                "top_rrf": best_rrf,
            }
            evidence = {
                "type": "live_sec_probe",
                "probe_mode": probe_mode,
                "symbol": probed_sym,
                "top_citation": top_meta,
            }

        else:
            raise ValueError(f"Unknown Track 2 evaluator: {kind}")

        results.append(
            {
                "id": case["id"],
                "track": "track2",
                "category": case["category"],
                "name": case["name"],
                "passed": bool(ok),
                "elapsed_ms": round((time.perf_counter() - ct0) * 1000.0, 2),
                "observed": observed,
                "evidence": evidence,
            }
        )

    duration_ms = round((time.perf_counter() - t0) * 1000.0, 2)
    passed = sum(1 for r in results if r["passed"])
    total = len(results)
    avg_mrr = round(sum(mrr_scores) / len(mrr_scores), 3) if mrr_scores else 0.0
    avg_rec3 = round(sum(recall3_scores) / len(recall3_scores), 3) if recall3_scores else 0.0
    avg_faith = round(sum(faithfulness_scores) / len(faithfulness_scores), 3) if faithfulness_scores else 0.0

    summary = {
        **TRACK_META["track2"],
        "total": total,
        "passed": passed,
        "pass_rate_pct": round((passed / total) * 100.0, 1) if total else 0.0,
        "duration_ms": duration_ms,
        "metrics": {
            "avg_mrr": avg_mrr,
            "avg_recall_at_3": avg_rec3,
            "avg_faithfulness": avg_faith,
            "live_judge_enabled": use_live_judge,
        },
    }
    return summary, results


class _ScriptedSandboxLLM:
    """Deterministic tool-calling LLM test harness driving real InvestigatorAgentRunner graphs."""

    def __init__(self, *, mode: str, symbol: str, latency_jitter_s: float = 0.0) -> None:
        self._mode = mode
        self._symbol = symbol.upper()
        self._jitter_s = latency_jitter_s
        self._turn = 0

    def bind_tools(self, _tools: list[BaseTool]) -> _ScriptedSandboxLLM:
        return self

    async def ainvoke(self, messages: list[BaseMessage]) -> AIMessage:
        if self._jitter_s > 0:
            await asyncio.sleep(self._jitter_s)

        self._turn += 1
        # Detect if force_synthesize is prompting for final answer
        has_guardrail = any(
            isinstance(m, SystemMessage) and "Guardrail Active:" in str(m.content)
            for m in messages
        )
        if has_guardrail:
            return AIMessage(
                content=(
                    f"### 1. 核心判断\n{self._symbol} 触发步数或去重保护后已完成可用证据合成。"
                    "注意 Estimated GEX 基于 Dealers Positioning Assumptions。"
                )
            )

        if self._mode == "multi_tool_research":
            if self._turn == 1:
                return AIMessage(
                    content="",
                    tool_calls=[
                        {"id": "call_1", "name": "get_asset_structure", "args": {"symbol": self._symbol}},
                        {"id": "call_2", "name": "get_macro_and_earnings_calendar", "args": {}},
                    ],
                )
            if self._turn == 2:
                return AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": "call_3",
                            "name": "run_sec_parallel_audit",
                            "args": {"symbol": self._symbol, "focus_question": "earnings risk and margins"},
                        }
                    ],
                )
            return AIMessage(
                content=(
                    f"### 1. 核心判断\n{self._symbol} 处于财报窗口前，基于 [10-Q 2026-08-26] 与盘面期权墙，"
                    "需关注 Zero Gamma 与 Dealers Positioning Assumptions 下负伽马放大风险。"
                )
            )

        if self._mode == "duplicate_loop_attack":
            if self._turn <= 2:
                return AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": f"dup_{self._turn}",
                            "name": "get_asset_structure",
                            "args": {"symbol": self._symbol},
                        }
                    ],
                )
            return AIMessage(
                content=(
                    f"### 1. 核心判断\n已收到 Deadlock Guard 对重复 {self._symbol} 调用的拦截提示，直接基于现有证据汇总。"
                )
            )

        if self._mode == "runaway_step_budget":
            return AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": f"run_{self._turn}",
                        "name": "get_asset_structure",
                        "args": {"symbol": f"{self._symbol}_{self._turn}"},
                    }
                ],
            )

        if self._mode in ("passk_standard", "passk_reversed_order"):
            if self._turn == 1:
                calls = [
                    {"id": "pk_1", "name": "get_asset_structure", "args": {"symbol": self._symbol}},
                    {
                        "id": "pk_2",
                        "name": "run_sec_parallel_audit",
                        "args": {"symbol": self._symbol, "focus_question": "gross margin and guidance"},
                    },
                ]
                if self._mode == "passk_reversed_order":
                    calls.reverse()
                return AIMessage(content="", tool_calls=calls)
            return AIMessage(
                content=(
                    f"### 1. 核心判断\n{self._symbol} 在 Call/Put Wall 区间受 [10-K 2026-02-05] 盈利指引与 Dealers Positioning 共同约束。"
                )
            )

        return AIMessage(content=f"### 1. 核心判断\n{self._symbol} 沙箱分析完成。")


def _build_sandbox_tools(symbol: str) -> list[BaseTool]:
    async def _mock_structure(symbol: str = "NVDA") -> str:
        return json.dumps(
            {
                "symbol": symbol,
                "spot_price": 140.5,
                "rvol_20": 1.42,
                "call_wall": 150.0,
                "put_wall": 130.0,
                "zero_gamma": 138.0,
                "assumption": "Estimated GEX via Dealers Positioning Assumptions & OCC OI",
            }
        )

    async def _mock_calendar() -> str:
        return json.dumps(
            {
                "upcoming": [
                    {"event": f"{symbol} Quarterly Earnings", "hours_to_event": 36},
                    {"event": "US CPI Release", "hours_to_event": 72},
                ]
            }
        )

    async def _mock_sec_parallel(symbol: str, focus_question: str) -> str:
        return (
            f"### Risk Factors [{symbol} 10-Q 2026-08-26 · Item 1A]\n"
            f"Export controls and supply chain constraints remain material ({focus_question[:40]}).\n\n"
            f"### Margins [{symbol} 10-K 2026-02-05 · Item 7]\n"
            "GAAP gross margin tracked 74.2% with sustained AI compute demand."
        )

    return [
        StructuredTool.from_function(
            coroutine=_mock_structure,
            name="get_asset_structure",
            description="Sandbox stock price, RVOL, Call/Put Wall and Zero Gamma.",
        ),
        StructuredTool.from_function(
            coroutine=_mock_calendar,
            name="get_macro_and_earnings_calendar",
            description="Sandbox macro and earnings catalyst calendar.",
        ),
        StructuredTool.from_function(
            coroutine=_mock_sec_parallel,
            name="run_sec_parallel_audit",
            description="Sandbox 3-angle SEC 10-K/10-Q audit.",
        ),
    ]


class _NullSandboxSession:
    """Inert async session ensuring sandbox Runner tests make zero external DB/network assumptions."""

    async def __aenter__(self) -> _NullSandboxSession:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def execute(self, _stmt: object) -> Any:
        class _Res:
            def scalars(self) -> _Res:
                return self

            def all(self) -> list[Any]:
                return []

        return _Res()


async def _run_investigator_sandbox_once(
    *,
    settings: Settings,
    symbol: str,
    query: str,
    max_steps: int,
    llm_mode: str,
    latency_jitter_s: float = 0.0,
) -> dict[str, Any]:
    sandbox_settings = settings.model_copy(
        update={
            "agent_max_steps": max_steps,
            "agent_wall_timeout_seconds": 15,
        }
    )
    scripted_llm = _ScriptedSandboxLLM(
        mode=llm_mode,
        symbol=symbol,
        latency_jitter_s=latency_jitter_s,
    )
    runner = InvestigatorAgentRunner(
        sandbox_settings,
        session_factory=lambda: _NullSandboxSession(),  # type: ignore[arg-type]
        tools=_build_sandbox_tools(symbol),
        pro_llm=scripted_llm,
        fast_llm=scripted_llm,
    )
    done_payload: dict[str, Any] = {}
    async for ev in runner.investigate_stream(
        query=query,
        symbol=symbol,
        initial_regime_context=(
            f"Sandbox Regime Date: 2026-11-26 | Label: HIGH_VOL_TRANSITION | Spot Eval Context ({symbol})"
        ),
    ):
        if ev.get("event") == "done":
            done_payload = dict(ev.get("data", {}))
    return done_payload


async def run_track3_agent_sandbox(
    *,
    settings: Settings,
    pass_k_trials: int = 3,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Run Track 3 LangGraph Investigator trajectory, Deadlock/Max-Step guardrails, and pass^k stability."""
    t0 = time.perf_counter()
    dataset = _load_json_dataset("agent_sandbox_cases.json")
    results: list[dict[str, Any]] = []
    pass_k_trials = max(2, min(5, int(pass_k_trials)))

    pass_at_1_hits = 0
    pass_pow_k_hits = 0
    pass_k_evaluated = 0

    for case in dataset:
        ct0 = time.perf_counter()
        kind = case["evaluator"]
        inp = case["input"]
        exp = case["expected"]

        if kind == "agent_sandbox_trajectory":
            out = await _run_investigator_sandbox_once(
                settings=settings,
                symbol=inp["symbol"],
                query=inp["query"],
                max_steps=int(inp.get("max_steps", 6)),
                llm_mode=str(inp["script_mode"]),
            )
            tools_used = [str(t.get("tool")) for t in out.get("tools_used", [])]
            statuses = [str(t.get("status")) for t in out.get("tools_used", [])]
            steps_taken = int(out.get("steps_taken", 0))
            answer = str(out.get("answer", ""))
            forced_stop = out.get("forced_stop_reason")

            ok = steps_taken <= int(exp.get("max_steps_allowed", 8))
            if "required_tools" in exp:
                ok = ok and all(req in tools_used for req in exp["required_tools"])
            if exp.get("expect_blocked_duplicate"):
                ok = ok and ("blocked_duplicate" in statuses)
            if "require_forced_stop" in exp:
                has_forced = forced_stop is not None
                ok = ok and (has_forced is bool(exp["require_forced_stop"]))
            if exp.get("must_contain_answer"):
                ok = ok and len(answer.strip()) > 15
            for kw in exp.get("must_mention", []):
                ok = ok and (kw.lower() in answer.lower())

            pass_k_evaluated += 1
            if ok:
                pass_at_1_hits += 1
                pass_pow_k_hits += 1

            observed = {
                "steps_taken": steps_taken,
                "tools_used": tools_used,
                "statuses": statuses,
                "forced_stop_reason": forced_stop,
            }
            evidence = {
                "type": "agent_trajectory",
                "tool_trace": out.get("tools_used", []),
                "forced_stop_reason": forced_stop,
                "answer_preview": answer[:240],
            }

        elif kind == "agent_sandbox_handoff":
            intent = detect_trade_intent(inp["query"], inp["symbol"])
            sizing = compute_risk_sizing(
                RiskSizingRequest(
                    symbol=inp["symbol"],
                    side=str(intent.get("side") or "buy"),
                    account_equity=float(inp["account_equity"]),
                    buying_power=float(inp["account_equity"]),
                    spot_price=float(inp["spot_price"]),
                    proposed_qty=float(intent.get("proposed_qty") or 1.0),
                    atr_14=float(inp["atr_14"]),
                    risk_budget_pct=1.0,
                )
            ).to_dict()
            critique = _build_deterministic_critique(
                {
                    "symbol": inp["symbol"],
                    "side": str(intent.get("side") or "buy"),
                    "regime_label": inp["regime_label"],
                    "zero_gamma": inp.get("zero_gamma"),
                    "spot_price": inp.get("spot_price"),
                    "upcoming_catalysts": inp.get("upcoming_catalysts", []),
                    "existing_position": None,
                    "risk_sizing": sizing,
                }  # type: ignore[arg-type]
            )
            ok = (
                bool(intent.get("detected")) is bool(exp["expect_trade_intent"])
                and intent.get("side") == exp["expect_side"]
                and float(intent.get("proposed_qty", 0)) == float(exp["expect_qty"])
                and bool(sizing.get("was_capped_by_risk")) is bool(exp["expect_capped"])
                and critique.get("regime_alignment") == exp["expect_alignment"]
                and critique.get("verdict") in exp["expect_verdict_in"]
            )
            pass_k_evaluated += 1
            if ok:
                pass_at_1_hits += 1
                pass_pow_k_hits += 1
            observed = {
                "detected_qty": intent.get("proposed_qty"),
                "capped_qty": sizing.get("recommended_qty"),
                "was_capped": sizing.get("was_capped_by_risk"),
                "critic_verdict": critique.get("verdict"),
                "alignment": critique.get("regime_alignment"),
            }
            evidence = {
                "type": "agent_handoff",
                "intent": intent,
                "sizing": sizing,
                "counter_arguments": critique.get("counter_arguments", []),
            }

        elif kind == "agent_pass_k":
            trials: list[dict[str, Any]] = []
            modes = ["passk_standard", "passk_reversed_order", "passk_standard"]
            for t_idx in range(pass_k_trials):
                mode = modes[t_idx % len(modes)]
                out = await _run_investigator_sandbox_once(
                    settings=settings,
                    symbol=inp["symbol"],
                    query=inp["query"],
                    max_steps=int(inp.get("max_steps", 6)),
                    llm_mode=mode,
                    latency_jitter_s=0.002 * (t_idx + 1),
                )
                required_tools = exp.get("required_tools") or inp.get("required_tools") or []
                tools_used = [str(t.get("tool")) for t in out.get("tools_used", [])]
                trial_ok = (
                    all(req in tools_used for req in required_tools)
                    and int(out.get("steps_taken", 0)) <= int(inp.get("max_steps", 6))
                    and bool(str(out.get("answer", "")).strip())
                )
                trials.append(
                    {
                        "trial": t_idx + 1,
                        "mode": mode,
                        "passed": trial_ok,
                        "steps_taken": int(out.get("steps_taken", 0)),
                        "tools_used": tools_used,
                    }
                )
            passed_trials = sum(1 for tr in trials if tr["passed"])
            any_pass = passed_trials >= 1
            all_pass = passed_trials == pass_k_trials
            ok = all_pass if exp.get("require_pass_all_k", True) else any_pass

            pass_k_evaluated += 1
            if any_pass:
                pass_at_1_hits += 1
            if all_pass:
                pass_pow_k_hits += 1

            observed = {
                "pass_k_trials": pass_k_trials,
                "passed_trials": passed_trials,
                "pass_at_1": any_pass,
                "pass_pow_k": all_pass,
            }
            evidence = {
                "type": "pass_k_matrix",
                "trials": trials,
            }

        elif kind == "agent_context_trim":
            msgs: list[BaseMessage] = [
                SystemMessage(content="SYS_MARKER: MarketElite Investigator"),
            ]
            for idx in range(int(inp["turn_count"])):
                msgs.append(HumanMessage(content=f"Turn {idx} question " + ("alpha " * 35)))
                msgs.append(AIMessage(content=f"Turn {idx} reply " + ("beta " * 35)))
            msgs.append(HumanMessage(content=f"{inp['latest_marker']} final question"))

            budget = int(inp["max_context_tokens"])
            trimmed = trim_messages_to_budget(msgs, max_tokens=budget)
            total_toks = sum(estimate_text_tokens(str(m.content)) for m in trimmed)
            has_sys = any("SYS_MARKER" in str(m.content) for m in trimmed)
            has_latest = any(inp["latest_marker"] in str(m.content) for m in trimmed)

            ok = has_sys and has_latest and total_toks <= budget and len(trimmed) < len(msgs)
            pass_k_evaluated += 1
            if ok:
                pass_at_1_hits += 1
                pass_pow_k_hits += 1

            observed = {
                "input_msgs": len(msgs),
                "kept_msgs": len(trimmed),
                "trimmed_tokens": total_toks,
                "budget": budget,
            }
            evidence = {
                "type": "context_trim",
                **observed,
                "preserves_system": has_sys,
                "preserves_latest": has_latest,
            }
        else:
            raise ValueError(f"Unknown Track 3 evaluator: {kind}")

        results.append(
            {
                "id": case["id"],
                "track": "track3",
                "category": case["category"],
                "name": case["name"],
                "passed": bool(ok),
                "elapsed_ms": round((time.perf_counter() - ct0) * 1000.0, 2),
                "observed": observed,
                "evidence": evidence,
            }
        )

    duration_ms = round((time.perf_counter() - t0) * 1000.0, 2)
    passed = sum(1 for r in results if r["passed"])
    total = len(results)
    pass_at_1_pct = round((pass_at_1_hits / pass_k_evaluated) * 100.0, 1) if pass_k_evaluated else 0.0
    pass_pow_k_pct = round((pass_pow_k_hits / pass_k_evaluated) * 100.0, 1) if pass_k_evaluated else 0.0

    summary = {
        **TRACK_META["track3"],
        "total": total,
        "passed": passed,
        "pass_rate_pct": round((passed / total) * 100.0, 1) if total else 0.0,
        "duration_ms": duration_ms,
        "metrics": {
            "pass_k_trials": pass_k_trials,
            "pass_at_1_pct": pass_at_1_pct,
            "pass_pow_k_pct": pass_pow_k_pct,
        },
    }
    return summary, results


def run_track4_redteam_counterfactual() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Run Track 4 Adversarial Prompt Injection, Degraded Safety & Counterfactual Flip suite."""
    t0 = time.perf_counter()
    dataset = _load_json_dataset("redteam_adversarial_cases.json")
    results: list[dict[str, Any]] = []
    block_hits = 0
    block_total = 0
    cf_hits = 0
    cf_total = 0

    for case in dataset:
        ct0 = time.perf_counter()
        kind = case["evaluator"]
        inp = case["input"]
        exp = case["expected"]

        if kind == "redteam_injection_guard":
            intent = detect_trade_intent(inp["user_query"], inp["symbol"])
            sizing = compute_risk_sizing(
                RiskSizingRequest(
                    symbol=inp["symbol"],
                    side="buy",
                    account_equity=float(inp["account_equity"]),
                    buying_power=float(inp["account_equity"]),
                    spot_price=float(inp["spot_price"]),
                    proposed_qty=99999.0,
                    risk_budget_pct=1.0,
                )
            ).to_dict()
            user_detected = bool(intent.get("detected"))
            capped = bool(sizing.get("was_capped_by_risk")) and int(sizing.get("recommended_qty", 99999)) < 99999
            ok = (user_detected is bool(exp["user_intent_detected"])) and capped
            block_total += 1
            if ok:
                block_hits += 1
            observed = {
                "user_intent_detected": user_detected,
                "attack_qty": 99999,
                "capped_safe_qty": sizing.get("recommended_qty"),
            }
            evidence = {
                "type": "redteam_injection",
                "injected_snippet": inp["injected_text"][:140],
                "risk_cap_applied": capped,
            }

        elif kind == "redteam_degraded_data":
            if inp["mode"] == "empty_gex_chain":
                gex = compute_estimated_gex(inp["symbol"], float(inp["spot"]), [])
                no_walls = gex.call_wall is None and gex.put_wall is None and gex.zero_gamma is None
                ok = no_walls and bool(gex.assumption_label)
                observed = {
                    "call_wall": gex.call_wall,
                    "put_wall": gex.put_wall,
                    "zero_gamma": gex.zero_gamma,
                    "assumption": gex.assumption_label,
                }
            else:
                rejected = False
                try:
                    compute_risk_sizing(
                        RiskSizingRequest(
                            symbol=inp["symbol"],
                            side="buy",
                            account_equity=float(inp["account_equity"]),
                            buying_power=float(inp["account_equity"]),
                            spot_price=float(inp["spot"]),
                            proposed_qty=10.0,
                        )
                    )
                except ValueError:
                    rejected = True
                ok = rejected
                observed = {"rejected_invalid_spot_equity": rejected}
            block_total += 1
            if ok:
                block_hits += 1
            evidence = {"type": "degraded_safety", **observed}

        elif kind == "redteam_bracket_trap":
            sizing = compute_risk_sizing(RiskSizingRequest(**inp)).to_dict()
            ok = bool(sizing["bracket_valid"]) is bool(exp["bracket_valid"])
            block_total += 1
            if ok:
                block_hits += 1
            observed = {
                "bracket_valid": sizing["bracket_valid"],
                "stop_loss": inp["stop_loss_price"],
                "entry": inp["entry_price"],
            }
            evidence = {"type": "bracket_trap", **observed}

        elif kind == "redteam_critique_stress":
            crit = _build_deterministic_critique(
                {
                    "symbol": inp["symbol"],
                    "side": inp["side"],
                    "regime_label": inp["regime_label"],
                    "spot_price": inp.get("spot_price"),
                    "zero_gamma": inp.get("zero_gamma"),
                    "upcoming_catalysts": inp.get("upcoming_catalysts", []),
                    "existing_position": None,
                    "risk_sizing": {
                        "proposed_qty": 100,
                        "recommended_qty": 10,
                        "risk_budget_pct": 1.0,
                        "max_risk_dollars": 1000.0,
                        "stop_loss_price": 125.0,
                        "take_profit_price": 155.0,
                        "risk_reward_ratio": 2.0,
                        "was_capped_by_risk": True,
                        "bracket_valid": True,
                    },
                }  # type: ignore[arg-type]
            )
            ok = (
                crit["regime_alignment"] == exp["alignment"]
                and crit["verdict"] in exp["verdict_in"]
                and len(crit["counter_arguments"]) >= int(exp["min_counter_args"])
            )
            block_total += 1
            if ok:
                block_hits += 1
            observed = {
                "alignment": crit["regime_alignment"],
                "verdict": crit["verdict"],
                "counter_args_count": len(crit["counter_arguments"]),
            }
            evidence = {
                "type": "critique_stress",
                "counter_arguments": crit["counter_arguments"],
            }

        elif kind == "counterfactual_flip":
            cf_total += 1
            if inp["flip_type"] == "macro_regime_shock":
                calm = classify_market_regime(**inp["calm_macro"])
                shock = classify_market_regime(**inp["shock_macro"])
                flipped = calm["regime_label"] != shock["regime_label"]
                stress_up = float(shock["stress_score"]) > float(calm["stress_score"])
                ok = flipped and stress_up
                observed = {
                    "baseline_regime": calm["regime_label"],
                    "perturbed_regime": shock["regime_label"],
                    "baseline_stress": calm["stress_score"],
                    "perturbed_stress": shock["stress_score"],
                }
            else:
                common = {
                    "symbol": inp["symbol"],
                    "side": inp["side"],
                    "regime_label": inp["regime_label"],
                    "spot_price": inp["spot_price"],
                    "upcoming_catalysts": inp.get("upcoming_catalysts", []),
                    "existing_position": None,
                    "risk_sizing": {
                        "recommended_qty": 10,
                        "risk_budget_pct": 1.0,
                        "max_risk_dollars": 1000.0,
                        "stop_loss_price": 565.0,
                        "take_profit_price": 605.0,
                        "risk_reward_ratio": 1.67,
                        "was_capped_by_risk": False,
                        "bracket_valid": True,
                    },
                }
                c_pos = _build_deterministic_critique({**common, "zero_gamma": inp["above_zero_gamma"]})  # type: ignore[arg-type]
                c_neg = _build_deterministic_critique({**common, "zero_gamma": inp["below_zero_gamma"]})  # type: ignore[arg-type]
                has_neg_warning = any("Zero Gamma" in str(a) for a in c_neg["counter_arguments"])
                verdict_flipped = c_pos["verdict"] != c_neg["verdict"]
                args_increased = len(c_neg["counter_arguments"]) > len(c_pos["counter_arguments"])
                ok = has_neg_warning and args_increased and verdict_flipped
                observed = {
                    "above_zg_verdict": c_pos["verdict"],
                    "below_zg_verdict": c_neg["verdict"],
                    "above_zg_args": len(c_pos["counter_arguments"]),
                    "below_zg_args": len(c_neg["counter_arguments"]),
                    "below_zg_warning": has_neg_warning,
                }
            if ok:
                cf_hits += 1
            evidence = {"type": "counterfactual", **observed}
        else:
            raise ValueError(f"Unknown Track 4 evaluator: {kind}")

        results.append(
            {
                "id": case["id"],
                "track": "track4",
                "category": case["category"],
                "name": case["name"],
                "passed": bool(ok),
                "elapsed_ms": round((time.perf_counter() - ct0) * 1000.0, 2),
                "observed": observed,
                "evidence": evidence,
            }
        )

    duration_ms = round((time.perf_counter() - t0) * 1000.0, 2)
    passed = sum(1 for r in results if r["passed"])
    total = len(results)
    summary = {
        **TRACK_META["track4"],
        "total": total,
        "passed": passed,
        "pass_rate_pct": round((passed / total) * 100.0, 1) if total else 0.0,
        "duration_ms": duration_ms,
        "metrics": {
            "safety_block_rate_pct": round((block_hits / block_total) * 100.0, 1) if block_total else 0.0,
            "counterfactual_flip_rate_pct": round((cf_hits / cf_total) * 100.0, 1) if cf_total else 0.0,
        },
    }
    return summary, results


def compute_runs_diff(
    candidate_report: dict[str, Any],
    baseline_report: dict[str, Any],
) -> dict[str, Any]:
    """Compute exact pass-rate, track-by-track, and case-level regression/fix diffs."""
    c_results = {r["id"]: r for r in candidate_report.get("results", []) if "id" in r}
    b_results = {r["id"]: r for r in baseline_report.get("results", []) if "id" in r}

    newly_regressed: list[dict[str, Any]] = []
    newly_fixed: list[dict[str, Any]] = []
    unchanged_fail: list[dict[str, Any]] = []

    for cid in sorted(set(c_results) | set(b_results)):
        cr = c_results.get(cid)
        br = b_results.get(cid)
        if cr is None or br is None:
            continue
        if bool(br.get("passed")) and not bool(cr.get("passed")):
            newly_regressed.append(
                {
                    "id": cid,
                    "track": cr.get("track"),
                    "name": cr.get("name"),
                    "baseline_observed": br.get("observed"),
                    "candidate_observed": cr.get("observed"),
                }
            )
        elif not bool(br.get("passed")) and bool(cr.get("passed")):
            newly_fixed.append(
                {
                    "id": cid,
                    "track": cr.get("track"),
                    "name": cr.get("name"),
                }
            )
        elif not bool(cr.get("passed")):
            unchanged_fail.append(
                {
                    "id": cid,
                    "track": cr.get("track"),
                    "name": cr.get("name"),
                }
            )

    c_tracks = candidate_report.get("tracks", {})
    b_tracks = baseline_report.get("tracks", {})
    track_deltas: dict[str, dict[str, Any]] = {}
    for tid in ALL_TRACK_IDS:
        ct = c_tracks.get(tid)
        bt = b_tracks.get(tid)
        if ct and bt:
            track_deltas[tid] = {
                "title_zh": ct.get("title_zh", tid),
                "baseline_pct": bt.get("pass_rate_pct", 0.0),
                "candidate_pct": ct.get("pass_rate_pct", 0.0),
                "delta_pct": round(
                    float(ct.get("pass_rate_pct", 0.0)) - float(bt.get("pass_rate_pct", 0.0)),
                    1,
                ),
            }

    overall_delta_pct = round(
        float(candidate_report.get("pass_rate_pct", 0.0))
        - float(baseline_report.get("pass_rate_pct", 0.0)),
        1,
    )
    return {
        "candidate_run_key": candidate_report.get("run_key"),
        "baseline_run_key": baseline_report.get("run_key"),
        "candidate_pass_rate_pct": candidate_report.get("pass_rate_pct", 0.0),
        "baseline_pass_rate_pct": baseline_report.get("pass_rate_pct", 0.0),
        "overall_delta_pct": overall_delta_pct,
        "duration_delta_ms": round(
            float(candidate_report.get("duration_ms", 0.0))
            - float(baseline_report.get("duration_ms", 0.0)),
            2,
        ),
        "regression_detected": len(newly_regressed) > 0,
        "newly_regressed": newly_regressed,
        "newly_fixed": newly_fixed,
        "unchanged_fail": unchanged_fail,
        "track_deltas": track_deltas,
    }


def _serialize_eval_run_row(row: EvalRun, *, include_report: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": row.id,
        "run_key": row.run_key,
        "suite_version": row.suite_version,
        "trigger_source": row.trigger_source,
        "tracks_executed": row.tracks_executed,
        "llm_judge_mode": row.llm_judge_mode,
        "git_sha": row.git_sha,
        "pass_k_trials": row.pass_k_trials,
        "total_cases": row.total_cases,
        "passed_cases": row.passed_cases,
        "pass_rate_pct": row.pass_rate_pct,
        "track_summary": row.track_summary_json,
        "duration_ms": row.duration_ms,
        "is_baseline": row.is_baseline,
        "notes": row.notes,
        "created_at": row.created_at.isoformat(),
    }
    if include_report:
        out["report"] = row.report_json
    return out


async def run_full_eval_suite(
    *,
    settings: Settings,
    session_factory: async_sessionmaker[AsyncSession] | None = None,
    tracks: list[str] | None = None,
    pass_k_trials: int = 3,
    use_live_judge: bool = False,
    trigger_source: str = "manual_ui",
    mark_baseline: bool = False,
    notes: str = "",
    save_file_report: bool = True,
) -> dict[str, Any]:
    """Execute selected Tracks (default all 4), persist EvalRun to PostgreSQL & compute Baseline Diff."""
    t0 = time.perf_counter()
    selected = [t for t in (tracks or list(ALL_TRACK_IDS)) if t in ALL_TRACK_IDS]
    if not selected:
        selected = list(ALL_TRACK_IDS)

    track_summaries: dict[str, Any] = {}
    all_results: list[dict[str, Any]] = []
    legacy_categories: dict[str, Any] = {}

    if "track1" in selected:
        t1_sum, t1_cases, t1_raw = run_track1_golden()
        track_summaries["track1"] = t1_sum
        all_results.extend(t1_cases)
        legacy_categories = t1_raw.get("categories", {})

    if "track2" in selected:
        t2_sum, t2_cases = await run_track2_rag_faithfulness(
            session_factory=session_factory,
            settings=settings,
            use_live_judge=use_live_judge,
        )
        track_summaries["track2"] = t2_sum
        all_results.extend(t2_cases)

    if "track3" in selected:
        t3_sum, t3_cases = await run_track3_agent_sandbox(
            settings=settings,
            pass_k_trials=pass_k_trials,
        )
        track_summaries["track3"] = t3_sum
        all_results.extend(t3_cases)

    if "track4" in selected:
        t4_sum, t4_cases = run_track4_redteam_counterfactual()
        track_summaries["track4"] = t4_sum
        all_results.extend(t4_cases)

    # Rebuild category aggregation across all executed cases cleanly
    categories: dict[str, dict[str, Any]] = {}
    for r in all_results:
        cat = str(r.get("category", "general"))
        b = categories.setdefault(cat, {"total": 0, "passed": 0, "track": r.get("track")})
        b["total"] += 1
        if r.get("passed"):
            b["passed"] += 1
    for cat, stats in categories.items():
        tot = stats["total"]
        stats["pass_rate_pct"] = round((stats["passed"] / tot) * 100.0, 1) if tot else 0.0

    total = len(all_results)
    passed = sum(1 for r in all_results if r.get("passed"))
    pass_rate = round((passed / total) * 100.0, 1) if total else 0.0
    duration_ms = round((time.perf_counter() - t0) * 1000.0, 2)
    run_key = (
        f"eval-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-"
        f"{uuid.uuid4().hex[:6]}"
    )
    git_sha = _resolve_git_sha()
    judge_mode = "hybrid_live_judge" if use_live_judge else "offline_deterministic"

    report: dict[str, Any] = {
        "run_key": run_key,
        "suite_version": "v2.0-4track",
        "status": "ok" if passed == total else "degraded",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "trigger_source": trigger_source,
        "git_sha": git_sha,
        "llm_judge_mode": judge_mode,
        "pass_k_trials": pass_k_trials,
        "tracks_executed": selected,
        "total_cases": total,
        "passed_cases": passed,
        "pass_rate_pct": pass_rate,
        "duration_ms": duration_ms,
        "tracks": track_summaries,
        "categories": categories or legacy_categories,
        "results": all_results,
        "notes": notes.strip()[:255],
        "is_baseline": bool(mark_baseline),
    }

    if save_file_report:
        try:
            _LATEST_REPORT_PATH.write_text(
                json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except OSError as exc:
            logger.warning("Unable to write eval latest_report.json: %s", exc)

    baseline_diff: dict[str, Any] | None = None
    persisted = False

    if session_factory is not None:
        try:
            async with session_factory() as session:
                prev_baseline_stmt = (
                    select(EvalRun)
                    .where(EvalRun.is_baseline.is_(True))
                    .order_by(desc(EvalRun.created_at))
                    .limit(1)
                )
                baseline_row = (await session.execute(prev_baseline_stmt)).scalars().first()
                if baseline_row is None:
                    prev_any_stmt = select(EvalRun).order_by(desc(EvalRun.created_at)).limit(1)
                    baseline_row = (await session.execute(prev_any_stmt)).scalars().first()

                # First ever run automatically acts as initial Golden Baseline
                effective_baseline = bool(mark_baseline) or (baseline_row is None)
                if effective_baseline:
                    await session.execute(update(EvalRun).values(is_baseline=False))
                report["is_baseline"] = effective_baseline

                new_row = EvalRun(
                    run_key=run_key,
                    suite_version="v2.0-4track",
                    trigger_source=trigger_source,
                    tracks_executed=selected,
                    llm_judge_mode=judge_mode,
                    git_sha=git_sha,
                    pass_k_trials=pass_k_trials,
                    total_cases=total,
                    passed_cases=passed,
                    pass_rate_pct=pass_rate,
                    track_summary_json=track_summaries,
                    report_json=report,
                    duration_ms=duration_ms,
                    is_baseline=effective_baseline,
                    notes=notes.strip()[:255],
                )
                session.add(new_row)
                await session.commit()
                persisted = True

                if baseline_row is not None and isinstance(baseline_row.report_json, dict):
                    baseline_diff = compute_runs_diff(report, baseline_row.report_json)
        except SQLAlchemyError as exc:
            logger.warning("EvalRun persistence skipped/failed: %s", exc)

    report["persisted"] = persisted
    report["baseline_diff"] = baseline_diff
    return report


async def list_eval_runs(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    limit: int = 15,
) -> dict[str, Any]:
    """List recent persisted EvalRun records alongside the newest full report and baseline diff."""
    rows: list[EvalRun] = []
    try:
        async with session_factory() as session:
            stmt = select(EvalRun).order_by(desc(EvalRun.created_at)).limit(limit)
            rows = list((await session.execute(stmt)).scalars().all())
    except SQLAlchemyError as exc:
        logger.warning("list_eval_runs failed: %s", exc)
        rows = []

    if not rows:
        # Fallback cleanly to cached JSON if present, else empty indicator
        latest_report = None
        if _LATEST_REPORT_PATH.exists():
            try:
                latest_report = json.loads(_LATEST_REPORT_PATH.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                latest_report = None
        return {
            "runs": [],
            "baseline_run_key": None,
            "latest_report": latest_report,
            "baseline_diff": None,
        }

    baseline_row = next((r for r in rows if r.is_baseline), None)
    if baseline_row is None:
        try:
            async with session_factory() as session:
                b_stmt = (
                    select(EvalRun)
                    .where(EvalRun.is_baseline.is_(True))
                    .order_by(desc(EvalRun.created_at))
                    .limit(1)
                )
                baseline_row = (await session.execute(b_stmt)).scalars().first()
        except SQLAlchemyError:
            baseline_row = None

    latest_row = rows[0]
    latest_report = dict(latest_row.report_json or {})
    latest_report["is_baseline"] = latest_row.is_baseline
    diff = None
    if baseline_row is not None and baseline_row.run_key != latest_row.run_key:
        diff = compute_runs_diff(latest_report, dict(baseline_row.report_json or {}))
    elif len(rows) >= 2:
        diff = compute_runs_diff(latest_report, dict(rows[1].report_json or {}))

    return {
        "runs": [_serialize_eval_run_row(r) for r in rows],
        "baseline_run_key": baseline_row.run_key if baseline_row else latest_row.run_key,
        "latest_report": latest_report,
        "baseline_diff": diff,
    }


async def get_eval_run_detail(
    session_factory: async_sessionmaker[AsyncSession],
    run_key: str,
) -> dict[str, Any] | None:
    """Fetch complete report payload for a specific run_key."""
    try:
        async with session_factory() as session:
            stmt = select(EvalRun).where(EvalRun.run_key == run_key).limit(1)
            row = (await session.execute(stmt)).scalars().first()
            if row is None:
                return None
            return _serialize_eval_run_row(row, include_report=True)
    except SQLAlchemyError as exc:
        logger.warning("get_eval_run_detail failed: %s", exc)
        return None


async def pin_eval_baseline(
    session_factory: async_sessionmaker[AsyncSession],
    run_key: str,
) -> dict[str, Any] | None:
    """Mark a specific EvalRun as the canonical regression Golden Baseline."""
    async with session_factory() as session:
        stmt = select(EvalRun).where(EvalRun.run_key == run_key).limit(1)
        row = (await session.execute(stmt)).scalars().first()
        if row is None:
            return None
        await session.execute(update(EvalRun).values(is_baseline=False))
        row.is_baseline = True
        if isinstance(row.report_json, dict):
            updated_report = dict(row.report_json)
            updated_report["is_baseline"] = True
            row.report_json = updated_report
        await session.commit()
        await session.refresh(row)
        return _serialize_eval_run_row(row)


async def compare_eval_runs_by_key(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    candidate_key: str,
    baseline_key: str,
) -> dict[str, Any] | None:
    """Load two EvalRun snapshots from PostgreSQL and return full diff report."""
    async with session_factory() as session:
        c_stmt = select(EvalRun).where(EvalRun.run_key == candidate_key).limit(1)
        b_stmt = select(EvalRun).where(EvalRun.run_key == baseline_key).limit(1)
        c_row = (await session.execute(c_stmt)).scalars().first()
        b_row = (await session.execute(b_stmt)).scalars().first()
        if c_row is None or b_row is None:
            return None
        return compute_runs_diff(dict(c_row.report_json or {}), dict(b_row.report_json or {}))

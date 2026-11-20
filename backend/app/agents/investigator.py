from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from collections.abc import AsyncIterator, Sequence
from typing import Annotated, Any, TypedDict

import httpx
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    AnyMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.tools import BaseTool, StructuredTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.mcp_servers.market_server import (
    get_asset_structure,
    get_macro_and_earnings_calendar,
    get_market_regime_snapshot,
    get_sec_filings_context,
    mcp,
)
from app.rag.hybrid_search import HybridSecRetriever
from app.services.llm_router import (
    LLMUnconfiguredError,
    build_fast_llm,
    build_pro_llm,
    estimate_text_tokens,
    trim_messages_to_budget,
)

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = """You are MarketElite Investigator, an institutional US equity market-structure analyst.
Rules:
1. Ground EVERY price, indicator, macro rate, and filing citation strictly in tool outputs or injected Regime Context. Never invent prices, EPS numbers, or dates.
2. Explicitly note when referencing Estimated GEX that it relies on Dealer Positioning Assumptions & OCC T+1/T+2 OI.
3. Keep analysis concise, structured, and objective: Macro/Regime Context -> Asset Technicals & Options Walls -> Fundamental/SEC Risk Citations -> Key Factual Risks.
4. For deep 10-K/10-Q multi-angle audits of a company, invoke `run_sec_parallel_audit` once rather than looping repeatedly on individual SEC snippets.
5. Never claim to execute orders; order execution is separated into Risk Critic + HITL."""


class _ParallelSecArgs(BaseModel):
    symbol: str = Field(description="US stock ticker symbol, e.g. NVDA, AAPL, MSFT.")
    focus_question: str = Field(description="Core investment question guiding the filing audit.")


class InvestigatorState(TypedDict):
    """LangGraph Investigator state with anti-loop hashes and rolling context memory."""

    messages: Annotated[list[AnyMessage], add_messages]
    symbol: str | None
    steps_taken: int
    max_steps: int
    seen_tool_hashes: list[str]
    rolling_summary: str
    compressed_sec_notes: list[str]
    tool_calls_log: list[dict[str, Any]]
    forced_stop_reason: str | None
    regime_context: str


def compute_tool_fingerprint(tool_name: str, args: dict[str, Any]) -> str:
    """Compute canonical SHA-256 fingerprint of a tool call to block identical loop calls."""
    canonical = json.dumps({"tool": tool_name, "args": args}, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


_BUY_INTENT_RE = re.compile(
    r"(买|买入|做多|建仓|抄底|加仓|buy|long|accumulate|enter)", re.IGNORECASE
)
_SELL_INTENT_RE = re.compile(r"(卖|卖出|做空|清仓|止损减仓|sell|short)", re.IGNORECASE)
_QTY_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:股|shares?|sh)\b", re.IGNORECASE)


def detect_trade_intent(query: str, symbol: str | None) -> dict[str, Any]:
    """Detect conditional trade execution intent cleanly so UI routes to isolated Risk Critic."""
    text = (query or "").strip()
    is_sell = bool(_SELL_INTENT_RE.search(text))
    is_buy = bool(_BUY_INTENT_RE.search(text))
    if not (is_buy or is_sell):
        return {"detected": False}

    qty_match = _QTY_RE.search(text)
    proposed_qty = float(qty_match.group(1)) if qty_match else 100.0
    return {
        "detected": True,
        "symbol": (symbol or "SPY").upper().strip(),
        "side": "sell" if is_sell and not is_buy else "buy",
        "proposed_qty": max(1.0, proposed_qty),
    }


def _loopback_httpx_factory(
    headers: dict[str, str] | None = None,
    timeout: httpx.Timeout | None = None,
    auth: httpx.Auth | None = None,
) -> httpx.AsyncClient:
    """Create proxy-bypassing httpx client so local loopback FastMCP never hits HTTP_PROXY."""
    return httpx.AsyncClient(
        headers=headers,
        timeout=timeout or httpx.Timeout(30.0, read=300.0),
        auth=auth,
        follow_redirects=True,
        trust_env=False,
    )


async def load_mcp_tools(settings: Settings) -> list[BaseTool]:
    """Load read-only MarketElite tools via FastMCP Streamable HTTP with safe local fallback."""
    mcp_url = f"http://127.0.0.1:{settings.api_port}/mcp-server/mcp"
    try:
        client = MultiServerMCPClient(
            connections={
                "marketelite": {
                    "transport": "streamable_http",
                    "url": mcp_url,
                    "httpx_client_factory": _loopback_httpx_factory,
                }
            }
        )
        tools = await asyncio.wait_for(client.get_tools(), timeout=6.0)
        if tools:
            return tools
    except (OSError, TimeoutError, asyncio.TimeoutError, httpx.HTTPError, RuntimeError, ValueError) as exc:
        logger.info("MCP HTTP transport unavailable (%s); using direct FastMCP registry", exc)

    # Same underlying read-only FastMCP callables for unit tests or in-process calls
    return [
        StructuredTool.from_function(
            coroutine=get_market_regime_snapshot,
            name="get_market_regime_snapshot",
            description="Read precomputed US Market Regime, Fed Net Liquidity, VIX & sectors.",
        ),
        StructuredTool.from_function(
            coroutine=get_asset_structure,
            name="get_asset_structure",
            description="Return deterministic technicals, RVOL 4-quadrant, Estimated GEX & headlines.",
        ),
        StructuredTool.from_function(
            coroutine=get_macro_and_earnings_calendar,
            name="get_macro_and_earnings_calendar",
            description="Return upcoming US macro releases (CPI/NFP/PCE/GDP) and major earnings.",
        ),
        StructuredTool.from_function(
            coroutine=get_sec_filings_context,
            name="get_sec_filings_context",
            description="Lazy-load 10-K/10-Q from SEC EDGAR and retrieve cited passages via RAG.",
        ),
    ]


async def run_parallel_sec_subgraph(
    *,
    symbol: str,
    focus_question: str,
    settings: Settings,
    session_factory: async_sessionmaker[AsyncSession],
) -> list[str]:
    """Fan out 3 isolated Fast-Tier sub-researchers over SEC 10-K/10-Q chunks without leaking chat history."""
    sym = symbol.upper().strip()
    retriever = HybridSecRetriever(settings, session_factory)

    angles = [
        ("Risk Factors & Macro Headwinds", f"{sym} material risks macro supply chain {focus_question}"),
        ("Revenue Drivers & Margins", f"{sym} revenue growth gross margin guidance {focus_question}"),
        ("Liquidity, Debt & CapEx", f"{sym} cash liquidity debt capital expenditures {focus_question}"),
    ]

    async def _research_angle(angle_title: str, query: str) -> str:
        res = await retriever.search(sym, query, top_k=3, auto_ingest=True)
        chunks = res.get("chunks", [])
        if not chunks:
            return f"[{angle_title}]: No SEC filing data found for {sym}."

        raw_passages = "\n".join(
            f"({c['form_type']} {c['filing_date']} {c['section_title']}) {str(c['content'])[:450]}"
            for c in chunks
        )
        try:
            fast_llm = build_fast_llm(settings, temperature=0.0)
            prompt = [
                SystemMessage(
                    content=(
                        "You are an isolated SEC filing extractor. Summarize ONLY facts explicitly "
                        "present in the passages below into <=110 words with inline citation tags "
                        "like [10-K Date · Section]."
                    )
                ),
                HumanMessage(
                    content=f"Angle: {angle_title}\nFocus: {focus_question}\n\nPassages:\n{raw_passages}"
                ),
            ]
            reply = await fast_llm.ainvoke(prompt)
            text = reply.content if isinstance(reply.content, str) else str(reply.content)
            return f"### {angle_title}\n{text.strip()}"
        except LLMUnconfiguredError:
            first = chunks[0]
            return (
                f"### {angle_title} [{first['form_type']} {first['filing_date']} · "
                f"{first['section_title']}]\n{str(first['content'])[:280]}..."
            )

    notes = await asyncio.gather(*(_research_angle(title, q) for title, q in angles))
    return list(notes)


class InvestigatorAgentRunner:
    """Bounded LangGraph Investigator orchestrating MCP tools, parallel SEC subgraph & anti-loop guards."""

    def __init__(
        self,
        settings: Settings,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        tools: Sequence[BaseTool] | None = None,
        pro_llm: Any = None,
        fast_llm: Any = None,
    ) -> None:
        self._settings = settings
        self._session_factory = session_factory
        self._injected_tools = list(tools) if tools is not None else None
        self._pro_llm = pro_llm
        self._fast_llm = fast_llm

    def _build_parallel_sec_tool(
        self, notes_collector: list[str]
    ) -> BaseTool:
        async def _run_sec_parallel_audit(symbol: str, focus_question: str) -> str:
            notes = await run_parallel_sec_subgraph(
                symbol=symbol,
                focus_question=focus_question,
                settings=self._settings,
                session_factory=self._session_factory,
            )
            notes_collector.extend(notes)
            return "\n\n".join(notes)

        return StructuredTool.from_function(
            coroutine=_run_sec_parallel_audit,
            name="run_sec_parallel_audit",
            description=(
                "Run a 3-angle parallel SEC 10-K/10-Q sub-research audit (Risks, Margins, Liquidity) "
                "for deep fundamental investigation of a US stock."
            ),
            args_schema=_ParallelSecArgs,
        )

    def _build_graph(
        self,
        *,
        tools: list[BaseTool],
        pro_llm: Any,
        fast_llm: Any | None,
    ) -> Any:
        tools_by_name = {t.name: t for t in tools}
        llm_with_tools = pro_llm.bind_tools(tools)
        max_context_tokens = self._settings.agent_max_context_tokens

        async def prepare_context_node(state: InvestigatorState) -> dict[str, Any]:
            regime_ctx = state.get("regime_context") or await get_market_regime_snapshot()
            msgs = list(state.get("messages", []))
            rolling = state.get("rolling_summary", "")

            # Rolling Summarization when conversation turns grow long
            total_tokens = sum(estimate_text_tokens(str(m.content)) for m in msgs)
            if len(msgs) > 8 or total_tokens > int(max_context_tokens * 0.65):
                older = msgs[:-4]
                tail = msgs[-4:]
                older_text = "\n".join(
                    f"{m.type}: {str(m.content)[:350]}" for m in older if m.content
                )
                if fast_llm is not None and older_text:
                    try:
                        sum_resp = await fast_llm.ainvoke(
                            [
                                SystemMessage(
                                    content="Compress prior market investigation turns into <=120 words keeping exact numbers and symbols."
                                ),
                                HumanMessage(content=f"Existing summary:\n{rolling}\n\nTurns:\n{older_text}"),
                            ]
                        )
                        rolling = str(sum_resp.content).strip()
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("Rolling summarization fallback (%s)", exc)
                        rolling = f"{rolling}\n{older_text[:600]}".strip()
                else:
                    rolling = f"{rolling}\n{older_text[:600]}".strip()
                msgs = tail

            return {
                "regime_context": regime_ctx,
                "rolling_summary": rolling,
                "messages": msgs,
            }

        async def planner_node(state: InvestigatorState) -> dict[str, Any]:
            if state["steps_taken"] >= state["max_steps"]:
                return {"forced_stop_reason": f"Reached max_steps={state['max_steps']}"}

            sys_parts = [
                _SYSTEM_PROMPT,
                f"\n[Injected Layer-1 Market Regime Context]\n{state.get('regime_context', '')}",
            ]
            if state.get("rolling_summary"):
                sys_parts.append(f"\n[Rolling Conversation Summary]\n{state['rolling_summary']}")

            prompt_msgs = [SystemMessage(content="\n".join(sys_parts)), *state["messages"]]
            trimmed = trim_messages_to_budget(prompt_msgs, max_tokens=max_context_tokens)
            response = await llm_with_tools.ainvoke(trimmed)
            return {"messages": [response]}

        async def tool_executor_node(state: InvestigatorState) -> dict[str, Any]:
            last_msg = state["messages"][-1]
            tool_calls = getattr(last_msg, "tool_calls", None) or []
            seen_hashes = list(state.get("seen_tool_hashes", []))
            logs = list(state.get("tool_calls_log", []))
            new_messages: list[ToolMessage] = []
            steps = state["steps_taken"]

            for tc in tool_calls:
                name = str(tc.get("name", ""))
                args = tc.get("args") or {}
                call_id = str(tc.get("id", name))
                fp = compute_tool_fingerprint(name, args)

                if fp in seen_hashes:
                    msg = (
                        f"[Deadlock Guard] Tool `{name}` with identical arguments was already executed. "
                        "Use existing evidence or call `force_synthesize` / reply directly."
                    )
                    new_messages.append(ToolMessage(content=msg, tool_call_id=call_id, name=name))
                    logs.append({"tool": name, "args": args, "status": "blocked_duplicate"})
                    steps += 1
                    continue

                seen_hashes.append(fp)
                tool = tools_by_name.get(name)
                if tool is None:
                    new_messages.append(
                        ToolMessage(
                            content=f"[Tool Error] Unknown tool `{name}`.",
                            tool_call_id=call_id,
                            name=name,
                        )
                    )
                    steps += 1
                    continue

                t0 = time.perf_counter()
                try:
                    raw_out = await tool.ainvoke(args)
                    latency_ms = round((time.perf_counter() - t0) * 1000.0, 1)
                    out_str = raw_out if isinstance(raw_out, str) else json.dumps(raw_out, default=str)
                    new_messages.append(
                        ToolMessage(content=out_str, tool_call_id=call_id, name=name)
                    )
                    logs.append(
                        {
                            "tool": name,
                            "args": args,
                            "status": "ok",
                            "latency_ms": latency_ms,
                            "preview": out_str[:180],
                        }
                    )
                except Exception as exc:  # noqa: BLE001 - intentional MCP tool error self-healing boundary
                    latency_ms = round((time.perf_counter() - t0) * 1000.0, 1)
                    err_text = f"[Tool Self-Heal Hint] Tool `{name}` failed: {exc}. Adjust inputs or proceed without it."
                    new_messages.append(
                        ToolMessage(content=err_text, tool_call_id=call_id, name=name)
                    )
                    logs.append(
                        {
                            "tool": name,
                            "args": args,
                            "status": "error",
                            "latency_ms": latency_ms,
                            "preview": str(exc)[:180],
                        }
                    )
                steps += 1

            forced_reason = (
                f"Step budget reached ({steps}/{state['max_steps']})"
                if steps >= state["max_steps"]
                else None
            )
            return {
                "messages": new_messages,
                "seen_tool_hashes": seen_hashes,
                "tool_calls_log": logs,
                "steps_taken": steps,
                "forced_stop_reason": forced_reason,
            }

        async def force_synthesize_node(state: InvestigatorState) -> dict[str, Any]:
            reason = state.get("forced_stop_reason") or "Budget guard triggered"
            sys_prompt = (
                f"{_SYSTEM_PROMPT}\n\n[Guardrail Active: {reason}]\n"
                "Do NOT attempt further tool calls. Synthesize an accurate final report strictly "
                "from the observations already present in this thread."
            )
            trimmed = trim_messages_to_budget(
                [SystemMessage(content=sys_prompt), *state["messages"]],
                max_tokens=max_context_tokens,
            )
            reply = await pro_llm.ainvoke(trimmed)
            if not isinstance(reply, AIMessage):
                reply = AIMessage(content=str(reply))
            return {"messages": [reply]}

        def route_after_planner(state: InvestigatorState) -> str:
            if state.get("forced_stop_reason"):
                return "force_synthesize"
            last_msg = state["messages"][-1]
            tool_calls = getattr(last_msg, "tool_calls", None)
            if tool_calls:
                return "tool_executor"
            return END

        def route_after_tools(state: InvestigatorState) -> str:
            if state.get("forced_stop_reason") or state["steps_taken"] >= state["max_steps"]:
                return "force_synthesize"
            return "planner"

        builder = StateGraph(InvestigatorState)
        builder.add_node("prepare_context", prepare_context_node)
        builder.add_node("planner", planner_node)
        builder.add_node("tool_executor", tool_executor_node)
        builder.add_node("force_synthesize", force_synthesize_node)

        builder.add_edge(START, "prepare_context")
        builder.add_edge("prepare_context", "planner")
        builder.add_conditional_edges(
            "planner",
            route_after_planner,
            {"tool_executor": "tool_executor", "force_synthesize": "force_synthesize", END: END},
        )
        builder.add_conditional_edges(
            "tool_executor",
            route_after_tools,
            {"planner": "planner", "force_synthesize": "force_synthesize"},
        )
        builder.add_edge("force_synthesize", END)
        return builder.compile()

    async def investigate_stream(
        self,
        *,
        query: str,
        symbol: str | None = None,
        history: Sequence[dict[str, str]] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Run Investigator graph within wall-clock timeout and yield structured SSE events."""
        pro_llm = self._pro_llm or build_pro_llm(self._settings, streaming=True)
        fast_llm = self._fast_llm
        if fast_llm is None:
            try:
                fast_llm = build_fast_llm(self._settings)
            except LLMUnconfiguredError:
                fast_llm = None

        notes_collector: list[str] = []
        base_tools = (
            list(self._injected_tools)
            if self._injected_tools is not None
            else await load_mcp_tools(self._settings)
        )
        all_tools = [*base_tools, self._build_parallel_sec_tool(notes_collector)]

        graph = self._build_graph(tools=all_tools, pro_llm=pro_llm, fast_llm=fast_llm)

        messages: list[AnyMessage] = []
        for h in history or ():
            role = h.get("role", "user")
            content = h.get("content", "")
            if not content:
                continue
            messages.append(
                AIMessage(content=content) if role == "assistant" else HumanMessage(content=content)
            )
        user_text = f"[Focused Ticker: {symbol.upper()}]\n{query}" if symbol else query
        messages.append(HumanMessage(content=user_text))

        init_state: InvestigatorState = {
            "messages": messages,
            "symbol": symbol.upper() if symbol else None,
            "steps_taken": 0,
            "max_steps": self._settings.agent_max_steps,
            "seen_tool_hashes": [],
            "rolling_summary": "",
            "compressed_sec_notes": [],
            "tool_calls_log": [],
            "forced_stop_reason": None,
            "regime_context": "",
        }

        yield {
            "event": "status",
            "data": {
                "node": "prepare_context",
                "detail": "Loading Layer-1 Market Regime & FastMCP tools",
            },
        }

        final_state: dict[str, Any] = dict(init_state)
        deadline = time.monotonic() + float(self._settings.agent_wall_timeout_seconds)
        emitted_log_count = 0

        try:
            stream_iter = graph.astream(
                init_state,
                config={"recursion_limit": 25},
                stream_mode=["messages", "updates", "values"],
            ).__aiter__()

            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0.0:
                    raise TimeoutError("Agent wall clock budget exhausted")
                try:
                    mode, chunk = await asyncio.wait_for(anext(stream_iter), timeout=remaining)
                except StopAsyncIteration:
                    break

                if mode == "messages" and isinstance(chunk, tuple) and len(chunk) == 2:
                    msg_chunk, meta = chunk
                    node_name = meta.get("langgraph_node") if isinstance(meta, dict) else None
                    has_tool_chunks = bool(
                        getattr(msg_chunk, "tool_call_chunks", None)
                        or getattr(msg_chunk, "tool_calls", None)
                    )
                    delta = getattr(msg_chunk, "content", "")
                    if (
                        isinstance(msg_chunk, (AIMessageChunk, AIMessage))
                        and node_name in ("planner", "force_synthesize")
                        and not has_tool_chunks
                        and isinstance(delta, str)
                        and delta
                    ):
                        yield {"event": "token", "data": {"delta": delta}}
                elif mode == "values" and isinstance(chunk, dict):
                    final_state = chunk
                elif mode == "updates" and isinstance(chunk, dict):
                    for node_name, node_out in chunk.items():
                        if not isinstance(node_out, dict):
                            continue
                        if node_name == "prepare_context":
                            yield {
                                "event": "status",
                                "data": {
                                    "node": "planner",
                                    "detail": "Regime context injected; planning multi-step lookup",
                                },
                            }
                        elif node_name == "tool_executor":
                            all_logs = node_out.get("tool_calls_log", [])
                            for item in all_logs[emitted_log_count:]:
                                yield {"event": "tool_result", "data": item}
                            emitted_log_count = len(all_logs)
                        elif node_name == "force_synthesize":
                            yield {
                                "event": "status",
                                "data": {
                                    "node": "force_synthesize",
                                    "detail": node_out.get("forced_stop_reason", "Synthesizing"),
                                },
                            }
        except (TimeoutError, asyncio.TimeoutError):
            # Graceful degradation: salvage accumulated state via force_synthesize without HTTP 500
            yield {
                "event": "status",
                "data": {
                    "node": "force_synthesize",
                    "detail": (
                        f"Wall timeout ({self._settings.agent_wall_timeout_seconds}s) reached; "
                        "synthesizing gracefully"
                    ),
                },
            }
            fallback = await pro_llm.ainvoke(
                trim_messages_to_budget(
                    [
                        SystemMessage(
                            content=(
                                f"{_SYSTEM_PROMPT}\n"
                                "Wall timeout reached. Synthesize directly from gathered facts."
                            )
                        ),
                        *final_state.get("messages", messages),
                    ],
                    max_tokens=self._settings.agent_max_context_tokens,
                )
            )
            final_state["messages"] = [*final_state.get("messages", messages), fallback]
            final_state["forced_stop_reason"] = "wall_timeout_graceful_fallback"

        final_msgs = final_state.get("messages", [])
        answer = ""
        for msg in reversed(final_msgs):
            if isinstance(msg, AIMessage) and msg.content:
                answer = msg.content if isinstance(msg.content, str) else str(msg.content)
                break

        yield {
            "event": "done",
            "data": {
                "answer": answer,
                "steps_taken": final_state.get("steps_taken", 0),
                "tools_used": final_state.get("tool_calls_log", []),
                "sec_parallel_notes": notes_collector,
                "forced_stop_reason": final_state.get("forced_stop_reason"),
                "trade_intent": detect_trade_intent(query, symbol),
                "mcp_server": mcp.name,
            },
        }

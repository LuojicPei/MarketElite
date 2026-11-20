from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.runnables.config import var_child_runnable_config
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.db.models import (
    EconomicCalendarEvent,
    MarketDailyBar,
    MarketRegimeDaily,
    OptionsGexSnapshot,
    PaperTrade,
)
from app.mcp_servers.market_server import get_asset_structure, get_market_regime_snapshot
from app.quant.risk import RiskSizingRequest, compute_risk_sizing, validate_bracket_prices
from app.quant.technicals import DailyBarInput, analyze_asset_technicals
from app.rag.hybrid_search import HybridSecRetriever
from app.services.llm_router import LLMUnconfiguredError, build_pro_llm
from app.services.providers.alpaca import AlpacaClient
from app.services.resilience import ProviderError

logger = logging.getLogger(__name__)

_CRITIC_SYSTEM_PROMPT = """You are MarketElite Risk Critic — an independent adversarial Chief Risk Officer.
You operate in STRICT CONTEXT ISOLATION from conversational enthusiasm. Your job is to stress-test the proposed trade against objective market structure, GEX walls, earnings/macro catalysts, and capital preservation.

Rules:
1. Respond ONLY in valid JSON with these exact keys:
   - "verdict": one of "APPROVED_WITH_CAPS", "CAUTION_REDUCED", "REJECTED_HIGH_RISK"
   - "summary": concise 2-sentence institutional critique (CN + key EN terms)
   - "counter_arguments": array of 2-4 concrete factual reasons this trade could lose money
   - "regime_alignment": short tag ("ALIGNED" | "COUNTER_TREND" | "HIGH_VOL_HAZARD")
   - "falsification_trigger": exact price level + technical condition that proves the thesis wrong
   - "suggested_stop_loss": float (must respect trade side) or null
   - "suggested_take_profit": float (must respect trade side) or null
2. Ground every number strictly in the supplied Market Facts & Risk Sizing block. Never recommend exceeding the deterministic 1%-risk max_safe_qty."""


class RiskCritiqueReport(BaseModel):
    """Structured adversarial Risk Critic assessment."""

    verdict: str = Field(default="CAUTION_REDUCED")
    summary: str = Field(default="")
    counter_arguments: list[str] = Field(default_factory=list)
    regime_alignment: str = Field(default="COUNTER_TREND")
    falsification_trigger: str = Field(default="")
    suggested_stop_loss: float | None = None
    suggested_take_profit: float | None = None


class RiskCriticState(TypedDict, total=False):
    """Context-isolated LangGraph state for Risk Critic & durable HITL execution."""

    thread_id: str
    symbol: str
    side: str
    proposed_qty: float
    entry_price: float | None
    stop_loss_price: float | None
    take_profit_price: float | None
    risk_budget_pct: float
    rationale: str

    # Gathered cold market facts
    regime_label: str
    regime_summary: str
    asset_summary: str
    spot_price: float
    atr_14: float | None
    call_wall: float | None
    put_wall: float | None
    zero_gamma: float | None
    upcoming_catalysts: list[dict[str, Any]]
    sec_risk_excerpt: str
    account: dict[str, Any]
    existing_position: dict[str, Any] | None

    # Deterministic sizing + adversarial critique
    risk_sizing: dict[str, Any]
    critique: dict[str, Any]

    # HITL human decision & final order receipt
    human_decision: dict[str, Any]
    execution_status: str
    execution_receipt: dict[str, Any]
    execution_error: str | None


def _extract_json_dict(raw: str) -> dict[str, Any] | None:
    text = raw.strip()
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        brace = re.search(r"(\{.*\})", text, re.DOTALL)
        if brace:
            try:
                parsed = json.loads(brace.group(1))
                return parsed if isinstance(parsed, dict) else None
            except json.JSONDecodeError:
                return None
    return None


def _build_deterministic_critique(state: RiskCriticState) -> dict[str, Any]:
    """Rule-based adversarial fallback when Reasoning LLM is unavailable or errors."""
    sizing = state["risk_sizing"]
    catalysts = state.get("upcoming_catalysts", [])
    regime_label = str(state.get("regime_label", "NEUTRAL"))
    side = str(state.get("side", "buy")).lower()
    spot = float(state.get("spot_price", 0.0))
    zero_gamma = state.get("zero_gamma")
    existing = state.get("existing_position")

    counter_args: list[str] = []
    high_risk_flags = 0

    if regime_label in ("RISK_OFF_STRESS", "LIQUIDITY_TIGHTENING") and side == "buy":
        counter_args.append(
            f"Macro Regime 为 `{regime_label}`（压力偏高），顺周期做多易遭系统性估值/流动性回撤。"
        )
        high_risk_flags += 1
    if zero_gamma is not None and side == "buy" and spot < float(zero_gamma):
        counter_args.append(
            f"现价 ${spot:.2f} 低于 Zero Gamma 翻转位 ${float(zero_gamma):.2f}，做市商处于负伽马区间可能放大下行波动。"
        )
        high_risk_flags += 1
    if catalysts:
        first = catalysts[0]
        counter_args.append(
            f"近期催化剂警告：{first.get('event_time', '')[:10]} 有 {first.get('title', 'Event')}，存在跳空滑点破止损风险。"
        )
        high_risk_flags += 1
    if sizing.get("was_capped_by_risk"):
        counter_args.append(
            f"原拟 {sizing['proposed_qty']} 股突破 {sizing['risk_budget_pct']}% 单笔风险预算"
            f"（上限 ${sizing['max_risk_dollars']:,.0f}），已强制缩仓至 {sizing['recommended_qty']} 股。"
        )
    if existing:
        counter_args.append(
            f"账户已持有 {existing.get('qty')} 股 {state['symbol']}（市值 ${existing.get('market_value', 0):,.0f}），加仓会放大单一标的相关性敞口。"
        )
    if not counter_args:
        counter_args.append(
            "即使技术结构配合，盘中流动性变化与突发宏观新闻仍可能击穿预期支撑位，必须严格挂出 Bracket 止损。"
        )

    if not sizing.get("bracket_valid"):
        verdict = "REJECTED_HIGH_RISK"
    elif high_risk_flags >= 2 or sizing.get("was_capped_by_risk"):
        verdict = "CAUTION_REDUCED"
    else:
        verdict = "APPROVED_WITH_CAPS"

    sl = sizing.get("stop_loss_price")
    falsification = (
        f"有效跌破 ${sl:.2f}" if side == "buy" and sl else f"有效突破 ${sl:.2f}" if sl else "跌破预设证伪止损"
    )
    alignment = (
        "COUNTER_TREND"
        if regime_label in ("RISK_OFF_STRESS", "HIGH_VOL_TRANSITION", "LIQUIDITY_TIGHTENING")
        and side == "buy"
        else "ALIGNED"
    )
    summary = (
        f"按 {sizing['risk_budget_pct']:.1f}% 账户风险预算（上限 ${sizing['max_risk_dollars']:,.2f}）核验："
        f"建议上限 {sizing['recommended_qty']} 股，Bracket 止损 ${sizing['stop_loss_price']} / 止盈 ${sizing['take_profit_price']}（R:R {sizing['risk_reward_ratio']}x）。"
    )
    return RiskCritiqueReport(
        verdict=verdict,
        summary=summary,
        counter_arguments=counter_args,
        regime_alignment=alignment,
        falsification_trigger=falsification,
        suggested_stop_loss=sizing.get("stop_loss_price"),
        suggested_take_profit=sizing.get("take_profit_price"),
    ).model_dump()


class RiskCriticRunner:
    """Context-isolated adversarial Risk Critic with durable Postgres HITL checkpoint & Alpaca Paper execution."""

    def __init__(
        self,
        settings: Settings,
        session_factory: async_sessionmaker[AsyncSession],
        checkpointer: BaseCheckpointSaver[Any],
        *,
        alpaca_client: AlpacaClient | None = None,
        pro_llm: Any = None,
    ) -> None:
        self._settings = settings
        self._session_factory = session_factory
        self._checkpointer = checkpointer
        self._alpaca = alpaca_client or AlpacaClient(settings)
        self._pro_llm = pro_llm

    async def _load_symbol_facts(self, symbol: str) -> dict[str, Any]:
        sym = symbol.upper().strip()
        spot_price = 0.0
        atr_14: float | None = None
        call_wall: float | None = None
        put_wall: float | None = None
        zero_gamma: float | None = None
        regime_label = "NEUTRAL_ROTATION"
        catalysts: list[dict[str, Any]] = []

        now = datetime.now(timezone.utc)
        horizon = now + timedelta(days=10)

        async with self._session_factory() as session:
            bars_stmt = (
                select(MarketDailyBar)
                .where(MarketDailyBar.symbol == sym)
                .order_by(desc(MarketDailyBar.trade_date))
                .limit(220)
            )
            db_bars = list((await session.execute(bars_stmt)).scalars().all())
            db_bars.reverse()
            if db_bars:
                spot_price = float(db_bars[-1].close)
                tech = analyze_asset_technicals(
                    [
                        DailyBarInput(
                            trade_date=b.trade_date.isoformat(),
                            open=b.open,
                            high=b.high,
                            low=b.low,
                            close=b.close,
                            volume=b.volume,
                            vwap=b.vwap,
                        )
                        for b in db_bars
                    ]
                )
                raw_atr = tech.get("atr_14")
                atr_14 = float(raw_atr) if raw_atr is not None else None

            gex_stmt = (
                select(OptionsGexSnapshot)
                .where(OptionsGexSnapshot.symbol == sym)
                .order_by(desc(OptionsGexSnapshot.snapshot_time))
                .limit(1)
            )
            gex = (await session.execute(gex_stmt)).scalar_one_or_none()
            if gex is not None:
                spot_price = spot_price or float(gex.spot_price)
                call_wall = gex.call_wall
                put_wall = gex.put_wall
                zero_gamma = gex.zero_gamma

            reg_stmt = (
                select(MarketRegimeDaily)
                .order_by(desc(MarketRegimeDaily.regime_date))
                .limit(1)
            )
            reg = (await session.execute(reg_stmt)).scalar_one_or_none()
            if reg is not None:
                regime_label = str(reg.regime_label)

            cal_stmt = (
                select(EconomicCalendarEvent)
                .where(
                    EconomicCalendarEvent.event_time >= now,
                    EconomicCalendarEvent.event_time <= horizon,
                )
                .order_by(EconomicCalendarEvent.event_time)
                .limit(40)
            )
            cal_rows = list((await session.execute(cal_stmt)).scalars().all())
            for ev in cal_rows:
                if ev.symbol == sym or (ev.event_type == "macro" and ev.impact == "High"):
                    catalysts.append(
                        {
                            "event_type": ev.event_type,
                            "event_time": ev.event_time.isoformat(),
                            "symbol": ev.symbol,
                            "title": ev.title,
                            "impact": ev.impact,
                        }
                    )

        return {
            "spot_price": spot_price,
            "atr_14": atr_14,
            "call_wall": call_wall,
            "put_wall": put_wall,
            "zero_gamma": zero_gamma,
            "regime_label": regime_label,
            "catalysts": catalysts[:6],
        }

    def _build_graph(self) -> Any:
        runner = self

        async def gather_hard_facts_node(state: RiskCriticState) -> dict[str, Any]:
            sym = state["symbol"].upper().strip()
            facts = await runner._load_symbol_facts(sym)
            regime_summary = await get_market_regime_snapshot()
            asset_summary = await get_asset_structure(sym)

            account: dict[str, Any] = {
                "status": "OFFLINE_FALLBACK",
                "equity": 100000.0,
                "buying_power": 100000.0,
                "cash": 100000.0,
                "paper": True,
            }
            existing_pos: dict[str, Any] | None = None
            try:
                account = await runner._alpaca.get_account()
                positions = await runner._alpaca.get_positions()
                for p in positions:
                    if str(p.get("symbol", "")).upper() == sym:
                        existing_pos = p
                        break
            except (ProviderError, ValueError, OSError) as exc:
                logger.warning("Alpaca account fetch fallback for Risk Critic: %s", exc)

            # Check already-ingested SEC risk chunks without triggering slow network download
            sec_excerpt = "No cached SEC 10-K/10-Q chunks yet for this symbol."
            try:
                retriever = HybridSecRetriever(runner._settings, runner._session_factory)
                sec_res = await retriever.search(
                    sym,
                    "material risk factors export controls debt liquidity margin",
                    top_k=2,
                    auto_ingest=False,
                )
                chunks = sec_res.get("chunks", [])
                if chunks:
                    sec_excerpt = "\n".join(
                        f"[{c['form_type']} {c['filing_date']} {c['section_title']}]: "
                        f"{str(c['content'])[:260]}..."
                        for c in chunks
                    )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Cached SEC lookup skipped in Risk Critic: %s", exc)

            spot = float(facts["spot_price"] or state.get("entry_price") or 0.0)
            if spot <= 0:
                raise ValueError(
                    f"No price bar available for {sym}. Run pipeline sync or provide entry_price."
                )

            sizing = compute_risk_sizing(
                RiskSizingRequest(
                    symbol=sym,
                    side=state["side"],
                    account_equity=float(account["equity"]),
                    buying_power=float(account["buying_power"]),
                    spot_price=spot,
                    proposed_qty=float(state["proposed_qty"]),
                    entry_price=state.get("entry_price"),
                    stop_loss_price=state.get("stop_loss_price"),
                    take_profit_price=state.get("take_profit_price"),
                    atr_14=facts["atr_14"],
                    call_wall=facts["call_wall"],
                    put_wall=facts["put_wall"],
                    risk_budget_pct=float(state.get("risk_budget_pct", 1.0)),
                )
            )

            return {
                "symbol": sym,
                "regime_label": facts["regime_label"],
                "regime_summary": regime_summary,
                "asset_summary": asset_summary,
                "spot_price": spot,
                "atr_14": facts["atr_14"],
                "call_wall": facts["call_wall"],
                "put_wall": facts["put_wall"],
                "zero_gamma": facts["zero_gamma"],
                "upcoming_catalysts": facts["catalysts"],
                "sec_risk_excerpt": sec_excerpt,
                "account": account,
                "existing_position": existing_pos,
                "risk_sizing": sizing.to_dict(),
            }

        async def adversarial_critic_node(state: RiskCriticState) -> dict[str, Any]:
            fallback = _build_deterministic_critique(state)
            try:
                llm = runner._pro_llm or build_pro_llm(
                    runner._settings, temperature=0.1, streaming=False
                )
            except LLMUnconfiguredError:
                return {"critique": fallback}

            sizing = state["risk_sizing"]
            prompt_body = "\n\n".join(
                [
                    (
                        f"PROPOSAL: {state['side'].upper()} {state['proposed_qty']} {state['symbol']} "
                        f"(Rationale: {state.get('rationale') or 'Not specified'})"
                    ),
                    f"DETERMINISTIC 1% SIZING:\n{json.dumps(sizing, ensure_ascii=False)}",
                    (
                        f"ACCOUNT & EXISTING POSITION:\nAccount={json.dumps(state.get('account'))}\n"
                        f"Existing={json.dumps(state.get('existing_position'))}"
                    ),
                    f"MACRO REGIME:\n{state.get('regime_summary', '')}",
                    f"ASSET TECHNICALS & GEX:\n{state.get('asset_summary', '')}",
                    f"UPCOMING 10D CATALYSTS:\n{json.dumps(state.get('upcoming_catalysts', []), ensure_ascii=False)}",
                    f"CACHED SEC RISK EXCERPTS:\n{state.get('sec_risk_excerpt', '')}",
                ]
            )
            try:
                resp = await llm.ainvoke(
                    [
                        SystemMessage(content=_CRITIC_SYSTEM_PROMPT),
                        HumanMessage(content=prompt_body),
                    ]
                )
                raw_text = resp.content if isinstance(resp.content, str) else str(resp.content)
                parsed = _extract_json_dict(raw_text)
                if parsed is None:
                    return {"critique": fallback}
                report = RiskCritiqueReport.model_validate(parsed).model_dump()
                if not report.get("counter_arguments"):
                    report["counter_arguments"] = fallback["counter_arguments"]
                if not sizing.get("bracket_valid"):
                    report["verdict"] = "REJECTED_HIGH_RISK"
                return {"critique": report}
            except Exception as exc:  # noqa: BLE001
                logger.warning("Risk Critic LLM fallback triggered: %s", exc)
                return {"critique": fallback}

        def hitl_approval_gate_node(
            state: RiskCriticState, config: RunnableConfig
        ) -> dict[str, Any]:
            sizing = dict(state["risk_sizing"])
            critique = dict(state["critique"])

            # Ensure Python 3.10 async executor preserves RunnableConfig contextvar for `interrupt()`
            token = var_child_runnable_config.set(config)
            try:
                decision_payload = interrupt(
                    {
                        "type": "risk_critic_hitl_approval",
                        "thread_id": state["thread_id"],
                        "symbol": state["symbol"],
                        "side": state["side"],
                        "rationale": state.get("rationale", ""),
                        "risk_sizing": sizing,
                        "critique": critique,
                        "account": state.get("account", {}),
                        "existing_position": state.get("existing_position"),
                        "upcoming_catalysts": state.get("upcoming_catalysts", []),
                    }
                )
            finally:
                var_child_runnable_config.reset(token)

            if not isinstance(decision_payload, dict):
                decision_payload = {"decision": "reject", "note": "Malformed resume payload"}
            return {"human_decision": decision_payload}

        async def deterministic_execute_node(state: RiskCriticState) -> dict[str, Any]:
            decision = state.get("human_decision") or {}
            action = str(decision.get("decision", "reject")).lower().strip()
            sizing = state["risk_sizing"]

            if action != "approve":
                return {
                    "execution_status": "rejected",
                    "execution_receipt": {
                        "decision": "rejected",
                        "reason": str(decision.get("note") or "Operator rejected proposal"),
                    },
                }

            max_safe = int(sizing.get("max_safe_qty", 0))
            if max_safe < 1:
                return {
                    "execution_status": "blocked_by_risk_cap",
                    "execution_error": "Safe integer quantity under 1% risk budget is 0.",
                    "execution_receipt": {"decision": "blocked", "qty": 0},
                }

            requested_qty = int(decision.get("approved_qty") or sizing["recommended_qty"])
            final_qty = max(1, min(requested_qty, max_safe))

            entry_px = float(sizing["entry_price"])
            sl_px = round(float(decision.get("stop_loss_price") or sizing["stop_loss_price"]), 2)
            tp_px = round(
                float(decision.get("take_profit_price") or sizing["take_profit_price"]), 2
            )
            limit_px_raw = decision.get("limit_price")
            limit_px = round(float(limit_px_raw), 2) if limit_px_raw is not None else None
            effective_entry = limit_px if limit_px is not None else entry_px

            valid_bracket, err_msg = validate_bracket_prices(
                side=state["side"],
                entry_price=effective_entry,
                stop_loss_price=sl_px,
                take_profit_price=tp_px,
            )
            if not valid_bracket:
                return {
                    "execution_status": "validation_failed",
                    "execution_error": err_msg,
                    "execution_receipt": {"decision": "validation_failed", "detail": err_msg},
                }

            try:
                client_oid = re.sub(r"[^a-zA-Z0-9_-]", "", state["thread_id"])[:42]
                order = await runner._alpaca.submit_bracket_order(
                    symbol=state["symbol"],
                    qty=final_qty,
                    side=state["side"],
                    take_profit_price=tp_px,
                    stop_loss_price=sl_px,
                    limit_price=limit_px,
                    client_order_id=f"me-{client_oid}",
                )
                return {
                    "execution_status": "submitted",
                    "execution_error": None,
                    "execution_receipt": {
                        "decision": "approved",
                        "alpaca_order": order,
                        "final_qty": final_qty,
                        "entry_price": effective_entry,
                        "stop_loss_price": sl_px,
                        "take_profit_price": tp_px,
                    },
                }
            except (ProviderError, ValueError) as exc:
                return {
                    "execution_status": "broker_error",
                    "execution_error": str(exc),
                    "execution_receipt": {"decision": "broker_error", "detail": str(exc)},
                }

        builder = StateGraph(RiskCriticState)
        builder.add_node("gather_hard_facts", gather_hard_facts_node)
        builder.add_node("adversarial_critic", adversarial_critic_node)
        builder.add_node("hitl_approval_gate", hitl_approval_gate_node)
        builder.add_node("deterministic_execute", deterministic_execute_node)

        builder.add_edge(START, "gather_hard_facts")
        builder.add_edge("gather_hard_facts", "adversarial_critic")
        builder.add_edge("adversarial_critic", "hitl_approval_gate")
        builder.add_edge("hitl_approval_gate", "deterministic_execute")
        builder.add_edge("deterministic_execute", END)

        return builder.compile(checkpointer=self._checkpointer)

    async def propose_trade(
        self,
        *,
        thread_id: str,
        symbol: str,
        side: str,
        proposed_qty: float,
        entry_price: float | None = None,
        stop_loss_price: float | None = None,
        take_profit_price: float | None = None,
        risk_budget_pct: float = 1.0,
        rationale: str = "",
    ) -> dict[str, Any]:
        """Run Risk Critic through HITL interrupt(), checkpointing state & saving pending PaperTrade."""
        graph = self._build_graph()
        config = {"configurable": {"thread_id": thread_id}}
        init_state: RiskCriticState = {
            "thread_id": thread_id,
            "symbol": symbol.upper().strip(),
            "side": side.lower().strip(),
            "proposed_qty": float(proposed_qty),
            "entry_price": entry_price,
            "stop_loss_price": stop_loss_price,
            "take_profit_price": take_profit_price,
            "risk_budget_pct": float(risk_budget_pct),
            "rationale": rationale.strip(),
        }

        result = await graph.ainvoke(init_state, config=config)
        interrupts = result.get("__interrupt__", [])
        approval_payload = (
            interrupts[0].value if interrupts and hasattr(interrupts[0], "value") else {}
        )
        sizing = result.get("risk_sizing", approval_payload.get("risk_sizing", {}))
        critique = result.get("critique", approval_payload.get("critique", {}))

        trade_id: int | None = None
        async with self._session_factory() as session:
            existing = (
                await session.execute(
                    select(PaperTrade).where(PaperTrade.thread_id == thread_id).limit(1)
                )
            ).scalar_one_or_none()
            if existing is None:
                row = PaperTrade(
                    thread_id=thread_id,
                    symbol=symbol.upper().strip(),
                    side=side.lower().strip(),
                    order_class="bracket",
                    qty=float(sizing.get("recommended_qty", 0)),
                    entry_price=sizing.get("entry_price"),
                    stop_loss_price=sizing.get("stop_loss_price"),
                    take_profit_price=sizing.get("take_profit_price"),
                    risk_budget_pct=float(risk_budget_pct),
                    status="pending_hitl",
                    regime_at_entry=str(result.get("regime_label", ""))[:48] or None,
                    rationale_summary=str(critique.get("summary") or rationale)[:2000],
                )
                session.add(row)
                await session.commit()
                await session.refresh(row)
                trade_id = row.id
            else:
                trade_id = existing.id

        return {
            "status": "awaiting_approval",
            "thread_id": thread_id,
            "trade_id": trade_id,
            "approval_card": approval_payload,
        }

    async def resume_trade(
        self,
        *,
        thread_id: str,
        decision: str,
        approved_qty: int | None = None,
        stop_loss_price: float | None = None,
        take_profit_price: float | None = None,
        limit_price: float | None = None,
        note: str = "",
    ) -> dict[str, Any]:
        """Resume suspended HITL checkpoint via Command(resume=...) and execute deterministically."""
        graph = self._build_graph()
        config = {"configurable": {"thread_id": thread_id}}
        snapshot = await graph.aget_state(config)
        if not snapshot or not snapshot.values:
            raise KeyError(f"No suspended checkpoint found for thread_id={thread_id}")

        resume_data = {
            "decision": decision.lower().strip(),
            "approved_qty": approved_qty,
            "stop_loss_price": stop_loss_price,
            "take_profit_price": take_profit_price,
            "limit_price": limit_price,
            "note": note,
        }
        result = await graph.ainvoke(Command(resume=resume_data), config=config)

        exec_status = str(result.get("execution_status", "unknown"))
        receipt = result.get("execution_receipt", {})
        alpaca_order = receipt.get("alpaca_order") if isinstance(receipt, dict) else None
        order_id = alpaca_order.get("id") if isinstance(alpaca_order, dict) else None

        async with self._session_factory() as session:
            row = (
                await session.execute(
                    select(PaperTrade).where(PaperTrade.thread_id == thread_id).limit(1)
                )
            ).scalar_one_or_none()
            if row is not None:
                row.status = exec_status
                if isinstance(receipt, dict):
                    if receipt.get("final_qty"):
                        row.qty = float(receipt["final_qty"])
                    if receipt.get("entry_price"):
                        row.entry_price = float(receipt["entry_price"])
                    if receipt.get("stop_loss_price"):
                        row.stop_loss_price = float(receipt["stop_loss_price"])
                    if receipt.get("take_profit_price"):
                        row.take_profit_price = float(receipt["take_profit_price"])
                if order_id:
                    row.alpaca_order_id = str(order_id)
                await session.commit()

        return {
            "status": exec_status,
            "thread_id": thread_id,
            "error": result.get("execution_error"),
            "receipt": receipt,
        }

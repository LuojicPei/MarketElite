from __future__ import annotations

import logging
import time
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from openai import OpenAIError
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agents.risk_critic import _extract_json_dict, load_symbol_market_facts
from app.agents.watchdog import EpisodicMemoryRetriever
from app.core.config import Settings
from app.quant.risk import RiskSizingRequest, compute_risk_sizing
from app.rag.hybrid_search import HybridSecRetriever
from app.services.broker import BrokerConfig, fetch_unified_broker_state
from app.services.llm_router import LLMUnconfiguredError, build_pro_llm
from app.services.resilience import ProviderError

logger = logging.getLogger(__name__)

_DEBATE_SYSTEM_PROMPT = """You are orchestrating MarketElite's institutional Bull-vs-Bear CRO Adversarial Debate for retail-pro US equity traders.
Two independent analysts examine the SAME verified market structure snapshot:
- Blue Team (做多推演方): builds an actionable, concrete bullish/entry thesis citing price structure, EMA/SMA levels, RVOL volume confirmation, upside distance to Call Wall, and fundamental/SEC facts.
- Red Team (独立风控挑刺方): surfaces real execution traps: macro headwinds, negative gamma (below Zero Gamma) intraday whipsaw risk, upcoming 10-day earnings/macro gap risk, portfolio overlap, and past episodic lessons.

CRITICAL READABILITY RULE:
- Write clear, engaging, easy-to-understand Simplified Chinese. Avoid dumping raw English enum jargon like "RISK_OFF_STRESS", "CRO_CAUTION_DEFER", "ELEVATED", or "NEGATIVE_GEX" — always explain what a signal MEANS in plain trading terms with exact dollar prices and percentages.
- Every bullet should deliver concrete findings, price thresholds, or actionable execution rules (never generic 10-word platitudes).

Respond ONLY in valid JSON with exact keys:
- "verdict": one of "BULL_FAVORED_WITH_CAP", "BALANCED_CONTESTED", "CRO_CAUTION_DEFER"
- "conviction_score": integer 0-100
- "bull_headline": rich 1-2 sentence Chinese core bullish/directional judgment
- "bull_catalysts": array of 4 substantive Chinese factual points (momentum/moving average, option wall room & targets, risk-reward setup, fundamental/structural support) referencing exact numbers
- "bear_headline": rich 1-2 sentence Chinese core risk warning
- "bear_counter_arguments": array of 4 substantive Chinese factual risk findings explaining concrete failure scenarios and exact trigger prices
- "key_insights": array of 3-4 actionable Chinese trading insights/ideas (e.g., exact confirmation condition to enter, what to watch intraday, why position size is capped, and immediate exit plan)
- "cro_summary": 2-3 sentence plain-Chinese final execution conclusion (referencing exact max_safe_qty, max risk dollars, entry zone, stop loss, and take profit)

STRICT GROUNDING RULE: Never invent any price, ratio, date, or share count outside the supplied JSON facts."""


_REGIME_ZH_MAP: dict[str, str] = {
    "RISK_OFF_STRESS": "避险承压期（大盘防御为主）",
    "LIQUIDITY_TIGHTENING": "流动性收紧期（估值承压）",
    "HIGH_VOL_TRANSITION": "高波动震荡期（防宽幅扫损）",
    "RISK_ON_EXPANSION": "顺风扩张期（利于多头趋势）",
    "NEUTRAL_ROTATION": "震荡轮动期（精选个股结构）",
}

_RISK_TAG_ZH_MAP: dict[str, str] = {
    "MACRO_HEADWIND": "宏观大盘逆风",
    "HIGH_VOLATILITY": "高波动防扫损",
    "NEGATIVE_GEX": "负伽马放大甩尾波动",
    "CATALYST_10D": "未来10日财报/宏观事件",
    "CONCENTRATION": "单一标的持仓过重",
    "MEMORY_CAUTION": "历史同类交易踩坑提醒",
}


class _LlmDebateSynthesis(BaseModel):
    verdict: str = Field(default="BALANCED_CONTESTED")
    conviction_score: int = Field(default=62, ge=0, le=100)
    bull_headline: str = Field(default="")
    bull_catalysts: list[str] = Field(default_factory=list)
    bear_headline: str = Field(default="")
    bear_counter_arguments: list[str] = Field(default_factory=list)
    key_insights: list[str] = Field(default_factory=list)
    cro_summary: str = Field(default="")


class DebateRunner:
    """Dual-perspective Bull vs Bear CRO Debate grounded in live market facts & broker equity."""

    def __init__(
        self,
        settings: Settings,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        broker_config: BrokerConfig | None = None,
        redis_client: Any = None,
        pro_llm: Any = None,
    ) -> None:
        self._settings = settings
        self._session_factory = session_factory
        self._broker_cfg = broker_config or BrokerConfig(provider="sandbox")
        self._redis = redis_client
        self._pro_llm = pro_llm

    async def run_debate(
        self,
        *,
        symbol: str,
        side: str = "buy",
        risk_budget_pct: float = 1.0,
        thesis_hint: str = "",
    ) -> dict[str, Any]:
        started = time.perf_counter()
        sym = symbol.upper().strip()
        norm_side = side.lower().strip()
        if norm_side not in ("buy", "sell"):
            norm_side = "buy"
        budget = max(0.25, min(2.0, float(risk_budget_pct or 1.0)))

        facts = await load_symbol_market_facts(self._session_factory, sym)
        spot = float(facts.get("spot_price") or 0.0)
        if spot <= 0:
            raise ValueError(f"尚未缓存 {sym} 的日线或估值行情，请先点击同步数据或在首页切换观察。")

        account: dict[str, Any] = {
            "equity": 100_000.0,
            "buying_power": 100_000.0,
            "currency": "USD",
            "broker": "sandbox",
        }
        existing_pos: dict[str, Any] | None = None
        broker_label = "本地拟真模拟盘 · 24/7 Sandbox"
        try:
            unified = await fetch_unified_broker_state(
                session_factory=self._session_factory,
                settings=self._settings,
                redis_client=self._redis,
                broker_cfg=self._broker_cfg,
            )
            if unified.get("account"):
                account = dict(unified["account"])
            broker_label = str(unified.get("broker_label") or broker_label)
            for p in unified.get("positions", []):
                if str(p.get("symbol", "")).upper() == sym:
                    existing_pos = p
                    break
        except (ProviderError, ValueError, OSError) as exc:
            logger.warning("Debate broker fallback cleanly handled: %s", exc)

        equity = max(100.0, float(account.get("equity") or 100_000.0))
        buying_power = max(0.0, float(account.get("buying_power") or equity))
        currency = str(account.get("currency") or "USD").upper()

        sizing = compute_risk_sizing(
            RiskSizingRequest(
                symbol=sym,
                side=norm_side,
                account_equity=equity,
                buying_power=buying_power,
                spot_price=spot,
                proposed_qty=max(1, int((equity * 0.15) // max(spot, 1.0))),
                entry_price=spot,
                atr_14=facts.get("atr_14"),
                call_wall=facts.get("call_wall"),
                put_wall=facts.get("put_wall"),
                risk_budget_pct=budget,
            )
        )

        # Cached SEC snippets (fast DB read only, no external HTTP penalty)
        sec_snippets: list[str] = []
        try:
            sec_ret = HybridSecRetriever(self._settings, self._session_factory)
            sec_res = await sec_ret.search(
                sym,
                "revenue margin liquidity risk factors guidance",
                top_k=2,
                auto_ingest=False,
            )
            for c in sec_res.get("chunks", [])[:2]:
                sec_snippets.append(
                    f"[{c.get('form_type')} {c.get('filing_date')} · {c.get('section_title')}] {str(c.get('content', ''))[:200]}..."
                )
        except Exception as exc:  # noqa: BLE001
            logger.debug("Debate cached SEC lookup skipped: %s", exc)

        # Episodic memory recall
        memories: list[dict[str, Any]] = []
        try:
            mem_ret = EpisodicMemoryRetriever(self._settings, self._session_factory)
            memories = await mem_ret.recall(
                f"{sym} {facts['regime_label']} {thesis_hint}",
                symbol=sym,
                regime_label=facts["regime_label"],
                top_k=3,
                workspace_id=self._broker_cfg.workspace_id if self._broker_cfg else "default",
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("Debate memory lookup skipped: %s", exc)

        det = self._build_deterministic_debate(
            sym=sym,
            side=norm_side,
            spot=spot,
            currency=currency,
            equity=equity,
            facts=facts,
            sizing=sizing.to_dict(),
            existing_pos=existing_pos,
            memories=memories,
            sec_snippets=sec_snippets,
            thesis_hint=thesis_hint,
        )

        mode = "deterministic_stress_test"
        try:
            llm = self._pro_llm or build_pro_llm(self._settings, temperature=0.15, streaming=False)
            payload_facts = {
                "symbol": sym,
                "side": norm_side,
                "thesis_hint": thesis_hint,
                "spot_price": spot,
                "regime_label": facts["regime_label"],
                "technicals": {
                    "ema_20": facts.get("ema_20"),
                    "sma_50": facts.get("sma_50"),
                    "sma_200": facts.get("sma_200"),
                    "rsi_14": facts.get("rsi_14"),
                    "rvol_20": facts.get("rvol_20"),
                    "atr_14": facts.get("atr_14"),
                    "change_5d_pct": facts.get("change_5d_pct"),
                    "change_20d_pct": facts.get("change_20d_pct"),
                    "volume_price_tag": facts.get("volume_price_tag"),
                },
                "options_gex": {
                    "call_wall": facts.get("call_wall"),
                    "put_wall": facts.get("put_wall"),
                    "zero_gamma": facts.get("zero_gamma"),
                    "net_gex": facts.get("net_gex"),
                },
                "sizing": sizing.to_dict(),
                "existing_position": existing_pos,
                "catalysts_10d": facts.get("catalysts", []),
                "memories": [
                    {"title": m.get("title"), "lesson": str(m.get("lesson_text", ""))[:180]}
                    for m in memories
                ],
                "sec_cached_snippets": sec_snippets,
            }
            resp = await llm.ainvoke(
                [
                    SystemMessage(content=_DEBATE_SYSTEM_PROMPT),
                    HumanMessage(content=f"MARKET_FACTS:\n{payload_facts}"),
                ]
            )
            raw = resp.content if isinstance(resp.content, str) else str(resp.content)
            parsed = _extract_json_dict(raw)
            if parsed is not None:
                validated = _LlmDebateSynthesis.model_validate(parsed)
                if validated.bull_headline:
                    det["bull_case"]["headline"] = validated.bull_headline
                if validated.bull_catalysts:
                    det["bull_case"]["catalysts"] = validated.bull_catalysts[:4]
                if validated.bear_headline:
                    det["bear_case"]["headline"] = validated.bear_headline
                if validated.bear_counter_arguments:
                    det["bear_case"]["counter_arguments"] = validated.bear_counter_arguments[:4]
                if validated.key_insights:
                    det["key_insights"] = validated.key_insights[:4]
                if validated.cro_summary:
                    det["cro_verdict"]["summary"] = validated.cro_summary
                det["conviction_score"] = validated.conviction_score
                if validated.verdict in (
                    "BULL_FAVORED_WITH_CAP",
                    "BALANCED_CONTESTED",
                    "CRO_CAUTION_DEFER",
                ):
                    det["verdict"] = validated.verdict
                mode = "llm_adversarial"
        except (LLMUnconfiguredError, OpenAIError, ValueError, RuntimeError, OSError) as exc:
            logger.info("Debate using deterministic quantitative stress-test: %s", exc)

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return {
            "symbol": sym,
            "side": norm_side,
            "mode": mode,
            "broker_label": broker_label,
            "currency": currency,
            "account_equity": round(equity, 2),
            "spot_price": round(spot, 2),
            "regime_label": facts["regime_label"],
            "regime_zh": _REGIME_ZH_MAP.get(str(facts["regime_label"]), "震荡轮动期"),
            "latency_ms": elapsed_ms,
            "key_levels": {
                "spot_price": round(spot, 2),
                "entry_price": sizing.entry_price,
                "stop_loss_price": sizing.stop_loss_price,
                "take_profit_price": sizing.take_profit_price,
                "put_wall": facts.get("put_wall"),
                "zero_gamma": facts.get("zero_gamma"),
                "call_wall": facts.get("call_wall"),
                "ema_20": facts.get("ema_20"),
                "sma_50": facts.get("sma_50"),
                "atr_14": facts.get("atr_14"),
            },
            "upcoming_catalysts": facts.get("catalysts", []),
            "memory_hits": memories,
            "sec_snippets": sec_snippets,
            **det,
        }

    def _build_deterministic_debate(
        self,
        *,
        sym: str,
        side: str,
        spot: float,
        currency: str,
        equity: float,
        facts: dict[str, Any],
        sizing: dict[str, Any],
        existing_pos: dict[str, Any] | None,
        memories: list[dict[str, Any]],
        sec_snippets: list[str],
        thesis_hint: str,
    ) -> dict[str, Any]:
        ema_20 = facts.get("ema_20")
        sma_50 = facts.get("sma_50")
        rsi_14 = facts.get("rsi_14")
        rvol_20 = facts.get("rvol_20")
        atr_pct = facts.get("atr_pct")
        chg_5d = facts.get("change_5d_pct")
        chg_20d = facts.get("change_20d_pct")
        call_wall = facts.get("call_wall")
        put_wall = facts.get("put_wall")
        zero_gamma = facts.get("zero_gamma")
        regime = str(facts.get("regime_label", "NEUTRAL_ROTATION"))
        catalysts = facts.get("catalysts", [])

        bull_points: list[str] = []
        bear_points: list[str] = []
        risk_tags: list[str] = []
        key_insights: list[str] = []
        score = 60

        # Bull evidence assembly (concrete multi-factor reasoning)
        if ema_20 and spot >= float(ema_20):
            dist_ema = ((spot / float(ema_20)) - 1.0) * 100.0
            bull_points.append(
                f"短期趋势占优：现价 ${spot:.2f} 稳站 20 日均线（${float(ema_20):.2f}）上方 +{dist_ema:.1f}%，回踩均线通常能吸引短线资金承接。"
            )
            score += 8
        elif put_wall and spot <= float(put_wall) * 1.04:
            dist_pw = ((spot / float(put_wall)) - 1.0) * 100.0
            bull_points.append(
                f"接近下方期权大资金防守墙（Put Wall ${float(put_wall):.2f}，仅隔 {abs(dist_pw):.1f}%）：大量看跌期权对冲盘在此构成天然支撑，跌深后易触发买盘反抽。"
            )
        else:
            bull_points.append(
                f"波段基准位置：现价 ${spot:.2f}（近 5 日 {chg_5d if chg_5d is not None else '—'}%，近 20 日 {chg_20d if chg_20d is not None else '—'}%），若后续放量站回关键均线可确认多头延续。"
            )

        if rvol_20 and float(rvol_20) >= 1.2:
            bull_points.append(
                f"成交量积极配合：近 20 日量比达 {float(rvol_20):.2f} 倍（明显高于均值），说明当前价格变动并非无量虚涨，机构交投承接真实有效。"
            )
            score += 6
        else:
            bull_points.append(
                f"缩量蓄势结构：当前 20 日量比约为 {float(rvol_20):.2f} 倍（偏温和），若随后放量突破震荡区间上限，买盘推升爆发力会更强。"
                if rvol_20
                else "量能中性温和：建议耐心等待放量突破信号确认后再逐步加码，避免盲目追高。"
            )

        if call_wall and float(call_wall) > spot:
            upside_room = ((float(call_wall) / spot) - 1.0) * 100.0
            bull_points.append(
                f"上方目标空间明确：期权顶部阻力墙（Call Wall）位于 ${float(call_wall):.2f}，距离现价仍有 +{upside_room:.1f}% 空间；若站稳多空波动分界位，顺势冲高阻力相对较小。"
            )
        else:
            bull_points.append(
                f"盈亏比结构清晰：按预设止损 ${sizing['stop_loss_price']} 与目标 ${sizing['take_profit_price']} 计算，每承担 $1 风险有望博取 ${sizing['risk_reward_ratio']} 回报，赔率具备数学优势。"
            )

        if sec_snippets:
            bull_points.append(f"基本面原件依据：已调取公司最新 SEC 官方财报原文，核心口径参考 -> {sec_snippets[0]}")
        elif sma_50:
            bull_points.append(
                f"中期结构参考：50 日中期成本均线位于 ${float(sma_50):.2f}（当前 RSI14 强弱指标为 {rsi_14 if rsi_14 is not None else '—'}，{'尚未严重超买' if (rsi_14 or 50) < 70 else '短线偏热需防回吐'}），多空位置清晰。"
            )

        # Bear / CRO stress-test assembly (plain-Chinese mechanism warnings)
        regime_zh = _REGIME_ZH_MAP.get(regime, "震荡轮动期")
        if regime in ("RISK_OFF_STRESS", "LIQUIDITY_TIGHTENING") and side == "buy":
            bear_points.append(
                f"大环境逆风提醒：目前全市场处于「{regime_zh}」，市场整体风险偏好与资金流动性偏紧，此时做多个股容易遭遇“个股没错但大盘拖累杀估值”的系统性回撤。"
            )
            risk_tags.append("MACRO_HEADWIND")
            score -= 14
        elif regime == "HIGH_VOL_TRANSITION":
            bear_points.append(
                f"高波动扫损警告：当前市场处于「{regime_zh}」（日均振幅约 {atr_pct or '—'}%），盘中常出现快速上下插针，若止损设得太窄极易被洗出后拉起，因此必须轻仓把止损放宽到 ATR 安全区外。"
            )
            risk_tags.append("HIGH_VOLATILITY")
            score -= 8

        if zero_gamma is not None and spot < float(zero_gamma):
            dist_zg = ((float(zero_gamma) / spot) - 1.0) * 100.0
            bear_points.append(
                f"负伽马震荡风险：现价 ${spot:.2f} 处于做市商多空平衡位（Zero Gamma ${float(zero_gamma):.2f}）下方约 {dist_zg:.1f}%，这意味着跌势中机构会被迫“追跌卖出对冲”，日内振幅会被明显放大。"
            )
            risk_tags.append("NEGATIVE_GEX")
            score -= 12

        if catalysts:
            c0 = catalysts[0]
            bear_points.append(
                f"近期重磅事件地雷：{str(c0.get('event_time', ''))[:10]} 将迎来「{c0.get('title', '重要事件')}」，财报/宏观数据公布往往伴随盘后大幅跳空，可能直接跳过预设止损价成交。"
            )
            risk_tags.append("CATALYST_10D")
            score -= 9

        if existing_pos:
            mv = float(existing_pos.get("market_value") or 0.0)
            conc_pct = (mv / equity * 100.0) if equity > 0 else 0.0
            bear_points.append(
                f"重仓集中度风险：你当前账户已持有 {existing_pos.get('qty')} 股 {sym}（占总净值约 {conc_pct:.1f}%），若再同向加仓，单只股票波动对总账户盈亏的影响会成倍放大。"
            )
            if conc_pct >= 12.0:
                risk_tags.append("CONCENTRATION")
                score -= 7

        if memories:
            m0 = memories[0]
            bear_points.append(
                f"过往教训敲警钟：你的历史交易记忆库中曾记录过相似情形「{m0.get('title', sym)}」，说明同类剧本存在翻车先例，切忌因为侥幸心理调高单笔最大亏损额。"
            )
            risk_tags.append("MEMORY_CAUTION")

        if len(bear_points) < 3:
            bear_points.append(
                f"关键位失效纪律：一旦股价放量跌破预设防守底线 ${sizing['stop_loss_price']}，说明原有做多逻辑已被市场否定，必须果断按计划止损，严禁“套牢变长线”继续补仓。"
            )

        score = max(15, min(92, score))
        if len(risk_tags) >= 3 or score < 45:
            verdict = "CRO_CAUTION_DEFER"
            temp = "EXTREME"
        elif len(risk_tags) >= 1 or score < 65:
            verdict = "BALANCED_CONTESTED"
            temp = "ELEVATED"
        else:
            verdict = "BULL_FAVORED_WITH_CAP"
            temp = "LOW"

        entry_lo = round(spot * 0.99, 2)
        entry_hi = round(spot * 1.008, 2)

        key_insights.append(
            f"入场节奏建议：现价 ${spot:.2f} 附近不建议一把满仓追单，更稳妥的做法是在 ${entry_lo:.2f}–${entry_hi:.2f} 区间分批试探，并同步挂好 ${sizing['stop_loss_price']} 机械止损。"
        )
        if zero_gamma and call_wall:
            key_insights.append(
                f"多空强弱分水岭：盯紧 ${float(zero_gamma):.2f}（做市商波动转折线）——站稳其上日内波动更温和；上方第一波兑现利润可重点观察 ${float(call_wall):.2f} 压力区反应。"
            )
        elif sma_50:
            key_insights.append(
                f"关键位置验证：若价格能持续守住 50 日均线（${float(sma_50):.2f}）之上且成交量不大幅萎缩，多头结构即可延续；反之一旦失守则应主动降仓观望。"
            )
        key_insights.append(
            f"硬核仓位红线：按 {currency} {equity:,.0f} 账户、单笔最多亏净值 {sizing['risk_budget_pct']:.1f}%（即 {currency} {sizing['max_risk_dollars']:,.0f}）倒推，本次最多建议买 {sizing['recommended_qty']} 股，最坏触发止损也不会伤及账户本金元气。"
        )
        if risk_tags:
            key_insights.append(
                f"当前主要卡点：共检测到 {len(risk_tags)} 项风险提示（{', '.join(_RISK_TAG_ZH_MAP.get(t, t) for t in risk_tags[:3])}），建议优先用小半仓试单，等风险落地或盘面确认后再决定是否补足。"
            )

        action_label = "试探做多" if side == "buy" else "减仓/对冲防守"
        bull_headline = (
            f"{sym} 当前价格 ${spot:.2f} 具备清晰的 {action_label} 结构，目标区间锚定至 ${sizing['take_profit_price']}"
            + (f"（结合你的思路：{thesis_hint[:36]}）" if thesis_hint.strip() else "")
        )
        bear_headline = (
            f"风控官重点提示：{sym} 当前需格外防范 {', '.join(_RISK_TAG_ZH_MAP.get(t, t) for t in risk_tags[:2])}（止损底线 ${sizing['stop_loss_price']}）"
            if risk_tags
            else f"风控底线要求：{sym} 必须严守单笔最大亏损 {sizing['risk_budget_pct']:.1f}%（跌破 ${sizing['stop_loss_price']} 无条件离场）"
        )
        falsification = (
            f"价格有效跌破 ${sizing['stop_loss_price']}"
            if side == "buy"
            else f"价格放量站稳突破 ${sizing['stop_loss_price']}"
        )
        verdict_plain = (
            "建议先观望或轻仓防守"
            if verdict == "CRO_CAUTION_DEFER"
            else "多空各有道理，适合按安全仓位分批小仓试单"
            if verdict == "BALANCED_CONTESTED"
            else "多方结构占优，可在严格设好止损的前提下按安全股数执行"
        )
        summary = (
            f"综合裁决：{verdict_plain}。在 {currency} {equity:,.0f} 净值与 {sizing['risk_budget_pct']:.1f}% 最大单笔风险约束（极限亏损封顶 {currency} {sizing['max_risk_dollars']:,.0f}）下，"
            f"建议下单上限为 {sizing['recommended_qty']} 股（参考入场 ${entry_lo:.2f}–${entry_hi:.2f}，止损 ${sizing['stop_loss_price']}，止盈目标 ${sizing['take_profit_price']}，盈亏比约 {sizing['risk_reward_ratio']} 倍）。"
        )

        return {
            "verdict": verdict,
            "conviction_score": score,
            "risk_temperature": temp,
            "key_insights": key_insights[:4],
            "bull_case": {
                "headline": bull_headline,
                "catalysts": bull_points[:4],
                "entry_zone": [entry_lo, entry_hi],
                "target_price": sizing["take_profit_price"],
            },
            "bear_case": {
                "headline": bear_headline,
                "counter_arguments": bear_points[:4],
                "invalidation_price": sizing["stop_loss_price"],
                "key_risk_tags": risk_tags,
                "risk_tags_zh": [_RISK_TAG_ZH_MAP.get(t, t) for t in risk_tags],
            },
            "cro_verdict": {
                "summary": summary,
                "max_safe_qty": sizing["recommended_qty"],
                "suggested_stop_loss": sizing["stop_loss_price"],
                "suggested_take_profit": sizing["take_profit_price"],
                "risk_reward_ratio": sizing["risk_reward_ratio"],
                "risk_budget_pct": sizing["risk_budget_pct"],
                "max_risk_dollars": sizing["max_risk_dollars"],
                "estimated_notional": sizing["estimated_notional"],
                "falsification_trigger": falsification,
            },
        }

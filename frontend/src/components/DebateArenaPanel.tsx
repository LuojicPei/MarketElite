"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRightCircle,
  Brain,
  Compass,
  Flame,
  Lightbulb,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Swords,
  Target,
  TrendingUp,
} from "lucide-react";
import {
  DebateReportResponse,
  RiskPrefillDraft,
  runAgentDebate,
} from "@/lib/api";
import BracketPriceLadder from "@/components/BracketPriceLadder";

interface DebateArenaPanelProps {
  defaultSymbol: string;
  onHandoffToRisk: (draft: RiskPrefillDraft) => void;
}

const REGIME_ZH: Record<string, string> = {
  RISK_OFF_STRESS: "避险承压期",
  LIQUIDITY_TIGHTENING: "流动性收紧期",
  HIGH_VOL_TRANSITION: "高波动震荡期",
  RISK_ON_EXPANSION: "顺风扩张期",
  NEUTRAL_ROTATION: "震荡轮动期",
};

const RISK_TAG_ZH: Record<string, string> = {
  MACRO_HEADWIND: "宏观大盘逆风",
  HIGH_VOLATILITY: "高波动防扫损",
  NEGATIVE_GEX: "负伽马放大波动",
  CATALYST_10D: "近期财报/数据事件",
  CONCENTRATION: "持仓过度集中",
  MEMORY_CAUTION: "历史同类交易警示",
};

const TEMP_ZH: Record<string, string> = {
  EXTREME: "高风险警戒",
  ELEVATED: "中等注意",
  LOW: "风险可控",
};

function fmtMoney(val: number, ccy?: string): string {
  const code = (ccy || "USD").toUpperCase();
  const sym = code === "GBP" ? "£" : code === "EUR" ? "€" : "$";
  return `${sym}${val.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtPctDelta(target: number | null | undefined, spot: number): string | null {
  if (target == null || !Number.isFinite(target) || spot <= 0) return null;
  const pct = ((target / spot) - 1) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export default function DebateArenaPanel({
  defaultSymbol,
  onHandoffToRisk,
}: DebateArenaPanelProps) {
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [riskBudget, setRiskBudget] = useState<number>(1.0);
  const [thesisHint, setThesisHint] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<DebateReportResponse | null>(null);

  useEffect(() => {
    setSymbol(defaultSymbol);
  }, [defaultSymbol]);

  const executeDebate = useCallback(
    async (symArg: string, sideArg: "buy" | "sell", budgetArg: number, hintArg: string) => {
      const clean = symArg.trim().toUpperCase();
      if (!clean) return;
      setLoading(true);
      setError(null);
      try {
        const res = await runAgentDebate({
          symbol: clean,
          side: sideArg,
          risk_budget_pct: budgetArg,
          thesis_hint: hintArg.trim(),
        });
        setReport(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : "红蓝对抗投决推演失败");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const verdictStyle = (verdict: string) => {
    if (verdict === "CRO_CAUTION_DEFER") {
      return "bg-rose-500/[0.15] text-rose-800 dark:text-rose-300";
    }
    if (verdict === "BULL_FAVORED_WITH_CAP") {
      return "bg-emerald-500/[0.15] text-emerald-800 dark:text-emerald-300";
    }
    return "bg-amber-500/[0.15] text-amber-800 dark:text-amber-300";
  };

  const verdictLabel = (verdict: string) => {
    if (verdict === "CRO_CAUTION_DEFER") return "风控建议观望或轻仓防守";
    if (verdict === "BULL_FAVORED_WITH_CAP") return "多方结构占优 · 限额可执行";
    return "多空分歧 · 谨慎小仓分批试单";
  };

  const levelCards = report
    ? [
        {
          label: "当前现价",
          value: `$${report.key_levels.spot_price.toFixed(2)}`,
          sub: "实时评估基准价",
          tone: "text-zinc-950 dark:text-white",
        },
        {
          label: "建议入场伏击区",
          value: `$${report.bull_case.entry_zone[0].toFixed(2)} – $${report.bull_case.entry_zone[1].toFixed(2)}`,
          sub: "分批建仓区间，避免追高",
          tone: "text-sky-700 dark:text-sky-300",
        },
        {
          label: "止损防守底线",
          value: `$${report.cro_verdict.suggested_stop_loss.toFixed(2)}`,
          sub: fmtPctDelta(report.cro_verdict.suggested_stop_loss, report.key_levels.spot_price)
            ? `距现价 ${fmtPctDelta(report.cro_verdict.suggested_stop_loss, report.key_levels.spot_price)}`
            : "机械止损防失控",
          tone: "text-rose-700 dark:text-rose-300",
        },
        {
          label: "止盈目标位",
          value: `$${report.cro_verdict.suggested_take_profit.toFixed(2)}`,
          sub: fmtPctDelta(report.cro_verdict.suggested_take_profit, report.key_levels.spot_price)
            ? `距现价 ${fmtPctDelta(report.cro_verdict.suggested_take_profit, report.key_levels.spot_price)} · 赔率 ${report.cro_verdict.risk_reward_ratio} 倍`
            : `赔率 ${report.cro_verdict.risk_reward_ratio} 倍`,
          tone: "text-emerald-700 dark:text-emerald-300",
        },
        {
          label: "下方期权强支撑",
          value:
            report.key_levels.put_wall != null
              ? `$${Number(report.key_levels.put_wall).toFixed(2)}`
              : "暂无期权数据",
          sub:
            report.key_levels.put_wall != null
              ? `距现价 ${fmtPctDelta(report.key_levels.put_wall, report.key_levels.spot_price)}（机构防守位）`
              : "Put Wall 待同步",
          tone: "text-emerald-700 dark:text-emerald-300",
        },
        {
          label: "多空波动分界位",
          value:
            report.key_levels.zero_gamma != null
              ? `$${Number(report.key_levels.zero_gamma).toFixed(2)}`
              : "暂无期权数据",
          sub:
            report.key_levels.zero_gamma != null
              ? report.key_levels.spot_price >= Number(report.key_levels.zero_gamma)
                ? "现价在其上方，波动相对平稳"
                : "现价在其下方，注意急跌急反弹"
              : "Zero Gamma 转折线",
          tone: "text-amber-700 dark:text-amber-300",
        },
        {
          label: "上方期权强阻力",
          value:
            report.key_levels.call_wall != null
              ? `$${Number(report.key_levels.call_wall).toFixed(2)}`
              : "暂无期权数据",
          sub:
            report.key_levels.call_wall != null
              ? `距现价 ${fmtPctDelta(report.key_levels.call_wall, report.key_levels.spot_price)}（反弹密集区）`
              : "Call Wall 待同步",
          tone: "text-violet-700 dark:text-violet-300",
        },
      ]
    : [];

  return (
    <div className="space-y-4">
      {/* Control Strip (Never auto-runs on tab open) */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void executeDebate(symbol, side, riskBudget, thesisHint);
        }}
        className="space-y-3 rounded-2xl border border-zinc-200/80 bg-zinc-50/85 p-4 dark:border-white/10 dark:bg-white/[0.04]"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 font-sans text-xs font-bold text-zinc-900 dark:text-zinc-100">
            <Swords className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            多空红蓝对抗投决室 · 手动点击发起论证
          </span>
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
            <span className="font-sans text-zinc-600 dark:text-zinc-400">单笔最大亏损上限:</span>
            {[0.5, 1.0, 1.5, 2.0].map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => setRiskBudget(b)}
                className={`rounded-full px-2.5 py-0.5 font-semibold transition ${
                  riskBudget === b
                    ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                    : "bg-white/90 text-zinc-700 hover:bg-zinc-200 dark:bg-white/[0.08] dark:text-zinc-200"
                }`}
              >
                {b}%
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="NVDA"
            className="w-full rounded-xl border border-zinc-200/90 bg-white px-3 py-2 font-mono text-xs uppercase text-zinc-950 focus:border-emerald-500 focus:outline-none dark:border-white/15 dark:bg-white/[0.06] dark:text-white sm:w-24"
          />
          <select
            value={side}
            onChange={(e) => setSide(e.target.value as "buy" | "sell")}
            className="rounded-xl border border-zinc-200/90 bg-white px-2.5 py-2 font-sans text-xs font-medium text-zinc-950 focus:border-emerald-500 focus:outline-none dark:border-white/15 dark:bg-zinc-900 dark:text-white sm:w-32"
          >
            <option value="buy">拟方向：做多买入</option>
            <option value="sell">拟方向：减仓/对冲</option>
          </select>
          <input
            type="text"
            value={thesisHint}
            onChange={(e) => setThesisHint(e.target.value)}
            placeholder="补充你的想法（例如：站稳 20 日均线分批买入，关心财报前波动风险）"
            className="flex-1 rounded-xl border border-zinc-200/90 bg-white px-3 py-2 text-xs text-zinc-950 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-white/15 dark:bg-white/[0.06] dark:text-white"
          />
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-zinc-950 px-5 py-2 font-sans text-xs font-bold text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-[#F3F3F0] dark:text-[#0B0B0D] dark:hover:bg-white"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Swords className="h-3.5 w-3.5" />}
            {loading ? "对抗推演中..." : "召开红蓝对抗"}
          </button>
        </div>
      </form>

      {error && (
        <div className="rounded-xl bg-rose-500/[0.12] px-3.5 py-2.5 font-mono text-xs text-rose-800 dark:text-rose-200">
          {error}
        </div>
      )}

      {/* Pre-Debate Explicit Idle Guide (Zero wasted tokens until user clicks submit) */}
      {!report && !loading && (
        <div className="rounded-2xl border border-zinc-200/80 bg-white/80 p-5 dark:border-white/10 dark:bg-white/[0.03]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="flex items-center gap-2 font-serif text-base font-bold text-zinc-950 dark:text-white">
                <Sparkles className="h-4 w-4 text-emerald-500" />
                准备就绪：点击「召开红蓝对抗」再开始推演
              </h3>
              <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
                为节省额度，切入本页签不会自动调用大模型；确认上方标的（<b>{symbol || defaultSymbol}</b>）、方向与单笔亏损预算后，点击按钮即可发起完整红蓝对抗。
              </p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-3 text-xs">
            <div className="rounded-xl bg-zinc-50/90 p-3 dark:bg-white/[0.04]">
              <div className="font-bold text-emerald-700 dark:text-emerald-300">① 多空硬核辩论</div>
              <p className="mt-1 leading-relaxed text-zinc-600 dark:text-zinc-400">
                多头推演趋势与目标空间，独立风控官结合大盘环境、财报日程与过往踩坑记忆无情挑刺。
              </p>
            </div>
            <div className="rounded-xl bg-zinc-50/90 p-3 dark:bg-white/[0.04]">
              <div className="font-bold text-sky-700 dark:text-sky-300">② 关键价格与点位清单</div>
              <p className="mt-1 leading-relaxed text-zinc-600 dark:text-zinc-400">
                直出买点区间、止损底线、止盈目标及期权支撑/阻力/波动分界线，不堆生涩英文代码。
              </p>
            </div>
            <div className="rounded-xl bg-zinc-50/90 p-3 dark:bg-white/[0.04]">
              <div className="font-bold text-amber-700 dark:text-amber-300">③ 一键生成风控计划单</div>
              <p className="mt-1 leading-relaxed text-zinc-600 dark:text-zinc-400">
                自动按账户净值与 {riskBudget}% 预算倒推最大安全股数，可直接同步到右侧风控审核下单。
              </p>
            </div>
          </div>
        </div>
      )}

      {report && (
        <div className="space-y-4">
          {/* Plain-Chinese Verdict & Context Header */}
          <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-zinc-200/80 bg-zinc-50/85 p-3.5 dark:border-white/10 dark:bg-white/[0.04]">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-3 py-1 font-sans text-xs font-bold ${verdictStyle(
                  report.verdict
                )}`}
              >
                {verdictLabel(report.verdict)}
              </span>
              <span className="rounded-full bg-white/90 px-2.5 py-0.5 font-sans text-[11px] font-medium text-zinc-700 dark:bg-white/10 dark:text-zinc-200">
                {report.mode === "llm_adversarial" ? "AI 双视角深度推演" : "量化压力测试（零额度）"} ·{" "}
                {(report.latency_ms / 1000).toFixed(2)}s
              </span>
              <span className="rounded-full bg-white/90 px-2.5 py-0.5 font-sans text-[11px] text-zinc-700 dark:bg-white/10 dark:text-zinc-200">
                大环境：{report.regime_zh || REGIME_ZH[report.regime_label] || "震荡轮动期"}
              </span>
            </div>

            <div className="flex items-center gap-3 text-xs">
              <span className="inline-flex items-center gap-1 font-medium text-zinc-700 dark:text-zinc-200">
                <Flame
                  className={`h-3.5 w-3.5 ${
                    report.risk_temperature === "EXTREME"
                      ? "text-rose-500"
                      : report.risk_temperature === "ELEVATED"
                        ? "text-amber-500"
                        : "text-emerald-500"
                  }`}
                />
                风险警戒：{TEMP_ZH[report.risk_temperature] || "需关注风险"}
              </span>
              <span className="font-mono font-bold text-zinc-950 dark:text-white">
                综合胜算 {report.conviction_score} / 100
              </span>
            </div>
          </div>

          {/* Core Actionable Insights & Findings */}
          {report.key_insights && report.key_insights.length > 0 && (
            <div className="rounded-2xl border border-sky-500/25 bg-sky-500/[0.06] p-4 dark:border-sky-400/20 dark:bg-sky-500/[0.08]">
              <div className="mb-2 flex items-center gap-1.5 font-sans text-xs font-bold text-sky-900 dark:text-sky-200">
                <Lightbulb className="h-4 w-4 text-amber-500" />
                <span>核心发现与实操建议（大白话拆解）</span>
              </div>
              <ul className="space-y-1.5 text-xs leading-relaxed text-zinc-800 dark:text-zinc-100">
                {report.key_insights.map((ins, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <Compass className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
                    <span>{ins}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Side-by-Side Bull vs Bear Cards */}
          <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
            {/* Blue Team Bull */}
            <div className="space-y-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] p-4 dark:bg-emerald-500/[0.08]">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 font-sans text-xs font-bold text-emerald-800 dark:text-emerald-300">
                  <TrendingUp className="h-4 w-4" />
                  蓝方观点 · 看多理由与上涨空间
                </span>
                <span className="font-mono text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
                  目标参考 ${report.bull_case.target_price.toFixed(2)}
                </span>
              </div>
              <p className="text-[13px] font-semibold leading-relaxed text-zinc-950 dark:text-white">
                {report.bull_case.headline}
              </p>
              <ul className="space-y-2 text-xs leading-relaxed text-zinc-800 dark:text-zinc-200">
                {report.bull_case.catalysts.map((item, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Red Team Bear CRO */}
            <div className="space-y-3 rounded-2xl border border-rose-500/20 bg-rose-500/[0.06] p-4 dark:bg-rose-500/[0.08]">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 font-sans text-xs font-bold text-rose-800 dark:text-rose-300">
                  <ShieldAlert className="h-4 w-4" />
                  红方挑刺 · 潜在风险与反转警示
                </span>
                <span className="font-mono text-[11px] font-bold text-rose-700 dark:text-rose-300">
                  离场底线 ${report.bear_case.invalidation_price.toFixed(2)}
                </span>
              </div>
              <p className="text-[13px] font-semibold leading-relaxed text-zinc-950 dark:text-white">
                {report.bear_case.headline}
              </p>
              <ul className="space-y-2 text-xs leading-relaxed text-zinc-800 dark:text-zinc-200">
                {report.bear_case.counter_arguments.map((arg, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                    <span>{arg}</span>
                  </li>
                ))}
              </ul>
              {report.bear_case.key_risk_tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {report.bear_case.key_risk_tags.map((tag, i) => (
                    <span
                      key={tag}
                      className="rounded-full bg-rose-500/[0.15] px-2.5 py-0.5 font-sans text-[10.5px] font-semibold text-rose-800 dark:text-rose-200"
                    >
                      {report.bear_case.risk_tags_zh?.[i] || RISK_TAG_ZH[tag] || tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Crisp Key Prices & Levels Matrix */}
          <div className="rounded-2xl border border-zinc-200/80 bg-white/85 p-4 dark:border-white/10 dark:bg-white/[0.04]">
            <div className="mb-3 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 font-sans text-xs font-bold text-zinc-950 dark:text-white">
                <Target className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                关键价格与期权重要点位清单（一目了然看价位）
              </span>
              <span className="font-mono text-[10.5px] text-zinc-500 dark:text-zinc-400">
                {report.symbol} · {report.side === "buy" ? "做多参考方案" : "减仓防守参考"}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
              {levelCards.map((card) => (
                <div
                  key={card.label}
                  className="rounded-xl border border-zinc-200/75 bg-zinc-50/85 p-2.5 dark:border-white/[0.08] dark:bg-white/[0.03]"
                >
                  <div className="font-sans text-[10.5px] text-zinc-500 dark:text-zinc-400">
                    {card.label}
                  </div>
                  <div className={`mt-1 font-mono text-xs font-bold tabular-nums ${card.tone}`}>
                    {card.value}
                  </div>
                  <div className="mt-0.5 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
                    {card.sub}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Embedded Key Levels Visual Ladder */}
          <BracketPriceLadder
            symbol={report.symbol}
            side={report.side}
            spotPrice={report.key_levels.spot_price}
            entryPrice={report.key_levels.entry_price}
            stopLossPrice={report.key_levels.stop_loss_price}
            takeProfitPrice={report.key_levels.take_profit_price}
            putWall={report.key_levels.put_wall}
            zeroGamma={report.key_levels.zero_gamma}
            callWall={report.key_levels.call_wall}
            compact
          />

          {/* Memory hits + Final Action Decision & Handoff */}
          {report.memory_hits.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
              <Brain className="h-3.5 w-3.5 shrink-0" />
              <span className="font-semibold">关联过往复盘教训：</span>
              {report.memory_hits.slice(0, 2).map((m, i) => (
                <span
                  key={m.id ?? i}
                  className="rounded-full bg-white/80 px-2.5 py-0.5 text-[11px] text-zinc-900 dark:bg-white/10 dark:text-zinc-100"
                >
                  {m.title || m.symbol}
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-200/80 bg-zinc-50/90 p-4 dark:border-white/10 dark:bg-white/[0.05]">
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="inline-flex flex-wrap items-center gap-2 font-sans text-xs font-bold text-zinc-950 dark:text-white">
                <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <span>
                  风控终审方案 · 最多买 {report.cro_verdict.max_safe_qty} 股（最大亏{" "}
                  {fmtMoney(report.cro_verdict.max_risk_dollars, report.currency)} · 盈亏比{" "}
                  {report.cro_verdict.risk_reward_ratio} 倍）
                </span>
              </div>
              <p className="text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
                {report.cro_verdict.summary}
              </p>
            </div>

            <button
              type="button"
              onClick={() =>
                onHandoffToRisk({
                  symbol: report.symbol,
                  side: report.side,
                  qty: Math.max(1, report.cro_verdict.max_safe_qty),
                  entryPrice: report.key_levels.entry_price,
                  stopLoss: report.cro_verdict.suggested_stop_loss,
                  takeProfit: report.cro_verdict.suggested_take_profit,
                  riskBudgetPct: report.cro_verdict.risk_budget_pct,
                  rationale: `[红蓝对抗推荐] ${report.bull_case.headline} | 证伪离场条件: ${report.cro_verdict.falsification_trigger}`,
                  nonce: Date.now(),
                })
              }
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2.5 font-sans text-xs font-bold text-white transition hover:bg-emerald-500 dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400"
            >
              带入此方案去右侧算仓审核
              <ArrowRightCircle className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

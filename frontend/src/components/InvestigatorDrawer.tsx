"use client";

import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpRight,
  Bot,
  CheckCircle2,
  FileSearch,
  Loader2,
  Maximize2,
  Send,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import {
  AgentStatusResponse,
  SecSearchResponse,
  TradeIntentInfo,
  fetchAgentStatus,
  searchSecFilings,
  streamInvestigate,
} from "@/lib/api";
import RiskCriticPanel from "@/components/RiskCriticPanel";
import { MarkdownReport } from "@/components/MarkdownReport";
import SpotlightBlock from "@/components/SpotlightBlock";

const EASE_EXPO = [0.16, 1, 0.3, 1] as const;

interface ToolTraceItem {
  tool: string;
  status: string;
  latency_ms?: number;
  preview?: string;
}

interface InvestigatorDrawerProps {
  open: boolean;
  onClose?: () => void;
  defaultSymbol: string;
  mode?: "drawer" | "split";
  onOpenFullWorkspace?: () => void;
}

const QUICK_PROMPTS = [
  {
    label: "结构与期权墙剖析",
    build: (sym: string) =>
      `请综合分析 ${sym} 当前的技术面趋势、RVOL 量价状态、Estimated GEX 期权墙 (Call/Put Wall / Zero Gamma) 与最新美股宏观 Regime。`,
  },
  {
    label: "SEC 10-K/Q 核心风险",
    build: (sym: string) =>
      `请执行并行 SEC 文件调研，提取 ${sym} 最新 10-K/10-Q 中的利润率变化、债务流动性与核心风险提示，务必附带原文出处引用。`,
  },
  {
    label: "宏观流动性与利率冲击",
    build: (sym: string) =>
      `结合目前美联储净流动性、美债 10Y-2Y 利差、HY OAS 与 VIX 期限结构，判断宏观环境对 ${sym} 估值与波动率的顺风或逆风。`,
  },
  {
    label: "未来10天催化与事件",
    build: (sym: string) =>
      `核查未来 10 天围绕 ${sym} 的宏观数据发布与财报日历催化，指出潜在跳空或 Gamma 挤仓风险点。`,
  },
  {
    label: "试算买入 50 股风控",
    build: (sym: string) =>
      `我想评估当前买入 50 股 ${sym} 的结构性赔率与证伪止损条件，请结合技术面、GEX 与过往教训给出风控前置建议。`,
  },
];

export default function InvestigatorDrawer({
  open,
  onClose,
  defaultSymbol,
  mode = "drawer",
  onOpenFullWorkspace,
}: InvestigatorDrawerProps) {
  const [rightTab, setRightTab] = useState<"risk" | "sec">("risk");
  const [drawerTab, setDrawerTab] = useState<"agent" | "sec" | "risk">("agent");

  const [agentStatus, setAgentStatus] = useState<AgentStatusResponse | null>(null);
  const [symbolInput, setSymbolInput] = useState<string>(defaultSymbol);
  const [queryInput, setQueryInput] = useState<string>(
    `请结合当前宏观 Regime、${defaultSymbol} 技术动量/期权墙以及 SEC 财报风险给出中文投研综述。`
  );

  // Agent SSE state (multi-turn thread persistence + token streaming)
  const [threadId, setThreadId] = useState<string>(() => `desk-${defaultSymbol}-${Date.now()}`);
  const [turns, setTurns] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [runningAgent, setRunningAgent] = useState(false);
  const [nodeStatus, setNodeStatus] = useState<string | null>(null);
  const [toolTraces, setToolTraces] = useState<ToolTraceItem[]>([]);
  const [answer, setAnswer] = useState<string>("");
  const [agentError, setAgentError] = useState<string | null>(null);
  const [tradeIntent, setTradeIntent] = useState<TradeIntentInfo | null>(null);
  const [riskPrefill, setRiskPrefill] = useState<{
    symbol: string;
    side: "buy" | "sell";
    qty: number;
    rationale: string;
  }>({
    symbol: defaultSymbol,
    side: "buy",
    qty: 50,
    rationale: "",
  });

  // 0-Token SEC search state
  const [secQuery, setSecQuery] = useState<string>(
    "revenue growth gross margin liquidity risk factors export"
  );
  const [secForm, setSecForm] = useState<string>("");
  const [secLoading, setSecLoading] = useState(false);
  const [secError, setSecError] = useState<string | null>(null);
  const [secResult, setSecResult] = useState<SecSearchResponse | null>(null);

  useEffect(() => {
    setSymbolInput(defaultSymbol);
    setRiskPrefill((prev) => ({ ...prev, symbol: defaultSymbol }));
    if (turns.length === 0) {
      setQueryInput(
        `请结合当前宏观 Regime、${defaultSymbol} 技术动量/期权墙以及 SEC 财报风险给出中文投研综述。`
      );
    }
  }, [defaultSymbol, turns.length]);

  useEffect(() => {
    if (!open && mode === "drawer") return;
    fetchAgentStatus()
      .then((res) => setAgentStatus(res))
      .catch(() => setAgentStatus(null));
  }, [open, mode]);

  async function executeAgentQuery(qText: string, symOverride?: string) {
    const cleanQ = qText.trim();
    const cleanSym = (symOverride || symbolInput).trim().toUpperCase();
    if (!cleanQ) return;

    setRunningAgent(true);
    setNodeStatus("准备宏观上下文与 MCP 工具链路...");
    setToolTraces([]);
    setAnswer("");
    setAgentError(null);
    setTradeIntent(null);

    let streamed = "";
    try {
      await streamInvestigate(
        {
          thread_id: threadId,
          query: cleanQ,
          symbol: cleanSym || null,
          history: turns,
        },
        (ev) => {
          if (ev.event === "status") {
            const detail = String(ev.data.detail ?? ev.data.node ?? "Processing...");
            setNodeStatus(detail);
          } else if (ev.event === "tool_trace") {
            setToolTraces((prev) => [
              ...prev,
              {
                tool: String(ev.data.tool ?? "mcp_tool"),
                status: String(ev.data.status ?? "ok"),
                latency_ms:
                  typeof ev.data.latency_ms === "number" ? ev.data.latency_ms : undefined,
                preview:
                  typeof ev.data.preview === "string" ? ev.data.preview : undefined,
              },
            ]);
          } else if (ev.event === "token") {
            const delta = String(ev.data.delta ?? "");
            streamed += delta;
            setAnswer(streamed);
          } else if (ev.event === "done") {
            const finalAns = String(ev.data.answer ?? streamed);
            setAnswer(finalAns);
            setNodeStatus(
              ev.data.forced_stop_reason
                ? `已完成 (边界触发: ${String(ev.data.forced_stop_reason)})`
                : `已完成 (${String(ev.data.steps_taken ?? 0)} 次工具调用)`
            );
            const intent = ev.data.trade_intent as TradeIntentInfo | undefined;
            if (intent) {
              setTradeIntent(intent);
              if (intent.detected) {
                setRiskPrefill({
                  symbol: (intent.symbol || cleanSym || defaultSymbol).toUpperCase(),
                  side: intent.side || "buy",
                  qty: intent.proposed_qty || 50,
                  rationale: finalAns.slice(0, 260),
                });
              }
            }
            if (finalAns) {
              setTurns((prev) => [
                ...prev.slice(-10),
                { role: "user", content: cleanQ },
                { role: "assistant", content: finalAns },
              ]);
            }
          } else if (ev.event === "error") {
            setAgentError(String(ev.data.message ?? "Investigator stream error."));
          }
        }
      );
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : "Agent request failed");
    } finally {
      setRunningAgent(false);
    }
  }

  async function handleRunAgent(e: React.FormEvent) {
    e.preventDefault();
    await executeAgentQuery(queryInput);
  }

  function handleResetThread() {
    setThreadId(`desk-${symbolInput || defaultSymbol}-${Date.now()}`);
    setTurns([]);
    setToolTraces([]);
    setAnswer("");
    setAgentError(null);
    setTradeIntent(null);
    setNodeStatus(null);
  }

  async function handleRunSecSearch(e: React.FormEvent) {
    e.preventDefault();
    const sym = symbolInput.trim().toUpperCase();
    if (!sym || !secQuery.trim()) return;
    setSecLoading(true);
    setSecError(null);
    try {
      const res = await searchSecFilings({
        symbol: sym,
        query: secQuery.trim(),
        form_type: secForm || null,
        top_k: 5,
      });
      setSecResult(res);
    } catch (err) {
      setSecError(err instanceof Error ? err.message : "SEC search failed");
    } finally {
      setSecLoading(false);
    }
  }

  const renderCopilotPane = () => (
    <div className="flex h-full flex-col space-y-4">
      {agentStatus && !agentStatus.llm_pro_ready && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 font-mono text-xs text-amber-200">
          <div className="font-semibold">LLM API Key 未配置</div>
          <p className="mt-1 text-[11px] text-amber-300/80">
            在 <code>.env</code> 填入 DeepSeek / OpenAI 兼容密钥即可启用多步推理；左侧仍可零 Token 直查 SEC 财报。
          </p>
        </div>
      )}

      {/* One-Click Chinese Research Prompt Chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          快捷投研指令:
        </span>
        {QUICK_PROMPTS.map((chip) => {
          const sym = (symbolInput || defaultSymbol).toUpperCase();
          return (
            <button
              key={chip.label}
              type="button"
              disabled={runningAgent}
              onClick={() => {
                const promptText = chip.build(sym);
                setQueryInput(promptText);
                void executeAgentQuery(promptText, sym);
              }}
              className="rounded-full border border-zinc-700 bg-zinc-900/90 px-2.5 py-1 font-mono text-[10px] text-zinc-200 transition hover:border-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {/* Chat Thread History + Streaming Output */}
      <div className="min-h-[260px] flex-1 space-y-3 overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
        {turns.length === 0 && !answer && !runningAgent && (
          <div className="flex h-48 flex-col items-center justify-center text-center text-xs text-zinc-400">
            <Bot className="mb-2 h-6 w-6 text-zinc-500" />
            <p className="font-medium text-zinc-200">
              Investigator 已加载 {symbolInput || defaultSymbol} 实时结构上下文
            </p>
            <p className="mt-1 max-w-md text-[11px] text-zinc-500">
              可点击上方快捷指令或输入自定义问题。若检测到买入/卖出意图，将自动把论据预填至右侧 Risk Critic 独立风控面板。
            </p>
          </div>
        )}

        {/* Prior completed turns rendered cleanly */}
        {(runningAgent || !answer ? turns : turns.slice(0, -2)).map((t, idx) =>
          t.role === "user" ? (
            <div key={`turn-${idx}`} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-[#F3F3F0] px-4 py-2.5 text-xs leading-relaxed text-[#0B0B0D] shadow-sm">
                <span className="mb-0.5 block font-mono text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
                  研究员提问 · YOU
                </span>
                {t.content}
              </div>
            </div>
          ) : (
            <div
              key={`turn-${idx}`}
              className="rounded-2xl rounded-tl-sm border border-zinc-200 bg-white/95 p-4 text-zinc-950 shadow-sm backdrop-blur-md dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-100"
            >
              <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                Investigator 历史回复
              </div>
              <MarkdownReport content={t.content} compact />
            </div>
          )
        )}

        {/* Active streaming turn prompt bubble when answer streaming starts */}
        {(runningAgent || answer) && turns.length >= 2 && !runningAgent && (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-[#F3F3F0] px-4 py-2.5 text-xs leading-relaxed text-[#0B0B0D] shadow-sm">
              <span className="mb-0.5 block font-mono text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
                研究员提问 · YOU
              </span>
              {turns[turns.length - 2]?.content}
            </div>
          </div>
        )}

        {nodeStatus && (
          <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 font-mono text-[11px] text-zinc-300">
            <Terminal className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <span>{nodeStatus}</span>
          </div>
        )}

        {toolTraces.length > 0 && (
          <div className="space-y-1.5">
            <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              FastMCP 工具调用链路 ({toolTraces.length})
            </div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {toolTraces.map((tr, idx) => (
                <div
                  key={`${tr.tool}-${idx}`}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 font-mono text-[11px]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 truncate font-semibold text-zinc-200">
                      <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" />
                      {tr.tool}
                    </span>
                    <span className="shrink-0 text-[10px] text-zinc-500">
                      {tr.latency_ms !== undefined ? `${tr.latency_ms}ms` : tr.status}
                    </span>
                  </div>
                  {tr.preview && (
                    <p className="mt-1 truncate text-[10px] text-zinc-400">{tr.preview}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {agentError && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 font-mono text-xs text-rose-200">
            {agentError}
          </div>
        )}

        {answer && (
          <div className="rounded-2xl border border-zinc-200 bg-white/95 p-5 text-zinc-950 shadow-sm backdrop-blur-md dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-100">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 pb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500 dark:border-white/10 dark:text-zinc-400">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                Investigator 结构化投研结论 (Read-Only Grounded)
              </span>
              <button
                type="button"
                onClick={() => {
                  setRiskPrefill({
                    symbol: (tradeIntent?.symbol || symbolInput || defaultSymbol).toUpperCase(),
                    side: tradeIntent?.side || "buy",
                    qty: tradeIntent?.proposed_qty || 50,
                    rationale: answer.slice(0, 260),
                  });
                  if (mode === "split") {
                    setRightTab("risk");
                  } else {
                    setDrawerTab("risk");
                  }
                }}
                className={`inline-flex items-center gap-1 rounded-full px-3 py-1 font-mono text-[10px] font-semibold transition ${
                  tradeIntent?.detected
                    ? "bg-zinc-950 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                    : "border border-zinc-300 bg-zinc-100 text-zinc-900 hover:bg-zinc-200 dark:border-white/20 dark:bg-white/10 dark:text-white dark:hover:bg-white/20"
                }`}
              >
                {tradeIntent?.detected
                  ? `交易意图 (${tradeIntent.side?.toUpperCase()} ${tradeIntent.proposed_qty}) → 同步至风控`
                  : "同步论证 → Risk Critic 风控审查"}
              </button>
            </div>
            <MarkdownReport content={answer} />
          </div>
        )}
      </div>

      {/* Input Composer */}
      <form onSubmit={handleRunAgent} className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
            placeholder="Ticker (如 AMD)"
            className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs uppercase text-white placeholder:text-zinc-500 focus:border-zinc-400 focus:outline-none sm:w-28"
          />
          <input
            type="text"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder="输入投研问题，或询问特定价格区间、10-K/Q 风险、做多/做空建议..."
            className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 font-sans text-xs text-white placeholder:text-zinc-500 focus:border-zinc-400 focus:outline-none"
          />
          <button
            type="submit"
            disabled={runningAgent}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#F3F3F0] px-4 py-2 font-mono text-xs font-semibold text-[#0B0B0D] transition hover:bg-white disabled:opacity-50"
          >
            {runningAgent ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            发送
          </button>
          {turns.length > 0 && (
            <button
              type="button"
              onClick={handleResetThread}
              className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
            >
              重置对话
            </button>
          )}
        </div>
      </form>
    </div>
  );

  const renderSecPane = () => (
    <div className="space-y-3">
      <form onSubmit={handleRunSecSearch} className="space-y-2.5">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
            placeholder="NVDA"
            className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs uppercase text-white focus:border-zinc-400 focus:outline-none sm:w-24"
          />
          <select
            value={secForm}
            onChange={(e) => setSecForm(e.target.value)}
            className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-white focus:border-zinc-400 focus:outline-none sm:w-28"
          >
            <option value="">10-K + 10-Q</option>
            <option value="10-K">10-K</option>
            <option value="10-Q">10-Q</option>
          </select>
          <input
            type="text"
            value={secQuery}
            onChange={(e) => setSecQuery(e.target.value)}
            placeholder="关键词，如 risk factors, gross margin, China export..."
            className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 font-sans text-xs text-white focus:border-zinc-400 focus:outline-none"
          />
          <button
            type="submit"
            disabled={secLoading}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-white px-4 py-2 font-mono text-xs font-medium text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-50"
          >
            {secLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileSearch className="h-3.5 w-3.5" />
            )}
            检索
          </button>
        </div>
      </form>

      {secError && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 font-mono text-xs text-rose-200">
          {secError}
        </div>
      )}

      {secResult && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-zinc-400">
            <span>
              模式: <strong className="text-white">{secResult.mode}</strong>
            </span>
            <span>
              已收录:{" "}
              {secResult.filings
                .map((f) => `${f.form_type} (${f.filing_date}, ${f.chunk_count} chunks)`)
                .join(" · ") || "PostgreSQL Cache"}
            </span>
          </div>

          <div className="max-h-[540px] space-y-2.5 overflow-y-auto pr-1">
            {secResult.chunks.map((ch) => (
              <div
                key={ch.chunk_id}
                className="rounded-xl border border-zinc-200 bg-white/95 p-4 text-zinc-950 backdrop-blur-md dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-100"
              >
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
                  <span className="font-semibold text-zinc-900 dark:text-white">
                    [{ch.symbol} {ch.form_type} {ch.filing_date}] · {ch.section_title}
                  </span>
                  <span className="text-zinc-500 dark:text-zinc-400">RRF {ch.rrf_score.toFixed(4)}</span>
                </div>
                <p className="text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">{ch.content}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  // Full Split-Screen Workstation Mode (inside Copilot & Risk Tab)
  if (mode === "split") {
    return (
      <div className="space-y-5">
        <SpotlightBlock tone="obsidian" tilt="subtle" className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-white">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900">
              <Bot className="h-4 w-4 text-white" />
            </span>
            <div>
              <h2 className="font-serif text-xl font-semibold tracking-tight text-white">
                双栏投研与风控台 · Copilot &amp; Risk Workbench
              </h2>
              <p className="font-mono text-[11px] text-zinc-400">
                左侧 Investigator 只读多步调研（含历史经验召回） · 右侧 上下文隔离 Risk Critic &amp; SEC 原文直查
              </p>
            </div>
          </div>
          {agentStatus?.phoenix_ui_url && (
            <a
              href={agentStatus.phoenix_ui_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 font-mono text-[11px] text-zinc-200 hover:border-zinc-500 hover:text-white"
            >
              Phoenix 链路追踪
              <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          )}
        </SpotlightBlock>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <SpotlightBlock tone="obsidian" tilt="subtle" className="p-5 lg:col-span-7">
            {renderCopilotPane()}
          </SpotlightBlock>

          <SpotlightBlock tone="obsidian" tilt="subtle" className="p-5 lg:col-span-5">
            <div className="mb-4 flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="inline-flex rounded-full border border-zinc-800 bg-zinc-900 p-0.5 font-mono text-[11px]">
                <button
                  type="button"
                  onClick={() => setRightTab("risk")}
                  className={`rounded-full px-3 py-1 transition ${
                    rightTab === "risk" ? "bg-white font-semibold text-zinc-950" : "text-zinc-400 hover:text-white"
                  }`}
                >
                  Risk Critic 风控 &amp; HITL
                </button>
                <button
                  type="button"
                  onClick={() => setRightTab("sec")}
                  className={`rounded-full px-3 py-1 transition ${
                    rightTab === "sec" ? "bg-white font-semibold text-zinc-950" : "text-zinc-400 hover:text-white"
                  }`}
                >
                  SEC 财报直查 (0-Token)
                </button>
              </div>
              <span className="font-mono text-[10px] text-zinc-500">上下文严格隔离</span>
            </div>

            {rightTab === "risk" ? (
              <RiskCriticPanel
                defaultSymbol={riskPrefill.symbol || symbolInput || defaultSymbol}
                prefillSide={riskPrefill.side}
                prefillQty={riskPrefill.qty}
                prefillRationale={riskPrefill.rationale}
              />
            ) : (
              renderSecPane()
            )}
          </SpotlightBlock>
        </div>
      </div>
    );
  }

  // Non-blocking Side Dock Drawer inside Cockpit
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: "100%", opacity: 0.6 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0.6 }}
          transition={{ duration: 0.3, ease: EASE_EXPO }}
          className="velvet-black-block fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col rounded-none border-l border-white/15 text-zinc-100 shadow-[-24px_0_70px_-15px_rgba(0,0,0,0.75)]"
        >
          {/* Header Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-5 py-3.5">
            <div className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900">
                <Bot className="h-3.5 w-3.5 text-zinc-100" />
              </span>
              <div>
                <h2 className="font-serif text-base tracking-tight text-white">
                  AI 侧边协查舱 ({symbolInput || defaultSymbol})
                </h2>
                <p className="font-mono text-[10px] text-zinc-400">
                  非阻塞停靠 · 可随时点击左侧切换任意股票 K 线
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              {onOpenFullWorkspace && (
                <button
                  type="button"
                  onClick={() => {
                    onClose?.();
                    onOpenFullWorkspace();
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] text-zinc-200 hover:border-zinc-500 hover:text-white"
                >
                  <Maximize2 className="h-3 w-3" />
                  双栏全屏台
                </button>
              )}
              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-zinc-800 p-1.5 text-zinc-400 transition hover:border-zinc-600 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {/* Sub-tabs inside Side Dock */}
          <div className="flex items-center gap-1 border-b border-zinc-800/80 bg-zinc-950/60 px-5 py-2 font-mono text-[11px]">
            <button
              type="button"
              onClick={() => setDrawerTab("agent")}
              className={`rounded-full px-3 py-1 transition ${
                drawerTab === "agent" ? "bg-white text-zinc-950" : "text-zinc-400 hover:text-white"
              }`}
            >
              Investigator 对话
            </button>
            <button
              type="button"
              onClick={() => setDrawerTab("risk")}
              className={`rounded-full px-3 py-1 transition ${
                drawerTab === "risk" ? "bg-white text-zinc-950" : "text-zinc-400 hover:text-white"
              }`}
            >
              Risk Critic 风控
            </button>
            <button
              type="button"
              onClick={() => setDrawerTab("sec")}
              className={`rounded-full px-3 py-1 transition ${
                drawerTab === "sec" ? "bg-white text-zinc-950" : "text-zinc-400 hover:text-white"
              }`}
            >
              SEC 财报检索
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5">
            {drawerTab === "agent" ? (
              renderCopilotPane()
            ) : drawerTab === "risk" ? (
              <RiskCriticPanel
                defaultSymbol={riskPrefill.symbol || symbolInput || defaultSymbol}
                prefillSide={riskPrefill.side}
                prefillQty={riskPrefill.qty}
                prefillRationale={riskPrefill.rationale}
              />
            ) : (
              renderSecPane()
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

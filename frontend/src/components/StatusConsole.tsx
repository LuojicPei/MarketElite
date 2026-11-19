"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Cpu,
  Database,
  Eye,
  GitBranch,
  Layers,
  Pause,
  Play,
  RefreshCw,
  ServerCrash,
  ShieldAlert,
  Terminal,
  Zap,
} from "lucide-react";
import {
  ArchitectureStage,
  ComponentHealth,
  fetchArchitecture,
  fetchHealth,
  HealthResponse,
} from "@/lib/api";

const EASE_EXPO = [0.16, 1, 0.3, 1] as const;

const FALLBACK_STAGES: ArchitectureStage[] = [
  {
    id: "base",
    order: 1,
    tag: "确定性底座 · Zero Token",
    title: "Market Cockpit & Quant Pipeline",
    subtitle: "宏观流动性 / Estimated GEX / 广度 / 熔断缓存",
    summary:
      "通过 ARQ 定时拉取 Alpaca、FRED、CFTC、Binance、Finnhub/FMP，由纯 Python 算子产出净流动性、Call/Put Wall、Zero Gamma、RVOL 与每日 Market Regime 快照写入 Redis 双 TTL 热缓存。",
    components: [
      "ARQ Worker",
      "Redis Circuit Breaker",
      "PostgreSQL 16 + pgvector",
      "Lightweight Charts / ECharts",
    ],
    phase: "Phase 1–2",
  },
  {
    id: "investigator",
    order: 2,
    tag: "Agent 1 · 动态规划主脑",
    title: "Investigator Agent",
    subtitle: "LangGraph ReAct + FastMCP + SEC 混合 RAG",
    summary:
      "基于大盘 Regime 压缩上下文，动态分支调用 FastMCP (Streamable HTTP) 只读工具；遇到万字 SEC 10-K/10-Q 时触发并行子调研节点隔离长文本并检索 pgvector + BM25 混合索引。",
    components: [
      "LangGraph StateGraph",
      "FastMCP Streamable HTTP",
      "Deadlock Hash Guard",
      "Rolling Context Trim",
    ],
    phase: "Phase 3",
  },
  {
    id: "critic",
    order: 3,
    tag: "Agent 2 · 独立对抗裁判",
    title: "Risk Critic & HITL Executor",
    subtitle: "Actor-Critic 隔离审查 + 真实模拟盘下单",
    summary:
      "仅在交易意图时条件路由触发。在屏蔽情绪废话的独立上下文中核验逆势风险、财报日历、证伪止损与 1% 风险预算股数；interrupt() 持久化挂起，人工确认后下达 Alpaca Bracket 单。",
    components: [
      "AsyncPostgresSaver",
      "interrupt() HITL",
      "1% Risk Sizing",
      "Alpaca Paper Bracket",
    ],
    phase: "Phase 4",
  },
  {
    id: "watchdog",
    order: 4,
    tag: "Agent 3 · 24h 自治闭环",
    title: "Watchdog & Reflection Agent",
    subtitle: "主动异动巡检 + 四象限归因 + 长期记忆",
    summary:
      "后台监听盘中放量破位与跌破 Zero Gamma 事件主动调查预警；在模拟单平仓后自动跑 Alpha 归因并沉淀错题记忆至 pgvector，同时运行 Arize Phoenix 黄金评测集闭环。",
    components: [
      "Event Watchdog",
      "T+5/T+20 Alpha Eval",
      "Episodic pgvector Memory",
      "Arize Phoenix Trace",
    ],
    phase: "Phase 5",
  },
];

const STAGE_MOCK_FLOW: Record<
  string,
  { trigger: string; guardrails: string[]; output: string }
> = {
  base: {
    trigger: "ARQ Cron (08:30 ET) 聚合 FRED + Alpaca 期权链",
    guardrails: ["Soft/Hard 双 TTL 缓存", "连续 5 次 429 自动熔断 60s", "0 LLM Token 数学计算"],
    output: "Regime: 谨慎防守 | SPY Zero Gamma: 584.2 | HY OAS: 3.12% (+9bp)",
  },
  investigator: {
    trigger: "用户提问: 「NVDA 今天跌了 5%，能抄底吗？」",
    guardrails: ["Tool 指纹防死循环", "SEC 10-K 子图隔离压缩", "45s 超时优雅降级"],
    output: "动态查明 SOXX 仅跌 0.8%，NVDA 属放量破位 (RVOL 2.4) 且 4 天后发财报，暂不盲目接刀。",
  },
  critic: {
    trigger: "条件路由激活: 检测到「计划买入 200 股」高风险意图",
    guardrails: ["隔离情感对话上下文", "1% 最大回撤反推股数", "HITL interrupt() 落盘挂起"],
    output: "驳回 200 股冲动仓位 -> 建议减至 45 股，硬止损设 Put Wall 下方，等待人工卡片确认。",
  },
  watchdog: {
    trigger: "事件驱动: Alpaca Bracket 止盈/止损单触发平仓",
    guardrails: ["T+5 / T+20 客观市场验证", "对比 SPY 剥离 Beta/Alpha", "错题写入 pgvector 长期记忆"],
    output: "归因结论: 严格按止损执行（好过程），跑赢同期 SPY +1.8%，预警准确率已同步 Arize Phoenix。",
  },
};

function handleSpotlightMove(e: React.MouseEvent<HTMLElement>) {
  const rect = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--mx", `${e.clientX - rect.left}px`);
  e.currentTarget.style.setProperty("--my", `${e.clientY - rect.top}px`);
}

function StatusDot({
  status,
}: {
  status: "up" | "down" | "disabled" | "standby";
}) {
  const styles = {
    up: "bg-emerald-500",
    down: "bg-rose-500",
    disabled: "bg-zinc-400",
    standby: "bg-amber-500",
  }[status];

  return (
    <span className="relative flex h-2.5 w-2.5 items-center justify-center">
      <span
        className={`relative inline-flex h-2 w-2 rounded-full ${styles} ${
          status === "up" ? "pulse-ring" : ""
        }`}
      />
    </span>
  );
}

function InfraBlock({
  title,
  subtitle,
  icon: Icon,
  health,
  variant,
  delay,
}: {
  title: string;
  subtitle: string;
  icon: React.ElementType;
  health?: ComponentHealth;
  variant: "black" | "white";
  delay: number;
}) {
  const isDark = variant === "black";
  const status = health?.status ?? "down";
  const badgeText =
    status === "up" ? "ONLINE" : status === "disabled" ? "DISABLED" : "OFFLINE";

  const statusTextColor =
    status === "up"
      ? isDark
        ? "text-emerald-400"
        : "text-emerald-700"
      : status === "disabled"
      ? "text-zinc-400"
      : isDark
      ? "text-rose-400"
      : "text-rose-600";

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: EASE_EXPO }}
      onMouseMove={handleSpotlightMove}
      className={`${
        isDark ? "velvet-black-block text-zinc-100" : "velvet-white-block text-zinc-900"
      } rounded-2xl p-5 flex flex-col justify-between transition-transform duration-300 hover:-translate-y-0.5`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-9 w-9 items-center justify-center rounded-xl border ${
              isDark
                ? "border-white/15 bg-white/[0.06] text-white"
                : "border-zinc-200 bg-zinc-50 text-zinc-900"
            }`}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <h3
              className={`text-sm font-semibold tracking-tight ${
                isDark ? "text-white" : "text-zinc-950"
              }`}
            >
              {title}
            </h3>
            <p className={`text-xs ${isDark ? "text-zinc-400" : "text-zinc-500"}`}>
              {subtitle}
            </p>
          </div>
        </div>

        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-medium ${
            isDark
              ? "border-white/15 bg-white/[0.05]"
              : "border-zinc-200 bg-zinc-50"
          } ${statusTextColor}`}
        >
          <StatusDot status={status} />
          {badgeText}
        </span>
      </div>

      <div
        className={`mt-5 flex items-center justify-between border-t pt-3 text-xs ${
          isDark ? "border-white/10" : "border-zinc-200"
        }`}
      >
        <span
          className={`truncate font-mono ${isDark ? "text-zinc-400" : "text-zinc-500"}`}
          title={health?.detail}
        >
          {health?.detail || "Awaiting backend probe..."}
        </span>
        <span
          className={`ml-2 shrink-0 font-mono font-medium tabular-nums ${
            isDark ? "text-white" : "text-zinc-950"
          }`}
        >
          {health ? `${health.latency_ms.toFixed(1)} ms` : "-- ms"}
        </span>
      </div>

      {health?.ui_url && status === "up" && (
        <a
          href={health.ui_url}
          target="_blank"
          rel="noreferrer"
          className={`mt-2.5 inline-flex items-center gap-1 text-xs font-medium transition-opacity hover:opacity-75 ${
            isDark ? "text-white" : "text-zinc-950"
          }`}
        >
          打开 Phoenix Trace 面板
          <ArrowUpRight className="h-3.5 w-3.5" />
        </a>
      )}
    </motion.div>
  );
}

export default function StatusConsole() {
  const [activeTab, setActiveTab] = useState<"telemetry" | "choreography">("telemetry");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [stages, setStages] = useState<ArchitectureStage[]>(FALLBACK_STAGES);
  const [loading, setLoading] = useState<boolean>(true);
  const [apiError, setApiError] = useState<string | null>(null);
  const [roundTripMs, setRoundTripMs] = useState<number | null>(null);

  const [selectedStageId, setSelectedStageId] = useState<string>("base");
  const [autoPlay, setAutoPlay] = useState<boolean>(false);

  const probeSystem = useCallback(async () => {
    setLoading(true);
    setApiError(null);
    const t0 = performance.now();
    try {
      const [h, arch] = await Promise.all([fetchHealth(), fetchArchitecture()]);
      setHealth(h);
      if (arch?.stages?.length) {
        setStages(arch.stages);
      }
      setRoundTripMs(Math.round(performance.now() - t0));
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Backend API unreachable");
      setHealth(null);
      setRoundTripMs(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    probeSystem();
  }, [probeSystem]);

  useEffect(() => {
    if (!autoPlay || activeTab !== "choreography") return;
    const timer = setInterval(() => {
      setSelectedStageId((prev) => {
        const idx = stages.findIndex((s) => s.id === prev);
        return stages[(idx + 1) % stages.length].id;
      });
    }, 2800);
    return () => clearInterval(timer);
  }, [autoPlay, activeTab, stages]);

  const readinessStats = useMemo(() => {
    const items = health?.integrations ?? [];
    if (!items.length) return { ready: 0, total: 9, pct: 0 };
    const ready = items.filter((i) => i.configured).length;
    return { ready, total: items.length, pct: Math.round((ready / items.length) * 100) };
  }, [health]);

  const activeStage = useMemo(
    () => stages.find((s) => s.id === selectedStageId) ?? stages[0],
    [stages, selectedStageId]
  );

  const overallStatus = useMemo(() => {
    if (apiError || !health) return { label: "API STANDBY", tone: "standby" as const };
    if (health.status === "ok") return { label: "CORE ONLINE", tone: "up" as const };
    if (health.status === "degraded") return { label: "DEGRADED", tone: "standby" as const };
    return { label: "INITIALIZING", tone: "down" as const };
  }, [apiError, health]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Gallery Minimal Top Bar */}
      <header className="sticky top-0 z-30 border-b border-zinc-200/80 bg-[#F6F6F3]/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-obsidian-950 text-white shadow-sm">
              <Activity className="h-[18px] w-[18px]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-serif text-xl tracking-tight text-zinc-950">
                  MarketElite
                </span>
                <span className="rounded-full border border-zinc-300 bg-white px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
                  Phase 0
                </span>
              </div>
              <p className="text-xs text-zinc-500">
                US Equity Structure &amp; Multi-Agent Risk Terminal
              </p>
            </div>
          </div>

          {/* Monochrome Sliding Segmented Switch */}
          <div className="flex items-center rounded-full border border-zinc-200 bg-white p-1 shadow-sm">
            {(
              [
                { id: "telemetry", label: "系统健康探针", icon: Cpu },
                { id: "choreography", label: "Agent 闭环流转预览", icon: GitBranch },
              ] as const
            ).map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`relative flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
                    isActive ? "text-white" : "text-zinc-500 hover:text-zinc-950"
                  }`}
                >
                  {isActive && (
                    <motion.span
                      layoutId="active-nav-pill"
                      transition={{ type: "spring", stiffness: 420, damping: 32 }}
                      className="absolute inset-0 rounded-full bg-obsidian-950"
                    />
                  )}
                  <Icon className="relative z-10 h-3.5 w-3.5" />
                  <span className="relative z-10">{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Status & Jet-Black Re-probe Trigger */}
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs shadow-sm">
              <StatusDot status={overallStatus.tone} />
              <span className="font-medium text-zinc-900">{overallStatus.label}</span>
              {roundTripMs !== null && (
                <span className="border-l border-zinc-200 pl-2 tabular-nums text-zinc-500">
                  {roundTripMs} ms
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={probeSystem}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-full bg-obsidian-950 px-4 py-1.5 text-xs font-medium text-white shadow-sm transition-all hover:bg-zinc-800 active:scale-[0.98] disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              刷新探针
            </button>
          </div>
        </div>
      </header>

      {/* Main Gallery Stage */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-7">
        <AnimatePresence mode="wait">
          {activeTab === "telemetry" ? (
            <motion.div
              key="telemetry"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.28, ease: EASE_EXPO }}
              className="space-y-5"
            >
              {/* Standby Banner if FastAPI isn't started yet */}
              {apiError && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.99 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="velvet-white-block flex flex-col justify-between gap-4 rounded-2xl border-amber-300/70 p-4 sm:flex-row sm:items-center"
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700 border border-amber-200">
                      <ServerCrash className="h-4 w-4" />
                    </div>
                    <div>
                      <h2 className="text-sm font-semibold text-zinc-950">
                        后端 FastAPI 探针暂未连接 ({apiError})
                      </h2>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        请启动本地后端服务，页面即可实时采集 PostgreSQL / Redis / Phoenix 与密钥就绪状态。
                      </p>
                    </div>
                  </div>
                  <div className="shrink-0 rounded-xl bg-obsidian-950 px-3.5 py-2 font-mono text-xs text-zinc-100">
                    cd backend &amp;&amp; .\.venv\Scripts\python.exe run.py
                  </div>
                </motion.div>
              )}

              {/* Hero Block: Deep Obsidian Velvet Black Anchor */}
              <div
                onMouseMove={handleSpotlightMove}
                className="velvet-black-block rounded-2xl p-6 text-zinc-100"
              >
                <div className="flex flex-col justify-between gap-5 md:flex-row md:items-center">
                  <div className="space-y-1.5">
                    <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-400">
                      SYSTEM READINESS // LIGHT SILK × MONOCHROME
                    </div>
                    <h1 className="font-serif text-3xl tracking-tight text-white">
                      工程基础设施实时遥测台
                    </h1>
                    <p className="max-w-2xl text-xs leading-relaxed text-zinc-400">
                      前端已采用「白底丝绒 × 黑白相间组件」视觉基线；PostgreSQL (pgvector)、Redis 缓存锁及 Arize Phoenix 可观测探针均已就绪，敏感密钥严格保留在服务端脱敏校验。
                    </p>
                  </div>

                  {/* Nested Crisp White Metric Inset inside Black Hero */}
                  <div className="w-full shrink-0 rounded-xl bg-white p-4 text-zinc-900 shadow-sm md:w-72">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-zinc-600">数据源与 LLM 就绪度</span>
                      <span className="font-mono font-bold tabular-nums text-zinc-950">
                        {readinessStats.ready} / {readinessStats.total}
                      </span>
                    </div>
                    <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-zinc-200">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${readinessStats.pct}%` }}
                        transition={{ duration: 0.7, ease: EASE_EXPO }}
                        className="h-full rounded-full bg-obsidian-950"
                      />
                    </div>
                    <div className="mt-2.5 flex items-center justify-between font-mono text-[11px] text-zinc-500">
                      <span>{health?.env?.toUpperCase() || "LOCAL"}</span>
                      <span className="tabular-nums">
                        {health?.checked_at
                          ? new Date(health.checked_at).toLocaleTimeString()
                          : "--:--:--"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Alternating White / Black / White Infrastructure Row */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <InfraBlock
                  title="PostgreSQL 16 + pgvector"
                  subtitle="业务账本 / Checkpoint / SEC 混合 RAG"
                  icon={Database}
                  health={health?.components.postgres}
                  variant="white"
                  delay={0.05}
                />
                <InfraBlock
                  title="Redis 7 Store"
                  subtitle="驾驶舱热缓存 / 熔断器 / 防重入锁"
                  icon={Zap}
                  health={health?.components.redis}
                  variant="black"
                  delay={0.12}
                />
                <InfraBlock
                  title="Arize Phoenix"
                  subtitle="单容器 OpenTelemetry Trace & Eval"
                  icon={Eye}
                  health={health?.components.phoenix}
                  variant="white"
                  delay={0.19}
                />
              </div>

              {/* Clean Gallery White Matrix */}
              <div
                onMouseMove={handleSpotlightMove}
                className="velvet-white-block rounded-2xl p-5"
              >
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 pb-3">
                  <div>
                    <h2 className="text-sm font-semibold text-zinc-950">
                      美股数据源与大模型网关接入矩阵
                    </h2>
                    <p className="text-xs text-zinc-500">
                      免账号官方源开箱即用；其余在根目录{" "}
                      <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-zinc-800">
                        .env
                      </code>{" "}
                      填入免费 Key 即可自动点亮。
                    </p>
                  </div>
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-obsidian-950 px-3 py-1 font-mono text-[11px] text-white">
                    <Terminal className="h-3 w-3" />
                    python -m scripts.check_keys
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {(
                    health?.integrations ?? [
                      {
                        id: "alpaca",
                        name: "Alpaca Market & Paper Trading",
                        category: "market_data",
                        requires_key: true,
                        configured: false,
                        mode: "Paper",
                      },
                      {
                        id: "fred",
                        name: "FRED Macro & Liquidity",
                        category: "macro",
                        requires_key: true,
                        configured: false,
                        mode: "API Key",
                      },
                      {
                        id: "finnhub",
                        name: "Finnhub Earnings & EPS",
                        category: "fundamentals",
                        requires_key: true,
                        configured: false,
                        mode: "Free Tier",
                      },
                      {
                        id: "fmp",
                        name: "FMP Economic Calendar",
                        category: "macro",
                        requires_key: true,
                        configured: false,
                        mode: "Free Tier",
                      },
                      {
                        id: "binance",
                        name: "Binance Vision (BTCUSDT)",
                        category: "crypto",
                        requires_key: false,
                        configured: true,
                        mode: "Keyless Public",
                      },
                      {
                        id: "cftc",
                        name: "CFTC COT Socrata JSON",
                        category: "positioning",
                        requires_key: false,
                        configured: true,
                        mode: "Keyless Public",
                      },
                      {
                        id: "sec_edgar",
                        name: "SEC EDGAR (10-K / 10-Q / 8-K)",
                        category: "rag",
                        requires_key: false,
                        configured: false,
                        mode: "Header Policy",
                      },
                      {
                        id: "llm_fast",
                        name: "LLM Fast Tier",
                        category: "llm",
                        requires_key: true,
                        configured: false,
                        mode: "OpenAI-Compat",
                      },
                      {
                        id: "llm_pro",
                        name: "LLM Reasoning Tier",
                        category: "llm",
                        requires_key: true,
                        configured: false,
                        mode: "OpenAI-Compat",
                      },
                    ]
                  ).map((item, idx) => (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.35, delay: 0.03 * idx, ease: EASE_EXPO }}
                      className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200/90 bg-[#FAF9F6] px-3.5 py-3 transition-colors hover:border-zinc-400"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-zinc-900">
                          {item.name}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
                          <span>{item.mode}</span>
                          <span>·</span>
                          <span>{item.requires_key ? "API Key" : "Zero-Key"}</span>
                        </div>
                      </div>
                      {item.configured ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-obsidian-950 px-2.5 py-0.5 font-mono text-[11px] text-emerald-400">
                          <CheckCircle2 className="h-3 w-3" />
                          READY
                        </span>
                      ) : (
                        <span className="inline-flex shrink-0 items-center rounded-full border border-zinc-300 bg-white px-2.5 py-0.5 font-mono text-[11px] text-amber-700">
                          PENDING
                        </span>
                      )}
                    </motion.div>
                  ))}
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="choreography"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.28, ease: EASE_EXPO }}
              className="space-y-5"
            >
              {/* Monochrome Header Card */}
              <div
                onMouseMove={handleSpotlightMove}
                className="velvet-black-block flex flex-col justify-between gap-4 rounded-2xl p-6 text-white sm:flex-row sm:items-center"
              >
                <div>
                  <div className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest text-zinc-400">
                    <Layers className="h-3.5 w-3.5" />
                    <span>1 Deterministic Cockpit + 3 Closed-Loop Agents</span>
                  </div>
                  <h1 className="mt-1 font-serif text-3xl tracking-tight text-white">
                    闭环工作流编排与风控流转预览
                  </h1>
                  <p className="mt-1 text-xs text-zinc-400">
                    点击下方黑白交替节点或开启自动演示，预览「数据底座 → 自主调查 → 独立风控对抗 → 模拟实盘 → 自我反思」的完整链路。
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setAutoPlay((v) => !v)}
                  className={`inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold transition-all active:scale-[0.98] ${
                    autoPlay
                      ? "bg-emerald-500 text-zinc-950"
                      : "bg-white text-zinc-950 hover:bg-zinc-200"
                  }`}
                >
                  {autoPlay ? (
                    <>
                      <Pause className="h-3.5 w-3.5" />
                      暂停自动演示
                    </>
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5" />
                      演示一次全链路流转
                    </>
                  )}
                </button>
              </div>

              {/* 4-Stage Alternating Monochrome Track */}
              <div className="grid grid-cols-1 gap-3.5 md:grid-cols-4">
                {stages.map((stage, index) => {
                  const isSelected = stage.id === activeStage.id;
                  const stageIcon = [Database, Bot, ShieldAlert, Eye][index] || Bot;
                  const StageIcon = stageIcon;

                  return (
                    <button
                      key={stage.id}
                      type="button"
                      onClick={() => {
                        setAutoPlay(false);
                        setSelectedStageId(stage.id);
                      }}
                      onMouseMove={handleSpotlightMove}
                      className={`group relative flex flex-col justify-between rounded-2xl p-4 text-left transition-all duration-300 ${
                        isSelected
                          ? "velvet-black-block text-white -translate-y-0.5"
                          : "velvet-white-block text-zinc-900 hover:-translate-y-0.5"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span
                          className={`font-mono text-[11px] font-semibold ${
                            isSelected ? "text-zinc-300" : "text-zinc-500"
                          }`}
                        >
                          0{stage.order} · {stage.phase}
                        </span>
                        <div
                          className={`flex h-7 w-7 items-center justify-center rounded-lg border transition-colors ${
                            isSelected
                              ? "border-white/20 bg-white/10 text-white"
                              : "border-zinc-200 bg-zinc-50 text-zinc-700"
                          }`}
                        >
                          <StageIcon className="h-3.5 w-3.5" />
                        </div>
                      </div>

                      <div className="mt-3">
                        <div
                          className={`text-[11px] font-medium ${
                            isSelected ? "text-zinc-400" : "text-zinc-500"
                          }`}
                        >
                          {stage.tag}
                        </div>
                        <div
                          className={`mt-0.5 text-sm font-semibold ${
                            isSelected ? "text-white" : "text-zinc-950"
                          }`}
                        >
                          {stage.title}
                        </div>
                        <div
                          className={`mt-1 text-xs ${
                            isSelected ? "text-zinc-400" : "text-zinc-500"
                          }`}
                        >
                          {stage.subtitle}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Alternating Black + White Detail Inspector */}
              <AnimatePresence mode="wait">
                <motion.div
                  key={activeStage.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.32, ease: EASE_EXPO }}
                  className="grid grid-cols-1 gap-4 lg:grid-cols-12"
                >
                  {/* White Gallery Detail Panel */}
                  <div
                    onMouseMove={handleSpotlightMove}
                    className="velvet-white-block space-y-4 rounded-2xl p-6 lg:col-span-7"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-obsidian-950 px-3 py-0.5 font-mono text-xs font-medium text-white">
                        {activeStage.tag}
                      </span>
                      <span className="rounded-full border border-zinc-300 bg-zinc-50 px-3 py-0.5 font-mono text-xs text-zinc-700">
                        目标交付：{activeStage.phase}
                      </span>
                    </div>

                    <div>
                      <h2 className="font-serif text-2xl text-zinc-950">
                        {activeStage.title}
                      </h2>
                      <p className="mt-2 text-sm leading-relaxed text-zinc-600">
                        {activeStage.summary}
                      </p>
                    </div>

                    <div>
                      <div className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                        Core Engineering Components
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {activeStage.components.map((comp) => (
                          <span
                            key={comp}
                            className="rounded-lg border border-zinc-200 bg-[#FAF9F6] px-2.5 py-1 font-mono text-xs text-zinc-800"
                          >
                            {comp}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Black Obsidian Simulation Trace Panel */}
                  <div
                    onMouseMove={handleSpotlightMove}
                    className="velvet-black-block flex flex-col justify-between rounded-2xl p-6 text-zinc-100 lg:col-span-5"
                  >
                    <div className="space-y-3.5">
                      <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
                        <span className="font-mono text-xs font-semibold text-white">
                          SIMULATED EXECUTION TRACE
                        </span>
                        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-400">
                          <StatusDot status="up" />
                          GUARDED
                        </span>
                      </div>

                      <div>
                        <div className="text-[11px] font-medium text-zinc-400">
                          触发信号
                        </div>
                        <div className="mt-1 rounded-xl border border-white/10 bg-black/50 p-2.5 font-mono text-xs text-zinc-100">
                          {STAGE_MOCK_FLOW[activeStage.id]?.trigger}
                        </div>
                      </div>

                      <div>
                        <div className="text-[11px] font-medium text-zinc-400">
                          内置异常兜底与风控栅栏
                        </div>
                        <ul className="mt-1.5 space-y-1.5">
                          {STAGE_MOCK_FLOW[activeStage.id]?.guardrails.map((g) => (
                            <li
                              key={g}
                              className="flex items-center gap-2 text-xs text-zinc-300"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                              <span>{g}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    <div className="mt-4 rounded-xl bg-white p-3 text-zinc-900">
                      <div className="font-mono text-[11px] font-semibold uppercase text-emerald-700">
                        Output Artifact
                      </div>
                      <p className="mt-0.5 font-mono text-xs leading-relaxed text-zinc-900">
                        {STAGE_MOCK_FLOW[activeStage.id]?.output}
                      </p>
                    </div>
                  </div>
                </motion.div>
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

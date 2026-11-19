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
  Play,
  Pause,
  RefreshCw,
  ServerCrash,
  ShieldAlert,
  Sparkles,
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

function StatusDot({ status }: { status: "up" | "down" | "disabled" | "standby" }) {
  const styles = {
    up: "bg-bull",
    down: "bg-bear",
    disabled: "bg-slate-500",
    standby: "bg-caution",
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

function InfraCard({
  title,
  subtitle,
  icon: Icon,
  health,
  delay,
}: {
  title: string;
  subtitle: string;
  icon: React.ElementType;
  health?: ComponentHealth;
  delay: number;
}) {
  const status = health?.status ?? "down";
  const badgeText =
    status === "up" ? "ONLINE" : status === "disabled" ? "DISABLED" : "OFFLINE";
  const badgeClass =
    status === "up"
      ? "border-bull/30 bg-bull/10 text-bull"
      : status === "disabled"
      ? "border-white/10 bg-white/5 text-slate-400"
      : "border-bear/30 bg-bear/10 text-bear";

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: EASE_EXPO }}
      className="glass-panel rounded-xl p-4 transition-colors duration-200 hover:border-white/[0.14]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-obsidian-950/90 text-signal">
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-slate-100">{title}</h3>
            <p className="text-xs text-slate-400">{subtitle}</p>
          </div>
        </div>

        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] font-medium ${badgeClass}`}
        >
          <StatusDot status={status} />
          {badgeText}
        </span>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-white/[0.06] pt-3 text-xs">
        <span className="truncate font-mono text-slate-400" title={health?.detail}>
          {health?.detail || "Awaiting backend telemetry..."}
        </span>
        <span className="ml-2 shrink-0 font-mono tabular-nums text-slate-300">
          {health ? `${health.latency_ms.toFixed(1)} ms` : "-- ms"}
        </span>
      </div>

      {health?.ui_url && status === "up" && (
        <a
          href={health.ui_url}
          target="_blank"
          rel="noreferrer"
          className="mt-2.5 inline-flex items-center gap-1 text-xs font-medium text-signal transition-colors hover:text-sky-300"
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

  // Smooth auto-play pipeline flow preview
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
      {/* Top Glass Command Bar */}
      <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-obsidian-950/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <div className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-signal/30 bg-signal/10 text-signal shadow-glow">
              <Activity className="h-[18px] w-[18px]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-bold tracking-tight text-white">
                  MarketElite
                </span>
                <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-400">
                  Phase 0 · Foundation
                </span>
              </div>
              <p className="text-xs text-slate-400">
                US Equity Structure &amp; Multi-Agent Risk Workstation
              </p>
            </div>
          </div>

          {/* Sliding Segmented Navigation */}
          <div className="flex items-center rounded-lg border border-white/[0.08] bg-obsidian-900/90 p-1">
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
                  className={`relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    isActive ? "text-white" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {isActive && (
                    <motion.span
                      layoutId="active-nav-pill"
                      transition={{ type: "spring", stiffness: 420, damping: 32 }}
                      className="absolute inset-0 rounded-md border border-white/10 bg-white/[0.08] shadow-hairline"
                    />
                  )}
                  <Icon className="relative z-10 h-3.5 w-3.5" />
                  <span className="relative z-10">{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Live Status & Re-probe Trigger */}
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-obsidian-900/80 px-3 py-1.5 font-mono text-xs">
              <StatusDot status={overallStatus.tone} />
              <span className="text-slate-200">{overallStatus.label}</span>
              {roundTripMs !== null && (
                <span className="border-l border-white/10 pl-2 tabular-nums text-slate-400">
                  {roundTripMs} ms
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={probeSystem}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-medium text-slate-200 transition-all hover:border-signal/40 hover:bg-signal/10 hover:text-white active:scale-[0.98] disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin text-signal" : ""}`} />
              刷新探针
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-7">
        <AnimatePresence mode="wait">
          {activeTab === "telemetry" ? (
            <motion.div
              key="telemetry"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.28, ease: EASE_EXPO }}
              className="space-y-6"
            >
              {/* Standby Notice if FastAPI is not started yet */}
              {apiError && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.99 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="glass-panel flex flex-col justify-between gap-4 rounded-xl border-caution/30 p-4 sm:flex-row sm:items-center"
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-caution/30 bg-caution/10 text-caution">
                      <ServerCrash className="h-4 w-4" />
                    </div>
                    <div>
                      <h2 className="text-sm font-semibold text-amber-200">
                        后端 FastAPI 探针暂未连接 ({apiError})
                      </h2>
                      <p className="mt-0.5 text-xs text-slate-400">
                        请先启动本地 Docker 基础设施与后端服务，页面即可实时采集 PostgreSQL / Redis / Phoenix 与密钥就绪状态。
                      </p>
                    </div>
                  </div>
                  <div className="shrink-0 rounded-lg border border-white/10 bg-obsidian-950 px-3 py-2 font-mono text-xs text-slate-300">
                    docker compose -f docker-compose.dev.yml up -d
                  </div>
                </motion.div>
              )}

              {/* Hero Telemetry Summary Strip */}
              <div className="glass-panel rounded-xl p-5">
                <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
                  <div className="space-y-1">
                    <div className="inline-flex items-center gap-1.5 text-xs font-medium text-signal">
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>Phase 0 · 底座连通性与密钥安全验证</span>
                    </div>
                    <h1 className="text-xl font-bold tracking-tight text-white">
                      工程基础设施实时遥测台
                    </h1>
                    <p className="text-xs text-slate-400">
                      前端样式基线、PostgreSQL (pgvector)、Redis 缓存锁及 Arize Phoenix 可观测性探针已接入；密钥仅在服务端脱敏校验，绝不回传明文。
                    </p>
                  </div>

                  <div className="w-full shrink-0 rounded-xl border border-white/[0.07] bg-obsidian-950/70 p-3.5 md:w-72">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">外部数据源与 LLM 就绪度</span>
                      <span className="font-mono font-semibold tabular-nums text-white">
                        {readinessStats.ready} / {readinessStats.total}
                      </span>
                    </div>
                    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${readinessStats.pct}%` }}
                        transition={{ duration: 0.7, ease: EASE_EXPO }}
                        className="h-full rounded-full bg-gradient-to-r from-signal to-bull"
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-between font-mono text-[11px] text-slate-500">
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

              {/* 3 Core Infrastructure Cards */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <InfraCard
                  title="PostgreSQL 16 + pgvector"
                  subtitle="业务账本 / Checkpoint / SEC 混合 RAG"
                  icon={Database}
                  health={health?.components.postgres}
                  delay={0.05}
                />
                <InfraCard
                  title="Redis 7 Store"
                  subtitle="驾驶舱热缓存 / 熔断器 / 防重入锁"
                  icon={Zap}
                  health={health?.components.redis}
                  delay={0.12}
                />
                <InfraCard
                  title="Arize Phoenix"
                  subtitle="单容器 OpenTelemetry Trace & Eval"
                  icon={Eye}
                  health={health?.components.phoenix}
                  delay={0.19}
                />
              </div>

              {/* External Integrations Readiness Matrix */}
              <div className="glass-panel rounded-xl p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold text-white">
                      美股数据源与大模型网关接入矩阵
                    </h2>
                    <p className="text-xs text-slate-400">
                      免账号官方源开箱即用；其余只需在根目录 <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-slate-200">.env</code> 填入对应免费 Key 即可自动点亮。
                    </p>
                  </div>
                  <div className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-obsidian-950/80 px-2.5 py-1 font-mono text-[11px] text-slate-400">
                    <Terminal className="h-3 w-3 text-signal" />
                    python -m scripts.check_keys
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {(health?.integrations ?? [
                    { id: "alpaca", name: "Alpaca Market & Paper Trading", category: "market_data", requires_key: true, configured: false, mode: "Paper" },
                    { id: "fred", name: "FRED Macro & Liquidity", category: "macro", requires_key: true, configured: false, mode: "API Key" },
                    { id: "finnhub", name: "Finnhub Earnings & EPS", category: "fundamentals", requires_key: true, configured: false, mode: "Free Tier" },
                    { id: "fmp", name: "FMP Economic Calendar", category: "macro", requires_key: true, configured: false, mode: "Free Tier" },
                    { id: "binance", name: "Binance Vision (BTCUSDT)", category: "crypto", requires_key: false, configured: true, mode: "Keyless Public" },
                    { id: "cftc", name: "CFTC COT Socrata JSON", category: "positioning", requires_key: false, configured: true, mode: "Keyless Public" },
                    { id: "sec_edgar", name: "SEC EDGAR (10-K / 10-Q / 8-K)", category: "rag", requires_key: false, configured: false, mode: "Header Policy" },
                    { id: "llm_fast", name: "LLM Fast Tier", category: "llm", requires_key: true, configured: false, mode: "OpenAI-Compat" },
                    { id: "llm_pro", name: "LLM Reasoning Tier", category: "llm", requires_key: true, configured: false, mode: "OpenAI-Compat" },
                  ]).map((item, idx) => (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.35, delay: 0.03 * idx, ease: EASE_EXPO }}
                      className="glass-subcard flex items-center justify-between gap-3 rounded-lg p-3 transition-colors hover:border-white/[0.14]"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-slate-100">
                          {item.name}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-slate-500">
                          <span>{item.mode}</span>
                          <span>·</span>
                          <span>{item.requires_key ? "API Key" : "Zero-Key"}</span>
                        </div>
                      </div>
                      {item.configured ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-bull/30 bg-bull/10 px-2 py-0.5 font-mono text-[11px] text-bull">
                          <CheckCircle2 className="h-3 w-3" />
                          READY
                        </span>
                      ) : (
                        <span className="inline-flex shrink-0 items-center rounded-full border border-caution/30 bg-caution/10 px-2 py-0.5 font-mono text-[11px] text-caution">
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
              className="space-y-6"
            >
              {/* Choreography Header + Auto-play toggle */}
              <div className="glass-panel flex flex-col justify-between gap-4 rounded-xl p-5 sm:flex-row sm:items-center">
                <div>
                  <div className="inline-flex items-center gap-1.5 text-xs font-medium text-signal">
                    <Layers className="h-3.5 w-3.5" />
                    <span>1 Deterministic Cockpit + 3 Closed-Loop Agents</span>
                  </div>
                  <h1 className="mt-1 text-xl font-bold tracking-tight text-white">
                    闭环工作流编排与风控流转预览
                  </h1>
                  <p className="mt-0.5 text-xs text-slate-400">
                    点击下方任意环节或开启自动演示，预览 MarketElite 如何完成“数据计算 → 自主调查 → 对抗风控 → 模拟实盘 → 自我反思”。
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setAutoPlay((v) => !v)}
                  className={`inline-flex shrink-0 items-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-semibold transition-all active:scale-[0.98] ${
                    autoPlay
                      ? "border-bull/40 bg-bull/15 text-bull"
                      : "border-signal/35 bg-signal/10 text-signal hover:bg-signal/20"
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

              {/* 4-Stage Interactive Pipeline Track */}
              <div className="relative grid grid-cols-1 gap-3 md:grid-cols-4">
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
                      className={`group relative flex flex-col justify-between rounded-xl border p-4 text-left transition-all duration-300 ${
                        isSelected
                          ? "border-signal/50 bg-obsidian-800/90 shadow-glow"
                          : "border-white/[0.07] bg-obsidian-900/60 hover:border-white/[0.16] hover:bg-obsidian-850/70"
                      }`}
                    >
                      {isSelected && (
                        <motion.div
                          layoutId="stage-active-glow"
                          transition={{ type: "spring", stiffness: 360, damping: 30 }}
                          className="pointer-events-none absolute inset-0 rounded-xl border border-signal/50 bg-gradient-to-b from-signal/[0.08] to-transparent"
                        />
                      )}

                      <div className="relative z-10 flex items-center justify-between">
                        <span className="font-mono text-[11px] font-semibold text-signal">
                          0{stage.order} · {stage.phase}
                        </span>
                        <div
                          className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
                            isSelected
                              ? "border-signal/40 bg-signal/15 text-signal"
                              : "border-white/10 bg-obsidian-950 text-slate-400 group-hover:text-slate-200"
                          }`}
                        >
                          <StageIcon className="h-3.5 w-3.5" />
                        </div>
                      </div>

                      <div className="relative z-10 mt-3">
                        <div className="text-[11px] font-medium text-slate-400">
                          {stage.tag}
                        </div>
                        <div className="mt-0.5 text-sm font-semibold text-white">
                          {stage.title}
                        </div>
                        <div className="mt-1 text-xs text-slate-400">
                          {stage.subtitle}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Animated Stage Detail Inspector */}
              <AnimatePresence mode="wait">
                <motion.div
                  key={activeStage.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.32, ease: EASE_EXPO }}
                  className="glass-panel grid grid-cols-1 gap-6 rounded-xl p-6 lg:grid-cols-12"
                >
                  <div className="space-y-4 lg:col-span-7">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-signal/30 bg-signal/10 px-2.5 py-0.5 font-mono text-xs font-medium text-signal">
                        {activeStage.tag}
                      </span>
                      <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 font-mono text-xs text-slate-300">
                        目标交付：{activeStage.phase}
                      </span>
                    </div>

                    <div>
                      <h2 className="text-lg font-bold text-white">{activeStage.title}</h2>
                      <p className="mt-2 text-sm leading-relaxed text-slate-300">
                        {activeStage.summary}
                      </p>
                    </div>

                    <div>
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                        核心工程组件
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {activeStage.components.map((comp) => (
                          <span
                            key={comp}
                            className="rounded-md border border-white/10 bg-obsidian-950/90 px-2.5 py-1 font-mono text-xs text-slate-200"
                          >
                            {comp}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Live Simulation Trace Card */}
                  <div className="glass-subcard flex flex-col justify-between rounded-xl p-4 lg:col-span-5">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between border-b border-white/[0.06] pb-2">
                        <span className="font-mono text-xs font-semibold text-slate-200">
                          SIMULATED EXECUTION TRACE
                        </span>
                        <span className="inline-flex items-center gap-1 font-mono text-[11px] text-bull">
                          <StatusDot status="up" />
                          GUARDED
                        </span>
                      </div>

                      <div>
                        <div className="text-[11px] font-medium text-slate-400">
                          触发信号
                        </div>
                        <div className="mt-1 rounded-md border border-white/[0.06] bg-obsidian-950/80 p-2 font-mono text-xs text-slate-200">
                          {STAGE_MOCK_FLOW[activeStage.id]?.trigger}
                        </div>
                      </div>

                      <div>
                        <div className="text-[11px] font-medium text-slate-400">
                          内置异常兜底与风控栅栏
                        </div>
                        <ul className="mt-1 space-y-1">
                          {STAGE_MOCK_FLOW[activeStage.id]?.guardrails.map((g) => (
                            <li
                              key={g}
                              className="flex items-center gap-1.5 text-xs text-slate-300"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-bull" />
                              <span>{g}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    <div className="mt-4 rounded-lg border border-bull/25 bg-bull/[0.07] p-2.5">
                      <div className="text-[11px] font-semibold text-bull">阶段输出产物</div>
                      <p className="mt-0.5 font-mono text-xs leading-relaxed text-emerald-100">
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

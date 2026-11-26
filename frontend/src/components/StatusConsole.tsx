"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  Activity,
  BookOpen,
  Cpu,
  Database,
  GitBranch,
  Lock,
  RefreshCw,
  Unlock,
  Zap,
} from "lucide-react";
import DataLineageView from "@/components/dataplatform/DataLineageView";
import DataCatalogQualityView from "@/components/dataplatform/DataCatalogQualityView";
import RagGovernanceView from "@/components/dataplatform/RagGovernanceView";
import ProvidersFinOpsView from "@/components/dataplatform/ProvidersFinOpsView";
import EvalCenterView from "@/components/dataplatform/EvalCenterView";
import {
  DataPlatformOverviewResponse,
  DataPlatformRagResponse,
  EvalRunsListResponse,
  HealthResponse,
  fetchDataPlatformEvalRuns,
  fetchDataPlatformOverview,
  fetchDataPlatformRagGovernance,
  fetchHealth,
  runDataQualityAudit,
  verifyDataPlatformAdminToken,
} from "@/lib/api";

const ADMIN_SESSION_STORAGE_KEY = "me_dataplatform_admin_token";

const EASE_EXPO = [0.16, 1, 0.3, 1] as const;

type PlatformTabId = "lineage" | "catalog" | "rag" | "evals" | "finops";

export default function StatusConsole() {
  const [activeTab, setActiveTab] = useState<PlatformTabId>("lineage");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [overview, setOverview] = useState<DataPlatformOverviewResponse | null>(null);
  const [ragData, setRagData] = useState<DataPlatformRagResponse | null>(null);
  const [evalRunsData, setEvalRunsData] = useState<EvalRunsListResponse | null>(null);

  const [loading, setLoading] = useState<boolean>(true);
  const [runningQuality, setRunningQuality] = useState<boolean>(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [roundTripMs, setRoundTripMs] = useState<number | null>(null);

  // Positioning A: Public Read-Only Showcase + Admin Token Unlock
  const [adminToken, setAdminToken] = useState<string>("");
  const [tokenInput, setTokenInput] = useState<string>("");
  const [adminUnlocked, setAdminUnlocked] = useState<boolean>(false);
  const [showcasePreview, setShowcasePreview] = useState<boolean>(true);
  const [showUnlockBox, setShowUnlockBox] = useState<boolean>(false);
  const [verifyingToken, setVerifyingToken] = useState<boolean>(false);
  const [unlockFeedback, setUnlockFeedback] = useState<string | null>(null);

  const requiresAdmin = Boolean(overview?.access_mode?.requires_admin_token);
  const isReadOnly = requiresAdmin ? !adminUnlocked : showcasePreview;

  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(ADMIN_SESSION_STORAGE_KEY);
      if (saved && saved.trim()) {
        setTokenInput(saved);
        void verifyDataPlatformAdminToken(saved)
          .then(() => {
            setAdminToken(saved);
            setAdminUnlocked(true);
            setShowcasePreview(false);
          })
          .catch(() => {
            window.sessionStorage.removeItem(ADMIN_SESSION_STORAGE_KEY);
          });
      }
    } catch {
      // sessionStorage unavailable in restricted contexts
    }
  }, []);

  const loadAllPlatformState = useCallback(async () => {
    setLoading(true);
    setApiError(null);
    const t0 = performance.now();
    try {
      const [h, ov, rag, evRuns] = await Promise.all([
        fetchHealth().catch(() => null),
        fetchDataPlatformOverview(),
        fetchDataPlatformRagGovernance().catch(() => null),
        fetchDataPlatformEvalRuns(15).catch(() => null),
      ]);
      if (h) setHealth(h);
      setOverview(ov);
      if (rag) setRagData(rag);
      if (evRuns) setEvalRunsData(evRuns);
      setRoundTripMs(Math.round(performance.now() - t0));
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "无法读取数据与评测中台状态");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAllPlatformState();
  }, [loadAllPlatformState]);

  const handleRerunQuality = async () => {
    if (isReadOnly) return;
    setRunningQuality(true);
    try {
      const nextDq = await runDataQualityAudit(adminToken);
      setOverview((prev) => (prev ? { ...prev, quality: nextDq } : prev));
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "数据质量稽核运行失败");
    } finally {
      setRunningQuality(false);
    }
  };

  const handleToggleLockOrUnlock = async () => {
    setUnlockFeedback(null);
    if (!isReadOnly) {
      // Return cleanly to Public Visitor Read-Only view
      setAdminUnlocked(false);
      setAdminToken("");
      setShowcasePreview(true);
      setShowUnlockBox(false);
      try {
        window.sessionStorage.removeItem(ADMIN_SESSION_STORAGE_KEY);
      } catch {
        // ignore storage errors
      }
      return;
    }

    if (!requiresAdmin) {
      // Local dev without ADMIN_API_TOKEN: 1-click toggle between Showcase Preview & Dev Mode
      setShowcasePreview(false);
      setAdminUnlocked(true);
      setShowUnlockBox(false);
      return;
    }

    // Production / ADMIN_API_TOKEN guarded: prompt for passphrase
    setShowUnlockBox((prev) => !prev);
  };

  const handleVerifyAdminSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setVerifyingToken(true);
    setUnlockFeedback(null);
    try {
      await verifyDataPlatformAdminToken(tokenInput);
      const clean = tokenInput.trim();
      setAdminToken(clean);
      setAdminUnlocked(true);
      setShowcasePreview(false);
      setShowUnlockBox(false);
      try {
        if (clean) {
          window.sessionStorage.setItem(ADMIN_SESSION_STORAGE_KEY, clean);
        }
      } catch {
        // ignore storage errors
      }
    } catch (err) {
      setUnlockFeedback(err instanceof Error ? err.message : "口令校验失败（403）");
    } finally {
      setVerifyingToken(false);
    }
  };

  const statusPill = useMemo(() => {
    if (apiError || !health) return { label: "API STANDBY", dot: "bg-amber-500" };
    if (health.status === "ok") return { label: "DATA PLATFORM ONLINE", dot: "bg-emerald-500" };
    if (health.status === "degraded") return { label: "PARTIAL DEGRADED", dot: "bg-amber-500" };
    return { label: "INITIALIZING", dot: "bg-rose-500" };
  }, [apiError, health]);

  const navTabs: Array<{ id: PlatformTabId; label: string; icon: React.ElementType }> = [
    { id: "lineage", label: "数据血缘与总览", icon: GitBranch },
    { id: "catalog", label: "资产目录与质量", icon: Database },
    { id: "rag", label: "RAG 语料与记忆", icon: BookOpen },
    { id: "evals", label: "全栈评测 (4-Track)", icon: Zap },
    { id: "finops", label: "熔断监控与 FinOps", icon: Cpu },
  ];

  return (
    <div className="mx-auto flex w-full max-w-[1780px] flex-col px-4 pt-6 pb-12 sm:px-6 lg:px-8">
      {/* Authoritative Hero Header */}
      <div className="mb-5 flex flex-col justify-between gap-4 px-1 lg:flex-row lg:items-center">
        <div className="flex items-start gap-3.5 sm:items-center sm:gap-4">
          <div className="apple-liquid-glass flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-zinc-950 dark:text-white sm:h-14 sm:w-14">
            <Activity className="relative z-10 h-6 w-6 text-emerald-500 sm:h-7 sm:w-7" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">
                DATAOPS OBSERVABILITY · HYBRID RAG GOVERNANCE · MULTI-TRACK EVALS
              </span>
              <span className="apple-liquid-glass inline-flex items-center gap-1.5 rounded-full px-3 py-0.5 font-mono text-[11px] font-semibold text-zinc-900 dark:text-zinc-100">
                <span className={`relative z-10 h-2 w-2 rounded-full ${statusPill.dot}`} />
                <span className="relative z-10">{statusPill.label}</span>
              </span>
            </div>
            <h1 className="mt-1 font-serif text-2xl font-bold tracking-tight text-zinc-950 dark:text-white sm:text-3xl lg:text-4xl">
              MarketElite 数据与评测中台
            </h1>
          </div>
        </div>

        {/* Probe Latency + Showcase Lock/Unlock + Liquid Glass Reload */}
        <div className="flex flex-wrap items-center gap-2.5 self-start lg:self-center">
          <button
            type="button"
            onClick={() => void handleToggleLockOrUnlock()}
            title={
              isReadOnly
                ? requiresAdmin
                  ? "当前为公网只读展示模式，输入管理员口令可解锁跑批与基线修改"
                  : "当前正模拟公网访客只读视图，点击可一键解锁本地管理操作"
                : "点击切回公网访客只读视角"
            }
            className={`apple-liquid-glass-btn inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-2 font-mono text-xs font-semibold transition ${
              isReadOnly
                ? "text-amber-700 dark:text-amber-300"
                : "text-emerald-700 dark:text-emerald-300"
            }`}
          >
            {isReadOnly ? (
              <Lock className="relative z-10 h-3.5 w-3.5" />
            ) : (
              <Unlock className="relative z-10 h-3.5 w-3.5" />
            )}
            <span className="relative z-10">
              {isReadOnly
                ? requiresAdmin
                  ? "访客只读 · 解锁管理"
                  : "访客只读预览 · 解锁调试"
                : "管理员已解锁 · 锁定只读"}
            </span>
          </button>

          {roundTripMs !== null && (
            <span className="font-mono text-xs font-medium tabular-nums text-zinc-500 dark:text-zinc-400">
              {roundTripMs} ms
            </span>
          )}
          <button
            type="button"
            disabled={loading}
            onClick={() => void loadAllPlatformState()}
            className="apple-liquid-glass-btn inline-flex items-center gap-2 whitespace-nowrap rounded-full px-4 py-2 font-sans text-sm font-semibold text-zinc-950 disabled:opacity-50 dark:text-white"
          >
            <RefreshCw className={`relative z-10 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            <span className="relative z-10">全量采样刷新</span>
          </button>
        </div>
      </div>

      {/* Inline Admin Passphrase Bar (when requiresAdmin and user clicks unlock) */}
      {showUnlockBox && isReadOnly && (
        <form
          onSubmit={handleVerifyAdminSubmit}
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/[0.07] px-4 py-2.5"
        >
          <div className="font-sans text-xs text-amber-950 dark:text-amber-200">
            <b>管理员口令解锁：</b>
            {overview?.access_mode?.admin_configured === false
              ? "服务端处于 Public Showcase 锁定但未配置 ADMIN_API_TOKEN，当前接口保持只读。"
              : "输入 `.env` 中的 ADMIN_API_TOKEN 后，将暂存当前标签页会话并解锁跑批/同步/改基线操作。"}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="输入 X-Admin-Token..."
              aria-label="X-Admin-Token"
              className="h-8 w-52 rounded-full border border-zinc-300 bg-white px-3 font-mono text-xs text-zinc-900 outline-none dark:border-white/20 dark:bg-zinc-900 dark:text-white"
            />
            <button
              type="submit"
              disabled={verifyingToken}
              className="h-8 rounded-full bg-zinc-950 px-3.5 font-mono text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-zinc-950"
            >
              {verifyingToken ? "校验中..." : "验证解锁"}
            </button>
            <button
              type="button"
              onClick={() => setShowUnlockBox(false)}
              className="h-8 rounded-full px-2.5 font-mono text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
            >
              取消
            </button>
          </div>
          {unlockFeedback && (
            <div className="w-full font-mono text-[11px] font-semibold text-rose-700 dark:text-rose-300">
              {unlockFeedback}
            </div>
          )}
        </form>
      )}

      {/* Subtle Positioning A Public Read-Only Notice */}
      {isReadOnly && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-zinc-200/80 bg-white/60 px-4 py-2 font-sans text-xs text-zinc-700 backdrop-blur-md dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-300">
          <div className="flex items-center gap-2">
            <Lock className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span>
              当前为 <b>公开只读展示模式</b>：访客可自由浏览 4 层数仓血缘、PG/Redis 实时指标与全部 54 项全栈评测证据；触发跑批、在线 RAG 调试与写库操作需管理员口令解锁。
            </span>
          </div>
          <span className="font-mono text-[10.5px] text-zinc-500 dark:text-zinc-400">
            READ-ONLY SHOWCASE GUARD
          </span>
        </div>
      )}

      {/* Borderless Floating Apple Liquid Glass 5-Module Dock + Telemetry Strip */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <LayoutGroup id="dataplatform-liquid-glass-tabs">
          <div className="apple-liquid-glass relative flex flex-wrap items-center gap-1 rounded-[26px] p-1.5 md:flex-nowrap md:rounded-full">
            {navTabs.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 py-2.5 font-sans text-sm tracking-tight transition-colors duration-200 ${
                    active
                      ? "font-semibold text-zinc-950 dark:text-white"
                      : "font-medium text-zinc-700 hover:text-zinc-950 dark:text-zinc-200 dark:hover:text-white"
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="dataplatform-liquid-glass-pill"
                      transition={{ type: "spring", stiffness: 420, damping: 32, mass: 0.7 }}
                      className="apple-liquid-glass-active absolute inset-0 rounded-full"
                    />
                  )}
                  <Icon className="relative z-10 h-4 w-4 shrink-0" />
                  <span className="relative z-10">{tab.label}</span>
                </button>
              );
            })}
          </div>
        </LayoutGroup>

        <div className="hidden items-center gap-2 px-1 font-mono text-xs text-zinc-600 dark:text-zinc-300 xl:flex">
          <span>{overview ? `${overview.kpis.total_tables} PG Tables` : "16 PG Tables"}</span>
          <span>·</span>
          <span>{overview ? `${overview.quality.checks.length} DQ Rules` : "6 DQ Rules"}</span>
          <span>·</span>
          <span>
            {evalRunsData?.latest_report
              ? `${evalRunsData.latest_report.passed_cases}/${evalRunsData.latest_report.total_cases} 4-Track Evals`
              : "54 4-Track Evals"}
          </span>
        </div>
      </div>

      {apiError && (
        <div className="mb-4 rounded-2xl border border-rose-500/35 bg-rose-500/10 px-4 py-2.5 font-mono text-xs text-rose-900 dark:text-rose-200">
          {apiError}
        </div>
      )}

      {/* Main Content Workspace */}
      <AnimatePresence mode="wait">
        {activeTab === "lineage" ? (
          <motion.div
            key="lineage"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.24, ease: EASE_EXPO }}
          >
            <DataLineageView
              overview={overview}
              health={health}
              loading={loading}
              onJumpTab={(t) => setActiveTab(t)}
            />
          </motion.div>
        ) : activeTab === "catalog" ? (
          <motion.div
            key="catalog"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.24, ease: EASE_EXPO }}
          >
            <DataCatalogQualityView
              catalog={overview?.catalog ?? []}
              quality={overview?.quality ?? null}
              runningQuality={runningQuality}
              isReadOnly={isReadOnly}
              adminToken={adminToken}
              onRerunQuality={handleRerunQuality}
              onSyncCompleted={() => void loadAllPlatformState()}
            />
          </motion.div>
        ) : activeTab === "rag" ? (
          <motion.div
            key="rag"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.24, ease: EASE_EXPO }}
          >
            <RagGovernanceView
              ragData={ragData}
              loading={loading}
              isReadOnly={isReadOnly}
              adminToken={adminToken}
              onRefresh={() => void loadAllPlatformState()}
            />
          </motion.div>
        ) : activeTab === "finops" ? (
          <motion.div
            key="finops"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.24, ease: EASE_EXPO }}
          >
            <ProvidersFinOpsView
              overview={overview}
              isReadOnly={isReadOnly}
              adminToken={adminToken}
              onRefresh={() => void loadAllPlatformState()}
            />
          </motion.div>
        ) : (
          <motion.div
            key="evals"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.24, ease: EASE_EXPO }}
          >
            <EvalCenterView
              evalRunsData={evalRunsData}
              phoenixUiUrl={overview?.kpis.phoenix_ui_url ?? null}
              loading={loading}
              isReadOnly={isReadOnly}
              adminToken={adminToken}
              onRefresh={() => void loadAllPlatformState()}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

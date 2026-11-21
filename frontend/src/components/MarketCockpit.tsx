"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  BarChart3,
  Calendar,
  Layers,
  Moon,
  Newspaper,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Sun,
} from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import MacroTickerStrip from "@/components/MacroTickerStrip";
import StatusConsole from "@/components/StatusConsole";
import InvestigatorDrawer from "@/components/InvestigatorDrawer";
import { PortfolioWatchdogView } from "@/components/PortfolioWatchdogView";
import { useTheme } from "@/components/ThemeProvider";
import AssetCandlestickChart from "@/components/charts/AssetCandlestickChart";
import CorrelationHeatmapChart from "@/components/charts/CorrelationHeatmapChart";
import GexProfileChart from "@/components/charts/GexProfileChart";
import NetLiquidityChart from "@/components/charts/NetLiquidityChart";
import {
  AssetDetailResponse,
  DashboardOverviewResponse,
  RegimeHistoryPoint,
  TrackedAssetSummary,
  ensureAsset,
  fetchAssetDetail,
  fetchDashboardOverview,
  fetchRegimeHistory,
  fetchTrackedAssets,
  fetchWatchdogAlerts,
  triggerPipelineSync,
} from "@/lib/api";
import {
  formatCreditState,
  formatDriverText,
  formatVolumePriceTag,
} from "@/lib/i18n";

const EASE_EXPO = [0.16, 1, 0.3, 1] as const;

function fmtNum(val: number | null | undefined, digits = 2, suffix = ""): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return `${val.toFixed(digits)}${suffix}`;
}

function fmtSigned(val: number | null | undefined, digits = 2, suffix = ""): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return `${val >= 0 ? "+" : ""}${val.toFixed(digits)}${suffix}`;
}

function fmtBillions(val: number | null | undefined): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  const sign = val >= 0 ? "+" : "-";
  const abs = Math.abs(val);
  if (abs >= 1e9) {
    return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  }
  return `${sign}$${(abs / 1e6).toFixed(1)}M`;
}

function deltaTone(val: number | null | undefined, onObsidian = false): string {
  if (val === null || val === undefined) {
    return onObsidian ? "text-zinc-400" : "text-zinc-500 dark:text-zinc-400";
  }
  if (val > 0) {
    return onObsidian ? "text-emerald-400" : "text-emerald-600 dark:text-emerald-400";
  }
  if (val < 0) {
    return onObsidian ? "text-rose-400" : "text-rose-600 dark:text-rose-400";
  }
  return onObsidian ? "text-zinc-300" : "text-zinc-600 dark:text-zinc-300";
}

const REGIME_BI: Record<string, string> = {
  HIGH_VOL_TRANSITION: "高波切换 · HIGH VOL TRANSITION",
  RISK_ON_EXPANSION: "风险扩张 · RISK ON EXPANSION",
  RISK_OFF_STRESS: "避险承压 · RISK OFF STRESS",
  LIQUIDITY_TIGHTENING: "流动性收紧 · LIQUIDITY TIGHTENING",
  NEUTRAL_ROTATION: "中性轮动 · NEUTRAL ROTATION",
};

const SENTIMENT_BI: Record<string, string> = {
  "Extreme Fear": "极度恐慌 Extreme Fear",
  Fear: "恐慌 Fear",
  Neutral: "中性 Neutral",
  Greed: "贪婪 Greed",
  "Extreme Greed": "极度贪婪 Extreme Greed",
};

const PILLAR_BI: Record<string, string> = {
  momentum: "动量 Mom",
  breadth: "广度 Brd",
  volatility: "波动 Vol",
  credit: "信用 Crd",
  risk_appetite: "风险 Beta",
};

const VIX_STATE_BI: Record<string, string> = {
  "Contango (Calm)": "正向升水 Contango",
  "Flat (Transition)": "期限走平 Flat",
  "Backwardation (Stress)": "倒挂贴水 Backwardation",
};

const BUCKET_BI: Record<string, string> = {
  Offensive: "进攻 Offensive",
  Cyclical: "周期 Cyclical",
  Defensive: "防御 Defensive",
};

function formatRegimeLabel(label: string | undefined): string {
  if (!label) return "初始化中 · INITIALIZING";
  return REGIME_BI[label] ?? label.replaceAll("_", " ");
}

export default function MarketCockpit() {
  const { theme, toggleTheme } = useTheme();
  const [viewMode, setViewMode] = useState<"cockpit" | "copilot" | "portfolio" | "infra">("cockpit");
  const [overview, setOverview] = useState<DashboardOverviewResponse | null>(null);
  const [trackedAssets, setTrackedAssets] = useState<TrackedAssetSummary[]>([]);
  const [regimeHistory, setRegimeHistory] = useState<RegimeHistoryPoint[]>([]);
  const [unackedAlerts, setUnackedAlerts] = useState<number>(0);

  const [selectedSymbol, setSelectedSymbol] = useState<string>("SPY");
  const [tickerSearchInput, setTickerSearchInput] = useState<string>("");
  const [searchingTicker, setSearchingTicker] = useState<boolean>(false);
  const [tickerSearchError, setTickerSearchError] = useState<string | null>(null);
  const [watchlistFilter, setWatchlistFilter] = useState<"all" | "etf" | "equity">("all");
  const [watchlistSort, setWatchlistSort] = useState<"alpha" | "chg_desc">("alpha");

  const [assetDetail, setAssetDetail] = useState<AssetDetailResponse | null>(null);
  const [gexSymbol, setGexSymbol] = useState<"SPY" | "QQQ">("SPY");
  const [calendarFilter, setCalendarFilter] = useState<"all" | "macro" | "earnings">("all");
  const [loading, setLoading] = useState<boolean>(true);
  const [assetLoading, setAssetLoading] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const loadOverviewAndAssets = useCallback(async () => {
    setError(null);
    try {
      const [ov, list, hist, alRes] = await Promise.all([
        fetchDashboardOverview(),
        fetchTrackedAssets().catch(() => ({ count: 0, assets: [] })),
        fetchRegimeHistory(30).catch(() => ({ count: 0, history: [] })),
        fetchWatchdogAlerts(20).catch(() => ({ count: 0, alerts: [] })),
      ]);
      setOverview(ov);
      setTrackedAssets(list.assets);
      setRegimeHistory(hist.history);
      setUnackedAlerts(alRes.alerts.filter((a) => !a.acknowledged).length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed loading MarketElite cockpit");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAsset = useCallback(async (symbol: string) => {
    setAssetLoading(true);
    try {
      const detail = await fetchAssetDetail(symbol, 260, true, true);
      setAssetDetail(detail);
    } catch {
      setAssetDetail(null);
    } finally {
      setAssetLoading(false);
    }
  }, []);

  const handleGlobalTickerSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const sym = tickerSearchInput.trim().toUpperCase();
    if (!sym) return;
    setSearchingTicker(true);
    setTickerSearchError(null);
    try {
      await ensureAsset(sym, false);
      setSelectedSymbol(sym);
      const list = await fetchTrackedAssets().catch(() => null);
      if (list) setTrackedAssets(list.assets);
      setTickerSearchInput("");
    } catch (err) {
      setTickerSearchError(err instanceof Error ? err.message : `未找到美股代码 ${sym}`);
    } finally {
      setSearchingTicker(false);
    }
  };

  useEffect(() => {
    loadOverviewAndAssets();
  }, [loadOverviewAndAssets]);

  useEffect(() => {
    if (viewMode === "cockpit") {
      loadAsset(selectedSymbol);
    }
  }, [selectedSymbol, viewMode, loadAsset]);

  const handleManualSync = async () => {
    setSyncing(true);
    try {
      await triggerPipelineSync(false);
      await loadOverviewAndAssets();
      await loadAsset(selectedSymbol);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const filteredWatchlist = useMemo(() => {
    const items = trackedAssets.filter((a) => {
      if (watchlistFilter === "etf") return a.asset_class === "etf";
      if (watchlistFilter === "equity") return a.asset_class !== "etf";
      return true;
    });
    if (watchlistSort === "chg_desc") {
      return [...items].sort(
        (a, b) => (b.change_1d_pct ?? -999) - (a.change_1d_pct ?? -999)
      );
    }
    return [...items].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }, [trackedAssets, watchlistFilter, watchlistSort]);

  const filteredCalendar = useMemo(() => {
    const events = overview?.positioning_and_calendar?.upcoming_events ?? [];
    if (calendarFilter === "all") return events;
    return events.filter((ev) => ev.event_type === calendarFilter);
  }, [overview, calendarFilter]);

  const activeGex = overview?.options_gex?.[gexSymbol] ?? null;

  const leftNavItems = [
    { id: "cockpit" as const, label: "驾驶舱" },
    { id: "copilot" as const, label: "投研与风控台" },
  ];

  const rightNavItems = [
    { id: "portfolio" as const, label: "模拟盘与复盘" },
    { id: "infra" as const, label: "系统与评测" },
  ];

  const renderNavPill = (tabItem: { id: "cockpit" | "copilot" | "portfolio" | "infra"; label: string }) => {
    const isActive = viewMode === tabItem.id;
    return (
      <button
        key={tabItem.id}
        type="button"
        onClick={() => setViewMode(tabItem.id)}
        className={`relative inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-sans text-[12px] tracking-tight transition-colors duration-200 ${
          isActive
            ? "font-semibold text-zinc-950 dark:text-white"
            : "font-medium text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
        }`}
      >
        {isActive && (
          <motion.span
            layoutId="apple-glass-nav-pill"
            transition={{ type: "spring", stiffness: 360, damping: 32, mass: 0.8 }}
            className="apple-liquid-glass-active absolute inset-0 rounded-full"
          />
        )}
        <span className="relative z-10">{tabItem.label}</span>
        {tabItem.id === "portfolio" && unackedAlerts > 0 && (
          <span className="relative z-10 rounded-full bg-rose-600 px-1.5 py-0.2 font-mono text-[9px] font-bold text-white shadow-sm">
            {unackedAlerts}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="min-h-screen pb-20">
      {/* Floating Apple Liquid Glass Split Architectural Navigation Bar */}
      <header className="pointer-events-none sticky top-0 z-40 px-4 pt-3 pb-1.5 sm:px-6">
        <div className="mx-auto flex max-w-[1460px] flex-wrap items-center justify-between gap-2.5">
          {/* Left Floating Circular Glass Controls */}
          <div className="pointer-events-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (viewMode !== "cockpit") {
                  setViewMode("cockpit");
                }
                setDrawerOpen((v) => !v);
              }}
              title={`AI 侧边协查舱 (${selectedSymbol})`}
              aria-label="Toggle AI Investigator Drawer"
              className={`apple-liquid-glass-btn relative flex h-10 w-10 items-center justify-center rounded-full text-zinc-800 dark:text-zinc-100 ${
                drawerOpen && viewMode === "cockpit"
                  ? "ring-2 ring-emerald-500/50 dark:ring-emerald-400/50"
                  : ""
              }`}
            >
              <Activity className="h-[18px] w-[18px]" />
              <span className="absolute right-2 top-2 flex h-2 w-2">
                <span className="pulse-ring absolute inline-flex h-full w-full rounded-full bg-emerald-500" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
            </button>

            <button
              type="button"
              onClick={handleManualSync}
              disabled={syncing}
              title={
                overview?.cache_source === "redis"
                  ? "Redis Hot <50ms · 点击强制同步管线"
                  : "同步市场宏观与量价管线"
              }
              className="apple-liquid-glass-btn inline-flex h-10 items-center gap-1.5 rounded-full px-3.5 font-mono text-[11px] font-medium text-zinc-800 disabled:opacity-50 dark:text-zinc-100"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">{syncing ? "同步中" : "同步"}</span>
              {overview?.cache_source === "redis" && (
                <span
                  aria-label="Redis Hot"
                  className="hidden h-1.5 w-1.5 rounded-full bg-emerald-500 lg:inline-block"
                />
              )}
            </button>
          </div>

          {/* Center Split Apple Liquid Glass Navigation Capsule + Rising Brand Emblem */}
          <nav
            aria-label="Primary Workspaces"
            className="pointer-events-auto order-3 flex w-full justify-center md:order-2 md:w-auto"
          >
            <div className="apple-liquid-glass relative flex h-11 items-center gap-1 rounded-full px-2">
              <div className="flex items-center gap-0.5">{leftNavItems.map(renderNavPill)}</div>

              {/* Central Rising Brand Prism Crest (Inspired by Split Capsule Center Mark) */}
              <button
                type="button"
                onClick={() => {
                  setViewMode("cockpit");
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                title="MarketElite · 返回驾驶舱顶部"
                className="group relative mx-1.5 flex items-center gap-2 rounded-full px-2 py-1 transition-transform duration-200 hover:scale-[1.04]"
              >
                <span className="relative -my-3 flex h-12 w-10 items-center justify-center filter drop-shadow-[0_6px_14px_rgba(24,24,27,0.28)] dark:drop-shadow-[0_6px_16px_rgba(0,0,0,0.85)]">
                  <svg
                    viewBox="0 0 40 44"
                    className="h-11 w-10"
                    aria-hidden="true"
                  >
                    <defs>
                      <linearGradient id="meCrestGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#18181b" />
                        <stop offset="55%" stopColor="#09090b" />
                        <stop offset="100%" stopColor="#27272a" />
                      </linearGradient>
                    </defs>
                    <polygon
                      points="20,2 38,38 2,38"
                      fill="url(#meCrestGrad)"
                      className="stroke-white/80 dark:stroke-white/40"
                      strokeWidth="1.2"
                      strokeLinejoin="round"
                    />
                    <polyline
                      points="11,29 17,22 21,26 28,15"
                      fill="none"
                      stroke="#34d399"
                      strokeWidth="2.1"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span className="hidden font-serif text-[16px] font-medium italic tracking-tight text-zinc-950 transition-colors duration-150 dark:text-zinc-50 sm:inline">
                  MarketElite
                </span>
              </button>

              <div className="flex items-center gap-0.5">{rightNavItems.map(renderNavPill)}</div>
            </div>
          </nav>

          {/* Right Floating Liquid Glass Controls: Theme Switcher & GitHub Icon */}
          <div className="pointer-events-auto order-2 flex items-center gap-2 md:order-3">
            <button
              type="button"
              onClick={toggleTheme}
              title="切换丝绒白昼 / 黑曜夜幕主题"
              className="apple-liquid-glass-btn inline-flex h-10 items-center gap-1.5 rounded-full px-3.5 font-mono text-[11px] font-medium text-zinc-800 dark:text-zinc-100"
            >
              {theme === "dark" ? (
                <>
                  <Sun className="h-3.5 w-3.5 text-amber-300" />
                  <span>丝绒白昼</span>
                </>
              ) : (
                <>
                  <Moon className="h-3.5 w-3.5 text-zinc-700" />
                  <span>黑曜夜幕</span>
                </>
              )}
            </button>

            <a
              href="https://github.com/LOGIC-P/MarketElite"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open MarketElite GitHub Repository"
              title="GitHub · LOGIC-P/MarketElite"
              className="apple-liquid-glass-btn flex h-10 w-10 items-center justify-center rounded-full text-zinc-900 dark:text-zinc-100"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-[18px] w-[18px] fill-current"
                aria-hidden="true"
              >
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
            </a>
          </div>
        </div>
      </header>

      {viewMode === "infra" ? (
        <StatusConsole />
      ) : viewMode === "copilot" ? (
        <main className="mx-auto max-w-[1460px] px-4 pt-5 sm:px-6">
          <InvestigatorDrawer
            open={true}
            mode="split"
            defaultSymbol={selectedSymbol}
          />
        </main>
      ) : viewMode === "portfolio" ? (
        <main className="mx-auto max-w-[1460px] px-4 pt-5 sm:px-6">
          <PortfolioWatchdogView
            onSelectSymbol={(sym) => {
              setSelectedSymbol(sym);
              setViewMode("cockpit");
            }}
            onAlertCountChange={setUnackedAlerts}
          />
        </main>
      ) : (
        <main className="mx-auto max-w-[1460px] space-y-5 px-4 pt-5 sm:px-6">
        {error && (
          <div className="flex items-center justify-between rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 font-mono text-xs text-rose-800">
            <span className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" />
              {error}
            </span>
            <button
              type="button"
              onClick={loadOverviewAndAssets}
              className="underline hover:text-rose-950"
            >
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
            <div className="h-72 animate-pulse rounded-2xl bg-zinc-900/90 lg:col-span-7" />
            <div className="h-72 animate-pulse rounded-2xl border border-zinc-200 bg-white lg:col-span-5" />
          </div>
        ) : overview?.status === "empty_bootstrap_needed" ? (
          <SpotlightBlock tone="obsidian" className="p-8 text-center">
            <p className="font-serif text-2xl italic text-white">
              Deterministic Market Cache Pending Bootstrap
            </p>
            <p className="mt-2 font-mono text-xs text-zinc-400">
              {overview.message}
            </p>
            <button
              type="button"
              onClick={handleManualSync}
              disabled={syncing}
              className="mt-5 inline-flex items-center gap-2 rounded-full bg-white px-5 py-2 font-mono text-xs font-medium text-zinc-950 transition hover:bg-zinc-200"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
              Run Initial Phase 1 Pipeline Sync
            </button>
          </SpotlightBlock>
        ) : (
          <>
            {/* BAND 1: OBSIDIAN (7 cols) + GALLERY WHITE (5 cols) */}
            <motion.section
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: EASE_EXPO }}
              className="grid grid-cols-1 gap-5 lg:grid-cols-12"
            >
              {/* Layer 1: Obsidian Regime & US Fed Net Liquidity */}
              <SpotlightBlock tone="obsidian" tilt="subtle" className="flex flex-col justify-between p-6 lg:col-span-7">
                <div className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.16em] text-zinc-400">
                        <Layers className="h-3.5 w-3.5" />
                        LAYER 01 · 宏观流动性与体制锚 (Macro Regime Anchor)
                      </div>
                      <h1 className="mt-2 font-serif text-2xl tracking-tight text-white sm:text-3xl">
                        {formatRegimeLabel(overview?.regime?.regime_label)}
                      </h1>
                    </div>
                    <div className="flex flex-col items-end gap-1 font-mono text-[11px]">
                      <span className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-zinc-200">
                        压力 Stress {overview?.regime?.stress_score ?? 0} · 支撑 Support{" "}
                        {overview?.regime?.support_score ?? 0}
                      </span>
                      <span className="text-[10px] text-zinc-500">
                        基准日 {overview?.regime_date ?? "—"} · 0-Token 规则计算
                      </span>
                    </div>
                  </div>

                  {/* Headline Metrics Strip */}
                  <div className="grid grid-cols-2 gap-3 border-y border-zinc-800/90 py-3.5 sm:grid-cols-4">
                    <div>
                      <div className="font-mono text-[10px] tracking-wider text-zinc-500">
                        美联储净流动性 Net Liq
                      </div>
                      <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-white">
                        {overview?.macro?.net_liquidity.latest_billions != null
                          ? `$${overview.macro.net_liquidity.latest_billions.toLocaleString()}B`
                          : "—"}
                      </div>
                      <div
                        className={`font-mono text-[11px] tabular-nums ${deltaTone(
                          overview?.macro?.net_liquidity.delta_20d_billions,
                          true
                        )}`}
                      >
                        20D {fmtSigned(overview?.macro?.net_liquidity.delta_20d_billions, 1, "B")}
                      </div>
                    </div>

                    <div>
                      <div className="font-mono text-[10px] tracking-wider text-zinc-500">
                        美债利差 10Y–2Y Curve
                      </div>
                      <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-white">
                        {fmtSigned(overview?.macro?.yield_credit.yield_spread_10y2y, 2, "%")}
                      </div>
                      <div className="font-mono text-[11px] tabular-nums text-zinc-400">
                        10Y {fmtNum(overview?.macro?.yield_credit.dgs10, 2, "%")} · 实际 Real{" "}
                        {fmtNum(overview?.macro?.yield_credit.dfii10, 2, "%")}
                      </div>
                    </div>

                    <div>
                      <div className="font-mono text-[10px] tracking-wider text-zinc-500">
                        高收益利差 HY OAS
                      </div>
                      <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-white">
                        {fmtNum(overview?.macro?.yield_credit.hy_oas, 2, "%")}
                      </div>
                      <div className="font-mono text-[11px] text-zinc-400">
                        {formatCreditState(overview?.macro?.yield_credit.credit_state)}
                      </div>
                    </div>

                    <div>
                      <div className="font-mono text-[10px] tracking-wider text-zinc-500">
                        波动期限比 VIX/VIX3M
                      </div>
                      <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-white">
                        {fmtNum(overview?.macro?.vix_structure.vix_vix3m_ratio, 3)}
                      </div>
                      <div className="font-mono text-[11px] text-zinc-400">
                        {VIX_STATE_BI[overview?.macro?.vix_structure.structure_state ?? ""] ??
                          overview?.macro?.vix_structure.structure_state ??
                          "—"}
                      </div>
                    </div>
                  </div>

                  {/* Deterministic Drivers */}
                  <div className="flex flex-wrap gap-2">
                    {(overview?.regime?.drivers ?? []).map((driver) => (
                      <span
                        key={driver}
                        className="rounded-md border border-zinc-800 bg-zinc-900/70 px-2.5 py-1 font-mono text-[11px] text-zinc-300"
                      >
                        {formatDriverText(driver)}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Fed Net Liquidity ECharts Area */}
                <div className="mt-4">
                  <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-zinc-500">
                    <span>WALCL – WTREGEN – RRPONTSYD (90-Obs Trajectory, USD Billions)</span>
                    <span>Updated {overview?.macro?.net_liquidity.latest_date ?? "—"}</span>
                  </div>
                  <NetLiquidityChart
                    series={overview?.macro?.net_liquidity.series ?? []}
                    height={165}
                  />
                </div>
              </SpotlightBlock>

              {/* Layer 2 & 5: Gallery White Volatility, Credit Details & Fear/Greed */}
              <SpotlightBlock tone="gallery" className="flex flex-col justify-between p-6 lg:col-span-5">
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-mono text-[10px] tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                      LAYER 02 &amp; 05 · 波动率期限与市场情绪 (Vol &amp; Sentiment)
                    </div>
                    <span className="shrink-0 whitespace-nowrap rounded-full border border-zinc-200/80 bg-white/70 px-2.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:border-white/10 dark:bg-white/[0.06] dark:text-zinc-300">
                      5 维合成模型 · 5-Pillar
                    </span>
                  </div>

                  {/* Fear & Greed Editorial Meter */}
                  <div className="rounded-xl border border-zinc-200/80 bg-white/55 p-4 backdrop-blur-md dark:border-white/10 dark:bg-white/[0.03]">
                    <div className="flex items-baseline justify-between">
                      <div>
                        <div className="font-mono text-[10px] tracking-wider text-zinc-500 dark:text-zinc-400">
                          自研恐慌贪婪指数 Fear &amp; Greed Index
                        </div>
                        <div className="mt-1 flex items-baseline gap-2.5">
                          <span className="font-mono text-3xl font-bold tabular-nums text-zinc-950 dark:text-white">
                            {fmtNum(overview?.regime?.fear_greed.score, 1)}
                          </span>
                          <span className="font-serif text-lg italic text-zinc-700 dark:text-zinc-300">
                            {SENTIMENT_BI[overview?.regime?.fear_greed.label ?? ""] ??
                              overview?.regime?.fear_greed.label ??
                              "Unavailable"}
                          </span>
                        </div>
                      </div>
                      <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                        0 极恐 Fear · 100 极贪 Greed
                      </span>
                    </div>

                    <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-white/10">
                      <div
                        className="h-full rounded-full bg-zinc-950 transition-all duration-700 dark:bg-zinc-100"
                        style={{
                          width: `${Math.min(100, Math.max(4, overview?.regime?.fear_greed.score ?? 0))}%`,
                        }}
                      />
                    </div>

                    <div className="mt-3 grid grid-cols-5 gap-2">
                      {Object.entries(overview?.regime?.fear_greed.components ?? {}).map(
                        ([pillar, score]) => (
                          <div key={pillar} className="text-center">
                            <div className="font-mono text-[11px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                              {score !== null && score !== undefined ? score.toFixed(0) : "—"}
                            </div>
                            <div className="truncate font-mono text-[9px] text-zinc-500 dark:text-zinc-400">
                              {PILLAR_BI[pillar] ?? pillar.replace("_", " ")}
                            </div>
                          </div>
                        )
                      )}
                    </div>
                  </div>

                  {/* VIX Term Curve */}
                  <div>
                    <div className="mb-2 flex items-center justify-between font-mono text-[10px] tracking-wider text-zinc-500 dark:text-zinc-400">
                      <span>CBOE 波动率期限结构 (VIX Curve)</span>
                      <span className="text-zinc-800 dark:text-zinc-200">
                        {VIX_STATE_BI[overview?.macro?.vix_structure.structure_state ?? ""] ??
                          overview?.macro?.vix_structure.structure_state ??
                          "—"}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2.5">
                      {[
                        { label: "VIX9D (9日短端)", val: overview?.macro?.vix_structure.vix9d },
                        { label: "VIX (30日基准)", val: overview?.macro?.vix_structure.vix },
                        { label: "VIX3M (3月远端)", val: overview?.macro?.vix_structure.vix3m },
                      ].map((v) => (
                        <div
                          key={v.label}
                          className="rounded-xl border border-zinc-200/80 bg-white/70 px-3 py-2.5 backdrop-blur-md transition-colors group-hover/panel:border-zinc-300/90 dark:border-white/10 dark:bg-white/[0.04] dark:group-hover/panel:border-white/20"
                        >
                          <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">{v.label}</div>
                          <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-zinc-950 dark:text-white">
                            {fmtNum(v.val, 2)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Funding & Credit Plumbing Table */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-zinc-200/80 pt-3 font-mono text-xs tabular-nums dark:border-white/10">
                    <div className="flex justify-between">
                      <span className="text-zinc-500 dark:text-zinc-400">SOFR 隔夜利率</span>
                      <span className="font-medium text-zinc-950 dark:text-zinc-100">
                        {fmtNum(overview?.macro?.yield_credit.sofr, 2, "%")}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500 dark:text-zinc-400">银行准备金 Reserves</span>
                      <span className="font-medium text-zinc-950 dark:text-zinc-100">
                        {overview?.macro?.yield_credit.wresbal_billions != null
                          ? `$${overview.macro.yield_credit.wresbal_billions.toLocaleString()}B`
                          : "—"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500 dark:text-zinc-400">投资级利差 IG OAS</span>
                      <span className="font-medium text-zinc-950 dark:text-zinc-100">
                        {fmtNum(overview?.macro?.yield_credit.ig_oas, 2, "%")}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500 dark:text-zinc-400">HYG / LQD (20D)</span>
                      <span className="font-medium text-zinc-950 dark:text-zinc-100">
                        {fmtNum(overview?.macro?.yield_credit.hyg_lqd_ratio, 3)}{" "}
                        <span
                          className={deltaTone(
                            overview?.macro?.yield_credit.hyg_lqd_20d_delta_pct,
                            false
                          )}
                        >
                          ({fmtSigned(overview?.macro?.yield_credit.hyg_lqd_20d_delta_pct, 2, "%")})
                        </span>
                      </span>
                    </div>
                  </div>

                  {/* 30-Day Regime & Fear/Greed Trajectory Strip */}
                  {regimeHistory.length > 0 && (
                    <div className="border-t border-zinc-200/80 pt-3 dark:border-white/10">
                      <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                        <span>近 {regimeHistory.length} 日情绪与体制轨迹 (Fear &amp; Greed Track)</span>
                        <span>最新 {regimeHistory[regimeHistory.length - 1]?.regime_date}</span>
                      </div>
                      <div className="flex h-10 items-end gap-1">
                        {regimeHistory.slice(-20).map((pt) => {
                          const score = Math.min(100, Math.max(8, pt.fear_greed_score ?? 40));
                          const tone =
                            pt.regime_label === "RISK_OFF_STRESS"
                              ? "bg-rose-500"
                              : pt.regime_label === "RISK_ON_EXPANSION"
                                ? "bg-emerald-600 dark:bg-emerald-500"
                                : "bg-zinc-700 dark:bg-zinc-400";
                          return (
                            <div
                              key={pt.regime_date}
                              title={`${pt.regime_date}: ${pt.regime_label} (F&G ${pt.fear_greed_score ?? "—"}, VIX ${pt.vix_spot ?? "—"})`}
                              className={`flex-1 rounded-t-sm transition-all ${tone}`}
                              style={{ height: `${score}%` }}
                            />
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </SpotlightBlock>
            </motion.section>

            {/* BAND 2: GALLERY WHITE (5 cols) + OBSIDIAN (7 cols) — Alternating Checkered Rhythm */}
            <motion.section
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.06, ease: EASE_EXPO }}
              className="grid grid-cols-1 gap-5 lg:grid-cols-12"
            >
              {/* Layer 3 & 4 Left: Gallery White Core Indices & Market Breadth */}
              <SpotlightBlock tone="gallery" className="flex flex-col justify-between p-6 lg:col-span-5">
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-mono text-[10px] tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                      LAYER 03 · 核心指数与市场广度 (Core &amp; Breadth)
                    </div>
                    <span className="shrink-0 font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                      点击行切换 K 线 · Click row
                    </span>
                  </div>

                  {/* Breadth Summary Pills */}
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-xl border border-zinc-200/80 bg-white/60 p-2.5 backdrop-blur-md dark:border-white/10 dark:bg-white/[0.04]">
                      <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                        站上 50日线 &gt;50MA
                      </div>
                      <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-zinc-950 dark:text-white">
                        {fmtNum(overview?.equities?.breadth.pct_above_50ma, 1, "%")}
                      </div>
                    </div>
                    <div className="rounded-xl border border-zinc-200/80 bg-white/60 p-2.5 backdrop-blur-md dark:border-white/10 dark:bg-white/[0.04]">
                      <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                        站上 200日线 &gt;200MA
                      </div>
                      <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-zinc-950 dark:text-white">
                        {fmtNum(overview?.equities?.breadth.pct_above_200ma, 1, "%")}
                      </div>
                    </div>
                    <div className="rounded-xl border border-zinc-200/80 bg-white/60 p-2.5 backdrop-blur-md dark:border-white/10 dark:bg-white/[0.04]">
                      <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                        等权强弱 RSP/SPY
                      </div>
                      <div
                        className={`mt-0.5 font-mono text-base font-semibold tabular-nums ${deltaTone(
                          overview?.equities?.breadth.rsp_spy_20d_delta_pct,
                          false
                        )}`}
                      >
                        {fmtSigned(overview?.equities?.breadth.rsp_spy_20d_delta_pct, 2, "%")}
                      </div>
                    </div>
                  </div>

                  {/* Core Indices Table */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-left font-mono text-xs tabular-nums">
                      <thead>
                        <tr className="border-b border-zinc-200/80 text-[10px] uppercase text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                          <th className="py-2 font-medium">Ticker</th>
                          <th className="py-2 text-right font-medium">Close</th>
                          <th className="py-2 text-right font-medium">1D</th>
                          <th className="py-2 text-right font-medium">20D</th>
                          <th className="py-2 text-right font-medium">RSI14</th>
                          <th className="py-2 text-right font-medium">RVOL</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-200/60 dark:divide-white/10">
                        {Object.entries(overview?.equities?.core_indices ?? {}).map(
                          ([sym, tech]) => {
                            const active = selectedSymbol === sym;
                            return (
                              <tr
                                key={sym}
                                onClick={() => setSelectedSymbol(sym)}
                                className={`cursor-pointer transition-colors ${
                                  active
                                    ? "bg-zinc-950 text-white dark:bg-white/[0.14] dark:text-white dark:ring-1 dark:ring-inset dark:ring-white/25"
                                    : "text-zinc-900 hover:bg-zinc-900/[0.04] dark:text-zinc-100 dark:hover:bg-white/[0.06]"
                                }`}
                              >
                                <td className="py-2.5 pl-2 font-semibold">{sym}</td>
                                <td className="py-2.5 text-right">
                                  {tech.last_close != null
                                    ? sym === "BTCUSDT"
                                      ? `$${tech.last_close.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                                      : `$${tech.last_close.toFixed(2)}`
                                    : "—"}
                                </td>
                                <td
                                  className={`py-2.5 text-right ${deltaTone(
                                    tech.change_1d_pct,
                                    active || theme === "dark"
                                  )}`}
                                >
                                  {fmtSigned(tech.change_1d_pct, 2, "%")}
                                </td>
                                <td
                                  className={`py-2.5 text-right ${deltaTone(
                                    tech.change_20d_pct,
                                    active || theme === "dark"
                                  )}`}
                                >
                                  {fmtSigned(tech.change_20d_pct, 2, "%")}
                                </td>
                                <td className="py-2.5 text-right">{fmtNum(tech.rsi_14, 1)}</td>
                                <td className="py-2.5 pr-2 text-right">
                                  {fmtNum(tech.rvol_20, 2, "x")}
                                </td>
                              </tr>
                            );
                          }
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Global Search Any US Ticker + Filtered Watchlist */}
                <div className="mt-4 space-y-2.5 border-t border-zinc-200/80 pt-3 dark:border-white/10">
                  <form onSubmit={handleGlobalTickerSearch} className="flex gap-1.5">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                      <input
                        type="text"
                        value={tickerSearchInput}
                        onChange={(e) => setTickerSearchInput(e.target.value.toUpperCase())}
                        placeholder="输入任意美股代码直查 K 线/GEX/EPS，如 AMD, PLTR, TSM..."
                        className="w-full rounded-lg border border-zinc-300/90 bg-white/80 py-1.5 pr-2 pl-8 font-mono text-[11px] uppercase text-zinc-950 backdrop-blur-md placeholder:normal-case placeholder:text-zinc-400 focus:border-zinc-950 focus:outline-none dark:border-white/15 dark:bg-white/[0.05] dark:text-white dark:focus:border-white/50"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={searchingTicker || !tickerSearchInput.trim()}
                      className="rounded-lg bg-zinc-950 px-3 py-1.5 font-mono text-[11px] font-medium text-white transition hover:bg-zinc-800 disabled:opacity-40 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                    >
                      {searchingTicker ? "拉取中..." : "调入看盘"}
                    </button>
                  </form>
                  {tickerSearchError && (
                    <p className="font-mono text-[10px] text-rose-600 dark:text-rose-400">{tickerSearchError}</p>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                    <span>观测资产池 Watchlist ({filteredWatchlist.length})</span>
                    <div className="flex items-center gap-1">
                      {(
                        [
                          { id: "all", label: "全部" },
                          { id: "etf", label: "ETF" },
                          { id: "equity", label: "个股" },
                        ] as const
                      ).map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => setWatchlistFilter(f.id)}
                          className={`rounded px-1.5 py-0.5 transition ${
                            watchlistFilter === f.id
                              ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                              : "bg-zinc-100/80 text-zinc-600 hover:bg-zinc-200 dark:bg-white/[0.06] dark:text-zinc-300 dark:hover:bg-white/[0.12]"
                          }`}
                        >
                          {f.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          setWatchlistSort((s) => (s === "alpha" ? "chg_desc" : "alpha"))
                        }
                        className="rounded border border-zinc-200/80 px-1.5 py-0.5 text-zinc-600 hover:bg-zinc-100 dark:border-white/15 dark:text-zinc-300 dark:hover:bg-white/[0.08]"
                      >
                        {watchlistSort === "alpha" ? "A→Z" : "涨幅↓"}
                      </button>
                    </div>
                  </div>

                  <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto pr-1">
                    {filteredWatchlist.map((a) => (
                      <button
                        key={a.symbol}
                        type="button"
                        onClick={() => setSelectedSymbol(a.symbol)}
                        className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] transition ${
                          selectedSymbol === a.symbol
                            ? "border-zinc-950 bg-zinc-950 text-white dark:border-white/40 dark:bg-white dark:text-zinc-950"
                            : "border-zinc-200/80 bg-white/70 text-zinc-700 hover:border-zinc-400 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-200 dark:hover:border-white/30"
                        }`}
                      >
                        <span>{a.symbol}</span>
                        {a.change_1d_pct !== null && (
                          <span
                            className={deltaTone(a.change_1d_pct, selectedSymbol === a.symbol && theme !== "dark")}
                          >
                            {a.change_1d_pct >= 0 ? "+" : ""}
                            {a.change_1d_pct.toFixed(1)}%
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </SpotlightBlock>

              {/* Layer 4 Right: Obsidian Interactive Asset Candlestick & Micro Technicals */}
              <SpotlightBlock tone="obsidian" tilt="subtle" className="flex flex-col justify-between p-6 lg:col-span-7">
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.16em] text-zinc-400">
                        <Activity className="h-3.5 w-3.5" />
                        LAYER 04 · 个股微观量价与均线 (Micro Structure)
                      </div>
                      <div className="mt-1 flex flex-wrap items-baseline gap-3">
                        <h2 className="font-serif text-2xl text-white sm:text-3xl">
                          {selectedSymbol}
                        </h2>
                        <span className="font-mono text-lg font-semibold tabular-nums text-white">
                          {assetDetail?.technicals.last_close != null
                            ? `$${assetDetail.technicals.last_close.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}`
                            : "—"}
                        </span>
                        <span
                          className={`font-mono text-xs tabular-nums ${deltaTone(
                            assetDetail?.technicals.change_1d_pct,
                            true
                          )}`}
                        >
                          {fmtSigned(assetDetail?.technicals.change_1d_pct, 2, "%")} (1D)
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] text-zinc-300">
                        {formatVolumePriceTag(assetDetail?.technicals.volume_price_tag)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setDrawerOpen(true)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1 font-mono text-[10px] font-medium text-emerald-300 transition hover:border-emerald-400/60 hover:bg-emerald-500/20"
                      >
                        <Sparkles className="h-3 w-3" />
                        AI 协查 {selectedSymbol}
                      </button>
                    </div>
                  </div>

                  {/* Single-line Technicals Telemetry Strip */}
                  <div className="grid grid-cols-3 gap-2 rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-2.5 font-mono text-[11px] tabular-nums sm:grid-cols-6">
                    <div>
                      <span className="block text-[9px] uppercase text-zinc-500">RSI(14)</span>
                      <span className="text-zinc-100">
                        {fmtNum(assetDetail?.technicals.rsi_14, 1)}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[9px] uppercase text-zinc-500">RVOL(20)</span>
                      <span className="text-zinc-100">
                        {fmtNum(assetDetail?.technicals.rvol_20, 2, "x")}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[9px] uppercase text-zinc-500">ATR(14)</span>
                      <span className="text-zinc-100">
                        {fmtNum(assetDetail?.technicals.atr_pct, 2, "%")}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[9px] uppercase text-zinc-500">距50日线 Dist 50MA</span>
                      <span
                        className={deltaTone(assetDetail?.technicals.dist_50ma_pct, true)}
                      >
                        {fmtSigned(assetDetail?.technicals.dist_50ma_pct, 2, "%")}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[9px] uppercase text-zinc-500">距200日线 Dist 200MA</span>
                      <span
                        className={deltaTone(assetDetail?.technicals.dist_200ma_pct, true)}
                      >
                        {fmtSigned(assetDetail?.technicals.dist_200ma_pct, 2, "%")}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[9px] uppercase text-zinc-500">MACD Hist</span>
                      <span
                        className={deltaTone(
                          assetDetail?.technicals.macd?.histogram,
                          true
                        )}
                      >
                        {fmtSigned(assetDetail?.technicals.macd?.histogram, 3)}
                      </span>
                    </div>
                  </div>

                  {/* TradingView Lightweight Charts */}
                  {assetLoading && !assetDetail ? (
                    <div className="flex h-[320px] items-center justify-center rounded-xl border border-zinc-800 font-mono text-xs text-zinc-500">
                      Loading {selectedSymbol} consolidated OHLCV...
                    </div>
                  ) : (
                    <AssetCandlestickChart
                      symbol={selectedSymbol}
                      bars={assetDetail?.bars ?? []}
                      gex={assetDetail?.options_gex}
                      height={310}
                    />
                  )}
                </div>

                {/* Focused Ticker Estimated GEX & Finnhub EPS / Analyst Consensus Strip */}
                {(assetDetail?.options_gex ||
                  (assetDetail?.eps_history && assetDetail.eps_history.length > 0) ||
                  (assetDetail?.recommendations && assetDetail.recommendations.length > 0)) && (
                  <div className="mt-3 grid grid-cols-1 gap-2.5 border-t border-zinc-800 pt-3 sm:grid-cols-2">
                    {assetDetail?.options_gex && (
                      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-2.5 font-mono text-[11px]">
                        <div className="text-[10px] text-zinc-400">
                          {selectedSymbol} 估算期权墙 (Estimated GEX)
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
                          <span className={deltaTone(assetDetail.options_gex.net_gex, true)}>
                            Net {fmtBillions(assetDetail.options_gex.net_gex)}
                          </span>
                          <span className="text-emerald-400">
                            Call ${assetDetail.options_gex.call_wall?.toFixed(0) ?? "—"}
                          </span>
                          <span className="text-rose-400">
                            Put ${assetDetail.options_gex.put_wall?.toFixed(0) ?? "—"}
                          </span>
                          <span className="text-amber-400">
                            ZG ${assetDetail.options_gex.zero_gamma?.toFixed(2) ?? "—"}
                          </span>
                        </div>
                      </div>
                    )}

                    {assetDetail?.eps_history && assetDetail.eps_history.length > 0 && (
                      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-2.5 font-mono text-[11px]">
                        <div className="flex items-center justify-between text-[10px] text-zinc-400">
                          <span>Finnhub 季度 EPS 实际 vs 预期</span>
                          {assetDetail.recommendations?.[0] && (
                            <span className="text-zinc-300">
                              评级 买{assetDetail.recommendations[0].strong_buy + assetDetail.recommendations[0].buy}/持{assetDetail.recommendations[0].hold}/卖{assetDetail.recommendations[0].sell + assetDetail.recommendations[0].strong_sell}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 grid grid-cols-2 gap-1.5 text-[10px] tabular-nums">
                          {assetDetail.eps_history.slice(0, 2).map((ep) => (
                            <div key={ep.period} className="rounded bg-zinc-900 px-2 py-1">
                              <span className="text-zinc-400">{ep.period.slice(0, 7)} </span>
                              <span className="text-white">
                                {ep.actual !== null ? `$${ep.actual.toFixed(2)}` : "—"}
                              </span>
                              <span className="text-zinc-500">
                                {" "}
                                / Est {ep.estimate !== null ? `$${ep.estimate.toFixed(2)}` : "—"}
                              </span>
                              {ep.surprise_percent !== null && (
                                <span className={` ml-1 ${deltaTone(ep.surprise_percent, true)}`}>
                                  ({ep.surprise_percent >= 0 ? "+" : ""}
                                  {ep.surprise_percent.toFixed(1)}%)
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Compact News Strip (if available from Alpaca) */}
                {assetDetail?.news && assetDetail.news.length > 0 && (
                  <div className="mt-3 border-t border-zinc-800 pt-3">
                    <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] tracking-wider text-zinc-500">
                      <Newspaper className="h-3 w-3" />
                      最新财经快讯 Headlines ({selectedSymbol})
                    </div>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {assetDetail.news.slice(0, 2).map((n) => (
                        <a
                          key={n.id}
                          href={n.url}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate rounded-lg border border-zinc-800/80 bg-zinc-900/50 px-2.5 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-600 hover:text-white"
                        >
                          <span className="mr-1.5 font-mono text-[10px] text-zinc-500">
                            {n.source}
                          </span>
                          {n.headline}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </SpotlightBlock>
            </motion.section>

            {/* BAND 3: GALLERY WHITE GEX (7 cols) + OBSIDIAN SECTORS (5 cols) */}
            <motion.section
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.12, ease: EASE_EXPO }}
              className="grid grid-cols-1 gap-5 lg:grid-cols-12"
            >
              {/* Estimated GEX Strike Profile */}
              <SpotlightBlock tone="gallery" tilt="subtle" className="p-6 lg:col-span-7">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                      <BarChart3 className="h-3.5 w-3.5" />
                      LAYER 02 · 期权做市商墙体分布 (Dealer Positioning)
                    </div>
                    <h2 className="mt-1 font-serif text-2xl text-zinc-950 dark:text-white">
                      {gexSymbol} Estimated GEX 伽马敞口估算
                    </h2>
                  </div>

                  <div className="flex items-center gap-1 rounded-full border border-zinc-200/80 bg-zinc-100/80 p-0.5 font-mono text-[11px] dark:border-white/10 dark:bg-white/[0.06]">
                    {(["SPY", "QQQ"] as const).map((sym) => (
                      <button
                        key={sym}
                        type="button"
                        onClick={() => setGexSymbol(sym)}
                        className={`rounded-full px-3 py-1 transition ${
                          gexSymbol === sym
                            ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                            : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                        }`}
                      >
                        {sym}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-2 rounded-lg border border-zinc-200/80 bg-white/50 px-3 py-1.5 font-mono text-[10px] text-zinc-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-400">
                  {activeGex?.assumption_label ??
                    "Estimated GEX ($ / 1% Move · Dealer Positioning · OCC T+1/T+2 OI)"}
                </div>

                {/* Key Wall Stats */}
                <div className="my-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
                  {[
                    {
                      label: "现价 Spot Ref",
                      value: activeGex ? `$${activeGex.spot_price.toFixed(2)}` : "—",
                      cls: "text-zinc-950 dark:text-white",
                    },
                    {
                      label: "净伽马 Net GEX",
                      value: activeGex ? fmtBillions(activeGex.net_gex) : "—",
                      cls: deltaTone(activeGex?.net_gex, false),
                    },
                    {
                      label: "看涨墙 Call Wall",
                      value: activeGex?.call_wall ? `$${activeGex.call_wall.toFixed(0)}` : "—",
                      cls: "text-emerald-600 dark:text-emerald-400",
                    },
                    {
                      label: "看跌墙 Put Wall",
                      value: activeGex?.put_wall ? `$${activeGex.put_wall.toFixed(0)}` : "—",
                      cls: "text-rose-600 dark:text-rose-400",
                    },
                    {
                      label: "翻转位 Zero Gamma",
                      value: activeGex?.zero_gamma ? `$${activeGex.zero_gamma.toFixed(2)}` : "—",
                      cls: "text-amber-600 dark:text-amber-400",
                    },
                  ].map((stat) => (
                    <div
                      key={stat.label}
                      className="rounded-xl border border-zinc-200/80 bg-white/70 px-3 py-2 backdrop-blur-md dark:border-white/10 dark:bg-white/[0.04]"
                    >
                      <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">{stat.label}</div>
                      <div
                        className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${stat.cls}`}
                      >
                        {stat.value}
                      </div>
                    </div>
                  ))}
                </div>

                <GexProfileChart
                  profile={activeGex?.strike_profile ?? []}
                  spotPrice={activeGex?.spot_price ?? 0}
                  callWall={activeGex?.call_wall ?? null}
                  putWall={activeGex?.put_wall ?? null}
                  zeroGamma={activeGex?.zero_gamma ?? null}
                  height={235}
                />

                {activeGex && (
                  <div className="mt-2 flex flex-wrap justify-between font-mono text-[10px] text-zinc-500 tabular-nums">
                    <span>
                      P/C OI Ratio: {fmtNum(activeGex.put_call_ratio, 2)} · Call OI{" "}
                      {activeGex.total_call_oi.toLocaleString()} · Put OI{" "}
                      {activeGex.total_put_oi.toLocaleString()}
                    </span>
                    <span>Snapshot {activeGex.snapshot_time.slice(0, 16).replace("T", " ")} UTC</span>
                  </div>
                )}
              </SpotlightBlock>

              {/* Layer 3 Right: Obsidian 11-Sector Rotation Matrix */}
              <SpotlightBlock tone="obsidian" className="p-6 lg:col-span-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-[10px] tracking-[0.16em] text-zinc-400">
                      LAYER 03 · 11 大板块轮动热力 (SPDR Sector Rotation)
                    </div>
                    <h2 className="mt-1 font-serif text-xl text-white sm:text-2xl">
                      进攻 Offensive / 周期 Cyclical / 防御 Defensive
                    </h2>
                  </div>
                  <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-zinc-500">按20日排序</span>
                </div>

                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-left font-mono text-xs tabular-nums">
                    <thead>
                      <tr className="border-b border-zinc-800 text-[10px] uppercase text-zinc-500">
                        <th className="py-2 font-medium">ETF</th>
                        <th className="py-2 font-medium">风格 Bucket</th>
                        <th className="py-2 text-right font-medium">1D</th>
                        <th className="py-2 text-right font-medium">20D</th>
                        <th className="py-2 text-right font-medium">vs SPY</th>
                        <th className="py-2 text-right font-medium">RVOL</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/60">
                      {(overview?.equities?.sector_rotation ?? []).map((sec) => (
                        <tr
                          key={sec.symbol}
                          onClick={() => setSelectedSymbol(sec.symbol)}
                          className={`cursor-pointer transition ${
                            selectedSymbol === sec.symbol
                              ? "bg-white text-zinc-950 dark:bg-white/[0.14] dark:text-white dark:ring-1 dark:ring-inset dark:ring-white/25"
                              : "hover:bg-zinc-900/70 text-zinc-200"
                          }`}
                        >
                          <td className="py-2 pl-2 font-semibold">{sec.symbol}</td>
                          <td className="py-2 text-[10px] opacity-80">
                            {BUCKET_BI[sec.bucket] ?? sec.bucket}
                          </td>
                          <td
                            className={`py-2 text-right ${deltaTone(
                              sec.return_1d_pct,
                              selectedSymbol !== sec.symbol || theme === "dark"
                            )}`}
                          >
                            {fmtSigned(sec.return_1d_pct, 2, "%")}
                          </td>
                          <td
                            className={`py-2 text-right ${deltaTone(
                              sec.return_20d_pct,
                              selectedSymbol !== sec.symbol
                            )}`}
                          >
                            {fmtSigned(sec.return_20d_pct, 2, "%")}
                          </td>
                          <td
                            className={`py-2 text-right ${deltaTone(
                              sec.rel_spy_20d_pct,
                              selectedSymbol !== sec.symbol
                            )}`}
                          >
                            {fmtSigned(sec.rel_spy_20d_pct, 2, "%")}
                          </td>
                          <td className="py-2 pr-2 text-right">
                            {fmtNum(sec.rvol_20, 2, "x")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SpotlightBlock>
            </motion.section>

            {/* BAND 4: OBSIDIAN (4 cols) + GALLERY WHITE (4 cols) + OBSIDIAN (4 cols) */}
            <motion.section
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.18, ease: EASE_EXPO }}
              className="grid grid-cols-1 gap-5 lg:grid-cols-12"
            >
              {/* Cross-Asset Rolling Correlations */}
              <SpotlightBlock tone="obsidian" tilt="subtle" className="p-6 lg:col-span-4">
                <div className="font-mono text-[10px] tracking-[0.16em] text-zinc-400">
                  LAYER 03 · 跨资产协同关系 (Cross-Asset Fit)
                </div>
                <h3 className="mt-1 font-serif text-xl text-white">
                  跨资产滚动相关性 (vs SPY)
                </h3>
                <p className="mt-0.5 font-mono text-[10px] text-zinc-500">
                  美元 USD (UUP), 黄金 Gold (GLD), 铜 Copper (CPER), 美债 Bonds (TLT), BTC
                </p>
                <div className="mt-3">
                  <CorrelationHeatmapChart
                    correlations={overview?.equities?.cross_asset_correlations ?? {}}
                    height={235}
                  />
                </div>
              </SpotlightBlock>

              {/* Institutional CFTC COT Futures Positioning */}
              <SpotlightBlock tone="gallery" className="p-6 lg:col-span-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-mono text-[10px] tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                      LAYER 05 · CFTC 机构期货净持仓 (COT)
                    </div>
                    <h3 className="mt-1 font-serif text-xl text-zinc-950 dark:text-white">
                      非商业投机净头寸 Net Positioning
                    </h3>
                  </div>
                  <span className="shrink-0 whitespace-nowrap rounded border border-zinc-200/80 px-2 py-0.5 font-mono text-[10px] text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                    周更 Weekly
                  </span>
                </div>

                <div className="mt-4 space-y-3">
                  {Object.entries(overview?.positioning_and_calendar?.cot ?? {}).map(
                    ([code, row]) => {
                      const pct = row.noncomm_net_pct_oi ?? 0;
                      const barWidth = Math.min(100, Math.max(6, Math.abs(pct) * 2.5));
                      return (
                        <div
                          key={code}
                          className="rounded-xl border border-zinc-200/80 bg-white/60 p-3 backdrop-blur-md dark:border-white/10 dark:bg-white/[0.04]"
                        >
                          <div className="flex items-center justify-between font-mono text-xs">
                            <span className="font-semibold text-zinc-950 dark:text-white">
                              {code}{" "}
                              <span className="font-normal text-zinc-500 dark:text-zinc-400">· {row.contract}</span>
                            </span>
                            <span
                              className={`font-semibold tabular-nums ${deltaTone(
                                row.noncomm_net,
                                false
                              )}`}
                            >
                              {row.noncomm_net >= 0 ? "+" : ""}
                              {row.noncomm_net.toLocaleString()}
                            </span>
                          </div>
                          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-white/10">
                            <div
                              className={`h-full rounded-full ${
                                row.noncomm_net >= 0 ? "bg-emerald-600 dark:bg-emerald-500" : "bg-rose-600 dark:bg-rose-500"
                              }`}
                              style={{ width: `${barWidth}%` }}
                            />
                          </div>
                          <div className="mt-1.5 flex justify-between font-mono text-[10px] text-zinc-500 tabular-nums dark:text-zinc-400">
                            <span>
                              WoW:{" "}
                              {row.wow_change !== null
                                ? `${row.wow_change >= 0 ? "+" : ""}${row.wow_change.toLocaleString()}`
                                : "—"}
                            </span>
                            <span>
                              {fmtSigned(row.noncomm_net_pct_oi, 1, "% OI")} · {row.report_date}
                            </span>
                          </div>
                        </div>
                      );
                    }
                  )}
                </div>
              </SpotlightBlock>

              {/* Catalyst Calendar: FRED Macro + Finnhub Earnings */}
              <SpotlightBlock tone="obsidian" className="p-6 lg:col-span-4">
                <div className="flex flex-wrap items-start justify-between gap-2.5">
                  <div>
                    <div className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.16em] text-zinc-400">
                      <Calendar className="h-3 w-3 shrink-0" />
                      LAYER 05 · 事件催化剂日历 (Catalysts)
                    </div>
                    <h3 className="mt-1 font-serif text-xl text-white">
                      宏观发布与重点财报 Macro &amp; Earnings
                    </h3>
                  </div>

                  <div className="flex shrink-0 items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900 p-0.5 font-mono text-[10px]">
                    {(
                      [
                        { id: "all", label: "全部 All" },
                        { id: "macro", label: "宏观 Macro" },
                        { id: "earnings", label: "财报 Earn" },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setCalendarFilter(tab.id)}
                        className={`whitespace-nowrap rounded-full px-2 py-0.5 transition ${
                          calendarFilter === tab.id
                            ? "bg-white text-zinc-950"
                            : "text-zinc-400 hover:text-white"
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-4 max-h-[260px] space-y-2 overflow-y-auto pr-1">
                  {filteredCalendar.length === 0 ? (
                    <div className="rounded-xl border border-zinc-800 p-4 text-center font-mono text-xs text-zinc-500">
                      No upcoming events in current filter window
                    </div>
                  ) : (
                    filteredCalendar.map((ev) => (
                      <div
                        key={ev.event_key}
                        className="flex items-center justify-between gap-2 rounded-xl border border-zinc-800/90 bg-zinc-900/50 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`rounded px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                                ev.event_type === "macro"
                                  ? "bg-white text-zinc-950"
                                  : "border border-zinc-700 text-zinc-300"
                              }`}
                            >
                              {ev.event_type}
                            </span>
                            <span className="truncate font-mono text-xs font-medium text-zinc-100">
                              {ev.title}
                            </span>
                          </div>
                          <div className="mt-0.5 font-mono text-[10px] text-zinc-500 tabular-nums">
                            {ev.event_time.slice(0, 10)} · Impact: {ev.impact}
                          </div>
                        </div>

                        {(ev.actual !== null && ev.actual !== undefined) ||
                        ev.estimate !== null ||
                        ev.eps_actual != null ||
                        ev.eps_estimate !== null ? (
                          <div className="shrink-0 text-right font-mono text-[10px] tabular-nums">
                            {ev.event_type === "macro" ? (
                              <>
                                {ev.actual != null && (
                                  <span className="block font-semibold text-emerald-400">
                                    实际 {ev.actual}
                                  </span>
                                )}
                                {ev.estimate != null && (
                                  <span className="text-zinc-400">预期 {ev.estimate}</span>
                                )}
                              </>
                            ) : (
                              <>
                                {ev.eps_actual != null && (
                                  <span className="block font-semibold text-emerald-400">
                                    实际 ${ev.eps_actual.toFixed(2)}
                                  </span>
                                )}
                                {ev.eps_estimate !== null && (
                                  <span className="text-zinc-300">
                                    Est ${ev.eps_estimate.toFixed(2)}
                                  </span>
                                )}
                              </>
                            )}
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </SpotlightBlock>
            </motion.section>
          </>
        )}
      </main>
      )}

      {/* Full-Width Bottom Auto-Scrolling Macro Ticker Strip (with swipe & K-Line sparklines) */}
      <MacroTickerStrip
        selectedSymbol={selectedSymbol}
        onSelectProxy={(proxySymbol) => {
          setSelectedSymbol(proxySymbol);
          if (viewMode !== "cockpit") {
            setViewMode("cockpit");
          }
        }}
      />

      <InvestigatorDrawer
        open={drawerOpen && viewMode === "cockpit"}
        mode="drawer"
        onClose={() => setDrawerOpen(false)}
        onOpenFullWorkspace={() => setViewMode("copilot")}
        defaultSymbol={selectedSymbol}
      />
    </div>
  );
}

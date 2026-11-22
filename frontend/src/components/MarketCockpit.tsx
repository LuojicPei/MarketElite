"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  BarChart3,
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
import StockDetailView from "@/components/StockDetailView";
import WatchlistCardPanel from "@/components/WatchlistCardPanel";
import WatchlistWorkspace from "@/components/WatchlistWorkspace";
import { PortfolioWatchdogView } from "@/components/PortfolioWatchdogView";
import { useTheme } from "@/components/ThemeProvider";
import AssetCandlestickChart from "@/components/charts/AssetCandlestickChart";
import GexProfileChart from "@/components/charts/GexProfileChart";
import NetLiquidityChart from "@/components/charts/NetLiquidityChart";
import {
  AssetDetailResponse,
  DashboardOverviewResponse,
  RegimeHistoryPoint,
  TrackedAssetSummary,
  WatchlistAssetItem,
  ensureAsset,
  fetchAssetDetail,
  fetchDashboardOverview,
  fetchRegimeHistory,
  fetchTrackedAssets,
  fetchWatchdogAlerts,
  fetchWatchlist,
  triggerPipelineSync,
  updateWatchlist,
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

export type CockpitViewMode =
  | "cockpit"
  | "watchlist"
  | "stock"
  | "copilot"
  | "portfolio"
  | "infra";

interface MarketCockpitProps {
  initialView?: CockpitViewMode;
  initialStock?: string;
}

export default function MarketCockpit({
  initialView = "cockpit",
  initialStock,
}: MarketCockpitProps) {
  const normalizedInitialStock = initialStock ? initialStock.toUpperCase().trim() : undefined;
  const { theme, toggleTheme } = useTheme();
  const [viewMode, setViewMode] = useState<CockpitViewMode>(initialView);
  const [overview, setOverview] = useState<DashboardOverviewResponse | null>(null);
  const [trackedAssets, setTrackedAssets] = useState<TrackedAssetSummary[]>([]);
  const [regimeHistory, setRegimeHistory] = useState<RegimeHistoryPoint[]>([]);
  const [unackedAlerts, setUnackedAlerts] = useState<number>(0);

  const [selectedSymbol, setSelectedSymbol] = useState<string>(normalizedInitialStock || "SPY");
  const [activeStockSymbol, setActiveStockSymbol] = useState<string>(
    normalizedInitialStock || "NVDA"
  );
  const [watchlistItems, setWatchlistItems] = useState<WatchlistAssetItem[]>([]);
  const [watchlistLoading, setWatchlistLoading] = useState<boolean>(true);
  const [watchlistMutating, setWatchlistMutating] = useState<boolean>(false);
  const [watchlistError, setWatchlistError] = useState<string | null>(null);

  const [tickerSearchInput, setTickerSearchInput] = useState<string>("");
  const [searchingTicker, setSearchingTicker] = useState<boolean>(false);
  const [tickerSearchError, setTickerSearchError] = useState<string | null>(null);
  const [watchlistFilter, setWatchlistFilter] = useState<"all" | "etf" | "equity">("all");
  const [watchlistSort, setWatchlistSort] = useState<"alpha" | "chg_desc">("alpha");

  const [assetDetail, setAssetDetail] = useState<AssetDetailResponse | null>(null);
  const [gexSymbol, setGexSymbol] = useState<"SPY" | "QQQ">("SPY");
  const [loading, setLoading] = useState<boolean>(true);
  const [assetLoading, setAssetLoading] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const loadWatchlistData = useCallback(async () => {
    setWatchlistLoading(true);
    try {
      const res = await fetchWatchlist();
      setWatchlistItems(res.items);
      setWatchlistError(null);
    } catch (err) {
      setWatchlistError(err instanceof Error ? err.message : "无法读取关注列表");
    } finally {
      setWatchlistLoading(false);
    }
  }, []);

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

  const handlePersistWatchlist = async (nextSymbols: string[]) => {
    setWatchlistMutating(true);
    setWatchlistError(null);
    try {
      const updated = await updateWatchlist(nextSymbols);
      setWatchlistItems(updated.items);
    } catch (err) {
      setWatchlistError(err instanceof Error ? err.message : "更新关注列表失败");
    } finally {
      setWatchlistMutating(false);
    }
  };

  const handleAddWatchlistSymbol = async (symbol: string) => {
    const sym = symbol.toUpperCase().trim();
    if (!sym) return;
    const current = watchlistItems.map((x) => x.symbol);
    if (current.includes(sym)) {
      setWatchlistError(`${sym} 已在关注列表中`);
      return;
    }
    await handlePersistWatchlist([sym, ...current]);
  };

  const handleRemoveWatchlistSymbol = async (symbol: string) => {
    const sym = symbol.toUpperCase().trim();
    const next = watchlistItems.map((x) => x.symbol).filter((s) => s !== sym);
    await handlePersistWatchlist(next);
  };

  const handleToggleWatchlistSymbol = async (symbol: string) => {
    const sym = symbol.toUpperCase().trim();
    const current = watchlistItems.map((x) => x.symbol);
    if (current.includes(sym)) {
      await handlePersistWatchlist(current.filter((s) => s !== sym));
    } else {
      await handlePersistWatchlist([sym, ...current]);
    }
  };

  const navigateView = useCallback((mode: CockpitViewMode, stockSym?: string) => {
    setViewMode(mode);
    if (mode === "stock" && stockSym) {
      const sym = stockSym.toUpperCase().trim();
      setActiveStockSymbol(sym);
      setSelectedSymbol(sym);
      if (typeof window !== "undefined") {
        window.history.pushState({ viewMode: "stock", symbol: sym }, "", `/stocks/${sym}`);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } else if (typeof window !== "undefined" && window.location.pathname !== "/") {
      window.history.pushState({ viewMode: mode }, "", "/");
    }
  }, []);

  useEffect(() => {
    const onPopState = () => {
      if (typeof window === "undefined") return;
      const m = window.location.pathname.match(/^\/stocks\/([^/]+)/i);
      if (m && m[1]) {
        const sym = decodeURIComponent(m[1]).toUpperCase();
        setActiveStockSymbol(sym);
        setSelectedSymbol(sym);
        setViewMode("stock");
      } else {
        setViewMode("cockpit");
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
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
    loadWatchlistData();
  }, [loadOverviewAndAssets, loadWatchlistData]);

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

  const activeGex = overview?.options_gex?.[gexSymbol] ?? null;

  const leftNavItems = [
    { id: "cockpit" as const, label: "市场总览" },
    { id: "watchlist" as const, label: "我的关注" },
  ];

  const rightNavItems = [
    { id: "copilot" as const, label: "投研与风控台" },
    { id: "portfolio" as const, label: "模拟盘与复盘" },
    { id: "infra" as const, label: "系统与评测" },
  ];

  const renderNavPill = (tabItem: {
    id: "cockpit" | "watchlist" | "copilot" | "portfolio" | "infra";
    label: string;
  }) => {
    const isActive = viewMode === tabItem.id;
    return (
      <button
        key={tabItem.id}
        type="button"
        onClick={() => navigateView(tabItem.id)}
        className={`relative inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-sans text-[13px] tracking-tight transition-colors duration-200 ${
          isActive
            ? "font-semibold text-zinc-950 dark:text-white"
            : "font-medium text-zinc-800 hover:text-zinc-950 dark:text-zinc-200 dark:hover:text-white"
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
        {tabItem.id === "watchlist" && watchlistItems.length > 0 && (
          <span className="relative z-10 rounded-full bg-zinc-900/10 px-1.5 py-0.2 font-mono text-[10px] font-bold text-zinc-900 dark:bg-white/20 dark:text-zinc-100">
            {watchlistItems.length}
          </span>
        )}
        {tabItem.id === "portfolio" && unackedAlerts > 0 && (
          <span className="relative z-10 rounded-full bg-rose-600 px-1.5 py-0.2 font-mono text-[10px] font-bold text-white shadow-sm">
            {unackedAlerts}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="min-h-screen pb-16">
      {/* Floating Apple Liquid Glass Split Architectural Navigation Bar */}
      <header className="pointer-events-none sticky top-0 z-40 px-4 pt-3 pb-1.5 sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-[1780px] flex-wrap items-center justify-between gap-2.5">
          {/* Left Floating Circular Glass Controls */}
          <div className="pointer-events-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (viewMode !== "cockpit") {
                  navigateView("cockpit");
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
              className="apple-liquid-glass-btn inline-flex h-10 items-center gap-1.5 rounded-full px-3.5 font-mono text-xs font-medium text-zinc-900 disabled:opacity-50 dark:text-zinc-100"
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
            className="pointer-events-auto order-3 flex w-full justify-center lg:order-2 lg:w-auto"
          >
            <div className="apple-liquid-glass relative flex h-11 items-center gap-1 overflow-x-auto rounded-full px-2">
              <div className="flex shrink-0 items-center gap-0.5">{leftNavItems.map(renderNavPill)}</div>

              {/* Central Rising Brand Prism Crest */}
              <button
                type="button"
                onClick={() => {
                  navigateView("cockpit");
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                title="MarketElite · 返回市场总览顶部"
                className="group relative mx-1.5 flex shrink-0 items-center gap-2 rounded-full px-2 py-1 transition-transform duration-200 hover:scale-[1.04]"
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
                <span className="hidden font-serif text-[17px] font-medium italic tracking-tight text-zinc-950 transition-colors duration-150 dark:text-zinc-50 sm:inline">
                  MarketElite
                </span>
              </button>

              <div className="flex shrink-0 items-center gap-0.5">{rightNavItems.map(renderNavPill)}</div>
            </div>
          </nav>

          {/* Right Floating Liquid Glass Controls: Theme Switcher & GitHub Icon */}
          <div className="pointer-events-auto order-2 flex items-center gap-2 lg:order-3">
            <button
              type="button"
              onClick={toggleTheme}
              title="切换丝绒白昼 / 黑曜夜幕主题"
              className="apple-liquid-glass-btn inline-flex h-10 items-center gap-1.5 rounded-full px-3.5 font-mono text-xs font-medium text-zinc-900 dark:text-zinc-100"
            >
              {theme === "dark" ? (
                <>
                  <Sun className="h-3.5 w-3.5 text-amber-300" />
                  <span>丝绒白昼</span>
                </>
              ) : (
                <>
                  <Moon className="h-3.5 w-3.5 text-zinc-800" />
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
      ) : viewMode === "watchlist" ? (
        <WatchlistWorkspace
          items={watchlistItems}
          loading={watchlistLoading}
          mutating={watchlistMutating}
          error={watchlistError}
          regimeLabel={overview?.regime?.regime_label}
          onAddSymbol={handleAddWatchlistSymbol}
          onReorderSymbols={handlePersistWatchlist}
          onRemoveSymbol={handleRemoveWatchlistSymbol}
          onOpenStockDetail={(sym) => navigateView("stock", sym)}
        />
      ) : viewMode === "stock" ? (
        <StockDetailView
          symbol={activeStockSymbol}
          isWatched={watchlistItems.some((x) => x.symbol === activeStockSymbol)}
          onToggleWatchlist={handleToggleWatchlistSymbol}
          onSelectOtherSymbol={(sym) => navigateView("stock", sym)}
          onBackToOverview={() => navigateView("cockpit")}
          onBackToWatchlist={() => navigateView("watchlist")}
          onOpenAiDrawer={(sym) => {
            setSelectedSymbol(sym);
            setDrawerOpen(true);
          }}
          onOpenCopilot={(sym) => {
            setSelectedSymbol(sym);
            navigateView("copilot");
          }}
        />
      ) : viewMode === "copilot" ? (
        <main className="mx-auto w-full max-w-[1780px] px-4 pt-5 sm:px-6 lg:px-8">
          <InvestigatorDrawer
            open={true}
            mode="split"
            defaultSymbol={selectedSymbol}
          />
        </main>
      ) : viewMode === "portfolio" ? (
        <main className="mx-auto w-full max-w-[1780px] px-4 pt-5 sm:px-6 lg:px-8">
          <PortfolioWatchdogView
            onSelectSymbol={(sym) => navigateView("stock", sym)}
            onAlertCountChange={setUnackedAlerts}
          />
        </main>
      ) : (
        <main className="mx-auto w-full max-w-[1780px] space-y-5 px-4 pt-5 sm:px-6 lg:px-8">
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
                      <div className="flex items-center gap-2 font-mono text-xs font-semibold tracking-wider text-zinc-200">
                        <Layers className="h-3.5 w-3.5 text-emerald-400" />
                        LAYER 01 · 宏观流动性与体制锚 (Macro Regime Anchor)
                      </div>
                      <h1 className="mt-2 font-serif text-2xl font-medium tracking-tight text-white sm:text-3xl">
                        {formatRegimeLabel(overview?.regime?.regime_label)}
                      </h1>
                    </div>
                    <div className="flex flex-col items-end gap-1 font-mono text-xs">
                      <span className="rounded-full border border-zinc-600 bg-zinc-900 px-3 py-1 font-medium text-zinc-100">
                        压力 Stress {overview?.regime?.stress_score ?? 0} · 支撑 Support{" "}
                        {overview?.regime?.support_score ?? 0}
                      </span>
                      <span className="text-xs text-zinc-300">
                        基准日 {overview?.regime_date ?? "—"} · 0-Token 规则计算
                      </span>
                    </div>
                  </div>

                  {/* Headline Metrics Strip */}
                  <div className="grid grid-cols-2 gap-3.5 border-y border-zinc-800/90 py-4 sm:grid-cols-4">
                    <div>
                      <div className="font-mono text-xs font-medium text-zinc-300">
                        美联储净流动性 Net Liq
                      </div>
                      <div className="mt-1 font-mono text-xl font-bold tabular-nums text-white">
                        {overview?.macro?.net_liquidity.latest_billions != null
                          ? `$${overview.macro.net_liquidity.latest_billions.toLocaleString()}B`
                          : "—"}
                      </div>
                      <div
                        className={`font-mono text-xs font-medium tabular-nums ${deltaTone(
                          overview?.macro?.net_liquidity.delta_20d_billions,
                          true
                        )}`}
                      >
                        20D {fmtSigned(overview?.macro?.net_liquidity.delta_20d_billions, 1, "B")}
                      </div>
                    </div>

                    <div>
                      <div className="font-mono text-xs font-medium text-zinc-300">
                        美债利差 10Y–2Y Curve
                      </div>
                      <div className="mt-1 font-mono text-xl font-bold tabular-nums text-white">
                        {fmtSigned(overview?.macro?.yield_credit.yield_spread_10y2y, 2, "%")}
                      </div>
                      <div className="font-mono text-xs tabular-nums text-zinc-200">
                        10Y {fmtNum(overview?.macro?.yield_credit.dgs10, 2, "%")} · 实际 Real{" "}
                        {fmtNum(overview?.macro?.yield_credit.dfii10, 2, "%")}
                      </div>
                    </div>

                    <div>
                      <div className="font-mono text-xs font-medium text-zinc-300">
                        高收益利差 HY OAS
                      </div>
                      <div className="mt-1 font-mono text-xl font-bold tabular-nums text-white">
                        {fmtNum(overview?.macro?.yield_credit.hy_oas, 2, "%")}
                      </div>
                      <div className="font-mono text-xs text-zinc-200">
                        {formatCreditState(overview?.macro?.yield_credit.credit_state)}
                      </div>
                    </div>

                    <div>
                      <div className="font-mono text-xs font-medium text-zinc-300">
                        波动期限比 VIX/VIX3M
                      </div>
                      <div className="mt-1 font-mono text-xl font-bold tabular-nums text-white">
                        {fmtNum(overview?.macro?.vix_structure.vix_vix3m_ratio, 3)}
                      </div>
                      <div className="font-mono text-xs text-zinc-200">
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
                        className="rounded-lg border border-zinc-700 bg-zinc-900/80 px-2.5 py-1 font-mono text-xs text-zinc-100"
                      >
                        {formatDriverText(driver)}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Fed Net Liquidity ECharts Area */}
                <div className="mt-4">
                  <div className="mb-1 flex items-center justify-between font-mono text-xs text-zinc-300">
                    <span>WALCL – WTREGEN – RRPONTSYD (90-Obs, USD Billions)</span>
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
                    <div className="font-mono text-xs font-semibold tracking-wider text-zinc-700 dark:text-zinc-200">
                      LAYER 02 &amp; 05 · 波动率期限与市场情绪 (Vol &amp; Sentiment)
                    </div>
                    <span className="shrink-0 whitespace-nowrap rounded-full border border-zinc-300 bg-white px-2.5 py-0.5 font-mono text-xs font-medium text-zinc-800 dark:border-white/20 dark:bg-white/[0.08] dark:text-zinc-100">
                      5 维合成模型 · 5-Pillar
                    </span>
                  </div>

                  {/* Fear & Greed Editorial Meter */}
                  <div className="rounded-xl border border-zinc-200 bg-white/80 p-4 dark:border-white/15 dark:bg-white/[0.04]">
                    <div className="flex items-baseline justify-between gap-2">
                      <div>
                        <div className="font-mono text-xs font-medium text-zinc-700 dark:text-zinc-200">
                          自研恐慌贪婪指数 Fear &amp; Greed Index
                        </div>
                        <div className="mt-1 flex items-baseline gap-2.5">
                          <span className="font-mono text-3xl font-bold tabular-nums text-zinc-950 dark:text-white">
                            {fmtNum(overview?.regime?.fear_greed.score, 1)}
                          </span>
                          <span className="font-serif text-lg font-medium italic text-zinc-800 dark:text-zinc-200">
                            {SENTIMENT_BI[overview?.regime?.fear_greed.label ?? ""] ??
                              overview?.regime?.fear_greed.label ??
                              "Unavailable"}
                          </span>
                        </div>
                      </div>
                      <span className="font-mono text-xs font-medium text-zinc-700 dark:text-zinc-300">
                        0 极恐 · 100 极贪
                      </span>
                    </div>

                    <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-white/15">
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
                            <div className="font-mono text-sm font-bold tabular-nums text-zinc-950 dark:text-zinc-50">
                              {score !== null && score !== undefined ? score.toFixed(0) : "—"}
                            </div>
                            <div className="truncate font-mono text-xs font-medium text-zinc-700 dark:text-zinc-300">
                              {PILLAR_BI[pillar] ?? pillar.replace("_", " ")}
                            </div>
                          </div>
                        )
                      )}
                    </div>
                  </div>

                  {/* VIX Term Curve */}
                  <div>
                    <div className="mb-2 flex items-center justify-between font-mono text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      <span>CBOE 波动率期限结构 (VIX Curve)</span>
                      <span className="font-semibold text-zinc-950 dark:text-zinc-100">
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
                          className="rounded-xl border border-zinc-200 bg-white/85 px-3 py-2.5 dark:border-white/15 dark:bg-white/[0.05]"
                        >
                          <div className="font-mono text-xs font-medium text-zinc-700 dark:text-zinc-300">
                            {v.label}
                          </div>
                          <div className="mt-0.5 font-mono text-lg font-bold tabular-nums text-zinc-950 dark:text-white">
                            {fmtNum(v.val, 2)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Funding & Credit Plumbing Table */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-zinc-200 pt-3 font-mono text-xs tabular-nums dark:border-white/15">
                    <div className="flex justify-between">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">SOFR 隔夜利率</span>
                      <span className="font-bold text-zinc-950 dark:text-zinc-50">
                        {fmtNum(overview?.macro?.yield_credit.sofr, 2, "%")}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">银行准备金</span>
                      <span className="font-bold text-zinc-950 dark:text-zinc-50">
                        {overview?.macro?.yield_credit.wresbal_billions != null
                          ? `$${overview.macro.yield_credit.wresbal_billions.toLocaleString()}B`
                          : "—"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">投资级 IG OAS</span>
                      <span className="font-bold text-zinc-950 dark:text-zinc-50">
                        {fmtNum(overview?.macro?.yield_credit.ig_oas, 2, "%")}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">HYG / LQD</span>
                      <span className="font-bold text-zinc-950 dark:text-zinc-50">
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
                    <div className="border-t border-zinc-200 pt-3 dark:border-white/15">
                      <div className="mb-1.5 flex items-center justify-between font-mono text-xs font-medium text-zinc-700 dark:text-zinc-300">
                        <span>近 {regimeHistory.length} 日情绪与体制轨迹</span>
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
                    <div className="font-mono text-xs font-semibold tracking-wider text-zinc-700 dark:text-zinc-200">
                      LAYER 03 · 核心指数与市场广度 (Core &amp; Breadth)
                    </div>
                    <span className="shrink-0 font-mono text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      点击行切换右侧 K 线
                    </span>
                  </div>

                  {/* Breadth Summary Pills */}
                  <div className="grid grid-cols-3 gap-2.5">
                    <div className="rounded-xl border border-zinc-200 bg-white/85 p-3 dark:border-white/15 dark:bg-white/[0.05]">
                      <div className="font-mono text-xs font-medium text-zinc-700 dark:text-zinc-300">
                        站上 50 日线
                      </div>
                      <div className="mt-1 font-mono text-lg font-bold tabular-nums text-zinc-950 dark:text-white">
                        {fmtNum(overview?.equities?.breadth.pct_above_50ma, 1, "%")}
                      </div>
                    </div>
                    <div className="rounded-xl border border-zinc-200 bg-white/85 p-3 dark:border-white/15 dark:bg-white/[0.05]">
                      <div className="font-mono text-xs font-medium text-zinc-700 dark:text-zinc-300">
                        站上 200 日线
                      </div>
                      <div className="mt-1 font-mono text-lg font-bold tabular-nums text-zinc-950 dark:text-white">
                        {fmtNum(overview?.equities?.breadth.pct_above_200ma, 1, "%")}
                      </div>
                    </div>
                    <div className="rounded-xl border border-zinc-200 bg-white/85 p-3 dark:border-white/15 dark:bg-white/[0.05]">
                      <div className="font-mono text-xs font-medium text-zinc-700 dark:text-zinc-300">
                        等权 RSP/SPY
                      </div>
                      <div
                        className={`mt-1 font-mono text-lg font-bold tabular-nums ${deltaTone(
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
                    <table className="w-full text-left font-mono text-[13px] tabular-nums">
                      <thead>
                        <tr className="border-b border-zinc-200 text-xs font-semibold uppercase text-zinc-700 dark:border-white/15 dark:text-zinc-300">
                          <th className="py-2">Ticker</th>
                          <th className="py-2 text-right">Close</th>
                          <th className="py-2 text-right">1D</th>
                          <th className="py-2 text-right">20D</th>
                          <th className="py-2 text-right">RSI14</th>
                          <th className="py-2 text-right">RVOL</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-200/70 dark:divide-white/10">
                        {Object.entries(overview?.equities?.core_indices ?? {}).map(
                          ([sym, tech]) => {
                            const active = selectedSymbol === sym;
                            return (
                              <tr
                                key={sym}
                                onClick={() => setSelectedSymbol(sym)}
                                className={`cursor-pointer transition-colors ${
                                  active
                                    ? "bg-zinc-950 text-white dark:bg-white/[0.16] dark:text-white dark:ring-1 dark:ring-inset dark:ring-white/30"
                                    : "text-zinc-900 hover:bg-zinc-900/[0.04] dark:text-zinc-100 dark:hover:bg-white/[0.06]"
                                }`}
                              >
                                <td className="py-2.5 pl-2 font-bold">{sym}</td>
                                <td className="py-2.5 text-right font-semibold">
                                  {tech.last_close != null
                                    ? sym === "BTCUSDT"
                                      ? `$${tech.last_close.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                                      : `$${tech.last_close.toFixed(2)}`
                                    : "—"}
                                </td>
                                <td
                                  className={`py-2.5 text-right font-semibold ${deltaTone(
                                    tech.change_1d_pct,
                                    active || theme === "dark"
                                  )}`}
                                >
                                  {fmtSigned(tech.change_1d_pct, 2, "%")}
                                </td>
                                <td
                                  className={`py-2.5 text-right font-semibold ${deltaTone(
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

                {/* Global Search Any US Ticker + Filtered Asset Universe */}
                <div className="mt-4 space-y-3 border-t border-zinc-200 pt-3.5 dark:border-white/15">
                  <form onSubmit={handleGlobalTickerSearch} className="flex gap-2">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-600 dark:text-zinc-300" />
                      <input
                        type="text"
                        value={tickerSearchInput}
                        onChange={(e) => setTickerSearchInput(e.target.value.toUpperCase())}
                        placeholder="输入美股代码查 K 线/GEX/EPS，如 AMD, PLTR, TSM..."
                        className="w-full rounded-xl border border-zinc-300 bg-white/90 py-2 pr-3 pl-9 font-mono text-xs uppercase text-zinc-950 placeholder:normal-case placeholder:text-zinc-500 focus:border-zinc-950 focus:outline-none dark:border-white/15 dark:bg-white/[0.06] dark:text-white dark:placeholder:text-zinc-400"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={searchingTicker || !tickerSearchInput.trim()}
                      className="rounded-xl bg-zinc-950 px-3.5 py-2 font-mono text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-40 dark:bg-white dark:text-zinc-950"
                    >
                      {searchingTicker ? "拉取中..." : "调入看盘"}
                    </button>
                  </form>
                  {tickerSearchError && (
                    <p className="font-mono text-xs font-medium text-rose-700 dark:text-rose-300">
                      {tickerSearchError}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-zinc-700 dark:text-zinc-200">
                    <span className="font-semibold">全市场资产池 ({filteredWatchlist.length})</span>
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
                          className={`rounded-md px-2 py-0.5 font-medium transition ${
                            watchlistFilter === f.id
                              ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                              : "bg-zinc-200/80 text-zinc-800 hover:bg-zinc-300 dark:bg-white/[0.08] dark:text-zinc-200"
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
                        className="rounded-md border border-zinc-300 px-2 py-0.5 font-medium text-zinc-800 hover:bg-zinc-100 dark:border-white/20 dark:text-zinc-200"
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
                        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs font-medium transition ${
                          selectedSymbol === a.symbol
                            ? "border-zinc-950 bg-zinc-950 text-white dark:border-white/50 dark:bg-white dark:text-zinc-950"
                            : "border-zinc-200 bg-white/85 text-zinc-900 hover:border-zinc-400 dark:border-white/15 dark:bg-white/[0.05] dark:text-zinc-100"
                        }`}
                      >
                        <span className="font-semibold">{a.symbol}</span>
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
                      <div className="flex items-center gap-2 font-mono text-xs font-semibold tracking-wider text-zinc-200">
                        <Activity className="h-3.5 w-3.5 text-emerald-400" />
                        LAYER 04 · 个股微观量价与均线 (Micro Structure)
                      </div>
                      <div className="mt-1 flex flex-wrap items-baseline gap-3">
                        <h2 className="font-serif text-2xl font-medium text-white sm:text-3xl">
                          {selectedSymbol}
                        </h2>
                        <span className="font-mono text-xl font-bold tabular-nums text-white">
                          {assetDetail?.technicals.last_close != null
                            ? `$${assetDetail.technicals.last_close.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}`
                            : "—"}
                        </span>
                        <span
                          className={`font-mono text-xs font-semibold tabular-nums ${deltaTone(
                            assetDetail?.technicals.change_1d_pct,
                            true
                          )}`}
                        >
                          {fmtSigned(assetDetail?.technicals.change_1d_pct, 2, "%")} (1D)
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 font-mono text-xs text-zinc-100">
                        {formatVolumePriceTag(assetDetail?.technicals.volume_price_tag)}
                      </span>
                      <button
                        type="button"
                        onClick={() => navigateView("stock", selectedSymbol)}
                        className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1 font-mono text-xs font-semibold text-zinc-950 transition hover:bg-zinc-200"
                      >
                        个股详情 <ArrowRight className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDrawerOpen(true)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/50 bg-emerald-500/15 px-3 py-1 font-mono text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/25"
                      >
                        <Sparkles className="h-3 w-3" />
                        AI 协查
                      </button>
                    </div>
                  </div>

                  {/* Single-line Technicals Telemetry Strip */}
                  <div className="grid grid-cols-3 gap-2.5 rounded-xl border border-zinc-800 bg-zinc-950/75 p-3 font-mono text-xs tabular-nums sm:grid-cols-6">
                    <div>
                      <span className="block text-xs text-zinc-300">RSI(14)</span>
                      <span className="mt-0.5 block text-sm font-bold text-white">
                        {fmtNum(assetDetail?.technicals.rsi_14, 1)}
                      </span>
                    </div>
                    <div>
                      <span className="block text-xs text-zinc-300">RVOL(20)</span>
                      <span className="mt-0.5 block text-sm font-bold text-white">
                        {fmtNum(assetDetail?.technicals.rvol_20, 2, "x")}
                      </span>
                    </div>
                    <div>
                      <span className="block text-xs text-zinc-300">ATR(14)</span>
                      <span className="mt-0.5 block text-sm font-bold text-white">
                        {fmtNum(assetDetail?.technicals.atr_pct, 2, "%")}
                      </span>
                    </div>
                    <div>
                      <span className="block text-xs text-zinc-300">距 50 日线</span>
                      <span
                        className={`mt-0.5 block text-sm font-bold ${deltaTone(assetDetail?.technicals.dist_50ma_pct, true)}`}
                      >
                        {fmtSigned(assetDetail?.technicals.dist_50ma_pct, 2, "%")}
                      </span>
                    </div>
                    <div>
                      <span className="block text-xs text-zinc-300">距 200 日线</span>
                      <span
                        className={`mt-0.5 block text-sm font-bold ${deltaTone(assetDetail?.technicals.dist_200ma_pct, true)}`}
                      >
                        {fmtSigned(assetDetail?.technicals.dist_200ma_pct, 2, "%")}
                      </span>
                    </div>
                    <div>
                      <span className="block text-xs text-zinc-300">MACD 柱</span>
                      <span
                        className={`mt-0.5 block text-sm font-bold ${deltaTone(
                          assetDetail?.technicals.macd?.histogram,
                          true
                        )}`}
                      >
                        {fmtSigned(assetDetail?.technicals.macd?.histogram, 3)}
                      </span>
                    </div>
                  </div>

                  {/* TradingView Lightweight Charts */}
                  {assetLoading && !assetDetail ? (
                    <div className="flex h-[320px] items-center justify-center rounded-xl border border-zinc-800 font-mono text-sm text-zinc-200">
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
                      <div className="rounded-xl border border-zinc-800 bg-zinc-950/75 p-3 font-mono text-xs">
                        <div className="font-medium text-zinc-200">
                          {selectedSymbol} 估算期权墙 (Estimated GEX)
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-semibold tabular-nums">
                          <span className={deltaTone(assetDetail.options_gex.net_gex, true)}>
                            Net {fmtBillions(assetDetail.options_gex.net_gex)}
                          </span>
                          <span className="text-emerald-400">
                            Call ${assetDetail.options_gex.call_wall?.toFixed(0) ?? "—"}
                          </span>
                          <span className="text-rose-400">
                            Put ${assetDetail.options_gex.put_wall?.toFixed(0) ?? "—"}
                          </span>
                          <span className="text-amber-300">
                            ZG ${assetDetail.options_gex.zero_gamma?.toFixed(2) ?? "—"}
                          </span>
                        </div>
                      </div>
                    )}

                    {assetDetail?.eps_history && assetDetail.eps_history.length > 0 && (
                      <div className="rounded-xl border border-zinc-800 bg-zinc-950/75 p-3 font-mono text-xs">
                        <div className="flex items-center justify-between font-medium text-zinc-200">
                          <span>季度 EPS 实际 vs 预期</span>
                          {assetDetail.recommendations?.[0] && (
                            <span className="text-zinc-100">
                              买{assetDetail.recommendations[0].strong_buy + assetDetail.recommendations[0].buy}/持{assetDetail.recommendations[0].hold}/卖{assetDetail.recommendations[0].sell + assetDetail.recommendations[0].strong_sell}
                            </span>
                          )}
                        </div>
                        <div className="mt-1.5 grid grid-cols-2 gap-2 text-xs tabular-nums">
                          {assetDetail.eps_history.slice(0, 2).map((ep) => (
                            <div key={ep.period} className="rounded bg-zinc-900 px-2 py-1">
                              <span className="text-zinc-200">{ep.period.slice(0, 7)} </span>
                              <span className="font-bold text-white">
                                {ep.actual !== null ? `$${ep.actual.toFixed(2)}` : "—"}
                              </span>
                              <span className="text-zinc-300">
                                {" "}
                                / {ep.estimate !== null ? `$${ep.estimate.toFixed(2)}` : "—"}
                              </span>
                              {ep.surprise_percent !== null && (
                                <span className={`ml-1 font-semibold ${deltaTone(ep.surprise_percent, true)}`}>
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
                    <div className="mb-1.5 flex items-center gap-1.5 font-mono text-xs font-medium text-zinc-200">
                      <Newspaper className="h-3.5 w-3.5" />
                      最新财经快讯 Headlines ({selectedSymbol})
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {assetDetail.news.slice(0, 2).map((n) => (
                        <a
                          key={n.id}
                          href={n.url}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-100 transition hover:border-zinc-500 hover:text-white"
                        >
                          <span className="mr-2 font-mono font-semibold text-zinc-300">
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
                    <div className="flex items-center gap-2 font-mono text-xs font-semibold tracking-wider text-zinc-700 dark:text-zinc-200">
                      <BarChart3 className="h-3.5 w-3.5" />
                      LAYER 02 · 期权做市商墙体分布 (Dealer Positioning)
                    </div>
                    <h2 className="mt-1 font-serif text-2xl font-medium text-zinc-950 dark:text-white">
                      {gexSymbol} Estimated GEX 伽马敞口估算
                    </h2>
                  </div>

                  <div className="flex items-center gap-1 rounded-full border border-zinc-300 bg-zinc-100 p-0.5 font-mono text-xs dark:border-white/20 dark:bg-white/[0.08]">
                    {(["SPY", "QQQ"] as const).map((sym) => (
                      <button
                        key={sym}
                        type="button"
                        onClick={() => setGexSymbol(sym)}
                        className={`rounded-full px-3 py-1 font-semibold transition ${
                          gexSymbol === sym
                            ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                            : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-200 dark:hover:text-white"
                        }`}
                      >
                        {sym}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-2 rounded-lg border border-zinc-200 bg-white/75 px-3 py-1.5 font-mono text-xs font-medium text-zinc-700 dark:border-white/15 dark:bg-white/[0.04] dark:text-zinc-200">
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
                      cls: "text-emerald-700 dark:text-emerald-400",
                    },
                    {
                      label: "看跌墙 Put Wall",
                      value: activeGex?.put_wall ? `$${activeGex.put_wall.toFixed(0)}` : "—",
                      cls: "text-rose-700 dark:text-rose-400",
                    },
                    {
                      label: "翻转位 Zero Gamma",
                      value: activeGex?.zero_gamma ? `$${activeGex.zero_gamma.toFixed(2)}` : "—",
                      cls: "text-amber-700 dark:text-amber-300",
                    },
                  ].map((stat) => (
                    <div
                      key={stat.label}
                      className="rounded-xl border border-zinc-200 bg-white/85 px-3 py-2.5 dark:border-white/15 dark:bg-white/[0.05]"
                    >
                      <div className="font-mono text-xs font-medium text-zinc-700 dark:text-zinc-300">
                        {stat.label}
                      </div>
                      <div
                        className={`mt-0.5 font-mono text-base font-bold tabular-nums ${stat.cls}`}
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
                  <div className="mt-2 flex flex-wrap justify-between font-mono text-xs font-medium text-zinc-700 tabular-nums dark:text-zinc-300">
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
                    <div className="font-mono text-xs font-semibold tracking-wider text-zinc-200">
                      LAYER 03 · 11 大板块轮动热力 (SPDR Sector Rotation)
                    </div>
                    <h2 className="mt-1 font-serif text-xl font-medium text-white sm:text-2xl">
                      进攻 Offensive / 周期 Cyclical / 防御 Defensive
                    </h2>
                  </div>
                  <span className="shrink-0 whitespace-nowrap font-mono text-xs text-zinc-200">按20日排序</span>
                </div>

                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-left font-mono text-[13px] tabular-nums">
                    <thead>
                      <tr className="border-b border-zinc-800 text-xs font-semibold uppercase text-zinc-200">
                        <th className="py-2">ETF</th>
                        <th className="py-2">风格 Bucket</th>
                        <th className="py-2 text-right">1D</th>
                        <th className="py-2 text-right">20D</th>
                        <th className="py-2 text-right">vs SPY</th>
                        <th className="py-2 text-right">RVOL</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/70">
                      {(overview?.equities?.sector_rotation ?? []).map((sec) => (
                        <tr
                          key={sec.symbol}
                          onClick={() => setSelectedSymbol(sec.symbol)}
                          className={`cursor-pointer transition ${
                            selectedSymbol === sec.symbol
                              ? "bg-white text-zinc-950 dark:bg-white/[0.16] dark:text-white dark:ring-1 dark:ring-inset dark:ring-white/30"
                              : "hover:bg-zinc-900/75 text-zinc-100"
                          }`}
                        >
                          <td className="py-2.5 pl-2 font-bold">{sec.symbol}</td>
                          <td className="py-2.5 text-xs font-medium opacity-95">
                            {BUCKET_BI[sec.bucket] ?? sec.bucket}
                          </td>
                          <td
                            className={`py-2.5 text-right font-semibold ${deltaTone(
                              sec.return_1d_pct,
                              selectedSymbol !== sec.symbol || theme === "dark"
                            )}`}
                          >
                            {fmtSigned(sec.return_1d_pct, 2, "%")}
                          </td>
                          <td
                            className={`py-2.5 text-right font-semibold ${deltaTone(
                              sec.return_20d_pct,
                              selectedSymbol !== sec.symbol
                            )}`}
                          >
                            {fmtSigned(sec.return_20d_pct, 2, "%")}
                          </td>
                          <td
                            className={`py-2.5 text-right font-semibold ${deltaTone(
                              sec.rel_spy_20d_pct,
                              selectedSymbol !== sec.symbol
                            )}`}
                          >
                            {fmtSigned(sec.rel_spy_20d_pct, 2, "%")}
                          </td>
                          <td className="py-2.5 pr-2 text-right font-medium">
                            {fmtNum(sec.rvol_20, 2, "x")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SpotlightBlock>
            </motion.section>

            {/* BAND 4: HOME WATCHLIST CARD (7 cols, Figures 2+3 + Full Management) + INSTITUTIONAL CFTC COT (5 cols) */}
            <motion.section
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.16, ease: EASE_EXPO }}
              className="grid grid-cols-1 gap-5 lg:grid-cols-12"
            >
              <WatchlistCardPanel
                items={watchlistItems}
                loading={watchlistLoading}
                mutating={watchlistMutating}
                error={watchlistError}
                onAddSymbol={handleAddWatchlistSymbol}
                onReorderSymbols={handlePersistWatchlist}
                onRemoveSymbol={handleRemoveWatchlistSymbol}
                onOpenStockDetail={(sym) => navigateView("stock", sym)}
                onOpenMyWatchlist={() => navigateView("watchlist")}
              />

              {/* Institutional CFTC COT Futures Positioning */}
              <SpotlightBlock tone="obsidian" className="flex flex-col justify-between p-6 lg:col-span-5">
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-mono text-xs font-semibold tracking-wider text-zinc-200">
                        LAYER 05 · CFTC 机构期货净持仓 (COT)
                      </div>
                      <h3 className="mt-1 font-serif text-xl font-medium text-white sm:text-2xl">
                        非商业投机净头寸 Net Positioning
                      </h3>
                    </div>
                    <span className="shrink-0 whitespace-nowrap rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1 font-mono text-xs font-medium text-zinc-100">
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
                            className="rounded-xl border border-zinc-800 bg-zinc-950/75 p-3.5"
                          >
                            <div className="flex items-center justify-between font-mono text-sm">
                              <span className="font-bold text-white">
                                {code}{" "}
                                <span className="font-normal text-zinc-200">· {row.contract}</span>
                              </span>
                              <span
                                className={`font-bold tabular-nums ${deltaTone(
                                  row.noncomm_net,
                                  true
                                )}`}
                              >
                                {row.noncomm_net >= 0 ? "+" : ""}
                                {row.noncomm_net.toLocaleString()}
                              </span>
                            </div>
                            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                              <div
                                className={`h-full rounded-full ${
                                  row.noncomm_net >= 0 ? "bg-emerald-500" : "bg-rose-500"
                                }`}
                                style={{ width: `${barWidth}%` }}
                              />
                            </div>
                            <div className="mt-2 flex justify-between font-mono text-xs text-zinc-200 tabular-nums">
                              <span>
                                周变动 WoW:{" "}
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
                </div>
              </SpotlightBlock>
            </motion.section>
          </>
        )}
      </main>
      )}

      {/* Full-Width Compact Auto-Scrolling Macro Ticker Strip */}
      <MacroTickerStrip
        selectedSymbol={selectedSymbol}
        onSelectProxy={(proxySymbol) => {
          setSelectedSymbol(proxySymbol);
          if (viewMode === "stock") {
            navigateView("stock", proxySymbol);
          } else if (viewMode !== "cockpit") {
            navigateView("cockpit");
          }
        }}
      />

      <InvestigatorDrawer
        open={drawerOpen && (viewMode === "cockpit" || viewMode === "stock" || viewMode === "watchlist")}
        mode="drawer"
        onClose={() => setDrawerOpen(false)}
        onOpenFullWorkspace={() => navigateView("copilot")}
        defaultSymbol={viewMode === "stock" ? activeStockSymbol : selectedSymbol}
      />
    </div>
  );
}

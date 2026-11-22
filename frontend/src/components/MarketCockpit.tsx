"use client";

import React, { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  Moon,
  RefreshCw,
  ShieldAlert,
  Sun,
} from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import MacroTickerStrip from "@/components/MacroTickerStrip";
import OverviewBentoGrid from "@/components/OverviewBentoGrid";
import StatusConsole from "@/components/StatusConsole";
import InvestigatorDrawer from "@/components/InvestigatorDrawer";
import StockDetailView from "@/components/StockDetailView";
import WatchlistWorkspace from "@/components/WatchlistWorkspace";
import { PortfolioWatchdogView } from "@/components/PortfolioWatchdogView";
import { useTheme } from "@/components/ThemeProvider";
import {
  AssetDetailResponse,
  DashboardOverviewResponse,
  DiscoverNewsItem,
  RegimeHistoryPoint,
  WatchlistAssetItem,
  ensureAsset,
  fetchAssetDetail,
  fetchDashboardOverview,
  fetchDiscoverNews,
  fetchRegimeHistory,
  fetchWatchdogAlerts,
  fetchWatchlist,
  triggerPipelineSync,
  updateWatchlist,
} from "@/lib/api";

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

  const [assetDetail, setAssetDetail] = useState<AssetDetailResponse | null>(null);
  const [gexSymbol, setGexSymbol] = useState<"SPY" | "QQQ">("SPY");
  const [discoverNews, setDiscoverNews] = useState<DiscoverNewsItem[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState<boolean>(true);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [assetLoading, setAssetLoading] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const loadDiscoverNewsData = useCallback(async (forceRefresh = false) => {
    setDiscoverLoading(true);
    try {
      const res = await fetchDiscoverNews(12, forceRefresh);
      setDiscoverNews(res.items);
      setDiscoverError(null);
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : "无法获取市场要闻");
    } finally {
      setDiscoverLoading(false);
    }
  }, []);

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
      const [ov, hist, alRes] = await Promise.all([
        fetchDashboardOverview(),
        fetchRegimeHistory(30).catch(() => ({ count: 0, history: [] })),
        fetchWatchdogAlerts(20).catch(() => ({ count: 0, alerts: [] })),
      ]);
      setOverview(ov);
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
    loadDiscoverNewsData(false);
  }, [loadOverviewAndAssets, loadWatchlistData, loadDiscoverNewsData]);

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
      await loadDiscoverNewsData(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

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
        className={`relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 font-sans text-[13px] tracking-tight transition-colors duration-200 ${
          isActive
            ? "font-semibold text-zinc-950 dark:text-white"
            : "font-medium text-zinc-800 hover:text-zinc-950 dark:text-zinc-100 dark:hover:text-white"
        }`}
      >
        {isActive && (
          <motion.span
            layoutId="apple-glass-nav-pill"
            transition={{ type: "spring", stiffness: 420, damping: 32, mass: 0.7 }}
            className="apple-liquid-glass-active absolute inset-0 rounded-full"
          />
        )}
        <span className="relative z-10">{tabItem.label}</span>
        {tabItem.id === "watchlist" && watchlistItems.length > 0 && (
          <span className="relative z-10 rounded-full bg-zinc-950/12 px-1.5 py-0.2 font-mono text-[10px] font-bold text-zinc-950 dark:bg-white/20 dark:text-white">
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
    <div className={`min-h-screen ${viewMode === "cockpit" ? "pb-14" : "pb-6"}`}>
      {/* Floating Apple Liquid Glass Split Architectural Navigation Bar (Zero Scrollbar) */}
      <header className="pointer-events-none sticky top-0 z-40 px-3 pt-2.5 pb-1 sm:px-5 lg:px-6">
        <div className="mx-auto flex w-full max-w-[1860px] flex-wrap items-center justify-between gap-2.5">
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
              className={`apple-liquid-glass-btn relative flex h-10 w-10 items-center justify-center rounded-full text-zinc-900 dark:text-white ${
                drawerOpen && viewMode === "cockpit"
                  ? "ring-2 ring-emerald-500/50 dark:ring-emerald-400/50"
                  : ""
              }`}
            >
              <Activity className="relative z-10 h-[18px] w-[18px]" />
              <span className="absolute right-2 top-2 z-10 flex h-2 w-2">
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
              className="apple-liquid-glass-btn inline-flex h-10 items-center gap-1.5 rounded-full px-3.5 font-mono text-xs font-semibold text-zinc-950 disabled:opacity-50 dark:text-white"
            >
              <RefreshCw className={`relative z-10 h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
              <span className="relative z-10 hidden sm:inline">{syncing ? "同步中" : "同步"}</span>
              {overview?.cache_source === "redis" && (
                <span
                  aria-label="Redis Hot"
                  className="relative z-10 hidden h-1.5 w-1.5 rounded-full bg-emerald-500 lg:inline-block"
                />
              )}
            </button>
          </div>

          {/* Center Split Apple Liquid Glass Navigation Capsule + Rising Brand Emblem (NO overflow scrollbars) */}
          <nav
            aria-label="Primary Workspaces"
            className="pointer-events-auto order-3 flex w-full justify-center lg:order-2 lg:w-auto"
          >
            <div className="apple-liquid-glass relative flex flex-wrap items-center justify-center gap-1 rounded-[24px] px-2 py-1 md:h-11 md:flex-nowrap md:rounded-full md:py-0">
              <div className="relative z-10 flex shrink-0 items-center gap-0.5">{leftNavItems.map(renderNavPill)}</div>

              {/* Central Rising Brand Prism Crest */}
              <button
                type="button"
                onClick={() => {
                  navigateView("cockpit");
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                title="MarketElite · 返回市场总览顶部"
                className="group relative z-10 mx-1.5 flex shrink-0 items-center gap-2 rounded-full px-2 py-1 transition-transform duration-200 hover:scale-[1.04]"
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
                      className="stroke-white/85 dark:stroke-white/45"
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
                <span className="hidden font-serif text-[17px] font-medium italic tracking-tight text-zinc-950 transition-colors duration-150 dark:text-white sm:inline">
                  MarketElite
                </span>
              </button>

              <div className="relative z-10 flex shrink-0 items-center gap-0.5">{rightNavItems.map(renderNavPill)}</div>
            </div>
          </nav>

          {/* Right Floating Liquid Glass Controls: Theme Switcher & GitHub Icon */}
          <div className="pointer-events-auto order-2 flex items-center gap-2 lg:order-3">
            <button
              type="button"
              onClick={toggleTheme}
              title="切换丝绒白昼 / 黑曜夜幕主题"
              className="apple-liquid-glass-btn inline-flex h-10 items-center gap-1.5 rounded-full px-3.5 font-mono text-xs font-semibold text-zinc-950 dark:text-white"
            >
              {theme === "dark" ? (
                <>
                  <Sun className="relative z-10 h-3.5 w-3.5 text-amber-300" />
                  <span className="relative z-10">丝绒白昼</span>
                </>
              ) : (
                <>
                  <Moon className="relative z-10 h-3.5 w-3.5 text-zinc-900" />
                  <span className="relative z-10">黑曜夜幕</span>
                </>
              )}
            </button>

            <a
              href="https://github.com/LOGIC-P/MarketElite"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open MarketElite GitHub Repository"
              title="GitHub · LOGIC-P/MarketElite"
              className="apple-liquid-glass-btn flex h-10 w-10 items-center justify-center rounded-full text-zinc-950 dark:text-white"
            >
              <svg
                viewBox="0 0 24 24"
                className="relative z-10 h-[18px] w-[18px] fill-current"
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
        <main className="mx-auto w-full max-w-[1860px] px-3 pt-3 sm:px-5 lg:px-6">
          <InvestigatorDrawer
            open={true}
            mode="split"
            defaultSymbol={selectedSymbol}
          />
        </main>
      ) : viewMode === "portfolio" ? (
        <main className="mx-auto w-full max-w-[1860px] px-3 pt-3 sm:px-5 lg:px-6">
          <PortfolioWatchdogView
            onSelectSymbol={(sym) => navigateView("stock", sym)}
            onAlertCountChange={setUnackedAlerts}
          />
        </main>
      ) : (
        <main className="mx-auto w-full max-w-[1860px] space-y-3 px-3 pt-2.5 sm:px-5 lg:px-6">
          {error && (
            <div className="flex items-center justify-between rounded-xl border border-rose-300 bg-rose-50 px-4 py-2.5 font-mono text-xs text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/50 dark:text-rose-200">
              <span className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4" />
                {error}
              </span>
              <button
                type="button"
                onClick={loadOverviewAndAssets}
                className="underline hover:text-rose-950 dark:hover:text-white"
              >
                Retry
              </button>
            </div>
          )}

          {loading ? (
            <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-12">
              <div className="h-[740px] animate-pulse rounded-2xl bg-zinc-900/90 xl:col-span-3" />
              <div className="h-[740px] animate-pulse rounded-2xl border border-zinc-200 bg-white dark:border-white/10 dark:bg-zinc-950 xl:col-span-6" />
              <div className="h-[740px] animate-pulse rounded-2xl border border-zinc-200 bg-white dark:border-white/10 dark:bg-zinc-950 xl:col-span-3" />
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
            <OverviewBentoGrid
              theme={theme}
              overview={overview}
              regimeHistory={regimeHistory}
              selectedSymbol={selectedSymbol}
              onSelectSymbol={(sym) => setSelectedSymbol(sym)}
              assetDetail={assetDetail}
              assetLoading={assetLoading}
              gexSymbol={gexSymbol}
              onChangeGexSymbol={(sym) => setGexSymbol(sym)}
              tickerSearchInput={tickerSearchInput}
              onChangeSearchInput={(val) => setTickerSearchInput(val)}
              searchingTicker={searchingTicker}
              tickerSearchError={tickerSearchError}
              onSearchSubmit={handleGlobalTickerSearch}
              watchlistItems={watchlistItems}
              watchlistLoading={watchlistLoading}
              watchlistMutating={watchlistMutating}
              watchlistError={watchlistError}
              onAddWatchlist={handleAddWatchlistSymbol}
              onReorderWatchlist={handlePersistWatchlist}
              onRemoveWatchlist={handleRemoveWatchlistSymbol}
              discoverNews={discoverNews}
              discoverLoading={discoverLoading}
              discoverError={discoverError}
              onRefreshDiscover={() => void loadDiscoverNewsData(true)}
              onOpenStockDetail={(sym) => navigateView("stock", sym)}
              onOpenMyWatchlist={() => navigateView("watchlist")}
              onOpenAiDrawer={() => setDrawerOpen(true)}
            />
          )}
        </main>
      )}

      {/* Bottom Macro Ticker Strip renders ONLY on 市场总览 ("cockpit") */}
      {viewMode === "cockpit" && (
        <MacroTickerStrip
          selectedSymbol={selectedSymbol}
          onSelectProxy={(proxySymbol) => {
            setSelectedSymbol(proxySymbol);
          }}
        />
      )}

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

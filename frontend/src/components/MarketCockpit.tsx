"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { LayoutGroup, motion } from "framer-motion";
import {
  Activity,
  Check,
  Coffee,
  LayoutGrid,
  Moon,
  RefreshCw,
  Settings,
  ShieldAlert,
  Sun,
} from "lucide-react";
import type { Layout } from "react-grid-layout";
import SpotlightBlock from "@/components/SpotlightBlock";
import MacroTickerStrip from "@/components/MacroTickerStrip";
import MarketSessionClock from "@/components/MarketSessionClock";
import MacroCalendarPill from "@/components/MacroCalendarPill";
import SettingsModal from "@/components/SettingsModal";
import OverviewBentoGrid from "@/components/OverviewBentoGrid";
import StatusConsole from "@/components/StatusConsole";
import InvestigatorDrawer from "@/components/InvestigatorDrawer";
import StockDetailView from "@/components/StockDetailView";
import WatchlistWorkspace from "@/components/WatchlistWorkspace";
import { PortfolioWatchdogView } from "@/components/PortfolioWatchdogView";
import { useTheme } from "@/components/ThemeProvider";
import { SETTINGS_UPDATED_EVENT, hasLocalByokKey } from "@/lib/clientSettings";
import {
  DashboardLayoutState,
  LayoutPresetId,
  WIDGET_META_MAP,
  WidgetId,
  clearDashboardLayoutStorage,
  getPresetLayoutState,
  loadDashboardLayoutState,
  saveDashboardLayoutState,
} from "@/lib/dashboardLayout";
import {
  AssetDetailResponse,
  CoreBenchmarkItem,
  DarkPoolProfileResponse,
  DashboardOverviewResponse,
  DiscoverNewsItem,
  InstitutionalFlowResponse,
  RiskPrefillDraft,
  MarketMoversResponse,
  MocAuctionResponse,
  OnChainPulseResponse,
  OptionsExpiryBucket,
  OptionsRadarResponse,
  RegimeHistoryPoint,
  SectorHeatmapResponse,
  SentimentPulseResponse,
  WatchlistAssetItem,
  ensureAsset,
  fetchAssetDetail,
  fetchCoreBenchmarks,
  fetchDarkPoolProfile,
  fetchDashboardOverview,
  fetchDiscoverNews,
  fetchInstitutionalFlow,
  fetchMarketMovers,
  fetchMocAuction,
  fetchOnChainPulse,
  fetchOptionsRadar,
  fetchRegimeHistory,
  fetchSectorHeatmap,
  fetchSentimentPulse,
  fetchWatchdogAlerts,
  fetchWatchlist,
  triggerPipelineSync,
  updateWatchlist,
} from "@/lib/api";

const EASE_EXPO = [0.16, 1, 0.3, 1] as const;

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
  const { theme, setTheme } = useTheme();
  const [viewMode, setViewMode] = useState<CockpitViewMode>(initialView);
  const [overview, setOverview] = useState<DashboardOverviewResponse | null>(null);
  const [sentimentPulse, setSentimentPulse] = useState<SentimentPulseResponse | null>(null);
  const [coreBenchmarks, setCoreBenchmarks] = useState<CoreBenchmarkItem[]>([]);
  const [institutionalFlow, setInstitutionalFlow] = useState<InstitutionalFlowResponse | null>(null);
  const [sectorHeatmap, setSectorHeatmap] = useState<SectorHeatmapResponse | null>(null);
  const [marketMovers, setMarketMovers] = useState<MarketMoversResponse | null>(null);
  const [optionsRadar, setOptionsRadar] = useState<OptionsRadarResponse | null>(null);
  const [optionsLoading, setOptionsLoading] = useState<boolean>(true);
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
  const [optionsPresetSymbol, setOptionsPresetSymbol] = useState<"SPY" | "QQQ" | "IWM">("SPY");
  const [optionsFollowMain, setOptionsFollowMain] = useState<boolean>(false);
  const [optionsBucket, setOptionsBucket] = useState<OptionsExpiryBucket>("all");
  const optionsTargetSymbol = optionsFollowMain ? selectedSymbol : optionsPresetSymbol;

  const [mocAuction, setMocAuction] = useState<MocAuctionResponse | null>(null);
  const [mocLoading, setMocLoading] = useState<boolean>(true);
  const [mocSymbol, setMocSymbol] = useState<string>("SPY");

  const [darkPoolData, setDarkPoolData] = useState<DarkPoolProfileResponse | null>(null);
  const [darkPoolLoading, setDarkPoolLoading] = useState<boolean>(true);
  const [darkPoolFollowMain, setDarkPoolFollowMain] = useState<boolean>(true);
  const [darkPoolManualSymbol, setDarkPoolManualSymbol] = useState<string>("SPY");

  const [onChainData, setOnChainData] = useState<OnChainPulseResponse | null>(null);
  const [onChainLoading, setOnChainLoading] = useState<boolean>(true);

  const normalizedMainSym = selectedSymbol.toUpperCase().trim();
  const isEquityMain =
    normalizedMainSym.length > 0 &&
    !normalizedMainSym.endsWith("USDT") &&
    !["VIX", "^VIX", "DXY", "BTC", "ETH"].includes(normalizedMainSym);
  const darkPoolTargetSymbol =
    darkPoolFollowMain && isEquityMain ? normalizedMainSym : darkPoolManualSymbol;
  const [discoverNews, setDiscoverNews] = useState<DiscoverNewsItem[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState<boolean>(true);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [moversMinPrice, setMoversMinPrice] = useState<number>(2.0);
  const [loading, setLoading] = useState<boolean>(true);
  const [assetLoading, setAssetLoading] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [riskHandoffDraft, setRiskHandoffDraft] = useState<RiskPrefillDraft | null>(null);
  const [copilotQueryDraft, setCopilotQueryDraft] = useState<{
    symbol: string;
    query: string;
    nonce: number;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<"llm" | "broker">("llm");
  const [hasByokKey, setHasByokKey] = useState<boolean>(false);
  const [editMode, setEditMode] = useState<boolean>(false);
  const [layoutHydrated, setLayoutHydrated] = useState<boolean>(false);
  const [layoutState, setLayoutState] = useState<DashboardLayoutState>(() =>
    getPresetLayoutState("classic")
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const syncKeyFlag = () => setHasByokKey(hasLocalByokKey());
    syncKeyFlag();
    window.addEventListener(SETTINGS_UPDATED_EVENT, syncKeyFlag);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, syncKeyFlag);
  }, []);

  useEffect(() => {
    setLayoutState(loadDashboardLayoutState());
    setLayoutHydrated(true);
  }, []);

  useEffect(() => {
    if (!layoutHydrated) return;
    saveDashboardLayoutState(layoutState);
  }, [layoutState, layoutHydrated]);

  const handleUpdateLayoutItems = useCallback((nextVisibleLgLayout: Layout) => {
    if (!nextVisibleLgLayout || nextVisibleLgLayout.length === 0) return;
    const byId = new Map(nextVisibleLgLayout.map((item) => [item.i, item]));

    setLayoutState((prev) => {
      let changed = false;
      const nextItems = prev.items.map((prevItem) => {
        const nextItem = byId.get(prevItem.i);
        if (!nextItem) return prevItem;
        const meta = WIDGET_META_MAP[prevItem.i as WidgetId];
        const minW = meta?.minW ?? prevItem.minW ?? 2;
        const minH = meta?.minH ?? prevItem.minH ?? 3;
        const clampedW = Math.min(12, Math.max(minW, Math.round(nextItem.w)));
        const clampedX = Math.min(Math.max(0, Math.round(nextItem.x)), 12 - clampedW);
        const clampedY = Math.max(0, Math.round(nextItem.y));
        const clampedH = Math.max(minH, Math.round(nextItem.h));

        if (
          prevItem.x === clampedX &&
          prevItem.y === clampedY &&
          prevItem.w === clampedW &&
          prevItem.h === clampedH
        ) {
          return prevItem;
        }
        changed = true;
        return {
          ...prevItem,
          x: clampedX,
          y: clampedY,
          w: clampedW,
          h: clampedH,
          minW,
          minH,
        };
      });

      if (!changed) return prev;
      return {
        ...prev,
        activePreset: "custom",
        items: nextItems,
      };
    });
  }, []);

  const handleToggleWidget = useCallback((id: WidgetId) => {
    setLayoutState((prev) => {
      const isHidden = prev.hiddenIds.includes(id);
      const nextHidden = isHidden
        ? prev.hiddenIds.filter((item) => item !== id)
        : [...prev.hiddenIds, id];
      return {
        ...prev,
        activePreset: "custom",
        hiddenIds: nextHidden,
      };
    });
  }, []);

  const handleApplyPreset = useCallback((preset: LayoutPresetId) => {
    setLayoutState(getPresetLayoutState(preset));
  }, []);

  const handleResetLayout = useCallback(() => {
    setLayoutState(clearDashboardLayoutStorage());
  }, []);

  const handleImportLayout = useCallback((next: DashboardLayoutState) => {
    setLayoutState(next);
  }, []);

  const loadDiscoverNewsData = useCallback(async (forceRefresh = false) => {
    setDiscoverLoading(true);
    try {
      const res = await fetchDiscoverNews(21, forceRefresh);
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
      const [ov, pulse, benches, inst, heatmap, movers, hist, alRes, onchain] = await Promise.all([
        fetchDashboardOverview(),
        fetchSentimentPulse().catch(() => null),
        fetchCoreBenchmarks().catch(() => null),
        fetchInstitutionalFlow().catch(() => null),
        fetchSectorHeatmap().catch(() => null),
        fetchMarketMovers(false, moversMinPrice).catch(() => null),
        fetchRegimeHistory(30).catch(() => ({ count: 0, history: [] })),
        fetchWatchdogAlerts(20).catch(() => ({ count: 0, alerts: [] })),
        fetchOnChainPulse().catch(() => null),
      ]);
      setOverview(ov);
      if (pulse) setSentimentPulse(pulse);
      if (benches?.items) setCoreBenchmarks(benches.items);
      if (inst) setInstitutionalFlow(inst);
      if (heatmap) setSectorHeatmap(heatmap);
      if (movers) setMarketMovers(movers);
      if (onchain) setOnChainData(onchain);
      setRegimeHistory(hist.history);
      setUnackedAlerts(alRes.alerts.filter((a) => !a.acknowledged).length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed loading MarketElite cockpit");
    } finally {
      setLoading(false);
      setOnChainLoading(false);
    }
  }, [moversMinPrice]);

  const handlePersistWatchlist = useCallback(async (nextSymbols: string[]) => {
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
  }, []);

  const handleAddWatchlistSymbol = useCallback(
    async (symbol: string) => {
      const sym = symbol.toUpperCase().trim();
      if (!sym) return;
      const current = watchlistItems.map((x) => x.symbol);
      if (current.includes(sym)) {
        setWatchlistError(`${sym} 已在关注列表中`);
        return;
      }
      await handlePersistWatchlist([sym, ...current]);
    },
    [watchlistItems, handlePersistWatchlist]
  );

  const handleRemoveWatchlistSymbol = useCallback(
    async (symbol: string) => {
      const sym = symbol.toUpperCase().trim();
      const next = watchlistItems.map((x) => x.symbol).filter((s) => s !== sym);
      await handlePersistWatchlist(next);
    },
    [watchlistItems, handlePersistWatchlist]
  );

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
    if (mode !== "cockpit") {
      setEditMode(false);
    }
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

  const assetReqSeqRef = React.useRef(0);

  const loadAsset = useCallback(async (symbol: string) => {
    const reqId = ++assetReqSeqRef.current;
    setAssetLoading(true);
    try {
      const detail = await fetchAssetDetail(symbol, 260, true, true);
      if (reqId === assetReqSeqRef.current) {
        setAssetDetail(detail);
      }
    } catch {
      if (reqId === assetReqSeqRef.current) {
        setAssetDetail(null);
      }
    } finally {
      if (reqId === assetReqSeqRef.current) {
        setAssetLoading(false);
      }
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
    const newsTimer = window.setInterval(() => {
      void loadDiscoverNewsData(false);
    }, 15 * 60 * 1000);
    return () => window.clearInterval(newsTimer);
  }, [loadOverviewAndAssets, loadWatchlistData, loadDiscoverNewsData]);

  const optionsReqSeqRef = React.useRef(0);

  const loadOptionsRadarData = useCallback(
    async (sym: string, bucket: OptionsExpiryBucket, forceRefresh = false) => {
      const reqId = ++optionsReqSeqRef.current;
      setOptionsLoading(true);
      try {
        const res = await fetchOptionsRadar(sym, bucket, forceRefresh);
        if (reqId === optionsReqSeqRef.current) {
          setOptionsRadar(res);
        }
      } catch {
        // Preserve previous radar snapshot cleanly on transient errors
      } finally {
        if (reqId === optionsReqSeqRef.current) {
          setOptionsLoading(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    if (viewMode === "cockpit") {
      void loadOptionsRadarData(optionsTargetSymbol, optionsBucket, false);
    }
  }, [optionsTargetSymbol, optionsBucket, viewMode, loadOptionsRadarData]);

  const mocReqSeqRef = React.useRef(0);
  const loadMocAuctionData = useCallback(async (sym: string, forceRefresh = false) => {
    const reqId = ++mocReqSeqRef.current;
    setMocLoading(true);
    try {
      const res = await fetchMocAuction(sym, forceRefresh);
      if (reqId === mocReqSeqRef.current) {
        setMocAuction(res);
      }
    } catch {
      // Preserve last snapshot cleanly on transient network errors
    } finally {
      if (reqId === mocReqSeqRef.current) {
        setMocLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (viewMode === "cockpit") {
      void loadMocAuctionData(mocSymbol, false);
    }
  }, [mocSymbol, viewMode, loadMocAuctionData]);

  const dpReqSeqRef = React.useRef(0);
  const loadDarkPoolData = useCallback(async (sym: string, forceRefresh = false) => {
    const reqId = ++dpReqSeqRef.current;
    setDarkPoolLoading(true);
    try {
      const res = await fetchDarkPoolProfile(sym, forceRefresh);
      if (reqId === dpReqSeqRef.current) {
        setDarkPoolData(res);
      }
    } catch {
      // Preserve last snapshot cleanly
    } finally {
      if (reqId === dpReqSeqRef.current) {
        setDarkPoolLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (viewMode === "cockpit") {
      void loadDarkPoolData(darkPoolTargetSymbol, false);
    }
  }, [darkPoolTargetSymbol, viewMode, loadDarkPoolData]);

  useEffect(() => {
    if (viewMode !== "cockpit") return;
    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void fetchSentimentPulse()
        .then((pulse) => setSentimentPulse(pulse))
        .catch(() => {});
      void fetchCoreBenchmarks()
        .then((benches) => {
          if (benches?.items) setCoreBenchmarks(benches.items);
        })
        .catch(() => {});
      void fetchSectorHeatmap()
        .then((hm) => setSectorHeatmap(hm))
        .catch(() => {});
    }, 120_000);
    return () => window.clearInterval(timer);
  }, [viewMode]);

  useEffect(() => {
    if (viewMode === "cockpit") {
      loadAsset(selectedSymbol);
    }
  }, [selectedSymbol, viewMode, loadAsset]);

  const handleToggleMoversMinPrice = useCallback((nextMin: number) => {
    setMoversMinPrice(nextMin);
    void fetchMarketMovers(false, nextMin)
      .then((m) => setMarketMovers(m))
      .catch(() => {});
  }, []);

  const handleRefreshMovers = useCallback(() => {
    void fetchMarketMovers(true, moversMinPrice)
      .then((m) => setMarketMovers(m))
      .catch(() => {});
  }, [moversMinPrice]);

  const handleSelectOptionsPreset = useCallback((sym: "SPY" | "QQQ" | "IWM") => {
    setOptionsFollowMain(false);
    setOptionsPresetSymbol(sym);
  }, []);

  const handleToggleOptionsFollowMain = useCallback(() => {
    setOptionsFollowMain((prev) => !prev);
  }, []);

  const handleChangeOptionsBucket = useCallback((b: OptionsExpiryBucket) => {
    setOptionsBucket(b);
  }, []);

  const handleSelectMocSymbol = useCallback((sym: string) => {
    setMocSymbol(sym.toUpperCase().trim() || "SPY");
  }, []);

  const handleToggleDarkPoolFollowMain = useCallback(() => {
    setDarkPoolFollowMain((prev) => !prev);
  }, []);

  const handleSelectDarkPoolSymbol = useCallback((sym: string) => {
    const clean = sym.toUpperCase().trim();
    if (!clean) return;
    setDarkPoolFollowMain(false);
    setDarkPoolManualSymbol(clean);
  }, []);

  const handleSelectSymbolMemo = useCallback((sym: string) => {
    setSelectedSymbol(sym);
  }, []);

  const handleChangeSearchInput = useCallback((val: string) => {
    setTickerSearchInput(val);
  }, []);

  const handleOpenStockDetail = useCallback(
    (sym: string) => navigateView("stock", sym),
    [navigateView]
  );

  const handleOpenMyWatchlist = useCallback(() => navigateView("watchlist"), [navigateView]);

  const handleOpenAiDrawer = useCallback(() => setDrawerOpen(true), []);

  const handleRefreshDiscover = useCallback(() => {
    void loadDiscoverNewsData(true);
  }, [loadDiscoverNewsData]);

  const handleOpenEditMode = useCallback(() => {
    setEditMode(true);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, []);

  const handleCloseEditMode = useCallback(() => setEditMode(false), []);

  const handleManualSync = async () => {
    setSyncing(true);
    try {
      await triggerPipelineSync(false);
      await loadOverviewAndAssets();
      await loadOptionsRadarData(optionsTargetSymbol, optionsBucket, true);
      await loadMocAuctionData(mocSymbol, true);
      await loadDarkPoolData(darkPoolTargetSymbol, true);
      await fetchOnChainPulse(true).then((oc) => setOnChainData(oc)).catch(() => {});
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
    { id: "infra" as const, label: "数据与评测中台" },
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
        className={`relative inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-1.5 font-sans text-[11.5px] tracking-tight transition-colors duration-200 2xl:gap-1.5 2xl:px-3 2xl:text-[13px] ${
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
          <span className="relative z-10 rounded-full bg-zinc-950/[0.12] px-1.5 py-0.5 font-mono text-[10px] font-bold text-zinc-950 dark:bg-white/20 dark:text-white">
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
      <header className="pointer-events-none sticky top-0 z-40 px-2.5 pt-2.5 pb-1 sm:px-3 2xl:px-6">
        <div className="mx-auto flex w-full max-w-[97vw] flex-wrap items-center justify-between gap-1.5 xl:flex-nowrap 2xl:max-w-[2380px] 2xl:gap-2.5">
          {/* Left Floating Circular Glass Controls */}
          <div className="pointer-events-auto flex items-center gap-1.5 2xl:gap-2">
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
              className="apple-liquid-glass-btn inline-flex h-10 items-center gap-1.5 rounded-full px-2.5 font-mono text-xs font-semibold text-zinc-950 disabled:opacity-50 dark:text-white 2xl:px-3.5"
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

            <MarketSessionClock />
          </div>

          {/* Center Split Apple Liquid Glass Navigation Capsule + Rising Brand Emblem (NO overflow scrollbars) */}
          <nav
            aria-label="Primary Workspaces"
            className="pointer-events-auto order-3 flex w-full justify-center xl:order-2 xl:w-auto"
          >
            <LayoutGroup id="cockpit-nav-group">
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
                className="group relative z-10 mx-0.5 flex shrink-0 items-center gap-1.5 rounded-full px-1.5 py-1 transition-transform duration-200 hover:scale-[1.04] 2xl:mx-1.5 2xl:gap-2 2xl:px-2"
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
                <span className="hidden font-serif text-[15px] font-medium italic tracking-tight text-zinc-950 transition-colors duration-150 dark:text-white sm:inline 2xl:text-[17px]">
                  MarketElite
                </span>
              </button>

              <div className="relative z-10 flex shrink-0 items-center gap-0.5">{rightNavItems.map(renderNavPill)}</div>
            </div>
            </LayoutGroup>
          </nav>

          {/* Right Floating Liquid Glass Controls: Macro Calendar, Theme Switcher, Layout Editor, Settings & GitHub */}
          <div className="pointer-events-auto order-2 flex items-center gap-1.5 xl:order-3 2xl:gap-2">
            <MacroCalendarPill />

            <div
              role="group"
              aria-label="切换极昼纯白、暖阳米白或黑曜夜幕主题"
              className="apple-liquid-glass inline-flex h-10 shrink-0 flex-nowrap items-center gap-0.5 rounded-full p-1 font-mono text-[11px] font-semibold"
            >
              {(
                [
                  { id: "white", label: "白昼", title: "极昼纯白", Icon: Sun, iconCls: "text-amber-500" },
                  { id: "cream", label: "米白", title: "暖阳米白", Icon: Coffee, iconCls: "text-amber-700 dark:text-amber-300" },
                  { id: "dark", label: "夜幕", title: "黑曜夜幕", Icon: Moon, iconCls: "text-indigo-500 dark:text-sky-300" },
                ] as const
              ).map(({ id, label, title, Icon, iconCls }) => {
                const active = theme === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTheme(id)}
                    title={title}
                    aria-pressed={active}
                    className={`relative z-10 inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 ${
                      active
                        ? "bg-zinc-950 text-white shadow-sm dark:bg-white dark:text-zinc-950"
                        : "text-zinc-900 hover:bg-black/[0.06] hover:text-zinc-950 dark:text-zinc-100 dark:hover:bg-white/[0.1] dark:hover:text-white"
                    }`}
                  >
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? "text-current" : iconCls}`} />
                    <span className="hidden xl:inline">{label}</span>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => {
                if (viewMode !== "cockpit") {
                  navigateView("cockpit");
                  setEditMode(true);
                  if (typeof window !== "undefined") {
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }
                  return;
                }
                setEditMode((v) => {
                  const next = !v;
                  if (next && typeof window !== "undefined") {
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }
                  return next;
                });
              }}
              title={
                editMode && viewMode === "cockpit"
                  ? "完成主页板块排版并锁定"
                  : "编辑主页板块排版（拖拽移动 · 缩放大小 · 显示/隐藏）"
              }
              aria-label={
                editMode && viewMode === "cockpit"
                  ? "完成主页排版编辑"
                  : "自定义主页板块排版"
              }
              aria-pressed={editMode && viewMode === "cockpit"}
              className={`apple-liquid-glass-btn relative flex h-10 w-10 items-center justify-center rounded-full transition-all ${
                editMode && viewMode === "cockpit"
                  ? "bg-emerald-500/20 text-emerald-700 ring-2 ring-emerald-500/70 dark:bg-emerald-400/20 dark:text-emerald-300 dark:ring-emerald-400/70"
                  : "text-zinc-950 dark:text-white"
              }`}
            >
              {editMode && viewMode === "cockpit" ? (
                <Check className="relative z-10 h-[17px] w-[17px]" />
              ) : (
                <LayoutGrid className="relative z-10 h-[17px] w-[17px]" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              title={
                hasByokKey
                  ? "设置 · 已接入您的本地 API Key"
                  : "设置 · 填写个人 API Key 与选择模型"
              }
              aria-label="打开 API 与站点设置"
              className={`apple-liquid-glass-btn relative flex h-10 w-10 items-center justify-center rounded-full text-zinc-950 dark:text-white ${
                hasByokKey ? "ring-1 ring-emerald-500/45 dark:ring-emerald-400/45" : ""
              }`}
            >
              <Settings className="relative z-10 h-[17px] w-[17px]" />
              {hasByokKey && (
                <span
                  aria-label="BYOK Active"
                  className="absolute right-2 top-2 z-10 h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.9)]"
                />
              )}
            </button>

            <a
              href="https://github.com/LuojicPei/MarketElite"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open MarketElite GitHub Repository"
              title="GitHub · LuojicPei/MarketElite"
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

      <motion.div
        key={viewMode === "stock" ? `stock-${activeStockSymbol}` : viewMode}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.34, ease: EASE_EXPO }}
      >
          {viewMode === "infra" ? (
            <StatusConsole />
          ) : viewMode === "watchlist" ? (
            <WatchlistWorkspace
              items={watchlistItems}
              onNavigateToCopilot={() => {
                setCopilotQueryDraft(null);
                navigateView("copilot");
              }}
              loading={watchlistLoading}
              mutating={watchlistMutating}
              error={watchlistError}
              regimeLabel={overview?.regime?.regime_label}
              spyCloses={sentimentPulse?.spy_closes}
              onAddSymbol={handleAddWatchlistSymbol}
              onReorderSymbols={handlePersistWatchlist}
              onRemoveSymbol={handleRemoveWatchlistSymbol}
              onOpenStockDetail={(sym) => navigateView("stock", sym)}
              onOpenSettings={() => setSettingsOpen(true)}
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
            <main className="mx-auto w-full max-w-[97vw] px-3 pt-3 sm:px-5 lg:px-6 2xl:max-w-[2380px]">
              <InvestigatorDrawer
                open={true}
                mode="split"
                defaultSymbol={selectedSymbol}
                onOpenSettings={() => setSettingsOpen(true)}
                initialRiskDraft={riskHandoffDraft}
                initialQueryPrompt={copilotQueryDraft}
              />
            </main>
          ) : viewMode === "portfolio" ? (
            <main className="mx-auto w-full max-w-[97vw] px-3 pt-3 sm:px-5 lg:px-6 2xl:max-w-[2380px]">
              <PortfolioWatchdogView
                onSelectSymbol={(sym) => navigateView("stock", sym)}
                onAlertCountChange={setUnackedAlerts}
                onOpenSettings={() => {
                  setSettingsInitialTab("broker");
                  setSettingsOpen(true);
                }}
                onOpenCopilot={(sym, customPrompt) => {
                  setSelectedSymbol(sym);
                  setCopilotQueryDraft(
                    customPrompt
                      ? { symbol: sym, query: customPrompt, nonce: Date.now() }
                      : null
                  );
                  navigateView("copilot");
                }}
                onOpenRiskTicket={(draft) => {
                  setSelectedSymbol(draft.symbol);
                  setRiskHandoffDraft(draft);
                  navigateView("copilot");
                }}
              />
            </main>
          ) : (
            <main className="mx-auto w-full max-w-[97vw] space-y-3 px-3 pt-2.5 sm:px-5 lg:px-6 2xl:max-w-[2380px]">
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
                  sentimentPulse={sentimentPulse}
                  coreBenchmarks={coreBenchmarks}
                  institutionalFlow={institutionalFlow}
                  sectorHeatmap={sectorHeatmap}
                  marketMovers={marketMovers}
                  moversMinPrice={moversMinPrice}
                  onToggleMoversMinPrice={handleToggleMoversMinPrice}
                  onRefreshMovers={handleRefreshMovers}
                  optionsRadar={optionsRadar}
                  optionsLoading={optionsLoading}
                  optionsTargetSymbol={optionsTargetSymbol}
                  optionsFollowMain={optionsFollowMain}
                  optionsBucket={optionsBucket}
                  onSelectOptionsPreset={handleSelectOptionsPreset}
                  onToggleOptionsFollowMain={handleToggleOptionsFollowMain}
                  onChangeOptionsBucket={handleChangeOptionsBucket}
                  mocData={mocAuction}
                  mocLoading={mocLoading}
                  mocSymbol={mocSymbol}
                  onSelectMocSymbol={handleSelectMocSymbol}
                  darkPoolData={darkPoolData}
                  darkPoolLoading={darkPoolLoading}
                  darkPoolTargetSymbol={darkPoolTargetSymbol}
                  darkPoolFollowMain={darkPoolFollowMain}
                  onToggleDarkPoolFollowMain={handleToggleDarkPoolFollowMain}
                  onSelectDarkPoolSymbol={handleSelectDarkPoolSymbol}
                  onChainData={onChainData}
                  onChainLoading={onChainLoading}
                  regimeHistory={regimeHistory}
                  selectedSymbol={selectedSymbol}
                  onSelectSymbol={handleSelectSymbolMemo}
                  assetDetail={assetDetail}
                  assetLoading={assetLoading}
                  tickerSearchInput={tickerSearchInput}
                  onChangeSearchInput={handleChangeSearchInput}
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
                  onOpenStockDetail={handleOpenStockDetail}
                  onOpenMyWatchlist={handleOpenMyWatchlist}
                  onOpenAiDrawer={handleOpenAiDrawer}
                  discoverNews={discoverNews}
                  discoverLoading={discoverLoading}
                  discoverError={discoverError}
                  onRefreshDiscover={handleRefreshDiscover}
                  layoutState={layoutState}
                  editMode={editMode}
                  onUpdateLayoutItems={handleUpdateLayoutItems}
                  onToggleWidget={handleToggleWidget}
                  onApplyPreset={handleApplyPreset}
                  onResetLayout={handleResetLayout}
                  onImportLayout={handleImportLayout}
                  onOpenEditMode={handleOpenEditMode}
                  onCloseEditMode={handleCloseEditMode}
                />
              )}
            </main>
          )}
        </motion.div>

      {/* Bottom Macro Ticker Strip renders ONLY on 市场总览 ("cockpit") */}
      {viewMode === "cockpit" && (
        <motion.div
          key="macro-ticker-strip"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: EASE_EXPO }}
        >
          <MacroTickerStrip
            selectedSymbol={selectedSymbol}
            onSelectProxy={(proxySymbol) => {
              setSelectedSymbol(proxySymbol);
            }}
          />
        </motion.div>
      )}

      <InvestigatorDrawer
        open={drawerOpen && (viewMode === "cockpit" || viewMode === "stock" || viewMode === "watchlist")}
        mode="drawer"
        onClose={() => setDrawerOpen(false)}
        onOpenFullWorkspace={() => navigateView("copilot")}
        onOpenSettings={() => setSettingsOpen(true)}
        defaultSymbol={viewMode === "stock" ? activeStockSymbol : selectedSymbol}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsInitialTab("llm");
        }}
        initialTab={settingsInitialTab}
      />
    </div>
  );
}

"use client";

import React, { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ResponsiveGridLayout,
  useContainerWidth,
  verticalCompactor,
  type Layout,
} from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import {
  Activity,
  ArrowRight,
  Layers,
  LayoutGrid,
  RotateCcw,
  Search,
  Sparkles,
  Star,
} from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import MiniKLineSparkline from "@/components/MiniKLineSparkline";
import WatchlistCardPanel from "@/components/WatchlistCardPanel";
import DiscoverNewsShelf from "@/components/DiscoverNewsShelf";
import AssetCandlestickChart from "@/components/charts/AssetCandlestickChart";
import CnnFearGreedGauge from "@/components/charts/CnnFearGreedGauge";
import NetLiquidityChart from "@/components/charts/NetLiquidityChart";
import CatalystRadarModule from "@/components/CatalystRadarModule";
import DarkPoolModule from "@/components/DarkPoolModule";
import InstitutionalFlowModule from "@/components/InstitutionalFlowModule";
import MarketMoversModule from "@/components/MarketMoversModule";
import MocAuctionModule from "@/components/MocAuctionModule";
import OnChainPulseModule from "@/components/OnChainPulseModule";
import OptionsRadarModule from "@/components/OptionsRadarModule";
import SectorHeatmapModule from "@/components/SectorHeatmapModule";
import GridWidgetFrame from "@/components/GridWidgetFrame";
import LayoutEditorBar from "@/components/LayoutEditorBar";
import type { VelvetTheme } from "@/components/ThemeProvider";
import {
  DashboardLayoutState,
  GRID_BREAKPOINTS,
  GRID_COLS,
  GRID_MARGIN,
  GRID_ROW_HEIGHT,
  LayoutPresetId,
  WIDGET_META_MAP,
  WidgetId,
  buildResponsiveLayoutsFromState,
} from "@/lib/dashboardLayout";
import type {
  AssetDetailResponse,
  CoreBenchmarkItem,
  DarkPoolProfileResponse,
  DashboardOverviewResponse,
  DiscoverNewsItem,
  InstitutionalFlowResponse,
  MarketMoversResponse,
  MocAuctionResponse,
  OnChainPulseResponse,
  OptionsExpiryBucket,
  OptionsRadarResponse,
  RegimeHistoryPoint,
  SectorHeatmapResponse,
  SentimentPulseResponse,
  WatchlistAssetItem,
} from "@/lib/api";
import { formatVolumePriceTag } from "@/lib/i18n";

const EASE_EXPO = [0.16, 1, 0.3, 1] as const;

function fmtNum(val: number | null | undefined, digits = 2, suffix = ""): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return `${val.toFixed(digits)}${suffix}`;
}

function fmtSigned(val: number | null | undefined, digits = 2, suffix = ""): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return `${val >= 0 ? "+" : ""}${val.toFixed(digits)}${suffix}`;
}

function deltaTone(val: number | null | undefined, _onObsidian = false): string {
  if (val === null || val === undefined) {
    return "text-zinc-600 dark:text-zinc-300";
  }
  if (val > 0) {
    return "text-emerald-700 dark:text-emerald-400";
  }
  if (val < 0) {
    return "text-rose-700 dark:text-rose-400";
  }
  return "text-zinc-700 dark:text-zinc-300";
}

const REGIME_PLAIN: Record<string, { headline: string; badge: string; dot: string; tone: string }> = {
  HIGH_VOL_TRANSITION: {
    headline: "波动切换期 · 警惕剧烈震荡",
    badge: "防守偏稳",
    dot: "bg-amber-500 dark:bg-amber-400",
    tone: "border-amber-500/45 bg-amber-500/15 text-amber-900 dark:text-amber-200",
  },
  RISK_ON_EXPANSION: {
    headline: "顺风扩张期 · 流动性充裕",
    badge: "顺风进攻",
    dot: "bg-emerald-500 dark:bg-emerald-400",
    tone: "border-emerald-500/45 bg-emerald-500/15 text-emerald-900 dark:text-emerald-200",
  },
  RISK_OFF_STRESS: {
    headline: "环境偏紧 · 防守控仓为主",
    badge: "防守警戒",
    dot: "bg-rose-500 dark:bg-rose-400",
    tone: "border-rose-500/45 bg-rose-500/15 text-rose-900 dark:text-rose-200",
  },
  LIQUIDITY_TIGHTENING: {
    headline: "利率与抽水压制 · 谨慎扩张",
    badge: "收紧观察",
    dot: "bg-amber-500 dark:bg-amber-400",
    tone: "border-amber-500/45 bg-amber-500/15 text-amber-900 dark:text-amber-200",
  },
  NEUTRAL_ROTATION: {
    headline: "中性轮动 · 结构分化为主",
    badge: "温和中性",
    dot: "bg-sky-500 dark:bg-sky-400",
    tone: "border-sky-500/45 bg-sky-500/15 text-sky-900 dark:text-sky-200",
  },
};

interface OverviewBentoGridProps {
  theme: VelvetTheme;
  overview: DashboardOverviewResponse | null;
  sentimentPulse?: SentimentPulseResponse | null;
  coreBenchmarks?: CoreBenchmarkItem[];
  institutionalFlow?: InstitutionalFlowResponse | null;
  sectorHeatmap?: SectorHeatmapResponse | null;
  marketMovers?: MarketMoversResponse | null;
  moversMinPrice?: number;
  onToggleMoversMinPrice?: (nextMin: number) => void;
  onRefreshMovers?: () => void;
  optionsRadar?: OptionsRadarResponse | null;
  optionsLoading?: boolean;
  optionsTargetSymbol: string;
  optionsFollowMain: boolean;
  optionsBucket: OptionsExpiryBucket;
  onSelectOptionsPreset: (sym: "SPY" | "QQQ" | "IWM") => void;
  onToggleOptionsFollowMain: () => void;
  onChangeOptionsBucket: (bucket: OptionsExpiryBucket) => void;
  mocData?: MocAuctionResponse | null;
  mocLoading?: boolean;
  mocSymbol: string;
  onSelectMocSymbol: (sym: string) => void;
  darkPoolData?: DarkPoolProfileResponse | null;
  darkPoolLoading?: boolean;
  darkPoolTargetSymbol: string;
  darkPoolFollowMain: boolean;
  onToggleDarkPoolFollowMain: () => void;
  onSelectDarkPoolSymbol: (sym: string) => void;
  onChainData?: OnChainPulseResponse | null;
  onChainLoading?: boolean;
  regimeHistory?: RegimeHistoryPoint[];
  selectedSymbol: string;
  onSelectSymbol: (sym: string) => void;
  assetDetail: AssetDetailResponse | null;
  assetLoading: boolean;
  tickerSearchInput: string;
  onChangeSearchInput: (val: string) => void;
  searchingTicker: boolean;
  tickerSearchError: string | null;
  onSearchSubmit: (e: React.FormEvent) => void;
  watchlistItems: WatchlistAssetItem[];
  watchlistLoading: boolean;
  watchlistMutating: boolean;
  watchlistError: string | null;
  onAddWatchlist: (sym: string) => Promise<void>;
  onReorderWatchlist: (syms: string[]) => Promise<void>;
  onRemoveWatchlist: (sym: string) => Promise<void>;
  discoverNews: DiscoverNewsItem[];
  discoverLoading: boolean;
  discoverError: string | null;
  onRefreshDiscover: () => void;
  onOpenStockDetail: (sym: string) => void;
  onOpenMyWatchlist: () => void;
  onOpenAiDrawer: () => void;
  layoutState: DashboardLayoutState;
  editMode: boolean;
  onUpdateLayoutItems: (nextVisibleLgLayout: Layout) => void;
  onToggleWidget: (id: WidgetId) => void;
  onApplyPreset: (preset: LayoutPresetId) => void;
  onResetLayout: () => void;
  onImportLayout: (next: DashboardLayoutState) => void;
  onOpenEditMode: () => void;
  onCloseEditMode: () => void;
}

function OverviewBentoGrid({
  theme,
  overview,
  sentimentPulse,
  coreBenchmarks,
  institutionalFlow,
  sectorHeatmap,
  marketMovers,
  moversMinPrice = 2.0,
  onToggleMoversMinPrice,
  onRefreshMovers,
  optionsRadar,
  optionsLoading,
  optionsTargetSymbol,
  optionsFollowMain,
  optionsBucket,
  onSelectOptionsPreset,
  onToggleOptionsFollowMain,
  onChangeOptionsBucket,
  mocData,
  mocLoading,
  mocSymbol,
  onSelectMocSymbol,
  darkPoolData,
  darkPoolLoading,
  darkPoolTargetSymbol,
  darkPoolFollowMain,
  onToggleDarkPoolFollowMain,
  onSelectDarkPoolSymbol,
  onChainData,
  onChainLoading,
  selectedSymbol,
  onSelectSymbol,
  assetDetail,
  assetLoading,
  tickerSearchInput,
  onChangeSearchInput,
  searchingTicker,
  tickerSearchError,
  onSearchSubmit,
  watchlistItems,
  watchlistLoading,
  watchlistMutating,
  watchlistError,
  onAddWatchlist,
  onReorderWatchlist,
  onRemoveWatchlist,
  discoverNews,
  discoverLoading,
  discoverError,
  onRefreshDiscover,
  onOpenStockDetail,
  onOpenMyWatchlist,
  onOpenAiDrawer,
  layoutState,
  editMode,
  onUpdateLayoutItems,
  onToggleWidget,
  onApplyPreset,
  onResetLayout,
  onImportLayout,
  onOpenEditMode,
  onCloseEditMode,
}: OverviewBentoGridProps) {
  const { width, containerRef, mounted } = useContainerWidth({
    measureBeforeMount: true,
    initialWidth: 1280,
  });
  const chartTheme: "light" | "dark" = theme === "dark" ? "dark" : "light";
  const currentBreakpoint: "lg" | "md" | "sm" =
    width >= GRID_BREAKPOINTS.lg ? "lg" : width >= GRID_BREAKPOINTS.md ? "md" : "sm";
  const breakpointRef = useRef<"lg" | "md" | "sm">(currentBreakpoint);
  breakpointRef.current = currentBreakpoint;
  const [, setActiveBreakpoint] = useState<"lg" | "md" | "sm">("lg");

  const regimeLabel = overview?.regime?.regime_label ?? "";
  const regimeInfo = REGIME_PLAIN[regimeLabel] ?? {
    headline: "宏观环境初始化中...",
    badge: "待同步",
    dot: "bg-zinc-400",
    tone: "border-zinc-700 bg-zinc-900 text-zinc-200",
  };

  const watchlistSymbols = useMemo(
    () => watchlistItems.map((x) => x.symbol),
    [watchlistItems]
  );

  // Module 1 unified metrics (live Yahoo ^TNX / DXY overlaid seamlessly over deterministic FRED data)
  const yield10y = sentimentPulse?.tnx?.price ?? overview?.macro?.yield_credit.dgs10 ?? null;
  const yield10yBps =
    sentimentPulse?.tnx?.change_abs != null
      ? Math.round(sentimentPulse.tnx.change_abs * 100)
      : null;
  const yield2y = overview?.macro?.yield_credit.dgs2 ?? null;
  const realYield10y = overview?.macro?.yield_credit.dfii10 ?? null;
  const liqLatestB = overview?.macro?.net_liquidity.latest_billions ?? null;
  const liqDelta20B = overview?.macro?.net_liquidity.delta_20d_billions ?? null;
  const hyOas = overview?.macro?.yield_credit.hy_oas ?? null;
  const dxySpot = sentimentPulse?.dxy?.price ?? null;
  const dxyPct = sentimentPulse?.dxy?.change_pct ?? null;

  // Module 6 unified Fear & Greed (CNN Live pre-market/intraday first, internal snapshot fallback)
  const liveFearGreed = sentimentPulse?.fear_greed ?? null;
  const activeFgScore = liveFearGreed?.score ?? overview?.regime?.fear_greed.score ?? null;
  const activeFgRating = liveFearGreed?.label ?? overview?.regime?.fear_greed.label ?? "Unavailable";
  const activeFgSource = liveFearGreed?.source ?? "internal";
  const activeFgRawValues = liveFearGreed?.component_raw_values ?? {};
  const activeVixBars = sentimentPulse?.vix?.bars ?? [];
  const activeVixSpot = sentimentPulse?.vix?.price ?? overview?.macro?.vix_structure.vix ?? null;
  const activeVixChangeAbs = sentimentPulse?.vix?.change_abs ?? null;
  const activeVixChangePct = sentimentPulse?.vix?.change_pct ?? null;
  const activeVixPeak = sentimentPulse?.vix?.peak_high ?? null;
  const activeVixPeakDate = sentimentPulse?.vix?.peak_date ?? null;

  const hiddenSet = useMemo(() => new Set<WidgetId>(layoutState.hiddenIds), [layoutState.hiddenIds]);

  const visibleItems = useMemo(
    () =>
      layoutState.items
        .filter((item) => !hiddenSet.has(item.i as WidgetId))
        .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x)),
    [layoutState.items, hiddenSet]
  );

  const responsiveLayouts = useMemo(
    () => buildResponsiveLayoutsFromState(layoutState),
    [layoutState]
  );

  const canManipulateGrid = editMode && currentBreakpoint !== "sm";

  const renderWidgetBody = (widgetId: WidgetId): React.ReactNode => {
    switch (widgetId) {
      case "macro-regime": {
        const yieldTag =
          yield10y == null
            ? "利率读取中"
            : yield10y >= 4.5
              ? "估值偏高压"
              : yield10y >= 4.0
                ? "利率温和"
                : "估值友好";
        const yieldBadgeCls =
          yield10y == null
            ? "bg-zinc-200/80 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            : yield10y >= 4.5
              ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
              : yield10y >= 4.0
                ? "bg-amber-500/15 text-amber-800 dark:text-amber-300"
                : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
        const yieldDesc =
          yield10y == null
            ? "同步美债收益率中"
            : yield10y >= 4.5
              ? ">4.5% 抬升贴现率，持续压制科技成长估值"
              : yield10y >= 4.0
                ? "4.0%-4.5% 震荡区间，估值端承压有限"
                : "<4.0% 无风险基准回落，估值空间打开";

        const creditTag =
          hyOas == null
            ? "等待利差"
            : hyOas < 3.5
              ? "信用安全(违约低)"
              : hyOas <= 4.75
                ? "信用常态平稳"
                : "信用利差走阔警示";
        const creditBadgeCls =
          hyOas == null
            ? "bg-zinc-200/80 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            : hyOas < 3.5
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : hyOas <= 4.75
                ? "bg-zinc-200/80 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
                : "bg-rose-500/15 text-rose-700 dark:text-rose-300";

        const dxyFlowTag =
          dxyPct == null
            ? "美元同步中"
            : dxyPct >= 0.25
              ? "美元走强 · 抽血"
              : dxyPct <= -0.25
                ? "美元走弱 · 利好"
                : "美元波动平稳";
        const dxyBadgeCls =
          dxyPct == null
            ? "bg-zinc-200/80 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            : dxyPct >= 0.25
              ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
              : dxyPct <= -0.25
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : "bg-zinc-200/80 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200";
        const dxyDesc =
          dxyPct == null
            ? "等待全球外汇快照"
            : dxyPct >= 0.25
              ? "强美元压制外资风险偏好与大宗计价"
              : dxyPct <= -0.25
                ? "弱美元释放全球流动性并提振黄金股指"
                : "汇率波幅温和，跨国营收与汇兑扰动有限";

        const netSeries = overview?.macro?.net_liquidity.series ?? [];
        const latestLiqPt = netSeries.length > 0 ? netSeries[netSeries.length - 1] : null;
        const prev20LiqPt =
          netSeries.length > 1 ? netSeries[Math.max(0, netSeries.length - 21)] : null;
        const walclB = latestLiqPt?.walcl_b ?? null;
        const walclDeltaB =
          latestLiqPt && prev20LiqPt ? latestLiqPt.walcl_b - prev20LiqPt.walcl_b : null;
        const tgaB = latestLiqPt?.tga_b ?? null;
        const tgaDeltaB =
          latestLiqPt && prev20LiqPt ? latestLiqPt.tga_b - prev20LiqPt.tga_b : null;
        const rrpB = latestLiqPt?.rrp_b ?? null;
        const rrpDeltaB =
          latestLiqPt && prev20LiqPt ? latestLiqPt.rrp_b - prev20LiqPt.rrp_b : null;
        const sofr = overview?.macro?.yield_credit.sofr ?? null;
        const wresbalB = overview?.macro?.yield_credit.wresbal_billions ?? null;
        const hygLqdRatio = overview?.macro?.yield_credit.hyg_lqd_ratio ?? null;
        const hygLqdDelta = overview?.macro?.yield_credit.hyg_lqd_20d_delta_pct ?? null;

        const yieldSpread = yield2y != null && yield10y != null ? yield10y - yield2y : null;
        const twoYTag =
          yieldSpread == null
            ? "等待曲线同步"
            : yieldSpread < 0
              ? `倒挂 ${yieldSpread.toFixed(2)}%`
              : `曲线正常 +${yieldSpread.toFixed(2)}%`;
        const twoYBadgeCls =
          yieldSpread == null
            ? "bg-zinc-200/80 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            : yieldSpread < 0
              ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
              : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
        const twoYDesc =
          yieldSpread == null
            ? "追踪政策利率锚"
            : yieldSpread < 0
              ? `短端高于长端 · ${sofr != null ? `隔夜SOFR ${sofr.toFixed(2)}%` : "紧缩预期未退"}`
              : `10Y-2Y 正利差 · ${sofr != null ? `隔夜SOFR ${sofr.toFixed(2)}%` : "期限结构修复"}`;

        const realTag =
          realYield10y == null
            ? "—"
            : realYield10y >= 2.1
              ? "偏高压制估值"
              : realYield10y >= 1.5
                ? "中性偏紧"
                : "估值舒适区";
        const realBadgeCls =
          realYield10y == null
            ? "bg-zinc-200/80 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            : realYield10y >= 2.1
              ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
              : realYield10y >= 1.5
                ? "bg-amber-500/15 text-amber-800 dark:text-amber-300"
                : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
        const realDesc =
          realYield10y == null
            ? "扣除通胀的真实资金成本"
            : realYield10y >= 2.1
              ? "TIPS >2.1% 警戒，资金偏好高自由现金流"
              : realYield10y >= 1.5
                ? "真实利率中性偏紧，成长与价值结构分化"
                : "<1.5% 真实资金宽松，高久期资产顺风";

        const liqBadgeCls =
          liqDelta20B == null
            ? "bg-zinc-200/80 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            : liqDelta20B >= 0
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "bg-rose-500/15 text-rose-700 dark:text-rose-300";
        const liqDesc =
          liqDelta20B == null
            ? "美联储净资金池监测"
            : liqDelta20B >= 0
              ? "近20日水库净释放现金，托底风险偏好"
              : "近20日水库净抽血，需防流动性收紧冲击";

        const creditDesc =
          hyOas == null
            ? "追踪高收益债信用利差"
            : hyOas <= 4.75
              ? `${hygLqdRatio != null ? `HYG/LQD ${hygLqdRatio.toFixed(2)} · ` : ""}企业债违约预期低`
              : `${hygLqdRatio != null ? `HYG/LQD ${hygLqdRatio.toFixed(2)} · ` : ""}信用避险溢价走高`;

        const bankCashTag =
          wresbalB != null
            ? wresbalB >= 2800
              ? `银行资金充裕 ($${(wresbalB / 1000).toFixed(2)}T) · 隔夜拆借 SOFR ${sofr != null ? `${sofr.toFixed(2)}%` : "—"}`
              : `银行准备金 $${(wresbalB / 1000).toFixed(2)}T · SOFR ${sofr != null ? `${sofr.toFixed(2)}%` : "—"}`
            : "美联储总资产、财政部TGA与逆回购RRP三水库联动";

        return (
          <SpotlightBlock tone="obsidian" className="flex h-full flex-col justify-between gap-1.5 overflow-hidden p-3">
            <div className="shrink-0">
              {/* Balanced Primary Header + Compact Regime Pill on One Baseline */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5 font-sans text-[14px] font-bold tracking-tight text-zinc-950 dark:text-white">
                  <Layers className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span className="truncate">宏观环境与资金总闸</span>
                </div>
                <span
                  className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-sans text-[10px] font-semibold ${regimeInfo.tone}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${regimeInfo.dot}`} />
                  {regimeInfo.badge}
                </span>
              </div>

              {/* Plain-Chinese Verdict Callout */}
              <div className="mt-1 truncate rounded-lg border border-zinc-200/80 bg-white/75 px-2.5 py-1 font-sans text-[11px] font-semibold text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-100">
                定调：{regimeInfo.headline}
              </div>

              {/* 6-Tile Macro Pillars (Left-Right Split: Left Big Value, Right Badge + Rich Narrative) */}
              <div className="mt-1 grid grid-cols-2 gap-1">
                <div
                  title={yieldDesc}
                  className="flex min-w-0 items-center justify-between gap-1.5 rounded-lg border border-zinc-200/90 bg-white/85 px-2 py-1 dark:border-zinc-800/90 dark:bg-zinc-950/65"
                >
                  <div className="shrink-0">
                    <div className="font-sans text-[9.5px] font-medium text-zinc-600 dark:text-zinc-400">
                      10年美债利率
                    </div>
                    <div className="mt-0.5 flex items-baseline gap-1">
                      <span className="font-mono text-[14px] font-extrabold leading-none tabular-nums text-zinc-950 dark:text-white">
                        {yield10y != null ? `${yield10y.toFixed(2)}%` : "—"}
                      </span>
                      {yield10yBps != null && (
                        <span
                          className={`font-mono text-[9.5px] font-bold ${
                            yield10yBps > 0
                              ? "text-rose-700 dark:text-rose-400"
                              : "text-emerald-700 dark:text-emerald-400"
                          }`}
                        >
                          {yield10yBps >= 0 ? `+${yield10yBps}` : yield10yBps}bp
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 text-right">
                    <span className={`inline-block max-w-full truncate whitespace-nowrap rounded px-1 py-0.5 font-sans text-[9px] font-bold leading-none ${yieldBadgeCls}`}>
                      {yieldTag}
                    </span>
                    <div className="mt-0.5 truncate font-sans text-[9px] leading-tight text-zinc-600 dark:text-zinc-300">
                      {yieldDesc}
                    </div>
                  </div>
                </div>

                <div
                  title={`2年期美债收益率对美联储降息/加息预期最敏感 · ${twoYDesc}`}
                  className="flex min-w-0 items-center justify-between gap-1.5 rounded-lg border border-zinc-200/90 bg-white/85 px-2 py-1 dark:border-zinc-800/90 dark:bg-zinc-950/65"
                >
                  <div className="shrink-0">
                    <div className="font-sans text-[9.5px] font-medium text-zinc-600 dark:text-zinc-400">
                      2年利率(降息锚)
                    </div>
                    <div className="mt-0.5 font-mono text-[14px] font-extrabold leading-none tabular-nums text-zinc-950 dark:text-white">
                      {yield2y != null ? `${yield2y.toFixed(2)}%` : "—"}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 text-right">
                    <span className={`inline-block max-w-full truncate whitespace-nowrap rounded px-1 py-0.5 font-sans text-[9px] font-bold leading-none ${twoYBadgeCls}`}>
                      {twoYTag}
                    </span>
                    <div className="mt-0.5 truncate font-sans text-[9px] leading-tight text-zinc-600 dark:text-zinc-300">
                      {twoYDesc}
                    </div>
                  </div>
                </div>

                <div
                  title={`扣除通胀后的真实融资成本：高于2.1%会明显压制高估值科技股 · ${realDesc}`}
                  className="flex min-w-0 items-center justify-between gap-1.5 rounded-lg border border-zinc-200/90 bg-white/85 px-2 py-1 dark:border-zinc-800/90 dark:bg-zinc-950/65"
                >
                  <div className="shrink-0">
                    <div className="font-sans text-[9.5px] font-medium text-zinc-600 dark:text-zinc-400">
                      10Y 实际利率
                    </div>
                    <div className="mt-0.5 font-mono text-[14px] font-extrabold leading-none tabular-nums text-zinc-950 dark:text-white">
                      {realYield10y != null ? `${realYield10y.toFixed(2)}%` : "—"}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 text-right">
                    <span className={`inline-block max-w-full truncate whitespace-nowrap rounded px-1 py-0.5 font-sans text-[9px] font-bold leading-none ${realBadgeCls}`}>
                      {realTag}
                    </span>
                    <div className="mt-0.5 truncate font-sans text-[9px] leading-tight text-zinc-600 dark:text-zinc-300">
                      {realDesc}
                    </div>
                  </div>
                </div>

                <div
                  title={`过去20个交易日美联储向市场净释放(+)或抽走(-)的美元资金 · ${liqDesc}`}
                  className="flex min-w-0 items-center justify-between gap-1.5 rounded-lg border border-zinc-200/90 bg-white/85 px-2 py-1 dark:border-zinc-800/90 dark:bg-zinc-950/65"
                >
                  <div className="shrink-0">
                    <div className="font-sans text-[9.5px] font-medium text-zinc-600 dark:text-zinc-400">
                      20日市场净放水
                    </div>
                    <div className={`mt-0.5 font-mono text-[14px] font-extrabold leading-none tabular-nums ${deltaTone(liqDelta20B)}`}>
                      {liqDelta20B != null
                        ? `${liqDelta20B >= 0 ? "+" : "-"}$${Math.abs(liqDelta20B).toFixed(1)}B`
                        : "—"}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 text-right">
                    <span className={`inline-block max-w-full truncate whitespace-nowrap rounded px-1 py-0.5 font-mono text-[9px] font-bold leading-none ${liqBadgeCls}`}>
                      池深{liqLatestB != null ? `$${(liqLatestB / 1000).toFixed(2)}T` : "—"}
                    </span>
                    <div className="mt-0.5 truncate font-sans text-[9px] leading-tight text-zinc-600 dark:text-zinc-300">
                      {liqDesc}
                    </div>
                  </div>
                </div>

                <div
                  title={`高收益企业债违约利差${hygLqdRatio != null ? `（HYG/LQD比 ${hygLqdRatio.toFixed(2)}）` : ""} · ${creditDesc}`}
                  className="flex min-w-0 items-center justify-between gap-1.5 rounded-lg border border-zinc-200/90 bg-white/85 px-2 py-1 dark:border-zinc-800/90 dark:bg-zinc-950/65"
                >
                  <div className="shrink-0">
                    <div className="font-sans text-[9.5px] font-medium text-zinc-600 dark:text-zinc-400">
                      企业违约利差
                    </div>
                    <div className="mt-0.5 flex items-baseline gap-0.5 font-mono leading-none">
                      <span className="text-[14px] font-extrabold tabular-nums text-zinc-950 dark:text-white">
                        {fmtNum(hyOas, 2, "%")}
                      </span>
                      {hygLqdDelta != null && (
                        <span className={`text-[9px] font-bold ${deltaTone(hygLqdDelta)}`}>
                          {hygLqdDelta >= 0 ? "+" : ""}
                          {hygLqdDelta.toFixed(1)}%
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 text-right">
                    <span className={`inline-block max-w-full truncate whitespace-nowrap rounded px-1 py-0.5 font-sans text-[9px] font-bold leading-none ${creditBadgeCls}`}>
                      {creditTag}
                    </span>
                    <div className="mt-0.5 truncate font-sans text-[9px] leading-tight text-zinc-600 dark:text-zinc-300">
                      {creditDesc}
                    </div>
                  </div>
                </div>

                <div
                  title={`${bankCashTag} · ${dxyDesc}`}
                  className="flex min-w-0 items-center justify-between gap-1.5 rounded-lg border border-zinc-200/90 bg-white/85 px-2 py-1 dark:border-zinc-800/90 dark:bg-zinc-950/65"
                >
                  <div className="shrink-0">
                    <div className="font-sans text-[9.5px] font-medium text-zinc-600 dark:text-zinc-400">
                      美元指数(DXY)
                    </div>
                    <div className="mt-0.5 flex items-baseline gap-0.5 font-mono leading-none">
                      <span className="text-[14px] font-extrabold tabular-nums text-zinc-950 dark:text-white">
                        {dxySpot != null ? dxySpot.toFixed(2) : "—"}
                      </span>
                      {dxyPct != null && (
                        <span
                          className={`text-[9px] font-bold ${
                            dxyPct > 0
                              ? "text-rose-700 dark:text-rose-400"
                              : "text-emerald-700 dark:text-emerald-400"
                          }`}
                        >
                          {fmtSigned(dxyPct, 2, "%")}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 text-right">
                    <span className={`inline-block max-w-full truncate whitespace-nowrap rounded px-1 py-0.5 font-sans text-[9px] font-bold leading-none ${dxyBadgeCls}`}>
                      {dxyFlowTag}
                    </span>
                    <div className="mt-0.5 truncate font-sans text-[9px] leading-tight text-zinc-600 dark:text-zinc-300">
                      {dxyDesc}
                    </div>
                  </div>
                </div>
              </div>

              {/* Compact 3 Reservoirs Strip (Left-Right Split matching Main Pillars) */}
              <div
                title={bankCashTag}
                className="mt-1 grid grid-cols-3 gap-1 font-mono text-[8.5px]"
              >
                <div className="flex min-w-0 items-center justify-between gap-1 rounded-lg border border-zinc-200/90 bg-white/80 px-1.5 py-1 dark:border-zinc-800/90 dark:bg-zinc-950/65">
                  <div className="shrink-0">
                    <div className="font-sans text-[9px] text-zinc-600 dark:text-zinc-400">
                      央行总资产
                    </div>
                    <div className="mt-0.5 text-[12.5px] font-extrabold leading-none text-zinc-950 dark:text-white tabular-nums">
                      {walclB != null ? `$${(walclB / 1000).toFixed(2)}T` : "—"}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 text-right">
                    <span
                      className={`inline-block max-w-full truncate whitespace-nowrap rounded px-1 py-0.5 text-[8px] font-bold leading-none ${
                        walclDeltaB == null
                          ? "bg-zinc-200/80 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                          : walclDeltaB >= 0
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            : "bg-amber-500/15 text-amber-800 dark:text-amber-300"
                      }`}
                    >
                      {walclDeltaB != null
                        ? `${walclDeltaB >= 0 ? "扩" : "缩"}$${Math.abs(walclDeltaB).toFixed(0)}B`
                        : "QT"}
                    </span>
                    <div className="mt-0.5 truncate font-sans text-[8px] leading-tight text-zinc-600 dark:text-zinc-300">
                      {wresbalB != null ? `备$${(wresbalB / 1000).toFixed(1)}T` : "流动性底"}
                    </div>
                  </div>
                </div>

                <div className="flex min-w-0 items-center justify-between gap-1 rounded-lg border border-zinc-200/90 bg-white/80 px-1.5 py-1 dark:border-zinc-800/90 dark:bg-zinc-950/65">
                  <div className="shrink-0">
                    <div className="font-sans text-[9px] text-zinc-600 dark:text-zinc-400">
                      国库(TGA)
                    </div>
                    <div className="mt-0.5 text-[12.5px] font-extrabold leading-none text-zinc-950 dark:text-white tabular-nums">
                      {tgaB != null ? `$${tgaB.toFixed(0)}B` : "—"}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 text-right">
                    <span
                      className={`inline-block max-w-full truncate whitespace-nowrap rounded px-1 py-0.5 font-sans text-[8px] font-bold leading-none ${
                        tgaDeltaB == null
                          ? "bg-zinc-200/80 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                          : tgaDeltaB <= 0
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                      }`}
                    >
                      {tgaDeltaB != null
                        ? `${tgaDeltaB <= 0 ? "放" : "抽"}$${Math.abs(tgaDeltaB).toFixed(0)}B`
                        : "财政库"}
                    </span>
                    <div className="mt-0.5 truncate font-sans text-[8px] leading-tight text-zinc-600 dark:text-zinc-300">
                      {(tgaDeltaB ?? 0) <= 0 ? "释现金" : "吸现金"}
                    </div>
                  </div>
                </div>

                <div className="flex min-w-0 items-center justify-between gap-1 rounded-lg border border-zinc-200/90 bg-white/80 px-1.5 py-1 dark:border-zinc-800/90 dark:bg-zinc-950/65">
                  <div className="shrink-0">
                    <div className="font-sans text-[9px] text-zinc-600 dark:text-zinc-400">
                      逆回购(RRP)
                    </div>
                    <div className="mt-0.5 text-[12.5px] font-extrabold leading-none text-zinc-950 dark:text-white tabular-nums">
                      {rrpB != null ? `$${rrpB.toFixed(0)}B` : "—"}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 text-right">
                    <span
                      className={`inline-block max-w-full truncate whitespace-nowrap rounded px-1 py-0.5 font-sans text-[8px] font-bold leading-none ${
                        rrpDeltaB == null
                          ? "bg-zinc-200/80 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                          : rrpDeltaB <= 0
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                      }`}
                    >
                      {rrpDeltaB != null ? (rrpDeltaB <= 0 ? "回流" : "留存") : "缓冲"}
                    </span>
                    <div className="mt-0.5 truncate font-sans text-[8px] leading-tight text-zinc-600 dark:text-zinc-300">
                      {rrpB != null && rrpB < 50 ? "见底承压" : "缓冲足"}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-zinc-200/80 bg-white/70 px-2 pt-1.5 pb-1 dark:border-zinc-800/80 dark:bg-zinc-950/55">
              <NetLiquidityChart
                theme={chartTheme}
                series={netSeries}
                spyOverlay={sentimentPulse?.spy_closes}
                delta20dBillions={liqDelta20B}
                fillContainer
              />
            </div>
          </SpotlightBlock>
        );
      }

      case "cot-positioning":
        return <InstitutionalFlowModule data={institutionalFlow ?? null} theme={chartTheme} />;

      case "benchmarks-search": {
        const coreSymbols = ["SPY", "QQQ", "SOXX", "BTCUSDT"] as const;
        const benchMetaMap: Record<string, { display: string; name: string }> = {
          SPY: { display: "SPY", name: "标普500" },
          QQQ: { display: "QQQ", name: "纳指100" },
          SOXX: { display: "SOXX", name: "半导体" },
          BTCUSDT: { display: "BTC", name: "比特币" },
        };
        const benchmarkCards: CoreBenchmarkItem[] =
          coreBenchmarks && coreBenchmarks.length > 0
            ? coreBenchmarks
            : coreSymbols.map((sym) => {
                const tech = overview?.equities?.core_indices?.[sym];
                return {
                  symbol: sym,
                  display_symbol: benchMetaMap[sym].display,
                  name_zh: benchMetaMap[sym].name,
                  role_zh: "",
                  last_close: tech?.last_close ?? null,
                  prev_close: tech?.prev_close ?? null,
                  change_1d_pct: tech?.change_1d_pct ?? null,
                  change_5d_pct: tech?.change_5d_pct ?? null,
                  change_20d_pct: tech?.change_20d_pct ?? null,
                  change_ytd_pct: tech?.change_ytd_pct ?? null,
                  rsi_14: tech?.rsi_14 ?? null,
                  dist_50ma_pct: tech?.dist_50ma_pct ?? null,
                  dist_52w_high_pct: tech?.dist_52w_high_pct ?? null,
                  macd_hist: tech?.macd?.histogram ?? null,
                  macd_prev_hist: tech?.macd?.prev_histogram ?? null,
                  atr_pct: null,
                  rvol_20: null,
                  sparkline_bars: tech?.sparkline_bars ?? [],
                };
              });

        const retTone = (v: number | null | undefined) => {
          if (v == null) return "text-zinc-500 dark:text-zinc-400";
          return v >= 0
            ? "text-emerald-700 dark:text-emerald-300"
            : "text-rose-700 dark:text-rose-300";
        };
        const isDarkSurface = theme === "dark";
        const isCreamSurface = theme === "cream";

        return (
          <SpotlightBlock
            tone="obsidian"
            className="flex h-full flex-col justify-between gap-2 overflow-y-auto p-2"
          >
            <div className="grid flex-1 grid-cols-2 gap-1.5 sm:grid-cols-4">
              {benchmarkCards.map((item) => {
                const active = selectedSymbol === item.symbol;
                const chg = item.change_1d_pct ?? 0;
                const isUp = chg >= 0;
                const strongMove = Math.abs(chg) >= 1.5;
                const rgb = isUp ? "16, 185, 129" : "244, 63, 94";

                // Style F: E's diagonal directional gradient wash + D's completely borderless lifted active state
                const washA = active
                  ? isDarkSurface
                    ? strongMove ? 0.25 : 0.21
                    : strongMove ? 0.16 : 0.13
                  : isDarkSurface
                    ? strongMove ? 0.14 : 0.10
                    : strongMove ? 0.095 : 0.065;
                const washB = active
                  ? isDarkSurface ? 0.055 : 0.035
                  : isDarkSurface ? 0.022 : 0.015;
                const bgBase = active
                  ? isDarkSurface
                    ? "rgba(23, 26, 34, 0.98)"
                    : isCreamSurface
                      ? "rgba(255, 253, 247, 0.99)"
                      : "rgba(255, 255, 255, 0.99)"
                  : isDarkSurface
                    ? "rgba(13, 15, 20, 0.92)"
                    : isCreamSurface
                      ? "rgba(247, 243, 234, 0.93)"
                      : "rgba(248, 250, 253, 0.92)";

                const cardInlineStyle: React.CSSProperties = {
                  background: `linear-gradient(142deg, rgba(${rgb}, ${washA}) 0%, rgba(${rgb}, ${washB}) 56%, ${bgBase} 100%)`,
                  boxShadow: active
                    ? isDarkSurface
                      ? `0 16px 32px -10px rgba(0, 0, 0, 0.88), 0 8px 22px -12px rgba(${rgb}, 0.30), inset 0 1px 0 rgba(255, 255, 255, 0.13)`
                      : `0 14px 28px -10px rgba(15, 23, 42, 0.15), 0 6px 18px -10px rgba(${rgb}, 0.16), inset 0 1px 0 rgba(255, 255, 255, 1)`
                    : isDarkSurface
                      ? "0 4px 12px -6px rgba(0, 0, 0, 0.62), inset 0 1px 0 rgba(255, 255, 255, 0.035)"
                      : "0 4px 10px -6px rgba(15, 23, 42, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.85)",
                };

                const pctBadgeCls =
                  chg >= 3.0
                    ? "bg-emerald-700 text-white dark:bg-emerald-500 dark:text-zinc-950"
                    : chg >= 1.2
                      ? "bg-emerald-600 text-white dark:bg-emerald-500/90 dark:text-zinc-950"
                      : isUp
                        ? "bg-emerald-500/15 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300"
                        : chg <= -4.0
                          ? "bg-rose-700 text-white dark:bg-rose-500 dark:text-white"
                          : chg <= -1.5
                            ? "bg-rose-600 text-white dark:bg-rose-500/90 dark:text-white"
                            : "bg-rose-500/15 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300";

                const rsi = item.rsi_14;
                const rvol = item.rvol_20;
                const ret5d = item.change_5d_pct;
                const ret20d = item.change_20d_pct;
                const retYtd = item.change_ytd_pct;
                const dist52w = item.dist_52w_high_pct;
                const macdHist = item.macd_hist;
                const macdPrev = item.macd_prev_hist;
                const atrPct = item.atr_pct;

                // Beginner-friendly status wording that agrees with trend direction (never contradictory)
                const macdBadge =
                  macdHist == null
                    ? null
                    : macdHist >= 0
                      ? macdPrev != null && macdHist >= macdPrev
                        ? {
                            label: "多头加速上攻",
                            cls: "bg-emerald-600/15 text-emerald-800 dark:text-emerald-300",
                          }
                        : {
                            label: "偏多·涨势趋缓",
                            cls: "bg-emerald-500/[0.12] text-emerald-700 dark:text-emerald-300",
                          }
                      : macdPrev != null && macdHist > macdPrev
                        ? {
                            label: "偏空·跌势放缓",
                            cls: "bg-amber-500/[0.18] text-amber-900 dark:text-amber-300",
                          }
                        : {
                            label: "空头承压走弱",
                            cls: "bg-rose-600/15 text-rose-800 dark:text-rose-300",
                          };

                const rsiTag =
                  rsi == null
                    ? null
                    : rsi < 32
                      ? {
                          label: `RSI${rsi.toFixed(0)}·超卖`,
                          cls: "bg-amber-500/20 text-amber-900 dark:text-amber-300",
                        }
                      : rsi > 70
                        ? {
                            label: `RSI${rsi.toFixed(0)}·偏热`,
                            cls: "bg-rose-500/15 text-rose-800 dark:text-rose-300",
                          }
                        : rsi < 45
                          ? {
                              label: `RSI${rsi.toFixed(0)}·偏弱`,
                              cls: "bg-black/[0.06] text-zinc-800 dark:bg-white/[0.08] dark:text-zinc-200",
                            }
                          : {
                              label: `RSI${rsi.toFixed(0)}·健康`,
                              cls: "bg-black/[0.06] text-zinc-800 dark:bg-white/[0.08] dark:text-zinc-200",
                            };

                const rvolTag =
                  rvol == null
                    ? null
                    : rvol >= 1.25
                      ? {
                          label: `放量${rvol.toFixed(1)}x`,
                          cls: isUp
                            ? "bg-emerald-500/[0.18] text-emerald-800 dark:text-emerald-300"
                            : "bg-rose-500/[0.18] text-rose-800 dark:text-rose-300",
                        }
                      : rvol <= 0.75
                        ? {
                            label: `缩量${rvol.toFixed(1)}x`,
                            cls: "bg-black/[0.055] text-zinc-700 dark:bg-white/[0.08] dark:text-zinc-300",
                          }
                        : {
                            label: `量比${rvol.toFixed(1)}x`,
                            cls: "bg-black/[0.055] text-zinc-800 dark:bg-white/[0.08] dark:text-zinc-200",
                          };

                const titleParts = [
                  `${item.display_symbol} ${benchMetaMap[item.symbol]?.name || item.name_zh}`,
                  rvol != null ? `20日量比 ${rvol.toFixed(2)}x` : null,
                  atrPct != null ? `日均振幅 ±${atrPct.toFixed(1)}%` : null,
                  "点击切换主图",
                ].filter(Boolean);

                return (
                  <button
                    key={item.symbol}
                    type="button"
                    onClick={() => onSelectSymbol(item.symbol)}
                    title={titleParts.join(" · ")}
                    style={cardInlineStyle}
                    className={`flex h-full flex-col justify-between gap-1 rounded-2xl border-0 px-1.5 py-2 text-left outline-none transition-all duration-200 focus:outline-none 2xl:px-2.5 ${
                      active
                        ? "-translate-y-0.5 opacity-100"
                        : "opacity-85 hover:-translate-y-0.5 hover:opacity-100"
                    }`}
                  >
                    {/* Row 1: Luminous Active Dot + Clear Symbol & Title + Larger Real-Time 1D% */}
                    <div className="flex items-center justify-between gap-1">
                      <div className="flex min-w-0 items-center gap-1">
                        {active && (
                          <span
                            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                              isUp
                                ? "bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.9)]"
                                : "bg-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.9)]"
                            }`}
                            aria-hidden="true"
                          />
                        )}
                        <div className="flex min-w-0 items-baseline gap-1">
                          <span className="shrink-0 font-mono text-[14px] font-black tracking-tight text-zinc-950 dark:text-white">
                            {item.display_symbol}
                          </span>
                          <span className="truncate font-sans text-[10.5px] font-semibold tracking-tighter text-zinc-700 dark:text-zinc-300">
                            {benchMetaMap[item.symbol]?.name || item.name_zh}
                          </span>
                        </div>
                      </div>
                      <span
                        className={`shrink-0 rounded-lg px-1.5 py-0.5 font-mono text-[12px] font-extrabold leading-tight tracking-tight tabular-nums ${pctBadgeCls}`}
                      >
                        {fmtSigned(item.change_1d_pct, 2, "%")}
                      </span>
                    </div>

                    {/* Row 2: Enlarged Price + Enlarged K-Line Sparkline Filling Right Half */}
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="shrink-0 font-mono text-[20px] font-black leading-none tracking-tight tabular-nums text-zinc-950 dark:text-white sm:text-[21px]">
                        {item.last_close != null
                          ? item.symbol === "BTCUSDT"
                            ? `$${item.last_close.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                            : `$${item.last_close.toFixed(2)}`
                          : "—"}
                      </div>
                      <MiniKLineSparkline
                        bars={item.sparkline_bars}
                        prevClose={item.prev_close ?? item.last_close ?? 0}
                        isUp={isUp}
                        width={96}
                        height={36}
                        className="h-[34px] min-w-[68px] flex-1 max-w-[108px] overflow-visible"
                      />
                    </div>

                    {/* Row 2b: Session Status (Left) + Distance from 52W High 距年高 (Right) on ALL 4 cards */}
                    <div className="flex items-center justify-between gap-1 font-mono text-[9px] font-semibold leading-tight tracking-tight tabular-nums">
                      {item.extended_hours ? (
                        <span
                          className={`whitespace-nowrap rounded px-1 py-0.5 ${
                            (item.extended_hours.change_pct ?? 0) >= 0
                              ? "bg-amber-500/[0.18] text-amber-900 dark:text-amber-300"
                              : "bg-rose-500/15 text-rose-800 dark:text-rose-300"
                          }`}
                        >
                          {item.extended_hours.label_zh}
                          {item.extended_hours.change_pct != null
                            ? `${item.extended_hours.change_pct >= 0 ? "+" : ""}${item.extended_hours.change_pct.toFixed(2)}%`
                            : `$${item.extended_hours.price.toFixed(2)}`}
                        </span>
                      ) : (
                        <span className="whitespace-nowrap rounded bg-black/[0.06] px-1 py-0.5 text-zinc-700 dark:bg-white/[0.08] dark:text-zinc-300">
                          {item.symbol === "BTCUSDT" ? "7×24现货" : item.role_zh || "核心基准"}
                        </span>
                      )}
                      {dist52w != null && (
                        <span className="shrink-0 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                          距年高{dist52w >= 0 ? "+" : ""}
                          {dist52w.toFixed(1)}%
                        </span>
                      )}
                    </div>

                    {/* Row 3: Multi-Horizon Returns Strip (5日 / 20日 / 年初) */}
                    <div className="grid grid-cols-3 gap-1 rounded-xl bg-black/[0.04] px-2 py-1 font-mono text-[10px] leading-tight tabular-nums dark:bg-white/[0.055]">
                      <div>
                        <div className="text-[8.5px] text-zinc-500 dark:text-zinc-400">5日</div>
                        <div className={`font-bold ${retTone(ret5d)}`}>
                          {fmtSigned(ret5d, 1, "%")}
                        </div>
                      </div>
                      <div>
                        <div className="text-[8.5px] text-zinc-500 dark:text-zinc-400">20日</div>
                        <div className={`font-bold ${retTone(ret20d)}`}>
                          {fmtSigned(ret20d, 1, "%")}
                        </div>
                      </div>
                      <div>
                        <div className="text-[8.5px] text-zinc-500 dark:text-zinc-400">年初</div>
                        <div className={`font-bold ${retTone(retYtd)}`}>
                          {fmtSigned(retYtd, 1, "%")}
                        </div>
                      </div>
                    </div>

                    {/* Row 4: Full-Width Bottom 3-Capsule Strip (RVOL量比 + RSI + MACD Momentum) */}
                    <div className="flex items-center justify-between gap-0.5 font-sans text-[8.5px] leading-none tracking-tighter 2xl:gap-1 2xl:text-[10px]">
                      {rvolTag && (
                        <span
                          className={`shrink-0 whitespace-nowrap rounded-md px-[3px] py-1 font-semibold tabular-nums 2xl:px-1.5 ${rvolTag.cls}`}
                        >
                          {rvolTag.label}
                        </span>
                      )}
                      {rsiTag && (
                        <span
                          className={`shrink-0 whitespace-nowrap rounded-md px-[3px] py-1 font-semibold tabular-nums 2xl:px-1.5 ${rsiTag.cls}`}
                        >
                          {rsiTag.label}
                        </span>
                      )}
                      {macdBadge && (
                        <span
                          className={`min-w-0 flex-1 whitespace-nowrap rounded-md px-[3px] py-1 text-center font-semibold 2xl:px-1.5 ${macdBadge.cls}`}
                        >
                          {macdBadge.label}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            <form onSubmit={onSearchSubmit} className="flex shrink-0 flex-wrap items-center gap-2">
              <div className="relative min-w-[190px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600 dark:text-zinc-300" />
                <input
                  type="text"
                  value={tickerSearchInput}
                  onChange={(e) => onChangeSearchInput(e.target.value.toUpperCase())}
                  placeholder="输入任意美股代码切换 K 线 / 期权雷达 (如 AMD, PLTR, TSM, NVDA)..."
                  className="w-full rounded-xl border border-zinc-300 bg-white py-1.5 pl-9 pr-3 font-mono text-xs uppercase text-zinc-950 placeholder:normal-case placeholder:text-zinc-500 focus:border-zinc-950 focus:outline-none dark:border-white/15 dark:bg-white/[0.06] dark:text-white dark:placeholder:text-zinc-400"
                />
              </div>
              <button
                type="submit"
                disabled={searchingTicker || !tickerSearchInput.trim()}
                className="rounded-xl bg-zinc-950 px-3.5 py-1.5 font-mono text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-45 dark:bg-white dark:text-zinc-950"
              >
                {searchingTicker ? "拉取中..." : "调入看盘"}
              </button>
              {tickerSearchError && (
                <span className="font-mono text-xs font-medium text-rose-700 dark:text-rose-300">
                  {tickerSearchError}
                </span>
              )}
            </form>
          </SpotlightBlock>
        );
      }

      case "candlestick-main": {
        const matchedAsset =
          assetDetail?.symbol?.toUpperCase() === selectedSymbol.toUpperCase()
            ? assetDetail
            : null;
        const tech = matchedAsset?.technicals;
        const liveBench = coreBenchmarks?.find((b) => b.symbol === selectedSymbol);
        const liveWatch = watchlistItems.find((w) => w.symbol === selectedSymbol);
        const liveSectorSec = sectorHeatmap?.sectors.find((s) => s.symbol === selectedSymbol);
        const liveSectorComp = sectorHeatmap?.sectors
          .flatMap((s) => s.constituents)
          .find((c) => c.symbol === selectedSymbol);
        const headerPrice =
          liveBench?.last_close ??
          liveWatch?.price ??
          liveSectorSec?.price ??
          liveSectorComp?.price ??
          tech?.last_close ??
          null;
        const headerChg1d =
          liveBench?.change_1d_pct ??
          liveWatch?.change_1d_pct ??
          liveSectorSec?.return_1d_pct ??
          liveSectorComp?.change_1d_pct ??
          tech?.change_1d_pct ??
          null;

        const rsi = tech?.rsi_14 ?? null;
        const macdHist = tech?.macd?.histogram ?? null;
        const macdPrev = tech?.macd?.prev_histogram ?? null;
        const rvol = tech?.rvol_20 ?? null;
        const atrPct = tech?.atr_pct ?? null;
        const atr14 = tech?.atr_14 ?? null;
        const ma50Dist = tech?.dist_50ma_pct ?? null;
        const ma200Dist = tech?.dist_200ma_pct ?? null;
        const high52wDist = tech?.dist_52w_high_pct ?? null;
        const high52w = tech?.high_52w ?? null;
        const chg1d = headerChg1d ?? 0;

        const headerExt =
          liveBench?.extended_hours ??
          liveWatch?.extended_hours ??
          matchedAsset?.extended_hours ??
          null;

        const isWatched = watchlistItems.some((w) => w.symbol === selectedSymbol);
        const canWatch = !selectedSymbol.endsWith("USDT");

        const rsiStatus =
          rsi == null
            ? {
                label: "—",
                tone: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400",
              }
            : rsi < 30
              ? {
                  label: "极度超卖",
                  tone: "border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
                }
              : rsi < 45
                ? {
                    label: "偏弱磨底",
                    tone: "border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-300",
                  }
                : rsi <= 68
                  ? {
                      label: "健康多头",
                      tone: "border-emerald-500/35 bg-emerald-500/12 text-emerald-800 dark:text-emerald-300",
                    }
                  : {
                      label: "超买防回调",
                      tone: "border-rose-500/45 bg-rose-500/15 text-rose-800 dark:text-rose-300",
                    };

        const macdStatus =
          macdHist == null
            ? {
                label: "—",
                tone: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400",
              }
            : macdHist >= 0
              ? macdPrev != null && macdHist >= macdPrev
                ? {
                    label: "多头加速",
                    tone: "border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
                  }
                : {
                    label: "红柱收窄",
                    tone: "border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-300",
                  }
              : macdPrev != null && macdHist > macdPrev
                ? {
                    label: "空头减弱",
                    tone: "border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-300",
                  }
                : {
                    label: "空头走弱",
                    tone: "border-rose-500/45 bg-rose-500/15 text-rose-800 dark:text-rose-300",
                  };

        const liveTagMismatch =
          headerChg1d != null &&
          tech?.volume_price_tag != null &&
          ((headerChg1d < 0 &&
            (tech.volume_price_tag.startsWith("Volume Expansion Up") ||
              tech.volume_price_tag.startsWith("Low-Volume Drift Up"))) ||
            (headerChg1d >= 0 &&
              (tech.volume_price_tag.startsWith("Volume Expansion Down") ||
                tech.volume_price_tag.startsWith("Low-Volume Pullback"))));

        const effectiveVolumePriceTag =
          liveTagMismatch && headerChg1d != null
            ? rvol == null
              ? "Unclassified (Insufficient Volume History)"
              : headerChg1d >= 0
                ? rvol >= 1.2
                  ? "Volume Expansion Up (Accumulation / Breakout)"
                  : "Low-Volume Drift Up (Thin Conviction)"
                : rvol >= 1.2
                  ? "Volume Expansion Down (Distribution / Stress)"
                  : "Low-Volume Pullback (Orderly Digestion)"
            : tech?.volume_price_tag;

        const rvolStatus =
          rvol == null
            ? {
                label: "—",
                tone: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400",
              }
            : rvol >= 1.5
              ? chg1d >= 0
                ? {
                    label: "放量抢筹",
                    tone: "border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
                  }
                : {
                    label: "放量抛压",
                    tone: "border-rose-500/45 bg-rose-500/15 text-rose-800 dark:text-rose-300",
                  }
              : rvol >= 0.85
                ? {
                    label: "量能温和",
                    tone: "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300",
                  }
                : {
                    label: "缩量观望",
                    tone: "border-amber-500/35 bg-amber-500/12 text-amber-800 dark:text-amber-300",
                  };

        return (
          <SpotlightBlock tone="gallery" className="flex h-full flex-col p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-baseline gap-2.5">
                <span className="flex items-center gap-1.5 font-mono text-xs font-semibold text-zinc-700 dark:text-zinc-200">
                  <Activity className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                </span>
                <h2 className="font-serif text-2xl font-medium text-zinc-950 dark:text-white">
                  {selectedSymbol}
                </h2>
                <span className="font-mono text-xl font-bold tabular-nums text-zinc-950 dark:text-white">
                  {headerPrice != null
                    ? `$${headerPrice.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}`
                    : "—"}
                </span>
                <span className={`font-mono text-xs font-bold tabular-nums ${deltaTone(headerChg1d)}`}>
                  {fmtSigned(headerChg1d, 2, "%")}
                </span>
                {headerExt && (
                  <span
                    className={`rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] font-semibold ${
                      (headerExt.change_pct ?? 0) >= 0
                        ? "border-amber-500/40 bg-amber-500/12 text-amber-900 dark:text-amber-200"
                        : "border-rose-500/40 bg-rose-500/12 text-rose-800 dark:text-rose-200"
                    }`}
                  >
                    {headerExt.label_zh} ${headerExt.price.toFixed(2)}
                    {headerExt.change_pct != null
                      ? ` (${headerExt.change_pct >= 0 ? "+" : ""}${headerExt.change_pct.toFixed(2)}%)`
                      : ""}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <span className="hidden rounded-md border border-zinc-200 bg-zinc-100 px-2 py-1 font-mono text-[10.5px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 xl:inline-block">
                  {formatVolumePriceTag(effectiveVolumePriceTag)}
                </span>
                {canWatch && (
                  <button
                    type="button"
                    disabled={watchlistMutating}
                    onClick={() => {
                      if (isWatched) {
                        void onRemoveWatchlist(selectedSymbol);
                      } else {
                        void onAddWatchlist(selectedSymbol);
                      }
                    }}
                    title={isWatched ? "点击移出右侧关注列表" : "一键加入右侧关注列表"}
                    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-xs font-semibold transition ${
                      isWatched
                        ? "border-amber-500/60 bg-amber-500/15 text-amber-900 hover:bg-amber-500/25 dark:border-amber-400/60 dark:bg-amber-400/20 dark:text-amber-200"
                        : "border-zinc-300 bg-zinc-100 text-zinc-800 hover:border-zinc-950 hover:text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-white/50 dark:hover:text-white"
                    }`}
                  >
                    <Star
                      className={`h-3 w-3 ${
                        isWatched ? "fill-amber-500 text-amber-500 dark:fill-amber-300 dark:text-amber-300" : ""
                      }`}
                    />
                    {isWatched ? "已关注" : "加关注"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onOpenStockDetail(selectedSymbol)}
                  className="inline-flex items-center gap-1 rounded-full bg-zinc-950 px-2.5 py-1 font-mono text-xs font-semibold text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                >
                  个股页 <ArrowRight className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={onOpenAiDrawer}
                  className="inline-flex items-center gap-1 rounded-full border border-emerald-600/45 bg-emerald-500/12 px-2.5 py-1 font-mono text-xs font-medium text-emerald-800 transition hover:bg-emerald-500/20 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-300 dark:hover:bg-emerald-500/25"
                >
                  <Sparkles className="h-3 w-3" />
                  AI 协查
                </button>
              </div>
            </div>

            {/* Intuitive Diagnostic Technical Cards */}
            <div className="my-2.5 grid grid-cols-3 gap-1.5 font-mono text-xs tabular-nums sm:grid-cols-6">
              <div
                title="RSI(14) 相对强弱指标：低于30属于超跌买点区，高于70属于过热超买区"
                className="rounded-lg border border-zinc-200/90 bg-zinc-50/90 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-950/75"
              >
                <div className="flex items-center justify-between text-[10px] text-zinc-600 dark:text-zinc-400">
                  <span>RSI(14)</span>
                  <strong className="text-xs text-zinc-950 dark:text-white">{fmtNum(rsi, 1)}</strong>
                </div>
                <span
                  className={`mt-1 inline-block rounded border px-1.5 py-0.5 font-sans text-[9.5px] font-semibold ${rsiStatus.tone}`}
                >
                  {rsiStatus.label}
                </span>
              </div>

              <div
                title="MACD 柱状动量：对比前一日斜率，红柱放大=买盘增强，绿柱缩短=跌势减缓"
                className="rounded-lg border border-zinc-200/90 bg-zinc-50/90 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-950/75"
              >
                <div className="flex items-center justify-between text-[10px] text-zinc-600 dark:text-zinc-400">
                  <span>MACD</span>
                  <strong className={`text-xs ${deltaTone(macdHist)}`}>
                    {fmtSigned(macdHist, 2)}
                  </strong>
                </div>
                <span
                  className={`mt-1 inline-block rounded border px-1.5 py-0.5 font-sans text-[9.5px] font-semibold ${macdStatus.tone}`}
                >
                  {macdStatus.label}
                </span>
              </div>

              <div
                title="RVOL 相对成交量：现量与过去20日均量对比，>1.5倍表示大资金明显异动"
                className="rounded-lg border border-zinc-200/90 bg-zinc-50/90 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-950/75"
              >
                <div className="flex items-center justify-between gap-1 text-[10px] text-zinc-600 dark:text-zinc-400">
                  <span className="whitespace-nowrap">量比</span>
                  <strong className="text-xs text-zinc-950 dark:text-white">{fmtNum(rvol, 2, "x")}</strong>
                </div>
                <span
                  className={`mt-1 inline-block whitespace-nowrap rounded border px-1.5 py-0.5 font-sans text-[9.5px] font-semibold ${rvolStatus.tone}`}
                >
                  {rvolStatus.label}
                </span>
              </div>

              <div
                title="ATR 日均波幅：估算该标的每天正常上下振幅，设置止损时建议高于1倍ATR"
                className="rounded-lg border border-zinc-200/90 bg-zinc-50/90 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-950/75"
              >
                <div className="flex items-center justify-between gap-1 text-[10px] text-zinc-600 dark:text-zinc-400">
                  <span className="whitespace-nowrap">日波幅</span>
                  <strong className="text-xs text-zinc-950 dark:text-white">{fmtNum(atrPct, 2, "%")}</strong>
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-zinc-700 dark:text-zinc-300">
                  {atr14 != null ? `约 ±$${atr14.toFixed(1)}/天` : "正常波动"}
                </div>
              </div>

              <div
                title="50日/200日均线位置：正数=站在趋势生命线之上，负数=仍处于均线下方压制"
                className="rounded-lg border border-zinc-200/90 bg-zinc-50/90 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-950/75"
              >
                <div className="flex items-center justify-between gap-1 text-[10px] text-zinc-600 dark:text-zinc-400">
                  <span className="whitespace-nowrap">50MA</span>
                  <strong className={`text-xs ${deltaTone(ma50Dist)}`}>
                    {fmtSigned(ma50Dist, 1, "%")}
                  </strong>
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-zinc-700 dark:text-zinc-300">
                  200MA{" "}
                  <span className={deltaTone(ma200Dist)}>
                    {fmtSigned(ma200Dist, 1, "%")}
                  </span>
                </div>
              </div>

              <div
                title="距离过去52周（约1年）最高点的回撤空间与年高参考位"
                className="rounded-lg border border-zinc-200/90 bg-zinc-50/90 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-950/75"
              >
                <div className="flex items-center justify-between gap-1 text-[10px] text-zinc-600 dark:text-zinc-400">
                  <span className="whitespace-nowrap">距年高</span>
                  <strong
                    className={`text-xs ${
                      high52wDist != null && high52wDist <= -15
                        ? "text-rose-700 dark:text-rose-400"
                        : high52wDist != null && high52wDist >= -3
                          ? "text-emerald-700 dark:text-emerald-400"
                          : "text-amber-700 dark:text-amber-300"
                    }`}
                  >
                    {fmtSigned(high52wDist, 1, "%")}
                  </strong>
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-zinc-700 dark:text-zinc-300">
                  {high52w != null ? `年高 $${high52w.toFixed(0)}` : "52W High"}
                </div>
              </div>
            </div>

            {/* Wall Street Consensus Strip (Rating + Target Price Upside + Last 4Q EPS Beats) */}
            {(() => {
              const latestRec = matchedAsset?.recommendations?.[0] ?? null;
              const recBulls = latestRec ? latestRec.strong_buy + latestRec.buy : 0;
              const recHold = latestRec?.hold ?? 0;
              const recBears = latestRec ? latestRec.sell + latestRec.strong_sell : 0;
              const recTotal = recBulls + recHold + recBears;
              const bullPct = recTotal > 0 ? Math.round((recBulls / recTotal) * 100) : null;
              const holdPct = recTotal > 0 ? Math.round((recHold / recTotal) * 100) : 0;
              const bearPct = recTotal > 0 ? Math.max(0, 100 - (bullPct ?? 0) - holdPct) : 0;

              const pt = matchedAsset?.price_target ?? null;
              const ptVal = pt?.target_consensus ?? pt?.target_median ?? null;
              const ptUpside =
                ptVal != null && headerPrice != null && headerPrice > 0
                  ? ((ptVal / headerPrice) - 1) * 100
                  : null;

              const epsList = [...(matchedAsset?.eps_history ?? [])].slice(0, 4).reverse();

              if (!latestRec && ptVal == null && epsList.length === 0) {
                return null;
              }

              return (
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-200/90 bg-zinc-50/90 px-2.5 py-1.5 font-mono text-[10.5px] dark:border-zinc-800/90 dark:bg-zinc-950/70">
                  {latestRec && recTotal > 0 && (
                    <div
                      title={`买方 ${recBulls} 家（强买 ${latestRec.strong_buy} / 买 ${latestRec.buy}）· 持有 ${recHold} · 卖出 ${recBears}`}
                      className="flex items-center gap-2"
                    >
                      <span className="font-sans text-[10px] text-zinc-600 dark:text-zinc-400">华尔街评级</span>
                      <span className="font-bold text-emerald-700 dark:text-emerald-400">买入 {bullPct}%</span>
                      <div className="flex h-1.5 w-16 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                        <div className="bg-emerald-500" style={{ width: `${bullPct}%` }} />
                        <div className="bg-amber-400" style={{ width: `${holdPct}%` }} />
                        <div className="bg-rose-500" style={{ width: `${bearPct}%` }} />
                      </div>
                    </div>
                  )}

                  {ptVal != null && (
                    <div
                      title={
                        pt?.target_low && pt?.target_high
                          ? `华尔街一致目标区间 $${pt.target_low.toFixed(0)} – $${pt.target_high.toFixed(0)}`
                          : "华尔街一致目标价"
                      }
                      className="flex items-center gap-1.5"
                    >
                      <span className="font-sans text-[10px] text-zinc-600 dark:text-zinc-400">一致目标</span>
                      <span className="font-bold text-zinc-950 dark:text-white tabular-nums">${ptVal.toFixed(1)}</span>
                      {ptUpside != null && (
                        <span
                          className={`rounded px-1.5 py-0.5 text-[9.5px] font-bold ${
                            ptUpside >= 0
                              ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
                              : "bg-rose-500/15 text-rose-800 dark:text-rose-300"
                          }`}
                        >
                          {ptUpside >= 0 ? `+${ptUpside.toFixed(1)}%` : `${ptUpside.toFixed(1)}%`}
                        </span>
                      )}
                    </div>
                  )}

                  {epsList.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="font-sans text-[10px] text-zinc-600 dark:text-zinc-400">近4季EPS</span>
                      {epsList.map((ep, idx) => {
                        const surp = ep.surprise_percent;
                        const beat = surp != null ? surp >= 0 : (ep.actual ?? 0) >= (ep.estimate ?? 0);
                        return (
                          <span
                            key={`${ep.period}-${idx}`}
                            title={`${ep.period}: 实际 ${ep.actual != null ? `$${ep.actual.toFixed(2)}` : "—"} vs 预期 ${ep.estimate != null ? `$${ep.estimate.toFixed(2)}` : "—"}`}
                            className={`rounded px-1.5 py-0.5 text-[9.5px] font-semibold tabular-nums ${
                              beat
                                ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
                                : "bg-rose-500/15 text-rose-800 dark:text-rose-300"
                            }`}
                          >
                            {surp != null
                              ? `${beat ? "✓" : "✕"}${surp >= 0 ? "+" : ""}${surp.toFixed(1)}%`
                              : ep.period.slice(2, 7)}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            <div className="flex min-h-0 flex-1 flex-col">
              {assetLoading && !matchedAsset ? (
                <div className="flex min-h-[180px] flex-1 items-center justify-center rounded-xl border border-zinc-200 font-mono text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-200">
                  正在加载 {selectedSymbol} K 线与筹码数据...
                </div>
              ) : (
                <AssetCandlestickChart
                  theme={theme}
                  symbol={selectedSymbol}
                  bars={matchedAsset?.bars ?? []}
                  gex={matchedAsset?.options_gex}
                  fillContainer
                />
              )}
            </div>
          </SpotlightBlock>
        );
      }

      case "watchlist-panel":
        return (
          <WatchlistCardPanel
            items={watchlistItems}
            loading={watchlistLoading}
            mutating={watchlistMutating}
            error={watchlistError}
            selectedSymbol={selectedSymbol}
            onSelectSymbol={onSelectSymbol}
            onAddSymbol={onAddWatchlist}
            onReorderSymbols={onReorderWatchlist}
            onRemoveSymbol={onRemoveWatchlist}
            onOpenStockDetail={onOpenStockDetail}
            onOpenMyWatchlist={onOpenMyWatchlist}
          />
        );

      case "catalyst-radar":
        return (
          <CatalystRadarModule
            watchlistSymbols={watchlistSymbols}
            onSelectSymbol={onSelectSymbol}
          />
        );

      case "market-movers":
        return (
          <MarketMoversModule
            data={marketMovers ?? null}
            selectedSymbol={selectedSymbol}
            onSelectSymbol={onSelectSymbol}
            onRefresh={onRefreshMovers}
            minPrice={moversMinPrice}
            onToggleMinPrice={onToggleMoversMinPrice}
          />
        );

      case "sentiment-breadth": {
        const ma50 = overview?.equities?.breadth.pct_above_50ma ?? null;
        const ma200 = overview?.equities?.breadth.pct_above_200ma ?? null;
        const rspDelta = overview?.equities?.breadth.rsp_spy_20d_delta_pct ?? null;
        const putCallRaw = activeFgRawValues["put_call"] ?? null;
        const safeHavenRaw = activeFgRawValues["safe_haven"] ?? null;

        const ma50Tone =
          ma50 == null
            ? "bg-zinc-400"
            : ma50 < 25
              ? "bg-red-500"
              : ma50 >= 70
                ? "bg-amber-500"
                : "bg-emerald-500";
        const ma200Tone =
          ma200 == null ? "bg-zinc-400" : ma200 < 40 ? "bg-rose-500" : "bg-emerald-500";

        const vixMiniBars = activeVixBars.slice(-24).map((b, idx) => ({
          t: idx,
          o: b.open,
          h: b.high,
          l: b.low,
          c: b.close,
        }));
        const vixPrevClose =
          sentimentPulse?.vix?.prev_close ?? activeVixSpot ?? 20;
        const isVixRising = (activeVixChangeAbs ?? 0) >= 0;
        const vixScalePct =
          activeVixSpot != null
            ? Math.max(2, Math.min(98, ((activeVixSpot - 10) / 35) * 100))
            : 30;
        const vixZoneMeta =
          activeVixSpot == null
            ? { text: "等待同步", cls: "text-zinc-500 dark:text-zinc-400" }
            : activeVixSpot >= 30
              ? { text: "高危踩踏区 (≥30)", cls: "text-rose-600 dark:text-rose-400" }
              : activeVixSpot >= 20
                ? { text: "警戒升温 (20-30)", cls: "text-amber-700 dark:text-amber-300" }
                : { text: "低波常态 (<20)", cls: "text-emerald-700 dark:text-emerald-400" };

        const resonanceText =
          activeFgScore != null && activeFgScore < 25 && (ma50 ?? 50) >= 35
            ? `CNN ${activeFgScore.toFixed(0)} 极度恐慌但 50日线广度 (${fmtNum(ma50, 0, "%")}) 未崩盘 · 局部结构杀跌，盯紧超卖反弹`
            : activeFgScore != null && activeFgScore < 25
              ? `情绪与广度双重冰点（CNN ${activeFgScore.toFixed(0)} · 50日线 ${fmtNum(ma50, 0, "%")}）· 极端超卖区域`
              : activeFgScore != null && activeFgScore >= 70
                ? `CNN ${activeFgScore.toFixed(0)} 偏贪婪 · 留意低 VIX 突发性回踩风险`
                : `CNN ${activeFgScore != null ? activeFgScore.toFixed(0) : "—"} · VIX ${activeVixSpot != null ? activeVixSpot.toFixed(1) : "—"} · 市场情绪处于正常切换区`;

        const sentimentHeaderBadge =
          activeFgScore == null
            ? { label: "情绪同步中", cls: "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-white/15 dark:bg-white/10 dark:text-zinc-300" }
            : activeFgScore < 25
              ? { label: "极度恐惧", cls: "border-rose-500/45 bg-rose-500/15 text-rose-700 dark:border-rose-400/50 dark:bg-rose-500/20 dark:text-rose-300" }
              : activeFgScore < 45
                ? { label: "市场恐慌", cls: "border-amber-500/45 bg-amber-500/15 text-amber-800 dark:border-amber-400/50 dark:bg-amber-500/20 dark:text-amber-300" }
                : activeFgScore <= 55
                  ? { label: "情绪中性", cls: "border-zinc-300 bg-zinc-100 text-zinc-800 dark:border-white/15 dark:bg-white/10 dark:text-zinc-200" }
                  : activeFgScore < 75
                    ? { label: "偏向乐观", cls: "border-emerald-500/45 bg-emerald-500/15 text-emerald-700 dark:border-emerald-400/50 dark:bg-emerald-500/20 dark:text-emerald-300" }
                    : { label: "极度贪婪", cls: "border-rose-500/45 bg-rose-500/15 text-rose-700 dark:border-rose-400/50 dark:bg-rose-500/20 dark:text-rose-300" };

        return (
          <SpotlightBlock
            tone="gallery"
            className="flex h-full flex-col justify-between gap-1.5 overflow-hidden p-3"
          >
            {/* Module Title + Prominent Colored Sentiment State */}
            <div className="flex shrink-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-sans text-[14px] font-bold tracking-tight text-zinc-950 dark:text-white">
                  恐慌情绪与市场广度
                </span>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 font-sans text-[12px] font-extrabold tracking-tight ${sentimentHeaderBadge.cls}`}
                >
                  {sentimentHeaderBadge.label}
                </span>
              </div>
              <span className="shrink-0 font-mono text-[10px] font-medium text-zinc-600 dark:text-zinc-300">
                {activeFgSource === "cnn_live" ? "CNN实时·含盘前" : overview?.regime_date ?? ""}
              </span>
            </div>

            {/* Hero Split: Left Compact CNN Gauge | Right Compact VIX Mini K-Line Thermometer Card */}
            <div className="grid shrink-0 grid-cols-2 gap-2">
              <CnnFearGreedGauge
                compact
                score={activeFgScore}
                rating={activeFgRating}
                previousClose={liveFearGreed?.previous_close}
                previous1Week={liveFearGreed?.previous_1_week}
                previous1Month={liveFearGreed?.previous_1_month}
                source={activeFgSource}
              />

              <div className="flex h-full flex-col justify-between rounded-xl border border-zinc-200/90 bg-white/85 p-2 dark:border-white/15 dark:bg-white/[0.04]">
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate font-sans text-[11px] font-bold text-zinc-900 dark:text-zinc-100">
                    VIX 波动率
                  </span>
                  {activeVixPeak != null && (
                    <span
                      title={activeVixPeakDate ? `近4月峰值日 ${activeVixPeakDate}` : "近4月峰值"}
                      className={`shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9px] font-semibold ${
                        activeVixPeak >= 35
                          ? "border-red-500/40 bg-red-500/12 text-red-700 dark:text-red-300"
                          : "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-white/15 dark:bg-white/10 dark:text-zinc-300"
                      }`}
                    >
                      峰 {activeVixPeak.toFixed(1)}
                    </span>
                  )}
                </div>

                {/* VIX Spot Price & % Inline Top Row */}
                <div className="flex items-baseline justify-between gap-1.5 pt-0.5">
                  <div
                    className={`font-mono text-[20px] font-extrabold leading-none tabular-nums ${
                      (activeVixSpot ?? 0) >= 28
                        ? "text-red-600 dark:text-red-400"
                        : "text-zinc-950 dark:text-white"
                    }`}
                  >
                    {activeVixSpot != null ? activeVixSpot.toFixed(2) : "—"}
                  </div>
                  {activeVixChangePct != null && (
                    <span
                      className={`font-mono text-[10.5px] font-bold tabular-nums ${
                        isVixRising
                          ? "text-red-600 dark:text-red-400"
                          : "text-emerald-700 dark:text-emerald-400"
                      }`}
                    >
                      {activeVixChangePct >= 0
                        ? `↗ +${activeVixChangePct.toFixed(1)}%`
                        : `↘ ${activeVixChangePct.toFixed(1)}%`}
                    </span>
                  )}
                </div>

                {/* Full-Width Proportional Borderless VIX K-Line Micro Chart */}
                <div className="my-1 flex w-full items-center justify-center">
                  <MiniKLineSparkline
                    bars={vixMiniBars}
                    prevClose={vixPrevClose}
                    isUp={!isVixRising}
                    width={168}
                    height={52}
                  />
                </div>

                {/* VIX Regime Temperature Scale (10 -> 45) */}
                <div>
                  <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-gradient-to-r from-emerald-500 via-amber-400 to-rose-600">
                    <div
                      className="absolute top-1/2 h-2.5 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-zinc-950 shadow"
                      style={{ left: `${vixScalePct}%` }}
                    />
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-1 font-sans text-[9px] font-semibold">
                    <span className={`truncate ${vixZoneMeta.cls}`}>{vixZoneMeta.text}</span>
                    <span className="shrink-0 font-mono text-[8.5px] text-zinc-500 dark:text-zinc-400">
                      20警戒 / 30高危
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* 2x2 Breadth & Hedging Matrix */}
            <div className="grid shrink-0 grid-cols-2 gap-1.5 font-mono">
              <div className="rounded-lg border border-zinc-200/90 bg-white/85 px-2 py-1 dark:border-white/15 dark:bg-white/[0.05]">
                <div className="flex items-center justify-between text-[10px] font-sans text-zinc-600 dark:text-zinc-300">
                  <span>标普站上50日线</span>
                  <span className="font-mono font-bold text-zinc-950 dark:text-white">
                    {fmtNum(ma50, 1, "%")}
                  </span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-white/10">
                  <div
                    className={`h-full rounded-full ${ma50Tone}`}
                    style={{ width: `${Math.min(100, Math.max(4, ma50 ?? 0))}%` }}
                  />
                </div>
              </div>

              <div className="rounded-lg border border-zinc-200/90 bg-white/85 px-2 py-1 dark:border-white/15 dark:bg-white/[0.05]">
                <div className="flex items-center justify-between text-[10px] font-sans text-zinc-600 dark:text-zinc-300">
                  <span>标普站上200日线</span>
                  <span className="font-mono font-bold text-zinc-950 dark:text-white">
                    {fmtNum(ma200, 1, "%")}
                  </span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-white/10">
                  <div
                    className={`h-full rounded-full ${ma200Tone}`}
                    style={{ width: `${Math.min(100, Math.max(4, ma200 ?? 0))}%` }}
                  />
                </div>
              </div>

              <div
                title="等权标普RSP vs 市值加权SPY 近20日相对涨跌：正数代表中小盘和板块广度扩散良好"
                className="flex items-center justify-between gap-1 rounded-lg border border-zinc-200/90 bg-white/85 px-2 py-1 dark:border-white/15 dark:bg-white/[0.05]"
              >
                <span className="truncate font-sans text-[10px] text-zinc-600 dark:text-zinc-300">
                  小盘 vs 巨头
                </span>
                <span className={`shrink-0 text-[11px] font-bold tabular-nums ${deltaTone(rspDelta)}`}>
                  {fmtSigned(rspDelta, 2, "%")}
                </span>
              </div>

              <div
                title="CBOE 看跌/看涨期权成交比及股债避险偏离度"
                className="flex items-center justify-between gap-1 rounded-lg border border-zinc-200/90 bg-white/85 px-2 py-1 dark:border-white/15 dark:bg-white/[0.05]"
              >
                <span className="truncate font-sans text-[10px] text-zinc-600 dark:text-zinc-300">
                  {putCallRaw != null ? "看跌/看涨比" : "股债避险流"}
                </span>
                <span className="flex shrink-0 items-baseline gap-1 text-[11px] font-bold tabular-nums text-zinc-950 dark:text-white">
                  <span>{putCallRaw != null ? putCallRaw.toFixed(2) : "—"}</span>
                  {safeHavenRaw != null && (
                    <span
                      className={`text-[9.5px] font-semibold ${
                        safeHavenRaw < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"
                      }`}
                    >
                      {safeHavenRaw >= 0 ? `+${safeHavenRaw.toFixed(1)}%` : `${safeHavenRaw.toFixed(1)}%`}
                    </span>
                  )}
                </span>
              </div>
            </div>

            {/* Synthesized Fear + Breadth Resonance Takeaway */}
            <div className="shrink-0 line-clamp-2 rounded-lg border border-zinc-200/90 bg-zinc-100/80 px-2.5 py-1.5 font-sans text-[10.5px] font-medium leading-snug text-zinc-800 dark:border-white/10 dark:bg-white/[0.05] dark:text-zinc-200">
              {resonanceText}
            </div>
          </SpotlightBlock>
        );
      }

      case "gex-wall":
        return (
          <OptionsRadarModule
            theme={chartTheme}
            data={optionsRadar ?? null}
            loading={optionsLoading}
            targetSymbol={optionsTargetSymbol}
            followMainChart={optionsFollowMain}
            mainSymbol={selectedSymbol}
            bucket={optionsBucket}
            onSelectPresetSymbol={onSelectOptionsPreset}
            onToggleFollowMain={onToggleOptionsFollowMain}
            onChangeBucket={onChangeOptionsBucket}
          />
        );

      case "sector-rotation":
        return (
          <SectorHeatmapModule
            data={sectorHeatmap ?? null}
            selectedSymbol={selectedSymbol}
            onSelectSymbol={onSelectSymbol}
          />
        );

      case "discover-news":
        return (
          <DiscoverNewsShelf
            items={discoverNews}
            loading={discoverLoading}
            error={discoverError}
            onRefresh={onRefreshDiscover}
          />
        );

      case "moc-auction-radar":
        return (
          <MocAuctionModule
            theme={chartTheme}
            data={mocData ?? null}
            loading={mocLoading}
            targetSymbol={mocSymbol}
            onSelectSymbol={onSelectMocSymbol}
          />
        );

      case "darkpool-trf-tracker":
        return (
          <DarkPoolModule
            theme={chartTheme}
            data={darkPoolData ?? null}
            loading={darkPoolLoading}
            targetSymbol={darkPoolTargetSymbol}
            followMainChart={darkPoolFollowMain}
            mainSymbol={selectedSymbol}
            onToggleFollowMain={onToggleDarkPoolFollowMain}
            onSelectSymbol={onSelectDarkPoolSymbol}
          />
        );

      case "onchain-liquidity-pulse":
        return (
          <OnChainPulseModule
            theme={chartTheme}
            data={onChainData ?? null}
            loading={onChainLoading}
          />
        );
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE_EXPO }}
      className="space-y-3.5"
    >
      <AnimatePresence>
        {editMode && (
          <LayoutEditorBar
            layoutState={layoutState}
            onToggleWidget={onToggleWidget}
            onApplyPreset={onApplyPreset}
            onResetDefault={onResetLayout}
            onImportState={onImportLayout}
            onDone={onCloseEditMode}
          />
        )}
      </AnimatePresence>

      {visibleItems.length === 0 ? (
        <SpotlightBlock tone="gallery" className="p-10 text-center">
          <LayoutGrid className="mx-auto h-8 w-8 text-emerald-500" />
          <h2 className="mt-3 font-sans text-lg font-bold text-zinc-950 dark:text-white">
            当前主页所有板块均已隐藏
          </h2>
          <p className="mt-1 font-sans text-xs text-zinc-600 dark:text-zinc-300">
            你可以打开右上角排版开关恢复任意单个模块，或一键重置回经典全景 14 大模块布局。
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {!editMode && (
              <button
                type="button"
                onClick={onOpenEditMode}
                className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-4 py-2 font-sans text-xs font-semibold text-zinc-900 dark:border-white/15 dark:bg-white/10 dark:text-white"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                打开模块管理器
              </button>
            )}
            <button
              type="button"
              onClick={onResetLayout}
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-4 py-2 font-sans text-xs font-bold text-white shadow-sm hover:bg-emerald-500"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              恢复全部默认板块
            </button>
          </div>
        </SpotlightBlock>
      ) : (
        <div
          ref={containerRef as React.RefObject<HTMLDivElement>}
          className={`me-bento-grid w-full ${editMode ? "me-grid-editing" : ""}`}
        >
          {mounted && (
            <ResponsiveGridLayout
              width={width}
              layouts={responsiveLayouts}
              breakpoints={GRID_BREAKPOINTS}
              cols={GRID_COLS}
              rowHeight={GRID_ROW_HEIGHT}
              margin={GRID_MARGIN}
              containerPadding={[0, 0]}
              compactor={verticalCompactor}
              dragConfig={{
                enabled: canManipulateGrid,
                handle: ".me-grid-drag-handle",
                cancel: ".me-grid-no-drag",
                threshold: 4,
              }}
              resizeConfig={{
                enabled: canManipulateGrid,
                handles: ["se"],
              }}
              onBreakpointChange={(nextBp) => {
                if (nextBp === "lg" || nextBp === "md" || nextBp === "sm") {
                  breakpointRef.current = nextBp;
                  setActiveBreakpoint(nextBp);
                }
              }}
              onLayoutChange={(currentLayout) => {
                // Only commit canonical 12-col layout geometry updates at desktop `lg`
                if (
                  canManipulateGrid &&
                  width >= GRID_BREAKPOINTS.lg &&
                  currentBreakpoint === "lg" &&
                  breakpointRef.current === "lg"
                ) {
                  onUpdateLayoutItems(currentLayout);
                }
              }}
            >
              {visibleItems.map((item, idx) => {
                const wid = item.i as WidgetId;
                const meta = WIDGET_META_MAP[wid];
                if (!meta) return null;
                return (
                  <div key={wid} className="h-full w-full">
                    <motion.div
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: 0.38,
                        delay: Math.min(0.28, idx * 0.028),
                        ease: EASE_EXPO,
                      }}
                      className="h-full w-full"
                    >
                      <GridWidgetFrame
                        widgetId={wid}
                        editMode={editMode}
                        gridColsWidth={item.w}
                        gridRowsHeight={item.h}
                        onHide={onToggleWidget}
                      >
                        {renderWidgetBody(wid)}
                      </GridWidgetFrame>
                    </motion.div>
                  </div>
                );
              })}
            </ResponsiveGridLayout>
          )}
        </div>
      )}
    </motion.div>
  );
}

export default React.memo(OverviewBentoGrid);

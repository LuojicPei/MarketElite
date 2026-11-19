"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  BarChart3,
  Calendar,
  Cpu,
  Database,
  Layers,
  Newspaper,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import StatusConsole from "@/components/StatusConsole";
import InvestigatorDrawer from "@/components/InvestigatorDrawer";
import AssetCandlestickChart from "@/components/charts/AssetCandlestickChart";
import CorrelationHeatmapChart from "@/components/charts/CorrelationHeatmapChart";
import GexProfileChart from "@/components/charts/GexProfileChart";
import NetLiquidityChart from "@/components/charts/NetLiquidityChart";
import {
  AssetDetailResponse,
  DashboardOverviewResponse,
  TrackedAssetSummary,
  fetchAssetDetail,
  fetchDashboardOverview,
  fetchTrackedAssets,
  triggerPipelineSync,
} from "@/lib/api";

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
  const inB = val / 1e9;
  return `${inB >= 0 ? "+" : ""}$${inB.toFixed(2)}B`;
}

function deltaTone(val: number | null | undefined, dark = false): string {
  if (val === null || val === undefined) return dark ? "text-zinc-400" : "text-zinc-500";
  if (val > 0) return dark ? "text-emerald-400" : "text-emerald-600";
  if (val < 0) return dark ? "text-rose-400" : "text-rose-600";
  return dark ? "text-zinc-300" : "text-zinc-600";
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
  const [viewMode, setViewMode] = useState<"cockpit" | "infra">("cockpit");
  const [overview, setOverview] = useState<DashboardOverviewResponse | null>(null);
  const [trackedAssets, setTrackedAssets] = useState<TrackedAssetSummary[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<string>("SPY");
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
      const [ov, list] = await Promise.all([
        fetchDashboardOverview(),
        fetchTrackedAssets().catch(() => ({ count: 0, assets: [] })),
      ]);
      setOverview(ov);
      setTrackedAssets(list.assets);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed loading MarketElite cockpit");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAsset = useCallback(async (symbol: string) => {
    setAssetLoading(true);
    try {
      const detail = await fetchAssetDetail(symbol, 220, true);
      setAssetDetail(detail);
    } catch {
      setAssetDetail(null);
    } finally {
      setAssetLoading(false);
    }
  }, []);

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

  const quickTape = useMemo(() => {
    const priority = ["SPY", "QQQ", "SOXX", "IWM", "RSP", "BTCUSDT", "GLD", "TLT"];
    const bySym = new Map(trackedAssets.map((a) => [a.symbol, a]));
    return priority
      .map((s) => bySym.get(s))
      .filter((x): x is TrackedAssetSummary => Boolean(x));
  }, [trackedAssets]);

  const filteredCalendar = useMemo(() => {
    const events = overview?.positioning_and_calendar?.upcoming_events ?? [];
    if (calendarFilter === "all") return events;
    return events.filter((ev) => ev.event_type === calendarFilter);
  }, [overview, calendarFilter]);

  const activeGex = overview?.options_gex?.[gexSymbol] ?? null;

  if (viewMode === "infra") {
    return (
      <div className="min-h-screen">
        <div className="sticky top-0 z-40 border-b border-zinc-200/80 bg-white/80 backdrop-blur-md">
          <div className="mx-auto flex max-w-[1460px] items-center justify-between px-4 py-2.5 sm:px-6">
            <div className="flex items-center gap-3">
              <span className="font-serif text-xl italic tracking-tight text-zinc-950">
                MarketElite
              </span>
              <span className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                Infrastructure Console · 基础设施
              </span>
            </div>
            <div className="flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-100 p-0.5 font-mono text-[11px]">
              <button
                type="button"
                onClick={() => setViewMode("cockpit")}
                className="rounded-full px-3 py-1 text-zinc-600 transition hover:text-zinc-950"
              >
                5-Layer Cockpit 驾驶舱
              </button>
              <button
                type="button"
                onClick={() => setViewMode("infra")}
                className="rounded-full bg-zinc-950 px-3 py-1 text-white"
              >
                Infra 拓扑
              </button>
            </div>
          </div>
        </div>
        <StatusConsole />
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-24">
      {/* Top Sticky Architectural Rail */}
      <header className="sticky top-0 z-40 border-b border-zinc-200/80 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1460px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="pulse-ring absolute inline-flex h-full w-full rounded-full bg-emerald-500" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <span className="font-serif text-xl italic tracking-tight text-zinc-950">
                MarketElite
              </span>
            </div>
            <span className="hidden rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-mono text-[10px] tracking-wider text-zinc-500 md:inline-block">
              美股结构与风险终端 · US Equity Terminal
            </span>
          </div>

          {/* Interactive Live Tape Strip */}
          <div className="hidden items-center gap-1.5 overflow-x-auto xl:flex">
            {quickTape.map((item) => {
              const active = selectedSymbol === item.symbol;
              return (
                <button
                  key={item.symbol}
                  type="button"
                  onClick={() => setSelectedSymbol(item.symbol)}
                  className={`flex items-center gap-2 rounded-lg border px-2.5 py-1 font-mono text-[11px] tabular-nums transition ${
                    active
                      ? "border-zinc-950 bg-zinc-950 text-white"
                      : "border-zinc-200/90 bg-white text-zinc-800 hover:border-zinc-400"
                  }`}
                >
                  <span className="font-semibold">{item.symbol}</span>
                  <span>
                    {item.symbol === "BTCUSDT"
                      ? `$${item.close.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                      : `$${item.close.toFixed(2)}`}
                  </span>
                  <span
                    className={
                      active
                        ? deltaTone(item.change_1d_pct, true)
                        : deltaTone(item.change_1d_pct, false)
                    }
                  >
                    {fmtSigned(item.change_1d_pct, 2, "%")}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2">
            {overview?.cache_source && (
              <span className="hidden items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 font-mono text-[10px] text-zinc-600 sm:inline-flex">
                <Database className="h-3 w-3 text-zinc-500" />
                {overview.cache_source === "redis" ? "Redis Hot <50ms" : overview.cache_source}
              </span>
            )}

            <button
              type="button"
              onClick={handleManualSync}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1 font-mono text-[11px] text-zinc-800 transition hover:border-zinc-950 disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "同步中 Syncing..." : "同步 Sync"}
            </button>

            <div className="flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-100 p-0.5 font-mono text-[11px]">
              <button
                type="button"
                onClick={() => setViewMode("cockpit")}
                className="rounded-full bg-zinc-950 px-3 py-1 text-white"
              >
                驾驶舱 Cockpit
              </button>
              <button
                type="button"
                onClick={() => setViewMode("infra")}
                className="rounded-full px-3 py-1 text-zinc-600 transition hover:text-zinc-950"
              >
                Infra
              </button>
            </div>
          </div>
        </div>
      </header>

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
              <SpotlightBlock tone="obsidian" className="flex flex-col justify-between p-6 lg:col-span-7">
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
                        {overview?.macro?.yield_credit.credit_state ?? "—"}
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
                        {driver}
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
                    <div className="font-mono text-[10px] tracking-[0.16em] text-zinc-500">
                      LAYER 02 &amp; 05 · 波动率期限与市场情绪 (Vol &amp; Sentiment)
                    </div>
                    <span className="shrink-0 whitespace-nowrap rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 font-mono text-[10px] text-zinc-600">
                      5 维合成模型 · 5-Pillar
                    </span>
                  </div>

                  {/* Fear & Greed Editorial Meter */}
                  <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-4">
                    <div className="flex items-baseline justify-between">
                      <div>
                        <div className="font-mono text-[10px] tracking-wider text-zinc-500">
                          自研恐慌贪婪指数 Fear &amp; Greed Index
                        </div>
                        <div className="mt-1 flex items-baseline gap-2.5">
                          <span className="font-mono text-3xl font-bold tabular-nums text-zinc-950">
                            {fmtNum(overview?.regime?.fear_greed.score, 1)}
                          </span>
                          <span className="font-serif text-lg italic text-zinc-700">
                            {SENTIMENT_BI[overview?.regime?.fear_greed.label ?? ""] ??
                              overview?.regime?.fear_greed.label ??
                              "Unavailable"}
                          </span>
                        </div>
                      </div>
                      <span className="font-mono text-[10px] text-zinc-400">
                        0 极恐 Fear · 100 极贪 Greed
                      </span>
                    </div>

                    <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-200">
                      <div
                        className="h-full rounded-full bg-zinc-950 transition-all duration-700"
                        style={{
                          width: `${Math.min(100, Math.max(4, overview?.regime?.fear_greed.score ?? 0))}%`,
                        }}
                      />
                    </div>

                    <div className="mt-3 grid grid-cols-5 gap-2">
                      {Object.entries(overview?.regime?.fear_greed.components ?? {}).map(
                        ([pillar, score]) => (
                          <div key={pillar} className="text-center">
                            <div className="font-mono text-[11px] font-semibold tabular-nums text-zinc-900">
                              {score !== null && score !== undefined ? score.toFixed(0) : "—"}
                            </div>
                            <div className="truncate font-mono text-[9px] text-zinc-500">
                              {PILLAR_BI[pillar] ?? pillar.replace("_", " ")}
                            </div>
                          </div>
                        )
                      )}
                    </div>
                  </div>

                  {/* VIX Term Curve */}
                  <div>
                    <div className="mb-2 flex items-center justify-between font-mono text-[10px] tracking-wider text-zinc-500">
                      <span>CBOE 波动率期限结构 (VIX Curve)</span>
                      <span className="text-zinc-800">
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
                          className="rounded-xl border border-zinc-200 bg-white px-3 py-2.5"
                        >
                          <div className="font-mono text-[10px] text-zinc-500">{v.label}</div>
                          <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-zinc-950">
                            {fmtNum(v.val, 2)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Funding & Credit Plumbing Table */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-zinc-200 pt-3 font-mono text-xs tabular-nums">
                    <div className="flex justify-between">
                      <span className="text-zinc-500">SOFR 隔夜利率</span>
                      <span className="font-medium text-zinc-950">
                        {fmtNum(overview?.macro?.yield_credit.sofr, 2, "%")}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">银行准备金 Reserves</span>
                      <span className="font-medium text-zinc-950">
                        {overview?.macro?.yield_credit.wresbal_billions != null
                          ? `$${overview.macro.yield_credit.wresbal_billions.toLocaleString()}B`
                          : "—"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">投资级利差 IG OAS</span>
                      <span className="font-medium text-zinc-950">
                        {fmtNum(overview?.macro?.yield_credit.ig_oas, 2, "%")}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">HYG / LQD (20D)</span>
                      <span className="font-medium text-zinc-950">
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
                    <div className="font-mono text-[10px] tracking-[0.16em] text-zinc-500">
                      LAYER 03 · 核心指数与市场广度 (Core &amp; Breadth)
                    </div>
                    <span className="shrink-0 font-mono text-[10px] text-zinc-400">
                      点击行切换 K 线 · Click row
                    </span>
                  </div>

                  {/* Breadth Summary Pills */}
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-xl border border-zinc-200 bg-zinc-50/80 p-2.5">
                      <div className="font-mono text-[10px] text-zinc-500">
                        站上 50日线 &gt;50MA
                      </div>
                      <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-zinc-950">
                        {fmtNum(overview?.equities?.breadth.pct_above_50ma, 1, "%")}
                      </div>
                    </div>
                    <div className="rounded-xl border border-zinc-200 bg-zinc-50/80 p-2.5">
                      <div className="font-mono text-[10px] text-zinc-500">
                        站上 200日线 &gt;200MA
                      </div>
                      <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-zinc-950">
                        {fmtNum(overview?.equities?.breadth.pct_above_200ma, 1, "%")}
                      </div>
                    </div>
                    <div className="rounded-xl border border-zinc-200 bg-zinc-50/80 p-2.5">
                      <div className="font-mono text-[10px] text-zinc-500">
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
                        <tr className="border-b border-zinc-200 text-[10px] uppercase text-zinc-500">
                          <th className="py-2 font-medium">Ticker</th>
                          <th className="py-2 text-right font-medium">Close</th>
                          <th className="py-2 text-right font-medium">1D</th>
                          <th className="py-2 text-right font-medium">20D</th>
                          <th className="py-2 text-right font-medium">RSI14</th>
                          <th className="py-2 text-right font-medium">RVOL</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-100">
                        {Object.entries(overview?.equities?.core_indices ?? {}).map(
                          ([sym, tech]) => {
                            const active = selectedSymbol === sym;
                            return (
                              <tr
                                key={sym}
                                onClick={() => setSelectedSymbol(sym)}
                                className={`cursor-pointer transition ${
                                  active
                                    ? "bg-zinc-950 text-white"
                                    : "hover:bg-zinc-50 text-zinc-900"
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
                                    active
                                  )}`}
                                >
                                  {fmtSigned(tech.change_1d_pct, 2, "%")}
                                </td>
                                <td
                                  className={`py-2.5 text-right ${deltaTone(
                                    tech.change_20d_pct,
                                    active
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

                {/* All Tracked Universe Quick Selector */}
                <div className="mt-4 border-t border-zinc-200 pt-3">
                  <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] text-zinc-500">
                    <span>观测资产池 Watchlist ({trackedAssets.length})</span>
                    <span>
                      涨跌家数 Adv/Dec: {overview?.equities?.breadth.advances ?? 0}/
                      {overview?.equities?.breadth.declines ?? 0}
                    </span>
                  </div>
                  <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto pr-1">
                    {trackedAssets.map((a) => (
                      <button
                        key={a.symbol}
                        type="button"
                        onClick={() => setSelectedSymbol(a.symbol)}
                        className={`rounded border px-1.5 py-0.5 font-mono text-[10px] transition ${
                          selectedSymbol === a.symbol
                            ? "border-zinc-950 bg-zinc-950 text-white"
                            : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-400"
                        }`}
                      >
                        {a.symbol}
                      </button>
                    ))}
                  </div>
                </div>
              </SpotlightBlock>

              {/* Layer 4 Right: Obsidian Interactive Asset Candlestick & Micro Technicals */}
              <SpotlightBlock tone="obsidian" className="flex flex-col justify-between p-6 lg:col-span-7">
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

                    <span className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] text-zinc-300">
                      {assetDetail?.technicals.volume_price_tag ?? "Loading volume regime..."}
                    </span>
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
              <SpotlightBlock tone="gallery" className="p-6 lg:col-span-7">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.16em] text-zinc-500">
                      <BarChart3 className="h-3.5 w-3.5" />
                      LAYER 02 · 期权做市商墙体分布 (Dealer Positioning)
                    </div>
                    <h2 className="mt-1 font-serif text-2xl text-zinc-950">
                      {gexSymbol} Estimated GEX 伽马敞口估算
                    </h2>
                  </div>

                  <div className="flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-100 p-0.5 font-mono text-[11px]">
                    {(["SPY", "QQQ"] as const).map((sym) => (
                      <button
                        key={sym}
                        type="button"
                        onClick={() => setGexSymbol(sym)}
                        className={`rounded-full px-3 py-1 transition ${
                          gexSymbol === sym
                            ? "bg-zinc-950 text-white"
                            : "text-zinc-600 hover:text-zinc-950"
                        }`}
                      >
                        {sym}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 font-mono text-[10px] text-zinc-600">
                  {activeGex?.assumption_label ??
                    "Estimated GEX (Dealer Positioning Assumption · OCC T+1/T+2 OI)"}
                </div>

                {/* Key Wall Stats */}
                <div className="my-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
                  {[
                    {
                      label: "现价 Spot Ref",
                      value: activeGex ? `$${activeGex.spot_price.toFixed(2)}` : "—",
                      cls: "text-zinc-950",
                    },
                    {
                      label: "净伽马 Net GEX",
                      value: activeGex ? fmtBillions(activeGex.net_gex) : "—",
                      cls: deltaTone(activeGex?.net_gex, false),
                    },
                    {
                      label: "看涨墙 Call Wall",
                      value: activeGex?.call_wall ? `$${activeGex.call_wall.toFixed(0)}` : "—",
                      cls: "text-emerald-600",
                    },
                    {
                      label: "看跌墙 Put Wall",
                      value: activeGex?.put_wall ? `$${activeGex.put_wall.toFixed(0)}` : "—",
                      cls: "text-rose-600",
                    },
                    {
                      label: "翻转位 Zero Gamma",
                      value: activeGex?.zero_gamma ? `$${activeGex.zero_gamma.toFixed(2)}` : "—",
                      cls: "text-amber-600",
                    },
                  ].map((stat) => (
                    <div
                      key={stat.label}
                      className="rounded-xl border border-zinc-200 bg-white px-3 py-2"
                    >
                      <div className="font-mono text-[10px] text-zinc-500">{stat.label}</div>
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
                              ? "bg-white text-zinc-950"
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
                              selectedSymbol !== sec.symbol
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
              <SpotlightBlock tone="obsidian" className="p-6 lg:col-span-4">
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
                    <div className="font-mono text-[10px] tracking-[0.16em] text-zinc-500">
                      LAYER 05 · CFTC 机构期货净持仓 (COT)
                    </div>
                    <h3 className="mt-1 font-serif text-xl text-zinc-950">
                      非商业投机净头寸 Net Positioning
                    </h3>
                  </div>
                  <span className="shrink-0 whitespace-nowrap rounded border border-zinc-200 px-2 py-0.5 font-mono text-[10px] text-zinc-500">
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
                          className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3"
                        >
                          <div className="flex items-center justify-between font-mono text-xs">
                            <span className="font-semibold text-zinc-950">
                              {code}{" "}
                              <span className="font-normal text-zinc-500">· {row.contract}</span>
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
                          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
                            <div
                              className={`h-full rounded-full ${
                                row.noncomm_net >= 0 ? "bg-emerald-600" : "bg-rose-600"
                              }`}
                              style={{ width: `${barWidth}%` }}
                            />
                          </div>
                          <div className="mt-1.5 flex justify-between font-mono text-[10px] text-zinc-500 tabular-nums">
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

                        {ev.eps_estimate !== null && (
                          <span className="shrink-0 font-mono text-[11px] text-zinc-300 tabular-nums">
                            Est ${ev.eps_estimate.toFixed(2)}
                          </span>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </SpotlightBlock>
            </motion.section>
          </>
        )}
      </main>

      {/* Bottom Floating Phase 3 Command Capsule */}
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.22, ease: EASE_EXPO }}
          className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4"
        >
          <div className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-full border border-zinc-800 bg-[#0B0B0D]/95 px-4 py-2 text-white shadow-[0_20px_50px_-12px_rgba(0,0,0,0.65)] backdrop-blur-md">
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-300">
              <Cpu className="h-3.5 w-3.5 text-emerald-400" />
              焦点 Focus: <strong className="text-white">{selectedSymbol}</strong>
            </span>
            <span className="hidden h-3 w-px bg-zinc-700 sm:inline-block" />
            <span className="hidden font-mono text-[11px] text-zinc-400 sm:inline">
              体制 Regime:{" "}
              <span className="text-zinc-200">
                {formatRegimeLabel(overview?.regime?.regime_label)}
              </span>
            </span>
            <span className="hidden h-3 w-px bg-zinc-700 md:inline-block" />
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1 font-mono text-[10px] font-semibold text-zinc-950 transition hover:bg-zinc-200"
            >
              <Sparkles className="h-3 w-3" />
              Investigator 投研主脑 · SEC 财报检索
            </button>
          </div>
        </motion.div>
      </AnimatePresence>

      <InvestigatorDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        defaultSymbol={selectedSymbol}
      />
    </div>
  );
}

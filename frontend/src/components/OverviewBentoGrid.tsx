"use client";

import React from "react";
import { motion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Layers,
  Search,
  Sparkles,
} from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import WatchlistCardPanel from "@/components/WatchlistCardPanel";
import DiscoverNewsShelf from "@/components/DiscoverNewsShelf";
import AssetCandlestickChart from "@/components/charts/AssetCandlestickChart";
import GexProfileChart from "@/components/charts/GexProfileChart";
import NetLiquidityChart from "@/components/charts/NetLiquidityChart";
import type {
  AssetDetailResponse,
  DashboardOverviewResponse,
  DiscoverNewsItem,
  RegimeHistoryPoint,
  WatchlistAssetItem,
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
    return onObsidian ? "text-zinc-300" : "text-zinc-700 dark:text-zinc-300";
  }
  if (val > 0) {
    return onObsidian ? "text-emerald-400" : "text-emerald-700 dark:text-emerald-400";
  }
  if (val < 0) {
    return onObsidian ? "text-rose-400" : "text-rose-700 dark:text-rose-400";
  }
  return onObsidian ? "text-zinc-200" : "text-zinc-700 dark:text-zinc-300";
}

const REGIME_BI: Record<string, string> = {
  HIGH_VOL_TRANSITION: "高波切换 · HIGH VOL TRANSITION",
  RISK_ON_EXPANSION: "风险扩张 · RISK ON EXPANSION",
  RISK_OFF_STRESS: "避险承压 · RISK OFF STRESS",
  LIQUIDITY_TIGHTENING: "流动性收紧 · LIQUIDITY TIGHTENING",
  NEUTRAL_ROTATION: "中性轮动 · NEUTRAL ROTATION",
};

const SENTIMENT_BI: Record<string, string> = {
  "Extreme Fear": "极度恐慌",
  Fear: "恐慌 Fear",
  Neutral: "中性 Neutral",
  Greed: "贪婪 Greed",
  "Extreme Greed": "极度贪婪",
};

const PILLAR_BI: Record<string, string> = {
  momentum: "动量",
  breadth: "广度",
  volatility: "波动",
  credit: "信用",
  risk_appetite: "风险",
};

const VIX_STATE_BI: Record<string, string> = {
  "Contango (Calm)": "正向升水",
  "Flat (Transition)": "期限走平",
  "Backwardation (Stress)": "倒挂贴水",
};

const BUCKET_SHORT: Record<string, string> = {
  Offensive: "进攻",
  Cyclical: "周期",
  Defensive: "防御",
};

interface OverviewBentoGridProps {
  theme: "light" | "dark";
  overview: DashboardOverviewResponse | null;
  regimeHistory: RegimeHistoryPoint[];
  selectedSymbol: string;
  onSelectSymbol: (sym: string) => void;
  assetDetail: AssetDetailResponse | null;
  assetLoading: boolean;
  gexSymbol: "SPY" | "QQQ";
  onChangeGexSymbol: (sym: "SPY" | "QQQ") => void;
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
}

export default function OverviewBentoGrid({
  theme,
  overview,
  regimeHistory,
  selectedSymbol,
  onSelectSymbol,
  assetDetail,
  assetLoading,
  gexSymbol,
  onChangeGexSymbol,
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
}: OverviewBentoGridProps) {
  const activeGex = overview?.options_gex?.[gexSymbol] ?? null;
  const regimeLabel = overview?.regime?.regime_label;
  const formattedRegime = regimeLabel
    ? REGIME_BI[regimeLabel] ?? regimeLabel.replaceAll("_", " ")
    : "初始化中 · INITIALIZING";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE_EXPO }}
      className="space-y-3.5"
    >
      {/* ==================== ROW 1 (3+6+3): MACRO/COT | BENCHMARKS + MAIN K-LINE | WATCHLIST ==================== */}
      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-12">
        {/* Left Rail (3 cols): Macro Regime & Liquidity + CFTC COT */}
        <div className="flex flex-col gap-3.5 xl:col-span-3">
          <SpotlightBlock tone="obsidian" className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold tracking-wider text-zinc-200">
                  <Layers className="h-3.5 w-3.5 text-emerald-400" />
                  LAYER 01 · 宏观流动性与体制锚
                </div>
                <h1 className="mt-1 font-serif text-xl font-medium leading-tight tracking-tight text-white">
                  {formattedRegime}
                </h1>
              </div>
              <span className="shrink-0 rounded-full border border-zinc-600 bg-zinc-900 px-2.5 py-0.5 font-mono text-[11px] font-medium text-zinc-100">
                压{overview?.regime?.stress_score ?? 0}·支{overview?.regime?.support_score ?? 0}
              </span>
            </div>

            <div className="mt-2.5 grid grid-cols-2 gap-2 border-y border-zinc-800 py-2">
              <div>
                <div className="font-mono text-[11px] text-zinc-300">美联储净流动性</div>
                <div className="font-mono text-base font-bold tabular-nums text-white">
                  {overview?.macro?.net_liquidity.latest_billions != null
                    ? `$${overview.macro.net_liquidity.latest_billions.toLocaleString()}B`
                    : "—"}
                </div>
                <div
                  className={`font-mono text-[11px] font-semibold tabular-nums ${deltaTone(
                    overview?.macro?.net_liquidity.delta_20d_billions,
                    true
                  )}`}
                >
                  20D {fmtSigned(overview?.macro?.net_liquidity.delta_20d_billions, 1, "B")}
                </div>
              </div>

              <div>
                <div className="font-mono text-[11px] text-zinc-300">10Y–2Y 期限利差</div>
                <div className="font-mono text-base font-bold tabular-nums text-white">
                  {fmtSigned(overview?.macro?.yield_credit.yield_spread_10y2y, 2, "%")}
                </div>
                <div className="font-mono text-[11px] tabular-nums text-zinc-200">
                  10Y {fmtNum(overview?.macro?.yield_credit.dgs10, 2, "%")} · R{" "}
                  {fmtNum(overview?.macro?.yield_credit.dfii10, 2, "%")}
                </div>
              </div>

              <div>
                <div className="font-mono text-[11px] text-zinc-300">高收益利差 HY OAS</div>
                <div className="font-mono text-base font-bold tabular-nums text-white">
                  {fmtNum(overview?.macro?.yield_credit.hy_oas, 2, "%")}
                </div>
                <div className="truncate font-mono text-[11px] text-zinc-200">
                  {formatCreditState(overview?.macro?.yield_credit.credit_state)}
                </div>
              </div>

              <div>
                <div className="font-mono text-[11px] text-zinc-300">VIX / VIX3M 期限比</div>
                <div className="font-mono text-base font-bold tabular-nums text-white">
                  {fmtNum(overview?.macro?.vix_structure.vix_vix3m_ratio, 3)}
                </div>
                <div className="font-mono text-[11px] text-zinc-200">
                  {VIX_STATE_BI[overview?.macro?.vix_structure.structure_state ?? ""] ?? "—"}
                </div>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              {(overview?.regime?.drivers ?? []).slice(0, 3).map((driver) => (
                <span
                  key={driver}
                  className="rounded-md border border-zinc-700 bg-zinc-900/90 px-2 py-0.5 font-mono text-[11px] text-zinc-100"
                >
                  {formatDriverText(driver)}
                </span>
              ))}
            </div>

            <div className="mt-2">
              <NetLiquidityChart
                series={overview?.macro?.net_liquidity.series ?? []}
                height={86}
              />
            </div>
          </SpotlightBlock>

          {/* Compact CFTC COT 2x2 Matrix */}
          <SpotlightBlock tone="obsidian" className="flex-1 p-3.5">
            <div className="mb-2 flex items-center justify-between font-mono text-[11px] font-semibold text-zinc-200">
              <span>LAYER 05 · CFTC 机构净持仓 (COT)</span>
              <span>周更</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(overview?.positioning_and_calendar?.cot ?? {}).map(
                ([code, row]) => {
                  const pct = row.noncomm_net_pct_oi ?? 0;
                  const barWidth = Math.min(100, Math.max(8, Math.abs(pct) * 2.5));
                  return (
                    <div
                      key={code}
                      className="rounded-lg border border-zinc-800 bg-zinc-950/75 px-2.5 py-2 font-mono text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-white">{code}</span>
                        <span className={`font-bold tabular-nums ${deltaTone(row.noncomm_net, true)}`}>
                          {row.noncomm_net >= 0 ? "+" : ""}
                          {(row.noncomm_net / 1000).toFixed(0)}K
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className={`h-full rounded-full ${
                            row.noncomm_net >= 0 ? "bg-emerald-500" : "bg-rose-500"
                          }`}
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                    </div>
                  );
                }
              )}
            </div>
          </SpotlightBlock>
        </div>

        {/* Center Stage (6 cols): Benchmarks + Search + Main K-Line */}
        <div className="flex flex-col gap-3.5 xl:col-span-6">
          <SpotlightBlock tone="gallery" className="space-y-2.5 p-3.5">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {Object.entries(overview?.equities?.core_indices ?? {}).map(([sym, tech]) => {
                const active = selectedSymbol === sym;
                return (
                  <button
                    key={sym}
                    type="button"
                    onClick={() => onSelectSymbol(sym)}
                    className={`rounded-xl border px-2.5 py-2 text-left font-mono transition ${
                      active
                        ? "border-zinc-950 bg-zinc-950 text-white shadow-sm dark:border-white/50 dark:bg-white dark:text-zinc-950"
                        : "border-zinc-200 bg-white/90 text-zinc-950 hover:border-zinc-400 dark:border-white/15 dark:bg-white/[0.06] dark:text-white"
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs font-bold">
                      <span>{sym}</span>
                      <span
                        className={deltaTone(
                          tech.change_1d_pct,
                          active ? theme !== "dark" : theme === "dark"
                        )}
                      >
                        {fmtSigned(tech.change_1d_pct, 2, "%")}
                      </span>
                    </div>
                    <div className="mt-0.5 text-sm font-bold tabular-nums">
                      {tech.last_close != null
                        ? sym === "BTCUSDT"
                          ? `$${tech.last_close.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                          : `$${tech.last_close.toFixed(2)}`
                        : "—"}
                    </div>
                  </button>
                );
              })}
            </div>

            <form onSubmit={onSearchSubmit} className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[220px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600 dark:text-zinc-300" />
                <input
                  type="text"
                  value={tickerSearchInput}
                  onChange={(e) => onChangeSearchInput(e.target.value.toUpperCase())}
                  placeholder="输入任意美股代码切换 K 线 / GEX (如 AMD, PLTR, TSM, NVDA)..."
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

          {/* Main Candlestick + Telemetry Chart Card */}
          <SpotlightBlock tone="obsidian" className="flex-1 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-baseline gap-2.5">
                <span className="flex items-center gap-1.5 font-mono text-xs font-semibold text-zinc-200">
                  <Activity className="h-3.5 w-3.5 text-emerald-400" />
                  LAYER 04
                </span>
                <h2 className="font-serif text-2xl font-medium text-white">
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
                  className={`font-mono text-xs font-bold tabular-nums ${deltaTone(
                    assetDetail?.technicals.change_1d_pct,
                    true
                  )}`}
                >
                  {fmtSigned(assetDetail?.technicals.change_1d_pct, 2, "%")}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <span className="hidden rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-100 sm:inline-block">
                  {formatVolumePriceTag(assetDetail?.technicals.volume_price_tag)}
                </span>
                <button
                  type="button"
                  onClick={() => onOpenStockDetail(selectedSymbol)}
                  className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 font-mono text-xs font-semibold text-zinc-950 transition hover:bg-zinc-200"
                >
                  个股页 <ArrowRight className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={onOpenAiDrawer}
                  className="inline-flex items-center gap-1 rounded-full border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-1 font-mono text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/25"
                >
                  <Sparkles className="h-3 w-3" />
                  AI 协查
                </button>
              </div>
            </div>

            <div className="my-2.5 grid grid-cols-3 gap-2 rounded-xl border border-zinc-800 bg-zinc-950/75 px-3 py-2 font-mono text-xs tabular-nums sm:grid-cols-6">
              <div>
                <span className="text-[11px] text-zinc-300">RSI(14) </span>
                <strong className="text-white">{fmtNum(assetDetail?.technicals.rsi_14, 1)}</strong>
              </div>
              <div>
                <span className="text-[11px] text-zinc-300">RVOL </span>
                <strong className="text-white">{fmtNum(assetDetail?.technicals.rvol_20, 2, "x")}</strong>
              </div>
              <div>
                <span className="text-[11px] text-zinc-300">ATR% </span>
                <strong className="text-white">{fmtNum(assetDetail?.technicals.atr_pct, 2, "%")}</strong>
              </div>
              <div>
                <span className="text-[11px] text-zinc-300">50MA </span>
                <strong className={deltaTone(assetDetail?.technicals.dist_50ma_pct, true)}>
                  {fmtSigned(assetDetail?.technicals.dist_50ma_pct, 2, "%")}
                </strong>
              </div>
              <div>
                <span className="text-[11px] text-zinc-300">200MA </span>
                <strong className={deltaTone(assetDetail?.technicals.dist_200ma_pct, true)}>
                  {fmtSigned(assetDetail?.technicals.dist_200ma_pct, 2, "%")}
                </strong>
              </div>
              <div>
                <span className="text-[11px] text-zinc-300">MACD </span>
                <strong className={deltaTone(assetDetail?.technicals.macd?.histogram, true)}>
                  {fmtSigned(assetDetail?.technicals.macd?.histogram, 2)}
                </strong>
              </div>
            </div>

            {assetLoading && !assetDetail ? (
              <div className="flex h-[250px] items-center justify-center rounded-xl border border-zinc-800 font-mono text-xs text-zinc-200">
                Loading {selectedSymbol} consolidated OHLCV...
              </div>
            ) : (
              <AssetCandlestickChart
                symbol={selectedSymbol}
                bars={assetDetail?.bars ?? []}
                gex={assetDetail?.options_gex}
                height={250}
              />
            )}
          </SpotlightBlock>
        </div>

        {/* Right Rail (3 cols): Self-contained High-Density Watchlist Card */}
        <div className="xl:col-span-3">
          <WatchlistCardPanel
            items={watchlistItems}
            loading={watchlistLoading}
            mutating={watchlistMutating}
            error={watchlistError}
            onAddSymbol={onAddWatchlist}
            onReorderSymbols={onReorderWatchlist}
            onRemoveSymbol={onRemoveWatchlist}
            onOpenStockDetail={onOpenStockDetail}
            onOpenMyWatchlist={onOpenMyWatchlist}
          />
        </div>
      </div>

      {/* ==================== ROW 2 (4+4+4): SENTIMENT/BREADTH | GEX WALL | 11 SECTORS ==================== */}
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-12">
        {/* Fear & Greed + VIX Term + Breadth + Funding */}
        <SpotlightBlock tone="gallery" className="flex flex-col justify-between p-4 lg:col-span-4">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] font-semibold tracking-wider text-zinc-700 dark:text-zinc-200">
                LAYER 02 &amp; 05 · 恐慌 · 广度 · 资金
              </span>
              <span className="shrink-0 font-mono text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">
                {overview?.regime_date ?? ""}
              </span>
            </div>

            <div className="mt-2.5 rounded-xl border border-zinc-200 bg-white/85 p-3 dark:border-white/15 dark:bg-white/[0.04]">
              <div className="flex items-baseline justify-between">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-2xl font-bold tabular-nums text-zinc-950 dark:text-white">
                    {fmtNum(overview?.regime?.fear_greed.score, 1)}
                  </span>
                  <span className="font-serif text-base font-medium italic text-zinc-800 dark:text-zinc-200">
                    {SENTIMENT_BI[overview?.regime?.fear_greed.label ?? ""] ??
                      overview?.regime?.fear_greed.label ??
                      "—"}
                  </span>
                </div>
                <span className="font-mono text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                  恐慌贪婪指数
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-white/15">
                <div
                  className="h-full rounded-full bg-zinc-950 transition-all duration-700 dark:bg-zinc-100"
                  style={{
                    width: `${Math.min(100, Math.max(4, overview?.regime?.fear_greed.score ?? 0))}%`,
                  }}
                />
              </div>
              <div className="mt-2 grid grid-cols-5 gap-1 text-center font-mono text-[11px]">
                {Object.entries(overview?.regime?.fear_greed.components ?? {}).map(
                  ([pillar, score]) => (
                    <div key={pillar}>
                      <div className="font-bold text-zinc-950 dark:text-white">
                        {score !== null && score !== undefined ? score.toFixed(0) : "—"}
                      </div>
                      <div className="text-zinc-700 dark:text-zinc-300">
                        {PILLAR_BI[pillar] ?? pillar.slice(0, 3)}
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>

            <div className="mt-2.5 grid grid-cols-3 gap-2 font-mono">
              {[
                { label: "VIX9D", val: fmtNum(overview?.macro?.vix_structure.vix9d, 2) },
                { label: "VIX(30D)", val: fmtNum(overview?.macro?.vix_structure.vix, 2) },
                { label: "VIX3M", val: fmtNum(overview?.macro?.vix_structure.vix3m, 2) },
                {
                  label: ">50MA 占比",
                  val: fmtNum(overview?.equities?.breadth.pct_above_50ma, 1, "%"),
                },
                {
                  label: ">200MA 占比",
                  val: fmtNum(overview?.equities?.breadth.pct_above_200ma, 1, "%"),
                },
                {
                  label: "RSP/SPY",
                  val: fmtSigned(overview?.equities?.breadth.rsp_spy_20d_delta_pct, 2, "%"),
                  cls: deltaTone(overview?.equities?.breadth.rsp_spy_20d_delta_pct, false),
                },
              ].map((b) => (
                <div
                  key={b.label}
                  className="rounded-lg border border-zinc-200 bg-white/85 px-2.5 py-1.5 dark:border-white/15 dark:bg-white/[0.05]"
                >
                  <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                    {b.label}
                  </div>
                  <div
                    className={`text-sm font-bold tabular-nums ${
                      b.cls ?? "text-zinc-950 dark:text-white"
                    }`}
                  >
                    {b.val}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-2.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 pt-2 font-mono text-xs font-medium text-zinc-800 dark:border-white/15 dark:text-zinc-200">
              <span>SOFR {fmtNum(overview?.macro?.yield_credit.sofr, 2, "%")}</span>
              <span>IG {fmtNum(overview?.macro?.yield_credit.ig_oas, 2, "%")}</span>
              <span>
                准备金{" "}
                {overview?.macro?.yield_credit.wresbal_billions != null
                  ? `$${overview.macro.yield_credit.wresbal_billions.toLocaleString()}B`
                  : "—"}
              </span>
            </div>

            {regimeHistory.length > 0 && (
              <div className="flex h-5 items-end gap-0.5">
                {regimeHistory.slice(-20).map((pt) => {
                  const score = Math.min(100, Math.max(12, pt.fear_greed_score ?? 40));
                  const tone =
                    pt.regime_label === "RISK_OFF_STRESS"
                      ? "bg-rose-500"
                      : pt.regime_label === "RISK_ON_EXPANSION"
                        ? "bg-emerald-600 dark:bg-emerald-500"
                        : "bg-zinc-700 dark:bg-zinc-400";
                  return (
                    <div
                      key={pt.regime_date}
                      title={`${pt.regime_date}: F&G ${pt.fear_greed_score ?? "—"}`}
                      className={`flex-1 rounded-t-sm ${tone}`}
                      style={{ height: `${score}%` }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </SpotlightBlock>

        {/* GEX Strike Wall */}
        <SpotlightBlock tone="gallery" className="flex flex-col justify-between p-4 lg:col-span-4">
          <div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">
                <BarChart3 className="h-3.5 w-3.5" />
                LAYER 02 · {gexSymbol} GEX 期权墙
              </div>
              <div className="flex items-center gap-1 rounded-full border border-zinc-300 bg-zinc-100 p-0.5 font-mono text-[11px] dark:border-white/20 dark:bg-white/[0.08]">
                {(["SPY", "QQQ"] as const).map((sym) => (
                  <button
                    key={sym}
                    type="button"
                    onClick={() => onChangeGexSymbol(sym)}
                    className={`rounded-full px-2.5 py-0.5 font-semibold transition ${
                      gexSymbol === sym
                        ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                        : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-200"
                    }`}
                  >
                    {sym}
                  </button>
                ))}
              </div>
            </div>

            <div className="my-2.5 grid grid-cols-4 gap-1.5 font-mono text-xs tabular-nums">
              <div className="rounded-lg border border-zinc-200 bg-white/85 px-2 py-1 dark:border-white/15 dark:bg-white/[0.05]">
                <div className="text-[10px] text-zinc-700 dark:text-zinc-300">Net GEX</div>
                <div className={`font-bold ${deltaTone(activeGex?.net_gex, false)}`}>
                  {activeGex ? fmtBillions(activeGex.net_gex) : "—"}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white/85 px-2 py-1 dark:border-white/15 dark:bg-white/[0.05]">
                <div className="text-[10px] text-zinc-700 dark:text-zinc-300">Call Wall</div>
                <div className="font-bold text-emerald-700 dark:text-emerald-400">
                  {activeGex?.call_wall ? `$${activeGex.call_wall.toFixed(0)}` : "—"}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white/85 px-2 py-1 dark:border-white/15 dark:bg-white/[0.05]">
                <div className="text-[10px] text-zinc-700 dark:text-zinc-300">Put Wall</div>
                <div className="font-bold text-rose-700 dark:text-rose-400">
                  {activeGex?.put_wall ? `$${activeGex.put_wall.toFixed(0)}` : "—"}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white/85 px-2 py-1 dark:border-white/15 dark:bg-white/[0.05]">
                <div className="text-[10px] text-zinc-700 dark:text-zinc-300">Zero γ</div>
                <div className="font-bold text-amber-700 dark:text-amber-300">
                  {activeGex?.zero_gamma ? `$${activeGex.zero_gamma.toFixed(1)}` : "—"}
                </div>
              </div>
            </div>
          </div>

          <GexProfileChart
            profile={activeGex?.strike_profile ?? []}
            spotPrice={activeGex?.spot_price ?? 0}
            callWall={activeGex?.call_wall ?? null}
            putWall={activeGex?.put_wall ?? null}
            zeroGamma={activeGex?.zero_gamma ?? null}
            height={195}
          />
        </SpotlightBlock>

        {/* Compact 11 SPDR Sectors Table */}
        <SpotlightBlock tone="obsidian" className="p-4 lg:col-span-4">
          <div className="mb-2 flex items-center justify-between font-mono text-[11px] font-semibold text-zinc-200">
            <span>LAYER 03 · 11 板块轮动 (按20D排序)</span>
            <span>点击切图</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs tabular-nums">
              <thead>
                <tr className="border-b border-zinc-800 text-[11px] font-semibold text-zinc-200">
                  <th className="py-1">ETF</th>
                  <th className="py-1">风格</th>
                  <th className="py-1 text-right">1D</th>
                  <th className="py-1 text-right">20D</th>
                  <th className="py-1 text-right">vsSPY</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {(overview?.equities?.sector_rotation ?? []).map((sec) => {
                  const active = selectedSymbol === sec.symbol;
                  return (
                    <tr
                      key={sec.symbol}
                      onClick={() => onSelectSymbol(sec.symbol)}
                      className={`cursor-pointer transition ${
                        active
                          ? "bg-white text-zinc-950 dark:bg-white/[0.16] dark:text-white"
                          : "text-zinc-100 hover:bg-zinc-900/75"
                      }`}
                    >
                      <td className="py-1 pl-1 font-bold">{sec.symbol}</td>
                      <td className="py-1 text-[11px]">
                        {BUCKET_SHORT[sec.bucket] ?? sec.bucket}
                      </td>
                      <td
                        className={`py-1 text-right font-semibold ${deltaTone(
                          sec.return_1d_pct,
                          !active || theme === "dark"
                        )}`}
                      >
                        {fmtSigned(sec.return_1d_pct, 2, "%")}
                      </td>
                      <td
                        className={`py-1 text-right font-semibold ${deltaTone(
                          sec.return_20d_pct,
                          !active || theme === "dark"
                        )}`}
                      >
                        {fmtSigned(sec.return_20d_pct, 2, "%")}
                      </td>
                      <td
                        className={`py-1 pr-1 text-right font-semibold ${deltaTone(
                          sec.rel_spy_20d_pct,
                          !active || theme === "dark"
                        )}`}
                      >
                        {fmtSigned(sec.rel_spy_20d_pct, 2, "%")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SpotlightBlock>
      </div>

      {/* ==================== ROW 3: DISCOVER HD PHOTO FINANCIAL NEWS (CHINESE TRANSLATED) ==================== */}
      <DiscoverNewsShelf
        items={discoverNews}
        loading={discoverLoading}
        error={discoverError}
        onRefresh={onRefreshDiscover}
      />
    </motion.div>
  );
}

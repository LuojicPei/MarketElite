"use client";

import React, { useEffect, useState } from "react";
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Bot,
  ExternalLink,
  FileText,
  Layers,
  Newspaper,
  Search,
  ShieldAlert,
  Sparkles,
  Star,
} from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import StockLogoBadge from "@/components/StockLogoBadge";
import AssetCandlestickChart from "@/components/charts/AssetCandlestickChart";
import GexProfileChart from "@/components/charts/GexProfileChart";
import { useTheme } from "@/components/ThemeProvider";
import {
  AssetDetailResponse,
  SecSearchResponse,
  fetchAssetDetail,
  searchSecFilings,
} from "@/lib/api";
import { formatVolumePriceTag } from "@/lib/i18n";

interface StockDetailViewProps {
  symbol: string;
  isWatched: boolean;
  onToggleWatchlist: (symbol: string) => Promise<void>;
  onSelectOtherSymbol: (symbol: string) => void;
  onBackToOverview: () => void;
  onBackToWatchlist: () => void;
  onOpenAiDrawer: (symbol: string) => void;
  onOpenCopilot: (symbol: string) => void;
}

function fmtUsd(val: number | null | undefined, digits = 2): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return `$${val.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function fmtCapB(billions: number | null | undefined): string {
  if (billions === null || billions === undefined || Number.isNaN(billions)) return "—";
  if (billions >= 1000) return `$${(billions / 1000).toFixed(2)}T`;
  if (billions >= 1) return `$${billions.toFixed(1)}B`;
  return `$${(billions * 1000).toFixed(0)}M`;
}

function fmtVol(vol: number | null | undefined): string {
  if (vol === null || vol === undefined || Number.isNaN(vol)) return "—";
  if (vol >= 1e9) return `${(vol / 1e9).toFixed(2)}B`;
  if (vol >= 1e6) return `${(vol / 1e6).toFixed(2)}M`;
  if (vol >= 1e3) return `${(vol / 1e3).toFixed(1)}K`;
  return vol.toFixed(0);
}

function fmtSigned(val: number | null | undefined, digits = 2, suffix = ""): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return `${val >= 0 ? "+" : ""}${val.toFixed(digits)}${suffix}`;
}

function fmtBillions(val: number | null | undefined): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  const sign = val >= 0 ? "+" : "-";
  const abs = Math.abs(val);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toLocaleString()}`;
}

export default function StockDetailView({
  symbol,
  isWatched,
  onToggleWatchlist,
  onSelectOtherSymbol,
  onBackToOverview,
  onBackToWatchlist,
  onOpenAiDrawer,
  onOpenCopilot,
}: StockDetailViewProps) {
  const { theme } = useTheme();
  const [detail, setDetail] = useState<AssetDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jumpInput, setJumpInput] = useState("");
  const [togglingWatch, setTogglingWatch] = useState(false);

  // SEC 10-K/Q Interactive Query inside Stock Page
  const [secQuery, setSecQuery] = useState("");
  const [secLoading, setSecLoading] = useState(false);
  const [secRes, setSecRes] = useState<SecSearchResponse | null>(null);
  const [secError, setSecError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setSecRes(null);
    setSecError(null);
    fetchAssetDetail(symbol, 260, true, true)
      .then((res) => {
        if (alive) setDetail(res);
      })
      .catch((err) => {
        if (alive) {
          setError(err instanceof Error ? err.message : "Failed to load asset detail");
          setDetail(null);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [symbol]);

  const handleJump = (e: React.FormEvent) => {
    e.preventDefault();
    const sym = jumpInput.trim().toUpperCase();
    if (!sym) return;
    setJumpInput("");
    onSelectOtherSymbol(sym);
  };

  const handleSecSearch = async (queryText: string) => {
    const q = queryText.trim();
    if (!q) return;
    setSecQuery(q);
    setSecLoading(true);
    setSecError(null);
    try {
      const res = await searchSecFilings({ symbol, query: q, top_k: 4 });
      setSecRes(res);
    } catch (err) {
      setSecError(err instanceof Error ? err.message : "SEC 检索失败");
    } finally {
      setSecLoading(false);
    }
  };

  const lastClose = detail?.technicals.last_close;
  const chg1dPct = detail?.technicals.change_1d_pct;
  const chg1dAbs = detail?.metrics?.change_1d_abs;
  const isUp = (chg1dPct ?? 0) >= 0;
  const low52 = detail?.metrics?.week52_low;
  const high52 = detail?.metrics?.week52_high;
  const pos52Pct =
    lastClose != null && low52 != null && high52 != null && high52 > low52
      ? Math.max(0, Math.min(100, ((lastClose - low52) / (high52 - low52)) * 100))
      : null;

  const latestRec = detail?.recommendations?.[0];
  const recTotal = latestRec
    ? latestRec.strong_buy +
      latestRec.buy +
      latestRec.hold +
      latestRec.sell +
      latestRec.strong_sell
    : 0;

  return (
    <main className="mx-auto w-full max-w-[1860px] space-y-4 px-4 pt-3 sm:px-6 lg:px-8">
      {/* Top Breadcrumb Navigation & Instant Ticker Switch */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onBackToOverview}
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white/90 px-3.5 py-1.5 font-mono text-xs font-semibold text-zinc-900 transition hover:border-zinc-950 dark:border-white/20 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回市场总览
          </button>
          <button
            type="button"
            onClick={onBackToWatchlist}
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white/90 px-3.5 py-1.5 font-mono text-xs font-semibold text-zinc-900 transition hover:border-zinc-950 dark:border-white/20 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-white"
          >
            我的关注列表
          </button>
        </div>

        <form onSubmit={handleJump} className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600 dark:text-zinc-300" />
            <input
              type="text"
              value={jumpInput}
              onChange={(e) => setJumpInput(e.target.value.toUpperCase())}
              placeholder="切换任意代码 (AAPL, NVDA, SPY)..."
              className="w-56 rounded-xl border border-zinc-300 bg-white/90 py-1.5 pl-9 pr-3 font-mono text-sm text-zinc-950 placeholder:text-zinc-500 focus:border-zinc-950 focus:outline-none dark:border-white/20 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-400 sm:w-64"
            />
          </div>
          <button
            type="submit"
            disabled={!jumpInput.trim()}
            className="rounded-xl bg-zinc-950 px-3.5 py-1.5 font-mono text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-45 dark:bg-white dark:text-zinc-950"
          >
            跳转个股
          </button>
        </form>
      </div>

      {error && (
        <div className="rounded-2xl border border-rose-300 bg-rose-50 px-5 py-4 text-sm font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </div>
      )}

      {/* Block 1: Institutional Single-Stock Identity & Persistent Action Toolbar */}
      <SpotlightBlock tone="gallery" className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="flex items-start gap-4">
            <StockLogoBadge symbol={symbol} size={58} />
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-serif text-2xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50 sm:text-3xl">
                  {detail?.profile?.name || symbol}
                </h1>
                <span className="rounded-lg border border-zinc-300 bg-white px-2.5 py-0.5 font-mono text-xs font-bold text-zinc-900 dark:border-white/20 dark:bg-zinc-900 dark:text-zinc-100">
                  {symbol} · {detail?.profile?.exchange || "US"}
                </span>
                {detail?.profile?.industry && (
                  <span className="rounded-lg border border-zinc-300/80 bg-zinc-100 px-2.5 py-0.5 font-mono text-xs font-medium text-zinc-800 dark:border-white/15 dark:bg-white/[0.08] dark:text-zinc-200">
                    {detail.profile.industry}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-baseline gap-3">
                <span className="font-mono text-3xl font-bold tabular-nums text-zinc-950 dark:text-white sm:text-4xl">
                  {fmtUsd(lastClose)}
                </span>
                <span
                  className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 font-mono text-sm font-bold tabular-nums ${
                    isUp
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/75 dark:text-emerald-300"
                      : "bg-rose-100 text-rose-800 dark:bg-rose-950/75 dark:text-rose-300"
                  }`}
                >
                  {chg1dAbs != null ? `${chg1dAbs >= 0 ? "+" : "-"}$${Math.abs(chg1dAbs).toFixed(2)}` : ""}{" "}
                  ({fmtSigned(chg1dPct, 2, "%")}) 今日 1D
                </span>
                {detail?.technicals.as_of_date && (
                  <span className="font-mono text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    最新日线 {detail.technicals.as_of_date}
                  </span>
                )}
              </div>

              {/* Multi-Horizon Pills */}
              {detail?.metrics && (
                <div className="flex flex-wrap items-center gap-2 pt-1 font-mono text-xs tabular-nums">
                  {(
                    [
                      { label: "5日", val: detail.metrics.change_5d_pct },
                      { label: "1月", val: detail.metrics.change_1m_pct },
                      { label: "6月", val: detail.metrics.change_6m_pct },
                      { label: "年内 YTD", val: detail.metrics.change_ytd_pct },
                    ] as const
                  ).map((h) => (
                    <span
                      key={h.label}
                      className="rounded-lg border border-zinc-200 bg-white/90 px-2.5 py-1 dark:border-white/15 dark:bg-white/[0.05]"
                    >
                      <span className="mr-1.5 font-medium text-zinc-700 dark:text-zinc-300">
                        {h.label}
                      </span>
                      <span
                        className={`font-bold ${
                          h.val == null
                            ? "text-zinc-700 dark:text-zinc-300"
                            : h.val >= 0
                              ? "text-emerald-700 dark:text-emerald-400"
                              : "text-rose-700 dark:text-rose-400"
                        }`}
                      >
                        {fmtSigned(h.val, 2, "%")}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Persistent Action Toolbar */}
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              disabled={togglingWatch}
              onClick={async () => {
                setTogglingWatch(true);
                try {
                  await onToggleWatchlist(symbol);
                } finally {
                  setTogglingWatch(false);
                }
              }}
              className={`inline-flex items-center gap-1.5 rounded-full border px-4 py-2 font-mono text-xs font-semibold transition ${
                isWatched
                  ? "border-amber-500 bg-amber-50 text-amber-900 dark:border-amber-400/50 dark:bg-amber-500/20 dark:text-amber-200"
                  : "border-zinc-300 bg-white text-zinc-900 hover:border-zinc-950 dark:border-white/20 dark:bg-zinc-900 dark:text-zinc-100"
              }`}
            >
              <Star className={`h-3.5 w-3.5 ${isWatched ? "fill-current" : ""}`} />
              {isWatched ? "已加入关注" : "+ 加入关注列表"}
            </button>

            <button
              type="button"
              onClick={() => onOpenAiDrawer(symbol)}
              className="inline-flex items-center gap-1.5 rounded-full border border-emerald-600/40 bg-emerald-700 px-4 py-2 font-mono text-xs font-semibold text-white transition hover:bg-emerald-600"
            >
              <Sparkles className="h-3.5 w-3.5" />
              AI 深度协查 {symbol}
            </button>

            <button
              type="button"
              onClick={() => onOpenCopilot(symbol)}
              className="inline-flex items-center gap-1.5 rounded-full bg-zinc-950 px-4 py-2 font-mono text-xs font-semibold text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              风控试算 &amp; 下单 →
            </button>
          </div>
        </div>
      </SpotlightBlock>

      {/* Block 2: Primary Candlestick Workbench (8 col) + Valuation/52W Bento Panel (4 col) */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        <SpotlightBlock tone="obsidian" className="space-y-4 p-5 sm:p-6 xl:col-span-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-mono text-xs font-semibold tracking-wider text-zinc-700 dark:text-zinc-200">
              <Activity className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              PRICE STRUCTURE &amp; TECHNICALS · K线量价与均线结构
            </div>
            <span className="rounded-lg border border-zinc-200 bg-zinc-100 px-3 py-1 font-mono text-xs font-medium text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
              {formatVolumePriceTag(detail?.technicals.volume_price_tag)}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-xl border border-zinc-200/90 bg-zinc-50/90 p-3 font-mono text-xs tabular-nums dark:border-zinc-800 dark:bg-zinc-950/75 sm:grid-cols-6">
            <div>
              <span className="block text-zinc-600 dark:text-zinc-300">RSI(14)</span>
              <span className="mt-0.5 block text-sm font-bold text-zinc-950 dark:text-white">
                {detail?.technicals.rsi_14 != null ? detail.technicals.rsi_14.toFixed(1) : "—"}
              </span>
            </div>
            <div>
              <span className="block text-zinc-600 dark:text-zinc-300">RVOL(20)</span>
              <span className="mt-0.5 block text-sm font-bold text-zinc-950 dark:text-white">
                {detail?.technicals.rvol_20 != null ? `${detail.technicals.rvol_20.toFixed(2)}x` : "—"}
              </span>
            </div>
            <div>
              <span className="block text-zinc-600 dark:text-zinc-300">ATR(14)%</span>
              <span className="mt-0.5 block text-sm font-bold text-zinc-950 dark:text-white">
                {detail?.technicals.atr_pct != null ? `${detail.technicals.atr_pct.toFixed(2)}%` : "—"}
              </span>
            </div>
            <div>
              <span className="block text-zinc-600 dark:text-zinc-300">距 50 日线</span>
              <span
                className={`mt-0.5 block text-sm font-bold ${
                  (detail?.technicals.dist_50ma_pct ?? 0) >= 0
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-rose-700 dark:text-rose-400"
                }`}
              >
                {fmtSigned(detail?.technicals.dist_50ma_pct, 2, "%")}
              </span>
            </div>
            <div>
              <span className="block text-zinc-600 dark:text-zinc-300">距 200 日线</span>
              <span
                className={`mt-0.5 block text-sm font-bold ${
                  (detail?.technicals.dist_200ma_pct ?? 0) >= 0
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-rose-700 dark:text-rose-400"
                }`}
              >
                {fmtSigned(detail?.technicals.dist_200ma_pct, 2, "%")}
              </span>
            </div>
            <div>
              <span className="block text-zinc-600 dark:text-zinc-300">MACD 柱</span>
              <span
                className={`mt-0.5 block text-sm font-bold ${
                  (detail?.technicals.macd?.histogram ?? 0) >= 0
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-rose-700 dark:text-rose-400"
                }`}
              >
                {detail?.technicals.macd?.histogram != null
                  ? detail.technicals.macd.histogram.toFixed(3)
                  : "—"}
              </span>
            </div>
          </div>

          {loading ? (
            <div className="flex h-[410px] items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 font-mono text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
              正在加载 {symbol} 历史日线与期权结构...
            </div>
          ) : (
            <AssetCandlestickChart
              theme={theme}
              symbol={symbol}
              bars={detail?.bars ?? []}
              gex={detail?.options_gex}
              height={410}
            />
          )}
        </SpotlightBlock>

        {/* Right: Valuation & Market Mechanics Snapshot (Koyfin / Yahoo Standard) */}
        <SpotlightBlock tone="gallery" className="flex flex-col justify-between space-y-5 p-5 sm:p-6 xl:col-span-4">
          <div className="space-y-4">
            <div className="font-mono text-xs font-semibold tracking-wider text-zinc-700 dark:text-zinc-300">
              KEY STATISTICS · 核心估值与交易指标
            </div>

            {/* 52-Week Range Slider Gauge */}
            {pos52Pct !== null && low52 != null && high52 != null && (
              <div className="space-y-2 rounded-2xl border border-zinc-200 bg-white/90 p-4 dark:border-white/15 dark:bg-white/[0.05]">
                <div className="flex items-center justify-between font-mono text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                  <span>52 周区间位置</span>
                  <span>{pos52Pct.toFixed(0)}%</span>
                </div>
                <div className="relative h-2.5 w-full rounded-full bg-zinc-200 dark:bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-zinc-950 dark:bg-emerald-400"
                    style={{ width: `${pos52Pct}%` }}
                  />
                  <span
                    className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-zinc-950 shadow dark:border-zinc-950 dark:bg-white"
                    style={{ left: `${pos52Pct}%` }}
                  />
                </div>
                <div className="flex justify-between font-mono text-xs font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
                  <span>低 {fmtUsd(low52)}</span>
                  <span>高 {fmtUsd(high52)}</span>
                </div>
              </div>
            )}

            {/* Structured Two-Column Bento Metrics Table */}
            <div className="divide-y divide-zinc-200/85 rounded-2xl border border-zinc-200 bg-white/90 px-4 dark:divide-white/10 dark:border-white/15 dark:bg-white/[0.04]">
              {(
                [
                  { label: "今开 Open", value: fmtUsd(detail?.metrics?.open) },
                  { label: "昨收 Prev Close", value: fmtUsd(detail?.metrics?.prev_close) },
                  {
                    label: "当日振幅 Day Range",
                    value: detail?.metrics
                      ? `${fmtUsd(detail.metrics.day_low)} - ${fmtUsd(detail.metrics.day_high)}`
                      : "—",
                  },
                  { label: "总市值 Market Cap", value: fmtCapB(detail?.profile?.market_cap_b) },
                  {
                    label: "市盈率 P/E (TTM)",
                    value:
                      detail?.metrics?.pe_ttm != null
                        ? `${detail.metrics.pe_ttm.toFixed(2)}x`
                        : "—",
                  },
                  {
                    label: "市净率 P/B",
                    value: detail?.metrics?.pb != null ? `${detail.metrics.pb.toFixed(2)}x` : "—",
                  },
                  {
                    label: "Beta 波动系数",
                    value: detail?.metrics?.beta != null ? detail.metrics.beta.toFixed(2) : "—",
                  },
                  {
                    label: "股息率 Div Yield",
                    value:
                      detail?.metrics?.dividend_yield != null
                        ? `${detail.metrics.dividend_yield.toFixed(2)}%`
                        : "—",
                  },
                  { label: "最近成交量 Volume", value: fmtVol(detail?.metrics?.volume) },
                  { label: "10日均量 Avg Vol", value: fmtVol(detail?.metrics?.avg_vol_10d) },
                ] as const
              ).map((row) => (
                <div
                  key={row.label}
                  className="flex items-center justify-between py-2.5 text-sm"
                >
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">{row.label}</span>
                  <span className="font-mono font-bold tabular-nums text-zinc-950 dark:text-zinc-50">
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {detail?.profile?.weburl && (
            <a
              href={detail.profile.weburl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-between rounded-xl border border-zinc-300 bg-white px-4 py-2.5 font-mono text-xs font-semibold text-zinc-900 transition hover:border-zinc-950 dark:border-white/20 dark:bg-zinc-900 dark:text-zinc-100"
            >
              <span>公司官网 / IPO {detail.profile.ipo || ""}</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </SpotlightBlock>
      </div>

      {/* Block 3: Dense 3-Column Deep Dive Grid (GEX Wall + Analyst/EPS + SEC/Headlines) */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <SpotlightBlock tone="obsidian" className="space-y-3 p-4 sm:p-5 xl:col-span-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-mono text-xs font-semibold tracking-wider text-zinc-700 dark:text-zinc-200">
              <BarChart3 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              OPTIONS DEALER GEX WALL · 期权做市商伽马分布
            </div>
            <span className="font-mono text-xs text-zinc-600 dark:text-zinc-300">
              {detail?.options_gex ? `OI 分析 ${detail.options_gex.put_call_ratio?.toFixed(2) ?? "—"} P/C` : "无期权链"}
            </span>
          </div>

          {detail?.options_gex ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl border border-zinc-200/90 bg-zinc-50/90 p-3 dark:border-zinc-800 dark:bg-zinc-950/75">
                  <span className="block font-mono text-xs text-zinc-600 dark:text-zinc-300">净伽马 Net GEX</span>
                  <span
                    className={`mt-1 block font-mono text-lg font-bold tabular-nums ${
                      detail.options_gex.net_gex >= 0
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-rose-700 dark:text-rose-400"
                    }`}
                  >
                    {fmtBillions(detail.options_gex.net_gex)}
                  </span>
                </div>
                <div className="rounded-xl border border-zinc-200/90 bg-zinc-50/90 p-3 dark:border-zinc-800 dark:bg-zinc-950/75">
                  <span className="block font-mono text-xs text-zinc-600 dark:text-zinc-300">Call Wall</span>
                  <span className="mt-1 block font-mono text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                    {detail.options_gex.call_wall != null ? fmtUsd(detail.options_gex.call_wall, 0) : "—"}
                  </span>
                </div>
                <div className="rounded-xl border border-zinc-200/90 bg-zinc-50/90 p-3 dark:border-zinc-800 dark:bg-zinc-950/75">
                  <span className="block font-mono text-xs text-zinc-600 dark:text-zinc-300">Put Wall</span>
                  <span className="mt-1 block font-mono text-lg font-bold tabular-nums text-rose-700 dark:text-rose-400">
                    {detail.options_gex.put_wall != null ? fmtUsd(detail.options_gex.put_wall, 0) : "—"}
                  </span>
                </div>
                <div className="rounded-xl border border-zinc-200/90 bg-zinc-50/90 p-3 dark:border-zinc-800 dark:bg-zinc-950/75">
                  <span className="block font-mono text-xs text-zinc-600 dark:text-zinc-300">Zero Gamma</span>
                  <span className="mt-1 block font-mono text-lg font-bold tabular-nums text-amber-700 dark:text-amber-300">
                    {detail.options_gex.zero_gamma != null ? fmtUsd(detail.options_gex.zero_gamma, 2) : "—"}
                  </span>
                </div>
              </div>
              <GexProfileChart
                profile={detail.options_gex.strike_profile ?? []}
                spotPrice={detail.options_gex.spot_price}
                callWall={detail.options_gex.call_wall}
                putWall={detail.options_gex.put_wall}
                zeroGamma={detail.options_gex.zero_gamma}
                height={220}
              />
            </>
          ) : (
            <div className="flex h-[240px] items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 px-6 text-center text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-300">
              {symbol} 暂未检测到美股期权 GEX 快照，请重点参考左侧 K 线均线与右侧估值指标。
            </div>
          )}
        </SpotlightBlock>

        {/* Analyst Consensus + Quarterly EPS History */}
        <SpotlightBlock tone="gallery" className="space-y-4 p-4 sm:p-5 xl:col-span-4">
          <div className="flex items-center gap-2 font-mono text-xs font-semibold tracking-wider text-zinc-700 dark:text-zinc-300">
            <Layers className="h-4 w-4" />
            ANALYST CONSENSUS &amp; EPS SURPRISE · 华尔街一致预期与财报超预期表现
          </div>

          {latestRec && recTotal > 0 ? (
            <div className="space-y-2.5 rounded-2xl border border-zinc-200 bg-white/90 p-4 dark:border-white/15 dark:bg-white/[0.04]">
              <div className="flex items-center justify-between font-mono text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                <span>华尔街机构评级 ({latestRec.period})</span>
                <span>共 {recTotal} 位分析师</span>
              </div>
              <div className="flex h-3 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div
                  className="bg-emerald-700"
                  style={{ width: `${(latestRec.strong_buy / recTotal) * 100}%` }}
                />
                <div
                  className="bg-emerald-500"
                  style={{ width: `${(latestRec.buy / recTotal) * 100}%` }}
                />
                <div
                  className="bg-amber-400"
                  style={{ width: `${(latestRec.hold / recTotal) * 100}%` }}
                />
                <div
                  className="bg-rose-500"
                  style={{ width: `${((latestRec.sell + latestRec.strong_sell) / recTotal) * 100}%` }}
                />
              </div>
              <div className="flex flex-wrap gap-3 font-mono text-xs font-semibold tabular-nums text-zinc-800 dark:text-zinc-200">
                <span className="text-emerald-700 dark:text-emerald-400">
                  强力买入 {latestRec.strong_buy}
                </span>
                <span className="text-emerald-700 dark:text-emerald-300">
                  买入 {latestRec.buy}
                </span>
                <span className="text-amber-700 dark:text-amber-300">
                  持有 {latestRec.hold}
                </span>
                <span className="text-rose-700 dark:text-rose-400">
                  卖出 {latestRec.sell + latestRec.strong_sell}
                </span>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-200 bg-white/80 p-3.5 text-sm text-zinc-700 dark:border-white/15 dark:bg-white/[0.04] dark:text-zinc-300">
              ETF / 加密资产不适用公司分析师买/卖评级汇总。
            </div>
          )}

          {/* EPS History */}
          <div>
            <h3 className="mb-2.5 font-mono text-xs font-semibold text-zinc-800 dark:text-zinc-200">
              近季度每股收益 (EPS) 实际 vs 一致预期
            </h3>
            {detail?.eps_history && detail.eps_history.length > 0 ? (
              <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white/90 dark:border-white/15 dark:bg-white/[0.04]">
                <table className="w-full text-left font-mono text-sm tabular-nums">
                  <thead>
                    <tr className="border-b border-zinc-200 text-xs font-semibold text-zinc-700 dark:border-white/15 dark:text-zinc-300">
                      <th className="px-3.5 py-2.5">财报期</th>
                      <th className="px-3.5 py-2.5 text-right">预期 Est</th>
                      <th className="px-3.5 py-2.5 text-right">实际 Actual</th>
                      <th className="px-3.5 py-2.5 text-right">超预期 Surprise</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200/70 dark:divide-white/10">
                    {detail.eps_history.slice(0, 5).map((ep) => {
                      const sp = ep.surprise_percent ?? 0;
                      return (
                        <tr key={ep.period}>
                          <td className="px-3.5 py-2 font-semibold text-zinc-900 dark:text-zinc-100">
                            {ep.period}
                          </td>
                          <td className="px-3.5 py-2 text-right text-zinc-800 dark:text-zinc-200">
                            {fmtUsd(ep.estimate)}
                          </td>
                          <td className="px-3.5 py-2 text-right font-bold text-zinc-950 dark:text-white">
                            {fmtUsd(ep.actual)}
                          </td>
                          <td
                            className={`px-3.5 py-2 text-right font-bold ${
                              sp >= 0
                                ? "text-emerald-700 dark:text-emerald-400"
                                : "text-rose-700 dark:text-rose-400"
                            }`}
                          >
                            {fmtSigned(ep.surprise_percent, 2, "%")}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="rounded-xl border border-zinc-200 bg-white/80 p-4 text-sm text-zinc-700 dark:border-white/15 dark:bg-white/[0.04] dark:text-zinc-300">
                当前标的暂无公开季度 EPS 超预期记录。
              </div>
            )}
          </div>
        </SpotlightBlock>
      {/* Block 4 -> Consolidated 3rd Column in Dense 12-Col Bento Grid: SEC + News */}
        <SpotlightBlock tone="gallery" className="space-y-3.5 p-4 sm:p-5 xl:col-span-4">
          <div className="flex items-center gap-2 font-mono text-xs font-semibold tracking-wider text-zinc-700 dark:text-zinc-300">
            <FileText className="h-4 w-4" />
            SEC 10-K / 10-Q 与实时快讯 ({symbol})
          </div>

          <div className="flex flex-wrap gap-2">
            {[
              "revenue growth gross margin outlook",
              "risk factors competitive headwinds",
              "capital expenditures share repurchase cash flow",
            ].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => void handleSecSearch(preset)}
                className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1 font-mono text-xs font-medium text-zinc-800 transition hover:border-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-200"
              >
                {preset}
              </button>
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSecSearch(secQuery);
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={secQuery}
              onChange={(e) => setSecQuery(e.target.value)}
              placeholder={`检索 ${symbol} 10-K/10-Q 财报段落...`}
              className="flex-1 rounded-xl border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-950 placeholder:text-zinc-500 focus:border-zinc-950 focus:outline-none dark:border-white/20 dark:bg-zinc-900 dark:text-zinc-100"
            />
            <button
              type="submit"
              disabled={secLoading || !secQuery.trim()}
              className="rounded-xl bg-zinc-950 px-4 py-2 font-mono text-xs font-semibold text-white disabled:opacity-45 dark:bg-white dark:text-zinc-950"
            >
              {secLoading ? "检索中..." : "检索"}
            </button>
          </form>

          {secError && <p className="text-xs font-medium text-rose-700 dark:text-rose-300">{secError}</p>}

          {secRes && secRes.chunks.length > 0 && (
            <div className="max-h-72 space-y-2.5 overflow-y-auto pr-1">
              {secRes.chunks.map((c) => (
                <div
                  key={c.chunk_id}
                  className="rounded-xl border border-zinc-200 bg-white/90 p-3 dark:border-white/15 dark:bg-white/[0.04]"
                >
                  <div className="mb-1 flex items-center justify-between font-mono text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                    <span>
                      {c.form_type} · {c.filing_date} · {c.section_title}
                    </span>
                    <span className="text-emerald-700 dark:text-emerald-400">
                      RRF {c.rrf_score.toFixed(3)}
                    </span>
                  </div>
                  <p className="line-clamp-4 text-xs leading-relaxed text-zinc-800 dark:text-zinc-200">
                    {c.content}
                  </p>
                </div>
              ))}
            </div>
          )}

          {!secRes && (
            <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white/80 p-3 text-xs text-zinc-700 dark:border-white/15 dark:bg-white/[0.04] dark:text-zinc-300">
              <Bot className="h-4 w-4 shrink-0" />
              点击快捷词检索 {symbol} SEC EDGAR 10-K/Q 原文段落。
            </div>
          )}

          {/* Embedded Headlines right underneath in the 3rd column */}
          <div className="border-t border-zinc-200 pt-3 dark:border-white/15">
            <div className="mb-2 flex items-center justify-between font-mono text-xs font-semibold text-zinc-800 dark:text-zinc-200">
              <span className="flex items-center gap-1.5">
                <Newspaper className="h-3.5 w-3.5" />
                实时市场快讯 Headlines
              </span>
              <span>{detail?.news.length ?? 0} 条</span>
            </div>
            <div className="max-h-56 divide-y divide-zinc-200/80 overflow-y-auto rounded-xl border border-zinc-200 bg-white/85 dark:divide-white/10 dark:border-white/15 dark:bg-white/[0.03]">
              {detail?.news && detail.news.length > 0 ? (
                detail.news.slice(0, 5).map((item) => (
                  <a
                    key={item.id}
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-start justify-between gap-2 px-3 py-2 text-xs transition hover:bg-zinc-100 dark:hover:bg-white/[0.05]"
                  >
                    <div className="min-w-0">
                      <div className="line-clamp-2 font-medium text-zinc-900 dark:text-zinc-100">
                        {item.headline}
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                        {item.source} · {item.created_at.slice(0, 10)}
                      </div>
                    </div>
                    <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-600 dark:text-zinc-300" />
                  </a>
                ))
              ) : (
                <div className="p-4 text-center text-xs text-zinc-700 dark:text-zinc-300">
                  当前标的暂无 Alpaca 新闻摘要。
                </div>
              )}
            </div>
          </div>
        </SpotlightBlock>
      </div>
    </main>
  );
}

"use client";

import React, { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bot,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { MarkdownReport } from "@/components/MarkdownReport";
import MiniKLineSparkline from "@/components/MiniKLineSparkline";
import SpotlightBlock from "@/components/SpotlightBlock";
import StockLogoBadge from "@/components/StockLogoBadge";
import { streamInvestigate, type WatchlistAssetItem } from "@/lib/api";

interface WatchlistWorkspaceProps {
  items: WatchlistAssetItem[];
  loading: boolean;
  mutating: boolean;
  error: string | null;
  regimeLabel?: string | null;
  onAddSymbol: (symbol: string) => Promise<void>;
  onReorderSymbols: (symbols: string[]) => Promise<void>;
  onRemoveSymbol: (symbol: string) => Promise<void>;
  onOpenStockDetail: (symbol: string) => void;
}

type SortField = "order" | "1d" | "5d" | "1m" | "6m" | "ytd";
type CompareRange = "5D" | "1M" | "6M" | "YTD" | "1Y" | "ALL";

const SERIES_PALETTE = [
  "#0f766e", // deep teal
  "#b45309", // warm bronze
  "#e11d48", // crimson
  "#7c3aed", // violet
  "#2563eb", // cobalt blue
  "#059669", // emerald
  "#c026d3", // fuchsia
  "#0284c7", // sky blue
];

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtUsd(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function sliceSeriesForRange(
  closes: { d: string; c: number }[],
  range: CompareRange
): { d: string; c: number }[] {
  if (!closes || closes.length === 0) return [];
  if (range === "ALL") return closes;
  if (range === "5D") return closes.slice(-6);
  if (range === "1M") return closes.slice(-22);
  if (range === "6M") return closes.slice(-127);
  if (range === "1Y") return closes.slice(-253);
  // YTD
  const latestYear = closes[closes.length - 1].d.slice(0, 4);
  const idx = closes.findIndex((pt) => pt.d.startsWith(latestYear));
  if (idx <= 0) return closes;
  return closes.slice(Math.max(0, idx - 1));
}

export default function WatchlistWorkspace({
  items,
  loading,
  mutating,
  error,
  regimeLabel,
  onAddSymbol,
  onReorderSymbols,
  onRemoveSymbol,
  onOpenStockDetail,
}: WatchlistWorkspaceProps) {
  const [newTicker, setNewTicker] = useState("");
  const [manageMode, setManageMode] = useState(false);
  const [sortField, setSortField] = useState<SortField>("order");
  const [sortAsc, setSortAsc] = useState(false);
  const [range, setRange] = useState<CompareRange>("YTD");
  const [hiddenSymbols, setHiddenSymbols] = useState<Set<string>>(new Set());
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Optional DeepSeek live watchlist diagnostic
  const [aiReport, setAiReport] = useState("");
  const [aiRunning, setAiRunning] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const sym = newTicker.trim().toUpperCase();
    if (!sym) return;
    await onAddSymbol(sym);
    setNewTicker("");
  };

  const handleSortClick = (field: SortField) => {
    if (sortField === field) {
      setSortAsc((v) => !v);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const sortedItems = useMemo(() => {
    if (sortField === "order") return items;
    const keyMap: Record<Exclude<SortField, "order">, keyof WatchlistAssetItem> = {
      "1d": "change_1d_pct",
      "5d": "change_5d_pct",
      "1m": "change_1m_pct",
      "6m": "change_6m_pct",
      ytd: "change_ytd_pct",
    };
    const key = keyMap[sortField];
    return [...items].sort((a, b) => {
      const av = typeof a[key] === "number" ? (a[key] as number) : -9999;
      const bv = typeof b[key] === "number" ? (b[key] as number) : -9999;
      return sortAsc ? av - bv : bv - av;
    });
  }, [items, sortAsc, sortField]);

  const moveOrder = async (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = items.map((x) => x.symbol);
    [next[index], next[target]] = [next[target], next[index]];
    await onReorderSymbols(next);
  };

  // Zero-latency quantitative narrative brief modeled cleanly after Figure 4
  const quantSummary = useMemo(() => {
    if (items.length === 0) return null;
    const valid1d = items.filter((i) => typeof i.change_1d_pct === "number");
    const avg1d =
      valid1d.length > 0
        ? valid1d.reduce((acc, i) => acc + (i.change_1d_pct ?? 0), 0) / valid1d.length
        : 0;
    const sorted1d = [...valid1d].sort(
      (a, b) => (b.change_1d_pct ?? 0) - (a.change_1d_pct ?? 0)
    );
    const leader = sorted1d[0];
    const laggard = sorted1d[sorted1d.length - 1];
    const oversold = items.filter((i) => (i.rsi_14 ?? 50) <= 32);
    const overbought = items.filter((i) => (i.rsi_14 ?? 50) >= 70);
    return { avg1d, leader, laggard, oversold, overbought };
  }, [items]);

  // Multi-line Normalized % Comparison Computation (Figure 5)
  const comparisonData = useMemo(() => {
    const visibleItems = items.filter((it) => !hiddenSymbols.has(it.symbol));
    const perStock = items.map((item, colorIdx) => {
      const sliced = sliceSeriesForRange(item.daily_closes, range);
      const baseClose = sliced[0]?.c ?? item.price;
      const latestClose = sliced[sliced.length - 1]?.c ?? item.price;
      const absDelta = latestClose - baseClose;
      const pctDelta = baseClose > 0 ? ((latestClose / baseClose) - 1) * 100 : 0;
      const points = sliced.map((pt) => ({
        d: pt.d,
        pct: baseClose > 0 ? ((pt.c / baseClose) - 1) * 100 : 0,
      }));
      return {
        item,
        color: SERIES_PALETTE[colorIdx % SERIES_PALETTE.length],
        hidden: hiddenSymbols.has(item.symbol),
        absDelta,
        pctDelta,
        points,
      };
    });

    // Align X axis by shared dates across longest visible series
    const longest = perStock
      .filter((s) => !s.hidden && s.points.length > 0)
      .sort((a, b) => b.points.length - a.points.length)[0];
    const dates = longest ? longest.points.map((p) => p.d) : [];

    let minPct = 0;
    let maxPct = 0;
    for (const s of perStock) {
      if (s.hidden) continue;
      for (const p of s.points) {
        if (p.pct < minPct) minPct = p.pct;
        if (p.pct > maxPct) maxPct = p.pct;
      }
    }
    const pad = Math.max(2, (maxPct - minPct) * 0.12);
    minPct = Math.min(-2, minPct - pad);
    maxPct = Math.max(2, maxPct + pad);

    return {
      visibleCount: visibleItems.length,
      perStock,
      dates,
      minPct,
      maxPct,
    };
  }, [hiddenSymbols, items, range]);

  const handleRunAiBrief = async () => {
    if (aiRunning || items.length === 0) return;
    setAiRunning(true);
    setAiReport("");
    setAiError(null);
    const summaryInput = items
      .map(
        (it) =>
          `${it.symbol} (${it.name}): 现价 $${it.price.toFixed(2)}, 1D ${fmtPct(it.change_1d_pct)}, 1M ${fmtPct(it.change_1m_pct)}, YTD ${fmtPct(it.change_ytd_pct)}, RSI(14) ${it.rsi_14 ?? "—"}`
      )
      .join("\n");
    try {
      await streamInvestigate(
        {
          thread_id: `watchlist-${Date.now()}`,
          symbol: items[0].symbol,
          query: `当前宏观体制：${regimeLabel || "UNKNOWN"}。请作为高级机构组合策略师，对我的自选关注列表进行整体复盘与风险对比点评（聚焦强弱分化、RSI超买超卖、仓位集中度与近期观察重点）：\n${summaryInput}`,
        },
        (ev) => {
          if (ev.event === "token" && typeof ev.data.text === "string") {
            setAiReport((prev) => prev + ev.data.text);
          } else if (ev.event === "final" && typeof ev.data.report_markdown === "string") {
            setAiReport(ev.data.report_markdown);
          } else if (ev.event === "error") {
            setAiError(String(ev.data.message || "AI 诊断失败"));
          }
        }
      );
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "AI 诊断请求异常");
    } finally {
      setAiRunning(false);
    }
  };

  const chartW = 1040;
  const chartH = 260;
  const padL = 48;
  const padR = 16;
  const padT = 16;
  const padB = 26;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;
  const spanPct = Math.max(0.01, comparisonData.maxPct - comparisonData.minPct);
  const mapPctY = (val: number) =>
    padT + ((comparisonData.maxPct - val) / spanPct) * plotH;
  const zeroY = mapPctY(0);

  return (
    <main className="mx-auto w-full max-w-[1860px] space-y-4 px-4 pt-3 sm:px-6 lg:px-8">
      {/* Compact Header + Executive Brief Bar */}
      <SpotlightBlock tone="gallery" className="space-y-3.5 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="font-mono text-xs font-semibold tracking-wider text-zinc-700 dark:text-zinc-300">
              PORTFOLIO WATCHLIST · 我的自选关注分析台
            </div>
            <h1 className="mt-1 font-serif text-2xl font-medium tracking-tight text-zinc-950 dark:text-zinc-50 sm:text-3xl">
              我的关注列表 ({items.length})
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <form onSubmit={handleAddSubmit} className="flex items-center gap-2">
              <div className="relative">
                <Plus className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600 dark:text-zinc-300" />
                <input
                  type="text"
                  value={newTicker}
                  onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
                  placeholder="添加股票代码..."
                  className="w-40 rounded-xl border border-zinc-300 bg-white py-1.5 pl-9 pr-3 font-mono text-sm text-zinc-950 placeholder:text-zinc-500 focus:border-zinc-950 focus:outline-none dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-400 sm:w-48"
                />
              </div>
              <button
                type="submit"
                disabled={mutating || !newTicker.trim()}
                className="rounded-xl bg-zinc-950 px-3.5 py-1.5 font-mono text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-45 dark:bg-white dark:text-zinc-950"
              >
                + 添加
              </button>
            </form>

            <button
              type="button"
              onClick={() => setManageMode((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 font-mono text-xs font-medium transition ${
                manageMode
                  ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
                  : "border-zinc-300 bg-white text-zinc-800 hover:border-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-100"
              }`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {manageMode ? "完成管理" : "管理关注列表"}
            </button>

            <button
              type="button"
              onClick={handleRunAiBrief}
              disabled={aiRunning || items.length === 0}
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-700 px-3.5 py-1.5 font-mono text-xs font-semibold text-white transition hover:bg-emerald-600 disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {aiRunning ? "正在分析关注列表..." : "AI 深度简评"}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/40 dark:text-rose-200">
            {error}
          </div>
        )}

        {/* Executive Watchlist Narrative Summary with Clickable Inline Pills (Figure 4) */}
        {quantSummary && (
          <div className="space-y-2.5 rounded-2xl border border-zinc-200/90 bg-white/85 p-4 text-sm leading-relaxed text-zinc-900 dark:border-white/15 dark:bg-white/[0.04] dark:text-zinc-100 sm:p-5">
            <p>
              当前自选组合共关注{" "}
              <strong className="font-mono font-bold">{items.length}</strong>{" "}
              只核心标的，今日等权平均涨跌幅{" "}
              <span
                className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-xs font-bold ${
                  quantSummary.avg1d >= 0
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300"
                    : "bg-rose-100 text-rose-800 dark:bg-rose-950/70 dark:text-rose-300"
                }`}
              >
                {quantSummary.avg1d >= 0 ? "↗" : "↘"} {fmtPct(quantSummary.avg1d)}
              </span>
              {quantSummary.leader && (
                <>
                  。表现最强为{" "}
                  <button
                    type="button"
                    onClick={() => onOpenStockDetail(quantSummary.leader.symbol)}
                    className="font-semibold text-zinc-950 underline decoration-zinc-400 underline-offset-2 hover:decoration-zinc-950 dark:text-white"
                  >
                    {quantSummary.leader.name} ({quantSummary.leader.symbol})
                  </button>{" "}
                  <span
                    className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-xs font-bold ${
                      (quantSummary.leader.change_1d_pct ?? 0) >= 0
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300"
                        : "bg-rose-100 text-rose-800 dark:bg-rose-950/70 dark:text-rose-300"
                    }`}
                  >
                    {(quantSummary.leader.change_1d_pct ?? 0) >= 0 ? "↗" : "↘"}{" "}
                    {fmtPct(quantSummary.leader.change_1d_pct)}
                  </span>{" "}
                  最新报 <strong className="font-mono">{fmtUsd(quantSummary.leader.price)}</strong>
                </>
              )}
              {quantSummary.laggard && quantSummary.laggard.symbol !== quantSummary.leader?.symbol && (
                <>
                  ；相对承压为{" "}
                  <button
                    type="button"
                    onClick={() => onOpenStockDetail(quantSummary.laggard.symbol)}
                    className="font-semibold text-zinc-950 underline decoration-zinc-400 underline-offset-2 hover:decoration-zinc-950 dark:text-white"
                  >
                    {quantSummary.laggard.name} ({quantSummary.laggard.symbol})
                  </button>{" "}
                  <span
                    className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-xs font-bold ${
                      (quantSummary.laggard.change_1d_pct ?? 0) >= 0
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300"
                        : "bg-rose-100 text-rose-800 dark:bg-rose-950/70 dark:text-rose-300"
                    }`}
                  >
                    {(quantSummary.laggard.change_1d_pct ?? 0) >= 0 ? "↗" : "↘"}{" "}
                    {fmtPct(quantSummary.laggard.change_1d_pct)}
                  </span>{" "}
                  现价 <strong className="font-mono">{fmtUsd(quantSummary.laggard.price)}</strong>。
                </>
              )}
            </p>

            {(quantSummary.oversold.length > 0 || quantSummary.overbought.length > 0) && (
              <p className="text-zinc-800 dark:text-zinc-200">
                动量信号监测：
                {quantSummary.oversold.length > 0 && (
                  <span>
                    RSI(14) ≤ 32 进入超卖警示区：{" "}
                    <strong className="font-mono">
                      {quantSummary.oversold.map((s) => `${s.symbol} (${s.rsi_14?.toFixed(1)})`).join(" · ")}
                    </strong>
                    。
                  </span>
                )}
                {quantSummary.overbought.length > 0 && (
                  <span>
                    {" "}
                    RSI(14) ≥ 70 偏强区：{" "}
                    <strong className="font-mono">
                      {quantSummary.overbought.map((s) => `${s.symbol} (${s.rsi_14?.toFixed(1)})`).join(" · ")}
                    </strong>
                    。
                  </span>
                )}
              </p>
            )}
          </div>
        )}

        {(aiReport || aiError) && (
          <div className="rounded-2xl border border-emerald-500/30 bg-zinc-950 p-4 text-zinc-100">
            <div className="mb-2 flex items-center gap-2 font-mono text-xs font-semibold text-emerald-400">
              <Bot className="h-4 w-4" />
              DeepSeek AI 自选股联合诊断
            </div>
            {aiError ? (
              <p className="text-sm text-rose-300">{aiError}</p>
            ) : (
              <MarkdownReport content={aiReport} />
            )}
          </div>
        )}

        {/* Side-by-Side Single-Screen Workspace Grid: Multi-Horizon Table (Left 6) + Comparison Chart (Right 6) */}
      </SpotlightBlock>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <SpotlightBlock tone="gallery" className="overflow-hidden p-4 xl:col-span-6">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-mono text-xs font-semibold tracking-wider text-zinc-700 dark:text-zinc-200">
              MULTI-HORIZON MATRIX · 多周期收益与动量明细
            </span>
            <span className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
              点击行跳转个股页
            </span>
          </div>
          <div className="overflow-x-auto rounded-xl border border-zinc-200/90 bg-white/85 dark:border-white/15 dark:bg-white/[0.03]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-200 font-mono text-xs font-semibold text-zinc-700 dark:border-white/15 dark:text-zinc-300">
                  <th className="px-3 py-2.5">标的资产</th>
                  <th className="px-2 py-2.5 text-center">K线</th>
                  <th className="px-2.5 py-2.5 text-right">最新价</th>
                  {(
                    [
                      { f: "1d", label: "1天" },
                      { f: "5d", label: "5日" },
                      { f: "1m", label: "1月" },
                      { f: "6m", label: "6月" },
                      { f: "ytd", label: "YTD" },
                    ] as const
                  ).map((col) => (
                    <th key={col.f} className="px-2 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => handleSortClick(col.f)}
                        className={`inline-flex items-center gap-0.5 hover:text-zinc-950 dark:hover:text-white ${
                          sortField === col.f ? "font-bold text-zinc-950 dark:text-white" : ""
                        }`}
                      >
                        <span>{col.label}</span>
                        <ArrowUpDown className="h-3 w-3" />
                      </button>
                    </th>
                  ))}
                  <th className="px-2 py-2.5 text-right">RSI</th>
                  {manageMode && <th className="px-2.5 py-2.5 text-right">操作</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200/75 font-mono text-xs tabular-nums dark:divide-white/[0.08]">
                {loading && sortedItems.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-zinc-700 dark:text-zinc-300">
                      加载关注列表中...
                    </td>
                  </tr>
                ) : (
                  sortedItems.map((item) => {
                    const origIdx = items.findIndex((x) => x.symbol === item.symbol);
                    const isUp1d = (item.change_1d_pct ?? 0) >= 0;
                    const horizons = [
                      item.change_1d_pct,
                      item.change_5d_pct,
                      item.change_1m_pct,
                      item.change_6m_pct,
                      item.change_ytd_pct,
                    ];
                    return (
                      <tr
                        key={item.symbol}
                        onClick={() => onOpenStockDetail(item.symbol)}
                        className="cursor-pointer transition-colors hover:bg-zinc-100/80 dark:hover:bg-white/[0.06]"
                      >
                        <td className="px-3 py-2.5 font-sans">
                          <div className="flex items-center gap-2.5">
                            <StockLogoBadge symbol={item.symbol} size={30} />
                            <div className="min-w-0">
                              <div className="max-w-[145px] truncate text-sm font-semibold text-zinc-950 dark:text-zinc-50">
                                {item.name}
                              </div>
                              <div className="font-mono text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                                {item.symbol} · {item.exchange}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <div className="flex justify-center">
                            <MiniKLineSparkline
                              bars={item.sparkline_bars}
                              prevClose={item.prev_close}
                              isUp={isUp1d}
                              width={56}
                              height={22}
                            />
                          </div>
                        </td>
                        <td className="px-2.5 py-2.5 text-right text-sm font-bold text-zinc-950 dark:text-zinc-50">
                          {fmtUsd(item.price)}
                        </td>
                        {horizons.map((val, hIdx) => (
                          <td
                            key={hIdx}
                            className={`px-2 py-2.5 text-right font-semibold ${
                              val === null || val === undefined
                                ? "text-zinc-600 dark:text-zinc-300"
                                : val >= 0
                                  ? "text-emerald-700 dark:text-emerald-400"
                                  : "text-rose-700 dark:text-rose-400"
                            }`}
                          >
                            {fmtPct(val)}
                          </td>
                        ))}
                        <td className="px-2 py-2.5 text-right font-semibold text-zinc-800 dark:text-zinc-200">
                          {item.rsi_14 != null ? item.rsi_14.toFixed(1) : "—"}
                        </td>
                        {manageMode && (
                          <td
                            className="px-2.5 py-2.5 text-right"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="inline-flex items-center gap-1">
                              {origIdx >= 0 && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => void moveOrder(origIdx, -1)}
                                    disabled={mutating || origIdx === 0}
                                    title="上移"
                                    className="rounded border border-zinc-300 bg-white p-1 text-zinc-800 disabled:opacity-35 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-100"
                                  >
                                    <ArrowUp className="h-3 w-3" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void moveOrder(origIdx, 1)}
                                    disabled={mutating || origIdx === items.length - 1}
                                    title="下移"
                                    className="rounded border border-zinc-300 bg-white p-1 text-zinc-800 disabled:opacity-35 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-100"
                                  >
                                    <ArrowDown className="h-3 w-3" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void onRemoveSymbol(item.symbol)}
                                    disabled={mutating}
                                    title="删除"
                                    className="rounded border border-rose-300 bg-rose-50 p-1 text-rose-700 dark:border-rose-500/40 dark:bg-rose-950/60 dark:text-rose-300"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </SpotlightBlock>

        {/* Right Side: Normalized Multi-Stock Percentage Comparison Chart (Figure 5) */}
        <SpotlightBlock tone="gallery" className="space-y-3 p-4 xl:col-span-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-mono text-xs font-semibold tracking-wider text-zinc-700 dark:text-zinc-300">
              PERFORMANCE COMPARISON · 归一化收益率曲线
            </div>
            <h2 className="mt-1 font-serif text-xl font-medium text-zinc-950 dark:text-zinc-50 sm:text-2xl">
              自选股涨跌幅
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-zinc-300/90 bg-white/90 p-1 font-mono text-xs dark:border-white/15 dark:bg-zinc-900">
            {(["5D", "1M", "6M", "YTD", "1Y", "ALL"] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={`rounded-lg px-3 py-1 font-semibold transition ${
                  range === r
                    ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                    : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* SVG Normalized % Multi-Curve Chart */}
        {comparisonData.dates.length > 1 ? (
          <div className="relative overflow-hidden rounded-2xl border border-zinc-200/90 bg-white/85 p-3 dark:border-white/15 dark:bg-zinc-950/65">
            <svg
              viewBox={`0 0 ${chartW} ${chartH}`}
              className="h-[260px] w-full select-none"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = (e.clientX - rect.left) / Math.max(rect.width, 1);
                const svgX = ratio * chartW;
                const rel = Math.max(0, Math.min(1, (svgX - padL) / plotW));
                const idx = Math.round(rel * (comparisonData.dates.length - 1));
                setHoverIdx(idx);
              }}
              onMouseLeave={() => setHoverIdx(null)}
            >
              {/* Horizontal Percentage Gridlines */}
              {[comparisonData.maxPct, comparisonData.maxPct / 2, 0, comparisonData.minPct / 2, comparisonData.minPct].map(
                (tick, idx) => {
                  const yPos = mapPctY(tick);
                  const isZero = Math.abs(tick) < 0.01;
                  return (
                    <g key={idx}>
                      <line
                        x1={padL}
                        x2={chartW - padR}
                        y1={yPos}
                        y2={yPos}
                        stroke="currentColor"
                        className={
                          isZero
                            ? "text-zinc-500 dark:text-zinc-400"
                            : "text-zinc-200 dark:text-zinc-800"
                        }
                        strokeWidth={isZero ? "1.1" : "0.8"}
                        strokeDasharray={isZero ? "4 3" : "none"}
                      />
                      <text
                        x={padL - 8}
                        y={yPos + 4}
                        textAnchor="end"
                        className="fill-zinc-700 font-mono text-[11px] font-medium dark:fill-zinc-300"
                      >
                        {`${tick >= 0 ? "+" : ""}${tick.toFixed(0)}%`}
                      </text>
                    </g>
                  );
                }
              )}

              {/* X Axis Date Ticks */}
              {[0, 0.25, 0.5, 0.75, 1].map((frac, idx) => {
                const dIdx = Math.min(
                  comparisonData.dates.length - 1,
                  Math.round(frac * (comparisonData.dates.length - 1))
                );
                const xPos = padL + frac * plotW;
                return (
                  <text
                    key={idx}
                    x={xPos}
                    y={chartH - 6}
                    textAnchor={idx === 0 ? "start" : idx === 4 ? "end" : "middle"}
                    className="fill-zinc-700 font-mono text-[11px] dark:fill-zinc-300"
                  >
                    {comparisonData.dates[dIdx]?.slice(5)}
                  </text>
                );
              })}

              {/* 0% baseline marker */}
              <circle cx={padL} cy={zeroY} r="2.5" className="fill-zinc-600 dark:fill-zinc-300" />

              {/* Stock Curves */}
              {comparisonData.perStock.map((series) => {
                if (series.hidden || series.points.length < 2) return null;
                const dMap = new Map(series.points.map((p) => [p.d, p.pct]));
                const pts = comparisonData.dates
                  .map((d, i) => {
                    const val = dMap.get(d);
                    if (val === undefined) return null;
                    const x = padL + (i / Math.max(comparisonData.dates.length - 1, 1)) * plotW;
                    const y = mapPctY(val);
                    return `${x.toFixed(1)},${y.toFixed(1)}`;
                  })
                  .filter((x): x is string => x !== null);
                if (pts.length < 2) return null;
                return (
                  <path
                    key={series.item.symbol}
                    d={`M${pts.join(" L")}`}
                    fill="none"
                    stroke={series.color}
                    strokeWidth="2.2"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                );
              })}

              {/* Crosshair */}
              {hoverIdx !== null && comparisonData.dates[hoverIdx] && (
                <line
                  x1={padL + (hoverIdx / Math.max(comparisonData.dates.length - 1, 1)) * plotW}
                  x2={padL + (hoverIdx / Math.max(comparisonData.dates.length - 1, 1)) * plotW}
                  y1={padT}
                  y2={chartH - padB}
                  stroke="currentColor"
                  className="text-zinc-600 dark:text-zinc-300"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                />
              )}
            </svg>

            {hoverIdx !== null && comparisonData.dates[hoverIdx] && (
              <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-zinc-200 pt-2 font-mono text-xs text-zinc-900 dark:border-white/10 dark:text-zinc-100">
                <span className="font-bold">{comparisonData.dates[hoverIdx]}</span>
                {comparisonData.perStock
                  .filter((s) => !s.hidden)
                  .map((s) => {
                    const matched = s.points.find((p) => p.d === comparisonData.dates[hoverIdx]);
                    if (!matched) return null;
                    return (
                      <span key={s.item.symbol} className="inline-flex items-center gap-1.5">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: s.color }}
                        />
                        <span className="font-semibold">{s.item.symbol}</span>
                        <span
                          className={
                            matched.pct >= 0
                              ? "font-semibold text-emerald-700 dark:text-emerald-400"
                              : "font-semibold text-rose-700 dark:text-rose-400"
                          }
                        >
                          {fmtPct(matched.pct)}
                        </span>
                      </span>
                    );
                  })}
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-zinc-200 p-6 text-center text-sm text-zinc-700 dark:border-white/15 dark:text-zinc-300">
            正在准备多标的归一化历史序列...
          </div>
        )}

        {/* Comparison Breakdown Rows matching Figure 5 (Color Bar + Icon + $ Price + $ Delta + % Pill + Close) */}
        <div className="divide-y divide-zinc-200/80 overflow-hidden rounded-2xl border border-zinc-200/90 bg-white/85 dark:divide-white/[0.08] dark:border-white/15 dark:bg-white/[0.04]">
          {comparisonData.perStock.map(({ item, color, hidden, absDelta, pctDelta }) => {
            const isUp = pctDelta >= 0;
            const signAbs = absDelta >= 0 ? "+" : "-";
            return (
              <div
                key={item.symbol}
                className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-opacity ${
                  hidden ? "opacity-45" : ""
                }`}
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setHiddenSymbols((prev) => {
                        const next = new Set(prev);
                        if (next.has(item.symbol)) next.delete(item.symbol);
                        else next.add(item.symbol);
                        return next;
                      });
                    }}
                    title={hidden ? "点击显示曲线" : "点击隐藏/对比此曲线"}
                    className="h-9 w-1.5 shrink-0 rounded-full transition hover:scale-y-110"
                    style={{ backgroundColor: color }}
                  />
                  <StockLogoBadge symbol={item.symbol} size={36} />
                  <button
                    type="button"
                    onClick={() => onOpenStockDetail(item.symbol)}
                    className="min-w-0 text-left group"
                  >
                    <div className="truncate font-sans text-sm font-semibold text-zinc-950 group-hover:underline dark:text-zinc-50">
                      {item.name}
                    </div>
                    <div className="font-mono text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      {item.symbol} · {item.exchange}
                    </div>
                  </button>
                </div>

                <div className="flex items-center gap-4 font-mono text-sm tabular-nums sm:gap-6">
                  <span className="font-bold text-zinc-950 dark:text-zinc-50">
                    {fmtUsd(item.price)}
                  </span>
                  <span
                    className={`hidden font-semibold sm:inline ${
                      isUp
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-rose-700 dark:text-rose-400"
                    }`}
                  >
                    {`${signAbs}$${Math.abs(absDelta).toFixed(2)}`}
                  </span>
                  <span
                    className={`inline-flex min-w-[88px] items-center justify-center gap-1 rounded-lg px-2.5 py-1 text-xs font-bold ${
                      isUp
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/75 dark:text-emerald-300"
                        : "bg-rose-100 text-rose-800 dark:bg-rose-950/75 dark:text-rose-300"
                    }`}
                  >
                    {isUp ? "↗" : "↘"} {Math.abs(pctDelta).toFixed(2)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => void onRemoveSymbol(item.symbol)}
                    disabled={mutating}
                    title={`从关注列表移除 ${item.symbol}`}
                    className="rounded-full border border-zinc-300 p-1.5 text-zinc-700 transition hover:border-rose-500 hover:bg-rose-50 hover:text-rose-700 dark:border-white/20 dark:text-zinc-200 dark:hover:bg-rose-950/50"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </SpotlightBlock>
      </div>
    </main>
  );
}

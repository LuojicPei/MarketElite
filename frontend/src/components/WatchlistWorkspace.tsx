"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bot,
  Eye,
  EyeOff,
  GripVertical,
  KeyRound,
  Pin,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { MarkdownReport } from "@/components/MarkdownReport";
import MiniKLineSparkline from "@/components/MiniKLineSparkline";
import SpotlightBlock from "@/components/SpotlightBlock";
import StockLogoBadge from "@/components/StockLogoBadge";
import WatchlistPortfolioBacktester from "@/components/WatchlistPortfolioBacktester";
import WatchlistQuadrantRadar from "@/components/WatchlistQuadrantRadar";
import WatchlistRiskRankingCard from "@/components/WatchlistRiskRankingCard";
import { fetchAgentStatus, streamInvestigate, type WatchlistAssetItem } from "@/lib/api";
import { WATCHLIST_SHOWCASE_BRIEF } from "@/lib/showcaseSamples";

interface WatchlistWorkspaceProps {
  items: WatchlistAssetItem[];
  loading: boolean;
  mutating: boolean;
  error: string | null;
  regimeLabel?: string | null;
  spyCloses?: { date: string; close: number }[];
  onAddSymbol: (symbol: string) => Promise<void>;
  onReorderSymbols: (symbols: string[]) => Promise<void>;
  onRemoveSymbol: (symbol: string) => Promise<void>;
  onOpenStockDetail: (symbol: string) => void;
  onOpenSettings?: () => void;
  onNavigateToCopilot?: () => void;
}

type SortField = "order" | "1d" | "5d" | "1m" | "6m" | "ytd";
type CompareRange = "5D" | "1M" | "6M" | "YTD" | "1Y" | "ALL";

const EASE_EXPO = [0.16, 1, 0.3, 1] as const;

const SERIES_PALETTE = [
  "#10b981", // emerald
  "#3b82f6", // royal blue
  "#f59e0b", // amber
  "#ec4899", // pink
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#ef4444", // crimson red
  "#84cc16", // lime
  "#f97316", // orange
  "#6366f1", // indigo
  "#14b8a6", // teal
  "#e879f9", // orchid
  "#0ea5e9", // sky
  "#eab308", // gold
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

interface ChartCoordPt {
  x: number;
  y: number;
  d: string;
  pct: number;
  idx: number;
}

interface PreparedChartCurve {
  item: WatchlistAssetItem;
  color: string;
  hidden: boolean;
  absDelta: number;
  pctDelta: number;
  points: { d: string; pct: number }[];
  coords: ChartCoordPt[];
  coordByIdx: Map<number, ChartCoordPt>;
  pathD: string;
  areaD: string;
}

interface WatchlistComparisonSvgPanelProps {
  dates: string[];
  perStock: {
    item: WatchlistAssetItem;
    color: string;
    hidden: boolean;
    absDelta: number;
    pctDelta: number;
    points: { d: string; pct: number }[];
  }[];
  orderedChartCurves: PreparedChartCurve[];
  chartCurvesCount: number;
  activeHighlightSymbol: string | null;
  focusedStockMeta: {
    item: WatchlistAssetItem;
    color: string;
    pctDelta: number;
    points: { d: string; pct: number }[];
  } | null;
  activeYBounds: { minPct: number; maxPct: number };
  spanPct: number;
  zeroY: number;
  endpointLabels: { symbol: string; color: string; pctDelta: number; y: number }[];
  pinnedSymbol: string | null;
  hoveredSymbol: string | null;
  chartW: number;
  chartH: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
  plotW: number;
  plotH: number;
  onClearPin: () => void;
  onNearestSymbolChange: React.Dispatch<React.SetStateAction<string | null>>;
}

const WatchlistComparisonSvgPanel = React.memo(function WatchlistComparisonSvgPanel({
  dates,
  perStock,
  orderedChartCurves,
  chartCurvesCount,
  activeHighlightSymbol,
  focusedStockMeta,
  activeYBounds,
  spanPct,
  zeroY,
  endpointLabels,
  pinnedSymbol,
  hoveredSymbol,
  chartW,
  chartH,
  padL,
  padR,
  padT,
  padB,
  plotW,
  plotH,
  onClearPin,
  onNearestSymbolChange,
}: WatchlistComparisonSvgPanelProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const moveRafRef = useRef<number | null>(null);

  const curveBySymbol = useMemo(() => {
    const map = new Map<string, PreparedChartCurve>();
    for (const c of orderedChartCurves) {
      map.set(c.item.symbol, c);
    }
    return map;
  }, [orderedChartCurves]);

  const mapPctY = (val: number) =>
    padT + ((activeYBounds.maxPct - val) / spanPct) * plotH;

  if (dates.length <= 1) {
    return (
      <div className="rounded-xl border border-zinc-200 p-6 text-center text-sm text-zinc-700 dark:border-white/15 dark:text-zinc-300">
        正在准备多标的归一化历史序列...
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-zinc-200/90 bg-white/85 p-3 dark:border-white/15 dark:bg-zinc-950/65">
      {/* Fixed-Height HUD Readout Strip (Zero Vertical Layout Jump) */}
      <div className="mb-1.5 flex h-7 items-center justify-between gap-2 overflow-hidden border-b border-zinc-200/70 pb-1.5 font-mono text-[11px] dark:border-white/10">
        {focusedStockMeta ? (
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: focusedStockMeta.color }}
            />
            <span className="font-bold text-zinc-950 dark:text-white">
              {focusedStockMeta.item.symbol}
            </span>
            <span className="hidden truncate font-sans text-zinc-600 dark:text-zinc-300 sm:inline">
              {focusedStockMeta.item.name}
            </span>
            <span
              className={`rounded px-1.5 py-0.2 font-bold ${
                focusedStockMeta.pctDelta >= 0
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
              }`}
            >
              区间 {fmtPct(focusedStockMeta.pctDelta)}
            </span>
            {hoverIdx !== null && dates[hoverIdx] && (() => {
              const pt = curveBySymbol.get(focusedStockMeta.item.symbol)?.coordByIdx.get(hoverIdx);
              return pt ? (
                <span className="text-zinc-700 dark:text-zinc-200">
                  · {dates[hoverIdx]}:{" "}
                  <strong
                    className={
                      pt.pct >= 0
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-rose-700 dark:text-rose-400"
                    }
                  >
                    {fmtPct(pt.pct)}
                  </strong>
                </span>
              ) : null;
            })()}
          </div>
        ) : hoverIdx !== null && dates[hoverIdx] ? (
          <div className="flex min-w-0 items-center gap-3 overflow-hidden">
            <span className="shrink-0 font-bold text-zinc-950 dark:text-white">
              {dates[hoverIdx]}
            </span>
            <div className="flex items-center gap-2.5 truncate">
              {perStock
                .filter((s) => !s.hidden)
                .map((s) => {
                  const pt = curveBySymbol.get(s.item.symbol)?.coordByIdx.get(hoverIdx);
                  return pt ? { ...s, hoverPct: pt.pct } : null;
                })
                .filter((x): x is NonNullable<typeof x> => x !== null)
                .sort((a, b) => b.hoverPct - a.hoverPct)
                .slice(0, 4)
                .map((s) => (
                  <span key={s.item.symbol} className="inline-flex shrink-0 items-center gap-1">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: s.color }}
                    />
                    <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                      {s.item.symbol}
                    </span>
                    <span
                      className={
                        s.hoverPct >= 0
                          ? "font-semibold text-emerald-700 dark:text-emerald-400"
                          : "font-semibold text-rose-700 dark:text-rose-400"
                      }
                    >
                      {fmtPct(s.hoverPct)}
                    </span>
                  </span>
                ))}
            </div>
          </div>
        ) : (
          <div className="flex w-full items-center justify-between gap-2 text-zinc-600 dark:text-zinc-400">
            <span className="truncate">
              悬浮股票行、标签或曲线可单线高亮，其余曲线自动淡化
            </span>
            <span className="shrink-0 tabular-nums">
              {dates[0]} → {dates[dates.length - 1]}
            </span>
          </div>
        )}

        {pinnedSymbol && (
          <button
            type="button"
            onClick={onClearPin}
            className="shrink-0 rounded-full border border-zinc-300 px-2 py-0.5 text-[10px] font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-white/20 dark:text-zinc-200 dark:hover:bg-white/10"
          >
            取消锁定
          </button>
        )}
      </div>

      <svg
        viewBox={`0 0 ${chartW} ${chartH}`}
        className="h-[300px] w-full select-none"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const clientX = e.clientX;
          const clientY = e.clientY;
          if (moveRafRef.current !== null) {
            window.cancelAnimationFrame(moveRafRef.current);
          }
          moveRafRef.current = window.requestAnimationFrame(() => {
            moveRafRef.current = null;
            const svgX = ((clientX - rect.left) / Math.max(rect.width, 1)) * chartW;
            const svgY = ((clientY - rect.top) / Math.max(rect.height, 1)) * chartH;
            const rel = Math.max(0, Math.min(1, (svgX - padL) / plotW));
            const idx = Math.round(rel * (dates.length - 1));
            setHoverIdx((prev) => (prev === idx ? prev : idx));

            if (!pinnedSymbol && !hoveredSymbol) {
              let bestSym: string | null = null;
              let bestDist = 28;
              for (const c of orderedChartCurves) {
                const pt = c.coordByIdx.get(idx) ?? c.coords[c.coords.length - 1];
                if (!pt) continue;
                const dist = Math.abs(pt.y - svgY);
                if (dist < bestDist) {
                  bestDist = dist;
                  bestSym = c.item.symbol;
                }
              }
              onNearestSymbolChange((prev) => (prev === bestSym ? prev : bestSym));
            }
          });
        }}
        onMouseLeave={() => {
          if (moveRafRef.current !== null) {
            window.cancelAnimationFrame(moveRafRef.current);
            moveRafRef.current = null;
          }
          setHoverIdx(null);
          onNearestSymbolChange((prev) => (prev === null ? prev : null));
        }}
      >
        <defs>
          <clipPath id="wlPlotClip">
            <rect x={padL} y={padT - 8} width={plotW + 4} height={plotH + 16} />
          </clipPath>
          {focusedStockMeta && (
            <linearGradient id="wlFocusAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={focusedStockMeta.color} stopOpacity="0.24" />
              <stop offset="100%" stopColor={focusedStockMeta.color} stopOpacity="0.01" />
            </linearGradient>
          )}
        </defs>

        {[
          activeYBounds.maxPct,
          activeYBounds.maxPct - spanPct * 0.25,
          activeYBounds.maxPct - spanPct * 0.5,
          activeYBounds.maxPct - spanPct * 0.75,
          activeYBounds.minPct,
        ].map((tick, idx) => {
          const yPos = mapPctY(tick);
          const labelVal = Math.abs(spanPct) < 20 ? tick.toFixed(1) : tick.toFixed(0);
          return (
            <g key={idx}>
              <line
                x1={padL}
                x2={chartW - padR}
                y1={yPos}
                y2={yPos}
                stroke="currentColor"
                className="text-zinc-200 dark:text-zinc-800"
                strokeWidth="0.8"
              />
              <text
                x={padL - 8}
                y={yPos + 4}
                textAnchor="end"
                className="fill-zinc-700 font-mono text-[11px] font-medium dark:fill-zinc-300"
              >
                {`${tick >= 0 ? "+" : ""}${labelVal}%`}
              </text>
            </g>
          );
        })}

        {activeYBounds.minPct < 0 && activeYBounds.maxPct > 0 && (
          <g>
            <line
              x1={padL}
              x2={chartW - padR}
              y1={zeroY}
              y2={zeroY}
              stroke="currentColor"
              className="text-zinc-500 dark:text-zinc-400"
              strokeWidth="1.1"
              strokeDasharray="4 3"
            />
            <circle cx={padL} cy={zeroY} r="2.5" className="fill-zinc-600 dark:fill-zinc-300" />
          </g>
        )}

        {[0, 0.25, 0.5, 0.75, 1].map((frac, idx) => {
          const dIdx = Math.min(dates.length - 1, Math.round(frac * (dates.length - 1)));
          const xPos = padL + frac * plotW;
          return (
            <text
              key={idx}
              x={xPos}
              y={chartH - 6}
              textAnchor={idx === 0 ? "start" : idx === 4 ? "end" : "middle"}
              className="fill-zinc-700 font-mono text-[11px] dark:fill-zinc-300"
            >
              {dates[dIdx]?.slice(5)}
            </text>
          );
        })}

        <g clipPath="url(#wlPlotClip)">
          {orderedChartCurves.map((series) => {
            const isFocused = activeHighlightSymbol === series.item.symbol;
            const isDimmed = Boolean(activeHighlightSymbol && !isFocused);
            const lastPt = series.coords[series.coords.length - 1];

            return (
              <g key={series.item.symbol}>
                {isFocused && (
                  <>
                    <path d={series.areaD} fill="url(#wlFocusAreaGrad)" />
                    <path
                      d={series.pathD}
                      fill="none"
                      stroke={series.color}
                      strokeWidth="6.5"
                      strokeOpacity="0.18"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  </>
                )}
                <path
                  d={series.pathD}
                  fill="none"
                  stroke={series.color}
                  strokeWidth={isFocused ? 3.2 : isDimmed ? 1.3 : 2.1}
                  strokeOpacity={isFocused ? 1 : isDimmed ? 0.13 : chartCurvesCount > 6 ? 0.85 : 0.95}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {isFocused && (
                  <circle
                    cx={lastPt.x}
                    cy={lastPt.y}
                    r="4.2"
                    fill={series.color}
                    stroke="#ffffff"
                    strokeWidth="1.5"
                  />
                )}
              </g>
            );
          })}
        </g>

        {endpointLabels.map((lbl) => {
          const labelY = Math.max(padT + 9, Math.min(chartH - padB - 9, lbl.y));
          return (
            <g key={`end-${lbl.symbol}`} transform={`translate(${chartW - padR + 6}, ${labelY})`}>
              <rect x="0" y="-9" width="68" height="18" rx="5" fill={lbl.color} fillOpacity="0.92" />
              <text
                x="34"
                y="3.5"
                textAnchor="middle"
                fill="#ffffff"
                className="font-mono text-[9.5px] font-bold"
              >
                {`${lbl.symbol} ${lbl.pctDelta >= 0 ? "+" : ""}${lbl.pctDelta.toFixed(0)}%`}
              </text>
            </g>
          );
        })}

        {hoverIdx !== null && dates[hoverIdx] && (
          <>
            <line
              x1={padL + (hoverIdx / Math.max(dates.length - 1, 1)) * plotW}
              x2={padL + (hoverIdx / Math.max(dates.length - 1, 1)) * plotW}
              y1={padT}
              y2={chartH - padB}
              stroke="currentColor"
              className="text-zinc-500 dark:text-zinc-300"
              strokeDasharray="3 3"
              strokeWidth="1"
            />
            {orderedChartCurves.map((c) => {
              const pt = c.coordByIdx.get(hoverIdx);
              if (!pt) return null;
              const isFocused = activeHighlightSymbol === c.item.symbol;
              const isDimmed = Boolean(activeHighlightSymbol && !isFocused);
              if (isDimmed) return null;
              return (
                <circle
                  key={`dot-${c.item.symbol}`}
                  cx={pt.x}
                  cy={pt.y}
                  r={isFocused ? 4.8 : 3}
                  fill={c.color}
                  stroke="#ffffff"
                  strokeWidth="1.4"
                />
              );
            })}
          </>
        )}
      </svg>
    </div>
  );
});

export default function WatchlistWorkspace({
  items,
  loading,
  mutating,
  error,
  regimeLabel,
  spyCloses,
  onAddSymbol,
  onReorderSymbols,
  onRemoveSymbol,
  onOpenStockDetail,
  onOpenSettings,
  onNavigateToCopilot,
}: WatchlistWorkspaceProps) {
  const [newTicker, setNewTicker] = useState("");
  const [manageMode, setManageMode] = useState(false);
  const [sortField, setSortField] = useState<SortField>("order");
  const [sortAsc, setSortAsc] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [range, setRange] = useState<CompareRange>("YTD");
  const [hiddenSymbols, setHiddenSymbols] = useState<Set<string>>(new Set());
  const [hoveredSymbol, setHoveredSymbol] = useState<string | null>(null);
  const [pinnedSymbol, setPinnedSymbol] = useState<string | null>(null);
  const clearPinHandler = useCallback(() => setPinnedSymbol(null), []);
  const [svgNearestSymbol, setSvgNearestSymbol] = useState<string | null>(null);
  const [autoZoomOnFocus, setAutoZoomOnFocus] = useState<boolean>(true);
  const [breakdownSortByRange, setBreakdownSortByRange] = useState<boolean>(true);
  const [simExternalPreset, setSimExternalPreset] = useState<{
    symbols: string[];
    label: string;
    version: number;
  } | null>(null);

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

  const handleDropRow = async (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex || mutating) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }
    const next = items.map((x) => x.symbol);
    const [moved] = next.splice(dragIndex, 1);
    next.splice(targetIndex, 0, moved);
    setDragIndex(null);
    setDragOverIndex(null);
    await onReorderSymbols(next);
  };

  const handleSaveCurrentAsCustom = async () => {
    if (mutating || sortedItems.length === 0) return;
    await onReorderSymbols(sortedItems.map((x) => x.symbol));
    setSortField("order");
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

    let rawMin = 0;
    let rawMax = 0;
    for (const s of perStock) {
      if (s.hidden) continue;
      for (const p of s.points) {
        if (p.pct < rawMin) rawMin = p.pct;
        if (p.pct > rawMax) rawMax = p.pct;
      }
    }
    const topPad = Math.max(2, Math.abs(rawMax) * 0.1);
    const botPad = Math.max(2, Math.min(24, Math.max(Math.abs(rawMin) * 0.14, (rawMax - rawMin) * 0.04)));
    const minPct = Math.min(-2, rawMin - botPad);
    const maxPct = Math.max(2, rawMax + topPad);

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
      const st = await fetchAgentStatus().catch(() => null);
      if (st && !st.llm_pro_ready) {
        setAiReport(WATCHLIST_SHOWCASE_BRIEF);
        return;
      }
      let streamed = "";
      await streamInvestigate(
        {
          thread_id: `watchlist-${Date.now()}`,
          symbol: items[0].symbol,
          query: `当前宏观体制：${regimeLabel || "UNKNOWN"}。请作为高级机构组合策略师，对我的自选关注列表进行整体复盘与风险对比点评（聚焦强弱分化、RSI超买超卖、仓位集中度与近期观察重点）：\n${summaryInput}`,
        },
        (ev) => {
          if (ev.event === "token") {
            const chunk =
              typeof ev.data.delta === "string"
                ? ev.data.delta
                : typeof ev.data.text === "string"
                ? ev.data.text
                : "";
            if (chunk) {
              streamed += chunk;
              setAiReport(streamed);
            }
          } else if (ev.event === "done" || ev.event === "final") {
            const ans =
              typeof ev.data.answer === "string"
                ? ev.data.answer
                : typeof ev.data.report_markdown === "string"
                ? ev.data.report_markdown
                : streamed;
            if (ans) setAiReport(ans);
          } else if (ev.event === "error") {
            setAiError(String(ev.data.message || ev.data.detail || "AI 诊断失败"));
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
  const chartH = 300;
  const padL = 52;
  const padR = 78;
  const padT = 16;
  const padB = 26;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;

  const activeHighlightSymbol = useMemo(() => {
    const candidate = hoveredSymbol ?? svgNearestSymbol ?? pinnedSymbol;
    if (!candidate || hiddenSymbols.has(candidate)) return null;
    return candidate;
  }, [hoveredSymbol, svgNearestSymbol, pinnedSymbol, hiddenSymbols]);

  const focusedStockMeta = useMemo(() => {
    if (!activeHighlightSymbol) return null;
    return (
      comparisonData.perStock.find((s) => s.item.symbol === activeHighlightSymbol) ?? null
    );
  }, [comparisonData.perStock, activeHighlightSymbol]);

  // Only zoom Y-axis when focused from outside the SVG (chips/tables/pins) so mouse picking inside SVG stays rock-steady
  const shouldZoomFocusedY = Boolean(
    autoZoomOnFocus && focusedStockMeta && (hoveredSymbol || pinnedSymbol) && !svgNearestSymbol
  );

  const activeYBounds = useMemo(() => {
    if (!shouldZoomFocusedY || !focusedStockMeta || focusedStockMeta.points.length < 2) {
      return { minPct: comparisonData.minPct, maxPct: comparisonData.maxPct };
    }
    let lo = 0;
    let hi = 0;
    for (const pt of focusedStockMeta.points) {
      if (pt.pct < lo) lo = pt.pct;
      if (pt.pct > hi) hi = pt.pct;
    }
    const span = Math.max(4, hi - lo);
    return {
      minPct: lo - Math.max(2, span * 0.14),
      maxPct: hi + Math.max(2, span * 0.14),
    };
  }, [shouldZoomFocusedY, focusedStockMeta, comparisonData.minPct, comparisonData.maxPct]);

  const spanPct = Math.max(0.01, activeYBounds.maxPct - activeYBounds.minPct);
  const mapPctY = (val: number) =>
    padT + ((activeYBounds.maxPct - val) / spanPct) * plotH;
  const zeroY = mapPctY(0);

  const sortedBreakdown = useMemo(() => {
    if (!breakdownSortByRange) return comparisonData.perStock;
    return [...comparisonData.perStock].sort((a, b) => b.pctDelta - a.pctDelta);
  }, [comparisonData.perStock, breakdownSortByRange]);

  const toggleSymbolVisibility = (sym: string) => {
    setHiddenSymbols((prev) => {
      const next = new Set(prev);
      if (next.has(sym)) next.delete(sym);
      else next.add(sym);
      return next;
    });
    if (pinnedSymbol === sym) setPinnedSymbol(null);
  };

  const applyTopFilter = (count: number) => {
    const ranked = [...comparisonData.perStock]
      .sort((a, b) => b.pctDelta - a.pctDelta)
      .slice(0, count)
      .map((s) => s.item.symbol);
    const keep = new Set(ranked);
    setHiddenSymbols(
      new Set(items.map((it) => it.symbol).filter((sym) => !keep.has(sym)))
    );
    setPinnedSymbol(null);
  };

  const applyExtremesFilter = () => {
    const ranked = [...comparisonData.perStock].sort((a, b) => b.pctDelta - a.pctDelta);
    const keep = new Set<string>();
    ranked.slice(0, 2).forEach((s) => keep.add(s.item.symbol));
    ranked.slice(-2).forEach((s) => keep.add(s.item.symbol));
    setHiddenSymbols(
      new Set(items.map((it) => it.symbol).filter((sym) => !keep.has(sym)))
    );
    setPinnedSymbol(null);
  };

  const resetChartFilters = () => {
    setHiddenSymbols(new Set());
    setPinnedSymbol(null);
    setHoveredSymbol(null);
    setSvgNearestSymbol(null);
  };

  const chartCurves = useMemo(() => {
    if (comparisonData.dates.length < 2) return [];
    const denom = Math.max(comparisonData.dates.length - 1, 1);
    const toY = (val: number) =>
      padT + ((activeYBounds.maxPct - val) / spanPct) * plotH;
    const clampedBaseY = Math.max(padT, Math.min(chartH - padB, zeroY)).toFixed(1);

    return comparisonData.perStock
      .filter((s) => !s.hidden && s.points.length >= 2)
      .map((series) => {
        const dMap = new Map(series.points.map((p) => [p.d, p.pct]));
        const coords: { x: number; y: number; d: string; pct: number; idx: number }[] = [];
        const coordByIdx = new Map<number, { x: number; y: number; d: string; pct: number; idx: number }>();
        const ptsStr: string[] = [];
        comparisonData.dates.forEach((d, i) => {
          const val = dMap.get(d);
          if (val === undefined) return;
          const pt = {
            x: padL + (i / denom) * plotW,
            y: toY(val),
            d,
            pct: val,
            idx: i,
          };
          coords.push(pt);
          coordByIdx.set(i, pt);
          ptsStr.push(`${pt.x.toFixed(1)},${pt.y.toFixed(1)}`);
        });
        const pathD = ptsStr.length >= 2 ? `M${ptsStr.join(" L")}` : "";
        const firstPt = coords[0];
        const lastPt = coords[coords.length - 1];
        const areaD =
          coords.length >= 2
            ? `${pathD} L${lastPt.x.toFixed(1)},${clampedBaseY} L${firstPt.x.toFixed(1)},${clampedBaseY} Z`
            : "";
        return { ...series, coords, coordByIdx, pathD, areaD };
      })
      .filter((s) => s.coords.length >= 2);
  }, [comparisonData, activeYBounds.maxPct, spanPct, plotW, plotH, padL, padT, chartH, padB, zeroY]);

  const orderedChartCurves = useMemo(() => {
    if (!activeHighlightSymbol) return chartCurves;
    return [...chartCurves].sort((a, b) => {
      const aFocus = a.item.symbol === activeHighlightSymbol ? 1 : 0;
      const bFocus = b.item.symbol === activeHighlightSymbol ? 1 : 0;
      return aFocus - bFocus;
    });
  }, [chartCurves, activeHighlightSymbol]);

  const endpointLabels = useMemo(() => {
    if (chartCurves.length === 0) return [];
    if (activeHighlightSymbol) {
      const target = chartCurves.find((c) => c.item.symbol === activeHighlightSymbol);
      if (!target) return [];
      const last = target.coords[target.coords.length - 1];
      return [{ symbol: target.item.symbol, color: target.color, pctDelta: target.pctDelta, y: last.y }];
    }
    const candidates = chartCurves
      .map((c) => ({
        symbol: c.item.symbol,
        color: c.color,
        pctDelta: c.pctDelta,
        y: c.coords[c.coords.length - 1].y,
      }))
      .sort((a, b) => b.pctDelta - a.pctDelta);
    const picked: typeof candidates = [];
    const prioritized =
      candidates.length <= 4
        ? candidates
        : [candidates[0], candidates[candidates.length - 1], candidates[1], candidates[candidates.length - 2]];
    for (const cand of prioritized) {
      const clampedY = Math.max(padT + 9, Math.min(chartH - padB - 9, cand.y));
      if (picked.every((p) => Math.abs(p.y - clampedY) >= 18)) {
        picked.push({ ...cand, y: clampedY });
      }
    }
    return picked;
  }, [chartCurves, activeHighlightSymbol, padT, chartH, padB]);

  const maxAbsRangePct = useMemo(() => {
    let m = 1;
    for (const s of comparisonData.perStock) {
      const a = Math.abs(s.pctDelta);
      if (a > m) m = a;
    }
    return m;
  }, [comparisonData.perStock]);

  return (
    <main className="mx-auto w-full max-w-[97vw] space-y-4 px-3 pt-3 sm:px-5 lg:px-6 2xl:max-w-[2380px]">
      {/* Compact Header + Executive Brief Bar */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.36, ease: EASE_EXPO }}
      >
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

        <AnimatePresence>
          {(aiReport || aiError) && (
            <motion.div
              key="watchlist-ai-brief"
              initial={{ opacity: 0, y: 8, scale: 0.99 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.28, ease: EASE_EXPO }}
              className="rounded-2xl border border-emerald-500/35 bg-zinc-50/95 p-4 text-zinc-950 shadow-sm dark:border-emerald-500/30 dark:bg-zinc-950/90 dark:text-zinc-100"
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 font-mono text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                <span className="flex items-center gap-2">
                  <Bot className="h-4 w-4" />
                  AI 自选股联合诊断
                </span>
                {aiReport === WATCHLIST_SHOWCASE_BRIEF && onOpenSettings && (
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="inline-flex items-center gap-1 rounded-full bg-amber-400 px-3 py-1 font-sans text-xs font-bold text-zinc-950 transition hover:bg-amber-300"
                  >
                    <KeyRound className="h-3 w-3" />
                    填入 API Key 解锁实时分析
                  </button>
                )}
              </div>
              {aiError ? (
                <p className="text-sm text-rose-700 dark:text-rose-300">{aiError}</p>
              ) : (
                <MarkdownReport content={aiReport} />
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Side-by-Side Single-Screen Workspace Grid: Multi-Horizon Table (Left 6) + Comparison Chart (Right 6) */}
      </SpotlightBlock>
      </motion.div>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-12">
        <div className="flex flex-col gap-4 xl:col-span-6">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.42, delay: 0.05, ease: EASE_EXPO }}
          >
          <SpotlightBlock tone="gallery" className="overflow-hidden p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold tracking-wider text-zinc-700 dark:text-zinc-200">
              MULTI-HORIZON MATRIX · 多周期收益与动量明细
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSortField("order")}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-semibold transition ${
                  sortField === "order"
                    ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
                    : "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-950 dark:border-white/20 dark:bg-white/[0.06] dark:text-zinc-200"
                }`}
              >
                <GripVertical className="h-3 w-3" />
                {sortField === "order" ? "自定义排序 (可拖拽)" : "恢复自定义排序"}
              </button>
              {sortField !== "order" && (
                <button
                  type="button"
                  onClick={() => void handleSaveCurrentAsCustom()}
                  disabled={mutating}
                  className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-500/20 disabled:opacity-45 dark:text-emerald-300"
                >
                  设为自定义顺序
                </button>
              )}
              <span className="hidden font-mono text-[11px] text-zinc-600 dark:text-zinc-400 sm:inline">
                点击行跳转个股页
              </span>
            </div>
          </div>
          <div className="overflow-x-auto rounded-xl border border-zinc-200/90 bg-white/85 dark:border-white/15 dark:bg-white/[0.03]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-200 font-mono text-[11px] font-semibold text-zinc-700 dark:border-white/15 dark:text-zinc-300">
                  <th className="px-2 py-2">标的资产</th>
                  <th className="px-1.5 py-2 text-center">K线</th>
                  <th className="px-1.5 py-2 text-right">最新价</th>
                  {(
                    [
                      { f: "1d", label: "1天" },
                      { f: "5d", label: "5日" },
                      { f: "1m", label: "1月" },
                      { f: "6m", label: "6月" },
                      { f: "ytd", label: "YTD" },
                    ] as const
                  ).map((col) => (
                    <th key={col.f} className="px-1.5 py-2 text-right">
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
                  <th className="px-1.5 py-2 text-right">RSI</th>
                  {(manageMode || sortField === "order") && (
                    <th className="px-1.5 py-2 text-right">
                      {manageMode ? "操作" : "调序"}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200/75 font-mono text-xs tabular-nums dark:divide-white/[0.08]">
                {loading && sortedItems.length === 0 ? (
                  <tr>
                    <td
                      colSpan={manageMode || sortField === "order" ? 10 : 9}
                      className="px-4 py-8 text-center text-zinc-700 dark:text-zinc-300"
                    >
                      加载关注列表中...
                    </td>
                  </tr>
                ) : (
                  sortedItems.map((item) => {
                    const origIdx = items.findIndex((x) => x.symbol === item.symbol);
                    const canDrag = sortField === "order" && !mutating && origIdx >= 0;
                    const isDragTarget =
                      canDrag && dragOverIndex === origIdx && dragIndex !== origIdx;
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
                        draggable={canDrag}
                        onDragStart={() => {
                          if (canDrag) setDragIndex(origIdx);
                        }}
                        onDragOver={(e) => {
                          if (canDrag) {
                            e.preventDefault();
                            setDragOverIndex(origIdx);
                          }
                        }}
                        onDragLeave={() => {
                          if (dragOverIndex === origIdx) setDragOverIndex(null);
                        }}
                        onDrop={() => {
                          if (canDrag) void handleDropRow(origIdx);
                        }}
                        onDragEnd={() => {
                          setDragIndex(null);
                          setDragOverIndex(null);
                        }}
                        onClick={() => onOpenStockDetail(item.symbol)}
                        onMouseEnter={() => setHoveredSymbol(item.symbol)}
                        onMouseLeave={() =>
                          setHoveredSymbol((prev) => (prev === item.symbol ? null : prev))
                        }
                        className={`group cursor-pointer transition-colors duration-100 ${
                          isDragTarget
                            ? "bg-emerald-500/15 ring-2 ring-inset ring-emerald-500 dark:bg-emerald-500/25"
                            : activeHighlightSymbol === item.symbol
                              ? "bg-emerald-500/10 dark:bg-emerald-500/20"
                              : activeHighlightSymbol
                                ? "opacity-65 hover:bg-zinc-100/80 dark:hover:bg-white/[0.06]"
                                : "hover:bg-zinc-100/80 dark:hover:bg-white/[0.06]"
                        }`}
                      >
                        <td className="px-2 py-2 font-sans">
                          <div className="flex items-center gap-1.5">
                            {canDrag && (
                              <span
                                title="按住拖拽调整自定义顺序"
                                onClick={(e) => e.stopPropagation()}
                                className="cursor-grab text-zinc-400 transition group-hover:text-zinc-700 active:cursor-grabbing dark:text-zinc-500 dark:group-hover:text-zinc-200"
                              >
                                <GripVertical className="h-3.5 w-3.5 shrink-0" />
                              </span>
                            )}
                            <StockLogoBadge symbol={item.symbol} size={28} />
                            <div className="min-w-0">
                              <div className="max-w-[112px] truncate text-[13px] font-semibold text-zinc-950 dark:text-zinc-50 2xl:max-w-[138px]">
                                {item.name}
                              </div>
                              <div className="font-mono text-[10.5px] font-medium text-zinc-700 dark:text-zinc-300">
                                {item.symbol} · {item.exchange}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-1.5 py-2">
                          <div className="flex justify-center">
                            <MiniKLineSparkline
                              bars={item.sparkline_bars}
                              prevClose={item.prev_close}
                              isUp={isUp1d}
                              width={48}
                              height={20}
                            />
                          </div>
                        </td>
                        <td className="px-1.5 py-2 text-right text-xs font-bold text-zinc-950 dark:text-zinc-50">
                          {fmtUsd(item.price)}
                        </td>
                        {horizons.map((val, hIdx) => (
                          <td
                            key={hIdx}
                            className={`px-1.5 py-2 text-right font-semibold ${
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
                        <td className="px-1.5 py-2 text-right font-semibold text-zinc-800 dark:text-zinc-200">
                          {item.rsi_14 != null ? item.rsi_14.toFixed(1) : "—"}
                        </td>
                        {(manageMode || sortField === "order") && (
                          <td
                            className="px-1.5 py-2 text-right"
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
                                    aria-label={`上移 ${item.symbol}`}
                                    className="rounded border border-zinc-300 bg-white p-1 text-zinc-800 hover:border-zinc-950 disabled:opacity-30 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-100"
                                  >
                                    <ArrowUp className="h-3 w-3" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void moveOrder(origIdx, 1)}
                                    disabled={mutating || origIdx === items.length - 1}
                                    title="下移"
                                    aria-label={`下移 ${item.symbol}`}
                                    className="rounded border border-zinc-300 bg-white p-1 text-zinc-800 hover:border-zinc-950 disabled:opacity-30 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-100"
                                  >
                                    <ArrowDown className="h-3 w-3" />
                                  </button>
                                  {manageMode && (
                                    <button
                                      type="button"
                                      onClick={() => void onRemoveSymbol(item.symbol)}
                                      disabled={mutating}
                                      title="删除"
                                      className="rounded border border-rose-300 bg-rose-50 p-1 text-rose-700 dark:border-rose-500/40 dark:bg-rose-950/60 dark:text-rose-300"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </button>
                                  )}
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
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.42, delay: 0.12, ease: EASE_EXPO }}
          >
          <WatchlistQuadrantRadar
            items={items}
            palette={SERIES_PALETTE}
            highlightSymbol={activeHighlightSymbol}
            onHoverSymbol={setHoveredSymbol}
            onOpenStockDetail={onOpenStockDetail}
            onApplySymbolsToSimulator={(symbols, label) =>
              setSimExternalPreset((prev) => ({
                symbols,
                label,
                version: (prev?.version ?? 0) + 1,
              }))
            }
          />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.42, delay: 0.19, ease: EASE_EXPO }}
          >
          <WatchlistPortfolioBacktester
            items={items}
            palette={SERIES_PALETTE}
            spyCloses={spyCloses}
            externalPreset={simExternalPreset}
            onOpenStockDetail={onOpenStockDetail}
            onNavigateToCopilot={onNavigateToCopilot}
          />
          </motion.div>
        </div>

        {/* Right Side: Normalized Multi-Stock Comparison + Risk Defense Matrix */}
        <div className="flex flex-col gap-4 xl:col-span-6">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.42, delay: 0.08, ease: EASE_EXPO }}
          >
          <SpotlightBlock tone="gallery" className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-mono text-xs font-semibold tracking-wider text-zinc-700 dark:text-zinc-300">
              PERFORMANCE COMPARISON · 归一化收益率曲线
            </div>
            <h2 className="mt-1 font-serif text-xl font-medium text-zinc-950 dark:text-zinc-50 sm:text-2xl">
              自选股涨跌幅
            </h2>
          </div>

          <LayoutGroup id="watchlist-range-group">
          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-zinc-300/90 bg-white/90 p-1 font-mono text-xs dark:border-white/15 dark:bg-zinc-900">
            {(["5D", "1M", "6M", "YTD", "1Y", "ALL"] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={`relative rounded-lg px-3 py-1 font-semibold transition-colors ${
                  range === r
                    ? "text-white dark:text-zinc-950"
                    : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                }`}
              >
                {range === r && (
                  <motion.span
                    layoutId="watchlist-range-pill"
                    transition={{ type: "spring", stiffness: 420, damping: 32 }}
                    className="absolute inset-0 rounded-lg bg-zinc-950 dark:bg-white"
                  />
                )}
                <span className="relative z-10">{r}</span>
              </button>
            ))}
          </div>
          </LayoutGroup>
        </div>

        {/* Interactive Focus Bar + Quick Filter Presets (Declutter Controls) */}
        <div className="space-y-2 rounded-2xl border border-zinc-200/90 bg-white/75 p-2.5 dark:border-white/10 dark:bg-white/[0.03]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
              <button
                type="button"
                onClick={resetChartFilters}
                className={`rounded-full px-2.5 py-1 font-semibold transition ${
                  hiddenSymbols.size === 0 && !pinnedSymbol
                    ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                    : "border border-zinc-300 bg-white text-zinc-700 hover:border-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-200"
                }`}
              >
                全部 ({items.length})
              </button>
              {items.length > 5 && (
                <button
                  type="button"
                  onClick={() => applyTopFilter(5)}
                  className="rounded-full border border-zinc-300 bg-white px-2.5 py-1 font-medium text-zinc-800 transition hover:border-emerald-600 hover:text-emerald-700 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-emerald-400 dark:hover:text-emerald-300"
                >
                  仅看前 5 强
                </button>
              )}
              {items.length > 4 && (
                <button
                  type="button"
                  onClick={applyExtremesFilter}
                  className="rounded-full border border-zinc-300 bg-white px-2.5 py-1 font-medium text-zinc-800 transition hover:border-sky-600 hover:text-sky-700 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-sky-400 dark:hover:text-sky-300"
                >
                  头尾极值对比
                </button>
              )}
              {(hiddenSymbols.size > 0 || pinnedSymbol) && (
                <button
                  type="button"
                  onClick={resetChartFilters}
                  className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 font-semibold text-amber-800 transition hover:bg-amber-500/25 dark:text-amber-300"
                >
                  <RotateCcw className="h-3 w-3" />
                  重置筛选
                </button>
              )}
              <button
                type="button"
                onClick={() => setAutoZoomOnFocus((v) => !v)}
                title={
                  autoZoomOnFocus
                    ? "开启状态：悬停某只股票时自动放大该股 Y 轴振幅，避免高波股挤压"
                    : "关闭状态：保持全自选组统一 Y 轴尺度对比"
                }
                className={`rounded-full border px-2.5 py-1 font-medium transition ${
                  autoZoomOnFocus
                    ? "border-emerald-500/45 bg-emerald-500/15 font-semibold text-emerald-700 dark:border-emerald-400/40 dark:text-emerald-300"
                    : "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-300"
                }`}
              >
                {autoZoomOnFocus ? "聚焦自适应纵轴" : "全局同尺度纵轴"}
              </button>
            </div>

            <span className="font-mono text-[10.5px] text-zinc-600 dark:text-zinc-400">
              悬浮单线聚焦 · 点击标签锁定
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {sortedBreakdown.map(({ item, color, hidden, pctDelta }) => {
              const isFocused = activeHighlightSymbol === item.symbol;
              const isPinned = pinnedSymbol === item.symbol;
              const isDimmed = Boolean(activeHighlightSymbol && !isFocused);
              return (
                <button
                  key={`chip-${item.symbol}`}
                  type="button"
                  onMouseEnter={() => setHoveredSymbol(item.symbol)}
                  onMouseLeave={() =>
                    setHoveredSymbol((prev) => (prev === item.symbol ? null : prev))
                  }
                  onClick={() => {
                    if (hidden) {
                      toggleSymbolVisibility(item.symbol);
                      setPinnedSymbol(item.symbol);
                      return;
                    }
                    setPinnedSymbol((prev) => (prev === item.symbol ? null : item.symbol));
                  }}
                  title={
                    hidden
                      ? `${item.symbol} 已隐藏，点击显示并高亮`
                      : isPinned
                        ? `已锁定聚焦 ${item.symbol}（再次点击取消）`
                        : `悬浮突出 ${item.symbol} · 点击锁定曲线`
                  }
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-all ${
                    hidden
                      ? "border-zinc-200/70 bg-transparent text-zinc-400 line-through opacity-50 dark:border-white/10"
                      : isFocused
                        ? "border-zinc-950 bg-zinc-950 font-bold text-white shadow-sm dark:border-white dark:bg-white dark:text-zinc-950"
                        : isDimmed
                          ? "border-zinc-200 bg-white/50 text-zinc-500 opacity-45 dark:border-white/10 dark:bg-white/[0.02] dark:text-zinc-400"
                          : "border-zinc-200/90 bg-white text-zinc-900 hover:border-zinc-500 dark:border-white/15 dark:bg-zinc-900/90 dark:text-zinc-100"
                  }`}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span>{item.symbol}</span>
                  <span
                    className={
                      isFocused
                        ? pctDelta >= 0
                          ? "text-emerald-300 dark:text-emerald-700"
                          : "text-rose-300 dark:text-rose-700"
                        : pctDelta >= 0
                          ? "text-emerald-700 dark:text-emerald-400"
                          : "text-rose-700 dark:text-rose-400"
                    }
                  >
                    {fmtPct(pctDelta)}
                  </span>
                  {isPinned && <Pin className="h-2.5 w-2.5 shrink-0 opacity-85" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* SVG Normalized % Multi-Curve Chart (hover crosshair state isolated from table & radar/backtester) */}
        <WatchlistComparisonSvgPanel
          dates={comparisonData.dates}
          perStock={comparisonData.perStock}
          orderedChartCurves={orderedChartCurves}
          chartCurvesCount={chartCurves.length}
          activeHighlightSymbol={activeHighlightSymbol}
          focusedStockMeta={focusedStockMeta}
          activeYBounds={activeYBounds}
          spanPct={spanPct}
          zeroY={zeroY}
          endpointLabels={endpointLabels}
          pinnedSymbol={pinnedSymbol}
          hoveredSymbol={hoveredSymbol}
          chartW={chartW}
          chartH={chartH}
          padL={padL}
          padR={padR}
          padT={padT}
          padB={padB}
          plotW={plotW}
          plotH={plotH}
          onClearPin={clearPinHandler}
          onNearestSymbolChange={setSvgNearestSymbol}
        />

        {/* Comparison Breakdown Rows with Hover Spotlight, Relative Strength Bar, Sort Toggle & Explicit Eye/Pin Controls */}
        <div className="flex items-center justify-between px-1 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
          <span>
            个股表现明细 ({comparisonData.visibleCount}/{items.length} 条显示中)
          </span>
          <button
            type="button"
            onClick={() => setBreakdownSortByRange((v) => !v)}
            className="inline-flex items-center gap-1 rounded-full border border-zinc-300/90 bg-white px-2.5 py-0.5 text-[10.5px] font-semibold text-zinc-800 transition hover:border-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-white"
          >
            <ArrowUpDown className="h-3 w-3" />
            {breakdownSortByRange ? `按 ${range} 涨跌幅排序` : "按自选列表顺序"}
          </button>
        </div>

        <div className="divide-y divide-zinc-200/80 overflow-hidden rounded-2xl border border-zinc-200/90 bg-white/85 dark:divide-white/[0.08] dark:border-white/15 dark:bg-white/[0.04]">
          {sortedBreakdown.map(({ item, color, hidden, absDelta, pctDelta }) => {
            const isUp = pctDelta >= 0;
            const signAbs = absDelta >= 0 ? "+" : "-";
            const isFocused = activeHighlightSymbol === item.symbol;
            const isPinned = pinnedSymbol === item.symbol;
            const isDimmed = Boolean(activeHighlightSymbol && !isFocused);
            const strengthWidth = Math.min(100, Math.max(4, (Math.abs(pctDelta) / maxAbsRangePct) * 100));

            return (
              <div
                key={item.symbol}
                onMouseEnter={() => {
                  if (!hidden) setHoveredSymbol(item.symbol);
                }}
                onMouseLeave={() =>
                  setHoveredSymbol((prev) => (prev === item.symbol ? null : prev))
                }
                className={`relative flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 transition-colors duration-100 ${
                  hidden
                    ? "opacity-40"
                    : isFocused
                      ? "bg-zinc-950/[0.045] dark:bg-white/[0.07]"
                      : isDimmed
                        ? "opacity-55 hover:opacity-95"
                        : "hover:bg-zinc-100/70 dark:hover:bg-white/[0.04]"
                }`}
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <button
                    type="button"
                    onClick={() => toggleSymbolVisibility(item.symbol)}
                    title={hidden ? "点击显示曲线" : "点击隐藏/对比此曲线"}
                    className={`w-1.5 shrink-0 rounded-full transition-all ${
                      isFocused ? "h-10 scale-x-125" : "h-8 hover:scale-y-110"
                    }`}
                    style={{ backgroundColor: color }}
                  />
                  <StockLogoBadge symbol={item.symbol} size={34} />
                  <button
                    type="button"
                    onClick={() => onOpenStockDetail(item.symbol)}
                    className="group min-w-0 text-left"
                  >
                    <div className="truncate font-sans text-sm font-semibold text-zinc-950 group-hover:underline dark:text-zinc-50">
                      {item.name}
                    </div>
                    <div className="font-mono text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      {item.symbol} · {item.exchange}
                    </div>
                  </button>
                </div>

                <div className="flex items-center gap-2.5 font-mono text-sm tabular-nums sm:gap-3.5">
                  <span className="font-bold text-zinc-950 dark:text-zinc-50">
                    {fmtUsd(item.price)}
                  </span>
                  <span
                    className={`hidden text-xs font-semibold sm:inline ${
                      isUp
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-rose-700 dark:text-rose-400"
                    }`}
                  >
                    {`${signAbs}$${Math.abs(absDelta).toFixed(2)}`}
                  </span>
                  <div className="flex flex-col items-end gap-1">
                    <span
                      className={`inline-flex min-w-[82px] items-center justify-center gap-1 rounded-lg px-2 py-0.5 text-xs font-bold ${
                        isUp
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/75 dark:text-emerald-300"
                          : "bg-rose-100 text-rose-800 dark:bg-rose-950/75 dark:text-rose-300"
                      }`}
                    >
                      {isUp ? "↗" : "↘"} {Math.abs(pctDelta).toFixed(2)}%
                    </span>
                    <span className="h-1 w-[82px] overflow-hidden rounded-full bg-zinc-200/80 dark:bg-white/10">
                      <span
                        className={`block h-full rounded-full ${
                          isUp ? "bg-emerald-500" : "bg-rose-500"
                        }`}
                        style={{ width: `${strengthWidth}%` }}
                      />
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (hidden) toggleSymbolVisibility(item.symbol);
                      setPinnedSymbol((prev) => (prev === item.symbol ? null : item.symbol));
                    }}
                    title={isPinned ? "取消锁定此股" : "锁定聚焦此股曲线"}
                    className={`rounded-full border p-1.5 transition ${
                      isPinned
                        ? "border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:border-emerald-400 dark:text-emerald-300"
                        : "border-zinc-300 text-zinc-600 hover:border-zinc-700 hover:text-zinc-950 dark:border-white/15 dark:text-zinc-300 dark:hover:border-white/40"
                    }`}
                  >
                    <Pin className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleSymbolVisibility(item.symbol)}
                    title={hidden ? `在图中显示 ${item.symbol}` : `在图中隐藏 ${item.symbol}`}
                    className={`rounded-full border p-1.5 transition ${
                      hidden
                        ? "border-zinc-300 bg-zinc-100 text-zinc-500 dark:border-white/15 dark:bg-white/5 dark:text-zinc-400"
                        : "border-zinc-300 text-zinc-700 hover:border-zinc-900 dark:border-white/15 dark:text-zinc-200 dark:hover:border-white/40"
                    }`}
                  >
                    {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
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
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.42, delay: 0.16, ease: EASE_EXPO }}
      >
        <WatchlistRiskRankingCard
          items={items}
          highlightSymbol={activeHighlightSymbol}
          onHoverSymbol={setHoveredSymbol}
          onOpenStockDetail={onOpenStockDetail}
        />
      </motion.div>
        </div>
      </div>
    </main>
  );
}

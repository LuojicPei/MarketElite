"use client";

import React, { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Grid, MousePointerClick, Sparkles } from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import { SectorHeatmapItem, SectorHeatmapResponse } from "@/lib/api";

interface SectorHeatmapModuleProps {
  data: SectorHeatmapResponse | null;
  selectedSymbol: string;
  onSelectSymbol: (sym: string) => void;
  loading?: boolean;
}

type HeatmapMetric = "1d" | "5d" | "20d" | "vsSpy";

interface TreemapBox {
  sector: SectorHeatmapItem;
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
}

function getMetricValue(sec: SectorHeatmapItem, metric: HeatmapMetric): number | null {
  if (metric === "1d") return sec.return_1d_pct;
  if (metric === "5d") return sec.return_5d_pct;
  if (metric === "20d") return sec.return_20d_pct;
  return sec.rel_spy_20d_pct;
}

function heatTileColors(val: number | null, active: boolean): {
  bg: string;
  border: string;
  badge: string;
} {
  if (active) {
    return {
      bg: val != null && val >= 0 ? "bg-emerald-700" : "bg-rose-700",
      border: "border-white ring-2 ring-white/80",
      badge: "text-white",
    };
  }
  if (val == null) {
    return {
      bg: "bg-zinc-800/90 hover:bg-zinc-700/90",
      border: "border-zinc-700/70",
      badge: "text-zinc-300",
    };
  }
  if (val >= 2.5) {
    return {
      bg: "bg-emerald-600 hover:bg-emerald-500",
      border: "border-emerald-400/50",
      badge: "text-white",
    };
  }
  if (val >= 0.8) {
    return {
      bg: "bg-emerald-700/95 hover:bg-emerald-600",
      border: "border-emerald-500/40",
      badge: "text-emerald-50",
    };
  }
  if (val >= 0.05) {
    return {
      bg: "bg-emerald-950/95 hover:bg-emerald-900",
      border: "border-emerald-700/45",
      badge: "text-emerald-200",
    };
  }
  if (val > -0.05) {
    return {
      bg: "bg-zinc-800 hover:bg-zinc-700",
      border: "border-zinc-600/50",
      badge: "text-zinc-200",
    };
  }
  if (val > -0.8) {
    return {
      bg: "bg-rose-950/95 hover:bg-rose-900",
      border: "border-rose-700/45",
      badge: "text-rose-200",
    };
  }
  if (val > -2.5) {
    return {
      bg: "bg-rose-800/95 hover:bg-rose-700",
      border: "border-rose-500/45",
      badge: "text-rose-50",
    };
  }
  return {
    bg: "bg-rose-600 hover:bg-rose-500",
    border: "border-rose-300/60",
    badge: "text-white",
  };
}

/**
 * Recursive weighted binary partition treemap covering 100% area cleanly at any aspect ratio.
 */
function buildBinaryTreemap(
  items: { sector: SectorHeatmapItem; areaWeight: number }[],
  x: number,
  y: number,
  w: number,
  h: number
): TreemapBox[] {
  if (items.length === 0) return [];
  if (items.length === 1) {
    return [
      {
        sector: items[0].sector,
        leftPct: x,
        topPct: y,
        widthPct: w,
        heightPct: h,
      },
    ];
  }

  const total = items.reduce((s, it) => s + it.areaWeight, 0) || 1;
  let halfSum = 0;
  let splitIdx = 1;
  for (let i = 0; i < items.length - 1; i++) {
    halfSum += items[i].areaWeight;
    splitIdx = i + 1;
    if (halfSum >= total * 0.46) break;
  }

  const leftItems = items.slice(0, splitIdx);
  const rightItems = items.slice(splitIdx);
  const ratio = leftItems.reduce((s, it) => s + it.areaWeight, 0) / total;

  // Split along the longer pixel axis accounting wide treemap aspect ratio
  const horizontalSplit = w * 2.75 >= h;
  if (horizontalSplit) {
    const wLeft = w * ratio;
    return [
      ...buildBinaryTreemap(leftItems, x, y, wLeft, h),
      ...buildBinaryTreemap(rightItems, x + wLeft, y, w - wLeft, h),
    ];
  }
  const hTop = h * ratio;
  return [
    ...buildBinaryTreemap(leftItems, x, y, w, hTop),
    ...buildBinaryTreemap(rightItems, x, y + hTop, w, h - hTop),
  ];
}

function SectorHeatmapModule({
  data,
  selectedSymbol,
  onSelectSymbol,
  loading = false,
}: SectorHeatmapModuleProps) {
  const [metric, setMetric] = useState<HeatmapMetric>("1d");
  const [hovered, setHovered] = useState<{
    sector: SectorHeatmapItem;
    x: number;
    y: number;
  } | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  const treemapBoxes = useMemo(() => {
    const list = [...(data?.sectors ?? [])];
    if (list.length === 0) return [];
    const weighted = list
      .map((sector) => ({
        sector,
        // Compress cap weights gently so smaller sectors (XLE/XLU/XLRE/XLB) stay generously legible
        areaWeight: Math.pow(Math.max(2.8, sector.market_weight_pct), 0.58),
      }))
      .sort((a, b) => b.areaWeight - a.areaWeight);

    return buildBinaryTreemap(weighted, 0, 0, 100, 100);
  }, [data]);

  const clearHideTimer = () => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const scheduleHide = () => {
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      setHovered(null);
    }, 110);
  };

  const metricTabs: { id: HeatmapMetric; label: string }[] = [
    { id: "1d", label: "今日 1D" },
    { id: "5d", label: "近5日" },
    { id: "20d", label: "近20日" },
    { id: "vsSpy", label: "跑赢SPY" },
  ];

  // Clamp tooltip position safely inside viewport above the sticky bottom ticker strip
  const tooltipPos = useMemo(() => {
    if (!hovered || typeof window === "undefined") {
      return { left: 0, top: 0 };
    }
    const cardW = 440;
    const cardH = 314;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const safeBottom = vh - 68;
    const safeTop = 64;
    const left =
      hovered.x + 18 + cardW > vw - 12
        ? Math.max(12, hovered.x - cardW - 14)
        : hovered.x + 18;
    const rawTop =
      hovered.y + 14 + cardH > safeBottom
        ? hovered.y - cardH - 10
        : hovered.y + 14;
    const top = Math.min(Math.max(safeTop, rawTop), Math.max(safeTop, safeBottom - cardH));
    return { left, top };
  }, [hovered]);

  return (
    <SpotlightBlock
      tone="gallery"
      className="flex h-full flex-col justify-between gap-2.5 p-3.5 sm:p-4"
    >
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 font-sans text-sm font-bold tracking-tight text-zinc-950 dark:text-white">
            <Grid className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            <span>美股 11 板块实时热力矩阵</span>
          </div>
          {data?.summary_zh && (
            <span className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-100/90 px-2.5 py-0.5 font-sans text-[11px] font-medium text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-200">
              <Sparkles className="h-3 w-3 text-amber-500 dark:text-amber-400" />
              {data.summary_zh}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden items-center gap-1 font-sans text-[10.5px] text-zinc-600 dark:text-zinc-400 md:inline-flex">
            <MousePointerClick className="h-3 w-3" />
            悬浮透视10大权重龙头 · 点击切主图
          </span>
          <div className="flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-100/90 p-0.5 font-sans text-[11px] dark:border-zinc-700 dark:bg-zinc-900">
            {metricTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setMetric(t.id)}
                className={`rounded-full px-2.5 py-0.5 font-medium transition ${
                  metric === t.id
                    ? "bg-zinc-950 text-white shadow-sm dark:bg-white dark:text-zinc-950"
                    : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Finviz Weighted Treemap Canvas */}
      <div
        className="relative min-h-[240px] w-full flex-1 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100/80 dark:border-zinc-800 dark:bg-zinc-950/80"
        onMouseLeave={scheduleHide}
      >
        {treemapBoxes.length === 0 ? (
          <div className="flex h-full items-center justify-center font-mono text-xs text-zinc-600 dark:text-zinc-400">
            {loading ? "正在加载全美股 11 板块与 110 大权重龙头行情..." : "暂无板块热力数据"}
          </div>
        ) : (
          treemapBoxes.map((box) => {
            const { sector, leftPct, topPct, widthPct, heightPct } = box;
            const val = getMetricValue(sector, metric);
            const active = selectedSymbol === sector.symbol;
            const tone = heatTileColors(val, active);
            const isLarge = widthPct >= 18 && heightPct >= 30;
            const isMedium = widthPct >= 11 && heightPct >= 22;
            const isTight = heightPct < 21 || widthPct < 13;

            return (
              <button
                key={sector.symbol}
                type="button"
                onClick={() => onSelectSymbol(sector.symbol)}
                onMouseEnter={(e) => {
                  clearHideTimer();
                  setHovered({ sector, x: e.clientX, y: e.clientY });
                }}
                onMouseMove={(e) => {
                  clearHideTimer();
                  setHovered({ sector, x: e.clientX, y: e.clientY });
                }}
                style={{
                  left: `calc(${leftPct}% + 2px)`,
                  top: `calc(${topPct}% + 2px)`,
                  width: `calc(${widthPct}% - 4px)`,
                  height: `calc(${heightPct}% - 4px)`,
                }}
                className={`group absolute flex flex-col justify-between overflow-hidden rounded-lg border text-left transition-colors ${
                  isTight ? "p-1.5" : "p-2"
                } ${tone.bg} ${tone.border}`}
              >
                <div className="flex items-start justify-between gap-1">
                  <div className="min-w-0 leading-tight">
                    <div
                      className={`truncate font-sans font-bold text-white ${
                        isLarge ? "text-sm" : isTight ? "text-[11px]" : "text-xs"
                      }`}
                    >
                      {sector.short_zh}
                    </div>
                    {!isTight && (
                      <div className="font-mono text-[10px] font-semibold text-white/80">
                        {sector.symbol}
                        {isLarge ? ` · ${sector.market_weight_pct.toFixed(1)}%` : ""}
                      </div>
                    )}
                  </div>
                  {sector.price != null && isMedium && (
                    <span className="shrink-0 rounded bg-black/25 px-1.5 py-0.5 font-mono text-[10px] text-white/90">
                      ${sector.price.toFixed(1)}
                    </span>
                  )}
                </div>

                <div>
                  <div
                    className={`font-mono font-bold leading-none tabular-nums tracking-tight ${tone.badge} ${
                      isLarge ? "text-xl" : isMedium ? "text-base" : "text-xs sm:text-sm"
                    }`}
                  >
                    {val != null ? `${val >= 0 ? "+" : ""}${val.toFixed(2)}%` : "—"}
                  </div>

                  {isLarge && sector.constituents.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {sector.constituents.slice(0, 4).map((c) => (
                        <span
                          key={c.symbol}
                          className="rounded bg-black/25 px-1.5 py-0.5 font-mono text-[9.5px] text-white/90"
                        >
                          {c.symbol}{" "}
                          {c.change_1d_pct != null
                            ? `${c.change_1d_pct >= 0 ? "+" : ""}${c.change_1d_pct.toFixed(1)}%`
                            : ""}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Color Legend */}
      <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
        <span>面积按标普行业权重等比例缩放 · 悬浮板块查看前 10 大权重股实时表现</span>
        <div className="flex items-center gap-1">
          <span className="rounded bg-rose-600 px-1.5 py-0.5 text-white">-2.5%+</span>
          <span className="rounded bg-rose-900 px-1.5 py-0.5 text-rose-100">-0.8%</span>
          <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">0%</span>
          <span className="rounded bg-emerald-800 px-1.5 py-0.5 text-emerald-100">+0.8%</span>
          <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-white">+2.5%+</span>
        </div>
      </div>

      {/* Cursor-Following Floating Top-10 Constituents Glass Card */}
      {hovered &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            onMouseEnter={clearHideTimer}
            onMouseLeave={scheduleHide}
            style={{ left: tooltipPos.left, top: tooltipPos.top }}
            className="fixed z-50 w-[440px] max-w-[calc(100vw-24px)] rounded-2xl border border-zinc-200/90 bg-white/95 p-3 text-zinc-950 shadow-2xl backdrop-blur-xl dark:border-white/20 dark:bg-zinc-950/95 dark:text-white"
          >
            <div className="flex items-start justify-between gap-2 border-b border-zinc-200 pb-2 dark:border-zinc-800">
              <div>
                <div className="font-sans text-xs font-bold text-zinc-950 dark:text-white">
                  {hovered.sector.name_zh}
                </div>
                <div className="mt-0.5 font-mono text-[10.5px] text-zinc-600 dark:text-zinc-400">
                  {hovered.sector.symbol} · 标普权重 {hovered.sector.market_weight_pct.toFixed(1)}% ·{" "}
                  {hovered.sector.price != null ? `$${hovered.sector.price.toFixed(2)}` : ""}
                </div>
              </div>
              <div className="text-right font-mono text-xs tabular-nums">
                <div
                  className={`font-bold ${
                    (hovered.sector.return_1d_pct ?? 0) >= 0
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-rose-700 dark:text-rose-400"
                  }`}
                >
                  1D{" "}
                  {hovered.sector.return_1d_pct != null
                    ? `${hovered.sector.return_1d_pct >= 0 ? "+" : ""}${hovered.sector.return_1d_pct.toFixed(2)}%`
                    : "—"}
                </div>
                <div className="text-[10px] text-zinc-600 dark:text-zinc-400">
                  20D{" "}
                  {hovered.sector.return_20d_pct != null
                    ? `${hovered.sector.return_20d_pct >= 0 ? "+" : ""}${hovered.sector.return_20d_pct.toFixed(2)}%`
                    : "—"}
                </div>
              </div>
            </div>

            <div className="mt-2 flex items-center justify-between font-sans text-[10.5px] font-semibold text-zinc-600 dark:text-zinc-400">
              <span>重仓 Top {hovered.sector.constituents.length} 龙头股（点击个股直切 K 线 & 期权雷达）</span>
              <span className="font-mono text-[9.5px] text-zinc-500">现价 / 今日涨跌</span>
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              {hovered.sector.constituents.slice(0, 10).map((c, idx) => {
                const chg = c.change_1d_pct;
                const up = (chg ?? 0) >= 0;
                const barW = Math.min(100, Math.max(8, Math.abs(chg ?? 0) * 18));
                return (
                  <button
                    key={c.symbol}
                    type="button"
                    onClick={() => {
                      onSelectSymbol(c.symbol);
                      setHovered(null);
                    }}
                    className="flex w-full items-center justify-between gap-1.5 rounded-lg border border-zinc-200/90 bg-zinc-50/90 px-2 py-1 text-left transition hover:border-zinc-400 hover:bg-zinc-100 dark:border-zinc-800/80 dark:bg-zinc-900/85 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <span className="font-mono text-[9px] text-zinc-500 tabular-nums">
                          {idx + 1}.
                        </span>
                        <span className="font-mono text-[11px] font-bold text-zinc-950 dark:text-white">
                          {c.symbol}
                        </span>
                        <span className="truncate font-sans text-[10px] text-zinc-700 dark:text-zinc-300">
                          {c.name_zh}
                        </span>
                      </div>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                        <div
                          className={`h-full rounded-full ${
                            up ? "bg-emerald-500" : "bg-rose-500"
                          }`}
                          style={{ width: `${barW}%` }}
                        />
                      </div>
                    </div>
                    <div className="shrink-0 text-right font-mono text-[10.5px] leading-tight tabular-nums">
                      <div className="text-zinc-800 dark:text-zinc-200">
                        {c.price != null ? `$${c.price.toFixed(1)}` : "—"}
                      </div>
                      <div
                        className={`font-bold ${
                          chg == null
                            ? "text-zinc-500"
                            : up
                              ? "text-emerald-700 dark:text-emerald-400"
                              : "text-rose-700 dark:text-rose-400"
                        }`}
                      >
                        {chg != null ? `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%` : "—"}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </SpotlightBlock>
  );
}

export default React.memo(SectorHeatmapModule);

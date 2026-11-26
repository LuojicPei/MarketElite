"use client";

import React, { useMemo, useState } from "react";
import { ArrowRight, GitCommitHorizontal, Target } from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import type { WatchlistAssetItem } from "@/lib/api";
import { computeRsiAtOffset, computeSingleStockStats } from "@/lib/watchlistQuant";

interface WatchlistQuadrantRadarProps {
  items: WatchlistAssetItem[];
  palette: string[];
  highlightSymbol: string | null;
  onHoverSymbol: (symbol: string | null) => void;
  onOpenStockDetail: (symbol: string) => void;
  onApplySymbolsToSimulator?: (symbols: string[], label: string) => void;
}

type RadarMode = "momentum" | "valuation" | "risk_reward";
type MomentumHorizon = "1d" | "5d" | "1m" | "6m" | "ytd";

const MOMENTUM_HORIZONS: {
  id: MomentumHorizon;
  label: string;
  lookbackBars: number;
}[] = [
  { id: "1d", label: "1日", lookbackBars: 1 },
  { id: "5d", label: "5日", lookbackBars: 5 },
  { id: "1m", label: "1月", lookbackBars: 21 },
  { id: "6m", label: "6月", lookbackBars: 126 },
  { id: "ytd", label: "YTD", lookbackBars: 0 },
];

function getItemMomentumPct(item: WatchlistAssetItem, horizon: MomentumHorizon): number {
  switch (horizon) {
    case "1d":
      return item.change_1d_pct ?? 0;
    case "5d":
      return item.change_5d_pct ?? 0;
    case "1m":
      return item.change_1m_pct ?? 0;
    case "6m":
      return item.change_6m_pct ?? 0;
    case "ytd":
      return item.change_ytd_pct ?? 0;
  }
}

interface PlottedBubble {
  item: WatchlistAssetItem;
  color: string;
  anchorX: number;
  anchorY: number;
  cx: number;
  cy: number;
  r: number;
  xLabel: string;
  yLabel: string;
  sizeLabel: string;
  isAnomaly: boolean;
  isWinnerZone: boolean;
  trailX?: number;
  trailY?: number;
}

const VB_W = 940;
const VB_H = 340;
const PAD_L = 58;
const PAD_R = 28;
const PAD_T = 28;
const PAD_B = 40;

/** Run lightweight iterative collision separation so overlapping tickers stay legible without breaking anchor truth. */
function nudgeCollidingBubbles(raw: PlottedBubble[]): PlottedBubble[] {
  const nodes = raw.map((b) => ({ ...b }));
  const minX = PAD_L + 18;
  const maxX = VB_W - PAD_R - 18;
  const minY = PAD_T + 18;
  const maxY = VB_H - PAD_B - 18;

  for (let iter = 0; iter < 20; iter++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = b.cx - a.cx;
        const dy = b.cy - a.cy;
        const dist = Math.hypot(dx, dy) || 0.01;
        const minDist = a.r + b.r + 5;
        if (dist < minDist) {
          const push = (minDist - dist) * 0.45;
          const ux = dx / dist;
          const uy = dy / dist;
          a.cx = Math.max(minX, Math.min(maxX, a.cx - ux * push));
          a.cy = Math.max(minY, Math.min(maxY, a.cy - uy * push));
          b.cx = Math.max(minX, Math.min(maxX, b.cx + ux * push));
          b.cy = Math.max(minY, Math.min(maxY, b.cy + uy * push));
        }
      }
    }
  }
  return nodes;
}

function WatchlistQuadrantRadar({
  items,
  palette,
  highlightSymbol,
  onHoverSymbol,
  onOpenStockDetail,
  onApplySymbolsToSimulator,
}: WatchlistQuadrantRadarProps) {
  const [mode, setMode] = useState<RadarMode>("momentum");
  const [momHorizon, setMomHorizon] = useState<MomentumHorizon>("1d");
  const [showTrail, setShowTrail] = useState<boolean>(true);
  const [localHoverSym, setLocalHoverSym] = useState<string | null>(null);

  const plot = useMemo(() => {
    const plotW = VB_W - PAD_L - PAD_R;
    const plotH = VB_H - PAD_T - PAD_B;
    if (items.length === 0) return null;

    if (mode === "momentum") {
      const horizonMeta =
        MOMENTUM_HORIZONS.find((h) => h.id === momHorizon) ?? MOMENTUM_HORIZONS[0];
      const yVals = items.map((it) => getItemMomentumPct(it, momHorizon));
      const rawMin = Math.min(0, ...yVals);
      const rawMax = Math.max(0, ...yVals);
      const absMax = Math.max(4, Math.abs(rawMin), Math.abs(rawMax)) * 1.18;
      const yMin = Math.min(-2, rawMin < 0 ? rawMin * 1.18 : -absMax * 0.28);
      const yMax = Math.max(2, rawMax > 0 ? rawMax * 1.18 : absMax * 0.28);
      const ySpan = Math.max(1e-6, yMax - yMin);

      const xMin = 15;
      const xMax = 85;
      const mapX = (rsi: number) =>
        PAD_L + ((Math.max(xMin, Math.min(xMax, rsi)) - xMin) / (xMax - xMin)) * plotW;
      const mapY = (pct: number) => PAD_T + ((yMax - pct) / ySpan) * plotH;

      const xMid = mapX(50);
      const yZero = mapY(0);

      const rawBubbles: PlottedBubble[] = items.map((item, idx) => {
        const rsi = item.rsi_14 ?? 50;
        const pct = getItemMomentumPct(item, momHorizon);
        const rvol = item.rvol_20 ?? 1.0;
        const r = Math.max(12, Math.min(26, 9.5 + Math.sqrt(Math.max(0.25, rvol)) * 7.2));
        const ax = mapX(rsi);
        const ay = mapY(pct);

        // Compute real 5-trading-days-ago historical momentum coordinates from daily_closes
        let trailX: number | undefined;
        let trailY: number | undefined;
        if (item.daily_closes.length >= 22) {
          const histRsi = computeRsiAtOffset(item.daily_closes, 5);
          const idxEnd = item.daily_closes.length - 6;
          let idxPrev = -1;
          if (momHorizon === "ytd" && idxEnd > 0) {
            const yr = item.daily_closes[idxEnd].d.slice(0, 4);
            const yrIdx = item.daily_closes.findIndex((pt) => pt.d.startsWith(yr));
            idxPrev = yrIdx > 0 ? yrIdx - 1 : 0;
          } else {
            idxPrev = idxEnd - horizonMeta.lookbackBars;
          }
          if (
            histRsi !== null &&
            idxEnd > idxPrev &&
            idxPrev >= 0 &&
            item.daily_closes[idxPrev].c > 0
          ) {
            const histPct =
              ((item.daily_closes[idxEnd].c / item.daily_closes[idxPrev].c) - 1) * 100;
            trailX = mapX(histRsi);
            trailY = mapY(Math.max(yMin * 0.96, Math.min(yMax * 0.96, histPct)));
          }
        }

        return {
          item,
          color: palette[idx % palette.length],
          anchorX: ax,
          anchorY: ay,
          cx: ax,
          cy: ay,
          r,
          xLabel: `RSI ${rsi.toFixed(1)}`,
          yLabel: `${horizonMeta.label} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          sizeLabel: `量比 ${rvol.toFixed(2)}x`,
          isAnomaly: rvol >= 1.8,
          isWinnerZone: pct >= 0,
          trailX,
          trailY,
        };
      });

      const bubbles = nudgeCollidingBubbles(rawBubbles);
      return {
        bubbles,
        xMid,
        yZero,
        xTicks: [20, 32, 50, 70, 80].map((v) => ({ label: `${v}`, x: mapX(v), warn: v === 32 || v === 70 })),
        yTicks: [yMax, 0, yMin].map((v) => ({
          label: `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
          y: mapY(v),
          isZero: Math.abs(v) < 1e-6,
        })),
        quadLabels: [
          { x: PAD_L + 8, y: PAD_T + 14, anchor: "start", text: "低位修复反弹", cls: "fill-sky-600 dark:fill-sky-400" },
          { x: VB_W - PAD_R - 8, y: PAD_T + 14, anchor: "end", text: "放量主升领涨", cls: "fill-emerald-600 dark:fill-emerald-400" },
          { x: PAD_L + 8, y: VB_H - PAD_B - 8, anchor: "start", text: "弱势超卖承压", cls: "fill-rose-600 dark:fill-rose-400" },
          { x: VB_W - PAD_R - 8, y: VB_H - PAD_B - 8, anchor: "end", text: "高位分歧回踩", cls: "fill-amber-600 dark:fill-amber-400" },
        ],
        hasUnprofitableColumn: false,
        xAxisName: "RSI(14) 相对强弱",
        legendText: "气泡面积 = RVOL 量比 · 虚线箭头 = 5日前动量迁移轨迹",
        exportLabel: "导入正收益领涨标的",
      };
    }

    if (mode === "risk_reward") {
      const statsMap = new Map(
        items.map((it) => [it.symbol, computeSingleStockStats(it, "YTD")])
      );
      const ddMag = (sym: string) => Math.abs(statsMap.get(sym)?.maxDrawdownPct ?? 0);
      const maxDdAxis = Math.max(25, Math.min(90, Math.ceil(Math.max(...items.map((i) => ddMag(i.symbol))) * 1.12 / 5) * 5));
      const sortedDd = items.map((i) => ddMag(i.symbol)).sort((a, b) => a - b);
      const medianDd = sortedDd[Math.floor(sortedDd.length / 2)] ?? 25;

      const yVals = items.map((it) => statsMap.get(it.symbol)?.totalReturnPct ?? 0);
      const rawMin = Math.min(0, ...yVals);
      const rawMax = Math.max(0, ...yVals);
      const yMin = rawMin < 0 ? rawMin * 1.42 : -12;
      const yMax = rawMax > 0 ? rawMax * 1.18 : 10;
      const ySpan = Math.max(1e-6, yMax - yMin);

      const mapX = (d: number) => PAD_L + (Math.min(maxDdAxis, Math.max(0, d)) / maxDdAxis) * plotW;
      const mapY = (ret: number) => PAD_T + ((yMax - ret) / ySpan) * plotH;

      const xMid = mapX(medianDd);
      const yZero = mapY(0);

      const rawBubbles: PlottedBubble[] = items.map((item, idx) => {
        const st = statsMap.get(item.symbol)!;
        const ddAbs = Math.abs(st.maxDrawdownPct);
        const ret = st.totalReturnPct;
        const cap = item.market_cap_b ?? 8;
        const r = Math.max(11.5, Math.min(26, 8 + Math.log10(Math.max(0.2, cap) + 1) * 6.2));
        const ax = mapX(ddAbs);
        const ay = mapY(ret);
        return {
          item,
          color: palette[idx % palette.length],
          anchorX: ax,
          anchorY: ay,
          cx: ax,
          cy: ay,
          r,
          xLabel: `最大回撤 -${ddAbs.toFixed(1)}%`,
          yLabel: `YTD ${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%`,
          sizeLabel: `年化波动 ${st.annVolPct.toFixed(1)}%`,
          isAnomaly: ret > 0 && ddAbs <= medianDd,
          isWinnerZone: ret > 0 && ddAbs <= medianDd * 1.15,
        };
      });

      const bubbles = nudgeCollidingBubbles(rawBubbles);
      return {
        bubbles,
        xMid,
        yZero,
        xTicks: [0, Math.round(maxDdAxis * 0.35), Math.round(maxDdAxis * 0.7), maxDdAxis].map((v) => ({
          label: `-${v}%`,
          x: mapX(v),
          warn: false,
        })),
        yTicks: [yMax, 0, yMin].map((v) => ({
          label: `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
          y: mapY(v),
          isZero: Math.abs(v) < 1e-6,
        })),
        quadLabels: [
          { x: PAD_L + 8, y: PAD_T + 14, anchor: "start", text: "低回撤高盈利 (金牛区)", cls: "fill-emerald-600 dark:fill-emerald-400" },
          { x: VB_W - PAD_R - 8, y: PAD_T + 14, anchor: "end", text: "高弹性妖股区", cls: "fill-sky-600 dark:fill-sky-400" },
          { x: PAD_L + 8, y: VB_H - PAD_B - 8, anchor: "start", text: "微亏弱震荡区", cls: "fill-amber-600 dark:fill-amber-400" },
          { x: VB_W - PAD_R - 8, y: VB_H - PAD_B - 8, anchor: "end", text: "深幅回撤亏损区", cls: "fill-rose-600 dark:fill-rose-400" },
        ],
        hasUnprofitableColumn: false,
        xAxisName: "年内最大回撤幅度 (越靠左越抗跌)",
        legendText: "气泡面积 = 总市值 · 左上方代表抗跌又能赚的优质压舱石",
        exportLabel: "导入高性价比抗跌股",
      };
    }

    // Valuation Mode: X = PE(TTM) vs Y = YTD% (Radius = Market Cap $B)
    const positivePes = items
      .map((it) => it.pe_ttm)
      .filter((v): v is number => typeof v === "number" && v > 0)
      .sort((a, b) => a - b);
    const hasUnprof = items.some((it) => typeof it.pe_ttm !== "number" || it.pe_ttm <= 0);
    const leftGutterW = hasUnprof ? 92 : 0;
    const peStart = PAD_L + leftGutterW;
    const peW = plotW - leftGutterW;

    const peCap = positivePes.length
      ? Math.max(45, Math.min(95, Math.ceil((positivePes[positivePes.length - 1] ?? 50) * 1.08 / 5) * 5))
      : 60;
    const medianPe = positivePes.length
      ? positivePes[Math.floor(positivePes.length / 2)]
      : 28;

    const yVals = items.map((it) => it.change_ytd_pct ?? 0);
    const rawMin = Math.min(0, ...yVals);
    const rawMax = Math.max(0, ...yVals);
    const yMin = rawMin < 0 ? rawMin * 1.38 : -12;
    const yMax = rawMax > 0 ? rawMax * 1.18 : 10;
    const ySpan = Math.max(1e-6, yMax - yMin);

    const mapX = (pe: number | null | undefined) => {
      if (typeof pe !== "number" || pe <= 0) return PAD_L + leftGutterW * 0.45;
      const clamped = Math.min(peCap, Math.max(0, pe));
      return peStart + (clamped / peCap) * peW;
    };
    const mapY = (ytd: number) => PAD_T + ((yMax - ytd) / ySpan) * plotH;

    const xMid = mapX(Math.min(peCap, medianPe));
    const yZero = mapY(0);

    const rawBubbles: PlottedBubble[] = items.map((item, idx) => {
      const cap = item.market_cap_b ?? 5;
      const ytd = item.change_ytd_pct ?? 0;
      const pe = item.pe_ttm;
      const r = Math.max(11.5, Math.min(26, 8 + Math.log10(Math.max(0.2, cap) + 1) * 6.2));
      const ax = mapX(pe);
      const ay = mapY(ytd);
      return {
        item,
        color: palette[idx % palette.length],
        anchorX: ax,
        anchorY: ay,
        cx: ax,
        cy: ay,
        r,
        xLabel: typeof pe === "number" && pe > 0 ? `PE ${pe.toFixed(1)}x` : "暂无正PE",
        yLabel: `YTD ${ytd >= 0 ? "+" : ""}${ytd.toFixed(2)}%`,
        sizeLabel: cap >= 1000 ? `市值 $${(cap / 1000).toFixed(2)}T` : `市值 $${cap.toFixed(1)}B`,
        isAnomaly: cap >= 1000,
        isWinnerZone: typeof pe === "number" && pe > 0 && ytd >= 0,
      };
    });

    const bubbles = nudgeCollidingBubbles(rawBubbles);
    return {
      bubbles,
      xMid,
      yZero,
      xTicks: [
        ...(hasUnprof ? [{ label: "未盈利/NA", x: PAD_L + leftGutterW * 0.45, warn: true }] : []),
        ...[0, Math.round(peCap * 0.35), Math.round(peCap * 0.7), peCap].map((v) => ({
          label: `${v}x`,
          x: peStart + (v / peCap) * peW,
          warn: false,
        })),
      ],
      yTicks: [yMax, 0, yMin].map((v) => ({
        label: `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
        y: mapY(v),
        isZero: Math.abs(v) < 1e-6,
      })),
      quadLabels: [
        { x: peStart + 8, y: PAD_T + 14, anchor: "start", text: "低估值高回报", cls: "fill-emerald-600 dark:fill-emerald-400" },
        { x: VB_W - PAD_R - 8, y: PAD_T + 14, anchor: "end", text: "高估值高景气", cls: "fill-sky-600 dark:fill-sky-400" },
        { x: peStart + 8, y: VB_H - PAD_B - 8, anchor: "start", text: "低PE深度折价", cls: "fill-amber-600 dark:fill-amber-400" },
        { x: VB_W - PAD_R - 8, y: VB_H - PAD_B - 8, anchor: "end", text: "高估值杀跌区", cls: "fill-rose-600 dark:fill-rose-400" },
      ],
      hasUnprofitableColumn: hasUnprof,
      peDividerX: peStart - 8,
      xAxisName: "PE(TTM) 估值倍数",
      legendText: "气泡面积 = 总市值 · 左虚线柱收录未盈利高成长弹射标的",
      exportLabel: "导入正盈利增长股",
    };
  }, [items, mode, momHorizon, palette]);

  const activeSym = localHoverSym || highlightSymbol;
  const activeBubble = plot?.bubbles.find((b) => b.item.symbol === activeSym) ?? null;

  const orderedBubbles = useMemo(() => {
    if (!plot) return [];
    return [...plot.bubbles].sort((a, b) => {
      const aAct = a.item.symbol === activeSym ? 1 : 0;
      const bAct = b.item.symbol === activeSym ? 1 : 0;
      if (aAct !== bAct) return aAct - bAct;
      return b.r - a.r;
    });
  }, [activeSym, plot]);

  const winnerSymbols = useMemo(
    () => (plot ? plot.bubbles.filter((b) => b.isWinnerZone).map((b) => b.item.symbol) : []),
    [plot]
  );

  return (
    <SpotlightBlock tone="obsidian" className="overflow-hidden p-4">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <span className="font-mono text-xs font-semibold tracking-wider text-zinc-800 dark:text-zinc-200">
            4-QUADRANT RADAR · 四象限气泡雷达
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
          {mode === "momentum" && (
            <>
              <div className="inline-flex rounded-full border border-zinc-300/80 bg-white/80 p-0.5 dark:border-white/15 dark:bg-white/[0.06]">
                {MOMENTUM_HORIZONS.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => setMomHorizon(h.id)}
                    className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold transition ${
                      momHorizon === h.id
                        ? "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-zinc-950"
                        : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                    }`}
                  >
                    {h.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setShowTrail((v) => !v)}
                title="显示近5个交易日 RSI 与涨跌幅迁移方向轨迹"
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold transition ${
                  showTrail
                    ? "border-emerald-500/45 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    : "border-zinc-300 bg-white text-zinc-600 dark:border-white/15 dark:bg-white/[0.05] dark:text-zinc-300"
                }`}
              >
                <GitCommitHorizontal className="h-3 w-3" />
                5日轨迹
              </button>
            </>
          )}

          <div className="inline-flex rounded-full border border-zinc-300/80 bg-white/80 p-0.5 dark:border-white/15 dark:bg-white/[0.06]">
            {(
              [
                { id: "momentum", label: "动量 × 放量" },
                { id: "valuation", label: "PE估值 × 市值" },
                { id: "risk_reward", label: "收益 × 回撤" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setMode(tab.id)}
                className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold transition ${
                  mode === tab.id
                    ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                    : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {!plot ? (
        <div className="flex h-48 items-center justify-center font-mono text-xs text-zinc-500 dark:text-zinc-400">
          暂无自选股分布数据
        </div>
      ) : (
      <div className="relative rounded-xl bg-zinc-50/70 p-2.5 dark:bg-white/[0.02]">
          <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="block h-auto w-full select-none overflow-visible">
            <defs>
              <marker
                id="radar-arrow"
                viewBox="0 0 8 8"
                refX="6"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 7 4 L 0 7 z" fill="currentColor" opacity="0.65" />
              </marker>
            </defs>

            {plot.yTicks.map((t, idx) => (
              <g key={`yt-${idx}`}>
                <line
                  x1={PAD_L}
                  y1={t.y}
                  x2={VB_W - PAD_R}
                  y2={t.y}
                  className={
                    t.isZero
                      ? "stroke-zinc-400/70 dark:stroke-white/25"
                      : "stroke-zinc-200/80 dark:stroke-white/[0.07]"
                  }
                  strokeDasharray={t.isZero ? "4 3" : "2 4"}
                  strokeWidth={t.isZero ? 1.3 : 0.9}
                />
                <text
                  x={PAD_L - 8}
                  y={t.y + 4}
                  textAnchor="end"
                  className="fill-zinc-500 font-mono text-[11px] dark:fill-zinc-400"
                >
                  {t.label}
                </text>
              </g>
            ))}

            {plot.hasUnprofitableColumn && plot.peDividerX && (
              <line
                x1={plot.peDividerX}
                y1={PAD_T}
                x2={plot.peDividerX}
                y2={VB_H - PAD_B}
                className="stroke-zinc-300 dark:stroke-white/15"
                strokeDasharray="3 3"
                strokeWidth={1.1}
              />
            )}

            <line
              x1={plot.xMid}
              y1={PAD_T}
              x2={plot.xMid}
              y2={VB_H - PAD_B}
              className="stroke-zinc-400/70 dark:stroke-white/25"
              strokeDasharray="4 3"
              strokeWidth={1.2}
            />

            {plot.xTicks.map((t, idx) => (
              <g key={`xt-${idx}`}>
                {t.warn && (
                  <line
                    x1={t.x}
                    y1={PAD_T}
                    x2={t.x}
                    y2={VB_H - PAD_B}
                    className="stroke-amber-400/35 dark:stroke-amber-400/20"
                    strokeDasharray="2 4"
                    strokeWidth={1}
                  />
                )}
                <text
                  x={t.x}
                  y={VB_H - PAD_B + 16}
                  textAnchor="middle"
                  className="fill-zinc-500 font-mono text-[11px] dark:fill-zinc-400"
                >
                  {t.label}
                </text>
              </g>
            ))}

            <text
              x={(PAD_L + VB_W - PAD_R) / 2}
              y={VB_H - 5}
              textAnchor="middle"
              className="fill-zinc-500 font-sans text-[11.5px] font-medium dark:fill-zinc-400"
            >
              {plot.xAxisName}
            </text>

            {plot.quadLabels.map((q, idx) => (
              <text
                key={`ql-${idx}`}
                x={q.x}
                y={q.y}
                textAnchor={q.anchor as "start" | "end"}
                className={`${q.cls} font-sans text-[11.5px] font-bold opacity-85`}
              >
                {q.text}
              </text>
            ))}

            {/* Motion Trails (Rendered beneath active bubbles in Momentum mode) */}
            {mode === "momentum" &&
              showTrail &&
              orderedBubbles.map((b) => {
                if (b.trailX === undefined || b.trailY === undefined) return null;
                const dist = Math.hypot(b.anchorX - b.trailX, b.anchorY - b.trailY);
                if (dist < 8) return null;
                const isFocus = activeSym === b.item.symbol;
                const opacity = activeSym ? (isFocus ? 0.92 : 0.14) : 0.45;
                return (
                  <g key={`tr-${b.item.symbol}`} opacity={opacity} style={{ color: b.color }}>
                    <circle cx={b.trailX} cy={b.trailY} r={3} fill={b.color} />
                    <line
                      x1={b.trailX}
                      y1={b.trailY}
                      x2={b.anchorX}
                      y2={b.anchorY}
                      stroke={b.color}
                      strokeWidth={isFocus ? 2 : 1.35}
                      strokeDasharray="4 3"
                      markerEnd="url(#radar-arrow)"
                    />
                  </g>
                );
              })}

            {/* Bubbles with Subtle Anchor Tether When Nudged Apart */}
            {orderedBubbles.map((b) => {
              const isFocus = activeSym === b.item.symbol;
              const isDim = Boolean(activeSym && !isFocus);
              const nudged = Math.hypot(b.cx - b.anchorX, b.cy - b.anchorY) > 4;
              return (
                <g
                  key={b.item.symbol}
                  className="cursor-pointer transition-opacity duration-150"
                  opacity={isDim ? 0.28 : 1}
                  onMouseEnter={() => {
                    setLocalHoverSym(b.item.symbol);
                    onHoverSymbol(b.item.symbol);
                  }}
                  onMouseLeave={() => {
                    setLocalHoverSym(null);
                    onHoverSymbol(null);
                  }}
                  onClick={() => onOpenStockDetail(b.item.symbol)}
                >
                  {nudged && (
                    <>
                      <line
                        x1={b.anchorX}
                        y1={b.anchorY}
                        x2={b.cx}
                        y2={b.cy}
                        className="stroke-zinc-400/50 dark:stroke-white/25"
                        strokeWidth={1.1}
                      />
                      <circle cx={b.anchorX} cy={b.anchorY} r={2.2} fill={b.color} />
                    </>
                  )}
                  {(b.isAnomaly || isFocus) && (
                    <circle
                      cx={b.cx}
                      cy={b.cy}
                      r={b.r + (isFocus ? 6 : 4)}
                      fill="none"
                      stroke={b.color}
                      strokeOpacity={isFocus ? 0.85 : 0.42}
                      strokeWidth={isFocus ? 2 : 1.3}
                    />
                  )}
                  <circle
                    cx={b.cx}
                    cy={b.cy}
                    r={b.r}
                    fill={b.color}
                    fillOpacity={isFocus ? 0.94 : 0.78}
                    stroke={isFocus ? "#ffffff" : b.color}
                    strokeWidth={isFocus ? 2 : 1.2}
                  />
                  <text
                    x={b.cx}
                    y={
                      b.r >= 15.5
                        ? b.cy + 4
                        : b.cy > VB_H - PAD_B - 55
                          ? b.cy - b.r - 5
                          : b.cy + b.r + 12.5
                    }
                    textAnchor="middle"
                    className={`pointer-events-none font-mono text-[11px] font-bold ${
                      b.r >= 15.5
                        ? "fill-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.65)]"
                        : "fill-zinc-900 dark:fill-zinc-100"
                    }`}
                  >
                    {b.item.symbol}
                  </text>
                </g>
              );
            })}
          </svg>

          {activeBubble && (
            <div
              className={`pointer-events-none absolute z-20 rounded-xl border border-zinc-200/90 bg-white/95 px-2.5 py-2 font-mono text-[11px] shadow-lg dark:border-white/15 dark:bg-zinc-900/95 ${
                activeBubble.cx > VB_W * 0.55 ? "left-3" : "right-3"
              } ${activeBubble.cy > VB_H * 0.55 ? "top-3" : "bottom-3"}`}
            >
              <div className="flex items-center gap-1.5 font-sans font-bold text-zinc-950 dark:text-white">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: activeBubble.color }}
                />
                <span>{activeBubble.item.name}</span>
                <span className="font-mono text-zinc-500 dark:text-zinc-400">
                  ({activeBubble.item.symbol})
                </span>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10.5px] text-zinc-700 dark:text-zinc-300">
                <span>{activeBubble.yLabel}</span>
                <span>{activeBubble.xLabel}</span>
                <span>{activeBubble.sizeLabel}</span>
                <span>现价 ${activeBubble.item.price.toFixed(2)}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Footer with Direct One-Click Quadrant Export to Portfolio Simulator */}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 font-mono text-[10.5px] text-zinc-600 dark:text-zinc-400">
        <span>{plot?.legendText ?? ""}</span>
        {onApplySymbolsToSimulator && winnerSymbols.length > 0 && (
          <button
            type="button"
            onClick={() => onApplySymbolsToSimulator(winnerSymbols, plot?.exportLabel ?? "优势象限")}
            className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/12 px-2.5 py-1 font-sans text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-500/20 dark:text-emerald-300"
          >
            <span>{plot?.exportLabel} ({winnerSymbols.length}只) 至下方推演</span>
            <ArrowRight className="h-3 w-3" />
          </button>
        )}
      </div>
    </SpotlightBlock>
  );
}

export default React.memo(WatchlistQuadrantRadar);

"use client";

import React, { useEffect, useState } from "react";
import { Activity, LineChart, Target } from "lucide-react";
import {
  EquityCurvePoint,
  PortfolioAnalyticsResponse,
  QuadrantScatterPoint,
} from "@/lib/api";
import SpotlightBlock from "@/components/SpotlightBlock";

interface PortfolioAnalyticsChartsProps {
  analytics: PortfolioAnalyticsResponse | null;
  loading?: boolean;
}

function fmtMoney(val: number | undefined | null, currency: string): string {
  if (val === undefined || val === null || Number.isNaN(val)) return "—";
  const prefix =
    currency === "GBP" ? "£" : currency === "EUR" ? "€" : "$";
  const sign = val < 0 ? "-" : "";
  return `${sign}${prefix}${Math.abs(val).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function quadrantColor(q: string): string {
  switch (q) {
    case "GOOD_PROCESS_GOOD_OUTCOME":
      return "#10b981"; // emerald-500
    case "GOOD_PROCESS_BAD_OUTCOME":
      return "#0ea5e9"; // sky-500
    case "BAD_PROCESS_GOOD_OUTCOME":
      return "#f59e0b"; // amber-500
    default:
      return "#f43f5e"; // rose-500
  }
}

export default function PortfolioAnalyticsCharts({
  analytics,
  loading = false,
}: PortfolioAnalyticsChartsProps) {
  const [viewSource, setViewSource] = useState<"real" | "demo">("real");
  const [hoveredCurveIdx, setHoveredCurveIdx] = useState<number | null>(null);
  const [hoveredPt, setHoveredPt] = useState<QuadrantScatterPoint | null>(null);

  useEffect(() => {
    if (!analytics) return;
    setViewSource(analytics.kpis.closed_trades > 0 ? "real" : "demo");
  }, [analytics]);

  if (loading && !analytics) {
    return (
      <SpotlightBlock tone="gallery" className="p-5">
        <div className="h-52 animate-pulse rounded-2xl bg-zinc-100/80 dark:bg-white/[0.04]" />
      </SpotlightBlock>
    );
  }

  if (!analytics) return null;

  const isDemo = viewSource === "demo";
  const activeDataset = isDemo
    ? analytics.demo_preview
    : {
        currency: analytics.currency,
        kpis: analytics.kpis,
        equity_curve: analytics.equity_curve,
        quadrant_points: analytics.quadrant_points,
        quadrant_counts: analytics.quadrant_counts,
      };

  const kpis = activeDataset.kpis;
  const curve: EquityCurvePoint[] = activeDataset.equity_curve || [];
  const points: QuadrantScatterPoint[] = activeDataset.quadrant_points || [];
  const counts = activeDataset.quadrant_counts || {};
  const ccy = activeDataset.currency || "USD";

  // --- SVG 1 Geometry: Net Equity % vs SPY % ---
  const W1 = 560;
  const H1 = 210;
  const padL = 44;
  const padR = 16;
  const padT = 22;
  const padB = 30;
  const innerW1 = W1 - padL - padR;
  const innerH1 = H1 - padT - padB;

  const retValues = curve.flatMap((c) => [c.portfolio_return_pct, c.spy_return_pct, 0]);
  const rawMinY1 = retValues.length ? Math.min(...retValues) : -2;
  const rawMaxY1 = retValues.length ? Math.max(...retValues) : 4;
  const spanY1 = Math.max(2.0, (rawMaxY1 - rawMinY1) * 1.25);
  const midY1 = (rawMaxY1 + rawMinY1) / 2;
  const minY1 = midY1 - spanY1 / 2;
  const maxY1 = midY1 + spanY1 / 2;

  const mapX1 = (idx: number) =>
    curve.length <= 1
      ? padL + innerW1 / 2
      : padL + (idx / (curve.length - 1)) * innerW1;
  const mapY1 = (val: number) =>
    padT + innerH1 - ((val - minY1) / Math.max(0.01, maxY1 - minY1)) * innerH1;

  const portPath = curve
    .map((pt, i) => `${i === 0 ? "M" : "L"}${mapX1(i).toFixed(1)},${mapY1(pt.portfolio_return_pct).toFixed(1)}`)
    .join(" ");
  const spyPath = curve
    .map((pt, i) => `${i === 0 ? "M" : "L"}${mapX1(i).toFixed(1)},${mapY1(pt.spy_return_pct).toFixed(1)}`)
    .join(" ");
  const portAreaPath =
    curve.length >= 2
      ? `${portPath} L${mapX1(curve.length - 1).toFixed(1)},${mapY1(0).toFixed(1)} L${mapX1(0).toFixed(
          1
        )},${mapY1(0).toFixed(1)} Z`
      : "";

  const activeCurvePt =
    hoveredCurveIdx !== null && curve[hoveredCurveIdx]
      ? curve[hoveredCurveIdx]
      : curve[curve.length - 1] ?? null;

  // --- SVG 2 Geometry: 2x2 Quadrant Matrix (X=process_score 0..100, Y=return_pct) ---
  const W2 = 460;
  const H2 = 210;
  const qPadL = 42;
  const qPadR = 16;
  const qPadT = 26;
  const qPadB = 28;
  const qInnerW = W2 - qPadL - qPadR;
  const qInnerH = H2 - qPadT - qPadB;

  const ptYVals = points.map((p) => p.return_pct);
  const absYMax = Math.max(4, ...ptYVals.map((v) => Math.abs(v) * 1.45));
  const minY2 = -absYMax;
  const maxY2 = absYMax;

  const mapQX = (score: number) => qPadL + (Math.max(0, Math.min(100, score)) / 100) * qInnerW;
  const mapQY = (ret: number) =>
    qPadT + qInnerH - ((Math.max(minY2, Math.min(maxY2, ret)) - minY2) / (maxY2 - minY2)) * qInnerH;

  const splitX = mapQX(70);
  const splitY = mapQY(0);

  return (
    <SpotlightBlock tone="gallery" className="space-y-4 p-5">
      {/* Header & Source Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200/70 pb-3 dark:border-white/10">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-serif text-lg font-semibold tracking-tight text-zinc-950 sm:text-xl dark:text-white">
              组合绩效基准曲线与 2×2 四象限纪律矩阵
            </h3>
            {isDemo ? (
              <span className="rounded-full bg-amber-500/[0.15] px-2.5 py-0.5 font-mono text-[10px] font-semibold text-amber-800 dark:text-amber-300">
                演示样例预览 (6 笔全象限样本)
              </span>
            ) : (
              <span className="rounded-full bg-emerald-500/[0.15] px-2.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-800 dark:text-emerald-300">
                真实平仓账本 ({kpis.closed_trades} 笔已结算)
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            实时对比组合收益率与 SPY 大盘基准，并将「风控纪律评分 × 单笔盈亏结果」落位甄别真能力与运气单
          </p>
        </div>

        <div className="inline-flex rounded-xl bg-zinc-100/90 p-0.5 font-mono text-[11px] dark:bg-white/[0.06]">
          <button
            type="button"
            onClick={() => setViewSource("real")}
            className={`rounded-lg px-3 py-1 transition ${
              viewSource === "real"
                ? "bg-zinc-950 font-semibold text-white dark:bg-white dark:text-zinc-950"
                : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-300"
            }`}
          >
            真实账本 ({analytics.kpis.closed_trades})
          </button>
          <button
            type="button"
            onClick={() => setViewSource("demo")}
            className={`rounded-lg px-3 py-1 transition ${
              viewSource === "demo"
                ? "bg-zinc-950 font-semibold text-white dark:bg-white dark:text-zinc-950"
                : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-300"
            }`}
          >
            演示样例预览
          </button>
        </div>
      </div>

      {/* 5 Quant KPI Pills */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <div className="rounded-xl bg-zinc-50/90 px-3.5 py-2.5 dark:bg-white/[0.04]">
          <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            累计 Alpha (vs SPY)
          </div>
          <div
            className={`mt-1 font-mono text-base font-bold tabular-nums ${
              kpis.excess_alpha_pct >= 0
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-rose-700 dark:text-rose-400"
            }`}
          >
            {kpis.excess_alpha_pct >= 0 ? "+" : ""}
            {kpis.excess_alpha_pct.toFixed(2)}%
          </div>
          <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
            组合 {kpis.portfolio_return_pct >= 0 ? "+" : ""}
            {kpis.portfolio_return_pct.toFixed(2)}% · SPY {kpis.spy_return_pct >= 0 ? "+" : ""}
            {kpis.spy_return_pct.toFixed(2)}%
          </div>
        </div>

        <div className="rounded-xl bg-zinc-50/90 px-3.5 py-2.5 dark:bg-white/[0.04]">
          <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            交易胜率 Win Rate
          </div>
          <div className="mt-1 font-mono text-base font-bold tabular-nums text-zinc-950 dark:text-white">
            {kpis.win_rate_pct.toFixed(1)}%
          </div>
          <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
            {kpis.win_count} 盈 / {kpis.loss_count} 亏 (共 {kpis.closed_trades} 笔)
          </div>
        </div>

        <div className="rounded-xl bg-zinc-50/90 px-3.5 py-2.5 dark:bg-white/[0.04]">
          <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            盈亏比 Profit Factor
          </div>
          <div className="mt-1 font-mono text-base font-bold tabular-nums text-zinc-950 dark:text-white">
            {kpis.profit_factor !== null ? `${kpis.profit_factor.toFixed(2)}x` : "—"}
          </div>
          <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
            净已实现 {fmtMoney(kpis.net_realized_pnl, ccy)}
          </div>
        </div>

        <div className="rounded-xl bg-zinc-50/90 px-3.5 py-2.5 dark:bg-white/[0.04]">
          <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            区间最大回撤 Max DD
          </div>
          <div className="mt-1 font-mono text-base font-bold tabular-nums text-rose-700 dark:text-rose-400">
            {kpis.max_drawdown_pct.toFixed(2)}%
          </div>
          <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
            基于净值曲线高点测算
          </div>
        </div>

        <div className="rounded-xl bg-zinc-50/90 px-3.5 py-2.5 dark:bg-white/[0.04]">
          <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            平均过程纪律分
          </div>
          <div className="mt-1 font-mono text-base font-bold tabular-nums text-sky-700 dark:text-sky-400">
            {kpis.avg_process_score !== null ? `${kpis.avg_process_score.toFixed(1)} / 100` : "—"}
          </div>
          <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
            及格红线 70 分 (预算/止损/体制)
          </div>
        </div>
      </div>

      {/* Side-by-Side Dual SVG Charts */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        {/* Left: Net Equity vs SPY Curve */}
        <div className="rounded-2xl bg-zinc-50/85 p-4 xl:col-span-6 dark:bg-white/[0.03]">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-800 dark:text-zinc-200">
              <LineChart className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              账户净值收益率 vs SPY 基准曲线
            </span>
            {activeCurvePt && (
              <span className="font-mono text-[10.5px] tabular-nums text-zinc-600 dark:text-zinc-300">
                {activeCurvePt.date} · {fmtMoney(activeCurvePt.equity, ccy)} (
                {activeCurvePt.portfolio_return_pct >= 0 ? "+" : ""}
                {activeCurvePt.portfolio_return_pct.toFixed(2)}% vs SPY{" "}
                {activeCurvePt.spy_return_pct >= 0 ? "+" : ""}
                {activeCurvePt.spy_return_pct.toFixed(2)}%)
              </span>
            )}
          </div>

          <svg viewBox={`0 0 ${W1} ${H1}`} className="h-52 w-full select-none overflow-visible">
            <defs>
              <linearGradient id="meEquityFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#10b981" stopOpacity="0.28" />
                <stop offset="100%" stopColor="#10b981" stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {/* Zero axis */}
            <line
              x1={padL}
              x2={W1 - padR}
              y1={mapY1(0)}
              y2={mapY1(0)}
              stroke="currentColor"
              strokeOpacity="0.2"
              strokeDasharray="4 4"
            />
            {[minY1, (minY1 + maxY1) / 2, maxY1].map((tick, idx) => (
              <g key={`y1-${idx}`}>
                <line
                  x1={padL}
                  x2={W1 - padR}
                  y1={mapY1(tick)}
                  y2={mapY1(tick)}
                  stroke="currentColor"
                  strokeOpacity="0.07"
                />
                <text
                  x={padL - 6}
                  y={mapY1(tick) + 3}
                  textAnchor="end"
                  className="fill-zinc-500 font-mono text-[9.5px] dark:fill-zinc-400"
                >
                  {tick >= 0 ? "+" : ""}
                  {tick.toFixed(1)}%
                </text>
              </g>
            ))}

            {portAreaPath && <path d={portAreaPath} fill="url(#meEquityFill)" />}
            {spyPath && (
              <path
                d={spyPath}
                fill="none"
                stroke="#f59e0b"
                strokeWidth="1.75"
                strokeDasharray="5 4"
              />
            )}
            {portPath && (
              <path
                d={portPath}
                fill="none"
                stroke="#10b981"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

            {curve.map((pt, i) => {
              const cx = mapX1(i);
              const cy = mapY1(pt.portfolio_return_pct);
              const isActive = hoveredCurveIdx === i;
              return (
                <g
                  key={`c-${i}`}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoveredCurveIdx(i)}
                  onMouseLeave={() => setHoveredCurveIdx(null)}
                >
                  <circle
                    cx={cx}
                    cy={cy}
                    r={isActive ? 5.5 : 3.5}
                    fill="#10b981"
                    stroke="white"
                    strokeWidth="1.5"
                  />
                  {(i === 0 || i === curve.length - 1 || i % Math.max(1, Math.floor(curve.length / 4)) === 0) && (
                    <text
                      x={cx}
                      y={H1 - 8}
                      textAnchor="middle"
                      className="fill-zinc-500 font-mono text-[9px] dark:fill-zinc-400"
                    >
                      {pt.date}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          <div className="mt-1 flex items-center gap-4 font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-4 rounded-full bg-emerald-500" />
              账户累计回报 %
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-4 border-t-2 border-dashed border-amber-500" />
              SPY 同期基准 %
            </span>
          </div>
        </div>

        {/* Right: 2x2 Quadrant Matrix */}
        <div className="rounded-2xl bg-zinc-50/85 p-4 xl:col-span-6 dark:bg-white/[0.03]">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-800 dark:text-zinc-200">
              <Target className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
              「过程纪律 × 市场结果」2×2 四象限矩阵
            </span>
            {hoveredPt ? (
              <span className="font-mono text-[10.5px] tabular-nums text-zinc-700 dark:text-zinc-200">
                #{hoveredPt.trade_id} {hoveredPt.symbol} · {hoveredPt.quadrant_cn} · 纪律{" "}
                {hoveredPt.process_score} 分 · 盈亏 {fmtMoney(hoveredPt.realized_pnl, ccy)} (
                {hoveredPt.return_pct >= 0 ? "+" : ""}
                {hoveredPt.return_pct.toFixed(1)}%)
              </span>
            ) : (
              <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                悬停散点查看归因详情
              </span>
            )}
          </div>

          <svg viewBox={`0 0 ${W2} ${H2}`} className="h-52 w-full select-none overflow-visible">
            {/* Soft Quadrant Regions */}
            <rect
              x={splitX}
              y={qPadT}
              width={Math.max(1, W2 - qPadR - splitX)}
              height={Math.max(1, splitY - qPadT)}
              fill="#10b981"
              fillOpacity="0.08"
            />
            <rect
              x={splitX}
              y={splitY}
              width={Math.max(1, W2 - qPadR - splitX)}
              height={Math.max(1, qPadT + qInnerH - splitY)}
              fill="#0ea5e9"
              fillOpacity="0.06"
            />
            <rect
              x={qPadL}
              y={qPadT}
              width={Math.max(1, splitX - qPadL)}
              height={Math.max(1, splitY - qPadT)}
              fill="#f59e0b"
              fillOpacity="0.07"
            />
            <rect
              x={qPadL}
              y={splitY}
              width={Math.max(1, splitX - qPadL)}
              height={Math.max(1, qPadT + qInnerH - splitY)}
              fill="#f43f5e"
              fillOpacity="0.07"
            />

            {/* Dividers: X=70 score, Y=0% return */}
            <line
              x1={splitX}
              x2={splitX}
              y1={qPadT}
              y2={qPadT + qInnerH}
              stroke="currentColor"
              strokeOpacity="0.25"
              strokeDasharray="4 4"
            />
            <line
              x1={qPadL}
              x2={W2 - qPadR}
              y1={splitY}
              y2={splitY}
              stroke="currentColor"
              strokeOpacity="0.25"
              strokeDasharray="4 4"
            />

            {/* Corner Labels */}
            <text
              x={W2 - qPadR - 6}
              y={qPadT + 14}
              textAnchor="end"
              className="fill-emerald-700 font-sans text-[10px] font-semibold dark:fill-emerald-300"
            >
              高纪律盈利 ({counts.GOOD_PROCESS_GOOD_OUTCOME ?? 0})
            </text>
            <text
              x={W2 - qPadR - 6}
              y={qPadT + qInnerH - 6}
              textAnchor="end"
              className="fill-sky-700 font-sans text-[10px] font-semibold dark:fill-sky-300"
            >
              合规止损 ({counts.GOOD_PROCESS_BAD_OUTCOME ?? 0})
            </text>
            <text
              x={qPadL + 6}
              y={qPadT + 14}
              textAnchor="start"
              className="fill-amber-700 font-sans text-[10px] font-semibold dark:fill-amber-300"
            >
              侥幸盈利 ({counts.BAD_PROCESS_GOOD_OUTCOME ?? 0})
            </text>
            <text
              x={qPadL + 6}
              y={qPadT + qInnerH - 6}
              textAnchor="start"
              className="fill-rose-700 font-sans text-[10px] font-semibold dark:fill-rose-300"
            >
              双输复盘 ({counts.BAD_PROCESS_BAD_OUTCOME ?? 0})
            </text>

            {/* Axes Ticks */}
            <text
              x={qPadL - 6}
              y={splitY + 3}
              textAnchor="end"
              className="fill-zinc-500 font-mono text-[9px] dark:fill-zinc-400"
            >
              0%
            </text>
            <text
              x={qPadL - 6}
              y={qPadT + 8}
              textAnchor="end"
              className="fill-zinc-500 font-mono text-[9px] dark:fill-zinc-400"
            >
              +{maxY2.toFixed(0)}%
            </text>
            <text
              x={qPadL - 6}
              y={qPadT + qInnerH}
              textAnchor="end"
              className="fill-zinc-500 font-mono text-[9px] dark:fill-zinc-400"
            >
              {minY2.toFixed(0)}%
            </text>
            <text
              x={splitX}
              y={H2 - 8}
              textAnchor="middle"
              className="fill-zinc-500 font-mono text-[9px] dark:fill-zinc-400"
            >
              纪律及格线 70 → 100 分
            </text>

            {/* Scatter Points */}
            {points.map((pt) => {
              const cx = mapQX(pt.process_score);
              const cy = mapQY(pt.return_pct);
              const color = quadrantColor(pt.quadrant);
              const active = hoveredPt?.trade_id === pt.trade_id;
              return (
                <g
                  key={`qp-${pt.trade_id}`}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoveredPt(pt)}
                  onMouseLeave={() => setHoveredPt(null)}
                >
                  <circle
                    cx={cx}
                    cy={cy}
                    r={active ? 8 : 6}
                    fill={color}
                    fillOpacity={0.85}
                    stroke="white"
                    strokeWidth={active ? 2 : 1.5}
                  />
                  <text
                    x={cx}
                    y={cy - 9}
                    textAnchor="middle"
                    className="fill-zinc-800 font-mono text-[9px] font-bold dark:fill-zinc-200"
                  >
                    {pt.symbol}
                  </text>
                </g>
              );
            })}
          </svg>

          {points.length === 0 && !isDemo && (
            <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
              <span className="inline-flex items-center gap-1">
                <Activity className="h-3.5 w-3.5" />
                尚无已平仓复盘交易点，平仓任意单后自动落位四象限。
              </span>
              <button
                type="button"
                onClick={() => setViewSource("demo")}
                className="font-mono text-[10.5px] font-semibold text-emerald-700 underline dark:text-emerald-400"
              >
                切至演示样例
              </button>
            </div>
          )}
        </div>
      </div>
    </SpotlightBlock>
  );
}

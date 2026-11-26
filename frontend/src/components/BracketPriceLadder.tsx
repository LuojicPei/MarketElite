"use client";

import React from "react";
import { AlertTriangle, CheckCircle2, Ruler } from "lucide-react";

interface BracketPriceLadderProps {
  symbol: string;
  side: "buy" | "sell";
  spotPrice?: number | null;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  putWall?: number | null;
  zeroGamma?: number | null;
  callWall?: number | null;
  compact?: boolean;
}

interface LadderMarker {
  id: string;
  label: string;
  price: number;
  lane: "top" | "bottom";
  tone: "rose" | "emerald" | "sky" | "amber" | "zinc" | "indigo";
}

function pctPos(val: number, min: number, max: number): number {
  if (max <= min) return 50;
  return Math.max(2, Math.min(98, ((val - min) / (max - min)) * 100));
}

export default function BracketPriceLadder({
  symbol,
  side,
  spotPrice,
  entryPrice,
  stopLossPrice,
  takeProfitPrice,
  putWall,
  zeroGamma,
  callWall,
  compact = false,
}: BracketPriceLadderProps) {
  const numericPrices = [
    entryPrice,
    stopLossPrice,
    takeProfitPrice,
    spotPrice ?? 0,
    putWall ?? 0,
    zeroGamma ?? 0,
    callWall ?? 0,
  ].filter((v) => typeof v === "number" && Number.isFinite(v) && v > 0);

  if (numericPrices.length < 2) {
    return null;
  }

  const rawMin = Math.min(...numericPrices);
  const rawMax = Math.max(...numericPrices);
  const span = Math.max(rawMax - rawMin, rawMax * 0.04, 1);
  const axisMin = rawMin - span * 0.14;
  const axisMax = rawMax + span * 0.14;

  const riskDist = Math.abs(entryPrice - stopLossPrice);
  const rewardDist = Math.abs(takeProfitPrice - entryPrice);
  const rr = riskDist > 0.001 ? Number((rewardDist / riskDist).toFixed(2)) : 0;

  const entryPct = pctPos(entryPrice, axisMin, axisMax);
  const slPct = pctPos(stopLossPrice, axisMin, axisMax);
  const tpPct = pctPos(takeProfitPrice, axisMin, axisMax);

  const riskLeft = Math.min(entryPct, slPct);
  const riskWidth = Math.max(1.5, Math.abs(entryPct - slPct));
  const rewardLeft = Math.min(entryPct, tpPct);
  const rewardWidth = Math.max(1.5, Math.abs(tpPct - entryPct));

  const markers: LadderMarker[] = [
    { id: "sl", label: "止损 SL", price: stopLossPrice, lane: "top", tone: "rose" },
    { id: "entry", label: "入场 Entry", price: entryPrice, lane: "top", tone: "zinc" },
    { id: "tp", label: "止盈 TP", price: takeProfitPrice, lane: "top", tone: "emerald" },
  ];

  if (putWall && putWall > 0) {
    markers.push({ id: "pw", label: "Put Wall", price: putWall, lane: "bottom", tone: "sky" });
  }
  if (zeroGamma && zeroGamma > 0) {
    markers.push({ id: "zg", label: "Zero γ", price: zeroGamma, lane: "bottom", tone: "amber" });
  }
  if (callWall && callWall > 0) {
    markers.push({ id: "cw", label: "Call Wall", price: callWall, lane: "bottom", tone: "indigo" });
  }

  const alerts: string[] = [];
  if (side === "buy") {
    if (putWall && stopLossPrice > putWall && (stopLossPrice - putWall) / putWall < 0.05) {
      alerts.push(
        `止损 $${stopLossPrice.toFixed(2)} 位于 Put Wall ($${putWall.toFixed(2)}) 上方，建议评估是否下移至买盘墙外沿防洗盘`
      );
    }
    if (zeroGamma && entryPrice < zeroGamma) {
      alerts.push(
        `入场价处于 Zero Gamma ($${zeroGamma.toFixed(2)}) 下方负伽马区，波动率可能放大`
      );
    }
    if (callWall && takeProfitPrice > callWall * 1.01) {
      alerts.push(
        `止盈目标 $${takeProfitPrice.toFixed(2)} 越过 Call Wall ($${callWall.toFixed(2)}) 强阻力磁吸位`
      );
    }
  }
  if (rr > 0 && rr < 1.5) {
    alerts.push(`当前 R:R 仅 ${rr.toFixed(2)}x (< 1.5x)，盈亏比结构偏窄`);
  }

  const badgeToneClass = (tone: LadderMarker["tone"]) => {
    switch (tone) {
      case "rose":
        return "bg-rose-500/[0.14] text-rose-700 dark:text-rose-300";
      case "emerald":
        return "bg-emerald-500/[0.14] text-emerald-700 dark:text-emerald-300";
      case "sky":
        return "bg-sky-500/[0.14] text-sky-700 dark:text-sky-300";
      case "amber":
        return "bg-amber-500/[0.14] text-amber-800 dark:text-amber-300";
      case "indigo":
        return "bg-indigo-500/[0.14] text-indigo-700 dark:text-indigo-300";
      default:
        return "bg-zinc-900 text-white dark:bg-white dark:text-zinc-950";
    }
  };

  const dotColorClass = (tone: LadderMarker["tone"]) => {
    switch (tone) {
      case "rose":
        return "bg-rose-500 ring-rose-500/30";
      case "emerald":
        return "bg-emerald-500 ring-emerald-500/30";
      case "sky":
        return "bg-sky-500 ring-sky-500/30";
      case "amber":
        return "bg-amber-500 ring-amber-500/30";
      case "indigo":
        return "bg-indigo-500 ring-indigo-500/30";
      default:
        return "bg-zinc-900 ring-zinc-400/40 dark:bg-white";
    }
  };

  return (
    <div
      className={`rounded-2xl bg-white/85 ${
        compact ? "p-3" : "p-3.5"
      } dark:bg-white/[0.04]`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-200">
          <Ruler className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          Bracket 结构化价位标尺 · {symbol} ({side.toUpperCase()})
        </span>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
          {spotPrice ? (
            <span className="text-zinc-500 dark:text-zinc-400">
              现价 <strong className="text-zinc-900 dark:text-zinc-100">${spotPrice.toFixed(2)}</strong>
            </span>
          ) : null}
          <span className="rounded-full bg-emerald-500/[0.14] px-2 py-0.5 font-semibold text-emerald-700 dark:text-emerald-300">
            R:R {rr > 0 ? `${rr.toFixed(2)}x` : "—"}
          </span>
        </div>
      </div>

      {/* Key Legend Pills (Non-overlapping summary row) */}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {markers
          .slice()
          .sort((a, b) => a.price - b.price)
          .map((m) => (
            <span
              key={m.id}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${badgeToneClass(
                m.tone
              )}`}
            >
              <span>{m.label}</span>
              <span>${m.price.toFixed(2)}</span>
            </span>
          ))}
      </div>

      {/* Proportional Horizontal Axis */}
      <div className="relative mt-4 px-2 pb-4 pt-4">
        {/* Base Axis */}
        <div className="relative h-2.5 w-full rounded-full bg-zinc-200/80 dark:bg-white/[0.08]">
          {/* Risk Span (Rose) */}
          <div
            className="absolute top-0 h-full rounded-l-full bg-rose-500/45"
            style={{ left: `${riskLeft}%`, width: `${riskWidth}%` }}
            title={`风险区间 $${Math.min(entryPrice, stopLossPrice).toFixed(2)} – $${Math.max(
              entryPrice,
              stopLossPrice
            ).toFixed(2)}`}
          />
          {/* Reward Span (Emerald) */}
          <div
            className="absolute top-0 h-full rounded-r-full bg-emerald-500/45"
            style={{ left: `${rewardLeft}%`, width: `${rewardWidth}%` }}
            title={`收益区间 $${Math.min(entryPrice, takeProfitPrice).toFixed(2)} – $${Math.max(
              entryPrice,
              takeProfitPrice
            ).toFixed(2)}`}
          />

          {/* Markers */}
          {markers.map((m) => {
            const left = pctPos(m.price, axisMin, axisMax);
            return (
              <div
                key={`axis-${m.id}`}
                className="group absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${left}%` }}
              >
                <span
                  className={`block font-mono text-[9px] font-bold tracking-tight whitespace-nowrap ${
                    m.lane === "top"
                      ? "-translate-y-4 text-zinc-700 dark:text-zinc-200"
                      : "translate-y-4 text-zinc-500 dark:text-zinc-400"
                  }`}
                >
                  {m.id.toUpperCase()}
                </span>
                <span
                  className={`absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ${dotColorClass(
                    m.tone
                  )}`}
                  title={`${m.label}: $${m.price.toFixed(2)}`}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Structural Risk Hint / Healthy Confirmation */}
      {alerts.length > 0 ? (
        <div className="mt-1.5 space-y-1 rounded-xl bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-900 dark:text-amber-200">
          {alerts.map((msg, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
              <span>{msg}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-1.5 flex items-center gap-1.5 rounded-xl bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-800 dark:text-emerald-300">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>止损止盈边界与期权 GEX 关键位及 ≥1.5x 赔率要求相容</span>
        </div>
      )}
    </div>
  );
}

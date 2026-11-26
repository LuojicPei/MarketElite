"use client";

import React, { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts";
import { NetLiquidityPoint } from "@/lib/api";

interface NetLiquidityChartProps {
  series: NetLiquidityPoint[];
  spyOverlay?: { date: string; close: number }[];
  delta20dBillions?: number | null;
  height?: number;
  fillContainer?: boolean;
  theme?: "light" | "dark";
}

export default function NetLiquidityChart({
  series,
  spyOverlay,
  delta20dBillions,
  height = 180,
  fillContainer = false,
  theme = "dark",
}: NetLiquidityChartProps) {
  const isLight = theme === "light";
  const containerRef = useRef<HTMLDivElement | null>(null);

  const alignedSeries = useMemo(() => {
    if (!series || series.length === 0) return [];
    const sortedSpy = [...(spyOverlay ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    let spyIdx = 0;

    return series.map((pt) => {
      if (pt.spy_close != null && Number.isFinite(pt.spy_close)) {
        return pt;
      }
      if (sortedSpy.length === 0) {
        return { ...pt, spy_close: null };
      }
      while (spyIdx + 1 < sortedSpy.length && sortedSpy[spyIdx + 1].date <= pt.date) {
        spyIdx += 1;
      }
      const chosen = sortedSpy[spyIdx];
      return {
        ...pt,
        spy_close: chosen && chosen.date <= pt.date ? chosen.close : sortedSpy[0].close,
      };
    });
  }, [series, spyOverlay]);

  const hasSpy = useMemo(
    () => alignedSeries.some((d) => d.spy_close != null && Number.isFinite(d.spy_close)),
    [alignedSeries]
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el || alignedSeries.length === 0) return;

    const chart = echarts.init(el);
    const dates = alignedSeries.map((d) => d.date);
    const liqValues = alignedSeries.map((d) => d.net_liquidity_b);
    const minLiq = Math.floor(Math.min(...liqValues) - 35);
    const maxLiq = Math.ceil(Math.max(...liqValues) + 35);

    const spyValues = alignedSeries.map((d) => d.spy_close ?? null);
    const validSpy = spyValues.filter((v): v is number => v !== null && Number.isFinite(v));
    const minSpy = validSpy.length > 0 ? Math.floor(Math.min(...validSpy) * 0.985) : 0;
    const maxSpy = validSpy.length > 0 ? Math.ceil(Math.max(...validSpy) * 1.015) : 100;

    const isExpanding =
      delta20dBillions != null
        ? delta20dBillions >= 0
        : liqValues[liqValues.length - 1] >= liqValues[Math.max(0, liqValues.length - 20)];
    const liqColor = isExpanding
      ? isLight
        ? "#059669"
        : "#34D399"
      : isLight
        ? "#E11D48"
        : "#FB7185";
    const liqGradTop = isExpanding
      ? isLight
        ? "rgba(5,150,105,0.20)"
        : "rgba(52,211,153,0.26)"
      : isLight
        ? "rgba(225,29,72,0.18)"
        : "rgba(251,113,133,0.24)";
    const liqGradBot = isExpanding
      ? "rgba(52,211,153,0.01)"
      : "rgba(251,113,133,0.01)";
    const spyStroke = isLight ? "#D97706" : "#FBBF24";

    chart.setOption({
      animationDuration: 450,
      grid: {
        left: 42,
        right: hasSpy ? 40 : 12,
        top: 10,
        bottom: 20,
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: isLight ? "#FFFFFF" : "#141418",
        borderColor: isLight ? "#E4E4E7" : "#27272A",
        textStyle: {
          color: isLight ? "#18181B" : "#FAFAFA",
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 11,
        },
        formatter: (params: unknown) => {
          const arr = Array.isArray(params) ? params : [params];
          const first = arr[0] as { dataIndex?: number };
          const idx = first?.dataIndex ?? 0;
          const pt = alignedSeries[idx];
          if (!pt) return "";
          const lines = [
            `<div style="font-weight:700;margin-bottom:4px;color:${isLight ? "#18181B" : "#e4e4e7"}">${pt.date}</div>`,
            `<span style="color:${liqColor}">● 市场净活水:</span> <b>$${pt.net_liquidity_b.toFixed(1)}B</b>`,
            `<span style="color:${isLight ? "#52525b" : "#a1a1aa"};font-size:10px">  总水库 $${pt.walcl_b.toFixed(0)}B − TGA $${pt.tga_b.toFixed(0)}B − 逆回购 $${pt.rrp_b.toFixed(0)}B</span>`,
          ];
          if (pt.spy_close != null) {
            lines.push(
              `<span style="color:${spyStroke}">--- 标普 SPY:</span> <b>$${pt.spy_close.toFixed(2)}</b>`
            );
          }
          return lines.join("<br/>");
        },
      },
      xAxis: {
        type: "category",
        data: dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: isLight ? "#D4D4D8" : "#3F3F46" } },
        axisTick: { show: false },
        axisLabel: {
          color: isLight ? "#52525B" : "#A1A1AA",
          fontSize: 10,
          fontFamily: "JetBrains Mono, monospace",
          formatter: (val: string) => val.slice(5),
        },
      },
      yAxis: [
        {
          type: "value",
          min: minLiq,
          max: maxLiq,
          splitNumber: 3,
          splitLine: {
            lineStyle: {
              color: isLight ? "rgba(24,24,27,0.08)" : "rgba(255,255,255,0.08)",
              type: "dashed",
            },
          },
          axisLabel: {
            color: liqColor,
            fontSize: 10,
            fontFamily: "JetBrains Mono, monospace",
            formatter: (v: number) => `${(v / 1000).toFixed(2)}T`,
          },
        },
        ...(hasSpy
          ? [
              {
                type: "value",
                min: minSpy,
                max: maxSpy,
                splitNumber: 3,
                splitLine: { show: false },
                axisLabel: {
                  color: spyStroke,
                  fontSize: 10,
                  fontFamily: "JetBrains Mono, monospace",
                  formatter: (v: number) => `$${v.toFixed(0)}`,
                },
              },
            ]
          : []),
      ],
      series: [
        {
          name: "市场活水",
          type: "line",
          yAxisIndex: 0,
          data: liqValues,
          showSymbol: false,
          smooth: 0.25,
          lineStyle: { color: liqColor, width: 2 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: liqGradTop },
              { offset: 1, color: liqGradBot },
            ]),
          },
        },
        ...(hasSpy
          ? [
              {
                name: "标普 SPY",
                type: "line",
                yAxisIndex: 1,
                data: spyValues,
                showSymbol: false,
                smooth: 0.15,
                lineStyle: { color: spyStroke, width: 1.6, type: "dashed" },
              },
            ]
          : []),
      ],
    });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [alignedSeries, delta20dBillions, hasSpy, isLight]);

  if (series.length === 0) {
    return (
      <div
        style={fillContainer ? undefined : { height }}
        className={`flex items-center justify-center rounded-xl border border-zinc-200 dark:border-zinc-800/80 text-xs font-mono text-zinc-500 ${
          fillContainer ? "min-h-[82px] w-full flex-1" : "w-full"
        }`}
      >
        美联储净流动性序列待同步...
      </div>
    );
  }

  return (
    <div className={fillContainer ? "flex h-full min-h-0 flex-col" : "w-full"}>
      <div className="mb-0.5 flex flex-wrap items-center justify-between gap-1 font-mono text-[9.5px]">
        <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
          <span className="inline-flex items-center gap-1">
            <span
              className={`h-2 w-2 rounded-full ${
                (delta20dBillions ?? 0) >= 0
                  ? "bg-emerald-600 dark:bg-emerald-400"
                  : "bg-rose-600 dark:bg-rose-400"
              }`}
            />
            <span>净活水(左)</span>
          </span>
          {hasSpy && (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
              <span className="inline-block h-0.5 w-3 border-t-2 border-dashed border-amber-600 dark:border-amber-400" />
              <span>标普SPY(右)</span>
            </span>
          )}
        </div>
        <span className="hidden text-zinc-600 dark:text-zinc-400 xl:inline">↗放水利好 · ↘抽水承压</span>
      </div>
      <div
        ref={containerRef}
        style={fillContainer ? undefined : { height }}
        className={fillContainer ? "min-h-[70px] w-full flex-1" : "w-full"}
      />
    </div>
  );
}

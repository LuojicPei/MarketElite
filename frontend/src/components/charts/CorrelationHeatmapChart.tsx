"use client";

import React, { useEffect, useRef } from "react";
import * as echarts from "echarts";

interface CorrelationHeatmapChartProps {
  correlations: Record<string, { corr_20d?: number | null; corr_60d?: number | null }>;
  height?: number;
}

export default function CorrelationHeatmapChart({
  correlations,
  height = 220,
}: CorrelationHeatmapChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const symbols = Object.keys(correlations);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || symbols.length === 0) return;

    const chart = echarts.init(el);
    const windows = ["20D vs SPY", "60D vs SPY"];
    const data: [number, number, number][] = [];

    symbols.forEach((sym, yIdx) => {
      const c20 = correlations[sym]?.corr_20d ?? 0;
      const c60 = correlations[sym]?.corr_60d ?? 0;
      data.push([0, yIdx, Number(c20.toFixed(2))]);
      data.push([1, yIdx, Number(c60.toFixed(2))]);
    });

    chart.setOption({
      animationDuration: 400,
      grid: { left: 68, right: 16, top: 24, bottom: 16 },
      tooltip: {
        position: "top",
        backgroundColor: "#141418",
        borderColor: "#27272A",
        textStyle: { color: "#FAFAFA", fontFamily: "JetBrains Mono, monospace", fontSize: 11 },
        formatter: (params: unknown) => {
          const p = params as { value: [number, number, number] };
          const [xIdx, yIdx, val] = p.value;
          return `${symbols[yIdx]} (${windows[xIdx]}): <b>${val.toFixed(2)}</b>`;
        },
      },
      xAxis: {
        type: "category",
        data: windows,
        position: "top",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: "#A1A1AA", fontSize: 10, fontFamily: "JetBrains Mono, monospace" },
      },
      yAxis: {
        type: "category",
        data: symbols,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: "#FAFAFA", fontSize: 11, fontFamily: "JetBrains Mono, monospace" },
      },
      visualMap: {
        min: -1,
        max: 1,
        show: false,
        inRange: {
          color: ["#9F1239", "#3F3F46", "#18181B", "#27272A", "#059669"],
        },
      },
      series: [
        {
          type: "heatmap",
          data,
          label: {
            show: true,
            color: "#FAFAFA",
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 11,
            formatter: (params: unknown) => {
              const p = params as { value: [number, number, number] };
              const v = p.value[2];
              return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
            },
          },
          itemStyle: {
            borderColor: "#0B0B0D",
            borderWidth: 3,
            borderRadius: 4,
          },
        },
      ],
    });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [correlations, symbols]);

  if (symbols.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center rounded-xl border border-zinc-800 text-xs font-mono text-zinc-500"
      >
        Cross-asset rolling correlation pending bars...
      </div>
    );
  }

  return <div ref={containerRef} style={{ height }} className="w-full" />;
}

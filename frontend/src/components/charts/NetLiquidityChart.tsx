"use client";

import React, { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { NetLiquidityPoint } from "@/lib/api";

interface NetLiquidityChartProps {
  series: NetLiquidityPoint[];
  height?: number;
}

export default function NetLiquidityChart({ series, height = 180 }: NetLiquidityChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || series.length === 0) return;

    const chart = echarts.init(el);
    const dates = series.map((d) => d.date);
    const values = series.map((d) => d.net_liquidity_b);
    const minVal = Math.floor(Math.min(...values) - 40);
    const maxVal = Math.ceil(Math.max(...values) + 40);

    chart.setOption({
      animationDuration: 500,
      grid: { left: 46, right: 12, top: 14, bottom: 22 },
      tooltip: {
        trigger: "axis",
        backgroundColor: "#141418",
        borderColor: "#27272A",
        textStyle: { color: "#FAFAFA", fontFamily: "JetBrains Mono, monospace", fontSize: 11 },
        formatter: (params: unknown) => {
          const arr = Array.isArray(params) ? params : [params];
          const first = arr[0] as { dataIndex?: number };
          const idx = first?.dataIndex ?? 0;
          const pt = series[idx];
          if (!pt) return "";
          return [
            `<div style="font-weight:600;margin-bottom:4px">${pt.date}</div>`,
            `Net Liquidity: <b>$${pt.net_liquidity_b.toFixed(1)}B</b>`,
            `WALCL: $${pt.walcl_b.toFixed(1)}B`,
            `TGA: -$${pt.tga_b.toFixed(1)}B`,
            `RRP: -$${pt.rrp_b.toFixed(1)}B`,
          ].join("<br/>");
        },
      },
      xAxis: {
        type: "category",
        data: dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: "#27272A" } },
        axisTick: { show: false },
        axisLabel: {
          color: "#71717A",
          fontSize: 10,
          fontFamily: "JetBrains Mono, monospace",
          formatter: (val: string) => val.slice(5),
        },
      },
      yAxis: {
        type: "value",
        min: minVal,
        max: maxVal,
        splitNumber: 3,
        splitLine: { lineStyle: { color: "rgba(255,255,255,0.06)", type: "dashed" } },
        axisLabel: {
          color: "#71717A",
          fontSize: 10,
          fontFamily: "JetBrains Mono, monospace",
          formatter: (v: number) => `${(v / 1000).toFixed(2)}T`,
        },
      },
      series: [
        {
          name: "Net Liquidity",
          type: "line",
          data: values,
          showSymbol: false,
          smooth: 0.2,
          lineStyle: { color: "#FAFAFA", width: 1.75 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(255,255,255,0.16)" },
              { offset: 1, color: "rgba(255,255,255,0.01)" },
            ]),
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
  }, [series]);

  if (series.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center rounded-xl border border-zinc-800/80 text-xs font-mono text-zinc-500"
      >
        FRED Net Liquidity sequence pending sync...
      </div>
    );
  }

  return <div ref={containerRef} style={{ height }} className="w-full" />;
}

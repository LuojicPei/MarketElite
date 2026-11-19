"use client";

import React, { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { StrikeGexProfile } from "@/lib/api";

interface GexProfileChartProps {
  profile: StrikeGexProfile[];
  spotPrice: number;
  callWall: number | null;
  putWall: number | null;
  zeroGamma: number | null;
  height?: number;
}

export default function GexProfileChart({
  profile,
  spotPrice,
  callWall,
  putWall,
  zeroGamma,
  height = 240,
}: GexProfileChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || profile.length === 0) return;

    const chart = echarts.init(el);
    const strikes = profile.map((r) => String(r.strike));
    // Display in $B scale for clean legibility (`Spot^2 * OI * 100 * Gamma`)
    const callData = profile.map((r) => Number((r.call_gex / 1e9).toFixed(2)));
    const putData = profile.map((r) => Number((r.put_gex / 1e9).toFixed(2)));

    chart.setOption({
      animationDuration: 450,
      grid: { left: 50, right: 16, top: 20, bottom: 28 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        backgroundColor: "#0B0B0D",
        borderColor: "#27272A",
        textStyle: { color: "#FAFAFA", fontFamily: "JetBrains Mono, monospace", fontSize: 11 },
        formatter: (params: unknown) => {
          const list = Array.isArray(params) ? params : [params];
          const first = list[0] as { dataIndex?: number };
          const row = profile[first?.dataIndex ?? 0];
          if (!row) return "";
          return [
            `<div style="font-weight:600;margin-bottom:4px">Strike $${row.strike}</div>`,
            `Call GEX: +$${(row.call_gex / 1e9).toFixed(2)}B (OI ${row.call_oi.toLocaleString()})`,
            `Put GEX: $${(row.put_gex / 1e9).toFixed(2)}B (OI ${row.put_oi.toLocaleString()})`,
            `<b>Net GEX: $${(row.net_gex / 1e9).toFixed(2)}B</b>`,
          ].join("<br/>");
        },
      },
      xAxis: {
        type: "category",
        data: strikes,
        axisLine: { lineStyle: { color: "#D4D4D8" } },
        axisTick: { show: false },
        axisLabel: {
          color: "#52525B",
          fontSize: 10,
          fontFamily: "JetBrains Mono, monospace",
          interval: Math.max(0, Math.floor(strikes.length / 8) - 1),
          formatter: (val: string) => {
            const num = Number(val);
            if (callWall && num === callWall) return `${val}*C`;
            if (putWall && num === putWall) return `${val}*P`;
            return val;
          },
        },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: "#F4F4F5", type: "dashed" } },
        axisLabel: {
          color: "#52525B",
          fontSize: 10,
          fontFamily: "JetBrains Mono, monospace",
          formatter: (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}B`,
        },
      },
      series: [
        {
          name: "Call GEX (+)",
          type: "bar",
          stack: "gex",
          data: callData,
          itemStyle: { color: "#059669", borderRadius: [2, 2, 0, 0] },
          barMaxWidth: 14,
        },
        {
          name: "Put GEX (-)",
          type: "bar",
          stack: "gex",
          data: putData,
          itemStyle: { color: "#E11D48", borderRadius: [0, 0, 2, 2] },
          barMaxWidth: 14,
        },
      ],
    });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [profile, spotPrice, callWall, putWall, zeroGamma]);

  if (profile.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-xs font-mono text-zinc-500"
      >
        No options Estimated GEX strikes available
      </div>
    );
  }

  return <div ref={containerRef} style={{ height }} className="w-full" />;
}

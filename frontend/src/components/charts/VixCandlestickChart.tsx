"use client";

import React, { useEffect, useMemo, useRef } from "react";
import {
  ColorType,
  CrosshairMode,
  IChartApi,
  LineStyle,
  Time,
  createChart,
} from "lightweight-charts";
import { VixOhlcBar } from "@/lib/api";

interface VixCandlestickChartProps {
  bars: VixOhlcBar[];
  spotPrice: number | null;
  changeAbs?: number | null;
  changePct?: number | null;
  peakHigh?: number | null;
  peakDate?: string | null;
  theme?: "light" | "dark";
  height?: number;
  fillContainer?: boolean;
}

export default function VixCandlestickChart({
  bars,
  spotPrice,
  changeAbs,
  changePct,
  peakHigh,
  peakDate,
  theme = "dark",
  height = 176,
  fillContainer = false,
}: VixCandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const sortedBars = useMemo(() => {
    const byDate = new Map<string, VixOhlcBar>();
    for (const b of bars) {
      byDate.set(b.trade_date, b);
    }
    return Array.from(byDate.values()).sort((a, b) =>
      a.trade_date.localeCompare(b.trade_date)
    );
  }, [bars]);

  const computedPeak = useMemo(() => {
    if (peakHigh != null) return peakHigh;
    if (sortedBars.length === 0) return null;
    return Math.max(...sortedBars.map((b) => b.high));
  }, [peakHigh, sortedBars]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || sortedBars.length === 0) return;

    const isDark = theme === "dark";
    const initialHeight = fillContainer
      ? Math.max(125, Math.floor(el.clientHeight || height))
      : height;

    const chart: IChartApi = createChart(el, {
      width: el.clientWidth,
      height: initialHeight,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: isDark ? "#A1A1AA" : "#52525B",
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 10,
      },
      localization: {
        locale: "en-US",
      },
      grid: {
        vertLines: { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)" },
        horzLines: { color: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.06)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: isDark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.22)",
          style: LineStyle.Dashed,
        },
        horzLine: {
          color: isDark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.22)",
          style: LineStyle.Dashed,
        },
      },
      rightPriceScale: {
        borderColor: isDark ? "#27272A" : "#E4E4E7",
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      timeScale: {
        borderColor: isDark ? "#27272A" : "#E4E4E7",
        timeVisible: false,
      },
    });

    // For VIX (Fear Gauge): VIX surging up = fear spike (crimson red), VIX falling = fear easing (emerald)
    const series = chart.addCandlestickSeries({
      upColor: "#EF4444",
      downColor: "#10B981",
      borderVisible: false,
      wickUpColor: "#EF4444",
      wickDownColor: "#10B981",
    });

    series.setData(
      sortedBars.map((b) => ({
        time: b.trade_date as Time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      }))
    );

    // Intuitive threshold lines so users instantly see 20 / 30 / 40 panic severity
    series.createPriceLine({
      price: 20,
      color: "rgba(245, 158, 11, 0.72)",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "20 警戒",
    });
    series.createPriceLine({
      price: 30,
      color: "rgba(249, 115, 22, 0.85)",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "30 高危",
    });
    if ((computedPeak ?? 0) >= 32 || (spotPrice ?? 0) >= 32) {
      series.createPriceLine({
        price: 40,
        color: "rgba(220, 38, 38, 0.92)",
        lineWidth: 1,
        lineStyle: LineStyle.LargeDashed,
        axisLabelVisible: true,
        title: "40 极端踩踏",
      });
    }

    const barsToShow = Math.min(sortedBars.length, 65);
    if (sortedBars.length <= barsToShow) {
      chart.timeScale().fitContent();
    } else {
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, sortedBars.length - barsToShow),
        to: sortedBars.length + 1,
      });
    }

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w > 0) {
        if (fillContainer && h >= 120) {
          chart.applyOptions({ width: w, height: h });
        } else {
          chart.applyOptions({ width: w });
        }
      }
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [sortedBars, computedPeak, spotPrice, theme, height, fillContainer]);

  const isPanicHigh = (spotPrice ?? 0) >= 28;
  const isVixRising = (changeAbs ?? 0) >= 0;

  return (
    <div className="flex h-full min-h-0 flex-col justify-between rounded-xl border border-zinc-200/90 bg-white/85 p-3 dark:border-white/15 dark:bg-white/[0.04]">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-baseline gap-2">
          <span className="font-sans text-xs font-bold text-zinc-900 dark:text-zinc-100">
            VIX 恐慌指数 K 线
          </span>
          <span
            className={`font-mono text-lg font-extrabold tabular-nums ${
              isPanicHigh
                ? "text-red-600 dark:text-red-400"
                : "text-zinc-950 dark:text-white"
            }`}
          >
            {spotPrice != null ? spotPrice.toFixed(2) : "—"}
          </span>
          {changePct != null && (
            <span
              className={`font-mono text-[10.5px] font-bold ${
                isVixRising
                  ? "text-red-600 dark:text-red-400"
                  : "text-emerald-700 dark:text-emerald-400"
              }`}
            >
              {changePct >= 0 ? `+${changePct.toFixed(1)}%` : `${changePct.toFixed(1)}%`}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 font-mono text-[10px]">
          {computedPeak != null && (
            <span
              title={peakDate ? `近期最高冲击日期：${peakDate}` : "近4个月最高"}
              className={`rounded-full border px-2 py-0.5 font-semibold ${
                computedPeak >= 35
                  ? "border-red-500/45 bg-red-600/15 text-red-700 dark:border-red-400/45 dark:text-red-300"
                  : "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-white/15 dark:bg-white/10 dark:text-zinc-300"
              }`}
            >
              近4月峰值 {computedPeak.toFixed(1)}
            </span>
          )}
        </div>
      </div>

      {sortedBars.length === 0 ? (
        <div className="flex min-h-[120px] flex-1 items-center justify-center font-mono text-xs text-zinc-500 dark:text-zinc-400">
          正在拉取 ^VIX 实时 K 线...
        </div>
      ) : (
        <div
          ref={containerRef}
          style={fillContainer ? undefined : { height }}
          className={fillContainer ? "min-h-[130px] w-full flex-1" : "w-full"}
        />
      )}

      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 font-mono text-[9.5px] text-zinc-500 dark:text-zinc-400">
        <span>红柱=恐慌飙升 · 绿柱=情绪回落</span>
        <span>虚线锚：20警戒 · 30高危 · 40极端</span>
      </div>
    </div>
  );
}

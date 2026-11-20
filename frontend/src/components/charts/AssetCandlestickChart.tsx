"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  IChartApi,
  LineStyle,
  Time,
  createChart,
} from "lightweight-charts";
import { DailyBarPoint, EstimatedGexSnapshot } from "@/lib/api";

interface AssetCandlestickChartProps {
  symbol: string;
  bars: DailyBarPoint[];
  gex?: EstimatedGexSnapshot | null;
  height?: number;
}

function calcSmaSeries(
  bars: DailyBarPoint[],
  period: number
): { time: Time; value: number }[] {
  const out: { time: Time; value: number }[] = [];
  let rollingSum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    rollingSum += bars[i].close;
    if (i >= period) {
      rollingSum -= bars[i - period].close;
    }
    if (i >= period - 1) {
      out.push({
        time: bars[i].trade_date as Time,
        value: Number((rollingSum / period).toFixed(4)),
      });
    }
  }
  return out;
}

function calcEmaSeries(
  bars: DailyBarPoint[],
  span: number
): { time: Time; value: number }[] {
  if (bars.length < span) return [];
  const alpha = 2 / (span + 1);
  let ema =
    bars.slice(0, span).reduce((acc, b) => acc + b.close, 0) / span;
  const out: { time: Time; value: number }[] = [
    { time: bars[span - 1].trade_date as Time, value: Number(ema.toFixed(4)) },
  ];
  for (let i = span; i < bars.length; i += 1) {
    ema = (bars[i].close - ema) * alpha + ema;
    out.push({
      time: bars[i].trade_date as Time,
      value: Number(ema.toFixed(4)),
    });
  }
  return out;
}

export default function AssetCandlestickChart({
  symbol,
  bars,
  gex,
  height = 330,
}: AssetCandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [rangeKey, setRangeKey] = useState<"1M" | "3M" | "6M" | "1Y">("6M");
  const [showEma20, setShowEma20] = useState(true);
  const [showSma50, setShowSma50] = useState(true);
  const [showSma200, setShowSma200] = useState(false);

  const sortedBars = useMemo(() => {
    const seen = new Set<string>();
    const clean: DailyBarPoint[] = [];
    for (const b of bars) {
      if (!seen.has(b.trade_date)) {
        seen.add(b.trade_date);
        clean.push(b);
      }
    }
    clean.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
    return clean;
  }, [bars]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || sortedBars.length === 0) return;

    const chart: IChartApi = createChart(el, {
      width: el.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "#0B0B0D" },
        textColor: "#A1A1AA",
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 11,
      },
      localization: {
        locale: "en-US",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.05)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(255,255,255,0.22)", style: LineStyle.Dashed },
        horzLine: { color: "rgba(255,255,255,0.22)", style: LineStyle.Dashed },
      },
      rightPriceScale: {
        borderColor: "#1C1C21",
      },
      timeScale: {
        borderColor: "#1C1C21",
        timeVisible: false,
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#10B981",
      downColor: "#F43F5E",
      borderVisible: false,
      wickUpColor: "#10B981",
      wickDownColor: "#F43F5E",
    });

    candleSeries.setData(
      sortedBars.map((b) => ({
        time: b.trade_date as Time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      }))
    );

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    volumeSeries.setData(
      sortedBars.map((b) => ({
        time: b.trade_date as Time,
        value: b.volume,
        color: b.close >= b.open ? "rgba(16,185,129,0.22)" : "rgba(244,63,94,0.22)",
      }))
    );

    if (showEma20) {
      const ema20 = chart.addLineSeries({
        color: "#FAFAFA",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      ema20.setData(calcEmaSeries(sortedBars, 20));
    }
    if (showSma50) {
      const sma50 = chart.addLineSeries({
        color: "#A1A1AA",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      sma50.setData(calcSmaSeries(sortedBars, 50));
    }
    if (showSma200) {
      const sma200 = chart.addLineSeries({
        color: "#D97706",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      sma200.setData(calcSmaSeries(sortedBars, 200));
    }

    if (gex) {
      if (gex.call_wall) {
        candleSeries.createPriceLine({
          price: gex.call_wall,
          color: "rgba(16,185,129,0.7)",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: `Call $${gex.call_wall}`,
        });
      }
      if (gex.put_wall) {
        candleSeries.createPriceLine({
          price: gex.put_wall,
          color: "rgba(244,63,94,0.7)",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: `Put $${gex.put_wall}`,
        });
      }
      if (gex.zero_gamma) {
        candleSeries.createPriceLine({
          price: gex.zero_gamma,
          color: "rgba(217,119,6,0.85)",
          lineWidth: 1,
          lineStyle: LineStyle.LargeDashed,
          axisLabelVisible: false,
          title: `ZG $${gex.zero_gamma}`,
        });
      }
    }

    const barsWindow = rangeKey === "1M" ? 22 : rangeKey === "3M" ? 63 : rangeKey === "6M" ? 126 : sortedBars.length;
    if (rangeKey === "1Y" || sortedBars.length <= barsWindow) {
      chart.timeScale().fitContent();
    } else {
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, sortedBars.length - barsWindow),
        to: sortedBars.length + 1,
      });
    }

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) {
        chart.applyOptions({ width });
      }
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [sortedBars, height, rangeKey, showEma20, showSma50, showSma200, gex]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-zinc-400">
            {symbol} · 日线 OHLCV + 成交量
          </span>
          <div className="inline-flex rounded-md border border-zinc-800 bg-zinc-900/80 p-0.5">
            {(
              [
                { key: "1M", label: "1M" },
                { key: "3M", label: "3M" },
                { key: "6M", label: "6M" },
                { key: "1Y", label: "全部" },
              ] as const
            ).map((tf) => (
              <button
                key={tf.key}
                type="button"
                onClick={() => setRangeKey(tf.key)}
                className={`rounded px-2 py-0.5 text-[10px] transition ${
                  rangeKey === tf.key
                    ? "bg-zinc-100 font-semibold text-zinc-950"
                    : "text-zinc-400 hover:text-zinc-100"
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowEma20((v) => !v)}
            className={`rounded-md border px-2 py-0.5 transition ${
              showEma20
                ? "border-zinc-200 bg-zinc-100 text-zinc-950"
                : "border-zinc-800 text-zinc-500 hover:text-zinc-200"
            }`}
          >
            EMA 20
          </button>
          <button
            type="button"
            onClick={() => setShowSma50((v) => !v)}
            className={`rounded-md border px-2 py-0.5 transition ${
              showSma50
                ? "border-zinc-400 bg-zinc-800 text-zinc-100"
                : "border-zinc-800 text-zinc-500 hover:text-zinc-200"
            }`}
          >
            SMA 50
          </button>
          <button
            type="button"
            onClick={() => setShowSma200((v) => !v)}
            className={`rounded-md border px-2 py-0.5 transition ${
              showSma200
                ? "border-amber-500/50 bg-amber-500/15 text-amber-300"
                : "border-zinc-800 text-zinc-500 hover:text-zinc-200"
            }`}
          >
            SMA 200
          </button>
        </div>
      </div>
      <div ref={containerRef} style={{ height }} className="w-full overflow-hidden rounded-xl" />
    </div>
  );
}

"use client";

import React, { useId, useMemo } from "react";
import type { MacroTapeBar } from "@/lib/api";

interface MiniKLineSparklineProps {
  bars: MacroTapeBar[];
  prevClose: number;
  isUp: boolean;
  width?: number;
  height?: number;
  showCandles?: boolean;
}

/**
 * Shared SVG micro OHLC K-line & prev-close baseline sparkline used across
 * the bottom macro tape, Homepage Watchlist rows, and My Watchlist cards.
 */
export default function MiniKLineSparkline({
  bars,
  prevClose,
  isUp,
  width = 66,
  height = 28,
  showCandles = true,
}: MiniKLineSparklineProps) {
  const uid = useId().replace(/:/g, "");
  const padY = 2.5;
  const innerH = height - padY * 2;

  const geometry = useMemo(() => {
    if (!bars || bars.length === 0) return null;
    let minV = prevClose;
    let maxV = prevClose;
    for (const b of bars) {
      if (b.l < minV) minV = b.l;
      if (b.h > maxV) maxV = b.h;
    }
    const span = maxV - minV;
    const safeSpan = span > 1e-9 ? span : Math.max(Math.abs(prevClose) * 0.01, 0.01);
    const mapY = (v: number) => padY + ((maxV - v) / safeSpan) * innerH;

    const refY = Math.max(padY, Math.min(height - padY, mapY(prevClose)));
    const count = bars.length;
    const slotW = width / Math.max(count, 1);
    const candleW = Math.max(1.2, Math.min(3.0, slotW * 0.6));

    const pts = bars.map((b, idx) => {
      const x = count === 1 ? width * 0.5 : (idx + 0.5) * slotW;
      return {
        x,
        y: mapY(b.c),
        oY: mapY(b.o),
        cY: mapY(b.c),
        hY: mapY(b.h),
        lY: mapY(b.l),
        c: b.c,
        o: b.o,
      };
    });

    const linePath = pts
      .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(" ");
    const firstX = pts[0].x.toFixed(1);
    const lastX = pts[pts.length - 1].x.toFixed(1);
    const areaPath = `${linePath} L${lastX},${refY.toFixed(1)} L${firstX},${refY.toFixed(1)} Z`;

    return {
      refY,
      candleW,
      pts,
      linePath,
      areaPath,
      lastPt: pts[pts.length - 1],
    };
  }, [bars, height, innerH, prevClose, width]);

  if (!geometry) {
    return <div style={{ width, height }} className="shrink-0" />;
  }

  const upStroke = "#10b981";
  const downStroke = "#e11d48";
  const overallColor = isUp ? upStroke : downStroke;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 overflow-visible"
      aria-hidden="true"
    >
      <defs>
        <clipPath id={`clip-above-${uid}`}>
          <rect x="0" y="0" width={width} height={geometry.refY} />
        </clipPath>
        <clipPath id={`clip-below-${uid}`}>
          <rect x="0" y={geometry.refY} width={width} height={height - geometry.refY} />
        </clipPath>
        <linearGradient id={`grad-up-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={upStroke} stopOpacity="0.26" />
          <stop offset="100%" stopColor={upStroke} stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id={`grad-down-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={downStroke} stopOpacity="0.03" />
          <stop offset="100%" stopColor={downStroke} stopOpacity="0.28" />
        </linearGradient>
      </defs>

      <path
        d={geometry.areaPath}
        fill={`url(#grad-up-${uid})`}
        clipPath={`url(#clip-above-${uid})`}
      />
      <path
        d={geometry.areaPath}
        fill={`url(#grad-down-${uid})`}
        clipPath={`url(#clip-below-${uid})`}
      />

      {/* Horizontal Dotted Reference Line */}
      <line
        x1={0}
        x2={width}
        y1={geometry.refY}
        y2={geometry.refY}
        stroke="currentColor"
        className="text-zinc-500/70 dark:text-zinc-400/60"
        strokeWidth="0.9"
        strokeDasharray="1.8 2"
      />

      {/* Micro OHLC K-Line Bars */}
      {showCandles &&
        geometry.pts.map((p, idx) => {
          const candleUp = p.c >= p.o;
          const fill = candleUp ? upStroke : downStroke;
          const top = Math.min(p.oY, p.cY);
          const bodyH = Math.max(1.2, Math.abs(p.cY - p.oY));
          return (
            <g key={idx}>
              <line
                x1={p.x}
                x2={p.x}
                y1={p.hY}
                y2={p.lY}
                stroke={fill}
                strokeWidth="0.8"
                strokeOpacity="0.72"
              />
              <rect
                x={p.x - geometry.candleW / 2}
                y={top}
                width={geometry.candleW}
                height={bodyH}
                rx="0.35"
                fill={fill}
                fillOpacity={candleUp ? "0.78" : "0.84"}
              />
            </g>
          );
        })}

      <path
        d={geometry.linePath}
        fill="none"
        stroke={overallColor}
        strokeWidth="1.2"
        strokeOpacity="0.9"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={geometry.lastPt.x}
        cy={geometry.lastPt.y}
        r="2.0"
        fill={overallColor}
      />
    </svg>
  );
}

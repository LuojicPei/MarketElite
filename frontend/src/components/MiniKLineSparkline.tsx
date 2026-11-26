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
  className?: string;
}

/**
 * Shared SVG micro OHLC K-line & prev-close baseline sparkline used across
 * the bottom macro tape, Homepage Watchlist rows, and My Watchlist cards.
 */
function MiniKLineSparkline({
  bars,
  prevClose,
  isUp,
  width = 66,
  height = 28,
  showCandles = true,
  className = "shrink-0 overflow-visible",
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
    const halfCandle = candleW / 2;

    const lineSegs: string[] = [];
    const upWicks: string[] = [];
    const downWicks: string[] = [];
    const upBodies: string[] = [];
    const downBodies: string[] = [];
    let firstX = 0;
    let lastX = 0;
    let lastY = refY;

    for (let idx = 0; idx < count; idx += 1) {
      const b = bars[idx];
      const x = count === 1 ? width * 0.5 : (idx + 0.5) * slotW;
      const oY = mapY(b.o);
      const cY = mapY(b.c);
      const hY = mapY(b.h);
      const lY = mapY(b.l);
      const xStr = x.toFixed(1);
      const cStr = cY.toFixed(1);
      if (idx === 0) firstX = x;
      lastX = x;
      lastY = cY;
      lineSegs.push(`${idx === 0 ? "M" : "L"}${xStr},${cStr}`);

      if (showCandles) {
        const wickCmd = `M${xStr},${hY.toFixed(1)}V${lY.toFixed(1)}`;
        const top = Math.min(oY, cY);
        const bodyH = Math.max(1.2, Math.abs(cY - oY));
        const bodyCmd = `M${(x - halfCandle).toFixed(1)},${top.toFixed(1)}h${candleW.toFixed(1)}v${bodyH.toFixed(1)}h-${candleW.toFixed(1)}Z`;
        if (b.c >= b.o) {
          upWicks.push(wickCmd);
          upBodies.push(bodyCmd);
        } else {
          downWicks.push(wickCmd);
          downBodies.push(bodyCmd);
        }
      }
    }

    const linePath = lineSegs.join(" ");
    const areaPath = `${linePath} L${lastX.toFixed(1)},${refY.toFixed(1)} L${firstX.toFixed(1)},${refY.toFixed(1)} Z`;

    return {
      refY,
      linePath,
      areaPath,
      lastX,
      lastY,
      upWicksPath: upWicks.join(" "),
      downWicksPath: downWicks.join(" "),
      upBodiesPath: upBodies.join(" "),
      downBodiesPath: downBodies.join(" "),
    };
  }, [bars, height, innerH, prevClose, showCandles, width]);

  if (!geometry) {
    return <div style={{ width, height }} className={className} />;
  }

  const upStroke = "#10b981";
  const downStroke = "#e11d48";
  const overallColor = isUp ? upStroke : downStroke;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
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

      {/* Batched Micro OHLC K-Line Bars (4 paths instead of 50+ SVG nodes) */}
      {showCandles && (
        <>
          {geometry.upWicksPath && (
            <path d={geometry.upWicksPath} stroke={upStroke} strokeWidth="0.8" strokeOpacity="0.72" fill="none" />
          )}
          {geometry.downWicksPath && (
            <path d={geometry.downWicksPath} stroke={downStroke} strokeWidth="0.8" strokeOpacity="0.72" fill="none" />
          )}
          {geometry.upBodiesPath && (
            <path d={geometry.upBodiesPath} fill={upStroke} fillOpacity="0.78" />
          )}
          {geometry.downBodiesPath && (
            <path d={geometry.downBodiesPath} fill={downStroke} fillOpacity="0.84" />
          )}
        </>
      )}

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
        cx={geometry.lastX}
        cy={geometry.lastY}
        r="2.0"
        fill={overallColor}
      />
    </svg>
  );
}

export default React.memo(MiniKLineSparkline);

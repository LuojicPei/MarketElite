"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { fetchMacroTape, type MacroTapeBar, type MacroTapeItem } from "@/lib/api";

interface MacroTickerStripProps {
  selectedSymbol: string;
  onSelectProxy: (proxySymbol: string, item: MacroTapeItem) => void;
}

function formatTapePrice(price: number, decimals: number, unit: string): string {
  const formatted = price.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  if (unit === "%") return `${formatted}%`;
  return formatted;
}

function formatTapeDelta(absVal: number, pctVal: number, decimals: number): string {
  const signAbs = absVal >= 0 ? "+" : "-";
  const absDigits = decimals >= 3 ? decimals : 2;
  const absStr = Math.abs(absVal).toLocaleString("en-US", {
    minimumFractionDigits: absDigits,
    maximumFractionDigits: absDigits,
  });
  const signPct = pctVal >= 0 ? "+" : "-";
  const pctStr = Math.abs(pctVal).toFixed(2);
  return `${signAbs}${absStr} ${signPct}${pctStr}%`;
}

function MiniKLineSparkline({
  bars,
  prevClose,
  isUp,
}: {
  bars: MacroTapeBar[];
  prevClose: number;
  isUp: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  const width = 82;
  const height = 36;
  const padY = 3.5;
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
    const candleW = Math.max(1.4, Math.min(3.4, slotW * 0.62));

    const pts: { x: number; y: number; oY: number; cY: number; hY: number; lY: number; c: number; o: number }[] =
      bars.map((b, idx) => {
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
  }, [bars, innerH, prevClose]);

  if (!geometry) {
    return <div className="h-[36px] w-[82px] shrink-0" />;
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
          <stop offset="0%" stopColor={upStroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={upStroke} stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id={`grad-down-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={downStroke} stopOpacity="0.03" />
          <stop offset="100%" stopColor={downStroke} stopOpacity="0.3" />
        </linearGradient>
      </defs>

      {/* Dual-tone area wash split around prev_close reference line */}
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

      {/* Horizontal Dotted Reference Line (Previous Close Baseline) */}
      <line
        x1={0}
        x2={width}
        y1={geometry.refY}
        y2={geometry.refY}
        stroke="currentColor"
        className="text-zinc-400/75 dark:text-zinc-500/75"
        strokeWidth="0.9"
        strokeDasharray="1.8 2"
      />

      {/* Micro OHLC K-Line Candlesticks */}
      {geometry.pts.map((p, idx) => {
        const candleUp = p.c >= p.o;
        const fill = candleUp ? upStroke : downStroke;
        const top = Math.min(p.oY, p.cY);
        const bodyH = Math.max(1.3, Math.abs(p.cY - p.oY));
        return (
          <g key={idx}>
            <line
              x1={p.x}
              x2={p.x}
              y1={p.hY}
              y2={p.lY}
              stroke={fill}
              strokeWidth="0.85"
              strokeOpacity="0.72"
            />
            <rect
              x={p.x - geometry.candleW / 2}
              y={top}
              width={geometry.candleW}
              height={bodyH}
              rx="0.4"
              fill={fill}
              fillOpacity={candleUp ? "0.78" : "0.84"}
            />
          </g>
        );
      })}

      {/* Connecting close contour + glowing live close dot */}
      <path
        d={geometry.linePath}
        fill="none"
        stroke={overallColor}
        strokeWidth="1.05"
        strokeOpacity="0.85"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={geometry.lastPt.x}
        cy={geometry.lastPt.y}
        r="2.2"
        fill={overallColor}
      />
    </svg>
  );
}

export default function MacroTickerStrip({
  selectedSymbol,
  onSelectProxy,
}: MacroTickerStripProps) {
  const [items, setItems] = useState<MacroTapeItem[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const offsetRef = useRef(0);
  const hoveredRef = useRef(false);
  const draggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartOffsetRef = useRef(0);
  const dragMovedRef = useRef(false);

  const loadTape = useCallback(async () => {
    try {
      const res = await fetchMacroTape(false);
      if (Array.isArray(res.items) && res.items.length > 0) {
        setItems(res.items);
      }
    } catch {
      // Silently preserve existing items if background poll blips
    }
  }, []);

  useEffect(() => {
    loadTape();
    const timer = window.setInterval(loadTape, 120_000);
    return () => window.clearInterval(timer);
  }, [loadTape]);

  const wrapOffset = useCallback((val: number, halfWidth: number) => {
    if (halfWidth <= 0) return 0;
    let next = val % halfWidth;
    if (next < 0) next += halfWidth;
    return next;
  }, []);

  // Smooth slow 60fps continuous marquee scroll via float offset accumulation
  useEffect(() => {
    if (items.length === 0) return;
    let rafId = 0;
    let lastTs = performance.now();
    const SPEED_PX_PER_SEC = 28;

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastTs) / 1000);
      lastTs = now;

      const container = containerRef.current;
      const track = trackRef.current;
      if (container && track && !hoveredRef.current && !draggingRef.current) {
        const halfWidth = track.scrollWidth / 2;
        if (halfWidth > 0) {
          offsetRef.current = wrapOffset(
            offsetRef.current + SPEED_PX_PER_SEC * dt,
            halfWidth
          );
          container.scrollLeft = offsetRef.current;
        }
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [items.length, wrapOffset]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    draggingRef.current = true;
    dragMovedRef.current = false;
    dragStartXRef.current = e.clientX;
    dragStartOffsetRef.current = offsetRef.current;
  };

  useEffect(() => {
    const onWinPointerMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const dx = e.clientX - dragStartXRef.current;
      if (Math.abs(dx) > 5) {
        dragMovedRef.current = true;
      }
      const container = containerRef.current;
      const track = trackRef.current;
      if (!container || !track) return;
      const halfWidth = track.scrollWidth / 2;
      offsetRef.current = wrapOffset(dragStartOffsetRef.current - dx, halfWidth);
      container.scrollLeft = offsetRef.current;
    };

    const onWinPointerUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      window.setTimeout(() => {
        dragMovedRef.current = false;
      }, 60);
    };

    window.addEventListener("pointermove", onWinPointerMove);
    window.addEventListener("pointerup", onWinPointerUp);
    window.addEventListener("pointercancel", onWinPointerUp);
    return () => {
      window.removeEventListener("pointermove", onWinPointerMove);
      window.removeEventListener("pointerup", onWinPointerUp);
      window.removeEventListener("pointercancel", onWinPointerUp);
    };
  }, [wrapOffset]);

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    const track = trackRef.current;
    if (!container || !track) return;
    const halfWidth = track.scrollWidth / 2;
    if (halfWidth <= 0) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(delta) < 1) return;
    offsetRef.current = wrapOffset(offsetRef.current + delta * 0.9, halfWidth);
    container.scrollLeft = offsetRef.current;
  };

  if (items.length === 0) {
    return null;
  }

  const loopItems = [...items, ...items];

  return (
    <aside
      aria-label="Global Macro Live Ticker Tape"
      className="macro-tape-rail fixed inset-x-0 bottom-0 z-40 h-[62px] select-none"
      onMouseEnter={() => {
        hoveredRef.current = true;
      }}
      onMouseLeave={() => {
        hoveredRef.current = false;
      }}
    >
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onWheel={handleWheel}
        className="h-full w-full cursor-grab overflow-x-hidden active:cursor-grabbing"
        style={{ touchAction: "pan-y" }}
      >
        <div ref={trackRef} className="flex h-full w-max items-stretch">
          {loopItems.map((item, idx) => {
            const isUp = item.change_abs >= 0;
            const isSelected = selectedSymbol === item.proxy_symbol;
            return (
              <button
                key={`${item.yahoo_symbol}-${idx}`}
                type="button"
                onClick={() => {
                  if (dragMovedRef.current) return;
                  onSelectProxy(item.proxy_symbol, item);
                }}
                title={`${item.name} (${item.zh_name}) — 点击查看代理标的 ${item.proxy_symbol} 深度K线与GEX`}
                className={`group relative flex h-full w-auto min-w-[205px] shrink-0 items-center justify-between gap-3 border-r border-zinc-200/70 px-4 text-left transition-colors hover:bg-zinc-900/[0.03] dark:border-white/[0.07] dark:hover:bg-white/[0.04] ${
                  isSelected
                    ? "bg-zinc-900/[0.04] dark:bg-white/[0.05]"
                    : ""
                }`}
              >
                {isSelected && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-3 top-0 h-[2px] rounded-full bg-zinc-950 dark:bg-sky-400"
                  />
                )}

                <div className="shrink-0 space-y-[1px] whitespace-nowrap">
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-sans text-[11.5px] font-bold tracking-tight text-blue-700 group-hover:underline dark:text-sky-400">
                      {item.name}
                    </span>
                    <span className="font-sans text-[10px] text-zinc-500 dark:text-zinc-400">
                      {item.zh_name}
                    </span>
                  </div>
                  <div className="font-mono text-[12px] font-bold leading-tight tabular-nums text-zinc-900 dark:text-zinc-50">
                    {formatTapePrice(item.price, item.decimals, item.unit)}
                  </div>
                  <div
                    className={`font-mono text-[10.5px] font-semibold leading-tight tabular-nums ${
                      isUp
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400"
                    }`}
                  >
                    {formatTapeDelta(item.change_abs, item.change_pct, item.decimals)}
                  </div>
                </div>

                <MiniKLineSparkline
                  bars={item.bars}
                  prevClose={item.prev_close}
                  isUp={isUp}
                />
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

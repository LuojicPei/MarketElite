"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import MiniKLineSparkline from "@/components/MiniKLineSparkline";
import { fetchMacroTape, type MacroTapeItem } from "@/lib/api";

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

export default function MacroTickerStrip({
  selectedSymbol,
  onSelectProxy,
}: MacroTickerStripProps) {
  const [items, setItems] = useState<MacroTapeItem[]>([]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const offsetRef = useRef(0);
  const halfWidthRef = useRef(0);
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
      // Preserve last loaded strip on transient network blips
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

  const applyGpuTransform = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    track.style.transform = `translate3d(${-offsetRef.current}px, 0, 0)`;
  }, []);

  // Measure single-loop width via ResizeObserver (avoids layout reads inside RAF)
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      halfWidthRef.current = track.scrollWidth / 2;
      offsetRef.current = wrapOffset(offsetRef.current, halfWidthRef.current);
      applyGpuTransform();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    return () => ro.disconnect();
  }, [items, applyGpuTransform, wrapOffset]);

  // Buttery GPU-composited subpixel glide (zero integer scrollLeft quantization)
  useEffect(() => {
    if (items.length === 0) return;
    let rafId = 0;
    let lastTs = performance.now();
    const SPEED_PX_PER_SEC = 18;

    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - lastTs) / 1000));
      lastTs = now;

      const halfWidth = halfWidthRef.current;
      if (halfWidth > 0 && !hoveredRef.current && !draggingRef.current) {
        offsetRef.current = wrapOffset(
          offsetRef.current + SPEED_PX_PER_SEC * dt,
          halfWidth
        );
        applyGpuTransform();
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [items.length, applyGpuTransform, wrapOffset]);

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
      const halfWidth = halfWidthRef.current;
      if (halfWidth <= 0) return;
      offsetRef.current = wrapOffset(dragStartOffsetRef.current - dx, halfWidth);
      applyGpuTransform();
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
  }, [applyGpuTransform, wrapOffset]);

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const halfWidth = halfWidthRef.current;
    if (halfWidth <= 0) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(delta) < 1) return;
    offsetRef.current = wrapOffset(offsetRef.current + delta * 0.9, halfWidth);
    applyGpuTransform();
  };

  if (items.length === 0) {
    return null;
  }

  const loopItems = [...items, ...items];

  return (
    <aside
      aria-label="Global Macro Live Ticker Tape"
      className="macro-tape-rail fixed inset-x-0 bottom-0 z-40 h-[48px] select-none overflow-hidden"
      onMouseEnter={() => {
        hoveredRef.current = true;
      }}
      onMouseLeave={() => {
        hoveredRef.current = false;
      }}
    >
      <div
        ref={viewportRef}
        onPointerDown={handlePointerDown}
        onWheel={handleWheel}
        className="h-full w-full cursor-grab overflow-hidden active:cursor-grabbing"
        style={{ touchAction: "pan-y" }}
      >
        <div
          ref={trackRef}
          className="flex h-full w-max items-stretch will-change-transform"
        >
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
                title={`${item.name} (${item.zh_name}) — 点击查看代理标的 ${item.proxy_symbol} 详情`}
                className={`group relative flex h-full w-auto min-w-[172px] shrink-0 items-center justify-between gap-2.5 border-r border-zinc-200/75 px-3 text-left transition-colors hover:bg-zinc-900/[0.04] dark:border-white/[0.08] dark:hover:bg-white/[0.05] ${
                  isSelected ? "bg-blue-500/[0.06] dark:bg-sky-400/[0.08]" : ""
                }`}
              >
                <div className="shrink-0 whitespace-nowrap leading-tight">
                  <div className="flex items-baseline gap-1">
                    <span className="font-sans text-[11px] font-bold tracking-tight text-blue-700 group-hover:underline dark:text-sky-400">
                      {item.name}
                    </span>
                    <span className="font-sans text-[10px] font-medium text-zinc-700 dark:text-zinc-300">
                      {item.zh_name}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[11.5px] font-bold tabular-nums text-zinc-950 dark:text-zinc-50">
                      {formatTapePrice(item.price, item.decimals, item.unit)}
                    </span>
                    <span
                      className={`font-mono text-[10px] font-semibold tabular-nums ${
                        isUp
                          ? "text-emerald-700 dark:text-emerald-400"
                          : "text-rose-700 dark:text-rose-400"
                      }`}
                    >
                      {formatTapeDelta(item.change_abs, item.change_pct, item.decimals)}
                    </span>
                  </div>
                </div>

                <MiniKLineSparkline
                  bars={item.bars}
                  prevClose={item.prev_close}
                  isUp={isUp}
                  width={62}
                  height={26}
                />
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

"use client";

import React, { useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  GripVertical,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import MiniKLineSparkline from "@/components/MiniKLineSparkline";
import SpotlightBlock from "@/components/SpotlightBlock";
import StockLogoBadge from "@/components/StockLogoBadge";
import type { WatchlistAssetItem } from "@/lib/api";

interface WatchlistCardPanelProps {
  items: WatchlistAssetItem[];
  loading: boolean;
  mutating: boolean;
  error: string | null;
  onAddSymbol: (symbol: string) => Promise<void>;
  onReorderSymbols: (symbols: string[]) => Promise<void>;
  onRemoveSymbol: (symbol: string) => Promise<void>;
  onOpenStockDetail: (symbol: string) => void;
  onOpenMyWatchlist: () => void;
}

export default function WatchlistCardPanel({
  items,
  loading,
  mutating,
  error,
  onAddSymbol,
  onReorderSymbols,
  onRemoveSymbol,
  onOpenStockDetail,
  onOpenMyWatchlist,
}: WatchlistCardPanelProps) {
  const [manageMode, setManageMode] = useState(false);
  const [inputSymbol, setInputSymbol] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const handleSubmitAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = inputSymbol.trim().toUpperCase();
    if (!cleaned) return;
    await onAddSymbol(cleaned);
    setInputSymbol("");
  };

  const moveItem = async (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = items.map((x) => x.symbol);
    [next[index], next[target]] = [next[target], next[index]];
    await onReorderSymbols(next);
  };

  const handleDrop = async (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) {
      setDragIndex(null);
      return;
    }
    const next = items.map((x) => x.symbol);
    const [moved] = next.splice(dragIndex, 1);
    next.splice(targetIndex, 0, moved);
    setDragIndex(null);
    await onReorderSymbols(next);
  };

  return (
    <SpotlightBlock tone="gallery" className="flex h-full flex-col justify-between p-4">
      <div className="space-y-3">
        {/* Header Row */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-mono text-xs font-semibold tracking-wider text-zinc-700 dark:text-zinc-200">
              WATCHLIST · 关注列表 ({items.length})
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setManageMode((v) => !v)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-xs font-medium transition ${
                manageMode
                  ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
                  : "border-zinc-300 bg-white text-zinc-800 hover:border-zinc-950 dark:border-white/20 dark:bg-white/[0.08] dark:text-zinc-100"
              }`}
            >
              <SlidersHorizontal className="h-3 w-3" />
              {manageMode ? "完成" : "管理"}
            </button>
            <button
              type="button"
              onClick={onOpenMyWatchlist}
              className="inline-flex items-center gap-1 rounded-full bg-zinc-950 px-2.5 py-1 font-mono text-xs font-medium text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950"
            >
              <span>对比</span>
              <ArrowRight className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* Inline Add Box */}
        <form onSubmit={handleSubmitAdd} className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Plus className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600 dark:text-zinc-300" />
            <input
              type="text"
              value={inputSymbol}
              onChange={(e) => setInputSymbol(e.target.value.toUpperCase())}
              placeholder="添加代码如 TSLA, PLTR..."
              className="w-full rounded-xl border border-zinc-300 bg-white/95 py-1.5 pl-8 pr-2.5 font-mono text-xs text-zinc-950 placeholder:text-zinc-500 focus:border-zinc-950 focus:outline-none dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-100 dark:placeholder:text-zinc-400"
            />
          </div>
          <button
            type="submit"
            disabled={mutating || !inputSymbol.trim()}
            className="shrink-0 rounded-xl bg-zinc-950 px-3 py-1.5 font-mono text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-45 dark:bg-white dark:text-zinc-950"
          >
            {mutating ? "..." : "加入"}
          </button>
        </form>

        {error && (
          <div className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/40 dark:text-rose-200">
            {error}
          </div>
        )}

        {/* Dense Watchlist Rows */}
        <div className="max-h-[385px] divide-y divide-zinc-200/85 overflow-y-auto overflow-x-hidden rounded-xl border border-zinc-200/90 bg-white/80 dark:divide-white/[0.08] dark:border-white/15 dark:bg-white/[0.04]">
          {loading && items.length === 0 ? (
            <div className="p-4 text-center font-mono text-xs text-zinc-700 dark:text-zinc-300">
              正在加载关注列表...
            </div>
          ) : items.length === 0 ? (
            <div className="p-4 text-center text-xs text-zinc-700 dark:text-zinc-300">
              暂无自选股，请在上方添加美股代码。
            </div>
          ) : (
            items.map((item, idx) => {
              const chgPct = item.change_1d_pct ?? 0;
              const isUp = chgPct >= 0;
              return (
                <div
                  key={item.symbol}
                  draggable={manageMode}
                  onDragStart={() => setDragIndex(idx)}
                  onDragOver={(e) => {
                    if (manageMode) e.preventDefault();
                  }}
                  onDrop={() => {
                    if (manageMode) void handleDrop(idx);
                  }}
                  className={`group flex items-center justify-between gap-2 px-3 py-2.5 transition-colors ${
                    manageMode
                      ? "cursor-move hover:bg-zinc-100/80 dark:hover:bg-white/[0.06]"
                      : "cursor-pointer hover:bg-zinc-100/80 dark:hover:bg-white/[0.07]"
                  }`}
                  onClick={() => {
                    if (!manageMode) {
                      onOpenStockDetail(item.symbol);
                    }
                  }}
                >
                  {/* Corporate Icon + Name + Ticker */}
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                    {manageMode && (
                      <GripVertical className="h-3.5 w-3.5 shrink-0 text-zinc-500 dark:text-zinc-300" />
                    )}
                    <StockLogoBadge symbol={item.symbol} size={32} />
                    <div className="min-w-0">
                      <div className="truncate font-sans text-[13px] font-semibold leading-tight text-zinc-950 group-hover:underline dark:text-zinc-50">
                        {item.name}
                      </div>
                      <div className="truncate font-mono text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                        <span className="font-bold text-zinc-900 dark:text-zinc-100">
                          {item.symbol}
                        </span>{" "}
                        · {item.exchange}
                      </div>
                    </div>
                  </div>

                  {/* Mini 18D K-Line (compact) */}
                  {!manageMode && (
                    <div className="hidden items-center sm:flex">
                      <MiniKLineSparkline
                        bars={item.sparkline_bars}
                        prevClose={item.prev_close}
                        isUp={isUp}
                        width={60}
                        height={24}
                      />
                    </div>
                  )}

                  {/* Price & Controls */}
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="text-right tabular-nums">
                      <div className="font-mono text-[13px] font-bold leading-tight text-zinc-950 dark:text-zinc-50">
                        ${item.price.toLocaleString("en-US", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                      <div
                        className={`font-mono text-[11px] font-semibold leading-tight ${
                          isUp
                            ? "text-emerald-700 dark:text-emerald-400"
                            : "text-rose-700 dark:text-rose-400"
                        }`}
                      >
                        {isUp ? "↗" : "↘"} {isUp ? "+" : ""}
                        {chgPct.toFixed(2)}%
                      </div>
                    </div>

                    {manageMode && (
                      <div
                        className="flex items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => void moveItem(idx, -1)}
                          disabled={mutating || idx === 0}
                          title="上移"
                          className="rounded border border-zinc-300 bg-white p-1 text-zinc-800 disabled:opacity-35 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-100"
                        >
                          <ArrowUp className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void moveItem(idx, 1)}
                          disabled={mutating || idx === items.length - 1}
                          title="下移"
                          className="rounded border border-zinc-300 bg-white p-1 text-zinc-800 disabled:opacity-35 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-100"
                        >
                          <ArrowDown className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void onRemoveSymbol(item.symbol)}
                          disabled={mutating}
                          title={`移出 ${item.symbol}`}
                          className="rounded border border-rose-300 bg-rose-50 p-1 text-rose-700 hover:bg-rose-600 hover:text-white dark:border-rose-500/40 dark:bg-rose-950/50 dark:text-rose-300"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="mt-2.5 flex items-center justify-between font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
        <span>点击标的查看个股页</span>
        <span>管理可拖拽排序</span>
      </div>
    </SpotlightBlock>
  );
}

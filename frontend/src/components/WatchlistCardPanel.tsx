"use client";

import React, { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
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
  selectedSymbol?: string;
  onSelectSymbol?: (symbol: string) => void;
  onAddSymbol: (symbol: string) => Promise<void>;
  onReorderSymbols: (symbols: string[]) => Promise<void>;
  onRemoveSymbol: (symbol: string) => Promise<void>;
  onOpenStockDetail: (symbol: string) => void;
  onOpenMyWatchlist: () => void;
}

type HomeWatchlistSort = "order" | "1d" | "5d" | "ytd";

const SORT_LABELS: Record<HomeWatchlistSort, string> = {
  order: "自定义",
  "1d": "1D▾",
  "5d": "5D▾",
  ytd: "YTD▾",
};

const SORT_SEQUENCE: HomeWatchlistSort[] = ["order", "1d", "5d", "ytd"];

function WatchlistCardPanel({
  items,
  loading,
  mutating,
  error,
  selectedSymbol,
  onSelectSymbol,
  onAddSymbol,
  onReorderSymbols,
  onRemoveSymbol,
  onOpenStockDetail,
  onOpenMyWatchlist,
}: WatchlistCardPanelProps) {
  const [manageMode, setManageMode] = useState(false);
  const [sortMode, setSortMode] = useState<HomeWatchlistSort>("order");
  const [inputSymbol, setInputSymbol] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const displayedItems = useMemo(() => {
    if (sortMode === "order") return items;
    const key =
      sortMode === "1d"
        ? "change_1d_pct"
        : sortMode === "5d"
          ? "change_5d_pct"
          : "change_ytd_pct";
    return [...items].sort((a, b) => {
      const av = typeof a[key] === "number" ? (a[key] as number) : -9999;
      const bv = typeof b[key] === "number" ? (b[key] as number) : -9999;
      return bv - av;
    });
  }, [items, sortMode]);

  const cycleSortMode = () => {
    const nextIdx = (SORT_SEQUENCE.indexOf(sortMode) + 1) % SORT_SEQUENCE.length;
    const next = SORT_SEQUENCE[nextIdx];
    setSortMode(next);
    if (next !== "order" && manageMode) {
      setManageMode(false);
    }
  };

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
    if (dragIndex === null || dragIndex === targetIndex || mutating) {
      setDragIndex(null);
      setDragOverIdx(null);
      return;
    }
    const next = items.map((x) => x.symbol);
    const [moved] = next.splice(dragIndex, 1);
    next.splice(targetIndex, 0, moved);
    setDragIndex(null);
    setDragOverIdx(null);
    await onReorderSymbols(next);
  };

  return (
    <SpotlightBlock tone="gallery" className="flex h-full flex-col justify-between p-4">
      <div className="flex min-h-0 flex-1 flex-col space-y-3">
        {/* Header Row */}
        <div className="flex items-center justify-between gap-1.5">
          <div className="min-w-0">
            <div className="truncate font-mono text-xs font-semibold tracking-wider text-zinc-700 dark:text-zinc-200">
              <span className="2xl:hidden">自选 ({items.length})</span>
              <span className="hidden 2xl:inline">关注列表 ({items.length})</span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={cycleSortMode}
              title="点击切换排序：自定义顺序 → 1日涨跌 → 5日 → YTD"
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 font-mono text-[11px] font-medium transition ${
                sortMode !== "order"
                  ? "border-emerald-600 bg-emerald-600 text-white dark:border-emerald-400 dark:bg-emerald-500 dark:text-zinc-950"
                  : "border-zinc-300 bg-white text-zinc-800 hover:border-zinc-950 dark:border-white/20 dark:bg-white/[0.08] dark:text-zinc-100"
              }`}
            >
              <ArrowUpDown className="h-3 w-3" />
              {SORT_LABELS[sortMode]}
            </button>
            <button
              type="button"
              onClick={() => {
                setManageMode((v) => !v);
                setSortMode("order");
              }}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 font-mono text-[11px] font-medium transition ${
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
              className="inline-flex items-center gap-1 rounded-full bg-zinc-950 px-2 py-1 font-mono text-[11px] font-medium text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950"
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
        <div className="min-h-0 flex-1 divide-y divide-zinc-200/85 overflow-y-auto overflow-x-hidden rounded-xl border border-zinc-200/90 bg-white/80 dark:divide-white/[0.08] dark:border-white/15 dark:bg-white/[0.04]">
          {loading && items.length === 0 ? (
            <div className="p-4 text-center font-mono text-xs text-zinc-700 dark:text-zinc-300">
              正在加载关注列表...
            </div>
          ) : items.length === 0 ? (
            <div className="p-4 text-center text-xs text-zinc-700 dark:text-zinc-300">
              暂无自选股，请在上方添加美股代码。
            </div>
          ) : (
            displayedItems.map((item, idx) => {
              const canDrag = sortMode === "order" && !mutating;
              const isDropTarget = canDrag && dragOverIdx === idx && dragIndex !== idx;
              const chgPct = item.change_1d_pct ?? 0;
              const isUp = chgPct >= 0;
              const isViewing = selectedSymbol === item.symbol;
              return (
                <div
                  key={item.symbol}
                  draggable={canDrag}
                  onDragStart={() => {
                    if (canDrag) setDragIndex(idx);
                  }}
                  onDragOver={(e) => {
                    if (canDrag) {
                      e.preventDefault();
                      setDragOverIdx(idx);
                    }
                  }}
                  onDragLeave={() => {
                    if (dragOverIdx === idx) setDragOverIdx(null);
                  }}
                  onDrop={() => {
                    if (canDrag) void handleDrop(idx);
                  }}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setDragOverIdx(null);
                  }}
                  className={`group flex items-center justify-between gap-2 px-3 py-2 transition-colors ${
                    isDropTarget
                      ? "bg-emerald-500/15 ring-1 ring-inset ring-emerald-500 dark:bg-emerald-500/25"
                      : manageMode
                        ? "cursor-move hover:bg-zinc-100/80 dark:hover:bg-white/[0.06]"
                        : isViewing
                          ? "cursor-pointer bg-emerald-500/12 dark:bg-emerald-500/15"
                          : "cursor-pointer hover:bg-zinc-100/80 dark:hover:bg-white/[0.07]"
                  }`}
                  onClick={() => {
                    if (!manageMode) {
                      if (onSelectSymbol) {
                        onSelectSymbol(item.symbol);
                      } else {
                        onOpenStockDetail(item.symbol);
                      }
                    }
                  }}
                >
                  {/* Corporate Icon + Name + Ticker */}
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {canDrag && (
                      <span
                        title="拖拽调整关注顺序"
                        onClick={(e) => e.stopPropagation()}
                        className="cursor-grab text-zinc-400 transition group-hover:text-zinc-700 active:cursor-grabbing dark:text-zinc-500 dark:group-hover:text-zinc-200"
                      >
                        <GripVertical className="h-3.5 w-3.5 shrink-0" />
                      </span>
                    )}
                    <StockLogoBadge symbol={item.symbol} size={30} />
                    <div className="min-w-0">
                      <div className="truncate font-sans text-[12.5px] font-semibold leading-tight text-zinc-950 dark:text-zinc-50">
                        {item.name}
                      </div>
                      <div className="flex items-center gap-1 truncate font-mono text-[10.5px] font-medium text-zinc-700 dark:text-zinc-300">
                        <span className="font-bold text-zinc-900 dark:text-zinc-100">
                          {item.symbol}
                        </span>
                        <span className="hidden 2xl:inline">· {item.exchange}</span>
                        {isViewing && !manageMode && (
                          <span className="shrink-0 rounded bg-emerald-600 px-1 py-0.5 font-mono text-[8.5px] font-bold text-white dark:bg-emerald-500 dark:text-zinc-950">
                            看盘
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Centered Wider Borderless 18D K-Line */}
                  {!manageMode && (
                    <div className="hidden shrink-0 items-center justify-center px-1 lg:flex">
                      <MiniKLineSparkline
                        bars={item.sparkline_bars}
                        prevClose={item.prev_close}
                        isUp={isUp}
                        width={84}
                        height={32}
                      />
                    </div>
                  )}

                  {/* Price & Controls */}
                  <div className="flex min-w-[96px] shrink-0 items-center justify-end gap-1.5">
                    <div className="text-right tabular-nums">
                      <div className="font-mono text-[12.5px] font-bold leading-tight text-zinc-950 dark:text-zinc-50">
                        ${item.price.toLocaleString("en-US", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                      <div
                        className={`font-mono text-[10.5px] font-semibold leading-tight ${
                          isUp
                            ? "text-emerald-700 dark:text-emerald-400"
                            : "text-rose-700 dark:text-rose-400"
                        }`}
                      >
                        {isUp ? "↗" : "↘"} {isUp ? "+" : ""}
                        {chgPct.toFixed(2)}%
                      </div>
                      {item.extended_hours && (
                        <div
                          className={`font-mono text-[9px] font-medium leading-tight ${
                            (item.extended_hours.change_pct ?? 0) >= 0
                              ? "text-amber-700 dark:text-amber-300"
                              : "text-rose-700/80 dark:text-rose-300/80"
                          }`}
                          title={`${item.extended_hours.label_zh} $${item.extended_hours.price.toFixed(2)}`}
                        >
                          {item.extended_hours.label_zh}{" "}
                          {item.extended_hours.change_pct != null
                            ? `${item.extended_hours.change_pct >= 0 ? "+" : ""}${item.extended_hours.change_pct.toFixed(2)}%`
                            : `$${item.extended_hours.price.toFixed(2)}`}
                        </div>
                      )}
                    </div>

                    {!manageMode && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenStockDetail(item.symbol);
                        }}
                        title={`进入 ${item.symbol} 个股深度详情页`}
                        aria-label={`进入 ${item.symbol} 个股详情页`}
                        className="rounded-lg border border-zinc-200 bg-white/80 p-1 text-zinc-600 transition hover:border-zinc-950 hover:bg-zinc-950 hover:text-white dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-300 dark:hover:border-white dark:hover:bg-white dark:hover:text-zinc-950"
                      >
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </button>
                    )}

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
        <span>单击切主图 · ↗ 进详情</span>
        <span>
          {sortMode === "order" ? "直接拖拽可自由排序" : "切回「自定义」可拖拽"}
        </span>
      </div>
    </SpotlightBlock>
  );
}

export default React.memo(WatchlistCardPanel);

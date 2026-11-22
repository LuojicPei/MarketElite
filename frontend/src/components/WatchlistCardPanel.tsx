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

  const pinTop = async (index: number) => {
    if (index <= 0) return;
    const next = items.map((x) => x.symbol);
    const [picked] = next.splice(index, 1);
    next.unshift(picked);
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
    <SpotlightBlock tone="gallery" className="flex flex-col justify-between p-5 sm:p-6 lg:col-span-7">
      <div className="space-y-4">
        {/* Panel Header & Management Toggle */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-mono text-xs font-semibold tracking-wider text-zinc-700 dark:text-zinc-300">
              WATCHLIST · 我的自选关注 ({items.length})
            </div>
            <h3 className="mt-1 font-serif text-xl font-medium text-zinc-950 dark:text-zinc-50 sm:text-2xl">
              关注列表 · 图标 / 微型 K 线 / 一键排重
            </h3>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setManageMode((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-xs font-medium transition ${
                manageMode
                  ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
                  : "border-zinc-300 bg-white/90 text-zinc-800 hover:border-zinc-950 dark:border-white/20 dark:bg-white/[0.08] dark:text-zinc-100 dark:hover:border-white/50"
              }`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {manageMode ? "完成管理" : "管理 / 排序"}
            </button>
            <button
              type="button"
              onClick={onOpenMyWatchlist}
              className="inline-flex items-center gap-1 rounded-full bg-zinc-950 px-3.5 py-1.5 font-mono text-xs font-medium text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              <span>我的关注对比</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Inline Fast Ticker Search / Add Bar */}
        <form onSubmit={handleSubmitAdd} className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Plus className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600 dark:text-zinc-300" />
            <input
              type="text"
              value={inputSymbol}
              onChange={(e) => setInputSymbol(e.target.value.toUpperCase())}
              placeholder="输入股票代码添加至关注 (如 NVDA, TSLA, PLTR, MU)..."
              className="w-full rounded-xl border border-zinc-300 bg-white/90 py-2 pl-9 pr-3 font-mono text-sm text-zinc-950 placeholder:text-zinc-500 focus:border-zinc-950 focus:outline-none dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-100 dark:placeholder:text-zinc-400 dark:focus:border-white/40"
            />
          </div>
          <button
            type="submit"
            disabled={mutating || !inputSymbol.trim()}
            className="rounded-xl bg-zinc-950 px-4 py-2 font-mono text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-45 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            {mutating ? "添加中..." : "+ 加入关注"}
          </button>
        </form>

        {error && (
          <div className="rounded-xl border border-rose-300 bg-rose-50 px-3.5 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/40 dark:text-rose-200">
            {error}
          </div>
        )}

        {/* Watchlist Rows (App-Icon + Company Name + Mini K-Line + Price $ + Quick Manage) */}
        <div className="divide-y divide-zinc-200/85 overflow-hidden rounded-2xl border border-zinc-200/90 bg-white/75 dark:divide-white/[0.08] dark:border-white/15 dark:bg-white/[0.04]">
          {loading && items.length === 0 ? (
            <div className="p-6 text-center font-mono text-sm text-zinc-700 dark:text-zinc-300">
              正在加载关注列表实时行情与 K 线...
            </div>
          ) : items.length === 0 ? (
            <div className="p-6 text-center text-sm text-zinc-700 dark:text-zinc-300">
              关注列表为空，请使用上方输入框添加任意美股标的。
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
                  className={`group flex items-center justify-between gap-3 px-4 py-3 transition-colors ${
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
                  {/* Left: Grip Handle (when managing) + Corporate Icon + Name + Exchange */}
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    {manageMode && (
                      <GripVertical className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-300" />
                    )}
                    <StockLogoBadge symbol={item.symbol} size={38} />
                    <div className="min-w-0">
                      <div className="truncate font-sans text-sm font-semibold text-zinc-950 group-hover:underline dark:text-zinc-50">
                        {item.name}
                      </div>
                      <div className="flex items-center gap-1.5 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                        <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                          {item.symbol}
                        </span>
                        <span>·</span>
                        <span>{item.exchange}</span>
                      </div>
                    </div>
                  </div>

                  {/* Center: Mini OHLC K-Line & Reference Line Sparkline */}
                  <div className="hidden items-center sm:flex">
                    <MiniKLineSparkline
                      bars={item.sparkline_bars}
                      prevClose={item.prev_close}
                      isUp={isUp}
                      width={92}
                      height={32}
                    />
                  </div>

                  {/* Right: Price ($) + 1D % OR Sort/Delete Buttons */}
                  <div className="flex shrink-0 items-center gap-3">
                    <div className="text-right tabular-nums">
                      <div className="font-mono text-sm font-bold text-zinc-950 dark:text-zinc-50">
                        ${item.price.toLocaleString("en-US", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                      <div
                        className={`font-mono text-xs font-semibold ${
                          isUp
                            ? "text-emerald-700 dark:text-emerald-400"
                            : "text-rose-700 dark:text-rose-400"
                        }`}
                      >
                        {isUp ? "↗" : "↘"} {isUp ? "+" : ""}
                        {chgPct.toFixed(2)}%
                      </div>
                    </div>

                    {manageMode ? (
                      <div
                        className="flex items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => void moveItem(idx, -1)}
                          disabled={mutating || idx === 0}
                          title="上移"
                          className="rounded-lg border border-zinc-300 bg-white p-1.5 text-zinc-800 transition hover:border-zinc-950 disabled:opacity-35 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-100"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void moveItem(idx, 1)}
                          disabled={mutating || idx === items.length - 1}
                          title="下移"
                          className="rounded-lg border border-zinc-300 bg-white p-1.5 text-zinc-800 transition hover:border-zinc-950 disabled:opacity-35 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-100"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        {idx > 0 && (
                          <button
                            type="button"
                            onClick={() => void pinTop(idx)}
                            disabled={mutating}
                            title="置顶"
                            className="rounded-lg border border-zinc-300 bg-white px-2 py-1 font-mono text-xs text-zinc-800 transition hover:border-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-100"
                          >
                            顶
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void onRemoveSymbol(item.symbol)}
                          disabled={mutating}
                          title={`移出 ${item.symbol}`}
                          className="rounded-lg border border-rose-300 bg-rose-50 p-1.5 text-rose-700 transition hover:bg-rose-600 hover:text-white dark:border-rose-500/40 dark:bg-rose-950/50 dark:text-rose-300"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <ArrowRight className="h-4 w-4 text-zinc-500 opacity-60 transition group-hover:translate-x-0.5 group-hover:text-zinc-950 group-hover:opacity-100 dark:text-zinc-300 dark:group-hover:text-white" />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200/80 pt-3 font-mono text-xs text-zinc-700 dark:border-white/10 dark:text-zinc-300">
        <span>点击任意关注股直达专属个股页面 · 切换「管理 / 排序」支持拖拽与上下移动</span>
        <span className="font-semibold text-zinc-900 dark:text-zinc-100">
          PostgreSQL 持久化同步
        </span>
      </div>
    </SpotlightBlock>
  );
}

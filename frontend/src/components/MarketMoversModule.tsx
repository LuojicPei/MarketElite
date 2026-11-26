"use client";

import React, { useMemo, useState } from "react";
import { Flame, RefreshCw, TrendingDown, TrendingUp, Zap } from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import StockLogoBadge from "@/components/StockLogoBadge";
import type { MarketMoverItem, MarketMoversResponse } from "@/lib/api";

interface MarketMoversModuleProps {
  data: MarketMoversResponse | null;
  loading?: boolean;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  onRefresh?: () => void;
  minPrice?: number;
  onToggleMinPrice?: (nextMinPrice: number) => void;
}

type MoverTab = "gainers" | "losers" | "rvol";

function MarketMoversModule({
  data,
  loading = false,
  selectedSymbol,
  onSelectSymbol,
  onRefresh,
  minPrice = 2.0,
  onToggleMinPrice,
}: MarketMoversModuleProps) {
  const [tab, setTab] = useState<MoverTab>("gainers");
  const [refreshing, setRefreshing] = useState(false);

  const list: MarketMoverItem[] = useMemo(() => {
    if (!data) return [];
    if (tab === "losers") return data.top_losers ?? [];
    if (tab === "rvol") return data.unusual_volume ?? [];
    return data.top_gainers ?? [];
  }, [data, tab]);

  const handleRefresh = () => {
    if (!onRefresh) return;
    setRefreshing(true);
    onRefresh();
    window.setTimeout(() => setRefreshing(false), 700);
  };

  return (
    <SpotlightBlock
      tone="obsidian"
      className="flex h-full flex-col justify-between gap-2 p-3 sm:p-3.5"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5 font-sans text-xs font-bold tracking-tight text-zinc-950 dark:text-white sm:text-sm">
          <Flame className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="truncate">今日异动龙虎榜</span>
          <span className="shrink-0 rounded-full border border-zinc-300 bg-white/90 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            TOP {list.length || 20}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {onToggleMinPrice && (
            <button
              type="button"
              onClick={() => onToggleMinPrice(minPrice > 0 ? 0 : 2.0)}
              title={
                minPrice > 0
                  ? "当前已过滤股价<$2与权证噪音，点击查看全市场无门槛异动"
                  : "当前展示全市场无门槛涨跌榜（含低价小盘），点击开启$2+过滤"
              }
              className={`rounded-full border px-2 py-0.5 font-mono text-[9.5px] font-semibold transition ${
                minPrice > 0
                  ? "border-emerald-600/40 bg-emerald-500/12 text-emerald-800 hover:bg-emerald-500/20 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300"
                  : "border-amber-500/50 bg-amber-500/15 text-amber-900 hover:bg-amber-500/25 dark:text-amber-200"
              }`}
            >
              {minPrice > 0 ? "过滤<$2" : "全市场"}
            </button>
          )}
          {onRefresh && (
            <button
              type="button"
              onClick={handleRefresh}
              title="刷新实时涨跌幅与成交放量"
              className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-zinc-300 bg-white/90 text-zinc-700 transition hover:border-zinc-950 hover:text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-white/40 dark:hover:text-white"
            >
              <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          )}
        </div>
      </div>

      {/* Narrative Bar + 3-Tab Switch */}
      <div className="space-y-1.5">
        {data?.summary_zh && (
          <div className="truncate rounded-lg border border-zinc-200/90 bg-white/80 px-2.5 py-1 font-sans text-[10.5px] font-medium text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/75 dark:text-zinc-200">
            {data.summary_zh}
          </div>
        )}

        <div className="grid grid-cols-3 gap-1 rounded-xl border border-zinc-200/90 bg-white/80 p-1 font-sans text-[11px] dark:border-zinc-800 dark:bg-zinc-950/75">
          <button
            type="button"
            onClick={() => setTab("gainers")}
            className={`inline-flex items-center justify-center gap-1 rounded-lg px-1.5 py-1 font-semibold transition ${
              tab === "gainers"
                ? "bg-emerald-600 text-white shadow-sm dark:bg-emerald-500 dark:text-zinc-950"
                : "text-zinc-700 hover:bg-zinc-200/70 hover:text-zinc-950 dark:text-zinc-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
            }`}
          >
            <TrendingUp className="h-3 w-3" />
            <span>今日领涨</span>
          </button>
          <button
            type="button"
            onClick={() => setTab("losers")}
            className={`inline-flex items-center justify-center gap-1 rounded-lg px-1.5 py-1 font-semibold transition ${
              tab === "losers"
                ? "bg-rose-600 text-white shadow-sm dark:bg-rose-500"
                : "text-zinc-700 hover:bg-zinc-200/70 hover:text-zinc-950 dark:text-zinc-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
            }`}
          >
            <TrendingDown className="h-3 w-3" />
            <span>今日重挫</span>
          </button>
          <button
            type="button"
            onClick={() => setTab("rvol")}
            className={`inline-flex items-center justify-center gap-1 rounded-lg px-1.5 py-1 font-semibold transition ${
              tab === "rvol"
                ? "bg-amber-500 text-zinc-950 shadow-sm dark:bg-amber-400"
                : "text-zinc-700 hover:bg-zinc-200/70 hover:text-zinc-950 dark:text-zinc-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
            }`}
          >
            <Zap className="h-3 w-3" />
            <span>异常爆量</span>
          </button>
        </div>
      </div>

      {/* Dense Ranked Top-20 Movers Feed */}
      <div className="min-h-0 flex-1 divide-y divide-zinc-200/80 overflow-y-auto rounded-xl border border-zinc-200/90 bg-white/90 dark:divide-zinc-800/80 dark:border-zinc-800/90 dark:bg-zinc-950/65">
        {loading && list.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 font-mono text-xs text-zinc-500 dark:text-zinc-400">
            正在扫描全美股实时异动榜单...
          </div>
        ) : list.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 font-mono text-xs text-zinc-500 dark:text-zinc-400">
            暂无盘中异动记录
          </div>
        ) : (
          list.map((item, idx) => {
            const up = item.change_1d_pct >= 0;
            const active = selectedSymbol === item.symbol;
            return (
              <button
                key={`${tab}-${item.symbol}`}
                type="button"
                onClick={() => onSelectSymbol(item.symbol)}
                className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left transition ${
                  active
                    ? "bg-emerald-500/15 ring-1 ring-inset ring-emerald-500/60 dark:bg-emerald-500/18"
                    : "hover:bg-zinc-100/80 dark:hover:bg-white/[0.06]"
                }`}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="w-4 shrink-0 text-center font-mono text-[10px] font-semibold text-zinc-500 tabular-nums">
                    {idx + 1}
                  </span>
                  <StockLogoBadge symbol={item.symbol} size={24} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs font-bold text-zinc-950 dark:text-white">
                        {item.symbol}
                      </span>
                      <span className="truncate font-sans text-[11px] text-zinc-600 dark:text-zinc-300">
                        {item.name_zh}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <span className="rounded bg-zinc-100 px-1.5 py-0.2 font-sans text-[9px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                        {item.theme_zh}
                      </span>
                      {tab !== "rvol" && item.rvol >= 1.35 && (
                        <span className="font-mono text-[9.5px] font-semibold text-amber-700 dark:text-amber-400">
                          量比 {item.rvol.toFixed(1)}x
                        </span>
                      )}
                      {tab === "rvol" && item.dollar_vol_m > 0 && (
                        <span className="font-mono text-[9.5px] text-zinc-600 dark:text-zinc-400">
                          额 ${item.dollar_vol_m >= 1000 ? `${(item.dollar_vol_m / 1000).toFixed(1)}B` : `${item.dollar_vol_m.toFixed(0)}M`}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="shrink-0 text-right font-mono tabular-nums">
                  <div className="text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">
                    ${item.price.toFixed(2)}
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    {tab === "rvol" && item.rvol > 1.0 && (
                      <span className="rounded bg-amber-500/15 px-1 py-0.2 text-[9.5px] font-bold text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
                        {item.rvol.toFixed(1)}x
                      </span>
                    )}
                    <span
                      className={`text-[11px] font-bold ${
                        up
                          ? "text-emerald-700 dark:text-emerald-400"
                          : "text-rose-700 dark:text-rose-400"
                      }`}
                    >
                      {up ? "+" : ""}
                      {item.change_1d_pct.toFixed(2)}%
                    </span>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between font-mono text-[9.5px] text-zinc-600 dark:text-zinc-400">
        <span>点击直切主图 · {minPrice > 0 ? "过滤<$2与权证" : "全市场无门槛"}</span>
        <span>
          {data?.universe_count ? `全美股扫描 (${data.universe_count}池)` : "全美股实时榜单"}
        </span>
      </div>
    </SpotlightBlock>
  );
}

export default React.memo(MarketMoversModule);

"use client";

import React, { useMemo, useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import StockLogoBadge from "@/components/StockLogoBadge";
import type { WatchlistAssetItem } from "@/lib/api";
import { computeSingleStockStats, type SimWindow } from "@/lib/watchlistQuant";

interface WatchlistRiskRankingCardProps {
  items: WatchlistAssetItem[];
  highlightSymbol: string | null;
  onHoverSymbol: (symbol: string | null) => void;
  onOpenStockDetail: (symbol: string) => void;
}

type RiskSortMode = "safest" | "wildest" | "ext_hours";

function WatchlistRiskRankingCard({
  items,
  highlightSymbol,
  onHoverSymbol,
  onOpenStockDetail,
}: WatchlistRiskRankingCardProps) {
  const [win, setWin] = useState<SimWindow>("YTD");
  const [sortBy, setSortBy] = useState<RiskSortMode>("safest");

  const ranked = useMemo(() => {
    const rows = items.map((item) => ({
      item,
      stats: computeSingleStockStats(item, win),
    }));
    const maxDdScale = Math.max(
      15,
      ...rows.map((r) => Math.abs(r.stats.maxDrawdownPct))
    );

    rows.sort((a, b) => {
      if (sortBy === "safest") {
        // Least negative max drawdown (closest to 0%) ranks highest
        return b.stats.maxDrawdownPct - a.stats.maxDrawdownPct;
      }
      if (sortBy === "wildest") {
        return b.stats.annVolPct - a.stats.annVolPct;
      }
      const aExt = Math.abs(a.item.extended_hours?.change_pct ?? -1);
      const bExt = Math.abs(b.item.extended_hours?.change_pct ?? -1);
      return bExt - aExt;
    });

    const anchorRow = [...rows].sort(
      (a, b) => b.stats.maxDrawdownPct - a.stats.maxDrawdownPct
    )[0];
    const wildRow = [...rows].sort(
      (a, b) => b.stats.annVolPct - a.stats.annVolPct
    )[0];

    return { rows, maxDdScale, anchorRow, wildRow };
  }, [items, sortBy, win]);

  return (
    <SpotlightBlock tone="gallery" className="overflow-hidden p-4">
      {/* Header Row */}
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <span className="font-mono text-xs font-semibold tracking-wider text-zinc-800 dark:text-zinc-200">
            RISK DEFENSE MATRIX · 抗风险能力与最大回撤体检
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px]">
          <div className="inline-flex rounded-full border border-zinc-300/80 bg-white/80 p-0.5 dark:border-white/15 dark:bg-white/[0.05]">
            {(
              [
                { id: "safest", label: "最稳抗跌" },
                { id: "wildest", label: "高波弹性" },
                { id: "ext_hours", label: "盘前盘后" },
              ] as const
            ).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSortBy(s.id)}
                className={`rounded-full px-2 py-0.5 font-semibold transition ${
                  sortBy === s.id
                    ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                    : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="inline-flex rounded-full border border-zinc-300/80 bg-white/80 p-0.5 dark:border-white/15 dark:bg-white/[0.05]">
            {(["6M", "YTD", "1Y"] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWin(w)}
                className={`rounded-full px-2 py-0.5 font-semibold transition ${
                  win === w
                    ? "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-zinc-950"
                    : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                }`}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Dense Defense Table */}
      <div className="overflow-x-auto rounded-xl border border-zinc-200/85 bg-white/85 dark:border-white/10 dark:bg-white/[0.03]">
        <table className="w-full border-collapse text-left font-mono text-xs tabular-nums">
          <thead>
            <tr className="border-b border-zinc-200/90 text-[10.5px] font-semibold text-zinc-600 dark:border-white/10 dark:text-zinc-400">
              <th className="px-2.5 py-2">标的</th>
              <th className="px-2 py-2">区间最大回撤 ({win})</th>
              <th className="px-2 py-2 text-right">年化波动</th>
              <th className="px-2 py-2 text-right">日胜率</th>
              <th className="px-2.5 py-2 text-right">盘前/盘后异动</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200/75 dark:divide-white/[0.06]">
            {ranked.rows.map(({ item, stats }) => {
              const ddAbs = Math.abs(stats.maxDrawdownPct);
              const barPct = Math.min(100, Math.max(4, (ddAbs / ranked.maxDdScale) * 100));
              const isFocus = highlightSymbol === item.symbol;
              const ddTone =
                ddAbs <= 18
                  ? "bg-emerald-500"
                  : ddAbs <= 38
                    ? "bg-amber-500"
                    : "bg-rose-500";
              const ddTextCls =
                ddAbs <= 18
                  ? "text-emerald-700 dark:text-emerald-400"
                  : ddAbs <= 38
                    ? "text-amber-700 dark:text-amber-300"
                    : "text-rose-700 dark:text-rose-400";
              const ext = item.extended_hours;

              return (
                <tr
                  key={`rk-${item.symbol}`}
                  onMouseEnter={() => onHoverSymbol(item.symbol)}
                  onMouseLeave={() => onHoverSymbol(null)}
                  onClick={() => onOpenStockDetail(item.symbol)}
                  className={`cursor-pointer transition-colors ${
                    isFocus
                      ? "bg-emerald-500/12 dark:bg-emerald-500/20"
                      : "hover:bg-zinc-100/80 dark:hover:bg-white/[0.05]"
                  }`}
                >
                  <td className="px-2.5 py-1.5 font-sans">
                    <div className="flex items-center gap-2">
                      <StockLogoBadge symbol={item.symbol} size={22} />
                      <div className="min-w-0">
                        <div className="font-mono text-xs font-bold text-zinc-950 dark:text-white">
                          {item.symbol}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="min-w-[140px] px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200/90 dark:bg-white/10">
                        <div
                          className={`h-full rounded-full ${ddTone}`}
                          style={{ width: `${barPct}%` }}
                        />
                      </div>
                      <span className={`w-12 text-right font-bold ${ddTextCls}`}>
                        {stats.maxDrawdownPct.toFixed(1)}%
                      </span>
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-right font-semibold text-zinc-800 dark:text-zinc-200">
                    {stats.annVolPct.toFixed(1)}%
                  </td>
                  <td className="px-2 py-1.5 text-right text-zinc-700 dark:text-zinc-300">
                    {stats.winRatePct.toFixed(0)}%
                  </td>
                  <td className="px-2.5 py-1.5 text-right">
                    {ext ? (
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${
                          (ext.change_pct ?? 0) >= 0
                            ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                            : "bg-rose-500/12 text-rose-700 dark:text-rose-300"
                        }`}
                      >
                        {ext.label_zh}{" "}
                        {ext.change_pct != null
                          ? `${ext.change_pct >= 0 ? "+" : ""}${ext.change_pct.toFixed(2)}%`
                          : `$${ext.price.toFixed(2)}`}
                      </span>
                    ) : (
                      <span className="text-[10.5px] text-zinc-400 dark:text-zinc-500">常规盘</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Compact Executive Footer */}
      {ranked.anchorRow && ranked.wildRow && (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 font-mono text-[10.5px] text-zinc-600 dark:text-zinc-400">
          <span className="inline-flex items-center gap-1">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            压舱石: <strong className="text-zinc-900 dark:text-zinc-100">{ranked.anchorRow.item.symbol}</strong>{" "}
            (回撤 {ranked.anchorRow.stats.maxDrawdownPct.toFixed(1)}%)
          </span>
          <span className="inline-flex items-center gap-1">
            <ShieldAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            高波动王: <strong className="text-zinc-900 dark:text-zinc-100">{ranked.wildRow.item.symbol}</strong>{" "}
            (年化波 {ranked.wildRow.stats.annVolPct.toFixed(1)}%)
          </span>
        </div>
      )}
    </SpotlightBlock>
  );
}

export default React.memo(WatchlistRiskRankingCard);

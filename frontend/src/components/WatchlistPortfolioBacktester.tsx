"use client";

import React, { useEffect, useId, useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Coins,
  ListChecks,
  Lock,
  RotateCcw,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  Unlock,
} from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import { proposeTradeBatch, type BatchTradeProposalResponse, type WatchlistAssetItem } from "@/lib/api";
import {
  evaluatePortfolio,
  sliceWindowDates,
  type SimWindow,
} from "@/lib/watchlistQuant";

interface WatchlistPortfolioBacktesterProps {
  items: WatchlistAssetItem[];
  palette: string[];
  spyCloses?: { date: string; close: number }[];
  externalPreset?: { symbols: string[]; label: string; version: number } | null;
  onOpenStockDetail: (symbol: string) => void;
  onNavigateToCopilot?: () => void;
}

type WeightStrategy = "equal" | "cap" | "inv_vol" | "sharpe" | "custom";

const PRINCIPAL_PRESETS = [1000, 10000, 50000, 100000] as const;

const VB_W = 940;
const VB_H = 265;
const PAD_L = 56;
const PAD_R = 20;
const PAD_T = 18;
const PAD_B = 28;

function WatchlistPortfolioBacktester({
  items,
  palette,
  spyCloses = [],
  externalPreset = null,
  onOpenStockDetail,
  onNavigateToCopilot,
}: WatchlistPortfolioBacktesterProps) {
  const uid = useId().replace(/:/g, "");
  const [win, setWin] = useState<SimWindow>("YTD");
  const [strategy, setStrategy] = useState<WeightStrategy>("equal");
  const [principalUsd, setPrincipalUsd] = useState<number>(10000);
  const [principalText, setPrincipalText] = useState<string>("10000");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [lockedSymbols, setLockedSymbols] = useState<Set<string>>(new Set());
  const [customSliders, setCustomSliders] = useState<Record<string, number>>({});
  const [showSliders, setShowSliders] = useState(false);
  const [showExecutionPlan, setShowExecutionPlan] = useState(true);
  const [presetBanner, setPresetBanner] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchTradeProposalResponse | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);

  useEffect(() => {
    setExcluded((prev) => {
      const validSyms = new Set(items.map((x) => x.symbol));
      const next = new Set(Array.from(prev).filter((s) => validSyms.has(s)));
      if (next.size >= items.length && items.length > 0) {
        next.delete(items[0].symbol);
      }
      return next;
    });
  }, [items]);

  // Apply external selection pushed from the 4-Quadrant Radar export button
  useEffect(() => {
    if (!externalPreset || externalPreset.symbols.length === 0) return;
    const keep = new Set(externalPreset.symbols);
    const nextExcl = new Set(items.map((i) => i.symbol).filter((s) => !keep.has(s)));
    if (nextExcl.size < items.length) {
      setExcluded(nextExcl);
      setPresetBanner(`已应用「${externalPreset.label}」筛选 (${items.length - nextExcl.size} 只)`);
    }
  }, [externalPreset, items]);

  // 1. Align dates, stock series, and SPY benchmark series cleanly
  const marketPrep = useMemo(() => {
    const longest = [...items].sort((a, b) => b.daily_closes.length - a.daily_closes.length)[0];
    const allDates = longest ? longest.daily_closes.map((pt) => pt.d) : [];
    const dates = sliceWindowDates(allDates, win);

    const alignedCloses: Record<string, (number | null)[]> = {};
    const stockStats: Record<string, { annVol: number; returnVolRatio: number }> = {};

    for (const item of items) {
      const map = new Map<string, number>();
      for (const pt of item.daily_closes) {
        map.set(pt.d, pt.c);
      }
      const arr: (number | null)[] = [];
      let lastKnown: number | null = null;
      for (const d of dates) {
        const hit = map.get(d);
        if (hit !== undefined) {
          lastKnown = hit;
          arr.push(hit);
        } else {
          arr.push(lastKnown);
        }
      }
      alignedCloses[item.symbol] = arr;

      const single = evaluatePortfolio(dates, { [item.symbol]: arr }, { [item.symbol]: 1 }, 10000);
      stockStats[item.symbol] = {
        annVol: single.annVolPct,
        returnVolRatio: single.returnVolRatio,
      };
    }

    // Align SPY benchmark over identical date axis
    const spyMap = new Map<string, number>();
    for (const pt of spyCloses) {
      spyMap.set(pt.date, pt.close);
    }
    const spyArr: (number | null)[] = [];
    let lastSpy: number | null = null;
    for (const d of dates) {
      const hit = spyMap.get(d);
      if (hit !== undefined) {
        lastSpy = hit;
        spyArr.push(hit);
      } else {
        spyArr.push(lastSpy);
      }
    }
    const hasSpy = spyArr.filter((v) => v !== null).length >= 3;

    return { dates, alignedCloses, stockStats, spyArr, hasSpy };
  }, [items, spyCloses, win]);

  // 2. Compute Normalized Active Weights (Honoring Per-Stock Weight Locks in Custom Mode)
  const { activeWeights, baselineWeights } = useMemo(() => {
    const base: Record<string, number> = {};
    const nAll = Math.max(1, items.length);
    for (const it of items) {
      base[it.symbol] = 1 / nAll;
    }

    const activeItems = items.filter((it) => !excluded.has(it.symbol));
    const safeActive = activeItems.length > 0 ? activeItems : items;
    const norm: Record<string, number> = {};
    for (const it of items) norm[it.symbol] = 0;

    if (strategy !== "custom") {
      const raw: Record<string, number> = {};
      if (strategy === "equal") {
        for (const it of safeActive) raw[it.symbol] = 1;
      } else if (strategy === "cap") {
        for (const it of safeActive) raw[it.symbol] = Math.max(0.5, it.market_cap_b ?? 8);
      } else if (strategy === "inv_vol") {
        for (const it of safeActive) {
          const vol = marketPrep.stockStats[it.symbol]?.annVol ?? 35;
          raw[it.symbol] = 1 / Math.max(10, vol);
        }
      } else if (strategy === "sharpe") {
        for (const it of safeActive) {
          const score = marketPrep.stockStats[it.symbol]?.returnVolRatio ?? 0;
          raw[it.symbol] = Math.max(0.15, score + 0.6);
        }
      }
      const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
      for (const it of safeActive) norm[it.symbol] = raw[it.symbol] / sum;
      return { activeWeights: norm, baselineWeights: base };
    }

    // Custom strategy with per-stock lock support
    const lockedActive = safeActive.filter((it) => lockedSymbols.has(it.symbol));
    const unlockedActive = safeActive.filter((it) => !lockedSymbols.has(it.symbol));

    let lockedFracSum = 0;
    const rawLocked: Record<string, number> = {};
    for (const it of lockedActive) {
      const f = Math.max(0, Math.min(100, customSliders[it.symbol] ?? 0)) / 100;
      rawLocked[it.symbol] = f;
      lockedFracSum += f;
    }
    const lockScale = lockedFracSum > 1 ? 1 / lockedFracSum : 1;
    for (const it of lockedActive) {
      norm[it.symbol] = rawLocked[it.symbol] * lockScale;
    }

    const remPool = Math.max(0, 1 - Math.min(1, lockedFracSum));
    if (unlockedActive.length > 0 && remPool > 0) {
      let unlSum = 0;
      for (const it of unlockedActive) {
        unlSum += Math.max(0, customSliders[it.symbol] ?? 50);
      }
      for (const it of unlockedActive) {
        const w = Math.max(0, customSliders[it.symbol] ?? 50);
        norm[it.symbol] = unlSum > 0 ? (w / unlSum) * remPool : remPool / unlockedActive.length;
      }
    } else if (unlockedActive.length === 0 && lockedFracSum > 0 && lockedFracSum < 1) {
      // Normalize if all active tickers are locked below 100%
      for (const it of lockedActive) {
        norm[it.symbol] = norm[it.symbol] / lockedFracSum;
      }
    }

    return { activeWeights: norm, baselineWeights: base };
  }, [customSliders, excluded, items, lockedSymbols, marketPrep.stockStats, strategy]);

  // 3. Evaluate Active, Equal-Weight Baseline, and SPY curves
  const sim = useMemo(() => {
    const { dates, alignedCloses, spyArr, hasSpy } = marketPrep;
    const safePrincipal = Math.max(100, principalUsd);
    const active = evaluatePortfolio(dates, alignedCloses, activeWeights, safePrincipal);
    const baseline = evaluatePortfolio(dates, alignedCloses, baselineWeights, safePrincipal);
    const spyStats = hasSpy
      ? evaluatePortfolio(dates, { SPY: spyArr }, { SPY: 1 }, safePrincipal)
      : null;

    const allPct = [
      ...active.pctSeries,
      ...baseline.pctSeries,
      ...(spyStats ? spyStats.pctSeries : []),
      0,
    ];
    const minP = Math.min(...allPct);
    const maxP = Math.max(...allPct);
    const padP = Math.max(2, (maxP - minP) * 0.14);
    const yMin = minP - padP;
    const yMax = maxP + padP;
    const ySpan = Math.max(1e-6, yMax - yMin);

    const plotW = VB_W - PAD_L - PAD_R;
    const plotH = VB_H - PAD_T - PAD_B;
    const count = Math.max(2, dates.length);
    const mapX = (i: number) => PAD_L + (i / (count - 1)) * plotW;
    const mapY = (pct: number) => PAD_T + ((yMax - pct) / ySpan) * plotH;

    const toPath = (series: number[]) =>
      series.map((p, i) => `${i === 0 ? "M" : "L"}${mapX(i).toFixed(1)},${mapY(p).toFixed(1)}`).join(" ");

    const activePath = toPath(active.pctSeries);
    const baselinePath = toPath(baseline.pctSeries);
    const spyPath = spyStats ? toPath(spyStats.pctSeries) : "";
    const zeroY = mapY(0);
    const areaPath =
      active.pctSeries.length >= 2
        ? `${activePath} L${mapX(active.pctSeries.length - 1).toFixed(1)},${zeroY.toFixed(1)} L${mapX(0).toFixed(1)},${zeroY.toFixed(1)} Z`
        : "";

    const hasDdBand =
      active.maxDrawdownPct < -1 &&
      active.troughIdx > active.peakIdx &&
      active.troughIdx < dates.length;
    const ddStartX = hasDdBand ? mapX(active.peakIdx) : 0;
    const ddEndX = hasDdBand ? mapX(active.troughIdx) : 0;

    const spyAlphaPct =
      spyStats !== null ? active.totalReturnPct - spyStats.totalReturnPct : null;

    return {
      dates,
      active,
      baseline,
      spyStats,
      spyAlphaPct,
      activePath,
      baselinePath,
      spyPath,
      areaPath,
      zeroY,
      hasDdBand,
      ddStartX,
      ddEndX,
      yTicks: [yMax, 0, yMin].map((v) => ({
        y: mapY(v),
        label: `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`,
        isZero: Math.abs(v) < 1e-6,
      })),
      mapX,
      mapY,
    };
  }, [activeWeights, baselineWeights, marketPrep, principalUsd]);

  const toggleInclude = (sym: string) => {
    setPresetBanner(null);
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(sym)) {
        next.delete(sym);
      } else if (items.length - next.size > 1) {
        next.add(sym);
      }
      return next;
    });
  };

  const toggleLock = (sym: string) => {
    setLockedSymbols((prev) => {
      const next = new Set(prev);
      if (next.has(sym)) {
        next.delete(sym);
      } else {
        if (strategy !== "custom") {
          const seeded: Record<string, number> = {};
          for (const it of items) {
            seeded[it.symbol] = Math.round((activeWeights[it.symbol] ?? 0) * 100);
          }
          setCustomSliders(seeded);
          setStrategy("custom");
        }
        next.add(sym);
      }
      return next;
    });
  };

  const handleSliderChange = (sym: string, val: number) => {
    setPresetBanner(null);
    if (strategy !== "custom") {
      const seeded: Record<string, number> = {};
      for (const it of items) {
        seeded[it.symbol] = Math.round((activeWeights[it.symbol] ?? 0) * 100);
      }
      seeded[sym] = val;
      setCustomSliders(seeded);
      setStrategy("custom");
    } else {
      setCustomSliders((prev) => ({ ...prev, [sym]: val }));
    }
    if (excluded.has(sym) && val > 0) {
      setExcluded((prev) => {
        const next = new Set(prev);
        next.delete(sym);
        return next;
      });
    }
  };

  const commitPrincipal = (raw: string) => {
    setPrincipalText(raw);
    const cleaned = Number(raw.replace(/[^0-9.]/g, ""));
    if (!Number.isNaN(cleaned) && cleaned >= 100) {
      setPrincipalUsd(Math.min(100_000_000, Math.round(cleaned)));
    }
  };

  const isCustomModified = strategy !== "equal" || excluded.size > 0;
  const isPos = sim.active.totalReturnPct >= 0;
  const ddImprovement = sim.active.maxDrawdownPct - sim.baseline.maxDrawdownPct;
  const activeCount = items.filter((i) => !excluded.has(i.symbol)).length;
  const hoverIdxSafe =
    hoverIdx !== null && hoverIdx >= 0 && hoverIdx < sim.dates.length ? hoverIdx : null;

  return (
    <SpotlightBlock tone="gallery" className="overflow-hidden p-4">
      {/* Header Row */}
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <span className="font-mono text-xs font-semibold tracking-wider text-zinc-800 dark:text-zinc-200">
            PORTFOLIO SIMULATOR PRO · 自选组合仓位推演仪
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-zinc-300/80 bg-white/85 p-0.5 font-mono text-[10.5px] dark:border-white/15 dark:bg-white/[0.05]">
          {(["1M", "3M", "6M", "YTD", "1Y"] as const).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWin(w)}
              className={`rounded-lg px-2 py-0.5 font-semibold transition ${
                win === w
                  ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                  : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
              }`}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      {/* Custom Principal Row */}
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-200/85 bg-white/75 px-2.5 py-1.5 font-mono text-[11px] dark:border-white/10 dark:bg-white/[0.03]">
        <div className="flex items-center gap-1.5">
          <Coins className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          <span className="font-sans font-semibold text-zinc-700 dark:text-zinc-300">
            模拟投入本金:
          </span>
          <div className="flex items-center rounded-lg border border-zinc-300/90 bg-white px-2 py-0.5 dark:border-white/15 dark:bg-zinc-900">
            <span className="mr-1 font-bold text-zinc-500">$</span>
            <input
              type="text"
              inputMode="numeric"
              aria-label="模拟投入本金金额"
              value={principalText}
              onChange={(e) => commitPrincipal(e.target.value)}
              className="w-20 bg-transparent font-mono text-xs font-bold text-zinc-950 focus:outline-none dark:text-white"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {PRINCIPAL_PRESETS.map((amt) => (
            <button
              key={amt}
              type="button"
              onClick={() => {
                setPrincipalUsd(amt);
                setPrincipalText(String(amt));
              }}
              className={`rounded-md px-2 py-0.5 text-[10.5px] font-semibold transition ${
                principalUsd === amt
                  ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                  : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-white/10 dark:text-zinc-300 dark:hover:bg-white/15"
              }`}
            >
              ${amt >= 1000 ? `${amt / 1000}K` : amt}
            </button>
          ))}
        </div>
      </div>

      {/* Allocation Strategy Pills */}
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
          {(
            [
              { id: "equal", label: "等权篮子" },
              { id: "cap", label: "市值加权" },
              { id: "inv_vol", label: "低波防御" },
              { id: "sharpe", label: "收益波动优选" },
              { id: "custom", label: "自定义" },
            ] as const
          ).map((st) => (
            <button
              key={st.id}
              type="button"
              onClick={() => {
                if (st.id === "custom") {
                  if (strategy !== "custom") {
                    const seeded: Record<string, number> = {};
                    for (const it of items) {
                      seeded[it.symbol] = Math.round((activeWeights[it.symbol] ?? 0) * 100);
                    }
                    setCustomSliders(seeded);
                  }
                  setShowSliders(true);
                }
                setPresetBanner(null);
                setStrategy(st.id);
              }}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold transition ${
                strategy === st.id
                  ? "border-emerald-600 bg-emerald-600 text-white dark:border-emerald-400 dark:bg-emerald-500 dark:text-zinc-950"
                  : "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-900 dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-200"
              }`}
            >
              {st.id === "inv_vol" && <ShieldCheck className="h-3 w-3" />}
              {st.id === "sharpe" && <Sparkles className="h-3 w-3" />}
              {st.label}
            </button>
          ))}

          <button
            type="button"
            onClick={() => setShowSliders((v) => !v)}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition ${
              showSliders
                ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
                : "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-900 dark:border-white/15 dark:bg-white/[0.05] dark:text-zinc-300"
            }`}
          >
            <SlidersHorizontal className="h-3 w-3" />
            调配权重
          </button>

          {isCustomModified && (
            <button
              type="button"
              onClick={() => {
                setStrategy("equal");
                setExcluded(new Set());
                setLockedSymbols(new Set());
                setPresetBanner(null);
              }}
              className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-amber-800 hover:bg-amber-500/20 dark:text-amber-300"
            >
              <RotateCcw className="h-3 w-3" />
              复原
            </button>
          )}
        </div>

        <span className="font-mono text-[10.5px] text-zinc-600 dark:text-zinc-400">
          {presetBanner || `${activeCount}/${items.length} 只入选`}
        </span>
      </div>

      {/* 4 Pro Quant KPI Cards (with SPY Alpha & Daily Win Rate) */}
      <div className="mb-2.5 grid grid-cols-2 gap-2 font-mono tabular-nums sm:grid-cols-4">
        <div className="rounded-xl border border-zinc-200/80 bg-white/80 px-2.5 py-1.5 dark:border-white/10 dark:bg-white/[0.04]">
          <div className="flex items-center justify-between font-sans text-[10px] text-zinc-600 dark:text-zinc-400">
            <span>推演净值 ({win})</span>
            {sim.spyAlphaPct !== null && (
              <span
                title="相对标普 500 (SPY) 同期的超额收益 Alpha"
                className={`font-mono text-[9.5px] font-bold ${
                  sim.spyAlphaPct >= 0
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-amber-700 dark:text-amber-300"
                }`}
              >
                α{sim.spyAlphaPct >= 0 ? "+" : ""}
                {sim.spyAlphaPct.toFixed(1)}%
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-baseline justify-between gap-1">
            <span className="text-sm font-bold text-zinc-950 dark:text-white">
              ${Math.round(sim.active.finalUsd).toLocaleString("en-US")}
            </span>
            <span
              className={`text-[11px] font-bold ${
                isPos
                  ? "text-emerald-700 dark:text-emerald-400"
                  : "text-rose-700 dark:text-rose-400"
              }`}
            >
              {isPos ? "+" : ""}
              {sim.active.totalReturnPct.toFixed(1)}%
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200/80 bg-white/80 px-2.5 py-1.5 dark:border-white/10 dark:bg-white/[0.04]">
          <div className="font-sans text-[10px] text-zinc-600 dark:text-zinc-400">
            区间最大回撤
          </div>
          <div className="mt-0.5 flex items-baseline justify-between gap-1">
            <span className="text-sm font-bold text-rose-700 dark:text-rose-400">
              {sim.active.maxDrawdownPct.toFixed(1)}%
            </span>
            {isCustomModified && Math.abs(ddImprovement) >= 0.2 && (
              <span
                className={`text-[10px] font-semibold ${
                  ddImprovement > 0
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                }`}
              >
                {ddImprovement > 0
                  ? `少跌${ddImprovement.toFixed(1)}%`
                  : `多跌${Math.abs(ddImprovement).toFixed(1)}%`}
              </span>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200/80 bg-white/80 px-2.5 py-1.5 dark:border-white/10 dark:bg-white/[0.04]">
          <div className="font-sans text-[10px] text-zinc-600 dark:text-zinc-400">
            年化波动 / 日胜率
          </div>
          <div className="mt-0.5 flex items-baseline justify-between gap-1">
            <span className="text-sm font-bold text-zinc-950 dark:text-white">
              {sim.active.annVolPct.toFixed(1)}%
            </span>
            <span className="text-[10.5px] text-zinc-600 dark:text-zinc-300">
              胜{sim.active.winRatePct.toFixed(0)}%
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200/80 bg-white/80 px-2.5 py-1.5 dark:border-white/10 dark:bg-white/[0.04]">
          <div className="font-sans text-[10px] text-zinc-600 dark:text-zinc-400">
            收益波动比 (vs SPY)
          </div>
          <div className="mt-0.5 flex items-baseline justify-between gap-1">
            <span
              className={`text-sm font-bold ${
                sim.active.returnVolRatio >= 0.8
                  ? "text-emerald-700 dark:text-emerald-400"
                  : sim.active.returnVolRatio < 0
                    ? "text-rose-700 dark:text-rose-400"
                    : "text-zinc-950 dark:text-white"
              }`}
            >
              {sim.active.returnVolRatio.toFixed(2)}
            </span>
            {sim.spyStats && (
              <span className="text-[10.5px] font-semibold text-amber-600 dark:text-amber-400">
                SPY {sim.spyStats.totalReturnPct >= 0 ? "+" : ""}
                {sim.spyStats.totalReturnPct.toFixed(1)}%
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Triple-Line Equity Curve + Red Max-Drawdown Window Shaded Band */}
      <div className="relative rounded-xl bg-zinc-50/70 p-2.5 dark:bg-white/[0.02]">
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="block h-auto w-full select-none overflow-visible"
          onMouseLeave={() => setHoverIdx(null)}
          onMouseMove={(e) => {
            if (sim.dates.length < 2) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const relX = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * VB_W;
            const plotW = VB_W - PAD_L - PAD_R;
            const ratio = Math.max(0, Math.min(1, (relX - PAD_L) / plotW));
            setHoverIdx(Math.round(ratio * (sim.dates.length - 1)));
          }}
        >
          <defs>
            <linearGradient id={`eq-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={isPos ? "#10b981" : "#e11d48"} stopOpacity="0.28" />
              <stop offset="100%" stopColor={isPos ? "#10b981" : "#e11d48"} stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {/* Max Drawdown Peak -> Trough Highlight Band */}
          {sim.hasDdBand && (
            <g>
              <rect
                x={sim.ddStartX}
                y={PAD_T}
                width={Math.max(4, sim.ddEndX - sim.ddStartX)}
                height={VB_H - PAD_T - PAD_B}
                fill="#e11d48"
                fillOpacity={0.08}
              />
              <circle
                cx={sim.ddStartX}
                cy={sim.mapY(sim.active.pctSeries[sim.active.peakIdx] ?? 0)}
                r={3.8}
                fill="#e11d48"
                fillOpacity={0.65}
              />
              <circle
                cx={sim.ddEndX}
                cy={sim.mapY(sim.active.pctSeries[sim.active.troughIdx] ?? 0)}
                r={4.5}
                fill="#e11d48"
                stroke="#ffffff"
                strokeWidth={1.3}
              />
            </g>
          )}

          {sim.yTicks.map((t, i) => (
            <g key={`bt-${i}`}>
              <line
                x1={PAD_L}
                y1={t.y}
                x2={VB_W - PAD_R}
                y2={t.y}
                className={
                  t.isZero
                    ? "stroke-zinc-400/75 dark:stroke-white/25"
                    : "stroke-zinc-200/80 dark:stroke-white/[0.06]"
                }
                strokeDasharray={t.isZero ? "4 3" : "2 4"}
                strokeWidth={t.isZero ? 1.2 : 0.9}
              />
              <text
                x={PAD_L - 8}
                y={t.y + 4}
                textAnchor="end"
                className="fill-zinc-500 font-mono text-[11px] dark:fill-zinc-400"
              >
                {t.label}
              </text>
            </g>
          ))}

          {sim.areaPath && <path d={sim.areaPath} fill={`url(#eq-${uid})`} />}

          {sim.baselinePath && (
            <path
              d={sim.baselinePath}
              fill="none"
              className="stroke-zinc-400/80 dark:stroke-zinc-500"
              strokeWidth={1.6}
              strokeDasharray="5 3.5"
            />
          )}

          {sim.spyPath && (
            <path
              d={sim.spyPath}
              fill="none"
              stroke="#d97706"
              strokeOpacity={0.88}
              strokeWidth={1.75}
              strokeDasharray="3 3"
            />
          )}

          {sim.activePath && (
            <path
              d={sim.activePath}
              fill="none"
              stroke={isPos ? "#10b981" : "#e11d48"}
              strokeWidth={2.7}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {hoverIdxSafe !== null && (
            <>
              <line
                x1={sim.mapX(hoverIdxSafe)}
                y1={PAD_T}
                x2={sim.mapX(hoverIdxSafe)}
                y2={VB_H - PAD_B}
                className="stroke-zinc-400 dark:stroke-zinc-500"
                strokeDasharray="3 3"
                strokeWidth={1.2}
              />
              <circle
                cx={sim.mapX(hoverIdxSafe)}
                cy={sim.mapY(sim.active.pctSeries[hoverIdxSafe] ?? 0)}
                r={5}
                fill={isPos ? "#10b981" : "#e11d48"}
                stroke="#ffffff"
                strokeWidth={1.6}
              />
            </>
          )}

          {sim.dates.length > 1 && (
            <>
              <text x={PAD_L} y={VB_H - 6} className="fill-zinc-500 font-mono text-[11px] dark:fill-zinc-400">
                {sim.dates[0]}
              </text>
              {sim.hasDdBand && (
                <text
                  x={Math.max(PAD_L + 155, Math.min(VB_W - PAD_R - 165, (sim.ddStartX + sim.ddEndX) / 2))}
                  y={VB_H - 6}
                  textAnchor="middle"
                  className="fill-rose-600 font-mono text-[10.5px] font-semibold dark:fill-rose-400"
                >
                  最深回撤 {sim.dates[sim.active.peakIdx]?.slice(5)}→{sim.dates[sim.active.troughIdx]?.slice(5)}
                </text>
              )}
              <text
                x={VB_W - PAD_R}
                y={VB_H - 6}
                textAnchor="end"
                className="fill-zinc-500 font-mono text-[11px] dark:fill-zinc-400"
              >
                {sim.dates[sim.dates.length - 1]}
              </text>
            </>
          )}
        </svg>

        {hoverIdxSafe !== null && (
          <div className="pointer-events-none absolute right-2 top-2 rounded-lg border border-zinc-200/90 bg-white/95 px-2.5 py-1.5 font-mono text-[10.5px] shadow dark:border-white/15 dark:bg-zinc-900/95">
            <div className="text-zinc-500 dark:text-zinc-400">{sim.dates[hoverIdxSafe]}</div>
            <div className="font-bold text-zinc-950 dark:text-white">
              推演: ${Math.round(sim.active.equity[hoverIdxSafe] ?? principalUsd).toLocaleString("en-US")} (
              {(sim.active.pctSeries[hoverIdxSafe] ?? 0) >= 0 ? "+" : ""}
              {(sim.active.pctSeries[hoverIdxSafe] ?? 0).toFixed(1)}%)
            </div>
            <div className="text-zinc-600 dark:text-zinc-300">
              等权: ${Math.round(sim.baseline.equity[hoverIdxSafe] ?? principalUsd).toLocaleString("en-US")} (
              {(sim.baseline.pctSeries[hoverIdxSafe] ?? 0) >= 0 ? "+" : ""}
              {(sim.baseline.pctSeries[hoverIdxSafe] ?? 0).toFixed(1)}%)
            </div>
            {sim.spyStats && (
              <div className="text-amber-700 dark:text-amber-300">
                SPY: ${Math.round(sim.spyStats.equity[hoverIdxSafe] ?? principalUsd).toLocaleString("en-US")} (
                {(sim.spyStats.pctSeries[hoverIdxSafe] ?? 0) >= 0 ? "+" : ""}
                {(sim.spyStats.pctSeries[hoverIdxSafe] ?? 0).toFixed(1)}%)
              </div>
            )}
          </div>
        )}
      </div>

      {/* Basket Toggle Chips */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {items.map((item, idx) => {
          const isExcluded = excluded.has(item.symbol);
          const isLocked = lockedSymbols.has(item.symbol);
          const pctW = Math.round((activeWeights[item.symbol] ?? 0) * 100);
          const dotColor = palette[idx % palette.length];
          return (
            <button
              key={`bt-chip-${item.symbol}`}
              type="button"
              onClick={() => toggleInclude(item.symbol)}
              title={isExcluded ? `纳入 ${item.symbol}` : `剔除 ${item.symbol} 测试回撤`}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10.5px] transition ${
                isExcluded
                  ? "border-zinc-300 bg-zinc-100/70 text-zinc-400 line-through dark:border-white/10 dark:bg-white/[0.02] dark:text-zinc-500"
                  : "border-zinc-300/90 bg-white text-zinc-900 hover:border-zinc-950 dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-100"
              }`}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: isExcluded ? "#a1a1aa" : dotColor }}
              />
              <span className="font-bold">{item.symbol}</span>
              {!isExcluded && (
                <span className="text-[10px] text-emerald-700 dark:text-emerald-400">
                  {pctW}%{isLocked ? "🔒" : ""}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Custom Weight Sliders with Per-Stock Weight Locks 🔒 */}
      {showSliders && (
        <div className="mt-2.5 grid grid-cols-1 gap-x-4 gap-y-1.5 rounded-xl border border-zinc-200/80 bg-zinc-50/80 p-2.5 sm:grid-cols-2 dark:border-white/10 dark:bg-white/[0.03]">
          {items.map((item) => {
            const isLocked = lockedSymbols.has(item.symbol);
            const wVal =
              strategy === "custom"
                ? (customSliders[item.symbol] ?? 0)
                : Math.round((activeWeights[item.symbol] ?? 0) * 100);
            const normPct = ((activeWeights[item.symbol] ?? 0) * 100).toFixed(1);
            return (
              <div key={`sl-${item.symbol}`} className="flex items-center gap-1.5 font-mono text-[11px]">
                <button
                  type="button"
                  onClick={() => toggleLock(item.symbol)}
                  title={isLocked ? "解锁该股比例" : "锁定该股权重比例"}
                  className={`rounded p-0.5 transition ${
                    isLocked
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                      : "text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200"
                  }`}
                >
                  {isLocked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  onClick={() => onOpenStockDetail(item.symbol)}
                  className="w-11 shrink-0 text-left font-bold text-zinc-900 hover:underline dark:text-zinc-100"
                >
                  {item.symbol}
                </button>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={wVal}
                  onChange={(e) => handleSliderChange(item.symbol, Number(e.target.value))}
                  className="h-1 flex-1 cursor-pointer accent-emerald-600 dark:accent-emerald-400"
                />
                <span className="w-10 shrink-0 text-right font-semibold text-zinc-700 dark:text-zinc-300">
                  {normPct}%
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Real-Money Execution Share Calculator Table */}
      <div className="mt-2.5 rounded-xl border border-zinc-200/80 bg-white/80 px-2.5 py-2 dark:border-white/10 dark:bg-white/[0.03]">
        <div className="mb-1.5 flex items-center justify-between font-mono text-[10.5px]">
          <button
            type="button"
            onClick={() => setShowExecutionPlan((v) => !v)}
            className="font-sans font-semibold text-zinc-800 hover:underline dark:text-zinc-200"
          >
            {showExecutionPlan ? "▾ " : "▸ "}实操股数折算参考 (按当前 ${principalUsd.toLocaleString("en-US")} 本金)
          </button>
          <span className="text-zinc-500 dark:text-zinc-400">
            <span className="text-zinc-500">--- 等权基准</span> ·{" "}
            <span className="text-amber-600 dark:text-amber-400">··· SPY大盘</span> ·{" "}
            <span className="text-rose-600 dark:text-rose-400">■ 红区最大回撤</span>
          </span>
        </div>

        {showExecutionPlan && (
          <div className="grid grid-cols-2 gap-1.5 font-mono text-[10.5px] sm:grid-cols-3">
            {items
              .filter((it) => (activeWeights[it.symbol] ?? 0) > 0.005)
              .sort((a, b) => (activeWeights[b.symbol] ?? 0) - (activeWeights[a.symbol] ?? 0))
              .map((it) => {
                const w = activeWeights[it.symbol] ?? 0;
                const allocUsd = principalUsd * w;
                const shares = it.price > 0 ? allocUsd / it.price : 0;
                return (
                  <button
                    key={`exec-${it.symbol}`}
                    type="button"
                    onClick={() => onOpenStockDetail(it.symbol)}
                    className="flex items-center justify-between rounded-lg bg-zinc-50 px-2 py-1 text-left transition hover:bg-zinc-100 dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
                  >
                    <span className="font-bold text-zinc-900 dark:text-zinc-100">{it.symbol}</span>
                    <span className="text-zinc-600 dark:text-zinc-300">
                      ${allocUsd >= 1000 ? `${(allocUsd / 1000).toFixed(1)}k` : Math.round(allocUsd)}{" "}
                      <strong className="text-emerald-700 dark:text-emerald-400">
                        ≈{shares >= 10 ? Math.round(shares) : shares.toFixed(1)}股
                      </strong>
                    </span>
                  </button>
                );
              })}
          </div>
        )}

        {/* Phase 3: One-Click Batch Enqueue into Risk Critic Pending Queue */}
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200/70 pt-2 dark:border-white/10">
          <div className="font-mono text-[10.5px] text-zinc-500 dark:text-zinc-400">
            按权重拆单至投研与风控台「待批断点」，每笔均经 Risk Critic 检验与 HITL 确认后才记账
          </div>
          <button
            type="button"
            disabled={batchBusy || items.every((it) => (activeWeights[it.symbol] ?? 0) <= 0.005 || it.price <= 0)}
            onClick={async () => {
              const strategyNames: Record<WeightStrategy, string> = {
                equal: "等权篮子",
                cap: "市值加权",
                inv_vol: "低波防御",
                sharpe: "收益波动优选",
                custom: "自定义权重",
              };
              const candidates = items
                .filter((it) => (activeWeights[it.symbol] ?? 0) > 0.005 && it.price > 0)
                .sort((a, b) => (activeWeights[b.symbol] ?? 0) - (activeWeights[a.symbol] ?? 0))
                .slice(0, 8)
                .map((it) => {
                  const w = activeWeights[it.symbol] ?? 0;
                  const qty = Math.max(1, Math.round((principalUsd * w) / it.price));
                  return {
                    symbol: it.symbol,
                    side: "buy" as const,
                    proposed_qty: qty,
                    entry_price: Number(it.price.toFixed(4)),
                    rationale: `[自选组合推演 · ${strategyNames[strategy]}] 目标权重 ${(w * 100).toFixed(1)}% · 本金 $${principalUsd.toLocaleString("en-US")} · 拟买入 ${qty} 股`,
                  };
                });
              if (candidates.length === 0) return;
              setBatchBusy(true);
              setBatchError(null);
              setBatchResult(null);
              try {
                const res = await proposeTradeBatch({
                  items: candidates,
                  risk_budget_pct: 1.0,
                  source_label: `自选组合仓位推演(${strategyNames[strategy]})`,
                });
                setBatchResult(res);
              } catch (err) {
                setBatchError(err instanceof Error ? err.message : "批量放入待审队列失败");
              } finally {
                setBatchBusy(false);
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-950 px-3 py-1 font-mono text-[11px] font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400"
          >
            <ListChecks className="h-3.5 w-3.5" />
            {batchBusy ? "正在拆单推演并挂起风控断点..." : "一键批量拆单至风控待审队列"}
          </button>
        </div>

        {batchError && (
          <div className="mt-2 rounded-lg border border-rose-500/35 bg-rose-500/10 px-2.5 py-1.5 font-mono text-[11px] text-rose-700 dark:text-rose-300">
            {batchError}
          </div>
        )}

        {batchResult && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-700 dark:text-emerald-300" />
              <span className="font-semibold text-emerald-900 dark:text-emerald-200">
                已将 {batchResult.queued_count} 笔建仓草案送入 Risk Critic 待审队列
                {batchResult.failed_count > 0 ? `（${batchResult.failed_count} 笔异常已跳过）` : ""}
              </span>
              <span className="font-mono text-[10px] text-emerald-800/80 dark:text-emerald-300/80">
                {batchResult.proposals
                  .filter((p) => p.verdict !== "ERROR")
                  .slice(0, 5)
                  .map((p) => `${p.symbol}×${p.recommended_qty ?? p.proposed_qty}(${p.verdict})`)
                  .join(" · ")}
              </span>
            </div>
            {onNavigateToCopilot && (
              <button
                type="button"
                onClick={onNavigateToCopilot}
                className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-2.5 py-1 font-mono text-[11px] font-semibold text-white transition hover:bg-emerald-600 dark:bg-emerald-400 dark:text-zinc-950 dark:hover:bg-emerald-300"
              >
                前往投研与风控台逐笔审批
                <ArrowRight className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Footer Note */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[10.5px] text-zinc-600 dark:text-zinc-400">
        <span className="inline-flex items-center gap-1">
          <TrendingUp className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          每日按权重再平衡仿真回测 · 锁仓 🔒 后调其余滑块自动配平 100%
        </span>
      </div>
    </SpotlightBlock>
  );
}

export default React.memo(WatchlistPortfolioBacktester);

"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { AlertTriangle, Building2, TrendingUp } from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import {
  InstitutionalContractFlow,
  InstitutionalFlowResponse,
} from "@/lib/api";

interface InstitutionalFlowModuleProps {
  data: InstitutionalFlowResponse | null;
  loading?: boolean;
  theme?: "light" | "dark";
}

const CONTRACT_ORDER = ["ES", "NQ", "ZN", "VX", "GC", "BTC"] as const;

function fmtContracts(val: number | null | undefined, signed = false): string {
  if (val == null || !Number.isFinite(val)) return "—";
  const prefix = signed && val > 0 ? "+" : val < 0 ? "-" : "";
  const abs = Math.abs(val);
  if (abs >= 1_000_000) return `${prefix}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${prefix}${(abs / 1_000).toFixed(1)}K`;
  return `${prefix}${abs.toFixed(0)}`;
}

function badgeTone(signal: string): string {
  if (signal === "squeeze_risk") {
    return "border-rose-500/45 bg-rose-500/15 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200";
  }
  if (signal === "aligned_long") {
    return "border-emerald-500/45 bg-emerald-500/15 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200";
  }
  if (signal === "fighting" || signal === "crowded_long") {
    return "border-amber-500/45 bg-amber-500/15 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200";
  }
  return "border-zinc-300 bg-zinc-200/80 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-200";
}

function InstitutionalFlowModule({
  data,
  loading = false,
  theme = "dark",
}: InstitutionalFlowModuleProps) {
  const isLight = theme === "light";
  const contractsMap = useMemo(() => data?.contracts ?? {}, [data]);
  const availableSymbols = useMemo(() => {
    const keys = Object.keys(contractsMap);
    const ordered = CONTRACT_ORDER.filter((sym) => keys.includes(sym));
    return ordered.length > 0 ? ordered : keys;
  }, [contractsMap]);

  const [activeKey, setActiveKey] = useState<string>("ES");
  const selectedKey = availableSymbols.includes(activeKey)
    ? activeKey
    : availableSymbols[0] ?? "ES";
  const activeContract: InstitutionalContractFlow | null =
    contractsMap[selectedKey] ?? null;

  const chartRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = chartRef.current;
    if (!el || !activeContract || activeContract.series_26w.length === 0) return;

    const chart = echarts.init(el);
    const pts = activeContract.series_26w;
    const dates = pts.map((p) => p.date.slice(5));
    const rmSeries = pts.map((p) => Math.round(p.real_money_net / 1000));
    const levSeries = pts.map((p) => Math.round(p.leveraged_net / 1000));

    const rmStroke = isLight ? "#059669" : "#10b981";
    const levStroke = isLight ? "#D97706" : "#f59e0b";

    chart.setOption({
      animationDuration: 400,
      grid: { top: 24, right: 12, bottom: 20, left: 46 },
      tooltip: {
        trigger: "axis",
        backgroundColor: isLight ? "#FFFFFF" : "rgba(9, 9, 11, 0.94)",
        borderColor: isLight ? "#E4E4E7" : "rgba(255,255,255,0.16)",
        textStyle: {
          color: isLight ? "#18181b" : "#f4f4f5",
          fontSize: 11,
          fontFamily: "monospace",
        },
        valueFormatter: (value: unknown) => {
          const num = Number(value);
          if (!Number.isFinite(num)) return "—";
          return `${num >= 0 ? "+" : ""}${num.toFixed(1)}K 手`;
        },
      },
      legend: {
        top: 0,
        right: 4,
        itemWidth: 10,
        itemHeight: 3,
        textStyle: { color: isLight ? "#3f3f46" : "#d4d4d8", fontSize: 10 },
        data: ["长线资管净仓", "对冲基金杠杆净仓"],
      },
      xAxis: {
        type: "category",
        data: dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: isLight ? "#d4d4d8" : "#3f3f46" } },
        axisLabel: { color: isLight ? "#52525b" : "#a1a1aa", fontSize: 9.5, interval: "auto" },
      },
      yAxis: {
        type: "value",
        scale: true,
        splitNumber: 3,
        axisLabel: {
          color: isLight ? "#52525b" : "#a1a1aa",
          fontSize: 9.5,
          formatter: (val: number) => `${val >= 0 ? "+" : ""}${val}K`,
        },
        splitLine: {
          lineStyle: { color: isLight ? "rgba(24,24,27,0.08)" : "rgba(255,255,255,0.06)" },
        },
      },
      series: [
        {
          name: "长线资管净仓",
          type: "line",
          smooth: 0.25,
          showSymbol: false,
          lineStyle: { width: 2.2, color: rmStroke },
          itemStyle: { color: rmStroke },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: isLight ? "rgba(5, 150, 105, 0.18)" : "rgba(16, 185, 129, 0.22)" },
              { offset: 1, color: "rgba(16, 185, 129, 0.0)" },
            ]),
          },
          data: rmSeries,
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: {
              type: "dashed",
              color: isLight ? "rgba(24,24,27,0.22)" : "rgba(255,255,255,0.2)",
            },
            data: [{ yAxis: 0 }],
            label: { show: false },
          },
        },
        {
          name: "对冲基金杠杆净仓",
          type: "line",
          smooth: 0.25,
          showSymbol: false,
          lineStyle: { width: 2.2, color: levStroke },
          itemStyle: { color: levStroke },
          data: levSeries,
        },
      ],
    });

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [activeContract, isLight]);

  const renderGroupCard = (
    group: InstitutionalContractFlow["real_money"] | InstitutionalContractFlow["leveraged"],
    variant: "real" | "lev"
  ) => {
    const totalGross = Math.max(group.long + group.short, 1);
    const longPct = Math.round((group.long / totalGross) * 100);
    const shortPct = 100 - longPct;
    const pct52 = group.percentile_52w;

    return (
      <div className="rounded-xl border border-zinc-200/90 bg-white/85 px-2.5 py-2 dark:border-zinc-800/90 dark:bg-zinc-950/75">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-sans text-[11px] font-semibold text-zinc-900 dark:text-zinc-200">
            {group.label}
          </span>
          {group.wow_change != null && (
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                group.wow_change >= 0
                  ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
                  : "bg-rose-500/15 text-rose-800 dark:text-rose-300"
              }`}
            >
              本周 {fmtContracts(group.wow_change, true)}
            </span>
          )}
        </div>

        <div className="mt-0.5 flex items-baseline justify-between gap-2">
          <span
            className={`font-mono text-base font-bold tabular-nums sm:text-lg ${
              group.net >= 0
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-rose-700 dark:text-rose-400"
            }`}
          >
            {fmtContracts(group.net, true)} 手
          </span>
          <span className="font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
            多空比 {group.long_short_ratio != null ? `${group.long_short_ratio.toFixed(2)}x` : "—"}
          </span>
        </div>

        {/* Bidirectional Long vs Short Bar */}
        <div className="mt-1.5">
          <div className="mb-0.5 flex justify-between font-mono text-[10px] text-zinc-700 dark:text-zinc-300">
            <span>多 {fmtContracts(group.long)} ({longPct}%)</span>
            <span>空 {fmtContracts(group.short)} ({shortPct}%)</span>
          </div>
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
            <div
              className="h-full bg-emerald-500/90"
              style={{ width: `${longPct}%` }}
            />
            <div
              className="h-full bg-rose-500/90"
              style={{ width: `${shortPct}%` }}
            />
          </div>
        </div>

        {/* 52W Extremes Bar */}
        <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
          <span>
            {variant === "lev" ? "52周杠杆极端分位" : "52周配置分位"}
          </span>
          <span className="font-semibold text-zinc-900 dark:text-zinc-200">
            {pct52 != null ? `${pct52.toFixed(0)}%` : "—"}
          </span>
        </div>
        <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div
            className={`h-full rounded-full ${
              pct52 == null
                ? "bg-zinc-400 dark:bg-zinc-600"
                : pct52 <= 18
                  ? "bg-rose-500"
                  : pct52 >= 82
                    ? "bg-emerald-500 dark:bg-emerald-400"
                    : "bg-amber-500 dark:bg-amber-400"
            }`}
            style={{ width: `${Math.max(4, pct52 ?? 50)}%` }}
          />
        </div>
      </div>
    );
  };

  return (
    <SpotlightBlock
      tone="obsidian"
      className="flex h-full flex-col justify-between gap-2 p-3 sm:p-3.5"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <span className="font-sans text-sm font-bold tracking-tight text-zinc-950 dark:text-white">
            华尔街聪明钱与杠杆透视
          </span>
          <span className="rounded-full border border-zinc-300/90 bg-white/85 px-2 py-0.5 font-mono text-[10px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-300">
            CFTC 资管 vs 对冲基金周报
          </span>
        </div>
        <span className="font-mono text-[10.5px] text-zinc-600 dark:text-zinc-400">
          {data?.report_date ? `报告日 ${data.report_date}` : "周更"}
        </span>
      </div>

      {/* Global Smart Money Takeaway */}
      {data?.summary_zh && (
        <div className="flex items-center gap-1.5 rounded-lg border border-amber-500/35 bg-amber-500/10 px-2.5 py-1 font-sans text-[11px] font-medium text-amber-900 dark:text-amber-200">
          <TrendingUp className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="truncate">{data.summary_zh}</span>
        </div>
      )}

      {/* Futures Selector Tabs */}
      <div className="flex flex-wrap gap-1.5 font-mono">
        {availableSymbols.map((sym) => {
          const row = contractsMap[sym];
          const active = sym === selectedKey;
          const squeeze = row?.crowded_signal === "squeeze_risk";
          return (
            <button
              key={sym}
              type="button"
              onClick={() => setActiveKey(sym)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-0.5 text-[11px] font-semibold transition ${
                active
                  ? "border-zinc-950 bg-zinc-950 text-white shadow-sm dark:border-white/50 dark:bg-white dark:text-zinc-950"
                  : "border-zinc-300/80 bg-white/80 text-zinc-700 hover:border-zinc-500 hover:text-zinc-950 dark:border-zinc-800 dark:bg-zinc-950/70 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:text-white"
              }`}
            >
              <span>{sym}</span>
              <span
                className={`font-sans text-[10px] ${
                  active
                    ? "text-zinc-300 dark:text-zinc-700"
                    : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                {row?.asset_bucket ?? ""}
              </span>
              {squeeze && (
                <span className="h-1.5 w-1.5 rounded-full bg-rose-500" title="空头极端拥挤 · 逼空警示" />
              )}
            </button>
          );
        })}
      </div>

      {activeContract ? (
        <>
          {/* Selected Contract Headline */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200/90 bg-white/80 px-2.5 py-1.5 dark:border-zinc-800/80 dark:bg-zinc-900/60">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-sans text-xs font-bold text-zinc-950 dark:text-white">
                  {activeContract.name_zh}
                </span>
                <span className="font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                  总持仓 OI {fmtContracts(activeContract.open_interest)}
                </span>
              </div>
              <p className="mt-0.5 truncate font-sans text-[10.5px] text-zinc-700 dark:text-zinc-300">
                {activeContract.headline_zh}
              </p>
            </div>
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-sans text-[10px] font-semibold ${badgeTone(
                activeContract.crowded_signal
              )}`}
            >
              {activeContract.crowded_signal === "squeeze_risk" && (
                <AlertTriangle className="h-3 w-3" />
              )}
              {activeContract.crowded_badge_zh}
            </span>
          </div>

          {/* Real Money vs Leveraged Funds Side-by-Side Breakdown */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {renderGroupCard(activeContract.real_money, "real")}
            {renderGroupCard(activeContract.leveraged, "lev")}
          </div>

          {/* 26-Week Scissors Chart — given generous height inside h:13 band */}
          <div className="flex min-h-[142px] flex-1 flex-col rounded-xl border border-zinc-200/90 bg-white/85 p-2 dark:border-zinc-800/80 dark:bg-zinc-950/60">
            <div className="mb-0.5 flex items-center justify-between px-1 font-sans text-[10px] text-zinc-600 dark:text-zinc-400">
              <span>近 26 周长短线资金多空走势（单位：千手）</span>
              <span className="font-mono text-[9.5px] text-zinc-500">
                周度 CFTC 官方更新
              </span>
            </div>
            <div ref={chartRef} className="min-h-[118px] w-full flex-1" />
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-zinc-200 bg-white/75 p-6 font-mono text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/50 dark:text-zinc-400">
          {loading ? "正在读取 CFTC 官方持仓细分..." : "暂无 CFTC 持仓细分数据"}
        </div>
      )}
    </SpotlightBlock>
  );
}

export default React.memo(InstitutionalFlowModule);

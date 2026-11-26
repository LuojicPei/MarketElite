"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { Activity, Flame, Link2, ShieldAlert } from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import {
  OptionsExpiryBucket,
  OptionsRadarResponse,
} from "@/lib/api";

interface OptionsRadarModuleProps {
  theme: "light" | "dark";
  data: OptionsRadarResponse | null;
  loading?: boolean;
  targetSymbol: string;
  followMainChart: boolean;
  mainSymbol: string;
  bucket: OptionsExpiryBucket;
  onSelectPresetSymbol: (sym: "SPY" | "QQQ" | "IWM") => void;
  onToggleFollowMain: () => void;
  onChangeBucket: (bucket: OptionsExpiryBucket) => void;
}

type OptionsChartTab = "gex" | "oi_vol" | "iv_skew";

function fmtBillions(val: number | null | undefined): string {
  if (val == null || !Number.isFinite(val)) return "—";
  const abs = Math.abs(val);
  const sign = val < 0 ? "-" : "+";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${(abs / 1e3).toFixed(0)}K`;
}

function fmtUsdCompact(val: number | null | undefined): string {
  if (val == null || !Number.isFinite(val)) return "—";
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(0)}K`;
  return `$${val.toFixed(0)}`;
}

function OptionsRadarModule({
  theme,
  data,
  loading = false,
  targetSymbol,
  followMainChart,
  mainSymbol,
  bucket,
  onSelectPresetSymbol,
  onToggleFollowMain,
  onChangeBucket,
}: OptionsRadarModuleProps) {
  const [chartTab, setChartTab] = useState<OptionsChartTab>("gex");
  const chartRef = useRef<HTMLDivElement | null>(null);
  const dark = theme === "dark";

  const profile = useMemo(() => data?.strike_profile ?? [], [data]);
  const spotPrice = data?.spot_price ?? 0;

  useEffect(() => {
    const el = chartRef.current;
    if (!el || profile.length === 0) return;

    const chart = echarts.init(el);
    const strikes = profile.map((r) => `$${r.strike.toFixed(0)}`);
    const axisLabelColor = dark ? "#a1a1aa" : "#52525b";
    const gridLineColor = dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";

    if (chartTab === "gex") {
      const callGexM = profile.map((r) => +(r.call_gex / 1e6).toFixed(2));
      const putGexM = profile.map((r) => +(r.put_gex / 1e6).toFixed(2));
      const netGexM = profile.map((r) => +(r.net_gex / 1e6).toFixed(2));

      chart.setOption({
        animationDuration: 350,
        grid: { top: 24, right: 14, bottom: 24, left: 52 },
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "shadow" },
          backgroundColor: "rgba(9, 9, 11, 0.94)",
          borderColor: "rgba(255,255,255,0.16)",
          textStyle: { color: "#f4f4f5", fontSize: 11, fontFamily: "monospace" },
        },
        legend: {
          top: 0,
          right: 6,
          itemWidth: 10,
          itemHeight: 8,
          textStyle: { color: axisLabelColor, fontSize: 10 },
          data: ["Call Gamma(买涨锚)", "Put Gamma(跌险)", "净 Net GEX"],
        },
        xAxis: {
          type: "category",
          data: strikes,
          axisLine: { lineStyle: { color: dark ? "#3f3f46" : "#d4d4d8" } },
          axisLabel: { color: axisLabelColor, fontSize: 9.5 },
        },
        yAxis: {
          type: "value",
          axisLabel: {
            color: axisLabelColor,
            fontSize: 9.5,
            formatter: (v: number) => `${v}M`,
          },
          splitLine: { lineStyle: { color: gridLineColor } },
        },
        series: [
          {
            name: "Call Gamma(买涨锚)",
            type: "bar",
            stack: "gex",
            itemStyle: { color: "#10b981", borderRadius: [3, 3, 0, 0] },
            data: callGexM,
          },
          {
            name: "Put Gamma(跌险)",
            type: "bar",
            stack: "gex",
            itemStyle: { color: "#e11d48", borderRadius: [0, 0, 3, 3] },
            data: putGexM,
          },
          {
            name: "净 Net GEX",
            type: "line",
            smooth: 0.2,
            symbolSize: 4,
            lineStyle: { width: 2, color: "#f59e0b" },
            itemStyle: { color: "#f59e0b" },
            data: netGexM,
          },
        ],
      });
    } else if (chartTab === "oi_vol") {
      const callOiK = profile.map((r) => +(r.call_oi / 1000).toFixed(1));
      const putOiK = profile.map((r) => +(-(r.put_oi / 1000)).toFixed(1));
      const totalVolK = profile.map((r) => +((r.call_vol + r.put_vol) / 1000).toFixed(1));

      chart.setOption({
        animationDuration: 350,
        grid: { top: 24, right: 42, bottom: 24, left: 48 },
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "shadow" },
          backgroundColor: "rgba(9, 9, 11, 0.94)",
          borderColor: "rgba(255,255,255,0.16)",
          textStyle: { color: "#f4f4f5", fontSize: 11, fontFamily: "monospace" },
        },
        legend: {
          top: 0,
          right: 6,
          itemWidth: 10,
          itemHeight: 8,
          textStyle: { color: axisLabelColor, fontSize: 10 },
          data: ["看涨 Call OI", "看跌 Put OI", "今日总成交量"],
        },
        xAxis: {
          type: "category",
          data: strikes,
          axisLabel: { color: axisLabelColor, fontSize: 9.5 },
        },
        yAxis: [
          {
            type: "value",
            axisLabel: {
              color: axisLabelColor,
              fontSize: 9.5,
              formatter: (v: number) => `${Math.abs(v)}K`,
            },
            splitLine: { lineStyle: { color: gridLineColor } },
          },
          {
            type: "value",
            axisLabel: {
              color: "#f59e0b",
              fontSize: 9.5,
              formatter: (v: number) => `${v}K`,
            },
            splitLine: { show: false },
          },
        ],
        series: [
          {
            name: "看涨 Call OI",
            type: "bar",
            stack: "oi",
            itemStyle: { color: "#10b981" },
            data: callOiK,
          },
          {
            name: "看跌 Put OI",
            type: "bar",
            stack: "oi",
            itemStyle: { color: "#f43f5e" },
            data: putOiK,
          },
          {
            name: "今日总成交量",
            type: "line",
            yAxisIndex: 1,
            smooth: 0.25,
            lineStyle: { width: 2, color: "#f59e0b" },
            itemStyle: { color: "#f59e0b" },
            data: totalVolK,
          },
        ],
      });
    } else {
      const putIvs = profile.map((r) => r.put_iv);
      const callIvs = profile.map((r) => r.call_iv);

      chart.setOption({
        animationDuration: 350,
        grid: { top: 24, right: 16, bottom: 24, left: 46 },
        tooltip: {
          trigger: "axis",
          backgroundColor: "rgba(9, 9, 11, 0.94)",
          borderColor: "rgba(255,255,255,0.16)",
          textStyle: { color: "#f4f4f5", fontSize: 11, fontFamily: "monospace" },
          valueFormatter: (v: unknown) => (v != null ? `${Number(v).toFixed(1)}% IV` : "—"),
        },
        legend: {
          top: 0,
          right: 6,
          itemWidth: 10,
          itemHeight: 3,
          textStyle: { color: axisLabelColor, fontSize: 10 },
          data: ["看跌 Put IV (下跌保险定价)", "看涨 Call IV (上涨彩票定价)"],
        },
        xAxis: {
          type: "category",
          data: strikes,
          axisLabel: { color: axisLabelColor, fontSize: 9.5 },
        },
        yAxis: {
          type: "value",
          scale: true,
          axisLabel: {
            color: axisLabelColor,
            fontSize: 9.5,
            formatter: (v: number) => `${v}%`,
          },
          splitLine: { lineStyle: { color: gridLineColor } },
        },
        series: [
          {
            name: "看跌 Put IV (下跌保险定价)",
            type: "line",
            connectNulls: true,
            smooth: 0.3,
            lineStyle: { width: 2.3, color: "#f43f5e" },
            itemStyle: { color: "#f43f5e" },
            data: putIvs,
          },
          {
            name: "看涨 Call IV (上涨彩票定价)",
            type: "line",
            connectNulls: true,
            smooth: 0.3,
            lineStyle: { width: 2.3, color: "#10b981" },
            itemStyle: { color: "#10b981" },
            data: callIvs,
          },
        ],
      });
    }

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [profile, chartTab, dark]);

  const bucketLabels: { id: OptionsExpiryBucket; label: string }[] = [
    { id: "all", label: "全周期" },
    { id: "0dte", label: "0-2DTE" },
    { id: "weekly", label: "本周五" },
    { id: "monthly", label: "月度主力" },
  ];

  const isPositiveGex = (data?.net_gex ?? 0) >= 0;
  const skew = data?.iv_skew_25d;

  return (
    <SpotlightBlock
      tone="gallery"
      className="flex h-full flex-col justify-between gap-2.5 p-3.5 sm:p-4"
    >
      {/* Top Bar: Title, Symbol Presets + Follow Main, Expiry Filter */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 font-sans text-sm font-bold tracking-tight text-zinc-950 dark:text-white">
            <Activity className="h-4 w-4 text-emerald-500" />
            <span>{targetSymbol} 期权全景雷达与异动扫单</span>
          </div>
          {spotPrice > 0 && (
            <span className="rounded-md bg-zinc-200/80 px-2 py-0.5 font-mono text-[11px] font-bold text-zinc-900 dark:bg-white/10 dark:text-white">
              现价 ${spotPrice.toFixed(2)}
            </span>
          )}
          {data?.status === "ok" && (
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-sans text-[10.5px] font-semibold ${
                isPositiveGex
                  ? "border-emerald-500/40 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                  : "border-rose-500/40 bg-rose-500/12 text-rose-700 dark:text-rose-300"
              }`}
            >
              {data.dealer_regime_zh}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Symbol Selector + Follow Main Switch */}
          <div className="flex items-center gap-1 rounded-full border border-zinc-300 bg-zinc-100 p-0.5 font-mono text-[11px] dark:border-white/20 dark:bg-white/[0.06]">
            {(["SPY", "QQQ", "IWM"] as const).map((sym) => {
              const active = !followMainChart && targetSymbol === sym;
              return (
                <button
                  key={sym}
                  type="button"
                  onClick={() => onSelectPresetSymbol(sym)}
                  className={`rounded-full px-2.5 py-0.5 font-semibold transition ${
                    active
                      ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                      : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-300"
                  }`}
                >
                  {sym}
                </button>
              );
            })}
            <button
              type="button"
              onClick={onToggleFollowMain}
              title="开启后，在上方搜索框、板块热力图或自选股切换个股时，此处自动联动查看该股期权链"
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-semibold transition ${
                followMainChart
                  ? "bg-emerald-600 text-white shadow-sm dark:bg-emerald-500 dark:text-zinc-950"
                  : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-300"
              }`}
            >
              <Link2 className="h-3 w-3" />
              <span>跟随主图({mainSymbol})</span>
            </button>
          </div>

          {/* Expiry Buckets */}
          <div className="flex items-center gap-1 rounded-full border border-zinc-300 bg-zinc-100 p-0.5 font-sans text-[11px] dark:border-white/20 dark:bg-white/[0.06]">
            {bucketLabels.map((b) => {
              const active = bucket === b.id;
              const cnt = data?.bucket_counts?.[b.id];
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => onChangeBucket(b.id)}
                  className={`rounded-full px-2.5 py-0.5 font-medium transition ${
                    active
                      ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                      : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-300"
                  }`}
                >
                  {b.label}
                  {cnt != null && cnt > 0 ? `(${cnt})` : ""}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Unsupported or Error State */}
      {data && data.status !== "ok" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-white/50 p-6 text-center dark:border-white/15 dark:bg-white/[0.03]">
          <ShieldAlert className="h-6 w-6 text-amber-500" />
          <div className="font-sans text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {data.reason || `${targetSymbol} 期权链暂未加载`}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onSelectPresetSymbol("SPY")}
              className="rounded-lg bg-zinc-950 px-3 py-1 font-mono text-xs font-semibold text-white dark:bg-white dark:text-zinc-950"
            >
              切回 SPY 期权雷达
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Battle Summary Line */}
          {data?.battle_summary_zh && (
            <div className="rounded-lg border border-zinc-200/90 bg-white/80 px-3 py-1.5 font-sans text-[11.5px] font-medium text-zinc-800 dark:border-white/10 dark:bg-white/[0.05] dark:text-zinc-200">
              实战定位：{data.battle_summary_zh}
              {data.anchor_expiry ? `（锚定到期日 ${data.anchor_expiry}）` : ""}
            </div>
          )}

          {/* 4 Quant Strategy Cards */}
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <div className="rounded-xl border border-zinc-200 bg-white/90 px-3 py-2 dark:border-white/15 dark:bg-white/[0.05]">
              <div className="font-sans text-[10.5px] text-zinc-600 dark:text-zinc-400">
                做市商净 Gamma (Net GEX)
              </div>
              <div
                className={`mt-0.5 font-mono text-base font-bold tabular-nums ${
                  isPositiveGex
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                }`}
              >
                {fmtBillions(data?.net_gex)}
              </div>
              <div className="truncate font-sans text-[10px] text-zinc-600 dark:text-zinc-300">
                {isPositiveGex ? "做市商高抛低吸 · 护盘减震" : "跌破易踩踏 · 涨破易逼空"}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white/90 px-3 py-2 dark:border-white/15 dark:bg-white/[0.05]">
              <div className="font-sans text-[10.5px] text-zinc-600 dark:text-zinc-400">
                关键防线 · 最大痛点 (Max Pain)
              </div>
              <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 font-mono text-sm font-bold tabular-nums">
                <span className="text-emerald-700 dark:text-emerald-400">
                  C墙 {data?.call_wall != null ? `$${data.call_wall.toFixed(0)}` : "—"}
                </span>
                <span className="text-rose-700 dark:text-rose-400">
                  P墙 {data?.put_wall != null ? `$${data.put_wall.toFixed(0)}` : "—"}
                </span>
                <span className="text-amber-700 dark:text-amber-300">
                  痛点 {data?.max_pain != null ? `$${data.max_pain.toFixed(0)}` : "—"}
                </span>
              </div>
              <div className="truncate font-mono text-[10px] text-zinc-600 dark:text-zinc-300">
                Zero γ 分水岭 {data?.zero_gamma != null ? `$${data.zero_gamma.toFixed(1)}` : "—"}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white/90 px-3 py-2 dark:border-white/15 dark:bg-white/[0.05]">
              <div className="font-sans text-[10.5px] text-zinc-600 dark:text-zinc-400">
                近期隐含预期波动 (Expected Move)
              </div>
              <div className="mt-0.5 flex items-baseline gap-1.5 font-mono text-base font-bold tabular-nums text-zinc-950 dark:text-white">
                <span>
                  {data?.expected_move_abs != null
                    ? `±$${data.expected_move_abs.toFixed(1)}`
                    : "—"}
                </span>
                {data?.expected_move_pct != null && (
                  <span className="text-xs font-semibold text-amber-600 dark:text-amber-300">
                    (±{data.expected_move_pct.toFixed(1)}%)
                  </span>
                )}
              </div>
              <div className="truncate font-mono text-[10px] text-zinc-600 dark:text-zinc-300">
                {data?.expected_low != null && data?.expected_high != null
                  ? `预期箱体 $${data.expected_low.toFixed(1)}–$${data.expected_high.toFixed(1)} · IV ${data.atm_iv_pct ?? "—"}%`
                  : "等待 ATM IV 定价"}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white/90 px-3 py-2 dark:border-white/15 dark:bg-white/[0.05]">
              <div className="font-sans text-[10.5px] text-zinc-600 dark:text-zinc-400">
                25Δ 偏斜 (Skew) & Put/Call 比
              </div>
              <div className="mt-0.5 flex items-baseline gap-2 font-mono text-base font-bold tabular-nums">
                <span
                  className={
                    skew == null
                      ? "text-zinc-500"
                      : skew >= 4
                        ? "text-rose-600 dark:text-rose-400"
                        : skew <= -2
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-zinc-950 dark:text-white"
                  }
                >
                  {skew != null ? `${skew >= 0 ? "+" : ""}${skew.toFixed(1)}%` : "—"}
                </span>
                <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                  OI P/C {data?.put_call_ratio != null ? data.put_call_ratio.toFixed(2) : "—"}
                </span>
              </div>
              <div className="truncate font-sans text-[10px] text-zinc-600 dark:text-zinc-300">
                {skew == null
                  ? `今日成交 P/C ${data?.put_call_vol_ratio?.toFixed(2) ?? "—"}`
                  : skew >= 4
                    ? `机构高溢价买跌保护 · 成交P/C ${data?.put_call_vol_ratio?.toFixed(2) ?? "—"}`
                    : `虚值定价均衡 · 成交P/C ${data?.put_call_vol_ratio?.toFixed(2) ?? "—"}`}
              </div>
            </div>
          </div>

          {/* Main Panoramic Workspace: Left 7 Cols 3-in-1 ECharts | Right 5 Cols Unusual Flow Radar */}
          <div className="grid min-h-[250px] flex-1 grid-cols-1 gap-3 lg:grid-cols-12">
            {/* Left 3-in-1 Interactive Chart */}
            <div className="flex min-h-[240px] flex-col rounded-xl border border-zinc-200 bg-white/80 p-2.5 dark:border-white/15 dark:bg-white/[0.04] lg:col-span-7">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1 rounded-lg bg-zinc-100 p-0.5 font-sans text-[11px] dark:bg-white/[0.06]">
                  {(
                    [
                      { id: "gex", label: "Gamma 墙分布" },
                      { id: "oi_vol", label: "OI 筹码 vs 今日成交" },
                      { id: "iv_skew", label: "IV 波动率微笑曲线" },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setChartTab(t.id)}
                      className={`rounded-md px-2.5 py-1 font-medium transition ${
                        chartTab === t.id
                          ? "bg-zinc-950 text-white shadow-sm dark:bg-white dark:text-zinc-950"
                          : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-300"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                  已扫合约 {data?.contracts_analyzed?.toLocaleString() ?? "—"} 张
                </span>
              </div>

              {loading && profile.length === 0 ? (
                <div className="flex flex-1 items-center justify-center font-mono text-xs text-zinc-500">
                  正在拉取 {targetSymbol} 全市场期权链 Greeks & OI...
                </div>
              ) : (
                <div ref={chartRef} className="min-h-[205px] w-full flex-1" />
              )}
            </div>

            {/* Right Unusual Options Sweeps / Flow Radar */}
            <div className="flex min-h-[240px] flex-col rounded-xl border border-zinc-200 bg-white/80 p-2.5 dark:border-white/15 dark:bg-white/[0.04] lg:col-span-5">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-sans text-xs font-bold text-zinc-950 dark:text-white">
                  <Flame className="h-3.5 w-3.5 text-amber-500" />
                  <span>异动爆量合约雷达 (Vol &gt; OI)</span>
                </div>
                <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                  今日新开大单优先
                </span>
              </div>

              <div className="min-h-0 flex-1 overflow-auto pr-1">
                <table className="w-full table-auto text-left font-mono text-[10.5px] tabular-nums">
                  <thead>
                    <tr className="border-b border-zinc-200 text-[10px] text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                      <th className="py-1 font-sans">合约 / 方向</th>
                      <th className="py-1 font-sans">到期</th>
                      <th className="py-1 text-right font-sans">成交 / OI</th>
                      <th className="py-1 pr-2 text-right font-sans">倍比/金额</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200/70 dark:divide-white/10">
                    {(data?.unusual_flow ?? []).length > 0 ? (
                      data!.unusual_flow.map((row) => {
                        const isCall = row.option_type === "call";
                        const hot = row.vol_oi_ratio >= 1.5;
                        return (
                          <tr
                            key={row.contract_symbol}
                            className="hover:bg-zinc-100/70 dark:hover:bg-white/[0.04]"
                          >
                            <td className="py-1.5 pr-1">
                              <div className="flex items-center gap-1">
                                <span
                                  className={`rounded px-1.5 py-0.5 text-[9.5px] font-bold uppercase ${
                                    isCall
                                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                                      : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                                  }`}
                                >
                                  {isCall ? "CALL" : "PUT"}
                                </span>
                                <span className="font-bold text-zinc-950 dark:text-white">
                                  ${row.strike.toFixed(row.strike % 1 === 0 ? 0 : 1)}
                                </span>
                              </div>
                            </td>
                            <td className="py-1.5 text-zinc-600 dark:text-zinc-300">
                              <span>{row.expiration_date ? row.expiration_date.slice(5) : "—"}</span>
                              <span className="ml-0.5 text-[9.5px] text-zinc-400">
                                ({row.dte}D)
                              </span>
                            </td>
                            <td className="py-1.5 text-right text-zinc-800 dark:text-zinc-200">
                              <span className="font-semibold">{row.volume.toLocaleString()}</span>
                              <span className="text-zinc-400">/{row.open_interest.toLocaleString()}</span>
                            </td>
                            <td className="py-1.5 pr-2 text-right">
                              <span
                                className={`font-bold ${
                                  hot
                                    ? "text-amber-600 dark:text-amber-300"
                                    : "text-zinc-700 dark:text-zinc-300"
                                }`}
                              >
                                {row.vol_oi_ratio.toFixed(1)}x
                              </span>
                              {row.est_premium_usd != null && (
                                <div className="text-[9.5px] text-zinc-500 dark:text-zinc-400">
                                  {fmtUsdCompact(row.est_premium_usd)}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td
                          colSpan={4}
                          className="py-8 text-center font-sans text-xs text-zinc-500 dark:text-zinc-400"
                        >
                          {loading ? "扫描异常期权成交..." : "盘前或当前到期池暂无显著爆量合约"}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </SpotlightBlock>
  );
}

export default React.memo(OptionsRadarModule);

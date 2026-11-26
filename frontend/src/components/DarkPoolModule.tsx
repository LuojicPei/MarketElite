"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { Layers, Link2, Search } from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import {
  BeginnerGuidePopover,
  ExpandPanelButton,
  MicrostructureExpandModal,
  SourceDisclosureFooter,
  getToneBannerClasses,
} from "@/components/MicrostructureShared";
import { DarkPoolProfileResponse } from "@/lib/api";

interface DarkPoolModuleProps {
  theme: "light" | "dark";
  data: DarkPoolProfileResponse | null;
  loading?: boolean;
  targetSymbol: string;
  followMainChart: boolean;
  mainSymbol: string;
  onToggleFollowMain: () => void;
  onSelectSymbol: (sym: string) => void;
}

type DarkPoolChartMode = "off_exchange" | "short_ratio";
const DARKPOOL_PRESETS = ["SPY", "QQQ", "NVDA", "AAPL", "TSLA"] as const;

const DARKPOOL_GUIDE_ITEMS = [
  {
    label: "① 暗池 / 场外（TRF/ATS）是啥？",
    text: "华尔街大机构买卖上千万美元股票时，为了不提前惊动公开盘口导致买贵/卖低，会在投行私下撮合池成交，收盘后才向 FINRA 上报。",
  },
  {
    label: "② 实战核心口诀怎么看？",
    text: "盯住“柱子（暗池活跃度）突然拔高”的几天，看后面白线股价怎么走：放量后跌不破、继续上行 = 机构托底吸筹；放量冲高回落破位 = 机构借利好派发！",
  },
  {
    label: "③ 避坑：做空成交比 ≠ 净空头！",
    text: "FINRA 每日 ShortVolume 包含大量做市商常规对冲买单，很多牛股常年在 45%–55%。别看绝对值高低，重点看它相对自己 20 日均值的 σ 偏离突变！",
  },
];

function fmtUsdShort(val: number | null | undefined): string {
  if (val == null || !Number.isFinite(val)) return "—";
  if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(1)}M`;
  if (val >= 1e3) return `$${(val / 1e3).toFixed(1)}K`;
  return `$${val.toFixed(0)}`;
}

function fmtUsdZh(val: number | null | undefined): string {
  if (val == null || !Number.isFinite(val)) return "—";
  if (val >= 1e8) return `$${(val / 1e8).toFixed(1)}亿`;
  if (val >= 1e4) return `$${(val / 1e4).toFixed(1)}万`;
  return `$${val.toFixed(0)}`;
}

function DarkPoolChartCanvas({
  series,
  avgValue,
  mode,
  dark,
  heightClass,
}: {
  series: DarkPoolProfileResponse["series_20d"];
  avgValue: number | null;
  mode: DarkPoolChartMode;
  dark: boolean;
  heightClass: string;
}) {
  const chartRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = chartRef.current;
    if (!el || series.length === 0) return;

    const chart = echarts.init(el);
    const labels = series.map((p) => p.label);
    const axisLabelColor = dark ? "#a1a1aa" : "#52525b";
    const gridLineColor = dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";

    const barValues = series.map((p) => {
      const val =
        mode === "off_exchange"
          ? p.off_exchange_pct ?? p.short_ratio_pct
          : p.short_ratio_pct;
      const isHot = avgValue != null && val >= avgValue + 3.0;
      const color =
        mode === "off_exchange"
          ? isHot
            ? "#8b5cf6"
            : dark
              ? "rgba(139, 92, 246, 0.45)"
              : "rgba(124, 58, 237, 0.42)"
          : isHot
            ? "#f59e0b"
            : dark
              ? "rgba(245, 158, 11, 0.48)"
              : "rgba(217, 119, 6, 0.45)";
      return {
        value: val,
        itemStyle: { color, borderRadius: [3, 3, 0, 0] },
      };
    });

    const priceValues = series.map((p) => p.close);

    chart.setOption({
      animationDuration: 320,
      grid: { top: 32, right: 50, bottom: 22, left: 42 },
      tooltip: {
        trigger: "axis",
        backgroundColor: "rgba(9, 9, 11, 0.94)",
        borderColor: "rgba(255,255,255,0.16)",
        textStyle: { color: "#f4f4f5", fontSize: 11, fontFamily: "sans-serif" },
        formatter: (params: unknown) => {
          const arr = Array.isArray(params) ? params : [];
          const idx = arr[0]?.dataIndex ?? 0;
          const pt = series[idx];
          if (!pt) return "";
          return [
            `<div style="font-weight:700;margin-bottom:3px;">${pt.date}</div>`,
            pt.close != null
              ? `<div>收盘价：<b style="color:#38bdf8">$${pt.close.toFixed(2)}</b></div>`
              : "",
            pt.off_exchange_pct != null
              ? `<div>场外暗池占比：<b style="color:#a78bfa">${pt.off_exchange_pct.toFixed(1)}%</b></div>`
              : "",
            `<div>场外做空成交占比：<b style="color:#fbbf24">${pt.short_ratio_pct.toFixed(1)}%</b></div>`,
            `<div style="color:#a1a1aa;margin-top:2px;">FINRA 场外成交 ${(pt.trf_total_volume / 1e6).toFixed(2)}M 股</div>`,
          ].join("");
        },
      },
      legend: {
        top: 0,
        right: 8,
        itemWidth: 10,
        itemHeight: 8,
        textStyle: { color: axisLabelColor, fontSize: 9.5 },
        data: [
          mode === "off_exchange" ? "场外暗池占比%" : "做空成交占比%",
          "收盘股价",
        ],
      },
      xAxis: {
        type: "category",
        data: labels,
        axisLine: { lineStyle: { color: dark ? "#3f3f46" : "#d4d4d8" } },
        axisLabel: { color: axisLabelColor, fontSize: 9.5 },
      },
      yAxis: [
        {
          type: "value",
          splitLine: { lineStyle: { color: gridLineColor } },
          axisLabel: { color: axisLabelColor, fontSize: 9.5, formatter: "{value}%" },
        },
        {
          type: "value",
          scale: true,
          splitLine: { show: false },
          axisLabel: {
            color: dark ? "#38bdf8" : "#0284c7",
            fontSize: 9.5,
            formatter: "${value}",
          },
        },
      ],
      series: [
        {
          name: mode === "off_exchange" ? "场外暗池占比%" : "做空成交占比%",
          type: "bar",
          yAxisIndex: 0,
          barMaxWidth: 18,
          data: barValues,
          markLine:
            avgValue != null
              ? {
                  symbol: "none",
                  silent: true,
                  lineStyle: {
                    color: mode === "off_exchange" ? "#a78bfa" : "#f59e0b",
                    type: "dashed",
                    width: 1.2,
                  },
                  label: {
                    show: true,
                    position: "insideEndTop",
                    distance: [0, 3],
                    formatter: `20日均 ${avgValue.toFixed(1)}%`,
                    fontSize: 9,
                    color: mode === "off_exchange" ? "#a78bfa" : "#d97706",
                    backgroundColor: dark
                      ? "rgba(9, 9, 11, 0.80)"
                      : "rgba(255, 255, 255, 0.88)",
                    padding: [2, 5],
                    borderRadius: 4,
                  },
                  data: [{ yAxis: avgValue }],
                }
              : undefined,
        },
        {
          name: "收盘股价",
          type: "line",
          yAxisIndex: 1,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: dark ? "#38bdf8" : "#0284c7", width: 2 },
          itemStyle: { color: dark ? "#38bdf8" : "#0284c7" },
          data: priceValues,
        },
      ],
    });

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [series, avgValue, mode, dark]);

  return <div ref={chartRef} className={`w-full ${heightClass}`} />;
}

export default function DarkPoolModule({
  theme,
  data,
  loading = false,
  targetSymbol,
  followMainChart,
  mainSymbol,
  onToggleFollowMain,
  onSelectSymbol,
}: DarkPoolModuleProps) {
  const [chartMode, setChartMode] = useState<DarkPoolChartMode>("off_exchange");
  const [searchText, setSearchText] = useState("");
  const [expanded, setExpanded] = useState(false);

  const dark = theme === "dark";
  const series = useMemo(() => data?.series_20d ?? [], [data]);
  const latest = data?.latest ?? null;
  const atsLatest = data?.ats_weekly?.latest ?? null;
  const atsWeeks = data?.ats_weekly?.weeks ?? [];
  const toneCls = getToneBannerClasses(data?.signal_tone);

  const handleMiniSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = searchText.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
    if (!cleaned) return;
    onSelectSymbol(cleaned);
    setSearchText("");
  };

  const avgLine =
    chartMode === "off_exchange"
      ? latest?.avg_off_exchange_20d ?? null
      : latest?.avg_short_ratio_20d ?? null;

  return (
    <SpotlightBlock
      tone="obsidian"
      className="flex h-full flex-col justify-between gap-2.5 p-3.5"
    >
      {/* Header + Mini Search + Sync Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Layers className="h-4 w-4 text-violet-600 dark:text-violet-400" />
          <span className="font-sans text-sm font-bold tracking-tight text-zinc-950 dark:text-white">
            暗池与场外机构成交
          </span>
          <span className="rounded-full border border-zinc-300/90 bg-white/85 px-2 py-0.5 font-mono text-[10px] font-medium text-zinc-700 dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-300">
            FINRA {targetSymbol}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {/* Independent Mini Ticker Search Box */}
          <form
            onSubmit={handleMiniSearchSubmit}
            className="me-grid-no-drag relative flex items-center"
          >
            <Search className="pointer-events-none absolute left-2 h-3 w-3 text-zinc-400" />
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="搜股票 如 PLTR"
              aria-label="搜索美股暗池代码"
              className="h-6 w-[128px] rounded-full border border-zinc-300/90 bg-white/90 pl-6 pr-2.5 font-mono text-[10.5px] uppercase text-zinc-900 placeholder:normal-case placeholder:text-zinc-400 focus:w-[146px] focus:border-violet-500 focus:outline-none dark:border-white/15 dark:bg-white/[0.07] dark:text-zinc-100 dark:placeholder:text-zinc-500"
            />
          </form>

          {/* Follow Main Chart Pill */}
          <button
            type="button"
            onClick={onToggleFollowMain}
            title="与上方主图 K 线当前美股代码联动"
            className={`me-grid-no-drag inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-sans text-[10.5px] font-semibold transition ${
              followMainChart
                ? "border-violet-500/50 bg-violet-500/15 text-violet-900 dark:border-violet-400/45 dark:bg-violet-500/20 dark:text-violet-200"
                : "border-zinc-300/90 bg-white/80 text-zinc-600 hover:text-zinc-950 dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-300 dark:hover:text-white"
            }`}
          >
            <Link2 className="h-3 w-3" />
            <span>跟随主图({mainSymbol})</span>
          </button>

          <ExpandPanelButton onClick={() => setExpanded(true)} />
          <BeginnerGuidePopover
            title="暗池与场外机构成交口诀"
            subtitle="FINRA Reg SHO TRF + ATS 周报"
            items={DARKPOOL_GUIDE_ITEMS}
          />
        </div>
      </div>

      {/* Presets + Chart Metric Switch */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="me-grid-no-drag flex flex-wrap items-center gap-1 font-mono text-[10px]">
          {DARKPOOL_PRESETS.map((sym) => {
            const active = !followMainChart && targetSymbol.toUpperCase() === sym;
            return (
              <button
                key={sym}
                type="button"
                onClick={() => onSelectSymbol(sym)}
                className={`rounded-md px-1.5 py-0.5 font-semibold transition ${
                  active
                    ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                    : "bg-zinc-200/70 text-zinc-700 hover:bg-zinc-300/80 dark:bg-white/[0.06] dark:text-zinc-300 dark:hover:bg-white/[0.12]"
                }`}
              >
                {sym}
              </button>
            );
          })}
        </div>

        <div className="me-grid-no-drag inline-flex items-center rounded-full border border-zinc-300/80 bg-white/80 p-0.5 font-sans text-[10px] dark:border-white/15 dark:bg-white/[0.06]">
          <button
            type="button"
            onClick={() => setChartMode("off_exchange")}
            className={`rounded-full px-2 py-0.5 font-semibold transition ${
              chartMode === "off_exchange"
                ? "bg-violet-600 text-white"
                : "text-zinc-600 dark:text-zinc-300"
            }`}
          >
            场外暗池占比%
          </button>
          <button
            type="button"
            onClick={() => setChartMode("short_ratio")}
            className={`rounded-full px-2 py-0.5 font-semibold transition ${
              chartMode === "short_ratio"
                ? "bg-amber-600 text-white"
                : "text-zinc-600 dark:text-zinc-300"
            }`}
          >
            做空成交比%
          </button>
        </div>
      </div>

      {/* Novice 1-line plain Chinese conclusion */}
      <div
        className={`flex items-start gap-2 rounded-xl border px-2.5 py-1.5 font-sans text-[11.5px] font-medium leading-snug ${toneCls.wrap}`}
      >
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${toneCls.dot}`} />
        <div className="min-w-0 flex-1">
          {data?.status === "unsupported"
            ? data.reason
            : data?.headline_zh ??
              (loading
                ? `正在拉取 ${targetSymbol} 近 20 日 FINRA TRF 暗池文件...`
                : "等待 FINRA 数据同步")}
        </div>
      </div>

      {/* 3 Core Capsules */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl bg-zinc-100/85 px-2.5 py-2 dark:bg-white/[0.05]">
          <div className="font-sans text-[10px] text-zinc-600 dark:text-zinc-400">
            场外暗池占比
          </div>
          <div className="mt-0.5 flex items-baseline gap-1 font-mono text-sm font-bold text-zinc-950 dark:text-white">
            <span>
              {latest?.off_exchange_pct != null
                ? `${latest.off_exchange_pct.toFixed(1)}%`
                : "—"}
            </span>
            {latest?.off_exchange_diff_pp != null && (
              <span
                className={`text-[10px] font-semibold ${
                  latest.off_exchange_diff_pp >= 2
                    ? "text-violet-600 dark:text-violet-300"
                    : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                {latest.off_exchange_diff_pp >= 0 ? "+" : ""}
                {latest.off_exchange_diff_pp.toFixed(1)}pct
              </span>
            )}
          </div>
        </div>

        <div className="rounded-xl bg-zinc-100/85 px-2.5 py-2 dark:bg-white/[0.05]">
          <div className="font-sans text-[10px] text-zinc-600 dark:text-zinc-400">
            做空成交偏离 (20日)
          </div>
          <div className="mt-0.5 flex items-baseline gap-1 font-mono text-sm font-bold text-zinc-950 dark:text-white">
            <span>{latest ? `${latest.short_ratio_pct.toFixed(1)}%` : "—"}</span>
            {latest && (
              <span
                className={`text-[10px] font-semibold ${
                  Math.abs(latest.short_ratio_z) >= 1.5
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                {latest.short_ratio_z >= 0 ? "+" : ""}
                {latest.short_ratio_z.toFixed(1)}σ
              </span>
            )}
          </div>
        </div>

        <div className="rounded-xl bg-zinc-100/85 px-2.5 py-2 dark:bg-white/[0.05]">
          <div className="font-sans text-[10px] text-zinc-600 dark:text-zinc-400">
            ATS 周均单笔体量
          </div>
          <div className="mt-0.5 font-mono text-sm font-bold text-zinc-950 dark:text-white">
            {fmtUsdZh(atsLatest?.avg_trade_usd)}
          </div>
          <div className="truncate font-mono text-[9.5px] text-zinc-500 dark:text-zinc-400">
            {atsLatest
              ? `${atsLatest.week_start_date.slice(5)}周 · 总${fmtUsdShort(atsLatest.total_notional_usd)}`
              : "ATS 周报暂无"}
          </div>
        </div>
      </div>

      {/* Main ECharts Canvas */}
      <div className="flex min-h-[165px] flex-1 flex-col rounded-xl bg-white/70 p-2 dark:bg-black/25">
        {loading && series.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center font-mono text-xs text-zinc-500 dark:text-zinc-400">
            正在解析 {targetSymbol} 近 20 日 FINRA 场外暗池成交...
          </div>
        ) : series.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center font-sans text-xs text-zinc-500 dark:text-zinc-400">
            {data?.reason ?? "暂无 FINRA TRF 场外暗池记录"}
          </div>
        ) : (
          <DarkPoolChartCanvas
            series={series}
            avgValue={avgLine}
            mode={chartMode}
            dark={dark}
            heightClass="min-h-0 flex-1"
          />
        )}
      </div>

      {/* Required Honest Small-Print Disclosure */}
      <SourceDisclosureFooter text={data?.methodology_note_zh} />

      {/* Fullscreen Detail Modal */}
      <MicrostructureExpandModal
        open={expanded}
        onClose={() => setExpanded(false)}
        title={`${targetSymbol} FINRA 暗池（TRF & ATS）全维明细`}
        subtitle={`最新日频截至 ${data?.latest_date ?? "—"} · 周度 ATS 统计周 ${atsLatest?.week_start_date ?? "—"}`}
      >
        <div className="space-y-4">
          <div className={`rounded-xl border px-3.5 py-2.5 text-xs font-medium ${toneCls.wrap}`}>
            {data?.headline_zh}
          </div>
          {series.length > 0 && (
            <div className="rounded-2xl bg-white/75 p-3 dark:bg-black/30">
              <DarkPoolChartCanvas
                series={series}
                avgValue={avgLine}
                mode={chartMode}
                dark={dark}
                heightClass="h-[280px]"
              />
            </div>
          )}

          {atsWeeks.length > 0 && (
            <div>
              <h4 className="mb-2 font-sans text-xs font-bold text-zinc-900 dark:text-zinc-100">
                FINRA OTCT 每周暗池（ATS）大单统计（存在约 2 周监管披露滞后）
              </h4>
              <div className="overflow-x-auto rounded-2xl border border-zinc-200/80 dark:border-white/[0.10]">
                <table className="w-full text-left font-mono text-[11px]">
                  <thead className="bg-zinc-100/80 text-zinc-600 dark:bg-white/[0.06] dark:text-zinc-300">
                    <tr>
                      <th className="px-3 py-2">统计周起</th>
                      <th className="px-3 py-2">总成交额</th>
                      <th className="px-3 py-2">总股数</th>
                      <th className="px-3 py-2">成交笔数</th>
                      <th className="px-3 py-2">单笔均额</th>
                      <th className="px-3 py-2">FINRA 发布日</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200/70 dark:divide-white/[0.08]">
                    {[...atsWeeks].reverse().map((w) => (
                      <tr key={w.week_start_date}>
                        <td className="px-3 py-1.5 font-semibold">{w.week_start_date}</td>
                        <td className="px-3 py-1.5">{fmtUsdShort(w.total_notional_usd)}</td>
                        <td className="px-3 py-1.5">{(w.total_shares / 1e6).toFixed(2)}M</td>
                        <td className="px-3 py-1.5">{w.total_trades?.toLocaleString() ?? "—"}</td>
                        <td className="px-3 py-1.5 font-bold text-violet-600 dark:text-violet-300">
                          {fmtUsdZh(w.avg_trade_usd)}
                        </td>
                        <td className="px-3 py-1.5 text-zinc-500">{w.last_update_date ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <SourceDisclosureFooter text={data?.methodology_note_zh} />
        </div>
      </MicrostructureExpandModal>
    </SpotlightBlock>
  );
}

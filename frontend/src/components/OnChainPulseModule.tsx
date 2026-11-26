"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { Coins, Flame, Gauge, Waves } from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import {
  BeginnerGuidePopover,
  ExpandPanelButton,
  MicrostructureExpandModal,
  SourceDisclosureFooter,
  getToneBannerClasses,
} from "@/components/MicrostructureShared";
import { BtcChainPoint, OnChainPulseResponse, PerpSeriesPoint, StablecoinSeriesPoint } from "@/lib/api";

interface OnChainPulseModuleProps {
  theme: "light" | "dark";
  data: OnChainPulseResponse | null;
  loading?: boolean;
}

const ONCHAIN_GUIDE_ITEMS = [
  {
    label: "① 这张卡为什么对美股也重要？",
    text: "加密资产与稳定币对全球美元流动性最敏感，常常领先纳指高弹性科技股（QQQ/SOXX）半步反应资金松紧。",
  },
  {
    label: "② 三大信号怎么一眼看懂？",
    text: "稳定币 7D/30D 增加 = 场外现金弹药变多；BTC 交易所大额净流出（绿柱向下） = 提币回冷钱包囤货；净流入飙升（红柱向上） = 充币准备卖。MVRV 越低越安全，>2.8 需警惕泡沫。",
  },
  {
    label: "③ 避坑：谨防合约高费率多杀多",
    text: "如果稳定币在流出，但永续资金费率却飙到 +0.03% 以上，说明不是机构真买，而是散户合约赌涨——极易突然插针爆仓！",
  },
];

function fmtB(val: number | null | undefined, signed = false): string {
  if (val == null || !Number.isFinite(val)) return "—";
  const prefix = signed && val > 0 ? "+" : "";
  return `${prefix}$${val.toFixed(2)}B`;
}

function fmtM(val: number | null | undefined, signed = false): string {
  if (val == null || !Number.isFinite(val)) return "—";
  const abs = Math.abs(val);
  const sign = signed && val > 0 ? "+" : val < 0 ? "-" : "";
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}B`;
  return `${sign}$${abs.toFixed(0)}M`;
}

function NetflowPriceChart({
  series,
  dark,
  heightClass,
}: {
  series: BtcChainPoint[];
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

    const bars = series.map((p) => {
      const nf = p.netflow_m ?? 0;
      // Inflow (+): potential sell pressure -> rose; Outflow (-): cold storage accumulation -> emerald
      const color = nf > 0 ? "#f43f5e" : "#10b981";
      return {
        value: p.netflow_m,
        itemStyle: { color, borderRadius: nf > 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] },
      };
    });

    chart.setOption({
      animationDuration: 320,
      grid: { top: 28, right: 54, bottom: 22, left: 48 },
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
          const nf = pt.netflow_m ?? 0;
          const nfDesc = nf > 0 ? "充入交易所（潜在抛压）" : "提回冷钱包（囤货锁仓）";
          return [
            `<div style="font-weight:700;margin-bottom:3px;">${pt.date}</div>`,
            pt.price_usd != null
              ? `<div>BTC 价格：<b style="color:#f59e0b">$${pt.price_usd.toLocaleString()}</b></div>`
              : "",
            pt.netflow_m != null
              ? `<div>交易所净流：<b style="color:${nf > 0 ? "#fb7185" : "#34d399"}">${fmtM(nf, true)}</b> · ${nfDesc}</div>`
              : "",
            pt.flow_in_m != null && pt.flow_out_m != null
              ? `<div style="color:#a1a1aa">转入 ${fmtM(pt.flow_in_m)} / 转出 ${fmtM(pt.flow_out_m)}</div>`
              : "",
            pt.mvrv != null
              ? `<div style="color:#a1a1aa">链上 MVRV：${pt.mvrv.toFixed(2)}</div>`
              : "",
          ].join("");
        },
      },
      legend: {
        top: 0,
        right: 8,
        itemWidth: 10,
        itemHeight: 8,
        textStyle: { color: axisLabelColor, fontSize: 9.5 },
        data: ["交易所净流($M: 红充/绿提)", "BTC价格($)"],
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
          axisLabel: { color: axisLabelColor, fontSize: 9.5, formatter: "{value}M" },
        },
        {
          type: "value",
          scale: true,
          splitLine: { show: false },
          axisLabel: {
            color: dark ? "#fbbf24" : "#d97706",
            fontSize: 9.5,
            formatter: (v: number) => `$${(v / 1000).toFixed(0)}k`,
          },
        },
      ],
      series: [
        {
          name: "交易所净流($M: 红充/绿提)",
          type: "bar",
          yAxisIndex: 0,
          barMaxWidth: 14,
          data: bars,
        },
        {
          name: "BTC价格($)",
          type: "line",
          yAxisIndex: 1,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: dark ? "#fbbf24" : "#d97706", width: 2 },
          itemStyle: { color: dark ? "#fbbf24" : "#d97706" },
          data: series.map((p) => p.price_usd),
        },
      ],
    });

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [series, dark]);

  return <div ref={chartRef} className={`w-full ${heightClass}`} />;
}

function StablecoinAndOiChart({
  stableSeries,
  perpSeries,
  dark,
  heightClass,
}: {
  stableSeries: StablecoinSeriesPoint[];
  perpSeries: PerpSeriesPoint[];
  dark: boolean;
  heightClass: string;
}) {
  const chartRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = chartRef.current;
    if (!el || (stableSeries.length === 0 && perpSeries.length === 0)) return;

    const chart = echarts.init(el);
    const axisLabelColor = dark ? "#a1a1aa" : "#52525b";
    const gridLineColor = dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";

    const perpByDate = new Map(perpSeries.map((p) => [p.date, p]));
    const dateAxis =
      stableSeries.length > 0
        ? stableSeries.map((s) => s.date)
        : perpSeries.map((p) => p.date);
    const labels = dateAxis.map((d) => d.slice(5));
    const stableByDate = new Map(stableSeries.map((s) => [s.date, s.total_b]));

    chart.setOption({
      animationDuration: 320,
      grid: { top: 28, right: 52, bottom: 22, left: 48 },
      tooltip: {
        trigger: "axis",
        backgroundColor: "rgba(9, 9, 11, 0.94)",
        borderColor: "rgba(255,255,255,0.16)",
        textStyle: { color: "#f4f4f5", fontSize: 11, fontFamily: "sans-serif" },
        formatter: (params: unknown) => {
          const arr = Array.isArray(params) ? params : [];
          const idx = arr[0]?.dataIndex ?? 0;
          const d = dateAxis[idx];
          if (!d) return "";
          const stVal = stableByDate.get(d);
          const pRow = perpByDate.get(d);
          return [
            `<div style="font-weight:700;margin-bottom:3px;">${d}</div>`,
            stVal != null
              ? `<div>全球稳定币总市值：<b style="color:#38bdf8">$${stVal.toFixed(2)}B</b></div>`
              : "",
            pRow?.oi_usd_b != null
              ? `<div>Binance 未平仓合约(OI)：<b style="color:#c084fc">$${pRow.oi_usd_b.toFixed(2)}B</b></div>`
              : "",
            pRow?.taker_buy_sell_ratio != null
              ? `<div style="color:#a1a1aa">主动吃单买卖比：${pRow.taker_buy_sell_ratio.toFixed(3)}</div>`
              : "",
          ].join("");
        },
      },
      legend: {
        top: 0,
        right: 8,
        itemWidth: 10,
        itemHeight: 4,
        textStyle: { color: axisLabelColor, fontSize: 9.5 },
        data: ["稳定币弹药池($B)", "永续持仓量OI($B)"],
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
          scale: true,
          splitLine: { lineStyle: { color: gridLineColor } },
          axisLabel: { color: axisLabelColor, fontSize: 9.5, formatter: "${value}B" },
        },
        {
          type: "value",
          scale: true,
          splitLine: { show: false },
          axisLabel: {
            color: dark ? "#c084fc" : "#9333ea",
            fontSize: 9.5,
            formatter: "${value}B",
          },
        },
      ],
      series: [
        {
          name: "稳定币弹药池($B)",
          type: "line",
          yAxisIndex: 0,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: dark ? "#38bdf8" : "#0284c7", width: 2.2 },
          areaStyle: {
            color: dark ? "rgba(56, 189, 248, 0.14)" : "rgba(2, 132, 199, 0.10)",
          },
          data: dateAxis.map((d) => stableByDate.get(d) ?? null),
        },
        {
          name: "永续持仓量OI($B)",
          type: "line",
          yAxisIndex: 1,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: dark ? "#c084fc" : "#9333ea", width: 1.8, type: "dashed" },
          data: dateAxis.map((d) => perpByDate.get(d)?.oi_usd_b ?? null),
        },
      ],
    });

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [stableSeries, perpSeries, dark]);

  return <div ref={chartRef} className={`w-full ${heightClass}`} />;
}

export default function OnChainPulseModule({
  theme,
  data,
  loading = false,
}: OnChainPulseModuleProps) {
  const [expanded, setExpanded] = useState(false);
  const dark = theme === "dark";

  const stable = data?.stablecoins ?? null;
  const btc = data?.btc_chain ?? null;
  const perp = data?.perp ?? null;
  const btcLatest = btc?.latest ?? null;
  const mvrvVal = btcLatest?.mvrv ?? null;
  const mvrvMeta = btc?.mvrv_meta;
  const toneCls = getToneBannerClasses(data?.signal_tone);

  const stableSeries = useMemo(() => stable?.series_35d ?? [], [stable]);
  const btcSeries = useMemo(() => btc?.series_35d ?? [], [btc]);
  const perpSeries = useMemo(() => perp?.series_30d ?? [], [perp]);

  // Map MVRV (typically 0.6 .. 3.6) cleanly onto 0..100% slider
  const mvrvBarPct =
    mvrvVal != null
      ? Math.min(98, Math.max(4, ((mvrvVal - 0.5) / 3.0) * 100))
      : 45;

  const netflowLatest = btcLatest?.netflow_m ?? null;

  return (
    <SpotlightBlock
      tone="obsidian"
      className="flex h-full flex-col justify-between gap-2.5 p-3.5"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Waves className="h-4 w-4 text-sky-600 dark:text-sky-400" />
          <span className="font-sans text-sm font-bold tracking-tight text-zinc-950 dark:text-white">
            链上活水与加密聪明钱全维脉搏
          </span>
          <span className="rounded-full border border-zinc-300/90 bg-white/85 px-2 py-0.5 font-mono text-[10px] font-medium text-zinc-700 dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-300">
            稳定币弹药 · 交易所充提 · MVRV · 永续杠杆
          </span>
          {data?.status === "partial" && (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-800 dark:text-amber-300">
              部分源降级
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {btcLatest?.active_addresses != null && (
            <span className="hidden font-mono text-[10px] text-zinc-500 dark:text-zinc-400 md:inline">
              链上日活 {(btcLatest.active_addresses / 10000).toFixed(1)}万地址 · {btcLatest.date}
            </span>
          )}
          <ExpandPanelButton onClick={() => setExpanded(true)} />
          <BeginnerGuidePopover
            title="链上活水与聪明钱实战口诀"
            subtitle="DefiLlama + CoinMetrics + Binance Futures"
            items={ONCHAIN_GUIDE_ITEMS}
          />
        </div>
      </div>

      {/* Novice 1-line 4D synthesis */}
      <div
        className={`flex items-start gap-2 rounded-xl border px-3 py-1.5 font-sans text-[11.5px] font-medium leading-snug ${toneCls.wrap}`}
      >
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${toneCls.dot}`} />
        <div className="min-w-0 flex-1">
          {data?.headline_zh ??
            (loading
              ? "正在同步 DefiLlama 稳定币、CoinMetrics 链上充提与 Binance 永续费率..."
              : "链上数据等待同步")}
        </div>
      </div>

      {/* 4 Newbie-Friendly Metric Meters */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {/* 1. Stablecoin Dry Powder */}
        <div className="rounded-xl bg-zinc-100/85 px-3 py-2 dark:bg-white/[0.05]">
          <div className="flex items-center justify-between font-sans text-[10.5px] text-zinc-600 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1">
              <Coins className="h-3.5 w-3.5 text-sky-500" />
              场外买盘弹药（稳定币）
            </span>
            <span className="font-mono text-[10px]">
              30D {fmtB(stable?.delta_30d_b, true)}
            </span>
          </div>
          <div className="mt-1 flex items-baseline gap-2 font-mono">
            <span className="text-base font-bold text-zinc-950 dark:text-white">
              {fmtB(stable?.total_circulating_b)}
            </span>
            <span
              className={`text-xs font-semibold ${
                (stable?.delta_7d_b ?? 0) >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400"
              }`}
            >
              7日 {fmtB(stable?.delta_7d_b, true)}
            </span>
          </div>
        </div>

        {/* 2. BTC Exchange Netflow */}
        <div className="rounded-xl bg-zinc-100/85 px-3 py-2 dark:bg-white/[0.05]">
          <div className="flex items-center justify-between font-sans text-[10.5px] text-zinc-600 dark:text-zinc-400">
            <span>BTC 交易所充提净流</span>
            <span className="font-mono text-[10px]">
              7D {fmtM(btc?.netflow_7d_m, true)}
            </span>
          </div>
          <div className="mt-1 flex items-baseline gap-2 font-mono">
            <span
              className={`text-base font-bold ${
                netflowLatest == null
                  ? "text-zinc-900 dark:text-zinc-100"
                  : netflowLatest > 0
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-emerald-600 dark:text-emerald-400"
              }`}
            >
              {fmtM(netflowLatest, true)}
            </span>
            <span className="font-sans text-[10.5px] font-medium text-zinc-600 dark:text-zinc-300">
              {netflowLatest == null
                ? "—"
                : netflowLatest > 0
                  ? "充入交易所（备卖）"
                  : "提回冷钱包（囤货）"}
            </span>
          </div>
        </div>

        {/* 3. MVRV Bubble Meter */}
        <div className="rounded-xl bg-zinc-100/85 px-3 py-2 dark:bg-white/[0.05]">
          <div className="flex items-center justify-between font-sans text-[10.5px] text-zinc-600 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1">
              <Gauge className="h-3.5 w-3.5 text-emerald-500" />
              持币浮盈分位（MVRV）
            </span>
            <span className="font-mono text-[10px]">
              {mvrvMeta?.label_zh ?? "—"}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="font-mono text-base font-bold text-zinc-950 dark:text-white">
              {mvrvVal != null ? mvrvVal.toFixed(2) : "—"}
            </span>
            <div className="flex-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-300/80 dark:bg-zinc-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-sky-500 to-rose-500 transition-all duration-300"
                  style={{ width: `${mvrvBarPct}%` }}
                />
              </div>
              <div className="mt-0.5 flex justify-between font-mono text-[8.5px] text-zinc-500 dark:text-zinc-400">
                <span>&lt;1.0深坑</span>
                <span>1.8温和</span>
                <span>&gt;2.8泡沫</span>
              </div>
            </div>
          </div>
        </div>

        {/* 4. Binance Perp Leverage */}
        <div className="rounded-xl bg-zinc-100/85 px-3 py-2 dark:bg-white/[0.05]">
          <div className="flex items-center justify-between font-sans text-[10.5px] text-zinc-600 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1">
              <Flame className="h-3.5 w-3.5 text-amber-500" />
              永续杠杆温度（BTCUSDT）
            </span>
            <span className="font-mono text-[10px]">
              {perp?.leverage_label_zh ?? "—"}
            </span>
          </div>
          <div className="mt-1 flex items-baseline gap-2 font-mono">
            <span className="text-base font-bold text-zinc-950 dark:text-white">
              {perp?.funding_rate_pct != null
                ? `${perp.funding_rate_pct >= 0 ? "+" : ""}${perp.funding_rate_pct.toFixed(4)}%`
                : "—"}
            </span>
            <span className="text-[10.5px] text-zinc-600 dark:text-zinc-300">
              OI {fmtB(perp?.open_interest_usd_b)}
              {perp?.top_trader_long_pct != null
                ? ` · 大户多${perp.top_trader_long_pct.toFixed(0)}%`
                : ""}
            </span>
          </div>
        </div>
      </div>

      {/* Side-by-Side Twin 30D Charts (Full w:12 Showcase Advantage!) */}
      <div className="grid min-h-[195px] flex-1 grid-cols-1 gap-2.5 lg:grid-cols-2">
        <div className="flex min-h-0 flex-col rounded-xl bg-white/70 p-2 dark:bg-black/25">
          <div className="mb-1 flex shrink-0 items-center justify-between px-1">
            <span className="font-sans text-[11px] font-bold text-zinc-800 dark:text-zinc-200">
              近35日 BTC 交易所充提净流 vs 币价（绿柱=提币囤货 · 红柱=充币备卖）
            </span>
            <span className="font-mono text-[9.5px] text-zinc-500 dark:text-zinc-400">
              存量 {btcLatest?.exchange_reserve_btc != null ? `${(btcLatest.exchange_reserve_btc / 1e4).toFixed(1)}万枚` : "—"}
            </span>
          </div>
          {btcSeries.length > 0 ? (
            <NetflowPriceChart series={btcSeries} dark={dark} heightClass="min-h-0 flex-1" />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center font-mono text-xs text-zinc-500">
              {loading ? "正在加载链上充提净流..." : "CoinMetrics 数据暂未返回"}
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-col rounded-xl bg-white/70 p-2 dark:bg-black/25">
          <div className="mb-1 flex shrink-0 items-center justify-between px-1">
            <span className="font-sans text-[11px] font-bold text-zinc-800 dark:text-zinc-200">
              近35日全球稳定币买盘弹药 vs Binance 永续持仓量（OI）
            </span>
            <span className="font-mono text-[9.5px] text-zinc-500 dark:text-zinc-400">
              吃单买卖比 {perp?.taker_buy_sell_ratio != null ? perp.taker_buy_sell_ratio.toFixed(2) : "—"}
            </span>
          </div>
          {stableSeries.length > 0 || perpSeries.length > 0 ? (
            <StablecoinAndOiChart
              stableSeries={stableSeries}
              perpSeries={perpSeries}
              dark={dark}
              heightClass="min-h-0 flex-1"
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center font-mono text-xs text-zinc-500">
              {loading ? "正在加载稳定币与持仓走势..." : "稳定币 / 合约 OI 数据暂未返回"}
            </div>
          )}
        </div>
      </div>

      {/* Required Honest Small-Print Disclosure */}
      <SourceDisclosureFooter text={data?.methodology_note_zh} />

      {/* Expanded Workbench Modal */}
      <MicrostructureExpandModal
        open={expanded}
        onClose={() => setExpanded(false)}
        title="链上活水与加密聪明钱 · 全景解析"
        subtitle={mvrvMeta ? `MVRV 提示：${mvrvMeta.hint_zh}` : undefined}
      >
        <div className="space-y-4">
          <div className={`rounded-xl border px-3.5 py-2.5 text-xs font-medium ${toneCls.wrap}`}>
            {data?.headline_zh}
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="rounded-2xl bg-white/75 p-3 dark:bg-black/30">
              <NetflowPriceChart series={btcSeries} dark={dark} heightClass="h-[260px]" />
            </div>
            <div className="rounded-2xl bg-white/75 p-3 dark:bg-black/30">
              <StablecoinAndOiChart
                stableSeries={stableSeries}
                perpSeries={perpSeries}
                dark={dark}
                heightClass="h-[260px]"
              />
            </div>
          </div>

          {stable?.breakdown && stable.breakdown.length > 0 && (
            <div>
              <h4 className="mb-2 font-sans text-xs font-bold text-zinc-900 dark:text-zinc-100">
                主流美元稳定币分布（DefiLlama 实时汇总）
              </h4>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {stable.breakdown.map((coin) => (
                  <div
                    key={coin.symbol}
                    className="rounded-xl border border-zinc-200/80 bg-white/80 p-2.5 font-mono dark:border-white/[0.10] dark:bg-white/[0.05]"
                  >
                    <div className="flex items-center justify-between text-xs font-bold text-zinc-900 dark:text-white">
                      <span>{coin.symbol}</span>
                      <span className="text-[10px] font-normal text-zinc-500">
                        {coin.name}
                      </span>
                    </div>
                    <div className="mt-1 text-sm font-bold text-zinc-950 dark:text-zinc-100">
                      {fmtB(coin.circulating_b)}
                    </div>
                    <div className="mt-0.5 text-[10px] text-zinc-600 dark:text-zinc-400">
                      7日{" "}
                      <span
                        className={
                          coin.delta_7d_b >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-rose-600 dark:text-rose-400"
                        }
                      >
                        {fmtB(coin.delta_7d_b, true)}
                      </span>{" "}
                      · 30日 {fmtB(coin.delta_30d_b, true)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <SourceDisclosureFooter text={data?.methodology_note_zh} />
        </div>
      </MicrostructureExpandModal>
    </SpotlightBlock>
  );
}

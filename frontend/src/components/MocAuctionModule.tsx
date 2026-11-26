"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { Clock3, Flame } from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import {
  BeginnerGuidePopover,
  ExpandPanelButton,
  MicrostructureExpandModal,
  SourceDisclosureFooter,
  getToneBannerClasses,
} from "@/components/MicrostructureShared";
import { MocAuctionResponse } from "@/lib/api";

interface MocAuctionModuleProps {
  theme: "light" | "dark";
  data: MocAuctionResponse | null;
  loading?: boolean;
  targetSymbol: string;
  onSelectSymbol: (sym: string) => void;
}

const MOC_PRESETS = ["SPY", "QQQ", "IWM", "SOXX"] as const;

const MOC_GUIDE_ITEMS = [
  {
    label: "① 这是在测谁的钱？",
    text: "盯紧美东 15:45–16:00 最后 15 分钟。被动指数 ETF、养老金再平衡、MSCI/罗素调仓资金必须在收盘按官方价强行成交，最容易在这 15 分钟集中放量。",
  },
  {
    label: "② 怎么用来辅助交易？",
    text: "当尾盘占比突然冲上均值的 1.5 倍以上且叠加月末/季末窗口时，切忌在末尾 10 分钟逆势硬扛；纯粹由调仓引发的尾盘极速拉伸或砸盘，次日早盘常出现回补缺口。",
  },
  {
    label: "③ 新手最容易踩的坑",
    text: "交易所官方 15:50 实时挂单净差额（NOI/NOII）属收费专线，本站拿不到原值；这里的指标是用分钟线实际成交量算出的放量冲击估算，别把它当成盘口未成交挂单预测！",
  },
];

function fmtShares(val: number | null | undefined): string {
  if (val == null || !Number.isFinite(val)) return "—";
  if (val >= 1e8) return `${(val / 1e8).toFixed(2)}亿股`;
  if (val >= 1e4) return `${(val / 1e4).toFixed(0)}万股`;
  return `${val.toLocaleString()}股`;
}

function MocChartCanvas({
  series,
  thresholdPct,
  dark,
  heightClass,
}: {
  series: MocAuctionResponse["series_10d"];
  thresholdPct: number;
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

    const barData = series.map((p) => {
      const isSpike = p.tail_share_pct >= thresholdPct;
      let color = dark ? "rgba(148, 163, 184, 0.55)" : "rgba(100, 116, 139, 0.50)";
      if (p.direction === "up") {
        color = isSpike
          ? "#10b981"
          : dark
            ? "rgba(16, 185, 129, 0.65)"
            : "rgba(5, 150, 105, 0.68)";
      } else if (p.direction === "down") {
        color = isSpike
          ? "#f43f5e"
          : dark
            ? "rgba(244, 63, 94, 0.65)"
            : "rgba(225, 29, 72, 0.68)";
      }
      return {
        value: p.tail_share_pct,
        itemStyle: { color, borderRadius: [4, 4, 0, 0] },
      };
    });

    chart.setOption({
      animationDuration: 320,
      grid: { top: 26, right: 12, bottom: 22, left: 40 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        backgroundColor: "rgba(9, 9, 11, 0.94)",
        borderColor: "rgba(255,255,255,0.16)",
        textStyle: { color: "#f4f4f5", fontSize: 11, fontFamily: "sans-serif" },
        formatter: (params: unknown) => {
          const arr = Array.isArray(params) ? params : [];
          const idx = arr[0]?.dataIndex ?? 0;
          const pt = series[idx];
          if (!pt) return "";
          const dirText =
            pt.direction === "up"
              ? "尾盘偏买拉升"
              : pt.direction === "down"
                ? "尾盘偏卖承压"
                : "尾盘多空均衡";
          const spikeHint =
            pt.tail_share_pct >= thresholdPct ? " · 触发放量警戒" : "";
          return [
            `<div style="font-weight:700;margin-bottom:3px;">${pt.date}（${pt.tail_window_et} ET）</div>`,
            `<div>尾盘量能占比：<b style="color:#38bdf8">${pt.tail_share_pct.toFixed(1)}%</b>${spikeHint}</div>`,
            `<div>15m 脉冲涨跌：<b>${pt.tail_return_pct >= 0 ? "+" : ""}${pt.tail_return_pct.toFixed(2)}%</b>（${dirText}）</div>`,
            `<div style="color:#a1a1aa;margin-top:2px;">尾盘成交 ${fmtShares(pt.tail_volume)} / 全天 ${fmtShares(pt.total_volume)}</div>`,
          ].join("");
        },
      },
      xAxis: {
        type: "category",
        data: labels,
        axisLine: { lineStyle: { color: dark ? "#3f3f46" : "#d4d4d8" } },
        axisLabel: { color: axisLabelColor, fontSize: 10 },
      },
      yAxis: {
        type: "value",
        name: "占全天%",
        nameTextStyle: { color: axisLabelColor, fontSize: 9.5, padding: [0, 0, 0, -10] },
        splitLine: { lineStyle: { color: gridLineColor } },
        axisLabel: { color: axisLabelColor, fontSize: 9.5, formatter: "{value}%" },
      },
      series: [
        {
          name: "尾盘15m占比",
          type: "bar",
          barMaxWidth: 26,
          data: barData,
          markLine: {
            symbol: "none",
            silent: true,
            lineStyle: { color: "#f59e0b", type: "dashed", width: 1.4 },
            label: {
              show: true,
              position: "insideEndTop",
              distance: [0, 3],
              formatter: `警戒线 ${thresholdPct.toFixed(1)}%`,
              color: "#d97706",
              fontSize: 9.5,
              backgroundColor: dark
                ? "rgba(9, 9, 11, 0.80)"
                : "rgba(255, 255, 255, 0.88)",
              padding: [2, 5],
              borderRadius: 4,
            },
            data: [{ yAxis: thresholdPct }],
          },
        },
      ],
    });

    const ro = new ResizeObserver(() => {
      chart.resize();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [series, thresholdPct, dark]);

  return <div ref={chartRef} className={`w-full ${heightClass}`} />;
}

export default function MocAuctionModule({
  theme,
  data,
  loading = false,
  targetSymbol,
  onSelectSymbol,
}: MocAuctionModuleProps) {
  const [expanded, setExpanded] = useState(false);
  const dark = theme === "dark";
  const series = useMemo(() => data?.series_10d ?? [], [data]);
  const latest = data?.latest ?? null;
  const thresholdPct = data?.alert_threshold_pct ?? 18.0;
  const nextRebal = data?.next_rebalance ?? null;
  const toneCls = getToneBannerClasses(data?.signal_tone);

  const nextRebalText = nextRebal
    ? `${nextRebal.title_zh} · ${
        nextRebal.days_away === 0 ? "就是今天" : `${nextRebal.days_away}天后`
      }`
    : "月末窗口读取中";

  const impulseTone =
    data?.signal_tone === "bullish"
      ? "text-emerald-700 dark:text-emerald-300"
      : data?.signal_tone === "bearish"
        ? "text-rose-700 dark:text-rose-300"
        : data?.signal_tone === "warning"
          ? "text-amber-700 dark:text-amber-300"
          : "text-zinc-900 dark:text-zinc-100";

  return (
    <SpotlightBlock
      tone="obsidian"
      className="flex h-full flex-col justify-between gap-2.5 p-3.5"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Clock3 className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <span className="font-sans text-sm font-bold tracking-tight text-zinc-950 dark:text-white">
            尾盘竞价与调仓脉冲
          </span>
          <span className="rounded-full border border-zinc-300/90 bg-white/85 px-2 py-0.5 font-mono text-[10px] font-medium text-zinc-700 dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-300">
            MOC 量化估算
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <div className="me-grid-no-drag flex items-center gap-0.5 rounded-full border border-zinc-300/80 bg-white/80 p-0.5 font-mono text-[10px] dark:border-white/15 dark:bg-white/[0.06]">
            {MOC_PRESETS.map((sym) => {
              const active = sym === targetSymbol.toUpperCase();
              return (
                <button
                  key={sym}
                  type="button"
                  onClick={() => onSelectSymbol(sym)}
                  className={`rounded-full px-2 py-0.5 font-semibold transition ${
                    active
                      ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                      : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                  }`}
                >
                  {sym}
                </button>
              );
            })}
          </div>
          <ExpandPanelButton onClick={() => setExpanded(true)} />
          <BeginnerGuidePopover
            title="尾盘竞价（MOC）实战口诀"
            subtitle="15:45–16:00 ET 被动资金收尾窗户"
            items={MOC_GUIDE_ITEMS}
          />
        </div>
      </div>

      {/* Novice 1-line plain Chinese conclusion */}
      <div
        className={`flex items-start gap-2 rounded-xl border px-2.5 py-1.5 font-sans text-[11.5px] font-medium leading-snug ${toneCls.wrap}`}
      >
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${toneCls.dot}`} />
        <div className="min-w-0 flex-1">
          <span>{data?.headline_zh ?? (loading ? "正在采样美股尾盘 15 分钟量能..." : "尾盘数据同步中")}</span>
          {data?.intraday_status === "mid_session_waiting" && (
            <span className="ml-1.5 inline-block rounded bg-black/10 px-1.5 py-0.5 font-mono text-[9.5px] dark:bg-white/10">
              等待今日15:45 ET尾盘
            </span>
          )}
        </div>
      </div>

      {/* 3 Core Capsules */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl bg-zinc-100/85 px-2.5 py-2 dark:bg-white/[0.05]">
          <div className="font-sans text-[10px] text-zinc-600 dark:text-zinc-400">
            尾盘 15m 量能占比
          </div>
          <div className="mt-0.5 flex items-baseline gap-1 font-mono text-sm font-bold text-zinc-950 dark:text-white">
            <span>{latest ? `${latest.tail_share_pct.toFixed(1)}%` : "—"}</span>
            {data?.surge_ratio != null && (
              <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
                ({data.surge_ratio.toFixed(2)}x均值)
              </span>
            )}
          </div>
        </div>

        <div className="rounded-xl bg-zinc-100/85 px-2.5 py-2 dark:bg-white/[0.05]">
          <div className="font-sans text-[10px] text-zinc-600 dark:text-zinc-400">
            尾盘冲量方向 (估算)
          </div>
          <div className={`mt-0.5 truncate font-sans text-xs font-bold ${impulseTone}`}>
            {data?.impulse_label_zh ?? "—"}
          </div>
          <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
            {latest
              ? `${latest.tail_return_pct >= 0 ? "+" : ""}${latest.tail_return_pct.toFixed(2)}% (${latest.label})`
              : "等待收盘样本"}
          </div>
        </div>

        <div className="rounded-xl bg-zinc-100/85 px-2.5 py-2 dark:bg-white/[0.05]">
          <div className="flex items-center gap-1 font-sans text-[10px] text-zinc-600 dark:text-zinc-400">
            <Flame className="h-3 w-3 text-amber-500" />
            <span>下个强制调仓日</span>
          </div>
          <div className="mt-0.5 truncate font-sans text-xs font-bold text-zinc-950 dark:text-white">
            {nextRebalText}
          </div>
          <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
            {nextRebal ? `${nextRebal.date} · ${nextRebal.tag_zh}` : "—"}
          </div>
        </div>
      </div>

      {/* Main ECharts Canvas */}
      <div className="flex min-h-[175px] flex-1 flex-col rounded-xl bg-white/70 p-2 dark:bg-black/25">
        {loading && series.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center font-mono text-xs text-zinc-500 dark:text-zinc-400">
            正在拉取 {targetSymbol} 近 10 个交易日分钟线...
          </div>
        ) : series.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center font-sans text-xs text-zinc-500 dark:text-zinc-400">
            {data?.reason ?? data?.intraday_status_zh ?? "暂无近10日尾盘分钟线数据"}
          </div>
        ) : (
          <MocChartCanvas
            series={series}
            thresholdPct={thresholdPct}
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
        title={`${targetSymbol} 尾盘竞价与 MOC 放量代理 · 完整监测面板`}
        subtitle={`基准 10 日均尾盘占比 ${data?.baseline_avg_tail_pct ?? "—"}% · 警戒阈值 ${thresholdPct.toFixed(1)}%`}
      >
        <div className="space-y-4">
          <div className={`rounded-xl border px-3.5 py-2.5 text-xs font-medium ${toneCls.wrap}`}>
            {data?.headline_zh}
          </div>
          {series.length > 0 && (
            <div className="rounded-2xl bg-white/75 p-3 dark:bg-black/30">
              <MocChartCanvas
                series={series}
                thresholdPct={thresholdPct}
                dark={dark}
                heightClass="h-[290px]"
              />
            </div>
          )}
          <div className="overflow-x-auto rounded-2xl border border-zinc-200/80 dark:border-white/[0.10]">
            <table className="w-full text-left font-mono text-[11px]">
              <thead className="bg-zinc-100/80 text-zinc-600 dark:bg-white/[0.06] dark:text-zinc-300">
                <tr>
                  <th className="px-3 py-2">交易日</th>
                  <th className="px-3 py-2">采样尾盘时段</th>
                  <th className="px-3 py-2">收盘价</th>
                  <th className="px-3 py-2">尾盘占比</th>
                  <th className="px-3 py-2">15m 脉冲涨跌</th>
                  <th className="px-3 py-2">尾盘 / 全天量</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200/70 dark:divide-white/[0.08]">
                {[...series].reverse().map((row) => (
                  <tr key={row.date} className="hover:bg-zinc-100/50 dark:hover:bg-white/[0.04]">
                    <td className="px-3 py-1.5 font-semibold text-zinc-900 dark:text-zinc-100">
                      {row.date}
                    </td>
                    <td className="px-3 py-1.5 text-zinc-600 dark:text-zinc-300">
                      {row.tail_window_et} {row.is_half_day ? "(半日市)" : ""}
                    </td>
                    <td className="px-3 py-1.5">${row.close_price.toFixed(2)}</td>
                    <td
                      className={`px-3 py-1.5 font-bold ${
                        row.tail_share_pct >= thresholdPct
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-zinc-900 dark:text-zinc-100"
                      }`}
                    >
                      {row.tail_share_pct.toFixed(2)}%
                    </td>
                    <td
                      className={`px-3 py-1.5 font-semibold ${
                        row.tail_return_pct > 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : row.tail_return_pct < 0
                            ? "text-rose-600 dark:text-rose-400"
                            : "text-zinc-500"
                      }`}
                    >
                      {row.tail_return_pct >= 0 ? "+" : ""}
                      {row.tail_return_pct.toFixed(3)}%
                    </td>
                    <td className="px-3 py-1.5 text-zinc-600 dark:text-zinc-400">
                      {fmtShares(row.tail_volume)} / {fmtShares(row.total_volume)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <SourceDisclosureFooter text={data?.methodology_note_zh} />
        </div>
      </MicrostructureExpandModal>
    </SpotlightBlock>
  );
}

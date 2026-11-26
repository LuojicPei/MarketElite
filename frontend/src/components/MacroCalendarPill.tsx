"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  BarChart3,
  CalendarClock,
  ChevronDown,
  Flame,
  History,
  Info,
  Repeat,
} from "lucide-react";
import {
  MacroIndicatorHistory,
  UpcomingCalendarResponse,
  fetchUpcomingCalendar,
} from "@/lib/api";
import {
  MacroEventImpact,
  UsMarketEventItem,
  buildUnifiedUsMarketEvents,
} from "@/lib/marketEvents";

type FilterGroup = "all" | "macro_fomc" | "flows_index" | "earnings" | "regime";
type PopoverViewMode = "upcoming" | "history";

function MiniMacroSparkline({
  values,
  trend,
}: {
  values: number[];
  trend: "up" | "down" | "flat";
}) {
  if (!values || values.length < 2) return null;
  // Records arrive newest-first; reverse for chronological left -> right chart
  const pts = [...values].reverse();
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = Math.max(max - min, 1e-6);
  const w = 78;
  const h = 24;
  const coords = pts.map((v, i) => {
    const x = 3 + (i / (pts.length - 1)) * (w - 6);
    const y = h - 4 - ((v - min) / span) * (h - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const stroke =
    trend === "up"
      ? "#f43f5e"
      : trend === "down"
        ? "#10b981"
        : "#0ea5e9";
  const last = coords[coords.length - 1].split(",");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0 overflow-visible" aria-hidden="true">
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={coords.join(" ")}
      />
      <circle cx={last[0]} cy={last[1]} r="2.2" fill={stroke} />
    </svg>
  );
}

function impactStyle(impact: MacroEventImpact): {
  dot: string;
  badge: string;
  label: string;
} {
  if (impact === "high") {
    return {
      dot: "bg-rose-500",
      badge:
        "border-rose-500/30 bg-rose-500/[0.12] text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/20 dark:text-rose-200",
      label: "高波焦点",
    };
  }
  if (impact === "medium") {
    return {
      dot: "bg-amber-500",
      badge:
        "border-amber-500/35 bg-amber-500/[0.12] text-amber-800 dark:border-amber-400/30 dark:bg-amber-500/20 dark:text-amber-200",
      label: "调仓/重点",
    };
  }
  return {
    dot: "bg-sky-500",
    badge:
      "border-sky-500/30 bg-sky-500/[0.12] text-sky-700 dark:border-sky-400/30 dark:bg-sky-500/20 dark:text-sky-200",
    label: "制度日历",
  };
}

function summarizeShortTitle(ev: UsMarketEventItem): string {
  if (ev.category === "earnings") {
    const sym = ev.title.split(" ")[0];
    return `${sym}财报`;
  }
  if (ev.title.includes("四巫日")) return "四巫日&调仓";
  if (ev.title.includes("养老金")) return "养老金调仓";
  if (ev.title.includes("FOMC") && ev.title.includes("纪要")) return "FOMC纪要";
  if (ev.title.includes("FOMC")) return "美联储议息";
  if (ev.title.includes("CPI")) return "美国CPI";
  if (ev.title.includes("PPI")) return "美国PPI";
  if (ev.title.includes("PCE")) return "核心PCE";
  if (ev.title.includes("非农")) return "非农NFP";
  if (ev.title.includes("零售销售")) return "零售销售";
  if (ev.title.includes("GDP")) return "美国GDP";
  if (ev.title.includes("ISM 制造业")) return "ISM制造业";
  if (ev.title.includes("ISM 非制造业")) return "ISM服务业";
  if (ev.title.includes("罗素")) return "罗素重构";
  if (ev.title.includes("MSCI")) return "MSCI调仓";
  if (ev.title.includes("感恩节")) return "感恩节休市";
  if (ev.title.includes("黑色星期五")) return "黑五半日市";
  if (ev.title.includes("圣诞")) return "圣诞休市";
  if (ev.title.includes("夏令时")) return "切换夏令时";
  if (ev.title.includes("冬令时")) return "切换冬令时";
  if (ev.title.includes("回购静默")) return "回购静默期";
  return ev.title.slice(0, 7);
}

export default function MacroCalendarPill() {
  const [liveCalendar, setLiveCalendar] = useState<UpcomingCalendarResponse | null>(null);
  const [events, setEvents] = useState<UsMarketEventItem[] | null>(null);
  const [open, setOpen] = useState(false);
  const [viewMode, setViewMode] = useState<PopoverViewMode>("upcoming");
  const [selectedIndId, setSelectedIndId] = useState<string>("all");
  const [filter, setFilter] = useState<FilterGroup>("all");
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadLive = () => {
      void fetchUpcomingCalendar()
        .then((res) => {
          if (!cancelled) setLiveCalendar(res);
        })
        .catch(() => {
          // Deterministic local calendar baseline stays active when offline
        });
    };
    loadLive();
    const timer = window.setInterval(loadLive, 5 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    void fetchUpcomingCalendar()
      .then((res) => setLiveCalendar(res))
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    const refresh = () => setEvents(buildUnifiedUsMarketEvents(Date.now(), liveCalendar, 95));
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(timer);
  }, [liveCalendar]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const filteredEvents = useMemo(() => {
    if (!events) return [];
    if (filter === "macro_fomc") {
      return events.filter((e) => e.category === "fomc" || e.category === "macro");
    }
    if (filter === "flows_index") {
      return events.filter((e) => e.category === "flows" || e.category === "index");
    }
    if (filter === "earnings") {
      return events.filter((e) => e.category === "earnings");
    }
    if (filter === "regime") {
      return events.filter((e) => e.category === "regime");
    }
    return events;
  }, [events, filter]);

  if (!events || events.length === 0) {
    return (
      <div
        aria-hidden="true"
        className="apple-liquid-glass-btn hidden h-10 w-28 animate-pulse rounded-full sm:block"
      />
    );
  }

  // Prefer the nearest high/medium impact event on the pill readout so minor notes don't crowd it
  const headlineEvent =
    events.find((e) => e.impact === "high" || e.impact === "medium") ?? events[0];
  const headlineTone = impactStyle(headlineEvent.impact);
  const shortTitle = summarizeShortTitle(headlineEvent);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`下一关键美股事件：${headlineEvent.title}（${headlineEvent.beijingDateTimeZh}）`}
        className="apple-liquid-glass-btn relative inline-flex h-10 items-center gap-1 rounded-full px-2 text-xs text-zinc-950 transition-all dark:text-white sm:px-2.5 2xl:gap-1.5 2xl:px-3"
      >
        <CalendarClock className="relative z-10 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" />
        <span className={`relative z-10 h-1.5 w-1.5 shrink-0 rounded-full ${headlineTone.dot}`} />
        <span className="relative z-10 hidden font-sans text-[11px] font-semibold sm:inline">
          {shortTitle}
        </span>
        <span className="relative z-10 rounded-full bg-zinc-950/[0.08] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-zinc-800 dark:bg-white/[0.12] dark:text-zinc-100">
          {headlineEvent.countdownBadge}
        </span>
        <ChevronDown
          className={`relative z-10 h-3 w-3 text-zinc-500 transition-transform duration-200 dark:text-zinc-400 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="absolute right-0 top-12 z-50 w-[min(95vw,500px)]"
          >
            <div className="apple-liquid-glass-popover rounded-2xl p-4 text-zinc-950 dark:text-zinc-50">
            {/* Header + Liquid Segmented Switch (Upcoming vs Macro Release History) */}
            <div className="relative z-10 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {viewMode === "upcoming" ? (
                  <Flame className="h-4 w-4 text-rose-500 dark:text-rose-400" />
                ) : (
                  <BarChart3 className="h-4 w-4 text-sky-600 dark:text-sky-400" />
                )}
                <span className="font-sans text-sm font-semibold text-zinc-950 dark:text-white">
                  美股关键日与资金事件日历
                </span>
              </div>

              <div className="inline-flex items-center rounded-full bg-zinc-950/[0.08] p-0.5 font-sans text-[11px] font-semibold dark:bg-white/[0.12]">
                <button
                  type="button"
                  onClick={() => setViewMode("upcoming")}
                  className={`rounded-full px-2.5 py-0.5 transition ${
                    viewMode === "upcoming"
                      ? "bg-white text-zinc-950 shadow-sm dark:bg-white/[0.22] dark:text-white"
                      : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                  }`}
                >
                  未来日程 ({filteredEvents.length})
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("history")}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 transition ${
                    viewMode === "history"
                      ? "bg-white text-zinc-950 shadow-sm dark:bg-white/[0.22] dark:text-white"
                      : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                  }`}
                >
                  <History className="h-3 w-3" />
                  <span>历史实绩 ({liveCalendar?.macro_history?.length ?? 7})</span>
                </button>
              </div>
            </div>

            {viewMode === "upcoming" ? (
              <>
                {/* Category Filters */}
                <div className="relative z-10 mt-3 flex flex-wrap items-center gap-1.5">
                  {(
                    [
                      { id: "all", label: "全部大事" },
                      { id: "macro_fomc", label: "议息与宏观数据" },
                      { id: "flows_index", label: "四巫/养老金/指数" },
                      { id: "earnings", label: "自选/焦点财报" },
                      { id: "regime", label: "休市与换时" },
                    ] as { id: FilterGroup; label: string }[]
                  ).map((tab) => {
                    const active = filter === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setFilter(tab.id)}
                        className={`rounded-full px-2.5 py-1 font-sans text-[11px] font-medium transition ${
                          active
                            ? "bg-zinc-950 text-white shadow-sm dark:bg-white dark:text-zinc-950"
                            : "bg-white/45 text-zinc-700 shadow-[inset_0_0.5px_0_rgba(255,255,255,0.65)] hover:bg-white/75 dark:bg-white/[0.06] dark:text-zinc-300 dark:shadow-[inset_0_0.5px_0_rgba(255,255,255,0.1)] dark:hover:bg-white/[0.12]"
                        }`}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>

                {/* Events Timeline */}
                <div className="relative z-10 mt-3 max-h-[395px] space-y-2 overflow-y-auto pr-1">
                  {filteredEvents.map((ev, index) => {
                    const tone = impactStyle(ev.impact);
                    return (
                      <div
                        key={ev.id}
                        className={`rounded-xl p-3 transition ${
                          index === 0
                            ? "bg-white/55 bg-gradient-to-br from-amber-500/[0.14] via-amber-500/[0.04] to-transparent shadow-[inset_0_0.5px_0_rgba(255,255,255,0.7),0_4px_14px_-6px_rgba(245,158,11,0.22)] dark:bg-white/[0.07] dark:from-amber-400/[0.16] dark:via-amber-500/[0.05] dark:to-transparent dark:shadow-[inset_0_0.5px_0_rgba(255,255,255,0.14)]"
                            : "bg-white/45 shadow-[inset_0_0.5px_0_rgba(255,255,255,0.68),0_2px_10px_-6px_rgba(15,23,42,0.1)] dark:bg-white/[0.06] dark:shadow-[inset_0_0.5px_0_rgba(255,255,255,0.1)]"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-sans text-[10px] font-semibold ${tone.badge}`}
                            >
                              <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                              {tone.label}
                            </span>
                            <span className="rounded-full bg-zinc-950/[0.08] px-2 py-0.5 font-sans text-[10px] font-medium text-zinc-700 dark:bg-white/10 dark:text-zinc-300">
                              {ev.categoryLabelZh}
                            </span>
                            {ev.sourceTag && (
                              <span className="rounded-full bg-emerald-500/[0.12] px-1.5 py-0.2 font-sans text-[9px] font-semibold text-emerald-700 dark:bg-emerald-500/[0.18] dark:text-emerald-300">
                                {ev.sourceTag}
                              </span>
                            )}
                          </div>

                          <span className="shrink-0 rounded-full bg-zinc-950 px-2 py-0.5 font-mono text-[10px] font-bold text-white dark:bg-white dark:text-zinc-950">
                            {ev.countdownBadge}
                          </span>
                        </div>

                        <div className="mt-1.5 font-sans text-[13px] font-semibold text-zinc-950 dark:text-white">
                          {ev.title}
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                          <span>北京 {ev.beijingDateTimeZh}</span>
                          <span className="text-zinc-400 dark:text-zinc-500">|</span>
                          <span>美东 {ev.easternDateTimeLabel}</span>
                        </div>

                        {ev.previousSummary && (
                          <div className="mt-1.5 flex items-center justify-between gap-2 rounded-lg bg-sky-500/10 px-2.5 py-1 font-mono text-[10.5px] font-semibold text-sky-900 dark:bg-sky-400/[0.12] dark:text-sky-200">
                            <span className="truncate">{ev.previousSummary}</span>
                            {ev.indicatorId && (
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedIndId(ev.indicatorId!);
                                  setViewMode("history");
                                }}
                                className="shrink-0 font-sans text-[10px] font-bold text-sky-700 underline decoration-sky-500/50 underline-offset-2 hover:text-sky-950 dark:text-sky-300 dark:hover:text-white"
                              >
                                历期实绩 →
                              </button>
                            )}
                          </div>
                        )}

                        <p className="mt-1.5 flex items-start gap-1.5 font-sans text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                          <Info className="mt-0.5 h-3 w-3 shrink-0 text-zinc-500 dark:text-zinc-400" />
                          <span>{ev.descriptionZh}</span>
                        </p>
                      </div>
                    );
                  })}

                  {filteredEvents.length === 0 && (
                    <div className="py-8 text-center font-sans text-xs text-zinc-500 dark:text-zinc-400">
                      当前筛选分类下未来 95 天暂无事件。
                    </div>
                  )}
                </div>
              </>
            ) : (
              <MacroReleaseHistoryView
                indicators={liveCalendar?.macro_history ?? []}
                selectedId={selectedIndId}
                onSelectId={setSelectedIndId}
              />
            )}

            <div className="relative z-10 mt-2.5 flex items-center justify-between border-t border-zinc-950/10 pt-2 font-sans text-[10px] text-zinc-600 dark:border-white/10 dark:text-zinc-400">
              <span className="inline-flex items-center gap-1">
                <Repeat className="h-3 w-3" />
                {viewMode === "upcoming"
                  ? "Fed/FRED/Finnhub 自动同步 + 四巫/养老金/节假日融合"
                  : "数据源：美联储 & 圣路易斯联储官方 FRED 实绩序列（已公布/前值）"}
              </span>
            </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MacroReleaseHistoryView({
  indicators,
  selectedId,
  onSelectId,
}: {
  indicators: MacroIndicatorHistory[];
  selectedId: string;
  onSelectId: (id: string) => void;
}) {
  const activeItem =
    selectedId !== "all"
      ? indicators.find((h) => h.id === selectedId) ?? null
      : null;

  const deltaTone = (trend: "up" | "down" | "flat", indId: string) => {
    if (trend === "flat") return "text-zinc-600 dark:text-zinc-300";
    // For inflation/unemployment/rate hikes vs payrolls/GDP keep objective directional tint
    const inflationOrRate = indId === "cpi" || indId === "pce" || indId === "ppi" || indId === "fomc";
    if (inflationOrRate) {
      return trend === "up"
        ? "text-rose-700 dark:text-rose-300"
        : "text-emerald-700 dark:text-emerald-300";
    }
    return trend === "up"
      ? "text-emerald-700 dark:text-emerald-300"
      : "text-rose-700 dark:text-rose-300";
  };

  return (
    <div className="relative z-10 mt-3 space-y-2.5">
      {/* Indicator Jump Chips */}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => onSelectId("all")}
          className={`rounded-full px-2.5 py-1 font-sans text-[11px] font-medium transition ${
            selectedId === "all"
              ? "bg-zinc-950 text-white shadow-sm dark:bg-white dark:text-zinc-950"
              : "bg-white/45 text-zinc-700 hover:bg-white/75 dark:bg-white/[0.06] dark:text-zinc-300 dark:hover:bg-white/[0.12]"
          }`}
        >
          全部 7 项总览
        </button>
        {indicators.map((ind) => {
          const on = selectedId === ind.id;
          return (
            <button
              key={ind.id}
              type="button"
              onClick={() => onSelectId(ind.id)}
              className={`rounded-full px-2.5 py-1 font-sans text-[11px] font-medium transition ${
                on
                  ? "bg-zinc-950 text-white shadow-sm dark:bg-white dark:text-zinc-950"
                  : "bg-white/45 text-zinc-700 hover:bg-white/75 dark:bg-white/[0.06] dark:text-zinc-300 dark:hover:bg-white/[0.12]"
              }`}
            >
              {ind.short_zh}
            </button>
          );
        })}
      </div>

      {indicators.length === 0 ? (
        <div className="rounded-xl bg-white/40 py-8 text-center font-sans text-xs text-zinc-600 dark:bg-white/[0.05] dark:text-zinc-400">
          正在从 FRED 拉取官方历史实绩序列，请稍候重试...
        </div>
      ) : activeItem ? (
        /* Single Indicator Full 10-Period Table */
        <div className="max-h-[385px] space-y-2 overflow-y-auto pr-1">
          <div className="flex items-center justify-between gap-3 rounded-xl bg-white/50 p-3 shadow-[inset_0_0.5px_0_rgba(255,255,255,0.7)] dark:bg-white/[0.07] dark:shadow-[inset_0_0.5px_0_rgba(255,255,255,0.12)]">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-sans text-[13px] font-bold text-zinc-950 dark:text-white">
                  {activeItem.title_zh}
                </span>
                <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.2 font-sans text-[9.5px] font-semibold text-emerald-700 dark:text-emerald-300">
                  {activeItem.latest_period_zh}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-2 font-mono">
                <span className="text-xl font-black tracking-tight tabular-nums text-zinc-950 dark:text-white">
                  {activeItem.latest_display}
                </span>
                {activeItem.secondary_badge && (
                  <span className="rounded bg-zinc-950/[0.08] px-1.5 py-0.5 text-[10.5px] font-semibold text-zinc-800 dark:bg-white/[0.12] dark:text-zinc-200">
                    {activeItem.secondary_badge}
                  </span>
                )}
                {activeItem.previous_display && (
                  <span className="text-[11px] text-zinc-600 dark:text-zinc-400">
                    前值 {activeItem.previous_display}
                  </span>
                )}
              </div>
            </div>
            <MiniMacroSparkline
              values={activeItem.records.map((r) => r.actual_value)}
              trend={activeItem.trend}
            />
          </div>

          <div className="overflow-hidden rounded-xl bg-white/45 shadow-[inset_0_0.5px_0_rgba(255,255,255,0.65)] dark:bg-white/[0.055] dark:shadow-[inset_0_0.5px_0_rgba(255,255,255,0.1)]">
            <table className="w-full text-left font-mono text-[11px] tabular-nums">
              <thead className="bg-zinc-950/[0.04] font-sans text-[10px] font-semibold text-zinc-600 dark:bg-white/[0.05] dark:text-zinc-400">
                <tr>
                  <th className="px-2.5 py-2">统计期</th>
                  <th className="px-2 py-2">公布值</th>
                  <th className="px-2 py-2">配套/环比</th>
                  <th className="px-2 py-2 text-right">较前变化</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-950/[0.08] dark:divide-white/[0.08]">
                {activeItem.records.map((rec, rIdx) => (
                  <tr
                    key={rec.period}
                    className={
                      rIdx === 0
                        ? "bg-sky-500/[0.08] font-semibold dark:bg-sky-400/10"
                        : "hover:bg-white/40 dark:hover:bg-white/[0.04]"
                    }
                  >
                    <td className="px-2.5 py-1.5 font-sans text-zinc-800 dark:text-zinc-200">
                      {rec.label_zh}
                    </td>
                    <td className="px-2 py-1.5 font-bold text-zinc-950 dark:text-white">
                      {rec.actual_display}
                    </td>
                    <td className="px-2 py-1.5 text-[10.5px] text-zinc-600 dark:text-zinc-300">
                      {rec.secondary_label && rec.secondary_display
                        ? `${rec.secondary_label} ${rec.secondary_display}`
                        : rec.mom_display || "—"}
                    </td>
                    <td className={`px-2.5 py-1.5 text-right font-semibold ${deltaTone(rec.trend, activeItem.id)}`}>
                      {rec.delta_display || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* All 7 Core Macro Indicators Overview Cards */
        <div className="max-h-[385px] space-y-2 overflow-y-auto pr-1">
          {indicators.map((ind) => (
            <button
              key={ind.id}
              type="button"
              onClick={() => onSelectId(ind.id)}
              className="flex w-full items-center justify-between gap-3 rounded-xl bg-white/45 px-3 py-2.5 text-left shadow-[inset_0_0.5px_0_rgba(255,255,255,0.7),0_2px_10px_-6px_rgba(15,23,42,0.1)] transition hover:-translate-y-0.5 hover:bg-white/65 dark:bg-white/[0.06] dark:shadow-[inset_0_0.5px_0_rgba(255,255,255,0.1)] dark:hover:bg-white/[0.11]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-sans text-[12.5px] font-bold text-zinc-950 dark:text-white">
                    {ind.title_zh}
                  </span>
                  <span className="rounded bg-zinc-950/[0.08] px-1.5 py-0.2 font-mono text-[10px] font-medium text-zinc-700 dark:bg-white/10 dark:text-zinc-300">
                    {ind.latest_period_zh}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-2 font-mono">
                  <span className="text-[16px] font-black leading-none tabular-nums text-zinc-950 dark:text-white">
                    {ind.latest_display}
                  </span>
                  {ind.secondary_badge && (
                    <span className="text-[10.5px] font-semibold text-zinc-700 dark:text-zinc-300">
                      {ind.secondary_badge}
                    </span>
                  )}
                  {ind.previous_display && (
                    <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
                      前值 {ind.previous_display}
                    </span>
                  )}
                  {ind.delta_display && (
                    <span className={`text-[10px] font-bold ${deltaTone(ind.trend, ind.id)}`}>
                      ({ind.delta_display})
                    </span>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 flex-col items-end gap-1">
                <MiniMacroSparkline
                  values={ind.records.map((r) => r.actual_value)}
                  trend={ind.trend}
                />
                <span className="font-sans text-[9.5px] font-semibold text-sky-700 dark:text-sky-300">
                  点查 {ind.records.length} 期明细 →
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

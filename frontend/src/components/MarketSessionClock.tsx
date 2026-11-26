"use client";

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  Clock,
  Moon,
  MoonStar,
  Sun,
  Sunrise,
  Sunset,
} from "lucide-react";
import {
  LiveUsMarketClockSnapshot,
  SESSION_META_MAP,
  UsSessionId,
  buildLiveUsMarketClock,
} from "@/lib/marketSchedule";

function renderSessionIcon(session: UsSessionId, className = "h-3.5 w-3.5") {
  switch (session) {
    case "overnight":
      return <MoonStar className={`${className} text-blue-500 dark:text-blue-400`} />;
    case "pre":
      return <Sunrise className={`${className} text-orange-500 dark:text-orange-400`} />;
    case "regular":
      return <Sun className={`${className} text-emerald-500 dark:text-emerald-400`} />;
    case "after":
      return <Sunset className={`${className} text-fuchsia-500 dark:text-fuchsia-400`} />;
    case "closed":
    default:
      return <Moon className={`${className} text-zinc-500 dark:text-zinc-400`} />;
  }
}

function getSessionPillTone(session: UsSessionId): string {
  switch (session) {
    case "overnight":
      return "border-blue-500/30 bg-blue-500/[0.12] text-blue-700 dark:border-blue-400/30 dark:bg-blue-500/20 dark:text-blue-200";
    case "pre":
      return "border-orange-500/35 bg-orange-500/[0.12] text-orange-700 dark:border-orange-400/35 dark:bg-orange-500/20 dark:text-orange-200";
    case "regular":
      return "border-emerald-500/35 bg-emerald-500/[0.14] text-emerald-700 dark:border-emerald-400/35 dark:bg-emerald-500/20 dark:text-emerald-200";
    case "after":
      return "border-fuchsia-500/35 bg-fuchsia-500/[0.12] text-fuchsia-700 dark:border-fuchsia-400/35 dark:bg-fuchsia-500/20 dark:text-fuchsia-200";
    case "closed":
    default:
      return "border-zinc-400/30 bg-zinc-500/10 text-zinc-700 dark:border-white/15 dark:bg-white/10 dark:text-zinc-300";
  }
}

export default function MarketSessionClock() {
  const [snapshot, setSnapshot] = useState<LiveUsMarketClockSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const syncClock = () => setSnapshot(buildLiveUsMarketClock(Date.now()));
    syncClock();
    const timer = window.setInterval(syncClock, 1000);
    return () => window.clearInterval(timer);
  }, []);

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

  if (!snapshot) {
    return (
      <div
        aria-hidden="true"
        className="apple-liquid-glass-btn hidden h-10 w-36 animate-pulse rounded-full sm:block"
      />
    );
  }

  const { session, sessionMeta, beijing, eastern } = snapshot;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const bjClockShort = `${pad2(beijing.hour)}:${pad2(beijing.minute)}`;
  const etClockShort = `${pad2(eastern.hour)}:${pad2(eastern.minute)}`;
  const etOffsetHours = snapshot.isDst ? -12 : -13;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="点击展开美股 24 小时交易时段全景图 & 中美双时钟"
        className="apple-liquid-glass-btn group relative inline-flex h-10 items-center gap-1.5 rounded-full px-2 text-left text-xs text-zinc-950 transition-all dark:text-white sm:px-2.5 2xl:gap-2 2xl:px-3"
      >
        {/* Colored Session Status Pill */}
        <span
          className={`relative z-10 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-sans text-[11px] font-semibold tracking-tight ${getSessionPillTone(
            session
          )}`}
        >
          {session === "regular" ? (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
          ) : (
            renderSessionIcon(session, "h-3.5 w-3.5")
          )}
          <span>{sessionMeta.shortZh}</span>
        </span>

        {/* Compact Mini 24h Progress Bar (2xl+) */}
        <div
          aria-hidden="true"
          className="relative z-10 hidden h-2 w-20 overflow-hidden rounded-full bg-zinc-300/60 dark:bg-white/15 2xl:block"
        >
          {snapshot.todayBeijingSegments.map((seg, i) => (
            <span
              key={`${seg.session}-${i}`}
              style={{
                left: `${seg.startPct}%`,
                width: `${seg.widthPct}%`,
                backgroundColor:
                  seg.session === "closed"
                    ? "transparent"
                    : SESSION_META_MAP[seg.session].colorHex,
              }}
              className="absolute inset-y-0"
            />
          ))}
          <span
            style={{ left: `${snapshot.todayProgressPct}%` }}
            className="absolute -inset-y-0.5 w-[2px] -translate-x-1/2 rounded-full bg-white shadow-[0_0_6px_rgba(14,165,233,0.9)]"
          />
        </div>

        {/* Friendly Dual Clocks + Countdown */}
        <div className="relative z-10 flex items-center gap-1.5 font-mono text-[11px] leading-none">
          <span className="font-semibold text-zinc-900 dark:text-zinc-100 md:hidden">
            {snapshot.countdownShortText}
          </span>

          <span className="hidden font-semibold text-zinc-900 dark:text-zinc-100 md:inline xl:hidden">
            {snapshot.nextTransitionLabelZh}
          </span>

          <span className="hidden items-center gap-1.5 xl:inline-flex">
            <span className="font-sans font-medium text-zinc-900 dark:text-zinc-100">
              北京 {beijing.weekdayZh} {snapshot.beijingFriendly}
            </span>
            <span className="hidden text-zinc-400 dark:text-zinc-500 min-[1520px]:inline">·</span>
            <span className="hidden font-sans text-zinc-700 dark:text-zinc-300 min-[1680px]:inline">
              美东 {eastern.weekdayZh} {snapshot.easternFriendly}
            </span>
            <span className="hidden font-sans text-zinc-600 dark:text-zinc-300 min-[1520px]:inline min-[1680px]:hidden">
              美东 {eastern.weekdayZh} {etClockShort}
            </span>
          </span>

          <span className="hidden rounded-full bg-zinc-950/[0.08] px-1.5 py-0.5 font-mono text-[10px] font-medium text-zinc-700 dark:bg-white/[0.12] dark:text-zinc-200 2xl:inline">
            {snapshot.nextTransitionLabelZh}
          </span>
        </div>

        <ChevronDown
          className={`relative z-10 h-3 w-3 text-zinc-500 transition-transform duration-200 dark:text-zinc-400 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* Expandable 7-Day Trading Hours Popover (True Floating Position Wrapper) */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="absolute left-0 top-12 z-50 w-[min(94vw,445px)]"
          >
            <div className="apple-liquid-glass-popover rounded-2xl p-4 text-zinc-950 dark:text-zinc-50">
            {/* Header & DST Badge */}
            <div className="relative z-10 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-sky-600 dark:text-sky-400" />
                <span className="font-sans text-sm font-semibold text-zinc-950 dark:text-white">
                  美股全时段交易表
                </span>
              </div>
              <span className="rounded-full bg-sky-500/[0.12] px-2.5 py-0.5 font-mono text-[10px] font-semibold text-sky-700 shadow-[inset_0_0.5px_0_rgba(255,255,255,0.45)] dark:bg-sky-400/15 dark:text-sky-300 dark:shadow-[inset_0_0.5px_0_rgba(255,255,255,0.12)]">
                {snapshot.dstLabelZh}
              </span>
            </div>

            {/* Intuitive Beijing + Eastern Dual Clocks */}
            <div className="relative z-10 mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-white/45 px-3 py-2 shadow-[inset_0_0.5px_0_rgba(255,255,255,0.7),0_2px_8px_-4px_rgba(15,23,42,0.08)] dark:bg-white/[0.06] dark:shadow-[inset_0_0.5px_0_rgba(255,255,255,0.12)]">
                <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                  中国北京时间 (CST)
                </div>
                <div className="mt-0.5 flex items-baseline gap-1.5 font-sans text-base font-bold text-zinc-950 dark:text-white">
                  <span>{snapshot.beijingFriendly}</span>
                  <span className="rounded bg-zinc-950/[0.08] px-1.5 py-0.2 text-[11px] font-semibold text-zinc-700 dark:bg-white/[0.12] dark:text-zinc-200">
                    {beijing.weekdayZh}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                  {beijing.dateStr} ({beijing.weekdayZh}) · {bjClockShort}:{pad2(beijing.second)}
                </div>
              </div>

              <div className="rounded-xl bg-white/45 px-3 py-2 shadow-[inset_0_0.5px_0_rgba(255,255,255,0.7),0_2px_8px_-4px_rgba(15,23,42,0.08)] dark:bg-white/[0.06] dark:shadow-[inset_0_0.5px_0_rgba(255,255,255,0.12)]">
                <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                  美国东部时间 ({eastern.tzAbbrev || "ET"} · {etOffsetHours}h)
                </div>
                <div className="mt-0.5 flex items-baseline gap-1.5 font-sans text-base font-bold text-zinc-950 dark:text-white">
                  <span>{snapshot.easternFriendly}</span>
                  <span className="rounded bg-zinc-950/[0.08] px-1.5 py-0.2 text-[11px] font-semibold text-zinc-700 dark:bg-white/[0.12] dark:text-zinc-200">
                    {eastern.weekdayZh}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                  {eastern.dateStr} ({eastern.weekdayZh}) · {etClockShort}:{pad2(eastern.second)}
                </div>
              </div>
            </div>

            {/* Active Session & Next Countdown */}
            <div
              className={`relative z-10 mt-2.5 flex items-center justify-between rounded-xl px-3 py-2 shadow-[inset_0_0.5px_0_rgba(255,255,255,0.4)] ${getSessionPillTone(
                session
              )}`}
            >
              <div className="flex items-center gap-2">
                {renderSessionIcon(session, "h-4 w-4")}
                <div>
                  <div className="font-sans text-xs font-bold">
                    当前状态：{sessionMeta.labelZh}
                  </div>
                  <div className="font-mono text-[10px] opacity-85">
                    {snapshot.holidayInfo.holidayNameZh
                      ? snapshot.holidayInfo.holidayNameZh
                      : `${sessionMeta.enLabel} · ${sessionMeta.etRange}`}
                  </div>
                </div>
              </div>
              <div className="text-right font-mono text-[11px] font-semibold">
                {snapshot.countdownTargetLabelZh.replace("距", "距离")}
                <div className="text-xs font-bold">{snapshot.countdownText}</div>
              </div>
            </div>

            {/* 7-Day Sun..Sat Horizontal Schedule Bars (Beijing Time Axis) */}
            <div className="relative z-10 mt-3.5">
              <div className="mb-1.5 flex items-center justify-between pl-11 pr-0.5 font-mono text-[9px] text-zinc-500 dark:text-zinc-400">
                <span>00:00</span>
                <span>04:00</span>
                <span>08:00</span>
                <span>12:00</span>
                <span>16:00</span>
                <span>20:00</span>
                <span>24:00</span>
              </div>

              <div className="relative space-y-1.5">
                {/* Global Vertical Sky-Blue Cursor Across Weekly Grid */}
                <div
                  style={{ left: `calc(2.75rem + (100% - 2.75rem) * ${snapshot.todayProgressPct / 100})` }}
                  className="pointer-events-none absolute -top-1 bottom-0 z-20 w-[1.5px] -translate-x-1/2 bg-sky-500/80 dark:bg-sky-400/85"
                />

                {snapshot.weeklyRows.map((row) => (
                  <div
                    key={row.dateStr}
                    className={`relative rounded-lg px-1 py-1 ${
                      row.isToday
                        ? "bg-sky-500/10 ring-1 ring-sky-500/30 dark:bg-sky-400/[0.12] dark:ring-sky-400/30"
                        : ""
                    }`}
                  >
                    <div className="relative flex items-center gap-2">
                      <div className="w-9 shrink-0 font-mono text-[11px] leading-tight">
                        <div
                          className={
                            row.isToday
                              ? "font-bold text-sky-700 dark:text-sky-300"
                              : "font-medium text-zinc-600 dark:text-zinc-400"
                          }
                        >
                          {row.dayShortZh}
                        </div>
                      </div>

                      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-zinc-200/80 dark:bg-white/10">
                        {row.segments.map((seg, idx) => (
                          <div
                            key={`${row.dateStr}-${idx}`}
                            title={`${row.dayShortZh} ${seg.startLabel}–${seg.endLabel} (北京时间): ${SESSION_META_MAP[seg.session].labelZh}`}
                            style={{
                              left: `${seg.startPct}%`,
                              width: `${seg.widthPct}%`,
                              backgroundColor:
                                seg.session === "closed"
                                  ? "transparent"
                                  : SESSION_META_MAP[seg.session].colorHex,
                            }}
                            className="absolute inset-y-0"
                          />
                        ))}
                      </div>

                      {row.isToday && (
                        <div
                          style={{
                            left: `calc(2.75rem + (100% - 2.75rem) * ${
                              snapshot.todayProgressPct / 100
                            })`,
                          }}
                          className="pointer-events-none absolute -top-2.5 z-30 -translate-x-1/2 rounded bg-sky-600 px-1 py-0.2 font-mono text-[9px] font-bold text-white shadow"
                        >
                          {bjClockShort}
                        </div>
                      )}
                    </div>

                    {row.holidayNote && (
                      <div className="pl-11 pt-0.5 font-sans text-[10px] font-medium text-amber-700 dark:text-amber-300/90">
                        ※ {row.holidayNote}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Legend */}
            <div className="relative z-10 mt-3.5 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-zinc-950/10 pt-3 font-sans text-[11px] dark:border-white/10">
              {(["overnight", "pre", "regular", "after"] as UsSessionId[]).map((sid) => {
                const meta = SESSION_META_MAP[sid];
                const bjRangeMap: Record<string, string> = snapshot.isDst
                  ? {
                      overnight: "08:00–16:00",
                      pre: "16:00–21:30",
                      regular: "21:30–04:00",
                      after: "04:00–08:00",
                    }
                  : {
                      overnight: "09:00–17:00",
                      pre: "17:00–22:30",
                      regular: "22:30–05:00",
                      after: "05:00–09:00",
                    };
                return (
                  <div key={sid} className="flex items-center justify-between gap-1.5">
                    <span className="flex items-center gap-1.5 font-medium text-zinc-800 dark:text-zinc-200">
                      <span
                        style={{ backgroundColor: meta.colorHex }}
                        className="h-2 w-3.5 rounded-full"
                      />
                      {meta.shortZh}
                    </span>
                    <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                      北京 {bjRangeMap[sid]}
                    </span>
                  </div>
                );
              })}
            </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

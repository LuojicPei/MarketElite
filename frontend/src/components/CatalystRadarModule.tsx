"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, CalendarClock, Flame, Star } from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import { fetchUpcomingCalendar, type UpcomingCalendarResponse } from "@/lib/api";
import { buildUnifiedUsMarketEvents, type UsMarketEventItem } from "@/lib/marketEvents";

interface CatalystRadarModuleProps {
  watchlistSymbols: string[];
  onSelectSymbol: (symbol: string) => void;
}

type RadarFilter = "all" | "macro" | "earnings";

function CatalystRadarModule({
  watchlistSymbols,
  onSelectSymbol,
}: CatalystRadarModuleProps) {
  const [liveCalendar, setLiveCalendar] = useState<UpcomingCalendarResponse | null>(null);
  const [filter, setFilter] = useState<RadarFilter>("all");
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetchUpcomingCalendar()
        .then((res) => {
          if (!cancelled) setLiveCalendar(res);
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
      load();
    }, 300_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const watchSet = useMemo(
    () => new Set(watchlistSymbols.map((s) => s.toUpperCase())),
    [watchlistSymbols]
  );

  const allEvents = useMemo(
    () => buildUnifiedUsMarketEvents(nowMs, liveCalendar, 45),
    [nowMs, liveCalendar]
  );

  const filteredEvents = useMemo(() => {
    if (filter === "macro") {
      return allEvents.filter((e) => e.category !== "earnings");
    }
    if (filter === "earnings") {
      const earn = allEvents.filter((e) => e.category === "earnings");
      return [...earn].sort((a, b) => {
        const aSym = a.title.split(" ")[0]?.toUpperCase() ?? "";
        const bSym = b.title.split(" ")[0]?.toUpperCase() ?? "";
        const aw = watchSet.has(aSym) ? 0 : 1;
        const bw = watchSet.has(bSym) ? 0 : 1;
        return aw !== bw ? aw - bw : a.timestampMs - b.timestampMs;
      });
    }
    return allEvents.filter((e) => e.impact === "high" || e.impact === "medium");
  }, [allEvents, filter, watchSet]);

  const nextHero = useMemo(
    () =>
      allEvents.find((e) => e.impact === "high" || e.impact === "medium") ??
      allEvents[0] ??
      null,
    [allEvents]
  );

  const extractTicker = (ev: UsMarketEventItem): string | null => {
    if (ev.category !== "earnings") return null;
    const head = (ev.title.split(" ")[0] || "").trim().toUpperCase();
    return /^[A-Z][A-Z0-9.-]{0,6}$/.test(head) ? head : null;
  };

  return (
    <SpotlightBlock
      tone="gallery"
      className="flex h-full flex-col justify-between gap-2 p-3.5"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5 font-sans text-xs font-bold tracking-tight text-zinc-950 dark:text-white">
          <CalendarClock className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span>宏观事件 & 财报催化雷达</span>
        </div>

        <div className="flex items-center gap-1 rounded-full border border-zinc-300/80 bg-white/80 p-0.5 font-mono text-[10px] dark:border-white/15 dark:bg-white/[0.06]">
          {(
            [
              { id: "all", label: "焦点" },
              { id: "macro", label: "宏观" },
              { id: "earnings", label: "财报" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setFilter(t.id)}
              className={`rounded-full px-2 py-0.5 font-semibold transition ${
                filter === t.id
                  ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                  : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Nearest Major Catalyst Highlight */}
      {nextHero && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 px-2.5 py-1.5 dark:border-amber-400/35 dark:bg-amber-500/15">
          <div className="flex min-w-0 items-center gap-1.5">
            <Flame className="h-3.5 w-3.5 shrink-0 text-rose-500 dark:text-rose-400" />
            <div className="min-w-0">
              <div className="truncate font-sans text-[11px] font-bold text-zinc-950 dark:text-white">
                下一焦点：{nextHero.title.replace(" ★ 自选关注", "")}
              </div>
              <div className="truncate font-mono text-[9.5px] text-zinc-700 dark:text-zinc-300">
                北京 {nextHero.beijingDateTimeZh}
              </div>
            </div>
          </div>
          <span className="shrink-0 rounded-full bg-zinc-950 px-2 py-0.5 font-mono text-[10px] font-bold text-white dark:bg-white dark:text-zinc-950">
            {nextHero.countdownBadge}
          </span>
        </div>
      )}

      {/* Event Stream */}
      <div className="min-h-0 flex-1 divide-y divide-zinc-200/80 overflow-y-auto rounded-xl border border-zinc-200/90 bg-white/80 dark:divide-white/[0.08] dark:border-white/15 dark:bg-white/[0.04]">
        {filteredEvents.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 font-sans text-xs text-zinc-500 dark:text-zinc-400">
            当前分类近 45 天暂无重大日程
          </div>
        ) : (
          filteredEvents.slice(0, 12).map((ev) => {
            const sym = extractTicker(ev);
            const isWatched = sym != null && watchSet.has(sym);
            const cleanTitle = ev.title.replace(" ★ 自选关注", "");
            const dotCls =
              ev.impact === "high"
                ? "bg-rose-500"
                : ev.impact === "medium"
                  ? "bg-amber-500"
                  : "bg-sky-500";
            const Wrapper: "button" | "div" = sym ? "button" : "div";

            return (
              <Wrapper
                key={ev.id}
                {...(sym
                  ? {
                      type: "button" as const,
                      onClick: () => onSelectSymbol(sym),
                      title: `点击将 ${sym} 调入中央 K 线与期权雷达`,
                    }
                  : {})}
                className={`flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left transition ${
                  sym
                    ? "cursor-pointer hover:bg-zinc-100/80 dark:hover:bg-white/[0.07]"
                    : ""
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotCls}`} />
                    <span className="truncate font-sans text-[11.5px] font-semibold text-zinc-950 dark:text-zinc-50">
                      {cleanTitle}
                    </span>
                    {isWatched && (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-400/25 px-1 py-0.2 font-mono text-[9px] font-bold text-amber-800 dark:text-amber-300">
                        <Star className="h-2.5 w-2.5 fill-current" />
                        自选
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                    <span>{ev.beijingDateTimeZh}</span>
                    <span>·</span>
                    <span className="truncate font-sans">{ev.categoryLabelZh}</span>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <span className="rounded-md bg-zinc-200/80 px-1.5 py-0.5 font-mono text-[10px] font-bold text-zinc-800 dark:bg-white/10 dark:text-zinc-200">
                    {ev.countdownBadge}
                  </span>
                  {sym && (
                    <ArrowUpRight className="h-3 w-3 text-zinc-400 dark:text-zinc-400" />
                  )}
                </div>
              </Wrapper>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
        <span>同步宏观/四巫/Finnhub日历</span>
        <span>点财报股可直切主图</span>
      </div>
    </SpotlightBlock>
  );
}

export default React.memo(CatalystRadarModule);

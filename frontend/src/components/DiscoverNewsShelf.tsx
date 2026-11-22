"use client";

import React, { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  Compass,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import { DiscoverNewsItem, resolveApiUrl } from "@/lib/api";

interface DiscoverNewsShelfProps {
  items: DiscoverNewsItem[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

const PAGE_SIZE = 3;

const PUBLISHER_BADGE_MAP: Record<string, { bg: string; fg: string; abbr: string }> = {
  cnbc: { bg: "#0c4a6e", fg: "#ffffff", abbr: "C" },
  reuters: { bg: "#ea580c", fg: "#ffffff", abbr: "R" },
  bloomberg: { bg: "#18181b", fg: "#ffffff", abbr: "B" },
  seekingalpha: { bg: "#065f46", fg: "#ffffff", abbr: "SA" },
  yahoo: { bg: "#5b21b6", fg: "#ffffff", abbr: "Y" },
  barron: { bg: "#1e293b", fg: "#fbbf24", abbr: "B" },
  wsj: { bg: "#1f2937", fg: "#f9fafb", abbr: "W" },
  marketwatch: { bg: "#15803d", fg: "#ffffff", abbr: "MW" },
  "24/7": { bg: "#991b1b", fg: "#ffffff", abbr: "24" },
  etf: { bg: "#0f766e", fg: "#ffffff", abbr: "E" },
  moneywise: { bg: "#0369a1", fg: "#ffffff", abbr: "M" },
};

function getPublisherStyle(name: string): { bg: string; fg: string; abbr: string } {
  const low = name.toLowerCase();
  for (const [key, val] of Object.entries(PUBLISHER_BADGE_MAP)) {
    if (low.includes(key)) {
      return val;
    }
  }
  const clean = name.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return {
    bg: "#27272a",
    fg: "#f4f4f5",
    abbr: clean.slice(0, 1) || "N",
  };
}

function formatRelativeZh(isoStr: string): string {
  const ts = Date.parse(isoStr);
  if (Number.isNaN(ts)) return "最新";
  const diffMin = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}小时前`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays <= 7) return `${diffDays}天前`;
  return isoStr.slice(5, 10);
}

export default function DiscoverNewsShelf({
  items,
  loading,
  error,
  onRefresh,
}: DiscoverNewsShelfProps) {
  const [page, setPage] = useState<number>(0);

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = page % totalPages;

  const visibleItems = useMemo(() => {
    if (items.length === 0) return [];
    const start = safePage * PAGE_SIZE;
    return items.slice(start, start + PAGE_SIZE);
  }, [items, safePage]);

  const handlePrev = () => {
    setPage((prev) => (prev - 1 + totalPages) % totalPages);
  };

  const handleNext = () => {
    setPage((prev) => (prev + 1) % totalPages);
  };

  return (
    <SpotlightBlock tone="gallery" className="p-4">
      {/* Header Row */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
            <Compass className="h-3.5 w-3.5" />
          </span>
          <h2 className="font-sans text-[15px] font-bold tracking-tight text-zinc-950 dark:text-white">
            发现 · 全球市场重要资讯
          </h2>
          <span className="rounded-full border border-zinc-300/90 bg-white/90 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-zinc-800 dark:border-white/20 dark:bg-white/[0.08] dark:text-zinc-100">
            中文实时译制 · 高清图讯
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-xs text-zinc-800 dark:text-zinc-200">
          {items.length > 0 && (
            <span className="font-semibold tabular-nums">
              第 {safePage + 1} / {totalPages} 组 · {items.length} 条精选
            </span>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            title="刷新全球要闻并译制最新标题"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-zinc-300 bg-white/90 text-zinc-900 transition hover:bg-zinc-100 disabled:opacity-50 dark:border-white/20 dark:bg-white/[0.08] dark:text-white dark:hover:bg-white/[0.15]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Content Cards */}
      {loading && items.length === 0 ? (
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
          {[0, 1, 2].map((idx) => (
            <div
              key={idx}
              className="overflow-hidden rounded-2xl border border-zinc-200/90 bg-white/80 p-2.5 dark:border-white/15 dark:bg-white/[0.04]"
            >
              <div className="h-[164px] w-full animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-800" />
              <div className="mt-2.5 h-4 w-11/12 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              <div className="mt-1.5 h-4 w-7/12 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              <div className="mt-3 h-3 w-1/3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            </div>
          ))}
        </div>
      ) : error && items.length === 0 ? (
        <div className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-5 text-center font-mono text-xs text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white/80 px-4 py-6 text-center font-mono text-xs text-zinc-700 dark:border-white/15 dark:bg-white/[0.04] dark:text-zinc-200">
          暂无全球图文快讯，请点击右上角刷新获取。
        </div>
      ) : (
        <>
          <AnimatePresence mode="wait">
            <motion.div
              key={safePage}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
              className="grid grid-cols-1 gap-3.5 md:grid-cols-3"
            >
              {visibleItems.map((item) => {
                const badges = (item.sources && item.sources.length > 0
                  ? item.sources
                  : [item.source]
                ).slice(0, 3);
                return (
                  <a
                    key={item.id}
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={
                      item.summary_zh
                        ? `${item.summary_zh}\n原文: ${item.headline_en}`
                        : item.headline_en
                    }
                    className="group flex flex-col justify-between overflow-hidden rounded-2xl border border-zinc-200/90 bg-white/90 p-2.5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-zinc-400 hover:shadow-md dark:border-white/15 dark:bg-white/[0.04] dark:hover:border-white/30 dark:hover:bg-white/[0.07]"
                  >
                    <div>
                      <div className="relative h-[164px] w-full overflow-hidden rounded-xl bg-zinc-900">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={resolveApiUrl(item.image_proxy_url)}
                          alt={item.title_zh}
                          loading="eager"
                          decoding="async"
                          className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]"
                        />
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/55 to-transparent" />
                        <span className="absolute left-2.5 top-2.5 rounded-full border border-white/25 bg-black/65 px-2.5 py-0.5 font-mono text-[10px] font-semibold text-white backdrop-blur-md">
                          {item.category_zh}
                        </span>
                      </div>

                      <h3 className="mt-2.5 line-clamp-2 min-h-[2.6rem] px-0.5 font-sans text-[15px] font-bold leading-snug tracking-tight text-zinc-950 transition-colors group-hover:text-emerald-700 dark:text-white dark:group-hover:text-emerald-300">
                        {item.title_zh}
                      </h3>
                    </div>

                    <div className="mt-2.5 flex items-center justify-between gap-2 px-0.5 pt-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="flex shrink-0 -space-x-1.5">
                          {badges.map((srcName, bIdx) => {
                            const st = getPublisherStyle(srcName);
                            return (
                              <span
                                key={`${item.id}-${srcName}-${bIdx}`}
                                style={{ backgroundColor: st.bg, color: st.fg }}
                                className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-white font-mono text-[9px] font-bold shadow-sm dark:border-zinc-900"
                              >
                                {st.abbr}
                              </span>
                            );
                          })}
                        </div>
                        <span className="truncate font-mono text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">
                          {item.source_count > 1
                            ? `${item.source_count} 个来源 · ${item.source}`
                            : item.source}
                        </span>
                      </div>

                      <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                        <span>{formatRelativeZh(item.published_at)}</span>
                        <ExternalLink className="h-3 w-3 opacity-60 transition-opacity group-hover:opacity-100" />
                      </span>
                    </div>
                  </a>
                );
              })}
            </motion.div>
          </AnimatePresence>

          {/* Carousel Controls: <   ● ○ ○ ○   > */}
          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between px-1">
              <button
                type="button"
                onClick={handlePrev}
                aria-label="上一组要闻"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-900 shadow-sm transition hover:bg-zinc-100 dark:border-white/20 dark:bg-zinc-900 dark:text-white dark:hover:bg-zinc-800"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>

              <div className="flex items-center gap-1.5" role="tablist" aria-label="要闻分页">
                {Array.from({ length: totalPages }).map((_, idx) => {
                  const active = idx === safePage;
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setPage(idx)}
                      aria-label={`第 ${idx + 1} 组要闻`}
                      aria-selected={active}
                      className={`h-2 rounded-full transition-all duration-200 ${
                        active
                          ? "w-5 bg-zinc-950 dark:bg-white"
                          : "w-2 bg-zinc-400/70 hover:bg-zinc-600 dark:bg-zinc-600 dark:hover:bg-zinc-400"
                      }`}
                    />
                  );
                })}
              </div>

              <button
                type="button"
                onClick={handleNext}
                aria-label="下一组要闻"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-900 shadow-sm transition hover:bg-zinc-100 dark:border-white/20 dark:bg-zinc-900 dark:text-white dark:hover:bg-zinc-800"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </>
      )}
    </SpotlightBlock>
  );
}

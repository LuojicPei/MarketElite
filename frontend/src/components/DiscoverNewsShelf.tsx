"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Compass,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";
import SpotlightBlock from "@/components/SpotlightBlock";
import DiscoverArticleModal from "@/components/DiscoverArticleModal";
import { DiscoverNewsItem, resolveApiUrl } from "@/lib/api";

interface DiscoverNewsShelfProps {
  items: DiscoverNewsItem[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

const AUTO_ROTATE_MS = 6500;

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

function DiscoverNewsShelf({
  items,
  loading,
  error,
  onRefresh,
}: DiscoverNewsShelfProps) {
  const [page, setPage] = useState<number>(0);
  const [autoPlay, setAutoPlay] = useState<boolean>(true);
  const [isHovered, setIsHovered] = useState<boolean>(false);
  const [tabVisible, setTabVisible] = useState<boolean>(true);
  const [activeArticle, setActiveArticle] = useState<DiscoverNewsItem | null>(null);

  const boxRef = useRef<HTMLDivElement | null>(null);
  const [boxSize, setBoxSize] = useState<{ width: number; height: number }>({
    width: 1200,
    height: 386,
  });

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = (w: number, h: number) => {
      if (w <= 0 || h <= 0) return;
      setBoxSize((prev) =>
        Math.abs(prev.width - w) < 4 && Math.abs(prev.height - h) < 4
          ? prev
          : { width: Math.round(w), height: Math.round(h) }
      );
    };
    update(el.clientWidth, el.clientHeight);
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) update(rect.width, rect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => setTabVisible(document.visibilityState === "visible");
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Derive grid cols, rows & card mode proportionally so headlines NEVER clip or require scrolling
  const layoutMetrics = useMemo(() => {
    const { width, height } = boxSize;
    const cols = width < 540 ? 1 : width < 960 ? 2 : 3;
    const headerWrapped = width < 680;
    const chromeH = headerWrapped ? 116 : 88;
    const availGridH = Math.max(110, height - chromeH);
    const rows = height >= 520 ? 2 : 1;
    const cardHeight = availGridH / rows;
    const cardWidth = width / cols;
    // Switch cleanly to horizontal media+text card when height is short OR aspect ratio gets overly wide
    const horizontalCard =
      cardHeight < 188 || (cardWidth / Math.max(cardHeight, 1) > 2.55 && cardHeight < 235);
    const pageSize = Math.max(1, cols * rows);
    const compactText = width < 760 || cardHeight < 225;
    return { cols, rows, pageSize, horizontalCard, compactText };
  }, [boxSize]);

  const totalPages = Math.max(1, Math.ceil(items.length / layoutMetrics.pageSize));
  const safePage = page % totalPages;

  const visibleItems = useMemo(() => {
    if (items.length === 0) return [];
    const start = safePage * layoutMetrics.pageSize;
    return items.slice(start, start + layoutMetrics.pageSize);
  }, [items, safePage, layoutMetrics.pageSize]);

  const autoRotateRunning =
    autoPlay && !isHovered && !activeArticle && tabVisible && totalPages > 1;

  useEffect(() => {
    if (!autoRotateRunning) return;
    const timer = window.setInterval(() => {
      setPage((prev) => (prev + 1) % totalPages);
    }, AUTO_ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [autoRotateRunning, totalPages, safePage]);

  const handlePrev = () => {
    setPage((prev) => (prev - 1 + totalPages) % totalPages);
  };

  const handleNext = () => {
    setPage((prev) => (prev + 1) % totalPages);
  };

  return (
    <>
      <div
        ref={boxRef}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className="h-full w-full"
      >
        <SpotlightBlock
          tone="obsidian"
          className="flex h-full flex-col justify-between p-3 sm:p-3.5"
        >
          {/* Header Row */}
          <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
                <Compass className="h-3.5 w-3.5" />
              </span>
              <h2 className="truncate font-sans text-[14px] font-bold tracking-tight text-zinc-950 dark:text-white sm:text-[15px]">
                发现 · 全球市场重要资讯
              </h2>
              <span className="hidden rounded-full border border-zinc-300/90 bg-white/90 px-2 py-0.5 font-mono text-[10px] font-semibold text-zinc-800 dark:border-white/20 dark:bg-white/[0.08] dark:text-zinc-100 md:inline-block">
                全中文速读 · 实时要闻
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-zinc-800 dark:text-zinc-200">
              {items.length > 0 && (
                <span className="font-semibold tabular-nums">
                  {safePage + 1}/{totalPages} 组
                  <span className="hidden sm:inline"> · {items.length} 条</span>
                </span>
              )}
              {totalPages > 1 && (
                <button
                  type="button"
                  onClick={() => setAutoPlay((v) => !v)}
                  title={
                    autoPlay
                      ? isHovered
                        ? "悬停阅读中，已自动暂停轮播（点击关闭自动轮播）"
                        : "自动轮播中（点击暂停）"
                      : "点击开启自动轮播"
                  }
                  aria-label={autoPlay ? "暂停自动轮播" : "开启自动轮播"}
                  className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 font-mono text-[10px] font-semibold transition ${
                    autoPlay
                      ? "border-emerald-500/40 bg-emerald-500/12 text-emerald-700 hover:bg-emerald-500/20 dark:border-emerald-400/35 dark:bg-emerald-500/15 dark:text-emerald-300"
                      : "border-zinc-300 bg-white/90 text-zinc-700 hover:bg-zinc-100 dark:border-white/20 dark:bg-white/[0.08] dark:text-zinc-300"
                  }`}
                >
                  {autoPlay ? (
                    <Pause className="h-2.5 w-2.5" />
                  ) : (
                    <Play className="h-2.5 w-2.5" />
                  )}
                  <span className="hidden sm:inline">
                    {autoPlay ? (isHovered ? "悬停" : "轮播") : "已停"}
                  </span>
                </button>
              )}
              <button
                type="button"
                onClick={onRefresh}
                disabled={loading}
                title="同步全站最新要闻（含 3 分钟防刷冷却）"
                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-zinc-300 bg-white/90 text-zinc-900 transition hover:bg-zinc-100 disabled:opacity-50 dark:border-white/20 dark:bg-white/[0.08] dark:text-white dark:hover:bg-white/[0.15]"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>

          {/* Content Area — Locked to exact proportional grid rows so titles never clip/scroll */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {loading && items.length === 0 ? (
              <div
                style={{
                  gridTemplateColumns: `repeat(${layoutMetrics.cols}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${layoutMetrics.rows}, minmax(0, 1fr))`,
                }}
                className="grid h-full gap-3"
              >
                {Array.from({ length: layoutMetrics.pageSize }).map((_, idx) => (
                  <div
                    key={idx}
                    className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-zinc-200/90 bg-white/80 p-2.5 dark:border-white/15 dark:bg-white/[0.04]"
                  >
                    <div className="min-h-0 flex-1 animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-800" />
                    <div className="mt-2 h-4 w-11/12 shrink-0 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                    <div className="mt-1.5 h-3 w-7/12 shrink-0 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                  </div>
                ))}
              </div>
            ) : error && items.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-xl border border-rose-300 bg-rose-50 px-4 py-5 text-center font-mono text-xs text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/40 dark:text-rose-200">
                {error}
              </div>
            ) : visibleItems.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-xl border border-zinc-200 bg-white/80 px-4 py-6 text-center font-mono text-xs text-zinc-700 dark:border-white/15 dark:bg-white/[0.04] dark:text-zinc-200">
                暂无全球图文快讯，请点击右上角刷新获取。
              </div>
            ) : (
              <AnimatePresence mode="wait">
                <motion.div
                  key={`${safePage}-${layoutMetrics.pageSize}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.22 }}
                  style={{
                    gridTemplateColumns: `repeat(${layoutMetrics.cols}, minmax(0, 1fr))`,
                    gridTemplateRows: `repeat(${layoutMetrics.rows}, minmax(0, 1fr))`,
                  }}
                  className="grid h-full gap-2.5 sm:gap-3"
                >
                  {visibleItems.map((item) => {
                    const badges = (item.sources && item.sources.length > 0
                      ? item.sources
                      : [item.source]
                    ).slice(0, 3);

                    if (layoutMetrics.horizontalCard) {
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setActiveArticle(item)}
                          title={
                            item.summary_zh
                              ? `${item.title_zh}\n\n${item.summary_zh}`
                              : item.title_zh
                          }
                          className="group flex h-full min-h-0 flex-row items-stretch gap-2.5 overflow-hidden rounded-2xl border border-zinc-200/90 bg-white/90 p-2 text-left shadow-sm transition-all duration-200 hover:border-zinc-400 hover:shadow-md dark:border-white/15 dark:bg-white/[0.04] dark:hover:border-white/30 dark:hover:bg-white/[0.07]"
                        >
                          <div className="relative h-full w-[36%] max-w-[165px] shrink-0 overflow-hidden rounded-xl bg-zinc-900">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={resolveApiUrl(item.image_proxy_url)}
                              alt={item.title_zh}
                              loading="eager"
                              decoding="async"
                              className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]"
                            />
                            <span className="absolute left-1.5 top-1.5 rounded-full border border-white/25 bg-black/65 px-2 py-0.5 font-mono text-[9px] font-semibold text-white backdrop-blur-md">
                              {item.category_zh}
                            </span>
                          </div>

                          <div className="flex min-w-0 flex-1 flex-col justify-between py-0.5">
                            <h3 className="line-clamp-3 font-sans text-[13.5px] font-bold leading-snug tracking-tight text-zinc-950 transition-colors group-hover:text-emerald-700 dark:text-white dark:group-hover:text-emerald-300">
                              {item.title_zh}
                            </h3>
                            <div className="mt-1 flex w-full items-center justify-between gap-2">
                              <span className="truncate font-mono text-[10px] font-semibold text-zinc-700 dark:text-zinc-300">
                                {item.source}
                              </span>
                              <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-zinc-600 dark:text-zinc-300">
                                {formatRelativeZh(item.published_at)}
                                <BookOpen className="h-3 w-3 opacity-65 group-hover:opacity-100" />
                              </span>
                            </div>
                          </div>
                        </button>
                      );
                    }

                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setActiveArticle(item)}
                        title={
                          item.summary_zh
                            ? `${item.title_zh}\n\n${item.summary_zh}\n点击在站内阅读全文`
                            : `${item.title_zh}\n点击在站内阅读全文`
                        }
                        className="group flex h-full min-h-0 flex-col justify-between overflow-hidden rounded-2xl border border-zinc-200/90 bg-white/90 p-2 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-zinc-400 hover:shadow-md dark:border-white/15 dark:bg-white/[0.04] dark:hover:border-white/30 dark:hover:bg-white/[0.07]"
                      >
                        {/* Proportional Flex Image Box — shrinks gracefully on resize so Headline NEVER clips */}
                        <div className="relative min-h-[76px] w-full flex-1 overflow-hidden rounded-xl bg-zinc-900">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={resolveApiUrl(item.image_proxy_url)}
                            alt={item.title_zh}
                            loading="eager"
                            decoding="async"
                            className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]"
                          />
                          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/55 to-transparent" />
                          <span className="absolute left-2 top-2 rounded-full border border-white/25 bg-black/65 px-2 py-0.5 font-mono text-[10px] font-semibold text-white backdrop-blur-md">
                            {item.category_zh}
                          </span>
                        </div>

                        {/* Fixed-priority Headline + Source Row (shrink-0 -> always 100% readable) */}
                        <div className="mt-2 shrink-0 px-0.5">
                          <h3
                            className={`line-clamp-2 font-sans font-bold leading-snug tracking-tight text-zinc-950 transition-colors group-hover:text-emerald-700 dark:text-white dark:group-hover:text-emerald-300 ${
                              layoutMetrics.compactText ? "text-[13.5px]" : "text-[14.5px]"
                            }`}
                          >
                            {item.title_zh}
                          </h3>

                          <div className="mt-1.5 flex w-full items-center justify-between gap-2 pt-0.5">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <div className="flex shrink-0 -space-x-1.5">
                                {badges.map((srcName, bIdx) => {
                                  const st = getPublisherStyle(srcName);
                                  return (
                                    <span
                                      key={`${item.id}-${srcName}-${bIdx}`}
                                      style={{ backgroundColor: st.bg, color: st.fg }}
                                      className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-white font-mono text-[8px] font-bold shadow-sm dark:border-zinc-900"
                                    >
                                      {st.abbr}
                                    </span>
                                  );
                                })}
                              </div>
                              <span className="truncate font-mono text-[10.5px] font-semibold text-zinc-800 dark:text-zinc-200">
                                {item.source_count > 1
                                  ? `${item.source_count} 来源 · ${item.source}`
                                  : item.source}
                              </span>
                            </div>

                            <span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px] font-medium text-zinc-700 dark:text-zinc-300">
                              <span>{formatRelativeZh(item.published_at)}</span>
                              <BookOpen className="h-3 w-3 opacity-65 transition-opacity group-hover:opacity-100" />
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </motion.div>
              </AnimatePresence>
            )}
          </div>

          {/* Carousel Controls with Auto-Progress Bar inside Active Indicator */}
          {totalPages > 1 && (
            <div className="mt-2 flex shrink-0 items-center justify-between px-1">
              <button
                type="button"
                onClick={handlePrev}
                aria-label="上一组要闻"
                className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-900 shadow-sm transition hover:bg-zinc-100 dark:border-white/20 dark:bg-zinc-900 dark:text-white dark:hover:bg-zinc-800"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
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
                      className={`relative h-1.5 overflow-hidden rounded-full transition-all duration-200 ${
                        active
                          ? "w-7 bg-zinc-300 dark:bg-zinc-700"
                          : "w-1.5 bg-zinc-400/65 hover:bg-zinc-600 dark:bg-zinc-600 dark:hover:bg-zinc-400"
                      }`}
                    >
                      {active && (
                        <motion.span
                          key={`progress-${safePage}-${autoRotateRunning ? "run" : "hold"}`}
                          initial={{ width: autoRotateRunning ? "0%" : "100%" }}
                          animate={{ width: "100%" }}
                          transition={
                            autoRotateRunning
                              ? { duration: AUTO_ROTATE_MS / 1000, ease: "linear" }
                              : { duration: 0.2 }
                          }
                          className="absolute inset-y-0 left-0 rounded-full bg-zinc-950 dark:bg-emerald-400"
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={handleNext}
                aria-label="下一组要闻"
                className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-900 shadow-sm transition hover:bg-zinc-100 dark:border-white/20 dark:bg-zinc-900 dark:text-white dark:hover:bg-zinc-800"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </SpotlightBlock>
      </div>

      <DiscoverArticleModal
        article={activeArticle}
        onClose={() => setActiveArticle(null)}
      />
    </>
  );
}

export default React.memo(DiscoverNewsShelf);

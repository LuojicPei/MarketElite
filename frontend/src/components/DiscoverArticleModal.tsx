"use client";

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  BookOpen,
  ExternalLink,
  Info,
  Languages,
  Quote,
  Sparkles,
  X,
} from "lucide-react";
import {
  DiscoverArticleBlock,
  DiscoverArticleDetail,
  DiscoverNewsItem,
  fetchDiscoverArticleDetail,
  resolveApiUrl,
} from "@/lib/api";

function RichInlineText({ text }: { text: string }) {
  const cleaned = text.replace(/<\/?(?!b\b)[^>]*>/gi, "");
  const parts = cleaned.split(/(<b>.*?<\/b>)/gi);
  return (
    <>
      {parts.map((part, idx) => {
        if (/^<b>.*<\/b>$/i.test(part)) {
          const inner = part.replace(/^<b>|<\/b>$/gi, "");
          return (
            <strong
              key={idx}
              className="font-semibold text-zinc-950 dark:text-white"
            >
              {inner}
            </strong>
          );
        }
        return (
          <React.Fragment key={idx}>
            {part.replace(/<\/?b>/gi, "")}
          </React.Fragment>
        );
      })}
    </>
  );
}

interface DiscoverArticleModalProps {
  article: DiscoverNewsItem | null;
  onClose: () => void;
}

const PUBLISHER_STYLE: Record<string, { bg: string; fg: string; abbr: string }> = {
  cnbc: { bg: "#0c4a6e", fg: "#ffffff", abbr: "C" },
  reuters: { bg: "#ea580c", fg: "#ffffff", abbr: "R" },
  bloomberg: { bg: "#18181b", fg: "#ffffff", abbr: "B" },
  seekingalpha: { bg: "#065f46", fg: "#ffffff", abbr: "SA" },
  yahoo: { bg: "#5b21b6", fg: "#ffffff", abbr: "Y" },
  barron: { bg: "#1e293b", fg: "#fbbf24", abbr: "B" },
  wsj: { bg: "#1f2937", fg: "#f9fafb", abbr: "W" },
  benzinga: { bg: "#1d4ed8", fg: "#ffffff", abbr: "BZ" },
  investor: { bg: "#0f172a", fg: "#38bdf8", abbr: "IBD" },
};

function getPublisherBadge(name: string): { bg: string; fg: string; abbr: string } {
  const low = name.toLowerCase();
  for (const [key, val] of Object.entries(PUBLISHER_STYLE)) {
    if (low.includes(key)) return val;
  }
  const letters = name.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return { bg: "#27272a", fg: "#ffffff", abbr: letters.slice(0, 2) || "N" };
}

function formatReadableTime(isoStr: string): string {
  if (!isoStr) return "";
  const dt = new Date(isoStr);
  if (Number.isNaN(dt.getTime())) return isoStr.slice(0, 16);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(
    dt.getHours()
  )}:${pad(dt.getMinutes())}`;
}

export default function DiscoverArticleModal({
  article,
  onClose,
}: DiscoverArticleModalProps) {
  // Default strictly to pure Chinese ("一打开默认全中文")
  const [bilingual, setBilingual] = useState<boolean>(false);
  const [detail, setDetail] = useState<DiscoverArticleDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!article) return;
    setBilingual(false);
    setDetail(null);
    setError(null);
    setLoading(true);

    let cancelled = false;
    void fetchDiscoverArticleDetail(article.id)
      .then((res) => {
        if (!cancelled) {
          setDetail(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "加载文章正文失败");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [article]);

  useEffect(() => {
    if (!article) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [article, onClose]);

  if (!article || typeof document === "undefined") return null;

  const badge = getPublisherBadge(article.source);
  const activeUrl = detail?.url || article.url;
  const relatedList = detail?.related_articles ?? article.related_articles ?? [];

  return createPortal(
    <AnimatePresence>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={article.title_zh}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3 backdrop-blur-md sm:p-6"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 12 }}
          transition={{ duration: 0.2 }}
          onClick={(e) => e.stopPropagation()}
          className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-zinc-200/90 bg-[#fcfbf9] text-zinc-950 shadow-2xl dark:border-white/15 dark:bg-[#0c0c0f] dark:text-zinc-100"
        >
          {/* Sticky Top Action Header */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/90 bg-white/85 px-5 py-3.5 backdrop-blur-md dark:border-white/10 dark:bg-zinc-950/85 sm:px-6">
            <div className="flex flex-wrap items-center gap-2">
              <span
                style={{ backgroundColor: badge.bg, color: badge.fg }}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full font-mono text-[10px] font-bold shadow-sm"
              >
                {badge.abbr}
              </span>
              <span className="font-mono text-xs font-bold text-zinc-900 dark:text-white">
                {article.source}
              </span>
              <span className="rounded-full border border-zinc-300 bg-zinc-100 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-zinc-800 dark:border-white/15 dark:bg-white/[0.08] dark:text-zinc-100">
                {article.category_zh}
              </span>
              <span className="font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                {formatReadableTime(article.published_at)}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setBilingual((v) => !v)}
                aria-pressed={bilingual}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-xs font-semibold transition ${
                  bilingual
                    ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
                    : "border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-100 dark:border-white/20 dark:bg-white/[0.08] dark:text-white dark:hover:bg-white/[0.15]"
                }`}
              >
                <Languages className="h-3.5 w-3.5" />
                <span>{bilingual ? "中 / 英对照" : "纯中文 · 中英对照"}</span>
              </button>

              <a
                href={activeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white px-3 py-1 font-mono text-xs font-semibold text-zinc-900 transition hover:bg-zinc-100 dark:border-white/20 dark:bg-white/[0.08] dark:text-white dark:hover:bg-white/[0.15]"
              >
                <span>跳转原网页</span>
                <ExternalLink className="h-3 w-3" />
              </a>

              <button
                type="button"
                onClick={onClose}
                aria-label="关闭阅读弹窗"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-900 transition hover:bg-zinc-100 dark:border-white/20 dark:bg-white/[0.08] dark:text-white dark:hover:bg-white/[0.15]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Scrollable Body */}
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-7">
            {/* Editorial HD Hero Photo */}
            <div className="relative h-52 w-full overflow-hidden rounded-2xl bg-zinc-900 sm:h-64">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={resolveApiUrl(article.image_proxy_url)}
                alt={article.title_zh}
                className="h-full w-full object-cover"
              />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/55 to-transparent" />
            </div>

            {/* Headlines */}
            <div>
              <h2 className="font-sans text-xl font-bold leading-snug tracking-tight text-zinc-950 dark:text-white sm:text-2xl">
                {detail?.title_zh || article.title_zh}
              </h2>
              {bilingual && (
                <p className="mt-2 border-l-2 border-emerald-500/70 pl-3 font-sans text-sm font-medium leading-relaxed text-zinc-700 dark:text-zinc-300">
                  {detail?.headline_en || article.headline_en}
                </p>
              )}
            </div>

            {/* Paywall / Summary Banner when applicable */}
            {detail?.access_status === "summary_only" && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-300/80 bg-amber-50/90 px-3.5 py-2.5 text-xs leading-relaxed text-amber-950 dark:border-amber-500/35 dark:bg-amber-950/35 dark:text-amber-200">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  该媒体原网页开启了订阅或访问权限校验，当前已在站内为您展示完整译制的官方核心要点摘要；点击右上角「跳转原网页」可尝试直接访问原媒体站点。
                </span>
              </div>
            )}

            {/* Article Paragraphs */}
            {loading ? (
              <div className="space-y-3 py-2">
                <div className="flex items-center gap-2 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                  <BookOpen className="h-3.5 w-3.5 animate-pulse text-emerald-500" />
                  <span>正在站内拉取原文并免费实时译制中文段落（0 LLM 额度消耗）...</span>
                </div>
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className={`h-4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800 ${
                      i === 3 ? "w-2/3" : "w-full"
                    }`}
                  />
                ))}
              </div>
            ) : error ? (
              <div className="space-y-2 rounded-xl border border-rose-300 bg-rose-50 p-4 text-xs text-rose-900 dark:border-rose-500/40 dark:bg-rose-950/40 dark:text-rose-200">
                <div className="font-semibold">正文提取受限：{error}</div>
                {article.summary_zh && (
                  <p className="text-sm leading-relaxed text-zinc-900 dark:text-zinc-100">
                    {article.summary_zh}
                  </p>
                )}
              </div>
            ) : detail?.blocks && detail.blocks.length > 0 ? (
              <div className="space-y-4">
                {(() => {
                  let seenFirstPara = false;
                  return detail.blocks.map((blk: DiscoverArticleBlock, idx: number) => {
                    if (blk.type === "callout" && blk.items_zh && blk.items_zh.length > 0) {
                      return (
                        <div
                          key={`blk-${idx}`}
                          className="rounded-2xl border border-emerald-500/25 bg-emerald-50/75 p-4 dark:border-emerald-400/25 dark:bg-emerald-950/25"
                        >
                          <div className="mb-2.5 flex items-center gap-1.5 font-mono text-xs font-bold tracking-wide text-emerald-900 dark:text-emerald-300">
                            <Sparkles className="h-3.5 w-3.5" />
                            <span>核心要点 · KEY TAKEAWAYS</span>
                          </div>
                          <ul className="space-y-2.5">
                            {blk.items_zh.map((zhItem, liIdx) => {
                              const enItem = blk.items_en?.[liIdx];
                              return (
                                <li key={liIdx} className="flex items-start gap-2.5">
                                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-600 dark:bg-emerald-400" />
                                  <div className="space-y-1">
                                    <p className="font-sans text-[14.5px] font-medium leading-relaxed text-zinc-900 dark:text-zinc-100">
                                      <RichInlineText text={zhItem} />
                                    </p>
                                    {bilingual && enItem && (
                                      <p className="border-l-2 border-emerald-500/45 pl-2.5 font-sans text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                                        <RichInlineText text={enItem} />
                                      </p>
                                    )}
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      );
                    }

                    if (blk.type === "heading") {
                      return (
                        <div key={`blk-${idx}`} className="pt-3 pb-0.5">
                          <h3 className="border-l-[3px] border-emerald-500 pl-3 font-sans text-[17px] font-bold leading-snug tracking-tight text-zinc-950 dark:text-white sm:text-[18px]">
                            <RichInlineText text={blk.zh || blk.en || ""} />
                          </h3>
                          {bilingual && blk.en && (
                            <p className="mt-1 pl-3.5 font-sans text-[13px] font-semibold text-zinc-600 dark:text-zinc-300">
                              <RichInlineText text={blk.en} />
                            </p>
                          )}
                        </div>
                      );
                    }

                    if (blk.type === "quote") {
                      return (
                        <blockquote
                          key={`blk-${idx}`}
                          className="space-y-1.5 rounded-r-2xl border-l-[3px] border-zinc-400 bg-zinc-100/80 px-4 py-3 dark:border-zinc-500 dark:bg-white/[0.05]"
                        >
                          <div className="flex items-start gap-2">
                            <Quote className="mt-1 h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" />
                            <p className="font-serif text-[15.5px] italic leading-relaxed text-zinc-900 dark:text-zinc-100">
                              <RichInlineText text={blk.zh || blk.en || ""} />
                            </p>
                          </div>
                          {bilingual && blk.en && (
                            <p className="pl-6 font-sans text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                              <RichInlineText text={blk.en} />
                            </p>
                          )}
                        </blockquote>
                      );
                    }

                    if (blk.type === "list" && blk.items_zh && blk.items_zh.length > 0) {
                      return (
                        <ul
                          key={`blk-${idx}`}
                          className="space-y-2 rounded-xl border border-zinc-200/80 bg-white/75 px-4 py-3 dark:border-white/10 dark:bg-white/[0.03]"
                        >
                          {blk.items_zh.map((zhItem, liIdx) => {
                            const enItem = blk.items_en?.[liIdx];
                            return (
                              <li key={liIdx} className="flex items-start gap-2.5">
                                <span className="mt-2 font-mono text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                                  {blk.ordered ? `${liIdx + 1}.` : "•"}
                                </span>
                                <div className="space-y-1">
                                  <p className="font-sans text-[15px] leading-relaxed text-zinc-900 dark:text-zinc-100">
                                    <RichInlineText text={zhItem} />
                                  </p>
                                  {bilingual && enItem && (
                                    <p className="border-l-2 border-emerald-500/45 pl-2.5 font-sans text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                                      <RichInlineText text={enItem} />
                                    </p>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      );
                    }

                    const isLead = !seenFirstPara;
                    seenFirstPara = true;
                    return (
                      <div key={`blk-${idx}`} className="space-y-1.5">
                        <p
                          className={`font-sans leading-[1.85] text-zinc-900 dark:text-zinc-100 ${
                            isLead
                              ? "text-[16px] font-medium text-zinc-950 dark:text-white"
                              : "text-[15.5px]"
                          }`}
                        >
                          <RichInlineText text={blk.zh || blk.en || ""} />
                        </p>
                        {bilingual && blk.en && (
                          <p className="border-l-2 border-emerald-500/55 pl-3 font-sans text-[13.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                            <RichInlineText text={blk.en} />
                          </p>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            ) : detail?.paragraphs && detail.paragraphs.length > 0 ? (
              <div className="space-y-4">
                {detail.paragraphs.map((p) => (
                  <div key={p.index} className="space-y-1.5">
                    <p className="font-sans text-[15.5px] leading-[1.85] text-zinc-900 dark:text-zinc-100">
                      {p.zh}
                    </p>
                    {bilingual && p.en && (
                      <p className="border-l-2 border-emerald-500/55 pl-3 font-sans text-[13.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                        {p.en}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : article.summary_zh ? (
              <p className="font-sans text-[15.5px] leading-[1.85] text-zinc-900 dark:text-zinc-100">
                {article.summary_zh}
              </p>
            ) : null}

            {/* Primary Source & Multi-Source Corroboration Links Footer */}
            <div className="space-y-3 border-t border-zinc-200 pt-4 dark:border-white/10">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-zinc-200 bg-white/90 px-4 py-3 dark:border-white/15 dark:bg-white/[0.04]">
                <div className="font-mono text-xs text-zinc-800 dark:text-zinc-200">
                  本文正文译自主信源：<strong className="text-zinc-950 dark:text-white">{article.source}</strong>
                </div>
                <a
                  href={activeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-full bg-zinc-950 px-3.5 py-1.5 font-mono text-xs font-semibold text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                >
                  <span>访问 {article.source} 原网页</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>

              {relatedList.length > 0 && (
                <div className="space-y-2">
                  <div className="font-mono text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                    同题材其他媒体相关报道（点击各自直达对应新闻网页）：
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {relatedList.map((rel, idx) => {
                      const relBadge = getPublisherBadge(rel.source);
                      return (
                        <a
                          key={`${rel.url}-${idx}`}
                          href={rel.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group flex items-start justify-between gap-2.5 rounded-xl border border-zinc-200 bg-white/85 p-3 transition hover:border-zinc-400 hover:bg-white dark:border-white/15 dark:bg-white/[0.04] dark:hover:border-white/30"
                        >
                          <div className="min-w-0 space-y-1">
                            <div className="flex items-center gap-1.5">
                              <span
                                style={{ backgroundColor: relBadge.bg, color: relBadge.fg }}
                                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full font-mono text-[8px] font-bold"
                              >
                                {relBadge.abbr}
                              </span>
                              <span className="font-mono text-[11px] font-bold text-zinc-800 dark:text-zinc-200">
                                {rel.source}
                              </span>
                            </div>
                            <div className="line-clamp-2 font-sans text-xs font-semibold leading-snug text-zinc-950 group-hover:text-emerald-700 dark:text-zinc-100 dark:group-hover:text-emerald-300">
                              {rel.title_zh || rel.headline_en}
                            </div>
                          </div>
                          <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500 group-hover:text-zinc-950 dark:text-zinc-400 dark:group-hover:text-white" />
                        </a>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body
  );
}

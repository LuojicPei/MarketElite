"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HelpCircle, Info, Maximize2, X } from "lucide-react";

export type SignalTone = "bullish" | "bearish" | "warning" | "neutral" | undefined;

export function getToneBannerClasses(tone: SignalTone): {
  wrap: string;
  dot: string;
} {
  if (tone === "bullish") {
    return {
      wrap: "border-emerald-500/35 bg-emerald-500/10 text-emerald-950 dark:border-emerald-400/30 dark:bg-emerald-500/[0.12] dark:text-emerald-200",
      dot: "bg-emerald-500",
    };
  }
  if (tone === "bearish") {
    return {
      wrap: "border-rose-500/35 bg-rose-500/10 text-rose-950 dark:border-rose-400/30 dark:bg-rose-500/[0.12] dark:text-rose-200",
      dot: "bg-rose-500",
    };
  }
  if (tone === "warning") {
    return {
      wrap: "border-amber-500/40 bg-amber-500/10 text-amber-950 dark:border-amber-400/30 dark:bg-amber-500/[0.12] dark:text-amber-200",
      dot: "bg-amber-500",
    };
  }
  return {
    wrap: "border-zinc-300/80 bg-zinc-100/90 text-zinc-900 dark:border-white/[0.12] dark:bg-white/[0.05] dark:text-zinc-200",
    dot: "bg-sky-500",
  };
}

export interface GuideItem {
  label: string;
  text: string;
}

interface BeginnerGuidePopoverProps {
  title: string;
  subtitle: string;
  items: GuideItem[];
}

/**
 * Shared Liquid Glass "? 口诀" beginner cheat-sheet button & popover.
 * Keeps jargon approachable without cluttering the primary card canvas.
 */
export function BeginnerGuidePopover({
  title,
  subtitle,
  items,
}: BeginnerGuidePopoverProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="me-grid-no-drag relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="查看新手实战口诀与避坑说明"
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-sans text-[10.5px] font-semibold transition ${
          open
            ? "border-sky-500/50 bg-sky-500/15 text-sky-900 dark:border-sky-400/40 dark:bg-sky-500/20 dark:text-sky-200"
            : "border-zinc-300/90 bg-white/80 text-zinc-700 hover:border-zinc-400 hover:text-zinc-950 dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-300 dark:hover:text-white"
        }`}
      >
        <HelpCircle className="h-3 w-3 text-sky-600 dark:text-sky-400" />
        <span>口诀</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={title}
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-[305px] max-w-[82vw]"
        >
          <div className="apple-liquid-glass-popover rounded-2xl p-3.5 text-left">
            <div className="mb-2 flex items-start justify-between gap-2 border-b border-zinc-300/60 pb-2 dark:border-white/[0.10]">
              <div>
                <div className="font-sans text-xs font-bold text-zinc-950 dark:text-white">
                  {title}
                </div>
                <div className="font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                  {subtitle}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full p-1 text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white"
                aria-label="关闭"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-2">
              {items.map((it) => (
                <div
                  key={it.label}
                  className="rounded-xl bg-white/70 px-2.5 py-2 dark:bg-white/[0.06]"
                >
                  <div className="font-sans text-[10.5px] font-bold text-zinc-900 dark:text-zinc-100">
                    {it.label}
                  </div>
                  <p className="mt-0.5 font-sans text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                    {it.text}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface ExpandPanelButtonProps {
  onClick: () => void;
  title?: string;
}

export function ExpandPanelButton({
  onClick,
  title = "放大查看完整图表与历史明细",
}: ExpandPanelButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="me-grid-no-drag inline-flex items-center gap-1 rounded-full border border-zinc-300/90 bg-white/80 px-2 py-0.5 font-sans text-[10.5px] font-semibold text-zinc-700 transition hover:border-zinc-400 hover:text-zinc-950 dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-300 dark:hover:text-white"
    >
      <Maximize2 className="h-3 w-3" />
      <span className="hidden sm:inline">详图</span>
    </button>
  );
}

interface MicrostructureExpandModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

export function MicrostructureExpandModal({
  open,
  onClose,
  title,
  subtitle,
  children,
}: MicrostructureExpandModalProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="apple-liquid-glass-popover relative flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl p-5 shadow-2xl">
        <div className="mb-3 flex items-center justify-between gap-3 border-b border-zinc-300/60 pb-3 dark:border-white/[0.1]">
          <div>
            <h3 className="font-sans text-base font-bold text-zinc-950 dark:text-white">
              {title}
            </h3>
            {subtitle && (
              <p className="font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300/80 bg-white/80 text-zinc-700 hover:bg-zinc-100 dark:border-white/15 dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/20"
            aria-label="关闭详图"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">{children}</div>
      </div>
    </div>,
    document.body
  );
}

export function SourceDisclosureFooter({ text }: { text?: string | null }) {
  if (!text) return null;
  return (
    <div className="flex items-start gap-1.5 rounded-lg bg-zinc-100/80 px-2.5 py-1.5 font-sans text-[10px] leading-snug text-zinc-600 dark:bg-white/[0.04] dark:text-zinc-400">
      <Info className="mt-0.5 h-3 w-3 shrink-0 text-zinc-500 dark:text-zinc-400" />
      <span>{text}</span>
    </div>
  );
}

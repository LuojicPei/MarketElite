"use client";

import React from "react";
import { EyeOff, GripHorizontal } from "lucide-react";
import { WIDGET_META_MAP, WidgetId } from "@/lib/dashboardLayout";

interface GridWidgetFrameProps {
  widgetId: WidgetId;
  editMode: boolean;
  gridColsWidth: number;
  gridRowsHeight: number;
  onHide: (id: WidgetId) => void;
  children: React.ReactNode;
}

export default function GridWidgetFrame({
  widgetId,
  editMode,
  gridColsWidth,
  gridRowsHeight,
  onHide,
  children,
}: GridWidgetFrameProps) {
  const meta = WIDGET_META_MAP[widgetId];

  if (!editMode) {
    return <div className="h-full w-full overflow-hidden rounded-2xl">{children}</div>;
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl ring-2 ring-emerald-500/65 shadow-[0_0_24px_-6px_rgba(16,185,129,0.45)] transition-shadow duration-200 dark:ring-emerald-400/60">
      <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-emerald-500/30 bg-emerald-50/95 px-2.5 text-zinc-900 backdrop-blur-md dark:border-emerald-400/25 dark:bg-zinc-950/95 dark:text-zinc-100">
        <div
          title="按住拖动移动该板块位置"
          className="me-grid-drag-handle flex min-w-0 flex-1 cursor-grab items-center gap-1.5 select-none active:cursor-grabbing"
        >
          <GripHorizontal className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="truncate font-sans text-[11px] font-semibold tracking-tight">
            {meta.titleZh}
          </span>
          <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.2 font-mono text-[10px] font-semibold text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-200">
            {gridColsWidth}×{gridRowsHeight}
          </span>
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onHide(widgetId);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          title={`隐藏「${meta.titleZh}」`}
          className="me-grid-no-drag inline-flex shrink-0 items-center gap-1 rounded-full border border-zinc-300/80 bg-white/80 px-2 py-0.5 font-sans text-[10px] font-semibold text-zinc-800 transition hover:border-rose-400/70 hover:bg-rose-50 hover:text-rose-700 dark:border-white/15 dark:bg-white/10 dark:text-zinc-100 dark:hover:border-rose-400/60 dark:hover:bg-rose-950/80 dark:hover:text-rose-200"
        >
          <EyeOff className="h-2.5 w-2.5" />
          <span>隐藏</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 select-none overflow-y-auto overflow-x-hidden [&>.velvet-black-block]:!rounded-t-none [&>.velvet-black-block]:!border-t-0 [&>.velvet-white-block]:!rounded-t-none [&>.velvet-white-block]:!border-t-0">
        {children}
      </div>
    </div>
  );
}

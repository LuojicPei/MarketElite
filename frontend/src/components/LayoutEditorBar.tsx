"use client";

import React, { useState } from "react";
import { motion } from "framer-motion";
import {
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  LayoutGrid,
  RotateCcw,
  Upload,
} from "lucide-react";
import {
  DASHBOARD_WIDGET_CATALOG,
  DashboardLayoutState,
  LayoutPresetId,
  WidgetId,
  normalizeLayoutState,
} from "@/lib/dashboardLayout";

interface LayoutEditorBarProps {
  layoutState: DashboardLayoutState;
  onToggleWidget: (id: WidgetId) => void;
  onApplyPreset: (preset: LayoutPresetId) => void;
  onResetDefault: () => void;
  onImportState: (next: DashboardLayoutState) => void;
  onDone: () => void;
}

const PRESET_LABELS: { id: LayoutPresetId; label: string; hint: string }[] = [
  { id: "classic", label: "经典全景", hint: "全部 11 大模块" },
  { id: "daytrader", label: "短线专注", hint: "大K线+自选+催化+龙虎榜" },
  { id: "macro", label: "宏观波段", hint: "流动性+广度+轮动+催化" },
];

export default function LayoutEditorBar({
  layoutState,
  onToggleWidget,
  onApplyPreset,
  onResetDefault,
  onImportState,
  onDone,
}: LayoutEditorBarProps) {
  const [showJsonPanel, setShowJsonPanel] = useState(false);
  const [jsonInput, setJsonInput] = useState("");
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const hiddenSet = new Set<WidgetId>(layoutState.hiddenIds);
  const visibleCount = DASHBOARD_WIDGET_CATALOG.length - hiddenSet.size;

  const handleCopyJson = async () => {
    const exported = JSON.stringify(layoutState, null, 2);
    setJsonInput(exported);
    setImportError(null);
    try {
      await navigator.clipboard.writeText(exported);
      setCopyFeedback(true);
      window.setTimeout(() => setCopyFeedback(false), 1800);
    } catch {
      // Clipboard API fallback handled cleanly by visible textarea
    }
  };

  const handleApplyImport = () => {
    setImportError(null);
    try {
      const parsed = JSON.parse(jsonInput) as Partial<DashboardLayoutState>;
      if (!parsed || !Array.isArray(parsed.items)) {
        setImportError("JSON 格式缺少 items 布局数组，请检查粘贴内容。");
        return;
      }
      onImportState({ ...normalizeLayoutState(parsed), activePreset: "custom" });
      setShowJsonPanel(false);
    } catch {
      setImportError("JSON 解析失败，请确认粘贴的是完整的 MarketElite 布局配置。");
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="rounded-2xl border border-emerald-500/40 bg-white/95 p-3.5 text-zinc-950 shadow-[0_16px_44px_-12px_rgba(16,185,129,0.28)] backdrop-blur-xl dark:border-emerald-400/35 dark:bg-zinc-950/95 dark:text-zinc-50 sm:p-4"
    >
      {/* Top Studio Controls Row */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 font-sans text-xs font-bold text-emerald-700 dark:text-emerald-300">
            <LayoutGrid className="h-3.5 w-3.5" />
            主页自由排版模式
          </span>
          <span className="font-sans text-xs text-zinc-600 dark:text-zinc-300">
            拖动卡片左上「⋮⋮」调整位置 · 拽住右下角调整宽高 · 自动防重叠吸附（已显示 {visibleCount}/
            {DASHBOARD_WIDGET_CATALOG.length}）
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {/* Quick Presets */}
          <div className="inline-flex items-center rounded-full border border-zinc-200 bg-zinc-100/80 p-0.5 dark:border-white/15 dark:bg-white/5">
            {PRESET_LABELS.map((p) => {
              const active = layoutState.activePreset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  title={p.hint}
                  onClick={() => onApplyPreset(p.id)}
                  className={`rounded-full px-2.5 py-1 font-sans text-[11px] font-semibold transition ${
                    active
                      ? "bg-zinc-950 text-white shadow-sm dark:bg-white dark:text-zinc-950"
                      : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => {
              const nextOpen = !showJsonPanel;
              setShowJsonPanel(nextOpen);
              if (nextOpen) {
                setJsonInput(JSON.stringify(layoutState, null, 2));
                setImportError(null);
              }
            }}
            className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white px-2.5 py-1 font-sans text-[11px] font-medium text-zinc-800 transition hover:bg-zinc-100 dark:border-white/15 dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/15"
          >
            <Download className="h-3 w-3" />
            导入/导出
          </button>

          <button
            type="button"
            onClick={onResetDefault}
            className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white px-2.5 py-1 font-sans text-[11px] font-medium text-zinc-800 transition hover:bg-zinc-100 dark:border-white/15 dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/15"
          >
            <RotateCcw className="h-3 w-3" />
            恢复默认
          </button>

          <button
            type="button"
            onClick={onDone}
            className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-3.5 py-1 font-sans text-xs font-bold text-white shadow-sm transition hover:bg-emerald-500"
          >
            <Check className="h-3.5 w-3.5" />
            完成并锁定
          </button>
        </div>
      </div>

      {/* Module Visibility Toggle Shelf (All 9 Modules) */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-zinc-200/80 pt-3 dark:border-white/10">
        <span className="mr-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          模块显隐:
        </span>
        {DASHBOARD_WIDGET_CATALOG.map((meta) => {
          const isHidden = hiddenSet.has(meta.id);
          return (
            <button
              key={meta.id}
              type="button"
              onClick={() => onToggleWidget(meta.id)}
              title={meta.descriptionZh}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-sans text-[11px] font-medium transition ${
                isHidden
                  ? "border-dashed border-zinc-300 bg-zinc-50 text-zinc-500 hover:border-emerald-500/50 hover:text-emerald-700 dark:border-white/15 dark:bg-white/[0.03] dark:text-zinc-400 dark:hover:text-emerald-300"
                  : "border-emerald-500/40 bg-emerald-500/12 text-emerald-800 hover:bg-emerald-500/20 dark:border-emerald-400/35 dark:bg-emerald-500/15 dark:text-emerald-200"
              }`}
            >
              {isHidden ? (
                <EyeOff className="h-3 w-3 opacity-70" />
              ) : (
                <Eye className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
              )}
              <span>{meta.titleZh}</span>
            </button>
          );
        })}
      </div>

      {/* Optional JSON Share / Import Panel */}
      {showJsonPanel && (
        <div className="mt-3 space-y-2 rounded-xl border border-zinc-200 bg-zinc-50/90 p-3 dark:border-white/10 dark:bg-black/40">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-sans text-xs font-semibold">
              布局 JSON 配置（跨设备备份或分享给好友）
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleCopyJson}
                className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white px-2.5 py-1 font-sans text-[11px] font-medium text-zinc-800 dark:border-white/15 dark:bg-white/10 dark:text-zinc-100"
              >
                <Copy className="h-3 w-3" />
                {copyFeedback ? "已复制" : "复制当前配置"}
              </button>
              <button
                type="button"
                onClick={handleApplyImport}
                className="inline-flex items-center gap-1 rounded-full bg-zinc-950 px-2.5 py-1 font-sans text-[11px] font-semibold text-white dark:bg-white dark:text-zinc-950"
              >
                <Upload className="h-3 w-3" />
                应用粘贴配置
              </button>
            </div>
          </div>
          <textarea
            value={jsonInput}
            onChange={(e) => setJsonInput(e.target.value)}
            rows={4}
            className="w-full rounded-lg border border-zinc-300 bg-white p-2 font-mono text-[11px] text-zinc-900 outline-none focus:border-emerald-500 dark:border-white/15 dark:bg-zinc-950 dark:text-zinc-100"
          />
          {importError && (
            <p className="font-sans text-[11px] text-rose-600 dark:text-rose-400">
              {importError}
            </p>
          )}
        </div>
      )}
    </motion.div>
  );
}

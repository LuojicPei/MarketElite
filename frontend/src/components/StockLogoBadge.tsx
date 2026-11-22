"use client";

import React, { useState } from "react";
import { getAssetLogoUrl } from "@/lib/api";

interface StockLogoBadgeProps {
  symbol: string;
  size?: number;
  className?: string;
}

const BRAND_COLORS: Record<string, { bg: string; fg: string }> = {
  NVDA: { bg: "#76b900", fg: "#ffffff" },
  AAPL: { bg: "#18181b", fg: "#ffffff" },
  GOOGL: { bg: "#2563eb", fg: "#ffffff" },
  GOOG: { bg: "#2563eb", fg: "#ffffff" },
  AMZN: { bg: "#f97316", fg: "#ffffff" },
  MSFT: { bg: "#0284c7", fg: "#ffffff" },
  TSLA: { bg: "#dc2626", fg: "#ffffff" },
  META: { bg: "#1d4ed8", fg: "#ffffff" },
  AMD: { bg: "#111827", fg: "#ffffff" },
  AVGO: { bg: "#be123c", fg: "#ffffff" },
  MU: { bg: "#312e81", fg: "#ffffff" },
  PLTR: { bg: "#0f172a", fg: "#ffffff" },
  SPY: { bg: "#0f172a", fg: "#34d399" },
  QQQ: { bg: "#1e293b", fg: "#38bdf8" },
  GLD: { bg: "#ca8a04", fg: "#ffffff" },
  SLV: { bg: "#64748b", fg: "#ffffff" },
  BTCUSDT: { bg: "#f59e0b", fg: "#18181b" },
};

/**
 * Rounded-square corporate badge loaded via cached backend `/api/assets/{sym}/logo`
 * (guaranteed HTTP 200 image or vector monogram) with zero-error local fallback.
 */
export default function StockLogoBadge({
  symbol,
  size = 36,
  className = "",
}: StockLogoBadgeProps) {
  const upper = symbol.toUpperCase();
  const [imgFailed, setImgFailed] = useState(false);
  const colors = BRAND_COLORS[upper] ?? { bg: "#27272a", fg: "#ffffff" };

  return (
    <div
      style={{ width: size, height: size }}
      className={`relative shrink-0 overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-sm dark:border-white/15 dark:bg-zinc-900 ${className}`}
    >
      {!imgFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={getAssetLogoUrl(upper)}
          alt={`${upper} icon`}
          onError={() => setImgFailed(true)}
          className="h-full w-full object-contain p-0.5"
        />
      ) : (
        <div
          style={{ backgroundColor: colors.bg, color: colors.fg }}
          className="flex h-full w-full items-center justify-center font-mono text-xs font-bold"
        >
          {upper.slice(0, 4)}
        </div>
      )}
    </div>
  );
}

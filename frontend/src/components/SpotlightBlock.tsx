"use client";

import React from "react";
import { clsx } from "clsx";

interface SpotlightBlockProps {
  tone: "obsidian" | "gallery";
  children: React.ReactNode;
  className?: string;
  tilt?: "strong" | "subtle" | "none";
}

/**
 * Borderless elevated Velvet architectural panel.
 *
 * Uses zero outer perimeter border and pure integer vertical hover translation (-3px)
 * without 3D perspective, scale, or offscreen backdrop-filter compositing so fonts
 * and candlestick charts stay 100% razor-sharp at rest and while hovering.
 */
export default function SpotlightBlock({
  tone,
  children,
  className,
}: SpotlightBlockProps) {
  return (
    <div
      className={clsx(
        "group/panel relative overflow-hidden rounded-2xl",
        tone === "obsidian"
          ? "velvet-black-block text-zinc-950 dark:text-zinc-100"
          : "velvet-white-block text-zinc-950 dark:text-zinc-100",
        className
      )}
    >
      {children}
    </div>
  );
}

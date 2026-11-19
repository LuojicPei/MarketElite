"use client";

import React, { useCallback } from "react";
import { clsx } from "clsx";

interface SpotlightBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  tone: "obsidian" | "gallery";
  children: React.ReactNode;
}

export default function SpotlightBlock({
  tone,
  children,
  className,
  onMouseMove,
  ...rest
}: SpotlightBlockProps) {
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      e.currentTarget.style.setProperty("--mx", `${e.clientX - rect.left}px`);
      e.currentTarget.style.setProperty("--my", `${e.clientY - rect.top}px`);
      onMouseMove?.(e);
    },
    [onMouseMove]
  );

  return (
    <div
      onMouseMove={handleMouseMove}
      className={clsx(
        "rounded-2xl transition-shadow duration-300",
        tone === "obsidian"
          ? "velvet-black-block text-zinc-100"
          : "velvet-white-block text-zinc-950",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

"use client";

import React, { useCallback, useState } from "react";
import { motion, useMotionTemplate, useMotionValue, useSpring } from "framer-motion";
import { clsx } from "clsx";

interface SpotlightBlockProps {
  tone: "obsidian" | "gallery";
  children: React.ReactNode;
  className?: string;
  tilt?: "strong" | "subtle" | "none";
}

/**
 * High-contrast Frosted Velvet architectural panel.
 *
 * Tactile responsiveness comes strictly from outer perimeter optics (1.5px cursor-tracked
 * bezel arc, sharp border elevation, top bevel glint, and multi-layer shadow depth).
 * Zero white overlay haze is painted over card content and zero 3D transform/scale
 * is applied, keeping typography and charts 100% crisp under hover.
 */
export default function SpotlightBlock({
  tone,
  children,
  className,
}: SpotlightBlockProps) {
  const [hovered, setHovered] = useState(false);

  const rawX = useMotionValue(50);
  const rawY = useMotionValue(50);
  const sheenX = useSpring(rawX, { stiffness: 220, damping: 26 });
  const sheenY = useSpring(rawY, { stiffness: 220, damping: 26 });

  const perimeterArcBackground = useMotionTemplate`radial-gradient(380px circle at ${sheenX}% ${sheenY}%, ${
    tone === "obsidian"
      ? "rgba(255, 255, 255, 0.85)"
      : "rgba(24, 24, 27, 0.58)"
  }, transparent 72%)`;

  const handleMouseEnter = useCallback(() => {
    setHovered(true);
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      rawX.set(((e.clientX - rect.left) / rect.width) * 100);
      rawY.set(((e.clientY - rect.top) / rect.height) * 100);
    },
    [rawX, rawY]
  );

  const handleMouseLeave = useCallback(() => {
    setHovered(false);
    rawX.set(50);
    rawY.set(50);
  }, [rawX, rawY]);

  return (
    <div
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      data-hovered={hovered ? "true" : "false"}
      className={clsx(
        "group/panel relative overflow-hidden rounded-2xl",
        tone === "obsidian"
          ? "velvet-black-block text-zinc-100"
          : "velvet-white-block text-zinc-950 dark:text-zinc-100",
        className
      )}
    >
      {/* Magnetic Beveled Perimeter Edge Light (strictly restricted to 1.5px frame edge) */}
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-20 rounded-[inherit] p-[1.5px] transition-opacity duration-200"
        style={{
          background: perimeterArcBackground,
          opacity: hovered ? 0.92 : 0,
          WebkitMask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
          WebkitMaskComposite: "xor",
          mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
          maskComposite: "exclude",
        }}
      />

      {/* Specular Top Edge Bevel Ignition */}
      <div
        aria-hidden="true"
        className={clsx(
          "pointer-events-none absolute top-0 z-20 h-[1.5px] transition-all duration-300",
          hovered ? "inset-x-2" : "inset-x-10",
          tone === "obsidian"
            ? hovered
              ? "bg-gradient-to-r from-transparent via-white/75 to-transparent"
              : "bg-gradient-to-r from-transparent via-white/20 to-transparent"
            : hovered
              ? "bg-gradient-to-r from-transparent via-zinc-900/45 to-transparent dark:via-white/65"
              : "bg-gradient-to-r from-transparent via-white/95 to-transparent dark:via-white/25"
        )}
      />

      {children}
    </div>
  );
}

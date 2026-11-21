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
 * High-tactility Frosted Velvet panel.
 *
 * Intentionally avoids 3D rotateX/rotateY, fractional scale(), preserve-3d, and
 * will-change: transform on the text-bearing container so Chromium never downgrades
 * text/canvas sharpness while hovering. Tactile responsiveness comes from:
 *   1. Decoupled optical frosted glass underlay (backdrop-filter isolated from text)
 *   2. Cursor-tracked prismatic border-mask rim flare around all 4 card edges
 *   3. Spring-eased diagonal velvet satin sweep across the glass surface
 *   4. Expanding top specular bevel & deep elevation box-shadow
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

  const glassWaveBackground = useMotionTemplate`radial-gradient(560px circle at ${sheenX}% ${sheenY}%, ${
    tone === "obsidian"
      ? "rgba(255, 255, 255, 0.13)"
      : "rgba(255, 255, 255, 0.48)"
  }, transparent 68%)`;

  const perimeterArcBackground = useMotionTemplate`radial-gradient(420px circle at ${sheenX}% ${sheenY}%, ${
    tone === "obsidian"
      ? "rgba(255, 255, 255, 0.92)"
      : "rgba(24, 24, 27, 0.65)"
  }, transparent 72%)`;

  const handleMouseEnter = useCallback(() => {
    setHovered(true);
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const px = ((e.clientX - rect.left) / rect.width) * 100;
      const py = ((e.clientY - rect.top) / rect.height) * 100;
      rawX.set(px);
      rawY.set(py);
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
      {/* Full-Panel Velvet Satin Optical Sweep */}
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-10 rounded-[inherit] transition-opacity duration-200"
        style={{
          background: glassWaveBackground,
          opacity: hovered ? 0.9 : 0,
        }}
      />

      {/* Magnetic Beveled Perimeter Edge Light (lights only the 1.5px rounded frame) */}
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-20 rounded-[inherit] p-[1.5px] transition-opacity duration-200"
        style={{
          background: perimeterArcBackground,
          opacity: hovered ? 0.95 : 0,
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
          hovered ? "inset-x-2" : "inset-x-8",
          tone === "obsidian"
            ? hovered
              ? "bg-gradient-to-r from-transparent via-white/75 to-transparent"
              : "bg-gradient-to-r from-transparent via-white/20 to-transparent"
            : hovered
              ? "bg-gradient-to-r from-transparent via-zinc-900/45 to-transparent dark:via-white/65"
              : "bg-gradient-to-r from-transparent via-white/95 to-transparent dark:via-white/25"
        )}
      />

      {/* Inner Content Rendered Directly at Native Subpixel Crispness */}
      {children}
    </div>
  );
}

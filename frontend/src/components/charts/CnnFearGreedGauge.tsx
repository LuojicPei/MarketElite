"use client";

import React from "react";

interface CnnFearGreedGaugeProps {
  score: number | null;
  rating: string | null | undefined;
  previousClose?: number | null;
  previous1Week?: number | null;
  previous1Month?: number | null;
  source?: string | null;
  compact?: boolean;
}

interface ZoneSpec {
  id: string;
  start: number;
  end: number;
  color: string;
  zhLabel: string;
}

const GAUGE_ZONES: ZoneSpec[] = [
  { id: "extreme_fear", start: 0, end: 25, color: "#dc2626", zhLabel: "极度恐惧" },
  { id: "fear", start: 25, end: 45, color: "#f97316", zhLabel: "恐惧" },
  { id: "neutral", start: 45, end: 55, color: "#eab308", zhLabel: "中性" },
  { id: "greed", start: 55, end: 75, color: "#22c55e", zhLabel: "贪婪" },
  { id: "extreme_greed", start: 75, end: 100, color: "#059669", zhLabel: "极度贪婪" },
];

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy - r * Math.sin(rad),
  };
}

function describeArc(cx: number, cy: number, r: number, scoreStart: number, scoreEnd: number) {
  // score 0 => 180deg (left), score 100 => 0deg (right)
  const startAngle = 180 - (scoreStart / 100) * 180;
  const endAngle = 180 - (scoreEnd / 100) * 180;
  const p1 = polarToCartesian(cx, cy, r, startAngle);
  const p2 = polarToCartesian(cx, cy, r, endAngle);
  return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${r} ${r} 0 0 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
}

function getMoodMeta(score: number | null, rating?: string | null) {
  const low = (rating ?? "").toLowerCase();
  if ((score !== null && score < 25) || low.includes("extreme fear")) {
    return {
      zh: "极度恐惧",
      en: "EXTREME FEAR",
      color: "#dc2626",
      textCls: "text-red-700 dark:text-red-400",
      badgeCls:
        "border-red-600/45 bg-red-600/15 text-red-700 dark:border-red-500/45 dark:bg-red-600/20 dark:text-red-300",
    };
  }
  if ((score !== null && score < 45) || low.includes("fear")) {
    return {
      zh: "恐惧",
      en: "FEAR",
      color: "#ea580c",
      textCls: "text-orange-700 dark:text-orange-400",
      badgeCls:
        "border-orange-500/40 bg-orange-500/15 text-orange-700 dark:border-orange-400/40 dark:bg-orange-500/20 dark:text-orange-300",
    };
  }
  if ((score !== null && score <= 55) || low.includes("neutral")) {
    return {
      zh: "中性",
      en: "NEUTRAL",
      color: "#ca8a04",
      textCls: "text-amber-700 dark:text-amber-300",
      badgeCls:
        "border-amber-500/40 bg-amber-500/15 text-amber-800 dark:border-amber-400/35 dark:bg-amber-500/15 dark:text-amber-300",
    };
  }
  if ((score !== null && score <= 75) || low === "greed") {
    return {
      zh: "贪婪",
      en: "GREED",
      color: "#16a34a",
      textCls: "text-emerald-700 dark:text-emerald-400",
      badgeCls:
        "border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:border-emerald-400/40 dark:bg-emerald-500/20 dark:text-emerald-300",
    };
  }
  return {
    zh: "极度贪婪",
    en: "EXTREME GREED",
    color: "#059669",
    textCls: "text-emerald-700 dark:text-emerald-300",
    badgeCls:
      "border-emerald-600/45 bg-emerald-600/15 text-emerald-800 dark:border-emerald-400/45 dark:bg-emerald-500/20 dark:text-emerald-300",
  };
}

export default function CnnFearGreedGauge({
  score,
  rating,
  previousClose,
  previous1Week,
  previous1Month,
  source,
  compact = false,
}: CnnFearGreedGaugeProps) {
  const clamped = score != null ? Math.max(0, Math.min(100, score)) : 50;
  const displayScore = score != null ? Math.round(score) : null;
  const mood = getMoodMeta(score, rating);

  const cx = 110;
  const cy = 104;
  const radius = 84;
  const needleAngle = 180 - (clamped / 100) * 180;
  const tip = polarToCartesian(cx, cy, radius - 14, needleAngle);

  const deltaVsClose =
    score != null && previousClose != null ? Number((score - previousClose).toFixed(1)) : null;

  return (
    <div
      className={`flex h-full flex-col justify-between rounded-xl border border-zinc-200/90 bg-white/85 dark:border-white/15 dark:bg-white/[0.04] ${
        compact ? "p-2" : "p-3"
      }`}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="truncate font-sans text-[11px] font-bold text-zinc-900 dark:text-zinc-100">
          {compact ? "CNN 恐慌" : "CNN 恐慌贪婪"}
        </span>
        <span
          className={`shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9px] font-bold ${
            source === "cnn_live"
              ? "border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
              : "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-white/15 dark:bg-white/10 dark:text-zinc-300"
          }`}
        >
          {source === "cnn_live" ? (compact ? "实时" : "CNN实时") : "模型"}
        </span>
      </div>

      {/* Semi-circle SVG Gauge matching CNN Fear & Greed dial */}
      <div
        className={`relative mx-auto flex w-full flex-col items-center ${
          compact ? "mt-0 max-w-[126px]" : "mt-1 max-w-[230px]"
        }`}
      >
        <svg viewBox="0 0 220 124" className="w-full overflow-visible select-none">
          {/* Colored Zone Arcs */}
          {GAUGE_ZONES.map((zone) => {
            const active =
              score != null &&
              score >= zone.start &&
              (zone.end === 100 ? score <= 100 : score < zone.end);
            return (
              <path
                key={zone.id}
                d={describeArc(cx, cy, radius, zone.start + 0.9, zone.end - 0.9)}
                fill="none"
                stroke={zone.color}
                strokeWidth={active ? 15 : 11}
                strokeOpacity={active ? 1 : 0.28}
                strokeLinecap="butt"
              />
            );
          })}

          {/* Tick Labels */}
          <text
            x="17"
            y="118"
            className="fill-zinc-500 font-mono text-[9.5px] font-semibold dark:fill-zinc-400"
          >
            0
          </text>
          <text
            x="105"
            y="14"
            textAnchor="middle"
            className="fill-zinc-500 font-mono text-[9.5px] font-semibold dark:fill-zinc-400"
          >
            50
          </text>
          <text
            x="204"
            y="118"
            textAnchor="end"
            className="fill-zinc-500 font-mono text-[9.5px] font-semibold dark:fill-zinc-400"
          >
            100
          </text>

          {/* Animated Needle */}
          {score != null && (
            <g>
              <line
                x1={cx}
                y1={cy}
                x2={tip.x}
                y2={tip.y}
                stroke={mood.color}
                strokeWidth="3"
                strokeLinecap="round"
              />
              <circle
                cx={cx}
                cy={cy}
                r="6"
                fill={mood.color}
                stroke="#ffffff"
                strokeWidth="1.5"
              />
            </g>
          )}
        </svg>

        {/* Big Numeric Score & Mood Readout */}
        <div className="-mt-1 text-center">
          <div className="flex items-baseline justify-center gap-1">
            <span
              className={`font-mono font-extrabold leading-none tabular-nums ${
                compact ? "text-2xl" : "text-3xl"
              } ${mood.textCls}`}
            >
              {displayScore != null ? displayScore : "—"}
            </span>
            {score != null && !compact && (
              <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                ({score.toFixed(1)})
              </span>
            )}
          </div>
          <div className={`${compact ? "mt-1" : "mt-1.5"} flex items-center justify-center`}>
            <span
              className={`inline-flex items-center rounded-full border font-sans font-bold ${
                compact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-0.5 text-[11px]"
              } ${mood.badgeCls}`}
            >
              {compact ? mood.zh : `${mood.zh} · ${mood.en}`}
            </span>
          </div>
        </div>
      </div>

      {/* Historical Comparison Strip */}
      <div
        className={`grid grid-cols-3 gap-1 border-t border-zinc-200/80 text-center font-mono dark:border-white/10 ${
          compact ? "mt-1 pt-1 text-[9px]" : "mt-2 pt-2 text-[10.5px]"
        }`}
      >
        <div className="rounded-md bg-zinc-100/80 px-1 py-1 dark:bg-white/[0.04]">
          <div className="text-[9.5px] text-zinc-600 dark:text-zinc-400">昨收</div>
          <div className="font-bold text-zinc-900 dark:text-zinc-100">
            {previousClose != null ? Math.round(previousClose) : "—"}
            {deltaVsClose !== null && deltaVsClose !== 0 && (
              <span
                className={`ml-0.5 text-[9.5px] ${
                  deltaVsClose > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
                }`}
              >
                {deltaVsClose > 0 ? `+${deltaVsClose.toFixed(1)}` : deltaVsClose.toFixed(1)}
              </span>
            )}
          </div>
        </div>
        <div className="rounded-md bg-zinc-100/80 px-1 py-1 dark:bg-white/[0.04]">
          <div className="text-[9.5px] text-zinc-600 dark:text-zinc-400">1周前</div>
          <div className="font-bold text-zinc-900 dark:text-zinc-100">
            {previous1Week != null ? Math.round(previous1Week) : "—"}
          </div>
        </div>
        <div className="rounded-md bg-zinc-100/80 px-1 py-1 dark:bg-white/[0.04]">
          <div className="text-[9.5px] text-zinc-600 dark:text-zinc-400">1月前</div>
          <div className="font-bold text-zinc-900 dark:text-zinc-100">
            {previous1Month != null ? Math.round(previous1Month) : "—"}
          </div>
        </div>
      </div>
    </div>
  );
}

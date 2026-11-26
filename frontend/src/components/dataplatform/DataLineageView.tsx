"use client";

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Database, GitBranch, Layers, ShieldAlert, Zap } from "lucide-react";
import type {
  DataPlatformOverviewResponse,
  HealthResponse,
  LineageEdge,
  LineageNode,
} from "@/lib/api";

interface DataLineageViewProps {
  overview: DataPlatformOverviewResponse | null;
  health: HealthResponse | null;
  loading: boolean;
  onJumpTab: (tab: "catalog" | "rag" | "evals" | "finops") => void;
}

const LAYER_META: Array<{ id: LineageNode["layer"]; title: string; subtitle: string }> = [
  { id: "ods", title: "ODS · 原始采集层", subtitle: "多源公开与专线 API" },
  { id: "dwd", title: "DWD · 清洗与熔断层", subtitle: "时区对齐 / 双TTL / 代理计算" },
  { id: "dws", title: "DWS · 特征与知识库", subtitle: "Regime / GEX / pgvector" },
  { id: "ads", title: "ADS · 服务与智能体", subtitle: "Bento看板 / MCP / 4-Agent" },
];

function nodeStatusBadge(status: string): { dot: string; text: string; label: string } {
  if (status === "healthy") {
    return {
      dot: "bg-emerald-500",
      text: "text-emerald-700 dark:text-emerald-300",
      label: "正常",
    };
  }
  if (status === "circuit_open") {
    return {
      dot: "bg-rose-500",
      text: "text-rose-700 dark:text-rose-300",
      label: "已熔断",
    };
  }
  if (status === "degraded") {
    return {
      dot: "bg-rose-500",
      text: "text-rose-700 dark:text-rose-300",
      label: "降级",
    };
  }
  if (status === "unconfigured") {
    return {
      dot: "bg-zinc-400",
      text: "text-zinc-600 dark:text-zinc-400",
      label: "未配Key",
    };
  }
  return {
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-300",
    label: status === "empty" ? "待入库" : "提醒",
  };
}

function collectLineageChain(
  selectedId: string | null,
  edges: LineageEdge[]
): {
  connectedNodes: Set<string>;
  upstreamNodes: Set<string>;
  downstreamNodes: Set<string>;
  activeEdges: Set<string>;
} {
  if (!selectedId) {
    return {
      connectedNodes: new Set(),
      upstreamNodes: new Set(),
      downstreamNodes: new Set(),
      activeEdges: new Set(),
    };
  }

  const upstream = new Set<string>();
  const downstream = new Set<string>();
  const activeEdges = new Set<string>();

  const upQueue = [selectedId];
  while (upQueue.length > 0) {
    const cur = upQueue.shift()!;
    for (const e of edges) {
      if (e.to === cur) {
        activeEdges.add(`${e.from}->${e.to}`);
        if (!upstream.has(e.from)) {
          upstream.add(e.from);
          upQueue.push(e.from);
        }
      }
    }
  }

  const downQueue = [selectedId];
  while (downQueue.length > 0) {
    const cur = downQueue.shift()!;
    for (const e of edges) {
      if (e.from === cur) {
        activeEdges.add(`${e.from}->${e.to}`);
        if (!downstream.has(e.to)) {
          downstream.add(e.to);
          downQueue.push(e.to);
        }
      }
    }
  }

  return {
    connectedNodes: new Set([
      selectedId,
      ...Array.from(upstream),
      ...Array.from(downstream),
    ]),
    upstreamNodes: upstream,
    downstreamNodes: downstream,
    activeEdges,
  };
}

export default function DataLineageView({
  overview,
  health,
  loading,
  onJumpTab,
}: DataLineageViewProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const graphRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [svgPaths, setSvgPaths] = useState<
    Array<{ key: string; d: string; active: boolean; dimmed: boolean }>
  >([]);

  const nodes = useMemo(() => overview?.lineage.nodes ?? [], [overview]);
  const edges = useMemo(() => overview?.lineage.edges ?? [], [overview]);
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const chain = useMemo(
    () => collectLineageChain(selectedNodeId, edges),
    [selectedNodeId, edges]
  );

  const recomputePaths = useMemo(() => {
    return () => {
      const wrap = graphRef.current;
      if (!wrap || edges.length === 0) {
        setSvgPaths([]);
        return;
      }
      const wRect = wrap.getBoundingClientRect();
      if (wRect.width < 680) {
        setSvgPaths([]);
        return;
      }

      const next: Array<{ key: string; d: string; active: boolean; dimmed: boolean }> = [];
      for (const e of edges) {
        const srcEl = nodeRefs.current[e.from];
        const dstEl = nodeRefs.current[e.to];
        if (!srcEl || !dstEl) continue;
        const s = srcEl.getBoundingClientRect();
        const t = dstEl.getBoundingClientRect();
        const x1 = s.right - wRect.left;
        const y1 = s.top + s.height / 2 - wRect.top;
        const x2 = t.left - wRect.left;
        const y2 = t.top + t.height / 2 - wRect.top;
        const dx = Math.max(24, (x2 - x1) * 0.5);
        const key = `${e.from}->${e.to}`;
        const hasSelection = selectedNodeId !== null;
        const active = hasSelection && chain.activeEdges.has(key);
        next.push({
          key,
          d: `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + dx).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`,
          active,
          dimmed: hasSelection && !active,
        });
      }
      setSvgPaths(next);
    };
  }, [edges, selectedNodeId, chain.activeEdges]);

  useLayoutEffect(() => {
    recomputePaths();
  }, [recomputePaths, nodes]);

  useEffect(() => {
    const el = graphRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => recomputePaths());
    ro.observe(el);
    return () => ro.disconnect();
  }, [recomputePaths]);

  const kpis = overview?.kpis;
  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) ?? null : null;

  return (
    <div className="space-y-4">
      {/* Top 4 Live DataOps KPIs */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <button
          type="button"
          onClick={() => onJumpTab("catalog")}
          className="velvet-white-block group rounded-2xl p-4 text-left transition hover:-translate-y-0.5"
        >
          <div className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <Database className="h-3.5 w-3.5 text-sky-500" />
              PostgreSQL 资产规模
            </span>
            <ArrowUpRight className="h-3.5 w-3.5 opacity-50 transition group-hover:opacity-100" />
          </div>
          <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-zinc-950 dark:text-white">
            {kpis ? kpis.total_pg_rows.toLocaleString() : loading ? "..." : "—"}
          </div>
          <div className="mt-1 font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
            {kpis
              ? `${kpis.healthy_tables}/${kpis.total_tables} 张表 SLA 健康`
              : "等待数据库采样"}
          </div>
        </button>

        <button
          type="button"
          onClick={() => onJumpTab("finops")}
          className="velvet-white-block group rounded-2xl p-4 text-left transition hover:-translate-y-0.5"
        >
          <div className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <Zap className="h-3.5 w-3.5 text-emerald-500" />
              Redis 热缓存与熔断
            </span>
            <ArrowUpRight className="h-3.5 w-3.5 opacity-50 transition group-hover:opacity-100" />
          </div>
          <div className="mt-2 flex items-baseline gap-2 font-mono">
            <span className="text-2xl font-bold tabular-nums text-zinc-950 dark:text-white">
              {kpis ? kpis.redis_keys : loading ? "..." : "—"}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">Keys</span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
            {kpis
              ? `新鲜信封 ${kpis.fresh_envelopes} · 熔断器开启 ${kpis.open_circuit_breakers}`
              : "等待 Redis 扫描"}
          </div>
        </button>

        <button
          type="button"
          onClick={() => onJumpTab("catalog")}
          className="velvet-white-block group rounded-2xl p-4 text-left transition hover:-translate-y-0.5"
        >
          <div className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
              数据质量综合健康分 (DQ)
            </span>
            <ArrowUpRight className="h-3.5 w-3.5 opacity-50 transition group-hover:opacity-100" />
          </div>
          <div className="mt-2 flex items-baseline gap-2 font-mono">
            <span
              className={`text-2xl font-bold tabular-nums ${
                (kpis?.dq_health_score ?? 0) >= 85
                  ? "text-emerald-600 dark:text-emerald-400"
                  : (kpis?.dq_health_score ?? 0) >= 60
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-rose-600 dark:text-rose-400"
              }`}
            >
              {kpis ? `${kpis.dq_health_score}` : loading ? "..." : "—"}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">/ 100</span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
            {overview?.quality
              ? `通过 ${overview.quality.summary.pass} · 提醒 ${overview.quality.summary.warn} · 异常 ${overview.quality.summary.fail}`
              : "6 项自动稽核规则"}
          </div>
        </button>

        <div className="velvet-white-block rounded-2xl p-4">
          <div className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <Layers className="h-3.5 w-3.5 text-violet-500" />
              底层容器与追踪探针
            </span>
            {kpis?.phoenix_ui_url && (
              <a
                href={kpis.phoenix_ui_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 font-mono text-[10.5px] font-semibold text-sky-600 hover:underline dark:text-sky-400"
              >
                Phoenix <ArrowUpRight className="h-3 w-3" />
              </a>
            )}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5 font-mono text-[11px]">
            {(
              [
                ["PG", health?.components.postgres],
                ["Redis", health?.components.redis],
                ["Phoenix", health?.components.phoenix],
              ] as const
            ).map(([label, comp]) => {
              const up = comp?.status === "up";
              return (
                <span
                  key={label}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${
                    up
                      ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-800 dark:border-emerald-400/30 dark:text-emerald-300"
                      : "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-300"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      up ? "bg-emerald-500" : "bg-amber-500"
                    }`}
                  />
                  {label}
                  {comp ? ` ${comp.latency_ms.toFixed(0)}ms` : ""}
                </span>
              );
            })}
          </div>
          <div className="mt-2 font-mono text-[10.5px] text-zinc-500 dark:text-zinc-400">
            点击下方血缘图任意节点，实时查看上下游影响面
          </div>
        </div>
      </div>

      {/* Interactive 4-Layer Medallion Lineage Topology */}
      <div className="velvet-white-block rounded-2xl p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/80 pb-3 dark:border-white/[0.10]">
          <div>
            <div className="flex items-center gap-2 font-sans text-sm font-bold text-zinc-950 dark:text-white">
              <GitBranch className="h-4 w-4 text-sky-500" />
              <span>全链路四层数仓血缘拓扑（ODS 接入 → DWD 清洗 → DWS 特征/向量 → ADS 交付）</span>
            </div>
            <p className="mt-0.5 font-sans text-xs text-zinc-600 dark:text-zinc-400">
              所有节点状态直接由 PostgreSQL {kpis?.total_tables ?? 16} 张表、Redis 双 TTL 缓存与熔断器实时映射；点击任一节点高亮影响链。
            </p>
          </div>
          {selectedNode && (
            <button
              type="button"
              onClick={() => setSelectedNodeId(null)}
              className="rounded-full border border-zinc-300 bg-white px-3 py-1 font-mono text-[11px] font-semibold text-zinc-800 hover:bg-zinc-100 dark:border-white/15 dark:bg-white/[0.08] dark:text-zinc-200 dark:hover:bg-white/15"
            >
              清除高亮（已选 {selectedNode.label}）
            </button>
          )}
        </div>

        {/* Impact Analysis Summary Ribbon when a node is selected */}
        {selectedNode && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-sky-500/35 bg-sky-500/10 px-3.5 py-2 font-sans text-xs text-sky-950 dark:border-sky-400/30 dark:bg-sky-500/[0.12] dark:text-sky-100">
            <span className="font-bold">影响面定位：</span>
            <span>
              当前选中 <b>{selectedNode.label}</b> · 上游依赖{" "}
              <b>
                {Array.from(chain.upstreamNodes)
                  .map((id) => nodeMap.get(id)?.label)
                  .filter(Boolean)
                  .join("、") || "原始源头（无更上游）"}
              </b>{" "}
              → 受影响下游{" "}
              <b>
                {Array.from(chain.downstreamNodes)
                  .map((id) => nodeMap.get(id)?.label)
                  .filter(Boolean)
                  .join("、") || "终端消费层"}
              </b>
            </span>
          </div>
        )}

        {/* 4 Columns + SVG Curved Connectors */}
        <div ref={graphRef} className="relative">
          {svgPaths.length > 0 && (
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
            >
              {svgPaths.map((p) => (
                <path
                  key={p.key}
                  d={p.d}
                  fill="none"
                  stroke={
                    p.active
                      ? "#0ea5e9"
                      : "currentColor"
                  }
                  className={
                    p.active
                      ? "opacity-95 transition-all duration-200"
                      : p.dimmed
                        ? "text-slate-400 opacity-15 transition-all duration-200 dark:text-slate-600"
                        : "text-slate-500/65 opacity-80 transition-all duration-200 dark:text-slate-400/45"
                  }
                  strokeWidth={p.active ? 2.4 : 1.5}
                  strokeLinecap="round"
                />
              ))}
            </svg>
          )}

          <div className="relative z-10 grid grid-cols-1 gap-6 md:grid-cols-4">
            {LAYER_META.map((layerMeta) => {
              const colNodes = nodes.filter((n) => n.layer === layerMeta.id);
              return (
                <div key={layerMeta.id} className="space-y-2.5">
                  <div className="rounded-xl bg-zinc-100/90 px-3 py-2 dark:bg-white/[0.05]">
                    <div className="font-mono text-[11px] font-bold text-zinc-900 dark:text-white">
                      {layerMeta.title}
                    </div>
                    <div className="font-sans text-[10.5px] text-zinc-500 dark:text-zinc-400">
                      {layerMeta.subtitle}
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    {colNodes.map((n) => {
                      const badge = nodeStatusBadge(n.status);
                      const isSel = selectedNodeId === n.id;
                      const isInChain =
                        selectedNodeId === null || chain.connectedNodes.has(n.id);
                      return (
                        <button
                          key={n.id}
                          ref={(el) => {
                            nodeRefs.current[n.id] = el;
                          }}
                          type="button"
                          onClick={() =>
                            setSelectedNodeId((prev) => (prev === n.id ? null : n.id))
                          }
                          className={`w-full rounded-xl border p-2.5 text-left transition-all ${
                            isSel
                              ? "border-sky-500 bg-sky-500/15 shadow-sm dark:border-sky-400 dark:bg-sky-500/20"
                              : isInChain
                                ? "border-zinc-200/90 bg-white/95 hover:border-sky-400 dark:border-white/[0.12] dark:bg-zinc-950/90 dark:hover:border-sky-400/60"
                                : "border-zinc-200/50 bg-white/60 opacity-35 dark:border-white/[0.06] dark:bg-zinc-950/50"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-sans text-xs font-bold text-zinc-950 dark:text-white">
                              {n.label}
                            </span>
                            <span
                              className={`inline-flex shrink-0 items-center gap-1 font-mono text-[10px] font-semibold ${badge.text}`}
                            >
                              <span className={`h-1.5 w-1.5 rounded-full ${badge.dot}`} />
                              {badge.label}
                            </span>
                          </div>
                          <div className="mt-1 truncate font-sans text-[10.5px] text-zinc-600 dark:text-zinc-400">
                            {n.sub}
                          </div>
                          <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                            <span>{n.layer.toUpperCase()}</span>
                            <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                              {n.metric}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

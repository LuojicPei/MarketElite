"use client";

import React, { useState } from "react";
import { Activity, Cpu, Lock, RotateCcw, ServerCrash } from "lucide-react";
import {
  DataPlatformOverviewResponse,
  resetProviderCircuit,
} from "@/lib/api";

interface ProvidersFinOpsViewProps {
  overview: DataPlatformOverviewResponse | null;
  isReadOnly?: boolean;
  adminToken?: string;
  onRefresh: () => void;
}

export default function ProvidersFinOpsView({
  overview,
  isReadOnly = false,
  adminToken = "",
  onRefresh,
}: ProvidersFinOpsViewProps) {
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const cacheData = overview?.cache_and_circuits;
  const finops = overview?.finops;

  const handleResetCircuit = async (providerId: string) => {
    if (isReadOnly) return;
    setResettingId(providerId);
    setActionMsg(null);
    try {
      const res = await resetProviderCircuit(providerId, adminToken);
      setActionMsg({
        ok: true,
        text: `已清理 [${res.provider}] 熔断状态键 ${res.keys_cleared} 条`,
      });
      onRefresh();
    } catch (err) {
      setActionMsg({
        ok: false,
        text: err instanceof Error ? err.message : "重置熔断失败",
      });
    } finally {
      setResettingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Core DualTTLCache Envelopes */}
      <div className="velvet-white-block rounded-2xl p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/80 pb-2.5 dark:border-white/[0.10]">
          <div className="flex items-center gap-2 font-sans text-sm font-bold text-zinc-950 dark:text-white">
            <Activity className="h-4 w-4 text-emerald-500" />
            <span>Redis DualTTLCache 核心业务信封与时效监测</span>
          </div>
          <div className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
            总键数 {cacheData?.total_keys ?? 0} · 内存占用 {cacheData?.used_memory_human ?? "N/A"}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3">
          {(cacheData?.envelopes ?? []).map((env) => {
            const cls =
              env.status === "fresh"
                ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
                : env.status === "stale_grace"
                  ? "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                  : "border-zinc-300/80 bg-zinc-100 text-zinc-600 dark:border-white/15 dark:bg-white/[0.04] dark:text-zinc-400";
            return (
              <div
                key={env.key}
                className="rounded-xl border border-zinc-200/80 bg-white/85 p-3 dark:border-white/[0.10] dark:bg-white/[0.04]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-sans text-xs font-bold text-zinc-950 dark:text-white">
                    {env.label_zh}
                  </span>
                  <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold ${cls}`}>
                    {env.status === "fresh"
                      ? "FRESH"
                      : env.status === "stale_grace"
                        ? "STALE GRACE"
                        : "EMPTY"}
                  </span>
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                  {env.key}
                </div>
                <div className="mt-2 flex items-center justify-between font-mono text-[10.5px] text-zinc-700 dark:text-zinc-300">
                  <span>
                    年龄 {env.age_minutes != null ? `${env.age_minutes}m` : "—"}
                  </span>
                  <span>
                    SoftTTL{" "}
                    {env.soft_ttl_remaining_s != null
                      ? env.soft_ttl_remaining_s >= 0
                        ? `余 ${env.soft_ttl_remaining_s}s`
                        : `过期 ${Math.abs(env.soft_ttl_remaining_s)}s`
                      : "—"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 14 Providers Circuit Breaker Matrix */}
      <div className="velvet-white-block rounded-2xl p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-sans text-sm font-bold text-zinc-950 dark:text-white">
            <ServerCrash className="h-4 w-4 text-amber-500" />
            <span>14 路外部数据源接入凭证与熔断器开关面板</span>
          </div>
          {actionMsg && (
            <span
              className={`font-mono text-xs ${
                actionMsg.ok
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400"
              }`}
            >
              {actionMsg.text}
            </span>
          )}
        </div>

        <div className="overflow-x-auto rounded-xl border border-zinc-200/80 dark:border-white/[0.10]">
          <table className="w-full text-left font-mono text-[11px]">
            <thead className="bg-zinc-100/85 text-zinc-600 dark:bg-white/[0.06] dark:text-zinc-300">
              <tr>
                <th className="px-3 py-2">Provider</th>
                <th className="px-3 py-2">所属数据域</th>
                <th className="px-3 py-2">鉴权方式</th>
                <th className="px-3 py-2">就绪状态</th>
                <th className="px-3 py-2">熔断器开关</th>
                <th className="px-3 py-2 text-right">近期失败次数</th>
                <th className="px-3 py-2 text-right">管理操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200/75 dark:divide-white/[0.08]">
              {(cacheData?.providers ?? []).map((p) => (
                <tr key={p.id}>
                  <td className="px-3 py-2 font-bold text-zinc-950 dark:text-white">
                    {p.name}
                  </td>
                  <td className="px-3 py-2 font-sans text-zinc-600 dark:text-zinc-300">
                    {p.domain}
                  </td>
                  <td className="px-3 py-2">{p.auth_mode}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        p.configured
                          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                          : "bg-zinc-200 text-zinc-600 dark:bg-white/10 dark:text-zinc-400"
                      }`}
                    >
                      {p.configured ? "READY" : "UNCONFIGURED"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        p.circuit_state === "open"
                          ? "bg-rose-500/20 text-rose-700 dark:text-rose-300"
                          : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      }`}
                    >
                      {p.circuit_state === "open"
                        ? `OPEN (${p.cooldown_remaining_s ?? "?"}s)`
                        : "CLOSED"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">{p.recent_failures}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      disabled={resettingId === p.id || isReadOnly}
                      onClick={() => handleResetCircuit(p.id)}
                      title={isReadOnly ? "访客只读模式已锁定熔断器重置" : undefined}
                      className="inline-flex items-center gap-1 rounded-full border border-zinc-300 px-2.5 py-0.5 font-sans text-[10.5px] font-semibold text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/15 dark:text-zinc-300 dark:hover:bg-white/10"
                    >
                      {isReadOnly ? (
                        <Lock className="h-3 w-3 text-amber-500" />
                      ) : (
                        <RotateCcw className="h-3 w-3" />
                      )}
                      {isReadOnly ? "只读锁定" : "重置熔断"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* LLM Dual-Tier FinOps & Agent Tool Latency */}
      <div className="velvet-white-block rounded-2xl p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/80 pb-2.5 dark:border-white/[0.10]">
          <div className="flex items-center gap-2 font-sans text-sm font-bold text-zinc-950 dark:text-white">
            <Cpu className="h-4 w-4 text-sky-500" />
            <span>LLM 分级路由与 Agent 工具运行时延迟（实库 Trace 统计）</span>
          </div>
          <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
            采样最近 {finops?.agent_runtime.recent_threads_sampled ?? 0} 个会话
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="rounded-xl bg-zinc-100/85 p-3 font-mono text-xs dark:bg-white/[0.05]">
            <div className="font-sans text-[10.5px] text-zinc-500 dark:text-zinc-400">
              双层模型与向量路由
            </div>
            <div className="mt-1 space-y-1 text-[11px]">
              <div>
                Fast Tier: <b>{finops?.llm_routing.fast_model ?? "—"}</b>
              </div>
              <div>
                Pro Tier: <b>{finops?.llm_routing.pro_model ?? "—"}</b>
              </div>
              <div>
                Embed ({finops?.llm_routing.embedding_dim ?? 1536}d):{" "}
                <b>{finops?.llm_routing.embedding_model ?? "—"}</b>
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-zinc-100/85 p-3 font-mono text-xs dark:bg-white/[0.05]">
            <div className="font-sans text-[10.5px] text-zinc-500 dark:text-zinc-400">
              预算防呆与死循环省流保护
            </div>
            <div className="mt-1 space-y-1 text-[11px]">
              <div>
                最大工具步数 / 超时上限:{" "}
                <b>
                  {finops?.llm_routing.max_steps_guard ?? 8} 步 /{" "}
                  {finops?.llm_routing.wall_timeout_s ?? 45}s
                </b>
              </div>
              <div>
                上下文裁剪阈值:{" "}
                <b>{finops?.llm_routing.max_context_tokens?.toLocaleString() ?? 14000} Tokens</b>
              </div>
              <div>
                已拦截重复工具死循环:{" "}
                <b className="text-emerald-600 dark:text-emerald-400">
                  {finops?.agent_runtime.blocked_duplicate_loops ?? 0} 次
                </b>
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-zinc-100/85 p-3 font-mono text-xs dark:bg-white/[0.05]">
            <div className="font-sans text-[10.5px] text-zinc-500 dark:text-zinc-400">
              MCP 工具平均调用频次
            </div>
            <div className="mt-1 space-y-1 text-[11px]">
              <div>
                累计记录工具调用:{" "}
                <b>{finops?.agent_runtime.total_tool_calls ?? 0} 次</b>
              </div>
              <div>
                平均每次投研步数:{" "}
                <b>{finops?.agent_runtime.avg_tools_per_thread ?? 0} 步</b>
              </div>
              <div>
                FastMCP 运行工具延迟表见下方
              </div>
            </div>
          </div>
        </div>

        {(finops?.agent_runtime.per_tool_latency.length ?? 0) > 0 && (
          <div className="mt-3 overflow-x-auto rounded-xl border border-zinc-200/80 dark:border-white/[0.10]">
            <table className="w-full text-left font-mono text-[11px]">
              <thead className="bg-zinc-100/85 text-zinc-600 dark:bg-white/[0.06] dark:text-zinc-300">
                <tr>
                  <th className="px-3 py-1.5">MCP 工具名</th>
                  <th className="px-3 py-1.5 text-right">调用次数</th>
                  <th className="px-3 py-1.5 text-right">报错数</th>
                  <th className="px-3 py-1.5 text-right">平均耗时</th>
                  <th className="px-3 py-1.5 text-right">P95 耗时</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200/75 dark:divide-white/[0.08]">
                {finops?.agent_runtime.per_tool_latency.map((t) => (
                  <tr key={t.tool}>
                    <td className="px-3 py-1.5 font-bold">{t.tool}</td>
                    <td className="px-3 py-1.5 text-right">{t.calls}</td>
                    <td className="px-3 py-1.5 text-right text-rose-600 dark:text-rose-400">
                      {t.errors}
                    </td>
                    <td className="px-3 py-1.5 text-right">{t.avg_ms} ms</td>
                    <td className="px-3 py-1.5 text-right">{t.p95_ms} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

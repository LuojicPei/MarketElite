"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  BookmarkCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GitCompare,
  Lock,
  Play,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  XCircle,
} from "lucide-react";
import {
  EvalCaseItem,
  EvalRunDiff,
  EvalRunSummaryRow,
  EvalRunsListResponse,
  MultiTrackEvalReport,
  compareDataPlatformEvalRuns,
  fetchDataPlatformEvalRunDetail,
  pinDataPlatformEvalBaseline,
  runDataPlatformEvalSuite,
} from "@/lib/api";

interface EvalCenterViewProps {
  evalRunsData: EvalRunsListResponse | null;
  phoenixUiUrl: string | null;
  loading: boolean;
  isReadOnly?: boolean;
  adminToken?: string;
  onRefresh: () => void;
}

const TRACK_LABELS: Record<string, { short: string; color: string }> = {
  track1: {
    short: "Track 1 · 确定性基线",
    color: "text-emerald-700 bg-emerald-500/10 border-emerald-500/30 dark:text-emerald-300",
  },
  track2: {
    short: "Track 2 · RAG 忠实度",
    color: "text-sky-700 bg-sky-500/10 border-sky-500/30 dark:text-sky-300",
  },
  track3: {
    short: "Track 3 · Agent 沙箱",
    color: "text-violet-700 bg-violet-500/10 border-violet-500/30 dark:text-violet-300",
  },
  track4: {
    short: "Track 4 · 红队与反事实",
    color: "text-amber-700 bg-amber-500/10 border-amber-500/30 dark:text-amber-300",
  },
};

function renderDeltaBadge(deltaPct: number) {
  if (deltaPct > 0) {
    return (
      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-mono text-[10.5px] font-bold text-emerald-700 dark:text-emerald-300">
        +{deltaPct}%
      </span>
    );
  }
  if (deltaPct < 0) {
    return (
      <span className="rounded-full bg-rose-500/15 px-2 py-0.5 font-mono text-[10.5px] font-bold text-rose-700 dark:text-rose-300">
        {deltaPct}% REGRESSION
      </span>
    );
  }
  return (
    <span className="rounded-full bg-zinc-200/80 px-2 py-0.5 font-mono text-[10.5px] font-semibold text-zinc-700 dark:bg-white/10 dark:text-zinc-300">
      0.0% 持平
    </span>
  );
}

export default function EvalCenterView({
  evalRunsData,
  phoenixUiUrl,
  loading,
  isReadOnly = false,
  adminToken = "",
  onRefresh,
}: EvalCenterViewProps) {
  const [selectedTracks, setSelectedTracks] = useState<string[]>([
    "track1",
    "track2",
    "track3",
    "track4",
  ]);
  const [passK, setPassK] = useState<number>(3);
  const [useLiveJudge, setUseLiveJudge] = useState<boolean>(false);
  const [runNotes, setRunNotes] = useState<string>("");

  const [running, setRunning] = useState<boolean>(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [activeReport, setActiveReport] = useState<MultiTrackEvalReport | null>(
    evalRunsData?.latest_report ?? null
  );
  const [trackFilter, setTrackFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "pass" | "fail">("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null);

  const [compareCandidate, setCompareCandidate] = useState<string>("");
  const [compareBaseline, setCompareBaseline] = useState<string>("");
  const [activeDiff, setActiveDiff] = useState<EvalRunDiff | null>(
    evalRunsData?.baseline_diff ?? null
  );
  const [comparing, setComparing] = useState<boolean>(false);

  const runs: EvalRunSummaryRow[] = useMemo(
    () => evalRunsData?.runs ?? [],
    [evalRunsData]
  );

  useEffect(() => {
    if (evalRunsData?.latest_report) {
      setActiveReport(evalRunsData.latest_report);
    }
    if (evalRunsData?.baseline_diff) {
      setActiveDiff(evalRunsData.baseline_diff);
    }
    if (runs.length > 0) {
      setCompareCandidate((prev) => prev || runs[0].run_key);
      setCompareBaseline(
        (prev) => prev || evalRunsData?.baseline_run_key || runs[runs.length - 1].run_key
      );
    }
  }, [evalRunsData, runs]);

  const toggleTrack = (tid: string) => {
    setSelectedTracks((prev) => {
      if (prev.includes(tid)) {
        return prev.length > 1 ? prev.filter((x) => x !== tid) : prev;
      }
      return [...prev, tid];
    });
  };

  const handleRunSuite = async () => {
    if (isReadOnly) return;
    setRunning(true);
    setActionError(null);
    setActionMsg(null);
    try {
      const report = await runDataPlatformEvalSuite(
        {
          tracks: selectedTracks,
          pass_k_trials: passK,
          use_live_judge: useLiveJudge,
          notes: runNotes.trim(),
        },
        adminToken
      );
      setActiveReport(report);
      setRunNotes("");
      setActionMsg(
        `已完成 ${report.run_key}：${report.passed_cases}/${report.total_cases} (${report.pass_rate_pct}%) · 耗时 ${report.duration_ms}ms`
      );
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "全栈 4-Track 评测运行失败");
    } finally {
      setRunning(false);
    }
  };

  const handleSelectHistoricalRun = async (runKey: string) => {
    setActionError(null);
    try {
      const res = await fetchDataPlatformEvalRunDetail(runKey);
      setActiveReport(res.report);
      setExpandedCaseId(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "加载历史评测详情失败");
    }
  };

  const handlePinBaseline = async (runKey: string) => {
    if (isReadOnly) return;
    setActionError(null);
    setActionMsg(null);
    try {
      await pinDataPlatformEvalBaseline(runKey, adminToken);
      setActionMsg(`已将 ${runKey} 固定为全站 Golden Regression Baseline。`);
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "设置黄金基线失败");
    }
  };

  const handleRunCompare = async () => {
    if (!compareCandidate || !compareBaseline) return;
    setComparing(true);
    setActionError(null);
    try {
      const res = await compareDataPlatformEvalRuns(compareCandidate, compareBaseline);
      setActiveDiff(res.diff);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "版本对比失败");
    } finally {
      setComparing(false);
    }
  };

  const tracks = activeReport?.tracks ?? {};
  const track2Metrics = (tracks.track2?.metrics ?? {}) as Record<string, unknown>;
  const track3Metrics = (tracks.track3?.metrics ?? {}) as Record<string, unknown>;
  const track4Metrics = (tracks.track4?.metrics ?? {}) as Record<string, unknown>;

  const filteredCases: EvalCaseItem[] = useMemo(() => {
    const all = activeReport?.results ?? [];
    const q = searchQuery.trim().toLowerCase();
    return all.filter((c) => {
      if (trackFilter !== "all" && c.track !== trackFilter) return false;
      if (statusFilter === "pass" && !c.passed) return false;
      if (statusFilter === "fail" && c.passed) return false;
      if (q) {
        const hay = `${c.id} ${c.name} ${c.category} ${c.track}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [activeReport, trackFilter, statusFilter, searchQuery]);

  return (
    <div className="space-y-4">
      {/* Control Banner & Track Runner */}
      <div className="velvet-black-block rounded-2xl p-5 text-zinc-950 dark:text-white">
        <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-center">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-600 dark:text-zinc-300">
              4-TRACK EVALUATION ENGINE · PG BASELINE REGRESSION DIFF
            </div>
            <h1 className="mt-1 font-serif text-xl tracking-tight text-zinc-950 dark:text-white sm:text-2xl">
              全栈四轨评测中台：确定性算子 × SEC RAG 忠实度 × Agent pass^k × 红队对抗
            </h1>
            <p className="mt-1 text-xs text-zinc-700 dark:text-zinc-300">
              覆盖真 LangGraph ReAct 沙箱轨迹、死循环哈希拦截、数字幻觉抓包、反事实决策翻转测试与 PostgreSQL <code className="rounded bg-zinc-200/70 px-1 py-0.5 font-mono text-[11px] dark:bg-white/10">eval_runs</code> 历史版本对照。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {activeReport && (
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 py-2 text-right text-zinc-950 dark:border-transparent dark:bg-white">
                <div className="font-mono text-[10px] font-semibold text-zinc-600">
                  ACTIVE RUN ({activeReport.run_key.slice(0, 18)})
                </div>
                <div className="font-mono text-lg font-bold tabular-nums">
                  {activeReport.passed_cases}/{activeReport.total_cases} ({activeReport.pass_rate_pct}%)
                </div>
              </div>
            )}
            <button
              type="button"
              disabled={running || loading || isReadOnly}
              onClick={() => void handleRunSuite()}
              title={isReadOnly ? "访客只读模式已锁定触发跑批，请在页面顶部解锁管理员口令" : undefined}
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-4 py-2.5 font-mono text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-emerald-400 dark:text-zinc-950 dark:hover:bg-emerald-300"
            >
              {isReadOnly ? (
                <Lock className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {isReadOnly
                ? "访客只读 · 需口令运行评测"
                : running
                  ? "四轨执行中..."
                  : "运行全栈 4-Track 评测"}
            </button>
            {phoenixUiUrl && (
              <a
                href={phoenixUiUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white/90 px-3 py-2 font-mono text-xs font-semibold text-zinc-900 hover:bg-zinc-100 dark:border-white/20 dark:bg-white/10 dark:text-white"
              >
                Phoenix <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </div>

        {/* Runner Configuration Strip */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200/80 pt-3 dark:border-white/10">
          <div className="flex flex-wrap items-center gap-1.5">
            {(["track1", "track2", "track3", "track4"] as const).map((tid) => {
              const on = selectedTracks.includes(tid);
              return (
                <button
                  key={tid}
                  type="button"
                  onClick={() => toggleTrack(tid)}
                  className={`rounded-full border px-2.5 py-1 font-mono text-[11px] font-semibold transition ${
                    on
                      ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
                      : "border-zinc-300 bg-white/70 text-zinc-600 dark:border-white/15 dark:bg-white/[0.04] dark:text-zinc-400"
                  }`}
                >
                  {TRACK_LABELS[tid].short}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white/80 px-2.5 py-1 font-mono text-[11px] text-zinc-800 dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-200">
              <span>pass^k:</span>
              <select
                disabled={isReadOnly}
                value={passK}
                onChange={(e) => setPassK(Number(e.target.value))}
                className="bg-transparent font-bold outline-none disabled:opacity-50"
              >
                <option value={3} className="text-zinc-900">k = 3</option>
                <option value={5} className="text-zinc-900">k = 5</option>
              </select>
            </label>

            <button
              type="button"
              disabled={isReadOnly}
              onClick={() => setUseLiveJudge((v) => !v)}
              title={isReadOnly ? "访客只读模式不可开启实盘 LLM Judge" : undefined}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 ${
                useLiveJudge
                  ? "border-sky-500 bg-sky-500/15 text-sky-900 dark:text-sky-200"
                  : "border-zinc-300 bg-white/80 text-zinc-700 dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-300"
              }`}
            >
              <Sparkles className="h-3 w-3" />
              {useLiveJudge ? "Live LLM Judge: ON" : "Live LLM Judge: OFF (零 Token)"}
            </button>

            <input
              type="text"
              disabled={isReadOnly}
              value={runNotes}
              onChange={(e) => setRunNotes(e.target.value)}
              placeholder={isReadOnly ? "只读模式已锁定新增跑批备注" : "本次版本备注（可选）..."}
              className="w-44 rounded-full border border-zinc-300 bg-white/90 px-3 py-1 font-mono text-[11px] text-zinc-900 outline-none placeholder:text-zinc-400 disabled:opacity-50 dark:border-white/15 dark:bg-white/[0.08] dark:text-white"
            />
          </div>
        </div>
      </div>

      {(actionMsg || actionError) && (
        <div
          className={`rounded-xl border px-4 py-2 font-mono text-xs ${
            actionError
              ? "border-rose-500/35 bg-rose-500/10 text-rose-900 dark:text-rose-200"
              : "border-emerald-500/35 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200"
          }`}
        >
          {actionError ?? actionMsg}
        </div>
      )}

      {/* 4 Executive Telemetry KPI Cards */}
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-4">
        <div className="velvet-white-block rounded-2xl p-4">
          <div className="flex items-center justify-between font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
            <span>全栈四轨总通过率</span>
            {activeDiff && renderDeltaBadge(activeDiff.overall_delta_pct)}
          </div>
          <div className="mt-1.5 flex items-baseline gap-2 font-mono">
            <span className="text-2xl font-bold tabular-nums text-zinc-950 dark:text-white">
              {activeReport ? `${activeReport.pass_rate_pct}%` : "—"}
            </span>
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              {activeReport ? `${activeReport.passed_cases}/${activeReport.total_cases} cases` : ""}
            </span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
            Git {activeReport?.git_sha ?? "workspace"} · {activeReport?.duration_ms ?? 0}ms
          </div>
        </div>

        <div className="velvet-white-block rounded-2xl p-4">
          <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
            Track 2 · SEC Hybrid RAG 质量
          </div>
          <div className="mt-1.5 flex items-baseline gap-2 font-mono">
            <span className="text-2xl font-bold tabular-nums text-sky-600 dark:text-sky-400">
              {track2Metrics.avg_faithfulness !== undefined
                ? `${Math.round(Number(track2Metrics.avg_faithfulness) * 100)}%`
                : "—"}
            </span>
            <span className="text-xs text-zinc-600 dark:text-zinc-400">Faithfulness</span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
            Recall@3: <b>{String(track2Metrics.avg_recall_at_3 ?? "—")}</b> · MRR:{" "}
            <b>{String(track2Metrics.avg_mrr ?? "—")}</b>
          </div>
        </div>

        <div className="velvet-white-block rounded-2xl p-4">
          <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
            Track 3 · Agent 沙箱 pass@1 / pass^k
          </div>
          <div className="mt-1.5 flex items-baseline gap-2 font-mono">
            <span className="text-2xl font-bold tabular-nums text-violet-600 dark:text-violet-400">
              {track3Metrics.pass_pow_k_pct !== undefined
                ? `${track3Metrics.pass_pow_k_pct}%`
                : "—"}
            </span>
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              严格 pass^{String(track3Metrics.pass_k_trials ?? passK)}
            </span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
            单次 pass@1: <b>{String(track3Metrics.pass_at_1_pct ?? "—")}%</b> · LangGraph 真图执行
          </div>
        </div>

        <div className="velvet-white-block rounded-2xl p-4">
          <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
            Track 4 · 红队防注入与反事实灵敏度
          </div>
          <div className="mt-1.5 flex items-baseline gap-2 font-mono">
            <span className="text-2xl font-bold tabular-nums text-amber-600 dark:text-amber-400">
              {track4Metrics.safety_block_rate_pct !== undefined
                ? `${track4Metrics.safety_block_rate_pct}%`
                : "—"}
            </span>
            <span className="text-xs text-zinc-600 dark:text-zinc-400">拦截率</span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
            反事实决策翻转率: <b>{String(track4Metrics.counterfactual_flip_rate_pct ?? "—")}%</b>
          </div>
        </div>
      </div>

      {/* Track Scorecard Pills (Click to filter inspector) */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {(["track1", "track2", "track3", "track4"] as const).map((tid) => {
          const ts = tracks[tid];
          const selected = trackFilter === tid;
          return (
            <button
              key={tid}
              type="button"
              onClick={() => setTrackFilter((prev) => (prev === tid ? "all" : tid))}
              className={`rounded-2xl border p-4 text-left transition ${
                selected
                  ? "border-zinc-950 bg-zinc-950 text-white dark:border-white/45 dark:bg-white dark:text-zinc-950"
                  : "velvet-white-block border-transparent text-zinc-900 dark:text-zinc-100"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-sans text-xs font-bold">
                  {ts?.title_zh ?? TRACK_LABELS[tid].short}
                </span>
                <span
                  className={`font-mono text-xs font-bold ${
                    selected
                      ? "text-emerald-400 dark:text-emerald-600"
                      : "text-emerald-600 dark:text-emerald-400"
                  }`}
                >
                  {ts ? `${ts.passed}/${ts.total}` : "—"}
                </span>
              </div>
              <div className="mt-1 font-mono text-[10.5px] opacity-75">
                {ts ? `${ts.pass_rate_pct}% · ${ts.duration_ms}ms · ${ts.subtitle}` : "未包含在当前运行"}
              </div>
            </button>
          );
        })}
      </div>

      {/* Regression Baseline Diff + PostgreSQL eval_runs History */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        {/* Baseline vs Candidate Diff Analyzer */}
        <div className="velvet-white-block rounded-2xl p-5 xl:col-span-7">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/80 pb-3 dark:border-white/10">
            <div className="flex items-center gap-2 font-sans text-sm font-bold text-zinc-950 dark:text-white">
              <GitCompare className="h-4 w-4 text-sky-500" />
              <span>Baseline vs Candidate 回归对比面板</span>
            </div>
            {activeDiff && (
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-mono text-[10.5px] font-bold ${
                  activeDiff.regression_detected
                    ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                    : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                }`}
              >
                {activeDiff.regression_detected ? (
                  <>
                    <AlertTriangle className="h-3 w-3" /> 检测到质量退化
                  </>
                ) : (
                  <>
                    <ShieldCheck className="h-3 w-3" /> 无回归退化 (Safe)
                  </>
                )}
              </span>
            )}
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <select
              value={compareBaseline}
              onChange={(e) => setCompareBaseline(e.target.value)}
              aria-label="Baseline Run"
              className="max-w-[235px] truncate rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 font-mono text-[11px] text-zinc-900 dark:border-white/15 dark:bg-white/[0.06] dark:text-white"
            >
              {runs.map((r) => (
                <option key={`b-${r.run_key}`} value={r.run_key} className="text-zinc-900">
                  Base: {r.run_key.replace("eval-", "")} {r.is_baseline ? "★" : ""} ({r.pass_rate_pct}%)
                </option>
              ))}
            </select>
            <span className="font-mono text-xs text-zinc-500">vs</span>
            <select
              value={compareCandidate}
              onChange={(e) => setCompareCandidate(e.target.value)}
              aria-label="Candidate Run"
              className="max-w-[225px] truncate rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 font-mono text-[11px] text-zinc-900 dark:border-white/15 dark:bg-white/[0.06] dark:text-white"
            >
              {runs.map((r) => (
                <option key={`c-${r.run_key}`} value={r.run_key} className="text-zinc-900">
                  Cand: {r.run_key.replace("eval-", "")} ({r.pass_rate_pct}%)
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={comparing || runs.length < 1}
              onClick={() => void handleRunCompare()}
              className="shrink-0 rounded-lg bg-zinc-950 px-3 py-1.5 font-mono text-[11px] font-semibold text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-zinc-950"
            >
              {comparing ? "对比中..." : "执行 Diff"}
            </button>
          </div>

          {activeDiff ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {Object.entries(activeDiff.track_deltas).map(([tid, td]) => (
                  <div
                    key={tid}
                    className="rounded-xl border border-zinc-200/80 bg-zinc-50/70 p-2.5 dark:border-white/10 dark:bg-white/[0.04]"
                  >
                    <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                      {tid.toUpperCase()}
                    </div>
                    <div className="mt-0.5 flex items-baseline justify-between font-mono text-xs font-bold">
                      <span>{td.candidate_pct}%</span>
                      <span
                        className={
                          td.delta_pct < 0
                            ? "text-rose-600 dark:text-rose-400"
                            : td.delta_pct > 0
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-zinc-500"
                        }
                      >
                        {td.delta_pct > 0 ? `+${td.delta_pct}%` : `${td.delta_pct}%`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 font-mono text-[11px]">
                <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.05] p-3">
                  <div className="font-bold text-rose-700 dark:text-rose-300">
                    新增退化用例 ({activeDiff.newly_regressed.length})
                  </div>
                  {activeDiff.newly_regressed.length === 0 ? (
                    <div className="mt-1 text-zinc-500 dark:text-zinc-400">
                      较基线无新增失败用例
                    </div>
                  ) : (
                    <ul className="mt-1 space-y-1">
                      {activeDiff.newly_regressed.map((c) => (
                        <li key={c.id} className="text-rose-800 dark:text-rose-200">
                          • {c.id} — {c.name}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.05] p-3">
                  <div className="font-bold text-emerald-700 dark:text-emerald-300">
                    新修复用例 ({activeDiff.newly_fixed.length})
                  </div>
                  {activeDiff.newly_fixed.length === 0 ? (
                    <div className="mt-1 text-zinc-500 dark:text-zinc-400">
                      所有历史用例状态稳定保持
                    </div>
                  ) : (
                    <ul className="mt-1 space-y-1">
                      {activeDiff.newly_fixed.map((c) => (
                        <li key={c.id} className="text-emerald-800 dark:text-emerald-200">
                          • {c.id} — {c.name}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-200/70 bg-zinc-50/70 p-4 font-mono text-xs text-zinc-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-400">
              点击上方「运行全栈 4-Track 评测」累积两次以上 PG 记录后，即可实时对比每次提示词/代码改动的用例级回归 Diff。
            </div>
          )}
        </div>

        {/* PostgreSQL eval_runs History Timeline */}
        <div className="velvet-white-block rounded-2xl p-5 xl:col-span-5">
          <div className="mb-3 flex items-center justify-between border-b border-zinc-200/80 pb-3 dark:border-white/10">
            <div className="font-sans text-sm font-bold text-zinc-950 dark:text-white">
              PostgreSQL <code className="rounded bg-zinc-200/70 px-1 py-0.5 font-mono text-xs dark:bg-white/10">eval_runs</code> 持久化流水 ({runs.length})
            </div>
            <span className="font-mono text-[10.5px] text-zinc-500 dark:text-zinc-400">
              支持回溯 &amp; 设为基线
            </span>
          </div>
          <div className="max-h-[250px] space-y-2 overflow-y-auto pr-1">
            {runs.length === 0 ? (
              <div className="py-6 text-center font-mono text-xs text-zinc-500 dark:text-zinc-400">
                暂无持久化流水记录
              </div>
            ) : (
              runs.map((r) => {
                const isViewing = activeReport?.run_key === r.run_key;
                return (
                  <div
                    key={r.run_key}
                    className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs transition ${
                      isViewing
                        ? "border-sky-500/50 bg-sky-500/[0.08]"
                        : "border-zinc-200/80 bg-white/70 dark:border-white/10 dark:bg-white/[0.04]"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold">
                        <button
                          type="button"
                          onClick={() => void handleSelectHistoricalRun(r.run_key)}
                          className="truncate text-zinc-950 hover:underline dark:text-white"
                        >
                          {r.run_key}
                        </button>
                        {r.is_baseline && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/20 px-1.5 py-0.5 text-[9.5px] text-amber-800 dark:text-amber-300">
                            <BookmarkCheck className="h-2.5 w-2.5" /> BASELINE
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                        {r.passed_cases}/{r.total_cases} ({r.pass_rate_pct}%) · {r.duration_ms}ms · {r.trigger_source}
                        {r.notes ? ` · ${r.notes}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void handleSelectHistoricalRun(r.run_key)}
                        className="rounded border border-zinc-300 px-2 py-0.5 font-mono text-[10px] text-zinc-700 hover:bg-zinc-100 dark:border-white/15 dark:text-zinc-200 dark:hover:bg-white/10"
                      >
                        载入
                      </button>
                      {!r.is_baseline && (
                        <button
                          type="button"
                          disabled={isReadOnly}
                          onClick={() => void handlePinBaseline(r.run_key)}
                          title={isReadOnly ? "访客只读模式不可修改黄金基线" : undefined}
                          className="rounded border border-amber-500/40 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-700 hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-40 dark:text-amber-300"
                        >
                          {isReadOnly ? "🔒 基线锁定" : "设为基线"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Granular Case Inspector with Expandable Evidence Drawer */}
      <div className="velvet-white-block rounded-2xl p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/80 pb-3 dark:border-white/10">
          <div className="flex items-center gap-2 font-sans text-sm font-bold text-zinc-950 dark:text-white">
            <Terminal className="h-4 w-4 text-emerald-500" />
            <span>
              用例明细与轨迹取证检查器 ({filteredCases.length} / {activeReport?.total_cases ?? 0})
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-zinc-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="筛选 ID / 关键词..."
                className="w-44 rounded-full border border-zinc-300 bg-white pl-8 pr-3 py-1 font-mono text-[11px] text-zinc-900 outline-none dark:border-white/15 dark:bg-white/[0.06] dark:text-white"
              />
            </div>

            {(["all", "pass", "fail"] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`rounded-full border px-2.5 py-1 font-mono text-[10.5px] font-semibold ${
                  statusFilter === st
                    ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
                    : "border-zinc-300 text-zinc-700 dark:border-white/15 dark:text-zinc-300"
                }`}
              >
                {st === "all" ? "全部状态" : st === "pass" ? "仅通过" : "仅失败"}
              </button>
            ))}
          </div>
        </div>

        <div className="max-h-[500px] space-y-2 overflow-y-auto pr-1">
          {filteredCases.map((c) => {
            const expanded = expandedCaseId === c.id;
            const trackBadge = TRACK_LABELS[c.track] ?? {
              short: c.track,
              color: "text-zinc-700 bg-zinc-100 border-zinc-300",
            };
            return (
              <div
                key={c.id}
                className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white/80 dark:border-white/15 dark:bg-white/[0.04]"
              >
                <button
                  type="button"
                  onClick={() => setExpandedCaseId((prev) => (prev === c.id ? null : c.id))}
                  className="flex w-full flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-left transition hover:bg-zinc-50/80 dark:hover:bg-white/[0.05]"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {expanded ? (
                      <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />
                    )}
                    {c.passed ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <XCircle className="h-4 w-4 text-rose-500" />
                    )}
                    <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${trackBadge.color}`}>
                      {trackBadge.short}
                    </span>
                    <span className="font-mono text-xs font-bold text-zinc-900 dark:text-white">
                      {c.id}
                    </span>
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">
                      {c.name}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
                    <span>{c.category}</span>
                    <span>·</span>
                    <span className="tabular-nums">{c.elapsed_ms} ms</span>
                  </div>
                </button>

                {expanded && (
                  <div className="border-t border-zinc-200/70 bg-zinc-50/85 px-4 py-3 font-mono text-[11px] text-zinc-800 dark:border-white/10 dark:bg-black/30 dark:text-zinc-200">
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                      <div>
                        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                          Observed Metrics
                        </div>
                        <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-zinc-200/80 bg-white/90 p-2.5 text-[10.5px] dark:border-white/10 dark:bg-white/[0.04]">
                          {JSON.stringify(c.observed, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <div className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                          <ShieldAlert className="h-3 w-3" />
                          Trajectory / Citation / Counterfactual Evidence
                        </div>
                        <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-zinc-200/80 bg-white/90 p-2.5 text-[10.5px] dark:border-white/10 dark:bg-white/[0.04]">
                          {JSON.stringify(c.evidence ?? c.observed, null, 2)}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

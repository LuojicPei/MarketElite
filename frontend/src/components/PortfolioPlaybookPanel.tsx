"use client";

import React, { useState } from "react";
import { LayoutGroup, motion } from "framer-motion";
import {
  BookOpenCheck,
  Check,
  Edit3,
  Pin,
  PinOff,
  Plus,
  Power,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  EpisodicMemoryRecord,
  PortfolioPostmortemReport,
  TradeReviewRecord,
  createPlaybookRule,
  deletePlaybookRule,
  recallEpisodicMemories,
  runPortfolioPostmortem,
  updatePlaybookRule,
} from "@/lib/api";
import { formatQuadrantOutcome, formatRegimeLabel } from "@/lib/i18n";
import { MarkdownReport } from "./MarkdownReport";
import SpotlightBlock from "@/components/SpotlightBlock";

const EASE_EXPO = [0.16, 1, 0.3, 1] as const;

interface PortfolioPlaybookPanelProps {
  reviews: TradeReviewRecord[];
  memories: EpisodicMemoryRecord[];
  onRefreshData: () => Promise<void>;
  onBanner: (msg: string) => void;
  onError: (msg: string) => void;
}

export default function PortfolioPlaybookPanel({
  reviews,
  memories,
  onRefreshData,
  onBanner,
  onError,
}: PortfolioPlaybookPanelProps) {
  const [activeTab, setActiveTab] = useState<"reviews" | "playbook" | "coach">("reviews");
  const [memQuery, setMemQuery] = useState("");
  const [recalledMemories, setRecalledMemories] = useState<EpisodicMemoryRecord[] | null>(null);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);

  // Create rule composer
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newSymbol, setNewSymbol] = useState("ALL");
  const [newRegime, setNewRegime] = useState("RISK_OFF_STRESS");
  const [newTitle, setNewTitle] = useState("");
  const [newLesson, setNewLesson] = useState("");
  const [creatingRule, setCreatingRule] = useState(false);

  // Inline edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editLesson, setEditLesson] = useState("");

  // Portfolio Post-Mortem Coach state
  const [postmortemLoading, setPostmortemLoading] = useState(false);
  const [postmortem, setPostmortem] = useState<PortfolioPostmortemReport | null>(null);
  const [adoptedTitles, setAdoptedTitles] = useState<Set<string>>(new Set());

  const displayedMemories = recalledMemories ?? memories;

  const handleMemorySearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!memQuery.trim()) {
      setRecalledMemories(null);
      return;
    }
    try {
      const res = await recallEpisodicMemories(memQuery.trim());
      setRecalledMemories(res.memories);
      setActiveTab("playbook");
    } catch (err) {
      onError(err instanceof Error ? err.message : "检索铁律记忆库失败");
    }
  };

  const handleCreateRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || newLesson.trim().length < 4 || creatingRule) return;
    setCreatingRule(true);
    try {
      await createPlaybookRule({
        symbol: newSymbol.trim().toUpperCase() || "ALL",
        regime_label: newRegime,
        title: newTitle.trim(),
        lesson_text: newLesson.trim(),
        is_pinned: true,
        is_active: true,
      });
      setNewTitle("");
      setNewLesson("");
      setShowCreateForm(false);
      setRecalledMemories(null);
      onBanner("已新增并置顶 Playbook 交易铁律（后续 Agent 调研与风控审批将优先注入该约束）。");
      await onRefreshData();
    } catch (err) {
      onError(err instanceof Error ? err.message : "创建铁律失败");
    } finally {
      setCreatingRule(false);
    }
  };

  const handleTogglePin = async (m: EpisodicMemoryRecord) => {
    setBusyRuleId(`pin-${m.id}`);
    try {
      const nextPinned = !Boolean(m.is_pinned);
      await updatePlaybookRule(m.id, { is_pinned: nextPinned });
      setRecalledMemories((prev) =>
        prev ? prev.map((x) => (x.id === m.id ? { ...x, is_pinned: nextPinned } : x)) : null
      );
      onBanner(
        nextPinned
          ? `已置顶铁律「${m.title}」：Investigator 与 Risk Critic 将优先强制引用。`
          : `已取消置顶「${m.title}」。`
      );
      await onRefreshData();
    } catch (err) {
      onError(err instanceof Error ? err.message : "置顶更新失败");
    } finally {
      setBusyRuleId(null);
    }
  };

  const handleToggleActive = async (m: EpisodicMemoryRecord) => {
    setBusyRuleId(`act-${m.id}`);
    try {
      const nextActive = m.is_active === false ? true : false;
      await updatePlaybookRule(m.id, { is_active: nextActive });
      setRecalledMemories((prev) =>
        prev ? prev.map((x) => (x.id === m.id ? { ...x, is_active: nextActive } : x)) : null
      );
      onBanner(
        nextActive
          ? `已恢复启用「${m.title}」。`
          : `已停用过期经验「${m.title}」，该条不再参与未来 Agent 上下文召回。`
      );
      await onRefreshData();
    } catch (err) {
      onError(err instanceof Error ? err.message : "状态切换失败");
    } finally {
      setBusyRuleId(null);
    }
  };

  const handleSaveEdit = async (memoryId: number) => {
    if (!editTitle.trim() || editLesson.trim().length < 4) return;
    setBusyRuleId(`edit-${memoryId}`);
    try {
      await updatePlaybookRule(memoryId, {
        title: editTitle.trim(),
        lesson_text: editLesson.trim(),
      });
      setEditingId(null);
      setRecalledMemories(null);
      onBanner("已更新 Playbook 规则正文。");
      await onRefreshData();
    } catch (err) {
      onError(err instanceof Error ? err.message : "保存修改失败");
    } finally {
      setBusyRuleId(null);
    }
  };

  const handleDeleteRule = async (memoryId: number) => {
    setBusyRuleId(`del-${memoryId}`);
    try {
      await deletePlaybookRule(memoryId);
      setRecalledMemories((prev) => (prev ? prev.filter((x) => x.id !== memoryId) : null));
      onBanner("已移除该条记忆规则。");
      await onRefreshData();
    } catch (err) {
      onError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setBusyRuleId(null);
    }
  };

  const handleRunCoach = async () => {
    setPostmortemLoading(true);
    try {
      const res = await runPortfolioPostmortem({ use_fast_llm: true, lookback_limit: 30 });
      setPostmortem(res);
      setActiveTab("coach");
    } catch (err) {
      onError(err instanceof Error ? err.message : "周期组合体检失败");
    } finally {
      setPostmortemLoading(false);
    }
  };

  const handleAdoptCandidate = async (cand: {
    symbol: string;
    regime_label: string;
    title: string;
    lesson_text: string;
  }) => {
    setBusyRuleId(`adopt-${cand.title}`);
    try {
      await createPlaybookRule({
        symbol: cand.symbol,
        regime_label: cand.regime_label,
        title: cand.title,
        lesson_text: cand.lesson_text,
        is_pinned: true,
        is_active: true,
      });
      setAdoptedTitles((prev) => new Set([...Array.from(prev), cand.title]));
      onBanner(`已将教练建议「${cand.title}」写入并置顶至 Playbook 铁律库！`);
      await onRefreshData();
    } catch (err) {
      onError(err instanceof Error ? err.message : "采纳规则失败");
    } finally {
      setBusyRuleId(null);
    }
  };

  return (
    <SpotlightBlock tone="gallery" className="p-5 xl:col-span-6">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/70 pb-3 dark:border-white/10">
        <div>
          <h3 className="font-serif text-lg font-semibold tracking-tight text-zinc-950 sm:text-xl dark:text-white">
            4-象限归因、AI 周期教练与 Playbook 交易铁律库
          </h3>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            置顶铁律 🔒 自动高优先级注入 Investigator / 红蓝对抗 / Risk Critic；停用后立即屏蔽
          </p>
        </div>

        <LayoutGroup id="playbook-tab-group">
        <div className="inline-flex rounded-lg bg-zinc-100/90 p-0.5 font-mono text-[11px] dark:bg-white/[0.06]">
          <button
            type="button"
            onClick={() => setActiveTab("reviews")}
            className={`relative rounded-md px-2.5 py-1 transition-colors ${
              activeTab === "reviews"
                ? "font-semibold text-white dark:text-zinc-950"
                : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
            }`}
          >
            {activeTab === "reviews" && (
              <motion.span
                layoutId="playbook-tab-pill"
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                className="absolute inset-0 rounded-md bg-zinc-950 dark:bg-white"
              />
            )}
            <span className="relative z-10">复盘归因 ({reviews.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("playbook")}
            className={`relative rounded-md px-2.5 py-1 transition-colors ${
              activeTab === "playbook"
                ? "font-semibold text-white dark:text-zinc-950"
                : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
            }`}
          >
            {activeTab === "playbook" && (
              <motion.span
                layoutId="playbook-tab-pill"
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                className="absolute inset-0 rounded-md bg-zinc-950 dark:bg-white"
              />
            )}
            <span className="relative z-10">Playbook 铁律 ({displayedMemories.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("coach")}
            className={`relative rounded-md px-2.5 py-1 transition-colors ${
              activeTab === "coach"
                ? "font-semibold text-white dark:text-zinc-950"
                : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
            }`}
          >
            {activeTab === "coach" && (
              <motion.span
                layoutId="playbook-tab-pill"
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                className="absolute inset-0 rounded-md bg-emerald-600 dark:bg-emerald-500"
              />
            )}
            <span className="relative z-10">周期教练</span>
          </button>
        </div>
        </LayoutGroup>
      </div>

      {/* Search Bar & Add Playbook Trigger */}
      {activeTab !== "coach" && (
        <form onSubmit={handleMemorySearch} className="mt-3 flex flex-wrap gap-2">
          <input
            type="text"
            value={memQuery}
            onChange={(e) => setMemQuery(e.target.value)}
            placeholder="检索铁律与历史教训（例如：NVDA Zero Gamma RISK_OFF stop_loss...）"
            className="min-w-[200px] flex-1 rounded-xl border border-zinc-200/90 bg-white px-3 py-1.5 text-xs text-zinc-950 placeholder:text-zinc-400 dark:border-white/15 dark:bg-white/[0.05] dark:text-white dark:placeholder:text-zinc-500"
          />
          <button
            type="submit"
            className="rounded-xl bg-zinc-950 px-3 py-1.5 font-mono text-[11px] font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            检索记忆
          </button>
          {recalledMemories !== null && (
            <button
              type="button"
              onClick={() => {
                setMemQuery("");
                setRecalledMemories(null);
              }}
              className="rounded-xl bg-zinc-100 px-2.5 py-1.5 font-mono text-[11px] text-zinc-600 dark:bg-white/10 dark:text-zinc-300"
            >
              重置
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setActiveTab("playbook");
              setShowCreateForm((v) => !v);
            }}
            className="inline-flex items-center gap-1 rounded-xl bg-emerald-500/[0.15] px-3 py-1.5 font-mono text-[11px] font-semibold text-emerald-800 hover:bg-emerald-500/25 dark:text-emerald-300"
          >
            <Plus className="h-3.5 w-3.5" />
            新增铁律
          </button>
        </form>
      )}

      {/* Inline Create Iron Rule Form */}
      {activeTab === "playbook" && showCreateForm && (
        <form
          onSubmit={handleCreateRule}
          className="mt-3 space-y-2 rounded-xl bg-zinc-100/80 p-3 dark:bg-white/[0.05]"
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input
              type="text"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
              placeholder="标的 (如 ALL / NVDA)"
              className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-white"
            />
            <select
              value={newRegime}
              onChange={(e) => setNewRegime(e.target.value)}
              className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-white"
            >
              <option value="RISK_OFF_STRESS">RISK_OFF_STRESS (避险逆风)</option>
              <option value="HIGH_VOL_TRANSITION">HIGH_VOL_TRANSITION (高波切换)</option>
              <option value="LIQUIDITY_TIGHTENING">LIQUIDITY_TIGHTENING (紧缩)</option>
              <option value="GOLDILOCKS_EXPANSION">GOLDILOCKS_EXPANSION (顺风扩张)</option>
              <option value="NEUTRAL_ROTATION">NEUTRAL_ROTATION (中性轮动)</option>
            </select>
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="铁律标题（如 负伽马禁止追高）"
              required
              className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-white"
            />
          </div>
          <textarea
            rows={2}
            value={newLesson}
            onChange={(e) => setNewLesson(e.target.value)}
            placeholder="具体约束规则正文（Agent 与 Risk Critic 将直接读取执行）..."
            required
            className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-white"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreateForm(false)}
              className="rounded-lg px-3 py-1 font-mono text-[11px] text-zinc-600 dark:text-zinc-300"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={creatingRule}
              className="rounded-lg bg-zinc-950 px-3.5 py-1 font-mono text-[11px] font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-zinc-950"
            >
              {creatingRule ? "写入中..." : "保存并置顶铁律"}
            </button>
          </div>
        </form>
      )}

      {/* Body Area */}
      <div className="mt-3 max-h-[340px] overflow-y-auto pr-1">
        {activeTab === "reviews" ? (
          <motion.div
            key="pb-reviews"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.26, ease: EASE_EXPO }}
            className="space-y-2.5"
          >
            {reviews.length === 0 ? (
              <p className="py-8 text-center text-xs text-zinc-500 dark:text-zinc-400">
                暂无单笔复盘记录。点击左侧任意交易的「生成 4-象限复盘」即可创建。
              </p>
            ) : (
              reviews.map((r) => {
                const q = formatQuadrantOutcome(r.quadrant_outcome);
                return (
                  <div
                    key={r.id}
                    className="rounded-xl bg-zinc-50/85 p-3.5 dark:bg-white/[0.04]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span
                        className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
                          q.tone === "good"
                            ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
                            : q.tone === "warn"
                              ? "bg-amber-500/15 text-amber-800 dark:text-amber-300"
                              : "bg-rose-500/15 text-rose-800 dark:text-rose-300"
                        }`}
                      >
                        {q.label}
                      </span>
                      <span className="font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
                        #{r.paper_trade_id} {r.symbol} · {r.horizon}
                        {r.alpha_vs_spy_pct !== null && r.alpha_vs_spy_pct !== undefined
                          ? ` · Alpha vs SPY ${r.alpha_vs_spy_pct >= 0 ? "+" : ""}${r.alpha_vs_spy_pct.toFixed(2)}%`
                          : ""}
                      </span>
                    </div>
                    <div className="mt-2">
                      <MarkdownReport content={r.lessons_markdown} compact />
                    </div>
                  </div>
                );
              })
            )}
          </motion.div>
        ) : activeTab === "playbook" ? (
          <motion.div
            key="pb-playbook"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.26, ease: EASE_EXPO }}
            className="space-y-2.5"
          >
            {displayedMemories.length === 0 ? (
              <p className="py-8 text-center text-xs text-zinc-500 dark:text-zinc-400">
                暂无匹配的 Playbook 交易铁律或记忆记录；可点击「新增铁律」或运行「周期教练」一键生成。
              </p>
            ) : (
              displayedMemories.map((m) => {
                const isPinned = Boolean(m.is_pinned);
                const isActive = m.is_active !== false;
                const isEditing = editingId === m.id;
                return (
                  <div
                    key={m.id}
                    className={`space-y-2 rounded-xl p-3.5 transition ${
                      !isActive
                        ? "bg-zinc-50/50 opacity-60 dark:bg-white/[0.02]"
                        : isPinned
                          ? "border border-amber-500/35 bg-amber-500/[0.08]"
                          : "bg-zinc-50/85 dark:bg-white/[0.04]"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px]">
                        {isPinned && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-400 px-2 py-0.5 font-bold text-zinc-950">
                            <Pin className="h-2.5 w-2.5" />
                            置顶铁律
                          </span>
                        )}
                        {!isActive && (
                          <span className="rounded-full bg-zinc-300/70 px-2 py-0.5 text-zinc-700 dark:bg-white/10 dark:text-zinc-300">
                            已停用
                          </span>
                        )}
                        <span className="font-bold text-zinc-950 dark:text-white">{m.title}</span>
                      </div>

                      <div className="flex flex-wrap items-center gap-1 font-mono text-[10px]">
                        <span className="mr-1 text-zinc-500 dark:text-zinc-400">
                          {m.symbol} · {formatRegimeLabel(m.regime_label).split(" · ")[0]}
                        </span>
                        <button
                          type="button"
                          disabled={busyRuleId === `pin-${m.id}`}
                          onClick={() => handleTogglePin(m)}
                          title={isPinned ? "取消置顶" : "置顶为硬性铁律"}
                          className={`rounded-md px-1.5 py-0.5 transition ${
                            isPinned
                              ? "bg-amber-500/20 text-amber-800 dark:text-amber-300"
                              : "bg-white/80 text-zinc-600 hover:text-zinc-950 dark:bg-white/10 dark:text-zinc-300"
                          }`}
                        >
                          {isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                        </button>
                        <button
                          type="button"
                          disabled={busyRuleId === `act-${m.id}`}
                          onClick={() => handleToggleActive(m)}
                          title={isActive ? "停用该条（不再注入 AI 上下文）" : "重新启用该条"}
                          className={`rounded-md px-1.5 py-0.5 transition ${
                            isActive
                              ? "bg-emerald-500/[0.15] text-emerald-700 dark:text-emerald-300"
                              : "bg-zinc-200 text-zinc-600 dark:bg-white/10 dark:text-zinc-400"
                          }`}
                        >
                          <Power className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(m.id);
                            setEditTitle(m.title);
                            setEditLesson(m.lesson_text);
                          }}
                          title="编辑文本"
                          className="rounded-md bg-white/80 px-1.5 py-0.5 text-zinc-600 hover:text-zinc-950 dark:bg-white/10 dark:text-zinc-300"
                        >
                          <Edit3 className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          disabled={busyRuleId === `del-${m.id}`}
                          onClick={() => handleDeleteRule(m.id)}
                          title="删除规则"
                          className="rounded-md bg-rose-500/[0.12] px-1.5 py-0.5 text-rose-700 hover:bg-rose-500/25 dark:text-rose-300"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    {isEditing ? (
                      <div className="space-y-1.5">
                        <input
                          type="text"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1 text-xs font-semibold text-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-white"
                        />
                        <textarea
                          rows={2}
                          value={editLesson}
                          onChange={(e) => setEditLesson(e.target.value)}
                          className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-white"
                        />
                        <div className="flex justify-end gap-2 font-mono text-[10.5px]">
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="text-zinc-500"
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            disabled={busyRuleId === `edit-${m.id}`}
                            onClick={() => handleSaveEdit(m.id)}
                            className="rounded-md bg-zinc-950 px-2.5 py-0.5 font-semibold text-white dark:bg-white dark:text-zinc-950"
                          >
                            保存更改
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
                        {m.lesson_text}
                      </p>
                    )}
                  </div>
                );
              })
            )}
          </motion.div>
        ) : (
          <motion.div
            key="pb-coach"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.26, ease: EASE_EXPO }}
            className="space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-zinc-50/90 p-3 dark:bg-white/[0.04]">
              <div className="text-xs text-zinc-700 dark:text-zinc-300">
                综合诊断近期所有已平仓交易在不同宏观体制下的胜率表现，自动提炼可置顶的 Playbook 铁律。
              </div>
              <button
                type="button"
                disabled={postmortemLoading}
                onClick={handleRunCoach}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-zinc-950 px-3.5 py-1.5 font-mono text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-zinc-950"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {postmortemLoading ? "诊断推演中..." : "生成周期组合全面体检"}
              </button>
            </div>

            {postmortem && (
              <div className="space-y-3">
                <div className="rounded-xl bg-zinc-50/90 p-3.5 dark:bg-white/[0.04]">
                  <MarkdownReport content={postmortem.summary_markdown} compact />
                </div>

                {postmortem.regime_breakdown.length > 0 && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {postmortem.regime_breakdown.map((rb) => (
                      <div
                        key={rb.regime_label}
                        className="flex items-center justify-between rounded-xl bg-zinc-50/85 px-3 py-2 font-mono text-[11px] dark:bg-white/[0.04]"
                      >
                        <div>
                          <div className="font-bold text-zinc-900 dark:text-white">
                            {formatRegimeLabel(rb.regime_label).split(" · ")[0]}
                          </div>
                          <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                            {rb.trades} 笔 · 胜率 {rb.win_rate_pct}% · 纪律 {rb.avg_process_score}
                          </div>
                        </div>
                        <span
                          className={`font-bold ${
                            rb.net_pnl >= 0
                              ? "text-emerald-700 dark:text-emerald-400"
                              : "text-rose-700 dark:text-rose-400"
                          }`}
                        >
                          {rb.net_pnl >= 0 ? "+" : ""}${rb.net_pnl.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {postmortem.recommended_rules.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 font-mono text-[10.5px] font-semibold uppercase text-zinc-600 dark:text-zinc-300">
                      <BookOpenCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      教练建议沉淀为 Playbook 铁律 ({postmortem.recommended_rules.length})
                    </div>
                    {postmortem.recommended_rules.map((cand) => {
                      const adopted = adoptedTitles.has(cand.title);
                      return (
                        <div
                          key={cand.title}
                          className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-3"
                        >
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="font-mono text-xs font-bold text-zinc-950 dark:text-white">
                              {cand.title}{" "}
                              <span className="text-[10px] font-normal text-zinc-500 dark:text-zinc-400">
                                ({cand.symbol} · {cand.regime_label})
                              </span>
                            </div>
                            <p className="text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
                              {cand.lesson_text}
                            </p>
                          </div>
                          <button
                            type="button"
                            disabled={adopted || busyRuleId === `adopt-${cand.title}`}
                            onClick={() => handleAdoptCandidate(cand)}
                            className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 font-mono text-[10.5px] font-semibold transition ${
                              adopted
                                ? "bg-emerald-500/20 text-emerald-800 dark:text-emerald-300"
                                : "bg-zinc-950 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950"
                            }`}
                          >
                            {adopted ? <Check className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                            {adopted ? "已置顶采纳" : "采纳并置顶"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}
      </div>
    </SpotlightBlock>
  );
}

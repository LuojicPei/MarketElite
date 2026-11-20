"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  History,
  Lock,
  PlayCircle,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import {
  PaperLedgerResponse,
  RiskApprovalCard,
  TradeResumeResponse,
  fetchTradeCheckpoint,
  fetchTradeLedger,
  proposeTrade,
  resumeTrade,
} from "@/lib/api";

interface RiskCriticPanelProps {
  defaultSymbol: string;
  prefillSide?: "buy" | "sell";
  prefillQty?: number;
  prefillRationale?: string;
}

export default function RiskCriticPanel({
  defaultSymbol,
  prefillSide = "buy",
  prefillQty = 200,
  prefillRationale = "",
}: RiskCriticPanelProps) {
  const [symbol, setSymbol] = useState<string>(defaultSymbol);
  const [side, setSide] = useState<"buy" | "sell">(prefillSide);
  const [proposedQty, setProposedQty] = useState<string>(String(prefillQty));
  const [riskPct, setRiskPct] = useState<string>("1.0");
  const [entryPrice, setEntryPrice] = useState<string>("");
  const [stopLoss, setStopLoss] = useState<string>("");
  const [takeProfit, setTakeProfit] = useState<string>("");
  const [rationale, setRationale] = useState<string>(prefillRationale);

  const [submitting, setSubmitting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ledger, setLedger] = useState<PaperLedgerResponse | null>(null);
  const [approvalCard, setApprovalCard] = useState<RiskApprovalCard | null>(null);
  const [requiresAdmin, setRequiresAdmin] = useState<boolean>(false);
  const [adminToken, setAdminToken] = useState<string>("");
  const [approvedQty, setApprovedQty] = useState<string>("");
  const [editStopLoss, setEditStopLoss] = useState<string>("");
  const [editTakeProfit, setEditTakeProfit] = useState<string>("");
  const [resumeNote, setResumeNote] = useState<string>("");
  const [receipt, setReceipt] = useState<TradeResumeResponse | null>(null);

  useEffect(() => {
    setSymbol(defaultSymbol);
  }, [defaultSymbol]);

  useEffect(() => {
    setSide(prefillSide);
    setProposedQty(String(prefillQty));
    if (prefillRationale) {
      setRationale(prefillRationale);
    }
  }, [prefillSide, prefillQty, prefillRationale]);

  const refreshLedger = useCallback(async () => {
    try {
      const data = await fetchTradeLedger();
      setLedger(data);
      setRequiresAdmin(data.requires_admin_token);
    } catch {
      // Non-fatal while panel opens
    }
  }, []);

  useEffect(() => {
    refreshLedger();
  }, [refreshLedger]);

  const syncCardEditableFields = (card: RiskApprovalCard) => {
    setApprovalCard(card);
    setApprovedQty(String(card.risk_sizing.recommended_qty || 1));
    setEditStopLoss(String(card.risk_sizing.stop_loss_price));
    setEditTakeProfit(String(card.risk_sizing.take_profit_price));
    setReceipt(null);
  };

  const handlePropose = async (e: React.FormEvent) => {
    e.preventDefault();
    const qtyNum = Number(proposedQty);
    if (!symbol.trim() || !Number.isFinite(qtyNum) || qtyNum <= 0 || submitting) return;

    setSubmitting(true);
    setError(null);
    setReceipt(null);
    try {
      const res = await proposeTrade({
        symbol: symbol.trim().toUpperCase(),
        side,
        proposed_qty: qtyNum,
        entry_price: entryPrice ? Number(entryPrice) : null,
        stop_loss_price: stopLoss ? Number(stopLoss) : null,
        take_profit_price: takeProfit ? Number(takeProfit) : null,
        risk_budget_pct: Number(riskPct) || 1.0,
        rationale: rationale.trim(),
      });
      setRequiresAdmin(res.requires_admin_token);
      syncCardEditableFields(res.approval_card);
      await refreshLedger();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Risk Critic proposal failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleResume = async (decision: "approve" | "reject") => {
    if (!approvalCard || resuming) return;
    setResuming(true);
    setError(null);
    try {
      const res = await resumeTrade(
        {
          thread_id: approvalCard.thread_id,
          decision,
          approved_qty: decision === "approve" ? Number(approvedQty) || 1 : null,
          stop_loss_price: editStopLoss ? Number(editStopLoss) : null,
          take_profit_price: editTakeProfit ? Number(editTakeProfit) : null,
          note: resumeNote.trim(),
        },
        adminToken
      );
      setReceipt(res);
      if (res.error) {
        setError(res.error);
      }
      await refreshLedger();
    } catch (err) {
      setError(err instanceof Error ? err.message : "HITL resume failed");
    } finally {
      setResuming(false);
    }
  };

  const handleLoadCheckpoint = async (threadId: string) => {
    setError(null);
    try {
      const cp = await fetchTradeCheckpoint(threadId);
      setRequiresAdmin(cp.requires_admin_token);
      if (cp.approval_card) {
        syncCardEditableFields(cp.approval_card);
      }
      if (!cp.is_suspended && cp.execution_status) {
        setReceipt({
          status: cp.execution_status,
          thread_id: cp.thread_id,
          error: null,
          receipt: cp.execution_receipt ?? {},
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load suspended checkpoint");
    }
  };

  const verdictBadgeStyle = (verdict: string) => {
    if (verdict === "REJECTED_HIGH_RISK") {
      return "border-rose-500/40 bg-rose-500/15 text-rose-300";
    }
    if (verdict === "CAUTION_REDUCED") {
      return "border-amber-500/40 bg-amber-500/15 text-amber-200";
    }
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
  };

  const pendingThreads = (ledger?.paper_trades ?? []).filter((t) => t.status === "pending_hitl");

  return (
    <div className="space-y-4">
      {/* Live Account & Checkpointer Status Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 font-mono text-[11px]">
        <div className="flex flex-wrap items-center gap-3 text-zinc-300">
          <span className="inline-flex items-center gap-1.5">
            <Database className="h-3.5 w-3.5 text-emerald-400" />
            Checkpointer:{" "}
            <strong className="text-white">
              {ledger?.checkpointer === "postgres" ? "AsyncPostgresSaver" : "InMemory"}
            </strong>
          </span>
          <span className="text-zinc-600">|</span>
          <span>
            Alpaca Paper Equity:{" "}
            <strong className="text-white">
              {ledger?.account ? `$${ledger.account.equity.toLocaleString()}` : "—"}
            </strong>
          </span>
          <span>
            Buying Power:{" "}
            <strong className="text-zinc-200">
              {ledger?.account ? `$${ledger.account.buying_power.toLocaleString()}` : "—"}
            </strong>
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-0.5 text-[10px] text-zinc-300">
            <Lock className="h-3 w-3 text-amber-400" />
            {requiresAdmin ? "Admin Lock Active" : "Paper Mode Ready"}
          </span>
          <button
            type="button"
            onClick={refreshLedger}
            className="rounded-lg border border-zinc-800 p-1 text-zinc-400 transition hover:border-zinc-600 hover:text-white"
            title="Refresh Alpaca Paper Ledger"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Proposal Form */}
      <form
        onSubmit={handlePropose}
        className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"
      >
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-200">
            Step 1 · 发起交易提案 Trade Proposal (隔离上下文风控)
          </span>
          <span className="font-mono text-[10px] text-zinc-500">
            强制 1% 风险预算 · Bracket 止盈止损
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="NVDA"
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs uppercase text-white focus:border-zinc-400 focus:outline-none"
          />
          <select
            value={side}
            onChange={(e) => setSide(e.target.value as "buy" | "sell")}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 font-mono text-xs text-white focus:border-zinc-400 focus:outline-none"
          >
            <option value="buy">BUY 做多</option>
            <option value="sell">SELL 做空</option>
          </select>
          <input
            type="number"
            min="1"
            step="1"
            value={proposedQty}
            onChange={(e) => setProposedQty(e.target.value)}
            placeholder="拟买股数 Qty"
            title="拟买股数 Proposed Qty"
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-white focus:border-zinc-400 focus:outline-none"
          />
          <input
            type="number"
            step="0.1"
            min="0.1"
            max="2.0"
            value={riskPct}
            onChange={(e) => setRiskPct(e.target.value)}
            placeholder="Risk %"
            title="单笔最大账户风险预算 %"
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-white focus:border-zinc-400 focus:outline-none"
          />
          <input
            type="number"
            step="0.01"
            value={stopLoss}
            onChange={(e) => setStopLoss(e.target.value)}
            placeholder="Stop Loss (自动)"
            title="止损价 (留空按 ATR / Put Wall 自动推导)"
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-white placeholder:text-zinc-500 focus:border-zinc-400 focus:outline-none"
          />
          <input
            type="number"
            step="0.01"
            value={takeProfit}
            onChange={(e) => setTakeProfit(e.target.value)}
            placeholder="Take Profit (自动)"
            title="止盈价 (留空按 2R / Call Wall 自动推导)"
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-white placeholder:text-zinc-500 focus:border-zinc-400 focus:outline-none"
          />
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="number"
            step="0.01"
            value={entryPrice}
            onChange={(e) => setEntryPrice(e.target.value)}
            placeholder="参考入场价 (留空用现价)"
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-white placeholder:text-zinc-500 focus:border-zinc-400 focus:outline-none sm:w-48"
          />
          <input
            type="text"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="简述交易逻辑（Risk Critic 将刻意隔离情绪、只查硬数据与财报日历反驳你）"
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-white placeholder:text-zinc-500 focus:border-zinc-400 focus:outline-none"
          />
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-white px-4 py-2 font-mono text-xs font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-50"
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            {submitting ? "Critic 审查中..." : "唤醒 Risk Critic 审查"}
          </button>
        </div>
      </form>

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 font-mono text-xs text-rose-200">
          {error}
        </div>
      )}

      {/* Suspended HITL Approval Card */}
      {approvalCard && (
        <div className="space-y-4 rounded-2xl border border-zinc-700 bg-zinc-950 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${verdictBadgeStyle(
                  approvalCard.critique.verdict
                )}`}
              >
                {approvalCard.critique.verdict}
              </span>
              <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-0.5 font-mono text-[10px] text-zinc-300">
                {approvalCard.critique.regime_alignment}
              </span>
              <span className="font-mono text-xs font-semibold text-white">
                {approvalCard.side.toUpperCase()} {approvalCard.symbol}
              </span>
            </div>
            <span className="font-mono text-[10px] text-zinc-500">
              thread: {approvalCard.thread_id}
            </span>
          </div>

          {/* 4-Pillar Deterministic Risk Sizing */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3">
              <div className="font-mono text-[10px] text-zinc-400">
                风控缩仓 1% Cap Qty
              </div>
              <div className="mt-1 font-mono text-sm font-bold text-white tabular-nums">
                {approvalCard.risk_sizing.proposed_qty} →{" "}
                <span className="text-emerald-400">
                  {approvalCard.risk_sizing.recommended_qty} 股
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3">
              <div className="font-mono text-[10px] text-zinc-400">
                1% 最大风险预算 Max Risk
              </div>
              <div className="mt-1 font-mono text-sm font-bold text-white tabular-nums">
                ${approvalCard.risk_sizing.max_risk_dollars.toLocaleString()}
              </div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3">
              <div className="font-mono text-[10px] text-zinc-400">
                参考入场 / 止损 / 止盈
              </div>
              <div className="mt-1 font-mono text-xs font-semibold text-zinc-100 tabular-nums">
                ${approvalCard.risk_sizing.entry_price} · SL $
                {approvalCard.risk_sizing.stop_loss_price} · TP $
                {approvalCard.risk_sizing.take_profit_price}
              </div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3">
              <div className="font-mono text-[10px] text-zinc-400">盈亏比 R:R / 名义本金</div>
              <div className="mt-1 font-mono text-sm font-bold text-white tabular-nums">
                {approvalCard.risk_sizing.risk_reward_ratio}x · $
                {approvalCard.risk_sizing.estimated_notional.toLocaleString()}
              </div>
            </div>
          </div>

          {/* Critique & Counter Arguments */}
          <div className="rounded-xl border border-zinc-800 bg-white p-4 text-zinc-950">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Risk Critic 对抗审查意见 (Adversarial Devil&apos;s Advocate)
            </div>
            <p className="mt-1 text-xs font-medium leading-relaxed text-zinc-900">
              {approvalCard.critique.summary}
            </p>
            <ul className="mt-2.5 space-y-1 text-xs text-zinc-700">
              {approvalCard.critique.counter_arguments.map((arg, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                  <span>{arg}</span>
                </li>
              ))}
            </ul>
            {approvalCard.critique.falsification_trigger && (
              <div className="mt-2.5 rounded-lg bg-zinc-100 px-3 py-1.5 font-mono text-[11px] text-zinc-800">
                证伪止损条件 Falsification: {approvalCard.critique.falsification_trigger}
              </div>
            )}
          </div>

          {/* Upcoming Catalysts & Deterministic Warnings */}
          {((approvalCard.upcoming_catalysts?.length ?? 0) > 0 ||
            approvalCard.risk_sizing.warnings.length > 0) && (
            <div className="space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 font-mono text-[11px] text-amber-200">
              {approvalCard.risk_sizing.warnings.map((w, idx) => (
                <div key={`w-${idx}`}>• {w}</div>
              ))}
              {approvalCard.upcoming_catalysts?.map((ev, idx) => (
                <div key={`ev-${idx}`}>
                  • Catalyst [{ev.event_time.slice(0, 10)}]: {ev.title} ({ev.impact})
                </div>
              ))}
            </div>
          )}

          {/* HITL Human Gate Actions */}
          {!receipt ? (
            <div className="space-y-3 border-t border-zinc-800 pt-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div>
                  <label className="block font-mono text-[10px] text-zinc-400">
                    确认股数 (≤ {approvalCard.risk_sizing.max_safe_qty})
                  </label>
                  <input
                    type="number"
                    min="1"
                    max={Math.max(1, approvalCard.risk_sizing.max_safe_qty)}
                    value={approvedQty}
                    onChange={(e) => setApprovedQty(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-white"
                  />
                </div>
                <div>
                  <label className="block font-mono text-[10px] text-zinc-400">
                    止损 Stop Loss
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={editStopLoss}
                    onChange={(e) => setEditStopLoss(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-white"
                  />
                </div>
                <div>
                  <label className="block font-mono text-[10px] text-zinc-400">
                    止盈 Take Profit
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={editTakeProfit}
                    onChange={(e) => setEditTakeProfit(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-white"
                  />
                </div>
                <div>
                  <label className="block font-mono text-[10px] text-zinc-400">
                    {requiresAdmin ? "Admin Token (必填)" : "审批备注 Note"}
                  </label>
                  {requiresAdmin ? (
                    <input
                      type="password"
                      value={adminToken}
                      onChange={(e) => setAdminToken(e.target.value)}
                      placeholder="X-Admin-Token"
                      className="mt-1 w-full rounded-lg border border-amber-500/40 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-white"
                    />
                  ) : (
                    <input
                      type="text"
                      value={resumeNote}
                      onChange={(e) => setResumeNote(e.target.value)}
                      placeholder="Optional note"
                      className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-white"
                    />
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={resuming}
                  onClick={() => handleResume("reject")}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2 font-mono text-xs text-rose-200 transition hover:bg-rose-500/20 disabled:opacity-50"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  驳回提案 Reject
                </button>
                <button
                  type="button"
                  disabled={resuming || approvalCard.risk_sizing.max_safe_qty < 1}
                  onClick={() => handleResume("approve")}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 font-mono text-xs font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50"
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {resuming
                    ? "Submitting Bracket..."
                    : "确认下达 Alpaca Bracket 单 (Approve & Execute)"}
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3.5 font-mono text-xs text-emerald-200">
              <div className="flex items-center gap-1.5 font-semibold">
                <CheckCircle2 className="h-4 w-4" />
                HITL Checkpoint Resumed · Status: {receipt.status}
              </div>
              <pre className="mt-2 max-h-36 overflow-auto text-[11px] text-emerald-100/90">
                {JSON.stringify(receipt.receipt, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Suspended Pending Checkpoints & Paper Ledger */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3.5">
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
            <History className="h-3.5 w-3.5" />
            挂起待批 &amp; 模拟单记录 ({ledger?.paper_trades.length ?? 0})
          </div>
          <div className="mt-2.5 max-h-44 space-y-2 overflow-y-auto">
            {pendingThreads.length === 0 && (ledger?.paper_trades.length ?? 0) === 0 ? (
              <div className="font-mono text-[11px] text-zinc-500">
                暂无提案记录；上方提交任意标的即可体验 Postgres Checkpoint 挂起与恢复。
              </div>
            ) : (
              (ledger?.paper_trades ?? []).slice(0, 8).map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-2 font-mono text-[11px]"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-white">
                      {t.side.toUpperCase()} {t.qty} {t.symbol}{" "}
                      <span className="text-[10px] font-normal text-zinc-400">[{t.status}]</span>
                    </div>
                    <div className="truncate text-[10px] text-zinc-500">
                      SL ${t.stop_loss_price ?? "—"} · TP ${t.take_profit_price ?? "—"}
                    </div>
                  </div>
                  {t.thread_id && t.status === "pending_hitl" && (
                    <button
                      type="button"
                      onClick={() => handleLoadCheckpoint(t.thread_id!)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[10px] font-semibold text-zinc-950 hover:bg-zinc-200"
                    >
                      <PlayCircle className="h-3 w-3" />
                      恢复审批
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">
            Alpaca Paper 实时持仓与挂单 ({ledger?.positions.length ?? 0} pos /{" "}
            {ledger?.orders.length ?? 0} ord)
          </div>
          <div className="mt-2.5 max-h-44 space-y-1.5 overflow-y-auto font-mono text-[11px]">
            {ledger?.alpaca_error && (
              <div className="text-amber-300">{ledger.alpaca_error}</div>
            )}
            {(ledger?.positions ?? []).map((p) => (
              <div
                key={p.symbol}
                className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 px-2.5 py-1.5"
              >
                <span className="text-white">
                  {p.symbol} × {p.qty}
                </span>
                <span className={p.unrealized_pl >= 0 ? "text-emerald-400" : "text-rose-400"}>
                  {p.unrealized_pl >= 0 ? "+" : ""}${p.unrealized_pl.toFixed(2)}
                </span>
              </div>
            ))}
            {(ledger?.orders ?? []).slice(0, 5).map((o) => (
              <div
                key={o.id}
                className="flex items-center justify-between rounded-lg border border-zinc-800/70 px-2.5 py-1.5 text-[10px] text-zinc-400"
              >
                <span>
                  {o.side.toUpperCase()} {o.qty} {o.symbol} ({o.order_class})
                </span>
                <span className="text-zinc-200">{o.status}</span>
              </div>
            ))}
            {!ledger?.positions.length && !ledger?.orders.length && !ledger?.alpaca_error && (
              <div className="text-zinc-500">当前 Alpaca Paper 模拟盘尚无持仓或订单。</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

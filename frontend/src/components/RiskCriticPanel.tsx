"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Database,
  History,
  Lock,
  PlayCircle,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
  XCircle,
} from "lucide-react";
import {
  PaperLedgerResponse,
  RiskApprovalCard,
  RiskPrefillDraft,
  RiskStructureResponse,
  TradeResumeResponse,
  fetchRiskStructure,
  fetchTradeCheckpoint,
  fetchTradeLedger,
  proposeTrade,
  resumeTrade,
} from "@/lib/api";
import { SETTINGS_UPDATED_EVENT } from "@/lib/clientSettings";
import BracketPriceLadder from "@/components/BracketPriceLadder";

const EASE_EXPO = [0.16, 1, 0.3, 1] as const;

interface RiskCriticPanelProps {
  defaultSymbol: string;
  prefillSide?: "buy" | "sell";
  prefillQty?: number;
  prefillRationale?: string;
  prefillDraft?: RiskPrefillDraft | null;
}

function currencySymbol(ccy?: string | null): string {
  const code = (ccy || "USD").toUpperCase();
  if (code === "GBP") return "£";
  if (code === "EUR") return "€";
  return "$";
}

function fmtAccountMoney(val: number | undefined | null, ccy?: string | null): string {
  if (val === undefined || val === null || Number.isNaN(val)) return "—";
  return `${currencySymbol(ccy)}${val.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtRiskVerdictZh(verdict: string): string {
  const v = (verdict || "").toUpperCase();
  if (v === "REJECTED_HIGH_RISK") return "高危警报 · 建议观望或大幅缩仓";
  if (v === "CAUTION_REDUCED") return "谨慎限额 · 严格按安全上限开仓";
  if (v === "APPROVED_WITH_DISCIPLINE" || v === "APPROVED") return "风控通过 · 纪律执行";
  return verdict;
}

function fmtRegimeAlignZh(align: string): string {
  const a = (align || "").toUpperCase();
  if (a.includes("FAVORABLE") || a.includes("ALIGNED") || a.includes("TAILWIND")) {
    return "顺应宏观体制";
  }
  if (a.includes("HEADWIND") || a.includes("STRESS") || a.includes("ADVERSE") || a.includes("MISALIGN")) {
    return "宏观体制逆风 · 防守为主";
  }
  if (a.includes("NEUTRAL") || a.includes("CONTESTED") || a.includes("MIXED")) {
    return "震荡中性环境";
  }
  return align;
}

function fmtTradeStatusZh(status: string): string {
  const s = (status || "").toLowerCase();
  if (s === "pending_hitl") return "待签字";
  if (s === "filled") return "已成交";
  if (s === "closed") return "已平仓";
  if (s === "canceled" || s === "cancelled") return "已撤单";
  if (s === "rejected") return "已拒单";
  if (s === "new" || s === "accepted" || s === "pending_new" || s === "held" || s === "submitted") {
    return "挂单/生效中";
  }
  return status;
}

function fmtRiskSideZh(side: string): string {
  return (side || "").toLowerCase() === "sell" ? "卖出" : "买入";
}

export default function RiskCriticPanel({
  defaultSymbol,
  prefillSide = "buy",
  prefillQty = 50,
  prefillRationale = "",
  prefillDraft = null,
}: RiskCriticPanelProps) {
  const [symbol, setSymbol] = useState<string>(defaultSymbol);
  const [side, setSide] = useState<"buy" | "sell">(prefillSide);
  const [proposedQty, setProposedQty] = useState<string>(String(prefillQty));
  const [riskPct, setRiskPct] = useState<string>("1.0");
  const [entryPrice, setEntryPrice] = useState<string>("");
  const [stopLoss, setStopLoss] = useState<string>("");
  const [takeProfit, setTakeProfit] = useState<string>("");
  const [rationale, setRationale] = useState<string>(prefillRationale);
  const [showAdvancedParams, setShowAdvancedParams] = useState<boolean>(
    Boolean(prefillRationale || prefillDraft?.stopLoss || prefillDraft?.takeProfit || prefillDraft?.rationale)
  );
  const [formCollapsedDuringReview, setFormCollapsedDuringReview] = useState<boolean>(true);
  const [bottomTab, setBottomTab] = useState<"queue" | "positions">("queue");

  const [submitting, setSubmitting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ledger, setLedger] = useState<PaperLedgerResponse | null>(null);
  const [riskPreview, setRiskPreview] = useState<RiskStructureResponse | null>(null);
  const [structureError, setStructureError] = useState<string | null>(null);
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

  useEffect(() => {
    if (!prefillDraft) return;
    setSymbol(prefillDraft.symbol.toUpperCase());
    setSide(prefillDraft.side);
    if (prefillDraft.qty) setProposedQty(String(prefillDraft.qty));
    setEntryPrice(prefillDraft.entryPrice ? String(prefillDraft.entryPrice) : "");
    setStopLoss(prefillDraft.stopLoss ? String(prefillDraft.stopLoss) : "");
    setTakeProfit(prefillDraft.takeProfit ? String(prefillDraft.takeProfit) : "");
    if (prefillDraft.riskBudgetPct) setRiskPct(String(prefillDraft.riskBudgetPct));
    if (prefillDraft.rationale !== undefined) setRationale(prefillDraft.rationale);
    if (prefillDraft.rationale || prefillDraft.stopLoss || prefillDraft.takeProfit) {
      setShowAdvancedParams(true);
    }
    setReceipt(null);
  }, [prefillDraft]);

  useEffect(() => {
    const cleanSym = symbol.trim().toUpperCase();
    if (!cleanSym) {
      setRiskPreview(null);
      setStructureError(null);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetchRiskStructure(cleanSym, {
          side,
          risk_budget_pct: Number(riskPct) || 1.0,
          entry_price: Number(entryPrice) > 0 ? Number(entryPrice) : null,
          stop_loss: Number(stopLoss) > 0 ? Number(stopLoss) : null,
          take_profit: Number(takeProfit) > 0 ? Number(takeProfit) : null,
          proposed_qty: Number(proposedQty) > 0 ? Number(proposedQty) : 50,
        });
        setRiskPreview(res);
        setStructureError(null);
      } catch (err) {
        setRiskPreview(null);
        setStructureError(
          err instanceof Error
            ? err.message
            : `暂未找到 ${cleanSym} 的行情基准数据，请先在首页搜索入库或核对代码`
        );
      }
    }, 260);
    return () => window.clearTimeout(timer);
  }, [symbol, side, riskPct, entryPrice, stopLoss, takeProfit, proposedQty, ledger?.broker]);

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
    void refreshLedger();
    window.addEventListener(SETTINGS_UPDATED_EVENT, refreshLedger);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, refreshLedger);
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
      setFormCollapsedDuringReview(true);
      await refreshLedger();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Risk Critic 预审失败");
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
      setError(err instanceof Error ? err.message : "人工审批恢复失败");
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
      setError(err instanceof Error ? err.message : "加载挂起风控断点失败");
    }
  };

  const verdictBadgeStyle = (verdict: string) => {
    if (verdict === "REJECTED_HIGH_RISK") {
      return "border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300";
    }
    if (verdict === "CAUTION_REDUCED") {
      return "border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-200";
    }
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  };

  const pendingThreads = (ledger?.paper_trades ?? []).filter((t) => t.status === "pending_hitl");
  const acctCcy = ledger?.currency || ledger?.account?.currency || "USD";
  const isReadOnlyBroker = Boolean(ledger?.read_only);
  const brokerShort = ledger?.broker_profile?.short_name || ledger?.broker_label || "本地模拟盘";
  const manualTicket =
    receipt?.receipt && typeof receipt.receipt === "object"
      ? ((("manual_reference_ticket" in receipt.receipt
          ? receipt.receipt.manual_reference_ticket
          : null) ??
          ("manual_t212_ticket" in receipt.receipt ? receipt.receipt.manual_t212_ticket : null)) as
          | Record<string, unknown>
          | null)
      : null;

  return (
    <div className="space-y-4">
      {/* Live Account & Checkpointer Status Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-zinc-100/80 px-3.5 py-2.5 font-mono text-[11px] dark:bg-white/[0.05]">
        <div className="flex flex-wrap items-center gap-2 text-zinc-700 dark:text-zinc-300">
          <span className="inline-flex items-center gap-1.5">
            <Wallet className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <strong className="text-zinc-950 dark:text-white">
              {ledger?.broker_profile?.display_name || ledger?.broker_label || "本地拟真模拟盘"}
            </strong>
          </span>
          <span className="text-zinc-300 dark:text-zinc-600">|</span>
          <span>
            净值{" "}
            <strong className="text-zinc-950 dark:text-white">
              {fmtAccountMoney(ledger?.account?.equity, acctCcy)}
            </strong>
          </span>
          <span>
            现金{" "}
            <strong className="text-zinc-800 dark:text-zinc-200">
              {fmtAccountMoney(ledger?.account?.buying_power, acctCcy)}
            </strong>
          </span>
          <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400">
            <Database className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
            {ledger?.checkpointer === "postgres" ? "断点已持久化" : "内存断点"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-white/85 px-2.5 py-0.5 text-[10px] text-zinc-700 dark:bg-white/10 dark:text-zinc-200">
            <Lock className="h-3 w-3 text-amber-600 dark:text-amber-400" />
            {isReadOnlyBroker
              ? `${brokerShort} 只读 · 演练记入拟真台账`
              : requiresAdmin
                ? "需管理员令牌"
                : "人工批准后入账"}
          </span>
          <button
            type="button"
            onClick={() => void refreshLedger()}
            className="rounded-lg bg-white/85 p-1 text-zinc-600 transition hover:text-zinc-950 dark:bg-white/10 dark:text-zinc-300 dark:hover:text-white"
            title="刷新账户与台账数据"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Proposal Form (Compact during active HITL review, progressive disclosure by default) */}
      {approvalCard && formCollapsedDuringReview ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-zinc-200/80 bg-zinc-50/75 px-4 py-2.5 font-mono text-xs dark:border-white/10 dark:bg-white/[0.03]">
          <span className="text-zinc-600 dark:text-zinc-300">
            当前正在审核草案：<strong className="text-zinc-950 dark:text-white">{approvalCard.side.toUpperCase()} {approvalCard.symbol}</strong>（已聚焦下方风控标尺与审批闸门）
          </span>
          <button
            type="button"
            onClick={() => setFormCollapsedDuringReview(false)}
            className="inline-flex items-center gap-1 rounded-full bg-zinc-950/5 px-3 py-1 text-[11px] font-semibold text-zinc-800 hover:bg-zinc-950/10 dark:bg-white/10 dark:text-zinc-100"
          >
            <ChevronDown className="h-3 w-3" />
            新建/修改提案参数
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            void handlePropose(e);
          }}
          className="space-y-3 rounded-2xl border border-zinc-200/80 bg-zinc-50/85 p-4 dark:border-white/10 dark:bg-white/[0.04]"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-serif text-lg font-semibold tracking-tight text-zinc-950 sm:text-xl dark:text-white">
                风控体检与模拟下单（1% 安全预算约束）
              </h3>
              <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-300">
                仅填代码、方向与股数即可，AI 自动核验安全仓位上限并生成 ATR / 期权墙止盈止损
              </p>
            </div>
            {approvalCard && (
              <button
                type="button"
                onClick={() => setFormCollapsedDuringReview(true)}
                className="font-mono text-[11px] text-zinc-500 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
              >
                收起表单专注审批
              </button>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2.5">
            <div>
              <label className="mb-1 block font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                代码 Symbol
              </label>
              <input
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                placeholder="NVDA"
                className="w-full rounded-xl border border-zinc-200/90 bg-white px-2.5 py-2 font-mono text-xs font-bold uppercase text-zinc-950 focus:border-emerald-500 focus:outline-none dark:border-white/15 dark:bg-zinc-900/90 dark:text-white"
              />
            </div>
            <div>
              <label className="mb-1 block font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                方向 Side
              </label>
              <select
                value={side}
                onChange={(e) => setSide(e.target.value as "buy" | "sell")}
                className="w-full rounded-xl border border-zinc-200/90 bg-white px-2.5 py-2 font-mono text-xs text-zinc-950 focus:border-emerald-500 focus:outline-none dark:border-white/15 dark:bg-zinc-900/90 dark:text-white"
              >
                <option value="buy">BUY 做多</option>
                <option value="sell">SELL 卖出/减仓</option>
              </select>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                <span>股数 Qty</span>
                {riskPreview && (
                  <button
                    type="button"
                    onClick={() =>
                      setProposedQty(String(Math.max(1, riskPreview.risk_sizing.recommended_qty)))
                    }
                    className="font-semibold text-emerald-700 hover:underline dark:text-emerald-400"
                  >
                    安全 {riskPreview.risk_sizing.recommended_qty}股
                  </button>
                )}
              </div>
              <input
                type="number"
                min="1"
                step="1"
                value={proposedQty}
                onChange={(e) => setProposedQty(e.target.value)}
                placeholder="Qty"
                className="w-full rounded-xl border border-zinc-200/90 bg-white px-2.5 py-2 font-mono text-xs text-zinc-950 focus:border-emerald-500 focus:outline-none dark:border-white/15 dark:bg-zinc-900/90 dark:text-white"
              />
            </div>
          </div>

          {/* Live Bracket Price Ladder Preview OR Clear Ticker Miss Warning */}
          {structureError && !riskPreview && !approvalCard && (
            <div className="rounded-xl border border-amber-500/35 bg-amber-500/[0.08] px-3 py-2 font-mono text-[11px] text-amber-900 dark:text-amber-200">
              {structureError}
            </div>
          )}
          {riskPreview && !approvalCard && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  结构化止盈 / 止损标尺实时预演 ({riskPreview.symbol})
                </span>
                <span className="text-[11px] font-normal text-zinc-500 dark:text-zinc-400">
                  自动对齐 ATR 与期权 Call/Put 墙 · 预算 {riskPct}% (Max{" "}
                  {fmtAccountMoney(riskPreview.risk_sizing.max_risk_dollars, acctCcy)})
                </span>
              </div>
              <BracketPriceLadder
                symbol={riskPreview.symbol}
                side={riskPreview.side}
                spotPrice={riskPreview.structure.spot_price}
                entryPrice={riskPreview.risk_sizing.entry_price}
                stopLossPrice={riskPreview.risk_sizing.stop_loss_price}
                takeProfitPrice={riskPreview.risk_sizing.take_profit_price}
                putWall={riskPreview.structure.put_wall}
                zeroGamma={riskPreview.structure.zero_gamma}
                callWall={riskPreview.structure.call_wall}
                compact
              />
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
            <button
              type="button"
              onClick={() => setShowAdvancedParams((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-200/70 px-2.5 py-1 font-mono text-[11.5px] font-semibold text-zinc-800 transition hover:bg-zinc-200 dark:bg-white/[0.08] dark:text-zinc-100 dark:hover:bg-white/[0.14]"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {showAdvancedParams ? "收起高级止损/预算/理由参数" : "自定义风险预算 · SL/TP · 理由（可选）"}
              {showAdvancedParams ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            {riskPreview && (
              <span className="font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                名义本金{" "}
                <strong className="text-zinc-950 dark:text-white">
                  {fmtAccountMoney(riskPreview.risk_sizing.estimated_notional, acctCcy)}
                </strong>
              </span>
            )}
          </div>

          {showAdvancedParams && (
            <div className="space-y-2.5 rounded-xl border border-zinc-200/80 bg-white/80 p-3 dark:border-white/10 dark:bg-black/25">
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <div>
                  <label className="mb-1 block font-mono text-[10.5px] text-zinc-600 dark:text-zinc-400">
                    风险预算 Risk %
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="2.0"
                    value={riskPct}
                    onChange={(e) => setRiskPct(e.target.value)}
                    placeholder="1.0"
                    className="w-full rounded-xl border border-zinc-200/90 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-950 focus:border-emerald-500 focus:outline-none dark:border-white/15 dark:bg-zinc-900/90 dark:text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-mono text-[10.5px] text-zinc-600 dark:text-zinc-400">
                    参考入场价
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={entryPrice}
                    onChange={(e) => setEntryPrice(e.target.value)}
                    placeholder="留空取现价"
                    className="w-full rounded-xl border border-zinc-200/90 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-950 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-white/15 dark:bg-zinc-900/90 dark:text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-mono text-[10.5px] text-zinc-600 dark:text-zinc-400">
                    止损 Stop Loss
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={stopLoss}
                    onChange={(e) => setStopLoss(e.target.value)}
                    placeholder="自动 ATR/墙"
                    className="w-full rounded-xl border border-zinc-200/90 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-950 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-white/15 dark:bg-zinc-900/90 dark:text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-mono text-[10.5px] text-zinc-600 dark:text-zinc-400">
                    止盈 Take Profit
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={takeProfit}
                    onChange={(e) => setTakeProfit(e.target.value)}
                    placeholder="自动 2R/墙"
                    className="w-full rounded-xl border border-zinc-200/90 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-950 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-white/15 dark:bg-zinc-900/90 dark:text-white"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-zinc-50 px-3 py-1.5 dark:bg-white/[0.04]">
                <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px]">
                  <span className="text-zinc-600 dark:text-zinc-400">风险预算档位:</span>
                  {["0.5", "1.0", "1.5", "2.0"].map((pctVal) => {
                    const active = Number(riskPct) === Number(pctVal);
                    return (
                      <button
                        key={pctVal}
                        type="button"
                        onClick={() => setRiskPct(pctVal)}
                        className={`rounded-full px-2.5 py-0.5 font-semibold transition ${
                          active
                            ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                            : "bg-zinc-200/70 text-zinc-700 hover:bg-zinc-200 dark:bg-white/[0.08] dark:text-zinc-200"
                        }`}
                      >
                        {pctVal}%
                      </button>
                    );
                  })}
                </div>
              </div>

              <input
                type="text"
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                placeholder="交易理由（可选：Risk Critic 将剥离情绪偏见进行反驳审核）"
                className="w-full rounded-xl border border-zinc-200/90 bg-white px-3 py-1.5 text-xs text-zinc-950 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-white/15 dark:bg-zinc-900/90 dark:text-white"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-zinc-950 px-4 py-2.5 font-mono text-xs font-semibold text-white shadow-sm transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400"
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            {submitting ? "CRO 正在对抗审查与验算..." : "唤醒 Risk Critic 独立审查"}
          </button>
        </form>
      )}

      {error && (
        <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-3 font-mono text-xs text-rose-800 dark:text-rose-200">
          {error}
        </div>
      )}

      {/* Elevated Spotlight: Suspended HITL Approval Card */}
      <AnimatePresence>
      {approvalCard && (
        <motion.div
          key={approvalCard.thread_id}
          initial={{ opacity: 0, y: 12, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.3, ease: EASE_EXPO }}
          className="space-y-4 rounded-2xl border border-emerald-500/40 bg-white p-5 shadow-md ring-1 ring-emerald-500/20 dark:border-emerald-400/35 dark:bg-white/[0.06] dark:ring-emerald-400/15"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${verdictBadgeStyle(
                  approvalCard.critique.verdict
                )}`}
              >
                {fmtRiskVerdictZh(approvalCard.critique.verdict)}
              </span>
              <span className="rounded-full bg-white px-2.5 py-0.5 font-mono text-[10px] text-zinc-700 dark:bg-white/10 dark:text-zinc-200">
                {fmtRegimeAlignZh(approvalCard.critique.regime_alignment)}
              </span>
              <span className="font-mono text-xs font-bold text-zinc-950 dark:text-white">
                {fmtRiskSideZh(approvalCard.side)} {approvalCard.symbol}
              </span>
            </div>
            <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
              断点 ID: {approvalCard.thread_id}
            </span>
          </div>

          {/* 4-Pillar Deterministic Risk Sizing */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <div className="rounded-xl bg-white/90 p-3 dark:bg-white/[0.05]">
              <div className="font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                1% 风控安全股数
              </div>
              <div className="mt-1 font-mono text-sm font-bold tabular-nums text-zinc-950 dark:text-white">
                {approvalCard.risk_sizing.proposed_qty} →{" "}
                <span className="text-emerald-700 dark:text-emerald-400">
                  {approvalCard.risk_sizing.recommended_qty} 股
                </span>
              </div>
            </div>
            <div className="rounded-xl bg-white/90 p-3 dark:bg-white/[0.05]">
              <div className="font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                最大风险预算 Max Risk
              </div>
              <div className="mt-1 font-mono text-sm font-bold tabular-nums text-zinc-950 dark:text-white">
                {fmtAccountMoney(approvalCard.risk_sizing.max_risk_dollars, acctCcy)}
              </div>
            </div>
            <div className="rounded-xl bg-white/90 p-3 dark:bg-white/[0.05]">
              <div className="font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                入场 / 止损 / 止盈
              </div>
              <div className="mt-1 font-mono text-xs font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                ${approvalCard.risk_sizing.entry_price} · SL $
                {approvalCard.risk_sizing.stop_loss_price} · TP $
                {approvalCard.risk_sizing.take_profit_price}
              </div>
            </div>
            <div className="rounded-xl bg-white/90 p-3 dark:bg-white/[0.05]">
              <div className="font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                盈亏比 R:R / 名义本金
              </div>
              <div className="mt-1 font-mono text-sm font-bold tabular-nums text-zinc-950 dark:text-white">
                {approvalCard.risk_sizing.risk_reward_ratio}x · $
                {approvalCard.risk_sizing.estimated_notional.toLocaleString()}
              </div>
            </div>
          </div>

          {/* Live Bracket Price Ladder inside HITL Gate */}
          <BracketPriceLadder
            symbol={approvalCard.symbol}
            side={approvalCard.side}
            spotPrice={approvalCard.structure_levels?.spot_price}
            entryPrice={approvalCard.risk_sizing.entry_price}
            stopLossPrice={
              Number(editStopLoss) > 0 ? Number(editStopLoss) : approvalCard.risk_sizing.stop_loss_price
            }
            takeProfitPrice={
              Number(editTakeProfit) > 0
                ? Number(editTakeProfit)
                : approvalCard.risk_sizing.take_profit_price
            }
            putWall={approvalCard.structure_levels?.put_wall ?? riskPreview?.structure.put_wall}
            zeroGamma={approvalCard.structure_levels?.zero_gamma ?? riskPreview?.structure.zero_gamma}
            callWall={approvalCard.structure_levels?.call_wall ?? riskPreview?.structure.call_wall}
          />

          {/* Critique & Counter Arguments (Fixed dark contrast!) */}
          <div className="rounded-xl bg-white/90 p-4 text-zinc-950 dark:bg-white/[0.06] dark:text-zinc-100">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Risk Critic 对抗审查意见 (Adversarial CRO)
            </div>
            <p className="mt-1.5 text-xs font-medium leading-relaxed text-zinc-900 dark:text-zinc-100">
              {approvalCard.critique.summary}
            </p>
            <ul className="mt-2.5 space-y-1.5 text-xs text-zinc-700 dark:text-zinc-300">
              {approvalCard.critique.counter_arguments.map((arg, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span>{arg}</span>
                </li>
              ))}
            </ul>
            {approvalCard.critique.falsification_trigger && (
              <div className="mt-3 rounded-lg bg-zinc-100/90 px-3 py-1.5 font-mono text-[11px] text-zinc-800 dark:bg-white/[0.08] dark:text-amber-200">
                证伪止损条件 Falsification: {approvalCard.critique.falsification_trigger}
              </div>
            )}
          </div>

          {/* Upcoming Catalysts & Deterministic Warnings */}
          {((approvalCard.upcoming_catalysts?.length ?? 0) > 0 ||
            approvalCard.risk_sizing.warnings.length > 0) && (
            <div className="space-y-1 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3.5 py-2.5 font-mono text-[11px] text-amber-900 dark:text-amber-200">
              {approvalCard.risk_sizing.warnings.map((w, idx) => (
                <div key={`w-${idx}`}>• {w}</div>
              ))}
              {approvalCard.upcoming_catalysts?.map((ev, idx) => (
                <div key={`ev-${idx}`}>
                  • 催化预警 [{ev.event_time.slice(0, 10)}]: {ev.title} ({ev.impact})
                </div>
              ))}
            </div>
          )}

          {/* HITL Human Gate Actions */}
          {!receipt ? (
            <div className="space-y-3 border-t border-zinc-200/70 pt-3 dark:border-white/10">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div>
                  <label className="block font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                    确认股数 (≤ {approvalCard.risk_sizing.max_safe_qty})
                  </label>
                  <input
                    type="number"
                    min="1"
                    max={Math.max(1, approvalCard.risk_sizing.max_safe_qty)}
                    value={approvedQty}
                    onChange={(e) => setApprovedQty(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                    止损 Stop Loss
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={editStopLoss}
                    onChange={(e) => setEditStopLoss(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                    止盈 Take Profit
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={editTakeProfit}
                    onChange={(e) => setEditTakeProfit(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                    {requiresAdmin ? "Admin Token (必填)" : "审批备注 Note"}
                  </label>
                  {requiresAdmin ? (
                    <input
                      type="password"
                      value={adminToken}
                      onChange={(e) => setAdminToken(e.target.value)}
                      placeholder="X-Admin-Token"
                      className="mt-1 w-full rounded-lg border border-amber-500/40 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-950 dark:bg-zinc-900 dark:text-white"
                    />
                  ) : (
                    <input
                      type="text"
                      value={resumeNote}
                      onChange={(e) => setResumeNote(e.target.value)}
                      placeholder="备注..."
                      className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-white"
                    />
                  )}
                </div>
              </div>

              {Number(approvedQty) > Math.max(1, approvalCard.risk_sizing.max_safe_qty) && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-1.5 font-mono text-[11px] text-rose-800 dark:text-rose-200">
                  <span>
                    确认股数 {approvedQty} 超出当前 1% 安全限额上限 ({Math.max(1, approvalCard.risk_sizing.max_safe_qty)} 股)
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setApprovedQty(String(Math.max(1, approvalCard.risk_sizing.max_safe_qty)))
                    }
                    className="rounded-full bg-rose-600 px-2.5 py-0.5 text-[10px] font-bold text-white hover:bg-rose-500"
                  >
                    一键调回 {Math.max(1, approvalCard.risk_sizing.max_safe_qty)} 股
                  </button>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={resuming}
                  onClick={() => handleResume("reject")}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2 font-mono text-xs text-rose-800 transition hover:bg-rose-500/20 disabled:opacity-50 dark:text-rose-200"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  驳回提案
                </button>
                <button
                  type="button"
                  disabled={
                    resuming ||
                    approvalCard.risk_sizing.max_safe_qty < 1 ||
                    !(Number(approvedQty) > 0) ||
                    Number(approvedQty) > Math.max(1, approvalCard.risk_sizing.max_safe_qty)
                  }
                  onClick={() => handleResume("approve")}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 font-mono text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50 dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400"
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {resuming
                    ? "正在执行入账..."
                    : isReadOnlyBroker
                      ? `确认并记入拟真演练单 (+ 生成 ${brokerShort} 参考单)`
                      : "确认批准并执行拟真委托"}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3.5 font-mono text-xs text-emerald-900 dark:text-emerald-200">
              <div className="flex items-center gap-1.5 font-semibold">
                <CheckCircle2 className="h-4 w-4" />
                人工闸门已放行 · 执行状态: {receipt.status}
              </div>
              {manualTicket && (
                <div className="rounded-lg bg-white/80 p-2.5 text-[11px] text-zinc-900 dark:bg-black/30 dark:text-zinc-100">
                  <div className="font-bold text-emerald-700 dark:text-emerald-300">
                    {ledger?.broker_profile?.ticket_label || `${brokerShort} 手动参考委托单（当前处于只读/导入模式）`}
                  </div>
                  <div className="mt-1">
                    代码 <strong>{String(manualTicket.ticker)}</strong> ·{" "}
                    <strong>{String(manualTicket.side)}</strong>{" "}
                    <strong>{String(manualTicket.quantity)}</strong> 股 · 参考价 $
                    {String(manualTicket.entry_ref)} · 止损 ${String(manualTicket.stop_loss_price)} ·
                    止盈 ${String(manualTicket.take_profit_price)}
                  </div>
                </div>
              )}
              <pre className="max-h-32 overflow-auto text-[11px] text-emerald-800 dark:text-emerald-100/90">
                {JSON.stringify(receipt.receipt, null, 2)}
              </pre>
            </div>
          )}
        </motion.div>
      )}
      </AnimatePresence>

      {/* Compact Tabbed Drawer for Suspended HITL Checkpoints & Live Positions */}
      <div className="rounded-2xl border border-zinc-200/80 bg-zinc-50/70 p-3.5 dark:border-white/10 dark:bg-white/[0.03]">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/70 pb-2.5 dark:border-white/10">
          <LayoutGroup id="risk-bottom-group">
          <div className="inline-flex rounded-xl bg-zinc-200/75 p-1 font-mono text-xs dark:bg-white/10">
            <button
              type="button"
              onClick={() => setBottomTab("queue")}
              className={`relative inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition-colors ${
                bottomTab === "queue"
                  ? "font-semibold text-white dark:text-zinc-950"
                  : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
              }`}
            >
              {bottomTab === "queue" && (
                <motion.span
                  layoutId="risk-bottom-tab-pill"
                  transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-zinc-950 shadow-sm dark:bg-white"
                />
              )}
              <History className="relative z-10 h-3.5 w-3.5" />
              <span className="relative z-10">待批断点 &amp; 台账 ({ledger?.paper_trades.length ?? 0})</span>
              {pendingThreads.length > 0 && (
                <span className="relative z-10 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-zinc-950">
                  {pendingThreads.length} 待批
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setBottomTab("positions")}
              className={`relative rounded-lg px-3 py-1.5 transition-colors ${
                bottomTab === "positions"
                  ? "font-semibold text-white dark:text-zinc-950"
                  : "text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
              }`}
            >
              {bottomTab === "positions" && (
                <motion.span
                  layoutId="risk-bottom-tab-pill"
                  transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-zinc-950 shadow-sm dark:bg-white"
                />
              )}
              <span className="relative z-10">
                实时持仓与挂单 ({ledger?.positions.length ?? 0} / {ledger?.orders.length ?? 0})
              </span>
            </button>
          </div>
          </LayoutGroup>
          {pendingThreads.length > 0 && bottomTab !== "queue" && (
            <button
              type="button"
              onClick={() => setBottomTab("queue")}
              className="font-mono text-xs font-semibold text-amber-600 hover:underline dark:text-amber-300"
            >
              {pendingThreads.length} 笔待签字 →
            </button>
          )}
        </div>

        {bottomTab === "queue" ? (
          <motion.div
            key="risk-tab-queue"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.26, ease: EASE_EXPO }}
            className="max-h-52 space-y-2 overflow-y-auto pr-0.5"
          >
            {pendingThreads.length === 0 && (ledger?.paper_trades.length ?? 0) === 0 ? (
              <div className="py-3 text-center font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                暂无风控单记录；上方输入股票并点击「唤醒 Risk Critic 独立审查」即可体验断点审批。
              </div>
            ) : (
              (ledger?.paper_trades ?? []).slice(0, 10).map((t) => (
                <div
                  key={t.id}
                  className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 font-mono text-[11px] ${
                    t.status === "pending_hitl"
                      ? "border border-amber-500/30 bg-amber-500/[0.06] dark:bg-amber-500/[0.08]"
                      : "bg-white/90 dark:bg-white/[0.05]"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-zinc-950 dark:text-white">
                      {fmtRiskSideZh(t.side)} {t.qty} {t.symbol}{" "}
                      <span className="text-[10px] font-normal text-zinc-500 dark:text-zinc-400">
                        [{fmtTradeStatusZh(t.status)}]
                      </span>
                    </div>
                    <div className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                      SL ${t.stop_loss_price ?? "—"} · TP ${t.take_profit_price ?? "—"}
                    </div>
                  </div>
                  {t.thread_id && t.status === "pending_hitl" && (
                    <button
                      type="button"
                      onClick={() => handleLoadCheckpoint(t.thread_id!)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-zinc-950 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                    >
                      <PlayCircle className="h-3 w-3" />
                      恢复审批
                    </button>
                  )}
                </div>
              ))
            )}
          </motion.div>
        ) : (
          <motion.div
            key="risk-tab-positions"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.26, ease: EASE_EXPO }}
            className="max-h-52 space-y-1.5 overflow-y-auto font-mono text-[11px]"
          >
            {(ledger?.broker_error || ledger?.alpaca_error) && (
              <div className="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-amber-800 dark:text-amber-300">
                {ledger.broker_error || ledger.alpaca_error}
              </div>
            )}
            {(ledger?.positions ?? []).map((p) => (
              <div
                key={p.symbol}
                className="flex items-center justify-between rounded-xl bg-white/90 px-3 py-1.5 dark:bg-white/[0.05]"
              >
                <span className="text-zinc-950 dark:text-white">
                  {p.symbol} × {p.qty}
                </span>
                <span
                  className={
                    p.unrealized_pl >= 0
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-rose-700 dark:text-rose-400"
                  }
                >
                  {p.unrealized_pl >= 0 ? "+" : ""}
                  {fmtAccountMoney(p.unrealized_pl, p.currency || acctCcy)}
                </span>
              </div>
            ))}
            {(ledger?.orders ?? []).slice(0, 6).map((o) => (
              <div
                key={o.id}
                className="flex items-center justify-between rounded-xl bg-white/75 px-3 py-1.5 text-[10px] text-zinc-600 dark:bg-white/[0.03] dark:text-zinc-300"
              >
                <span>
                  {fmtRiskSideZh(o.side)} {o.qty} {o.symbol}
                </span>
                <span className="text-zinc-800 dark:text-zinc-200">{fmtTradeStatusZh(o.status)}</span>
              </div>
            ))}
            {!ledger?.positions.length &&
              !ledger?.orders.length &&
              !ledger?.broker_error &&
              !ledger?.alpaca_error && (
                <div className="py-3 text-center text-zinc-500 dark:text-zinc-400">
                  {ledger?.broker_profile?.empty_positions_hint ||
                    "当前账户尚无持仓或委托；可在左侧分析或上方发起演练单。"}
                </div>
              )}
          </motion.div>
        )}
      </div>
    </div>
  );
}

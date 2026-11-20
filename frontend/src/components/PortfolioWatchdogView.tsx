"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  ackWatchdogAlert,
  cancelPaperOrder,
  closePaperPosition,
  EpisodicMemoryRecord,
  fetchTradeLedger,
  fetchTradeReviews,
  fetchWatchdogAlerts,
  PaperLedgerResponse,
  recallEpisodicMemories,
  reflectOnTrade,
  syncPaperTradesStatus,
  TradeReviewRecord,
  triggerWatchdogScan,
  WatchdogAlertRecord,
} from "@/lib/api";
import { formatQuadrantOutcome, formatRegimeLabel } from "@/lib/i18n";
import { MarkdownReport } from "./MarkdownReport";

interface PortfolioWatchdogViewProps {
  onSelectSymbol?: (symbol: string) => void;
  onAlertCountChange?: (unackedCount: number) => void;
}

export function PortfolioWatchdogView({
  onSelectSymbol,
  onAlertCountChange,
}: PortfolioWatchdogViewProps) {
  const [ledger, setLedger] = useState<PaperLedgerResponse | null>(null);
  const [alerts, setAlerts] = useState<WatchdogAlertRecord[]>([]);
  const [reviews, setReviews] = useState<TradeReviewRecord[]>([]);
  const [memories, setMemories] = useState<EpisodicMemoryRecord[]>([]);

  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adminToken, setAdminToken] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [memoryTab, setMemoryTab] = useState<"reviews" | "memories">("reviews");
  const [memQuery, setMemQuery] = useState("");
  const [recalledMemories, setRecalledMemories] = useState<EpisodicMemoryRecord[] | null>(null);

  const loadAll = useCallback(async () => {
    setErrorMsg(null);
    try {
      const [ledRes, alertRes, revRes] = await Promise.all([
        fetchTradeLedger(),
        fetchWatchdogAlerts(25),
        fetchTradeReviews(25),
      ]);
      setLedger(ledRes);
      setAlerts(alertRes.alerts);
      setReviews(revRes.reviews);
      setMemories(revRes.memories);
      onAlertCountChange?.(alertRes.alerts.filter((a) => !a.acknowledged).length);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "加载模拟盘与复盘数据失败");
    } finally {
      setLoading(false);
    }
  }, [onAlertCountChange]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleSyncOrders = async () => {
    setSyncing(true);
    setErrorMsg(null);
    try {
      const res = await syncPaperTradesStatus();
      setBanner(
        `同步完成：检查 ${res.checked} 条交易，更新 ${res.updated} 条（新平仓 ${res.newly_closed_trade_ids.length} 条）。`
      );
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "同步订单失败");
    } finally {
      setSyncing(false);
    }
  };

  const handleScanWatchdog = async () => {
    setScanning(true);
    setErrorMsg(null);
    try {
      const res = await triggerWatchdogScan(true);
      setBanner(
        `盘中哨兵扫描完成：扫描 ${res.scanned_symbols} 个标的，生成/更新 ${res.alerts_upserted} 条异常预警。`
      );
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "哨兵扫描失败");
    } finally {
      setScanning(false);
    }
  };

  const handleCancelOrder = async (orderId: string) => {
    setBusyId(`cancel-${orderId}`);
    setErrorMsg(null);
    try {
      await cancelPaperOrder(orderId, adminToken);
      setBanner(`已撤销 Alpaca 挂单 ${orderId.slice(0, 8)}...`);
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "撤单失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleClosePosition = async (symbol: string) => {
    setBusyId(`close-${symbol}`);
    setErrorMsg(null);
    try {
      await closePaperPosition(symbol, adminToken);
      setBanner(`已提交 ${symbol} 市价平仓指令并更新本地台账。`);
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : `平仓 ${symbol} 失败`);
    } finally {
      setBusyId(null);
    }
  };

  const handleAckAlert = async (alertId: number) => {
    setBusyId(`ack-${alertId}`);
    try {
      await ackWatchdogAlert(alertId);
      setAlerts((prev) => {
        const next = prev.map((a) => (a.id === alertId ? { ...a, acknowledged: true } : a));
        onAlertCountChange?.(next.filter((a) => !a.acknowledged).length);
        return next;
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "确认预警失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleReflectTrade = async (tradeId: number) => {
    setBusyId(`reflect-${tradeId}`);
    setErrorMsg(null);
    try {
      const res = await reflectOnTrade(tradeId, "POST_CLOSE");
      setBanner(`已完成交易 #${tradeId} 四象限归因：${res.quadrant_cn}`);
      setMemoryTab("reviews");
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "生成复盘失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleMemorySearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = memQuery.trim();
    if (!q) {
      setRecalledMemories(null);
      return;
    }
    try {
      const res = await recallEpisodicMemories(q);
      setRecalledMemories(res.memories);
      setMemoryTab("memories");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "记忆检索失败");
    }
  };

  const unackedCount = alerts.filter((a) => !a.acknowledged).length;

  return (
    <div className="space-y-6">
      {/* Top Account & Phase 5 Controls */}
      <section className="rounded-[24px] border border-[#141418] bg-[#0B0B0D] p-5 text-[#F3F3F0] shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-400">
              Phase 4–5 Paper Portfolio · Intraday Watchdog · 4-Quadrant Attribution
            </p>
            <h2 className="mt-1 font-serif text-xl font-semibold tracking-tight text-white">
              模拟盘执行、盘中哨兵预警与四象限复盘中心
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {ledger?.requires_admin_token && (
              <input
                type="password"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                placeholder="X-Admin-Token (平仓/撤单)"
                className="rounded-lg border border-white/15 bg-black/50 px-3 py-1.5 font-mono text-[11px] text-white placeholder:text-zinc-500"
              />
            )}
            <button
              type="button"
              onClick={handleSyncOrders}
              disabled={syncing}
              className="rounded-lg border border-white/20 bg-white/5 px-3.5 py-2 font-mono text-[11px] text-zinc-100 transition hover:bg-white/15 disabled:opacity-50"
            >
              {syncing ? "同步成交中..." : "同步 Alpaca 订单与盈亏"}
            </button>
            <button
              type="button"
              onClick={handleScanWatchdog}
              disabled={scanning}
              className="rounded-lg bg-[#F3F3F0] px-4 py-2 font-mono text-[11px] font-semibold text-[#0B0B0D] transition hover:bg-white disabled:opacity-50"
            >
              {scanning ? "哨兵扫描中..." : "立即运行盘中哨兵扫描 (Watchdog)"}
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-zinc-400">模拟账户净值 (Equity)</div>
            <div className="mt-1 font-mono text-lg font-semibold text-white">
              {ledger?.account ? `$${ledger.account.equity.toLocaleString()}` : "—"}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-zinc-400">可用购买力 (Buying Power)</div>
            <div className="mt-1 font-mono text-lg font-semibold text-white">
              {ledger?.account ? `$${ledger.account.buying_power.toLocaleString()}` : "—"}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-zinc-400">当前持仓标的数量</div>
            <div className="mt-1 font-mono text-lg font-semibold text-white">
              {ledger?.positions.length ?? 0}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-zinc-400">待处理哨兵预警</div>
            <div className="mt-1 font-mono text-lg font-semibold text-amber-300">
              {unackedCount} / {alerts.length}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-zinc-400">长期经验记忆库</div>
            <div className="mt-1 font-mono text-lg font-semibold text-emerald-300">
              {memories.length} 条
            </div>
          </div>
        </div>
      </section>

      {banner && (
        <div className="flex items-center justify-between rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-950">
          <span>{banner}</span>
          <button type="button" onClick={() => setBanner(null)} className="font-mono text-[11px] underline">
            关闭
          </button>
        </div>
      )}
      {errorMsg && (
        <div className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-2.5 text-xs text-rose-900">
          {errorMsg}
        </div>
      )}

      {/* Middle Row: Open Positions & Orders (Left) + Watchdog Anomaly Radar (Right) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="space-y-4 rounded-[20px] border border-[#E2E2DE] bg-white p-5 lg:col-span-7">
          <div className="flex items-center justify-between border-b border-[#EFEFEB] pb-3">
            <div>
              <h3 className="font-serif text-base font-semibold text-[#0B0B0D]">
                Alpaca 实时持仓与活动挂单
              </h3>
              <p className="text-[11px] text-[#6B6B73]">
                直接管理 Paper 持仓平仓与尚未成交的 Bracket / 限价挂单
              </p>
            </div>
            <button
              type="button"
              onClick={loadAll}
              className="rounded-md border border-[#D8D8D2] px-2.5 py-1 font-mono text-[11px] text-[#3A3A40] hover:bg-[#F3F3F0]"
            >
              刷新
            </button>
          </div>

          {loading ? (
            <div className="py-6 text-center text-xs text-[#6B6B73]">加载 Alpaca 持仓与订单中...</div>
          ) : (
            <>
              <div>
                <h4 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-[#6B6B73]">
                  当前持仓 Positions ({ledger?.positions.length ?? 0})
                </h4>
                {!ledger || ledger.positions.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-[#E2E2DE] px-3 py-4 text-center text-xs text-[#71717A]">
                    当前无持仓。可在「投研与风控台」审查并发起 Bracket 下单。
                  </p>
                ) : (
                  <div className="space-y-2">
                    {ledger.positions.map((pos) => (
                      <div
                        key={pos.symbol}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#E7E7E2] bg-[#FAF9F6] px-3.5 py-2.5 text-xs"
                      >
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => onSelectSymbol?.(pos.symbol)}
                            className="font-mono text-sm font-bold text-[#0B0B0D] underline-offset-4 hover:underline"
                          >
                            {pos.symbol}
                          </button>
                          <span className="font-mono text-[#4B4B52]">
                            {pos.qty} 股 @ 均价 ${pos.avg_entry_price.toFixed(2)} → 现价 ${pos.current_price.toFixed(2)}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span
                            className={`font-mono font-semibold ${
                              pos.unrealized_pl >= 0 ? "text-emerald-700" : "text-rose-700"
                            }`}
                          >
                            {pos.unrealized_pl >= 0 ? "+" : ""}${pos.unrealized_pl.toFixed(2)} (
                            {(pos.unrealized_plpc * 100).toFixed(2)}%)
                          </span>
                          <button
                            type="button"
                            disabled={busyId === `close-${pos.symbol}`}
                            onClick={() => handleClosePosition(pos.symbol)}
                            className="rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 font-mono text-[11px] font-medium text-rose-800 hover:bg-rose-100 disabled:opacity-50"
                          >
                            {busyId === `close-${pos.symbol}` ? "平仓中..." : "市价平仓"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="pt-2">
                <h4 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-[#6B6B73]">
                  近期 Alpaca 委托 Orders ({ledger?.orders.length ?? 0})
                </h4>
                <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                  {(ledger?.orders ?? []).slice(0, 10).map((ord) => {
                    const cancelable = ["new", "accepted", "partially_filled", "pending_new", "held"].includes(
                      ord.status.toLowerCase()
                    );
                    return (
                      <div
                        key={ord.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#EFEFEB] px-3 py-2 text-[11px] font-mono"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-[#0B0B0D]">{ord.symbol}</span>
                          <span className="uppercase text-[#5F5F67]">
                            {ord.side} {ord.qty} ({ord.order_class})
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-[#F3F3F0] px-2 py-0.5 text-[10px] text-[#3A3A40]">
                            {ord.status}
                            {ord.filled_avg_price ? ` @ $${Number(ord.filled_avg_price).toFixed(2)}` : ""}
                          </span>
                          {cancelable && (
                            <button
                              type="button"
                              disabled={busyId === `cancel-${ord.id}`}
                              onClick={() => handleCancelOrder(ord.id)}
                              className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                            >
                              {busyId === `cancel-${ord.id}` ? "撤单中" : "撤单"}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Agent 3 Watchdog Alerts */}
        <div className="space-y-3 rounded-[20px] border border-[#E2E2DE] bg-white p-5 lg:col-span-5">
          <div className="flex items-center justify-between border-b border-[#EFEFEB] pb-3">
            <div>
              <h3 className="font-serif text-base font-semibold text-[#0B0B0D]">
                Agent 3 盘中异常预警雷达
              </h3>
              <p className="text-[11px] text-[#6B6B73]">
                自动扫描 RVOL ≥ 1.8x 放量、负 GEX 破位、VIX 倒挂与 24h 高危宏观事件
              </p>
            </div>
          </div>

          {alerts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#E2E2DE] px-4 py-8 text-center text-xs text-[#6B6B73]">
              暂无异常预警记录，可点击上方「立即运行盘中哨兵扫描 (Watchdog)」。
            </div>
          ) : (
            <div className="max-h-[380px] space-y-2.5 overflow-y-auto pr-1">
              {alerts.map((al) => (
                <div
                  key={al.id}
                  className={`rounded-xl border p-3.5 transition ${
                    al.acknowledged
                      ? "border-[#EFEFEB] bg-[#FAF9F6] opacity-70"
                      : al.severity === "high"
                        ? "border-rose-300 bg-rose-50/40"
                        : "border-amber-300 bg-amber-50/40"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                          al.severity === "high"
                            ? "bg-rose-700 text-white"
                            : "bg-amber-700 text-white"
                        }`}
                      >
                        {al.severity}
                      </span>
                      {al.symbol && (
                        <button
                          type="button"
                          onClick={() => onSelectSymbol?.(al.symbol || "SPY")}
                          className="rounded border border-[#D8D8D2] bg-white px-2 py-0.5 font-mono text-[10px] font-semibold text-[#0B0B0D] hover:bg-[#F3F3F0]"
                        >
                          {al.symbol}
                        </button>
                      )}
                      <span className="font-mono text-[10px] text-[#71717A]">
                        {new Date(al.created_at).toLocaleString()}
                      </span>
                    </div>
                    {!al.acknowledged && (
                      <button
                        type="button"
                        disabled={busyId === `ack-${al.id}`}
                        onClick={() => handleAckAlert(al.id)}
                        className="shrink-0 rounded border border-[#D4D4CE] bg-white px-2 py-0.5 font-mono text-[10px] text-[#3A3A40] hover:bg-[#0B0B0D] hover:text-white"
                      >
                        已知悉
                      </button>
                    )}
                  </div>
                  <div className="mt-1.5 text-[13px] font-semibold text-[#0B0B0D]">{al.title}</div>
                  <div className="mt-1">
                    <MarkdownReport content={al.summary_markdown} compact />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Row: PaperTrade Ledger + 4-Quadrant Reviews & Long-Term Episodic Memory */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <div className="rounded-[20px] border border-[#E2E2DE] bg-white p-5 xl:col-span-6">
          <div className="border-b border-[#EFEFEB] pb-3">
            <h3 className="font-serif text-base font-semibold text-[#0B0B0D]">
              PostgreSQL 决策审计台账与一键复盘 (PaperTrade)
            </h3>
            <p className="text-[11px] text-[#6B6B73]">
              对任意已审核或平仓交易生成「过程纪律 × 市场结果」4 象限归因并写入记忆库
            </p>
          </div>

          <div className="mt-3 max-h-[380px] space-y-2.5 overflow-y-auto pr-1">
            {(ledger?.paper_trades ?? []).length === 0 ? (
              <p className="py-8 text-center text-xs text-[#71717A]">
                暂无 PaperTrade 记录。请在「投研与风控台」发起一笔 Risk Critic 交易审批。
              </p>
            ) : (
              (ledger?.paper_trades ?? []).map((t) => (
                <div
                  key={t.id}
                  className="rounded-xl border border-[#E7E7E2] bg-[#FAF9F6] p-3 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-mono">
                      <span className="font-bold text-[#0B0B0D]">#{t.id} {t.symbol}</span>
                      <span className="rounded bg-[#0B0B0D] px-1.5 py-0.5 text-[10px] uppercase text-white">
                        {t.side} {t.qty}
                      </span>
                      <span className="rounded border border-[#D8D8D2] bg-white px-2 py-0.5 text-[10px]">
                        {t.status}
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={busyId === `reflect-${t.id}`}
                      onClick={() => handleReflectTrade(t.id)}
                      className="rounded-lg border border-[#0B0B0D] bg-white px-2.5 py-1 font-mono text-[10px] font-semibold text-[#0B0B0D] transition hover:bg-[#0B0B0D] hover:text-white disabled:opacity-50"
                    >
                      {busyId === `reflect-${t.id}` ? "归因中..." : "生成 4-象限复盘"}
                    </button>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-[#4B4B52]">
                    <span>入场: {t.entry_price ? `$${t.entry_price.toFixed(2)}` : "—"}</span>
                    <span>止损: {t.stop_loss_price ? `$${t.stop_loss_price.toFixed(2)}` : "—"}</span>
                    <span>止盈: {t.take_profit_price ? `$${t.take_profit_price.toFixed(2)}` : "—"}</span>
                    <span>预算: {t.risk_budget_pct}%</span>
                    <span>体制: {formatRegimeLabel(t.regime_at_entry).split(" · ")[0]}</span>
                    {t.realized_pnl !== null && t.realized_pnl !== undefined && (
                      <span className={t.realized_pnl >= 0 ? "font-semibold text-emerald-700" : "font-semibold text-rose-700"}>
                        已实现盈亏: {t.realized_pnl >= 0 ? "+" : ""}${t.realized_pnl.toFixed(2)}
                      </span>
                    )}
                  </div>
                  {t.rationale_summary && (
                    <p className="mt-1 text-[11px] text-[#5F5F67] line-clamp-2">{t.rationale_summary}</p>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* 4-Quadrant Reviews & Long-Term Episodic Memory */}
        <div className="rounded-[20px] border border-[#E2E2DE] bg-white p-5 xl:col-span-6">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#EFEFEB] pb-3">
            <div>
              <h3 className="font-serif text-base font-semibold text-[#0B0B0D]">
                4-象限归因复盘与长期情景记忆 (BM25 + pgvector)
              </h3>
              <p className="text-[11px] text-[#6B6B73]">
                过往决策教训会自动注入 Investigator 与 Risk Critic 的前置上下文中
              </p>
            </div>
            <div className="inline-flex rounded-lg border border-[#E2E2DE] bg-[#F5F5F2] p-0.5 font-mono text-[11px]">
              <button
                type="button"
                onClick={() => setMemoryTab("reviews")}
                className={`rounded-md px-2.5 py-1 ${
                  memoryTab === "reviews" ? "bg-[#0B0B0D] text-white" : "text-[#5F5F67]"
                }`}
              >
                复盘归因 ({reviews.length})
              </button>
              <button
                type="button"
                onClick={() => setMemoryTab("memories")}
                className={`rounded-md px-2.5 py-1 ${
                  memoryTab === "memories" ? "bg-[#0B0B0D] text-white" : "text-[#5F5F67]"
                }`}
              >
                记忆库 ({(recalledMemories ?? memories).length})
              </button>
            </div>
          </div>

          <form onSubmit={handleMemorySearch} className="mt-3 flex gap-2">
            <input
              type="text"
              value={memQuery}
              onChange={(e) => setMemQuery(e.target.value)}
              placeholder="检索历史教训（例如：NVDA Zero Gamma RISK_OFF stop_loss...）"
              className="flex-1 rounded-lg border border-[#D8D8D2] bg-[#FAF9F6] px-3 py-1.5 text-xs text-[#0B0B0D] placeholder:text-[#8E8E96]"
            />
            <button
              type="submit"
              className="rounded-lg bg-[#0B0B0D] px-3.5 py-1.5 font-mono text-[11px] font-medium text-white hover:bg-[#1E1E24]"
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
                className="rounded-lg border border-[#D8D8D2] px-2.5 py-1.5 font-mono text-[11px] text-[#5F5F67]"
              >
                重置
              </button>
            )}
          </form>

          <div className="mt-3 max-h-[325px] space-y-2.5 overflow-y-auto pr-1">
            {memoryTab === "reviews" ? (
              reviews.length === 0 ? (
                <p className="py-8 text-center text-xs text-[#71717A]">
                  暂无复盘记录。点击左侧任意交易的「生成 4-象限复盘」即可创建。
                </p>
              ) : (
                reviews.map((r) => {
                  const q = formatQuadrantOutcome(r.quadrant_outcome);
                  return (
                    <div key={r.id} className="rounded-xl border border-[#E7E7E2] bg-[#FAF9F6] p-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span
                          className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
                            q.tone === "good"
                              ? "bg-emerald-100 text-emerald-900"
                              : q.tone === "warn"
                                ? "bg-amber-100 text-amber-900"
                                : "bg-rose-100 text-rose-900"
                          }`}
                        >
                          {q.label}
                        </span>
                        <span className="font-mono text-[11px] text-[#5F5F67]">
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
              )
            ) : (recalledMemories ?? memories).length === 0 ? (
              <p className="py-8 text-center text-xs text-[#71717A]">未检索到匹配的长期经验记忆。</p>
            ) : (
              (recalledMemories ?? memories).map((m) => (
                <div key={m.id} className="rounded-xl border border-[#E7E7E2] bg-[#FAF9F6] p-3">
                  <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                    <span className="font-semibold text-[#0B0B0D]">{m.title}</span>
                    <span className="text-[#71717A]">{m.regime_label}</span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-[#3A3A40]">{m.lesson_text}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

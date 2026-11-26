"use client";

import React, { useCallback, useEffect, useState } from "react";
import { LayoutGroup, motion } from "framer-motion";
import {
  Activity,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  HelpCircle,
  Pause,
  Play,
  Radio,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import {
  ackWatchdogAlert,
  cancelPaperOrder,
  closePaperPosition,
  configureAutopilot,
  EpisodicMemoryRecord,
  fetchAutopilotStatus,
  fetchTradeAnalytics,
  fetchTradeLedger,
  fetchTradeReviews,
  fetchWatchdogAlerts,
  PaperLedgerResponse,
  PortfolioAnalyticsResponse,
  reflectOnTrade,
  RiskPrefillDraft,
  runAutopilotNow,
  syncPaperTradesStatus,
  TradeReviewRecord,
  triggerWatchdogScan,
  WatchdogAlertRecord,
  WatchdogAutopilotStatus,
} from "@/lib/api";
import {
  BrokerProviderId,
  SETTINGS_UPDATED_EVENT,
  loadClientSettings,
  saveClientSettings,
} from "@/lib/clientSettings";
import { formatRegimeLabel } from "@/lib/i18n";
import { MarkdownReport } from "./MarkdownReport";
import PortfolioAnalyticsCharts from "@/components/PortfolioAnalyticsCharts";
import PortfolioPlaybookPanel from "@/components/PortfolioPlaybookPanel";
import SpotlightBlock from "@/components/SpotlightBlock";

const EASE_EXPO = [0.16, 1, 0.3, 1] as const;

interface PortfolioWatchdogViewProps {
  onSelectSymbol?: (symbol: string) => void;
  onAlertCountChange?: (unackedCount: number) => void;
  onOpenSettings?: () => void;
  onOpenCopilot?: (symbol: string, customPrompt?: string) => void;
  onOpenRiskTicket?: (draft: RiskPrefillDraft) => void;
}

function currencyPrefix(ccy?: string | null): string {
  const code = (ccy || "USD").toUpperCase();
  if (code === "GBP") return "£";
  if (code === "EUR") return "€";
  return "$";
}

function fmtCurrency(val: number | undefined | null, ccy?: string | null): string {
  if (val === undefined || val === null || Number.isNaN(val)) return "—";
  return `${currencyPrefix(ccy)}${val.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

interface PortfolioSwrCache {
  brokerKey: string;
  ledger: PaperLedgerResponse | null;
  analytics: PortfolioAnalyticsResponse | null;
  alerts: WatchdogAlertRecord[];
  reviews: TradeReviewRecord[];
  memories: EpisodicMemoryRecord[];
  autopilot: WatchdogAutopilotStatus | null;
  updatedAt: number;
}

function getActiveBrokerCacheKey(): string {
  if (typeof window === "undefined") return "sandbox:default:live:global";
  const cfg = loadClientSettings();
  return `${cfg.brokerProvider}:${cfg.workspaceId || "default"}:${cfg.trading212Env}:${cfg.binanceEnv}`;
}

const _PORTFOLIO_SWR_CACHE: PortfolioSwrCache = {
  brokerKey: "",
  ledger: null,
  analytics: null,
  alerts: [],
  reviews: [],
  memories: [],
  autopilot: null,
  updatedAt: 0,
};

function clearPortfolioSwrCache(): void {
  _PORTFOLIO_SWR_CACHE.brokerKey = "";
  _PORTFOLIO_SWR_CACHE.ledger = null;
  _PORTFOLIO_SWR_CACHE.analytics = null;
  _PORTFOLIO_SWR_CACHE.alerts = [];
  _PORTFOLIO_SWR_CACHE.reviews = [];
  _PORTFOLIO_SWR_CACHE.memories = [];
  _PORTFOLIO_SWR_CACHE.autopilot = null;
  _PORTFOLIO_SWR_CACHE.updatedAt = 0;
}

if (typeof window !== "undefined") {
  window.addEventListener(SETTINGS_UPDATED_EVENT, clearPortfolioSwrCache);
}

const BROKER_QUICK_PILLS: { id: BrokerProviderId; label: string }[] = [
  { id: "sandbox", label: "24/7 本地模拟盘" },
  { id: "alpaca", label: "Alpaca Paper" },
  { id: "ibkr", label: "盈透 IBKR" },
  { id: "binance", label: "Binance 币安" },
  { id: "trading212", label: "Trading212" },
  { id: "csv_import", label: "CSV 账本" },
];

function fmtOrderStatusZh(status: string): string {
  const s = (status || "").toLowerCase();
  if (s === "pending_hitl") return "待人工签字";
  if (s === "filled") return "已成交";
  if (s === "closed") return "已平仓";
  if (s === "canceled" || s === "cancelled") return "已撤单";
  if (s === "rejected") return "已拒单";
  if (s === "new" || s === "accepted" || s === "pending_new" || s === "held" || s === "submitted") {
    return "挂单/生效中";
  }
  if (s === "partially_filled") return "部分成交";
  return status;
}

function fmtSeverityZh(sev: string): string {
  const s = (sev || "").toLowerCase();
  if (s === "high") return "高危";
  if (s === "medium") return "中级";
  return "提示";
}

function fmtSideZh(side: string): string {
  return (side || "").toLowerCase() === "sell" ? "卖出" : "买入";
}

function calcStepQty(qty: number, ratio: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return 1;
  const raw = qty * ratio;
  if (qty < 2) {
    return Math.max(0.0001, Number(raw.toFixed(4)));
  }
  return Math.max(1, Math.round(raw));
}

export function PortfolioWatchdogView({
  onSelectSymbol,
  onAlertCountChange,
  onOpenSettings,
  onOpenCopilot,
  onOpenRiskTicket,
}: PortfolioWatchdogViewProps) {
  const currentBrokerKey = getActiveBrokerCacheKey();
  const cacheMatchesBroker =
    Boolean(_PORTFOLIO_SWR_CACHE.ledger) && _PORTFOLIO_SWR_CACHE.brokerKey === currentBrokerKey;

  const [activeBrokerId, setActiveBrokerId] = useState<BrokerProviderId>(() =>
    typeof window === "undefined" ? "sandbox" : loadClientSettings().brokerProvider
  );
  const [ledger, setLedger] = useState<PaperLedgerResponse | null>(() =>
    cacheMatchesBroker ? _PORTFOLIO_SWR_CACHE.ledger : null
  );
  const [analytics, setAnalytics] = useState<PortfolioAnalyticsResponse | null>(() =>
    cacheMatchesBroker ? _PORTFOLIO_SWR_CACHE.analytics : null
  );
  const [alerts, setAlerts] = useState<WatchdogAlertRecord[]>(() =>
    cacheMatchesBroker ? _PORTFOLIO_SWR_CACHE.alerts : []
  );
  const [reviews, setReviews] = useState<TradeReviewRecord[]>(() =>
    cacheMatchesBroker ? _PORTFOLIO_SWR_CACHE.reviews : []
  );
  const [memories, setMemories] = useState<EpisodicMemoryRecord[]>(() =>
    cacheMatchesBroker ? _PORTFOLIO_SWR_CACHE.memories : []
  );

  const [loading, setLoading] = useState<boolean>(() => !cacheMatchesBroker);
  const [analyticsLoading, setAnalyticsLoading] = useState<boolean>(
    () => !(cacheMatchesBroker && _PORTFOLIO_SWR_CACHE.analytics)
  );
  const [syncing, setSyncing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adminToken, setAdminToken] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [autopilot, setAutopilot] = useState<WatchdogAutopilotStatus | null>(
    () => _PORTFOLIO_SWR_CACHE.autopilot
  );
  const [autopilotBusy, setAutopilotBusy] = useState(false);
  const [countdownSec, setCountdownSec] = useState<number | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<"monitor" | "review" | "all">("monitor");
  const [showAllAlerts, setShowAllAlerts] = useState(false);
  const [showGuide, setShowGuide] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return window.localStorage.getItem("marketelite_watchdog_guide_hidden") !== "1";
    } catch {
      return true;
    }
  });

  const dismissGuide = () => {
    setShowGuide(false);
    try {
      window.localStorage.setItem("marketelite_watchdog_guide_hidden", "1");
    } catch {
      // Ignore storage failures safely
    }
  };

  useEffect(() => {
    const computeRemaining = () => {
      if (!autopilot?.enabled || !autopilot.next_run_at) {
        setCountdownSec(null);
        return;
      }
      const targetMs = Date.parse(autopilot.next_run_at);
      if (Number.isNaN(targetMs)) {
        setCountdownSec(null);
        return;
      }
      setCountdownSec(Math.max(0, Math.round((targetMs - Date.now()) / 1000)));
    };
    computeRemaining();
    const timer = window.setInterval(computeRemaining, 1000);
    return () => window.clearInterval(timer);
  }, [autopilot?.enabled, autopilot?.next_run_at]);

  useEffect(() => {
    const poll = window.setInterval(() => {
      fetchAutopilotStatus()
        .then((res) => setAutopilot(res))
        .catch(() => {});
    }, 30000);
    return () => window.clearInterval(poll);
  }, []);

  const loadAll = useCallback(
    async (forceRefresh = false) => {
      setErrorMsg(null);
      const reqBrokerKey = getActiveBrokerCacheKey();
      setActiveBrokerId(loadClientSettings().brokerProvider);
      if (forceRefresh || _PORTFOLIO_SWR_CACHE.brokerKey !== reqBrokerKey || _PORTFOLIO_SWR_CACHE.ledger === null) {
        setLoading(true);
      }
      if (forceRefresh || _PORTFOLIO_SWR_CACHE.brokerKey !== reqBrokerKey || _PORTFOLIO_SWR_CACHE.analytics === null) {
        setAnalyticsLoading(true);
      }
      _PORTFOLIO_SWR_CACHE.brokerKey = reqBrokerKey;

      // Launch all 5 requests independently so fast PostgreSQL/Redis panels (alerts,
      // reviews, Playbook, autopilot ~10ms) render immediately without waiting on remote broker HTTP.
      const pAlerts = fetchWatchdogAlerts(25).then((alertRes) => {
        if (_PORTFOLIO_SWR_CACHE.brokerKey === reqBrokerKey) {
          _PORTFOLIO_SWR_CACHE.alerts = alertRes.alerts;
        }
        setAlerts(alertRes.alerts);
        onAlertCountChange?.(alertRes.alerts.filter((a) => !a.acknowledged).length);
      });

      const pReviews = fetchTradeReviews(25).then((revRes) => {
        if (_PORTFOLIO_SWR_CACHE.brokerKey === reqBrokerKey) {
          _PORTFOLIO_SWR_CACHE.reviews = revRes.reviews;
          _PORTFOLIO_SWR_CACHE.memories = revRes.memories;
        }
        setReviews(revRes.reviews);
        setMemories(revRes.memories);
      });

      const pAutopilot = fetchAutopilotStatus()
        .then((apRes) => {
          _PORTFOLIO_SWR_CACHE.autopilot = apRes;
          setAutopilot(apRes);
        })
        .catch(() => null);

      const pLedger = fetchTradeLedger(forceRefresh)
        .then((ledRes) => {
          if (_PORTFOLIO_SWR_CACHE.brokerKey === reqBrokerKey) {
            _PORTFOLIO_SWR_CACHE.ledger = ledRes;
            _PORTFOLIO_SWR_CACHE.updatedAt = Date.now();
          }
          setLedger(ledRes);
        })
        .catch((err) => {
          setErrorMsg(err instanceof Error ? err.message : "加载账户持仓与复盘数据失败");
        })
        .finally(() => {
          setLoading(false);
        });

      const pAnalytics = fetchTradeAnalytics()
        .then((anaRes) => {
          if (_PORTFOLIO_SWR_CACHE.brokerKey === reqBrokerKey) {
            _PORTFOLIO_SWR_CACHE.analytics = anaRes;
          }
          setAnalytics(anaRes);
        })
        .catch(() => null)
        .finally(() => {
          setAnalyticsLoading(false);
        });

      await Promise.allSettled([pAlerts, pReviews, pAutopilot, pLedger, pAnalytics]);
    },
    [onAlertCountChange]
  );

  useEffect(() => {
    void loadAll(false);
    const onSettingsUpdate = () => {
      clearPortfolioSwrCache();
      setActiveBrokerId(loadClientSettings().brokerProvider);
      setLoading(true);
      setAnalyticsLoading(true);
      void loadAll(true);
    };
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdate);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdate);
  }, [loadAll]);

  const handleQuickSwitchBroker = (target: BrokerProviderId) => {
    const cur = loadClientSettings();
    const saved = saveClientSettings({ ...cur, brokerProvider: target });
    setActiveBrokerId(saved.brokerProvider);
    clearPortfolioSwrCache();
    setBanner(`已切换账户引擎至「${BROKER_QUICK_PILLS.find((x) => x.id === target)?.label || target}」，正在同步最新数据...`);
    const needsCreds =
      (target === "trading212" && (!saved.trading212ApiKey || !saved.trading212ApiSecret)) ||
      (target === "ibkr" && (!saved.ibkrFlexToken || !saved.ibkrQueryId)) ||
      (target === "binance" && (!saved.binanceApiKey || !saved.binanceApiSecret));
    if (needsCreds && onOpenSettings) {
      onOpenSettings();
    }
  };

  const handleSyncOrders = async () => {
    setSyncing(true);
    setErrorMsg(null);
    try {
      const res = await syncPaperTradesStatus();
      const label = ledger?.broker_profile?.short_name || res.broker?.toUpperCase() || "账户";
      setBanner(
        res.updated > 0
          ? `${label} 同步完成：核对 ${res.checked} 条历史成交，新导入 ${res.updated} 条至复盘台账。`
          : `${label} 同步完成：检查 ${res.checked} 条记录，实时持仓估值已更新。`
      );
      await loadAll(true);
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
        `盘中哨兵巡检完成：扫描 ${res.scanned_symbols} 个标的，生成/更新 ${res.alerts_upserted} 条异常预警。`
      );
      await loadAll(false);
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
      setBanner(`已撤销挂单 ${orderId.slice(0, 10)}...`);
      await loadAll(true);
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
      setBanner(`已按最新收盘价模拟平仓 ${symbol} 并更新复盘台账。`);
      await loadAll(true);
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
      await loadAll(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "生成复盘失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleAutopilotToggle = async () => {
    if (!autopilot) return;
    setAutopilotBusy(true);
    setErrorMsg(null);
    try {
      const next = await configureAutopilot({ enabled: !autopilot.enabled });
      setAutopilot(next);
      setBanner(next.enabled ? "已恢复盘中哨兵常驻自动巡检。" : "已暂停盘中哨兵自动巡检（可随时手动重启）。");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "切换自动巡检状态失败");
    } finally {
      setAutopilotBusy(false);
    }
  };

  const handleAutopilotInterval = async (intervalSeconds: number) => {
    setAutopilotBusy(true);
    setErrorMsg(null);
    try {
      const next = await configureAutopilot({ interval_seconds: intervalSeconds });
      setAutopilot(next);
      setBanner(`哨兵自动巡检周期已更新为每 ${Math.round(intervalSeconds / 60)} 分钟一轮。`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "修改巡检周期失败");
    } finally {
      setAutopilotBusy(false);
    }
  };

  const handleAutopilotRunNow = async () => {
    setAutopilotBusy(true);
    setErrorMsg(null);
    try {
      const res = await runAutopilotNow();
      setAutopilot(res);
      const summary = res.last_run ?? res.last_summary;
      setBanner(
        `全量巡检与自动复盘完成：新预警 ${summary?.alerts_upserted ?? 0} 条 · 自动复盘平仓单 ${summary?.reflected_count ?? 0} 笔。`
      );
      await loadAll(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "立即全量巡检失败");
    } finally {
      setAutopilotBusy(false);
    }
  };

  const handleAlertConsult = (al: WatchdogAlertRecord) => {
    if (!onOpenCopilot || !al.symbol) return;
    const metricSnippet = Object.entries(al.metrics || {})
      .slice(0, 4)
      .map(([k, v]) => `${k}=${typeof v === "number" ? Number(v).toFixed(2) : String(v)}`)
      .join(" | ");
    const prompt = `【哨兵预警联合会诊】标的 ${al.symbol} 触发预警「${al.title}」（级别 ${al.severity.toUpperCase()} · 体制 ${al.regime_label || "NEUTRAL"}）。${
      metricSnippet ? `关键监控指标：${metricSnippet}。` : ""
    }请调取最新技术破位风险、期权 Gamma 墙位与 Playbook 铁律，给出是否防守减仓/对冲/观望的具体量化建议与价位锚点。`;
    onOpenCopilot(al.symbol, prompt);
  };

  const handleAlertDefensiveOrder = (al: WatchdogAlertRecord) => {
    if (!onOpenRiskTicket || !al.symbol) return;
    const sym = al.symbol.toUpperCase();
    const heldPos = ledger?.positions.find((p) => p.symbol.toUpperCase() === sym);
    const side: "buy" | "sell" = heldPos?.side === "short" ? "buy" : "sell";
    const qty = heldPos && heldPos.qty > 0 ? Math.max(1, Math.round(heldPos.qty * 0.5)) : 1;
    const rawMetricPrice =
      typeof al.metrics?.current_price === "number"
        ? al.metrics.current_price
        : typeof al.metrics?.last_close === "number"
          ? al.metrics.last_close
          : null;
    const entryPrice = heldPos?.current_price ?? rawMetricPrice;
    const rationale = heldPos
      ? `[哨兵预警防守减仓 50%] 因「${al.title}」(${al.severity}) 拟先减仓 ${sym} ${qty} 股（原持仓 ${heldPos.qty} 股），请 Risk Critic 结合 ATR 与 Playbook 铁律审核防守边界。`
      : `[哨兵预警防守评估单] 因「${al.title}」(${al.severity}) 拟对 ${sym} 发起 1 股防守/对冲风控预审（需经 HITL 人工拍板后方可生效）。`;
    onOpenRiskTicket({
      symbol: sym,
      side,
      qty,
      entryPrice: entryPrice ?? null,
      stopLoss: null,
      takeProfit: null,
      riskBudgetPct: 1.0,
      rationale,
      nonce: Date.now(),
    });
  };

  const unackedAlerts = alerts.filter((a) => !a.acknowledged);
  const unackedCount = unackedAlerts.length;
  const highSeverityUnacked = unackedAlerts.filter((a) => a.severity === "high");
  const sortedAlerts = [...alerts].sort((a, b) => {
    if (a.acknowledged !== b.acknowledged) return a.acknowledged ? 1 : -1;
    const rank = (s: string) => (s === "high" ? 0 : s === "medium" ? 1 : 2);
    return rank(a.severity) - rank(b.severity);
  });
  const primaryAlerts = sortedAlerts.filter((a) => !a.acknowledged && a.severity === "high").slice(0, 5);
  const visiblePrimaryAlerts =
    primaryAlerts.length > 0 ? primaryAlerts : sortedAlerts.filter((a) => !a.acknowledged).slice(0, 4);
  const primaryIds = new Set(visiblePrimaryAlerts.map((a) => a.id));
  const secondaryAlerts = sortedAlerts.filter((a) => !primaryIds.has(a.id));

  const reviewedTradeIds = new Set(reviews.map((r) => r.paper_trade_id));
  const unreviewedClosedCount = (ledger?.paper_trades ?? []).filter(
    (t) => t.status === "closed" && !reviewedTradeIds.has(t.id)
  ).length;

  const acctCcy = ledger?.currency || ledger?.account?.currency || "USD";
  const brokerProfile = ledger?.broker_profile;
  const isReadOnly = Boolean(ledger?.read_only);
  const hasAnalyticsSample = Boolean(analytics?.has_sufficient_real_history);
  const kpiRef = analytics?.has_sufficient_real_history
    ? analytics.kpis
    : analytics?.demo_preview?.kpis;

  return (
    <div className="space-y-5">
      {/* Top Action Priority Hero & Workspace Controls */}
      <SpotlightBlock tone="obsidian" className="space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200/80 pb-4 dark:border-white/10">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/[0.12] px-2.5 py-0.5 font-mono text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                <Wallet className="h-3.5 w-3.5" />
                {brokerProfile?.display_name || ledger?.broker_label || "本地拟真模拟盘 · 24/7 Sandbox"}
              </span>
              {isReadOnly && (
                <span className="rounded-full bg-sky-500/[0.12] px-2.5 py-0.5 font-mono text-[10.5px] font-semibold text-sky-700 dark:text-sky-300">
                  只读同步 · 辅助风控与复盘
                </span>
              )}
              {!showGuide && (
                <button
                  type="button"
                  onClick={() => setShowGuide(true)}
                  className="inline-flex items-center gap-1 rounded-full bg-zinc-200/75 px-2.5 py-0.5 font-mono text-[10.5px] text-zinc-700 transition hover:bg-zinc-200 dark:bg-white/10 dark:text-zinc-200"
                >
                  <HelpCircle className="h-3 w-3" />
                  新手指引
                </button>
              )}
            </div>
            <h2 className="mt-1.5 font-serif text-2xl font-semibold tracking-tight text-zinc-950 sm:text-[30px] sm:leading-tight dark:text-white">
              账户持仓、盘中哨兵预警与进化复盘中心
            </h2>
            <p className="mt-1 text-xs text-zinc-600 sm:text-[13px] dark:text-zinc-300">
              上半区实时追踪持仓保护与哨兵警报，切换或同屏展开下翼即可查看净值 vs SPY 曲线、四象限归因与 Playbook 铁律
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[10.5px] font-semibold text-zinc-500 dark:text-zinc-400">
                一键切换数据源:
              </span>
              {BROKER_QUICK_PILLS.map((pill) => {
                const isSelected = activeBrokerId === pill.id;
                return (
                  <button
                    key={pill.id}
                    type="button"
                    onClick={() => handleQuickSwitchBroker(pill.id)}
                    className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-semibold transition ${
                      isSelected
                        ? "bg-zinc-950 text-white shadow-sm dark:bg-white dark:text-zinc-950"
                        : "bg-zinc-200/75 text-zinc-700 hover:bg-zinc-300/80 dark:bg-white/[0.08] dark:text-zinc-300 dark:hover:bg-white/[0.15]"
                    }`}
                  >
                    {pill.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="inline-flex items-center gap-1.5 rounded-xl bg-zinc-100 px-3 py-2 font-mono text-xs font-medium text-zinc-800 transition hover:bg-zinc-200 dark:bg-white/10 dark:text-zinc-100 dark:hover:bg-white/20"
              >
                <Settings className="h-3.5 w-3.5" />
                切换券商 / 导入持仓
              </button>
            )}
            {ledger?.requires_admin_token && !isReadOnly && (
              <input
                type="password"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                placeholder="X-Admin-Token (平仓/撤单)"
                className="rounded-xl border border-zinc-300 bg-white px-3 py-2 font-mono text-xs text-zinc-950 placeholder:text-zinc-500 dark:border-white/15 dark:bg-black/50 dark:text-white"
              />
            )}
            <button
              type="button"
              onClick={handleSyncOrders}
              disabled={syncing}
              className="rounded-xl bg-zinc-100 px-3.5 py-2 font-mono text-xs font-medium text-zinc-900 transition hover:bg-zinc-200 disabled:opacity-50 dark:bg-white/10 dark:text-white dark:hover:bg-white/20"
            >
              {syncing
                ? "正在同步..."
                : brokerProfile?.sync_button_label || "同步持仓估值与成交"}
            </button>
            <button
              type="button"
              onClick={handleScanWatchdog}
              disabled={scanning}
              className="rounded-xl bg-zinc-950 px-4 py-2 font-mono text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-[#F3F3F0] dark:text-[#0B0B0D] dark:hover:bg-white"
            >
              {scanning ? "哨兵巡检中..." : "立即运行盘中哨兵巡检"}
            </button>
          </div>
        </div>

        {/* Dismissible 4-Step Beginner Onboarding Rail */}
        {showGuide && (
          <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] px-4 py-3 dark:border-emerald-400/25 dark:bg-emerald-500/[0.08]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[11px] font-bold text-emerald-800 dark:text-emerald-300">
                4 步看懂本工作台闭环（新手指南）
              </span>
              <button
                type="button"
                onClick={dismissGuide}
                className="font-mono text-[11px] text-emerald-800/80 underline hover:text-emerald-950 dark:text-emerald-300 dark:hover:text-white"
              >
                我知道了，收起引导
              </button>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 text-xs text-zinc-700 sm:grid-cols-2 lg:grid-cols-4 dark:text-zinc-200">
              <button
                type="button"
                onClick={() => onOpenSettings?.()}
                className="rounded-xl bg-white/80 px-3 py-2 text-left transition hover:bg-white dark:bg-white/[0.06] dark:hover:bg-white/10"
              >
                <strong className="block text-zinc-950 dark:text-white">① 接入数据或用沙盒</strong>
                <span className="text-[11px] text-zinc-600 dark:text-zinc-400">
                  支持 IBKR、币安、T212、CSV 账单或免密 24/7 本地模拟盘
                </span>
              </button>
              <button
                type="button"
                onClick={() => setActiveWorkspace("monitor")}
                className="rounded-xl bg-white/80 px-3 py-2 text-left transition hover:bg-white dark:bg-white/[0.06] dark:hover:bg-white/10"
              >
                <strong className="block text-zinc-950 dark:text-white">② 处置高危预警</strong>
                <span className="text-[11px] text-zinc-600 dark:text-zinc-400">
                  红色预警点「AI 会诊」查破位，或点「生成防守/减仓单」护盘
                </span>
              </button>
              <button
                type="button"
                onClick={() => setActiveWorkspace("review")}
                className="rounded-xl bg-white/80 px-3 py-2 text-left transition hover:bg-white dark:bg-white/[0.06] dark:hover:bg-white/10"
              >
                <strong className="block text-zinc-950 dark:text-white">③ 四象限绩效复盘</strong>
                <span className="text-[11px] text-zinc-600 dark:text-zinc-400">
                  平仓后甄别「守纪盈利」与「侥幸赌对」，对齐 SPY 超额收益
                </span>
              </button>
              <button
                type="button"
                onClick={() => setActiveWorkspace("review")}
                className="rounded-xl bg-white/80 px-3 py-2 text-left transition hover:bg-white dark:bg-white/[0.06] dark:hover:bg-white/10"
              >
                <strong className="block text-zinc-950 dark:text-white">④ 置顶 Playbook 铁律</strong>
                <span className="text-[11px] text-zinc-600 dark:text-zinc-400">
                  教练提炼并置顶的铁律将强制注入下次 AI 调研与风控审批
                </span>
              </button>
            </div>
          </div>
        )}

        {/* Dual-Layer Hero Body: Left Capital Core (7 cols) + Right Action Priority Inbox (5 cols) */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:col-span-7">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.38, delay: 0.04, ease: EASE_EXPO }}
              whileHover={{ y: -2, scale: 1.008 }}
              className="rounded-xl bg-zinc-50/90 px-4 py-3 transition-shadow hover:shadow-sm dark:bg-white/[0.04]"
            >
              <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
                账户总净值 ({acctCcy})
              </div>
              <div className="mt-1 font-mono text-xl font-bold tabular-nums text-zinc-950 dark:text-white">
                {fmtCurrency(ledger?.account?.equity, acctCcy)}
              </div>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.38, delay: 0.08, ease: EASE_EXPO }}
              whileHover={{ y: -2, scale: 1.008 }}
              className="rounded-xl bg-zinc-50/90 px-4 py-3 transition-shadow hover:shadow-sm dark:bg-white/[0.04]"
            >
              <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
                可用现金 / 购买力
              </div>
              <div className="mt-1 font-mono text-xl font-bold tabular-nums text-zinc-950 dark:text-white">
                {fmtCurrency(ledger?.account?.buying_power, acctCcy)}
              </div>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.38, delay: 0.12, ease: EASE_EXPO }}
              whileHover={{ y: -2, scale: 1.008 }}
              className="rounded-xl bg-zinc-50/90 px-4 py-3 transition-shadow hover:shadow-sm dark:bg-white/[0.04]"
            >
              <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
                当前持仓标的数量
              </div>
              <div className="mt-1 font-mono text-xl font-bold tabular-nums text-zinc-950 dark:text-white">
                {ledger?.positions.length ?? 0}
              </div>
            </motion.div>
            <motion.button
              type="button"
              onClick={() => setActiveWorkspace("review")}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.38, delay: 0.16, ease: EASE_EXPO }}
              whileHover={{ y: -2, scale: 1.008 }}
              className="rounded-xl bg-zinc-50/90 px-4 py-3 text-left transition hover:bg-zinc-100 hover:shadow-sm dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
            >
              <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
                {hasAnalyticsSample ? "真实 Alpha / 纪律" : "绩效与铁律入口 →"}
              </div>
              <div className="mt-1 whitespace-nowrap font-mono text-base font-bold tabular-nums text-emerald-700 sm:text-lg dark:text-emerald-300">
                {kpiRef
                  ? `${(kpiRef.excess_alpha_pct ?? 0) >= 0 ? "+" : ""}${(kpiRef.excess_alpha_pct ?? 0).toFixed(1)}% · ${
                      kpiRef.avg_process_score !== null && kpiRef.avg_process_score !== undefined
                        ? `${Math.round(kpiRef.avg_process_score)} 分`
                        : `${memories.length} 铁律`
                    }`
                  : `${memories.length} 铁律`}
              </div>
            </motion.button>
          </div>

          {/* Right: Action Priority Inbox */}
          <div className="flex flex-col justify-between gap-2.5 rounded-xl border border-zinc-200/80 bg-zinc-50/85 px-4 py-3 lg:col-span-5 dark:border-white/10 dark:bg-white/[0.04]">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-200">
                今日优先决策清单 (Next Actions)
              </span>
              <span className="font-mono text-[10.5px] text-zinc-500 dark:text-zinc-400">
                铁律库 {memories.length} 条
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {highSeverityUnacked.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setActiveWorkspace("monitor")}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 font-mono text-[11px] font-semibold text-white transition hover:bg-rose-500"
                >
                  <ShieldAlert className="h-3.5 w-3.5" />
                  {highSeverityUnacked.length} 条高危预警待处置
                </button>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 px-2.5 py-1 font-mono text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  暂无未处理高危预警
                </span>
              )}

              <button
                type="button"
                onClick={() => setActiveWorkspace("review")}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-950 px-3 py-1.5 font-mono text-[11px] font-semibold text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
              >
                <BarChart3 className="h-3.5 w-3.5" />
                {unreviewedClosedCount > 0
                  ? `${unreviewedClosedCount} 笔平仓待复盘`
                  : "打开周期教练与 Playbook →"}
              </button>
            </div>
          </div>
        </div>

        {/* Phase 3: Watchdog Autopilot Sentinel Strip */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200/80 bg-zinc-50/85 px-4 py-2.5 dark:border-white/10 dark:bg-white/[0.04]">
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[11px] font-semibold ${
                autopilot?.enabled
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : "bg-amber-500/15 text-amber-800 dark:text-amber-300"
              }`}
            >
              <Radio className={`h-3 w-3 ${autopilot?.enabled ? "animate-pulse" : ""}`} />
              {autopilot?.enabled ? "后台哨兵常驻 · 运行中" : "后台哨兵已暂停"}
            </span>
            <span className="font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
              {autopilot?.run_24_7 ? "24/7 全天候沙盒巡检" : "仅常规交易时段"}
            </span>
            {autopilot?.last_run_at && (
              <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                上次巡检 {new Date(autopilot.last_run_at).toLocaleTimeString()} · 累计{" "}
                {autopilot.run_count} 轮
                {autopilot.last_summary
                  ? ` · 上轮自动复盘 ${autopilot.last_summary.reflected_count} 笔`
                  : ""}
              </span>
            )}
            {autopilot?.enabled && countdownSec !== null && (
              <span className="inline-flex items-center gap-1 rounded-full bg-zinc-200/80 px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-zinc-800 dark:bg-white/10 dark:text-zinc-200">
                <Clock className="h-3 w-3" />
                {String(Math.floor(countdownSec / 60)).padStart(2, "0")}:
                {String(countdownSec % 60).padStart(2, "0")}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <LayoutGroup id="autopilot-interval-group">
            <div className="inline-flex items-center rounded-lg bg-zinc-200/75 p-0.5 font-mono text-[11px] dark:bg-white/10">
              {[300, 900, 1800].map((sec) => {
                const active = (autopilot?.interval_seconds ?? 900) === sec;
                return (
                  <button
                    key={sec}
                    type="button"
                    disabled={autopilotBusy || !autopilot}
                    onClick={() => handleAutopilotInterval(sec)}
                    className={`relative rounded-md px-2 py-0.5 transition-colors disabled:opacity-50 ${
                      active
                        ? "font-semibold text-white dark:text-zinc-950"
                        : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                    }`}
                  >
                    {active && (
                      <motion.span
                        layoutId="autopilot-interval-pill"
                        transition={{ type: "spring", stiffness: 420, damping: 32 }}
                        className="absolute inset-0 rounded-md bg-zinc-950 dark:bg-white"
                      />
                    )}
                    <span className="relative z-10">{Math.round(sec / 60)}m</span>
                  </button>
                );
              })}
            </div>
            </LayoutGroup>
            <button
              type="button"
              disabled={autopilotBusy || !autopilot}
              onClick={handleAutopilotToggle}
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 font-mono text-[11px] font-semibold transition disabled:opacity-50 ${
                autopilot?.enabled
                  ? "bg-amber-500/15 text-amber-800 hover:bg-amber-500/25 dark:text-amber-300"
                  : "bg-emerald-600 text-white hover:bg-emerald-500"
              }`}
            >
              {autopilot?.enabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              {autopilot?.enabled ? "暂停巡检" : "开启巡检"}
            </button>
            <button
              type="button"
              disabled={autopilotBusy || autopilot?.running_now}
              onClick={handleAutopilotRunNow}
              className="rounded-lg bg-zinc-950 px-2.5 py-1 font-mono text-[11px] font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              {autopilotBusy || autopilot?.running_now ? "自动巡检+复盘中..." : "立即巡检+自动复盘"}
            </button>
          </div>
        </div>
      </SpotlightBlock>

      {banner && (
        <div className="flex items-center justify-between rounded-xl border border-emerald-500/35 bg-emerald-500/[0.12] px-4 py-2.5 text-xs text-emerald-950 dark:text-emerald-200">
          <span>{banner}</span>
          <button type="button" onClick={() => setBanner(null)} className="font-mono text-[11px] underline">
            关闭
          </button>
        </div>
      )}
      {(errorMsg || ledger?.broker_error) && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-900 dark:text-amber-200">
          <span>{errorMsg || ledger?.broker_error}</span>
          <div className="flex items-center gap-2">
            {onOpenSettings &&
              ((ledger?.broker && ledger.broker !== "sandbox") ||
                /key|密钥|llm|openai|deepseek/i.test(errorMsg || "")) && (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="rounded-full bg-amber-400 px-3 py-1 font-mono text-[11px] font-bold text-zinc-950 hover:bg-amber-300"
                >
                  前往设置检查配置
                </button>
              )}
            {errorMsg && (
              <button
                type="button"
                onClick={() => setErrorMsg(null)}
                className="font-mono text-[11px] underline opacity-80 hover:opacity-100"
              >
                关闭
              </button>
            )}
          </div>
        </div>
      )}

      {/* Flagship Dual-Wing Workspace Command Deck (Zero-Border Aurora Corner Glow) */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <span className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-200">
            选择工作台视图 (点击左侧实时应急 / 右侧全量复盘，或切换同屏全览)
          </span>
          <button
            type="button"
            onClick={() =>
              setActiveWorkspace((prev) => (prev === "all" ? "monitor" : "all"))
            }
            className={`aurora-deck-card inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-mono text-[11px] font-semibold ${
              activeWorkspace === "all"
                ? "bg-emerald-600 text-white shadow-sm dark:bg-emerald-500 dark:text-zinc-950"
                : "aurora-deck-idle text-zinc-800 dark:text-zinc-100"
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {activeWorkspace === "all" ? "当前：同屏全览（点此切回分栏专注）" : "⚡ 同屏全览全部模块"}
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
          <button
            type="button"
            onClick={() => setActiveWorkspace("monitor")}
            className={`aurora-deck-card group overflow-hidden rounded-2xl p-4 text-left ${
              activeWorkspace === "monitor" || activeWorkspace === "all"
                ? "aurora-deck-emerald"
                : "aurora-deck-idle"
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-center gap-3">
                <span
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition ${
                    activeWorkspace === "monitor" || activeWorkspace === "all"
                      ? "bg-emerald-600 text-white shadow-sm dark:bg-emerald-400 dark:text-zinc-950"
                      : "bg-emerald-500/[0.14] text-emerald-700 group-hover:bg-emerald-500/[0.22] dark:text-emerald-300"
                  }`}
                >
                  <Activity className="h-5 w-5" />
                </span>
                <div>
                  <div className="font-serif text-base font-bold tracking-tight text-zinc-950 sm:text-[17px] dark:text-white">
                    实时持仓监控 &amp; 哨兵应急
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] font-medium text-emerald-800/90 dark:text-emerald-300/90">
                    现价止盈止损防守轨 · AI 会诊 · 一键减仓单
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 font-mono text-[11px]">
                <span className="rounded-full bg-zinc-950/[0.08] px-2.5 py-0.5 font-bold tabular-nums text-zinc-900 dark:bg-white/[0.12] dark:text-white">
                  {ledger?.positions.length ?? 0} 持仓
                </span>
                <span
                  className={`rounded-full px-2.5 py-0.5 font-bold tabular-nums ${
                    highSeverityUnacked.length > 0
                      ? "bg-rose-600 text-white shadow-sm"
                      : "bg-amber-500/[0.18] text-amber-800 dark:text-amber-200"
                  }`}
                >
                  {unackedCount} 预警
                </span>
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setActiveWorkspace("review")}
            className={`aurora-deck-card group overflow-hidden rounded-2xl p-4 text-left ${
              activeWorkspace === "review" || activeWorkspace === "all"
                ? "aurora-deck-sky"
                : "aurora-deck-idle"
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-center gap-3">
                <span
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition ${
                    activeWorkspace === "review" || activeWorkspace === "all"
                      ? "bg-gradient-to-br from-sky-600 to-indigo-600 text-white shadow-sm dark:from-sky-400 dark:to-indigo-400 dark:text-zinc-950"
                      : "bg-sky-500/[0.14] text-sky-700 group-hover:bg-sky-500/[0.22] dark:text-sky-300"
                  }`}
                >
                  <BarChart3 className="h-5 w-5" />
                </span>
                <div>
                  <div className="font-serif text-base font-bold tracking-tight text-zinc-950 sm:text-[17px] dark:text-white">
                    绩效归因图表 · 审计台账 &amp; Playbook
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] font-medium text-sky-800/90 dark:text-sky-300/90">
                    净值 vs SPY 曲线 · 四象限散点矩阵 · AI 周期教练
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 font-mono text-[11px]">
                <span className="rounded-full bg-sky-500/[0.16] px-2.5 py-0.5 font-bold tabular-nums text-sky-800 dark:text-sky-200">
                  {reviews.length} 复盘
                </span>
                <span className="rounded-full bg-violet-500/[0.16] px-2.5 py-0.5 font-bold tabular-nums text-violet-800 dark:text-violet-200">
                  {memories.length} 铁律
                </span>
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* View A & View B Smooth Animated Transition Stage (Non-blocking keyed enter glide) */}
      <motion.div
        key={activeWorkspace}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, ease: EASE_EXPO }}
        className="space-y-5"
      >
      {(activeWorkspace === "monitor" || activeWorkspace === "all") && (
      <div className="space-y-4">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <SpotlightBlock tone="gallery" className="space-y-4 p-5 sm:p-6 lg:col-span-7">
          <div className="flex items-center justify-between border-b border-zinc-200/70 pb-3 dark:border-white/10">
            <div>
              <h3 className="font-serif text-lg font-semibold tracking-tight text-zinc-950 sm:text-xl dark:text-white">
                {brokerProfile?.positions_title || "实时持仓与活动委托"}
              </h3>
              <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-300">
                {isReadOnly
                  ? "当前处于只读同步状态；点击任意标的即可呼出 AI 进行持仓风险与 GEX 诊断，或生成防守方案"
                  : "可随时按最新市场收盘价模拟平仓并触发 4 象限复盘"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadAll(true)}
              className="rounded-lg bg-zinc-100 px-3 py-1.5 font-mono text-xs text-zinc-700 transition hover:bg-zinc-200 dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/20"
            >
              刷新
            </button>
          </div>

          {loading ? (
            <div className="py-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
              加载持仓与订单中...
            </div>
          ) : (
            <>
              <div>
                <h4 className="mb-2.5 font-mono text-[13px] font-semibold uppercase tracking-wider text-zinc-800 sm:text-sm dark:text-zinc-100">
                  当前持仓 ({ledger?.positions.length ?? 0})
                </h4>
                {!ledger || ledger.positions.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-zinc-300/80 px-3 py-5 text-center text-sm text-zinc-700 dark:border-white/15 dark:text-zinc-300">
                    {brokerProfile?.empty_positions_hint ||
                      "当前账户尚无持仓；可在「投研与风控台」发起 Risk Critic 风控演练单，或前往数据源中心导入已有持仓。"}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {ledger.positions.map((pos) => {
                      const posCcy = pos.currency || acctCcy;
                      const sl =
                        pos.stop_loss_price ?? Number((pos.avg_entry_price * 0.94).toFixed(2));
                      const tp =
                        pos.take_profit_price ?? Number((pos.avg_entry_price * 1.12).toFixed(2));
                      const lowBound = Math.min(sl, pos.avg_entry_price, pos.current_price, tp);
                      const highBound = Math.max(sl, pos.avg_entry_price, pos.current_price, tp);
                      const trackSpan = Math.max(0.01, highBound - lowBound);
                      const spotPct = Math.max(
                        2,
                        Math.min(98, ((pos.current_price - lowBound) / trackSpan) * 100)
                      );
                      const entryPct = Math.max(
                        2,
                        Math.min(98, ((pos.avg_entry_price - lowBound) / trackSpan) * 100)
                      );
                      const slPct = Math.max(2, Math.min(98, ((sl - lowBound) / trackSpan) * 100));
                      const tpPct = Math.max(2, Math.min(98, ((tp - lowBound) / trackSpan) * 100));
                      const distSlPct =
                        pos.current_price > 0
                          ? ((sl - pos.current_price) / pos.current_price) * 100
                          : 0;
                      const distTpPct =
                        pos.current_price > 0
                          ? ((tp - pos.current_price) / pos.current_price) * 100
                          : 0;
                      const halfQty = calcStepQty(pos.qty, 0.5);
                      const quarterQty = calcStepQty(pos.qty, 0.25);
                      const fullQty = pos.qty < 2 ? Math.max(0.0001, Number(pos.qty.toFixed(4))) : Math.max(1, Math.round(pos.qty));

                      return (
                        <div
                          key={`${pos.symbol}-${pos.raw_ticker || ""}`}
                          className="space-y-2.5 rounded-xl bg-zinc-50/90 px-4 py-3 text-sm dark:bg-white/[0.04]"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-3">
                              <button
                                type="button"
                                onClick={() => onSelectSymbol?.(pos.symbol)}
                                className="font-mono text-base font-bold text-zinc-950 underline-offset-4 hover:underline dark:text-white"
                              >
                                {pos.symbol}
                              </button>
                              <span className="font-mono text-xs font-medium text-zinc-700 dark:text-zinc-300">
                                {pos.qty} 股 @ 均价 {pos.avg_entry_price.toFixed(2)} → 现价{" "}
                                {pos.current_price.toFixed(2)}
                              </span>
                              <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                                市值 {fmtCurrency(pos.market_value, posCcy)}
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={`font-mono font-bold tabular-nums ${
                                  pos.unrealized_pl >= 0
                                    ? "text-emerald-700 dark:text-emerald-400"
                                    : "text-rose-700 dark:text-rose-400"
                                }`}
                              >
                                {pos.unrealized_pl >= 0 ? "+" : ""}
                                {fmtCurrency(pos.unrealized_pl, posCcy)} (
                                {(pos.unrealized_plpc * 100).toFixed(2)}%)
                              </span>
                              {onOpenCopilot && (
                                <button
                                  type="button"
                                  onClick={() => onOpenCopilot(pos.symbol)}
                                  className="inline-flex items-center gap-1 rounded-lg bg-zinc-200/80 px-2.5 py-1 font-mono text-xs font-semibold text-zinc-900 transition hover:bg-zinc-950 hover:text-white dark:bg-white/10 dark:text-zinc-100 dark:hover:bg-white dark:hover:text-zinc-950"
                                >
                                  <Sparkles className="h-3 w-3" />
                                  AI 体检
                                </button>
                              )}
                              {!isReadOnly && (
                                <button
                                  type="button"
                                  disabled={busyId === `close-${pos.symbol}`}
                                  onClick={() => handleClosePosition(pos.symbol)}
                                  className="rounded-lg bg-rose-500/[0.12] px-3 py-1 font-mono text-xs font-semibold text-rose-700 transition hover:bg-rose-500/20 disabled:opacity-50 dark:text-rose-300"
                                >
                                  {busyId === `close-${pos.symbol}` ? "平仓中..." : "按现价模拟平仓"}
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Phase 2 Live Position SL <- Entry/Spot -> TP Track Bar */}
                          <div className="space-y-1.5 rounded-xl bg-white/80 px-3 py-2 dark:bg-black/25">
                            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px]">
                              <span className="text-rose-700 dark:text-rose-300">
                                止损 SL ${sl.toFixed(2)} ({distSlPct >= 0 ? "+" : ""}
                                {distSlPct.toFixed(1)}%)
                                {pos.sl_is_estimated && (
                                  <span className="ml-1 text-zinc-500 dark:text-zinc-400">
                                    [ATR/结构估算]
                                  </span>
                                )}
                              </span>
                              {pos.zero_gamma && (
                                <span className="text-amber-700 dark:text-amber-300">
                                  Zero γ ${pos.zero_gamma.toFixed(2)}
                                </span>
                              )}
                              <span className="text-emerald-700 dark:text-emerald-300">
                                止盈 TP ${tp.toFixed(2)} (+{Math.max(0, distTpPct).toFixed(1)}%)
                              </span>
                            </div>

                            <div className="relative h-2 w-full rounded-full bg-zinc-200/85 dark:bg-white/[0.10]">
                              <div
                                className="absolute top-0 h-full rounded-full bg-gradient-to-r from-rose-500/50 via-sky-500/35 to-emerald-500/50"
                                style={{
                                  left: `${Math.min(slPct, tpPct)}%`,
                                  width: `${Math.max(4, Math.abs(tpPct - slPct))}%`,
                                }}
                              />
                              {/* Entry Cost Marker */}
                              <span
                                className="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-zinc-700 dark:bg-zinc-200"
                                style={{ left: `${entryPct}%` }}
                                title={`成本均价 $${pos.avg_entry_price.toFixed(2)}`}
                              />
                              {/* Current Spot Dot */}
                              <span
                                className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white dark:ring-zinc-900 ${
                                  pos.unrealized_pl >= 0 ? "bg-emerald-500" : "bg-rose-500"
                                }`}
                                style={{ left: `${spotPct}%` }}
                                title={`现价 $${pos.current_price.toFixed(2)}`}
                              />
                            </div>

                            {onOpenRiskTicket && (
                              <div className="flex flex-wrap items-center gap-1.5 pt-1 font-mono text-[10px]">
                                <span className="text-zinc-500 dark:text-zinc-400">
                                  经 Risk Critic 审批调仓:
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    onOpenRiskTicket({
                                      symbol: pos.symbol,
                                      side: pos.side === "short" ? "buy" : "sell",
                                      qty: halfQty,
                                      entryPrice: pos.current_price,
                                      stopLoss: null,
                                      takeProfit: null,
                                      riskBudgetPct: 1.0,
                                      rationale: `[持仓快捷减仓 50%] 对 ${pos.symbol} 拟减半仓 ${halfQty} 股锁定敞口并控制波动率回撤。`,
                                      nonce: Date.now(),
                                    })
                                  }
                                  className="inline-flex items-center gap-1 rounded-md bg-rose-500/[0.12] px-2 py-0.5 font-semibold text-rose-700 transition hover:bg-rose-500/20 dark:text-rose-300"
                                >
                                  <TrendingDown className="h-3 w-3" />
                                  减仓 50% ({halfQty}股)
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    onOpenRiskTicket({
                                      symbol: pos.symbol,
                                      side: pos.side === "short" ? "buy" : "sell",
                                      qty: fullQty,
                                      entryPrice: pos.current_price,
                                      stopLoss: null,
                                      takeProfit: null,
                                      riskBudgetPct: 1.0,
                                      rationale: `[移至保本止损单] 对 ${pos.symbol} 拟以成本均价 $${pos.avg_entry_price.toFixed(
                                        2
                                      )} 作为保护离场线评估防回撤退守方案（现价 $${pos.current_price.toFixed(2)}）。`,
                                      nonce: Date.now(),
                                    })
                                  }
                                  className="inline-flex items-center gap-1 rounded-md bg-sky-500/[0.12] px-2 py-0.5 font-semibold text-sky-700 transition hover:bg-sky-500/20 dark:text-sky-300"
                                >
                                  <ShieldCheck className="h-3 w-3" />
                                  移至保本止损
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    onOpenRiskTicket({
                                      symbol: pos.symbol,
                                      side: pos.side === "short" ? "sell" : "buy",
                                      qty: quarterQty,
                                      entryPrice: pos.current_price,
                                      stopLoss:
                                        pos.side !== "short" && sl < pos.current_price - 0.05
                                          ? sl
                                          : null,
                                      takeProfit:
                                        pos.side !== "short" && tp > pos.current_price + 0.05
                                          ? tp
                                          : null,
                                      riskBudgetPct: 1.0,
                                      rationale: `[持仓加仓预审] 现有持仓 ${pos.symbol} 拟顺势加仓 ${quarterQty} 股，提交 CRO 核验 1% 预算与集中度上限。`,
                                      nonce: Date.now(),
                                    })
                                  }
                                  className="inline-flex items-center gap-1 rounded-md bg-emerald-500/[0.12] px-2 py-0.5 font-semibold text-emerald-700 transition hover:bg-emerald-500/20 dark:text-emerald-300"
                                >
                                  <TrendingUp className="h-3 w-3" />
                                  加仓预审
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="pt-2">
                <h4 className="mb-2.5 font-mono text-[13px] font-semibold uppercase tracking-wider text-zinc-800 sm:text-sm dark:text-zinc-100">
                  活动与近期委托 ({ledger?.orders.length ?? 0})
                </h4>
                <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                  {(ledger?.orders ?? []).length === 0 ? (
                    <div className="rounded-xl bg-zinc-50/70 px-3 py-3 text-center font-mono text-xs text-zinc-500 dark:bg-white/[0.03] dark:text-zinc-400">
                      暂无挂单记录
                    </div>
                  ) : (
                    (ledger?.orders ?? []).slice(0, 10).map((ord) => {
                      const cancelable =
                        !isReadOnly &&
                        ["new", "accepted", "partially_filled", "pending_new", "held"].includes(
                          ord.status.toLowerCase()
                        );
                      return (
                        <div
                          key={ord.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-zinc-50/85 px-3.5 py-2.5 font-mono text-xs dark:bg-white/[0.04]"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-zinc-950 dark:text-white">{ord.symbol}</span>
                            <span className="font-medium text-zinc-700 dark:text-zinc-300">
                              {fmtSideZh(ord.side)} {ord.qty} 股
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="rounded bg-zinc-200/80 px-2 py-0.5 text-xs font-semibold text-zinc-900 dark:bg-white/[0.12] dark:text-zinc-100">
                              {fmtOrderStatusZh(ord.status)}
                              {ord.filled_avg_price ? ` @ $${Number(ord.filled_avg_price).toFixed(2)}` : ""}
                            </span>
                            {cancelable && (
                              <button
                                type="button"
                                disabled={busyId === `cancel-${ord.id}`}
                                onClick={() => handleCancelOrder(ord.id)}
                                className="rounded bg-amber-500/15 px-2.5 py-0.5 text-xs font-semibold text-amber-800 hover:bg-amber-500/25 disabled:opacity-50 dark:text-amber-200"
                              >
                                {busyId === `cancel-${ord.id}` ? "撤单中" : "撤单"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </>
          )}
        </SpotlightBlock>

        {/* Agent 3 Watchdog Alerts (Priority Triaged: HIGH/Unacked on top, secondary collapsible) */}
        <SpotlightBlock tone="gallery" className="space-y-3 p-5 sm:p-6 lg:col-span-5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/70 pb-3 dark:border-white/10">
            <div>
              <h3 className="font-serif text-lg font-semibold tracking-tight text-zinc-950 sm:text-xl dark:text-white">
                盘中哨兵异动雷达 (优先高危处置)
              </h3>
              <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                优先展示高危/未确认预警；点击「AI 会诊」或「生成防守/减仓单」直接闭环
              </p>
            </div>
          </div>

          {alerts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-300/80 px-4 py-8 text-center text-sm text-zinc-600 dark:border-white/15 dark:text-zinc-300">
              暂无异常预警记录，可点击上方「立即运行盘中哨兵巡检」。
            </div>
          ) : (
            <div className="space-y-2.5">
              <div className="max-h-[420px] space-y-2.5 overflow-y-auto pr-1">
                {(showAllAlerts ? sortedAlerts : visiblePrimaryAlerts).map((al) => (
                  <div
                    key={al.id}
                    className={`rounded-xl p-3.5 transition ${
                      al.acknowledged
                        ? "bg-zinc-50/70 opacity-75 dark:bg-white/[0.03]"
                        : al.severity === "high"
                          ? "border border-rose-500/35 bg-rose-500/10"
                          : "border border-amber-500/30 bg-amber-500/10"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded-full px-2 py-0.5 font-mono text-xs font-semibold ${
                            al.severity === "high"
                              ? "bg-rose-700 text-white"
                              : "bg-amber-700 text-white"
                          }`}
                        >
                          {fmtSeverityZh(al.severity)}
                        </span>
                        {al.symbol && (
                          <button
                            type="button"
                            onClick={() => onSelectSymbol?.(al.symbol || "SPY")}
                            className="rounded bg-white/85 px-2 py-0.5 font-mono text-xs font-bold text-zinc-950 hover:bg-white dark:bg-white/15 dark:text-white"
                          >
                            {al.symbol}
                          </button>
                        )}
                        <span className="font-mono text-xs font-medium text-zinc-600 dark:text-zinc-300">
                          {new Date(al.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        {onOpenCopilot && al.symbol && (
                          <button
                            type="button"
                            onClick={() => handleAlertConsult(al)}
                            className="rounded bg-zinc-950/90 px-2 py-0.5 font-mono text-[11px] font-semibold text-white hover:bg-zinc-800 dark:bg-white/15 dark:text-white dark:hover:bg-white/25"
                          >
                            AI 会诊
                          </button>
                        )}
                        {onOpenRiskTicket && al.symbol && (
                          <button
                            type="button"
                            onClick={() => handleAlertDefensiveOrder(al)}
                            className="inline-flex items-center gap-1 rounded bg-rose-600/90 px-2 py-0.5 font-mono text-[11px] font-semibold text-white hover:bg-rose-500 dark:bg-rose-500/80 dark:hover:bg-rose-500"
                          >
                            <ShieldAlert className="h-3 w-3" />
                            生成防守/减仓单
                          </button>
                        )}
                        {!al.acknowledged && (
                          <button
                            type="button"
                            disabled={busyId === `ack-${al.id}`}
                            onClick={() => handleAckAlert(al.id)}
                            className="rounded bg-white/90 px-2.5 py-0.5 font-mono text-xs font-medium text-zinc-800 hover:bg-zinc-950 hover:text-white dark:bg-white/10 dark:text-zinc-100"
                          >
                            已知悉
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="mt-1.5 text-sm font-semibold text-zinc-950 dark:text-white">
                      {al.title}
                    </div>
                    <div className="mt-1">
                      <MarkdownReport content={al.summary_markdown} compact />
                    </div>
                  </div>
                ))}
              </div>

              {secondaryAlerts.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAllAlerts((v) => !v)}
                  className="flex w-full items-center justify-between rounded-xl border border-zinc-200/80 bg-zinc-50/80 px-3 py-2 font-mono text-[11px] font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.08]"
                >
                  <span>
                    {showAllAlerts
                      ? `收起其余 (${secondaryAlerts.length}) 条中低级 / 已确认预警`
                      : `展开查看其余 (${secondaryAlerts.length}) 条中低级 / 历史预警`}
                  </span>
                  {showAllAlerts ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </div>
          )}
        </SpotlightBlock>
      </div>

      {activeWorkspace === "monitor" && (
        <div className="aurora-deck-card aurora-deck-sky flex flex-wrap items-center justify-between gap-3 rounded-2xl px-5 py-4">
          <div className="space-y-0.5">
            <div className="font-serif text-[15px] font-bold text-zinc-950 dark:text-white">
              想要看历史净值曲线 vs SPY、四象限散点矩阵、交易审计台账与 AI 周期教练？
            </div>
            <div className="font-mono text-xs text-zinc-600 dark:text-zinc-300">
              当前已积累 {ledger?.paper_trades.length ?? 0} 条台账记录 · {reviews.length} 份四象限复盘 · {memories.length} 条 Playbook 铁律
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveWorkspace("all")}
              className="rounded-xl bg-zinc-950/[0.06] px-3.5 py-2 font-mono text-xs font-semibold text-zinc-900 transition hover:bg-zinc-950/[0.12] dark:bg-white/10 dark:text-white dark:hover:bg-white/20"
            >
              ⚡ 同屏全览全部
            </button>
            <button
              type="button"
              onClick={() => setActiveWorkspace("review")}
              className="inline-flex items-center gap-1.5 rounded-xl bg-sky-600 px-4 py-2 font-mono text-xs font-semibold text-white shadow-sm transition hover:bg-sky-500 dark:bg-sky-400 dark:text-zinc-950 dark:hover:bg-sky-300"
            >
              <BarChart3 className="h-3.5 w-3.5" />
              切换到绩效归因与 Playbook →
            </button>
          </div>
        </div>
      )}
      </div>
      )}

      {/* View B: Performance Analytics, Audit Ledger, AI Coach & Playbook */}
      {(activeWorkspace === "review" || activeWorkspace === "all") && (
      <div className="space-y-5">
        <PortfolioAnalyticsCharts analytics={analytics} loading={analyticsLoading} />

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
          <SpotlightBlock tone="gallery" className="p-5 sm:p-6 xl:col-span-6">
            <div className="border-b border-zinc-200/70 pb-3 dark:border-white/10">
              <h3 className="font-serif text-lg font-semibold tracking-tight text-zinc-950 sm:text-xl dark:text-white">
                {brokerProfile?.ledger_title || "交易审计台账与一键归因复盘"}
              </h3>
              <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-300">
                对任意已审核、模拟平仓或从外部账户同步的交易生成「过程纪律 × 市场结果」4 象限归因
              </p>
            </div>

            <div className="mt-3 max-h-[420px] space-y-2.5 overflow-y-auto pr-1">
              {(ledger?.paper_trades ?? []).length === 0 ? (
                <p className="py-8 text-center text-xs text-zinc-500 dark:text-zinc-400">
                  暂无交易台账记录。可点击上方「同步」或在「投研与风控台」发起一笔审查。
                </p>
              ) : (
                (ledger?.paper_trades ?? []).map((t) => (
                  <div
                    key={t.id}
                    className="rounded-xl bg-zinc-50/85 p-3 text-xs dark:bg-white/[0.04]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 font-mono">
                        <span className="font-bold text-zinc-950 dark:text-white">
                          #{t.id} {t.symbol}
                        </span>
                        <span className="rounded bg-zinc-950 px-1.5 py-0.5 text-[10px] text-white dark:bg-white dark:text-zinc-950">
                          {fmtSideZh(t.side)} {t.qty}
                        </span>
                        <span className="rounded bg-white/90 px-2 py-0.5 text-[10px] text-zinc-800 dark:bg-white/10 dark:text-zinc-200">
                          {fmtOrderStatusZh(t.status)}
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={busyId === `reflect-${t.id}`}
                        onClick={() => handleReflectTrade(t.id)}
                        className="rounded-lg bg-zinc-950 px-2.5 py-1 font-mono text-[10px] font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-white/15 dark:text-white dark:hover:bg-white dark:hover:text-zinc-950"
                      >
                        {busyId === `reflect-${t.id}` ? "归因中..." : "生成 4-象限复盘"}
                      </button>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                      <span>成交/入场: {t.entry_price ? `$${t.entry_price.toFixed(2)}` : "—"}</span>
                      <span>止损: {t.stop_loss_price ? `$${t.stop_loss_price.toFixed(2)}` : "—"}</span>
                      <span>止盈: {t.take_profit_price ? `$${t.take_profit_price.toFixed(2)}` : "—"}</span>
                      <span>预算: {t.risk_budget_pct}%</span>
                      <span>体制: {formatRegimeLabel(t.regime_at_entry).split(" · ")[0]}</span>
                      {t.realized_pnl !== null && t.realized_pnl !== undefined && (
                        <span
                          className={
                            t.realized_pnl >= 0
                              ? "font-semibold text-emerald-700 dark:text-emerald-400"
                              : "font-semibold text-rose-700 dark:text-rose-400"
                          }
                        >
                          已实现盈亏: {t.realized_pnl >= 0 ? "+" : ""}${t.realized_pnl.toFixed(2)}
                        </span>
                      )}
                    </div>
                    {t.rationale_summary && (
                      <p className="mt-1 line-clamp-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                        {t.rationale_summary}
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          </SpotlightBlock>

          {/* 4-Quadrant Reviews, Playbook Iron Rules & AI Periodic Coach */}
          <PortfolioPlaybookPanel
            reviews={reviews}
            memories={memories}
            onRefreshData={() => loadAll(false)}
            onBanner={(msg) => setBanner(msg)}
            onError={(msg) => setErrorMsg(msg)}
          />
        </div>
      </div>
      )}
      </motion.div>
    </div>
  );
}

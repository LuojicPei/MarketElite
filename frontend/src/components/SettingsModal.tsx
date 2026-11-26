"use client";

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  FileSpreadsheet,
  KeyRound,
  Languages,
  Loader2,
  PlugZap,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Wallet,
  X,
  XCircle,
} from "lucide-react";
import {
  BinanceEnv,
  BrokerProviderId,
  LLM_PROVIDER_PRESETS,
  LlmProviderId,
  MarketEliteClientSettings,
  clearBrokerCredentials,
  clearLocalApiKey,
  getPresetById,
  hasConfiguredBrokerConnector,
  loadClientSettings,
  rotateWorkspaceId,
  saveClientSettings,
} from "@/lib/clientSettings";
import {
  ImportedHoldingItem,
  LiveModelItem,
  clearImportedHoldings,
  deleteImportedHolding,
  fetchByokModels,
  fetchImportedHoldings,
  importBrokerHoldings,
  testAgentConnection,
  testUnifiedBrokerConnection,
} from "@/lib/api";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  initialTab?: "llm" | "broker";
}

export default function SettingsModal({
  open,
  onClose,
  initialTab = "llm",
}: SettingsModalProps) {
  const [modalTab, setModalTab] = useState<"llm" | "broker">(initialTab);
  const [draft, setDraft] = useState<MarketEliteClientSettings>(() => loadClientSettings());
  const [showKey, setShowKey] = useState(false);
  const [showBrokerSecret, setShowBrokerSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [testingBroker, setTestingBroker] = useState(false);
  const [brokerResult, setBrokerResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [csvSource, setCsvSource] = useState("Robinhood / 券商导出");
  const [csvText, setCsvText] = useState("");
  const [csvReplace, setCsvReplace] = useState(false);
  const [importingCsv, setImportingCsv] = useState(false);
  const [importedHoldings, setImportedHoldings] = useState<ImportedHoldingItem[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [liveModels, setLiveModels] = useState<LiveModelItem[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [pickTarget, setPickTarget] = useState<"pro" | "fast">("pro");
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [activeSavedBroker, setActiveSavedBroker] = useState<BrokerProviderId>(
    () => loadClientSettings().brokerProvider
  );

  useEffect(() => {
    if (!open) return;
    setModalTab(initialTab);
    const loaded = loadClientSettings();
    setDraft(loaded);
    setActiveSavedBroker(loaded.brokerProvider);
    setShowKey(false);
    setShowBrokerSecret(false);
    setTestResult(null);
    setBrokerResult(null);
    setLiveModels([]);
    setModelsError(null);
    setModelSearch("");
    setSavedNotice(null);
    if (loaded.brokerProvider === "csv_import" || initialTab === "broker") {
      fetchImportedHoldings()
        .then((res) => setImportedHoldings(res.holdings))
        .catch(() => {});
    }
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  const activePreset = getPresetById(draft.provider);
  const hasKey = Boolean(draft.apiKey.trim());
  const hasT212 = Boolean(draft.trading212ApiKey.trim() && draft.trading212ApiSecret.trim());
  const hasIbkr = Boolean(draft.ibkrFlexToken.trim() && draft.ibkrQueryId.trim());
  const hasBinance = Boolean(draft.binanceApiKey.trim() && draft.binanceApiSecret.trim());
  const hasActiveExternalBroker =
    (draft.brokerProvider === "trading212" && hasT212) ||
    (draft.brokerProvider === "ibkr" && hasIbkr) ||
    (draft.brokerProvider === "binance" && hasBinance) ||
    (draft.brokerProvider === "csv_import" && importedHoldings.length > 0) ||
    draft.brokerProvider === "alpaca";

  const handleSelectProvider = (providerId: LlmProviderId) => {
    const preset = getPresetById(providerId);
    setDraft((prev) => ({
      ...prev,
      provider: providerId,
      baseUrl: preset.baseUrl,
      proModel: preset.defaultProModel,
      fastModel: preset.defaultFastModel,
    }));
    setTestResult(null);
    setLiveModels([]);
    setModelsError(null);
  };

  const handleFetchLiveModels = async () => {
    if (!draft.apiKey.trim()) {
      setModelsError("请先在上方填入您的 API Key，再从平台拉取最新可用模型列表。");
      return;
    }
    setFetchingModels(true);
    setModelsError(null);
    try {
      const res = await fetchByokModels({
        api_key: draft.apiKey.trim(),
        base_url: draft.baseUrl.trim() || activePreset.baseUrl,
      });
      setLiveModels(res.models);
      if (res.models.length === 0) {
        setModelsError("接口连接成功，但未返回任何聊天模型 ID，请直接在下方手动输入。");
      }
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : "拉取模型列表失败，请检查 Key 与 Base URL。");
    } finally {
      setFetchingModels(false);
    }
  };

  const handleTestConnection = async () => {
    if (!draft.apiKey.trim()) {
      setTestResult({ ok: false, message: "请先在上方填入您的 API Key 后再测试。" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testAgentConnection({
        api_key: draft.apiKey.trim(),
        base_url: draft.baseUrl.trim() || activePreset.baseUrl,
        model: draft.proModel.trim() || activePreset.defaultProModel,
      });
      setTestResult({
        ok: true,
        message: `连接成功！模型 ${res.model} 响应正常（延迟 ${res.latency_ms}ms，回复：${res.reply_preview}）`,
      });
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : "连接测试失败，请检查配置。",
      });
    } finally {
      setTesting(false);
    }
  };

  const handleTestBroker = async () => {
    setTestingBroker(true);
    setBrokerResult(null);
    try {
      const prov = draft.brokerProvider;
      const res = await testUnifiedBrokerConnection({
        provider: prov,
        api_key:
          prov === "trading212"
            ? draft.trading212ApiKey.trim()
            : prov === "binance"
              ? draft.binanceApiKey.trim()
              : "",
        api_secret:
          prov === "trading212"
            ? draft.trading212ApiSecret.trim()
            : prov === "binance"
              ? draft.binanceApiSecret.trim()
              : "",
        env: prov === "binance" ? draft.binanceEnv : draft.trading212Env,
        flex_token: draft.ibkrFlexToken.trim(),
        query_id: draft.ibkrQueryId.trim(),
      });
      setBrokerResult({
        ok: Boolean(res.ok),
        message:
          res.message ||
          `${prov.toUpperCase()} 连通成功（币种 ${res.currency || "USD"} · 净值 ${(res.equity ?? 0).toLocaleString()} · 持仓 ${res.positions_count ?? 0} 项）。`,
      });
    } catch (err) {
      setBrokerResult({
        ok: false,
        message: err instanceof Error ? err.message : "数据源连通测试失败，请核对只读凭证。",
      });
    } finally {
      setTestingBroker(false);
    }
  };

  const handleImportCsvHoldings = async () => {
    if (!csvText.trim() || importingCsv) return;
    setImportingCsv(true);
    setBrokerResult(null);
    try {
      const res = await importBrokerHoldings({
        raw_text: csvText,
        source_label: csvSource.trim() || "通用券商导入",
        replace_existing: csvReplace,
      });
      const list = await fetchImportedHoldings();
      setImportedHoldings(list.holdings);
      setCsvText("");
      setDraft((prev) => ({ ...prev, brokerProvider: "csv_import" }));
      setBrokerResult({
        ok: true,
        message: `成功解析并导入 ${res.imported_count} 项持仓 (${res.symbols.join(", ")})，点击保存配置即可生效！`,
      });
    } catch (err) {
      setBrokerResult({
        ok: false,
        message: err instanceof Error ? err.message : "持仓导入解析失败，请检查 CSV 格式。",
      });
    } finally {
      setImportingCsv(false);
    }
  };

  const handleCsvFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setCsvText(reader.result);
      }
    };
    reader.readAsText(file);
  };

  const BROKER_LABELS: Record<BrokerProviderId, string> = {
    sandbox: "本地拟真模拟盘 (24/7 Sandbox)",
    ibkr: "Interactive Brokers (IBKR Flex 只读)",
    binance: "Binance 币安现货 (只读)",
    trading212: "Trading212 (Invest / ISA 只读)",
    csv_import: "通用 CSV / 手动账本",
    alpaca: "Alpaca Paper (模拟直连)",
  };

  const applyAndSaveSettings = (nextSettings: MarketEliteClientSettings, autoClose = true) => {
    const saved = saveClientSettings(nextSettings);
    setDraft(saved);
    setActiveSavedBroker(saved.brokerProvider);
    setSavedNotice(
      `已保存并切换数据源：${BROKER_LABELS[saved.brokerProvider] || saved.brokerProvider.toUpperCase()}`
    );
    if (autoClose) {
      window.setTimeout(() => {
        onClose();
      }, 320);
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    applyAndSaveSettings(draft, true);
  };

  const handleClearKey = () => {
    const next = clearLocalApiKey();
    setDraft(next);
    setTestResult(null);
    setSavedNotice("已彻底清空本地浏览器存储的大模型 API Key");
  };

  const handleClearBrokerCreds = (target: BrokerProviderId) => {
    const next = clearBrokerCredentials(target);
    setDraft(next);
    setActiveSavedBroker(next.brokerProvider);
    setBrokerResult(null);
    setSavedNotice(`已清除 ${target.toUpperCase()} 凭证并切回本地 24/7 拟真模拟盘`);
  };

  return createPortal(
    <AnimatePresence>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="站点设置 · API 与阅读偏好"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-md sm:p-6"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 14 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 14 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          onClick={(e) => e.stopPropagation()}
          className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-zinc-200/90 bg-white/95 text-zinc-950 shadow-2xl backdrop-blur-2xl dark:border-white/15 dark:bg-zinc-950/95 dark:text-zinc-50"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-zinc-200/80 px-5 py-4 dark:border-white/10 sm:px-6">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-zinc-950 text-white shadow-sm dark:bg-white dark:text-zinc-950">
                <KeyRound className="h-4 w-4" />
              </div>
              <div>
                <h2 className="font-sans text-base font-bold tracking-tight">
                  API 模型配置与个人偏好设置
                </h2>
                <p className="font-sans text-[11px] text-zinc-500 dark:text-zinc-400">
                  无需修改任何服务器 .env 文件 · 所有用户独立在浏览器端配置自有密钥
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="关闭设置窗口"
              className="rounded-full border border-zinc-200 bg-zinc-100 p-2 text-zinc-700 transition hover:bg-zinc-200 dark:border-white/15 dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/20"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Segmented Modal Tabs */}
          <div className="flex items-center gap-2 border-b border-zinc-200/80 bg-zinc-50/80 px-5 py-2.5 dark:border-white/10 dark:bg-white/[0.03] sm:px-6">
            <button
              type="button"
              onClick={() => setModalTab("llm")}
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-sans text-xs font-semibold transition ${
                modalTab === "llm"
                  ? "bg-zinc-950 text-white shadow-sm dark:bg-white dark:text-zinc-950"
                  : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
              }`}
            >
              <KeyRound className="h-3.5 w-3.5" />
              AI 大模型密钥 {hasKey && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
            </button>
            <button
              type="button"
              onClick={() => setModalTab("broker")}
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-sans text-xs font-semibold transition ${
                modalTab === "broker"
                  ? "bg-zinc-950 text-white shadow-sm dark:bg-white dark:text-zinc-950"
                  : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
              }`}
            >
              <Wallet className="h-3.5 w-3.5" />
              数据源与券商接入
              {hasActiveExternalBroker && (
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              )}
            </button>
          </div>

          {/* Scrollable Body + Sticky Footer */}
          <form onSubmit={handleSave} className="flex min-h-0 flex-1 flex-col">
            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
            {modalTab === "broker" ? (
              <div className="space-y-4">
                {/* Active vs Pending Draft Indicator Bar */}
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-zinc-200/80 bg-zinc-50/90 px-3.5 py-2.5 text-xs dark:border-white/10 dark:bg-white/[0.04]">
                  <div className="flex flex-wrap items-center gap-2 font-sans">
                    <span className="text-zinc-500 dark:text-zinc-400">当前页面生效数据源：</span>
                    <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 font-mono text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
                      {BROKER_LABELS[activeSavedBroker] || activeSavedBroker.toUpperCase()}
                    </span>
                    {draft.brokerProvider !== activeSavedBroker && (
                      <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-amber-800 dark:text-amber-300">
                        已选待保存：{BROKER_LABELS[draft.brokerProvider]}
                      </span>
                    )}
                  </div>
                  {draft.brokerProvider !== activeSavedBroker && (
                    <button
                      type="button"
                      onClick={() => applyAndSaveSettings(draft, false)}
                      className="rounded-full bg-emerald-600 px-3 py-1 font-sans text-[11px] font-bold text-white transition hover:bg-emerald-500 dark:bg-emerald-500 dark:text-zinc-950"
                    >
                      立即应用切换
                    </button>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="block font-sans text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                    1. 选择要连接的证券账户 / 交易所 / 模拟沙盒引擎（选后点击底部「保存配置」或上方「立即应用」）
                  </label>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {(
                      [
                        {
                          id: "sandbox",
                          title: "本地拟真模拟盘",
                          badge: "24/7 免配直连",
                          desc: "内置 $100k 虚拟本金，免第三方密钥即可体验风控审单、平仓与四象限复盘。",
                        },
                        {
                          id: "ibkr",
                          title: "Interactive Brokers",
                          badge: "IBKR Flex 只读",
                          desc: "仅填 Flex Token + Query ID 同步真实美股/港股持仓与成交，无需挂本地 TWS。",
                        },
                        {
                          id: "binance",
                          title: "Binance 币安现货",
                          badge: "Crypto 只读",
                          desc: "使用纯 Reading 只读 API Key 接入 BTC/ETH/山寨现货持仓与 USD 实时估值。",
                        },
                        {
                          id: "trading212",
                          title: "Trading212",
                          badge: "Invest / ISA 只读",
                          desc: "同步 T212 真实账户净值、持仓与历史执行记录，演练单在本地记账。",
                        },
                        {
                          id: "csv_import",
                          title: "通用 CSV / 手动账本",
                          badge: "Robinhood / 富途 / 老虎",
                          desc: "无官方 API 券商的通用方案：粘贴或上传对账单 CSV，立享全部哨兵与 AI 风控。",
                        },
                        {
                          id: "alpaca",
                          title: "Alpaca Paper",
                          badge: "原生 Bracket 下单",
                          desc: "连接服务器 .env 配置的 Alpaca Paper Key 直接演练原生美股止盈止损单。",
                        },
                      ] as const
                    ).map((opt) => {
                      const active = draft.brokerProvider === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => {
                            setDraft((prev) => ({
                              ...prev,
                              brokerProvider: opt.id as BrokerProviderId,
                            }));
                            setBrokerResult(null);
                          }}
                          className={`flex flex-col items-start rounded-2xl border p-3 text-left transition ${
                            active
                              ? "border-emerald-500 bg-emerald-500/10 ring-1 ring-emerald-500/30 dark:border-emerald-400 dark:bg-emerald-500/15"
                              : "border-zinc-200 bg-zinc-50/80 hover:border-zinc-300 dark:border-white/10 dark:bg-white/[0.04] dark:hover:border-white/25"
                          }`}
                        >
                          <div className="flex w-full items-center justify-between gap-1">
                            <span className="font-sans text-xs font-bold">{opt.title}</span>
                          </div>
                          <span className="mt-1 rounded-full bg-zinc-950/[0.08] px-2 py-0.5 font-mono text-[10px] text-zinc-700 dark:bg-white/[0.12] dark:text-zinc-200">
                            {opt.badge}
                          </span>
                          <p className="mt-1.5 font-sans text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                            {opt.desc}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Sandbox / Alpaca Zero-Local-Key Quick Confirmation Panel */}
                {(draft.brokerProvider === "sandbox" || draft.brokerProvider === "alpaca") && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.08] p-4">
                    <div className="space-y-1 font-sans">
                      <div className="text-xs font-bold text-zinc-950 dark:text-white">
                        {draft.brokerProvider === "sandbox"
                          ? "本地 24/7 拟真模拟盘已就绪（免填任何外部密钥）"
                          : "Alpaca Paper 服务器原生纸交易通道（使用后端 .env 凭证）"}
                      </div>
                      <p className="text-[11px] text-zinc-600 dark:text-zinc-300">
                        {draft.brokerProvider === "sandbox"
                          ? "内置 $100,000 虚拟本金，全天候支持 Risk Critic 下单、按收盘价模拟平仓与 4 象限复盘。"
                          : "开启后「模拟盘与复盘」将实时同步 Alpaca Paper 真实纸交易持仓与 Bracket 挂单。"}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {draft.brokerProvider === "alpaca" && (
                        <button
                          type="button"
                          onClick={handleTestBroker}
                          disabled={testingBroker}
                          className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-white/80 px-3 py-1.5 font-sans text-xs font-semibold text-emerald-700 hover:bg-white disabled:opacity-50 dark:bg-white/10 dark:text-emerald-300"
                        >
                          {testingBroker ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
                          {testingBroker ? "正在握手..." : "测试 Alpaca 连通"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => applyAndSaveSettings(draft, true)}
                        className="rounded-full bg-emerald-600 px-4 py-1.5 font-sans text-xs font-bold text-white shadow-sm transition hover:bg-emerald-500 dark:bg-emerald-500 dark:text-zinc-950"
                      >
                        立即切换并进入该账户
                      </button>
                    </div>
                  </div>
                )}

                {/* IBKR Flex Read-Only Config */}
                {draft.brokerProvider === "ibkr" && (
                  <div className="space-y-3.5 rounded-2xl border border-zinc-200/90 bg-zinc-50/75 p-4 dark:border-white/15 dark:bg-white/[0.03]">
                    <div className="font-sans text-xs font-bold text-zinc-900 dark:text-white">
                      Interactive Brokers Flex Web Service 只读凭证（纯浏览器本地加密存储）
                    </div>
                    <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 font-sans text-[11px] text-sky-900 dark:text-sky-100">
                      公网免网关接入路径：登录 IBKR Client Portal ➔ <strong>业绩与报告 ➔ Flex 查询</strong>，创建包含
                      <code>未平仓头寸</code> 与 <code>交易</code> 的 Activity Flex Query，开启 Flex Web Service 获取只读 Token。
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label htmlFor="ibkr-token" className="block font-sans text-xs font-semibold">
                          IBKR Flex Token
                        </label>
                        <input
                          id="ibkr-token"
                          type={showBrokerSecret ? "text" : "password"}
                          value={draft.ibkrFlexToken}
                          onChange={(e) => {
                            setDraft((p) => ({ ...p, ibkrFlexToken: e.target.value }));
                            setBrokerResult(null);
                          }}
                          placeholder="粘贴 24 位数字 Flex Token..."
                          className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 font-mono text-xs text-zinc-950 dark:border-white/15 dark:bg-black/40 dark:text-white"
                        />
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="ibkr-qid" className="block font-sans text-xs font-semibold">
                          Flex Query ID
                        </label>
                        <div className="relative">
                          <input
                            id="ibkr-qid"
                            type="text"
                            value={draft.ibkrQueryId}
                            onChange={(e) => {
                              setDraft((p) => ({ ...p, ibkrQueryId: e.target.value }));
                              setBrokerResult(null);
                            }}
                            placeholder="例如: 987654"
                            className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 pr-10 font-mono text-xs text-zinc-950 dark:border-white/15 dark:bg-black/40 dark:text-white"
                          />
                          <button
                            type="button"
                            onClick={() => setShowBrokerSecret((v) => !v)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400"
                          >
                            {showBrokerSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => handleClearBrokerCreds("ibkr")}
                        disabled={!hasIbkr}
                        className="inline-flex items-center gap-1 font-sans text-xs font-medium text-rose-600 disabled:opacity-40 dark:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        清除 IBKR 凭证
                      </button>
                      <button
                        type="button"
                        onClick={handleTestBroker}
                        disabled={testingBroker}
                        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/[0.12] px-3.5 py-1.5 font-sans text-xs font-semibold text-emerald-700 hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-300"
                      >
                        {testingBroker ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
                        {testingBroker ? "正在验证..." : "测试 IBKR Flex 连通"}
                      </button>
                    </div>
                  </div>
                )}

                {/* Binance Read-Only Config */}
                {draft.brokerProvider === "binance" && (
                  <div className="space-y-3.5 rounded-2xl border border-zinc-200/90 bg-zinc-50/75 p-4 dark:border-white/15 dark:bg-white/[0.03]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-sans text-xs font-bold text-zinc-900 dark:text-white">
                        Binance 币安只读现货 API（纯浏览器 localStorage 存储）
                      </span>
                      <div className="inline-flex rounded-full border border-zinc-300 bg-white p-0.5 dark:border-white/15 dark:bg-black/40">
                        {([
                          { id: "global", label: "全球站 .com" },
                          { id: "us", label: "Binance.US" },
                          { id: "testnet", label: "Testnet" },
                        ] as const).map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => {
                              setDraft((p) => ({ ...p, binanceEnv: opt.id as BinanceEnv }));
                              setBrokerResult(null);
                            }}
                            className={`rounded-full px-2.5 py-0.5 font-mono text-[10.5px] font-semibold transition ${
                              draft.binanceEnv === opt.id
                                ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                                : "text-zinc-600 dark:text-zinc-300"
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 font-sans text-[11px] text-sky-900 dark:text-sky-100">
                      安全建议：在币安 API 管理页创建密钥时，仅保留 <code>Enable Reading（允许读取）</code>，严格关闭现货交易与提币权限。
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label htmlFor="bn-key" className="block font-sans text-xs font-semibold">
                          Binance API Key
                        </label>
                        <input
                          id="bn-key"
                          type={showBrokerSecret ? "text" : "password"}
                          value={draft.binanceApiKey}
                          onChange={(e) => {
                            setDraft((p) => ({ ...p, binanceApiKey: e.target.value }));
                            setBrokerResult(null);
                          }}
                          placeholder="粘贴 Read-Only API Key..."
                          className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 font-mono text-xs text-zinc-950 dark:border-white/15 dark:bg-black/40 dark:text-white"
                        />
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="bn-sec" className="block font-sans text-xs font-semibold">
                          Binance Secret Key
                        </label>
                        <div className="relative">
                          <input
                            id="bn-sec"
                            type={showBrokerSecret ? "text" : "password"}
                            value={draft.binanceApiSecret}
                            onChange={(e) => {
                              setDraft((p) => ({ ...p, binanceApiSecret: e.target.value }));
                              setBrokerResult(null);
                            }}
                            placeholder="粘贴 Secret Key..."
                            className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 pr-10 font-mono text-xs text-zinc-950 dark:border-white/15 dark:bg-black/40 dark:text-white"
                          />
                          <button
                            type="button"
                            onClick={() => setShowBrokerSecret((v) => !v)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400"
                          >
                            {showBrokerSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => handleClearBrokerCreds("binance")}
                        disabled={!hasBinance}
                        className="inline-flex items-center gap-1 font-sans text-xs font-medium text-rose-600 disabled:opacity-40 dark:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        清除 Binance 凭证
                      </button>
                      <button
                        type="button"
                        onClick={handleTestBroker}
                        disabled={testingBroker}
                        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/[0.12] px-3.5 py-1.5 font-sans text-xs font-semibold text-emerald-700 hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-300"
                      >
                        {testingBroker ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
                        {testingBroker ? "正在握手..." : "测试 Binance 只读连通"}
                      </button>
                    </div>
                  </div>
                )}

                {/* Trading212 Read-Only Config */}
                {draft.brokerProvider === "trading212" && (
                  <div className="space-y-3.5 rounded-2xl border border-zinc-200/90 bg-zinc-50/75 p-4 dark:border-white/15 dark:bg-white/[0.03]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-sans text-xs font-bold text-zinc-900 dark:text-white">
                        Trading212 v0 只读同步凭证（纯浏览器 localStorage 存储）
                      </span>
                      <div className="inline-flex rounded-full border border-zinc-300 bg-white p-0.5 dark:border-white/15 dark:bg-black/40">
                        {(["live", "demo"] as const).map((envOpt) => (
                          <button
                            key={envOpt}
                            type="button"
                            onClick={() => {
                              setDraft((prev) => ({ ...prev, trading212Env: envOpt }));
                              setBrokerResult(null);
                            }}
                            className={`rounded-full px-3 py-1 font-mono text-[11px] font-semibold transition ${
                              draft.trading212Env === envOpt
                                ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                                : "text-zinc-600 dark:text-zinc-300"
                            }`}
                          >
                            {envOpt === "live" ? "Live 实盘 (Invest / ISA)" : "Demo 练习盘"}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 font-sans text-[11px] text-sky-900 dark:text-sky-100">
                      推荐在 Trading212 App 内仅勾选：<code>Account data</code>、<code>Portfolio</code>、
                      <code>Orders - Read</code>、<code>History - Orders</code>、<code>Metadata</code>；关闭{" "}
                      <code>Orders - Execute</code> 保持 100% 只读安全。
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label
                          htmlFor="t212-api-key"
                          className="block font-sans text-xs font-semibold text-zinc-800 dark:text-zinc-200"
                        >
                          Trading212 API Key
                        </label>
                        <input
                          id="t212-api-key"
                          type={showBrokerSecret ? "text" : "password"}
                          autoComplete="off"
                          value={draft.trading212ApiKey}
                          onChange={(e) => {
                            setDraft((prev) => ({ ...prev, trading212ApiKey: e.target.value }));
                            setBrokerResult(null);
                          }}
                          placeholder="粘贴 Trading212 API Key..."
                          className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 font-mono text-xs text-zinc-950 outline-none focus:border-emerald-500 dark:border-white/15 dark:bg-black/40 dark:text-white"
                        />
                      </div>

                      <div className="space-y-1">
                        <label
                          htmlFor="t212-api-secret"
                          className="block font-sans text-xs font-semibold text-zinc-800 dark:text-zinc-200"
                        >
                          Trading212 API Secret
                        </label>
                        <div className="relative">
                          <input
                            id="t212-api-secret"
                            type={showBrokerSecret ? "text" : "password"}
                            autoComplete="off"
                            value={draft.trading212ApiSecret}
                            onChange={(e) => {
                              setDraft((prev) => ({ ...prev, trading212ApiSecret: e.target.value }));
                              setBrokerResult(null);
                            }}
                            placeholder="粘贴 Trading212 API Secret..."
                            className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 pr-10 font-mono text-xs text-zinc-950 outline-none focus:border-emerald-500 dark:border-white/15 dark:bg-black/40 dark:text-white"
                          />
                          <button
                            type="button"
                            onClick={() => setShowBrokerSecret((v) => !v)}
                            aria-label={showBrokerSecret ? "隐藏 Secret" : "显示 Secret"}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-white/10"
                          >
                            {showBrokerSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => handleClearBrokerCreds("trading212")}
                        disabled={!hasT212}
                        className="inline-flex items-center gap-1 font-sans text-xs font-medium text-rose-600 disabled:opacity-40 dark:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        清除 Trading212 凭证
                      </button>

                      <button
                        type="button"
                        onClick={handleTestBroker}
                        disabled={testingBroker}
                        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/[0.12] px-3.5 py-1.5 font-sans text-xs font-semibold text-emerald-700 transition hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-300"
                      >
                        {testingBroker ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <PlugZap className="h-3.5 w-3.5" />
                        )}
                        {testingBroker ? "正在握手..." : "测试 Trading212 连通"}
                      </button>
                    </div>
                  </div>
                )}

                {/* Universal CSV / Custom Portfolio Import */}
                {draft.brokerProvider === "csv_import" && (
                  <div className="space-y-3 rounded-2xl border border-zinc-200/90 bg-zinc-50/75 p-4 dark:border-white/15 dark:bg-white/[0.03]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 font-sans text-xs font-bold text-zinc-900 dark:text-white">
                        <FileSpreadsheet className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                        通用券商对账单 / 持仓快照导入（Robinhood · Webull · 富途 · 老虎 · Schwab）
                      </span>
                      <label className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-zinc-950 px-3 py-1 font-mono text-[11px] font-semibold text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950">
                        <Upload className="h-3 w-3" />
                        选择本地 CSV
                        <input
                          type="file"
                          accept=".csv,.txt"
                          onChange={handleCsvFileUpload}
                          className="hidden"
                        />
                      </label>
                    </div>

                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      <input
                        type="text"
                        value={csvSource}
                        onChange={(e) => setCsvSource(e.target.value)}
                        placeholder="来源标注（例如：Robinhood 美股账户）"
                        className="rounded-xl border border-zinc-300 bg-white px-3 py-1.5 font-sans text-xs text-zinc-950 dark:border-white/15 dark:bg-black/40 dark:text-white"
                      />
                      <label className="inline-flex items-center gap-2 font-sans text-xs text-zinc-700 dark:text-zinc-300">
                        <input
                          type="checkbox"
                          checked={csvReplace}
                          onChange={(e) => setCsvReplace(e.target.checked)}
                          className="rounded border-zinc-300"
                        />
                        导入前清空本空间旧导入持仓
                      </label>
                    </div>

                    <textarea
                      rows={4}
                      value={csvText}
                      onChange={(e) => setCsvText(e.target.value)}
                      placeholder={`可直接粘贴 CSV 或按每行简写输入：\nNVDA 12 @ 138.5\nAAPL, 20, 212.0\nSymbol,Shares,Avg Cost\nMSFT,8,415.0`}
                      className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 font-mono text-xs text-zinc-950 dark:border-white/15 dark:bg-black/40 dark:text-white"
                    />

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          await clearImportedHoldings();
                          setImportedHoldings([]);
                          setBrokerResult({ ok: true, message: "已清空当前工作空间的所有导入持仓。" });
                        }}
                        disabled={importedHoldings.length === 0}
                        className="inline-flex items-center gap-1 font-sans text-xs font-medium text-rose-600 disabled:opacity-40 dark:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        清空已导入 ({importedHoldings.length})
                      </button>

                      <button
                        type="button"
                        onClick={handleImportCsvHoldings}
                        disabled={importingCsv || !csvText.trim()}
                        className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-4 py-1.5 font-sans text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                      >
                        {importingCsv ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                        {importingCsv ? "正在解析入库..." : "解析并导入当前工作空间"}
                      </button>
                    </div>

                    {importedHoldings.length > 0 && (
                      <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto pt-1">
                        {importedHoldings.map((h) => (
                          <span
                            key={h.id}
                            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1 font-mono text-[11px] dark:border-white/15 dark:bg-white/[0.06]"
                          >
                            <strong>{h.symbol}</strong> ×{h.qty}
                            {h.avg_cost_price ? ` @ $${h.avg_cost_price}` : ""}
                            <button
                              type="button"
                              onClick={async () => {
                                await deleteImportedHolding(h.id);
                                setImportedHoldings((prev) => prev.filter((x) => x.id !== h.id));
                              }}
                              className="text-zinc-400 hover:text-rose-500"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {brokerResult && (
                  <div
                    className={`flex items-start gap-2 rounded-xl border px-3 py-2 font-sans text-xs ${
                      brokerResult.ok
                        ? "border-emerald-500/40 bg-emerald-500/[0.12] text-emerald-800 dark:text-emerald-200"
                        : "border-rose-500/40 bg-rose-500/[0.12] text-rose-800 dark:text-rose-200"
                    }`}
                  >
                    {brokerResult.ok ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    ) : (
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    )}
                    <span>{brokerResult.message}</span>
                  </div>
                )}

                {/* Public Multi-User Tenant Workspace Switcher */}
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-zinc-200/80 bg-zinc-50/70 px-3.5 py-2.5 dark:border-white/10 dark:bg-white/[0.03]">
                  <div className="space-y-0.5 font-sans">
                    <div className="flex items-center gap-2 text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                      <span>公网多用户工作空间隔离 ID</span>
                      <span className="rounded-md bg-zinc-200/90 px-2 py-0.5 font-mono text-[10.5px] text-zinc-800 dark:bg-white/10 dark:text-zinc-200">
                        {draft.workspaceId || "default"}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      公网访客均拥有独立隔离空间，互不干扰自选股、模拟台账与 Playbook 交易铁律。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const rotated = rotateWorkspaceId();
                      setDraft(rotated);
                      setSavedNotice(`已生成全新独立工作空间：${rotated.workspaceId}`);
                    }}
                    className="rounded-full border border-zinc-300 bg-white px-3 py-1 font-mono text-[11px] font-semibold text-zinc-800 transition hover:bg-zinc-100 dark:border-white/15 dark:bg-white/10 dark:text-zinc-100 dark:hover:bg-white/20"
                  >
                    + 新建空白隔离空间
                  </button>
                </div>
              </div>
            ) : (
              <>
            {/* Security & Status Banner */}
            <div
              className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border px-3.5 py-2.5 text-xs ${
                hasKey
                  ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-900 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-100"
                  : "border-amber-500/35 bg-amber-500/10 text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-100"
              }`}
            >
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="space-y-0.5 font-sans">
                  <div className="font-semibold">
                    {hasKey
                      ? "当前状态：已配置您的本地 API Key（可实时进行 AI 投研与风控）"
                      : "当前状态：未填写 API Key（行情、K线与新闻翻译免费看，AI 面板展示演示样例）"}
                  </div>
                  <div className="text-[11px] opacity-85">
                    隐私承诺：Key 严格保存在您当前浏览器的 localStorage，随单次请求透传，绝不存入服务器公共环境。
                  </div>
                </div>
              </div>
            </div>

            {/* Provider Presets */}
            <div className="space-y-2">
              <label className="block font-sans text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                1. 选择大模型服务商（一键填充接口地址与推荐模型）
              </label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {LLM_PROVIDER_PRESETS.map((preset) => {
                  const active = draft.provider === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => handleSelectProvider(preset.id)}
                      className={`flex flex-col items-start rounded-xl border p-2.5 text-left transition ${
                        active
                          ? "border-sky-500 bg-sky-500/10 shadow-sm ring-1 ring-sky-500/30 dark:border-sky-400 dark:bg-sky-500/15"
                          : "border-zinc-200 bg-zinc-50/80 hover:border-zinc-300 hover:bg-zinc-100/80 dark:border-white/10 dark:bg-white/5 dark:hover:border-white/25 dark:hover:bg-white/10"
                      }`}
                    >
                      <div className="flex w-full items-center justify-between gap-1">
                        <span className="font-sans text-xs font-bold">{preset.name}</span>
                      </div>
                      <span className="mt-1 rounded-full bg-zinc-950/[0.08] px-1.5 py-0.5 font-sans text-[10px] text-zinc-600 dark:bg-white/[0.12] dark:text-zinc-300">
                        {preset.badge}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="font-sans text-[11px] text-zinc-500 dark:text-zinc-400">
                {activePreset.helperHint}
              </p>
            </div>

            {/* API Key + Live Fetch Models + Test Button */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label
                  htmlFor="byok-api-key"
                  className="font-sans text-xs font-semibold text-zinc-800 dark:text-zinc-200"
                >
                  2. 填写您的 API Key
                </label>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleFetchLiveModels}
                    disabled={fetchingModels}
                    className="inline-flex items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1 font-sans text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-300"
                  >
                    <RefreshCw className={`h-3 w-3 ${fetchingModels ? "animate-spin" : ""}`} />
                    {fetchingModels ? "拉取中..." : "拉取最新模型列表"}
                  </button>
                  <button
                    type="button"
                    onClick={handleTestConnection}
                    disabled={testing}
                    className="inline-flex items-center gap-1 rounded-full border border-sky-500/35 bg-sky-500/10 px-2.5 py-1 font-sans text-[11px] font-semibold text-sky-700 transition hover:bg-sky-500/20 disabled:opacity-50 dark:text-sky-300"
                  >
                    {testing ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <PlugZap className="h-3 w-3" />
                    )}
                    {testing ? "测试握手中..." : "测试连通性"}
                  </button>
                </div>
              </div>

              <div className="relative">
                <input
                  id="byok-api-key"
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  value={draft.apiKey}
                  onChange={(e) => {
                    setDraft((prev) => ({ ...prev, apiKey: e.target.value }));
                    setTestResult(null);
                  }}
                  placeholder={`粘贴您的 ${activePreset.name} API Key（例如 sk-...）`}
                  className="w-full rounded-xl border border-zinc-300 bg-white px-3.5 py-2.5 pr-11 font-mono text-xs text-zinc-950 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 dark:border-white/15 dark:bg-black/40 dark:text-white"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "隐藏 Key" : "显示 Key"}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>

              {testResult && (
                <div
                  className={`flex items-start gap-2 rounded-xl border px-3 py-2 font-sans text-xs ${
                    testResult.ok
                      ? "border-emerald-500/40 bg-emerald-500/[0.12] text-emerald-800 dark:text-emerald-200"
                      : "border-rose-500/40 bg-rose-500/[0.12] text-rose-800 dark:text-rose-200"
                  }`}
                >
                  {testResult.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  )}
                  <span>{testResult.message}</span>
                </div>
              )}

              {modelsError && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 font-sans text-xs text-amber-800 dark:text-amber-200">
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{modelsError}</span>
                </div>
              )}

              {liveModels.length > 0 && (
                <div className="space-y-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-sans text-[11px] font-semibold text-emerald-800 dark:text-emerald-200">
                      已从您的接口实时拉取 {liveModels.length} 个可用模型：
                    </span>
                    <div className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white p-0.5 dark:border-white/15 dark:bg-black/40">
                      <button
                        type="button"
                        onClick={() => setPickTarget("pro")}
                        className={`rounded-full px-2 py-0.5 font-sans text-[10px] font-medium transition ${
                          pickTarget === "pro"
                            ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                            : "text-zinc-600 dark:text-zinc-300"
                        }`}
                      >
                        点击填入 → 深度(Pro)
                      </button>
                      <button
                        type="button"
                        onClick={() => setPickTarget("fast")}
                        className={`rounded-full px-2 py-0.5 font-sans text-[10px] font-medium transition ${
                          pickTarget === "fast"
                            ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                            : "text-zinc-600 dark:text-zinc-300"
                        }`}
                      >
                        点击填入 → 快速(Fast)
                      </button>
                    </div>
                  </div>

                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                    <input
                      type="text"
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      placeholder="筛选模型 ID（如 gemini-4 / gpt-6 / deepseek / claude...）"
                      className="w-full rounded-lg border border-zinc-200 bg-white py-1.5 pl-8 pr-3 font-mono text-[11px] text-zinc-900 outline-none focus:border-emerald-500 dark:border-white/15 dark:bg-black/40 dark:text-zinc-100"
                    />
                  </div>

                  <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto pr-1">
                    {liveModels
                      .filter((m) =>
                        !modelSearch.trim()
                          ? true
                          : m.id.toLowerCase().includes(modelSearch.trim().toLowerCase())
                      )
                      .slice(0, 80)
                      .map((m) => {
                        const isPicked =
                          pickTarget === "pro" ? draft.proModel === m.id : draft.fastModel === m.id;
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() =>
                              setDraft((prev) =>
                                pickTarget === "pro"
                                  ? { ...prev, proModel: m.id }
                                  : { ...prev, fastModel: m.id }
                              )
                            }
                            className={`rounded-lg px-2 py-1 font-mono text-[10px] transition ${
                              isPicked
                                ? "bg-emerald-600 font-bold text-white"
                                : "border border-zinc-200 bg-white text-zinc-800 hover:border-emerald-400 dark:border-white/15 dark:bg-white/10 dark:text-zinc-100"
                            }`}
                          >
                            {m.id}
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}
            </div>

            {/* Model Choices */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  htmlFor="byok-pro-model"
                  className="flex items-center gap-1 font-sans text-xs font-semibold text-zinc-800 dark:text-zinc-200"
                >
                  <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                  深度分析模型（投研 & Risk Critic）
                </label>
                <input
                  id="byok-pro-model"
                  type="text"
                  value={draft.proModel}
                  onChange={(e) => setDraft((prev) => ({ ...prev, proModel: e.target.value }))}
                  placeholder={activePreset.defaultProModel}
                  className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 font-mono text-xs text-zinc-950 outline-none focus:border-sky-500 dark:border-white/15 dark:bg-black/40 dark:text-white"
                />
                {activePreset.suggestedModels.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {activePreset.suggestedModels.map((m) => (
                      <button
                        key={`pro-${m}`}
                        type="button"
                        onClick={() => setDraft((prev) => ({ ...prev, proModel: m }))}
                        className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] transition ${
                          draft.proModel === m
                            ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-950"
                            : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-white/10 dark:text-zinc-300"
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="byok-fast-model"
                  className="font-sans text-xs font-semibold text-zinc-800 dark:text-zinc-200"
                >
                  快速汇总模型（摘要 & 盘中哨兵）
                </label>
                <input
                  id="byok-fast-model"
                  type="text"
                  value={draft.fastModel}
                  onChange={(e) => setDraft((prev) => ({ ...prev, fastModel: e.target.value }))}
                  placeholder={activePreset.defaultFastModel}
                  className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 font-mono text-xs text-zinc-950 outline-none focus:border-sky-500 dark:border-white/15 dark:bg-black/40 dark:text-white"
                />
                {activePreset.suggestedModels.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {activePreset.suggestedModels.map((m) => (
                      <button
                        key={`fast-${m}`}
                        type="button"
                        onClick={() => setDraft((prev) => ({ ...prev, fastModel: m }))}
                        className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] transition ${
                          draft.fastModel === m
                            ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-950"
                            : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-white/10 dark:text-zinc-300"
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Base URL */}
            <div className="space-y-1.5">
              <label
                htmlFor="byok-base-url"
                className="block font-sans text-xs font-semibold text-zinc-800 dark:text-zinc-200"
              >
                API Base URL（选预设后通常无需修改）
              </label>
              <input
                id="byok-base-url"
                type="url"
                value={draft.baseUrl}
                onChange={(e) => setDraft((prev) => ({ ...prev, baseUrl: e.target.value }))}
                placeholder="https://api.deepseek.com/v1"
                className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 font-mono text-xs text-zinc-950 outline-none focus:border-sky-500 dark:border-white/15 dark:bg-black/40 dark:text-white"
              />
            </div>
              </>
            )}

            {/* Reading Preference */}
            <div className="rounded-2xl border border-zinc-200/90 bg-zinc-50/75 p-3.5 dark:border-white/10 dark:bg-white/5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Languages className="h-4 w-4 text-sky-600 dark:text-sky-400" />
                  <div>
                    <div className="font-sans text-xs font-semibold">
                      新闻弹窗默认阅读视图（站内零额度实时翻译）
                    </div>
                    <div className="font-sans text-[11px] text-zinc-500 dark:text-zinc-400">
                      无论选哪项，阅读时均可随时点击右上角按钮临时切换
                    </div>
                  </div>
                </div>

                <div className="inline-flex rounded-full border border-zinc-300 bg-white p-0.5 dark:border-white/15 dark:bg-black/40">
                  <button
                    type="button"
                    onClick={() => setDraft((prev) => ({ ...prev, newsDefaultBilingual: false }))}
                    className={`rounded-full px-3 py-1 font-sans text-[11px] font-medium transition ${
                      !draft.newsDefaultBilingual
                        ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                        : "text-zinc-600 dark:text-zinc-300"
                    }`}
                  >
                    默认纯中文
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraft((prev) => ({ ...prev, newsDefaultBilingual: true }))}
                    className={`rounded-full px-3 py-1 font-sans text-[11px] font-medium transition ${
                      draft.newsDefaultBilingual
                        ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                        : "text-zinc-600 dark:text-zinc-300"
                    }`}
                  >
                    默认中英对照
                  </button>
                </div>
              </div>
            </div>

            </div>

            {/* Sticky Always-Visible Footer Actions */}
            <div className="shrink-0 space-y-2.5 border-t border-zinc-200/80 bg-white/95 px-5 py-3.5 dark:border-white/10 dark:bg-zinc-950/95 sm:px-6">
              {savedNotice && (
                <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/[0.12] px-3.5 py-2 text-center font-sans text-xs font-medium text-emerald-800 dark:text-emerald-200">
                  {savedNotice}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={handleClearKey}
                  disabled={!hasKey}
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-sans text-xs font-medium text-rose-600 transition hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-40 dark:text-rose-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  清除大模型密钥
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-full border border-zinc-300 bg-white px-4 py-2 font-sans text-xs font-medium text-zinc-800 transition hover:bg-zinc-100 dark:border-white/15 dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/15"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="rounded-full bg-zinc-950 px-5 py-2 font-sans text-xs font-semibold text-white shadow-sm transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                  >
                    保存配置并生效
                  </button>
                </div>
              </div>
            </div>
          </form>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body
  );
}

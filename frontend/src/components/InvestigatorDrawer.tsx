"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpRight,
  Bot,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cpu,
  FileSearch,
  HelpCircle,
  History,
  KeyRound,
  Loader2,
  Maximize2,
  Plus,
  RefreshCw,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Swords,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  AgentStatusResponse,
  InvestigatorThreadSummary,
  RiskPrefillDraft,
  SecSearchResponse,
  TradeIntentInfo,
  deleteInvestigatorThread,
  fetchAgentStatus,
  fetchInvestigatorThreadDetail,
  fetchInvestigatorThreads,
  searchSecFilings,
  streamInvestigate,
} from "@/lib/api";
import { SETTINGS_UPDATED_EVENT } from "@/lib/clientSettings";
import { INVESTIGATOR_SHOWCASE_SAMPLE } from "@/lib/showcaseSamples";
import RiskCriticPanel from "@/components/RiskCriticPanel";
import DebateArenaPanel from "@/components/DebateArenaPanel";
import { MarkdownReport } from "@/components/MarkdownReport";
import SpotlightBlock from "@/components/SpotlightBlock";

const EASE_EXPO = [0.16, 1, 0.3, 1] as const;

interface ToolTraceItem {
  tool: string;
  args?: Record<string, unknown>;
  status: string;
  latency_ms?: number;
  preview?: string;
  output?: string;
}

interface MemoryHitItem {
  id?: number;
  symbol?: string;
  regime_label?: string;
  quadrant_outcome?: string;
  title?: string;
  lesson_text?: string;
  alpha_vs_spy_pct?: number | null;
}

interface InvestigatorDrawerProps {
  open: boolean;
  onClose?: () => void;
  defaultSymbol: string;
  mode?: "drawer" | "split";
  onOpenFullWorkspace?: () => void;
  onOpenSettings?: () => void;
  initialRiskDraft?: RiskPrefillDraft | null;
  initialQueryPrompt?: { symbol: string; query: string; nonce: number } | null;
}

const PIPELINE_STAGES = [
  { id: 1, label: "体制与记忆召回" },
  { id: 2, label: "MCP 并行取证" },
  { id: 3, label: "结构化合成" },
  { id: 4, label: "风控预检闭环" },
] as const;

interface CuratedPromptItem {
  category: string;
  label: string;
  build: (sym: string) => string;
}

const CURATED_PROMPT_BANK: CuratedPromptItem[] = [
  {
    category: "宏观与持仓",
    label: "诊断当前持仓风险",
    build: () =>
      "请调用账户持仓与盘中预警/历史教训工具，全面体检我当前的真实持仓暴露在哪些负伽马波动区、财报地雷或同板块集中风险，并给出减仓优先级。",
  },
  {
    category: "期权微结构",
    label: "结构与期权墙剖析",
    build: (sym) =>
      `请综合分析 ${sym} 当前的技术趋势、近 20 日量比（RVOL）、期权 Call/Put 阻力支撑墙与多空波动转折位（Zero Gamma）。`,
  },
  {
    category: "自选强弱",
    label: "横向对比自选强弱",
    build: () =>
      "请读取我的自选股矩阵，挑出强弱分化最明显的 3~4 只标的横向对比均线趋势、量比与期权墙空间，列出优先关注与规避名单。",
  },
  {
    category: "SEC 财报",
    label: "10-K/Q 核心风险排雷",
    build: (sym) =>
      `请对 ${sym} 启动三路并行 SEC 财报审计，重点核查最新 10-K/10-Q 中的毛利率变动、资本开支、供应链/出口限制与现金流压力，附上原文出处。`,
  },
  {
    category: "开仓算仓",
    label: "试算买入 50 股风控",
    build: (sym) =>
      `我想评估当前买入 50 股 ${sym} 的入场赔率与止损底线，请结合大盘环境和账户 1% 单笔亏损上限给出风控前置方案。`,
  },
  {
    category: "宏观体制",
    label: "美联储流动性与 VIX 扫描",
    build: (sym) =>
      `请结合当前美联储净流动性变化、VIX 期限结构（是否倒挂）与信用利差（HY OAS），评估当前宏观大环境对 ${sym} 高估值成长股是否友好。`,
  },
  {
    category: "财报事件",
    label: "财报前波动防扫损评估",
    build: (sym) =>
      `请检查 ${sym} 未来两周的财报/重磅宏观日历窗口与期权隐含预期振幅，判断现在适合提前埋伏、用期权对冲，还是等财报落地后再介入。`,
  },
  {
    category: "暗池与尾盘",
    label: "大盘指数趋势与关键支撑",
    build: () =>
      "请分析 SPY 与 QQQ 的当前 20 日/50 日均线结构、市场广度（50MA 以上股票占比）及 Fear & Greed 情绪位置，判断是真突破还是诱多轮动。",
  },
  {
    category: "多空博弈",
    label: "回调接回还是破位止损",
    build: (sym) =>
      `如果未来 3 天大盘出现急跌回踩，${sym} 在哪些具体支撑价位具备机构承接价值？一旦跌破哪个关键价格必须视为破位离场？`,
  },
  {
    category: "历史复盘",
    label: "提取历史同类教训",
    build: (sym) =>
      `请检索历史经验记忆库（Episodic Memory）中与 ${sym} 或当前市场震荡环境相似的过往案例，告诉我之前赢在什么纪律、亏在什么冲动。`,
  },
  {
    category: "半导体链",
    label: "AI 算力龙头横向体检",
    build: () =>
      "请调用多资产对比工具同步对比 NVDA、AMD、AVGO 与 TSM 的短期动量、相对成交量（RVOL）与下方支撑位，谁的盈亏比更安全？",
  },
  {
    category: "杠杆防护",
    label: "现持仓极端回撤压力测试",
    build: () =>
      "假设本周出现突发性风险偏好降温（VIX 飙升至 28 以上），请根据我当前模拟盘持仓逐一测算哪个标的回撤压力最大，怎么调整防守？",
  },
  {
    category: "财报对照",
    label: "营收增速 vs 估值容忍度",
    build: (sym) =>
      `请调取 ${sym} 最新季报披露的收入增长驱动力、机构盈利一致预期以及当前股价相对 200 日均线偏离度，评估是否透支了未来预期。`,
  },
  {
    category: "跨资产联动",
    label: "美债利率与 BTC 流动性映射",
    build: () =>
      "请结合近期 10 年期/2 年期美债收益率、实际利率以及加密流动性脉搏，分析当前美元活水环境是在助推风险资产还是在暗中抽血。",
  },
  {
    category: "减仓策略",
    label: "盈利单动态移动止盈方案",
    build: (sym) =>
      `如果我已经持有一定仓位的 ${sym} 且账面浮盈，请结合上方 Call Wall 阻力位与 ATR 波动幅度，帮我设计一个分批止盈或上移止损的策略。`,
  },
  // +25 curated high-utility prompts (Total 40 = 8 batches x 5)
  {
    category: "阻力突破",
    label: "Call Wall 突破与防诱多确认",
    build: (sym) =>
      `请评估 ${sym} 上方期权 Call Wall 阻力位的压制强度：什么级别的放量（RVOL）和收盘价表现才算真突破，而不是假突破冲高回落？`,
  },
  {
    category: "防守验证",
    label: "Put Wall 跌破后的极端下限测算",
    build: (sym) =>
      `如果市场突然恶化导致 ${sym} 放量跌穿 Put Wall 期权强支撑，下方下一道历史机构筹码和 200 日均线防守区大概在什么价位？`,
  },
  {
    category: "分批建仓",
    label: "金字塔三批分步建仓设计",
    build: (sym) =>
      `我想用不超过总净值 1.5% 的风险预算分三批介入 ${sym}，请给出头仓、回踩确认加仓、右肩突破加仓的触发价格与各自止损位置。`,
  },
  {
    category: "破位应急",
    label: "跌破 50MA 砍仓还是减半评估",
    build: (sym) =>
      `假如 ${sym} 放量跌破 50 日均线且处于负伽马波动区，请客观对比直接止损离场 vs 先减半仓留观察仓，哪种方案期待值更高？`,
  },
  {
    category: "隔夜防护",
    label: "长假与重磅数据前降仓方案",
    build: () =>
      "未来 48 小时有重磅 CPI/非农或美联储议息会议，请梳理我目前持仓与自选矩阵里对利率与跳空最敏感的标的，建议降仓保留多少安全垫？",
  },
  {
    category: "自由现金流",
    label: "AI 资本开支 vs 现金流兑现率",
    build: (sym) =>
      `请查阅 ${sym} 的 SEC 财报原文，重点核查它的资本开支（CapEx）膨胀速度是否已经挤压自由现金流，以及管理层如何解释投入产出回报。`,
  },
  {
    category: "财报跳空",
    label: "财报后跳空追高/抄底禁忌",
    build: (sym) =>
      `若 ${sym} 财报次日大幅跳空高开或低开，开盘前 30 分钟内哪些成交量、期权墙重构与乖离率信号表明绝对不能盲目追单？`,
  },
  {
    category: "事件排期",
    label: "未来两周催化共振地图",
    build: (sym) =>
      `请整合宏观看板与日历工具，梳理 ${sym} 未来 14 天所有财报、分红、FOMC 或行业大会事件，标出最易引发隐含波动率骤升的高危窗口。`,
  },
  {
    category: "同业对比",
    label: "毛利率与盈利增长同业横评",
    build: (sym) =>
      `请从我自选股与行业龙头中找出 ${sym} 最直接的 2 家竞争对手，从毛利率趋势、近期价格动能（5日/20日涨幅）和抗跌韧性做一次综合排名。`,
  },
  {
    category: "利率敏感",
    label: "长端美债上行对高PE科技压制",
    build: (sym) =>
      `如果 10 年期美债收益率再次上冲突破关键心理关口，像 ${sym} 这类高估值或长久期成长股通常会在哪个回撤幅度出现机构逢低买盘？`,
  },
  {
    category: "风格轮动",
    label: "成长科技 vs 价值小盘切换信号",
    build: () =>
      "请对比 QQQs 与 IWM/DIA 近 5 日及 20 日动量差异、板块热力图领涨领跌结构，判断资金是在拥抱高弹性科技还是向价值/工业防御切换？",
  },
  {
    category: "情绪反向",
    label: "恐慌贪婪极值反向胜率评估",
    build: () =>
      "请查看当前 Fear & Greed 情绪指数与 VIX 期限结构是否进入极端恐慌或极度贪婪区间，在当前宏观体制下适合顺势追击还是反向伏击？",
  },
  {
    category: "汇率脉冲",
    label: "强美元周期对跨国龙头财报影响",
    build: (sym) =>
      `请分析当前美元与全球流动性环境，并在 ${sym} 最新 SEC 文件中检索海外收入占比及外汇汇兑风险敞口披露。`,
  },
  {
    category: "换仓效率",
    label: "跑输大盘 SPY 弱势持仓体检",
    build: () =>
      "请检查我当前账户持仓与自选队列中过去 20 个交易日明显跑输 SPY 的弱势标的，客观评估它们是短期洗盘蓄势还是资金持续流出应果断换仓？",
  },
  {
    category: "相关性去重",
    label: "持仓同质化与隐含高相关性",
    build: () =>
      "请诊断我的真实持仓与关注矩阵是否存在表面分散、实则都押注同一宏观/AI 算力因子的集中度风险，建议搭配哪类低相关对冲工具？",
  },
  {
    category: "空仓选股",
    label: "现金充足寻找黄金击球区",
    build: () =>
      "我目前手头现金比例充裕不愿追高，请从当前自选池中筛选 2~3 只趋势完好且正巧回踩 20MA 或 Put Wall 附近的高盈亏比候补标的。",
  },
  {
    category: "AI 软件对比",
    label: "算力硬件 vs AI 应用软件轮动",
    build: () =>
      "请调用工具对比算力芯片龙头（NVDA/AVGO）与企业软件应用（MSFT/META/PLTR 等）近 20 日量价动量差异，现阶段赔率更偏向哪一端？",
  },
  {
    category: "云巨头对决",
    label: "三大云厂资本开支受惠评估",
    build: () =>
      "请对比 MSFT、GOOGL、AMZN 与 META 近期动量强弱与期权墙空间，结合 SEC 财报核查哪家的 AI 变现线索在财报中体现最扎实？",
  },
  {
    category: "防御避险",
    label: "避险体制下医疗/公用事业防御盘点",
    build: () =>
      "如果宏观体制维持高压避险，请利用行业热力图和市场标尺，帮我挑出目前相对大盘抗跌、波动率较低且存在结构性支撑的防御性方向。",
  },
  {
    category: "加密周期",
    label: "比特币链上脉搏与纳指关联度",
    build: () =>
      "请分析当前 BTC/ETH 与美股高风险科技板块的同步共振情况：当加密流动性收紧领先异动时，美股持仓是否需要提前收紧止损？",
  },
  {
    category: "量价背离",
    label: "高位放量滞涨与派发风险识别",
    build: (sym) =>
      `请核查 ${sym} 近 5 日与 20 日的相对成交量（RVOL）和涨跌幅配比，判断当前是健康放量突破还是机构在高位放量滞涨派发？`,
  },
  {
    category: "缩量筑底",
    label: "缩量止跌与机构低吸拐点确认",
    build: (sym) =>
      `请分析 ${sym} 回调期间成交量是否出现明显萎缩并在关键均线附近走平，还需要等待哪 2 个量化信号出现才确认右侧企稳？`,
  },
  {
    category: "多空盈亏",
    label: "当前价位做多盈亏比打分",
    build: (sym) =>
      `假设按 ${sym} 今日收盘参考价立即买入，以 Put Wall 或 1.5 倍 ATR 为止损、Call Wall 为第一止盈目标，当前这笔交易赔率超过 2:1 吗？值得出手吗？`,
  },
  {
    category: "缺口博弈",
    label: "大缺口回补规律与挂单伏击区",
    build: (sym) =>
      `结合 ${sym} 当前 ATR 每日正常振幅以及均线乖离率，计算它在未破坏中期上升结构的前提下，合理的一轮日内/波段回踩极限买点区在哪里？`,
  },
  {
    category: "红利配置",
    label: "低波红利底仓 + 高弹性进攻配比",
    build: () =>
      "请结合我当前账户净值和市场波动率体制，帮我估算一个合理的攻守配比：拿多少仓位做高波动趋势进攻、留多少现金或低波资产压舱？",
  },
];

const PROMPT_BATCH_SIZE = 5;

function stripMarkdownSnippet(text: string, maxLen = 84): string {
  const clean = text
    .replace(/[#>*`_\-\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= maxLen) return clean || "已生成结构化投研结论";
  return `${clean.slice(0, maxLen)}…`;
}

export default function InvestigatorDrawer({
  open,
  onClose,
  defaultSymbol,
  mode = "drawer",
  onOpenFullWorkspace,
  onOpenSettings,
  initialRiskDraft = null,
  initialQueryPrompt = null,
}: InvestigatorDrawerProps) {
  const [rightTab, setRightTab] = useState<"risk" | "sec">("risk");
  const [drawerTab, setDrawerTab] = useState<"agent" | "sec" | "risk">("agent");
  const [copilotMode, setCopilotMode] = useState<"research" | "debate">("research");

  const [agentStatus, setAgentStatus] = useState<AgentStatusResponse | null>(null);
  const [showToolsCatalog, setShowToolsCatalog] = useState(false);
  const [showPreviewSample, setShowPreviewSample] = useState(false);
  const [showQuickGuide, setShowQuickGuide] = useState(false);

  const [symbolInput, setSymbolInput] = useState<string>(defaultSymbol);
  const [queryInput, setQueryInput] = useState<string>("");
  const [rotatingPromptIdx, setRotatingPromptIdx] = useState<number>(0);
  const [promptBatchIdx, setPromptBatchIdx] = useState<number>(0);
  const [inputFocused, setInputFocused] = useState<boolean>(false);
  const [expandedTurnPairs, setExpandedTurnPairs] = useState<Record<number, boolean>>({});
  const [latestAnswerCollapsed, setLatestAnswerCollapsed] = useState<boolean>(false);
  const [activeUserQuery, setActiveUserQuery] = useState<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const lastAutoConsultNonceRef = useRef<number | null>(null);

  // Persistent threads + live SSE telemetry
  const [savedThreads, setSavedThreads] = useState<InvestigatorThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string>(() => `desk-${defaultSymbol}-${Date.now()}`);
  const [turns, setTurns] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [runningAgent, setRunningAgent] = useState(false);
  const [activeStage, setActiveStage] = useState<number>(0);
  const [nodeStatus, setNodeStatus] = useState<string | null>(null);
  const [memoryHits, setMemoryHits] = useState<MemoryHitItem[]>([]);
  const [toolTraces, setToolTraces] = useState<ToolTraceItem[]>([]);
  const [expandedTraceIdx, setExpandedTraceIdx] = useState<number | null>(null);
  const [answer, setAnswer] = useState<string>("");
  const [agentError, setAgentError] = useState<string | null>(null);
  const [tradeIntent, setTradeIntent] = useState<TradeIntentInfo | null>(null);
  const [riskDraft, setRiskDraft] = useState<RiskPrefillDraft | null>(null);
  const [riskPrefill, setRiskPrefill] = useState<{
    symbol: string;
    side: "buy" | "sell";
    qty: number;
    rationale: string;
  }>({
    symbol: defaultSymbol,
    side: "buy",
    qty: 50,
    rationale: "",
  });

  useEffect(() => {
    if (!initialRiskDraft) return;
    setSymbolInput(initialRiskDraft.symbol);
    setRiskDraft(initialRiskDraft);
    setRightTab("risk");
    setDrawerTab("risk");
  }, [initialRiskDraft]);

  useEffect(() => {
    if (!initialQueryPrompt) return;
    setSymbolInput(initialQueryPrompt.symbol);
    setQueryInput(initialQueryPrompt.query);
    setCopilotMode("research");
    setDrawerTab("agent");
    if (
      agentStatus?.llm_pro_ready &&
      lastAutoConsultNonceRef.current !== initialQueryPrompt.nonce
    ) {
      lastAutoConsultNonceRef.current = initialQueryPrompt.nonce;
      void executeAgentRef.current(initialQueryPrompt.query, initialQueryPrompt.symbol);
    }
  }, [initialQueryPrompt, agentStatus?.llm_pro_ready]);

  // 0-Token SEC search state
  const [secQuery, setSecQuery] = useState<string>(
    "revenue growth gross margin liquidity risk factors export"
  );
  const [secForm, setSecForm] = useState<string>("");
  const [secLoading, setSecLoading] = useState(false);
  const [secError, setSecError] = useState<string | null>(null);
  const [secResult, setSecResult] = useState<SecSearchResponse | null>(null);

  const refreshThreads = useCallback(async () => {
    try {
      const res = await fetchInvestigatorThreads(12);
      setSavedThreads(res.threads);
    } catch {
      // Optional persistence list
    }
  }, []);

  useEffect(() => {
    setSymbolInput(defaultSymbol);
    setRiskPrefill((prev) => ({ ...prev, symbol: defaultSymbol }));
  }, [defaultSymbol]);

  useEffect(() => {
    if (inputFocused || queryInput.trim().length > 0 || runningAgent) return;
    const timer = window.setInterval(() => {
      setRotatingPromptIdx((prev) => (prev + 1) % CURATED_PROMPT_BANK.length);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [inputFocused, queryInput, runningAgent]);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    if (runningAgent || answer || turns.length > 0) {
      el.scrollTop = el.scrollHeight;
    }
  }, [turns.length, answer, runningAgent, nodeStatus]);

  useEffect(() => {
    if (!open && mode === "drawer") return;
    const syncStatus = () => {
      fetchAgentStatus()
        .then((res) => setAgentStatus(res))
        .catch(() => setAgentStatus(null));
    };
    syncStatus();
    if (mode === "split") {
      void refreshThreads();
    }
    window.addEventListener(SETTINGS_UPDATED_EVENT, syncStatus);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, syncStatus);
  }, [open, mode, refreshThreads]);

  async function handleLoadSavedThread(tid: string) {
    if (runningAgent) return;
    setAgentError(null);
    try {
      const detail = await fetchInvestigatorThreadDetail(tid);
      setThreadId(detail.thread_id);
      if (detail.symbol) setSymbolInput(detail.symbol);
      const msgs = detail.messages || [];
      setTurns(msgs);
      const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant")?.content || "";
      setAnswer(lastAssistant);
      setToolTraces(detail.tool_traces || []);
      setMemoryHits(detail.memory_hits || []);
      setTradeIntent(detail.trade_intent || null);
      setActiveStage(4);
      setNodeStatus(`已加载存档会话（${msgs.length / 2} 轮对话 · ${detail.tool_traces?.length || 0} 次取证）`);
      setExpandedTraceIdx(null);
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : "加载历史投研会话失败");
    }
  }

  async function handleDeleteSavedThread(tid: string, e: React.MouseEvent) {
    e.stopPropagation();
    await deleteInvestigatorThread(tid).catch(() => {});
    if (tid === threadId) {
      handleResetThread();
    }
    void refreshThreads();
  }

  async function executeAgentQuery(qText: string, symOverride?: string) {
    const cleanQ = qText.trim();
    const cleanSym = (symOverride || symbolInput).trim().toUpperCase();
    if (!cleanQ) return;

    if (agentStatus && !agentStatus.llm_pro_ready) {
      setAgentError("未填写大模型 API Key，当前为多智能体示范预览模式。点击右上角「设置」填写 Key 即可实时调度 Agent。");
      onOpenSettings?.();
      return;
    }

    setRunningAgent(true);
    setActiveStage(1);
    setActiveUserQuery(cleanQ);
    setLatestAnswerCollapsed(false);
    setExpandedTurnPairs({});
    setNodeStatus("正在装载宏观 Regime、历史经验记忆与 8 项 MCP 只读工具...");
    setToolTraces([]);
    setMemoryHits([]);
    setExpandedTraceIdx(null);
    setAnswer("");
    setAgentError(null);
    setTradeIntent(null);

    let streamed = "";
    try {
      await streamInvestigate(
        {
          thread_id: threadId,
          query: cleanQ,
          symbol: cleanSym || null,
          history: turns,
        },
        (ev) => {
          if (ev.event === "status") {
            const detail = String(ev.data.detail ?? ev.data.node ?? "Processing...");
            setNodeStatus(detail);
            if (typeof ev.data.stage === "number") {
              setActiveStage(ev.data.stage);
            }
          } else if (ev.event === "memory_hit") {
            const mems = Array.isArray(ev.data.memories) ? (ev.data.memories as MemoryHitItem[]) : [];
            setMemoryHits(mems);
          } else if (ev.event === "tool_trace" || ev.event === "tool_result") {
            setActiveStage((prev) => Math.max(prev, 2));
            setToolTraces((prev) => [
              ...prev,
              {
                tool: String(ev.data.tool ?? "mcp_tool"),
                args:
                  ev.data.args && typeof ev.data.args === "object"
                    ? (ev.data.args as Record<string, unknown>)
                    : undefined,
                status: String(ev.data.status ?? "ok"),
                latency_ms:
                  typeof ev.data.latency_ms === "number" ? ev.data.latency_ms : undefined,
                preview:
                  typeof ev.data.preview === "string" ? ev.data.preview : undefined,
                output:
                  typeof ev.data.output === "string" ? ev.data.output : undefined,
              },
            ]);
          } else if (ev.event === "token") {
            setActiveStage((prev) => Math.max(prev, 3));
            const delta = String(ev.data.delta ?? "");
            streamed += delta;
            setAnswer(streamed);
          } else if (ev.event === "done") {
            const finalAns = String(ev.data.answer ?? streamed);
            setAnswer(finalAns);
            setActiveStage(4);
            if (Array.isArray(ev.data.memory_hits)) {
              setMemoryHits(ev.data.memory_hits as MemoryHitItem[]);
            }
            setNodeStatus(
              ev.data.forced_stop_reason
                ? `已完成 (边界守护: ${String(ev.data.forced_stop_reason)})`
                : `已完成 (${String(ev.data.steps_taken ?? 0)} 次 MCP 工具取证)`
            );
            const intent = ev.data.trade_intent as TradeIntentInfo | undefined;
            if (intent) {
              setTradeIntent(intent);
              if (intent.detected) {
                setRiskPrefill({
                  symbol: (intent.symbol || cleanSym || defaultSymbol).toUpperCase(),
                  side: intent.side || "buy",
                  qty: intent.proposed_qty || 50,
                  rationale: finalAns.slice(0, 260),
                });
              }
            }
            if (finalAns) {
              setQueryInput("");
              setTurns((prev) => [
                ...prev.slice(-10),
                { role: "user", content: cleanQ },
                { role: "assistant", content: finalAns },
              ]);
            }
            if (mode === "split") {
              void refreshThreads();
            }
          } else if (ev.event === "error") {
            setAgentError(
              String(ev.data.message ?? ev.data.detail ?? "Investigator stream error.")
            );
          }
        }
      );
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : "Agent request failed");
    } finally {
      setRunningAgent(false);
      setActiveUserQuery(null);
    }
  }

  const executeAgentRef = useRef(executeAgentQuery);
  executeAgentRef.current = executeAgentQuery;

  async function handleRunAgent(e: React.FormEvent) {
    e.preventDefault();
    const fallbackSym = (symbolInput || defaultSymbol).toUpperCase();
    const effectiveQuery =
      queryInput.trim() ||
      CURATED_PROMPT_BANK[rotatingPromptIdx % CURATED_PROMPT_BANK.length].build(fallbackSym);
    await executeAgentQuery(effectiveQuery, fallbackSym);
  }

  function handleResetThread() {
    setThreadId(`desk-${symbolInput || defaultSymbol}-${Date.now()}`);
    setTurns([]);
    setActiveUserQuery(null);
    setExpandedTurnPairs({});
    setLatestAnswerCollapsed(false);
    setToolTraces([]);
    setMemoryHits([]);
    setExpandedTraceIdx(null);
    setAnswer("");
    setAgentError(null);
    setTradeIntent(null);
    setNodeStatus(null);
    setActiveStage(0);
  }

  async function handleRunSecSearch(e: React.FormEvent) {
    e.preventDefault();
    const sym = symbolInput.trim().toUpperCase();
    if (!sym || !secQuery.trim()) return;
    setSecLoading(true);
    setSecError(null);
    try {
      const res = await searchSecFilings({
        symbol: sym,
        query: secQuery.trim(),
        form_type: secForm || null,
        top_k: 5,
      });
      setSecResult(res);
    } catch (err) {
      setSecError(err instanceof Error ? err.message : "SEC search failed");
    } finally {
      setSecLoading(false);
    }
  }

  const isShowcaseMode =
    Boolean(agentStatus && !agentStatus.llm_pro_ready) &&
    turns.length === 0 &&
    !answer &&
    !runningAgent;

  const displayedStage = isShowcaseMode ? 4 : activeStage;
  const activeSym = (symbolInput || defaultSymbol || "SPY").toUpperCase();
  const promptTotalBatches = Math.max(
    1,
    Math.ceil(CURATED_PROMPT_BANK.length / PROMPT_BATCH_SIZE)
  );
  const activeQuickBatch = useMemo(() => {
    const start = (promptBatchIdx % promptTotalBatches) * PROMPT_BATCH_SIZE;
    return CURATED_PROMPT_BANK.slice(start, start + PROMPT_BATCH_SIZE);
  }, [promptBatchIdx, promptTotalBatches]);
  const liveSuggestedPrompt =
    CURATED_PROMPT_BANK[rotatingPromptIdx % CURATED_PROMPT_BANK.length];
  const liveSuggestedText = liveSuggestedPrompt.build(activeSym);

  const priorRounds = useMemo(() => {
    const raw = runningAgent || !answer ? turns : turns.slice(0, -2);
    const pairs: { user: string; assistant: string }[] = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i].role === "user") {
        const nextMsg = raw[i + 1]?.role === "assistant" ? raw[i + 1].content : "";
        pairs.push({ user: raw[i].content, assistant: nextMsg });
        if (raw[i + 1]?.role === "assistant") i++;
      } else {
        pairs.push({ user: "历史提问", assistant: raw[i].content });
      }
    }
    return pairs;
  }, [turns, runningAgent, answer]);

  const renderToolTraceCards = (items: ToolTraceItem[], label: string) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-200">
        <span>
          {label} ({items.length})
        </span>
        <span className="text-[10px] font-normal text-zinc-500 dark:text-zinc-400">
          点击卡片可展开原始返回
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {items.map((tr, idx) => {
          const isOpen = expandedTraceIdx === idx;
          return (
            <button
              key={`${tr.tool}-${idx}`}
              type="button"
              onClick={() => setExpandedTraceIdx(isOpen ? null : idx)}
              className="rounded-xl bg-white/95 p-3 text-left font-mono text-xs transition hover:bg-white dark:bg-white/[0.06] dark:hover:bg-white/[0.09]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 truncate font-semibold text-zinc-900 dark:text-zinc-100">
                  <CheckCircle2
                    className={`h-3.5 w-3.5 shrink-0 ${
                      tr.status === "ok"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-amber-500"
                    }`}
                  />
                  {tr.tool}
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400">
                  {tr.latency_ms !== undefined ? `${tr.latency_ms}ms` : tr.status}
                  {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </span>
              </div>
              {tr.preview && (
                <p className="mt-1 truncate text-[11px] text-zinc-600 dark:text-zinc-300">
                  {tr.preview}
                </p>
              )}
              {isOpen && (tr.output || tr.args) && (
                <div className="mt-2 space-y-1.5 border-t border-zinc-200/70 pt-2 text-[10.5px] text-zinc-700 dark:border-white/10 dark:text-zinc-200">
                  {tr.args && Object.keys(tr.args).length > 0 && (
                    <div className="text-zinc-500 dark:text-zinc-400">
                      入参: {JSON.stringify(tr.args)}
                    </div>
                  )}
                  {tr.output && (
                    <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-100/90 p-2 font-mono text-[10px] leading-relaxed text-zinc-800 dark:bg-black/40 dark:text-zinc-200">
                      {tr.output}
                    </pre>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );

  const renderCopilotPane = () => (
    <div className="flex h-full flex-col space-y-4">
      {/* Dual Flagship AI Engine Command Deck (Zero-Border Aurora Corner Glow) */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setCopilotMode("research")}
          className={`aurora-deck-card group overflow-hidden rounded-2xl p-4 text-left ${
            copilotMode === "research" ? "aurora-deck-emerald" : "aurora-deck-idle"
          }`}
        >
          <div className="flex items-start justify-between gap-2.5">
            <div className="flex items-center gap-3">
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition ${
                  copilotMode === "research"
                    ? "bg-emerald-600 text-white shadow-sm dark:bg-emerald-400 dark:text-zinc-950"
                    : "bg-emerald-500/[0.14] text-emerald-700 group-hover:bg-emerald-500/[0.22] dark:bg-emerald-400/[0.16] dark:text-emerald-300"
                }`}
              >
                <Bot className="h-[18px] w-[18px]" />
              </span>
              <div>
                <div className="font-serif text-[15px] font-bold tracking-tight text-zinc-950 sm:text-base dark:text-white">
                  深度研报 (Investigator)
                </div>
                <div className="mt-0.5 font-mono text-[11px] font-medium text-emerald-800/90 dark:text-emerald-300/90">
                  自主全网取证 · SEC + 记忆引擎
                </div>
              </div>
            </div>
            <span
              className={`shrink-0 rounded-full px-2.5 py-0.5 font-mono text-[10.5px] font-bold ${
                copilotMode === "research"
                  ? "bg-emerald-600 text-white dark:bg-emerald-400 dark:text-zinc-950"
                  : "bg-zinc-950/[0.07] text-zinc-700 dark:bg-white/10 dark:text-zinc-300"
              }`}
            >
              {copilotMode === "research" ? "已激活" : "切换引擎"}
            </span>
          </div>
          <p className="mt-2.5 text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
            并行调度 FastMCP 8 项只读工具、期权墙与历史教训记忆，流式输出带溯源引用研报。
          </p>
        </button>

        <button
          type="button"
          onClick={() => setCopilotMode("debate")}
          className={`aurora-deck-card group overflow-hidden rounded-2xl p-4 text-left ${
            copilotMode === "debate" ? "aurora-deck-sky" : "aurora-deck-idle"
          }`}
        >
          <div className="flex items-start justify-between gap-2.5">
            <div className="flex items-center gap-3">
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition ${
                  copilotMode === "debate"
                    ? "bg-gradient-to-br from-sky-600 to-amber-500 text-white shadow-sm dark:from-sky-400 dark:to-amber-300 dark:text-zinc-950"
                    : "bg-gradient-to-br from-sky-500/[0.16] to-amber-500/[0.18] text-sky-700 group-hover:from-sky-500/[0.25] group-hover:to-amber-500/[0.25] dark:text-sky-300"
                }`}
              >
                <Swords className="h-[18px] w-[18px]" />
              </span>
              <div>
                <div className="font-serif text-[15px] font-bold tracking-tight text-zinc-950 sm:text-base dark:text-white">
                  红蓝对抗投决 (Bull vs Bear CRO)
                </div>
                <div className="mt-0.5 font-mono text-[11px] font-medium text-sky-800/90 dark:text-sky-300/90">
                  免 Key 压力测试 · 多空裁决单
                </div>
              </div>
            </div>
            <span
              className={`shrink-0 rounded-full px-2.5 py-0.5 font-mono text-[10.5px] font-bold ${
                copilotMode === "debate"
                  ? "bg-sky-600 text-white dark:bg-sky-400 dark:text-zinc-950"
                  : "bg-sky-500/[0.14] text-sky-800 dark:bg-sky-400/[0.18] dark:text-sky-200"
              }`}
            >
              {copilotMode === "debate" ? "对抗中" : "双智能体"}
            </span>
          </div>
          <p className="mt-2.5 text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
            多头看催化剂、空头 CRO 严酷挑刺并锁定 1% 安全限仓，一键转右栏发起审批。
          </p>
        </button>
      </div>

      {copilotMode === "debate" ? (
        <motion.div
          key="debate"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: EASE_EXPO }}
        >
        <DebateArenaPanel
          defaultSymbol={symbolInput || defaultSymbol}
          onHandoffToRisk={(draft) => {
            setSymbolInput(draft.symbol);
            setRiskDraft(draft);
            if (mode === "split") {
              setRightTab("risk");
            } else {
              setDrawerTab("risk");
            }
          }}
        />
        </motion.div>
      ) : (
        <motion.div
          key="research"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: EASE_EXPO }}
          className="flex flex-1 flex-col space-y-3.5"
        >
          {agentStatus && !agentStatus.llm_pro_ready && (
            <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3.5 py-2.5 font-sans text-xs text-amber-950 dark:text-amber-100">
              <div className="space-y-0.5">
                <div className="flex items-center gap-1.5 font-semibold text-amber-900 dark:text-amber-200">
                  <KeyRound className="h-3.5 w-3.5" />
                  当前未填大模型 Key · SEC 原文检索 / 红蓝压力测试 / 右侧算仓全功能免费可用
                </div>
                <p className="text-[11px] text-amber-800/90 dark:text-amber-200/80">
                  填入任意 OpenAI 兼容或 DeepSeek/Gemini Key 后，左侧 Agent 将实时自主调度多工具调研。
                </p>
              </div>
              {onOpenSettings && (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-400 px-3 py-1 font-sans text-xs font-bold text-zinc-950 shadow-sm transition hover:bg-amber-300"
                >
                  <Settings className="h-3.5 w-3.5" />
                  填入 API Key
                </button>
              )}
            </div>
          )}

      {/* Persistent Thread Strip (Split Workbench) + 8-Tool Inventory Pill */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {mode === "split" && (
            <>
              <button
                type="button"
                onClick={handleResetThread}
                className="inline-flex items-center gap-1 rounded-full bg-zinc-950 px-2.5 py-1 font-mono text-[10.5px] font-semibold text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950"
              >
                <Plus className="h-3 w-3" />
                新建投研线程
              </button>
              {savedThreads.slice(0, 4).map((th) => {
                const active = th.thread_id === threadId && turns.length > 0;
                return (
                  <div
                    key={th.thread_id}
                    onClick={() => void handleLoadSavedThread(th.thread_id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleLoadSavedThread(th.thread_id);
                    }}
                    className={`group inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10.5px] transition ${
                      active
                        ? "bg-emerald-600 font-semibold text-white dark:bg-emerald-500 dark:text-zinc-950"
                        : "bg-zinc-100/90 text-zinc-700 hover:bg-zinc-200/80 dark:bg-white/[0.06] dark:text-zinc-200 dark:hover:bg-white/[0.12]"
                    }`}
                  >
                    <History className="h-3 w-3 shrink-0 opacity-75" />
                    <span className="max-w-[130px] truncate">{th.title}</span>
                    <button
                      type="button"
                      onClick={(e) => void handleDeleteSavedThread(th.thread_id, e)}
                      aria-label={`删除会话 ${th.title}`}
                      className="rounded-full p-0.5 opacity-60 hover:opacity-100"
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowToolsCatalog((v) => !v)}
          className="inline-flex items-center gap-1 rounded-full bg-zinc-100/90 px-2.5 py-1 font-mono text-[10.5px] font-medium text-zinc-700 transition hover:bg-zinc-200 dark:bg-white/[0.07] dark:text-zinc-200 dark:hover:bg-white/15"
        >
          <Cpu className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
          MCP 只读工具箱 ({agentStatus?.mcp_tools?.length ?? 8})
          {showToolsCatalog ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
      </div>

      {showToolsCatalog && agentStatus?.mcp_tools && (
        <div className="grid grid-cols-1 gap-1.5 rounded-xl bg-zinc-100/80 p-3 font-mono text-[10.5px] sm:grid-cols-2 dark:bg-white/[0.04]">
          {agentStatus.mcp_tools.map((t) => (
            <div key={t.name} className="rounded-lg bg-white/85 px-2.5 py-1.5 dark:bg-white/[0.05]">
              <div className="font-bold text-emerald-700 dark:text-emerald-300">{t.name}</div>
              <div className="mt-0.5 line-clamp-2 font-sans text-[10px] text-zinc-600 dark:text-zinc-400">
                {t.description}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Live Execution Pipeline Telemetry (Visible while running or in Showcase Mode) */}
      {(runningAgent || activeStage > 0 || isShowcaseMode) && (
        <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-zinc-100/80 p-1.5 font-mono text-[11px] sm:grid-cols-4 dark:bg-white/[0.04]">
          {PIPELINE_STAGES.map((st) => {
            const done = displayedStage > st.id || (displayedStage === 4 && st.id === 4 && !runningAgent);
            const current = runningAgent && displayedStage === st.id;
            return (
              <div
                key={st.id}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition ${
                  current
                    ? "bg-emerald-600 font-bold text-white dark:bg-emerald-500 dark:text-zinc-950"
                    : done
                      ? "bg-white font-semibold text-zinc-900 dark:bg-white/[0.12] dark:text-zinc-100"
                      : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9.5px] ${
                    current
                      ? "bg-white/25"
                      : done
                        ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
                        : "bg-zinc-200/80 dark:bg-white/10"
                  }`}
                >
                  {st.id}
                </span>
                <span className="truncate">{st.label}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Quick Prompts (3 batches x 5 = 15 curated prompts) */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
          精选指令 ({(promptBatchIdx % promptTotalBatches) + 1}/{promptTotalBatches}):
        </span>
        {activeQuickBatch.map((chip) => (
          <button
            key={chip.label}
            type="button"
            disabled={runningAgent}
            title={chip.build(activeSym)}
            onClick={() => {
              const promptText = chip.build(activeSym);
              setQueryInput(promptText);
              void executeAgentQuery(promptText, activeSym);
            }}
            className="rounded-full bg-zinc-100/90 px-3 py-1 font-mono text-[11px] font-medium text-zinc-800 transition hover:bg-zinc-950 hover:text-white disabled:opacity-50 dark:bg-white/[0.07] dark:text-zinc-100 dark:hover:bg-white dark:hover:text-zinc-950"
          >
            {chip.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPromptBatchIdx((prev) => (prev + 1) % promptTotalBatches)}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-200/80 bg-white/80 px-2.5 py-1 font-mono text-[10.5px] font-medium text-zinc-700 transition hover:border-emerald-500/50 hover:text-emerald-700 dark:border-white/15 dark:bg-white/[0.05] dark:text-zinc-200 dark:hover:border-emerald-400/50 dark:hover:text-emerald-300"
        >
          <RefreshCw className="h-3 w-3" />
          换一批 ({CURATED_PROMPT_BANK.length})
        </button>
      </div>

      {/* Bounded Scrollable Chat Thread (prevents vertical page bloat across multi-turn Q&A) */}
      <div
        ref={chatScrollRef}
        className={`space-y-3 overflow-y-auto overscroll-contain scroll-smooth rounded-2xl bg-zinc-50/85 p-4 dark:bg-white/[0.03] ${
          mode === "split"
            ? "min-h-[300px] h-[540px] xl:h-[600px]"
            : "min-h-[260px] max-h-[48vh] flex-1"
        }`}
      >
        {turns.length === 0 && !answer && !runningAgent && (
          <div className="space-y-3">
            {/* Beginner Scenario Launchpad */}
            <div className="rounded-2xl border border-zinc-200/85 bg-white/90 p-4 dark:border-white/10 dark:bg-white/[0.04]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="flex items-center gap-2 font-serif text-base font-semibold tracking-tight text-zinc-950 sm:text-lg dark:text-white">
                    <Bot className="h-[18px] w-[18px] text-emerald-600 dark:text-emerald-400" />
                    不知道从哪开始？选一个典型投资动作即刻体验
                  </h3>
                  <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-300">
                    先用左栏确认基本面/结构逻辑，再到右栏「算仓 + 签字」把单笔最大亏损锁在 1% 红线内。
                  </p>
                </div>
                <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                  当前目标: {(symbolInput || defaultSymbol).toUpperCase()}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                <button
                  type="button"
                  onClick={() => {
                    const sym = (symbolInput || defaultSymbol).toUpperCase();
                    const p = CURATED_PROMPT_BANK[1].build(sym);
                    setQueryInput(p);
                    if (agentStatus?.llm_pro_ready) {
                      void executeAgentQuery(p, sym);
                    } else {
                      setShowPreviewSample(true);
                    }
                  }}
                  className="flex flex-col items-start rounded-xl border border-zinc-200/90 bg-zinc-50/80 p-3.5 text-left transition hover:-translate-y-0.5 hover:border-emerald-500/50 hover:bg-emerald-500/[0.06] dark:border-white/10 dark:bg-white/[0.04] dark:hover:border-emerald-400/45"
                >
                  <span className="font-sans text-[13.5px] font-bold text-zinc-950 dark:text-white">
                    1. 买前排雷体检
                  </span>
                  <span className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                    看均线位置、放量状态、期权 Call/Put 墙与财报地雷
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setCopilotMode("debate")}
                  className="flex flex-col items-start rounded-xl border border-zinc-200/90 bg-zinc-50/80 p-3.5 text-left transition hover:-translate-y-0.5 hover:border-sky-500/50 hover:bg-sky-500/[0.06] dark:border-white/10 dark:bg-white/[0.04] dark:hover:border-sky-400/45"
                >
                  <span className="inline-flex items-center gap-1.5 font-sans text-[13.5px] font-bold text-zinc-950 dark:text-white">
                    <Swords className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
                    2. 红蓝多空对决
                  </span>
                  <span className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                    多头推演催化剂，空头 CRO 严酷挑刺并计算安全股数
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    const sym = (symbolInput || defaultSymbol).toUpperCase();
                    setRiskDraft({
                      symbol: sym,
                      side: "buy",
                      qty: 50,
                      riskBudgetPct: 1.0,
                      rationale: `[新手快速试算] 评估买入 50 股 ${sym} 的 1% 预算安全上限与防守止损位。`,
                      nonce: Date.now(),
                    });
                    if (mode === "split") {
                      setRightTab("risk");
                    } else {
                      setDrawerTab("risk");
                    }
                  }}
                  className="flex flex-col items-start rounded-xl border border-zinc-200/90 bg-zinc-50/80 p-3.5 text-left transition hover:-translate-y-0.5 hover:border-amber-500/50 hover:bg-amber-500/[0.06] dark:border-white/10 dark:bg-white/[0.04] dark:hover:border-amber-400/45"
                >
                  <span className="inline-flex items-center gap-1.5 font-sans text-[13.5px] font-bold text-zinc-950 dark:text-white">
                    <ShieldAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    3. 试算 1% 安全开仓
                  </span>
                  <span className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                    0-Token 免 Key 直算：看右侧自动生成止损、止盈标尺
                  </span>
                </button>
              </div>
            </div>

            {isShowcaseMode && (
              <div className="space-y-3">
                {/* Compact Rich Showcase Digest Anchor (Visible immediately so screen never feels stripped) */}
                <div className="rounded-2xl border border-zinc-200/85 bg-white/85 p-4 dark:border-white/10 dark:bg-white/[0.04]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 font-mono text-xs font-bold text-zinc-950 dark:text-white">
                        <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                        FastMCP 实时取证链路 &amp; 经验记忆示范 ({INVESTIGATOR_SHOWCASE_SAMPLE.symbol})
                      </span>
                      <span className="rounded-full bg-amber-500/[0.14] px-2 py-0.5 font-mono text-[10.5px] font-semibold text-amber-800 dark:text-amber-200">
                        <Brain className="mr-1 inline h-3 w-3" />
                        已注入 {INVESTIGATOR_SHOWCASE_SAMPLE.memoryHits.length} 条历史铁律
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowPreviewSample((v) => !v)}
                      className="inline-flex items-center gap-1 rounded-full bg-zinc-950 px-3 py-1 font-mono text-[11px] font-semibold text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                    >
                      {showPreviewSample ? "收起完整报告" : "展开完整研报与原包"}
                      {showPreviewSample ? (
                        <ChevronUp className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>

                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {INVESTIGATOR_SHOWCASE_SAMPLE.toolTraces.map((tr) => (
                      <button
                        key={tr.tool}
                        type="button"
                        onClick={() => setShowPreviewSample(true)}
                        className="inline-flex items-center gap-1 rounded-lg bg-zinc-100/90 px-2.5 py-1 font-mono text-[10.5px] font-medium text-zinc-800 transition hover:bg-emerald-500/[0.12] hover:text-emerald-800 dark:bg-white/[0.06] dark:text-zinc-200 dark:hover:bg-emerald-500/[0.18]"
                      >
                        <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                        {tr.tool} ({tr.latency_ms}ms)
                      </button>
                    ))}
                  </div>

                  {!showPreviewSample && (
                    <div className="mt-3 grid grid-cols-1 gap-2 border-t border-zinc-200/70 pt-2.5 text-xs text-zinc-600 sm:grid-cols-3 dark:border-white/10 dark:text-zinc-300">
                      <div className="rounded-lg bg-zinc-50/90 px-2.5 py-1.5 dark:bg-white/[0.03]">
                        <strong className="text-zinc-900 dark:text-white">① 持仓与记忆校准：</strong>
                        核验现持仓敞口与相似波动体制历史教训
                      </div>
                      <div className="rounded-lg bg-zinc-50/90 px-2.5 py-1.5 dark:bg-white/[0.03]">
                        <strong className="text-zinc-900 dark:text-white">② 量价与 GEX 期权墙：</strong>
                        标出 Call/Put 磁吸阻力与 Zero Gamma 位
                      </div>
                      <div className="rounded-lg bg-zinc-50/90 px-2.5 py-1.5 dark:bg-white/[0.03]">
                        <strong className="text-zinc-900 dark:text-white">③ SEC 三路并行审计：</strong>
                        检索 10-K/10-Q 风险因子并带出处传递给右栏风控
                      </div>
                    </div>
                  )}
                </div>

                {showPreviewSample && (
                  <div className="space-y-3">
                    <div className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-zinc-950 px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm dark:bg-[#F3F3F0] dark:text-[#0B0B0D]">
                        <span className="mb-0.5 block font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-300 dark:text-zinc-700">
                          示例提问 · PREVIEW
                        </span>
                        {INVESTIGATOR_SHOWCASE_SAMPLE.sampleQuery}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 rounded-xl bg-amber-500/[0.12] px-3 py-2 font-mono text-xs text-amber-900 dark:text-amber-200">
                      <Terminal className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                      <span>{INVESTIGATOR_SHOWCASE_SAMPLE.nodeStatus}</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-white/90 px-3 py-2 dark:bg-white/[0.05]">
                      <span className="inline-flex items-center gap-1 font-mono text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                        <Brain className="h-3.5 w-3.5" />
                        历史经验记忆召回 ({INVESTIGATOR_SHOWCASE_SAMPLE.memoryHits.length}):
                      </span>
                      {INVESTIGATOR_SHOWCASE_SAMPLE.memoryHits.map((m, idx) => (
                        <span
                          key={idx}
                          className="rounded-full bg-amber-500/[0.12] px-2.5 py-0.5 font-mono text-[10.5px] text-amber-900 dark:text-amber-200"
                        >
                          {m.title}
                        </span>
                      ))}
                    </div>

                    {renderToolTraceCards(INVESTIGATOR_SHOWCASE_SAMPLE.toolTraces, "FastMCP 工具链路示例")}

                    <div className="rounded-2xl bg-white p-5 text-zinc-950 shadow-sm dark:bg-white/[0.06] dark:text-zinc-100">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/80 pb-2 font-mono text-xs font-semibold uppercase tracking-wider text-zinc-700 dark:border-white/10 dark:text-zinc-200">
                        <span className="flex items-center gap-1.5">
                          <ShieldCheck className="h-3.5 w-3.5 text-amber-500" />
                          Investigator 输出效果演示样例 ({INVESTIGATOR_SHOWCASE_SAMPLE.symbol})
                        </span>
                        {onOpenSettings && (
                          <button
                            type="button"
                            onClick={onOpenSettings}
                            className="inline-flex items-center gap-1 rounded-full bg-zinc-950 px-3 py-1 font-sans text-xs font-semibold text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                          >
                            <KeyRound className="h-3 w-3" />
                            填入 Key 立即实操
                          </button>
                        )}
                      </div>
                      <MarkdownReport content={INVESTIGATOR_SHOWCASE_SAMPLE.answerMarkdown} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Prior completed turns (collapsible accordion cards to keep multi-turn compact) */}
        {priorRounds.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-zinc-200/60 px-3 py-1.5 font-mono text-[10.5px] text-zinc-600 dark:bg-white/[0.05] dark:text-zinc-300">
              <span>
                已归档 {priorRounds.length} 轮历史问答（默认折叠防拉长，点击可逐轮展开）
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const next: Record<number, boolean> = {};
                    priorRounds.forEach((_, idx) => {
                      next[idx] = true;
                    });
                    setExpandedTurnPairs(next);
                  }}
                  className="text-emerald-700 hover:underline dark:text-emerald-300"
                >
                  全部展开
                </button>
                <span className="opacity-40">·</span>
                <button
                  type="button"
                  onClick={() => setExpandedTurnPairs({})}
                  className="hover:underline"
                >
                  全部收起
                </button>
              </div>
            </div>

            {priorRounds.map((pair, idx) => {
              const isOpen = Boolean(expandedTurnPairs[idx]);
              return (
                <div
                  key={`prior-round-${idx}`}
                  className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white/90 transition dark:border-white/10 dark:bg-white/[0.04]"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedTurnPairs((prev) => ({ ...prev, [idx]: !prev[idx] }))
                    }
                    className="flex w-full items-start justify-between gap-3 px-3.5 py-2.5 text-left transition hover:bg-zinc-100/70 dark:hover:bg-white/[0.05]"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white dark:bg-white/15 dark:text-zinc-100">
                          第 {idx + 1} 轮
                        </span>
                        <span className="truncate font-sans text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                          {pair.user}
                        </span>
                      </div>
                      {!isOpen && pair.assistant && (
                        <p className="truncate font-sans text-[11px] text-zinc-500 dark:text-zinc-400">
                          结论摘要：{stripMarkdownSnippet(pair.assistant)}
                        </p>
                      )}
                    </div>
                    <span className="inline-flex shrink-0 items-center gap-1 pt-0.5 font-mono text-[10.5px] text-zinc-500 dark:text-zinc-400">
                      {isOpen ? "收起" : "展开"}
                      {isOpen ? (
                        <ChevronUp className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="space-y-3 border-t border-zinc-200/70 p-3.5 dark:border-white/10">
                      <div className="flex justify-end">
                        <div className="max-w-[90%] rounded-2xl rounded-tr-sm bg-zinc-950 px-3.5 py-2 text-xs leading-relaxed text-white dark:bg-[#F3F3F0] dark:text-[#0B0B0D]">
                          <span className="mb-0.5 block font-mono text-[9.5px] font-semibold uppercase tracking-wider text-zinc-300 dark:text-zinc-700">
                            历史提问 · YOU
                          </span>
                          {pair.user}
                        </div>
                      </div>
                      {pair.assistant && (
                        <div className="rounded-xl bg-zinc-50/90 p-3.5 text-zinc-950 dark:bg-white/[0.04] dark:text-zinc-100">
                          <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-200">
                            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                            Investigator 历史回复
                          </div>
                          <MarkdownReport content={pair.assistant} compact />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {(runningAgent || answer) && turns.length >= 2 && !runningAgent && (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-zinc-950 px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm dark:bg-[#F3F3F0] dark:text-[#0B0B0D]">
              <span className="mb-0.5 block font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-300 dark:text-zinc-700">
                最新提问 · YOU
              </span>
              {turns[turns.length - 2]?.content}
            </div>
          </div>
        )}

        {runningAgent && activeUserQuery && (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-zinc-950 px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm dark:bg-[#F3F3F0] dark:text-[#0B0B0D]">
              <span className="mb-0.5 block font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-300 dark:text-zinc-700">
                当前调研提问 · YOU
              </span>
              {activeUserQuery}
            </div>
          </div>
        )}

        {nodeStatus && (
          <div className="flex items-center gap-2 rounded-xl bg-white/95 px-3 py-2 font-mono text-xs text-zinc-900 dark:bg-white/[0.06] dark:text-zinc-100">
            <Terminal className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>{nodeStatus}</span>
          </div>
        )}

        {memoryHits.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-amber-500/10 px-3 py-2">
            <span className="inline-flex items-center gap-1 font-mono text-[11px] font-semibold text-amber-800 dark:text-amber-300">
              <Brain className="h-3.5 w-3.5" />
              已自动注入历史交易教训 ({memoryHits.length}):
            </span>
            {memoryHits.map((m, idx) => (
              <span
                key={`mh-${idx}`}
                className="rounded-full bg-white/85 px-2.5 py-0.5 font-mono text-[10.5px] text-zinc-900 dark:bg-white/10 dark:text-zinc-100"
              >
                [{m.symbol || "ALL"}] {m.title || m.quadrant_outcome}
              </span>
            ))}
          </div>
        )}

        {toolTraces.length > 0 && renderToolTraceCards(toolTraces, "FastMCP 实时取证链路")}

        {agentError && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 font-mono text-xs text-rose-800 dark:text-rose-200">
            {agentError}
          </div>
        )}

        {answer && (
          <div className="rounded-2xl bg-white p-5 text-zinc-950 shadow-sm dark:bg-white/[0.06] dark:text-zinc-100">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/80 pb-2 font-mono text-xs font-semibold uppercase tracking-wider text-zinc-700 dark:border-white/10 dark:text-zinc-200">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                Investigator 结构化投研结论
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setLatestAnswerCollapsed((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 font-mono text-[11px] font-medium text-zinc-700 transition hover:bg-zinc-200 dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/20"
                >
                  {latestAnswerCollapsed ? "展开正文" : "收起正文"}
                  {latestAnswerCollapsed ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronUp className="h-3 w-3" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRiskPrefill({
                      symbol: (tradeIntent?.symbol || symbolInput || defaultSymbol).toUpperCase(),
                      side: tradeIntent?.side || "buy",
                      qty: tradeIntent?.proposed_qty || 50,
                      rationale: answer.slice(0, 260),
                    });
                    if (mode === "split") {
                      setRightTab("risk");
                    } else {
                      setDrawerTab("risk");
                    }
                  }}
                  className={`inline-flex items-center gap-1 rounded-full px-3 py-1 font-mono text-xs font-semibold transition ${
                    tradeIntent?.detected
                      ? "bg-zinc-950 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                      : "bg-zinc-100 text-zinc-900 hover:bg-zinc-200 dark:bg-white/10 dark:text-white dark:hover:bg-white/20"
                  }`}
                >
                  {tradeIntent?.detected
                    ? `交易意图 (${tradeIntent.side?.toUpperCase()} ${tradeIntent.proposed_qty}) → 同步至风控`
                    : "同步论证 → Risk Critic 风控审查"}
                </button>
              </div>
            </div>
            {latestAnswerCollapsed ? (
              <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                已折叠当前结论（摘要：{stripMarkdownSnippet(answer, 120)}）— 点击右上角「展开正文」恢复阅读。
              </p>
            ) : (
              <MarkdownReport content={answer} />
            )}
          </div>
        )}
      </div>

      {/* Dynamic Rotating Prompt Suggestion Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-200/75 bg-white/80 px-3 py-2 dark:border-white/10 dark:bg-white/[0.04]">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
          <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
            {liveSuggestedPrompt.category} · {(rotatingPromptIdx % CURATED_PROMPT_BANK.length) + 1}/{CURATED_PROMPT_BANK.length} (10s)
          </span>
          <span
            title={liveSuggestedText}
            className="truncate font-sans text-[11.5px] text-zinc-700 dark:text-zinc-200"
          >
            {liveSuggestedText}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px]">
          <button
            type="button"
            onClick={() =>
              setRotatingPromptIdx((prev) => (prev + 1) % CURATED_PROMPT_BANK.length)
            }
            className="inline-flex items-center gap-1 rounded-lg bg-zinc-100 px-2 py-1 text-zinc-700 transition hover:bg-zinc-200 dark:bg-white/[0.07] dark:text-zinc-200 dark:hover:bg-white/15"
          >
            <RefreshCw className="h-3 w-3" />
            换一条
          </button>
          <button
            type="button"
            onClick={() => setQueryInput(liveSuggestedText)}
            className="rounded-lg bg-zinc-100 px-2 py-1 text-zinc-700 transition hover:bg-zinc-200 dark:bg-white/[0.07] dark:text-zinc-200 dark:hover:bg-white/15"
          >
            填入编辑
          </button>
          <button
            type="button"
            disabled={runningAgent}
            onClick={() => {
              setQueryInput(liveSuggestedText);
              void executeAgentQuery(liveSuggestedText, activeSym);
            }}
            className="rounded-lg bg-emerald-600 px-2.5 py-1 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50 dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400"
          >
            直接运行
          </button>
        </div>
      </div>

      {/* Input Composer */}
      <form onSubmit={handleRunAgent} className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
            placeholder="Ticker (如 NVDA)"
            className="w-full rounded-xl border border-zinc-200/90 bg-white px-3 py-2 font-mono text-xs uppercase text-zinc-950 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-white/15 dark:bg-white/[0.06] dark:text-white sm:w-28"
          />
          <input
            type="text"
            value={queryInput}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder={`推荐提问（留空回车将发送上方推荐）: ${liveSuggestedText}`}
            className="flex-1 rounded-xl border border-zinc-200/90 bg-white px-3 py-2 font-sans text-xs text-zinc-950 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-white/15 dark:bg-white/[0.06] dark:text-white"
          />
          <button
            type="submit"
            disabled={runningAgent}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-zinc-950 px-4 py-2 font-mono text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-[#F3F3F0] dark:text-[#0B0B0D] dark:hover:bg-white"
          >
            {runningAgent ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            发送
          </button>
          {turns.length > 0 && (
            <button
              type="button"
              onClick={handleResetThread}
              className="rounded-xl bg-zinc-100 px-3 py-2 font-mono text-xs text-zinc-700 transition hover:bg-zinc-200 dark:bg-white/[0.08] dark:text-zinc-200 dark:hover:bg-white/15"
            >
              重置
            </button>
          )}
        </div>
      </form>
        </motion.div>
      )}
    </div>
  );

  const renderSecPane = () => (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px]">
        <span className="text-zinc-500 dark:text-zinc-400">快捷检索主题:</span>
        {[
          { label: "风险因素与出口管制", q: "risk factors export controls supply chain restrictions" },
          { label: "营收与毛利率驱动", q: "revenue growth gross margin segment operating income" },
          { label: "AI 资本开支 CapEx", q: "capital expenditures AI infrastructure data center guidance" },
          { label: "现金流与偿债流动性", q: "cash flow liquidity debt maturities share repurchase" },
        ].map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => setSecQuery(item.q)}
            className="rounded-full bg-zinc-100 px-2.5 py-0.5 font-medium text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:bg-white/[0.08] dark:text-zinc-200 dark:hover:bg-white dark:hover:text-zinc-950"
          >
            {item.label}
          </button>
        ))}
      </div>
      <form onSubmit={handleRunSecSearch} className="space-y-2.5">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
            placeholder="NVDA"
            className="w-full rounded-xl border border-zinc-200/90 bg-white px-3 py-2 font-mono text-xs uppercase text-zinc-950 focus:border-emerald-500 focus:outline-none dark:border-white/15 dark:bg-white/[0.06] dark:text-white sm:w-24"
          />
          <select
            value={secForm}
            onChange={(e) => setSecForm(e.target.value)}
            className="rounded-xl border border-zinc-200/90 bg-white px-3 py-2 font-mono text-xs text-zinc-950 focus:border-emerald-500 focus:outline-none dark:border-white/15 dark:bg-zinc-900 dark:text-white sm:w-28"
          >
            <option value="">10-K + 10-Q</option>
            <option value="10-K">10-K</option>
            <option value="10-Q">10-Q</option>
          </select>
          <input
            type="text"
            value={secQuery}
            onChange={(e) => setSecQuery(e.target.value)}
            placeholder="关键词，如 risk factors, gross margin, China export..."
            className="flex-1 rounded-xl border border-zinc-200/90 bg-white px-3 py-2 font-sans text-xs text-zinc-950 focus:border-emerald-500 focus:outline-none dark:border-white/15 dark:bg-white/[0.06] dark:text-white"
          />
          <button
            type="submit"
            disabled={secLoading}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-zinc-950 px-4 py-2 font-mono text-xs font-medium text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            {secLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileSearch className="h-3.5 w-3.5" />
            )}
            检索
          </button>
        </div>
      </form>

      {secError && (
        <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-3 font-mono text-xs text-rose-800 dark:text-rose-200">
          {secError}
        </div>
      )}

      {secResult && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
            <span>
              模式: <strong className="text-zinc-950 dark:text-white">{secResult.mode}</strong>
            </span>
            <span>
              已收录:{" "}
              {secResult.filings
                .map((f) => `${f.form_type} (${f.filing_date}, ${f.chunk_count} chunks)`)
                .join(" · ") || "PostgreSQL Cache"}
            </span>
          </div>

          <div className="max-h-[540px] space-y-2.5 overflow-y-auto pr-1">
            {secResult.chunks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-300/80 px-4 py-8 text-center text-xs text-zinc-600 dark:border-white/15 dark:text-zinc-300">
                暂未在 {secResult.symbol || symbolInput} 已收录财报片段中命中「{secResult.query}」，可点上方快捷英文主题或精简关键词后重新检索。
              </div>
            ) : (
              secResult.chunks.map((ch) => (
              <div
                key={ch.chunk_id}
                className="rounded-xl bg-zinc-50/90 p-4 text-zinc-950 dark:bg-white/[0.05] dark:text-zinc-100"
              >
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
                  <span className="font-semibold text-zinc-900 dark:text-white">
                    [{ch.symbol} {ch.form_type} {ch.filing_date}] · {ch.section_title}
                  </span>
                  <span className="text-zinc-500 dark:text-zinc-400">
                    RRF {ch.rrf_score.toFixed(4)}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
                  {ch.content}
                </p>
              </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );

  // Full Split-Screen Workstation Mode (inside Copilot & Risk Tab)
  if (mode === "split") {
    return (
      <div className="space-y-4">
        <SpotlightBlock tone="obsidian" className="space-y-3 px-5 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3.5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-zinc-950 to-zinc-800 text-white shadow-sm dark:from-white/20 dark:to-white/10 dark:text-white">
                <Bot className="h-5 w-5" />
              </span>
              <div>
                <h2 className="font-serif text-2xl font-semibold tracking-tight text-zinc-950 sm:text-[28px] sm:leading-tight dark:text-white">
                  多智能体投研与独立风控台
                </h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[11.5px] text-zinc-600 dark:text-zinc-300">
                  <span className="rounded-lg bg-emerald-500/[0.14] px-2.5 py-0.5 font-semibold text-emerald-800 dark:text-emerald-300">
                    ① 左栏取证 / 红蓝辩论
                  </span>
                  <span>➔</span>
                  <span className="rounded-lg bg-sky-500/[0.14] px-2.5 py-0.5 font-semibold text-sky-800 dark:text-sky-300">
                    ② 右栏 1% 预算算仓与防守尺
                  </span>
                  <span>➔</span>
                  <span className="rounded-lg bg-amber-500/[0.14] px-2.5 py-0.5 font-semibold text-amber-800 dark:text-amber-300">
                    ③ 人工复核拍板再入账
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setShowQuickGuide((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200/90 bg-white/85 px-3.5 py-1.5 font-mono text-xs font-medium text-zinc-800 transition hover:bg-white dark:border-white/15 dark:bg-white/10 dark:text-zinc-100"
              >
                <HelpCircle className="h-3.5 w-3.5" />
                {showQuickGuide ? "收起使用指引" : "新手怎么用？"}
              </button>
              {agentStatus?.phoenix_ui_url && (
                <a
                  href={agentStatus.phoenix_ui_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-3.5 py-1.5 font-mono text-xs font-medium text-zinc-800 transition hover:bg-zinc-200 dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/20"
                >
                  Phoenix 链路追踪
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          </div>

          <AnimatePresence>
          {showQuickGuide && (
            <motion.div
              key="copilot-quick-guide"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.24, ease: EASE_EXPO }}
              className="grid grid-cols-1 gap-2.5 rounded-xl border border-zinc-200/80 bg-zinc-50/90 p-3.5 text-xs text-zinc-700 sm:grid-cols-3 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300"
            >
              <div>
                <strong className="text-zinc-950 dark:text-white">第一步 · 查逻辑与避坑：</strong>
                用左栏下方三张场景卡对关注标的做风险体检，或切去「红蓝对抗」让多空两派互相挑刺。
              </div>
              <div>
                <strong className="text-zinc-950 dark:text-white">第二步 · 算仓位与止损：</strong>
                在右栏填股票与股数，系统按你净值的 1% 安全线硬核限仓，并贴近 ATR 与期权墙标出止损/止盈。
              </div>
              <div>
                <strong className="text-zinc-950 dark:text-white">第三步 · 人工签字放行：</strong>
                审查无误再点批准；当前若接入只读券商，则会产出清晰委托参数供你在券商端安心执行。
              </div>
            </motion.div>
          )}
          </AnimatePresence>
        </SpotlightBlock>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          <SpotlightBlock tone="obsidian" className="p-5 lg:col-span-7">
            {renderCopilotPane()}
          </SpotlightBlock>

          <SpotlightBlock tone="gallery" className="p-5 lg:col-span-5">
            <div className="mb-4 grid grid-cols-2 gap-3 pb-3 border-b border-zinc-200/70 dark:border-white/10">
              <button
                type="button"
                onClick={() => setRightTab("risk")}
                className={`aurora-deck-card flex items-center justify-between rounded-2xl px-3.5 py-2.5 text-left ${
                  rightTab === "risk" ? "aurora-deck-amber" : "aurora-deck-idle"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition ${
                      rightTab === "risk"
                        ? "bg-amber-500 text-zinc-950 shadow-sm"
                        : "bg-amber-500/[0.14] text-amber-700 dark:text-amber-300"
                    }`}
                  >
                    <ShieldAlert className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="font-serif text-[13.5px] font-bold text-zinc-950 sm:text-sm dark:text-white">
                      Risk Critic 风控 &amp; HITL
                    </div>
                    <div className="font-mono text-[10.5px] text-zinc-600 dark:text-zinc-300">
                      独立限仓算单 · 人工签字
                    </div>
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setRightTab("sec")}
                className={`aurora-deck-card flex items-center justify-between rounded-2xl px-3.5 py-2.5 text-left ${
                  rightTab === "sec" ? "aurora-deck-sky" : "aurora-deck-idle"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition ${
                      rightTab === "sec"
                        ? "bg-sky-600 text-white shadow-sm dark:bg-sky-400 dark:text-zinc-950"
                        : "bg-sky-500/[0.14] text-sky-700 dark:text-sky-300"
                    }`}
                  >
                    <FileSearch className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="font-serif text-[13.5px] font-bold text-zinc-950 sm:text-sm dark:text-white">
                      SEC 财报直查 (0-Token)
                    </div>
                    <div className="font-mono text-[10.5px] text-zinc-600 dark:text-zinc-300">
                      10-K/Q 原文混合检索
                    </div>
                  </div>
                </div>
              </button>
            </div>

            {rightTab === "risk" ? (
              <motion.div
                key="right-risk"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, ease: EASE_EXPO }}
              >
                <RiskCriticPanel
                  defaultSymbol={riskPrefill.symbol || symbolInput || defaultSymbol}
                  prefillSide={riskPrefill.side}
                  prefillQty={riskPrefill.qty}
                  prefillRationale={riskPrefill.rationale}
                  prefillDraft={riskDraft}
                />
              </motion.div>
            ) : (
              <motion.div
                key="right-sec"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, ease: EASE_EXPO }}
              >
                {renderSecPane()}
              </motion.div>
            )}
          </SpotlightBlock>
        </div>
      </div>
    );
  }

  // Non-blocking Side Dock Drawer inside Cockpit
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: "100%", opacity: 0.6 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0.6 }}
          transition={{ duration: 0.3, ease: EASE_EXPO }}
          className="velvet-black-block fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col rounded-none border-l border-zinc-200/80 text-zinc-950 shadow-[-24px_0_70px_-15px_rgba(0,0,0,0.22)] dark:border-white/15 dark:text-zinc-100 dark:shadow-[-24px_0_70px_-15px_rgba(0,0,0,0.75)]"
        >
          {/* Header Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/80 px-5 py-3.5 dark:border-white/10">
            <div className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-100 text-zinc-900 dark:bg-white/10 dark:text-zinc-100">
                <Bot className="h-3.5 w-3.5" />
              </span>
              <div>
                <h2 className="font-serif text-base tracking-tight text-zinc-950 dark:text-white">
                  AI 侧边协查舱 ({symbolInput || defaultSymbol})
                </h2>
                <p className="font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                  非阻塞停靠 · 支持 8 项只读感知与直连风控预检
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              {onOpenFullWorkspace && (
                <button
                  type="button"
                  onClick={() => {
                    onClose?.();
                    onOpenFullWorkspace();
                  }}
                  className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 font-mono text-[10px] text-zinc-800 hover:bg-zinc-200 dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/20"
                >
                  <Maximize2 className="h-3 w-3" />
                  全屏作战台
                </button>
              )}
              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg bg-zinc-100 p-1.5 text-zinc-600 transition hover:text-zinc-950 dark:bg-white/10 dark:text-zinc-300 dark:hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {/* Sub-tabs inside Side Dock */}
          <div className="flex items-center gap-1 border-b border-zinc-200/80 bg-zinc-100/70 px-5 py-2 font-mono text-[11px] dark:border-white/10 dark:bg-white/[0.03]">
            <button
              type="button"
              onClick={() => setDrawerTab("agent")}
              className={`rounded-full px-3 py-1 transition ${
                drawerTab === "agent"
                  ? "bg-zinc-950 font-semibold text-white dark:bg-white dark:text-zinc-950"
                  : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
              }`}
            >
              Investigator 对话
            </button>
            <button
              type="button"
              onClick={() => setDrawerTab("risk")}
              className={`rounded-full px-3 py-1 transition ${
                drawerTab === "risk"
                  ? "bg-zinc-950 font-semibold text-white dark:bg-white dark:text-zinc-950"
                  : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
              }`}
            >
              Risk Critic 风控
            </button>
            <button
              type="button"
              onClick={() => setDrawerTab("sec")}
              className={`rounded-full px-3 py-1 transition ${
                drawerTab === "sec"
                  ? "bg-zinc-950 font-semibold text-white dark:bg-white dark:text-zinc-950"
                  : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
              }`}
            >
              SEC 财报检索
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5">
            {drawerTab === "agent" ? (
              <motion.div
                key="drawer-agent"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.26, ease: EASE_EXPO }}
              >
                {renderCopilotPane()}
              </motion.div>
            ) : drawerTab === "risk" ? (
              <motion.div
                key="drawer-risk"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.26, ease: EASE_EXPO }}
              >
                <RiskCriticPanel
                  defaultSymbol={riskPrefill.symbol || symbolInput || defaultSymbol}
                  prefillSide={riskPrefill.side}
                  prefillQty={riskPrefill.qty}
                  prefillRationale={riskPrefill.rationale}
                  prefillDraft={riskDraft}
                />
              </motion.div>
            ) : (
              <motion.div
                key="drawer-sec"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.26, ease: EASE_EXPO }}
              >
                {renderSecPane()}
              </motion.div>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

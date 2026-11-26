export interface ShowcaseToolTrace {
  tool: string;
  status: string;
  latency_ms: number;
  preview: string;
  output?: string;
}

export interface ShowcaseMemoryHit {
  symbol: string;
  regime_label: string;
  quadrant_outcome: string;
  title: string;
  alpha_vs_spy_pct?: number;
}

export interface ShowcaseInvestigatorSample {
  symbol: string;
  sampleQuery: string;
  nodeStatus: string;
  memoryHits: ShowcaseMemoryHit[];
  toolTraces: ShowcaseToolTrace[];
  answerMarkdown: string;
}

export const INVESTIGATOR_SHOWCASE_SAMPLE: ShowcaseInvestigatorSample = {
  symbol: "NVDA",
  sampleQuery:
    "请结合我当前的账户持仓、自选强弱矩阵、盘中 Watchdog 预警以及 NVDA 期权墙/SEC 风险，给出中文投研综述。（演示样例）",
  nodeStatus: "效果预览样例（支持 8 项 MCP 只读感知工具 + 历史经验召回；填入 API Key 立即实时流式推理）",
  memoryHits: [
    {
      symbol: "NVDA",
      regime_label: "HIGH_VOL_TRANSITION",
      quadrant_outcome: "BAD_PROCESS_GOOD_OUTCOME",
      title: "NVDA BUY [高波切换期避免无止损重仓逆势加仓]",
      alpha_vs_spy_pct: 2.15,
    },
  ],
  toolTraces: [
    {
      tool: "get_account_positions_snapshot",
      status: "ok",
      latency_ms: 28,
      preview: "读取活跃数据源（本地拟真模拟盘 / IBKR / 币安 / Trading212 / CSV 账本）净值与持仓盈亏",
      output:
        "Active Account: Local Sandbox or Read-Only Connector | Equity / Buying Power / Open Holdings snapshot synced cleanly.",
    },
    {
      tool: "get_watchlist_matrix",
      status: "ok",
      latency_ms: 34,
      preview: "扫描「我的关注」自选池全周期收益、RSI(14) 与 RVOL(20) 量价强弱",
      output:
        "User Watchlist Matrix: compares 1D/5D/YTD returns, RSI momentum, and RVOL anomalies across all tracked tickers.",
    },
    {
      tool: "get_watchdog_and_memories",
      status: "ok",
      latency_ms: 22,
      preview: "检查未确认的 Watchdog 异常预警与相似宏观 Regime 历史复盘教训",
      output:
        "Checks unacknowledged zero_gamma_breach / rvol_spike alerts & recalls episodic mistake rules for pre-trade caution.",
    },
    {
      tool: "get_asset_structure",
      status: "ok",
      latency_ms: 48,
      preview: "提取标的技术动量、EMA 偏离度、Estimated GEX 期权墙与最新新闻催化",
      output:
        "Extracts spot vs EMA20/SMA50/200, ATR%, RVOL 4-quadrant state, Call Wall / Put Wall / Zero Gamma bounds.",
    },
    {
      tool: "run_sec_parallel_audit",
      status: "ok",
      latency_ms: 94,
      preview: "3 路并行子研究员审计 SEC 10-K/10-Q 风险因子、毛利率驱动与流动性现金流",
      output:
        "Parallel fast sub-researchers inspect Risk Factors, Margin Drivers, and Debt/CapEx with inline [10-K/10-Q] citations.",
    },
  ],
  answerMarkdown: `> **[多智能体效果演示样本 · 未消耗任何 LLM 额度]**  
> 下方展示配置自有 API Key（并可只读接入本地模拟盘 / IBKR / 币安 / Trading212 / CSV 等数据源）后，**MarketElite Investigator** 的真实多工具联动工作流：

### 1. 账户与历史经验前置校准
- **持仓与集中度扫描**：Agent 通过 \`get_account_positions_snapshot\` 读取您当前的实时持仓成本、账户净值与剩余购买力，避免孤立看单一 K 线导致单票敞口失衡。
- **历史教训自动注入**：自动检索到相似波动率体制下的过往经验卡片，提示在 \`Zero Gamma\` 下方或高影响宏观事件窗口需严格执行 \`1%\` 风险预算与止损约束。

### 2. 市场结构与期权 Gamma 墙
- **量价与均线结构**：实时核对现价相对 \`EMA 20 / SMA 50 / SMA 200\` 偏离度与 \`RVOL 20D\`，区分“放量主升突破”与“缩量弱势反弹”。
- **期权墙约束（Estimated GEX）**：明确标注 **Call Wall（上方磁吸/阻力）**、**Put Wall（下方买盘缓冲）** 与 **Zero Gamma 翻转点**（基于 Dealer 对冲假设 & OCC T+1/T+2 OI）。

### 3. 基本面 / SEC 财报并行取证（零幻觉引用）
- 调用 3 路并行 RAG 子节点检索最新 \`10-K Item 1A Risk Factors\` 与 \`Item 7 MD&A\` 原文片段，核验毛利率指引、资本开支与出口/供应链合规硬风险，并附带出处标签。

### 4. 主要风险与下一步风控审查
- 给出清晰的 **证伪失效条件（Falsification Trigger）** 与参考盈亏比区间；点击下方按钮即可将本次论据直传右侧 **上下文隔离 Risk Critic CRO** 面板，按您账户真实净值测算安全股数与止损止盈边界。`,
};

export const WATCHLIST_SHOWCASE_BRIEF = `> **[效果演示样本 · 点击右上角 ⚙️ 填入您的 API Key 即可对当前自选池生成实时 AI 诊断]**

### 自选组合机构级复盘示例结构
1. **强弱分化对比**：系统会根据您自选列表内各标的近 \`1D / 1M / YTD\` 相对强弱与 \`RSI(14)\` 区间，识别短期超买领涨股与低位蓄势补涨标的。
2. **宏观敏感度与集中度提示**：分析组合是否过度暴露在单一板块（如高 Beta 算力/半导体）及面临下一次 **CPI / FOMC / 季末调仓窗口** 的回撤风险。
3. **本周跟踪清单**：列明每只关注标的下一步需要留意的突破确认位与防守均线位置。`;

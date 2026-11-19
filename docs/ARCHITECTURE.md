# MarketElite 系统架构设计规范

> 定位：**1 个确定性市场驾驶舱底座 + 3 个职责隔离的闭环自治 Agent**（拒绝“套壳问答网站”与过度拆分伪 Agent）。

---

## 1. 核心架构拓扑

```text
用户浏览器 (Next.js App Router · 白底丝绒黑白撞色终端)
   │  HTTP / SSE / Generative UI
   ▼
Cloudflare CDN/WAF ──▶ Caddy (自动 HTTPS · 禁用 SSE 缓冲)
   ├──▶ Next.js 前端服务 (本地: 3100)
   └──▶ FastAPI 后端网关 (本地: 8100 · 令牌桶限流 / Redis 防重入锁)
           │
           ├──▶ LangGraph 状态机 (AsyncPostgresSaver Checkpoint)
           │      ├── Agent 1: Investigator (动态 ReAct + 并行子图调研)
           │      └── Agent 2: Risk Critic (条件触发 · 隔离上下文 · 1%风险仓位 · HITL)
           │                    └── 用户人工确认后 ──▶ 确定性执行节点 ──▶ Alpaca Paper Bracket 下单
           │
           ├──▶ FastMCP Server (Streamable HTTP · langchain-mcp-adapters)
           │      ├── 行情 / 期权 Estimated GEX / 新闻 / 日历 只读工具
           │      └── SEC 10-K/10-Q 懒加载混合 RAG (pgvector + tsvector BM25)
           │
           ├──▶ PostgreSQL 16 + pgvector (本地: 5433)
           │      └── 一库四用: 时序业务表 / Checkpoint / SEC RAG / 复盘长期记忆
           │
           ├──▶ Redis 7 (本地: 6380)
           │      └── 驾驶舱热缓存 (Soft/Hard 双 TTL) / 熔断器状态 / 每日 Regime 快照
           │
           └──▶ Arize Phoenix (本地: 6007 / OTLP 4318)
                  └── 单容器轻量 OpenTelemetry Trace 与黄金测试集 Eval

后台独立进程: ARQ Worker + Agent 3 (Watchdog & Reflection)
   ├── 定时计算: 净流动性 / Estimated GEX / RVOL / 广度 / 每日 Regime 快照
   ├── 事件主动巡检: 盘中放量破位 / Zero Gamma 跌破主动归因告警
   └── 事后自我反思: 平仓后四象限归因 + Alpha vs SPY + 错题写入 pgvector 长期记忆
```

---

## 2. 关键架构取舍：为什么这样拆？

### 2.1 确定性 Pipeline vs Multi-Agent 边界
* **非 Agent 部分**：抓数、算指标（Net Liquidity、Black-Scholes Gamma / Estimated GEX、RSI/MACD/RVOL、市场广度、胜率与 Alpha SQL）全部由 Python 确定性算子 + ARQ 定时完成，**0 LLM Token 浪费**。
* **保留 3 个真实 Agent 的工程依据**：
  1. **Investigator（主脑）**：面对异动或复杂诉求动态决定调用哪些工具，遇万字财报时派生并行子图做上下文隔离提炼。
  2. **Risk Critic（对抗裁判）**：仅在交易意图时条件触发；故意隔离情绪对话上下文，专门做“唱反调”风控体检 + HITL 人工授权卡。
  3. **Watchdog & Reflection（后台哨兵）**：生命周期完全独立于在线对话，负责 7×24 事件驱动主动归因与 T+5/T+20 客观结果自我评测。

### 2.2 精准混合 RAG 分流策略（不盲目向量化）
* **不进 RAG**：K 线价格、技术指标、宏观净流动性、经济日历、持仓账本 → 全走 **PostgreSQL 时序/关系表 + Redis + 精准 SQL Tool**。
* **刚需 RAG（PostgreSQL `pgvector` + `tsvector` 混合检索 + Rerank）**：
  1. **SEC 10-K / 10-Q / 8-K 长文本财报**（按需懒加载 Lazy Ingestion，按章节切块 + 元数据过滤）。
  2. **跨标的交易复盘错题库**（Episodic Memory，按当前市场 Regime 语义召回历史 Top-3 教训）。

---

## 3. 七大生产级稳定性与异常兜底机制

1. **Loop 防死循环与卡死（4 道防线）**：`max_steps = 8` + `recursion_limit` + `45s` 墙钟超时 + `max_tokens_budget`；工具指纹哈希防连续重复调用；超限跳转 `force_synthesize` 优雅降级不抛 500；Redis `lock:run:{thread_id}` 防连击重入。
2. **Tool 校验与权限隔离**：所有入参 Pydantic v2 强校验；MCP `isError=true` 自动转为 `ToolMessage` 供 LLM 自愈纠错（最多 2 次）；**Alpaca 下单工具绝不暴露给任何对话式模型**，仅由 HITL 确认后的确定性节点执行。
3. **外部接口限流与熔断**：瞬态错误（429/503/超时）走指数退避重试；单源 60 秒连败 5 次打开 Redis 熔断器 60 秒；采用 **Soft-TTL / Hard-TTL 双缓存**，熔断期间返回旧快照并标注 `[Stale Cache]` 延迟提示。
4. **Checkpoint 断点恢复**：采用 `langgraph-checkpoint-postgres` (`AsyncPostgresSaver` + `AsyncConnectionPool`，`autocommit=True`、`prepare_threshold=0`、`row_factory=dict_row`、`LANGGRAPH_STRICT_MSGPACK=true`)，支持 HITL 跨小时/跨天零内存挂起与恢复。
5. **防上下文爆炸（4 道防线）**：MCP Tool 源头统计压缩（返回控制在 ~300 Tokens）→ 并行子图消化万字财报 → Rolling Summarization 对话滚动摘要 → 发送前 Tokenizer 核验硬裁剪。
6. **公网防刷与模型分层路由**：首页驾驶舱 100% 直读 Redis（0 API 消耗、0 Token）；对话按登录态/IP 限流；`LLM Router` 区分 Fast Tier（摘要/子图压缩）与 Pro Tier（主脑规划/Critic 审查），并利用支持 Context Caching 的接口压低多轮成本。
7. **双轨 Eval 评测**：日常 CI 跑 0 Token 的 Mock 确定性单测；发版/调 Prompt 前在 **Arize Phoenix** 手动跑 30~50 条时间切片黄金集（测数字忠实度与风控拦截率），配合线上 Watchdog T+5/T+20 真实结果闭环。

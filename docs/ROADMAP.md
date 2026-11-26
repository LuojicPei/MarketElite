# MarketElite 工程演进与交付里程碑档案（Phase 0 → v1.0）

> 记录 **MarketElite v1.0** 从底层基础设施骨架到全栈 DataOps 与 4-Track Eval 治理平台的完整落地阶段。所有阶段均已完成交付并纳入后端回归单测（85 项）与 4-Track 评测（54 项）。

| 演进阶段 | 核心目标 | 已交付关键能力与代码落点 | 状态 |
| :--- | :--- | :--- | :--- |
| **Phase 0** | 工程底座与可观测起步 | Monorepo 架构、`docker-compose`（`PostgreSQL 16 + pgvector` / `Redis 7` / `Arize Phoenix`）、FastAPI `/health` 探针与 Next.js App Router 底座 | ✅ 已交付 |
| **Phase 1** | 确定性数据中台与弹性缓存 | Alpaca/FRED/Finnhub/FMP/Binance/CFTC 数据管道、指数退避重试 + Redis 熔断器 + Soft/Hard 双 TTL 缓存、Net Liquidity / Estimated GEX / RVOL / 广度纯 Python 算子 | ✅ 已交付 |
| **Phase 2** | 高密度驾驶舱与图表可视化 | `/api/dashboard/overview`、TradingView Lightweight Charts K 线（EMA/Volume/GEX 水位叠加）、ECharts 板块热力与收益曲线、Bull vs Bear 对抗面板与 Price Ladder | ✅ 已交付 |
| **Phase 3** | 真 Agent 主脑 + FastMCP + SEC 混合 RAG | `FastMCP (Streamable HTTP)` 8 项只读工具、SEC EDGAR 懒加载 `pgvector + tsvector` RRF 混合检索、LangGraph `Investigator`（4 道防死循环/超窗防线）、SSE 流式推演与线程存档 | ✅ 已交付 |
| **Phase 4** | 独立风控对抗、HITL 断点与多券商账户 | `AsyncPostgresSaver` 持久化、`Risk Critic` 1% 硬限仓与 Bracket 标尺、6 类统一券商适配（Sandbox / Alpaca / IBKR Flex / Binance RO / Trading212 / CSV）、多租户 `X-Workspace-Id` 隔离 | ✅ 已交付 |
| **Phase 5** | 24/7 Watchdog 哨兵、记忆与 Golden Eval | `WatchdogAutopilotManager` 后台主动巡检、平仓后 2×2 四象限归因与 Alpha vs SPY、AI 周期教练、`EpisodicMemory` 置顶铁律库、`evals/run_eval.py`（32 条确定性基准） | ✅ 已交付 |
| **v0.8 – v0.9** | 微结构 6+6+12 与 Liquid Glass 三主题引擎 | 补全 FINRA ATS 暗池、机构资金流、链上脉搏、领涨领跌榜与双语即时新闻翻译；重构晨雾白 / 暖砂纸 / 曜石黑 Liquid Glass 主题与 Zero-Border Aurora 无边框极光卡片 | ✅ 已交付 |
| **v1.0.0** *(当前开源版本)* | DataOps 与 4-Track Eval 中台 + 体验抛光 + 开源零密钥就绪 | 升级为 **数据与评测中台**（16 表 4 层数仓血缘、6 项 DQ 审计、RAG 治理、FinOps、4-Track 54 条评测集与基线对比）；落地 `PUBLIC_SHOWCASE_READONLY` 只读守卫；红蓝对抗大白话重构、40 条分类提示词（10s 轮播）与问答折叠、券商 45s Redis 缓存 + 前端 SWR 秒切；新增 **0-Key 静态演示快照 Seed** | ✅ 已交付 |

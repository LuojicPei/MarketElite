# MarketElite 工程开发路线图（Phase 0 → Phase 5）

| 阶段 | 核心目标 | 关键交付物 | 验收标准 (DoD) |
| :--- | :--- | :--- | :--- |
| **Phase 0** *(已完成底座与视觉定调)* | 工程骨架、Git/Docker 底座、4号新视觉基线 | Monorepo 骨架、`docs/` 设计文档、`pgvector` + Redis + Phoenix 容器、白底黑白撞色控制台 | `pytest` & `ruff` 全绿；`http://localhost:3100` & `http://localhost:8100/health` 全组件 UP。 |
| **Phase 1** *(下一步)* | 确定性数据中台、量化算子与防雪崩缓存 | Alembic 表迁移、外部数据源客户端（含退避重试 + Redis 熔断 + 双 TTL 缓存）、净流动性/GEX/RVOL/广度算子、ARQ 定时调度 | `pytest` 100% 覆盖算子与 429 熔断模拟；数据库稳定生成每日市场快照。 |
| **Phase 2** | 高密度一页式驾驶舱 & 首次 VPS 上线 | `/api/dashboard/overview`（<50ms）、Lightweight Charts + ECharts 四象限白底黑白撞色驾驶舱、Caddy HTTPS + Cloudflare 公网域名首次上线 | 公网 `https://` 域名可打开实时更新的一页式驾驶舱。 |
| **Phase 3** | 真 Agent 主脑 + FastMCP + SEC 混合 RAG | `FastMCP (Streamable HTTP)` 工具层、SEC 10-K/10-Q 懒加载 `pgvector+BM25` RAG、LangGraph `Investigator`（含防死循环/上下文 4 道防线）、SSE + Arize Phoenix | 动态多步查股并引用 SEC 原文，Phoenix 可追溯完整 Trace，压测不卡死不超窗。 |
| **Phase 4** | 风控对抗 + Checkpoint + Alpaca 模拟下单 | `AsyncPostgresSaver`、`Risk Critic` 独立审查、1% 风险预算、HITL `interrupt()` 挂起恢复、Alpaca Paper Trading `OrderClass.BRACKET` 下单 | 完整跑通“提案 → 风控缩仓设止损 → 跨会话 HITL 确认 → Alpaca 模拟盘挂单”。 |
| **Phase 5** | Watchdog 巡检、长期记忆、Eval 门禁与防刷 | ARQ 盘中异动主动归因、平仓后四象限/Alpha 复盘写入 `pgvector`、30~50 条黄金集横向模型评测、访客配额与 GitHub Actions CI/CD | 公网稳定运行 48h，输出真实 Eval 评测报告与自评测统计看板。 |

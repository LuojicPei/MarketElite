# MarketElite

> 生产级美股市场结构洞察、独立风控对抗与闭环交易复盘 Multi-Agent 工作台。

## 核心架构定位

本项目并非“带图表的套壳问答网站”，而是由 **1 个确定性数据驾驶舱底座 + 3 个职责隔离的真实 Agent** 构成的闭环系统：

1. **确定性底座（Zero-Token Pipeline & Market Cockpit）**：定期聚合 FRED 宏观净流动性、美债收益率、HY/IG 信用利差、CFTC COT、Binance BTC、Alpaca 行情与期权链（Estimated GEX / Call-Put Wall / Zero Gamma）并落盘 PostgreSQL + Redis 热缓存。
2. **Agent 1 — Investigator（首席调查与执行主脑）**：基于 LangGraph 动态规划调查路径，通过 FastMCP (`Streamable HTTP`) 调用只读工具及按需懒加载的 SEC 10-K/10-Q 混合 RAG（`pgvector` + `tsvector`）。
3. **Agent 2 — Risk Critic（独立风控对抗裁判）**：条件路由触发，在隔离上下文下进行无情风控压力测试与仓位风险预算校验，通过 `AsyncPostgresSaver` Checkpoint + `interrupt()` HITL 确认后，经由确定性节点调用 Alpaca Paper Trading API 提交带止盈止损的 Bracket Order。
4. **Agent 3 — Watchdog & Reflection（后台主动巡检与自我反思）**：事件驱动主动异动归因告警、模拟单平仓后四象限归因与 Alpha 计算，并沉淀个人长期错题记忆。

---

## 本地快速启动（Phase 0）

### 1. 配置环境变量
```powershell
Copy-Item .env.example .env
# 编辑 .env 填入你的 ALPACA / FRED / FINNHUB / FMP / LLM Key
```

### 2. 启动本地基础设施（PostgreSQL pgvector + Redis + Arize Phoenix）
```powershell
docker compose -f docker-compose.dev.yml up -d
```

### 3. 启动后端 FastAPI（默认端口 8100）
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
python run.py
```

运行单元测试（0 Token 消耗）：
```powershell
pytest
```

验证外部 API Key 连通性：
```powershell
python -m scripts.check_keys
```

### 4. 启动前端 Next.js（默认端口 3100）
方式 A（本机已安装 Node.js 20+）：
```powershell
cd frontend
npm install
npm run dev
```

方式 B（本机未装 Node.js，直接用 Docker 一键启动前端）：
```powershell
docker compose -f docker-compose.dev.yml --profile web up -d --build frontend
```
打开浏览器访问 `http://localhost:3100` 查看系统探针与架构控制台（Phoenix 面板位于 `http://localhost:6007`）。

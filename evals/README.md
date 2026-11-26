# MarketElite 4-Track 全栈评测治理体系说明

MarketElite 的评测系统升级自早期 Phase 5 基准测试，目前在「**数据与评测中台 → 全栈评测 (4-Track)**」与离线 CLI 中统一运行 **4 个评测轨道（共 54 条结构化测试用例）**，并通过 PostgreSQL `eval_runs` 表持久化历次运行与回归基线比对。

---

## 1. 四轨数据集全览（`evals/datasets/`）

| 轨道 | 数据集文件 | 用例数 | 核心评测指标与校验逻辑 |
| :--- | :--- | :---: | :--- |
| **Track 1 · 确定性量化与风控基线** | [golden_cases.json](./datasets/golden_cases.json) | **32** | 覆盖 4 大域各 8 题：`regime_macro`（VIX 倒挂、净流动性恒等式、5 维 Fear & Greed）、`options_gex`（Net GEX 墙位、Zero Gamma、RVOL 标签）、`risk_critic`（1% 预算钳位、Bracket 防错）、`watchdog_safety`（四象限归因、死循环哈希拦截、RRF 融合排序）。 |
| **Track 2 · SEC 混合 RAG 与数值忠实度** | [rag_faithfulness_cases.json](./datasets/rag_faithfulness_cases.json) | **8** | 验证 `pgvector + tsvector` Hybrid RRF 的 `Recall@3` 与 `MRR`；核验回答中引用的财务数字是否**严格出自检索片段（数字防幻觉率）**，以及信息缺失时是否正确触发拒答边界（拒绝胡编）。 |
| **Track 3 · 多步 Agent 沙箱轨迹与 pass^k** | [agent_sandbox_cases.json](./datasets/agent_sandbox_cases.json) | **6** | 基于无外网依赖沙箱工具运行 LangGraph `Investigator`，检验预期工具链轨迹命中率、重复工具指纹死循环熔断、`agent_max_steps` 强制收敛降级、交易意图识别以及连续 `k=3` 次执行的 **`pass^k` 稳定通过率**。 |
| **Track 4 · 红队对抗与反事实敏感性** | [redteam_adversarial_cases.json](./datasets/redteam_adversarial_cases.json) | **8** | 测试 Indirect Prompt Injection 越狱抵御（如试图让模型越权下单或忽略 1% 红线）、下游数据缺失降级容错，以及宏观 Regime / Zero Gamma 关键参数翻转后的**反事实决策敏感度**。 |

---

## 2. 运行方式

### 2.1 在线 Web 中台一键触发（推荐）
打开前端顶部导航「**数据与评测中台 → 全栈评测 (4-Track)**」：
- 支持勾选单个或全部 Track 运行，实时查看 Pass/Fail 分布、分轨道通过率、失败用例 Diff 与历次回归基线比较（`EvalRun` 持久化于 PostgreSQL）。
- *注*：若公网部署开启了 `PUBLIC_SHOWCASE_READONLY=true`，访客可免费浏览全部历史报告与明细，点击「重新运行全栈评测」或「设为回归基线」需填入 `X-Admin-Token`。

### 2.2 命令行 CLI 运行（0 外部网络依赖）
在仓库根目录下运行 Track 1 确定性基准测试并刷新 [latest_report.json](./latest_report.json)：

```bash
# Linux / macOS
backend/.venv/bin/python evals/run_eval.py

# Windows PowerShell
.\backend\.venv\Scripts\python.exe .\evals\run_eval.py
```

### 2.3 运行完整后端单测（含 Track 1~4 引擎校验）
```bash
cd backend
pytest -q
```

# MarketElite Evaluation Harness (Phase 5)

本目录用于存放双轨评测体系（Dual-Track Eval），确保核心量化算子、风控纪律、交易归因与多智能体防护边界可持续回归验证：

## 1. 离线黄金测试集 (`datasets/golden_cases.json`)
包含 **32 条覆盖 4 大核心维度的标准用例**：
- `regime_macro` (8 项)：VIX 期限倒挂识别、净流动性 `WALCL - TGA - RRP` 恒等式、5 维 Fear & Greed 边界校验。
- `options_gex` (8 项)：正/负 Net GEX 期权墙计算、Zero Gamma 区间插值、RVOL 四象限量价标签与技术指标校验。
- `risk_critic` (8 项)：1% 单笔资金风险预算强制钳位、Bracket 止损防错校验、反趋势/宏观催化对抗审查。
- `watchdog_safety` (8 项)：过程×结果 4 象限归因分类、交易意图识别精准度、工具调用指纹死循环拦截与混合 RRF 排序。

## 2. 运行命令

```powershell
# CLI 运行并刷新 evals/latest_report.json
d:\MarketElite\backend\.venv\Scripts\python.exe d:\MarketElite\evals\run_eval.py
```

同时可在本地工作台「**系统与评测 (Infra & Evals) → Phase 5 黄金评测**」标签页一键在线触发与查看逐项实测结果。

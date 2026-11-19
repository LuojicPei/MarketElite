# MarketElite Evaluation Harness (Phase 5)

本目录用于存放双轨评测体系（Dual-Track Eval）：
1. **离线黄金测试集 (`datasets/`)**：涵盖 30~50 条美股真实时间切片测试用例（含财报雷区陷阱、负 Gamma 暴跌抄底校验、乱码标的容错、死循环诱发与 Prompt 注入攻击）。
2. **线上 Arize Phoenix 回归脚本**：对比不同模型（Fast Tier vs Pro Tier）在数字零幻觉忠实度、风控规则遵守率、端到端延迟与单任务成本上的表现。

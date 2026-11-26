# MarketElite 数据底座、微结构体系与 0-Key 降级规范（v1.0）

> 核心原则：**真实、零暗箱造假、显式标注延迟与假设边界，并在开源 0-Key 冷启动与实时全量行情之间平滑切换。**

---

## 一、 美股 5 层认知监测雷达

### 第 1 层：宏观流动性、美债曲线与信用体温锚（FRED / 免 Key CSV Fallback）
* **美联储净流动性（Net Liquidity）**：`WALCL（总资产）- WTREGEN（财政部 TGA 账户）- RRPONTSYD（隔夜逆回购）`
* **银行管道与隔夜压力**：`WRESBAL`（存款机构准备金余额）、`SOFR`（有担保隔夜融资利率）
* **美债收益率曲线**：`DGS2`、`DGS10`、`T10Y2Y`（10Y-2Y 利差）、`DFII10`（10Y TIPS 实际利率）
* **信用风险利差**：`BAMLH0A0HYM2`（HY OAS 垃圾债利差）、`BAMLC0A0CM`（IG 投资级利差）及 `HYG / LQD` 强弱比
* *降级策略*：未配置 `FRED_API_KEY` 时，[fred.py](../backend/app/services/providers/fred.py) 自动通过 St. Louis Fed 免密钥官方 `fredgraph.csv` 拉取全序列。

### 第 2 层：期权微结构与波动率期限（Alpaca Indicative + CBOE）
* **Estimated GEX（做市商伽马敞口估算）**：
  * 拼接 Alpaca `/v1beta1/options/snapshots/{symbol}?feed=indicative`（报价、IV、Greeks）与 OCC 结算 `open_interest`（明确标注 T+1/T+2 OI 滞后与做市商仓位方向行业惯例）。
  * 公式：`Strike GEX ($/1% move) = Spot² × OI × 100 × Gamma × 0.01`。
  * 核心衍生价位：**Call Wall**（上方阻力集中位）、**Put Wall**（下方支撑防守位）、**Zero Gamma / Gamma Flip**（均值回归 vs 负伽马波动加速分界线）、**Put/Call Ratio**。
* **波动率期限结构**：`^VIX9D / ^VIX / ^VIX3M` 判断平滑 Contango vs 短期恐慌 Backwardation 倒挂。

### 第 3 层：大盘骨架、市场广度与 11 板块轮动
* **核心指数与风险代理**：`SPY`、`QQQ`、`SOXX`（半导体风向标）、`IWM`、`RSP`、`BTCUSDT`。
* **广度健康度**：`RSP / SPY` 强弱比、成分股站上 `50MA / 200MA` 百分比、涨跌分布。
* **11 大板块轮动热力图**：`XLK / XLY / XLC`、`XLF / XLI / XLE / XLB`、`XLU / XLP / XLV / XLRE`。
* **跨资产滚动相关性**：`UUP`、`GLD`、`CPER`、`TLT`、`BTCUSDT` 相对 `SPY` 的 20D/60D 滚动相关性。

### 第 4 层：个股量价结构与盘中过滤
* **IEX 单边流与全市场校准约束**：实盘参考盘口价差之外，全天 **RVOL（当日量 / 20 日均量）** 与技术状态锚定 15 分钟全市场 Bar 或盘后校准 Bar，避免 2%~3% IEX 样本误判量能。
* **全自动技术指标栈**：`5/10/20 EMA`、`50/200 SMA` 偏离度、`MACD`、`RSI-14`、`ATR-14` 与四象限量价标签。

### 第 5 层：微结构 6+6+12 模块、仓位、日历与资讯流
* **大盘 6+6+12 微结构扩展雷达**：
  * **暗池透明度代理 (`/api/market/darkpool`)**：FINRA ATS 延迟周报透明展示机构场外撮合占比，严格标明监管 2–4 周延迟周期，绝不伪造实时暗池。
  * **MOC 尾盘与机构流向 (`/api/market/moc`, `/api/market/institutional-flow`)**：聚合大宗指数 ETF 尾盘与板块流向压力评分。
  * **链上宏观流动性 (`/api/market/onchain`)**：整合 BTCUSDT、DefiLlama 稳定币市值总水位（购买力弹药）与加密衍生品脉搏。
  * **机构期货仓位**：CFTC Socrata JSON 免 Key 周报（`ES` / `NQ` 等 Leveraged Funds & Asset Managers 净头寸）。
  * **异动榜单 (`/api/market/movers`)** 与 **双语即时财经发现流 (`/api/market/discover`)**：支持站内零额度中英对照即时切换与缩略图本地代理。

---

## 二、 四层数仓（DataOps）与数据质量（DQ-01 ~ DQ-06）

「数据与评测中台」实时巡检 **16 张 PostgreSQL 表** 与 Redis 关键健，按 **ODS（原始接入）→ DWD（清洗归一化）→ DWS（计算汇总特征/向量）→ ADS（交互交付表）** 展示全链路血缘，并自动运行 6 项数据质量审计：
1. `DQ-01` 行情日线完整性与极值防错（`market_daily_bars`）
2. `DQ-02` 宏观流动性与利率时序连续性（`macro_series`）
3. `DQ-03` 期权链 GEX 与关键墙位合理性校验（`options_gex_snapshots`）
4. `DQ-04` Discover 新闻满载与双语翻译完整率
5. `DQ-05` 6 大业务表 `workspace_id` 多租户隔离键防越界审计
6. `DQ-06` MOC / FINRA 暗池 / 链上微结构缓存健康探针

---

## 三、 0-Key 静态演示快照 vs 免费 API Key 能力边界

为保证 GitHub 开源克隆者在**完全不填写任何外部 API Key**的情况下也能流畅体验完整工作台，系统提供安全的双轨运行边界：

| 数据维度 | 0-Key 冷启动（内置静态演示快照） | 填写个人免费 API Key 后（`.env` / BYOK） |
| :--- | :--- | :--- |
| **美股日线与广度** | ✅ [demo_seed.py](../backend/app/services/demo_seed.py) 自动生成 40+ 核心标的 65 个交易日脱敏样本（不覆盖已有真实数据） | ✅ 通过免费 Alpaca Paper Key 自动拉取真实全市场日线与盘中更新 |
| **期权 GEX 与墙位** | ✅ 预置 SPY/QQQ/NVDA 等 10 大标的多行权价示例 GEX 墙与 Zero Gamma | ✅ 接入 Alpaca Indicative Options + OCC OI 计算真实个股期权墙 |
| **宏观流动性与利率** | ✅ 静态样本底座 + 免 Key FRED 官方 CSV 公开拉取 | ✅ 使用 `FRED_API_KEY` 高速稳态拉取并写入日度 Regime 快照 |
| **财经日历 / 一致预期** | ✅ 示例重要宏观窗口与季度 EPS 样本 | ✅ Finnhub + FMP 真实财报/FOMC/CPI 日历与 EPS 修正追踪 |
| **AI 智能体与 SEC RAG** | ✅ 红蓝对抗免 Key 压测 + Risk Critic 1% 算仓 + 0-Token SEC 样本检索 | ✅ 浏览器填入个人 DeepSeek / Gemini Key 即解锁流式 ReAct 调研与实时 EDGAR 解析 |

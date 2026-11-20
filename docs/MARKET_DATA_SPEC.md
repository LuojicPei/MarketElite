# MarketElite 美股数据底座与 5 层指标体系规范

> 原则：真实、零假数据、按更新频率分级调度、明确标出延时与计算假设边界。

---

## 一、 美股认知 5 层监测雷达

### 第 1 层：宏观水位与信用定价锚（Daily / Weekly · FRED）
* **美股净流动性（Net Liquidity）**：`WALCL (美联储总资产) - WTREGEN (财政部 TGA) - RRPONTSYD (隔夜逆回购)`
* **准备金与资金管道压力**：`WRESBAL`（银行准备金余额）、`SOFR`（有担保隔夜融资利率，防流动性管道危机）
* **美债收益率曲线**：`DGS2`（2Y 政策预期）、`DGS10`（10Y 资产定价分母）、`T10Y2Y`（10Y-2Y 利差）、`DFII10`（10Y TIPS 实际利率）
* **信用利差（机构风险体温计）**：`BAMLH0A0HYM2`（HY OAS 垃圾债利差，注意 FRED 授权仅保留滚动近 3 年窗口）、`BAMLC0A0CM`（IG 投资级利差）与 `HYG / LQD` 价格比率

### 第 2 层：期权结构与波动率期限（15-30m / Daily · Alpaca Indicative + CBOE）
* **Estimated GEX（做市商伽马敞口估算）**：
  * 拼接 Alpaca `/v1beta1/options/snapshots/{symbol}?feed=indicative`（报价、IV、Greeks）与 `/v2/options/contracts`（OCC 结算 `open_interest`，存在 T+1/T+2 滞后）。
  * 公式：`Strike GEX ($/1% move) = Spot² × OI × 100 × Gamma × 0.01`（按做市商净空/净多行业惯例符号假定聚合为标的价格每波动 1% 对应的做市商对冲美元敞口，**UI 必须明确标注 `Estimated GEX` 假定前提**）。
  * 衍生位：**Call Wall**（正 Gamma 最大阻力位）、**Put Wall**（负/支撑集中位）、**Zero Gamma / Gamma Flip**（震荡均值回归 vs 趋势加速分界线）、**Put/Call Ratio**。
* **波动率期限结构**：基于 `^VIX9D / ^VIX / ^VIX3M`（CBOE CSV / 极低频 `yfinance` + FRED `VIXCLS` 兜底）判断 Contango（平静）vs Backwardation（短期恐慌倒挂）。

### 第 3 层：大盘骨架、市场广度与板块轮动（15m / Daily · Alpaca）
* **核心指数与风险资产代理**：`SPY`（标普500）、`QQQ`（纳指100）、`SOXX`（半导体先行风向标）、`IWM`（小盘利率敏感度）、`RSP`（等权重标普）、`BTCUSDT`（Binance 7×24 全球流动性金丝雀）。
* **市场广度**：`RSP / SPY` 强弱比、标普成分股站上 `50MA / 200MA` 百分比、涨跌家数比。
* **11 大板块轮动热力**：`XLK / XLY / XLC`（进攻）、`XLF / XLI / XLE / XLB`（周期再通胀）、`XLU / XLP / XLV / XLRE`（防御）。
* **跨资产相关性**：`UUP`（美元代理）、`GLD`（黄金）、`CPER`（铜）、`TLT`（20 年美债）与 `SPY` 的滚动 20D/60D 相关性。

### 第 4 层：个股微观量价与技术过滤（15m / Daily · Alpaca）
* **关键 Engineering 约束**：Alpaca 免费实时 WebSocket（最多 30 标的）仅走 **IEX 单一交易所（约占全美 2%–3% 成交量）**。因此盘中参考 IEX 价格，但 **RVOL（相对成交量 = 当日量 / 20日均量）与 VWAP 必须采用 15 分钟延迟全市场汇总 Bar 或盘后校准数据**。
* **技术状态标签**：`5/10/20 EMA`、`50/200 SMA` 偏离度、`MACD` 动量与顶底背离、`RSI`（结合正/负 Gamma 区分钝化还是反转）、`ATR` 波动率警戒（无方向性，独立徽章显示）。

### 第 5 层：仓位、日历、基本面与自研情绪（Weekly / Daily）
* **机构期货仓位**：CFTC Socrata JSON API（`6dca-aqww` / `jun7-fc8e`，每周五更新周报）。
* **日历与一致预期**：Finnhub（`/api/v1/calendar/earnings` + Consensus EPS 每日入库自建修正曲线）+ FMP（`/stable/economic-calendar` CPI/FOMC/NFP 90天窗口）。
* **自研恐慌贪婪合成指数**：基于已有指标加权合成（替代容易在云 IP 触发 WAF 的 CNN 爬虫）。
* **商业高价壁垒取舍**：不造假实时暗池、不接高价 OPRA 扫单、不用伪造 ETF 每日净申赎；可选接入 FINRA ATS 延迟周报并显式标注 2–4 周监管滞后。

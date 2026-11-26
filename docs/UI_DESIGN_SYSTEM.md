# MarketElite UI/UX 视觉与动效设计规范（v1.0 · Three-Theme Liquid Glass & Aurora）

> 美学准则：**去仪表盘塑料感与刺眼霓虹边框，以三套自研 Liquid Glass 材质结合 Zero-Border Aurora 无边框极光角标，构建克制而高密度的机构级投研终端。**

---

## 1. 三主题自适应引擎（Three-Theme Liquid Glass Engine）

支持顶部导航右上角一键即时切换，贯穿整个工作台、图表刻度、Markdown 研报与弹窗：

1. **晨雾白玻璃（Light Glass · Day Daylight）**
   - 柔和画廊纸感与半透明磨砂层叠加，`backdrop-filter: blur(22px) saturate(160%)`，在明亮办公环境下保持极佳纸感与零眩光。
2. **暖砂纸（Warm Sand Paper · Editorial Focus）**
   - 偏暖低蓝光米棕纸张色阶（专为长时间读长篇 SEC 10-K 原文与研报设计），降疲护眼同时保留精确金融数字锐度。
3. **曜石黑（Obsidian Dark · Command Console）**
   - 深炭黑基底（`#0B0B0D` 渐变）配合微透黑曜石玻璃卡片与 1px 顶部漫反射高光边界，适合夜间盯盘与数据治理中台。

---

## 2. 核心设计语言规范

### 2.1 Zero-Border Aurora Deck（无边框极光角标卡）
- **应用区域**：
  - 「投研与风控台」双引擎切换卡（深度研报 Emerald Aurora / 红蓝对抗 Sky-Amber Aurora / 右栏 Risk Critic Amber / SEC 检索 Sky）
  - 「模拟盘与复盘」双翼工作台入口与「数据与评测中台」5 大子模块悬浮导航舱
- **交互规范**：剔除生硬粗实线边框，仅在激活态从左下/右上极角弥散极低不透明度极光渐变，伴随 `cubic-bezier(0.16, 1, 0.3, 1)` 微抬动效。

### 2.2 一致性数字对齐与语义色谱
- **字体栈**：标题及正文采用无衬线与局部衬线混排强化报告层次；全部价格、净值、Alpha 收益率、延迟 `ms` 强制使用等宽字体（`font-mono` + `tabular-nums`）与 `whitespace-nowrap`，保证高频刷新与中英混排零换行错位、零像素抖动。
- **美股标准涨跌色**：严格克制使用绿涨 `#10B981`、红跌 `#F43F5E` 与风控警示琥珀 `#F59E0B`，不喧宾夺主。

### 2.3 长文防拉长与流式体验约束
- 「深度研报」聊天列表限定于固定高度可滚动视窗内（分栏桌面端 `h-[540px]`~`xl:h-[600px]`，`overflow-y-auto overscroll-contain`）；多轮已归档历史问答默认折叠成可单击展开的手风琴卡片，消除多轮对话造成的整页无限拉伸感。
- 顶部浮岛导航集成 5 大一级工作台切页、全局标的搜索、主题切换、快捷键提示与 BYOK 设置入口。

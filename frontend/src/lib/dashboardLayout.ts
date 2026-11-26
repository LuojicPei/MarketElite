import type { Layout, LayoutItem, ResponsiveLayouts } from "react-grid-layout";

export type WidgetId =
  | "macro-regime"
  | "cot-positioning"
  | "benchmarks-search"
  | "candlestick-main"
  | "watchlist-panel"
  | "catalyst-radar"
  | "sentiment-breadth"
  | "gex-wall"
  | "sector-rotation"
  | "market-movers"
  | "discover-news"
  | "moc-auction-radar"
  | "darkpool-trf-tracker"
  | "onchain-liquidity-pulse";

export interface DashboardWidgetMeta {
  id: WidgetId;
  titleZh: string;
  layerTag: string;
  descriptionZh: string;
  minW: number;
  minH: number;
  defaultRect: Omit<LayoutItem, "i">;
}

export const DASHBOARD_WIDGET_CATALOG: DashboardWidgetMeta[] = [
  {
    id: "sentiment-breadth",
    titleZh: "恐慌情绪与市场广度",
    layerTag: "情绪广度",
    descriptionZh: "CNN 实时恐慌贪婪仪表盘（含盘前）、VIX 迷你K线温度卡、广度资金与共振结论",
    minW: 3,
    minH: 9,
    defaultRect: { x: 0, y: 0, w: 3, h: 10 },
  },
  {
    id: "macro-regime",
    titleZh: "宏观环境与资金总闸",
    layerTag: "宏观流动性",
    descriptionZh: "大环境诊断、2Y/10Y名义与实际利率、三水库水位拆解与净活水背离图",
    minW: 3,
    minH: 9,
    defaultRect: { x: 0, y: 10, w: 3, h: 10 },
  },
  {
    id: "benchmarks-search",
    titleZh: "四大核心基准行情 & 极速搜股",
    layerTag: "基准行情",
    descriptionZh: "SPY / QQQ / SOXX / BTC 彩色迷你K线卡、多周期收益/RSI/MACD状态与全市场搜股切图",
    minW: 4,
    minH: 5,
    defaultRect: { x: 3, y: 0, w: 6, h: 6 },
  },
  {
    id: "candlestick-main",
    titleZh: "K线主图与华尔街共识",
    layerTag: "量价主图",
    descriptionZh: "1D/5D分时与日线多周期、EMA/BOLL/VWAP叠加、技术诊断及华尔街评级/目标价/EPS Beat",
    minW: 4,
    minH: 9,
    defaultRect: { x: 3, y: 6, w: 6, h: 14 },
  },
  {
    id: "watchlist-panel",
    titleZh: "我的关注列表",
    layerTag: "自选股池",
    descriptionZh: "单击切主图、↗进个股页、支持自定义拖拽调序与多周期涨幅切换",
    minW: 2,
    minH: 7,
    defaultRect: { x: 9, y: 0, w: 3, h: 10 },
  },
  {
    id: "market-movers",
    titleZh: "今日领涨 / 重挫 / 异常爆量榜 Top 20",
    layerTag: "异动龙虎榜",
    descriptionZh: "全美股交易所盘中实时领涨、重挫与异常放量 Top 20 排行，支持<$2仙股过滤与点击切图",
    minW: 2,
    minH: 8,
    defaultRect: { x: 9, y: 10, w: 3, h: 10 },
  },
  {
    id: "sector-rotation",
    titleZh: "美股 11 板块实时热力矩阵",
    layerTag: "板块热力",
    descriptionZh: "市值权重面积热力图（1D/5D/20D/vsSPY），悬浮即现Top10权重龙头实时涨跌",
    minW: 5,
    minH: 10,
    defaultRect: { x: 0, y: 20, w: 7, h: 13 },
  },
  {
    id: "cot-positioning",
    titleZh: "华尔街聪明钱与杠杆透视",
    layerTag: "机构持仓",
    descriptionZh: "CFTC 资管真金 vs 对冲基金杠杆持仓拆解、52周极端拥挤警戒与26周多空剪刀差",
    minW: 4,
    minH: 10,
    defaultRect: { x: 7, y: 20, w: 5, h: 13 },
  },
  {
    id: "gex-wall",
    titleZh: "期权全景雷达与异动扫单",
    layerTag: "期权雷达",
    descriptionZh: "SPY/QQQ/IWM及联动个股期权链、Gamma墙、Max Pain最大痛点、预期波动箱体与Vol>OI爆量雷达",
    minW: 6,
    minH: 11,
    defaultRect: { x: 0, y: 33, w: 12, h: 14 },
  },
  {
    id: "discover-news",
    titleZh: "全球市场重要资讯精选",
    layerTag: "全球要闻",
    descriptionZh: "图文资讯精选、自动轮播、全中文直读标题及站内结构化中英阅读弹窗",
    minW: 4,
    minH: 8,
    defaultRect: { x: 0, y: 47, w: 12, h: 11 },
  },
  {
    id: "moc-auction-radar",
    titleZh: "尾盘竞价与调仓脉冲",
    layerTag: "尾盘 MOC",
    descriptionZh: "15:45–16:00 ET 尾盘放量占比测算（Proxy）、冲量方向与月末/季末/四巫日再平衡倒计时",
    minW: 4,
    minH: 10,
    defaultRect: { x: 0, y: 58, w: 6, h: 13 },
  },
  {
    id: "darkpool-trf-tracker",
    titleZh: "暗池与场外机构成交",
    layerTag: "FINRA暗池",
    descriptionZh: "FINRA 每日场外 TRF 暗池占比、20日做空成交偏离度、周度 ATS 单笔均额（支持跟随主图与独立搜股）",
    minW: 4,
    minH: 10,
    defaultRect: { x: 6, y: 58, w: 6, h: 13 },
  },
  {
    id: "onchain-liquidity-pulse",
    titleZh: "链上活水与加密聪明钱",
    layerTag: "链上脉搏",
    descriptionZh: "稳定币买盘弹药、BTC 交易所充提净流、MVRV 泡沫水位与 Binance 永续合约杠杆温度全维对照",
    minW: 6,
    minH: 11,
    defaultRect: { x: 0, y: 71, w: 12, h: 13 },
  },
  {
    id: "catalyst-radar",
    titleZh: "宏观事件 & 自选财报雷达",
    layerTag: "事件催化",
    descriptionZh: "未来7-14天FOMC/CPI/PCE/四巫日倒计时，及自选与龙头公司财报高波预警（可选面板）",
    minW: 2,
    minH: 7,
    defaultRect: { x: 9, y: 84, w: 3, h: 10 },
  },
];

export const WIDGET_META_MAP: Record<WidgetId, DashboardWidgetMeta> =
  DASHBOARD_WIDGET_CATALOG.reduce(
    (acc, meta) => {
      acc[meta.id] = meta;
      return acc;
    },
    {} as Record<WidgetId, DashboardWidgetMeta>
  );

export type LayoutPresetId = "classic" | "daytrader" | "macro";

export interface DashboardLayoutState {
  version: 1;
  activePreset: LayoutPresetId | "custom";
  items: LayoutItem[];
  hiddenIds: WidgetId[];
}

const STORAGE_KEY = "marketelite_bento_layout_v11";

export const GRID_BREAKPOINTS = { lg: 1120, md: 760, sm: 0 } as const;
export const GRID_COLS = { lg: 12, md: 6, sm: 1 } as const;
export const GRID_ROW_HEIGHT = 26;
export const GRID_MARGIN: readonly [number, number] = [14, 14];

function buildItem(
  id: WidgetId,
  override?: Partial<Pick<LayoutItem, "x" | "y" | "w" | "h">>
): LayoutItem {
  const meta = WIDGET_META_MAP[id];
  const rect = { ...meta.defaultRect, ...override };
  const w = Math.min(12, Math.max(meta.minW, rect.w));
  const x = Math.min(Math.max(0, rect.x), 12 - w);
  const h = Math.max(meta.minH, rect.h);
  return {
    i: id,
    x,
    y: Math.max(0, rect.y),
    w,
    h,
    minW: meta.minW,
    minH: meta.minH,
  };
}

export function getPresetLayoutState(preset: LayoutPresetId): DashboardLayoutState {
  if (preset === "daytrader") {
    return {
      version: 1,
      activePreset: "daytrader",
      items: [
        buildItem("benchmarks-search", { x: 0, y: 0, w: 8, h: 6 }),
        buildItem("candlestick-main", { x: 0, y: 6, w: 8, h: 13 }),
        buildItem("watchlist-panel", { x: 8, y: 0, w: 4, h: 10 }),
        buildItem("market-movers", { x: 8, y: 10, w: 4, h: 9 }),
        buildItem("catalyst-radar", { x: 0, y: 19, w: 4, h: 13 }),
        buildItem("gex-wall", { x: 4, y: 19, w: 8, h: 13 }),
        buildItem("discover-news", { x: 0, y: 32, w: 12, h: 10 }),
        buildItem("moc-auction-radar", { x: 0, y: 42, w: 6, h: 13 }),
        buildItem("darkpool-trf-tracker", { x: 6, y: 42, w: 6, h: 13 }),
        buildItem("onchain-liquidity-pulse", { x: 0, y: 55, w: 12, h: 13 }),
        buildItem("sentiment-breadth", { x: 0, y: 68, w: 6, h: 9 }),
        buildItem("macro-regime", { x: 6, y: 68, w: 6, h: 10 }),
        buildItem("sector-rotation", { x: 0, y: 78, w: 7, h: 13 }),
        buildItem("cot-positioning", { x: 7, y: 78, w: 5, h: 13 }),
      ],
      hiddenIds: [
        "macro-regime",
        "cot-positioning",
        "sentiment-breadth",
        "sector-rotation",
        "catalyst-radar",
      ],
    };
  }

  if (preset === "macro") {
    return {
      version: 1,
      activePreset: "macro",
      items: [
        buildItem("sentiment-breadth", { x: 0, y: 0, w: 6, h: 10 }),
        buildItem("macro-regime", { x: 6, y: 0, w: 6, h: 10 }),
        buildItem("sector-rotation", { x: 0, y: 10, w: 7, h: 13 }),
        buildItem("cot-positioning", { x: 7, y: 10, w: 5, h: 13 }),
        buildItem("catalyst-radar", { x: 0, y: 23, w: 4, h: 11 }),
        buildItem("discover-news", { x: 4, y: 23, w: 8, h: 11 }),
        buildItem("moc-auction-radar", { x: 0, y: 34, w: 6, h: 13 }),
        buildItem("darkpool-trf-tracker", { x: 6, y: 34, w: 6, h: 13 }),
        buildItem("onchain-liquidity-pulse", { x: 0, y: 47, w: 12, h: 13 }),
        buildItem("benchmarks-search", { x: 0, y: 60, w: 8, h: 5 }),
        buildItem("candlestick-main", { x: 0, y: 65, w: 8, h: 12 }),
        buildItem("watchlist-panel", { x: 8, y: 60, w: 4, h: 17 }),
        buildItem("market-movers", { x: 0, y: 77, w: 4, h: 10 }),
        buildItem("gex-wall", { x: 4, y: 77, w: 8, h: 13 }),
      ],
      hiddenIds: ["gex-wall", "market-movers"],
    };
  }

  return {
    version: 1,
    activePreset: "classic",
    items: DASHBOARD_WIDGET_CATALOG.map((meta) => buildItem(meta.id)),
    hiddenIds: ["catalyst-radar"],
  };
}

export function normalizeLayoutState(raw: Partial<DashboardLayoutState> | null): DashboardLayoutState {
  const fallback = getPresetLayoutState("classic");
  if (!raw || !Array.isArray(raw.items)) return fallback;

  const byId = new Map<WidgetId, LayoutItem>();
  for (const item of raw.items) {
    if (!item || typeof item.i !== "string") continue;
    const id = item.i as WidgetId;
    if (!(id in WIDGET_META_MAP)) continue;
    byId.set(
      id,
      buildItem(id, {
        x: Number.isFinite(item.x) ? item.x : undefined,
        y: Number.isFinite(item.y) ? item.y : undefined,
        w: Number.isFinite(item.w) ? item.w : undefined,
        h: Number.isFinite(item.h) ? item.h : undefined,
      })
    );
  }

  // Ensure every catalog widget has a valid entry
  for (const meta of DASHBOARD_WIDGET_CATALOG) {
    if (!byId.has(meta.id)) {
      byId.set(meta.id, buildItem(meta.id));
    }
  }

  const validHidden = Array.isArray(raw.hiddenIds)
    ? raw.hiddenIds.filter((id): id is WidgetId => typeof id === "string" && id in WIDGET_META_MAP)
    : [];

  const preset =
    raw.activePreset === "classic" ||
    raw.activePreset === "daytrader" ||
    raw.activePreset === "macro" ||
    raw.activePreset === "custom"
      ? raw.activePreset
      : "custom";

  return {
    version: 1,
    activePreset: preset,
    items: Array.from(byId.values()),
    hiddenIds: Array.from(new Set(validHidden)),
  };
}

export function loadDashboardLayoutState(): DashboardLayoutState {
  const fallback = getPresetLayoutState("classic");
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    return normalizeLayoutState(JSON.parse(raw) as Partial<DashboardLayoutState>);
  } catch {
    return fallback;
  }
}

export function saveDashboardLayoutState(state: DashboardLayoutState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota errors safely
  }
}

export function clearDashboardLayoutStorage(): DashboardLayoutState {
  const classic = getPresetLayoutState("classic");
  saveDashboardLayoutState(classic);
  return classic;
}

export function buildResponsiveLayoutsFromState(
  state: DashboardLayoutState
): ResponsiveLayouts<"lg" | "md" | "sm"> {
  const hidden = new Set<string>(state.hiddenIds);
  const visibleLg = state.items
    .filter((it) => !hidden.has(it.i))
    .map((it) => {
      const meta = WIDGET_META_MAP[it.i as WidgetId];
      return {
        ...it,
        minW: meta?.minW ?? 2,
        minH: meta?.minH ?? 4,
      };
    });

  // Sort top-to-bottom, left-to-right for coherent tablet/mobile reflow order
  const ordered = [...visibleLg].sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));

  // Derive 6-column tablet layout
  let mdX = 0;
  let mdY = 0;
  let rowMaxH = 0;
  const mdLayout: LayoutItem[] = ordered.map((it) => {
    const w = Math.min(6, Math.max(2, Math.round(it.w / 2)));
    if (mdX + w > 6) {
      mdX = 0;
      mdY += rowMaxH;
      rowMaxH = 0;
    }
    const placed: LayoutItem = {
      ...it,
      x: mdX,
      y: mdY,
      w,
      minW: Math.min(6, it.minW ?? 2),
    };
    mdX += w;
    rowMaxH = Math.max(rowMaxH, it.h);
    return placed;
  });

  // Derive 1-column mobile stack preserving exact user visual priority
  let smY = 0;
  const smLayout: LayoutItem[] = ordered.map((it) => {
    const placed: LayoutItem = {
      ...it,
      x: 0,
      y: smY,
      w: 1,
      minW: 1,
    };
    smY += it.h;
    return placed;
  });

  return {
    lg: visibleLg as Layout,
    md: mdLayout as Layout,
    sm: smLayout as Layout,
  };
}

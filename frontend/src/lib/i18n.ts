export interface BilingualLabel {
  cn: string;
  en: string;
}

const REGIME_LABELS: Record<string, BilingualLabel> = {
  RISK_ON_EXPANSION: { cn: "风险偏好扩张", en: "Risk-On Expansion" },
  NEUTRAL_ROTATION: { cn: "中性轮动均衡", en: "Neutral Rotation" },
  HIGH_VOL_TRANSITION: { cn: "高波切换过渡", en: "High-Vol Transition" },
  LIQUIDITY_TIGHTENING: { cn: "流动性收紧偏弱", en: "Liquidity Tightening" },
  RISK_OFF_STRESS: { cn: "避险承压警戒", en: "Risk-Off Stress" },
};

export function formatRegimeLabel(code?: string | null): string {
  const key = (code || "").toUpperCase().trim();
  const entry = REGIME_LABELS[key];
  return entry ? `${entry.cn} · ${entry.en}` : key || "暂无数据 · Unknown";
}

export function formatCreditState(state?: string | null): string {
  const val = (state || "").trim();
  if (!val) return "暂无数据 · N/A";
  const lower = val.toLowerCase();
  if (lower.includes("acute") || lower.includes("stress")) return `信用承压预警 · ${val}`;
  if (lower.includes("widening") || lower.includes("elevated")) return `信用利差走阔 · ${val}`;
  if (lower.includes("compressed")) return `利差收窄风险偏好 · ${val}`;
  if (lower.includes("normal") || lower.includes("calm")) return `信用环境平稳 · ${val}`;
  return val;
}

export function formatVixState(state?: string | null): string {
  const key = (state || "").toUpperCase().trim();
  if (key === "CONTANGO") return "远期升水稳定 · Contango";
  if (key === "BACKWARDATION") return "现货倒挂预警 · Backwardation";
  if (key === "FLAT") return "期限结构平坦 · Flat";
  return state || "暂无 · N/A";
}

export function formatVolumePriceTag(tag?: string | null): string {
  const val = (tag || "").trim();
  if (!val) return "暂无量价标签";
  if (val.startsWith("Volume Expansion Up")) return "放量上涨 · 机构吸筹突破 (Accumulation)";
  if (val.startsWith("Low-Volume Drift Up")) return "缩量飘升 · 上攻动能存疑 (Thin Conviction)";
  if (val.startsWith("Volume Expansion Down")) return "放量下跌 · 派发承压警戒 (Distribution)";
  if (val.startsWith("Low-Volume Pullback")) return "缩量回踩 · 良性消化筹码 (Orderly Pullback)";
  if (val.startsWith("Unclassified")) return "成交量历史数据不足 · Unclassified";
  return val;
}

export function formatDriverText(raw: string): string {
  const text = (raw || "").trim();
  if (!text) return "";
  if (text.startsWith("VIX term backwardation")) {
    return text.replace("VIX term backwardation", "VIX 期限倒挂预警 (VIX > VIX3M)");
  }
  if (text.startsWith("VIX term contango")) {
    return text.replace("VIX term contango", "VIX 远期升水稳定 (Contango)");
  }
  if (text.startsWith("Elevated VIX spot")) {
    return text.replace("Elevated VIX spot", "恐慌指数 VIX 处于高位");
  }
  if (text.startsWith("Widening HY OAS")) {
    return text.replace("Widening HY OAS", "高收益债信用利差 HY OAS 走阔");
  }
  if (text.startsWith("Net Liquidity draining")) {
    return text.replace("Net Liquidity draining", "美联储净流动性近期净回笼");
  }
  if (text.startsWith("Net Liquidity expanding")) {
    return text.replace("Net Liquidity expanding", "美联储净流动性持续净投放");
  }
  if (text.startsWith("SPY below 50SMA")) {
    return text.replace("SPY below 50SMA", "标普 SPY 位于 50 日均线下方");
  }
  if (text.startsWith("Weak breadth")) {
    return text.replace("Weak breadth", "市场广度偏弱");
  }
  if (text.includes("Dealer Net GEX negative")) {
    return "做市商估算净 GEX 为负（波动放大区间） · Estimated Net GEX < 0";
  }
  if (text.includes("Balanced macro")) {
    return "宏观流动性、信用利差与波动率结构整体均衡 · Balanced Macro Structure";
  }
  return text;
}

export function formatQuadrantOutcome(quadrant?: string | null): { label: string; tone: "good" | "warn" | "bad" } {
  const key = (quadrant || "").toUpperCase().trim();
  if (key === "GOOD_PROCESS_GOOD_OUTCOME") {
    return { label: "高纪律盈利 · Good Process / Win", tone: "good" };
  }
  if (key === "GOOD_PROCESS_BAD_OUTCOME") {
    return { label: "合规止损 · Good Process / Stop-Out", tone: "good" };
  }
  if (key === "BAD_PROCESS_GOOD_OUTCOME") {
    return { label: "侥幸盈利 ⚠️ · Bad Process / Lucky", tone: "warn" };
  }
  return { label: "纪律偏离亏损 · Bad Process / Loss", tone: "bad" };
}

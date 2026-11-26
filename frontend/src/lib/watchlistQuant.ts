import type { WatchlistAssetItem } from "@/lib/api";

export type SimWindow = "1M" | "3M" | "6M" | "YTD" | "1Y";

export interface StockRiskStats {
  symbol: string;
  totalReturnPct: number;
  maxDrawdownPct: number;
  drawdownFromHighPct: number;
  annVolPct: number;
  returnVolRatio: number;
  winRatePct: number;
  peakIdx: number;
  troughIdx: number;
}

export interface PortfolioCurveStats {
  equity: number[];
  pctSeries: number[];
  totalReturnPct: number;
  maxDrawdownPct: number;
  annVolPct: number;
  returnVolRatio: number;
  winRatePct: number;
  finalUsd: number;
  peakIdx: number;
  troughIdx: number;
}

export function sliceWindowDates(allDates: string[], win: SimWindow): string[] {
  if (allDates.length === 0) return [];
  if (win === "1M") return allDates.slice(-22);
  if (win === "3M") return allDates.slice(-64);
  if (win === "6M") return allDates.slice(-127);
  if (win === "1Y") return allDates.slice(-253);
  const latestYear = allDates[allDates.length - 1].slice(0, 4);
  const idx = allDates.findIndex((d) => d.startsWith(latestYear));
  return idx <= 0 ? allDates : allDates.slice(Math.max(0, idx - 1));
}

/**
 * Compute Wilder-style RSI(14) up to `endIdxInclusive` on daily close points.
 * Used cleanly to project 5-day-ago historical momentum coordinates in the 4-Quadrant Radar.
 */
export function computeRsiAtOffset(
  closes: { d: string; c: number }[],
  barsBackFromEnd: number,
  period = 14
): number | null {
  const endIdx = closes.length - 1 - barsBackFromEnd;
  if (endIdx < period) return null;
  const startIdx = Math.max(1, endIdx - 45);
  let avgGain = 0;
  let avgLoss = 0;
  let count = 0;
  for (let i = startIdx; i <= Math.min(startIdx + period - 1, endIdx); i++) {
    const delta = closes[i].c - closes[i - 1].c;
    if (delta >= 0) avgGain += delta;
    else avgLoss += Math.abs(delta);
    count += 1;
  }
  if (count === 0) return null;
  avgGain /= count;
  avgLoss /= count;
  for (let i = startIdx + count; i <= endIdx; i++) {
    const delta = closes[i].c - closes[i - 1].c;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss <= 1e-9) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Compute single-stock trailing return and drawdown stats cleanly from daily_closes. */
export function computeSingleStockStats(
  item: WatchlistAssetItem,
  win: SimWindow
): StockRiskStats {
  const allDates = item.daily_closes.map((pt) => pt.d);
  const targetDates = sliceWindowDates(allDates, win);
  const sliced = item.daily_closes.slice(-Math.max(2, targetDates.length));

  if (sliced.length < 2) {
    return {
      symbol: item.symbol,
      totalReturnPct: item.change_ytd_pct ?? item.change_1m_pct ?? 0,
      maxDrawdownPct: 0,
      drawdownFromHighPct: 0,
      annVolPct: 0,
      returnVolRatio: 0,
      winRatePct: 0,
      peakIdx: 0,
      troughIdx: 0,
    };
  }

  let peakVal = sliced[0].c;
  let highOverall = sliced[0].c;
  let maxDd = 0;
  let bestPeakIdx = 0;
  let curPeakIdx = 0;
  let bestTroughIdx = 0;
  const rets: number[] = [];
  let upDays = 0;

  for (let i = 1; i < sliced.length; i++) {
    const prev = sliced[i - 1].c;
    const cur = sliced[i].c;
    if (cur > highOverall) highOverall = cur;
    if (cur > peakVal) {
      peakVal = cur;
      curPeakIdx = i;
    }
    const dd = peakVal > 0 ? ((cur / peakVal) - 1) * 100 : 0;
    if (dd < maxDd) {
      maxDd = dd;
      bestPeakIdx = curPeakIdx;
      bestTroughIdx = i;
    }
    if (prev > 0) {
      const r = (cur - prev) / prev;
      rets.push(r);
      if (r > 0) upDays += 1;
    }
  }

  const startP = sliced[0].c;
  const endP = sliced[sliced.length - 1].c;
  const totalReturnPct = startP > 0 ? ((endP / startP) - 1) * 100 : 0;
  const drawdownFromHighPct = highOverall > 0 ? ((endP / highOverall) - 1) * 100 : 0;

  const n = rets.length;
  const mean = n > 0 ? rets.reduce((a, b) => a + b, 0) / n : 0;
  const variance =
    n > 1 ? rets.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (n - 1) : 0;
  const annVolPct = Math.sqrt(Math.max(0, variance)) * Math.sqrt(252) * 100;
  const annRetPct =
    n > 0 && startP > 0 && endP > 0
      ? ((endP / startP) ** (252 / Math.max(1, n)) - 1) * 100
      : 0;

  return {
    symbol: item.symbol,
    totalReturnPct,
    maxDrawdownPct: maxDd,
    drawdownFromHighPct,
    annVolPct,
    returnVolRatio: annVolPct > 0.5 ? annRetPct / annVolPct : 0,
    winRatePct: n > 0 ? (upDays / n) * 100 : 0,
    peakIdx: bestPeakIdx,
    troughIdx: bestTroughIdx,
  };
}

/** Simulate daily-rebalanced weighted portfolio equity over aligned close series for custom capital. */
export function evaluatePortfolio(
  dates: string[],
  alignedCloses: Record<string, (number | null)[]>,
  weights: Record<string, number>,
  principalUsd = 10000
): PortfolioCurveStats {
  const syms = Object.keys(weights).filter((s) => weights[s] > 0 && alignedCloses[s]);
  if (dates.length < 2 || syms.length === 0) {
    return {
      equity: [principalUsd],
      pctSeries: [0],
      totalReturnPct: 0,
      maxDrawdownPct: 0,
      annVolPct: 0,
      returnVolRatio: 0,
      winRatePct: 0,
      finalUsd: principalUsd,
      peakIdx: 0,
      troughIdx: 0,
    };
  }

  const equity: number[] = [principalUsd];
  const dailyRets: number[] = [];
  let upDays = 0;

  for (let t = 1; t < dates.length; t++) {
    let portRet = 0;
    let activeWeight = 0;
    for (const s of syms) {
      const arr = alignedCloses[s];
      const prev = arr[t - 1];
      const cur = arr[t];
      if (prev !== null && cur !== null && prev > 0) {
        const w = weights[s];
        portRet += w * ((cur - prev) / prev);
        activeWeight += w;
      }
    }
    const normRet = activeWeight > 0 ? portRet / activeWeight : 0;
    dailyRets.push(normRet);
    if (normRet > 0) upDays += 1;
    equity.push(equity[equity.length - 1] * (1 + normRet));
  }

  let peak = equity[0];
  let curPeakIdx = 0;
  let bestPeakIdx = 0;
  let bestTroughIdx = 0;
  let maxDd = 0;
  for (let i = 0; i < equity.length; i++) {
    const eq = equity[i];
    if (eq > peak) {
      peak = eq;
      curPeakIdx = i;
    }
    const dd = peak > 0 ? ((eq / peak) - 1) * 100 : 0;
    if (dd < maxDd) {
      maxDd = dd;
      bestPeakIdx = curPeakIdx;
      bestTroughIdx = i;
    }
  }

  const n = dailyRets.length;
  const mean = n > 0 ? dailyRets.reduce((a, b) => a + b, 0) / n : 0;
  const variance =
    n > 1 ? dailyRets.reduce((a, r) => accSum(a, r - mean), 0) / (n - 1) : 0;
  const annVolPct = Math.sqrt(Math.max(0, variance)) * Math.sqrt(252) * 100;

  const finalUsd = equity[equity.length - 1];
  const ratio = principalUsd > 0 ? finalUsd / principalUsd : 1;
  const totalReturnPct = (ratio - 1) * 100;
  const annRetPct =
    n > 0 && ratio > 0 ? (ratio ** (252 / Math.max(1, n)) - 1) * 100 : 0;

  return {
    equity,
    pctSeries: equity.map((e) => (principalUsd > 0 ? ((e / principalUsd) - 1) * 100 : 0)),
    totalReturnPct,
    maxDrawdownPct: maxDd,
    annVolPct,
    returnVolRatio: annVolPct > 0.5 ? annRetPct / annVolPct : 0,
    winRatePct: n > 0 ? (upDays / n) * 100 : 0,
    finalUsd,
    peakIdx: bestPeakIdx,
    troughIdx: bestTroughIdx,
  };
}

function accSum(acc: number, diff: number): number {
  return acc + diff * diff;
}

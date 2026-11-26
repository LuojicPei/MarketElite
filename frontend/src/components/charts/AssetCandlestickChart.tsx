"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  IChartApi,
  LineStyle,
  Time,
  createChart,
} from "lightweight-charts";
import {
  DailyBarPoint,
  EstimatedGexSnapshot,
  IntradayBarPoint,
  fetchAssetIntraday,
} from "@/lib/api";

interface AssetCandlestickChartProps {
  symbol: string;
  bars: DailyBarPoint[];
  gex?: EstimatedGexSnapshot | null;
  height?: number;
  fillContainer?: boolean;
  theme?: "white" | "cream" | "light" | "dark";
}

type ChartRangeKey = "1D" | "5D" | "1M" | "3M" | "6M" | "YTD" | "1Y";
type SubPaneKey = "off" | "macd" | "rsi" | "kdj";

interface OhlcLike {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function calcRollingVwapSeries(
  bars: DailyBarPoint[],
  period = 20
): { time: Time; value: number }[] {
  const out: { time: Time; value: number }[] = [];
  if (bars.length === 0) return out;
  for (let i = 0; i < bars.length; i += 1) {
    const start = Math.max(0, i - period + 1);
    let pv = 0;
    let vSum = 0;
    for (let j = start; j <= i; j += 1) {
      const tp = (bars[j].high + bars[j].low + bars[j].close) / 3;
      const vol = Math.max(0, bars[j].volume || 0);
      pv += tp * vol;
      vSum += vol;
    }
    if (vSum > 0 && i >= period - 1) {
      out.push({
        time: bars[i].trade_date as Time,
        value: Number((pv / vSum).toFixed(4)),
      });
    }
  }
  return out;
}

function calcSuperTrendSeries(
  bars: DailyBarPoint[],
  period = 10,
  mult = 3.0
): { time: Time; value: number; color: string }[] {
  const out: { time: Time; value: number; color: string }[] = [];
  if (bars.length <= period + 1) return out;

  const trs: number[] = [bars[0].high - bars[0].low];
  for (let i = 1; i < bars.length; i += 1) {
    const hl = bars[i].high - bars[i].low;
    const hc = Math.abs(bars[i].high - bars[i - 1].close);
    const lc = Math.abs(bars[i].low - bars[i - 1].close);
    trs.push(Math.max(hl, hc, lc));
  }

  let atr = trs.slice(1, period + 1).reduce((s, v) => s + v, 0) / period;
  let finalUpper = 0;
  let finalLower = 0;
  let bull = true;

  for (let i = period; i < bars.length; i += 1) {
    if (i > period) {
      atr = (atr * (period - 1) + trs[i]) / period;
    }
    const hl2 = (bars[i].high + bars[i].low) / 2;
    const basicUpper = hl2 + mult * atr;
    const basicLower = hl2 - mult * atr;
    const prevClose = bars[i - 1].close;

    if (i === period) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      bull = bars[i].close >= hl2;
    } else {
      finalUpper =
        basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
      finalLower =
        basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;
      if (bull && bars[i].close < finalLower) {
        bull = false;
      } else if (!bull && bars[i].close > finalUpper) {
        bull = true;
      }
    }

    const stVal = bull ? finalLower : finalUpper;
    out.push({
      time: bars[i].trade_date as Time,
      value: Number(stVal.toFixed(4)),
      color: bull ? "#10b981" : "#f43f5e",
    });
  }
  return out;
}

function calcVpocPrice(bars: DailyBarPoint[], lookback = 90, bins = 28): number | null {
  const slice = bars.slice(-lookback);
  if (slice.length < 10) return null;
  let minP = Number.POSITIVE_INFINITY;
  let maxP = Number.NEGATIVE_INFINITY;
  for (const b of slice) {
    if (b.low < minP) minP = b.low;
    if (b.high > maxP) maxP = b.high;
  }
  const span = maxP - minP;
  if (!(span > 1e-6)) return null;
  const volBins = new Array<number>(bins).fill(0);
  for (const b of slice) {
    const tp = (b.high + b.low + b.close) / 3;
    const idx = Math.max(0, Math.min(bins - 1, Math.floor(((tp - minP) / span) * bins)));
    volBins[idx] += Math.max(0, b.volume || 0);
  }
  let bestIdx = 0;
  for (let i = 1; i < bins; i += 1) {
    if (volBins[i] > volBins[bestIdx]) bestIdx = i;
  }
  return Number((minP + ((bestIdx + 0.5) / bins) * span).toFixed(2));
}

function calcMacdSubSeries(bars: OhlcLike[]) {
  if (bars.length < 35) return { dif: [], dea: [], hist: [] };
  const af = 2 / 13;
  const as = 2 / 27;
  const asig = 2 / 10;
  let emaF = bars[0].close;
  let emaS = bars[0].close;
  const macdRaw: { time: Time; val: number }[] = [];
  for (const b of bars) {
    emaF = (b.close - emaF) * af + emaF;
    emaS = (b.close - emaS) * as + emaS;
    macdRaw.push({ time: b.time, val: emaF - emaS });
  }
  let dea = macdRaw.slice(0, 9).reduce((s, p) => s + p.val, 0) / 9;
  const dif: { time: Time; value: number }[] = [];
  const deaArr: { time: Time; value: number }[] = [];
  const hist: { time: Time; value: number; color: string }[] = [];
  for (let i = 8; i < macdRaw.length; i += 1) {
    if (i > 8) {
      dea = (macdRaw[i].val - dea) * asig + dea;
    }
    const dVal = macdRaw[i].val;
    const hVal = dVal - dea;
    dif.push({ time: macdRaw[i].time, value: Number(dVal.toFixed(4)) });
    deaArr.push({ time: macdRaw[i].time, value: Number(dea.toFixed(4)) });
    hist.push({
      time: macdRaw[i].time,
      value: Number(hVal.toFixed(4)),
      color: hVal >= 0 ? "rgba(16,185,129,0.75)" : "rgba(244,63,94,0.75)",
    });
  }
  return { dif, dea: deaArr, hist };
}

function calcRsiSubSeries(bars: OhlcLike[], period = 14): { time: Time; value: number }[] {
  const out: { time: Time; value: number }[] = [];
  if (bars.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = bars[i].close - bars[i - 1].close;
    if (diff >= 0) gain += diff;
    else loss += Math.abs(diff);
  }
  let avgG = gain / period;
  let avgL = loss / period;
  const toRsi = (g: number, l: number) => (l <= 1e-9 ? 100 : 100 - 100 / (1 + g / l));
  out.push({ time: bars[period].time, value: Number(toRsi(avgG, avgL).toFixed(2)) });
  for (let i = period + 1; i < bars.length; i += 1) {
    const diff = bars[i].close - bars[i - 1].close;
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? Math.abs(diff) : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out.push({ time: bars[i].time, value: Number(toRsi(avgG, avgL).toFixed(2)) });
  }
  return out;
}

function calcKdjSubSeries(bars: OhlcLike[], period = 9) {
  const kLine: { time: Time; value: number }[] = [];
  const dLine: { time: Time; value: number }[] = [];
  const jLine: { time: Time; value: number }[] = [];
  if (bars.length < period) return { kLine, dLine, jLine };
  let k = 50;
  let d = 50;
  for (let i = period - 1; i < bars.length; i += 1) {
    let hi = Number.NEGATIVE_INFINITY;
    let lo = Number.POSITIVE_INFINITY;
    for (let j = i - period + 1; j <= i; j += 1) {
      if (bars[j].high > hi) hi = bars[j].high;
      if (bars[j].low < lo) lo = bars[j].low;
    }
    const rsv = hi > lo ? ((bars[i].close - lo) / (hi - lo)) * 100 : 50;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    const jVal = 3 * k - 2 * d;
    kLine.push({ time: bars[i].time, value: Number(k.toFixed(2)) });
    dLine.push({ time: bars[i].time, value: Number(d.toFixed(2)) });
    jLine.push({ time: bars[i].time, value: Number(jVal.toFixed(2)) });
  }
  return { kLine, dLine, jLine };
}

function calcSmaSeries(
  bars: DailyBarPoint[],
  period: number
): { time: Time; value: number }[] {
  const out: { time: Time; value: number }[] = [];
  let rollingSum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    rollingSum += bars[i].close;
    if (i >= period) {
      rollingSum -= bars[i - period].close;
    }
    if (i >= period - 1) {
      out.push({
        time: bars[i].trade_date as Time,
        value: Number((rollingSum / period).toFixed(4)),
      });
    }
  }
  return out;
}

function calcEmaSeries(
  bars: DailyBarPoint[],
  span: number
): { time: Time; value: number }[] {
  if (bars.length < span) return [];
  const alpha = 2 / (span + 1);
  let ema =
    bars.slice(0, span).reduce((acc, b) => acc + b.close, 0) / span;
  const out: { time: Time; value: number }[] = [
    { time: bars[span - 1].trade_date as Time, value: Number(ema.toFixed(4)) },
  ];
  for (let i = span; i < bars.length; i += 1) {
    ema = (bars[i].close - ema) * alpha + ema;
    out.push({
      time: bars[i].trade_date as Time,
      value: Number(ema.toFixed(4)),
    });
  }
  return out;
}

function calcBollingerSeries(
  bars: DailyBarPoint[],
  period = 20,
  numStd = 2
): {
  upper: { time: Time; value: number }[];
  mid: { time: Time; value: number }[];
  lower: { time: Time; value: number }[];
} {
  const upper: { time: Time; value: number }[] = [];
  const mid: { time: Time; value: number }[] = [];
  const lower: { time: Time; value: number }[] = [];
  if (bars.length < period) return { upper, mid, lower };

  for (let i = period - 1; i < bars.length; i += 1) {
    const slice = bars.slice(i - period + 1, i + 1);
    const mean = slice.reduce((s, b) => s + b.close, 0) / period;
    const variance =
      slice.reduce((s, b) => s + (b.close - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    const t = bars[i].trade_date as Time;
    mid.push({ time: t, value: Number(mean.toFixed(4)) });
    upper.push({ time: t, value: Number((mean + numStd * std).toFixed(4)) });
    lower.push({ time: t, value: Number((mean - numStd * std).toFixed(4)) });
  }
  return { upper, mid, lower };
}

function formatNyUnixTime(tsSec: number, withDate: boolean): string {
  const d = new Date(tsSec * 1000);
  try {
    const opts: Intl.DateTimeFormatOptions = {
      timeZone: "America/New_York",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      ...(withDate ? { month: "2-digit", day: "2-digit" } : {}),
    };
    return new Intl.DateTimeFormat("en-US", opts).format(d);
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

function AssetCandlestickChart({
  symbol,
  bars,
  gex,
  height = 330,
  fillContainer = false,
  theme = "dark",
}: AssetCandlestickChartProps) {
  const isLight = theme !== "dark";
  const canvasBg =
    theme === "dark" ? "#0B0B0D" : theme === "cream" ? "#FCFBF7" : "#FFFFFF";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [rangeKey, setRangeKey] = useState<ChartRangeKey>("6M");
  const [showEma9, setShowEma9] = useState(false);
  const [showEma20, setShowEma20] = useState(true);
  const [showSma50, setShowSma50] = useState(true);
  const [showSma200, setShowSma200] = useState(false);
  const [showBoll, setShowBoll] = useState(false);
  const [showSuperTrend, setShowSuperTrend] = useState(false);
  const [showDailyVwap, setShowDailyVwap] = useState(false);
  const [showVpoc, setShowVpoc] = useState(false);
  const [showVwap, setShowVwap] = useState(true);
  const [showExtended, setShowExtended] = useState(true);
  const [showWalls, setShowWalls] = useState(true);
  const [subPane, setSubPane] = useState<SubPaneKey>("off");

  const [intradayBars, setIntradayBars] = useState<IntradayBarPoint[]>([]);
  const [intradayLoading, setIntradayLoading] = useState(false);
  const intradaySeqRef = useRef(0);

  const isIntraday = rangeKey === "1D" || rangeKey === "5D";

  useEffect(() => {
    if (!isIntraday) return;
    const reqId = ++intradaySeqRef.current;
    const tf = rangeKey === "1D" ? "1d" : "5d";
    setIntradayLoading(true);
    fetchAssetIntraday(symbol, tf, false)
      .then((res) => {
        if (reqId === intradaySeqRef.current) {
          setIntradayBars(res.bars ?? []);
        }
      })
      .catch(() => {
        if (reqId === intradaySeqRef.current) {
          setIntradayBars([]);
        }
      })
      .finally(() => {
        if (reqId === intradaySeqRef.current) {
          setIntradayLoading(false);
        }
      });
  }, [symbol, rangeKey, isIntraday]);

  const sortedBars = useMemo(() => {
    const seen = new Set<string>();
    const clean: DailyBarPoint[] = [];
    for (const b of bars) {
      if (!seen.has(b.trade_date)) {
        seen.add(b.trade_date);
        clean.push(b);
      }
    }
    clean.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
    return clean;
  }, [bars]);

  const cleanIntradayBars = useMemo(() => {
    const seen = new Set<number>();
    const out: IntradayBarPoint[] = [];
    for (const b of intradayBars) {
      if (!showExtended && b.session && b.session !== "regular") continue;
      if (!seen.has(b.time)) {
        seen.add(b.time);
        out.push(b);
      }
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }, [intradayBars, showExtended]);

  const hasExtendedBars = useMemo(
    () => intradayBars.some((b) => b.session === "pre" || b.session === "post"),
    [intradayBars]
  );

  const vpocPrice = useMemo(() => calcVpocPrice(sortedBars, 90, 28), [sortedBars]);

  const latestRefPrice = useMemo(() => {
    if (isIntraday && cleanIntradayBars.length > 0) {
      return cleanIntradayBars[cleanIntradayBars.length - 1].close;
    }
    if (sortedBars.length > 0) {
      return sortedBars[sortedBars.length - 1].close;
    }
    return null;
  }, [isIntraday, cleanIntradayBars, sortedBars]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (isIntraday && cleanIntradayBars.length === 0) return;
    if (!isIntraday && sortedBars.length === 0) return;

    const hasSubPane = subPane !== "off";
    const initialHeight = fillContainer
      ? Math.max(160, Math.floor(el.clientHeight || height))
      : height;

    const chart: IChartApi = createChart(el, {
      width: el.clientWidth,
      height: initialHeight,
      layout: {
        background: { type: ColorType.Solid, color: canvasBg },
        textColor: isLight ? "#52525B" : "#A1A1AA",
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 11,
      },
      localization: {
        locale: "en-US",
        timeFormatter: (time: Time) => {
          if (typeof time === "number") {
            return formatNyUnixTime(time, rangeKey === "5D");
          }
          return String(time);
        },
      },
      grid: {
        vertLines: { color: isLight ? "rgba(24,24,27,0.05)" : "rgba(255,255,255,0.04)" },
        horzLines: { color: isLight ? "rgba(24,24,27,0.06)" : "rgba(255,255,255,0.05)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: isLight ? "rgba(24,24,27,0.28)" : "rgba(255,255,255,0.22)",
          style: LineStyle.Dashed,
        },
        horzLine: {
          color: isLight ? "rgba(24,24,27,0.28)" : "rgba(255,255,255,0.22)",
          style: LineStyle.Dashed,
        },
      },
      rightPriceScale: {
        borderColor: isLight ? "#E4E4E7" : "#1C1C21",
        scaleMargins: hasSubPane ? { top: 0.05, bottom: 0.28 } : { top: 0.06, bottom: 0.16 },
      },
      timeScale: {
        borderColor: isLight ? "#E4E4E7" : "#1C1C21",
        timeVisible: isIntraday,
        secondsVisible: false,
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#10B981",
      downColor: "#F43F5E",
      borderVisible: false,
      wickUpColor: "#10B981",
      wickDownColor: "#F43F5E",
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({
      scaleMargins: hasSubPane ? { top: 0.61, bottom: 0.25 } : { top: 0.82, bottom: 0 },
    });

    if (isIntraday) {
      candleSeries.setData(
        cleanIntradayBars.map((b) => {
          const isExt = b.session === "pre" || b.session === "post";
          const isUp = b.close >= b.open;
          if (!isExt) {
            return {
              time: b.time as Time,
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
            };
          }
          const extColor = isUp
            ? isLight
              ? "rgba(16,185,129,0.52)"
              : "rgba(52,211,153,0.45)"
            : isLight
              ? "rgba(225,29,72,0.52)"
              : "rgba(251,113,133,0.45)";
          return {
            time: b.time as Time,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            color: extColor,
            wickColor: extColor,
            borderColor: extColor,
          };
        })
      );
      volumeSeries.setData(
        cleanIntradayBars.map((b) => {
          const isExt = b.session === "pre" || b.session === "post";
          const alpha = isExt ? "0.14" : "0.26";
          return {
            time: b.time as Time,
            value: b.volume,
            color:
              b.close >= b.open
                ? `rgba(16,185,129,${alpha})`
                : `rgba(244,63,94,${alpha})`,
          };
        })
      );
      if (showVwap) {
        const vwapLine = chart.addLineSeries({
          color: isLight ? "#7E22CE" : "#A855F7",
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          title: "VWAP",
        });
        vwapLine.setData(
          cleanIntradayBars.map((b) => ({
            time: b.time as Time,
            value: b.vwap,
          }))
        );
      }
      chart.timeScale().fitContent();
    } else {
      candleSeries.setData(
        sortedBars.map((b) => ({
          time: b.trade_date as Time,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
        }))
      );
      volumeSeries.setData(
        sortedBars.map((b) => ({
          time: b.trade_date as Time,
          value: b.volume,
          color: b.close >= b.open ? "rgba(16,185,129,0.22)" : "rgba(244,63,94,0.22)",
        }))
      );

      if (showBoll) {
        const boll = calcBollingerSeries(sortedBars, 20, 2);
        const bollUp = chart.addLineSeries({
          color: "rgba(56, 189, 248, 0.55)",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        const bollMid = chart.addLineSeries({
          color: "rgba(56, 189, 248, 0.45)",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        const bollLo = chart.addLineSeries({
          color: "rgba(56, 189, 248, 0.55)",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        bollUp.setData(boll.upper);
        bollMid.setData(boll.mid);
        bollLo.setData(boll.lower);
      }

      if (showEma9) {
        const ema9 = chart.addLineSeries({
          color: isLight ? "#0284C7" : "#38BDF8",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        ema9.setData(calcEmaSeries(sortedBars, 9));
      }
      if (showEma20) {
        const ema20 = chart.addLineSeries({
          color: isLight ? "#18181B" : "#FAFAFA",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        ema20.setData(calcEmaSeries(sortedBars, 20));
      }
      if (showSma50) {
        const sma50 = chart.addLineSeries({
          color: isLight ? "#71717A" : "#A1A1AA",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        sma50.setData(calcSmaSeries(sortedBars, 50));
      }
      if (showSma200) {
        const sma200 = chart.addLineSeries({
          color: "#D97706",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        sma200.setData(calcSmaSeries(sortedBars, 200));
      }
      if (showDailyVwap) {
        const dVwap = chart.addLineSeries({
          color: isLight ? "#7E22CE" : "#A855F7",
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        dVwap.setData(calcRollingVwapSeries(sortedBars, 20));
      }
      if (showSuperTrend) {
        const stSeries = chart.addLineSeries({
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        stSeries.setData(calcSuperTrendSeries(sortedBars, 10, 3.0));
      }
      if (showVpoc && vpocPrice != null) {
        candleSeries.createPriceLine({
          price: vpocPrice,
          color: isLight ? "#0284C7" : "#22D3EE",
          lineWidth: 2,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `VPOC $${vpocPrice}`,
        });
      }

      let barsWindow = sortedBars.length;
      if (rangeKey === "1M") barsWindow = 22;
      else if (rangeKey === "3M") barsWindow = 63;
      else if (rangeKey === "6M") barsWindow = 126;
      else if (rangeKey === "YTD") {
        const yr = sortedBars[sortedBars.length - 1]?.trade_date.slice(0, 4);
        const ytdIdx = sortedBars.findIndex((b) => b.trade_date.startsWith(`${yr}-`));
        barsWindow = ytdIdx >= 0 ? sortedBars.length - ytdIdx : sortedBars.length;
      }

      if (rangeKey === "1Y" || sortedBars.length <= barsWindow) {
        chart.timeScale().fitContent();
      } else {
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, sortedBars.length - barsWindow),
          to: sortedBars.length + 1,
        });
      }
    }

    if (hasSubPane) {
      const subBars: OhlcLike[] = isIntraday
        ? cleanIntradayBars.map((b) => ({
            time: b.time as Time,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
          }))
        : sortedBars.map((b) => ({
            time: b.trade_date as Time,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
          }));

      if (subPane === "macd") {
        const { dif, dea, hist } = calcMacdSubSeries(subBars);
        const histSeries = chart.addHistogramSeries({
          priceScaleId: "sub",
          priceLineVisible: false,
          lastValueVisible: false,
        });
        histSeries.setData(hist);
        histSeries.createPriceLine({
          price: 0,
          color: isLight ? "rgba(24,24,27,0.22)" : "rgba(255,255,255,0.2)",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: false,
        });
        const difLine = chart.addLineSeries({
          priceScaleId: "sub",
          color: isLight ? "#0284C7" : "#38BDF8",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        const deaLine = chart.addLineSeries({
          priceScaleId: "sub",
          color: "#F59E0B",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        difLine.setData(dif);
        deaLine.setData(dea);
      } else if (subPane === "rsi") {
        const rsiLine = chart.addLineSeries({
          priceScaleId: "sub",
          color: isLight ? "#7C3AED" : "#A78BFA",
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          title: "RSI",
        });
        rsiLine.setData(calcRsiSubSeries(subBars, 14));
        rsiLine.createPriceLine({
          price: 70,
          color: "rgba(244,63,94,0.65)",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "70",
        });
        rsiLine.createPriceLine({
          price: 30,
          color: "rgba(16,185,129,0.65)",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "30",
        });
      } else if (subPane === "kdj") {
        const { kLine, dLine, jLine } = calcKdjSubSeries(subBars, 9);
        const kSeries = chart.addLineSeries({
          priceScaleId: "sub",
          color: isLight ? "#0284C7" : "#38BDF8",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        const dSeries = chart.addLineSeries({
          priceScaleId: "sub",
          color: "#F59E0B",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        const jSeries = chart.addLineSeries({
          priceScaleId: "sub",
          color: isLight ? "#C026D3" : "#E879F9",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        kSeries.setData(kLine);
        dSeries.setData(dLine);
        jSeries.setData(jLine);
        kSeries.createPriceLine({
          price: 80,
          color: "rgba(244,63,94,0.5)",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
        });
        kSeries.createPriceLine({
          price: 20,
          color: "rgba(16,185,129,0.5)",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
        });
      }

      chart.priceScale("sub").applyOptions({
        scaleMargins: { top: 0.77, bottom: 0.02 },
        borderVisible: false,
      });
    }

    if (showWalls && gex) {
      if (gex.call_wall) {
        candleSeries.createPriceLine({
          price: gex.call_wall,
          color: isLight ? "#059669" : "#10B981",
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `▲ Call 阻力`,
        });
      }
      if (gex.put_wall) {
        candleSeries.createPriceLine({
          price: gex.put_wall,
          color: isLight ? "#E11D48" : "#F43F5E",
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `▼ Put 支撑`,
        });
      }
      if (gex.zero_gamma) {
        candleSeries.createPriceLine({
          price: gex.zero_gamma,
          color: "#D97706",
          lineWidth: 2,
          lineStyle: LineStyle.LargeDashed,
          axisLabelVisible: true,
          title: `⚡ ZG 界`,
        });
      }
    }

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const nextWidth = Math.floor(rect.width);
      const nextHeight = Math.floor(rect.height);
      if (nextWidth > 0) {
        if (fillContainer && nextHeight >= 140) {
          chart.applyOptions({ width: nextWidth, height: nextHeight });
        } else {
          chart.applyOptions({ width: nextWidth });
        }
      }
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [
    sortedBars,
    cleanIntradayBars,
    isIntraday,
    height,
    fillContainer,
    rangeKey,
    showEma9,
    showEma20,
    showSma50,
    showSma200,
    showBoll,
    showSuperTrend,
    showDailyVwap,
    showVpoc,
    vpocPrice,
    subPane,
    showVwap,
    showWalls,
    gex,
    isLight,
    canvasBg,
  ]);

  const timeframes: { key: ChartRangeKey; label: string }[] = [
    { key: "1D", label: "1D分时" },
    { key: "5D", label: "5D" },
    { key: "1M", label: "1M" },
    { key: "3M", label: "3M" },
    { key: "6M", label: "6M" },
    { key: "YTD", label: "YTD" },
    { key: "1Y", label: "全部" },
  ];

  return (
    <div className={fillContainer ? "flex h-full min-h-0 flex-col space-y-2" : "space-y-2"}>
      <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-zinc-600 dark:text-zinc-400">
            {symbol} ·{" "}
            {rangeKey === "1D"
              ? "5分钟分时 (美东)"
              : rangeKey === "5D"
                ? "15分钟近5日 (美东)"
                : "日线 OHLCV"}
          </span>
          <div className="inline-flex flex-wrap rounded-md border border-zinc-200 bg-zinc-100/90 p-0.5 dark:border-zinc-800 dark:bg-zinc-900/80">
            {timeframes.map((tf) => (
              <button
                key={tf.key}
                type="button"
                onClick={() => setRangeKey(tf.key)}
                className={`rounded px-1.5 py-0.5 text-[10px] transition ${
                  rangeKey === tf.key
                    ? "bg-zinc-950 font-semibold text-white dark:bg-zinc-100 dark:text-zinc-950"
                    : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100"
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {isIntraday ? (
            <>
              {hasExtendedBars && (
                <button
                  type="button"
                  onClick={() => setShowExtended((v) => !v)}
                  title="显示/隐藏 盘前(04:00-09:30 ET) 与 盘后(16:00-20:00 ET) 半透明 K 线"
                  className={`rounded-md border px-2 py-0.5 text-[10px] transition ${
                    showExtended
                      ? "border-amber-500/60 bg-amber-500/15 text-amber-800 dark:text-amber-200"
                      : "border-zinc-200 text-zinc-500 hover:text-zinc-950 dark:border-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200"
                  }`}
                >
                  含盘前盘后
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowVwap((v) => !v)}
                title="VWAP 成交量加权机构均价线"
                className={`rounded-md border px-2 py-0.5 text-[10px] transition ${
                  showVwap
                    ? "border-purple-500/50 bg-purple-500/15 text-purple-800 dark:border-purple-400/60 dark:bg-purple-500/20 dark:text-purple-200"
                    : "border-zinc-200 text-zinc-500 hover:text-zinc-950 dark:border-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200"
                }`}
              >
                VWAP 机构线
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setShowEma9((v) => !v)}
                className={`rounded-md border px-1.5 py-0.5 text-[10px] transition ${
                  showEma9
                    ? "border-sky-500/60 bg-sky-500/15 text-sky-800 dark:border-sky-400/60 dark:bg-sky-500/20 dark:text-sky-200"
                    : "border-zinc-200 text-zinc-500 hover:text-zinc-950 dark:border-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200"
                }`}
              >
                EMA9
              </button>
              <button
                type="button"
                onClick={() => setShowEma20((v) => !v)}
                className={`rounded-md border px-1.5 py-0.5 text-[10px] transition ${
                  showEma20
                    ? "border-zinc-950 bg-zinc-950 text-white dark:border-zinc-200 dark:bg-zinc-100 dark:text-zinc-950"
                    : "border-zinc-200 text-zinc-500 hover:text-zinc-950 dark:border-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200"
                }`}
              >
                EMA20
              </button>
              <button
                type="button"
                onClick={() => setShowSma50((v) => !v)}
                className={`rounded-md border px-1.5 py-0.5 text-[10px] transition ${
                  showSma50
                    ? "border-zinc-300 bg-zinc-200 text-zinc-900 dark:border-zinc-400 dark:bg-zinc-800 dark:text-zinc-100"
                    : "border-zinc-200 text-zinc-500 hover:text-zinc-950 dark:border-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200"
                }`}
              >
                SMA50
              </button>
              <button
                type="button"
                onClick={() => setShowSma200((v) => !v)}
                className={`rounded-md border px-1.5 py-0.5 text-[10px] transition ${
                  showSma200
                    ? "border-amber-600/50 bg-amber-500/15 text-amber-800 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-300"
                    : "border-zinc-200 text-zinc-500 hover:text-zinc-950 dark:border-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200"
                }`}
              >
                SMA200
              </button>
              <button
                type="button"
                onClick={() => setShowBoll((v) => !v)}
                title="布林带 BOLL(20, 2)：直观查看超涨上轨与超跌下轨"
                className={`rounded-md border px-1.5 py-0.5 text-[10px] transition ${
                  showBoll
                    ? "border-cyan-600/50 bg-cyan-500/15 text-cyan-800 dark:border-cyan-400/60 dark:bg-cyan-500/15 dark:text-cyan-200"
                    : "border-zinc-200 text-zinc-500 hover:text-zinc-950 dark:border-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200"
                }`}
              >
                BOLL
              </button>
              <button
                type="button"
                onClick={() => setShowSuperTrend((v) => !v)}
                title="SuperTrend (ATR10, 3x)：红绿顺势止损带，突破翻色警示趋势反转"
                className={`rounded-md border px-1.5 py-0.5 text-[10px] transition ${
                  showSuperTrend
                    ? "border-emerald-600/50 bg-emerald-500/15 text-emerald-800 dark:border-emerald-400/60 dark:bg-emerald-500/15 dark:text-emerald-200"
                    : "border-zinc-200 text-zinc-500 hover:text-zinc-950 dark:border-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200"
                }`}
              >
                SuperTrend
              </button>
              <button
                type="button"
                onClick={() => setShowDailyVwap((v) => !v)}
                title="20日滚动成交量加权均价线：观察机构近期平均持仓成本"
                className={`rounded-md border px-1.5 py-0.5 text-[10px] transition ${
                  showDailyVwap
                    ? "border-purple-600/50 bg-purple-500/15 text-purple-800 dark:border-purple-400/60 dark:bg-purple-500/15 dark:text-purple-200"
                    : "border-zinc-200 text-zinc-500 hover:text-zinc-950 dark:border-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200"
                }`}
              >
                20D VWAP
              </button>
              <button
                type="button"
                onClick={() => setShowVpoc((v) => !v)}
                title="近90日成交量密集成交核心峰位 (VPOC)"
                className={`rounded-md border px-1.5 py-0.5 text-[10px] transition ${
                  showVpoc
                    ? "border-sky-600/50 bg-sky-500/15 text-sky-800 dark:border-cyan-400/60 dark:bg-cyan-500/15 dark:text-cyan-200"
                    : "border-zinc-200 text-zinc-500 hover:text-zinc-950 dark:border-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200"
                }`}
              >
                筹码峰
              </button>
            </>
          )}

          {/* Oscillator Sub-Pane Toggle */}
          <div
            title="底部副图动量指标切换：观察 MACD 金叉死叉、RSI 超买超卖与 KDJ 拐点"
            className="inline-flex rounded-md border border-zinc-200 bg-zinc-100/90 p-0.5 dark:border-zinc-800 dark:bg-zinc-900/80"
          >
            {(
              [
                { id: "off", label: "副图关" },
                { id: "macd", label: "MACD" },
                { id: "rsi", label: "RSI" },
                { id: "kdj", label: "KDJ" },
              ] as const
            ).map((sp) => (
              <button
                key={sp.id}
                type="button"
                onClick={() => setSubPane(sp.id)}
                className={`rounded px-1.5 py-0.5 text-[9.5px] transition ${
                  subPane === sp.id
                    ? "bg-zinc-950 font-semibold text-white dark:bg-zinc-100 dark:text-zinc-950"
                    : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100"
                }`}
              >
                {sp.label}
              </button>
            ))}
          </div>

          {gex && (
            <button
              type="button"
              onClick={() => setShowWalls((v) => !v)}
              title="显示/隐藏 期权 Call 阻力墙 / Put 支撑墙 / Zero Gamma 分水岭标线"
              className={`rounded-md border px-1.5 py-0.5 text-[10px] transition ${
                showWalls
                  ? "border-emerald-600/45 bg-emerald-500/15 text-emerald-800 dark:border-emerald-500/45 dark:bg-emerald-500/15 dark:text-emerald-300"
                  : "border-zinc-200 text-zinc-500 hover:text-zinc-950 dark:border-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200"
              }`}
            >
              期权墙
            </button>
          )}
        </div>
      </div>

      {/* Distinct Color-Coded Legend Strip for Option Walls & VPOC */}
      {((showWalls && gex && (gex.call_wall || gex.put_wall || gex.zero_gamma)) || (!isIntraday && showVpoc && vpocPrice != null)) && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-200/80 bg-zinc-50/85 px-2.5 py-1 font-mono text-[10px] dark:border-zinc-800/80 dark:bg-zinc-900/60">
          {showWalls && gex?.call_wall && (
            <span
              title="上方看涨期权压制/目标阻力墙 (绿虚线)"
              className="inline-flex items-center gap-1 rounded bg-emerald-500/12 px-1.5 py-0.5 font-semibold text-emerald-800 dark:text-emerald-300"
            >
              <span className="inline-block h-0.5 w-3 border-t-2 border-dashed border-emerald-500" />
              ▲ Call 阻力 ${gex.call_wall.toFixed(0)}
              {latestRefPrice && latestRefPrice > 0 && (
                <span className="opacity-80">
                  ({gex.call_wall >= latestRefPrice ? "+" : ""}
                  {(((gex.call_wall - latestRefPrice) / latestRefPrice) * 100).toFixed(1)}%)
                </span>
              )}
            </span>
          )}
          {showWalls && gex?.zero_gamma && (
            <span
              title="Zero Gamma 波动分水岭 (黄点划线)：其上压波动、其下放大波动"
              className="inline-flex items-center gap-1 rounded bg-amber-500/14 px-1.5 py-0.5 font-semibold text-amber-900 dark:text-amber-300"
            >
              <span className="inline-block h-0.5 w-3 border-t-2 border-dashed border-amber-500" />
              ⚡ ZG 分水岭 ${gex.zero_gamma.toFixed(0)}
            </span>
          )}
          {showWalls && gex?.put_wall && (
            <span
              title="下方看跌期权买盘保护/支撑墙 (红虚线)"
              className="inline-flex items-center gap-1 rounded bg-rose-500/12 px-1.5 py-0.5 font-semibold text-rose-800 dark:text-rose-300"
            >
              <span className="inline-block h-0.5 w-3 border-t-2 border-dashed border-rose-500" />
              ▼ Put 支撑 ${gex.put_wall.toFixed(0)}
              {latestRefPrice && latestRefPrice > 0 && (
                <span className="opacity-80">
                  ({gex.put_wall >= latestRefPrice ? "+" : ""}
                  {(((gex.put_wall - latestRefPrice) / latestRefPrice) * 100).toFixed(1)}%)
                </span>
              )}
            </span>
          )}
          {!isIntraday && showVpoc && vpocPrice != null && (
            <span
              title="近90日成交最密集核心成本线 (蓝绿点线)"
              className="inline-flex items-center gap-1 rounded bg-sky-500/12 px-1.5 py-0.5 font-semibold text-sky-800 dark:text-cyan-300"
            >
              <span className="inline-block h-0.5 w-3 border-t-2 border-dotted border-cyan-500" />
              筹码峰 VPOC ${vpocPrice.toFixed(2)}
            </span>
          )}
        </div>
      )}

      <div className={fillContainer ? "relative min-h-[160px] w-full flex-1" : "relative w-full"}>
        <div
          ref={containerRef}
          style={fillContainer ? undefined : { height }}
          className={
            fillContainer
              ? "h-full min-h-[160px] w-full overflow-hidden rounded-xl"
              : "w-full overflow-hidden rounded-xl"
          }
        />
        {isIntraday && intradayLoading && cleanIntradayBars.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/85 font-mono text-xs text-zinc-700 dark:bg-zinc-950/75 dark:text-zinc-300">
            正在加载 {symbol} {rangeKey} 分时 K 线与 VWAP...
          </div>
        )}
      </div>
    </div>
  );
}

export default React.memo(AssetCandlestickChart);

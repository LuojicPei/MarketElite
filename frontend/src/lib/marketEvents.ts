import {
  addUtcCalendarDays,
  formatFriendlyChineseTime,
  getNyseDayInfo,
  getYearHolidayMap,
  getZonedParts,
  zonedWallTimeToUtcMs,
} from "@/lib/marketSchedule";

import type { UpcomingCalendarResponse } from "@/lib/api";

export type MacroEventCategory =
  | "fomc"
  | "macro"
  | "flows"
  | "index"
  | "regime"
  | "earnings";
export type MacroEventImpact = "high" | "medium" | "info";

export interface UsMarketEventItem {
  id: string;
  title: string;
  subtitleEn: string;
  category: MacroEventCategory;
  categoryLabelZh: string;
  impact: MacroEventImpact;
  timestampMs: number;
  beijingDateTimeZh: string;
  easternDateTimeLabel: string;
  countdownBadge: string;
  descriptionZh: string;
  previousSummary?: string;
  indicatorId?: string;
  sourceTag?: string;
}

const FOMC_OFFICIAL_DATES: { date: string; sep: boolean; strategyOnly?: boolean }[] = [
  // 2026 Federal Reserve Schedule (verified from federalreserve.gov / chicagofed.org)
  { date: "2026-01-28", sep: false },
  { date: "2026-03-18", sep: true },
  { date: "2026-04-29", sep: false },
  { date: "2026-06-17", sep: true },
  { date: "2026-07-29", sep: false },
  { date: "2026-09-16", sep: true },
  { date: "2026-10-28", sep: false },
  { date: "2026-12-09", sep: true },
  // 2027 Federal Reserve Schedule
  { date: "2027-01-27", sep: false },
  { date: "2027-03-17", sep: true },
  { date: "2027-04-28", sep: false },
  { date: "2027-06-09", sep: true },
  { date: "2027-07-28", sep: false },
  { date: "2027-09-15", sep: true },
  { date: "2027-10-27", sep: false, strategyOnly: true },
  { date: "2027-11-17", sep: true },
];

const CPI_OFFICIAL_DATES_BY_YEAR: Record<number, string[]> = {
  // Verified from BLS release schedule (08:30 ET)
  2026: [
    "2026-01-13",
    "2026-02-13",
    "2026-03-11",
    "2026-04-10",
    "2026-05-12",
    "2026-06-10",
    "2026-07-14",
    "2026-08-12",
    "2026-09-11",
    "2026-10-14",
    "2026-11-10",
    "2026-12-10",
  ],
  2027: [
    "2027-01-13",
    "2027-02-11",
    "2027-03-10",
    "2027-04-13",
    "2027-05-12",
    "2027-06-10",
    "2027-07-14",
    "2027-08-11",
    "2027-09-14",
    "2027-10-14",
    "2027-11-10",
    "2027-12-10",
  ],
};

const PCE_CONFIRMED_DATES: string[] = [
  // Verified from BEA Personal Income and Outlays schedule (08:30 ET)
  "2026-08-26",
  "2026-09-30",
  "2026-10-29",
  "2026-11-25",
  "2026-12-23",
  "2027-02-25",
  "2027-03-31",
  "2027-04-29",
  "2027-05-27",
  "2027-06-25",
  "2027-07-29",
  "2027-08-25",
  "2027-10-28",
  "2027-11-24",
];

const RUSSELL_CONFIRMED_RECON: { date: string; label: string }[] = [
  { date: "2026-06-26", label: "罗素指数年度全量重构 (Russell Reconstitution)" },
  { date: "2026-12-11", label: "罗素指数半年度成分调整" },
];

const PPI_CONFIRMED_DATES: string[] = [
  // Verified from BLS Producer Price Index release schedule (08:30 ET)
  "2026-11-13",
  "2026-12-15",
  "2027-01-14",
  "2027-02-12",
  "2027-03-12",
  "2027-04-14",
  "2027-05-13",
  "2027-06-11",
  "2027-07-15",
  "2027-08-10",
  "2027-09-10",
  "2027-10-15",
  "2027-11-12",
  "2027-12-15",
];

const RETAIL_SALES_CONFIRMED_DATES: string[] = [
  // Verified from U.S. Census Bureau Advance Retail Sales schedule (08:30 ET)
  "2026-11-17",
  "2026-12-16",
  "2027-01-15",
  "2027-02-17",
  "2027-03-16",
  "2027-04-16",
  "2027-05-14",
  "2027-06-16",
  "2027-07-16",
  "2027-08-16",
  "2027-09-16",
  "2027-10-15",
  "2027-11-16",
  "2027-12-15",
];

const GDP_CONFIRMED_RELEASES: { date: string; label: string }[] = [
  // Verified from BEA GDP Release Schedule (08:30 ET)
  { date: "2026-11-25", label: "美国 Q3 GDP 修正值 (Second Estimate)" },
  { date: "2026-12-23", label: "美国 Q3 GDP 终值 (Third Estimate)" },
  { date: "2027-03-31", label: "美国 Q4 GDP 终值 & 企业利润" },
  { date: "2027-04-29", label: "美国 Q1 GDP 初值 (Advance)" },
  { date: "2027-07-29", label: "美国 Q2 GDP 初值 (Advance)" },
  { date: "2027-10-28", label: "美国 Q3 GDP 初值 (Advance)" },
];

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function parseYmd(dateStr: string): { year: number; month: number; day: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  return { year: y, month: m, day: d };
}

function isTradingDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const wd = d.getUTCDay();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${year}-${pad2(month)}-${pad2(day)}`;
  return getNyseDayInfo(year, month, day, wd, dateStr).isTradingDay;
}

function getMonthTradingDays(year: number, month: number): number[] {
  const daysInMonth = new Date(Date.UTC(year, month, 0, 12, 0, 0)).getUTCDate();
  const out: number[] = [];
  for (let d = 1; d <= daysInMonth; d += 1) {
    if (isTradingDate(year, month, d)) {
      out.push(d);
    }
  }
  return out;
}

function nthWeekdayDay(year: number, month: number, targetWd: number, nth: number): number {
  const firstWd = new Date(Date.UTC(year, month - 1, 1, 12, 0, 0)).getUTCDay();
  return 1 + ((targetWd - firstWd + 7) % 7) + (nth - 1) * 7;
}

function lastWeekdayDay(year: number, month: number, targetWd: number): number {
  const lastDate = new Date(Date.UTC(year, month, 0, 12, 0, 0));
  const back = (lastDate.getUTCDay() - targetWd + 7) % 7;
  return lastDate.getUTCDate() - back;
}

function adjustToPriorTradingDay(
  year: number,
  month: number,
  day: number
): { year: number; month: number; day: number } {
  let cursor = { year, month, day };
  for (let i = 0; i < 5; i += 1) {
    if (isTradingDate(cursor.year, cursor.month, cursor.day)) {
      return cursor;
    }
    const prev = addUtcCalendarDays(cursor.year, cursor.month, cursor.day, -1);
    cursor = { year: prev.year, month: prev.month, day: prev.day };
  }
  return cursor;
}

function adjustToNextOrSameTradingDay(
  year: number,
  month: number,
  day: number
): { year: number; month: number; day: number } {
  let cursor = { year, month, day };
  for (let i = 0; i < 6; i += 1) {
    if (isTradingDate(cursor.year, cursor.month, cursor.day)) {
      return cursor;
    }
    const next = addUtcCalendarDays(cursor.year, cursor.month, cursor.day, 1);
    cursor = { year: next.year, month: next.month, day: next.day };
  }
  return cursor;
}

function formatEventTimesAndCountdown(
  timestampMs: number,
  nowMs: number
): {
  beijingDateTimeZh: string;
  easternDateTimeLabel: string;
  countdownBadge: string;
} {
  const bjNow = getZonedParts(nowMs, "Asia/Shanghai");
  const bjEv = getZonedParts(timestampMs, "Asia/Shanghai");
  const etEv = getZonedParts(timestampMs, "America/New_York");

  const pad2 = (n: number) => String(n).padStart(2, "0");
  const beijingFriendly = formatFriendlyChineseTime(bjEv);
  const beijingDateTimeZh = `${bjEv.month}/${bjEv.day} ${WEEKDAY_CN[bjEv.weekday]} ${beijingFriendly}`;
  const easternDateTimeLabel = `${etEv.month}/${etEv.day} ${pad2(etEv.hour)}:${pad2(
    etEv.minute
  )} ${etEv.tzAbbrev.includes("EDT") ? "EDT" : "EST"}`;

  // Compute calendar day difference in Beijing Time for natural "今天 / 明天 / 后天 / X天后"
  const nowDayEpoch = Date.UTC(bjNow.year, bjNow.month - 1, bjNow.day);
  const evDayEpoch = Date.UTC(bjEv.year, bjEv.month - 1, bjEv.day);
  const dayDiff = Math.round((evDayEpoch - nowDayEpoch) / 86_400_000);
  const diffHours = Math.max(0, Math.floor((timestampMs - nowMs) / 3_600_000));

  let countdownBadge: string;
  if (timestampMs <= nowMs) {
    countdownBadge = "正在进行";
  } else if (diffHours < 1) {
    const diffMins = Math.max(1, Math.ceil((timestampMs - nowMs) / 60_000));
    countdownBadge = `${diffMins}分钟后`;
  } else if (dayDiff === 0) {
    countdownBadge = `今天 ${diffHours}小时后`;
  } else if (dayDiff === 1) {
    countdownBadge = "明天";
  } else if (dayDiff === 2) {
    countdownBadge = "后天";
  } else {
    countdownBadge = `${dayDiff}天后`;
  }

  return { beijingDateTimeZh, easternDateTimeLabel, countdownBadge };
}

export function getUpcomingUsMarketEvents(
  nowMs: number = Date.now(),
  horizonDays: number = 95
): UsMarketEventItem[] {
  const maxMs = nowMs + horizonDays * 86_400_000;
  const nowEt = getZonedParts(nowMs, "America/New_York");
  const maxEt = getZonedParts(maxMs, "America/New_York");
  const years = Array.from(
    { length: maxEt.year - nowEt.year + 1 },
    (_, idx) => nowEt.year + idx
  );

  const rawEvents: Omit<
    UsMarketEventItem,
    "beijingDateTimeZh" | "easternDateTimeLabel" | "countdownBadge"
  >[] = [];

  const pushEtEvent = (
    item: Omit<
      UsMarketEventItem,
      "timestampMs" | "beijingDateTimeZh" | "easternDateTimeLabel" | "countdownBadge"
    > & { year: number; month: number; day: number; hour: number; minute: number }
  ) => {
    const timestampMs = zonedWallTimeToUtcMs(
      item.year,
      item.month,
      item.day,
      item.hour,
      item.minute,
      "America/New_York"
    );
    // Keep events that occurred within the last 3 hours or upcoming within horizonDays
    if (timestampMs >= nowMs - 3 * 3600_000 && timestampMs <= maxMs) {
      rawEvents.push({
        id: item.id,
        title: item.title,
        subtitleEn: item.subtitleEn,
        category: item.category,
        categoryLabelZh: item.categoryLabelZh,
        impact: item.impact,
        timestampMs,
        descriptionZh: item.descriptionZh,
      });
    }
  };

  // 1. Official FOMC Rate Decisions & +3w FOMC Minutes
  for (const f of FOMC_OFFICIAL_DATES) {
    const { year, month, day } = parseYmd(f.date);
    if (f.strategyOnly) {
      pushEtEvent({
        id: `fomc-strategy-${f.date}`,
        year,
        month,
        day,
        hour: 14,
        minute: 0,
        title: "FOMC 货币政策战略会议",
        subtitleEn: "FOMC Policy Strategy Review",
        category: "fomc",
        categoryLabelZh: "美联储 FOMC",
        impact: "medium",
        descriptionZh: "本次为美联储五年期货币政策框架与战略专项讨论会议。",
      });
    } else {
      pushEtEvent({
        id: `fomc-${f.date}`,
        year,
        month,
        day,
        hour: 14,
        minute: 0,
        title: f.sep ? "美联储 FOMC 利率决议 + 点阵图" : "美联储 FOMC 利率决议",
        subtitleEn: f.sep ? "FOMC Rate Decision & SEP" : "FOMC Rate Decision",
        category: "fomc",
        categoryLabelZh: "美联储 FOMC",
        impact: "high",
        descriptionZh: f.sep
          ? "14:00 ET 公布利率并更新经济预测/点阵图，14:30 鲍威尔记者会，全市场定价中枢。"
          : "14:00 ET 公布利率决议，14:30 鲍威尔记者会，直接牵动降息预期与美债收益率。",
      });
      const minDay = addUtcCalendarDays(year, month, day, 21);
      pushEtEvent({
        id: `fomc-minutes-${minDay.dateStr}`,
        year: minDay.year,
        month: minDay.month,
        day: minDay.day,
        hour: 14,
        minute: 0,
        title: "美联储 FOMC 会议纪要",
        subtitleEn: "FOMC Meeting Minutes",
        category: "fomc",
        categoryLabelZh: "美联储 FOMC",
        impact: "medium",
        descriptionZh: "披露上次议息会议内部的鹰派/鸽派票委分歧与缩表细节。",
      });
    }
  }

  // 2. Official CPI Releases
  for (const yr of years) {
    const cpiDates = CPI_OFFICIAL_DATES_BY_YEAR[yr] ?? [];
    for (const dStr of cpiDates) {
      const { year, month, day } = parseYmd(dStr);
      pushEtEvent({
        id: `cpi-${dStr}`,
        year,
        month,
        day,
        hour: 8,
        minute: 30,
        title: "美国 CPI 通胀数据公布",
        subtitleEn: "US Consumer Price Index",
        category: "macro",
        categoryLabelZh: "核心宏观数据",
        impact: "high",
        descriptionZh: "美东 08:30 盘前发布核心与整体 CPI，决定纳指与成长股盘前跳空方向。",
      });
    }
  }

  // 3. Verified BEA Core PCE Releases
  for (const dStr of PCE_CONFIRMED_DATES) {
    const { year, month, day } = parseYmd(dStr);
    pushEtEvent({
      id: `pce-${dStr}`,
      year,
      month,
      day,
      hour: 8,
      minute: 30,
      title: "美国核心 PCE 物价指数",
      subtitleEn: "Core PCE Price Index",
      category: "macro",
      categoryLabelZh: "核心宏观数据",
      impact: "high",
      descriptionZh: "美联储最看重的官方通胀锚，往往引发盘前长端美债与科技股剧烈 repricing。",
    });
  }

  // 3b. Verified BLS Producer Price Index (PPI)
  for (const dStr of PPI_CONFIRMED_DATES) {
    const { year, month, day } = parseYmd(dStr);
    pushEtEvent({
      id: `ppi-${dStr}`,
      year,
      month,
      day,
      hour: 8,
      minute: 30,
      title: "美国 PPI 生产者物价指数公布",
      subtitleEn: "US Producer Price Index",
      category: "macro",
      categoryLabelZh: "核心宏观数据",
      impact: "medium",
      descriptionZh: "衡量上游生产端通胀传导，若超预期往往引发市场对后续核心 PCE 的重新定价。",
    });
  }

  // 3c. Verified US Retail Sales ("恐怖数据")
  for (const dStr of RETAIL_SALES_CONFIRMED_DATES) {
    const { year, month, day } = parseYmd(dStr);
    pushEtEvent({
      id: `retail-${dStr}`,
      year,
      month,
      day,
      hour: 8,
      minute: 30,
      title: "美国零售销售月率（“恐怖数据”）",
      subtitleEn: "US Advance Retail Sales",
      category: "macro",
      categoryLabelZh: "核心宏观数据",
      impact: "high",
      descriptionZh: "反映美国居民消费韧性与衰退/过热风险，美盘盘前极易触发股债剧烈波动。",
    });
  }

  // 3d. Verified BEA GDP Estimates
  for (const gdp of GDP_CONFIRMED_RELEASES) {
    const { year, month, day } = parseYmd(gdp.date);
    pushEtEvent({
      id: `gdp-${gdp.date}`,
      year,
      month,
      day,
      hour: 8,
      minute: 30,
      title: gdp.label,
      subtitleEn: "US BEA GDP Estimate",
      category: "macro",
      categoryLabelZh: "核心宏观数据",
      impact: "medium",
      descriptionZh: "美国经济增速与平减指数权威校准，直接影响软着陆/滞胀定价叙事。",
    });
  }

  // 4. Verified Russell Semi-Annual Reconstitutions (+ algorithmic fallback for 2027+)
  const russellYearsCovered = new Set<number>();
  for (const r of RUSSELL_CONFIRMED_RECON) {
    const { year, month, day } = parseYmd(r.date);
    russellYearsCovered.add(year);
    pushEtEvent({
      id: `russell-${r.date}`,
      year,
      month,
      day,
      hour: 16,
      minute: 0,
      title: r.label,
      subtitleEn: "FTSE Russell Index Rebalance",
      category: "index",
      categoryLabelZh: "指数调仓",
      impact: "high",
      descriptionZh: "尾盘集合竞价期间万亿级被动指数基金强制换仓，中小盘成交量常创年内新高。",
    });
  }
  for (const yr of years) {
    if (russellYearsCovered.has(yr)) continue;
    const juneLastFri = adjustToPriorTradingDay(yr, 6, lastWeekdayDay(yr, 6, 5));
    pushEtEvent({
      id: `russell-jun-${yr}`,
      year: juneLastFri.year,
      month: juneLastFri.month,
      day: juneLastFri.day,
      hour: 16,
      minute: 0,
      title: "罗素指数年度全量重构 (Russell Reconstitution)",
      subtitleEn: "FTSE Russell Annual Reconstitution",
      category: "index",
      categoryLabelZh: "指数调仓",
      impact: "high",
      descriptionZh: "每年 6 月末尾盘被动资金强制换仓，全美成交量全年最高峰之一。",
    });
    const decSecondFri = adjustToPriorTradingDay(yr, 12, nthWeekdayDay(yr, 12, 5, 2));
    pushEtEvent({
      id: `russell-dec-${yr}`,
      year: decSecondFri.year,
      month: decSecondFri.month,
      day: decSecondFri.day,
      hour: 16,
      minute: 0,
      title: "罗素指数半年度成分调整",
      subtitleEn: "FTSE Russell Semi-Annual Update",
      category: "index",
      categoryLabelZh: "指数调仓",
      impact: "medium",
      descriptionZh: "罗素指数半年度成分股纳入与剔除在收盘竞价正式生效。",
    });
  }

  // 5. Algorithmic Monthly & Year-Round Calendar Rules (works for any year)
  for (const yr of years) {
    for (let month = 1; month <= 12; month += 1) {
      const tradingDays = getMonthTradingDays(yr, month);
      if (tradingDays.length === 0) continue;

      // 5a. Nonfarm Payrolls (NFP): 1st Friday of month (push to 2nd if 1st Fri is holiday)
      const firstFri = nthWeekdayDay(yr, month, 5, 1);
      const nfpDay = isTradingDate(yr, month, firstFri)
        ? firstFri
        : nthWeekdayDay(yr, month, 5, 2);
      pushEtEvent({
        id: `nfp-${yr}-${month}`,
        year: yr,
        month,
        day: nfpDay,
        hour: 8,
        minute: 30,
        title: "美国非农就业与失业率报告 (NFP)",
        subtitleEn: "Nonfarm Payrolls",
        category: "macro",
        categoryLabelZh: "核心宏观数据",
        impact: "high",
        descriptionZh: "衡量美国劳动力市场冷暖与衰退风险的头号月度就业数据。",
      });

      // 5a-bis. ISM Manufacturing (1st trading day 10:00 ET) & Services PMI (3rd trading day 10:00 ET)
      pushEtEvent({
        id: `ism-mfg-${yr}-${month}`,
        year: yr,
        month,
        day: tradingDays[0],
        hour: 10,
        minute: 0,
        title: "美国 ISM 制造业 PMI",
        subtitleEn: "ISM Manufacturing PMI",
        category: "macro",
        categoryLabelZh: "核心宏观数据",
        impact: "medium",
        descriptionZh: "每月首个交易日盘中公布，50 荣枯线与新订单分项常引发工业/周期股即时反应。",
      });
      if (tradingDays.length >= 3) {
        pushEtEvent({
          id: `ism-svc-${yr}-${month}`,
          year: yr,
          month,
          day: tradingDays[2],
          hour: 10,
          minute: 0,
          title: "美国 ISM 非制造业（服务业）PMI",
          subtitleEn: "ISM Services PMI",
          category: "macro",
          categoryLabelZh: "核心宏观数据",
          impact: "medium",
          descriptionZh: "美国经济占比较高的服务业景气与物价分项指标，盘中 10:00 ET 公布。",
        });
      }

      // 5b. 3rd Friday: Quadruple Witching (Mar/Jun/Sep/Dec) vs Monthly OpEx
      const thirdFri = nthWeekdayDay(yr, month, 5, 3);
      const adjThirdFri = adjustToPriorTradingDay(yr, month, thirdFri);
      const isQuarterMonth = month === 3 || month === 6 || month === 9 || month === 12;
      if (isQuarterMonth) {
        pushEtEvent({
          id: `quad-witch-${yr}-${month}`,
          year: adjThirdFri.year,
          month: adjThirdFri.month,
          day: adjThirdFri.day,
          hour: 16,
          minute: 0,
          title: "美股「四巫日」+ 标普/纳指100 季度调仓",
          subtitleEn: "Quadruple Witching & S&P Rebalance",
          category: "flows",
          categoryLabelZh: "期权与资金暗流",
          impact: "high",
          descriptionZh:
            "股指期货、股指期权、个股期货与个股期权同日交割，叠加标普500/纳指100权重生效，开尾盘爆量极高波动。",
        });
      } else {
        pushEtEvent({
          id: `opex-${yr}-${month}`,
          year: adjThirdFri.year,
          month: adjThirdFri.month,
          day: adjThirdFri.day,
          hour: 16,
          minute: 0,
          title: "美股月度期权到期日 (OpEx)",
          subtitleEn: "Monthly Options Expiration",
          category: "flows",
          categoryLabelZh: "期权与资金暗流",
          impact: "medium",
          descriptionZh:
            "做市商 Gamma 对冲集中解绑，常在 Call/Put Wall 关键行权价附近出现磁吸或突破波动。",
        });
      }

      // 5c. Quarter-End Pension 60/40 Rebalancing Window (starts 3 trading days before quarter close)
      if (isQuarterMonth && tradingDays.length >= 3) {
        const pensionStartDay = tradingDays[tradingDays.length - 3];
        const quarterFinalDay = tradingDays[tradingDays.length - 1];
        pushEtEvent({
          id: `pension-rebal-${yr}-${month}`,
          year: yr,
          month,
          day: pensionStartDay,
          hour: 15,
          minute: 0,
          title: "季末养老金 60/40 再平衡窗口开启",
          subtitleEn: `Pension Quarter-End Flow (to ${month}/${quarterFinalDay})`,
          category: "flows",
          categoryLabelZh: "机构调仓暗流",
          impact: "high",
          descriptionZh:
            "季末最后 3 个交易日，大型养老金与主权基金强制执行「卖涨买跌」拉回股债配比，尾盘易出现逆势脉冲。",
        });
      } else if (!isQuarterMonth) {
        // Month-end institutional closing auction flow
        const lastTd = tradingDays[tradingDays.length - 1];
        pushEtEvent({
          id: `month-end-${yr}-${month}`,
          year: yr,
          month,
          day: lastTd,
          hour: 15,
          minute: 50,
          title: "月末机构尾盘再平衡竞价",
          subtitleEn: "Month-End Rebalance MOC",
          category: "flows",
          categoryLabelZh: "机构调仓暗流",
          impact: "medium",
          descriptionZh: "月末最后一个交易日最后 10 分钟常集中出现被动力与固定配比调仓买/卖盘。",
        });
      }

      // 5d. MSCI Index Quarterly/Semi-Annual Effective Date (Feb/May/Aug/Nov last trading day)
      if (month === 2 || month === 5 || month === 8 || month === 11) {
        const lastTd = tradingDays[tradingDays.length - 1];
        pushEtEvent({
          id: `msci-${yr}-${month}`,
          year: yr,
          month,
          day: lastTd,
          hour: 16,
          minute: 0,
          title: "MSCI 全球指数成分调仓生效",
          subtitleEn: "MSCI Index Rebalance Close",
          category: "index",
          categoryLabelZh: "指数调仓",
          impact: "medium",
          descriptionZh: "MSCI 季度指数权重调整于收盘生效，被动跟踪资金在 15:50–16:00 ET 集中成交。",
        });
      }

      // 5e. Treasury QRA Window Estimate (Feb / May / Aug / Nov first Wednesday)
      if (month === 2 || month === 5 || month === 8 || month === 11) {
        const qraWed = nthWeekdayDay(yr, month, 3, 1);
        pushEtEvent({
          id: `qra-${yr}-${month}`,
          year: yr,
          month,
          day: qraWed,
          hour: 8,
          minute: 30,
          title: "美债季度再融资公告 (QRA) 窗口",
          subtitleEn: "US Treasury Refunding Window",
          category: "fomc",
          categoryLabelZh: "财政与流动性",
          impact: "medium",
          descriptionZh: "美国财政部披露未来一季中长端美债发行规模，对 10Y 美债利率与成长股估值极为关键。",
        });
      }

      // 5f. Buyback Blackout Window Start (~5 weeks before peak earnings, around 15th of Mar/Jun/Sep/Dec)
      if (isQuarterMonth) {
        const bb = adjustToNextOrSameTradingDay(yr, month, 15);
        pushEtEvent({
          id: `buyback-blackout-${yr}-${month}`,
          year: bb.year,
          month: bb.month,
          day: bb.day,
          hour: 9,
          minute: 30,
          title: "财报季公司股票回购静默期窗口开启",
          subtitleEn: "Corporate Buyback Blackout",
          category: "flows",
          categoryLabelZh: "机构调仓暗流",
          impact: "info",
          descriptionZh: "进入财报前静默期，美股巨头回购托底买盘阶段性减弱，市场回撤波动率通常抬头。",
        });
      }
    }

    // Annual Events: Tax Day (Apr 15), Jackson Hole (4th Thu of Aug), DST Switches, NYSE Holidays
    const taxAdj = adjustToNextOrSameTradingDay(yr, 4, 15);
    pushEtEvent({
      id: `tax-day-${yr}`,
      year: taxAdj.year,
      month: taxAdj.month,
      day: taxAdj.day,
      hour: 9,
      minute: 30,
      title: "美国报税截止日 (Tax Day)",
      subtitleEn: "US Federal Tax Deadline",
      category: "flows",
      categoryLabelZh: "季节性流动性",
      impact: "info",
      descriptionZh: "个人与机构筹资缴税导致银行准备金与散户边际买盘短期承压的传统季节窗口。",
    });

    const jhThu = nthWeekdayDay(yr, 8, 4, 4);
    pushEtEvent({
      id: `jackson-hole-${yr}`,
      year: yr,
      month: 8,
      day: jhThu,
      hour: 10,
      minute: 0,
      title: "杰克逊霍尔全球央行年会 (Jackson Hole)",
      subtitleEn: "Fed Jackson Hole Symposium",
      category: "fomc",
      categoryLabelZh: "美联储与央行",
      impact: "high",
      descriptionZh: "美联储主席常在此发表年度核心政策基调演讲，历史上多次成为全年利率拐点。",
    });

    // DST Start (2nd Sunday of March) & End (1st Sunday of November)
    const dstSpring = nthWeekdayDay(yr, 3, 0, 2);
    pushEtEvent({
      id: `dst-spring-${yr}`,
      year: yr,
      month: 3,
      day: dstSpring,
      hour: 2,
      minute: 0,
      title: "美股切换「夏令时」— 开盘提前 1 小时",
      subtitleEn: "US Daylight Saving Starts (21:30 CST)",
      category: "regime",
      categoryLabelZh: "交易制度提醒",
      impact: "info",
      descriptionZh: "下个交易日起美股盘中改为北京时间 21:30 – 次日 04:00，宏观数据提前至 20:30。",
    });

    const dstFall = nthWeekdayDay(yr, 11, 0, 1);
    pushEtEvent({
      id: `dst-fall-${yr}`,
      year: yr,
      month: 11,
      day: dstFall,
      hour: 2,
      minute: 0,
      title: "美股切换「冬令时」— 开盘延后 1 小时",
      subtitleEn: "US Standard Time Starts (22:30 CST)",
      category: "regime",
      categoryLabelZh: "交易制度提醒",
      impact: "info",
      descriptionZh: "下个交易日起美股盘中改为北京时间 22:30 – 次日 05:00，宏观数据延后至 21:30。",
    });

    // NYSE Holidays & Half-Day Early Closes from shared marketSchedule engine
    const holidayMap = getYearHolidayMap(yr);
    holidayMap.forEach((info, dateStr) => {
      const { year, month, day } = parseYmd(dateStr);
      if (info.isFullHoliday && info.holidayNameZh) {
        pushEtEvent({
          id: `holiday-${dateStr}`,
          year,
          month,
          day,
          hour: 9,
          minute: 30,
          title: `美股全天休市：${info.holidayNameZh.replace("休市", "")}`,
          subtitleEn: "NYSE Full Market Holiday",
          category: "regime",
          categoryLabelZh: "休市与半日市",
          impact: "high",
          descriptionZh: "纽交所与纳斯达克常规/盘前/盘后全天闭市；前一晚夜盘同步暂停。",
        });
      } else if (info.isEarlyClose && info.holidayNameZh) {
        pushEtEvent({
          id: `early-${dateStr}`,
          year,
          month,
          day,
          hour: 13,
          minute: 0,
          title: info.holidayNameZh,
          subtitleEn: "NYSE 13:00 ET Early Close",
          category: "regime",
          categoryLabelZh: "休市与半日市",
          impact: "medium",
          descriptionZh: "美股提前 3 小时于美东 13:00 收盘，尾盘流动性极浅、价差放大。",
        });
      }
    });
  }

  rawEvents.sort((a, b) => a.timestampMs - b.timestampMs);

  return rawEvents.map((ev) => ({
    ...ev,
    ...formatEventTimesAndCountdown(ev.timestampMs, nowMs),
  }));
}

function classifyTopicKey(title: string): string | null {
  const low = title.toLowerCase();
  if (low.includes("fomc") && low.includes("minute")) return "fomc-minutes";
  if (low.includes("fomc") || low.includes("interest rate")) return "fomc";
  if (low.includes("cpi") || low.includes("consumer price")) return "cpi";
  if (low.includes("ppi") || low.includes("producer price")) return "ppi";
  if (low.includes("pce") || low.includes("personal income")) return "pce";
  if (low.includes("nonfarm") || low.includes("employment situation") || low.includes("payroll")) {
    return "nfp";
  }
  if (low.includes("retail sales")) return "retail";
  if (low.includes("gdp") || low.includes("gross domestic")) return "gdp";
  if (low.includes("ism") && low.includes("manufacturing")) return "ism-mfg";
  if (low.includes("ism") && (low.includes("services") || low.includes("non-manufacturing"))) {
    return "ism-svc";
  }
  return null;
}

function localizeBackendMacroTitle(rawTitle: string): {
  title: string;
  category: MacroEventCategory;
  categoryLabelZh: string;
  descriptionZh: string;
} {
  const topic = classifyTopicKey(rawTitle);
  switch (topic) {
    case "fomc":
      return {
        title: rawTitle.toLowerCase().includes("sep")
          ? "美联储 FOMC 利率决议 + 点阵图"
          : "美联储 FOMC 利率决议",
        category: "fomc",
        categoryLabelZh: "美联储 FOMC",
        descriptionZh: "来自美联储官方实时日程，14:00 ET 公布利率决议并牵动全市场定价中枢。",
      };
    case "cpi":
      return {
        title: "美国 CPI 通胀数据公布",
        category: "macro",
        categoryLabelZh: "核心宏观数据",
        descriptionZh: "来自 FRED 官方实时同步日程，美东 08:30 发布整体与核心 CPI。",
      };
    case "ppi":
      return {
        title: "美国 PPI 生产者物价指数公布",
        category: "macro",
        categoryLabelZh: "核心宏观数据",
        descriptionZh: "来自 FRED 官方实时同步日程，衡量上游通胀向消费端传导。",
      };
    case "pce":
      return {
        title: "美国核心 PCE 物价指数",
        category: "macro",
        categoryLabelZh: "核心宏观数据",
        descriptionZh: "来自 FRED 官方实时同步日程，美联储最看重的官方通胀锚。",
      };
    case "nfp":
      return {
        title: "美国非农就业与失业率报告 (NFP)",
        category: "macro",
        categoryLabelZh: "核心宏观数据",
        descriptionZh: "来自 FRED 官方实时同步日程，美东 08:30 公布就业与薪资增速。",
      };
    case "retail":
      return {
        title: "美国零售销售月率（“恐怖数据”）",
        category: "macro",
        categoryLabelZh: "核心宏观数据",
        descriptionZh: "来自 FRED 官方实时同步日程，衡量美国消费者支出动能。",
      };
    case "gdp":
      return {
        title: "美国季度 GDP 经济数据发布",
        category: "macro",
        categoryLabelZh: "核心宏观数据",
        descriptionZh: "来自 FRED 官方实时同步日程，美东 08:30 校准季度经济增长率。",
      };
    default:
      return {
        title: rawTitle,
        category: "macro",
        categoryLabelZh: "实时同步宏观",
        descriptionZh: "后端数据管道自动同步的美股高/中关注度宏观发布日程。",
      };
  }
}

export function buildUnifiedUsMarketEvents(
  nowMs: number = Date.now(),
  liveCalendar: UpcomingCalendarResponse | null = null,
  horizonDays: number = 95
): UsMarketEventItem[] {
  const baseEvents = getUpcomingUsMarketEvents(nowMs, horizonDays);
  if (!liveCalendar) {
    return baseEvents;
  }

  const maxMs = nowMs + horizonDays * 86_400_000;
  const watchlistSet = new Set(
    (liveCalendar.watchlist_symbols ?? []).map((s) => s.toUpperCase())
  );
  const historyById = new Map(
    (liveCalendar.macro_history ?? []).map((h) => [h.id, h])
  );

  // Index existing static/algorithmic events by (etDateStr + topic) so live backend upgrades or deduplicates cleanly
  const byTopicDate = new Map<string, number>();
  const merged = baseEvents.map((ev) => {
    const topic = classifyTopicKey(`${ev.title} ${ev.subtitleEn}`);
    const hist = topic ? historyById.get(topic) : undefined;
    return hist
      ? {
          ...ev,
          previousSummary: hist.summary_line_zh,
          indicatorId: hist.id,
        }
      : ev;
  });
  merged.forEach((ev, idx) => {
    const topic = classifyTopicKey(`${ev.title} ${ev.subtitleEn}`);
    if (topic) {
      const etDate = getZonedParts(ev.timestampMs, "America/New_York").dateStr;
      byTopicDate.set(`${etDate}:${topic}`, idx);
    }
  });

  // Merge live backend macro events (Fed FOMC / FRED / FMP)
  for (const row of liveCalendar.macro_events ?? []) {
    const ts = Date.parse(row.event_time);
    if (Number.isNaN(ts) || ts < nowMs - 3 * 3600_000 || ts > maxMs) continue;
    const etDate = getZonedParts(ts, "America/New_York").dateStr;
    const topic = classifyTopicKey(row.title);
    const hist = topic ? historyById.get(topic) : undefined;
    const resolvedPrevSummary = row.previous_summary || hist?.summary_line_zh;
    const resolvedIndId = row.indicator_id || hist?.id;
    const key = topic ? `${etDate}:${topic}` : null;

    if (key && byTopicDate.has(key)) {
      const existingIdx = byTopicDate.get(key)!;
      const existing = merged[existingIdx];
      const extraBits: string[] = [];
      if (row.estimate != null) extraBits.push(`预期 ${row.estimate}`);
      if (row.actual != null) extraBits.push(`公布值 ${row.actual}`);
      merged[existingIdx] = {
        ...existing,
        sourceTag: "官网实时同步",
        previousSummary: resolvedPrevSummary || existing.previousSummary,
        indicatorId: resolvedIndId || existing.indicatorId,
        descriptionZh: extraBits.length
          ? `${existing.descriptionZh}（${extraBits.join(" · ")}）`
          : existing.descriptionZh,
      };
      continue;
    }

    const localized = localizeBackendMacroTitle(row.title);
    const impactLow = (row.impact || "").toLowerCase();
    const mappedImpact: MacroEventImpact =
      impactLow === "high" ? "high" : impactLow === "medium" ? "medium" : "info";
    const times = formatEventTimesAndCountdown(ts, nowMs);
    const newItem: UsMarketEventItem = {
      id: `live-${row.event_key}`,
      title: localized.title,
      subtitleEn: row.title,
      category: localized.category,
      categoryLabelZh: localized.categoryLabelZh,
      impact: mappedImpact,
      timestampMs: ts,
      descriptionZh: localized.descriptionZh,
      previousSummary: resolvedPrevSummary || undefined,
      indicatorId: resolvedIndId || undefined,
      sourceTag: row.source === "federalreserve_gov" ? "美联储官网同步" : "实时同步",
      ...times,
    };
    merged.push(newItem);
    if (key) {
      byTopicDate.set(key, merged.length - 1);
    }
  }

  // Merge live corporate earnings (Watchlist + Core Tech Leaders)
  const seenEarnKeys = new Set<string>();
  for (const row of liveCalendar.earnings_events ?? []) {
    const ts = Date.parse(row.event_time);
    if (Number.isNaN(ts) || ts < nowMs - 3 * 3600_000 || ts > maxMs) continue;
    const sym = (row.symbol || "").toUpperCase();
    if (!sym) continue;
    const dedupKey = `${sym}:${getZonedParts(ts, "America/New_York").dateStr}`;
    if (seenEarnKeys.has(dedupKey)) continue;
    seenEarnKeys.add(dedupKey);

    const isWatched = watchlistSet.has(sym);
    const times = formatEventTimesAndCountdown(ts, nowMs);
    const epsNote =
      row.eps_estimate != null ? ` · 一致预期 EPS $${row.eps_estimate.toFixed(2)}` : "";
    merged.push({
      id: `earn-${row.event_key}`,
      title: `${sym} 季度财报发布${isWatched ? " ★ 自选关注" : ""}`,
      subtitleEn: row.title || `${sym} Earnings`,
      category: "earnings",
      categoryLabelZh: isWatched ? "自选股财报" : "重点股财报",
      impact: isWatched ? "high" : "medium",
      timestampMs: ts,
      descriptionZh: `Finnhub 实时财报日程${epsNote}；财报前后常伴随隐含波动率（IV Crush）与大幅跳空。`,
      sourceTag: "Finnhub 实时同步",
      ...times,
    });
  }

  merged.sort((a, b) => a.timestampMs - b.timestampMs);
  return merged;
}

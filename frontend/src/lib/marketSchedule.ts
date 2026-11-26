export type UsSessionId = "overnight" | "pre" | "regular" | "after" | "closed";

export interface ZonedClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sun, 6 = Sat
  weekdayZh: string;
  dateStr: string;
  minutesOfDay: number;
  tzAbbrev: string;
}

export interface HolidayInfo {
  isFullHoliday: boolean;
  isEarlyClose: boolean;
  holidayNameZh: string | null;
}

export interface SessionMeta {
  id: UsSessionId;
  labelZh: string;
  shortZh: string;
  enLabel: string;
  colorHex: string;
  etRange: string;
}

export interface ScheduleSegmentBar {
  session: UsSessionId;
  startPct: number;
  widthPct: number;
  startLabel: string;
  endLabel: string;
}

export interface DailyScheduleRow {
  weekday: number; // 0 = Sun .. 6 = Sat
  dayShortZh: string;
  dayShortEn: string;
  dateStr: string;
  isToday: boolean;
  holidayNote: string | null;
  segments: ScheduleSegmentBar[];
}

export interface LiveUsMarketClockSnapshot {
  nowMs: number;
  beijing: ZonedClockParts;
  eastern: ZonedClockParts;
  beijingFriendly: string;
  easternFriendly: string;
  isDst: boolean;
  dstLabelZh: string;
  session: UsSessionId;
  sessionMeta: SessionMeta;
  holidayInfo: HolidayInfo;
  nextSession: UsSessionId;
  nextTransitionMs: number;
  countdownText: string;
  countdownShortText: string;
  countdownTargetLabelZh: string;
  nextTransitionLabelZh: string;
  todayBeijingSegments: ScheduleSegmentBar[];
  todayProgressPct: number;
  weeklyRows: DailyScheduleRow[];
}

export const SESSION_META_MAP: Record<UsSessionId, SessionMeta> = {
  overnight: {
    id: "overnight",
    labelZh: "夜盘交易",
    shortZh: "夜盘",
    enLabel: "Overnight",
    colorHex: "#2563eb",
    etRange: "20:00 – 04:00 ET",
  },
  pre: {
    id: "pre",
    labelZh: "盘前交易",
    shortZh: "盘前",
    enLabel: "Pre-Market",
    colorHex: "#f97316",
    etRange: "04:00 – 09:30 ET",
  },
  regular: {
    id: "regular",
    labelZh: "盘中常规交易",
    shortZh: "盘中",
    enLabel: "Regular Hours",
    colorHex: "#22c55e",
    etRange: "09:30 – 16:00 ET",
  },
  after: {
    id: "after",
    labelZh: "盘后交易",
    shortZh: "盘后",
    enLabel: "After-Hours",
    colorHex: "#d946ef",
    etRange: "16:00 – 20:00 ET",
  },
  closed: {
    id: "closed",
    labelZh: "休市闭市",
    shortZh: "休市",
    enLabel: "Closed",
    colorHex: "#71717a",
    etRange: "周末 / 美股假日",
  },
};

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const WEEKDAY_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEKDAY_EN = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
const WEEKLY_ROWS_CACHE = new Map<string, DailyScheduleRow[]>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = FORMATTER_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hourCycle: "h23",
      timeZoneName: "short",
    });
    FORMATTER_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

export function getZonedParts(epochMs: number, timeZone: string): ZonedClockParts {
  const parts = getFormatter(timeZone).formatToParts(new Date(epochMs));
  const bag: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      bag[part.type] = part.value;
    }
  }
  const year = Number(bag.year);
  const month = Number(bag.month);
  const day = Number(bag.day);
  const hour = Number(bag.hour) % 24;
  const minute = Number(bag.minute);
  const second = Number(bag.second);
  const weekday = WEEKDAY_MAP[bag.weekday ?? "Sun"] ?? 0;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday,
    weekdayZh: WEEKDAY_ZH[weekday] ?? "周日",
    dateStr: `${year}-${pad2(month)}-${pad2(day)}`,
    minutesOfDay: hour * 60 + minute,
    tzAbbrev: bag.timeZoneName ?? "",
  };
}

export function zonedWallTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const targetUtcApprox = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = targetUtcApprox;
  for (let i = 0; i < 3; i += 1) {
    const p = getZonedParts(guess, timeZone);
    const renderedAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
    const diff = targetUtcApprox - renderedAsUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

export function formatFriendlyChineseTime(parts: ZonedClockParts): string {
  const { hour, minute } = parts;
  const mm = String(minute).padStart(2, "0");
  if (hour === 0) return `凌晨 0:${mm}`;
  if (hour >= 1 && hour <= 4) return `凌晨 ${hour}:${mm}`;
  if (hour >= 5 && hour <= 7) return `清晨 ${hour}:${mm}`;
  if (hour >= 8 && hour <= 11) return `上午 ${hour}:${mm}`;
  if (hour === 12) return `中午 12:${mm}`;
  if (hour >= 13 && hour <= 17) return `下午 ${hour - 12}:${mm}`;
  if (hour >= 18 && hour <= 19) return `傍晚 ${hour - 12}:${mm}`;
  return `晚上 ${hour - 12}:${mm}`;
}

export function addUtcCalendarDays(
  year: number,
  month: number,
  day: number,
  deltaDays: number
): { year: number; month: number; day: number; weekday: number; dateStr: string } {
  const d = new Date(Date.UTC(year, month - 1, day + deltaDays, 12, 0, 0));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const dy = d.getUTCDate();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return {
    year: y,
    month: m,
    day: dy,
    weekday: d.getUTCDay(),
    dateStr: `${y}-${pad2(m)}-${pad2(dy)}`,
  };
}

function getEasterSundayUtc(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function nthWeekdayOfMonth(
  year: number,
  month: number,
  targetWeekday: number,
  nth: number
): number {
  const firstWd = new Date(Date.UTC(year, month - 1, 1, 12, 0, 0)).getUTCDay();
  const offset = (targetWeekday - firstWd + 7) % 7;
  return 1 + offset + (nth - 1) * 7;
}

function lastWeekdayOfMonth(year: number, month: number, targetWeekday: number): number {
  const lastDay = new Date(Date.UTC(year, month, 0, 12, 0, 0));
  const lastWd = lastDay.getUTCDay();
  const back = (lastWd - targetWeekday + 7) % 7;
  return lastDay.getUTCDate() - back;
}

function observedUsHolidayDate(year: number, month: number, day: number): string {
  const wd = new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay();
  if (wd === 6) {
    return addUtcCalendarDays(year, month, day, -1).dateStr;
  }
  if (wd === 0) {
    return addUtcCalendarDays(year, month, day, 1).dateStr;
  }
  return addUtcCalendarDays(year, month, day, 0).dateStr;
}

const YEAR_HOLIDAY_CACHE = new Map<number, Map<string, HolidayInfo>>();

export function getYearHolidayMap(year: number): Map<string, HolidayInfo> {
  const cached = YEAR_HOLIDAY_CACHE.get(year);
  if (cached) return cached;

  const map = new Map<string, HolidayInfo>();
  const addFull = (dateStr: string, nameZh: string) => {
    map.set(dateStr, { isFullHoliday: true, isEarlyClose: false, holidayNameZh: nameZh });
  };
  const addEarly = (dateStr: string, nameZh: string) => {
    if (!map.has(dateStr)) {
      map.set(dateStr, { isFullHoliday: false, isEarlyClose: true, holidayNameZh: nameZh });
    }
  };

  // New Year's Day (NYSE stays open on Dec 31 if Jan 1 is Saturday per NYSE Rule 7.2)
  const jan1Wd = new Date(Date.UTC(year, 0, 1, 12, 0, 0)).getUTCDay();
  if (jan1Wd === 0) {
    addFull(`${year}-01-02`, "元旦补休");
  } else if (jan1Wd !== 6) {
    addFull(`${year}-01-01`, "元旦休市");
  }

  // MLK Jr. Day: 3rd Mon of Jan
  const mlk = nthWeekdayOfMonth(year, 1, 1, 3);
  addFull(addUtcCalendarDays(year, 1, mlk, 0).dateStr, "马丁路德金纪念日休市");

  // Presidents' Day: 3rd Mon of Feb
  const pres = nthWeekdayOfMonth(year, 2, 1, 3);
  addFull(addUtcCalendarDays(year, 2, pres, 0).dateStr, "总统日休市");

  // Good Friday
  const easter = getEasterSundayUtc(year);
  addFull(
    addUtcCalendarDays(year, easter.month, easter.day, -2).dateStr,
    "耶稣受难日休市"
  );

  // Memorial Day: Last Mon of May
  const mem = lastWeekdayOfMonth(year, 5, 1);
  addFull(addUtcCalendarDays(year, 5, mem, 0).dateStr, "阵亡将士纪念日休市");

  // Juneteenth (since 2022)
  if (year >= 2022) {
    addFull(observedUsHolidayDate(year, 6, 19), "六月节休市");
  }

  // Independence Day & early close July 3
  const jul4Obs = observedUsHolidayDate(year, 7, 4);
  addFull(jul4Obs, "美国独立日休市");
  const jul3Wd = new Date(Date.UTC(year, 6, 3, 12, 0, 0)).getUTCDay();
  if (jul3Wd >= 1 && jul3Wd <= 5 && jul4Obs === `${year}-07-04`) {
    addEarly(`${year}-07-03`, "独立日前夕提前休市 (13:00 ET)");
  }

  // Labor Day: 1st Mon of Sep
  const labor = nthWeekdayOfMonth(year, 9, 1, 1);
  addFull(addUtcCalendarDays(year, 9, labor, 0).dateStr, "美国劳工节休市");

  // Thanksgiving: 4th Thu of Nov & Black Friday early close
  const thanks = nthWeekdayOfMonth(year, 11, 4, 4);
  addFull(addUtcCalendarDays(year, 11, thanks, 0).dateStr, "感恩节休市");
  addEarly(
    addUtcCalendarDays(year, 11, thanks, 1).dateStr,
    "黑色星期五半日市 (13:00 ET 收盘)"
  );

  // Christmas Day & Christmas Eve early close
  const xmasObs = observedUsHolidayDate(year, 12, 25);
  addFull(xmasObs, "圣诞节休市");
  const dec24Wd = new Date(Date.UTC(year, 11, 24, 12, 0, 0)).getUTCDay();
  if (dec24Wd >= 1 && dec24Wd <= 4) {
    addEarly(`${year}-12-24`, "平安夜半日市 (13:00 ET 收盘)");
  }

  YEAR_HOLIDAY_CACHE.set(year, map);
  return map;
}

export function getNyseDayInfo(
  year: number,
  month: number,
  day: number,
  weekday: number,
  dateStr: string
): { isTradingDay: boolean; regularCloseMin: number; afterCloseMin: number; holiday: HolidayInfo } {
  const yearMap = getYearHolidayMap(year);
  const info = yearMap.get(dateStr) ?? {
    isFullHoliday: false,
    isEarlyClose: false,
    holidayNameZh: null,
  };
  if (weekday === 0 || weekday === 6 || info.isFullHoliday) {
    return {
      isTradingDay: false,
      regularCloseMin: 960,
      afterCloseMin: 1200,
      holiday: info,
    };
  }
  if (info.isEarlyClose) {
    return {
      isTradingDay: true,
      regularCloseMin: 13 * 60,
      afterCloseMin: 17 * 60,
      holiday: info,
    };
  }
  return {
    isTradingDay: true,
    regularCloseMin: 16 * 60,
    afterCloseMin: 20 * 60,
    holiday: info,
  };
}

export function classifyEtMoment(epochMs: number): {
  session: UsSessionId;
  holidayInfo: HolidayInfo;
  et: ZonedClockParts;
} {
  const et = getZonedParts(epochMs, "America/New_York");
  const m = et.minutesOfDay;
  const todayInfo = getNyseDayInfo(et.year, et.month, et.day, et.weekday, et.dateStr);

  if (m < 4 * 60) {
    return {
      session: todayInfo.isTradingDay ? "overnight" : "closed",
      holidayInfo: todayInfo.holiday,
      et,
    };
  }
  if (m < 9 * 60 + 30) {
    return {
      session: todayInfo.isTradingDay ? "pre" : "closed",
      holidayInfo: todayInfo.holiday,
      et,
    };
  }
  if (m < todayInfo.regularCloseMin) {
    return {
      session: todayInfo.isTradingDay ? "regular" : "closed",
      holidayInfo: todayInfo.holiday,
      et,
    };
  }
  if (m < todayInfo.afterCloseMin) {
    return {
      session: todayInfo.isTradingDay ? "after" : "closed",
      holidayInfo: todayInfo.holiday,
      et,
    };
  }
  if (m >= 20 * 60) {
    const nextDay = addUtcCalendarDays(et.year, et.month, et.day, 1);
    const nextInfo = getNyseDayInfo(
      nextDay.year,
      nextDay.month,
      nextDay.day,
      nextDay.weekday,
      nextDay.dateStr
    );
    return {
      session: nextInfo.isTradingDay ? "overnight" : "closed",
      holidayInfo: todayInfo.holiday,
      et,
    };
  }

  return { session: "closed", holidayInfo: todayInfo.holiday, et };
}

function buildBeijingDaySegments(
  year: number,
  month: number,
  day: number
): ScheduleSegmentBar[] {
  // Scan 96 x 15-min slots across the Beijing calendar day
  const totalSlots = 96;
  const slots: UsSessionId[] = [];
  for (let idx = 0; idx < totalSlots; idx += 1) {
    const hour = Math.floor((idx * 15) / 60);
    const minute = (idx * 15) % 60;
    // Evaluate midpoint (+7m) of each 15-minute slot in Beijing time
    const slotMs =
      zonedWallTimeToUtcMs(year, month, day, hour, minute, "Asia/Shanghai") + 7 * 60_000;
    slots.push(classifyEtMoment(slotMs).session);
  }

  const fmtMin = (totalMin: number) => {
    const clamped = Math.min(24 * 60, Math.max(0, totalMin));
    const h = Math.floor(clamped / 60);
    const m = clamped % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };

  const segments: ScheduleSegmentBar[] = [];
  let runStart = 0;
  for (let i = 1; i <= totalSlots; i += 1) {
    if (i === totalSlots || slots[i] !== slots[runStart]) {
      const startMin = runStart * 15;
      const endMin = i * 15;
      segments.push({
        session: slots[runStart],
        startPct: Number(((startMin / 1440) * 100).toFixed(3)),
        widthPct: Number((((endMin - startMin) / 1440) * 100).toFixed(3)),
        startLabel: fmtMin(startMin),
        endLabel: fmtMin(endMin),
      });
      runStart = i;
    }
  }
  return segments;
}

function findNextSessionTransition(
  nowMs: number,
  currentSession: UsSessionId
): { nextSession: UsSessionId; nextTransitionMs: number } {
  // Coarse scan every 5 minutes up to 96 hours, then refine to exact minute
  const fiveMin = 5 * 60_000;
  let coarseMs = nowMs;
  const maxScanMs = nowMs + 96 * 3600_000;
  let foundSession: UsSessionId = currentSession;

  while (coarseMs <= maxScanMs) {
    coarseMs += fiveMin;
    const probe = classifyEtMoment(coarseMs).session;
    if (probe !== currentSession) {
      foundSession = probe;
      break;
    }
  }

  // Binary / linear refine within that 5-minute window down to 1-minute precision
  let exactMs = Math.max(nowMs + 1000, coarseMs - fiveMin);
  while (exactMs < coarseMs) {
    if (classifyEtMoment(exactMs).session !== currentSession) {
      break;
    }
    exactMs += 60_000;
  }

  // Snap cleanly to minute boundary (:00 seconds in ET)
  const snappedParts = getZonedParts(exactMs, "America/New_York");
  const snapped =
    zonedWallTimeToUtcMs(
      snappedParts.year,
      snappedParts.month,
      snappedParts.day,
      snappedParts.hour,
      snappedParts.minute,
      "America/New_York"
    );

  return {
    nextSession: foundSession,
    nextTransitionMs: Math.max(nowMs + 1000, snapped),
  };
}

function formatCountdownPair(diffMs: number): { full: string; short: string } {
  const totalSec = Math.max(0, Math.floor(diffMs / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  if (days >= 1) {
    return {
      full: `${days}天${hours}小时${mins}分`,
      short: `${days}天${hours}h`,
    };
  }
  if (hours >= 1) {
    return {
      full: `${hours}小时${String(mins).padStart(2, "0")}分`,
      short: `${hours}h${String(mins).padStart(2, "0")}m`,
    };
  }
  return {
    full: `${mins}分${String(secs).padStart(2, "0")}秒`,
    short: `${mins}m${String(secs).padStart(2, "0")}s`,
  };
}

function resolveCountdownTargetLabel(
  session: UsSessionId,
  nextSession: UsSessionId
): string {
  if (session === "pre") return "距开盘";
  if (session === "regular") return "距收盘";
  if (session === "overnight") return "距盘前";
  if (session === "after") {
    return nextSession === "closed" ? "距休市" : "距夜盘";
  }
  if (nextSession === "overnight") return "距夜盘";
  if (nextSession === "pre") return "距盘前";
  if (nextSession === "regular") return "距开盘";
  return "距开盘";
}

export function buildLiveUsMarketClock(nowMs: number = Date.now()): LiveUsMarketClockSnapshot {
  const beijing = getZonedParts(nowMs, "Asia/Shanghai");
  const classified = classifyEtMoment(nowMs);
  const { et, session, holidayInfo } = classified;
  const sessionMeta = SESSION_META_MAP[session];

  const isDst = et.tzAbbrev.includes("EDT");
  const dstLabelZh = isDst ? "美东夏令时 (EDT · UTC-4)" : "美东冬令时 (EST · UTC-5)";

  const { nextSession, nextTransitionMs } = findNextSessionTransition(nowMs, session);
  const cd = formatCountdownPair(nextTransitionMs - nowMs);
  const countdownTargetLabelZh = resolveCountdownTargetLabel(session, nextSession);
  const nextTransitionLabelZh = `${countdownTargetLabelZh} ${cd.short}`;

  // Compute Sunday..Saturday of the current Beijing week (cached by Beijing dateStr)
  let cachedRows = WEEKLY_ROWS_CACHE.get(beijing.dateStr);
  if (!cachedRows) {
    const sundayCal = addUtcCalendarDays(
      beijing.year,
      beijing.month,
      beijing.day,
      -beijing.weekday
    );
    cachedRows = [];
    for (let wd = 0; wd < 7; wd += 1) {
      const dayCal = addUtcCalendarDays(sundayCal.year, sundayCal.month, sundayCal.day, wd);
      // Probe 23:00 CST (= 10:00/11:00 ET) to match the US trading session of that evening
      const etEvening = getZonedParts(
        zonedWallTimeToUtcMs(dayCal.year, dayCal.month, dayCal.day, 23, 0, "Asia/Shanghai"),
        "America/New_York"
      );
      const holidayForDay = getYearHolidayMap(etEvening.year).get(etEvening.dateStr);
      const segments = buildBeijingDaySegments(dayCal.year, dayCal.month, dayCal.day);
      cachedRows.push({
        weekday: wd,
        dayShortZh: WEEKDAY_ZH[wd],
        dayShortEn: WEEKDAY_EN[wd],
        dateStr: dayCal.dateStr,
        isToday: dayCal.dateStr === beijing.dateStr,
        holidayNote: holidayForDay?.holidayNameZh ?? null,
        segments,
      });
    }
    if (WEEKLY_ROWS_CACHE.size > 8) {
      WEEKLY_ROWS_CACHE.clear();
    }
    WEEKLY_ROWS_CACHE.set(beijing.dateStr, cachedRows);
  }
  const weeklyRows = cachedRows;

  const todayRow = weeklyRows.find((r) => r.isToday) ?? weeklyRows[beijing.weekday];
  const todayProgressPct = Number(
    (((beijing.minutesOfDay + beijing.second / 60) / 1440) * 100).toFixed(2)
  );

  return {
    nowMs,
    beijing,
    eastern: et,
    beijingFriendly: formatFriendlyChineseTime(beijing),
    easternFriendly: formatFriendlyChineseTime(et),
    isDst,
    dstLabelZh,
    session,
    sessionMeta,
    holidayInfo,
    nextSession,
    nextTransitionMs,
    countdownText: cd.full,
    countdownShortText: cd.short,
    countdownTargetLabelZh,
    nextTransitionLabelZh,
    todayBeijingSegments: todayRow.segments,
    todayProgressPct,
    weeklyRows,
  };
}

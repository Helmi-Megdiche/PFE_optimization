import type { DailyUsageStats, WellbeingStats } from './scoringEngine';

export interface UsageSessionRecord {
  start_time: Date | string;
  end_time: Date | string;
  app_category: string | null;
}

const EDUCATIONAL_CATEGORIES = new Set(['educational', 'creative']);

/** ALL_IS_FIXED #10: default zone for local-day/night-window calculations, matching env.ts's
 *  default. Kept as a literal here (not imported from config) so this module stays a pure,
 *  dependency-free scoring function that tests can drive without touching env — production
 *  call sites thread `env.appTimezone` through explicitly instead of relying on this default. */
const DEFAULT_TIMEZONE = 'Africa/Tunis';

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function sessionDurationMinutes(
  start: Date | string,
  end: Date | string,
): number {
  const s = toDate(start);
  const e = toDate(end);
  const ms = e.getTime() - s.getTime();
  return ms > 0 ? ms / 60_000 : 0;
}

/** Minutes of a session that fall in 22:00–06:00 local time in `timeZone` (default Africa/Tunis). */
export function nightMinutesInSession(
  start: Date | string,
  end: Date | string,
  timeZone: string = DEFAULT_TIMEZONE,
): number {
  const s = toDate(start);
  const e = toDate(end);
  if (e <= s) return 0;

  // Constructed once outside the per-minute loop below — constructing an Intl formatter
  // per minute is a real cost on a long session.
  const hourFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: 'numeric',
  });

  let night = 0;
  const cursor = new Date(s);

  while (cursor < e) {
    const hour = Number(hourFormatter.format(cursor));
    const isNight = hour >= 22 || hour < 6;

    const next = new Date(cursor);
    next.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0);
    const segmentEnd = next < e ? next : e;
    const mins = (segmentEnd.getTime() - cursor.getTime()) / 60_000;

    if (isNight) night += mins;
    cursor.setTime(segmentEnd.getTime());
  }

  return night;
}

export function aggregateSessionsForDay(
  sessions: UsageSessionRecord[],
  timeZone: string = DEFAULT_TIMEZONE,
): Pick<
  WellbeingStats,
  | 'totalScreenMinutes'
  | 'sessionCount'
  | 'nightMinutes'
  | 'educationalScreenMinutes'
> {
  let totalScreenMinutes = 0;
  let nightMinutes = 0;
  let educationalScreenMinutes = 0;

  for (const row of sessions) {
    const mins = sessionDurationMinutes(row.start_time, row.end_time);
    totalScreenMinutes += mins;
    nightMinutes += nightMinutesInSession(row.start_time, row.end_time, timeZone);

    const category = (row.app_category ?? 'unknown').toLowerCase();
    if (EDUCATIONAL_CATEGORIES.has(category)) {
      educationalScreenMinutes += mins;
    }
  }

  return {
    totalScreenMinutes,
    sessionCount: sessions.length,
    nightMinutes,
    educationalScreenMinutes,
  };
}

export function buildDailyStats(
  dayAggregate: ReturnType<typeof aggregateSessionsForDay>,
  weekOverWeekChangePercent: number,
  options?: {
    physicalActivityMinutes?: number;
    bedtimeVarianceMinutes?: number;
    familyCallsMessages?: number;
    recommendedScreenMinutes?: number;
  },
): WellbeingStats {
  return {
    ...dayAggregate,
    weekOverWeekChangePercent,
    physicalActivityMinutes: options?.physicalActivityMinutes ?? 0,
    bedtimeVarianceMinutes: options?.bedtimeVarianceMinutes ?? 30,
    familyCallsMessages: options?.familyCallsMessages ?? 0,
    recommendedScreenMinutes: options?.recommendedScreenMinutes,
  };
}

export function weekOverWeekChangePercent(
  currentDayMinutes: number,
  sameDayLastWeekMinutes: number,
): number {
  if (sameDayLastWeekMinutes <= 0) {
    return currentDayMinutes > 0 ? 100 : 0;
  }
  return ((currentDayMinutes - sameDayLastWeekMinutes) / sameDayLastWeekMinutes) * 100;
}

export function toScoreDateString(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function addictionStatsFromWellbeing(stats: WellbeingStats): DailyUsageStats {
  return {
    totalScreenMinutes: stats.totalScreenMinutes,
    sessionCount: stats.sessionCount,
    nightMinutes: stats.nightMinutes,
    weekOverWeekChangePercent: stats.weekOverWeekChangePercent,
    physicalActivityMinutes: stats.physicalActivityMinutes,
  };
}

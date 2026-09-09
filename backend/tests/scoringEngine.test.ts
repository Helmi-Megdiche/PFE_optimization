import {
  applyExposurePenaltyToAddictionScore,
  computeAddictionScore,
  computeExposurePenalty,
  computeWellbeingScore,
  type DailyUsageStats,
  type WellbeingStats,
} from '../src/scoring/scoringEngine';
import {
  aggregateSessionsForDay,
  nightMinutesInSession,
  toScoreDateString,
  weekOverWeekChangePercent,
} from '../src/scoring/aggregateUsage';

describe('computeAddictionScore', () => {
  const zeroUsage: DailyUsageStats = {
    totalScreenMinutes: 0,
    sessionCount: 0,
    nightMinutes: 0,
    weekOverWeekChangePercent: 0,
    physicalActivityMinutes: 0,
  };

  it('returns near-zero score with no usage', () => {
    const { score, components } = computeAddictionScore(zeroUsage);
    expect(score).toBe(0);
    expect(components.intensity).toBe(0);
    expect(components.nightUsage).toBe(0);
  });

  it('returns high score for heavy night usage and escalation', () => {
    const heavy: DailyUsageStats = {
      totalScreenMinutes: 720,
      sessionCount: 80,
      nightMinutes: 360,
      weekOverWeekChangePercent: 25,
      physicalActivityMinutes: 0,
    };
    const { score, components } = computeAddictionScore(heavy);
    expect(score).toBeGreaterThanOrEqual(80);
    expect(components.escalation).toBe(100);
    expect(components.intensity).toBe(100);
  });

  it('caps score at 100', () => {
    const extreme: DailyUsageStats = {
      totalScreenMinutes: 1000,
      sessionCount: 200,
      nightMinutes: 900,
      weekOverWeekChangePercent: 50,
      physicalActivityMinutes: 0,
    };
    expect(computeAddictionScore(extreme).score).toBeLessThanOrEqual(100);
  });
});

describe('exposure penalty', () => {
  it('adds 2 points per weekly risky event', () => {
    expect(computeExposurePenalty(0)).toBe(0);
    expect(computeExposurePenalty(3)).toBe(6);
    expect(computeExposurePenalty(10)).toBe(20);
  });

  it('caps exposure penalty at 20 points', () => {
    expect(computeExposurePenalty(15)).toBe(20);
    expect(computeExposurePenalty(100)).toBe(20);
  });

  it('applies penalty on top of base addiction score', () => {
    expect(applyExposurePenaltyToAddictionScore(45, 4)).toBe(53);
    expect(applyExposurePenaltyToAddictionScore(95, 10)).toBe(100);
  });

  it('never returns negative addiction score', () => {
    expect(applyExposurePenaltyToAddictionScore(0, 0)).toBe(0);
  });
});

describe('computeWellbeingScore', () => {
  it('returns high score for educational content and activity', () => {
    const stats: WellbeingStats = {
      totalScreenMinutes: 120,
      sessionCount: 5,
      nightMinutes: 0,
      weekOverWeekChangePercent: 0,
      physicalActivityMinutes: 60,
      educationalScreenMinutes: 120,
      bedtimeVarianceMinutes: 15,
      familyCallsMessages: 5,
    };
    const { score, components } = computeWellbeingScore(stats);
    expect(score).toBeGreaterThanOrEqual(80);
    expect(components.contentQuality).toBe(100);
    expect(components.realActivity).toBe(100);
  });

  it('handles zero screen time without division errors', () => {
    const stats: WellbeingStats = {
      totalScreenMinutes: 0,
      sessionCount: 0,
      nightMinutes: 0,
      weekOverWeekChangePercent: 0,
      physicalActivityMinutes: 0,
      educationalScreenMinutes: 0,
      bedtimeVarianceMinutes: 30,
      familyCallsMessages: 0,
    };
    const { score, components } = computeWellbeingScore(stats);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(components.contentQuality).toBe(0);
  });

  it('reduces screen balance when far over recommended limit', () => {
    const stats: WellbeingStats = {
      totalScreenMinutes: 480,
      sessionCount: 10,
      nightMinutes: 0,
      weekOverWeekChangePercent: 0,
      physicalActivityMinutes: 0,
      educationalScreenMinutes: 0,
      bedtimeVarianceMinutes: 30,
      familyCallsMessages: 0,
      recommendedScreenMinutes: 180,
    };
    expect(computeWellbeingScore(stats).components.screenBalance).toBe(0);
  });
});

describe('aggregateUsage helpers', () => {
  it('aggregates session durations and educational minutes', () => {
    const agg = aggregateSessionsForDay([
      {
        start_time: '2026-05-17T10:00:00.000Z',
        end_time: '2026-05-17T10:30:00.000Z',
        app_category: 'educational',
      },
      {
        start_time: '2026-05-17T11:00:00.000Z',
        end_time: '2026-05-17T11:15:00.000Z',
        app_category: 'social',
      },
    ]);
    expect(agg.sessionCount).toBe(2);
    expect(agg.totalScreenMinutes).toBeCloseTo(45, 0);
    expect(agg.educationalScreenMinutes).toBeCloseTo(30, 0);
  });

  it('computes night overlap for late session', () => {
    const night = nightMinutesInSession(
      '2026-05-17T23:00:00.000Z',
      '2026-05-18T01:00:00.000Z',
    );
    expect(night).toBeCloseTo(120, 0);
  });

  it('weekOverWeekChangePercent handles zero baseline', () => {
    expect(weekOverWeekChangePercent(60, 0)).toBe(100);
    expect(weekOverWeekChangePercent(0, 0)).toBe(0);
  });
});

// ALL_IS_FIXED #10 — discriminating pairs for the Africa/Tunis timezone fix (A1).
// These must be RED on the unmodified tree (nightMinutesInSession/toScoreDateString
// still hardcode UTC and ignore the timeZone argument) and GREEN after the fix.
describe('nightMinutesInSession — timezone-corrected night window', () => {
  it('counts 21:00-22:00Z as night in Africa/Tunis (22:00-23:00 local), not in UTC', () => {
    const night = nightMinutesInSession(
      '2026-01-10T21:00:00.000Z',
      '2026-01-10T22:00:00.000Z',
      'Africa/Tunis',
    );
    expect(night).toBeCloseTo(60, 0);
  });

  it('does not count 05:00-06:00Z as night in Africa/Tunis (06:00-07:00 local), unlike UTC', () => {
    const night = nightMinutesInSession(
      '2026-01-10T05:00:00.000Z',
      '2026-01-10T06:00:00.000Z',
      'Africa/Tunis',
    );
    expect(night).toBeCloseTo(0, 0);
  });

  it('control: 22:00-23:00Z (23:00-00:00 local) is night under both rules', () => {
    const night = nightMinutesInSession(
      '2026-01-10T22:00:00.000Z',
      '2026-01-10T23:00:00.000Z',
      'Africa/Tunis',
    );
    expect(night).toBeCloseTo(60, 0);
  });
});

describe('toScoreDateString — timezone-corrected calendar date', () => {
  it('renders 23:30Z as the next local calendar day in Africa/Tunis', () => {
    expect(toScoreDateString(new Date('2026-09-07T23:30:00.000Z'), 'Africa/Tunis')).toBe(
      '2026-09-08',
    );
  });

  it('control: 12:00Z is the same calendar day in both UTC and Africa/Tunis', () => {
    expect(toScoreDateString(new Date('2026-09-07T12:00:00.000Z'), 'Africa/Tunis')).toBe(
      '2026-09-07',
    );
  });
});

import { describe, expect, it } from 'bun:test';
import { evenPace, PACE_MARGIN } from '../src/services/limitPace';
import { quotaRowsFor } from '../src/services/quotaService';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const NOW = Date.parse('2026-09-25T00:00:00Z');

describe('evenPace', () => {
  it('puts even pace at the share of the window still to run', () => {
    // Three days of a week gone: even spending leaves four sevenths.
    expect(evenPace(57, NOW + 4 * DAY, WEEK, NOW)?.evenPercent).toBeCloseTo(57.14, 2);
    expect(evenPace(50, NOW + 2.5 * HOUR, 5 * HOUR, NOW)?.evenPercent).toBe(50);
  });

  it('says ahead only past the margin, and behind the same way', () => {
    const halfway = NOW + WEEK / 2;
    expect(evenPace(50, halfway, WEEK, NOW)?.verdict).toBe('on-pace');
    expect(evenPace(50 - PACE_MARGIN, halfway, WEEK, NOW)?.verdict).toBe('on-pace');
    expect(evenPace(50 - PACE_MARGIN - 1, halfway, WEEK, NOW)?.verdict).toBe('ahead');
    expect(evenPace(50 + PACE_MARGIN, halfway, WEEK, NOW)?.verdict).toBe('on-pace');
    expect(evenPace(50 + PACE_MARGIN + 1, halfway, WEEK, NOW)?.verdict).toBe('behind');
  });

  it('reads an out-of-range percent as its nearest end', () => {
    expect(evenPace(-5, NOW + WEEK / 2, WEEK, NOW)).toEqual({ evenPercent: 50, verdict: 'ahead' });
    expect(evenPace(140, NOW + WEEK / 2, WEEK, NOW)).toEqual({ evenPercent: 50, verdict: 'behind' });
  });

  it('gives nothing without a percent, a reset or a window length', () => {
    expect(evenPace(null, NOW + DAY, WEEK, NOW)).toBeNull();
    expect(evenPace(undefined, NOW + DAY, WEEK, NOW)).toBeNull();
    expect(evenPace(Number.NaN, NOW + DAY, WEEK, NOW)).toBeNull();
    expect(evenPace(50, undefined, WEEK, NOW)).toBeNull();
    expect(evenPace(50, Number.NaN, WEEK, NOW)).toBeNull();
    expect(evenPace(50, NOW + DAY, undefined, NOW)).toBeNull();
  });

  it('gives nothing for a window length that cannot be right', () => {
    expect(evenPace(50, NOW + 1_000, 0, NOW)).toBeNull();
    expect(evenPace(50, NOW + 1_000, -WEEK, NOW)).toBeNull();
    expect(evenPace(50, NOW + 1_000, 30_000, NOW)).toBeNull();
    expect(evenPace(50, NOW + DAY, Number.POSITIVE_INFINITY, NOW)).toBeNull();
    expect(evenPace(50, NOW + DAY, 400 * DAY, NOW)).toBeNull();
  });

  it('gives nothing once the reset has passed, since the reading is from a window that is over', () => {
    expect(evenPace(30, NOW, WEEK, NOW)).toBeNull();
    expect(evenPace(30, NOW - HOUR, WEEK, NOW)).toBeNull();
    expect(evenPace(30, NOW + 1, WEEK, NOW)?.evenPercent).toBeCloseTo(0, 5);
  });

  it('holds at 100 for a reset slightly more than a window away, and gives nothing further out', () => {
    // A 5-hour window whose reset is rounded up past the full length.
    expect(evenPace(95, NOW + 5.5 * HOUR, 5 * HOUR, NOW)).toEqual({ evenPercent: 100, verdict: 'on-pace' });
    expect(evenPace(95, NOW + 7.5 * HOUR, 5 * HOUR, NOW)?.evenPercent).toBe(100);
    // A weekly reset against a 5-hour length: the length is wrong.
    expect(evenPace(95, NOW + 3 * DAY, 5 * HOUR, NOW)).toBeNull();
  });
});

describe('window lengths on quota rows', () => {
  it('fixes Claude windows by name: five hours, or a week', () => {
    const rows = quotaRowsFor('claude', {
      five_hour: { utilization: 20 },
      seven_day: { utilization: 20 },
      seven_day_opus: { utilization: 20 },
      seven_day_sonnet: { utilization: 20 },
      seven_day_oauth_apps: { utilization: 20 },
      limits: [{ kind: 'weekly_scoped', percent: 12, is_active: true, scope: { model: { display_name: 'Fable' } } }],
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250 },
    });
    expect(rows.map((row) => [row.label, row.windowMs])).toEqual([
      ['5-hour window', 5 * HOUR],
      ['7-day window', WEEK],
      ['7-day OAuth apps window', WEEK],
      ['7-day Opus window', WEEK],
      ['7-day Sonnet window', WEEK],
      ['7-day Fable window', WEEK],
      ['Extra usage', undefined],
    ]);
  });

  it('gives the Claude caps without a fixed label a week as well, so they get an even-pace tick', () => {
    const rows = quotaRowsFor('claude', {
      seven_day_omelette: { utilization: 70 },
      seven_day_overage_included: { utilization: 25 },
      limits: [{ kind: 'weekly_scoped', percent: 47, is_active: true, scope: { model: { display_name: 'Haiku 5' } } }],
    });
    expect(rows.map((row) => [row.label, row.windowMs])).toEqual([
      ['7-day Omelette window', WEEK],
      ['7-day window', WEEK],
      ['7-day Haiku window', WEEK],
    ]);
  });

  it('gives the older Claude Fable field a week too', () => {
    expect(quotaRowsFor('claude', { iguana_necktie: { utilization: 41 } })[0]?.windowMs).toBe(WEEK);
  });

  it('takes Codex lengths from the reply and leaves them unset when it has none', () => {
    const rows = quotaRowsFor('codex', {
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 20, limitWindowSeconds: '604800' },
      },
      additional_rate_limits: [
        { limit_name: 'Spark', rate_limit: { primary_window: { used_percent: 5 }, secondary_window: { used_percent: 5, limit_window_seconds: 0 } } },
      ],
    });
    expect(rows.map((row) => [row.label, row.windowMs])).toEqual([
      ['5-hour limit', 5 * HOUR],
      ['Weekly limit', WEEK],
      ['Spark 5-hour limit', undefined],
      ['Spark Unknown window limit', undefined],
    ]);
  });
});

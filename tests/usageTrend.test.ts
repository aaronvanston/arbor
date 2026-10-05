import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { getFormatRegion, setFormatRegion } from '../src/lib/format';
import {
  addBucket,
  buildUsageTrendSeries,
  chooseTrendBucket,
  clampTrendRatio,
  findTrendPointIndex,
  formatLocalHourKey,
  formatTrendRangeLabel,
  isClientPointInsideRect,
  nextBucketStart,
  parseLocalHourKey,
  startOfBucket,
  trendPointIndexAtRatio,
  trendTimeAxis,
  trendTimePosition,
  trendValueAxis,
} from '../src/services/usageTrend';
import { itemAt, lastItem } from './support/items';
import { macDates } from './support/macDates';
import type { UsageTimelinePoint } from '../src/native/types';

const HOUR = 3_600_000;

const point = (
  hour: string,
  requests: number,
  tokens: number,
  extras: Partial<UsageTimelinePoint> = {},
): UsageTimelinePoint => ({
  hour,
  requests,
  tokens,
  success: extras.success ?? requests,
  failure: extras.failure ?? 0,
  canceled: extras.canceled ?? 0,
  firstTimestampMs: extras.firstTimestampMs ?? null,
});

const range = (start: Date, end?: Date) => ({ start: start.toISOString(), end: end?.toISOString() });

// ICU versions differ: some put a narrow no-break space before AM/PM, and some join date and time with "at".
const plain = (text: string) => macDates(text.replace(/\s+/g, ' ').replace(' at ', ', '));

// DST rules depend on the zone, so the DST tests pin theirs rather than use the machine's. The last
// four change clocks at midnight, which leaves days that start at 01:00.
const DST_ZONES = ['Australia/Melbourne', 'Australia/Lord_Howe', 'America/New_York', 'Europe/London', 'America/Santiago', 'Asia/Beirut', 'Africa/Cairo', 'America/Havana'];

// Deleting TZ afterward would leave Intl formatting on UTC, so the original zone is set back by name.
const HOST_ZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

function inTimeZone(zone: string, run: () => void) {
  process.env.TZ = zone;
  try {
    run();
  } finally {
    process.env.TZ = HOST_ZONE;
  }
}

describe('usage trend helpers', () => {
  // The axis layout is checked with US labels; tests/format.test.ts covers how each region writes them.
  const region = getFormatRegion();
  beforeEach(() => setFormatRegion({ locale: 'en-US', hourCycle: 'h12' }));
  afterAll(() => setFormatRegion(region));

  test('parses and formats local hour keys', () => {
    const date = parseLocalHourKey('2026-09-14-15');
    expect(date).not.toBeNull();
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(8);
    expect(date?.getDate()).toBe(14);
    expect(date?.getHours()).toBe(15);
    expect(date?.getMinutes()).toBe(0);
    expect(formatLocalHourKey(date as Date)).toBe('2026-09-14-15');
    expect(parseLocalHourKey(' 2026-09-14-15 ')?.getHours()).toBe(15);
    // The backend only groups by hour, and never by half hour.
    expect(parseLocalHourKey('2026-09-14-15-30')).toBeNull();
    expect(parseLocalHourKey('2026-02-30-10')).toBeNull();
    expect(parseLocalHourKey('2026-09-14-24')).toBeNull();
    expect(parseLocalHourKey('not an hour')).toBeNull();
  });

  test('chooses coarser buckets as the range grows, never finer than an hour', () => {
    const start = new Date(2026, 8, 14, 12);
    expect(chooseTrendBucket(start, start)).toBe('hour');
    expect(chooseTrendBucket(start, new Date(2026, 8, 14, 12, 30))).toBe('hour');
    expect(chooseTrendBucket(start, new Date(2026, 8, 14, 16))).toBe('hour');
    expect(chooseTrendBucket(new Date(2026, 0, 5), new Date(2026, 0, 6))).toBe('hour');
    expect(chooseTrendBucket(new Date(2026, 0, 5), new Date(2026, 0, 7))).toBe('hour');
    expect(chooseTrendBucket(new Date(2026, 0, 5), new Date(2026, 0, 8))).toBe('3h');
    expect(chooseTrendBucket(new Date(2026, 0, 5), new Date(2026, 0, 12))).toBe('day');
    expect(chooseTrendBucket(new Date(2026, 0, 5), new Date(2026, 1, 4))).toBe('day');
    expect(chooseTrendBucket(new Date(2026, 0, 1), new Date(2026, 2, 31))).toBe('day');
    expect(chooseTrendBucket(new Date(2025, 0, 1), new Date(2026, 6, 1))).toBe('week');
    expect(chooseTrendBucket(new Date(2022, 0, 1), new Date(2026, 0, 1))).toBe('month');
    expect(chooseTrendBucket(new Date(2010, 0, 1), new Date(2026, 0, 1))).toBe('month');
  });

  test('fills idle hours inside the selected range', () => {
    const start = new Date(2026, 8, 14, 10);
    const end = new Date(2026, 8, 14, 14);
    const series = buildUsageTrendSeries(
      [point('2026-09-14-10', 2, 20), point('2026-09-14-12', 1, 10, { success: 0, failure: 1 })],
      range(start, end),
    );

    expect(series.bucket).toBe('hour');
    expect(series.points.map((item) => item.key)).toEqual(['2026-09-14-10', '2026-09-14-11', '2026-09-14-12', '2026-09-14-13']);
    expect(series.points[1]).toMatchObject({ requests: 0, tokens: 0 });
    expect(series.points[2]).toMatchObject({ requests: 1, failure: 1, tokens: 10 });
    expect(series.totals).toMatchObject({ requests: 3, tokens: 30, failures: 1, success: 2 });
  });

  test('fills idle hours before the first event in the selected range', () => {
    const start = new Date(2026, 8, 14, 8);
    const end = new Date(2026, 8, 14, 12);
    const series = buildUsageTrendSeries([point('2026-09-14-10', 2, 20)], range(start, end));

    expect(series.bucket).toBe('hour');
    expect(series.points.map((item) => item.key)).toEqual(['2026-09-14-08', '2026-09-14-09', '2026-09-14-10', '2026-09-14-11']);
    expect(series.points[0]).toMatchObject({ requests: 0, tokens: 0 });
    expect(series.points[2]).toMatchObject({ requests: 2, tokens: 20 });
  });

  test('aggregates sparse hours into 3-hour buckets', () => {
    const start = new Date(2026, 0, 5);
    const end = new Date(2026, 0, 8);
    const series = buildUsageTrendSeries(
      [point('2026-01-05-01', 1, 5), point('2026-01-05-02', 3, 7, { success: 2, failure: 1 })],
      range(start, end),
    );

    expect(series.bucket).toBe('3h');
    const first = itemAt(series.points, 0);
    expect(startOfBucket(first.start, '3h').getHours()).toBe(0);
    expect(first).toMatchObject({ requests: 4, tokens: 12, failure: 1, success: 3 });
    expect(series.points.length).toBe(24);
  });

  test('uses daily buckets and fills idle days for a 30-day range', () => {
    const start = new Date(2026, 7, 15, 8);
    const end = new Date(2026, 8, 14, 18);
    const series = buildUsageTrendSeries(
      [point('2026-08-15-09', 2, 8), point('2026-09-14-10', 5, 20, { success: 4, failure: 1 })],
      range(start, end),
    );

    expect(series.bucket).toBe('day');
    expect(series.points[0]).toMatchObject({ requests: 2, tokens: 8 });
    expect(series.points[series.points.length - 1]).toMatchObject({ requests: 5, tokens: 20, failure: 1 });
    expect(series.points.some((item) => item.requests === 0)).toBe(true);
    expect(series.points.length).toBeGreaterThan(20);
  });

  test('starts week buckets on Monday', () => {
    const thursday = new Date(2026, 0, 1, 12);
    const monday = startOfBucket(thursday, 'week');
    expect(monday.getDay()).toBe(1);
    expect(monday.getFullYear()).toBe(2025);
    expect(monday.getMonth()).toBe(11);
    expect(monday.getDate()).toBe(29);
    expect(startOfBucket(new Date(2026, 0, 4, 23), 'week').getDate()).toBe(29);
    expect(startOfBucket(new Date(2026, 0, 5, 0, 30), 'week').getDate()).toBe(5);
  });

  test.each([
    [4, 'hour', 4],
    [24, 'hour', 24],
    [48, 'hour', 48],
    [72, '3h', 24],
    [7 * 24, 'day', 7],
    [30 * 24, 'day', 30],
  ] as const)('divides a %i-hour range by time, including empty slots', (hours, bucket, count) => {
    const start = new Date(2026, 0, 5);
    const end = new Date(start.getTime() + hours * HOUR);
    const series = buildUsageTrendSeries([], range(start, end));
    expect(series.bucket).toBe(bucket);
    expect(series.points).toHaveLength(count);
    expect(series.points[0]?.start).toEqual(start);
    expect(series.points[series.points.length - 1]?.end).toEqual(end);
    expect(series.points.every((item) => item.tokens === 0)).toBe(true);
    for (let index = 1; index < series.points.length; index++) {
      expect(itemAt(series.points, index).start).toEqual(itemAt(series.points, index - 1).end);
    }
  });

  test('clips partial boundary buckets without dropping prefiltered tokens', () => {
    const start = new Date(2026, 8, 14, 10, 17);
    const end = new Date(2026, 8, 14, 14, 17);
    const series = buildUsageTrendSeries(
      [
        // Ends before the range starts, so none of its requests can be in the range.
        point('2026-09-14-09', 1, 100),
        point('2026-09-14-10', 1, 10),
        point('2026-09-14-14', 2, 20),
        // Starts after the range ends.
        point('2026-09-14-15', 1, 200),
      ],
      range(start, end),
    );
    const last = lastItem(series.points);
    expect(series.points).toHaveLength(5);
    expect(series.points[0]?.start).toEqual(start);
    expect(series.points[0]?.end).toEqual(new Date(2026, 8, 14, 11));
    expect(last.start).toEqual(new Date(2026, 8, 14, 14));
    expect(last.end).toEqual(end);
    expect(series.points[0]?.tokens).toBe(10);
    expect(last.tokens).toBe(20);
    expect(series.totals.tokens).toBe(30);
    expect(series.points.reduce((sum, item) => sum + item.tokens, 0)).toBe(30);
    expect(trendTimePosition(itemAt(series.points, 0).end, start, end)).toBeCloseTo(43 / 240);
    expect(findTrendPointIndex(series.points, new Date(2026, 8, 14, 10, 59))).toBe(0);
    expect(findTrendPointIndex(series.points, new Date(2026, 8, 14, 11))).toBe(1);
    expect(findTrendPointIndex(series.points, end)).toBe(series.points.length - 1);
    expect(findTrendPointIndex([], end)).toBe(-1);
    expect(trendPointIndexAtRatio(series.points, start, end, 0)).toBe(0);
    expect(trendPointIndexAtRatio(series.points, start, end, 42 / 240)).toBe(0);
    expect(trendPointIndexAtRatio(series.points, start, end, 44 / 240)).toBe(1);
    expect(trendPointIndexAtRatio(series.points, start, end, 1)).toBe(series.points.length - 1);
    expect(trendPointIndexAtRatio(series.points, start, end, 7)).toBe(series.points.length - 1);
    expect(trendPointIndexAtRatio([], start, end, 0.5)).toBe(-1);
    expect(clampTrendRatio(1.4)).toBe(1);
    expect(clampTrendRatio(-0.2)).toBe(0);
    expect(clampTrendRatio(Number.NaN)).toBe(0);
    expect(isClientPointInsideRect(120, 40, { left: 100, right: 200, top: 10, bottom: 80 })).toBe(true);
    expect(isClientPointInsideRect(90, 40, { left: 100, right: 200, top: 10, bottom: 80 })).toBe(false);
    expect(isClientPointInsideRect(120, 81, { left: 100, right: 200, top: 10, bottom: 80 })).toBe(false);
  });

  test('keeps an inclusive end request in the final bar without extending the range', () => {
    const start = new Date(2026, 8, 14, 10);
    const end = new Date(2026, 8, 14, 14);
    const series = buildUsageTrendSeries([point('2026-09-14-14', 1, 50)], range(start, end));
    const last = lastItem(series.points);
    expect(series.points).toHaveLength(4);
    expect(last.end).toEqual(end);
    expect(last.tokens).toBe(50);
    expect(series.totals.tokens).toBe(50);
  });

  test('runs an open range to now and handles reversed or empty ranges', () => {
    const start = new Date(2026, 8, 14, 10, 17);
    const now = new Date(2026, 8, 14, 14, 17);
    const series = buildUsageTrendSeries([point('2026-09-14-11', 1, 10)], { start: start.toISOString() }, now);
    expect(series.points[0]?.start).toEqual(start);
    expect(series.points[series.points.length - 1]?.end).toEqual(now);
    expect(buildUsageTrendSeries([], range(now, start)).points).toEqual([]);
    expect(buildUsageTrendSeries([], range(now, start)).totals.requests).toBe(0);
    expect(buildUsageTrendSeries([]).points).toEqual([]);
    expect(buildUsageTrendSeries([point('not an hour', 3, 30)]).points).toEqual([]);
  });

  test('runs all time from the first recorded hour to now, including the idle stretch since', () => {
    const now = new Date(2026, 8, 14, 14, 17);
    const series = buildUsageTrendSeries([point('2026-09-10-05', 2, 20), point('2026-09-11-09', 1, 10)], {}, now);
    expect(series.bucket).toBe('day');
    expect(series.points[0]?.start).toEqual(new Date(2026, 8, 10, 5));
    expect(series.points[0]?.key).toBe('2026-09-10-00');
    expect(series.points[series.points.length - 1]?.end).toEqual(now);
    expect(series.points.map((item) => item.tokens)).toEqual([20, 10, 0, 0, 0]);

    // The current hour ends in the future; the axis still stops at now.
    const today = buildUsageTrendSeries([point('2026-09-14-09', 1, 10), point('2026-09-14-14', 1, 10)], {}, now);
    expect(today.bucket).toBe('hour');
    expect(today.points[today.points.length - 1]?.end).toEqual(now);

    // A clock behind the newest hour extends the axis to cover it.
    const behind = buildUsageTrendSeries([point('2026-09-14-15', 1, 10)], {}, now);
    expect(behind.points[behind.points.length - 1]?.end).toEqual(new Date(2026, 8, 14, 16));
    expect(behind.totals.tokens).toBe(10);
  });

  test('shows an empty all-time chart when the first timestamp is past what Date can hold', () => {
    // 9e15 ms is a finite number but an Invalid Date, as a corrupt timestamp row would be.
    const series = buildUsageTrendSeries([point('2026-09-20-10', 3, 100, { firstTimestampMs: 9e15 })], {}, new Date(2026, 8, 25, 12));
    expect(series.points).toEqual([]);
    expect(series.totals.requests).toBe(3);
    expect(series.totals.tokens).toBe(100);
  });

  test('keeps bucket keys stable while a rolling range moves within the hour', () => {
    const keysAt = (minute: number) => {
      const end = new Date(2026, 0, 14, 14, minute);
      return buildUsageTrendSeries([point('2026-01-14-13', 1, 10)], range(new Date(end.getTime() - 24 * HOUR), end)).points.map(
        (item) => item.key,
      );
    };
    expect(keysAt(20)).toEqual(keysAt(25));
  });

  test('scales months by their elapsed duration instead of equal point indexes', () => {
    const start = new Date(2023, 0, 1);
    const end = new Date(2026, 0, 1);
    const series = buildUsageTrendSeries([], range(start, end));
    expect(series.bucket).toBe('month');
    expect(series.points).toHaveLength(36);
    const widths = series.points
      .slice(0, 2)
      .map((item) => trendTimePosition(item.end, start, end) - trendTimePosition(item.start, start, end));
    expect(itemAt(widths, 0) / itemAt(widths, 1)).toBeCloseTo(31 / 28);
  });

  test('starts day buckets at local midnight across DST changes', () => {
    for (const zone of DST_ZONES) {
      inTimeZone(zone, () => {
        for (const [start, end] of [
          [new Date(2026, 2, 1), new Date(2026, 4, 1)],
          [new Date(2026, 8, 1), new Date(2026, 10, 15)],
        ] as const) {
          const series = buildUsageTrendSeries([], range(start, end));
          expect(series.bucket).toBe('day');
          for (let index = 1; index < series.points.length; index++) {
            const previous = itemAt(series.points, index - 1).start;
            // Where midnight is skipped, the Date constructor gives that day's first hour, 01:00.
            const nextMidnight = new Date(previous.getFullYear(), previous.getMonth(), previous.getDate() + 1);
            expect(`${zone} ${itemAt(series.points, index).start.toString()}`).toBe(`${zone} ${nextMidnight.toString()}`);
            expect(itemAt(series.points, index - 1).end.getTime()).toBe(nextMidnight.getTime());
          }
        }
        expect(addBucket(new Date(2026, 2, 28, 12), 'day').getTime()).toBe(new Date(2026, 2, 29, 12).getTime());
      });
    }
  });

  test('goes back to midnight the day after a DST change skips it', () => {
    inTimeZone('America/Santiago', () => {
      // Clocks jump from 00:00 to 01:00 on 6 September 2026 in Santiago.
      const skipped = startOfBucket(new Date(2026, 8, 6, 12), 'day');
      expect(skipped.getHours()).toBe(1);
      const next = nextBucketStart(skipped, 'day');
      expect([next.getDate(), next.getHours()]).toEqual([7, 0]);

      const now = new Date(2026, 8, 23, 14);
      const series = buildUsageTrendSeries(
        [point('2026-09-10-00', 5, 500), point('2026-09-10-12', 1, 100)],
        range(new Date(now.getTime() - 30 * 24 * HOUR), now),
        now,
      );
      const september10 = series.points.find((item) => item.start.getMonth() === 8 && item.start.getDate() === 10);
      expect(september10?.start.getHours()).toBe(0);
      expect(september10?.tokens).toBe(600);
    });
  });

  test('places hours by their recorded time after the timezone changes', () => {
    const now = new Date(Date.UTC(2026, 5, 10, 3));
    const hours = Array.from({ length: 24 }, (_, index) => now.getTime() - (24 - index) * HOUR);
    const recordedIn = (zone: string) => {
      const format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
      return (time: number) => {
        const part = Object.fromEntries(format.formatToParts(new Date(time)).map((item) => [item.type, item.value]));
        return `${part.year}-${part.month}-${part.day}-${part.hour}`;
      };
    };
    const label = recordedIn('Australia/Melbourne');
    // One request an hour, recorded 10 minutes past, while the Mac was on Melbourne time.
    const timeline = hours.map((time) => point(label(time), 1, 100, { firstTimestampMs: time + 10 * 60_000 }));
    for (const zone of ['America/Los_Angeles', 'Europe/London', 'Asia/Kolkata', 'Australia/Melbourne']) {
      inTimeZone(zone, () => {
        const series = buildUsageTrendSeries(timeline, range(new Date(now.getTime() - 24 * HOUR), now), now);
        expect(`${zone} ${series.totals.requests}`).toBe(`${zone} 24`);
        expect(series.points.reduce((sum, item) => sum + item.requests, 0)).toBe(24);
        if (zone !== 'Asia/Kolkata') {
          // Whole-hour offsets keep one request per bar; half-hour offsets move each request to the hour it started in.
          expect(series.points.filter((item) => item.requests === 1).length).toBe(24);
        }
      });
    }
    // Rows without a usable first timestamp still fall back to their label.
    const fallback = buildUsageTrendSeries([point('2026-06-10-12', 1, 100, { firstTimestampMs: 0 })], range(new Date(2026, 5, 10), new Date(2026, 5, 11)));
    expect(fallback.totals.requests).toBe(1);
  });

  test('labels the time axis as densely as the width allows, keeping exact endpoints', () => {
    const start = new Date(2026, 8, 14, 10, 17);
    const end = new Date(2026, 8, 14, 14, 17);
    const wide = trendTimeAxis(start, end, 'hour', 1000);
    const narrow = trendTimeAxis(start, end, 'hour', 320);
    const first = itemAt(wide, 0);
    const last = lastItem(wide);
    expect(first.date.getTime()).toBe(start.getTime());
    expect(first).toMatchObject({ position: 0, align: 'start', tick: false });
    expect(last.date.getTime()).toBe(end.getTime());
    expect(last).toMatchObject({ position: 1, align: 'end', tick: false });
    expect(plain(first.label)).toBe('10:17 AM');
    expect(plain(last.label)).toBe('2:17 PM');
    expect(wide.length).toBeGreaterThan(narrow.length);

    const inner = wide.slice(1, -1);
    expect(inner.length).toBeGreaterThan(1);
    expect(inner.every((label) => label.align === 'center' && label.tick && label.date.getMinutes() === 0)).toBe(true);
    const gaps = inner.slice(1).map((label, index) => label.date.getTime() - itemAt(inner, index).date.getTime());
    expect(new Set(gaps).size).toBe(1);
    expect(itemAt(inner, 0).position).toBeCloseTo(trendTimePosition(itemAt(inner, 0).date, start, end));

    expect(trendTimeAxis(start, start, 'hour', 800)).toEqual([]);
    expect(trendTimeAxis(start, end, 'hour', 0)).toHaveLength(2);
    // Too narrow for both endpoint labels: only the start stays.
    expect(trendTimeAxis(start, end, 'hour', 100)).toHaveLength(1);
  });

  test('increases time tick density progressively as the chart stretches', () => {
    const start = new Date(2026, 8, 14);
    const end = new Date(2026, 8, 15);
    const widths = [320, 480, 640, 800, 1000, 1400];
    const counts = widths.map((width) => trendTimeAxis(start, end, 'hour', width).length);

    expect(counts.every((count, index) => index === 0 || count >= itemAt(counts, index - 1))).toBe(true);
    expect(new Set(counts).size).toBeGreaterThanOrEqual(4);
    expect(counts[counts.length - 1]).toBeGreaterThan(itemAt(counts, 0));
  });

  test('names the day at midnight when the range spans days', () => {
    const labels = trendTimeAxis(new Date(2026, 8, 13, 14, 17), new Date(2026, 8, 14, 14, 17), 'hour', 1200);
    expect(plain(itemAt(labels, 0).label)).toBe('Sep 13, 2:17 PM');
    expect(plain(lastItem(labels).label)).toBe('Sep 14, 2:17 PM');
    const midnight = labels.find((label) => label.align === 'center' && label.date.getHours() === 0);
    expect(midnight && plain(midnight.label)).toBe('Sep 14');
  });

  test('puts 3-hour ticks on bucket edges', () => {
    const threeHourly = trendTimeAxis(new Date(2026, 0, 5), new Date(2026, 0, 8), '3h', 2000).slice(1, -1);
    expect(threeHourly.length).toBeGreaterThan(0);
    expect(threeHourly.every((label) => label.tick && label.date.getHours() % 3 === 0)).toBe(true);
  });

  test('puts each date label under the day it names', () => {
    const start = new Date(2026, 0, 5, 14, 17);
    const end = new Date(2026, 1, 4, 14, 17);
    const days = trendTimeAxis(start, end, 'day', 900);
    expect(days.length).toBeGreaterThan(5);
    // Less than half of Jan 5 is in the range, so its sliver of a bar gets no label.
    expect(plain(itemAt(days, 0).label)).toBe('Jan 7');
    for (const label of days) {
      expect(label.tick).toBe(false);
      expect(label.date.getHours()).toBe(0);
      expect(label.date.getMinutes()).toBe(0);
    }
    for (const label of days.filter((item) => item.align === 'center')) {
      const dayStart = Math.max(label.date.getTime(), start.getTime());
      const dayEnd = Math.min(addBucket(label.date, 'day').getTime(), end.getTime());
      expect(label.position).toBeCloseTo(((dayStart + dayEnd) / 2 - start.getTime()) / (end.getTime() - start.getTime()));
    }
    const gaps = days.slice(1).map((label, index) => Math.round((label.date.getTime() - itemAt(days, index).date.getTime()) / (24 * HOUR)));
    expect(new Set(gaps).size).toBe(1);
  });

  test('hangs a partial first day from the edge, unless it crowds the next label', () => {
    const start = new Date(2026, 0, 5, 8);
    const end = new Date(2026, 1, 4, 8);
    const roomy = trendTimeAxis(start, end, 'day', 1000);
    expect(roomy[0]).toMatchObject({ position: 0, align: 'start' });
    expect(plain(itemAt(roomy, 0).label)).toBe('Jan 5');
    expect(plain(itemAt(roomy, 1).label)).toBe('Jan 7');

    // Here "Jan 5" would sit too close to "Jan 7", so it gives way and the spacing stays even.
    const tight = trendTimeAxis(start, end, 'day', 860);
    expect(plain(itemAt(tight, 0).label)).toBe('Jan 7');
    expect(tight[0]?.align).toBe('center');
    const gaps = tight.slice(1).map((label, index) => Math.round((label.date.getTime() - itemAt(tight, index).date.getTime()) / (24 * HOUR)));
    expect(new Set(gaps).size).toBe(1);
  });

  test('names months under the middle of each month on long ranges', () => {
    const start = new Date(2026, 2, 7, 8);
    const end = new Date(2026, 8, 23, 8);
    const weeks = trendTimeAxis(start, end, 'week', 778);
    expect(weeks.map((label) => plain(label.label))).toEqual(['Mar 2026', 'Apr 2026', 'May 2026', 'Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026']);
    const span = end.getTime() - start.getTime();
    for (const label of weeks) {
      expect(label).toMatchObject({ align: 'center', tick: false });
      const monthStart = Math.max(label.date.getTime(), start.getTime());
      const monthEnd = Math.min(addBucket(label.date, 'month').getTime(), end.getTime());
      expect(label.position).toBeCloseTo(((monthStart + monthEnd) / 2 - start.getTime()) / span);
    }

    const months = trendTimeAxis(new Date(2023, 0, 1), new Date(2026, 0, 1), 'month', 1000);
    expect(months.length).toBeGreaterThan(3);
    // A month can start at 01:00 where DST skips midnight, so compare with the month's real start.
    expect(months.every((label) => !label.tick && label.date.getTime() === startOfBucket(label.date, 'month').getTime())).toBe(true);
    // Too narrow for every month, so labels land on quarters.
    expect(months.every((label) => label.date.getMonth() % 3 === 0)).toBe(true);
    expect(plain(itemAt(months, 1).label)).toMatch(/^[A-Z][a-z]{2} \d{4}$/);
    expect(trendTimeAxis(start, end, 'week', 0)).toEqual([]);
  });

  test('keeps time-axis ticks on round local hours across DST changes', () => {
    for (const zone of DST_ZONES) {
      inTimeZone(zone, () => {
        // Transition days in the US, Europe, Australia, Chile, Lebanon, Egypt and Cuba; elsewhere these are ordinary days.
        const days = [new Date(2026, 2, 8), new Date(2026, 2, 29), new Date(2026, 3, 5), new Date(2026, 9, 4), new Date(2026, 9, 25), new Date(2026, 10, 1), new Date(2026, 8, 6), new Date(2026, 3, 24), new Date(2026, 9, 29)];
        for (const day of days) {
          const start = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1, 12);
          const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 12);
          const labels = trendTimeAxis(start, end, 'hour', 1400).slice(1, -1);
          expect(labels.length).toBeGreaterThan(3);
          expect(labels.every((label) => label.date.getMinutes() === 0)).toBe(true);
          const hours = labels.map((label) => label.date.getHours());
          const step = Math.min(...hours.slice(1).map((hour, index) => (hour - itemAt(hours, index) + 24) % 24).filter((gap) => gap > 0));
          expect(`${zone} ${day.toDateString()} ${hours.every((hour) => hour % step === 0)}`).toBe(`${zone} ${day.toDateString()} true`);
        }
      });
    }
  });

  test('builds a zero-based value axis with at most one step of headroom', () => {
    expect(trendValueAxis(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(trendValueAxis(Number.NaN)).toEqual({ max: 1, ticks: [0, 1] });
    expect(trendValueAxis(1)).toEqual({ max: 1, ticks: [0, 1] });
    expect(trendValueAxis(3)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    expect(trendValueAxis(5)).toEqual({ max: 6, ticks: [0, 2, 4, 6] });
    expect(trendValueAxis(12)).toEqual({ max: 15, ticks: [0, 5, 10, 15] });
    expect(trendValueAxis(100)).toEqual({ max: 100, ticks: [0, 50, 100] });
    expect(trendValueAxis(1_234_567)).toEqual({ max: 1_500_000, ticks: [0, 500_000, 1_000_000, 1_500_000] });
    expect(trendValueAxis(90, 2)).toEqual({ max: 100, ticks: [0, 50, 100] });
    for (const peak of [7, 19, 240, 999, 4_321, 87_654, 2_500_001]) {
      const { max, ticks } = trendValueAxis(peak);
      const step = itemAt(ticks, 1);
      expect(max).toBeGreaterThanOrEqual(peak);
      expect(max - peak).toBeLessThan(step);
      expect(ticks[ticks.length - 1]).toBe(max);
    }
  });

  test('describes each bucket by the time it covers', () => {
    const now = new Date(2026, 8, 20);
    const label = (start: Date, end: Date, bucket: Parameters<typeof formatTrendRangeLabel>[1]) =>
      plain(formatTrendRangeLabel({ start, end }, bucket, now));

    expect(label(new Date(2026, 8, 14, 15), new Date(2026, 8, 14, 16), 'hour')).toBe('Sep 14, 3:00 PM – 4:00 PM');
    expect(label(new Date(2026, 8, 14, 23), new Date(2026, 8, 15), 'hour')).toBe('Sep 14, 11:00 PM – 12:00 AM');
    expect(label(new Date(2026, 8, 14, 10, 17), new Date(2026, 8, 14, 11), 'hour')).toBe('Sep 14, 10:17 AM – 11:00 AM');
    expect(label(new Date(2026, 8, 14, 12), new Date(2026, 8, 14, 15), '3h')).toBe('Sep 14, 12:00 PM – 3:00 PM');
    expect(label(new Date(2026, 8, 14), new Date(2026, 8, 15), 'day')).toBe('Mon, Sep 14');
    expect(label(new Date(2026, 8, 14, 10, 17), new Date(2026, 8, 15), 'day')).toBe('Sep 14, 10:17 AM – 12:00 AM');
    expect(label(new Date(2026, 8, 20), new Date(2026, 8, 20, 9, 30), 'day')).toBe('Sep 20, 12:00 AM – 9:30 AM');
    // Ranges come from Intl's range format now, which doesn't repeat the month.
    expect(label(new Date(2026, 8, 14), new Date(2026, 8, 21), 'week')).toBe('Sep 14 – 20');
    expect(label(new Date(2026, 8, 1), new Date(2026, 9, 1), 'month')).toBe('September 2026');
    expect(label(new Date(2026, 8, 10), new Date(2026, 9, 1), 'month')).toBe('Sep 10 – 30');
    expect(label(new Date(2025, 8, 14), new Date(2025, 8, 15), 'day')).toBe('Sun, Sep 14, 2025');
  });

  test('describes buckets in the Mac\'s region', () => {
    setFormatRegion({ locale: 'en-AU', hourCycle: 'h12' });
    const now = new Date(2026, 8, 20);
    const label = (start: Date, end: Date, bucket: Parameters<typeof formatTrendRangeLabel>[1]) =>
      plain(formatTrendRangeLabel({ start, end }, bucket, now));
    expect(label(new Date(2026, 8, 14, 15), new Date(2026, 8, 14, 16), 'hour')).toBe('14 Sep, 3:00 pm – 4:00 pm');
    expect(label(new Date(2026, 8, 14), new Date(2026, 8, 21), 'week')).toBe('14 – 20 Sep');
    setFormatRegion({ locale: 'en-AU', hourCycle: 'h23' });
    expect(label(new Date(2026, 8, 14, 15), new Date(2026, 8, 14, 16), 'hour')).toBe('14 Sep, 15:00 – 16:00');
    expect(plain(itemAt(trendTimeAxis(new Date(2026, 8, 13, 14, 17), new Date(2026, 8, 14, 14, 17), 'hour', 1200), 0).label)).toBe('13 Sep, 14:17');
  });
});

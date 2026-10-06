/**
 * Pure helpers behind the usage trend chart.
 *
 * The backend groups usage by local hour (`YYYY-MM-DD-HH`) and only returns
 * hours that had traffic; for a range of a few hours it also sends 5-minute
 * blocks. These helpers lay those rows on a continuous time
 * axis over the selected range: they fill idle gaps, pick a bucket size from
 * the span, pick tick density from the plot's pixel width, and map a pointer
 * position back to its bucket.
 *
 * The hour label is written in the timezone the Mac had when the requests were
 * recorded, so rows are placed by their first request's real time instead.
 */

import { formatDate, formatDateRange, formatDateTime, formatDateWith, formatTime } from '../lib/format';
import type { UsageFiveMinutePoint, UsageTimelinePoint } from '../native/types';

/** 5-minute blocks only come with a short range; otherwise the backend's local hour is the finest bucket. */
export type TrendBucket = '5m' | 'hour' | '3h' | 'day' | 'week' | 'month';

export type PreparedTrendPoint = {
  /** Local hour key of the bucket's calendar start, with the minute for 5-minute blocks; stable across refreshes. */
  key: string;
  requests: number;
  success: number;
  failure: number;
  canceled: number;
  tokens: number;
  /** Tokens from a count kept apart from `tokens`, drawn above them (see TrendInputPoint). */
  recovered: number;
  /** Bucket bounds, clipped to the selected range. */
  start: Date;
  end: Date;
};

export type TrendTotals = {
  requests: number;
  tokens: number;
  recovered: number;
  failures: number;
  success: number;
  canceled: number;
};

/**
 * A timeline row, and for All time the tokens of Claude Code's own count on a day whose transcripts are gone:
 * a different, higher count, so it's never added into `tokens`.
 */
export type TrendInputPoint = UsageTimelinePoint & { recovered?: number };

export type PreparedTrendSeries = {
  bucket: TrendBucket;
  points: PreparedTrendPoint[];
  totals: TrendTotals;
};

const HOUR_MS = 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
/** The longest span drawn in 5-minute blocks; the backend sends them up to the same length (FIVE_MINUTE_TIMELINE_MAX_MS). */
export const FIVE_MINUTE_SPAN_HOURS = 6;

export function parseLocalHourKey(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) return null;
  const date = new Date(year, month - 1, day, hour);
  // Rejects rolled-over dates such as 02-30.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour) {
    return null;
  }
  return date;
}

export function formatLocalHourKey(date: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}`;
}

/**
 * The local hour a timeline row belongs to. Its first request's real time keeps
 * hours recorded before a timezone change at the right place; the label is the
 * fallback for rows without one.
 */
export function timelinePointHour(point: UsageTimelinePoint): Date | null {
  const first = point.firstTimestampMs;
  if (typeof first === 'number' && Number.isFinite(first) && first > 0) return startOfBucket(new Date(first), 'hour');
  return parseLocalHourKey(point.hour);
}

function parseRangeDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function startOfBucket(date: Date, bucket: TrendBucket): Date {
  // Every timezone offset is a whole 5 minutes, so epoch blocks are local ones too.
  if (bucket === '5m') return new Date(Math.floor(date.getTime() / FIVE_MINUTES_MS) * FIVE_MINUTES_MS);
  const next = new Date(date.getTime());
  next.setMinutes(0, 0, 0);
  if (bucket === 'hour') return next;
  if (bucket === '3h') {
    next.setHours(Math.floor(next.getHours() / 3) * 3);
    return next;
  }
  next.setHours(0);
  if (bucket === 'day') return next;
  if (bucket === 'week') {
    // Weeks start on Monday.
    const weekday = next.getDay();
    next.setDate(next.getDate() + (weekday === 0 ? -6 : 1 - weekday));
    return next;
  }
  next.setDate(1);
  return next;
}

/** Steps in local time, so buckets follow the backend's local-hour keys across DST changes. */
export function addBucket(date: Date, bucket: TrendBucket): Date {
  // In real time, so a clock change neither repeats nor skips a block.
  if (bucket === '5m') return new Date(date.getTime() + FIVE_MINUTES_MS);
  const next = new Date(date.getTime());
  if (bucket === 'hour') next.setHours(next.getHours() + 1);
  else if (bucket === '3h') next.setHours(next.getHours() + 3);
  else if (bucket === 'day') next.setDate(next.getDate() + 1);
  else if (bucket === 'week') next.setDate(next.getDate() + 7);
  else next.setMonth(next.getMonth() + 1);
  // A clock that falls back further than one step could land at or before `date`; always move forward.
  return next.getTime() > date.getTime() ? next : new Date(date.getTime() + HOUR_MS);
}

/**
 * The next bucket boundary after a bucket start. Where a DST change skips local
 * midnight a day starts at 01:00, and stepping from there would carry 01:00 into
 * every later day; this snaps back to the calendar boundary.
 */
export function nextBucketStart(start: Date, bucket: TrendBucket): Date {
  const next = startOfBucket(addBucket(start, bucket), bucket);
  return next.getTime() > start.getTime() ? next : addBucket(start, bucket);
}

/**
 * The bucket for a span: fine enough that even a short preset shows a few dozen thin bars, so a
 * week reads hour by hour instead of as seven blocks. `fiveMinutes` says whether 5-minute blocks came.
 */
export function chooseTrendBucket(start: Date, end: Date, fiveMinutes = false): TrendBucket {
  const hours = Math.max(0, end.getTime() - start.getTime()) / HOUR_MS;
  if (fiveMinutes && hours <= FIVE_MINUTE_SPAN_HOURS) return '5m';
  // A day of slack past a week covers a custom range drawn a little long.
  if (hours <= 24 * 8) return 'hour';
  if (hours <= 24 * 21) return '3h';
  if (hours <= 24 * 90) return 'day';
  if (hours <= 24 * 366 * 2) return 'week';
  return 'month';
}

const emptyTotals = (): TrendTotals => ({ requests: 0, tokens: 0, recovered: 0, failures: 0, success: 0, canceled: 0 });

/**
 * Lays the hourly timeline over the selected range. Idle buckets are filled
 * with zeros, so bars sit at their real time. An open-ended range ("All
 * Time", or a custom range without an end) runs to `now`.
 */
type TrendCounts = Pick<TrendInputPoint, 'requests' | 'success' | 'failure' | 'canceled' | 'tokens' | 'recovered'>;

/**
 * The rows that overlap the range, in time order. The backend filters requests before grouping
 * them, so the first row can start before the range, and a request exactly at the inclusive end
 * opens one more row. Both are clamped into the edge buckets below.
 */
function rowsInRange<T>(rows: Array<{ point: T; start: Date | null }>, size: TrendBucket, rangeStart: Date | null, rangeEnd: Date | null) {
  return rows
    .filter((entry): entry is { point: T; start: Date } => {
      if (!entry.start) return false;
      if (rangeStart && addBucket(entry.start, size).getTime() <= rangeStart.getTime()) return false;
      return !rangeEnd || entry.start.getTime() <= rangeEnd.getTime();
    })
    .sort((left, right) => left.start.getTime() - right.start.getTime());
}

export function buildUsageTrendSeries(
  points: TrendInputPoint[],
  range: { start?: string; end?: string } = {},
  now = new Date(),
  fiveMinutePoints: UsageFiveMinutePoint[] = [],
): PreparedTrendSeries {
  const rangeStart = parseRangeDate(range.start);
  const rangeEnd = parseRangeDate(range.end);
  const hourly = rowsInRange(points.map((point) => ({ point, start: timelinePointHour(point) })), 'hour', rangeStart, rangeEnd);

  const totals = emptyTotals();
  for (const { point } of hourly) {
    totals.requests += Math.max(0, point.requests || 0);
    totals.tokens += Math.max(0, point.tokens || 0);
    totals.recovered += Math.max(0, point.recovered || 0);
    totals.failures += Math.max(0, point.failure || 0);
    totals.success += Math.max(0, point.success || 0);
    totals.canceled += Math.max(0, point.canceled || 0);
  }

  const spanStart = rangeStart ?? hourly[0]?.start;
  if (!spanStart) return { bucket: 'hour', points: [], totals };
  const lastHour = hourly[hourly.length - 1]?.start ?? null;
  // An open end runs to now, or to the end of the newest hour if the clock is behind it.
  const openEnd = lastHour && lastHour.getTime() >= now.getTime() ? addBucket(lastHour, 'hour') : now;
  const spanEnd = rangeEnd ?? openEnd;
  if (spanEnd.getTime() <= spanStart.getTime()) return { bucket: 'hour', points: [], totals: emptyTotals() };

  const bucket = chooseTrendBucket(spanStart, spanEnd, fiveMinutePoints.length > 0);
  // The totals stay on the hourly rows, which every range has; 5-minute blocks only change where the bars fall.
  const parsed: Array<{ point: TrendCounts; start: Date }> =
    bucket === '5m'
      ? rowsInRange(fiveMinutePoints.map((point) => ({ point, start: new Date(point.startMs) })), '5m', rangeStart, rangeEnd)
      : hourly;
  const series: PreparedTrendPoint[] = [];
  for (let cursor = startOfBucket(spanStart, bucket); cursor.getTime() < spanEnd.getTime(); cursor = nextBucketStart(cursor, bucket)) {
    series.push({
      key: bucket === '5m' ? `${formatLocalHourKey(cursor)}-${String(cursor.getMinutes()).padStart(2, '0')}` : formatLocalHourKey(cursor),
      requests: 0,
      success: 0,
      failure: 0,
      canceled: 0,
      tokens: 0,
      recovered: 0,
      start: new Date(Math.max(cursor.getTime(), spanStart.getTime())),
      end: new Date(Math.min(nextBucketStart(cursor, bucket).getTime(), spanEnd.getTime())),
    });
  }

  // Both lists are in time order, so one sweep assigns every hour to its bucket.
  let index = 0;
  for (const { point, start } of parsed) {
    const time = Math.max(spanStart.getTime(), Math.min(start.getTime(), spanEnd.getTime() - 1));
    // Past the last bucket there is no next start, so the sweep stays in the last one.
    while ((series[index + 1]?.start.getTime() ?? Infinity) <= time) index += 1;
    const target = series[index];
    // Only missing when the span start isn't a real date (a timestamp past what Date can hold), which opens
    // no buckets; the chart is then empty rather than crashing, and the totals still count the traffic.
    if (!target) continue;
    target.requests += Math.max(0, point.requests || 0);
    target.success += Math.max(0, point.success || 0);
    target.failure += Math.max(0, point.failure || 0);
    target.canceled += Math.max(0, point.canceled || 0);
    target.tokens += Math.max(0, point.tokens || 0);
    target.recovered += Math.max(0, point.recovered || 0);
  }

  return { bucket, points: series, totals };
}

export function trendTimePosition(date: Date, start: Date, end: Date): number {
  const span = end.getTime() - start.getTime();
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, (date.getTime() - start.getTime()) / span));
}

export function findTrendPointIndex(points: PreparedTrendPoint[], time: Date): number {
  if (!points.length) return -1;
  const index = points.findIndex((point) => time.getTime() < point.end.getTime());
  return index < 0 ? points.length - 1 : index;
}

export function clampTrendRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Maps a horizontal position (0 = range start, 1 = range end) to the bucket under it. */
export function trendPointIndexAtRatio(points: PreparedTrendPoint[], start: Date, end: Date, ratio: number): number {
  if (!points.length) return -1;
  const span = Math.max(0, end.getTime() - start.getTime());
  return findTrendPointIndex(points, new Date(start.getTime() + clampTrendRatio(ratio) * span));
}

export function isClientPointInsideRect(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
): boolean {
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

/** A zero-based value axis whose top tick is the first 1-2-5 step multiple at or above `peak`. */
export function trendValueAxis(peak: number, targetTicks = 4): { max: number; ticks: number[] } {
  if (!Number.isFinite(peak) || peak <= 0) return { max: 1, ticks: [0, 1] };
  const rawStep = peak / Math.max(1, Math.round(targetTicks));
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  // Counts are whole numbers, so the step never drops below one.
  const step = Math.max(1, (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude);
  const max = Math.ceil(peak / step) * step;
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, index) => index * step) };
}

type LabelStyle = 'time' | 'date' | 'dateTime' | 'month';

/** Axis labels in the region's style; they leave the year off, which the range heading adds when it matters. */
function axisLabel(date: Date, style: LabelStyle): string {
  switch (style) {
    case 'time': return formatTime(date);
    case 'date': return formatDate(date, { year: 'never' });
    case 'dateTime': return formatDateTime(date, { year: 'never' });
    case 'month': return formatDateWith(date, { month: 'short', year: 'numeric' });
  }
}

function sameCalendarDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

const isLocalMidnight = (date: Date) => date.getHours() === 0 && date.getMinutes() === 0;

// Axis labels are 11px monospace: about 0.6em per character, with room kept between neighbors.
const AXIS_CHAR_PX = 6.6;
const AXIS_LABEL_GAP_PX = 16;
const axisTextWidth = (text: string) => text.length * AXIS_CHAR_PX;

// Measures the widest label of each style: two-digit hours, days and a full year.
const AXIS_LABEL_SAMPLE = new Date(2026, 8, 30, 12, 0);

const TICK_STEP_HOURS = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 96, 168, 336, 720, 1440, 2160, 2880, 4380, 8760, 17520];
const MIN_TICK_STEP_HOURS: Record<TrendBucket, number> = { '5m': 1, hour: 1, '3h': 3, day: 24, week: 168, month: 720 };
const MONTH_HOURS = 730;

function tickStepHours(span: number, width: number, labelPx: number, minimumHours: number): number {
  const minStep = (span * labelPx) / Math.max(labelPx, width);
  const hours = TICK_STEP_HOURS.find(
    // Sub-day steps stay multiples of the bucket, so ticks fall on bar edges.
    (candidate) => candidate >= minimumHours && (candidate >= 24 || candidate % minimumHours === 0) && candidate * HOUR_MS >= minStep,
  );
  return hours ?? Math.ceil(minStep / (8760 * HOUR_MS)) * 8760;
}

/** Times on local clock and calendar boundaries for the step, from the last one at or before `start` up to `end`. */
function calendarSteps(start: Date, end: Date, stepHours: number): Date[] {
  const endTime = end.getTime();
  const candidates: Date[] = [];
  if (stepHours < 24) {
    // Every sub-day step divides 24, so counting from each local midnight keeps ticks on
    // round local hours, even on a day that a DST change shortens or lengthens.
    for (let day = startOfBucket(start, 'day'); day.getTime() < endTime; day = nextBucketStart(day, 'day')) {
      for (let hour = 0; hour < 24; hour += stepHours) {
        const tick = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
        // Skips an hour that a DST change leaves out, rather than labeling the hour after it.
        if (tick.getHours() === hour) candidates.push(tick);
      }
    }
  } else if (stepHours < 720) {
    // Whole days from the start's midnight, or whole weeks from the Monday on or before it.
    const first = startOfBucket(start, stepHours < 168 ? 'day' : 'week');
    for (let days = 0; ; days += stepHours / 24) {
      const tick = new Date(first.getFullYear(), first.getMonth(), first.getDate() + days);
      if (tick.getTime() >= endTime) break;
      candidates.push(tick);
    }
  } else {
    const months = Math.max(1, Math.round(stepHours / MONTH_HOURS));
    const first = startOfBucket(start, 'month');
    // Starts on a month index divisible by the step, so ticks land on quarters, halves or years.
    const offset = (first.getFullYear() * 12 + first.getMonth()) % months;
    for (let index = -offset; ; index += months) {
      const tick = new Date(first.getFullYear(), first.getMonth() + index, 1);
      if (tick.getTime() >= endTime) break;
      candidates.push(tick);
    }
  }
  return candidates;
}

/** Tick times strictly inside the range, on local clock and calendar boundaries for the step. */
function alignedTicks(start: Date, end: Date, stepHours: number): Date[] {
  const ticks: Date[] = [];
  for (const tick of calendarSteps(start, end, stepHours)) {
    // Keeps ticks strictly inside the range and strictly increasing.
    const previous = (ticks[ticks.length - 1] ?? start).getTime();
    if (tick.getTime() > previous && tick.getTime() < end.getTime()) ticks.push(tick);
  }
  return ticks;
}

export type TrendAxisLabel = {
  date: Date;
  label: string;
  /** Horizontal position as a fraction of the plot width. */
  position: number;
  align: 'start' | 'center' | 'end';
  /** True when the label marks an instant on a tick; false when it names a stretch of time or a range end. */
  tick: boolean;
};

/**
 * Time-axis labels for a plot `width` pixels wide, as dense as the width
 * allows without labels touching.
 *
 * Hourly charts label instants: round local times on tick marks, between the
 * exact range endpoints, which hang inward from the edges. Daily and coarser
 * charts label periods instead: each date or month sits under the middle of
 * the stretch it names, so a day's label sits under that day's bar rather
 * than between two bars.
 */
export function trendTimeAxis(start: Date, end: Date, bucket: TrendBucket, width: number): TrendAxisLabel[] {
  const span = end.getTime() - start.getTime();
  if (span <= 0) return [];
  const hourly = bucket === '5m' || bucket === 'hour' || bucket === '3h';
  const sample = (style: LabelStyle) => axisTextWidth(axisLabel(AXIS_LABEL_SAMPLE, style)) + AXIS_LABEL_GAP_PX;
  const minimumHours = MIN_TICK_STEP_HOURS[bucket];
  let stepHours = tickStepHours(span, width, sample(hourly ? 'time' : bucket === 'month' ? 'month' : 'date'), minimumHours);
  // Month labels are wider than the day labels the step was measured with.
  if (stepHours >= 720 && bucket !== 'month') stepHours = tickStepHours(span, width, sample('month'), minimumHours);
  return hourly ? instantLabels(start, end, stepHours, width) : periodLabels(start, end, bucket, stepHours, width);
}

function instantLabels(start: Date, end: Date, stepHours: number, width: number): TrendAxisLabel[] {
  const sameDay = sameCalendarDay(start, new Date(end.getTime() - 1));
  const styleFor = (date: Date, edge: boolean): LabelStyle => {
    if (stepHours >= 24) return 'date';
    if (sameDay) return 'time';
    if (edge) return 'dateTime';
    return isLocalMidnight(date) ? 'date' : 'time';
  };
  const labelFor = (date: Date, edge: boolean) => axisLabel(date, styleFor(date, edge));

  const first: TrendAxisLabel = { date: start, label: labelFor(start, true), position: 0, align: 'start', tick: false };
  const last: TrendAxisLabel = { date: end, label: labelFor(end, true), position: 1, align: 'end', tick: false };
  if (width <= 0) return [first, last];
  // Text extents in pixels; neighboring labels stay a gap apart.
  const firstRight = axisTextWidth(first.label);
  const lastLeft = width - axisTextWidth(last.label);
  const labels = [first];
  let right = firstRight;
  for (const date of alignedTicks(start, end, stepHours)) {
    const label = labelFor(date, false);
    const half = axisTextWidth(label) / 2;
    const x = trendTimePosition(date, start, end) * width;
    if (x - half < right + AXIS_LABEL_GAP_PX || x + half > lastLeft - AXIS_LABEL_GAP_PX) continue;
    labels.push({ date, label, position: x / width, align: 'center', tick: true });
    right = x + half;
  }
  // A plot too narrow for both endpoint labels keeps only the start.
  if (lastLeft - firstRight >= AXIS_LABEL_GAP_PX) labels.push(last);
  return labels;
}

function periodLabels(start: Date, end: Date, bucket: TrendBucket, stepHours: number, width: number): TrendAxisLabel[] {
  if (width <= 0) return [];
  const style: LabelStyle = stepHours >= 720 ? 'month' : 'date';
  // A date names one bar (a day or a week); a month label names the whole month.
  const unit: TrendBucket = style === 'month' ? 'month' : bucket;
  const span = end.getTime() - start.getTime();
  const labels: TrendAxisLabel[] = [];
  let right = Number.NEGATIVE_INFINITY;
  for (const date of calendarSteps(start, end, stepHours)) {
    const periodEnd = nextBucketStart(startOfBucket(date, unit), unit).getTime();
    const from = Math.max(date.getTime(), start.getTime());
    const to = Math.min(periodEnd, end.getTime());
    // A period mostly outside the range gets no label, so an edge label never sits under the next bar instead.
    if ((to - from) * 2 < periodEnd - date.getTime()) continue;
    const label = axisLabel(date, style);
    const text = axisTextWidth(label);
    const center = (((from + to) / 2 - start.getTime()) / span) * width;
    // A label that would cross an edge hangs inward from it.
    const left = Math.max(0, Math.min(width - text, center - text / 2));
    if (left < right + AXIS_LABEL_GAP_PX) {
      // Only a partial first period can crowd the next label; it gives way, so the spacing stays even.
      if (labels.length !== 1) continue;
      labels.pop();
    }
    const align = left <= 0 ? 'start' : left >= width - text ? 'end' : 'center';
    labels.push({ date, label, position: align === 'start' ? 0 : align === 'end' ? 1 : center / width, align, tick: false });
    right = left + text;
  }
  return labels;
}

/** Tooltip heading for one bucket, e.g. "23 Sep, 2:00 pm – 3:00 pm" or "Tue, 23 Sep". */
export function formatTrendRangeLabel(
  point: Pick<PreparedTrendPoint, 'start' | 'end'>,
  bucket: TrendBucket,
  now = new Date(),
): string {
  const { start, end } = point;
  const lastInstant = new Date(end.getTime() - 1);
  const calendarStart = startOfBucket(start, bucket);
  const complete = calendarStart.getTime() === start.getTime() && nextBucketStart(calendarStart, bucket).getTime() === end.getTime();
  const nowMs = now.getTime();
  if (bucket === 'month' && complete) return formatDateWith(start, { month: 'long', year: 'numeric' });
  if (bucket === 'day' && complete) return formatDate(start, { weekday: 'short', now: nowMs });
  if (bucket === 'week' || bucket === 'month') return formatDateRange(start, lastInstant, { now: nowMs });
  // 5-minute blocks, hours, and the partial days at either end of a range.
  const from = formatDateTime(start, { now: nowMs });
  const to = sameCalendarDay(start, lastInstant) ? formatTime(end) : formatDateTime(end, { now: nowMs });
  return `${from} – ${to}`;
}

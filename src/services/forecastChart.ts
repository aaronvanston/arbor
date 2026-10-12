/**
 * Geometry for the forecast chart: where its days fall, and its lines as SVG paths. Kept apart from the component so
 * it can be tested without a DOM.
 */
import type { PoolPoint } from './poolSimulation';

const HOUR = 3_600_000;
/** Room each day label needs, in pixels, before labels start skipping days. */
const LABEL_SPACE = 72;

const round = (value: number) => Math.round(value * 100) / 100;

export type ChartScale = { x: (t: number) => number; y: (value: number) => number };

/** Local midnights inside the range, every day or every few so labels don't crowd `width` pixels. */
export function dayTicks(startMs: number, endMs: number, width: number): number[] {
  const first = new Date(startMs);
  first.setHours(24, 0, 0, 0);
  // A label centered on its day needs half its room on each side, so days too near either edge go unlabeled.
  const margin = ((LABEL_SPACE / 2) / Math.max(1, width)) * (endMs - startMs);
  const days: number[] = [];
  for (const day = first; day.getTime() < endMs - margin; day.setDate(day.getDate() + 1)) {
    if (day.getTime() > startMs + margin) days.push(day.getTime());
  }
  const room = Math.max(1, Math.floor(width / LABEL_SPACE));
  const stride = Math.max(1, Math.ceil(days.length / room));
  return days.filter((_, index) => index % stride === 0);
}

/**
 * The history as a stepped line: each reading holds until the next, as the limits do between refreshes.
 */
export function stepLine(points: PoolPoint[], scale: ChartScale): string {
  return points.map((point, index) => {
    const x = round(scale.x(point.t));
    const y = round(scale.y(point.left));
    return index ? `H${x}V${y}` : `M${x},${y}`;
  }).join('');
}

/** The projection as a straight line through each step, with resets as the steps they are. */
export function straightLine(points: PoolPoint[], scale: ChartScale): string {
  return points.map((point, index) => `${index ? 'L' : 'M'}${round(scale.x(point.t))},${round(scale.y(point.left))}`).join('');
}

/** A line closed down to the baseline, for its soft fill. */
export function areaUnder(line: string, points: PoolPoint[], scale: ChartScale, baseline: number): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || !line) return '';
  return `${line}V${round(baseline)}H${round(scale.x(first.t))}Z`;
}

/** The value at `t`: the last point at or before it, for the history's held readings. */
export function heldValueAt(points: PoolPoint[], t: number): number | null {
  let value: number | null = null;
  for (const point of points) {
    if (point.t > t) break;
    value = point.left;
  }
  return value;
}

/** The value at `t` along a straight-line projection, or null outside it. */
export function lineValueAt(points: PoolPoint[], t: number): number | null {
  for (let index = 1; index < points.length; index += 1) {
    const before = points[index - 1];
    const after = points[index];
    if (!before || !after || t < before.t || t > after.t) continue;
    if (after.t === before.t) return after.left;
    return before.left + ((after.left - before.left) * (t - before.t)) / (after.t - before.t);
  }
  return null;
}

/** Stretches where a projection sits at zero, as start and end times. */
export function dryStretches(points: PoolPoint[]): Array<{ from: number; to: number }> {
  const stretches: Array<{ from: number; to: number }> = [];
  let from: number | null = null;
  points.forEach((point) => {
    if (point.left <= 0.0001) from ??= point.t;
    else if (from !== null) {
      stretches.push({ from, to: point.t });
      from = null;
    }
  });
  const last = points[points.length - 1];
  if (from !== null && last && last.t > from) stretches.push({ from, to: last.t });
  return stretches;
}

/** The hour starts from `startMs` to `endMs`, for the drain chart's projected rate. */
export function hourStarts(startMs: number, endMs: number): number[] {
  const hours: number[] = [];
  for (let t = Math.ceil(startMs / HOUR) * HOUR; t < endMs; t += HOUR) hours.push(t);
  return hours;
}

/** Hourly spend thinned to at most `most` bars, each the average of the hours it covers. */
export function groupHours(values: number[], startMs: number, most: number): Array<{ t: number; spanMs: number; value: number }> {
  const size = Math.max(1, Math.ceil(values.length / Math.max(1, most)));
  const bars: Array<{ t: number; spanMs: number; value: number }> = [];
  for (let index = 0; index < values.length; index += size) {
    const group = values.slice(index, index + size);
    bars.push({ t: startMs + index * HOUR, spanMs: group.length * HOUR, value: group.reduce((sum, value) => sum + value, 0) / group.length });
  }
  return bars;
}

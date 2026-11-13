/**
 * Geometry for the forecast chart: where its days fall, and its lines as SVG paths. Kept apart from the component so
 * it can be tested without a DOM.
 */
import type { ResetMark } from './limitForecast';
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

/** The value just after `t` along a projection: past the step a refill draws there, which has two points at `t`. */
export function lineValueAfter(points: PoolPoint[], t: number): number | null {
  let after: number | null = null;
  for (const point of points) {
    if (point.t > t) break;
    if (point.t === t) after = point.left;
  }
  return after ?? lineValueAt(points, t);
}

/** Marks drawn as one: where on the chart, the mark drawn there, and all of them, oldest first. */
export type MarkSpot = { x: number; y: number; lead: ResetMark; marks: ResetMark[] };

/**
 * Where the marks go. Those closer than `gap` pixels are one spot, drawn as the one that says most: a reset on
 * record before a rise with none. Marks behind now and ahead of it never share a spot. `place` gives a mark's point,
 * or null to leave it out.
 */
export function markSpots(marks: ResetMark[], place: (mark: ResetMark) => { x: number; y: number } | null, gap: number): MarkSpot[] {
  const spots: MarkSpot[] = [];
  let group: Array<{ mark: ResetMark; x: number; y: number }> = [];
  const close = () => {
    const lead = group.find((item) => item.mark.how !== 'early') ?? group[0];
    if (lead) spots.push({ x: lead.x, y: lead.y, lead: lead.mark, marks: group.map((item) => item.mark) });
    group = [];
  };
  [...marks].sort((a, b) => a.atMs - b.atMs).forEach((mark) => {
    const at = place(mark);
    if (!at) return;
    const first = group[0];
    if (first && (at.x - first.x >= gap || (first.mark.how === 'planned') !== (mark.how === 'planned'))) close();
    group.push({ mark, ...at });
  });
  close();
  return spots;
}

/** The spot nearest `x`, within `reach` pixels of it. */
export function spotNear(spots: MarkSpot[], x: number, reach: number): MarkSpot | null {
  let nearest: MarkSpot | null = null;
  for (const spot of spots) {
    if (Math.abs(spot.x - x) <= reach && (!nearest || Math.abs(spot.x - x) < Math.abs(nearest.x - x))) nearest = spot;
  }
  return nearest;
}

/** A diamond around a point, `size` from its middle to each tip. */
export function diamondPath(x: number, y: number, size: number): string {
  return `M${round(x)},${round(y - size)}l${size},${size}l${-size},${size}l${-size},${-size}z`;
}

/**
 * Where an arrow key lands: one step along, or on the first of `stops` on the way, so a mark between two steps can
 * still be read. All in shares of the chart's width.
 */
export function keyStep(from: number, step: number, stops: number[]): number {
  const to = Math.max(0, Math.min(1, from + step));
  const between = stops.filter((stop) => (step > 0 ? stop > from && stop < to : stop < from && stop > to));
  if (!between.length) return to;
  return step > 0 ? Math.min(...between) : Math.max(...between);
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

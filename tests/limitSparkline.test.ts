import { describe, expect, test } from 'bun:test';
import { HISTORY_WINDOW_MS, SPARKLINE_MIN_SPAN_MS, sparklinePoints } from '../src/services/limitsHistory';
import { lastItem } from './support/items';

const HOUR = 3_600_000;
const now = 10 * HISTORY_WINDOW_MS;
const points = (samples: { t: number; percent: number }[]) => sparklinePoints(samples, now, 100, 24);

describe('the limit sparkline', () => {
  test('draws nothing for a single reading, even an old one', () => {
    expect(points([])).toEqual([]);
    expect(points([{ t: now - 6 * HOUR, percent: 80 }])).toEqual([]);
  });

  test('ignores readings that fell out of the window', () => {
    expect(points([{ t: now - HISTORY_WINDOW_MS - 1, percent: 90 }, { t: now - 2 * HOUR, percent: 80 }])).toEqual([]);
  });

  test('waits until the readings span an hour, so a fresh pair isn’t a dot at the edge', () => {
    expect(points([{ t: now - 2 * 60_000, percent: 80 }, { t: now - 60_000, percent: 70 }])).toEqual([]);
    expect(points([{ t: now - SPARKLINE_MIN_SPAN_MS + 1, percent: 80 }, { t: now, percent: 70 }])).toEqual([]);
    expect(points([{ t: now - SPARKLINE_MIN_SPAN_MS, percent: 80 }, { t: now, percent: 70 }])).toHaveLength(2);
  });

  test('places readings across the day and carries the last one to now', () => {
    const drawn = points([{ t: now - 12 * HOUR, percent: 100 }, { t: now - 6 * HOUR, percent: 0 }]);
    expect(drawn).toEqual([
      { x: 50, y: 2 },
      { x: 75, y: 22 },
      { x: 100, y: 22 },
    ]);
  });

  test('keeps out-of-range percents inside the box', () => {
    const drawn = points([{ t: now - 2 * HOUR, percent: 140 }, { t: now, percent: -10 }]);
    expect(drawn.map((point) => point.y)).toEqual([2, 22]);
    expect(lastItem(drawn).x).toBe(100);
  });
});

import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LimitForecastPanel } from '../src/components/LimitForecastPanel';
import { I18nProvider } from '../src/i18n';
import { buildHeadline } from '../src/services/accountLimits';
import { translate } from '../src/i18n';
import {
  dayTicks, diamondPath, dryStretches, groupHours, heldValueAt, keyStep, lineValueAfter, lineValueAt, markSpots, spotNear, stepLine,
} from '../src/services/forecastChart';
import type { ResetMark } from '../src/services/limitForecast';
import { forecastHistoryMs, forecastSettingsFrom } from '../src/services/limitForecastView';
import type { QuotaState } from '../src/services/quotaService';
import { resetMarkLine } from '../src/services/resetKinds';
import { itemAt, lastItem } from './support/items';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = new Date(2026, 9, 12, 6, 0, 0).getTime();
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('forecast chart geometry', () => {
  it('labels local midnights, skipping days that crowd or sit at an edge', () => {
    const ticks = dayTicks(START, START + 7 * DAY, 700);
    // Oct 13 to 18; the 19th's midnight is six hours from the end, inside half a label.
    expect(ticks).toHaveLength(6);
    expect(ticks.every((tick) => new Date(tick).getHours() === 0)).toBe(true);
    // Too narrow for a label a day: every other day.
    expect(dayTicks(START, START + 14 * DAY, 500).length).toBeLessThanOrEqual(7);
    // A midnight a few pixels from the end gets no label to cut in half.
    expect(lastItem(dayTicks(START, new Date(2026, 9, 19, 0, 30).getTime(), 700))).toBe(new Date(2026, 9, 18).getTime());
  });

  it('holds history readings as steps and reads projections along their line', () => {
    const points = [{ t: 0, left: 100 }, { t: 10, left: 60 }, { t: 20, left: 0 }];
    expect(stepLine(points, { x: (t) => t, y: (value) => value })).toBe('M0,100H10V60H20V0');
    expect(heldValueAt(points, 15)).toBe(60);
    expect(heldValueAt(points, -1)).toBeNull();
    expect(lineValueAt(points, 15)).toBe(30);
    expect(lineValueAt(points, 30)).toBeNull();
  });

  it('finds where the projection sits empty', () => {
    expect(dryStretches([{ t: 0, left: 50 }, { t: 5, left: 0 }, { t: 9, left: 0 }, { t: 9, left: 100 }, { t: 12, left: 90 }]))
      .toEqual([{ from: 5, to: 9 }]);
  });

  it('averages hours into at most so many bars', () => {
    const bars = groupHours([1, 3, 5, 7, 9], 0, 2);
    expect(bars).toHaveLength(2);
    expect(itemAt(bars, 0)).toEqual({ t: 0, spanMs: 3 * HOUR, value: 3 });
  });
});

describe('forecast chart marks', () => {
  const mark = (atMs: number, how: ResetMark['how'], extra: Partial<ResetMark> = {}): ResetMark => ({ atMs, key: 'a', name: 'cam-work', how, gain: 80, ...extra });
  const place = (item: ResetMark) => ({ x: item.atMs, y: 20 });

  it('draws marks that crowd as one, the reset on record leading, and never joins the past to the plan', () => {
    const early = mark(100, 'early');
    const used = mark(104, 'used', { reset: 'weekly' });
    const later = mark(130, 'early');
    const planned = mark(134, 'planned');
    const spots = markSpots([planned, later, used, early], place, 10);
    expect(spots.map((spot) => [spot.x, spot.lead.how, spot.marks.length])).toEqual([[104, 'used', 2], [130, 'early', 1], [134, 'planned', 1]]);
    expect(itemAt(spots, 0).marks).toEqual([early, used]);
    // A mark with nowhere to go on the line is left out.
    expect(markSpots([early, used], (item) => (item === early ? null : place(item)), 10).map((spot) => spot.marks)).toEqual([[used]]);
  });

  it('reads the mark nearest the pointer, within reach', () => {
    const spots = markSpots([mark(100, 'used'), mark(130, 'early')], place, 10);
    expect(spotNear(spots, 108, 8)?.x).toBe(100);
    expect(spotNear(spots, 121, 8)).toBeNull();
    expect(spotNear(spots, 124, 8)?.x).toBe(130);
  });

  it('stops the arrow keys at a mark on their way', () => {
    expect(keyStep(0.5, 0.1, [0.53, 0.58, 0.7])).toBe(0.53);
    expect(keyStep(0.53, 0.1, [0.53, 0.58, 0.7])).toBe(0.58);
    expect(keyStep(0.5, -0.1, [0.42, 0.47, 0.6])).toBe(0.47);
    expect(keyStep(0.5, 0.1, [0.7])).toBeCloseTo(0.6, 9);
    expect(keyStep(0.95, 0.1, [])).toBe(1);
    expect(keyStep(0.02, -0.1, [])).toBe(0);
  });

  it('draws a diamond, and reads a projection just after a refill', () => {
    expect(diamondPath(10, 20, 5)).toBe('M10,15l5,5l-5,5l-5,-5z');
    const points = [{ t: 0, left: 50 }, { t: 10, left: 0 }, { t: 10, left: 100 }, { t: 20, left: 80 }];
    expect(lineValueAt(points, 10)).toBe(0);
    expect(lineValueAfter(points, 10)).toBe(100);
    expect(lineValueAfter(points, 15)).toBe(90);
    expect(lineValueAfter(points, 30)).toBeNull();
  });

  it('says what a mark is, with what it added back when the readings show it', () => {
    expect(resetMarkLine(translate, mark(0, 'used', { reset: 'weekly' }), '80%')).toBe('Used a weekly reset on cam-work ·\u00a0+80%');
    expect(resetMarkLine(translate, mark(0, 'used', { reset: 'fable' }), null)).toBe('Used a Fable reset on cam-work');
    expect(resetMarkLine(translate, mark(0, 'used'), '100%')).toBe('Used a reset on cam-work ·\u00a0+100%');
    expect(resetMarkLine(translate, mark(0, 'early'), '75%')).toBe('cam-work refilled early, with no reset on record ·\u00a0+75%');
    expect(resetMarkLine(translate, mark(0, 'planned', { reset: 'session' }), '100%')).toBe('Suggested 5-hour reset on cam-work ·\u00a0+100%');
    expect(resetMarkLine(translate, mark(0, 'planned'), '100%')).toBe('Suggested reset on cam-work ·\u00a0+100%');
  });
});

describe('forecast settings', () => {
  it('turns anything unknown into its default', () => {
    expect(forecastSettingsFrom({ forecastModel: 'bogus' as never, forecastLookbackDays: 5, forecastRatePerHour: Number.NaN, forecastResets: 'yes' as never }))
      .toEqual({ model: 'weekly', lookbackDays: 7, ratePerHour: null, countResets: false });
    expect(forecastSettingsFrom({ forecastModel: 'recent', forecastLookbackDays: 3, forecastRatePerHour: 2.5, forecastResets: true }))
      .toEqual({ model: 'recent', lookbackDays: 3, ratePerHour: 2.5, countResets: true });
  });

  it('draws as far behind now as ahead, or as far as the readings go', () => {
    const NOW = 100 * DAY;
    const since = (days: number) => [{ account: 'a', authIndex: '0', readings: [[NOW - days * DAY, 50, null] as [number, number, number | null]] }];
    expect(forecastHistoryMs(7)).toBe(7 * DAY);
    expect(forecastHistoryMs(7, since(20), NOW)).toBe(7 * DAY);
    expect(forecastHistoryMs(14, since(5), NOW)).toBe(5 * DAY);
    // A new install still draws a quarter of the horizon, and a day at least.
    expect(forecastHistoryMs(14, since(1), NOW)).toBe(3.5 * DAY);
    expect(forecastHistoryMs(1, [], NOW)).toBe(DAY);
  });
});

describe('the forecast panel', () => {
  const quota = (left: number): QuotaState => ({ status: 'success', rows: [{ label: '7-day window', remainingPercent: left, resetAtMs: Date.now() + 2 * DAY }] });

  it('sums the pool and reads its history before drawing', () => {
    const headline = buildHeadline([{ name: 'a', quota: quota(40) }, { name: 'b', quota: quota(75) }], '7-day window');
    const html = renderToStaticMarkup(
      <I18nProvider>
        <LimitForecastPanel provider="claude" providerName="Claude" headline={headline} resettable={() => false} />
      </I18nProvider>,
    );
    expect(text(html)).toContain('115% / 200% left');
    expect(text(html)).toContain('Reading limit history…');
    expect(html).toContain('aria-expanded="true"');
  });

  it('stays away without a headline window', () => {
    const headline = buildHeadline([{ name: 'a', quota: quota(40) }], null);
    expect(renderToStaticMarkup(
      <I18nProvider><LimitForecastPanel provider="claude" providerName="Claude" headline={headline} resettable={() => false} /></I18nProvider>,
    )).toBe('');
  });
});

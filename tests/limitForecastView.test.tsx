import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LimitForecastPanel } from '../src/components/LimitForecastPanel';
import { I18nProvider } from '../src/i18n';
import { buildHeadline } from '../src/services/accountLimits';
import { dayTicks, dryStretches, groupHours, heldValueAt, lineValueAt, stepLine } from '../src/services/forecastChart';
import { forecastHistoryMs, forecastSettingsFrom } from '../src/services/limitForecastView';
import type { QuotaState } from '../src/services/quotaService';
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

describe('forecast settings', () => {
  it('turns anything unknown into its default', () => {
    expect(forecastSettingsFrom({ forecastModel: 'bogus' as never, forecastLookbackDays: 5, forecastRatePerHour: Number.NaN, forecastResets: 'yes' as never }))
      .toEqual({ model: 'weekly', lookbackDays: 7, ratePerHour: null, countResets: false });
    expect(forecastSettingsFrom({ forecastModel: 'recent', forecastLookbackDays: 3, forecastRatePerHour: 2.5, forecastResets: true }))
      .toEqual({ model: 'recent', lookbackDays: 3, ratePerHour: 2.5, countResets: true });
  });

  it('draws a quarter of the horizon behind now, a day to a week', () => {
    expect(forecastHistoryMs(1)).toBe(DAY);
    expect(forecastHistoryMs(7)).toBe(1.75 * DAY);
    expect(forecastHistoryMs(14)).toBe(3.5 * DAY);
  });
});

describe('the forecast panel', () => {
  const quota = (left: number): QuotaState => ({ status: 'success', rows: [{ label: '7-day window', remainingPercent: left, resetAtMs: Date.now() + 2 * DAY }] });

  it('sums the pool and reads its history before drawing', () => {
    const headline = buildHeadline([{ name: 'a', quota: quota(40) }, { name: 'b', quota: quota(75) }], '7-day window');
    const html = renderToStaticMarkup(
      <I18nProvider>
        <LimitForecastPanel provider="claude" providerName="Claude" headline={headline} resettable={new Set()} />
      </I18nProvider>,
    );
    expect(text(html)).toContain('115% / 200% left');
    expect(text(html)).toContain('Reading limit history…');
    expect(html).toContain('aria-expanded="true"');
  });

  it('stays away without a headline window', () => {
    const headline = buildHeadline([{ name: 'a', quota: quota(40) }], null);
    expect(renderToStaticMarkup(
      <I18nProvider><LimitForecastPanel provider="claude" providerName="Claude" headline={headline} resettable={new Set()} /></I18nProvider>,
    )).toBe('');
  });
});

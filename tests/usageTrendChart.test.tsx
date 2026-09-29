import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { UsageStorageSection } from '../src/pages/UsageStorageSection';
import { UsageTrendSection } from '../src/pages/UsageTrendChart';
import type { UsageTimelinePoint } from '../src/native/types';

const HOUR = 3_600_000;
const end = new Date(2026, 0, 14, 14, 17);
const lastDay = { start: new Date(end.getTime() - 24 * HOUR).toISOString(), end: end.toISOString() };
const point = (hour: string, requests: number, tokens: number): UsageTimelinePoint => ({
  hour,
  firstTimestampMs: null,
  requests,
  success: requests,
  failure: 0,
  canceled: 0,
  tokens,
});

const renderTrend = (timeline: UsageTimelinePoint[], range: { start?: string; end?: string }) =>
  renderToStaticMarkup(
    <I18nProvider>
      <UsageTrendSection timeline={timeline} range={range} empty={<p>no-usage</p>} />
    </I18nProvider>,
  );

describe('usage trend section', () => {
  it('is titled after both series and says how the range is grouped', () => {
    const html = renderTrend([point('2026-01-14-09', 2, 1_000), point('2026-01-14-13', 3, 1_200)], lastDay);
    expect(html).toContain('Token and request trend');
    expect(html).toContain('Grouped by hour, in local time');
    expect(html).toContain('Tokens');
    expect(html).toContain('Requests');
    // The screen-reader summary totals the whole range, not only the visible buckets.
    expect(html).toContain('2,200 tokens and 5 requests in total.');
    expect(html).not.toContain('no-usage');
  });

  it('groups longer ranges into days', () => {
    const range = { start: new Date(end.getTime() - 30 * 24 * HOUR).toISOString(), end: end.toISOString() };
    const html = renderTrend([point('2025-12-20-10', 1, 10), point('2026-01-14-13', 3, 1_200)], range);
    expect(html).toContain('Grouped by day, in local time');
    expect(html).toContain('1,210 tokens and 4 requests in total.');
  });

  it('shows the empty state when the range has no traffic', () => {
    expect(renderTrend([], lastDay)).toContain('no-usage');
    // An hour outside the range does not count as traffic.
    expect(renderTrend([point('2026-01-10-10', 4, 400)], lastDay)).toContain('no-usage');
  });
});

describe('usage storage section', () => {
  it('holds its controls until the storage details load', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <UsageStorageSection />
      </I18nProvider>,
    );
    expect(html).toContain('Storage');
    expect(html).toContain('Retention');
    expect(html).toContain('Compact database');
    const compactButton = html.match(/<button(?:(?!<button)[\s\S])*?Compact<\/button>/)?.[0] ?? '';
    expect(compactButton).toContain('disabled=""');
  });
});

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { failedRequestsView, usageView, type UsageParams } from '../src/navigation';
import { UsageRecordsPage } from '../src/pages/UsageRecordsPage';

/** Usage as a view opens it, before anything has loaded. */
const page = (params: UsageParams) => renderToStaticMarkup(<I18nProvider><UsageRecordsPage variant="usage" params={params} /></I18nProvider>);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const breadcrumb = (html: string) => text(html.match(/<h1[^>]*>(.*?)<\/h1>/)?.[1] ?? '');
/** The All / Failed toggle's buttons, by their words, with whether each is pressed. */
const toggles = (html: string) =>
  [...html.matchAll(/<button[^>]*data-slot="toggle"[^>]*>(.*?)<\/button>/g)].map((match) => [text(match[1] ?? ''), /aria-pressed="true"/.test(match[0])]);
const paramsOf = (view: ReturnType<typeof usageView>): UsageParams => (view.kind === 'main' && view.page === 'usage' ? view.params ?? {} : {});

describe('Usage’s Requests with Failed on or off', () => {
  test('has an All / Failed toggle in its filters, on All for every request', () => {
    const html = page({ tab: 'events' });
    expect(breadcrumb(html)).toBe('Usage / Requests / All machines');
    expect(toggles(html)).toEqual([['All', true], ['Failed', false]]);
    expect(html).toMatch(/role="group"[^>]*aria-label="Requests to show"/);
  });

  test('opens on Failed from the old Failures view, which stays Requests in the top bar, with no Result chip beside it', () => {
    const html = page(paramsOf(failedRequestsView()));
    expect(breadcrumb(html)).toBe('Usage / Requests / All machines');
    expect(toggles(html)).toEqual([['All', false], ['Failed', true]]);
    // The toggle says Failed; a chip saying Result: Failed as well would say it twice.
    expect(text(html)).not.toContain('Request result Failed');
    expect(text(html)).toContain('Last 24 hours Filters');
  });

  test('leaves the toggle off Overview, where the Result filter is only in Filters', () => {
    const html = page({ tab: 'overview', result: 'failed' });
    expect(toggles(html)).toEqual([]);
    expect(text(html)).toContain('Filters 1 Request result Failed Clear all');
  });
});

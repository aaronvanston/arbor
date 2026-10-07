import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoreRuntimeProvider } from '../src/coreRuntime';
import { I18nProvider, translate } from '../src/i18n';
import { UsageCollectorBanner } from '../src/components/UsageCollectorBanner';
import { UsageCollectorSection } from '../src/pages/UsageCollectorSection';
import { collectorDisplay, collectorProblem, lastCollectedMs } from '../src/services/usageCollector';

describe('usage collector status', () => {
  test('each state has its own pill; no answer yet reads as waiting', () => {
    expect(collectorDisplay({ state: 'collecting' })).toEqual({ tone: 'success', labelKey: 'usage.collector.collecting' });
    expect(collectorDisplay({ state: 'error' })).toEqual({ tone: 'error', labelKey: 'usage.collector.error' });
    expect(collectorDisplay({ state: 'waiting-core' })).toEqual({ tone: 'warning', labelKey: 'usage.collector.waiting' });
    expect(collectorDisplay(null)).toEqual({ tone: 'warning', labelKey: 'usage.collector.waiting' });
  });

  // system-17: with no core installed there's nothing to wait for, so it says so and where to install one.
  test('says there is no core rather than waiting for one', () => {
    expect(collectorDisplay({ state: 'waiting-core' }, true)).toEqual({ tone: 'warning', labelKey: 'usage.collector.noCore', noteKey: 'usage.collector.noCoreNote' });
    expect(collectorDisplay({ state: 'collecting' }, true).labelKey).toBe('usage.collector.collecting');
  });

  test('the last record time is read only when there is one', () => {
    expect(lastCollectedMs({ lastCollectedAt: '2026-09-25T10:00:00.000Z' })).toBe(Date.parse('2026-09-25T10:00:00.000Z'));
    expect(lastCollectedMs({ lastCollectedAt: null })).toBeNull();
    expect(lastCollectedMs({ lastCollectedAt: 'yesterday' })).toBeNull();
    expect(lastCollectedMs(null)).toBeNull();
  });

  test('Settings › Data shows the collection section, before its first answer as loading', () => {
    const html = renderToStaticMarkup(<I18nProvider><CoreRuntimeProvider><UsageCollectorSection /></CoreRuntimeProvider></I18nProvider>);
    expect(html).toContain('Collection');
    expect(html).toContain('Status');
    expect(html).toContain('data-slot="skeleton"');
  });

  test('the usage pages’ banner stays away until the collector reports an error', () => {
    const html = renderToStaticMarkup(<I18nProvider><UsageCollectorBanner onOpenData={() => {}} /></I18nProvider>);
    expect(html).toBe('');
  });

  test('a failure reads as the core’s answer, in plain words', () => {
    const t = (key: Parameters<typeof translate>[0], variables?: Parameters<typeof translate>[1]) => translate(key, variables, {});
    expect(collectorProblem('Core usage queue returned HTTP 401: invalid management key', t))
      .toBe('The core didn’t accept Arbor’s management key. Restart the core, then try again.');
    expect(collectorProblem('Failed to read core usage queue: database is locked', t)).toBe('Arbor’s records were busy. Try again in a moment.');
  });
});

import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { CallStats, ProblemTable, Problems } from '../src/pages/DiagnosticsSettings';
import { problemGroups, summarizeCalls } from '../src/services/callDiagnostics';
import type { CallDiagnostics, DiagnosticCall } from '../src/native/types';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const NOW = Date.now();
const MINUTE = 60_000;
const call = (fields: Partial<DiagnosticCall> = {}): DiagnosticCall => ({
  atMs: NOW - MINUTE, kind: 'machine', target: 'ci-01', operation: 'health check', durationMs: 900, code: 0, outcome: 'ok',
  slowAfterMs: 10_000, slow: false, ...fields,
});
const calls = [
  call({ atMs: NOW - 3 * MINUTE, durationMs: 850 }),
  call({ atMs: NOW - 2 * MINUTE, durationMs: 12_400, slow: true }),
  call({ atMs: NOW - 4 * MINUTE, outcome: 'failed', code: 255, durationMs: 5_040 }),
  call({ kind: 'core', target: 'core', operation: 'POST /api-call', outcome: 'failed', code: 502, durationMs: 2_300, slowAfterMs: 10_000, atMs: NOW - 10 * MINUTE }),
  call({ kind: 'core', target: 'core', operation: 'GET /usage-queue', outcome: 'timedOut', code: null, durationMs: 30_000, slowAfterMs: 3_000, atMs: NOW - 90 * MINUTE }),
  call({ target: 'cedar-02', durationMs: 310 }),
];
const data: CallDiagnostics = { calls, keepDays: 7, maxCalls: 2_000, machineSlowMs: 10_000, coreSlowMs: 3_000, clearedAtMs: null };

describe('Settings › Diagnostics', () => {
  it('lists each machine and core operation with a problem, what went wrong last and how long its calls take', () => {
    const html = renderToStaticMarkup(<I18nProvider><ProblemTable groups={problemGroups(calls)} now={NOW} /></I18nProvider>);
    const rows = [...html.matchAll(/<tr[^>]*data-group[^>]*>(.*?)<\/tr>/g)].map((match) => text(match[1] ?? ''));
    expect(rows).toEqual([
      'ci-01 health check 3 1 1 5s 12s Slow · 2m ago',
      'Core POST /api-call 1 1 — 2.3s 2.3s HTTP 502 · 10m ago',
      'Core GET /usage-queue 1 1 — 30s 30s Timed out · 1h ago',
    ]);
    // A machine that only went fine isn't listed.
    expect(html).not.toContain('cedar-02');
    expect(html).toContain('title="1 timed out"');
    expect(html).toContain('title="Slow past 10s"');
  });

  it('says the failures can’t be shown until the calls are read, rather than leaving the section empty', () => {
    const problems = (props: Parameters<typeof Problems>[0]) => text(renderToStaticMarkup(<I18nProvider><Problems {...props} /></I18nProvider>));
    expect(problems({ data: null, loadFailed: true, now: NOW })).toBe('Nothing to show until the calls can be read.');
    expect(problems({ data: null, loadFailed: false, now: NOW })).toBe('');
    expect(problems({ data: { ...data, calls: [] }, loadFailed: false, now: NOW })).toContain('No calls yet');
    expect(problems({ data: { ...data, calls: [call()] }, loadFailed: false, now: NOW })).toContain('No failures or slow calls');
    expect(problems({ data, loadFailed: true, now: NOW })).toContain('ci-01 health check');
  });

  it('sums up the calls and says when they are slow', () => {
    const html = text(renderToStaticMarkup(<I18nProvider><CallStats data={data} summary={summarizeCalls(calls)} loading={false} now={NOW} /></I18nProvider>));
    expect(html).toContain('Calls 6');
    expect(html).toContain('Failed 3 1 timed out');
    expect(html).toContain('Slow 1 Over 10s on a machine, 3s for the core');
  });
});

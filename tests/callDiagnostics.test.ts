import { describe, expect, it } from 'bun:test';
import { en } from '../src/i18n/locales/en';
import {
  clearBlockedReason,
  groupCalls,
  isProblem,
  percentile,
  problemGroups,
  problemText,
  summarizeCalls,
} from '../src/services/callDiagnostics';
import { itemAt, present } from './support/items';
import type { DiagnosticCall } from '../src/native/types';

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

const call = (fields: Partial<DiagnosticCall> = {}): DiagnosticCall => ({
  atMs: NOW - MINUTE,
  kind: 'machine',
  target: 'ci-01',
  operation: 'health check',
  durationMs: 400,
  code: 0,
  outcome: 'ok',
  slowAfterMs: 10_000,
  slow: false,
  ...fields,
});

describe('call diagnostics', () => {
  it('takes the nearest-rank percentile', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    const twenty = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(percentile(twenty, 50)).toBe(10);
    expect(percentile(twenty, 95)).toBe(19);
    expect(percentile(twenty, 100)).toBe(20);
    expect(percentile(twenty, 0)).toBe(1);
  });

  it('groups calls by where they went and what for, with counts and percentiles over every call', () => {
    const calls = [
      // ci-01's health checks: 18 fine, one slow, one that couldn't connect.
      ...Array.from({ length: 18 }, (_, index) => call({ atMs: NOW - (index + 3) * MINUTE, durationMs: 800 + index * 10 })),
      call({ atMs: NOW - 2 * MINUTE, durationMs: 12_500, slow: true }),
      call({ atMs: NOW - MINUTE, durationMs: 5_000, outcome: 'failed', code: 255 }),
      // The same operation on another machine is its own group.
      call({ target: 'cedar-02', durationMs: 300 }),
      // So is the core, even with the same target name.
      call({ kind: 'core', target: 'core', operation: 'GET /auth-files', code: 200, slowAfterMs: 3_000, atMs: NOW - 30 * MINUTE }),
      call({ kind: 'core', target: 'core', operation: 'GET /auth-files', code: null, outcome: 'timedOut', durationMs: 30_000, slowAfterMs: 3_000, atMs: NOW - 20 * MINUTE }),
    ];
    const groups = groupCalls(calls);
    expect(groups.map((group) => `${group.kind} ${group.target} ${group.operation}`)).toEqual([
      // The latest problem first, then the groups that went fine.
      'machine ci-01 health check',
      'core core GET /auth-files',
      'machine cedar-02 health check',
    ]);
    const ci = itemAt(groups, 0);
    expect({ calls: ci.calls, failed: ci.failed, timedOut: ci.timedOut, slow: ci.slow }).toEqual({ calls: 20, failed: 1, timedOut: 0, slow: 1 });
    // Over all twenty, not only the problems: the middle of the fine ones, and the slow one at the top.
    expect(ci.p50Ms).toBe(890);
    expect(ci.p95Ms).toBe(5_000);
    expect(present(ci.lastProblem).code).toBe(255);
    expect(ci.lastSeenMs).toBe(NOW - MINUTE);
    expect(ci.slowAfterMs).toBe(10_000);
    const core = itemAt(groups, 1);
    expect({ failed: core.failed, timedOut: core.timedOut, slow: core.slow }).toEqual({ failed: 1, timedOut: 1, slow: 0 });
    expect(itemAt(groups, 2).lastProblem).toBeNull();

    expect(problemGroups(calls).map((group) => group.target)).toEqual(['ci-01', 'core']);
    expect(problemGroups([call(), call({ target: 'cedar-02' })])).toEqual([]);
  });

  it('orders the groups that went fine by their latest call', () => {
    const groups = groupCalls([call({ target: 'a', atMs: NOW - 5 * MINUTE }), call({ target: 'b', atMs: NOW - MINUTE })]);
    expect(groups.map((group) => group.target)).toEqual(['b', 'a']);
  });

  it('sums up the calls kept', () => {
    expect(summarizeCalls([])).toEqual({ calls: 0, failed: 0, timedOut: 0, slow: 0, sinceMs: null });
    const summary = summarizeCalls([
      call({ atMs: NOW - 3 * MINUTE }),
      call({ slow: true, durationMs: 11_000 }),
      call({ outcome: 'timedOut', code: null }),
      call({ outcome: 'failed', code: 1, atMs: NOW - 10 * MINUTE }),
    ]);
    expect(summary).toEqual({ calls: 4, failed: 2, timedOut: 1, slow: 1, sinceMs: NOW - 10 * MINUTE });
  });

  it('says what went wrong with a call in a word or two', () => {
    const says = (fields: Partial<DiagnosticCall>) => {
      const text = problemText(call(fields));
      return text ? en[text.key].replace('{code}', String(text.variables?.code)) : null;
    };
    expect(says({})).toBeNull();
    expect(says({ slow: true, durationMs: 12_000 })).toBe('Slow');
    expect(says({ outcome: 'timedOut', code: null })).toBe('Timed out');
    expect(says({ outcome: 'failed', code: 255 })).toBe('Exit 255');
    expect(says({ outcome: 'failed', code: null })).toBe('Didn’t run');
    expect(says({ kind: 'core', outcome: 'failed', code: 502 })).toBe('HTTP 502');
    expect(says({ kind: 'core', outcome: 'failed', code: null })).toBe('No answer');
    expect(isProblem(call())).toBe(false);
    expect(isProblem(call({ slow: true }))).toBe(true);
  });

  it('says why Clear can’t be pressed whenever it can’t', () => {
    const says = (calls: DiagnosticCall[] | null, loadFailed: boolean) => {
      const key = clearBlockedReason(calls ? summarizeCalls(calls) : null, loadFailed);
      return key ? en[key] : null;
    };
    expect(says(null, false)).toBe('The calls are still being read.');
    expect(says(null, true)).toBe('The calls couldn’t be read, so there’s nothing to clear yet.');
    expect(says([], false)).toBe('There are no calls to clear.');
    expect(says([call()], false)).toBeNull();
    // A later refresh that fails leaves the calls already read to clear.
    expect(says([call()], true)).toBeNull();
  });
});

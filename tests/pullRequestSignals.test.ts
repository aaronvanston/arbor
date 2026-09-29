import { describe, expect, test } from 'bun:test';
import { translate } from '../src/i18n';
import { pullRequestChecksState, pullRequestSignals, pullRequestSignalsText } from '../src/services/pullRequestSignals';
import type { PullRequestChecks, PullRequestState } from '../src/native/types';

const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);

const checks = (fields: Partial<PullRequestChecks>): PullRequestChecks => ({ rollup: '', passed: 0, failed: 0, pending: 0, total: 0, ...fields });

const github = (fields: Partial<PullRequestState> = {}): PullRequestState => ({
  state: 'open', draft: false, title: 'Token bucket rate limiter', baseBranch: 'main', mergedAtMs: null, closedAtMs: null,
  mergeable: 'mergeable', review: '', checks: null, checkedAtMs: 1,
  ...fields,
});

const kinds = (state: PullRequestState | null) => pullRequestSignals(state, t).map((signal) => signal.kind);

describe('how a pull request’s checks read together', () => {
  test('failing beats pending beats passing', () => {
    expect(pullRequestChecksState(checks({ rollup: 'pending', passed: 5, failed: 1, pending: 2, total: 8 }))).toBe('failing');
    expect(pullRequestChecksState(checks({ rollup: 'pending', passed: 5, pending: 2, total: 7 }))).toBe('pending');
    expect(pullRequestChecksState(checks({ rollup: 'success', passed: 5, total: 7 }))).toBe('passing');
  });

  test('no checks, or only skipped and neutral ones, show nothing', () => {
    expect(pullRequestChecksState(null)).toBeNull();
    expect(pullRequestChecksState(checks({ rollup: 'success', total: 3 }))).toBeNull();
  });

  test('without counts, GitHub’s own word ranks them the same way', () => {
    expect(pullRequestChecksState(checks({ rollup: 'error' }))).toBe('failing');
    expect(pullRequestChecksState(checks({ rollup: 'failure' }))).toBe('failing');
    expect(pullRequestChecksState(checks({ rollup: 'expected' }))).toBe('pending');
    expect(pullRequestChecksState(checks({ rollup: 'pending' }))).toBe('pending');
    expect(pullRequestChecksState(checks({ rollup: 'success' }))).toBe('passing');
    expect(pullRequestChecksState(checks({}))).toBeNull();
  });
});

describe('what shows beside a pull request', () => {
  test('checks, then the review verdict, then conflicts, each with its own label', () => {
    const signals = pullRequestSignals(github({
      review: 'changesRequested',
      mergeable: 'conflicting',
      checks: checks({ rollup: 'failure', passed: 4, failed: 1, pending: 1, total: 7 }),
    }), t);
    expect(signals).toEqual([
      { kind: 'failing', tone: 'error', label: 'Some checks failed', detail: '1 failed, 1 pending, 4 passed' },
      { kind: 'changesRequested', tone: 'warning', label: 'Changes requested', detail: '' },
      { kind: 'conflicting', tone: 'error', label: 'Conflicts with main', detail: '' },
    ]);
    expect(pullRequestSignalsText(signals)).toBe('Some checks failed (1 failed, 1 pending, 4 passed) · Changes requested · Conflicts with main');
  });

  test('each review verdict and checks state has its own look', () => {
    const one = (fields: Partial<PullRequestState>) => pullRequestSignals(github(fields), t)[0];
    expect(one({ review: 'approved' })).toMatchObject({ kind: 'approved', tone: 'success', label: 'Approved' });
    expect(one({ review: 'reviewRequired' })).toMatchObject({ kind: 'reviewRequired', tone: 'muted', label: 'Review required' });
    expect(one({ checks: checks({ rollup: 'pending', passed: 5, pending: 2, total: 7 }) }))
      .toMatchObject({ kind: 'pending', tone: 'warning', label: 'Some checks haven’t finished', detail: '2 pending, 5 passed' });
    expect(one({ checks: checks({ rollup: 'success' }) })).toMatchObject({ kind: 'passing', tone: 'success', label: 'All checks passed', detail: '' });
    expect(one({ mergeable: 'conflicting', baseBranch: '' })).toMatchObject({ kind: 'conflicting', label: 'Has merge conflicts' });
  });

  test('nothing when there’s nothing to say', () => {
    expect(kinds(github())).toEqual([]);
    expect(kinds(null)).toEqual([]);
    expect(pullRequestSignalsText([])).toBe('');
  });

  test('a merged or closed one is settled, so what’s on record about it isn’t shown', () => {
    const stale = { review: 'approved', mergeable: 'conflicting', checks: checks({ rollup: 'failure', failed: 1, total: 1 }) } as const;
    expect(kinds(github({ ...stale, state: 'merged' }))).toEqual([]);
    expect(kinds(github({ ...stale, state: 'closed' }))).toEqual([]);
    expect(kinds(github({ ...stale, state: '' }))).toEqual([]);
  });

  test('a draft shows its checks and any verdict given, but not a review it doesn’t need yet or conflicts', () => {
    const draft = { draft: true, mergeable: 'conflicting', checks: checks({ rollup: 'failure', failed: 1, total: 1 }) } as const;
    expect(kinds(github({ ...draft, review: 'reviewRequired' }))).toEqual(['failing']);
    expect(kinds(github({ ...draft, review: 'changesRequested' }))).toEqual(['failing', 'changesRequested']);
  });
});

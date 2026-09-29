import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { PullRequestSignals, PullRequestStateBadge } from '../src/components/PullRequestSignals';
import type { PullRequestState } from '../src/native/types';

const github = (fields: Partial<PullRequestState> = {}): PullRequestState => ({
  state: 'open', draft: false, title: 'Token bucket rate limiter', baseBranch: 'main', mergedAtMs: null, closedAtMs: null,
  mergeable: '', review: '', checks: null, checkedAtMs: 1,
  ...fields,
});

const markup = (state: PullRequestState | null) => renderToStaticMarkup(
  <I18nProvider>
    <PullRequestStateBadge github={state} />
    <PullRequestSignals github={state} />
  </I18nProvider>,
);
const text = (state: PullRequestState | null) => markup(state).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('a pull request’s badge and signals, as a session’s page shows them', () => {
  test('an open one names each signal for screen readers', () => {
    const page = markup(github({
      review: 'reviewRequired',
      mergeable: 'conflicting',
      checks: { rollup: 'pending', passed: 5, failed: 0, pending: 2, total: 7 },
    }));
    expect(text(github())).toBe('Open');
    expect(page).toContain('aria-label="Some checks haven’t finished: 2 pending, 5 passed"');
    expect(page).toContain('aria-label="Review required"');
    expect(page).toContain('aria-label="Conflicts with main"');
  });

  test('a draft keeps its checks but drops the review it doesn’t need yet and its conflicts', () => {
    const page = markup(github({
      draft: true,
      review: 'reviewRequired',
      mergeable: 'conflicting',
      checks: { rollup: 'failure', passed: 6, failed: 2, pending: 0, total: 9 },
    }));
    expect(text(github({ draft: true }))).toBe('Draft');
    expect(page).toContain('aria-label="Some checks failed: 2 failed, 6 passed"');
    expect(page).not.toContain('Review required');
    expect(page).not.toContain('Conflicts with');
  });

  test('a merged one shows only its badge', () => {
    const page = markup(github({ state: 'merged', mergedAtMs: 1, review: 'approved', checks: { rollup: 'success', passed: 9, failed: 0, pending: 0, total: 9 } }));
    expect(page).not.toContain('role="img"');
  });

  test('without checks there’s no checks icon', () => {
    const page = markup(github({ review: 'approved', mergeable: 'mergeable' }));
    expect(page.match(/role="img"/g)).toHaveLength(1);
    expect(page).toContain('aria-label="Approved"');
  });

  test('before GitHub has been asked, it says so and shows no signals', () => {
    expect(text(null)).toBe('Not checked');
    expect(markup(null)).not.toContain('role="img"');
  });
});

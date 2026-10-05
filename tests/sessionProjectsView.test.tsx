import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { SessionProjectsView } from '../src/pages/SessionProjectsView';
import type {
  GithubStatus,
  ProjectPullRequest,
  ProjectTotals,
  PullRequestState,
  SessionProjectsReport,
} from '../src/native/types';

const totals = (fields: Partial<ProjectTotals> = {}): ProjectTotals => ({
  sessions: 2, active: 0, requests: 40, totalTokens: 1_000, estimatedCost: 0, pricedRequests: 0,
  linesAdded: 0, linesRemoved: 0, sessionsWithLines: 0, lastActiveAtMs: 1,
  ...fields,
});

const pullRequest = (
  number: number,
  state: 'merged' | 'open',
  fields: Partial<ProjectPullRequest> = {},
  github: Partial<PullRequestState> = {},
): ProjectPullRequest => ({
  repository: 'acme/arbor', number, url: `https://github.com/acme/arbor/pull/${number}`, project: 'arbor', branch: `fix/${number}`,
  sessions: 1, estimatedCost: 0, pricedRequests: 0, linesAdded: 0, linesRemoved: 0, lastActiveAtMs: 1,
  github: {
    state, draft: false, title: `Change ${number}`, baseBranch: 'main', mergedAtMs: state === 'merged' ? 1 : null, closedAtMs: null,
    mergeable: '', review: '', checks: null, checkedAtMs: 1, ...github,
  },
  ...fields,
});

const report = (pullRequests: ProjectPullRequest[], github: Partial<GithubStatus> = {}): SessionProjectsReport => ({
  projects: [{ name: 'arbor', repository: 'acme/arbor', branches: [], ...totals() }],
  pullRequests,
  unplaced: totals({ sessions: 0, requests: 0 }),
  github: { checking: false, last: 'ok', message: '', detailError: '', atMs: 1, ...github },
});

const markup = (value: SessionProjectsReport) => renderToStaticMarkup(
  <I18nProvider>
    <SessionProjectsView report={value} onOpenSessions={() => {}} onCheckGithub={() => {}} />
  </I18nProvider>,
);
const render = (value: SessionProjectsReport) => markup(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the Projects view', () => {
  test('with nothing priced, pull request costs read as unknown rather than free', () => {
    const page = render(report([pullRequest(412, 'open'), pullRequest(57, 'open')]));
    expect(page).toContain('Cost per PR unpriced No prices for these models');
    expect(page).not.toContain('$0.00');
  });

  test('merged pull requests without a price read as unknown too', () => {
    const page = render(report([pullRequest(412, 'merged'), pullRequest(57, 'open', { estimatedCost: 3, pricedRequests: 4 })]));
    expect(page).toContain('Cost per merged PR unpriced No prices for these models');
    expect(page).toContain('$3.00');
  });

  test('a priced pull request keeps its cost', () => {
    const page = render(report([pullRequest(412, 'merged', { estimatedCost: 6, pricedRequests: 4 })]));
    expect(page).toContain('Cost per merged PR $6.00 $6.00 for 1 merged');
  });

  test('an open pull request says how its checks, review and merge stand; a merged one doesn’t', () => {
    const standing = {
      review: 'changesRequested',
      mergeable: 'conflicting',
      checks: { rollup: 'failure', passed: 4, failed: 1, pending: 1, total: 7 },
    } as const;
    const page = markup(report([pullRequest(57, 'open', {}, standing), pullRequest(412, 'merged', {}, standing)]));
    expect(page).toContain('aria-label="Some checks failed: 1 failed, 1 pending, 4 passed"');
    expect(page).toContain('aria-label="Conflicts with main"');
    expect(page.match(/aria-label="Changes requested"/g)).toHaveLength(1);
  });

  test('when GitHub turns down asking how they stand, the note says so and offers a retry', () => {
    const page = render(report([pullRequest(57, 'open')], { detailError: 'Field doesn’t exist' }));
    expect(page).toContain('GitHub said which pull requests merged, but not how open ones’ checks and reviews stand. Field doesn’t exist.');
    expect(page).toContain('Retry');
  });
});

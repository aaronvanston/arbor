import { describe, expect, test } from 'bun:test';
import { translate } from '../src/i18n';
import {
  branchPullRequests,
  githubNote,
  projectsTotals,
  pullRequestsHint,
  pullRequestStatus,
  summarizePullRequests,
} from '../src/services/sessionProjects';
import type { ProjectPullRequest, ProjectTotals, PullRequestState, SessionProjectsReport } from '../src/native/types';

const github = (state: PullRequestState['state'], draft = false): PullRequestState => ({
  state,
  draft,
  title: '',
  baseBranch: 'main',
  mergedAtMs: state === 'merged' ? 1 : null,
  closedAtMs: state === 'merged' || state === 'closed' ? 1 : null,
  mergeable: '',
  review: '',
  checks: null,
  checkedAtMs: 1,
});

const pullRequest = (number: number, estimatedCost: number, state: PullRequestState | null, fields: Partial<ProjectPullRequest> = {}): ProjectPullRequest => ({
  repository: 'acme/arbor',
  number,
  url: `https://github.com/acme/arbor/pull/${number}`,
  project: 'arbor',
  branch: `branch-${number}`,
  sessions: 1,
  estimatedCost,
  pricedRequests: 1,
  linesAdded: 0,
  linesRemoved: 0,
  lastActiveAtMs: 1,
  github: state,
  ...fields,
});

const totals = (fields: Partial<ProjectTotals> = {}): ProjectTotals => ({
  sessions: 0,
  active: 0,
  requests: 0,
  totalTokens: 0,
  estimatedCost: 0,
  pricedRequests: 0,
  linesAdded: 0,
  linesRemoved: 0,
  sessionsWithLines: 0,
  lastActiveAtMs: 0,
  ...fields,
});

describe('pull request states', () => {
  test('drafts get their own badge, and a pull request GitHub has not answered for is unchecked', () => {
    expect(pullRequestStatus(pullRequest(1, 0, github('merged')))).toBe('merged');
    expect(pullRequestStatus(pullRequest(1, 0, github('open')))).toBe('open');
    expect(pullRequestStatus(pullRequest(1, 0, github('open', true)))).toBe('draft');
    expect(pullRequestStatus(pullRequest(1, 0, github('closed')))).toBe('closed');
    expect(pullRequestStatus(pullRequest(1, 0, github('')))).toBe('unknown');
    expect(pullRequestStatus(pullRequest(1, 0, null))).toBe('unchecked');
  });

  test('a merged pull request costs what its merged ones cost on average', () => {
    const summary = summarizePullRequests([
      pullRequest(1, 6, github('merged')),
      pullRequest(2, 2, github('merged')),
      pullRequest(3, 10, github('open', true)),
      pullRequest(4, 1, github('closed')),
      pullRequest(5, 1, null),
    ]);
    expect(summary).toEqual({
      total: 5,
      merged: 2,
      open: 1,
      closed: 1,
      unknown: 1,
      cost: 20,
      mergedCost: 8,
      priced: 5,
      pricedMerged: 2,
      costPerMerged: 4,
      costPerPullRequest: 4,
    });
  });

  test('before any has merged, only the cost per pull request is known', () => {
    const summary = summarizePullRequests([pullRequest(1, 3, null), pullRequest(2, 1, github('open'))]);
    expect(summary.costPerMerged).toBeNull();
    expect(summary.costPerPullRequest).toBe(2);
    expect(summarizePullRequests([]).costPerPullRequest).toBeNull();
  });

  test('pull requests without a priced request are counted apart, so their cost can read as unknown', () => {
    const summary = summarizePullRequests([
      pullRequest(1, 0, github('merged'), { pricedRequests: 0 }),
      pullRequest(2, 0, github('open'), { pricedRequests: 0 }),
      pullRequest(3, 2, github('open')),
    ]);
    expect([summary.priced, summary.pricedMerged]).toEqual([1, 0]);
    expect(summarizePullRequests([pullRequest(1, 0, github('merged'), { pricedRequests: 0 })]).priced).toBe(0);
  });
});

describe('projects', () => {
  test('the totals count the sessions without a project too', () => {
    const report: SessionProjectsReport = {
      projects: [
        { name: 'arbor', repository: 'acme/arbor', branches: [], ...totals({ sessions: 3, linesAdded: 250, linesRemoved: 45, sessionsWithLines: 2 }) },
        { name: 'proxy', repository: null, branches: [], ...totals({ sessions: 1 }) },
      ],
      pullRequests: [],
      unplaced: totals({ sessions: 2 }),
      github: { checking: false, last: '', message: '', detailError: '', atMs: null },
    };
    expect(projectsTotals(report)).toEqual({ sessions: 6, linesAdded: 250, linesRemoved: 45, sessionsWithLines: 2 });
  });

  test('a branch lists the pull requests that came from it in its own project', () => {
    const pullRequests = [
      pullRequest(1, 0, null, { branch: 'fix/login-loop' }),
      pullRequest(2, 0, null, { branch: 'fix/login-loop', project: 'proxy', repository: 'acme/proxy' }),
      pullRequest(3, 0, null, { branch: 'main' }),
    ];
    expect(branchPullRequests(pullRequests, 'arbor', 'fix/login-loop').map((item) => item.number)).toEqual([1]);
    expect(branchPullRequests(pullRequests, 'arbor', '')).toEqual([]);
  });
});

const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);
const status = (fields: Partial<SessionProjectsReport['github']>): SessionProjectsReport['github'] => ({ checking: false, last: 'ok', message: '', detailError: '', atMs: 0, ...fields });

describe('what GitHub couldn’t say', () => {
  test('keeps GitHub’s own words for the tooltip, not the note', () => {
    const detail = githubNote(status({ detailError: "Field 'checkRunCountsByState' doesn't exist on type 'StatusCheckRollupContextConnection'" }), t);
    expect(detail?.text).toBe('GitHub said which pull requests merged, but not how open ones’ checks and reviews stand.');
    expect(detail?.detail).toContain('checkRunCountsByState');
    expect(detail?.unavailable).toBe(false);
    expect(githubNote(status({ last: 'missing' }), t)).toMatchObject({ unavailable: true });
    expect(githubNote(status({ last: 'failed', message: 'gh: network down' }), t)?.unavailable).toBe(true);
    expect(githubNote(status({}), t)).toBeNull();
  });

  test('the tile adds up to the table: closed and not known count too', () => {
    const count = (value: number) => String(value);
    expect(pullRequestsHint({ merged: 1, open: 5, closed: 1, unknown: 0 }, t, count)).toBe('1 merged · 5 open · 1 closed');
    expect(pullRequestsHint({ merged: 2, open: 0, closed: 0, unknown: 3 }, t, count)).toBe('2 merged · 0 open · 3 not known');
  });
});

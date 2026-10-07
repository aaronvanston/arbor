import type { MessageKey, MessageVariables } from '../i18n/resources';
import type { GithubStatus, ProjectPullRequest, SessionProjectsReport } from '../native/types';
import { errorWords, plainError } from './plainError';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/** A pull request's badge: GitHub's state with drafts on their own, `unknown` when GitHub couldn't find it, and `unchecked` before it's been asked. */
export type PullRequestStatus = 'merged' | 'open' | 'draft' | 'closed' | 'unknown' | 'unchecked';

export const pullRequestStatus = (pullRequest: Pick<ProjectPullRequest, 'github'>): PullRequestStatus => {
  const { github } = pullRequest;
  if (!github) return 'unchecked';
  if (github.state === 'open') return github.draft ? 'draft' : 'open';
  return github.state || 'unknown';
};

export type PullRequestSummary = {
  total: number;
  merged: number;
  /** Drafts included. */
  open: number;
  closed: number;
  /** Not asked about yet, or not found. */
  unknown: number;
  cost: number;
  mergedCost: number;
  /** The pull requests with a price. Without any, `cost` isn't known. */
  priced: number;
  /** The merged pull requests with a price. Without any, `mergedCost` isn't known. */
  pricedMerged: number;
  /** What an average merged pull request cost; null until one has merged. */
  costPerMerged: number | null;
  /** What an average pull request cost, merged or not; null without any. */
  costPerPullRequest: number | null;
};

export const summarizePullRequests = (pullRequests: ProjectPullRequest[]): PullRequestSummary => {
  const counts: Record<PullRequestStatus, number> = { merged: 0, open: 0, draft: 0, closed: 0, unknown: 0, unchecked: 0 };
  let cost = 0;
  let mergedCost = 0;
  let priced = 0;
  let pricedMerged = 0;
  for (const pullRequest of pullRequests) {
    const status = pullRequestStatus(pullRequest);
    const hasPrice = pullRequest.pricedRequests > 0;
    counts[status] += 1;
    cost += pullRequest.estimatedCost;
    priced += Number(hasPrice);
    if (status === 'merged') {
      mergedCost += pullRequest.estimatedCost;
      pricedMerged += Number(hasPrice);
    }
  }
  return {
    total: pullRequests.length,
    merged: counts.merged,
    open: counts.open + counts.draft,
    closed: counts.closed,
    unknown: counts.unknown + counts.unchecked,
    cost,
    mergedCost,
    priced,
    pricedMerged,
    costPerMerged: counts.merged ? mergedCost / counts.merged : null,
    costPerPullRequest: pullRequests.length ? cost / pullRequests.length : null,
  };
};

/** What the projects add up to, the sessions without one included. */
export const projectsTotals = (report: SessionProjectsReport) => {
  const all = [...report.projects, report.unplaced];
  const sum = (key: 'sessions' | 'linesAdded' | 'linesRemoved' | 'sessionsWithLines') => all.reduce((total, item) => total + item[key], 0);
  return {
    sessions: sum('sessions'),
    linesAdded: sum('linesAdded'),
    linesRemoved: sum('linesRemoved'),
    sessionsWithLines: sum('sessionsWithLines'),
  };
};

/** The pull requests that came from a project's branch. */
export const branchPullRequests = (pullRequests: ProjectPullRequest[], project: string, branch: string) =>
  branch ? pullRequests.filter((pullRequest) => pullRequest.project === project && pullRequest.branch === branch) : [];

/**
 * Why pull requests show no state, or no checks and reviews, when GitHub couldn't say: `text` for the page, `detail`
 * what GitHub said, for a tooltip, since its own words (a GraphQL field it doesn't have) mean nothing to most people.
 * `unavailable` when GitHub couldn't be asked at all, so no state is known.
 */
export function githubNote(github: GithubStatus, t: Translate): { text: string; detail: string; unavailable: boolean } | null {
  switch (github.last) {
    case 'missing': return { text: t('usage.projects.github.missing'), detail: '', unavailable: true };
    case 'signedOut': return { text: t('usage.projects.github.signedOut'), detail: '', unavailable: true };
    case 'failed': return { text: t('usage.projects.github.failed', { message: plainError(github.message, t) }), detail: errorWords(github.message), unavailable: true };
    case 'ok': return github.detailError ? { text: t('usage.projects.github.detailFailed'), detail: errorWords(github.detailError), unavailable: false } : null;
    default: return null;
  }
}

/** The pull requests at a glance: how many merged, are open (drafts with them) and closed, and aren't known yet. */
export function pullRequestsHint(summary: Pick<PullRequestSummary, 'merged' | 'open' | 'closed' | 'unknown'>, t: Translate, count: (value: number) => string): string {
  return [
    t('usage.projects.stat.pullRequestsMerged', { count: count(summary.merged) }),
    t('usage.projects.stat.pullRequestsOpen', { count: count(summary.open) }),
    summary.closed ? t('usage.projects.stat.pullRequestsClosed', { count: count(summary.closed) }) : '',
    summary.unknown ? t('usage.projects.stat.pullRequestsUnknown', { count: count(summary.unknown) }) : '',
  ].filter(Boolean).join(' · ');
}

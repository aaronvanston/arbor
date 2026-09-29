import type { ProjectPullRequest, SessionProjectsReport } from '../native/types';

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

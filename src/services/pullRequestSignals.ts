import type { MessageKey, MessageVariables } from '../i18n/resources';
import { formatCount } from '../lib/format';
import type { PullRequestChecks, PullRequestState } from '../native/types';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/** How a pull request's checks read together. */
export type PullRequestChecksState = 'failing' | 'pending' | 'passing';

/**
 * One failure makes them failing, else one unfinished makes them pending, else a pass makes them passing. Null
 * without checks, or with only skipped and neutral ones: showing nothing beats a tick nobody earned.
 */
export const pullRequestChecksState = (checks: PullRequestChecks | null): PullRequestChecksState | null => {
  if (!checks) return null;
  if (checks.total > 0) {
    if (checks.failed) return 'failing';
    if (checks.pending) return 'pending';
    return checks.passed ? 'passing' : null;
  }
  // Without counts, GitHub's own word, which ranks them the same way.
  switch (checks.rollup) {
    case 'failure':
    case 'error':
      return 'failing';
    case 'pending':
    case 'expected':
      return 'pending';
    case 'success':
      return 'passing';
    default:
      return null;
  }
};

export type PullRequestSignalTone = 'success' | 'warning' | 'error' | 'muted';

/** One thing worth knowing about how an open pull request stands. */
export type PullRequestSignal = {
  /** Picks its icon. */
  kind: PullRequestChecksState | 'approved' | 'changesRequested' | 'reviewRequired' | 'conflicting';
  tone: PullRequestSignalTone;
  label: string;
  /** How many checks are where, when GitHub counted them. Empty otherwise. */
  detail: string;
};

const CHECKS: Record<PullRequestChecksState, { tone: PullRequestSignalTone; label: MessageKey }> = {
  failing: { tone: 'error', label: 'usage.pullRequests.checks.failing' },
  pending: { tone: 'warning', label: 'usage.pullRequests.checks.pending' },
  passing: { tone: 'success', label: 'usage.pullRequests.checks.passing' },
};

const REVIEWS: Record<Exclude<PullRequestState['review'], ''>, { tone: PullRequestSignalTone; label: MessageKey }> = {
  approved: { tone: 'success', label: 'usage.pullRequests.review.approved' },
  changesRequested: { tone: 'warning', label: 'usage.pullRequests.review.changesRequested' },
  reviewRequired: { tone: 'muted', label: 'usage.pullRequests.review.reviewRequired' },
};

const checksDetail = (checks: PullRequestChecks, t: Translate) =>
  (
    [
      [checks.failed, 'usage.pullRequests.checks.count.failed'],
      [checks.pending, 'usage.pullRequests.checks.count.pending'],
      [checks.passed, 'usage.pullRequests.checks.count.passed'],
    ] as const
  )
    .flatMap(([count, key]) => (count ? [t(key, { count: formatCount(count) })] : []))
    .join(', ');

/**
 * What to show beside an open pull request: its checks, the verdict on its reviews, and conflicts with the branch it
 * merges into, in that order. Nothing for a merged or closed one: it's settled, and what's on record about its checks
 * is from before.
 */
export const pullRequestSignals = (github: PullRequestState | null, t: Translate): PullRequestSignal[] => {
  if (github?.state !== 'open') return [];
  const signals: PullRequestSignal[] = [];
  const checksState = pullRequestChecksState(github.checks);
  if (checksState && github.checks) {
    const { tone, label } = CHECKS[checksState];
    signals.push({ kind: checksState, tone, label: t(label), detail: checksDetail(github.checks, t) });
  }
  // A draft isn't up for review yet, so only a verdict someone gave shows on one.
  if (github.review && !(github.draft && github.review === 'reviewRequired')) {
    const { tone, label } = REVIEWS[github.review];
    signals.push({ kind: github.review, tone, label: t(label), detail: '' });
  }
  // Conflicts aren't raised on a draft: it isn't trying to merge yet.
  if (github.mergeable === 'conflicting' && !github.draft) {
    signals.push({
      kind: 'conflicting',
      tone: 'error',
      label: github.baseBranch ? t('usage.pullRequests.conflicts.withBase', { branch: github.baseBranch }) : t('usage.pullRequests.conflicts'),
      detail: '',
    });
  }
  return signals;
};

/** The signals as one line, for a tooltip that says everything about a pull request. */
export const pullRequestSignalsText = (signals: PullRequestSignal[]) =>
  signals.map((signal) => (signal.detail ? `${signal.label} (${signal.detail})` : signal.label)).join(' · ');

import { CircleCheck, CircleDot, CircleX, TriangleAlert, UserCheck, UserRound, UserRoundX, type AppIcon } from './ui/icons';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import { pullRequestSignals, type PullRequestSignal, type PullRequestSignalTone } from '../services/pullRequestSignals';
import { pullRequestStatus, type PullRequestStatus } from '../services/sessionProjects';
import { Badge, type BadgeProps } from './ui/badge';
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip';
import type { PullRequestState } from '../native/types';

/** How each state's badge looks, which a pull request's chip wears too. */
export const PULL_REQUEST_BADGES: Record<PullRequestStatus, NonNullable<BadgeProps['variant']>> = {
  merged: 'success',
  open: 'info',
  draft: 'muted',
  closed: 'error',
  unknown: 'muted',
  unchecked: 'outline',
};

const STATE_LABELS: Record<PullRequestStatus, MessageKey> = {
  merged: 'usage.pullRequests.state.merged',
  open: 'usage.pullRequests.state.open',
  draft: 'usage.pullRequests.state.draft',
  closed: 'usage.pullRequests.state.closed',
  unknown: 'usage.pullRequests.state.unknown',
  unchecked: 'usage.pullRequests.state.unchecked',
};

/** A pull request's state on GitHub as a badge. One GitHub couldn't find says why in a tooltip. */
export function PullRequestStateBadge({ github }: { github: PullRequestState | null }) {
  const { t } = useI18n();
  const status = pullRequestStatus({ github });
  const badge = <Badge variant={PULL_REQUEST_BADGES[status]} size="sm">{t(STATE_LABELS[status])}</Badge>;
  if (status !== 'unknown') return badge;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex cursor-default" />}>{badge}</TooltipTrigger>
      <TooltipPopup>{t('usage.pullRequests.unknownHint')}</TooltipPopup>
    </Tooltip>
  );
}

const ICONS: Record<PullRequestSignal['kind'], AppIcon> = {
  failing: CircleX,
  pending: CircleDot,
  passing: CircleCheck,
  approved: UserCheck,
  changesRequested: UserRoundX,
  reviewRequired: UserRound,
  conflicting: TriangleAlert,
};

const TONES: Record<PullRequestSignalTone, string> = {
  success: 'text-success-foreground',
  warning: 'text-warning-foreground',
  error: 'text-error-foreground',
  muted: 'text-icon-muted',
};

/**
 * An open pull request's checks, review verdict and conflicts as a row of icons, each named in its tooltip. Nothing
 * for one that's merged or closed, or that GitHub has said nothing about.
 */
export function PullRequestSignals({ github, className }: { github: PullRequestState | null; className?: string }) {
  const { t } = useI18n();
  const signals = pullRequestSignals(github, t);
  if (!signals.length) return null;
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 align-middle', className)}>
      {signals.map((signal) => {
        const Icon = ICONS[signal.kind];
        return (
          <Tooltip key={signal.kind}>
            {/* A span, not a button: these sit in rows that open the pull request when clicked. */}
            <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
              <Icon
                role="img"
                aria-label={signal.detail ? `${signal.label}: ${signal.detail}` : signal.label}
                className={cn('size-3.5', TONES[signal.tone])}
              />
            </TooltipTrigger>
            <TooltipPopup>
              {signal.label}
              {signal.detail ? <span className="block text-muted-foreground">{signal.detail}</span> : null}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </span>
  );
}

import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { formatDate, formatNumber, formatWhen } from '../../lib/format';
import { cn } from '../../lib/utils';
import type { ComputeProviderSnapshot } from '../../native/types';
import { allSandboxes, computeTotals, findLimit, formatHours, planHoursGone, planHoursGoneLastSaid, planHoursTone, sizeMix } from '../../services/compute';
import { agentsFigure, loadNeedsKey, mostPressingPlanHours } from '../../services/computePage';
import { StatBlock, StatsGrid } from '../layout/stats';

/** A figure and, quieter after it, what it's out of: "6 of 100", "4 live sessions". */
function Figure({ value, rest }: { value: ReactNode; rest?: ReactNode }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span>{value}</span>
      {rest ? <span className="truncate text-xs font-normal text-muted-foreground">{rest}</span> : null}
    </span>
  );
}

/**
 * The four figures over the sandboxes: how many run (against the provider's maximum), the agents behind them, the
 * vCPUs busy now, and the plan hours left with when they'd run out at the current rate.
 */
export function ComputeStats({ providers, nowMs, stale }: {
  providers: readonly ComputeProviderSnapshot[];
  nowMs: number;
  /** The figures are an earlier read's, as the banner above says: they show dimmed. */
  stale: boolean;
}) {
  const { t } = useI18n();
  const sandboxes = allSandboxes(providers);
  const totals = computeTotals(sandboxes);
  const agents = agentsFigure(sandboxes);
  const maxes = providers.map((provider) => findLimit(provider, 'activeSandboxes')?.max ?? null);
  const max = maxes.length && maxes.every((value) => value !== null) ? maxes.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const sizes = sizeMix(sandboxes).map((share) => t('compute.page.stat.sizeCount', { count: share.count, size: share.size })).join(', ');
  const pressing = mostPressingPlanHours(providers, nowMs);
  const hours = pressing?.hours ?? null;
  // Used up means one of two things when the provider says which: nothing more starts, or it now costs. The words
  // are only for a read that's current; the color keeps to the last answer.
  const gone = pressing ? planHoursGone(pressing.provider, nowMs) : null;
  const hoursTone = hours && pressing ? planHoursTone(hours, nowMs, planHoursGoneLastSaid(pressing.provider)) : 'muted';
  const reset = hours?.resetsAtMs ? formatDate(hours.resetsAtMs, { now: nowMs }) : null;

  const agentsHint = !agents.own
    ? t('compute.page.stat.agentsNone')
    : agents.notLinked === agents.own
      ? t('compute.page.stat.agentsNoLinks')
      : [
          agents.leftBehind ? t(agents.leftBehind === 1 ? 'compute.page.stat.leftBehind.one' : 'compute.page.stat.leftBehind.other', { count: agents.leftBehind }) : t('compute.page.stat.noneLeftBehind'),
          agents.notLinked ? t('compute.page.stat.notLinked', { count: agents.notLinked }) : null,
        ].filter(Boolean).join(' · ');

  const resets = reset ? t('compute.page.stat.hoursResets', { when: reset }) : null;
  const hoursGone = gone
    ? [t(gone === 'blocked' ? 'compute.page.stat.hoursGoneBlocked' : 'compute.page.stat.hoursGoneBilled'), resets].filter(Boolean).join(' ')
    : reset ? t('compute.page.stat.hoursGone', { when: reset }) : null;

  const hoursHint = !hours
    ? t(providers.some((provider) => provider.status === 'limitsNeedScope') ? 'compute.page.stat.hoursNeedScope' : 'compute.page.stat.hoursNone')
    : hours.left <= 0
      ? hoursGone ? <span className={cn(hoursTone === 'error' ? 'text-destructive-foreground' : hoursTone === 'warning' && 'text-warning-foreground')}>{hoursGone}</span> : null
      // A forecast from an earlier read's rate would claim more than Arbor knows.
      : stale
        ? resets
        : hours.runOutAtMs !== null && hours.perHour
          ? (
              <span className={cn(hoursTone === 'error' ? 'text-destructive-foreground' : hoursTone === 'warning' && 'text-warning-foreground')}>
                {t('compute.page.stat.runsOut', { when: formatWhen(hours.runOutAtMs, { now: nowMs }), rate: formatHours(hours.perHour) })}
              </span>
            )
          : reset ? t('compute.page.stat.hoursIdle', { when: reset }) : null;

  return (
    <StatsGrid columns={4} className={cn(stale && 'opacity-60')}>
      <StatBlock
        label={t('compute.page.stat.running')}
        value={<Figure value={totals.running} rest={max !== null ? t('compute.page.stat.of', { max: formatNumber(max) }) : null} />}
        hint={totals.running ? `${sizes} · ${t('compute.sizeLine', { vcpus: totals.vcpus, memory: formatNumber(totals.memoryGb) })}` : t('compute.page.stat.runningNone')}
      />
      <StatBlock
        label={t('compute.page.stat.agents')}
        value={agents.own && agents.notLinked < agents.own
          ? <Figure value={agents.liveSessions} rest={t(agents.liveSessions === 1 ? 'compute.page.stat.liveSessions.one' : 'compute.page.stat.liveSessions.other')} />
          : '—'}
        hint={agentsHint}
      />
      <StatBlock
        label={t('compute.page.stat.busy')}
        value={totals.read ? <Figure value={Math.round(totals.busyVcpus)} rest={t('compute.page.stat.of', { max: totals.readVcpus })} /> : '—'}
        hint={totals.hot
          ? t('compute.page.stat.busyHint', { count: totals.hot })
          : !totals.read && providers.some(loadNeedsKey) ? t('compute.load.keyCantRead') : undefined}
      />
      <StatBlock
        label={t('compute.page.stat.hoursLeft')}
        tone={hoursTone === 'error' ? 'danger' : hoursTone === 'warning' ? 'warning' : 'default'}
        value={hours ? <Figure value={formatNumber(Math.floor(hours.left))} rest={t('compute.page.stat.of', { max: formatNumber(hours.max) })} /> : '—'}
        hint={hoursHint}
      />
    </StatsGrid>
  );
}

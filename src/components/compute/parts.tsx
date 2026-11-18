import { memo, useMemo } from 'react';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import type { ComputePoint, ComputeSandbox } from '../../native/types';
import {
  formatEndedAgo,
  sandboxFlags,
  sandboxTone,
  shortComputeSessionId,
  type ComputeTone,
  type SandboxFlag,
} from '../../services/compute';
import { ISSUE_LABEL } from '../../services/computeAlerts';
import { HarnessName } from '../identity/Harness';
import { MachinePill } from '../identity/Identity';
import { Badge } from '../ui/badge';
import { TriangleAlert } from '../ui/icons';
import { StatusDot, type StatusTone } from '../ui/status-dot';

/** Pieces every Compute screen draws a sandbox with: its dot, its flags, what started it. */

const DOT_TONE: Record<ComputeTone, StatusTone> = { primary: 'success', warning: 'warning', error: 'error', muted: 'muted' };

/** A sandbox's state at a glance: green running, amber wanting a look, red in error, pulsing while it starts or stops. */
export function SandboxDot({ sandbox }: { sandbox: ComputeSandbox }) {
  const tone = sandboxTone(sandbox);
  return tone === 'changing' ? <StatusDot tone="info" pulse /> : <StatusDot tone={DOT_TONE[tone]} />;
}

const FLAG_VARIANT: Record<SandboxFlag, 'muted' | 'warning' | 'error'> = {
  starting: 'muted',
  stopping: 'muted',
  error: 'error',
  cpuAtLimit: 'warning',
  degraded: 'warning',
  forgotten: 'warning',
};

/** The badges after a sandbox's name: starting or stopping, in error, at its CPU limit, degraded with what's wrong, looks forgotten. */
export function SandboxFlags({ sandbox, size = 'default' }: { sandbox: ComputeSandbox; size?: 'default' | 'sm' }) {
  const { t } = useI18n();
  return (
    <>
      {sandboxFlags(sandbox).map((flag) => (
        <Badge key={flag} variant={FLAG_VARIANT[flag]} size={size}>
          {flag === 'starting' || flag === 'stopping' ? null : <TriangleAlert aria-hidden="true" />}
          {flag === 'degraded' && sandbox.issue
            ? t('compute.flag.degraded', { issue: t(ISSUE_LABEL[sandbox.issue]) })
            : t(`compute.flag.${flag}`)}
        </Badge>
      ))}
    </>
  );
}

/**
 * What started a sandbox, on one line: the machine, the session's short id, its agent, and whether it's live or when
 * it ended; or a teammate's, or not linked with why. Only what Arbor linked by id, never a guess from the name.
 */
export const StartedByLine = memo(function StartedByLine({ sandbox, nowMs }: { sandbox: ComputeSandbox; nowMs: number }) {
  const { t } = useI18n();
  if (!sandbox.mine) return <span className="text-xs text-muted-foreground">{t('compute.teammate')}</span>;
  if (!sandbox.machine) {
    return <span className="text-xs text-muted-foreground">{t(sandbox.linkProblem === 'unknownMachine' ? 'compute.linkProblem.unknownMachine' : 'compute.notLinked')}</span>;
  }
  const session = sandbox.session;
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <MachinePill name={sandbox.machine} size="sm" />
      {session ? (
        <>
          <span className="font-mono text-2xs text-foreground/70">{shortComputeSessionId(session.id)}</span>
          {session.known ? (
            <>
              {session.harness ? <HarnessName harness={session.harness} className="text-foreground/80" /> : null}
              {session.live
                ? <span className="text-success-foreground">{t('compute.live')}</span>
                : session.endedAtMs !== null ? <span>{t('compute.endedAgo', { ago: formatEndedAgo(session.endedAtMs, nowMs) })}</span> : null}
            </>
          ) : (
            <span className="truncate">{t('compute.sessionUnknown')}</span>
          )}
        </>
      ) : null}
    </span>
  );
});

const SPARK_W = 100;
const SPARK_H = 24;
const SPARK_STROKE: Record<ComputeTone, string> = { primary: 'text-success', warning: 'text-warning', error: 'text-error', muted: 'text-muted-foreground' };

/**
 * A row's CPU over its last readings (about half an hour), drawn once per reading: no clock and no animation, so a
 * hundred rows cost nothing between rounds. A gap in the readings breaks the line.
 */
export const CpuSparkline = memo(function CpuSparkline({ points, tone, className }: { points: readonly ComputePoint[]; tone: ComputeTone; className?: string }) {
  const { t } = useI18n();
  const path = useMemo(() => {
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last || points.length < 2) return null;
    const span = Math.max(1, last.atMs - first.atMs);
    let line = '';
    let previous: ComputePoint | null = null;
    for (const point of points) {
      const x = ((point.atMs - first.atMs) / span) * SPARK_W;
      const y = SPARK_H - Math.max(0, Math.min(1, point.cpu)) * (SPARK_H - 2) - 1;
      // Readings come a minute apart; more than two and a half means some were never taken.
      line += `${previous && point.atMs - previous.atMs <= 150_000 ? ' L' : ' M'} ${x.toFixed(1)},${y.toFixed(1)}`;
      previous = point;
    }
    return line.trim();
  }, [points]);
  if (!path) return <span className={cn('h-6 w-16', className)} aria-hidden="true" />;
  return (
    <svg className={cn('h-6 w-16 shrink-0', SPARK_STROKE[tone], className)} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" role="img" aria-label={t('compute.page.sparkline')}>
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
});

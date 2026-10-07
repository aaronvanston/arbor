import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { formatPercent } from '../../lib/format';
import { cn } from '../../lib/utils';
import type { MachinePool, PoolMemberVerdict, PoolPreview } from '../../native/types';
import { identityColorCss } from '../../services/identityColors';
import {
  POOL_STANDING_LABEL,
  POOL_WEIGHT_LABEL,
  leftOut,
  limitLoad,
  limitWords,
  planSteps,
  poolStanding,
  shareRule,
  trippedLimit,
  verdictMessage,
  type PoolLimit,
} from '../../services/pools';
import { MachinePill, useMachineLook } from '../identity/Identity';
import { Badge } from '../ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

/**
 * A pool's health as Fleet › Pools draws it: whether a run would start now, each member's load against the pool's
 * limits, who would take the next run and with what chance, and where a burst of runs would go.
 */

/** What a run does when nobody has room, in words for "…, so a run would {action}". */
export function useWhenFull(pool: MachinePool, pools: readonly MachinePool[]) {
  const { t } = useI18n();
  if (pool.whenFull === 'spill') return t('pools.next.spill', { pool: pools.find((other) => other.id === pool.spillPool)?.name ?? '' });
  if (pool.whenFull === 'queue') return t('pools.next.queue', { minutes: pool.queueTimeoutMin });
  return t('pools.next.refuse');
}

/** The pool's standing as a badge: how many machines have room, or that it's full. */
export function PoolStandingBadge({ pool, preview }: { pool: MachinePool; preview: PoolPreview | undefined }) {
  const { t } = useI18n();
  const { standing, withRoom, pickable } = poolStanding(pool, preview);
  const variant = standing === 'room' ? 'success' : standing === 'full' ? 'warning' : 'muted';
  return <Badge variant={variant}>{t(POOL_STANDING_LABEL[standing], { withRoom, pickable })}</Badge>;
}

/**
 * The next run's chances as one bar, a segment per member with room in that machine's color, widest first, so the
 * pool's balance reads at a glance.
 */
export function ShareBar({ preview, className }: { preview: PoolPreview | undefined; className?: string }) {
  const segments = (preview?.members ?? []).filter((verdict) => verdict.share > 0).sort((a, b) => b.share - a.share);
  return (
    <div className={cn('flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted', className)} data-slot="pool-share-bar" aria-hidden="true">
      {segments.map((verdict) => <ShareSegment key={verdict.machine} verdict={verdict} />)}
    </div>
  );
}

function ShareSegment({ verdict }: { verdict: PoolMemberVerdict }) {
  const look = useMachineLook(verdict.machine);
  return <span className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${verdict.share * 100}%`, background: identityColorCss(look.color) }} />;
}

/**
 * One limit as a small meter filling toward it, with a tick where the limit sits (none when it's off), in the warning
 * color once the member is at it.
 */
function LimitMeter({ limit, verdict, pool, children }: { limit: PoolLimit; verdict: PoolMemberVerdict | undefined; pool: MachinePool; children: ReactNode }) {
  const load = verdict ? limitLoad(limit, verdict, pool) : null;
  const tripped = verdict ? trippedLimit(verdict.kind) === limit : false;
  return (
    <span className="flex items-center justify-end gap-2">
      <span className={cn('tabular-nums', tripped ? 'font-medium text-warning-foreground' : !load && 'text-muted-foreground')}>{children}</span>
      {/* The figure says it all in a narrow card, so the bar gives way first and Now stays in view. */}
      <span className="relative hidden h-1.5 w-12 shrink-0 rounded-full bg-muted @2xl:block" aria-hidden="true">
        {load ? (
          <span className={cn('absolute inset-y-0 left-0 rounded-full', tripped ? 'bg-warning' : 'bg-foreground/35')} style={{ width: `${load.fill * 100}%` }} />
        ) : null}
        {load?.mark != null ? (
          <span className="absolute -inset-y-0.5 w-px bg-foreground/70" style={{ left: `calc(${load.mark * 100}% - 0.5px)` }} />
        ) : null}
      </span>
    </span>
  );
}

/** Each member's weight, load against the pool's limits, standing and chance of the next run. */
export function PoolMembersTable({ pool, preview }: { pool: MachinePool; preview: PoolPreview | undefined }) {
  const { t } = useI18n();
  const none = t('pools.figure.none');
  return (
    <Table containerClassName="@container">
      <TableHeader>
        <TableRow>
          <TableHead>{t('pools.column.machine')}</TableHead>
          <TableHead className="w-24">{t('pools.column.weight')}</TableHead>
          <TableHead className="w-28 text-end">{t('pools.column.agents')}</TableHead>
          <TableHead className="w-24 text-end">{t('pools.column.cpu')}</TableHead>
          <TableHead className="w-28 text-end">{t('pools.column.memory')}</TableHead>
          <TableHead>{t('pools.column.now')}</TableHead>
          <TableHead className="w-16 text-end">{t('pools.column.chance')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {pool.members.map((member) => {
          const verdict = preview?.members.find((entry) => entry.machine === member.machine);
          const message = verdict ? verdictMessage(verdict) : null;
          const running = verdict?.running ?? null;
          return (
            <TableRow key={member.machine} data-verdict={verdict?.kind}>
              <TableCell><MachinePill name={member.machine} /></TableCell>
              <TableCell className="text-muted-foreground">{t(POOL_WEIGHT_LABEL[member.weight])}</TableCell>
              <TableCell>
                <LimitMeter limit="agents" verdict={verdict} pool={pool}>
                  {running === null ? none : pool.maxAgents === null ? running : t('pools.figure.agentsOf', { running, max: pool.maxAgents })}
                </LimitMeter>
              </TableCell>
              <TableCell>
                <LimitMeter limit="cpu" verdict={verdict} pool={pool}>{verdict?.cpu == null ? none : `${Math.round(verdict.cpu)}%`}</LimitMeter>
              </TableCell>
              <TableCell>
                <LimitMeter limit="memory" verdict={verdict} pool={pool}>
                  {verdict?.memFree == null ? none : t('pools.figure.memFree', { percent: Math.round(verdict.memFree) })}
                </LimitMeter>
              </TableCell>
              <TableCell className={cn('min-w-24 whitespace-normal text-xs', verdict && leftOut(verdict.kind) ? 'text-warning-foreground' : 'text-muted-foreground')}>
                {message ? t(message.key, message.values) : t('pools.verdict.checking')}
              </TableCell>
              <TableCell className="text-end tabular-nums">
                {verdict && verdict.share > 0 ? formatPercent(verdict.share) : <span className="text-muted-foreground">{none}</span>}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** The limits that make a member full, in a line. */
export function PoolLimitsLine({ pool, className }: { pool: MachinePool; className?: string }) {
  const { t } = useI18n();
  const limits = limitWords(pool);
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      {limits.length ? t('pools.limits.any', { limits: limits.map((limit) => t(limit.key, limit.values)).join(', ') }) : t('pools.limits.none')}
    </p>
  );
}

/**
 * Where the next run would most likely go, in one line, with the rule behind it when asked. The plan's later steps
 * aren't drawn: the chance bar above already shows the balance, and a strip of eight machines read as noise.
 */
export function PoolPlan({ pool, pools, preview, explain = false }: { pool: MachinePool; pools: readonly MachinePool[]; preview: PoolPreview | undefined; explain?: boolean }) {
  const { t, tRich } = useI18n();
  const whenFull = useWhenFull(pool, pools);
  const next = planSteps(preview?.plan ?? []).machines[0];
  return (
    <div className="flex flex-col gap-1 text-sm" data-slot="pool-plan">
      {!preview ? (
        <span className="text-muted-foreground">{t('pools.verdict.checking')}</span>
      ) : next === undefined ? (
        <span className="text-muted-foreground">{t('pools.how.nobody', { action: whenFull })}</span>
      ) : (
        <span>{tRich('pools.next.likely', { machine: <MachinePill name={next} size="sm" /> })}</span>
      )}
      {explain ? <p className="text-xs text-muted-foreground">{t(shareRule(pool))}</p> : null}
    </div>
  );
}

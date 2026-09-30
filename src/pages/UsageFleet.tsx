import { ArrowUpRight, Monitor } from '../components/ui/icons';
import { useNothingRecorded } from '../hooks/useCollectorStatus';
import { useI18n } from '../i18n';
import { MachinePill } from '../components/identity/Identity';
import { formatCount, formatNumber, formatWhen } from '../lib/format';
import { SettingsBlock, SettingsSection } from '../components/layout/settings';
import { Button } from '../components/ui/button';
import { TABLE_NUMERIC_CLASS } from '../components/ui/data-table';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import type { MachineLive, MachineUsage } from '../native/types';

const number = formatCount;
const emptyUsage = (machine: string): MachineUsage => ({ machine, pool: '', requests: 0, tokens: 0, success: 0, failures: 0, canceled: 0, lastRequest: null });

export function UsageFleet({ items, live, onInspect, onAssign }: {
  items: MachineUsage[]; live: MachineLive[];
  onInspect: (machine: string) => void;
  onAssign: () => void;
}) {
  const { t } = useI18n();
  const nothingYet = useNothingRecorded();
  const byMachine = new Map<string, MachineUsage>();
  for (const item of items) {
    const prior = byMachine.get(item.machine) ?? emptyUsage(item.machine);
    byMachine.set(item.machine, { ...prior, requests: prior.requests + item.requests, tokens: prior.tokens + item.tokens,
      success: prior.success + item.success, failures: prior.failures + item.failures, canceled: prior.canceled + item.canceled,
      lastRequest: !prior.lastRequest || (item.lastRequest && item.lastRequest > prior.lastRequest) ? item.lastRequest : prior.lastRequest });
  }
  for (const item of live) if (!byMachine.has(item.machine)) byMachine.set(item.machine, emptyUsage(item.machine));
  const liveByMachine = new Map(live.map(item => [item.machine, item]));
  const machines = [...byMachine.values()].sort((a, b) => a.machine === '' ? 1 : b.machine === '' ? -1 : a.machine.localeCompare(b.machine));
  const maximum = throughputScale(live);
  const total = items.reduce((sum, item) => sum + item.tokens, 0);
  const unassigned = t('usage.fleet.unassigned');
  const liveMachines = machines.filter(item => item.machine || liveByMachine.get(item.machine)?.tokens.some(tokens => tokens > 0));

  return (
    <SettingsSection
      title={t('usage.fleet.title')}
      description={t('usage.fleet.description')}
      headerAction={
        <Button variant="outline" size="sm" onClick={onAssign}>
          <Monitor />
          {t('usage.fleet.assign')}
        </Button>
      }
    >
      {machines.length === 0 ? (
        <SettingsBlock className="text-sm text-muted-foreground">{t(nothingYet ? 'usage.fleet.emptyYet' : 'usage.fleet.empty')}</SettingsBlock>
      ) : (
        <>
          <div className="grid gap-px bg-border/50 sm:grid-cols-2 xl:grid-cols-3 [&>*]:bg-card">
            {liveMachines.map(item => {
              const name = item.machine || unassigned;
              return (
                <button
                  type="button"
                  key={item.machine}
                  className="group flex flex-col gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:hover:bg-input/16"
                  onClick={() => onInspect(item.machine || '__unassigned__')}
                  aria-label={t('usage.fleet.inspect', { machine: name })}
                >
                  <div className="flex items-center gap-2 text-sm">
                    <MachinePill name={item.machine} fallback={unassigned} />
                    <ArrowUpRight className="ms-auto size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" aria-hidden="true" />
                  </div>
                  <MachineThroughput machine={item.machine} name={name} activity={liveByMachine.get(item.machine)} maximum={maximum} />
                </button>
              );
            })}
          </div>
          <SettingsBlock className="py-2 text-xs text-muted-foreground">{t('usage.fleet.note')}</SettingsBlock>
          <div className="px-4 pt-3 pb-1">
            <h3 className="text-sm font-medium text-foreground">
              {t('usage.fleet.breakdownTitle')} <span className="ms-1 text-xs font-normal text-muted-foreground">{t('usage.fleet.breakdownDescription')}</span>
            </h3>
          </div>
          {/* No line between the breakdown's title and its table. */}
          <Table containerClassName="border-t-0!">
            <TableHeader>
              <TableRow>
                <TableHead>{t('usage.fleet.column.machine')}</TableHead>
                <TableHead className={TABLE_NUMERIC_CLASS}>{t('usage.fleet.column.tokens')}</TableHead>
                <TableHead className={TABLE_NUMERIC_CLASS}>{t('usage.fleet.column.share')}</TableHead>
                <TableHead className={TABLE_NUMERIC_CLASS}>{t('usage.fleet.column.requests')}</TableHead>
                <TableHead className={TABLE_NUMERIC_CLASS}>{t('usage.fleet.column.success')}</TableHead>
                <TableHead className={TABLE_NUMERIC_CLASS}>{t('usage.fleet.column.failed')}</TableHead>
                <TableHead className="text-end">{t('usage.fleet.column.lastRequest')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {machines.map(item => (
                <TableRow key={item.machine}>
                  <TableCell>
                    <MachinePill
                      name={item.machine}
                      fallback={unassigned}
                      onClick={() => onInspect(item.machine || '__unassigned__')}
                      label={t('usage.fleet.inspect', { machine: item.machine || unassigned })}
                    />
                  </TableCell>
                  <TableCell className={TABLE_NUMERIC_CLASS}>{number(item.tokens)}</TableCell>
                  <TableCell className={`${TABLE_NUMERIC_CLASS} text-muted-foreground`}>{total ? (item.tokens / total * 100).toFixed(1) : '0.0'}%</TableCell>
                  <TableCell className={TABLE_NUMERIC_CLASS}>{number(item.requests)}</TableCell>
                  <TableCell className={TABLE_NUMERIC_CLASS}>{item.success + item.failures ? `${(item.success / (item.success + item.failures) * 100).toFixed(1)}%` : '—'}</TableCell>
                  <TableCell className={`${TABLE_NUMERIC_CLASS} ${item.failures > 0 ? 'text-error-foreground' : ''}`}>{number(item.failures)}</TableCell>
                  <TableCell className="text-end text-muted-foreground">{item.lastRequest ? formatWhen(item.lastRequest) : t('usage.fleet.noRequests')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </SettingsSection>
  );
}

/** The largest five-second rate in the machines' last minute, which their charts share as their scale. */
export const throughputScale = (live: MachineLive[]) => Math.max(1, ...live.flatMap(item => item.tokens.map(tokens => tokens / 5)));

/**
 * A machine's tokens a second over the last minute, in five-second steps: the latest rate, how many requests finished,
 * and the chart on the scale it shares with the other machines' (`maximum`).
 */
export function MachineThroughput({ machine, name, activity, maximum }: { machine: string; name: string; activity: MachineLive | undefined; maximum: number }) {
  const { t } = useI18n();
  const gradientId = `fleet-grad-${(machine || 'unassigned').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const buckets = activity?.tokens ?? Array<number>(12).fill(0);
  const rates = buckets.map(tokens => tokens / 5);
  const current = rates[rates.length - 1] ?? 0;
  const step = rates.length > 1 ? 300 / (rates.length - 1) : 300;
  const coords = rates.map((rate, index) => `${(index * step).toFixed(1)},${(72 - rate / maximum * 64).toFixed(1)}`);
  const points = coords.join(' ');
  const area = coords.length ? `M 0,80 L ${coords.join(' L ')} L 300,80 Z` : '';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-lg font-semibold tabular-nums text-foreground">
          {number(current)} <small className="text-xs font-normal text-muted-foreground">{t('usage.fleet.tokensPerSecond')}</small>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {activity?.requests ? t('usage.fleet.recentRequests', { count: number(activity.requests) }) : t('usage.fleet.noRecent')}
        </span>
      </div>
      <svg
        className="h-16 w-full text-primary"
        viewBox="0 0 300 80"
        preserveAspectRatio="none"
        role="img"
        aria-label={t('usage.fleet.graphAria', { machine: name, rate: formatNumber(current), max: formatNumber(Math.ceil(maximum)) })}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.24" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[8, 40, 72].map((y) => (
          <line key={y} x1="0" x2="300" y1={y} y2={y} stroke="var(--border)" strokeDasharray="2,3" vectorEffect="non-scaling-stroke" />
        ))}
        {area ? <path d={area} fill={`url(#${gradientId})`} /> : null}
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-2xs tabular-nums text-muted-foreground">
        <span>{t('usage.fleet.axisStart')}</span>
        <span>{t('usage.fleet.axisScale', { max: number(Math.ceil(maximum)) })}</span>
        <span>{t('usage.fleet.axisNow')}</span>
      </div>
    </div>
  );
}

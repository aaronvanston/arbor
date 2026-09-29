import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ClientName, MachinePill, MachinePills, ModelName } from '../components/identity/Identity';
import { AlertCircle, Archive, TriangleAlert } from '../components/ui/icons';
import { useI18n } from '../i18n';
import { formatCount, formatDate, formatDateRange, formatDateWith, formatNumber, formatPercent } from '../lib/format';
import {
  byMonth,
  countingState,
  getLifetimeTokens,
  groupCounts,
  joinKey,
  lifetimeSummary,
  lifetimeTimeline,
  recoveredSummary,
  splitKey,
  type RecoveredSummary,
  type TokenGroup,
} from '../services/lifetimeTokens';
import { formatBytes } from '../services/machineHealth';
import { SettingsSection } from '../components/layout/settings';
import { StatBlock, StatsGrid } from '../components/layout/stats';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Skeleton } from '../components/ui/skeleton';
import { Spinner } from '../components/ui/spinner';
import { TABLE_NUMERIC_CLASS } from '../components/ui/data-table';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { UsageTrendSection } from './UsageTrendChart';
import type { LifetimeTokens } from '../native/types';

/** Counting runs with the archive's passes, a few minutes apart, or seconds apart while it catches up. */
/** While the archive is still counting old versions the tab follows along; after that, counts grow only with passes. */
const COUNTING_REFRESH_MS = 30_000;
const REFRESH_MS = 5 * 60_000;

const AGENT_KEYS = { claude: 'usage.lifetime.agent.claude', codex: 'usage.lifetime.agent.codex', openclaw: 'usage.lifetime.agent.openclaw', pi: 'usage.lifetime.agent.pi' } as const;

/**
 * The Usage page's All time tab: every token in every session the archive keeps, from the
 * transcripts themselves rather than the proxy's records, so it reaches back past them.
 * `refreshKey` changes when the page's refresh button is pressed.
 */
export function UsageLifetimeView({ refreshKey, onOpenArchive }: { refreshKey: number; onOpenArchive?: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<LifetimeTokens | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const load = () =>
      getLifetimeTokens().then(
        (next) => {
          if (disposed) return;
          setData(next);
          setError('');
          schedule(countingState(next) === 'counting' ? COUNTING_REFRESH_MS : REFRESH_MS);
        },
        (loadError) => {
          if (disposed) return;
          setError(String(loadError));
          schedule(REFRESH_MS);
        },
      );
    const schedule = (ms: number) => {
      timer = window.setTimeout(function next() {
        if (document.hidden) timer = window.setTimeout(next, ms);
        else void load();
      }, ms);
    };
    void load();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [refreshKey]);

  if (!data) {
    return error ? (
      <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{t('usage.lifetime.loadFailed', { error })}</AlertDescription></Alert>
    ) : (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }
  return <UsageLifetimeContent data={data} onOpenArchive={onOpenArchive} />;
}

export function UsageLifetimeContent({ data, onOpenArchive }: { data: LifetimeTokens; onOpenArchive?: () => void }) {
  const { t, tRich } = useI18n();
  const state = countingState(data);
  const summary = useMemo(() => lifetimeSummary(data), [data]);
  const timeline = useMemo(() => lifetimeTimeline(data.days, data.recovered), [data.days, data.recovered]);
  const recovered = useMemo(() => recoveredSummary(data), [data]);
  const models = useMemo(() => groupCounts(data.months, (row) => joinKey(row.agent, row.model)), [data.months]);
  const homes = useMemo(() => groupCounts(data.months, (row) => joinKey(row.machine, row.home, row.agent)), [data.months]);
  const months = useMemo(() => byMonth(data.months), [data.months]);

  const openArchive = onOpenArchive ? (
    <Button variant="outline" size="sm" className="mt-2" onClick={onOpenArchive}>{t('usage.lifetime.openArchive')}</Button>
  ) : null;

  if (state === 'off' || state === 'waiting') {
    return (
      <SettingsSection title={t('usage.lifetime.title')}>
        <Empty size="sm">
          <EmptyMedia><Archive /></EmptyMedia>
          <EmptyTitle>{t(state === 'off' ? 'usage.lifetime.off.title' : 'usage.lifetime.waiting.title')}</EmptyTitle>
          <EmptyDescription>{t(state === 'off' ? 'usage.lifetime.off.description' : 'usage.lifetime.waiting.description')}</EmptyDescription>
          {openArchive}
        </Empty>
      </SettingsSection>
    );
  }

  const { totals, total } = summary;
  // Own names: each pill shows the name a machine was given in Arbor.
  const machines = [...new Set(data.sources.map((source) => source.machine))];
  const share = (part: number) => formatPercent(total > 0 ? part / total : 0);
  const agentName = (agent: string) => (agent in AGENT_KEYS ? t(AGENT_KEYS[agent as keyof typeof AGENT_KEYS]) : agent);
  const firstDay = summary.firstDay ? formatDate(`${summary.firstDay}T00:00:00`) : null;
  // Claude Code's own count can reach back before the first transcript kept.
  const chartStart = [summary.firstDay, ...recovered.machines.filter((machine) => machine.tokens > 0).map((machine) => machine.firstDay)]
    .filter((day): day is string => Boolean(day))
    .sort()[0];

  return (
    <div className="flex flex-col gap-6">
      <StatsGrid columns={4}>
        <StatBlock
          label={t('usage.lifetime.stat.total')}
          value={formatCount(total)}
          hint={firstDay
            ? t('usage.lifetime.stat.totalSince', { calls: formatNumber(totals.calls), date: firstDay })
            : t('usage.lifetime.stat.totalHint', { calls: formatNumber(totals.calls) })}
        />
        <StatBlock
          label={t('usage.lifetime.stat.cacheRead')}
          value={formatCount(totals.cacheRead)}
          hint={t('usage.lifetime.stat.share', { share: share(totals.cacheRead) })}
        />
        <StatBlock
          label={t('usage.lifetime.stat.input')}
          value={formatCount(totals.input + totals.cacheWrite)}
          hint={t('usage.lifetime.stat.inputHint', { fresh: formatCount(totals.input), written: formatCount(totals.cacheWrite) })}
        />
        <StatBlock
          label={t('usage.lifetime.stat.output')}
          value={formatCount(totals.output)}
          hint={totals.reasoning > 0 ? t('usage.lifetime.stat.reasoning', { reasoning: formatCount(totals.reasoning) }) : t('usage.lifetime.stat.share', { share: share(totals.output) })}
        />
      </StatsGrid>

      {state === 'counting' ? (
        <Alert variant="info" icon={<Spinner />}>
          <AlertDescription>
            {t(data.versionsLeft === 1 ? 'usage.lifetime.counting.one' : 'usage.lifetime.counting.other', { count: formatNumber(data.versionsLeft), size: formatBytes(data.bytesLeft) })}
          </AlertDescription>
        </Alert>
      ) : null}
      {data.lastError ? (
        <Alert variant="warning" icon={<TriangleAlert />}>
          <AlertDescription>{t('usage.lifetime.failed', { error: data.lastError })}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-col gap-1 px-4 text-xs leading-[1.45] text-muted-foreground">
        <p>
          {data.sources.some((source) => source.kind === 'import')
            ? tRich('usage.lifetime.coverage.backups', { machines: <MachinePills names={machines} /> })
            : tRich(data.sources.length === 1 ? 'usage.lifetime.coverage.one' : 'usage.lifetime.coverage.other', { machines: <MachinePills names={machines} />, count: data.sources.length })}
        </p>
        {recovered.tokens > 0 ? (
          <p data-slot="lifetime-recovered-line">
            {t(recovered.days === 1 ? 'usage.lifetime.recovered.line.one' : 'usage.lifetime.recovered.line.other', { tokens: formatCount(recovered.tokens), days: formatNumber(recovered.days) })}
          </p>
        ) : null}
      </div>

      <UsageTrendSection
        timeline={timeline}
        range={{ start: chartStart ? new Date(`${chartStart}T00:00:00`).toISOString() : undefined }}
        empty={<p className="text-xs text-muted-foreground">{t('usage.lifetime.noDays')}</p>}
      />

      {recovered.machines.length ? <RecoveredDays summary={recovered} /> : null}

      <SettingsSection title={t('usage.lifetime.models.title')} description={t('usage.lifetime.models.description')}>
        <GroupTable
          groups={models}
          head={[t('usage.lifetime.column.model'), t('usage.lifetime.column.agent')]}
          cells={(key) => {
            const [agent = '', model = ''] = splitKey(key);
            return [
              model ? <ModelName key="model" model={model} /> : <span key="model" className="text-muted-foreground">{t('usage.lifetime.unknownModel')}</span>,
              <ClientName key="agent" name={agentName(agent)} />,
            ];
          }}
        />
      </SettingsSection>

      <SettingsSection title={t('usage.lifetime.homes.title')} description={t('usage.lifetime.homes.description')}>
        <GroupTable
          groups={homes}
          head={[t('usage.lifetime.column.machine'), t('usage.lifetime.column.home')]}
          cells={(key) => {
            const [machine = '', home = '', agent = ''] = splitKey(key);
            return [
              <MachinePill key="machine" name={machine} />,
              <span key="home" className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-mono" title={home}>{home}</span>
                <ClientName name={agentName(agent)} className="shrink-0 text-muted-foreground" />
              </span>,
            ];
          }}
        />
      </SettingsSection>

      <SettingsSection title={t('usage.lifetime.months.title')}>
        <GroupTable
          groups={months}
          head={[t('usage.lifetime.column.month')]}
          cells={(key) => [<span key="month" className="tabular-nums">{formatMonth(key)}</span>]}
          breakdown
        />
      </SettingsSection>
    </div>
  );
}

/** Claude Code's own count on the days whose transcripts are gone, by machine, kept apart from the total. */
function RecoveredDays({ summary }: { summary: RecoveredSummary }) {
  const { t } = useI18n();
  const number = TABLE_NUMERIC_CLASS;
  const day = (value: string) => `${value}T00:00:00`;
  return (
    <SettingsSection
      title={t('usage.lifetime.recovered.title')}
      description={t('usage.lifetime.recovered.description')}
      summary={summary.ratio !== null ? t('usage.lifetime.recovered.ratio', { ratio: formatNumber(summary.ratio, 1) }) : undefined}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('usage.lifetime.column.machine')}</TableHead>
            <TableHead>{t('usage.lifetime.column.when')}</TableHead>
            <TableHead className={`w-24 ${number}`}>{t('usage.lifetime.column.days')}</TableHead>
            <TableHead className={`w-24 ${number}`}>{t('usage.lifetime.column.sessions')}</TableHead>
            <TableHead className={`w-32 ${number}`}>{t('usage.lifetime.column.claudeCodeCount')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {summary.machines.map((machine) => (
            <TableRow key={machine.machine}>
              <TableCell className="max-w-0"><MachinePill name={machine.machine} /></TableCell>
              <TableCell className="max-w-0 truncate tabular-nums text-muted-foreground">{formatDateRange(day(machine.firstDay), day(machine.lastDay))}</TableCell>
              <TableCell className={number}>{formatNumber(machine.days + machine.sessionDays)}</TableCell>
              <TableCell className={number}>{formatNumber(machine.sessions)}</TableCell>
              <TableCell className={`${number} font-medium text-foreground`}>{machine.tokens > 0 ? formatCount(machine.tokens) : <span className="font-normal text-muted-foreground">—</span>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {summary.sessionDays > 0 ? (
        <p className="border-t border-border/70 px-4 py-2.5 text-xs text-muted-foreground">
          {t(summary.sessionDays === 1 ? 'usage.lifetime.recovered.sessionsOnly.one' : 'usage.lifetime.recovered.sessionsOnly.other', { days: formatNumber(summary.sessionDays) })}
        </p>
      ) : null}
    </SettingsSection>
  );
}

function formatMonth(month: string): string {
  const [year, number] = month.split('-').map(Number);
  if (!year || !number) return month;
  return formatDateWith(new Date(year, number - 1, 1), { year: 'numeric', month: 'short' });
}

function GroupTable({
  groups,
  head,
  cells,
  breakdown = false,
}: {
  groups: TokenGroup[];
  head: string[];
  cells: (key: string) => ReactNode[];
  /** Shows each kind of token, rather than the share of the whole. */
  breakdown?: boolean;
}) {
  const { t } = useI18n();
  const number = TABLE_NUMERIC_CLASS;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {head.map((label) => <TableHead key={label}>{label}</TableHead>)}
          <TableHead className={`w-24 ${number}`}>{t('usage.lifetime.column.calls')}</TableHead>
          {breakdown ? (
            <>
              <TableHead className={`w-24 ${number}`}>{t('usage.lifetime.column.input')}</TableHead>
              <TableHead className={`w-24 ${number}`}>{t('usage.lifetime.column.cacheWrite')}</TableHead>
              <TableHead className={`w-24 ${number}`}>{t('usage.lifetime.column.cacheRead')}</TableHead>
              <TableHead className={`w-24 ${number}`}>{t('usage.lifetime.column.output')}</TableHead>
            </>
          ) : null}
          <TableHead className={`w-24 ${number}`}>{t('usage.lifetime.column.total')}</TableHead>
          {breakdown ? null : <TableHead className={`w-20 ${number}`}>{t('usage.lifetime.column.share')}</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => (
          <TableRow key={group.key}>
            {cells(group.key).map((cell, index) => <TableCell key={index} className="max-w-0">{cell}</TableCell>)}
            <TableCell className={number}>{formatNumber(group.calls)}</TableCell>
            {breakdown ? (
              <>
                <TableCell className={number}>{formatCount(group.input)}</TableCell>
                <TableCell className={number}>{formatCount(group.cacheWrite)}</TableCell>
                <TableCell className={number}>{formatCount(group.cacheRead)}</TableCell>
                <TableCell className={number}>{formatCount(group.output)}</TableCell>
              </>
            ) : null}
            <TableCell className={`${number} font-medium text-foreground`}>{formatCount(group.total)}</TableCell>
            {breakdown ? null : <TableCell className={`${number} text-muted-foreground`}>{formatPercent(group.share)}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

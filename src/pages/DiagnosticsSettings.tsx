import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2 } from '../components/ui/icons';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsSection } from '../components/layout/settings';
import { StatBlock, StatsGrid } from '../components/layout/stats';
import { Button } from '../components/ui/button';
import { TABLE_NUMERIC_CLASS, TableEmpty } from '../components/ui/data-table';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Skeleton } from '../components/ui/skeleton';
import { Spinner } from '../components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { toast } from '../components/ui/toast';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { useI18n } from '../i18n';
import { formatAgo, formatElapsed, formatNumber, formatWhen } from '../lib/format';
import { cn } from '../lib/utils';
import {
  clearBlockedReason,
  callsOn,
  calledMachines,
  clearCallDiagnostics,
  getCallDiagnostics,
  problemGroups,
  problemText,
  summarizeCalls,
  undoClearCallDiagnostics,
  type CallGroup,
  type CallSummary,
} from '../services/callDiagnostics';
import { plainError } from '../services/plainError';
import { useQuotaClock } from '../services/quotaTime';
import type { CallDiagnostics } from '../native/types';
import { MachinePill } from '../components/identity/Identity';
import { SettingsMachineCrumb } from '../components/layout/MachineCrumb';
import { useSettingsScope } from '../services/machineSettings';

const REFRESH_MS = 15_000;
/** Shown while the first read is under way. */
const KEEP_DAYS = 7;

/** Settings › Diagnostics: the failures and slow calls among Arbor's calls to machines and the core. */
export function DiagnosticsSettingsPage() {
  const { t } = useI18n();
  const now = useQuotaClock();
  const [data, setData] = useState<CallDiagnostics | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  // The machine Settings is narrowed to shows its own calls; the core's are about no machine.
  const scope = useSettingsScope();

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setData(await getCallDiagnostics());
      setLoadError(null);
    } catch (error) {
      setLoadError(plainError(error, t));
    } finally {
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Nothing leaves the Mac and Undo brings every call back, so this doesn't ask first. Clear stays put, disabled with
  // nothing left to clear, so focus goes to Undo and comes back to Clear after it.
  const clear = async () => {
    setClearing(true);
    setClearError(null);
    try {
      const cleared = await clearCallDiagnostics(scope);
      await refresh();
      toast({
        title: t(cleared.count === 1 ? 'diagnostics.cleared.one' : 'diagnostics.cleared.other', { count: formatNumber(cleared.count) }),
        description: t('diagnostics.cleared.description'),
        action: {
          label: t('common.undo'),
          onClick: () => {
            undoClearCallDiagnostics(cleared)
              .then(refresh)
              .then(() => clearButton.current?.focus())
              .catch((error: unknown) => toast({ kind: 'error', title: t('diagnostics.undoFailed'), description: String(error) }));
          },
        },
        focusAction: true,
      });
    } catch (error) {
      setClearError(t('diagnostics.clearFailed', { error: plainError(error, t) }));
    } finally {
      setClearing(false);
    }
  };

  const shown = data ? { ...data, calls: callsOn(data.calls, scope) } : null;
  const summary = shown ? summarizeCalls(shown.calls) : null;
  // Clear empties the calls shown: every call, or the narrowed machine's.
  const clearBlocked = clearBlockedReason(summary, loadError !== null);

  return (
    <Page>
      <PageTopbar>
        <PageBreadcrumb
          segments={[
            t('settings.title'),
            t('settings.nav.diagnostics'),
            <SettingsMachineCrumb key="machine" machines={[...(data ? calledMachines(data.calls) : []), ...(scope ? [scope] : [])]} />,
          ]}
        />
      </PageTopbar>
      <PageBody>
        <SettingsSection
          settingId="diagnostics.calls"
          title={t('diagnostics.calls.title')}
          description={t('diagnostics.calls.description', { days: data?.keepDays ?? KEEP_DAYS })}
          headerAction={
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    // Stays focusable while a refresh runs, the one every 15 seconds included, so focus isn't dropped.
                    <Button
                      variant="ghost-muted"
                      size="icon-sm"
                      aria-label={t('diagnostics.refresh')}
                      disabled={refreshing}
                      focusableWhenDisabled
                      onClick={() => void refresh()}
                    />
                  }
                >
                  <RefreshIcon refreshing={refreshing} />
                </TooltipTrigger>
                <TooltipPopup>{t('diagnostics.refresh')}</TooltipPopup>
              </Tooltip>
              <Button
                ref={clearButton}
                variant="ghost-muted"
                size="sm"
                disabled={clearing || clearBlocked !== null}
                disabledReason={clearBlocked && !clearing ? t(clearBlocked) : undefined}
                onClick={() => void clear()}
              >
                {clearing ? <Spinner /> : <Trash2 />}
                {t('diagnostics.clear')}
              </Button>
            </div>
          }
        >
          <CallStats data={shown} summary={summary} loading={!data && !loadError} now={now} />
          {loadError || clearError ? (
            <p className="px-4 py-3 text-sm text-error-foreground" role="alert">
              {clearError ?? t('diagnostics.loadFailed', { error: loadError ?? '' })}
            </p>
          ) : null}
        </SettingsSection>

        <SettingsSection settingId="diagnostics.problems" title={t('diagnostics.problems.title')} description={t('diagnostics.problems.description')}>
          <Problems data={shown} loadFailed={loadError !== null} now={now} />
        </SettingsSection>
      </PageBody>
    </Page>
  );
}

/** The failures and slow calls, or why there are none to show. */
export function Problems({ data, loadFailed, now }: { data: CallDiagnostics | null; loadFailed: boolean; now: number }) {
  const { t } = useI18n();
  if (!data) {
    // The error itself shows above, with the stats.
    return loadFailed ? (
      <TableEmpty>{t('diagnostics.problems.unreadable')}</TableEmpty>
    ) : (
      <TableEmpty><Spinner /></TableEmpty>
    );
  }
  if (!data.calls.length) {
    return (
      <TableEmpty>
        {t('diagnostics.empty.title')}
        <span className="mt-1 block text-xs">{t('diagnostics.empty.description')}</span>
      </TableEmpty>
    );
  }
  const groups = problemGroups(data.calls);
  if (!groups.length) {
    return (
      <TableEmpty>
        {t('diagnostics.quiet.title')}
        <span className="mt-1 block text-xs">{t('diagnostics.quiet.description')}</span>
      </TableEmpty>
    );
  }
  return <ProblemTable groups={groups} now={now} />;
}

export function CallStats({ data, summary, loading, now }: { data: CallDiagnostics | null; summary: CallSummary | null; loading: boolean; now: number }) {
  const { t } = useI18n();
  const value = (read: (current: CallSummary) => string) =>
    summary ? read(summary) : loading ? <Skeleton className="mt-1.5 h-5 w-16" /> : '—';
  return (
    <StatsGrid columns={4} className="rounded-none border-0 shadow-none">
      <StatBlock label={t('diagnostics.stat.calls')} value={value((current) => formatNumber(current.calls))} />
      <StatBlock
        label={t('diagnostics.stat.failed')}
        value={value((current) => formatNumber(current.failed))}
        tone={summary?.failed ? 'danger' : 'default'}
        hint={summary?.timedOut ? t('diagnostics.stat.timedOut', { count: formatNumber(summary.timedOut) }) : undefined}
      />
      <StatBlock
        label={t('diagnostics.stat.slow')}
        value={value((current) => formatNumber(current.slow))}
        tone={summary?.slow ? 'warning' : 'default'}
        hint={data ? t('diagnostics.stat.slowHint', { onMachine: formatElapsed(data.machineSlowMs), core: formatElapsed(data.coreSlowMs) }) : undefined}
      />
      <StatBlock
        label={t('diagnostics.stat.since')}
        value={value((current) => (current.sinceMs === null ? '—' : formatWhen(current.sinceMs, { now })))}
        hint={data?.clearedAtMs ? t('diagnostics.stat.cleared', { time: formatAgo(data.clearedAtMs, now) }) : undefined}
      />
    </StatsGrid>
  );
}

export function ProblemTable({ groups, now }: { groups: CallGroup[]; now: number }) {
  const { t } = useI18n();
  return (
    <Table containerClassName="@container">
      <TableHeader>
        <TableRow>
          <TableHead>{t('diagnostics.column.where')}</TableHead>
          {/* The widest column: the rest fit their numbers, and this truncates only when the window can't fit it. */}
          <TableHead className="w-full">{t('diagnostics.column.operation')}</TableHead>
          <TableHead className={TABLE_NUMERIC_CLASS}>{t('diagnostics.column.calls')}</TableHead>
          <TableHead className={TABLE_NUMERIC_CLASS}>{t('diagnostics.column.failed')}</TableHead>
          <TableHead className={TABLE_NUMERIC_CLASS}>{t('diagnostics.column.slow')}</TableHead>
          <TableHead className={TABLE_NUMERIC_CLASS}>{t('diagnostics.column.p50')}</TableHead>
          <TableHead className={TABLE_NUMERIC_CLASS}>{t('diagnostics.column.p95')}</TableHead>
          <TableHead>{t('diagnostics.column.last')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => {
          const where = group.kind === 'core' ? t('diagnostics.target.core') : group.target;
          const problem = group.lastProblem ? problemText(group.lastProblem) : null;
          const slowPast = t('diagnostics.slowAfter', { time: formatElapsed(group.slowAfterMs) });
          return (
            <TableRow key={group.key} data-group={group.key}>
              <TableCell className="max-w-36">
                {group.kind === 'core'
                  ? <span className="block truncate font-medium text-foreground" title={where}>{where}</span>
                  : <MachinePill name={group.target} size="sm" className="max-w-full" />}
              </TableCell>
              <TableCell className="max-w-0">
                <span className={cn('block truncate', group.kind === 'core' && 'font-mono')} title={group.operation}>{group.operation}</span>
              </TableCell>
              <TableCell className={TABLE_NUMERIC_CLASS}>{formatNumber(group.calls)}</TableCell>
              <TableCell
                className={cn(TABLE_NUMERIC_CLASS, group.failed ? 'text-error-foreground' : 'text-muted-foreground')}
                title={group.timedOut ? t('diagnostics.timedOutCount', { count: formatNumber(group.timedOut) }) : undefined}
              >
                {group.failed ? formatNumber(group.failed) : '—'}
              </TableCell>
              <TableCell className={cn(TABLE_NUMERIC_CLASS, group.slow ? 'text-warning-foreground' : 'text-muted-foreground')} title={slowPast}>
                {group.slow ? formatNumber(group.slow) : '—'}
              </TableCell>
              <TableCell className={TABLE_NUMERIC_CLASS}>{formatElapsed(group.p50Ms)}</TableCell>
              <TableCell className={cn(TABLE_NUMERIC_CLASS, group.p95Ms > group.slowAfterMs && 'text-warning-foreground')}>
                {formatElapsed(group.p95Ms)}
              </TableCell>
              <TableCell>
                {group.lastProblem && problem ? (
                  // In a narrow table when it happened goes under what happened, so nothing is cut off at the edge.
                  <span className="flex flex-col @3xl:flex-row @3xl:items-center @3xl:gap-1.5">
                    <span className={group.lastProblem.outcome === 'ok' ? 'text-warning-foreground' : 'text-error-foreground'}>
                      {t(problem.key, problem.variables)}
                    </span>
                    <span className="hidden text-muted-foreground @3xl:inline">·</span>
                    <span className="text-xs text-muted-foreground @3xl:text-sm">{formatAgo(group.lastProblem.atMs, now)}</span>
                  </span>
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

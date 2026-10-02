import { useEffect, useState, type ReactNode } from 'react';
import { AutomationActions } from '../components/automations/AutomationActions';
import { useConfirmation } from '../components/ConfirmationDialog';
import { toast } from '../components/ui/toast';
import { MachinePill, ModelName, ProviderMark } from '../components/identity/Identity';
import { PoolName } from '../components/PoolName';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TableCard } from '../components/ui/data-table';
import { Empty, EmptyDescription } from '../components/ui/empty';
import { ArrowUpRight, Info } from '../components/ui/icons';
import { Skeleton } from '../components/ui/skeleton';
import { StatusDot } from '../components/ui/status-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useI18n } from '../i18n';
import { formatAgo, formatDateTime, formatDuration, formatRelative, formatWhen } from '../lib/format';
import { cn } from '../lib/utils';
import { automationsView, sessionsView, type AppView } from '../navigation';
import { invokeCommand } from '../native/commands';
import type { Automation, AutomationRun } from '../native/types';
import { AGENT_PROVIDER, loadAutomations, RUN_STATUS_LABEL, RUN_STATUS_TONE, SOURCE_LABEL, scheduleWords, useAutomations } from '../services/automations';
import { useQuotaClock } from '../services/quotaTime';

/** How many runs the page lists. */
const RUNS_SHOWN = 50;

/** One automation: what it's set to do, the prompt, and its runs, newest first. */
export function AutomationPage({ id, onNavigate }: { id: string; onNavigate: (view: AppView) => void }) {
  const { t } = useI18n();
  const { list } = useAutomations();
  const now = useQuotaClock();
  const [automation, setAutomation] = useState<Automation | null>(null);
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const summary = list?.automations.find((item) => item.id === id) ?? automation?.summary ?? null;

  // Read again whenever the list changes: a pause, a save or a run from anywhere shows here too.
  useEffect(() => {
    let current = true;
    Promise.all([invokeCommand('get_automation', { id }), invokeCommand('list_automation_runs', { id, limit: RUNS_SHOWN })])
      .then(([next, nextRuns]) => {
        if (!current) return;
        setAutomation(next);
        setRuns(nextRuns);
        setError(null);
      })
      .catch((reason: unknown) => { if (current) setError(String(reason)); });
    return () => { current = false; };
  }, [id, list]);

  const back = (
    <button type="button" className="cursor-pointer hover:text-foreground" onClick={() => onNavigate(automationsView())}>
      {t('app.nav.automations')}
    </button>
  );

  if (!automation || !summary) {
    return (
      <Page width="main">
        <PageTopbar><PageBreadcrumb segments={[back, summary?.name ?? '']} /></PageTopbar>
        <PageBody gap="gap-4">
          {error ? <p className="text-sm text-error-foreground">{error}</p> : <Skeleton className="h-96 rounded-2xl" />}
        </PageBody>
      </Page>
    );
  }

  const provider = summary.agent ? AGENT_PROVIDER[summary.agent] : null;
  const arbor = summary.source === 'arbor';

  return (
    <Page width="main">
      <PageTopbar actions={<AutomationActions item={summary} onNavigate={onNavigate} />}>
        <PageBreadcrumb segments={[back, summary.name]} />
      </PageTopbar>
      <PageBody gap="gap-4">
        <header className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">{summary.name}</h2>
            <Badge variant={summary.enabled ? 'success' : 'outline'}>{t(summary.enabled ? 'automations.status.enabled' : 'automations.status.paused')}</Badge>
            {!arbor ? <Badge variant="muted">{t(SOURCE_LABEL[summary.source])}</Badge> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {[summary.project, automation.projectPath && automation.projectPath !== summary.project ? automation.projectPath : null].filter(Boolean).join(' · ') || t('automations.noProject')}
          </p>
        </header>

        <Alert icon={<Info />}>
          <AlertDescription>
            {arbor
              ? summary.target.kind === 'best'
                ? t('automations.note.best')
                : summary.target.kind === 'pool'
                  ? t('automations.note.pool')
                  : summary.runsOn === 'machine'
                    ? t('automations.note.machine', { machine: summary.machine ?? '' })
                    : t('automations.note.arbor', { machine: summary.machine ?? '' })
              : t(summary.source === 'claudeDesktop' ? 'automations.note.claude' : summary.source === 'orca' ? 'automations.note.orca' : 'automations.note.codex', { path: automation.sourcePath ?? '' })}
          </AlertDescription>
        </Alert>

        <FactGrid>
          <Fact label={t('automations.fact.schedule')}>
            {scheduleWords(summary.schedule, t)}
            {summary.schedule.kind === 'custom' && automation.rrule ? <span className="block font-mono text-2xs text-muted-foreground">{automation.rrule}</span> : null}
          </Fact>
          <Fact label={t('automations.fact.nextRun')}>
            {summary.enabled && summary.nextRunAtMs
              ? <span title={formatDateTime(summary.nextRunAtMs, { year: 'always' })}>{formatWhen(summary.nextRunAtMs, { now })} ({formatRelative(summary.nextRunAtMs, now)})</span>
              : t(summary.enabled ? 'automations.fact.unknown' : 'automations.status.paused')}
          </Fact>
          <Fact label={t('automations.fact.machine')}>
            {summary.target.kind === 'best' ? t('automations.target.best')
              : summary.target.kind === 'pool' ? <PoolName id={summary.target.id} />
                : <MachinePill name={summary.machine} fallback="—" />}
          </Fact>
          <Fact label={t('automations.fact.agent')}>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              {/* A model's name wears its own mark. */}
              {automation.model ? <ModelName model={automation.model} effort={automation.effort} /> : (
                <>
                  {provider ? <ProviderMark provider={provider} decorative /> : null}
                  {t(`automations.agent.${summary.agent ?? 'other'}`)}
                </>
              )}
            </span>
          </Fact>
          {arbor || summary.source === 'orca' ? (
            <>
              <Fact label={t('automations.fact.workspace')}>{t(automation.workspace === 'newWorktree' ? 'automations.workspace.newWorktree' : 'automations.workspace.checkout')}</Fact>
              <Fact label={t('automations.fact.session')}>{t(automation.session === 'reuse' ? 'automations.session.reuse' : 'automations.session.fresh')}</Fact>
              {arbor ? (
                <Fact label={t('automations.fact.runsOn')}>
                  {automation.summary.runsOn === 'machine' && automation.summary.machine
                    ? t('automations.runsOn.machineShort', { machine: automation.summary.machine })
                    : t('automations.runsOn.appShort')}
                </Fact>
              ) : null}
              {arbor ? (
                <Fact label={t('automations.fact.access')}>
                  <span className={automation.access === 'full' ? 'text-warning-foreground' : undefined}>
                    {t(automation.access === 'full' ? 'automations.access.full' : 'automations.access.edits')}
                  </span>
                </Fact>
              ) : null}
              <Fact label={t('automations.fact.grace')}>{formatDuration(automation.graceMinutes * 60_000)}</Fact>
              <Fact label={t('automations.fact.precheck')}>
                {automation.precheck ? t('automations.fact.precheckOn', { seconds: automation.precheckTimeoutSecs }) : t('automations.fact.precheckOff')}
              </Fact>
            </>
          ) : null}
        </FactGrid>

        {automation.precheck ? (
          <section className="overflow-hidden rounded-2xl border border-border/70 bg-card">
            <h3 className="border-b border-border/50 px-4 py-2.5 text-sm font-medium">{t('automations.precheck.title')}</h3>
            <pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed text-foreground">{automation.precheck}</pre>
            <p className="border-t border-border/50 px-4 py-2 text-xs text-muted-foreground">{t('automations.precheck.explain')}</p>
          </section>
        ) : null}

        <Prompt text={automation.prompt} />

        <TableCard
          title={t('automations.runs.title')}
          count={runs ? t(runs.length === 1 ? 'automations.runs.count.one' : 'automations.runs.count.other', { count: runs.length }) : null}
        >
          {!runs ? (
            <Skeleton className="m-4 h-24" />
          ) : runs.length ? (
            <Table className="min-w-[44rem]">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('automations.runs.when')}</TableHead>
                  <TableHead>{t('automations.runs.status')}</TableHead>
                  <TableHead>{t('automations.fact.machine')}</TableHead>
                  <TableHead className="w-full">{t('automations.runs.precheck')}</TableHead>
                  <TableHead className="text-end">{t('automations.runs.took')}</TableHead>
                  <TableHead><span className="sr-only">{t('automations.runs.session')}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => <RunRow key={run.id} run={run} now={now} onNavigate={onNavigate} />)}
              </TableBody>
            </Table>
          ) : (
            <Empty size="sm"><EmptyDescription>{t(arbor ? 'automations.runs.none' : 'automations.runs.noneOther')}</EmptyDescription></Empty>
          )}
        </TableCard>
      </PageBody>
    </Page>
  );
}

function FactGrid({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-2xl border border-border/70 bg-card px-4 py-4 sm:grid-cols-4">{children}</dl>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm text-foreground">{children}</dd>
    </div>
  );
}

/** The prompt, a few lines of it until it's opened out. */
function Prompt({ text }: { text: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const long = text.length > 320 || text.split('\n').length > 5;
  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-card">
      <header className="flex items-center justify-between border-b border-border/50 px-4 py-2">
        <h3 className="text-sm font-medium">{t('automations.prompt.title')}</h3>
        {long ? <Button variant="ghost-muted" size="xs" onClick={() => setOpen(!open)}>{t(open ? 'automations.prompt.less' : 'automations.prompt.more')}</Button> : null}
      </header>
      <p className={cn('whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed text-foreground', !open && long && 'line-clamp-4')}>{text}</p>
    </section>
  );
}

function RunRow({ run, now, onNavigate }: { run: AutomationRun; now: number; onNavigate: (view: AppView) => void }) {
  const { t } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [stopping, setStopping] = useState(false);
  // Stopping kills the agent mid-run, which can't be taken back, so it asks first.
  const stop = async () => {
    const confirmed = await askConfirmation({
      title: t('automations.runs.stopTitle'),
      message: t('automations.runs.stopMessage'),
      confirmText: t('automations.runs.stop'),
      variant: 'danger',
    });
    if (!confirmed) return;
    setStopping(true);
    try {
      await invokeCommand('cancel_automation_run', { runId: run.id });
      await loadAutomations();
    } catch (reason) {
      toast({ kind: 'error', title: t('automations.runs.stopFailed'), description: String(reason) });
    } finally {
      setStopping(false);
    }
  };
  const took = run.startedAtMs && run.finishedAtMs ? run.finishedAtMs - run.startedAtMs : null;
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground" title={formatDateTime(run.scheduledAtMs, { seconds: true, year: 'always' })}>
        {formatWhen(run.scheduledAtMs, { now })}
        <span className="block text-2xs text-muted-foreground">{run.manual ? t('automations.runs.manual') : formatAgo(run.scheduledAtMs, now)}</span>
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs">
        <span className={cn('inline-flex items-center gap-1.5', run.status === 'failed' && 'text-error-foreground')}>
          <StatusDot tone={RUN_STATUS_TONE[run.status]} />
          {t(RUN_STATUS_LABEL[run.status])}
        </span>
        {run.error ? <span className="block max-w-56 truncate text-2xs text-muted-foreground" title={run.error}>{run.error}</span> : null}
      </TableCell>
      <TableCell className="text-xs"><MachinePill name={run.machine} fallback="—" size="sm" /></TableCell>
      <TableCell className="max-w-0 text-xs">
        {run.precheckExit === null
          ? <span className="text-muted-foreground">—</span>
          : <span className="block truncate font-mono text-2xs text-muted-foreground" title={run.precheckOutput ?? undefined}>
              <span className={run.precheckExit === 0 ? 'text-success-foreground' : 'text-muted-foreground'}>{t('automations.runs.exit', { code: run.precheckExit })}</span>
              {run.precheckOutput ? ` · ${run.precheckOutput}` : ''}
            </span>}
      </TableCell>
      <TableCell className="whitespace-nowrap text-end text-xs tabular-nums text-muted-foreground">{took !== null ? formatDuration(took) : '—'}</TableCell>
      <TableCell className="whitespace-nowrap text-end">
        {run.status === 'running' && run.automationId.startsWith('arbor:') ? (
          <Button variant="ghost-muted" size="xs" disabled={stopping} onClick={() => void stop()}>{t('automations.runs.stop')}</Button>
        ) : null}
        {run.sessionId ? (
          <Button variant="ghost-muted" size="xs" onClick={() => onNavigate(sessionsView({ session: run.sessionId ?? undefined }))}>
            {t('automations.runs.openSession')}
            <ArrowUpRight />
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

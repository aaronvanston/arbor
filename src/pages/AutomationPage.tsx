import { useEffect, useState, type ReactNode } from 'react';
import { AutomationActions } from '../components/automations/AutomationActions';
import { AutomationAppName } from '../components/automations/AutomationApp';
import { MarkdownPreview } from '../components/MarkdownPreview';
import { useConfirmation } from '../components/ConfirmationDialog';
import { toast } from '../components/ui/toast';
import { HarnessName } from '../components/identity/Harness';
import { MachinePill, ModelName } from '../components/identity/Identity';
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
import { Toggle, ToggleGroup } from '../components/ui/toggle-group';
import { useI18n } from '../i18n';
import { formatAgo, formatDateTime, formatDuration, formatRelative, formatWhen } from '../lib/format';
import { cn } from '../lib/utils';
import { automationsView, sessionsView, type AppView } from '../navigation';
import { invokeCommand } from '../native/commands';
import type { Automation, AutomationRun } from '../native/types';
import { AUTOMATION_APPS, automationHold, automationTargetGone, loadAutomations, RUN_STATUS_LABEL, RUN_STATUS_TONE, scheduleWords, useAutomations } from '../services/automations';
import { AutomationHoldNote } from '../components/automations/AutomationHoldNote';
import { useQuotaClock } from '../services/quotaTime';
import { usePools } from '../services/pools';

/** How many runs the page lists. */
const RUNS_SHOWN = 50;

/** One automation: what it's set to do, the prompt, and its runs, newest first. */
export function AutomationPage({ id, onNavigate }: { id: string; onNavigate: (view: AppView) => void }) {
  const { t } = useI18n();
  const { list } = useAutomations();
  const { pools } = usePools();
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

  const arbor = summary.source === 'arbor';
  const gone = automationTargetGone(summary, pools);
  // Settings' switch pauses every one of Arbor's own, so the next run isn't due while it's off either.
  const willRun = summary.enabled && !(arbor && list?.running === false);

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
            <Badge variant="muted"><AutomationAppName source={summary.source} /></Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {[summary.project, automation.projectPath && automation.projectPath !== summary.project ? automation.projectPath : null].filter(Boolean).join(' · ') || t('automations.noProject')}
          </p>
        </header>

        {arbor && summary.enabled ? (
          <AutomationHoldNote hold={automationHold(list, summary.agent)} onOpenSettings={() => onNavigate({ kind: 'settings', page: 'machines' })} />
        ) : null}

        <Alert icon={<Info />} variant={gone ? 'warning' : undefined}>
          <AlertDescription>
            {gone
              ? t(gone === 'best' ? 'automations.note.bestGone' : 'automations.note.poolGone')
              : arbor
              ? summary.target.kind === 'best'
                ? t('automations.note.best')
                : summary.target.kind === 'pool'
                  ? t('automations.note.pool')
                  : summary.runsOn === 'machine'
                    ? t('automations.note.machine', { machine: summary.machine ?? '' })
                    : t('automations.note.arbor', { machine: summary.machine ?? '' })
              : t(AUTOMATION_APPS[summary.source].note ?? 'automations.note.codex', { path: automation.sourcePath ?? '' })}
          </AlertDescription>
        </Alert>

        <FactGrid>
          <Fact label={t('automations.fact.schedule')}>
            {scheduleWords(summary.schedule, t)}
            {summary.schedule.kind === 'custom' && automation.rrule ? <span className="block font-mono text-2xs text-muted-foreground">{automation.rrule}</span> : null}
          </Fact>
          <Fact label={t('automations.fact.nextRun')}>
            {willRun && summary.nextRunAtMs
              ? <span title={formatDateTime(summary.nextRunAtMs, { year: 'always' })}>{formatWhen(summary.nextRunAtMs, { now })} ({formatRelative(summary.nextRunAtMs, now)})</span>
              : t(willRun ? 'automations.fact.unknown' : 'automations.status.paused')}
          </Fact>
          <Fact label={t('automations.fact.machine')}>
            {summary.target.kind === 'best' ? t('automations.target.best')
              : summary.target.kind === 'pool' ? <PoolName id={summary.target.id} />
                : <MachinePill name={summary.machine} fallback="—" />}
          </Fact>
          <Fact label={t('automations.fact.model')}>
            <ModelFact model={automation.model ?? summary.model} effort={automation.model ? automation.effort : null} agent={summary.agent} fromRun={!automation.model && Boolean(summary.model)} />
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
            </>
          ) : null}
        </FactGrid>

        <RunSteps automation={automation} runs={runs} now={now} />

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
            <Empty size="sm"><EmptyDescription>{t(!arbor ? 'automations.runs.noneOther' : summary.enabled ? 'automations.runs.none' : 'automations.runs.nonePaused')}</EmptyDescription></Empty>
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

/** The model, or the agent while no run has said which model it used. */
function ModelFact({ model, effort, agent, fromRun }: { model: string | null; effort: string | null; agent: Automation['summary']['agent']; fromRun: boolean }) {
  const { t } = useI18n();
  if (!model) {
    return (
      <span title={t('automations.model.unknown')}><HarnessName harness={agent} /></span>
    );
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {/* A model's name wears its own mark. */}
      <ModelName model={model} effort={effort} />
      {fromRun ? <span className="truncate text-xs text-muted-foreground">{t('automations.fact.modelFromRun')}</span> : null}
    </span>
  );
}

/** What each run does, in order: the pre-flight check, then the agent with the prompt. */
function RunSteps({ automation, runs, now }: { automation: Automation; runs: AutomationRun[] | null; now: number }) {
  const { t } = useI18n();
  const checked = runs?.find((run) => run.precheckExit !== null);
  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-card" aria-label={t('automations.steps.title')}>
      <h3 className="border-b border-border/50 px-4 py-2.5 text-sm font-medium">{t('automations.steps.title')}</h3>
      <ol className="flex flex-col px-4 py-3">
        <Step
          number={1}
          title={t('automations.step.precheck')}
          meta={automation.precheck ? (
            <>
              <span>{t('automations.step.precheckLimit', { seconds: automation.precheckTimeoutSecs })}</span>
              {checked && checked.precheckExit !== null ? (
                <span className={cn('inline-flex items-center gap-1.5', checked.precheckExit === 0 && 'text-success-foreground')} title={checked.precheckOutput ?? undefined}>
                  <StatusDot tone={checked.precheckExit === 0 ? 'success' : 'muted'} />
                  {t(checked.precheckExit === 0 ? 'automations.step.precheckPassed' : 'automations.step.precheckStopped', {
                    code: checked.precheckExit,
                    when: formatAgo(checked.startedAtMs ?? checked.scheduledAtMs, now),
                  })}
                </span>
              ) : null}
            </>
          ) : null}
        >
          {automation.precheck ? (
            <>
              <pre className="overflow-x-auto rounded-md border border-border/60 bg-muted/60 px-3 py-2 font-mono text-xs leading-5 text-foreground dark:bg-input/16">{automation.precheck}</pre>
              <p className="text-xs text-muted-foreground">{t('automations.precheck.explain')}</p>
            </>
          ) : <p className="text-xs text-muted-foreground">{t('automations.step.precheckNone')}</p>}
        </Step>
        <Step number={2} title={t('automations.step.agent')} last>
          <Prompt text={automation.prompt} />
        </Step>
      </ol>
    </section>
  );
}

function Step({ number, title, meta, last = false, children }: { number: number; title: string; meta?: ReactNode; last?: boolean; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3">
      <div className="flex flex-col items-center">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-medium tabular-nums text-muted-foreground">{number}</span>
        {last ? null : <span aria-hidden="true" className="my-1 w-px flex-1 bg-border" />}
      </div>
      <div className={cn('flex min-w-0 flex-col gap-2', !last && 'pb-5')}>
        <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1">
          <h4 className="text-sm font-medium text-foreground">{title}</h4>
          {meta ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{meta}</div> : null}
        </div>
        {children}
      </div>
    </li>
  );
}

/** The prompt, as markdown or as written, a few lines of it until it's opened out. */
function Prompt({ text }: { text: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [plain, setPlain] = useState(false);
  const long = text.length > 480 || text.split('\n').length > 10;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{t('automations.prompt.title')}</span>
        <ToggleGroup
          value={[plain ? 'plain' : 'formatted']}
          aria-label={t('automations.prompt.view')}
          onValueChange={(values) => {
            const [next] = values;
            if (next === 'plain' || next === 'formatted') setPlain(next === 'plain');
          }}
        >
          <Toggle value="formatted">{t('automations.prompt.formatted')}</Toggle>
          <Toggle value="plain">{t('automations.prompt.plain')}</Toggle>
        </ToggleGroup>
      </div>
      <div className={cn('rounded-lg border border-border/60 px-3 py-2.5', !open && long && 'max-h-56 overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]')}>
        {plain
          ? <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">{text}</p>
          : <MarkdownPreview source={text} />}
      </div>
      {long ? (
        <Button variant="ghost-muted" size="xs" className="self-start" onClick={() => setOpen(!open)}>
          {t(open ? 'automations.prompt.less' : 'automations.prompt.more')}
        </Button>
      ) : null}
    </div>
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

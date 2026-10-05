import { useEffect, useMemo, useState } from 'react';
import { HarnessName } from '../components/identity/Harness';
import { MachinePill, ModelName } from '../components/identity/Identity';
import { PoolName } from '../components/PoolName';
import { MachineCrumb } from '../components/layout/MachineCrumb';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { WithShortcut } from '../components/ShortcutKbd';
import { AutomationDialog } from '../components/automations/AutomationDialog';
import { AutomationActions } from '../components/automations/AutomationActions';
import { AutomationAppName } from '../components/automations/AutomationApp';
import { AutomationHoldNote } from '../components/automations/AutomationHoldNote';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TableCard } from '../components/ui/data-table';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { CirclePause, Plus, Search, TimeSchedule, TriangleAlert } from '../components/ui/icons';
import { Input } from '../components/ui/input';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { StatusDot } from '../components/ui/status-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Toggle, ToggleGroup } from '../components/ui/toggle-group';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { useShortcut } from '../hooks/useShortcuts';
import { useI18n } from '../i18n';
import { formatAgo, formatDateTime, formatRelative, formatWhen } from '../lib/format';
import { cn } from '../lib/utils';
import { automationView, automationsView, type AppView, type AutomationsParams } from '../navigation';
import type { AutomationSource, AutomationSummary } from '../native/types';
import {
  AUTOMATION_STATES,
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  STATE_LABEL,
  automationMachines,
  automationsHold,
  automationModels,
  filterAutomations,
  loadAutomations,
  scanAutomations,
  scheduleWords,
  showAutomations,
  sourceChoices,
  stateCounts,
  type AutomationState,
  useAutomations,
} from '../services/automations';
import { invokeCommand } from '../native/commands';
import { useQuotaClock } from '../services/quotaTime';
import { AutomationPage } from './AutomationPage';

/**
 * Fleet › Automations: every automation on every machine, Arbor's own and the ones other apps keep, or one
 * automation's own page when the view names it.
 */
export function AutomationsPage({ params, onNavigate, onViewChange }: {
  params?: AutomationsParams;
  onNavigate: (view: AppView) => void;
  onViewChange: (view: AppView) => void;
}) {
  useEffect(() => { void loadAutomations(); }, []);
  if (params?.automation) return <AutomationPage id={params.automation} onNavigate={onNavigate} />;
  return <AutomationsList machine={params?.machine ?? ''} onNavigate={onNavigate} onViewChange={onViewChange} />;
}

function AutomationsList({ machine, onNavigate, onViewChange }: {
  machine: string;
  onNavigate: (view: AppView) => void;
  onViewChange: (view: AppView) => void;
}) {
  const { t } = useI18n();
  const { list, error, loading } = useAutomations();
  const now = useQuotaClock();
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<AutomationSource | 'all'>('all');
  const [state, setState] = useState<AutomationState>('on');
  const [model, setModel] = useState('all');
  const [creating, setCreating] = useState(false);
  const automations = useMemo(() => list?.automations ?? [], [list]);
  const sources: (AutomationSource | 'all')[] = ['all', ...sourceChoices(list?.scans ?? [], source)];
  const shown = useMemo(
    () => filterAutomations(automations, { search, source, machine, state, model }),
    [automations, search, source, machine, state, model],
  );
  const counts = useMemo(() => stateCounts(automations, { search, source, machine, model }), [automations, search, source, machine, model]);
  // Failing joins the switch only while something is, or while it's the one picked.
  const states = AUTOMATION_STATES.filter((entry) => entry !== 'failing' || counts.failing > 0 || state === 'failing');
  // Only the models something runs with, and the one picked even once nothing does.
  const models = useMemo(() => {
    const present = automationModels(automations);
    return model === 'all' || present.includes(model) ? present : [...present, model];
  }, [automations, model]);
  const machines = useMemo(() => automationMachines(automations), [automations]);
  const failedScans = list?.scans.filter((scan) => scan.error) ?? [];
  const refresh = () => { void scanAutomations(); };
  useShortcut('page.refresh', refresh, !loading);

  const sourceLabel = (value: AutomationSource | 'all') => (value === 'all' ? t('automations.source.all') : <AutomationAppName source={value} />);
  const modelLabel = (value: string) => (value === 'all' ? t('automations.model.all') : <ModelName model={value} />);

  return (
    <Page width="main">
      <PageTopbar
        actions={(
          <>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              {t('automations.new')}
            </Button>
            <Tooltip>
              <TooltipTrigger render={<Button variant="outline" size="icon-sm" disabled={loading} focusableWhenDisabled onClick={refresh} aria-label={t('automations.scan')} />}>
                <RefreshIcon refreshing={loading} />
              </TooltipTrigger>
              <TooltipPopup><WithShortcut id="page.refresh">{t('automations.scan')}</WithShortcut></TooltipPopup>
            </Tooltip>
          </>
        )}
      >
        <PageBreadcrumb segments={[
          t('app.nav.automations'),
          <MachineCrumb key="machine" machine={machine} machines={machines} onChange={(next) => onViewChange(automationsView(next ? { machine: next } : {}))} />,
        ]}
        />
      </PageTopbar>
      <PageBody gap="gap-4">
        {list && !list.running ? (
          <Alert
            variant="warning"
            icon={<CirclePause />}
            action={(
              <Button size="sm" variant="outline" onClick={() => { void invokeCommand('set_automations_running', { running: true }).then(showAutomations); }}>
                {t('automations.paused.resume')}
              </Button>
            )}
          >
            <AlertTitle>{t('automations.paused.title')}</AlertTitle>
            <AlertDescription>{t('automations.paused.description')}</AlertDescription>
          </Alert>
        ) : null}
        {/* Turned off says so above; this is the other thing that stops them, which Run now wouldn't show until a run failed. */}
        {list?.running ? <AutomationHoldNote hold={automationsHold(list)} onOpenSettings={() => onNavigate({ kind: 'settings', page: 'machines' })} /> : null}
        {failedScans.map((scan) => (
          <p key={scan.machine} className="flex items-center gap-1.5 text-xs text-warning-foreground">
            <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            {t('automations.scanFailed', { machine: scan.machine, error: scan.error ?? '' })}
          </p>
        ))}
        {error && !list ? <p className="text-sm text-error-foreground">{error}</p> : null}
        {!list ? (
          <Skeleton className="h-72 rounded-2xl" />
        ) : !automations.length ? (
          <Empty>
            <EmptyMedia><TimeSchedule /></EmptyMedia>
            <EmptyTitle>{t('automations.empty.title')}</EmptyTitle>
            <EmptyDescription>{t('automations.empty.description')}</EmptyDescription>
            <Button size="sm" className="mt-2" onClick={() => setCreating(true)}>
              <Plus />
              {t('automations.new')}
            </Button>
          </Empty>
        ) : (
          <TableCard
            title={t('app.nav.automations')}
            nav={(
              <ToggleGroup
                value={[state]}
                aria-label={t('automations.state.label')}
                onValueChange={(values) => {
                  const [next] = values;
                  if (typeof next === 'string' && next !== state) setState(next as AutomationState);
                }}
              >
                {states.map((entry) => (
                  <Toggle key={entry} value={entry} className={cn(entry === 'failing' && 'text-error-foreground data-pressed:text-error-foreground')}>
                    {t(STATE_LABEL[entry])}
                    <span className="tabular-nums opacity-64">{counts[entry]}</span>
                  </Toggle>
                ))}
              </ToggleGroup>
            )}
            toolbar={(
              <>
                <Input
                  size="sm"
                  wrapperClassName="w-56"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('automations.search')}
                  aria-label={t('automations.search')}
                  startAddon={<Search />}
                />
                <Select value={model} onValueChange={(value) => setModel(value ?? 'all')}>
                  <SelectTrigger size="sm" className="w-auto min-w-32" aria-label={t('automations.model.label')}>
                    <SelectValue>{modelLabel(model)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {['all', ...models].map((entry) => <SelectItem key={entry} value={entry}>{modelLabel(entry)}</SelectItem>)}
                  </SelectPopup>
                </Select>
                <Select value={source} onValueChange={(value) => setSource((value ?? 'all') as AutomationSource | 'all')}>
                  <SelectTrigger size="sm" className="w-auto min-w-36" aria-label={t('automations.source.label')}>
                    <SelectValue>{sourceLabel(source)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {sources.map((entry) => <SelectItem key={entry} value={entry}>{sourceLabel(entry)}</SelectItem>)}
                  </SelectPopup>
                </Select>
              </>
            )}
          >
            {shown.length ? (
              <Table containerClassName="@container" className="min-w-[64rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-full">{t('automations.column.name')}</TableHead>
                    <TableHead>{t('automations.column.app')}</TableHead>
                    <TableHead>{t('automations.column.schedule')}</TableHead>
                    <TableHead>{t('automations.column.project')}</TableHead>
                    <TableHead>{t('automations.column.machine')}</TableHead>
                    <TableHead>{t('automations.column.model')}</TableHead>
                    <TableHead>{t('automations.column.nextRun')}</TableHead>
                    <TableHead>{t('automations.column.lastRun')}</TableHead>
                    <TableHead><span className="sr-only">{t('automations.column.actions')}</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((item) => (
                    <AutomationRow key={item.id} item={item} now={now} markPaused={state === 'all'} onOpen={() => onNavigate(automationView(item.id))} onNavigate={onNavigate} />
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Empty size="sm">
                <EmptyDescription>{t('automations.empty.filtered')}</EmptyDescription>
              </Empty>
            )}
          </TableCard>
        )}
        <p className="text-center text-xs text-muted-foreground">{t('automations.whileOpen')}</p>
      </PageBody>
      {creating ? <AutomationDialog open onOpenChange={setCreating} machine={machine || null} onSaved={(saved) => onNavigate(automationView(saved.summary.id))} /> : null}
    </Page>
  );
}

function AutomationRow({ item, now, markPaused, onOpen, onNavigate }: {
  item: AutomationSummary;
  now: number;
  /** Badge a paused one, where the switch shows them alongside the rest. */
  markPaused: boolean;
  onOpen: () => void;
  onNavigate: (view: AppView) => void;
}) {
  const { t } = useI18n();
  const last = item.lastRun;
  return (
    <TableRow className={cn('cursor-pointer transition-colors hover:bg-muted/50 dark:hover:bg-input/16', !item.enabled && 'text-muted-foreground')} onClick={onOpen}>
      <TableCell className="w-full max-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('truncate text-sm font-medium', item.enabled ? 'text-foreground' : 'text-muted-foreground')}>{item.name}</span>
          {markPaused && !item.enabled ? <Badge variant="outline" size="sm" className="shrink-0">{t('automations.status.paused')}</Badge> : null}
        </span>
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground"><AutomationAppName source={item.source} className="w-max" /></TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{scheduleWords(item.schedule, t)}</TableCell>
      <TableCell className="max-w-36 truncate text-xs text-muted-foreground">{item.project ?? '—'}</TableCell>
      <TableCell className="text-xs">
        {item.target.kind === 'best'
          ? <span className="whitespace-nowrap text-muted-foreground">{t('automations.target.best')}</span>
          : item.target.kind === 'pool'
            ? <PoolName id={item.target.id} className="max-w-32" />
            : <MachinePill name={item.machine} fallback="—" size="sm" className="max-w-32" />}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs">
        {item.model ? <ModelName model={item.model} className="w-max" /> : (
          // Until a run says which model, the agent stands in for it.
          <span className="text-muted-foreground" title={t('automations.model.unknown')}><HarnessName harness={item.agent} className="w-max" /></span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        {item.nextRunAtMs && item.enabled
          ? <span title={formatDateTime(item.nextRunAtMs, { year: 'always' })}>{formatWhen(item.nextRunAtMs, { now })} ({formatRelative(item.nextRunAtMs, now)})</span>
          : '—'}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs">
        {last ? (
          <span className={cn('inline-flex items-center gap-1.5', last.status === 'failed' ? 'text-error-foreground' : 'text-muted-foreground')} title={formatDateTime(last.atMs, { year: 'always' })}>
            <StatusDot tone={RUN_STATUS_TONE[last.status]} />
            {t('automations.lastRun', { status: t(RUN_STATUS_LABEL[last.status]), when: formatAgo(last.atMs, now) })}
          </span>
        ) : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell onClick={(event) => event.stopPropagation()}>
        <AutomationActions item={item} onNavigate={onNavigate} compact />
      </TableCell>
    </TableRow>
  );
}

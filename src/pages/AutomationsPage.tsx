import { useEffect, useMemo, useState } from 'react';
import { MachinePill, ProviderMark } from '../components/identity/Identity';
import { PoolName } from '../components/PoolName';
import { MachineCrumb } from '../components/layout/MachineCrumb';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { WithShortcut } from '../components/ShortcutKbd';
import { AutomationDialog } from '../components/automations/AutomationDialog';
import { AutomationActions } from '../components/automations/AutomationActions';
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
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { useShortcut } from '../hooks/useShortcuts';
import { useI18n } from '../i18n';
import { formatAgo, formatDateTime, formatRelative, formatWhen } from '../lib/format';
import { cn } from '../lib/utils';
import { automationView, automationsView, type AppView, type AutomationsParams } from '../navigation';
import type { AutomationAgent, AutomationSource, AutomationSummary } from '../native/types';
import {
  AGENT_PROVIDER,
  AUTOMATION_STATES,
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  SOURCE_LABEL,
  STATE_LABEL,
  automationAgents,
  automationMachines,
  filterAutomations,
  loadAutomations,
  scanAutomations,
  scheduleWords,
  showAutomations,
  type AutomationState,
  useAutomations,
} from '../services/automations';
import { invokeCommand } from '../native/commands';
import { useQuotaClock } from '../services/quotaTime';
import { AutomationPage } from './AutomationPage';

const SOURCES: readonly (AutomationSource | 'all')[] = ['all', 'arbor', 'codexApp', 'claudeDesktop', 'orca'];

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
  const [state, setState] = useState<AutomationState>('all');
  const [agent, setAgent] = useState<AutomationAgent | 'all'>('all');
  const [creating, setCreating] = useState(false);
  const automations = useMemo(() => list?.automations ?? [], [list]);
  // Orca's filter only once Orca's been found somewhere, like any other app's feature.
  const orcaFound = Boolean(list?.scans.some((scan) => scan.orca));
  const sources = SOURCES.filter((entry) => entry !== 'orca' || orcaFound || source === 'orca');
  const shown = useMemo(
    () => filterAutomations(automations, { search, source, machine, state, agent }),
    [automations, search, source, machine, state, agent],
  );
  // Only the agents something starts, and the one picked even once nothing does.
  const agents = useMemo(() => {
    const present = automationAgents(automations);
    return agent === 'all' || present.includes(agent) ? present : [...present, agent];
  }, [automations, agent]);
  const machines = useMemo(() => automationMachines(automations), [automations]);
  const failedScans = list?.scans.filter((scan) => scan.error) ?? [];
  const refresh = () => { void scanAutomations(); };
  useShortcut('page.refresh', refresh, !loading);

  const sourceLabel = (value: AutomationSource | 'all') => (value === 'all' ? t('automations.source.all') : t(SOURCE_LABEL[value]));
  const agentLabel = (value: AutomationAgent | 'all') => {
    if (value === 'all') return t('automations.agent.all');
    const provider = AGENT_PROVIDER[value];
    return (
      <span className="inline-flex items-center gap-2">
        {provider ? <ProviderMark provider={provider} decorative /> : null}
        {t(`automations.agent.${value}`)}
      </span>
    );
  };

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
            count={t(shown.length === 1 ? 'automations.count.one' : 'automations.count.other', { count: shown.length })}
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
                <Select value={state} onValueChange={(value) => setState((value ?? 'all') as AutomationState)}>
                  <SelectTrigger size="sm" className="w-auto min-w-32" aria-label={t('automations.state.label')}>
                    <SelectValue>{t(STATE_LABEL[state])}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {AUTOMATION_STATES.map((entry) => <SelectItem key={entry} value={entry}>{t(STATE_LABEL[entry])}</SelectItem>)}
                  </SelectPopup>
                </Select>
                <Select value={agent} onValueChange={(value) => setAgent((value ?? 'all') as AutomationAgent | 'all')}>
                  <SelectTrigger size="sm" className="w-auto min-w-32" aria-label={t('automations.agent.label')}>
                    <SelectValue>{agentLabel(agent)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {(['all', ...agents] as const).map((entry) => <SelectItem key={entry} value={entry}>{agentLabel(entry)}</SelectItem>)}
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
              <Table containerClassName="@container" className="min-w-[56rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-full">{t('automations.column.name')}</TableHead>
                    <TableHead>{t('automations.column.schedule')}</TableHead>
                    <TableHead>{t('automations.column.project')}</TableHead>
                    <TableHead>{t('automations.column.machine')}</TableHead>
                    <TableHead>{t('automations.column.nextRun')}</TableHead>
                    <TableHead>{t('automations.column.lastRun')}</TableHead>
                    <TableHead>{t('automations.column.agent')}</TableHead>
                    <TableHead><span className="sr-only">{t('automations.column.actions')}</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((item) => (
                    <AutomationRow key={item.id} item={item} now={now} onOpen={() => onNavigate(automationView(item.id))} onNavigate={onNavigate} />
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

function AutomationRow({ item, now, onOpen, onNavigate }: {
  item: AutomationSummary;
  now: number;
  onOpen: () => void;
  onNavigate: (view: AppView) => void;
}) {
  const { t } = useI18n();
  const provider = item.agent ? AGENT_PROVIDER[item.agent] : null;
  const last = item.lastRun;
  return (
    <TableRow className={cn('cursor-pointer transition-colors hover:bg-muted/50 dark:hover:bg-input/16', !item.enabled && 'text-muted-foreground')} onClick={onOpen}>
      <TableCell className="w-full max-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('truncate text-sm font-medium', item.enabled ? 'text-foreground' : 'text-muted-foreground')}>{item.name}</span>
          {item.source !== 'arbor' ? <Badge variant="muted" size="sm" className="shrink-0">{t(SOURCE_LABEL[item.source])}</Badge> : null}
          {!item.enabled ? <Badge variant="outline" size="sm" className="shrink-0">{t('automations.status.paused')}</Badge> : null}
        </span>
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{scheduleWords(item.schedule, t)}</TableCell>
      <TableCell className="max-w-36 truncate text-xs text-muted-foreground">{item.project ?? '—'}</TableCell>
      <TableCell className="text-xs">
        {item.target.kind === 'best'
          ? <span className="whitespace-nowrap text-muted-foreground">{t('automations.target.best')}</span>
          : item.target.kind === 'pool'
            ? <PoolName id={item.target.id} className="max-w-32" />
            : <MachinePill name={item.machine} fallback="—" size="sm" className="max-w-32" />}
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
      <TableCell>{provider ? <ProviderMark provider={provider} className="size-4" /> : <span className="text-muted-foreground">—</span>}</TableCell>
      <TableCell onClick={(event) => event.stopPropagation()}>
        <AutomationActions item={item} onNavigate={onNavigate} compact />
      </TableCell>
    </TableRow>
  );
}

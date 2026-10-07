import { createColumnHelper } from '@tanstack/react-table';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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
import { DataGrid, useDataGrid, type DataGridColumnDef, type DataGridColumnMeta, type DataGridFeatures, type DataGridSort } from '../components/ui/data-grid/data-grid';
import { DataGridColumnsMenu } from '../components/ui/data-grid/data-grid-columns';
import { gridLayout, type DataGridLayout } from '../components/ui/data-grid/data-grid-layout';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { ChevronDown, ChevronRight, CirclePause, FoldVertical, Plus, Search, TimeSchedule, TriangleAlert } from '../components/ui/icons';
import { Input } from '../components/ui/input';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { StatusDot } from '../components/ui/status-dot';
import { Toggle, ToggleGroup } from '../components/ui/toggle-group';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { useShortcut } from '../hooks/useShortcuts';
import { useI18n } from '../i18n';
import { formatAgo, formatDateTime, formatRelative, formatWhen } from '../lib/format';
import { cn } from '../lib/utils';
import { automationView, automationsView, type AppView, type AutomationsParams } from '../navigation';
import type { AutomationSource, AutomationSummary } from '../native/types';
import {
  AUTOMATION_APPS,
  AUTOMATION_STATES,
  automationGroupSummary,
  automationRowId,
  automationRows,
  automationsGrouped,
  automationRunner,
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  STATE_LABEL,
  automationMachines,
  automationsHold,
  automationModels,
  agentOfModelChoice,
  filterAutomations,
  loadAutomations,
  scanAutomations,
  scheduleWords,
  showAutomations,
  sortAutomations,
  sourceChoices,
  stateCounts,
  type AutomationGroupSummary,
  type AutomationRow,
  type AutomationSort,
  type AutomationState,
  useAutomations,
} from '../services/automations';
import { invokeCommand } from '../native/commands';
import { useQuotaClock } from '../services/quotaTime';
import { plainError } from '../services/plainError';
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
  const [sort, setSort] = useState<AutomationSort | null>(null);
  const [creating, setCreating] = useState(false);
  const automations = useMemo(() => list?.automations ?? [], [list]);
  const sources: (AutomationSource | 'all')[] = ['all', ...sourceChoices(list?.scans ?? [], source)];
  const shown = useMemo(
    () => sortAutomations(filterAutomations(automations, { search, source, machine, state, model }), sort),
    [automations, search, source, machine, state, model, sort],
  );
  const grouped = automationsGrouped.useValue();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => setOpen((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  }), []);
  const rows = useMemo(() => automationRows(shown, { grouped, open }), [shown, grouped, open]);
  const columns = useAutomationColumns({ now, markPaused: state === 'all', open, onToggle: toggle, onNavigate });
  const grid = useDataGrid({ data: rows, columns, getRowId: automationRowId, storageKey: AUTOMATIONS_GRID_KEY, initialLayout: defaultAutomationsLayout });
  const foldable = useMemo(() => automationRows(shown, { grouped: true, open: new Set() }).some((row) => row.kind === 'group'), [shown]);
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
  const modelLabel = (value: string) => {
    if (value === 'all') return t('automations.model.all');
    const agent = agentOfModelChoice(value);
    return agent ? <HarnessName harness={agent} /> : <ModelName model={value} />;
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
        {/* Turned off says so above; this is the other thing that stops them, which Run now wouldn't show until a run failed. */}
        {list?.running ? <AutomationHoldNote hold={automationsHold(list)} onOpenSettings={() => onNavigate({ kind: 'settings', page: 'machines' })} /> : null}
        {failedScans.map((scan) => (
          <p key={scan.machine} className="flex items-center gap-1.5 text-xs text-warning-foreground">
            <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            {t('automations.scanFailed', { machine: scan.machine, error: plainError(scan.error ?? '', t) })}
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
                {foldable || !grouped ? (
                  <Tooltip>
                    <TooltipTrigger render={<Button variant={grouped ? 'secondary' : 'outline'} size="sm" aria-pressed={grouped} onClick={() => automationsGrouped.set(!grouped)} />}>
                      <FoldVertical />
                      {t('automations.group.toggle')}
                    </TooltipTrigger>
                    <TooltipPopup>{t('automations.group.toggleHint')}</TooltipPopup>
                  </Tooltip>
                ) : null}
                <DataGridColumnsMenu grid={grid} defaultLayout={defaultAutomationsLayout} />
              </>
            )}
          >
            {shown.length ? (
              <DataGrid
                grid={grid}
                label={t('app.nav.automations')}
                surface="card"
                sorting={sort}
                onSortingChange={(next: DataGridSort | null) => setSort(next && (next.column === 'nextRun' || next.column === 'lastRun') ? { column: next.column, descending: next.descending } : null)}
                onRowClick={(row) => (row.kind === 'group' ? toggle(row.key) : onNavigate(automationView(row.item.id)))}
                rowClassName={(row) => (row.kind === 'item' && row.inGroup ? 'bg-muted/30 dark:bg-input/8' : undefined)}
              />
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

const AUTOMATIONS_GRID_KEY = 'arbor.automations-grid.v1';

type AutomationColumnId = 'name' | 'runsIn' | 'schedule' | 'project' | 'machine' | 'model' | 'nextRun' | 'lastRun' | 'actions';

const COLUMN_SIZES: Record<AutomationColumnId, { size: number; minSize: number }> = {
  name: { size: 220, minSize: 120 },
  runsIn: { size: 110, minSize: 80 },
  schedule: { size: 150, minSize: 90 },
  project: { size: 100, minSize: 60 },
  machine: { size: 130, minSize: 80 },
  model: { size: 130, minSize: 80 },
  nextRun: { size: 170, minSize: 100 },
  lastRun: { size: 140, minSize: 90 },
  actions: { size: 44, minSize: 44 },
};

const COLUMN_IDS = Object.keys(COLUMN_SIZES) as AutomationColumnId[];

/** Every column showing, the name held at the start and the row's actions at the end, so both stay as it scrolls. */
function defaultAutomationsLayout(): DataGridLayout {
  const layout = gridLayout(COLUMN_IDS.map((id) => ({ id, minSize: COLUMN_SIZES[id].minSize })), COLUMN_IDS, ['name']);
  return { ...layout, pinning: { start: ['name'], end: ['actions'] } };
}

const helper = createColumnHelper<DataGridFeatures, AutomationRow>();

/** What starts it, with a tooltip saying where and whether Arbor needs to be open. */
function RunsIn({ item }: { item: AutomationSummary }) {
  const { t } = useI18n();
  const runner = automationRunner(item);
  const machine = item.machine ?? '';
  const why = item.source === 'arbor'
    ? t(runner === 'ultradian' ? 'automations.runsIn.placed' : 'automations.runsIn.arbor', { machine })
    : item.source === 'ultradian'
      ? t('automations.runsIn.own', { machine })
      : t('automations.runsIn.app', { app: t(AUTOMATION_APPS[item.source].label) });
  return <span title={why} className="text-muted-foreground"><AutomationAppName source={runner} className="max-w-full" /></span>;
}

/** A run's next time, as the list says it. */
function NextRun({ at, now }: { at: number | null; now: number }) {
  return at ? <span title={formatDateTime(at, { year: 'always' })}>{formatWhen(at, { now })} ({formatRelative(at, now)})</span> : <>—</>;
}

/** How the last run went, and when. */
function LastRun({ last, now }: { last: AutomationSummary['lastRun']; now: number }) {
  const { t } = useI18n();
  if (!last) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn('inline-flex items-center gap-1.5', last.status === 'failed' ? 'text-error-foreground' : 'text-muted-foreground')} title={formatDateTime(last.atMs, { year: 'always' })}>
      <StatusDot tone={RUN_STATUS_TONE[last.status]} />
      {t('automations.lastRun', { status: t(RUN_STATUS_LABEL[last.status]), when: formatAgo(last.atMs, now) })}
    </span>
  );
}

function useAutomationColumns({ now, markPaused, open, onToggle, onNavigate }: {
  now: number;
  markPaused: boolean;
  /** The folds that are open. */
  open: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onNavigate: (view: AppView) => void;
}): DataGridColumnDef<AutomationRow>[] {
  const { t } = useI18n();
  return useMemo(() => {
    const summaries = new WeakMap<AutomationSummary[], AutomationGroupSummary>();
    const summed = (items: AutomationSummary[]) => {
      const known = summaries.get(items);
      if (known) return known;
      const next = automationGroupSummary(items);
      summaries.set(items, next);
      return next;
    };
    const varies = <span className="text-muted-foreground" title={t('automations.group.variesHint')}>{t('automations.group.varies')}</span>;
    const column = (
      id: AutomationColumnId,
      header: string,
      cell: (item: AutomationSummary, inGroup: boolean) => ReactNode,
      group: (items: AutomationSummary[], key: string) => ReactNode,
      meta: Partial<DataGridColumnMeta> = {},
      fixed = false,
    ) =>
      helper.display({
        id,
        header,
        ...COLUMN_SIZES[id],
        enableResizing: !fixed,
        cell: ({ row }) => (row.original.kind === 'group' ? group(row.original.items, row.original.key) : cell(row.original.item, row.original.inGroup !== null)),
        meta: { label: header, ...meta },
      });
    const muted = 'text-xs text-muted-foreground';
    const columns: Record<AutomationColumnId, DataGridColumnDef<AutomationRow>> = {
      name: column('name', t('automations.column.name'), (item, inGroup) => (
        <span className={cn('flex min-w-0 items-center gap-2', inGroup && 'ps-6')}>
          <span className={cn('truncate text-sm', inGroup ? 'text-muted-foreground' : 'font-medium', item.enabled ? !inGroup && 'text-foreground' : 'text-muted-foreground')}>{item.name}</span>
          {markPaused && !item.enabled ? <Badge variant="outline" size="sm" className="shrink-0">{t('automations.status.paused')}</Badge> : null}
        </span>
      ), (items, key) => {
        const opened = open.has(key);
        const first = items[0];
        return (
          <span className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className="flex shrink-0 cursor-pointer items-center rounded-sm text-icon-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5"
              aria-expanded={opened}
              aria-label={t(opened ? 'automations.group.collapse' : 'automations.group.expand', { name: first?.name ?? '' })}
              onClick={() => onToggle(key)}
            >
              {opened ? <ChevronDown /> : <ChevronRight />}
            </button>
            <span className="truncate text-sm font-medium text-foreground">{first?.name}</span>
            <Badge variant="muted" size="sm" className="shrink-0 tabular-nums">{items.length}</Badge>
          </span>
        );
      }),
      runsIn: column('runsIn', t('automations.column.app'), (item) => <RunsIn item={item} />, (items) => (items[0] ? <RunsIn item={items[0]} /> : null), { cellClassName: 'text-xs' }),
      schedule: column('schedule', t('automations.column.schedule'), (item) => scheduleWords(item.schedule, t), (items) => {
        const { schedule } = summed(items);
        return schedule.value ? scheduleWords(schedule.value, t) : varies;
      }, { cellClassName: muted }),
      project: column('project', t('automations.column.project'), (item) => item.project ?? '—', (items) => {
        const { project } = summed(items);
        return project.varies ? varies : project.value ?? '—';
      }, { cellClassName: muted }),
      machine: column('machine', t('automations.column.machine'), (item) => (
        item.target.kind === 'best'
          ? <span className="text-muted-foreground">{t('automations.target.best')}</span>
          : item.target.kind === 'pool'
            ? <PoolName id={item.target.id} className="max-w-full" />
            : <MachinePill name={item.machine} fallback="—" size="sm" className="max-w-full" />
      ), (items) => {
        const { machines } = summed(items);
        const [only] = machines;
        return machines.length === 1 && only
          ? <MachinePill name={only} size="sm" className="max-w-full" />
          : <span className="text-muted-foreground" title={machines.join(', ')}>{t(machines.length === 1 ? 'automations.group.machines.one' : 'automations.group.machines.other', { count: machines.length })}</span>;
      }, { cellClassName: 'text-xs' }),
      model: column('model', t('automations.column.model'), (item) => (
        item.model ? <ModelName model={item.model} className="max-w-full" /> : (
          // Until a run says which model, the agent stands in for it.
          <span className="text-muted-foreground" title={t('automations.model.unknown')}>{item.agent ? <HarnessName harness={item.agent} className="max-w-full" /> : '—'}</span>
        )
      ), (items) => {
        const { model } = summed(items);
        const agent = items[0]?.agent;
        if (model.varies) return varies;
        if (model.value) return <ModelName model={model.value} className="max-w-full" />;
        return <span className="text-muted-foreground">{agent && items.every((item) => item.agent === agent) ? <HarnessName harness={agent} className="max-w-full" /> : '—'}</span>;
      }, { cellClassName: 'text-xs' }),
      nextRun: column('nextRun', t('automations.column.nextRun'), (item) => <NextRun at={item.enabled ? item.nextRunAtMs : null} now={now} />, (items) => <NextRun at={summed(items).nextRunAtMs} now={now} />, { cellClassName: cn(muted, 'tabular-nums'), sort: 'time' }),
      lastRun: column('lastRun', t('automations.column.lastRun'), (item) => <LastRun last={item.lastRun} now={now} />, (items) => {
        const { failing, lastRun } = summed(items);
        // One failing among them says so, over however the newest went.
        return failing > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-error-foreground">
            <StatusDot tone="error" />
            {t('automations.group.failing', { count: failing, total: items.length })}
          </span>
        ) : <LastRun last={lastRun} now={now} />;
      }, { cellClassName: 'text-xs', sort: 'time' }),
      actions: column('actions', t('automations.column.actions'), (item) => <AutomationActions item={item} onNavigate={onNavigate} compact />, () => null, { fixed: true, cellClassName: 'px-1' }, true),
    };
    return COLUMN_IDS.map((id) => columns[id]);
  }, [t, now, markPaused, open, onToggle, onNavigate]);
}

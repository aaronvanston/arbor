import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ArrowDownToLine, ChevronRight, FolderGit2, HardDrive, Search, TriangleAlert } from '../components/ui/icons';
import { ChangesHeader, FileChanges, type CopyLabels } from '../components/FileChanges';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TableCard, TableEmpty } from '../components/ui/data-table';
import { Checkbox } from '../components/ui/checkbox';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../components/ui/dialog';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Input } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { StatusDot, type StatusTone } from '../components/ui/status-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Toggle, ToggleGroup } from '../components/ui/toggle-group';
import { MiddleTruncate } from '../components/ui/middle-truncate';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { useI18n } from '../i18n';
import { plainError } from '../services/plainError';
import type { MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import type { FileView } from '../services/fileView';
import { formatBytes } from '../services/machineHealth';
import {
  branchFate,
  buildProjects,
  canClean,
  chosenWorktrees,
  FETCH_STALE_MS,
  getProjects,
  looksSecret,
  machineTotals,
  matchesProject,
  measureProjects,
  needsLook,
  needsScan,
  ownSizeKb,
  placeSummary,
  readProjectFile,
  removableWhy,
  removalCounts,
  removalPlan,
  removeWorktrees,
  scanProjects,
  SETUP_PROJECTS_UPDATED_EVENT,
  tilde,
  worktreeOwner,
  type FileRow,
  type FileVariant,
  type ProjectPlace,
  type ProjectRow,
  type WorktreeOwner,
} from '../services/setupProjects';
import type {
  Blocker,
  MachineProjects,
  ProjectRepo,
  ProjectWorktree,
  RemovalOutcome,
  RemovalResult,
  SetupMachine,
  SetupText,
} from '../native/types';
import { MachinePill } from '../components/identity/Identity';
import { FixMenu } from '../components/FixMenu';
import { checkoutProblem } from '../services/fixPrompt';
import { useAgo, useNow } from '../hooks/useNow';

type Translate = ReturnType<typeof useI18n>['t'];
type Filter = 'all' | 'look' | 'clean';
/** The worktrees chosen for removal on each machine, by path. */
type Chosen = Record<string, string[]>;

const BLOCKER_TEXT: Record<Blocker, MessageKey> = {
  main: 'setup.projects.blocker.main',
  locked: 'setup.projects.blocker.locked',
  nested: 'setup.projects.blocker.nested',
  missing: 'setup.projects.blocker.missing',
  unknown: 'setup.projects.blocker.unknown',
  dirty: 'setup.projects.blocker.dirty',
  hidden: 'setup.projects.blocker.hidden',
  midway: 'setup.projects.blocker.midway',
  unreachable: 'setup.projects.blocker.unreachable',
  open: 'setup.projects.blocker.open',
  recent: 'setup.projects.blocker.recent',
  defaultBranch: 'setup.projects.blocker.defaultBranch',
  notMerged: 'setup.projects.blocker.notMerged',
};

const OWNER_TEXT: Record<WorktreeOwner, MessageKey> = {
  t3: 'setup.projects.owner.t3',
  claude: 'setup.projects.owner.claude',
  codex: 'setup.projects.owner.codex',
};

const OUTCOME_LOOK: Record<RemovalOutcome, { tone: StatusTone; key: MessageKey }> = {
  removed: { tone: 'success', key: 'setup.projects.outcome.removed' },
  gone: { tone: 'muted', key: 'setup.projects.outcome.gone' },
  changed: { tone: 'warning', key: 'setup.projects.outcome.changed' },
  busy: { tone: 'warning', key: 'setup.projects.outcome.busy' },
  skipped: { tone: 'muted', key: 'setup.projects.outcome.skipped' },
  failed: { tone: 'error', key: 'setup.projects.outcome.failed' },
};

const size = (kb: number | null) => (kb === null ? null : formatBytes(kb * 1024));

/**
 * The git checkouts sessions have worked in on each machine: one row a project, one column a machine, each copy's
 * branch and how it stands, its worktrees with the ones that can go, and whether its instruction files match.
 */
export function SetupProjects({ machines, embedded = false }: {
  machines: SetupMachine[];
  /** Under a heading of its own (a machine's page), so it leaves out its introduction. */
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<MachineProjects[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [chosen, setChosen] = useState<Chosen>({});
  const [reviewing, setReviewing] = useState(false);
  const [comparing, setComparing] = useState<FileComparison | null>(null);
  const autoScanned = useRef(new Set<string>());

  const reload = useCallback(() => {
    getProjects()
      .then((next) => { setProjects(next); setLoadError(null); })
      .catch((error) => setLoadError(String(error)));
  }, []);
  useEffect(() => {
    reload();
    let unlisten: (() => void) | null = null;
    let live = true;
    void listen(SETUP_PROJECTS_UPDATED_EVENT, reload).then((stop) => { if (live) unlisten = stop; else stop(); });
    return () => { live = false; unlisten?.(); };
  }, [reload]);

  const run = useCallback((machine: string, action: 'scan' | 'fetch' | 'measure') => {
    setActionErrors((current) => { const next = { ...current }; delete next[machine]; return next; });
    const done = action === 'measure' ? measureProjects(machine) : scanProjects(machine, action === 'fetch');
    done.catch((error) => setActionErrors((current) => ({ ...current, [machine]: String(error) })));
  }, []);

  // Machines never scanned, or not lately, are looked at once each time the tab opens.
  useEffect(() => {
    if (projects === null) return;
    for (const machine of machines) {
      if (!machine.reachable || autoScanned.current.has(machine.machine)) continue;
      if (!needsScan(projects.find((entry) => entry.machine === machine.machine), Date.now())) continue;
      autoScanned.current.add(machine.machine);
      void scanProjects(machine.machine).catch(() => undefined);
    }
  }, [projects, machines]);

  const byMachine = useMemo(() => new Map((projects ?? []).map((entry) => [entry.machine, entry])), [projects]);
  const columns = useMemo(() => machines.map((machine) => machine.machine), [machines]);
  const rows = useMemo(() => buildProjects(columns.flatMap((machine) => byMachine.get(machine) ?? [])), [byMachine, columns]);
  const lookCount = rows.filter(needsLook).length;
  const cleanCount = rows.filter(canClean).length;
  const shown = rows.filter((row) => (filter === 'look' ? needsLook(row) : filter === 'clean' ? canClean(row) : true) && matchesProject(row, query));
  const chosenCount = Object.values(chosen).reduce((sum, paths) => sum + paths.length, 0);
  const chosenMachines = Object.values(chosen).filter((paths) => paths.length).length;
  const anyScanned = (projects ?? []).some((entry) => entry.scannedAt !== null);
  const scanning = (projects ?? []).some((entry) => entry.scanning);

  const toggle = (key: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const choose = (machine: string, path: string, on: boolean) => setChosen((current) => {
    const paths = (current[machine] ?? []).filter((entry) => entry !== path);
    return { ...current, [machine]: on ? [...paths, path] : paths };
  });

  if (projects === null) {
    return loadError ? (
      <Alert variant="error" icon={<TriangleAlert />}>
        <AlertDescription>{t('setup.projects.loadFailed', { error: loadError })}</AlertDescription>
      </Alert>
    ) : (
      <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Spinner />{t('setup.projects.loading')}</p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {embedded ? null : <p className="max-w-3xl text-xs leading-[1.5] text-muted-foreground">{t('setup.projects.intro')}</p>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-2">
        {machines.map((machine) => (
          <MachineCard
            key={machine.machine}
            machine={machine}
            projects={byMachine.get(machine.machine) ?? null}
            error={actionErrors[machine.machine] ?? null}
            onRun={(action) => run(machine.machine, action)}
          />
        ))}
      </div>
      {!anyScanned ? (
        scanning ? (
          <p className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Spinner />{t('setup.projects.firstScan')}</p>
        ) : (
          <Empty>
            <EmptyMedia><FolderGit2 /></EmptyMedia>
            <EmptyTitle>{t('setup.projects.notScanned.title')}</EmptyTitle>
            <EmptyDescription>{t('setup.projects.notScanned.description')}</EmptyDescription>
          </Empty>
        )
      ) : (
        // The filter and search only narrow this table, so they sit in its card's head.
        <TableCard
          // A machine's page heads it Checkouts already, so there it says how it's laid out instead.
          title={t(embedded ? 'setup.projects.table.titleEmbedded' : 'setup.projects.table.title')}
          count={shown.length === rows.length
            ? t(rows.length === 1 ? 'setup.projects.table.count.one' : 'setup.projects.table.count.other', { count: rows.length })
            : t('setup.projects.table.shown', { shown: shown.length, total: rows.length })}
          toolbar={rows.length ? (
            <>
              <ToggleGroup value={[filter]} onValueChange={(value) => { const next = value[0]; if (next === 'all' || next === 'look' || next === 'clean') setFilter(next); }} aria-label={t('setup.projects.filter.label')}>
                <Toggle value="all">{t('setup.projects.filter.all')}<Badge variant="muted" size="sm" className="ms-0.5">{rows.length}</Badge></Toggle>
                <Toggle value="look">{t('setup.projects.filter.look')}{lookCount ? <Badge variant="warning" size="sm" className="ms-0.5">{lookCount}</Badge> : null}</Toggle>
                <Toggle value="clean">{t('setup.projects.filter.clean')}{cleanCount ? <Badge variant="info" size="sm" className="ms-0.5">{cleanCount}</Badge> : null}</Toggle>
              </ToggleGroup>
              <Input
                type="search"
                data-page-search
                size="sm"
                wrapperClassName="w-56"
                startAddon={<Search />}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('setup.projects.search')}
                aria-label={t('setup.projects.search')}
              />
            </>
          ) : null}
        >
          {!rows.length ? (
            <TableEmpty>
              {t('setup.projects.none.title')}
              <span className="mt-1 block text-xs">{t('setup.projects.none.description')}</span>
            </TableEmpty>
          ) : !shown.length ? (
            <TableEmpty>
              {query.trim() ? t('setup.projects.noMatches', { query: query.trim() }) : t(filter === 'clean' ? 'setup.projects.nothingToClean' : 'setup.projects.nothingToLook')}
            </TableEmpty>
          ) : (
            <Table stickyHeader containerClassName="max-h-[calc(100vh-var(--workspace-topbar-height)-19rem)] min-h-64 overflow-auto">
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-10 min-w-60 bg-card">{t('setup.projects.column.project')}</TableHead>
                  {columns.map((machine) => <TableHead key={machine} className="min-w-40"><MachinePill name={machine} /></TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((row) => (
                  <Fragment key={row.key}>
                    <ProjectRowView row={row} columns={columns} open={expanded.has(row.key)} onToggle={() => toggle(row.key)} />
                    {expanded.has(row.key) ? (
                      <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
                        <TableCell colSpan={columns.length + 1} className="bg-muted/24 p-0 dark:bg-input/8">
                          <ProjectDetail
                            row={row}
                            columns={columns}
                            chosen={chosen}
                            onChoose={choose}
                            onCompare={setComparing}
                          />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          )}
        </TableCard>
      )}
      {chosenCount ? (
        <div className="sticky bottom-4 z-30 flex flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-background/95 px-4 py-2.5 shadow-lg/5 backdrop-blur dark:bg-card/95">
          <p className="me-auto text-sm text-foreground">
            {t(chosenCount === 1 ? 'setup.projects.chosen.one' : chosenMachines > 1 ? 'setup.projects.chosen.across' : 'setup.projects.chosen.other', { count: chosenCount, machines: chosenMachines })}
          </p>
          <Button variant="ghost-muted" size="sm" onClick={() => setChosen({})}>{t('setup.projects.chosen.clear')}</Button>
          <Button size="sm" onClick={() => setReviewing(true)}>{t('setup.projects.chosen.review')}</Button>
        </div>
      ) : null}
      <RemoveDialog
        open={reviewing}
        chosen={chosen}
        byMachine={byMachine}
        onClose={() => setReviewing(false)}
        onDone={(machine) => {
          setChosen((current) => ({ ...current, [machine]: [] }));
          void scanProjects(machine).catch(() => undefined);
        }}
      />
      <FileCompareDialog comparison={comparing} onClose={() => setComparing(null)} />
    </div>
  );
}

function MachineCard({ machine, projects, error, onRun }: {
  machine: SetupMachine;
  projects: MachineProjects | null;
  error: string | null;
  onRun: (action: 'scan' | 'fetch' | 'measure') => void;
}) {
  const { t } = useI18n();
  // Its own times, so the half-minute clock renders these lines rather than the whole view.
  const scannedAgo = useAgo(projects?.scannedAt);
  const fetchedAgo = useAgo(projects?.fetchedAt);
  const busy = Boolean(projects?.scanning || projects?.measuring || projects?.removing);
  const failure = error ?? projects?.error ?? null;
  const totals = projects && projects.scannedAt !== null ? machineTotals(projects) : null;
  const status = projects?.scanning
    ? t('setup.projects.machine.scanning')
    : projects?.measuring
      ? t('setup.projects.machine.measuring')
      : projects?.removing
        ? t('setup.projects.machine.removing')
        : failure
        ? t('setup.projects.machine.failed')
        : projects?.scannedAt != null
          ? t('setup.projects.machine.scanned', { time: scannedAgo })
          : machine.reachable
            ? t('setup.projects.machine.waiting')
            : t('setup.projects.machine.away');
  const why = busy ? t('setup.projects.machine.busy') : !machine.reachable ? t('setup.projects.machine.awayHint') : undefined;
  const measureWhy = why ?? (totals === null ? t('setup.projects.machine.measureFirst') : undefined);
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border/70 bg-card px-3 py-2 shadow-xs/5">
      <div className="flex min-w-0 items-center gap-1.5">
        <MachinePill name={machine.machine} />
        {machine.local ? <span className="shrink-0 text-2xs text-muted-foreground">{t('setup.machine.thisMac')}</span> : null}
        <div className="ms-auto flex shrink-0 items-center">
          <Button variant="ghost-muted" size="icon-xs" disabledReason={why} onClick={() => onRun('scan')} aria-label={t('setup.projects.machine.scan', { machine: machine.machine })} title={t('setup.projects.machine.scan', { machine: machine.machine })}>
            <RefreshIcon refreshing={Boolean(projects?.scanning)} />
          </Button>
          <Button variant="ghost-muted" size="icon-xs" disabledReason={why} onClick={() => onRun('fetch')} aria-label={t('setup.projects.machine.fetch', { machine: machine.machine })} title={t('setup.projects.machine.fetch', { machine: machine.machine })}>
            <ArrowDownToLine />
          </Button>
          <Button variant="ghost-muted" size="icon-xs" disabledReason={measureWhy} onClick={() => onRun('measure')} aria-label={t('setup.projects.machine.measure', { machine: machine.machine })} title={t('setup.projects.machine.measure', { machine: machine.machine })}>
            <HardDrive />
          </Button>
        </div>
      </div>
      <div className={cn('flex min-w-0 items-center gap-1 text-2xs', failure ? 'text-warning-foreground' : 'text-muted-foreground')} title={failure ?? undefined}>
        {busy ? <Spinner className="size-3" /> : failure ? <TriangleAlert className="size-3 shrink-0" aria-hidden="true" /> : null}
        <span className="truncate">{status}</span>
        {projects?.fetchedAt != null && !busy && !failure ? <span className="truncate">· {t('setup.projects.machine.fetched', { time: fetchedAgo })}</span> : null}
      </div>
      {failure ? <p className="line-clamp-2 text-2xs text-muted-foreground" title={failure}>{failure}</p> : null}
      {totals ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground/85">
          <span>{t(totals.repos === 1 ? 'setup.projects.machine.repos.one' : 'setup.projects.machine.repos.other', { count: totals.repos })}</span>
          <span className="text-muted-foreground">·</span>
          <span>{t(totals.worktrees === 1 ? 'setup.projects.machine.worktrees.one' : 'setup.projects.machine.worktrees.other', { count: totals.worktrees })}</span>
          {totals.sizeKb !== null ? <><span className="text-muted-foreground">·</span><span>{size(totals.sizeKb)}</span></> : null}
          {totals.removable ? (
            <Badge variant="info" size="sm">
              {totals.reclaimKb !== null
                ? t('setup.projects.machine.canGoSize', { count: totals.removable, size: size(totals.reclaimKb) ?? '' })
                : t('setup.projects.machine.canGo', { count: totals.removable })}
            </Badge>
          ) : null}
        </div>
      ) : null}
      {projects?.partial ? <p className="text-2xs text-warning-foreground">{t('setup.projects.machine.partial')}</p> : null}
    </div>
  );
}

function ProjectRowView({ row, columns, open, onToggle }: { row: ProjectRow; columns: string[]; open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const filesDiffer = row.files.some((file) => file.differs);
  return (
    <TableRow className="cursor-pointer" onClick={onToggle}>
      <TableCell className="sticky left-0 z-10 max-w-80 bg-card">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            className="-ms-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-2"
            aria-expanded={open}
            aria-label={t(open ? 'setup.projects.row.collapse' : 'setup.projects.row.expand', { name: row.name })}
            onClick={(event) => { event.stopPropagation(); onToggle(); }}
          >
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          </button>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono text-xs text-foreground" title={row.remote ?? row.name}>{row.name}</span>
              {filesDiffer ? <Badge variant="warning" size="sm">{t('setup.projects.row.filesDiffer')}</Badge> : null}
            </span>
            <span className="truncate text-2xs text-muted-foreground" title={row.note}>{row.note}</span>
          </div>
        </div>
      </TableCell>
      {columns.map((machine) => {
        const places = row.places[machine] ?? [];
        const [first] = places;
        return (
          <TableCell key={machine} className="max-w-60 text-xs">
            {first ? <PlaceCell repo={first.repo} more={places.length - 1} /> : <Dash title={t('setup.projects.cell.notHere', { machine })} />}
          </TableCell>
        );
      })}
    </TableRow>
  );
}

const Dash = ({ title }: { title?: string }) => <span className="text-muted-foreground/60" title={title}>—</span>;

function Sync({ ahead, behind }: { ahead: number | null; behind: number | null }) {
  const { t } = useI18n();
  if (!ahead && !behind) return null;
  return (
    <span className="shrink-0 font-mono text-2xs" title={t('setup.projects.sync.title', { ahead: ahead ?? 0, behind: behind ?? 0 })}>
      {ahead ? <span className="text-info-foreground">↑{ahead}</span> : null}
      {ahead && behind ? ' ' : null}
      {behind ? <span className="text-warning-foreground">↓{behind}</span> : null}
    </span>
  );
}

function PlaceCell({ repo, more }: { repo: ProjectRepo; more: number }) {
  const { t } = useI18n();
  if (repo.state === 'missing') return <span className="text-warning-foreground">{t('setup.projects.cell.missing')}</span>;
  if (repo.state === 'notGit') return <span className="text-warning-foreground">{t('setup.projects.cell.notGit')}</span>;
  const summary = placeSummary(repo);
  const notes = [
    summary.changes ? t(summary.changes === 1 ? 'setup.projects.cell.changes.one' : 'setup.projects.cell.changes.other', { count: summary.changes }) : null,
    summary.worktrees ? t(summary.worktrees === 1 ? 'setup.projects.cell.worktrees.one' : 'setup.projects.cell.worktrees.other', { count: summary.worktrees }) : null,
    more > 0 ? t(more === 1 ? 'setup.projects.cell.clones.one' : 'setup.projects.cell.clones.other', { count: more }) : null,
  ].filter(Boolean);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        {!summary.bare && summary.branch
          ? <MiddleTruncate value={summary.branch} className="font-mono text-foreground/85" />
          : <span className="truncate font-mono text-foreground/85">{summary.bare ? t('setup.projects.cell.bare') : t('setup.projects.cell.detached')}</span>}
        <Sync ahead={summary.ahead} behind={summary.behind} />
        {repo.fetchFailed ? <span className="shrink-0 text-warning-foreground" title={t('setup.projects.cell.fetchFailed')}><TriangleAlert className="size-3" aria-hidden="true" /></span> : null}
      </span>
      {notes.length || summary.removable ? (
        <span className="flex min-w-0 items-center gap-1.5 text-2xs">
          {notes.length ? <span className={cn('truncate', summary.changes ? 'text-warning-foreground' : 'text-muted-foreground')}>{notes.join(' · ')}</span> : null}
          {summary.removable ? <span className="shrink-0 text-info-foreground">{t('setup.projects.cell.canGo', { count: summary.removable })}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

function ProjectDetail({ row, columns, chosen, onChoose, onCompare }: {
  row: ProjectRow;
  columns: string[];
  chosen: Chosen;
  onChoose: (machine: string, path: string, on: boolean) => void;
  onCompare: (comparison: FileComparison) => void;
}) {
  const places = columns.flatMap((machine) => row.places[machine] ?? []);
  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      {row.files.length ? <FilesView row={row} columns={columns} onCompare={onCompare} /> : null}
      {places.map((place) => (
        <PlaceDetail key={`${place.machine}\u0000${place.repo.path}`} place={place} chosen={chosen[place.machine] ?? []} onChoose={(path, on) => onChoose(place.machine, path, on)} />
      ))}
    </div>
  );
}

function FilesView({ row, columns, onCompare }: { row: ProjectRow; columns: string[]; onCompare: (comparison: FileComparison) => void }) {
  const { t } = useI18n();
  const holders = columns.filter((machine) => row.files.some((file) => machine in file.cells));
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-xs font-medium text-muted-foreground">{t('setup.projects.files.title')}</h4>
      <div className="overflow-hidden rounded-lg border border-border/60 bg-background/60 dark:bg-card">
        <Table density="compact">
          <TableHeader>
            <TableRow>
              <TableHead>{t('setup.projects.files.file')}</TableHead>
              {holders.map((machine) => <TableHead key={machine}><MachinePill name={machine} size="sm" /></TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {row.files.map((file) => (
              <TableRow key={file.name}>
                <TableCell className="font-mono text-foreground/90">{file.name}</TableCell>
                {holders.map((machine) => (
                  <TableCell key={machine}>
                    <FileCell file={file} machine={machine} project={row.name} onCompare={onCompare} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function FileCell({ file, machine, project, onCompare }: { file: FileRow; machine: string; project: string; onCompare: (comparison: FileComparison) => void }) {
  const { t } = useI18n();
  const variant = file.cells[machine];
  if (variant === undefined) return <Dash />;
  if (variant === null) return <span className="text-muted-foreground">{t('setup.projects.files.missing')}</span>;
  const reference = Object.values(file.cells).find((cell): cell is FileVariant => cell !== null && cell.letter === 'A') ?? null;
  const canCompare = file.differs && reference !== null && reference.place.machine !== machine && variant.letter !== 'A';
  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant={file.differs ? (variant.letter === 'A' ? 'outline' : 'warning') : 'success'} size="sm" title={t('setup.projects.files.variantTitle', { letter: variant.letter })}>{variant.letter}</Badge>
      <span className="text-muted-foreground">{formatBytes(variant.size)}</span>
      {canCompare ? (
        <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={() => onCompare({ project, name: file.name, reference, other: variant })}>
          {t('setup.projects.files.compare')}
        </Button>
      ) : null}
    </span>
  );
}

function PlaceDetail({ place, chosen, onChoose }: {
  place: ProjectPlace;
  chosen: string[];
  onChoose: (path: string, on: boolean) => void;
}) {
  const { t } = useI18n();
  const { repo, homeDir, machine } = place;
  const fetchedAgo = useAgo(repo.fetchedAt);
  const usedAgo = useAgo(repo.lastUsedMs);
  const facts = [
    repo.defaultBranch ? t('setup.projects.detail.default', { branch: repo.defaultBranch }) : null,
    repo.fetchedAt !== null ? t('setup.projects.detail.fetched', { time: fetchedAgo }) : repo.remote ? t('setup.projects.detail.neverFetched') : null,
    repo.lastUsedMs !== null ? t('setup.projects.detail.used', { time: usedAgo }) : null,
  ].filter(Boolean);
  const stale = useNow((nowMs) => repo.fetchedAt !== null && nowMs - repo.fetchedAt > FETCH_STALE_MS);
  const worktreeIssues = repo.worktrees.flatMap((worktree) => {
    const dirty = (worktree.changed ?? 0) + (worktree.untracked ?? 0);
    const states = [
      worktree.prunable ? t('setup.projects.worktree.folderGone') : null,
      dirty ? t('setup.projects.worktree.dirty', { changed: worktree.changed ?? 0, untracked: worktree.untracked ?? 0 }) : null,
      worktree.behind ? t('fix.detail.behindBy', { count: worktree.behind }) : null,
    ].filter((state): state is string => state !== null);
    return states.length
      ? [t('fix.detail.worktree', { path: tilde(worktree.path, homeDir), branch: worktree.branch ?? t('setup.projects.cell.detached'), state: states.join(', ') })]
      : [];
  });
  const issues = [
    repo.state === 'missing' ? t('setup.projects.detail.missing') : repo.state !== 'ok' ? t('setup.projects.detail.notGit') : null,
    repo.fetchFailed ? t('setup.projects.cell.fetchFailed') : null,
    stale ? t('setup.projects.detail.stale') : null,
    ...worktreeIssues,
  ].filter((issue): issue is string => issue !== null);
  const problem = issues.length
    ? checkoutProblem({ project: tilde(repo.path, homeDir).split('/').pop() ?? repo.path, path: tilde(repo.path, homeDir), remote: repo.remote, defaultBranch: repo.defaultBranch, issues }, t)
    : null;
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <h4 className="flex min-w-0"><MachinePill name={machine} /></h4>
        <MiddleTruncate value={tilde(repo.path, homeDir)} title={repo.path} className="font-mono text-xs text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{facts.join(' · ')}</span>
        {repo.fetchFailed ? <span className="text-xs text-warning-foreground">{t('setup.projects.cell.fetchFailed')}</span> : null}
        {stale ? <span className="text-xs text-warning-foreground">{t('setup.projects.detail.stale')}</span> : null}
        {problem ? <FixMenu machine={machine} problem={problem} className="ms-auto -my-1" /> : null}
      </div>
      {repo.state !== 'ok' ? (
        <p className="text-xs text-warning-foreground">{t(repo.state === 'missing' ? 'setup.projects.detail.missing' : 'setup.projects.detail.notGit')}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border/60 bg-background/60 dark:bg-card">
          <Table density="compact">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"><span className="sr-only">{t('setup.projects.worktree.choose')}</span></TableHead>
                <TableHead>{t('setup.projects.worktree.path')}</TableHead>
                <TableHead>{t('setup.projects.worktree.branch')}</TableHead>
                <TableHead>{t('setup.projects.worktree.changes')}</TableHead>
                <TableHead>{t('setup.projects.worktree.used')}</TableHead>
                <TableHead className="text-end">{t('setup.projects.worktree.size')}</TableHead>
                <TableHead>{t('setup.projects.worktree.cleanup')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {repo.worktrees.map((worktree) => (
                <WorktreeLine
                  key={worktree.path}
                  repo={repo}
                  worktree={worktree}
                  homeDir={homeDir}
                  chosen={chosen.includes(worktree.path)}
                  onChoose={(on) => onChoose(worktree.path, on)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function WorktreeLine({ repo, worktree, homeDir, chosen, onChoose }: {
  repo: ProjectRepo;
  worktree: ProjectWorktree;
  homeDir: string;
  chosen: boolean;
  onChoose: (on: boolean) => void;
}) {
  const { t } = useI18n();
  const owner = worktreeOwner(worktree.path, homeDir);
  const shownPath = worktree.main ? tilde(worktree.path, homeDir) : worktree.path.startsWith(`${repo.path}/`) ? `…${worktree.path.slice(repo.path.length)}` : tilde(worktree.path, homeDir);
  const used = [worktree.lastUsedMs, worktree.touchedAt].reduce<number | null>((latest, at) => (at !== null && (latest === null || at > latest) ? at : latest), null);
  const usedAgo = useAgo(used);
  const dirty = (worktree.changed ?? 0) + (worktree.untracked ?? 0);
  const own = ownSizeKb(repo, worktree);
  const removable = worktree.blocker === null;
  return (
    <TableRow className={cn(chosen && 'bg-info/6 dark:bg-info/10')}>
      <TableCell>
        {removable ? (
          <Checkbox checked={chosen} onCheckedChange={(on) => onChoose(on === true)} aria-label={t('setup.projects.worktree.chooseOne', { path: shownPath })} />
        ) : null}
      </TableCell>
      <TableCell className="max-w-80">
        <span className="flex min-w-0 items-center gap-1.5">
          <MiddleTruncate value={shownPath} title={worktree.path} className="font-mono text-foreground/90" />
          {worktree.main ? <Badge variant="outline" size="sm">{t('setup.projects.worktree.main')}</Badge> : null}
          {owner ? <Badge variant="muted" size="sm">{t(OWNER_TEXT[owner])}</Badge> : null}
          {worktree.locked ? <Badge variant="muted" size="sm">{t('setup.projects.worktree.locked')}</Badge> : null}
        </span>
      </TableCell>
      <TableCell className="max-w-56">
        <span className="flex min-w-0 items-center gap-1.5">
          {worktree.branch
            ? <MiddleTruncate value={worktree.branch} title={worktree.upstream ?? worktree.branch} className="font-mono text-foreground/85" />
            : <span className="truncate font-mono text-foreground/85">{t('setup.projects.cell.detached')}</span>}
          <Sync ahead={worktree.ahead} behind={worktree.behind} />
          {worktree.gone ? <span className="shrink-0 text-2xs text-muted-foreground">{t('setup.projects.worktree.gone')}</span> : null}
        </span>
      </TableCell>
      <TableCell>
        {worktree.prunable ? (
          <span className="text-warning-foreground">{t('setup.projects.worktree.folderGone')}</span>
        ) : worktree.changed === null ? (
          <Dash title={t('setup.projects.blocker.unknown')} />
        ) : dirty ? (
          <span className="text-warning-foreground">{t('setup.projects.worktree.dirty', { changed: worktree.changed ?? 0, untracked: worktree.untracked ?? 0 })}</span>
        ) : (
          <span className="text-muted-foreground">{t('setup.projects.worktree.clean')}</span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {worktree.open ? <span className="text-info-foreground">{t('setup.projects.worktree.open')}</span> : used !== null ? usedAgo : <Dash />}
      </TableCell>
      <TableCell className="text-end tabular-nums text-muted-foreground">{size(own) ?? <Dash />}</TableCell>
      <TableCell>
        {removable ? (
          <span className="text-info-foreground">{t(removableWhy(worktree) === 'merged' ? 'setup.projects.worktree.merged' : 'setup.projects.worktree.upstreamGone')}</span>
        ) : worktree.blocker && worktree.blocker !== 'main' ? (
          <span className="text-muted-foreground">{t(BLOCKER_TEXT[worktree.blocker])}</span>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

type RunState = { state: 'confirming' } | { state: 'busy' } | { state: 'done'; results: RemovalResult[] } | { state: 'error'; error: string };
type ChosenEntries = { homeDir: string; entries: ReturnType<typeof chosenWorktrees> };

function RemoveDialog({ open, chosen, byMachine, onClose, onDone }: {
  open: boolean;
  chosen: Chosen;
  byMachine: Map<string, MachineProjects>;
  onClose: () => void;
  onDone: (machine: string) => void;
}) {
  const { t, tRich } = useI18n();
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  // What can go of what was chosen, as it stood when the dialog opened, so the list stays put while machines are
  // worked through and scanned again.
  const [frozen, setFrozen] = useState<[string, ChosenEntries][]>([]);
  useEffect(() => {
    if (!open) return;
    setFrozen(Object.entries(chosen).flatMap(([machine, paths]): [string, ChosenEntries][] => {
      const projects = byMachine.get(machine);
      const entries = projects ? chosenWorktrees(projects, paths) : [];
      return projects && entries.length ? [[machine, { homeDir: projects.homeDir, entries }]] : [];
    }));
    setRuns({});
    // Only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const busy = Object.values(runs).some((run) => run.state === 'busy');

  const remove = async (machine: string, entries: ChosenEntries['entries']) => {
    setRuns((current) => ({ ...current, [machine]: { state: 'busy' } }));
    try {
      const results = await removeWorktrees(machine, removalPlan(entries));
      setRuns((current) => ({ ...current, [machine]: { state: 'done', results } }));
      onDone(machine);
    } catch (error) {
      setRuns((current) => ({ ...current, [machine]: { state: 'error', error: plainError(error, t) } }));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('setup.projects.review.title')}</DialogTitle>
          <DialogDescription>{t('setup.projects.review.description')}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-5">
          {!frozen.length ? <p className="text-xs text-muted-foreground">{t('setup.projects.review.nothing')}</p> : null}
          {frozen.map(([machine, { homeDir, entries }]) => {
            const projects = byMachine.get(machine);
            const run = runs[machine];
            const results = run?.state === 'done' ? run.results : null;
            return (
              <section key={machine} className="flex flex-col gap-2">
                <div className="flex min-h-8 flex-wrap items-center gap-2">
                  <h3 className="me-auto flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                    <MachinePill name={machine} />
                    <span className="font-normal text-muted-foreground">
                      {t(entries.length === 1 ? 'setup.projects.review.count.one' : 'setup.projects.review.count.other', { count: entries.length })}
                    </span>
                  </h3>
                  {run?.state === 'confirming' ? (
                    <>
                      <span className="text-sm text-foreground" role="status">
                        {tRich(entries.length === 1 ? 'setup.projects.review.confirm.one' : 'setup.projects.review.confirm.other', { count: entries.length, machine: <MachinePill name={machine} /> })}
                      </span>
                      <Button variant="outline" size="xs" onClick={() => setRuns((current) => { const next = { ...current }; delete next[machine]; return next; })}>{t('setup.sync.back')}</Button>
                      <Button variant="destructive" size="xs" onClick={() => void remove(machine, entries)}>{t('setup.projects.review.remove')}</Button>
                    </>
                  ) : run?.state === 'busy' ? (
                    <span className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5" />{tRich('setup.projects.review.working', { machine: <MachinePill name={machine} size="sm" /> })}</span>
                  ) : results ? (
                    <span className="text-xs text-muted-foreground">{resultsSummary(results, t)}</span>
                  ) : (
                    <Button
                      size="xs"
                      variant="destructive-outline"
                      disabledReason={
                        busy ? t('setup.projects.review.waitBusy')
                          : !projects || projects.scanning || projects.measuring || projects.removing ? tRich('setup.projects.review.waitScan', { machine: <MachinePill name={machine} size="sm" /> })
                            : undefined
                      }
                      onClick={() => setRuns((current) => ({ ...current, [machine]: { state: 'confirming' } }))}
                    >
                      {tRich('setup.projects.review.removeOn', { machine: <MachinePill name={machine} /> })}
                    </Button>
                  )}
                </div>
                {run?.state === 'error' ? <p className="text-sm text-error-foreground" role="status">{t('setup.projects.review.failed', { error: run.error })}</p> : null}
                <div className="overflow-hidden rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
                  {entries.map(({ repo, worktree }) => (
                    <RemovalLine
                      key={worktree.path}
                      repo={repo}
                      worktree={worktree}
                      homeDir={homeDir}
                      result={results?.find((result) => result.path === worktree.path) ?? null}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </DialogPanel>
        <DialogFooter>
          <p className="me-auto max-w-xl text-xs text-muted-foreground">{t('setup.projects.review.checks')}</p>
          <Button variant="outline" disabledReason={busy ? t('setup.projects.review.waitClose') : undefined} onClick={onClose}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function resultsSummary(results: RemovalResult[], t: Translate): string {
  const counts = removalCounts(results);
  const parts = (Object.keys(counts) as RemovalOutcome[])
    .filter((outcome) => counts[outcome])
    .map((outcome) => `${t(OUTCOME_LOOK[outcome].key)} ${counts[outcome]}`);
  return parts.join(' · ');
}

function RemovalLine({ repo, worktree, homeDir, result }: { repo: ProjectRepo; worktree: ProjectWorktree; homeDir: string; result: RemovalResult | null }) {
  const { t } = useI18n();
  const fate = branchFate(worktree);
  const branchText = fate === 'delete'
    ? t('setup.projects.review.deletesBranch', { branch: worktree.branch ?? '' })
    : fate === 'keep'
      ? t('setup.projects.review.keepsBranch', { branch: worktree.branch ?? '' })
      : t('setup.projects.review.detached');
  const secrets = worktree.ignored.filter(looksSecret);
  const ignoredCount = worktree.ignored.length + worktree.ignoredMore;
  const own = ownSizeKb(repo, worktree);
  return (
    <div className="flex min-w-0 flex-col gap-1 px-3 py-2 text-sm">
      <div className="flex min-w-0 items-center gap-3">
        <MiddleTruncate value={tilde(worktree.path, homeDir)} title={worktree.path} className="flex-1 font-mono text-xs text-foreground" />
        {own !== null ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{size(own)}</span> : null}
      </div>
      <span className="text-xs text-muted-foreground">{branchText}</span>
      {ignoredCount ? (
        <span className="text-xs text-muted-foreground">
          {t(ignoredCount === 1 ? 'setup.projects.review.ignored.one' : 'setup.projects.review.ignored.other', { count: ignoredCount })}{' '}
          <span className="font-mono">{worktree.ignored.slice(0, 6).join(', ')}{ignoredCount > 6 ? ', …' : ''}</span>
        </span>
      ) : null}
      {secrets.length ? (
        <span className="flex items-start gap-1.5 text-xs text-warning-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {t(secrets.length === 1 ? 'setup.projects.review.secret.one' : 'setup.projects.review.secret.other', { names: secrets.join(', ') })}
        </span>
      ) : null}
      {result ? <ResultLine result={result} /> : null}
    </div>
  );
}

function ResultLine({ result }: { result: RemovalResult }) {
  const { t } = useI18n();
  const look = OUTCOME_LOOK[result.outcome];
  const branch = result.branch === 'deleted' ? t('setup.projects.outcome.branchDeleted') : result.branch === 'kept' ? t('setup.projects.outcome.branchKept') : null;
  const detail = [branch, result.message].filter(Boolean).join(' · ');
  return (
    <span className="flex min-w-0 items-start gap-1.5 text-xs">
      <span className="mt-1"><StatusDot tone={look.tone} /></span>
      <span className="shrink-0 font-medium text-foreground/90">{t(look.key)}</span>
      {detail ? <span className="min-w-0 break-words text-muted-foreground">{detail}</span> : null}
    </span>
  );
}

type FileComparison = { project: string; name: string; reference: FileVariant; other: FileVariant };
type LoadedFiles = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ready'; before: SetupText; after: SetupText };

/** One instruction file on two machines, read from each when it opens. */
function FileCompareDialog({ comparison, onClose }: { comparison: FileComparison | null; onClose: () => void }) {
  const { t, tRich } = useI18n();
  const [loaded, setLoaded] = useState<LoadedFiles>({ state: 'loading' });
  useEffect(() => {
    if (!comparison) return;
    let current = true;
    setLoaded({ state: 'loading' });
    const read = (variant: FileVariant) => readProjectFile(variant.place.machine, variant.place.repo.path, comparison.name);
    Promise.all([read(comparison.reference), read(comparison.other)])
      .then(([before, after]) => { if (current) setLoaded({ state: 'ready', before, after }); })
      .catch((error) => { if (current) setLoaded({ state: 'error', error: String(error) }); });
    return () => { current = false; };
  }, [comparison]);
  const unreadable = loaded.state === 'ready' ? [loaded.before, loaded.after].find((side) => side.content === null) : undefined;
  return (
    <Dialog open={comparison !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPopup className="max-w-4xl">
        {comparison ? (
          <>
            <DialogHeader>
              <DialogTitle className="truncate pe-8 font-mono text-base">{comparison.name}</DialogTitle>
              <DialogDescription>
                {tRich('setup.projects.compare.description', {
                  project: comparison.project,
                  reference: <MachinePill name={comparison.reference.place.machine} />,
                  machine: <MachinePill name={comparison.other.place.machine} />,
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-3">
              {loaded.state === 'loading' ? (
                <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Spinner />{t('setup.compare.loading')}</p>
              ) : loaded.state === 'error' ? (
                <p className="py-4 text-sm text-error-foreground">{t('setup.compare.failed', { error: loaded.error })}</p>
              ) : unreadable ? (
                <p className="py-4 text-sm text-muted-foreground">{t('setup.compare.tooLarge', { size: formatBytes(unreadable.size) })}</p>
              ) : (
                <FileCopies
                  name={comparison.name}
                  before={loaded.before.content ?? ''}
                  after={loaded.after.content ?? ''}
                  labels={{ before: <MachinePill name={comparison.reference.place.machine} size="sm" />, after: <MachinePill name={comparison.other.place.machine} size="sm" /> }}
                />
              )}
            </DialogPanel>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

/** Two machines' copies of an instruction file, and the choice of seeing them rendered. */
function FileCopies({ name, before, after, labels }: { name: string; before: string; after: string; labels: CopyLabels }) {
  const [view, setView] = useState<FileView>('source');
  return (
    <>
      <ChangesHeader {...labels} path={name} view={view} onView={setView} />
      <FileChanges path={name} before={before} after={after} labels={labels} view={view} />
    </>
  );
}

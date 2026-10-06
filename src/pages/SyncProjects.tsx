import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ChevronRight, FolderGit2, Search, TriangleAlert } from '../components/ui/icons';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TableCard, TableEmpty } from '../components/ui/data-table';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Input } from '../components/ui/input';
import { MiddleTruncate } from '../components/ui/middle-truncate';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Spinner } from '../components/ui/spinner';
import { StatusDot, type StatusTone } from '../components/ui/status-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Toggle, ToggleGroup } from '../components/ui/toggle-group';
import { toast } from '../components/ui/toast';
import { MachinePill } from '../components/identity/Identity';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatAgo } from '../lib/format';
import { cn } from '../lib/utils';
import { useNow } from '../hooks/useNow';
import type { LayerProblem, PlaceFix, PlaceKind, PlaceState, ProjectCell, ProjectDrift, ProjectFixRequest, ProjectsDrift, SetupMachine } from '../native/types';
import {
  addSetupSchemas,
  applyProjectFixes,
  behindByMachine,
  canMove,
  cellFixes,
  behindOnDefault,
  dirtyCount,
  getProjectDrift,
  isStale,
  machineFixes,
  matchesQuery,
  projectInStep,
  projectName,
  splitProjects,
} from '../services/projectPlaces';
import { scanProjects, SETUP_PROJECTS_UPDATED_EVENT } from '../services/setupProjects';
import { getSetupRepo, storedSetupRepo, undoSetupSync } from '../services/setupSync';

type Filter = 'all' | 'attention';

const STATE_LOOK: Record<PlaceState, { tone: StatusTone; key: MessageKey }> = {
  inPlace: { tone: 'success', key: 'sync.projects.state.inPlace' },
  linked: { tone: 'success', key: 'sync.projects.state.linked' },
  elsewhere: { tone: 'warning', key: 'sync.projects.state.elsewhere' },
  missing: { tone: 'warning', key: 'sync.projects.state.missing' },
  blocked: { tone: 'error', key: 'sync.projects.state.blocked' },
  notScanned: { tone: 'muted', key: 'sync.projects.state.notScanned' },
};

const BLOCKER_TEXT: Record<PlaceKind, MessageKey> = {
  missing: 'sync.projects.blocker.other',
  broken: 'sync.projects.blocker.broken',
  file: 'sync.projects.blocker.file',
  empty: 'sync.projects.blocker.other',
  other: 'sync.projects.blocker.other',
  checkout: 'sync.projects.blocker.checkout',
};

const FIX_TEXT: Record<PlaceFix, MessageKey> = {
  link: 'sync.projects.fix.link',
  clone: 'sync.projects.fix.clone',
  move: 'sync.projects.fix.move',
  fastForward: 'sync.projects.fix.fastForward',
  fetch: 'sync.projects.fix.fetch',
};

/** Runs fixes on one machine, or which machine is busy with them. */
type OnFix = (machine: string, fixes: ProjectFixRequest[]) => void;

/**
 * Sync › Projects: where each project in the setup repo's projects/ folder is on each machine it's on, against where
 * its project.json wants it, with the checkouts no project claims and the archived ones. Changing anything comes from
 * the repo; this only shows how the machines stand.
 */
export function SyncProjects({ machines, onOpenInRepo, onOpenRepo }: {
  machines: SetupMachine[];
  onOpenInRepo: (path: string) => void;
  onOpenRepo: () => void;
}) {
  const { t } = useI18n();
  const now = useNow();
  const repo = storedSetupRepo();
  const [drift, setDrift] = useState<ProjectsDrift | null>(null);
  const [problems, setProblems] = useState<LayerProblem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scanErrors, setScanErrors] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [fixing, setFixing] = useState<ReadonlySet<string>>(new Set());
  const autoScanned = useRef(new Set<string>());

  const reload = useCallback(() => {
    if (!repo) return;
    getProjectDrift(repo)
      .then((next) => { setDrift(next); setLoadError(null); })
      .catch((error) => setLoadError(String(error)));
    getSetupRepo(repo).then((found) => setProblems(found.layers.problems)).catch(() => undefined);
  }, [repo]);
  useEffect(() => {
    reload();
    let unlisten: (() => void) | null = null;
    let live = true;
    void listen(SETUP_PROJECTS_UPDATED_EVENT, reload).then((stop) => { if (live) unlisten = stop; else stop(); });
    return () => { live = false; unlisten?.(); };
  }, [reload]);

  const scan = useCallback((machine: string) => {
    setScanErrors((current) => { const next = { ...current }; delete next[machine]; return next; });
    scanProjects(machine).catch((error) => setScanErrors((current) => ({ ...current, [machine]: String(error) })));
  }, []);

  // A machine whose last scan didn't look at the repo's places is scanned once when the view opens; a scan only reads.
  useEffect(() => {
    if (!drift) return;
    const unscanned = new Set(drift.projects.flatMap((project) => project.cells.filter((cell) => cell.state === 'notScanned').map((cell) => cell.machine)));
    for (const machine of machines) {
      if (!machine.reachable || !unscanned.has(machine.machine) || autoScanned.current.has(machine.machine)) continue;
      if (drift.machines.find((entry) => entry.machine === machine.machine)?.scanning) continue;
      autoScanned.current.add(machine.machine);
      scan(machine.machine);
    }
  }, [drift, machines, scan]);

  const { active, archived } = useMemo(() => (drift ? splitProjects(drift) : { active: [], archived: [] }), [drift]);
  const columns = useMemo(() => {
    const on = new Set(active.flatMap((project) => project.cells.map((cell) => cell.machine)));
    return machines.map((machine) => machine.machine).filter((machine) => on.has(machine));
  }, [active, machines]);
  const attention = active.filter((project) => !projectInStep(project));
  const shown = (filter === 'attention' ? attention : active).filter((project) => matchesQuery(project, query));

  const toggle = (key: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // Every fix is backed up on the machine, so it runs straight away and the toast offers Undo.
  const fix: OnFix = (machine, fixes) => {
    if (!repo || !fixes.length) return;
    setFixing((current) => new Set(current).add(machine));
    applyProjectFixes(repo, machine, fixes)
      .then(({ backup, results }) => {
        const done = results.filter((result) => result.outcome === 'done').length;
        const missed = results.filter((result) => result.outcome !== 'done');
        toast({
          kind: missed.length ? 'warning' : 'success',
          title: missed.length
            ? t('sync.projects.fix.partly', { done, total: results.length, machine })
            : t(done === 1 ? 'sync.projects.fix.done.one' : 'sync.projects.fix.done.other', { count: done, machine }),
          description: missed.length ? missed.map((result) => `${projectName(result.project)}: ${result.detail ?? t('sync.projects.fix.noDetail')}`).join('\n') : undefined,
          action: backup ? {
            label: t('sync.projects.fix.undo'),
            onClick: () => {
              undoSetupSync(machine, backup)
                .then((outcome) => toast(outcome.failed.length
                  ? { kind: 'error', title: t('sync.projects.fix.undoPartly'), description: outcome.failed.map((entry) => `${entry.path}: ${entry.reason}`).join('\n') }
                  : { kind: 'success', title: t('sync.projects.fix.undone') }))
                .catch((error) => toast({ kind: 'error', title: t('sync.projects.fix.undoFailed'), description: String(error) }));
            },
          } : undefined,
        });
      })
      .catch((error) => toast({ kind: 'error', title: t('sync.projects.fix.failed', { machine }), description: String(error) }))
      .finally(() => setFixing((current) => { const next = new Set(current); next.delete(machine); return next; }));
  };

  const addSchemas = () => {
    if (!repo) return;
    setAdding(true);
    addSetupSchemas(repo)
      .then(() => toast({ title: t('sync.projects.schemas.added') }))
      .catch((error) => toast({ kind: 'error', title: t('sync.projects.schemas.failed'), description: String(error) }))
      .finally(() => setAdding(false));
  };

  if (!repo) {
    return (
      <Empty>
        <EmptyMedia><FolderGit2 /></EmptyMedia>
        <EmptyTitle>{t('sync.projects.noRepo.title')}</EmptyTitle>
        <EmptyDescription>{t('sync.projects.noRepo.description')}</EmptyDescription>
        <Button size="sm" onClick={onOpenRepo}>{t('sync.projects.noRepo.action')}</Button>
      </Empty>
    );
  }
  if (drift === null) {
    return loadError ? (
      <Alert variant="error" icon={<TriangleAlert />}>
        <AlertDescription>{t('sync.projects.loadFailed', { error: loadError })}</AlertDescription>
      </Alert>
    ) : (
      <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Spinner />{t('sync.projects.loading')}</p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-3xl text-xs leading-[1.5] text-muted-foreground">{t('sync.projects.intro')}</p>
      {problems.length ? (
        <Alert variant="warning" icon={<TriangleAlert />}>
          <AlertTitle>{t(problems.length === 1 ? 'sync.projects.problems.one' : 'sync.projects.problems.other', { count: problems.length })}</AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-1">
              {problems.map((problem) => (
                <li key={`${problem.file}\u0000${problem.problem}`} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                  <button type="button" className="font-mono text-xs underline-offset-2 hover:underline" onClick={() => onOpenInRepo(problem.file)}>{problem.file}</button>
                  <span>{problem.problem}</span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {!active.length && !archived.length ? (
        <Empty>
          <EmptyMedia><FolderGit2 /></EmptyMedia>
          <EmptyTitle>{t('sync.projects.none.title')}</EmptyTitle>
          <EmptyDescription>{t('sync.projects.none.description')}</EmptyDescription>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" variant="outline" disabled={adding} onClick={addSchemas}>{adding ? <Spinner /> : null}{t('sync.projects.schemas.add')}</Button>
            <Button size="sm" variant="ghost-muted" onClick={onOpenRepo}>{t('sync.projects.openRepo')}</Button>
          </div>
        </Empty>
      ) : (
        <>
          <MachineStrip drift={drift} machines={machines} errors={scanErrors} now={now} fixing={fixing} onScan={scan} onFix={fix} />
          <TableCard
            title={t('sync.projects.table.title')}
            count={t(active.length === 1 ? 'sync.projects.table.count.one' : 'sync.projects.table.count.other', { count: active.length })}
            toolbar={(
              <>
                <ToggleGroup value={[filter]} onValueChange={(value) => { const next = value[0]; if (next === 'all' || next === 'attention') setFilter(next); }} aria-label={t('sync.projects.filter.label')}>
                  <Toggle value="all">{t('sync.projects.filter.all')}<Badge variant="muted" size="sm" className="ms-0.5">{active.length}</Badge></Toggle>
                  <Toggle value="attention">{t('sync.projects.filter.attention')}{attention.length ? <Badge variant="warning" size="sm" className="ms-0.5">{attention.length}</Badge> : null}</Toggle>
                </ToggleGroup>
                <Input
                  type="search"
                  data-page-search
                  size="sm"
                  wrapperClassName="w-56"
                  startAddon={<Search />}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('sync.projects.search')}
                  aria-label={t('sync.projects.search')}
                />
              </>
            )}
          >
            {!shown.length ? (
              <TableEmpty>{query.trim() ? t('sync.projects.noMatches', { query: query.trim() }) : t('sync.projects.allInStep')}</TableEmpty>
            ) : (
              <Table stickyHeader containerClassName="max-h-[calc(100vh-var(--workspace-topbar-height)-19rem)] min-h-48 overflow-auto">
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 z-10 min-w-60 bg-card">{t('sync.projects.column.project')}</TableHead>
                    {columns.map((machine) => <TableHead key={machine} className="min-w-44"><MachinePill name={machine} /></TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((project) => (
                    <Fragment key={project.project}>
                      <ProjectRow project={project} columns={columns} open={expanded.has(project.project)} onToggle={() => toggle(project.project)} />
                      {expanded.has(project.project) ? (
                        <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
                          <TableCell colSpan={columns.length + 1} className="bg-muted/24 p-0 dark:bg-input/8">
                            <ProjectDetail project={project} now={now} fixing={fixing} onFix={fix} onOpenInRepo={onOpenInRepo} />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            )}
          </TableCard>
          {drift.unlisted.length ? (
            <TableCard
              title={t('sync.projects.unlisted.title')}
              count={t(drift.unlisted.length === 1 ? 'sync.projects.unlisted.count.one' : 'sync.projects.unlisted.count.other', { count: drift.unlisted.length })}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('sync.projects.unlisted.machine')}</TableHead>
                    <TableHead>{t('sync.projects.unlisted.path')}</TableHead>
                    <TableHead>{t('sync.projects.unlisted.remote')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {drift.unlisted.map((checkout) => (
                    <TableRow key={`${checkout.machine}\u0000${checkout.path}`}>
                      <TableCell className="w-48"><MachinePill name={checkout.machine} size="sm" /></TableCell>
                      <TableCell className="max-w-96 font-mono text-xs"><MiddleTruncate value={checkout.path} /></TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{checkout.remote ?? t('sync.projects.unlisted.local')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableCard>
          ) : null}
          {archived.length ? (
            <details className="group rounded-xl border border-border/70 bg-card px-4 py-3 text-sm">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-foreground">
                <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
                {t('sync.projects.archived.title')}
                <Badge variant="muted" size="sm">{archived.length}</Badge>
              </summary>
              <ul className="mt-2 flex flex-col gap-1 ps-5.5 text-xs text-muted-foreground">
                {archived.map((project) => (
                  <li key={project.project} className="flex min-w-0 items-center gap-2">
                    <span className="font-mono text-foreground/85">{projectName(project.project)}</span>
                    {project.remote ? <span className="truncate font-mono">{project.remote}</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}

function MachineStrip({ drift, machines, errors, now, fixing, onScan, onFix }: {
  drift: ProjectsDrift;
  machines: SetupMachine[];
  errors: Record<string, string>;
  now: number;
  fixing: ReadonlySet<string>;
  onScan: (machine: string) => void;
  onFix: OnFix;
}) {
  const { t } = useI18n();
  const behind = behindByMachine(drift);
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
      {machines.map((machine) => {
        const scanState = drift.machines.find((entry) => entry.machine === machine.machine);
        const failure = errors[machine.machine] ?? scanState?.error ?? null;
        const count = behind.get(machine.machine) ?? 0;
        const why = scanState?.scanning || fixing.has(machine.machine) ? t('sync.projects.machine.busy') : !machine.reachable ? t('sync.projects.machine.away') : undefined;
        const fixes = machineFixes(drift, machine.machine);
        return (
          <div key={machine.machine} className="flex min-w-0 flex-col gap-1 rounded-xl border border-border/70 bg-card px-3 py-2 shadow-xs/5">
            <div className="flex min-w-0 items-center gap-1.5">
              <MachinePill name={machine.machine} />
              <div className="ms-auto flex shrink-0 items-center gap-1">
                {count && !fixes.length ? <Badge variant="warning" size="sm">{t(count === 1 ? 'sync.projects.machine.behind.one' : 'sync.projects.machine.behind.other', { count })}</Badge> : null}
                {fixes.length ? (
                  <Button variant="outline" size="xs" disabledReason={why} onClick={() => onFix(machine.machine, fixes)} title={t('sync.projects.machine.fixTitle', { machine: machine.machine })}>
                    {fixing.has(machine.machine) ? <Spinner /> : null}
                    {t(fixes.length === 1 ? 'sync.projects.machine.fix.one' : 'sync.projects.machine.fix.other', { count: fixes.length })}
                  </Button>
                ) : null}
                <Button variant="ghost-muted" size="icon-xs" disabledReason={why} onClick={() => onScan(machine.machine)} aria-label={t('sync.projects.machine.scan', { machine: machine.machine })} title={t('sync.projects.machine.scan', { machine: machine.machine })}>
                  <RefreshIcon refreshing={Boolean(scanState?.scanning)} />
                </Button>
              </div>
            </div>
            <p className={cn('truncate text-2xs', failure ? 'text-warning-foreground' : 'text-muted-foreground')} title={failure ?? undefined}>
              {scanState?.scanning
                ? t('sync.projects.machine.scanning')
                : failure
                  ? t('sync.projects.machine.failed')
                  : scanState?.scannedAt != null
                    ? t('sync.projects.machine.scanned', { time: formatAgo(scanState.scannedAt, now) })
                    : t('sync.projects.machine.waiting')}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function ProjectRow({ project, columns, open, onToggle }: { project: ProjectDrift; columns: string[]; open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const name = projectName(project.project);
  return (
    <TableRow className="cursor-pointer" onClick={onToggle}>
      <TableCell className="sticky left-0 z-10 max-w-80 bg-card">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            className="-ms-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-2"
            aria-expanded={open}
            aria-label={t(open ? 'sync.projects.row.collapse' : 'sync.projects.row.expand', { name })}
            onClick={(event) => { event.stopPropagation(); onToggle(); }}
          >
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          </button>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono text-xs text-foreground">{name}</span>
              {project.local ? <Badge variant="muted" size="sm">{t('sync.projects.row.local')}</Badge> : null}
            </span>
            <span className="truncate text-2xs text-muted-foreground" title={project.remote ?? undefined}>
              {project.remote ?? t('sync.projects.row.noRemote')}
            </span>
          </div>
        </div>
      </TableCell>
      {columns.map((machine) => {
        const cell = project.cells.find((candidate) => candidate.machine === machine);
        return (
          <TableCell key={machine} className="max-w-60 text-xs">
            {cell ? <PlaceCell cell={cell} /> : <span className="text-muted-foreground/60" title={t('sync.projects.cell.notHere', { machine })}>—</span>}
          </TableCell>
        );
      })}
    </TableRow>
  );
}

function PlaceCell({ cell }: { cell: ProjectCell }) {
  const { t } = useI18n();
  const look = STATE_LOOK[cell.state];
  const behind = cell.status ? behindOnDefault(cell.status) : 0;
  const dirty = cell.status ? dirtyCount(cell.status) : null;
  const notes = [
    behind ? t('sync.projects.cell.behind', { count: behind }) : null,
    dirty ? t(dirty === 1 ? 'sync.projects.cell.changes.one' : 'sync.projects.cell.changes.other', { count: dirty }) : null,
    cell.status?.fetchFailed ? t('sync.projects.cell.fetchFailed') : null,
  ].filter(Boolean);
  return (
    <div className="flex min-w-0 flex-col gap-0.5" title={cell.path}>
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusDot tone={look.tone} />
        <span className="truncate text-foreground/90">{t(look.key)}</span>
      </span>
      {notes.length ? <span className={cn('truncate text-2xs', behind || cell.status?.fetchFailed ? 'text-warning-foreground' : 'text-muted-foreground')}>{notes.join(' · ')}</span> : null}
    </div>
  );
}

function ProjectDetail({ project, now, fixing, onFix, onOpenInRepo }: {
  project: ProjectDrift;
  now: number;
  fixing: ReadonlySet<string>;
  onFix: OnFix;
  onOpenInRepo: (path: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <ul className="flex flex-col gap-2.5">
        {project.cells.map((cell) => (
          <li key={cell.machine} className="grid grid-cols-[10rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1">
            <span className="flex min-w-0"><MachinePill name={cell.machine} size="sm" /></span>
            <CellDetail
              cell={cell}
              local={project.local}
              now={now}
              busy={fixing.has(cell.machine)}
              onFix={(fix) => onFix(cell.machine, [{ project: project.project, fix }])}
            />
          </li>
        ))}
      </ul>
      {project.unassigned.length ? (
        <p className="text-xs text-muted-foreground">
          {t('sync.projects.detail.unassigned', { places: project.unassigned.map((placed) => `${placed.machine}: ${placed.path}`).join(', ') })}
        </p>
      ) : null}
      {project.unknown.length ? (
        <p className="text-xs text-warning-foreground">{t('sync.projects.detail.unknown', { machines: project.unknown.join(', ') })}</p>
      ) : null}
      <div>
        <Button variant="ghost-muted" size="xs" onClick={() => onOpenInRepo(`projects/${project.project}/project.json`)}>{t('sync.projects.detail.openFile')}</Button>
      </div>
    </div>
  );
}

function CellDetail({ cell, local, now, busy, onFix }: { cell: ProjectCell; local: boolean; now: number; busy: boolean; onFix: (fix: PlaceFix) => void }) {
  const { t } = useI18n();
  const status = cell.status;
  const fixes = cellFixes(cell, local);
  const movable = canMove(cell);
  const busyWhy = busy ? t('sync.projects.machine.busy') : undefined;
  const where = cell.state === 'linked'
    ? t('sync.projects.detail.linked', { link: cell.link ?? '' })
    : cell.state === 'elsewhere'
      ? t('sync.projects.detail.elsewhere', { checkout: cell.checkout ?? '' })
      : cell.state === 'missing'
        ? t('sync.projects.detail.missing')
        : cell.state === 'blocked'
          ? t('sync.projects.detail.blocked', { what: t(BLOCKER_TEXT[cell.blocker ?? 'other'], { remote: cell.blockerRemote ?? '' }) })
          : cell.state === 'notScanned'
            ? t('sync.projects.detail.notScanned')
            : t('sync.projects.detail.inPlace');
  const dirty = status ? dirtyCount(status) : null;
  const facts = status ? [
    status.branch ? t('sync.projects.detail.branch', { branch: status.branch }) : t('sync.projects.detail.detached'),
    dirty === null ? null : dirty ? t(dirty === 1 ? 'sync.projects.cell.changes.one' : 'sync.projects.cell.changes.other', { count: dirty }) : t('sync.projects.detail.clean'),
    status.behind ? t('sync.projects.detail.behind', { count: status.behind, upstream: status.upstream ?? '' }) : null,
    status.ahead ? t('sync.projects.detail.ahead', { count: status.ahead }) : null,
    status.worktrees ? t(status.worktrees === 1 ? 'sync.projects.detail.worktrees.one' : 'sync.projects.detail.worktrees.other', { count: status.worktrees }) : null,
    status.fetchFailed
      ? t('sync.projects.cell.fetchFailed')
      : status.fetchedAt !== null
        ? t(isStale(status, now) ? 'sync.projects.detail.fetchedLong' : 'sync.projects.detail.fetched', { time: formatAgo(status.fetchedAt, now) })
        : status.upstream ? t('sync.projects.detail.neverFetched') : null,
  ].filter(Boolean) : [];
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-xs">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-mono text-foreground/90">{cell.path}</span>
        <span className="text-muted-foreground">{where}</span>
      </span>
      {facts.length ? <span className="text-muted-foreground">{facts.join(' · ')}</span> : null}
      {cell.others.length ? (
        <span className="text-muted-foreground">{t('sync.projects.detail.others', { paths: cell.others.join(', ') })}</span>
      ) : null}
      {fixes.length || movable ? (
        <span className="flex flex-wrap items-center gap-1.5 pt-1">
          {fixes.map((fix) => (
            <Button key={fix} variant="outline" size="xs" disabledReason={busyWhy} onClick={() => onFix(fix)}>{t(FIX_TEXT[fix])}</Button>
          ))}
          {movable ? (
            <Button variant="ghost-muted" size="xs" disabledReason={busyWhy} onClick={() => onFix('move')} title={t('sync.projects.fix.moveTitle', { from: cell.checkout ?? '', to: cell.path })}>
              {t(FIX_TEXT.move)}
            </Button>
          ) : null}
        </span>
      ) : cell.state === 'blocked' ? <span className="text-warning-foreground">{t('sync.projects.detail.clearIt')}</span> : null}
    </div>
  );
}

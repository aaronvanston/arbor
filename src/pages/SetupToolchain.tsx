import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ChevronRight, Hammer, Search, TriangleAlert } from '../components/ui/icons';
import { SectionAbout } from '../components/layout/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TableCard, TableEmpty } from '../components/ui/data-table';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Input } from '../components/ui/input';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Spinner } from '../components/ui/spinner';
import { StatusDot, type StatusTone } from '../components/ui/status-dot';
import { Switch } from '../components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Toggle, ToggleGroup } from '../components/ui/toggle-group';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import { formatAgo } from '../lib/format';
import { tilde } from '../services/setupProjects';
import {
  buildLibraries,
  buildToolchainProjects,
  buildToolRows,
  changeNodeVersions,
  getToolchain,
  installableNode,
  matchesLibrary,
  matchesToolchain,
  needsLook,
  needsScan,
  nodeInstallers,
  nodeVersions,
  notInstalled,
  placeSummary,
  scanToolchain,
  SETUP_TOOLCHAIN_UPDATED_EVENT,
  type LibraryRow,
  type NeedCheck,
  type NeedState,
  type NodeManager,
  type NodeVersion,
  type PlaceCheck,
  type ToolCell,
  type ToolchainRow,
  type ToolRow,
} from '../services/setupToolchain';
import type { MachineToolchain, NodeChange, SetupMachine, ToolNeed } from '../native/types';
import { useConfirmation } from '../components/ConfirmationDialog';
import { Popover, PopoverPopup, PopoverTrigger } from '../components/ui/popover';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { toast } from '../components/ui/toast';
import { MachinePill } from '../components/identity/Identity';
import { useNow } from '../hooks/useNow';

type Translate = ReturnType<typeof useI18n>['t'];
type Filter = 'all' | 'look';

const TOOL_LABEL: Record<string, MessageKey> = {
  node: 'setup.toolchain.tool.node',
  npm: 'setup.toolchain.tool.npm',
  pnpm: 'setup.toolchain.tool.pnpm',
  yarn: 'setup.toolchain.tool.yarn',
  bun: 'setup.toolchain.tool.bun',
  deno: 'setup.toolchain.tool.deno',
  python: 'setup.toolchain.tool.python',
  uv: 'setup.toolchain.tool.uv',
  go: 'setup.toolchain.tool.go',
  rust: 'setup.toolchain.tool.rust',
  cargo: 'setup.toolchain.tool.cargo',
  git: 'setup.toolchain.tool.git',
  gh: 'setup.toolchain.tool.gh',
  jq: 'setup.toolchain.tool.jq',
  rg: 'setup.toolchain.tool.rg',
  docker: 'setup.toolchain.tool.docker',
};

const STATE_TONE: Record<NeedState, StatusTone> = {
  ok: 'success',
  managed: 'success',
  fetch: 'info',
  unknown: 'muted',
  switch: 'warning',
  differs: 'warning',
  mismatch: 'error',
  missing: 'error',
};

const STATE_TEXT: Record<NeedState, MessageKey> = {
  ok: 'setup.toolchain.state.ok',
  managed: 'setup.toolchain.state.managed',
  fetch: 'setup.toolchain.state.fetch',
  unknown: 'setup.toolchain.state.unknown',
  switch: 'setup.toolchain.state.switch',
  differs: 'setup.toolchain.state.differs',
  mismatch: 'setup.toolchain.state.mismatch',
  missing: 'setup.toolchain.state.missing',
};

export const toolLabel = (tool: string, t: Translate) => {
  const key = TOOL_LABEL[tool];
  return key ? t(key) : tool;
};

/** What a project asks for, like `Node >=22`, `Rust 1.85 or later` or `Bun, any version`. */
const needLabel = (need: ToolNeed, t: Translate) => {
  const tool = toolLabel(need.tool, t);
  if (need.wants === '*' || !need.wants) return t('setup.toolchain.need.any', { tool });
  return t(need.kind === 'min' ? 'setup.toolchain.need.min' : 'setup.toolchain.need.version', { tool, wants: need.wants });
};

const needSource = (need: ToolNeed) => (need.field ? `${need.file} · ${need.field}` : need.file);

/** What a check found on one machine, in a few words. */
function checkText(check: NeedCheck, t: Translate): string {
  const values = {
    have: check.have ?? '',
    version: check.using?.version ?? '',
    manager: check.using?.manager ?? '',
    tool: toolLabel(check.need.tool, t),
  };
  return t(STATE_TEXT[check.state], values);
}

/**
 * The tools on each machine and what each project asks of them: one table of tool versions across the fleet, one
 * of projects with whether each machine has what it needs, and the libraries projects share, by release.
 */
export function SetupToolchain({ machines }: { machines: SetupMachine[] }) {
  const { t } = useI18n();
  const now = useNow();
  const [toolchain, setToolchain] = useState<MachineToolchain[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [libraryQuery, setLibraryQuery] = useState('');
  const [splitOnly, setSplitOnly] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const autoScanned = useRef(new Set<string>());

  const reload = useCallback(() => {
    getToolchain()
      .then((next) => { setToolchain(next); setLoadError(null); })
      .catch((error) => setLoadError(String(error)));
  }, []);
  useEffect(() => {
    reload();
    let unlisten: (() => void) | null = null;
    let live = true;
    void listen(SETUP_TOOLCHAIN_UPDATED_EVENT, reload).then((stop) => { if (live) unlisten = stop; else stop(); });
    return () => { live = false; unlisten?.(); };
  }, [reload]);

  const scan = useCallback((machine: string) => {
    setActionErrors((current) => { const next = { ...current }; delete next[machine]; return next; });
    scanToolchain(machine).catch((error) => setActionErrors((current) => ({ ...current, [machine]: String(error) })));
  }, []);

  // Machines never scanned, or not lately, are looked at once each time the tab opens.
  useEffect(() => {
    if (toolchain === null) return;
    for (const machine of machines) {
      if (!machine.reachable || autoScanned.current.has(machine.machine)) continue;
      if (!needsScan(toolchain.find((entry) => entry.machine === machine.machine), Date.now())) continue;
      autoScanned.current.add(machine.machine);
      void scanToolchain(machine.machine).catch(() => undefined);
    }
  }, [toolchain, machines]);

  const byMachine = useMemo(() => new Map((toolchain ?? []).map((entry) => [entry.machine, entry])), [toolchain]);
  const ordered = useMemo(() => machines.flatMap((machine) => byMachine.get(machine.machine) ?? []), [machines, byMachine]);
  const columns = useMemo(() => ordered.filter((entry) => entry.scannedAt !== null).map((entry) => entry.machine), [ordered]);
  const toolRows = useMemo(() => buildToolRows(ordered), [ordered]);
  const rows = useMemo(() => buildToolchainProjects(ordered), [ordered]);
  const libraries = useMemo(() => buildLibraries(rows), [rows]);
  const lookCount = rows.filter(needsLook).length;
  const shown = rows.filter((row) => (filter === 'look' ? needsLook(row) : true) && matchesToolchain(row, query));
  const shownLibraries = libraries.filter((row) => (!splitOnly || row.lines > 1) && matchesLibrary(row, libraryQuery));
  const anyScanned = columns.length > 0;
  const scanning = ordered.some((entry) => entry.scanning);

  const toggle = (key: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  if (toolchain === null) {
    return loadError ? (
      <Alert variant="error" icon={<TriangleAlert />}>
        <AlertDescription>{t('setup.toolchain.loadFailed', { error: loadError })}</AlertDescription>
      </Alert>
    ) : (
      <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Spinner />{t('setup.toolchain.loading')}</p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-3xl text-xs leading-[1.5] text-muted-foreground">{t('setup.toolchain.intro')}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-2">
        {machines.map((machine) => (
          <MachineCard
            key={machine.machine}
            machine={machine}
            toolchain={byMachine.get(machine.machine) ?? null}
            rows={rows}
            error={actionErrors[machine.machine] ?? null}
            now={now}
            onScan={() => scan(machine.machine)}
          />
        ))}
      </div>
      {!anyScanned ? (
        scanning ? (
          <p className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Spinner />{t('setup.toolchain.firstScan')}</p>
        ) : (
          <Empty>
            <EmptyMedia><Hammer /></EmptyMedia>
            <EmptyTitle>{t('setup.toolchain.notScanned.title')}</EmptyTitle>
            <EmptyDescription>{t('setup.toolchain.notScanned.description')}</EmptyDescription>
          </Empty>
        )
      ) : (
        <>
          <TableCard
            title={<CardTitle title={t('setup.toolchain.tools.title')} description={t('setup.toolchain.tools.description')} />}
            count={t(toolRows.length === 1 ? 'setup.toolchain.machine.tools.one' : 'setup.toolchain.machine.tools.other', { count: toolRows.length })}
          >
            {toolRows.length ? (
              <Table containerClassName="overflow-auto">
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-40">{t('setup.toolchain.column.tool')}</TableHead>
                    {columns.map((machine) => <TableHead key={machine} className="min-w-36"><MachinePill name={machine} /></TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {toolRows.map((row) => <ToolRowView key={row.tool} row={row} columns={columns} homes={byMachine} />)}
                </TableBody>
              </Table>
            ) : (
              <TableEmpty>{t('setup.toolchain.tools.none')}</TableEmpty>
            )}
          </TableCard>

          {/* The filter and search only narrow this table, so they sit in its card's head. */}
          <TableCard
            title={<CardTitle title={t('setup.toolchain.projects.title')} description={t('setup.toolchain.projects.description')} />}
            count={shown.length === rows.length
              ? t(rows.length === 1 ? 'setup.toolchain.machine.projects.one' : 'setup.toolchain.machine.projects.other', { count: rows.length })
              : t('setup.toolchain.shown', { shown: shown.length, total: rows.length })}
            toolbar={rows.length ? (
              <>
                <ToggleGroup value={[filter]} onValueChange={(value) => { const next = value[0]; if (next === 'all' || next === 'look') setFilter(next); }} aria-label={t('setup.toolchain.filter.label')}>
                  <Toggle value="all">{t('setup.toolchain.filter.all')}<Badge variant="muted" size="sm" className="ms-0.5">{rows.length}</Badge></Toggle>
                  <Toggle value="look">{t('setup.toolchain.filter.look')}{lookCount ? <Badge variant="warning" size="sm" className="ms-0.5">{lookCount}</Badge> : null}</Toggle>
                </ToggleGroup>
                <Input
                  type="search"
                  data-page-search
                  size="sm"
                  wrapperClassName="w-56"
                  startAddon={<Search />}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('setup.toolchain.search')}
                  aria-label={t('setup.toolchain.search')}
                />
              </>
            ) : null}
          >
            {!rows.length ? (
              <TableEmpty>
                {t('setup.toolchain.projects.none.title')}
                <span className="mt-1 block text-xs">{t('setup.toolchain.projects.none.description')}</span>
              </TableEmpty>
            ) : !shown.length ? (
              <TableEmpty>
                {query.trim() ? t('setup.toolchain.noMatches', { query: query.trim() }) : t('setup.toolchain.nothingToLook')}
              </TableEmpty>
            ) : (
              <Table stickyHeader containerClassName="max-h-[calc(100vh-var(--workspace-topbar-height)-12rem)] min-h-40 overflow-auto">
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 z-10 min-w-60 bg-card">{t('setup.toolchain.column.project')}</TableHead>
                    {columns.map((machine) => <TableHead key={machine} className="min-w-44"><MachinePill name={machine} /></TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((row) => (
                    <Fragment key={row.key}>
                      <ProjectRowView row={row} columns={columns} open={expanded.has(row.key)} onToggle={() => toggle(row.key)} />
                      {expanded.has(row.key) ? (
                        <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
                          <TableCell colSpan={columns.length + 1} className="bg-muted/24 p-0 dark:bg-input/8">
                            <ProjectDetail row={row} columns={columns} />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            )}
          </TableCard>

          {libraries.length ? (
            <TableCard
              title={<CardTitle title={t('setup.toolchain.libraries.title')} description={t('setup.toolchain.libraries.description')} />}
              count={shownLibraries.length === libraries.length
                ? t(libraries.length === 1 ? 'setup.toolchain.libraries.count.one' : 'setup.toolchain.libraries.count.other', { count: libraries.length })
                : t('setup.toolchain.shown', { shown: shownLibraries.length, total: libraries.length })}
              toolbar={(
                <>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch size="sm" checked={splitOnly} onCheckedChange={setSplitOnly} />
                    {t('setup.toolchain.libraries.splitOnly')}
                  </label>
                  <Input
                    type="search"
                    data-page-search
                    size="sm"
                    wrapperClassName="w-56"
                    startAddon={<Search />}
                    value={libraryQuery}
                    onChange={(event) => setLibraryQuery(event.target.value)}
                    placeholder={t('setup.toolchain.libraries.search')}
                    aria-label={t('setup.toolchain.libraries.search')}
                  />
                </>
              )}
            >
              {shownLibraries.length ? (
                <Table stickyHeader containerClassName="max-h-[28rem] overflow-auto">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-48">{t('setup.toolchain.column.library')}</TableHead>
                      <TableHead>{t('setup.toolchain.column.versions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shownLibraries.map((row) => <LibraryRowView key={row.name} row={row} />)}
                  </TableBody>
                </Table>
              ) : (
                <TableEmpty>
                  {libraryQuery.trim() ? t('setup.toolchain.noMatches', { query: libraryQuery.trim() }) : t('setup.toolchain.libraries.allSame')}
                </TableEmpty>
              )}
            </TableCard>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A card's title with what the table is for behind an info mark. */
function CardTitle({ title, description }: { title: string; description: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {title}
      <SectionAbout title={title} description={description} />
    </span>
  );
}

function MachineCard({ machine, toolchain, rows, error, now, onScan }: {
  machine: SetupMachine;
  toolchain: MachineToolchain | null;
  rows: ToolchainRow[];
  error: string | null;
  now: number;
  onScan: () => void;
}) {
  const { t } = useI18n();
  const busy = Boolean(toolchain?.scanning);
  const failure = error ?? toolchain?.error ?? null;
  const scanned = toolchain?.scannedAt != null ? toolchain : null;
  const status = busy
    ? t('setup.toolchain.machine.scanning')
    : failure
      ? t('setup.toolchain.machine.failed')
      : scanned?.scannedAt != null
        ? t('setup.toolchain.machine.scanned', { time: formatAgo(scanned.scannedAt, now) })
        : machine.reachable
          ? t('setup.toolchain.machine.waiting')
          : t('setup.toolchain.machine.away');
  const why = busy ? t('setup.toolchain.machine.busy') : !machine.reachable ? t('setup.toolchain.machine.awayHint') : undefined;
  const trouble = scanned ? rows.filter((row) => (row.places[machine.machine] ?? []).some((place) => place.state === 'mismatch' || place.state === 'missing')).length : 0;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border/70 bg-card px-3 py-2 shadow-xs/5">
      <div className="flex min-w-0 items-center gap-1.5">
        <MachinePill name={machine.machine} />
        {machine.local ? <span className="shrink-0 text-2xs text-muted-foreground">{t('setup.machine.thisMac')}</span> : null}
        <Button variant="ghost-muted" size="icon-xs" className="ms-auto" disabledReason={why} onClick={onScan} aria-label={t('setup.toolchain.machine.scan', { machine: machine.machine })} title={t('setup.toolchain.machine.scan', { machine: machine.machine })}>
          <RefreshIcon refreshing={busy} />
        </Button>
      </div>
      <div className={cn('flex min-w-0 items-center gap-1 text-2xs', failure ? 'text-warning-foreground' : 'text-muted-foreground')} title={failure ?? undefined}>
        {busy ? <Spinner className="size-3" /> : failure ? <TriangleAlert className="size-3 shrink-0" aria-hidden="true" /> : null}
        <span className="truncate">{status}</span>
        {scanned && scanned.os ? <span className="truncate">· {scanned.os} {scanned.arch}</span> : null}
      </div>
      {failure ? <p className="line-clamp-2 text-2xs text-muted-foreground" title={failure}>{failure}</p> : null}
      {scanned ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground/85">
          <span>{t(scanned.tools.length === 1 ? 'setup.toolchain.machine.tools.one' : 'setup.toolchain.machine.tools.other', { count: scanned.tools.length })}</span>
          <span className="text-muted-foreground">·</span>
          <span>{t(scanned.projects.length === 1 ? 'setup.toolchain.machine.projects.one' : 'setup.toolchain.machine.projects.other', { count: scanned.projects.length })}</span>
          {trouble ? <Badge variant="error" size="sm">{t('setup.toolchain.machine.trouble', { count: trouble })}</Badge> : null}
        </div>
      ) : null}
      {toolchain?.partial ? <p className="text-2xs text-warning-foreground">{t('setup.toolchain.machine.partial')}</p> : null}
    </div>
  );
}

const Dash = ({ title }: { title?: string }) => <span className="text-muted-foreground/60" title={title}>—</span>;

function ToolRowView({ row, columns, homes }: { row: ToolRow; columns: string[]; homes: Map<string, MachineToolchain> }) {
  const { t } = useI18n();
  return (
    <TableRow>
      <TableCell className="text-sm">
        <span className="flex flex-col gap-0.5">
          <span className="text-foreground">{toolLabel(row.tool, t)}</span>
          {row.newest && row.anyBehind ? <span className="text-2xs text-muted-foreground">{t('setup.toolchain.tools.newest', { version: row.newest })}</span> : null}
        </span>
      </TableCell>
      {columns.map((machine) => {
        const toolchain = homes.get(machine);
        const cell = <ToolCellView cell={row.cells[machine] ?? null} machine={machine} homeDir={toolchain?.homeDir ?? ''} newest={row.newest} />;
        return (
          <TableCell key={machine} className="text-xs">
            {row.tool === 'node' && toolchain ? <NodeVersionsCell toolchain={toolchain} label={t('setup.toolchain.node.open', { machine })}>{cell}</NodeVersionsCell> : cell}
          </TableCell>
        );
      })}
    </TableRow>
  );
}

/** A machine's Node cell, which opens to the versions its version managers keep: install, remove or make one the default. */
function NodeVersionsCell({ toolchain, label, children }: { toolchain: MachineToolchain; label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        render={<button type="button" className="-mx-2 flex max-w-full cursor-pointer rounded-md px-2 py-1 text-start outline-none ring-ring transition-colors hover:bg-muted focus-visible:ring-2" aria-label={label} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup width="lg" padding="none" align="start" className="text-sm">
        <NodeVersions toolchain={toolchain} />
      </PopoverPopup>
    </Popover>
  );
}

function NodeVersions({ toolchain }: { toolchain: MachineToolchain }) {
  const { t, tRich } = useI18n();
  const { askConfirmation } = useConfirmation();
  const machine = toolchain.machine;
  const versions = useMemo(() => nodeVersions(toolchain), [toolchain]);
  const installers = useMemo(() => nodeInstallers(toolchain), [toolchain]);
  const [manager, setManager] = useState<NodeManager | null>(null);
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const using = manager && installers.includes(manager) ? manager : installers[0] ?? null;

  const run = async (key: string, change: NodeChange) => {
    setBusy(key);
    setError(null);
    try {
      const [result] = await changeNodeVersions(machine, [change]);
      if (result && !result.ok) setError(t('setup.toolchain.node.failed', { error: result.message ?? '' }));
      else {
        toast({ kind: 'success', title: t(NODE_DONE[change.action], { version: change.version, machine }) });
        if (change.action === 'install') setVersion('');
      }
      // What the version manager did is only known once the machine is looked at again.
      await scanToolchain(machine).catch(() => undefined);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (entry: NodeVersion) => {
    const confirmed = await askConfirmation({
      title: t('setup.toolchain.node.removeTitle', { version: entry.kept.version }),
      message: tRich(entry.pinnedBy.length ? 'setup.toolchain.node.removePinned' : 'setup.toolchain.node.removeMessage', {
        version: entry.kept.version,
        manager: entry.kept.manager,
        machine: <MachinePill name={machine} size="sm" />,
        projects: entry.pinnedBy.join(', '),
      }),
      confirmText: t('setup.toolchain.node.remove'),
      variant: 'danger',
    });
    if (confirmed) await run(`${entry.kept.manager}:${entry.kept.version}`, { manager: entry.kept.manager as NodeManager, version: entry.kept.version, action: 'uninstall' });
  };
  const wanted = version.trim();
  const install = () => {
    if (using && installableNode(wanted)) void run('install', { manager: using, version: wanted, action: 'install' });
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-border/50 px-3.5 py-2.5">
        <MachinePill name={machine} size="sm" />
        <span className="text-xs text-muted-foreground">{t('setup.toolchain.node.title')}</span>
      </div>
      {versions.length ? versions.map((entry) => {
        const key = `${entry.kept.manager}:${entry.kept.version}`;
        return (
          <div key={key} className="flex min-w-0 items-center gap-2 border-b border-border/50 px-3.5 py-2">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1.5">
                <span className="font-mono text-sm text-foreground">{entry.kept.version}</span>
                {entry.isDefault ? <Badge variant="primary" size="sm">{t('setup.toolchain.node.default')}</Badge> : null}
              </span>
              <span className="truncate text-2xs text-muted-foreground" title={entry.pinnedBy.join(', ') || undefined}>
                {entry.pinnedBy.length
                  ? t(entry.pinnedBy.length === 1 ? 'setup.toolchain.node.withPinned.one' : 'setup.toolchain.node.withPinned.other', { manager: entry.kept.manager, count: entry.pinnedBy.length })
                  : entry.kept.manager}
              </span>
            </span>
            {busy === key ? <Spinner className="size-3.5" /> : null}
            {entry.canDefault ? (
              <Button variant="ghost" size="xs" disabled={busy !== null} onClick={() => void run(key, { manager: entry.kept.manager as NodeManager, version: entry.kept.version, action: 'setDefault' })}>
                {t('setup.toolchain.node.makeDefault')}
              </Button>
            ) : null}
            {entry.canRemove ? (
              <Button variant="destructive-outline" size="xs" disabled={busy !== null} onClick={() => void remove(entry)}>
                {t('setup.toolchain.node.remove')}
              </Button>
            ) : null}
          </div>
        );
      }) : <p className="border-b border-border/50 px-3.5 py-2.5 text-xs text-muted-foreground">{t('setup.toolchain.node.noneKept')}</p>}
      {using ? (
        <form
          className="flex items-center gap-2 px-3.5 py-2.5"
          onSubmit={(event) => { event.preventDefault(); install(); }}
        >
          <Input
            size="sm"
            font="mono"
            className="w-32"
            value={version}
            placeholder={t('setup.toolchain.node.versionPlaceholder')}
            aria-label={t('setup.toolchain.node.version')}
            onChange={(event) => setVersion(event.target.value)}
          />
          {installers.length > 1 ? (
            <Select value={using} onValueChange={(value) => { if (installers.includes(value as NodeManager)) setManager(value as NodeManager); }}>
              <SelectTrigger size="sm" className="w-auto min-w-20" aria-label={t('setup.toolchain.node.manager')}>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {installers.map((entry) => <SelectItem key={entry} value={entry}>{entry}</SelectItem>)}
              </SelectPopup>
            </Select>
          ) : <span className="whitespace-nowrap text-xs text-muted-foreground">{t('setup.toolchain.node.with', { manager: using })}</span>}
          <Button type="submit" size="xs" className="ms-auto" disabled={busy !== null} disabledReason={installableNode(wanted) ? undefined : t('setup.toolchain.node.versionHint')}>
            {busy === 'install' ? <Spinner /> : null}
            {t('setup.toolchain.node.install')}
          </Button>
        </form>
      ) : <p className="px-3.5 py-2.5 text-xs text-muted-foreground">{t('setup.toolchain.node.noManager')}</p>}
      {error ? <p className="border-t border-border/50 px-3.5 py-2 text-xs text-error-foreground" role="alert">{error}</p> : null}
      <p className="border-t border-border/50 px-3.5 py-2 text-2xs text-muted-foreground">{t('setup.toolchain.node.hint')}</p>
    </div>
  );
}

const NODE_DONE: Record<NodeChange['action'], MessageKey> = {
  install: 'setup.toolchain.node.done.install',
  uninstall: 'setup.toolchain.node.done.uninstall',
  setDefault: 'setup.toolchain.node.done.setDefault',
};

function ToolCellView({ cell, machine, homeDir, newest }: { cell: ToolCell | null; machine: string; homeDir: string; newest: string | null }) {
  const { t } = useI18n();
  if (!cell) return <Dash />;
  const others = cell.kept.filter((entry) => entry.version !== cell.found?.version);
  const keptTitle = cell.kept.map((entry) => t('setup.toolchain.tools.keptEntry', { version: entry.label ? t('setup.toolchain.tools.keptLabel', { version: entry.version, label: entry.label }) : entry.version, manager: entry.manager })).join('\n');
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      {cell.found ? (
        <span
          className={cn('truncate font-mono', cell.behind ? 'text-warning-foreground' : 'text-foreground/85')}
          title={[tilde(cell.found.path, homeDir), cell.behind && newest ? t('setup.toolchain.tools.behind', { newest }) : null].filter(Boolean).join('\n')}
        >
          {cell.found.version ?? t('setup.toolchain.tools.noVersion')}
        </span>
      ) : (
        <Dash title={t('setup.toolchain.tools.notFound', { machine })} />
      )}
      {others.length ? (
        <span className="truncate text-2xs text-muted-foreground" title={keptTitle}>
          {t(others.length === 1 ? 'setup.toolchain.tools.kept.one' : 'setup.toolchain.tools.kept.other', { count: others.length })}
        </span>
      ) : null}
    </span>
  );
}

function ProjectRowView({ row, columns, open, onToggle }: { row: ToolchainRow; columns: string[]; open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <TableRow className="cursor-pointer" onClick={onToggle}>
      <TableCell className="sticky left-0 z-10 max-w-80 bg-card">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            className="-ms-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-2"
            aria-expanded={open}
            aria-label={t(open ? 'setup.toolchain.row.collapse' : 'setup.toolchain.row.expand', { name: row.name })}
            onClick={(event) => { event.stopPropagation(); onToggle(); }}
          >
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          </button>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono text-xs text-foreground" title={row.remote ?? row.name}>{row.name}</span>
              {row.drift.length ? <Badge variant="warning" size="sm">{t('setup.toolchain.row.drift')}</Badge> : null}
            </span>
            <span className="truncate text-2xs text-muted-foreground" title={row.note}>{row.note}</span>
          </div>
        </div>
      </TableCell>
      {columns.map((machine) => {
        const places = row.places[machine] ?? [];
        return (
          <TableCell key={machine} className="max-w-64 text-xs">
            {places.length ? <PlaceCell places={places} /> : <Dash title={t('setup.toolchain.cell.notHere', { machine })} />}
          </TableCell>
        );
      })}
    </TableRow>
  );
}

function PlaceCell({ places }: { places: PlaceCheck[] }) {
  const { t } = useI18n();
  if (places.every((place) => place.project.missing)) return <span className="text-warning-foreground">{t('setup.toolchain.cell.missing')}</span>;
  const summary = placeSummary(places);
  const headline = summary.worst
    ? summary.worst.state === 'managed'
      ? t('setup.toolchain.cell.ready')
      : t('setup.toolchain.cell.check', { need: needLabel(summary.worst.need, t), state: checkText(summary.worst, t) })
    : summary.packages
      ? t(summary.packages === 1 ? 'setup.toolchain.cell.packages.one' : 'setup.toolchain.cell.packages.other', { count: summary.packages })
      : t('setup.toolchain.cell.ready');
  const tone = summary.worst ? STATE_TONE[summary.worst.state] : summary.packages ? 'warning' : 'success';
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusDot tone={tone} />
        <span className="truncate text-foreground/85" title={headline}>{headline}</span>
      </span>
      {summary.more ? <span className="truncate text-2xs text-muted-foreground">{t('setup.toolchain.cell.more', { count: summary.more })}</span> : null}
      {summary.worst && summary.packages ? (
        <span className="truncate text-2xs text-warning-foreground">{t(summary.packages === 1 ? 'setup.toolchain.cell.packages.one' : 'setup.toolchain.cell.packages.other', { count: summary.packages })}</span>
      ) : null}
      {summary.notInstalled ? <span className="truncate text-2xs text-muted-foreground">{t('setup.toolchain.cell.notInstalled')}</span> : null}
    </div>
  );
}

/** A thing a project asks for, the same on every machine that asks it. */
const needId = (need: ToolNeed) => [need.tool, need.wants, need.kind, need.file, need.field ?? ''].join('\u0000');

function ProjectDetail({ row, columns }: { row: ToolchainRow; columns: string[] }) {
  const { t, tRich } = useI18n();
  const holders = columns.filter((machine) => (row.places[machine] ?? []).some((place) => !place.project.missing));
  const needs = new Map<string, ToolNeed>();
  for (const machine of holders) for (const place of row.places[machine] ?? []) for (const need of place.project.needs) needs.set(needId(need), need);
  const checkFor = (machine: string, id: string) => (row.places[machine] ?? []).flatMap((place) => place.checks).find((check) => needId(check.need) === id) ?? null;
  const problems = holders.flatMap((machine) => (row.places[machine] ?? []).map((place) => ({ machine, place })));
  const packageNotes = problems.filter(({ place }) => place.libraries.length || notInstalled(place.project).length || place.project.unread.length);
  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      {needs.size ? (
        <section className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">{t('setup.toolchain.detail.needs')}</h4>
          <div className="overflow-hidden rounded-lg border border-border/60 bg-background/60 dark:bg-card">
            <Table density="compact">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('setup.toolchain.detail.asks')}</TableHead>
                  {holders.map((machine) => <TableHead key={machine}><MachinePill name={machine} size="sm" /></TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...needs.entries()].map(([id, need]) => (
                  <TableRow key={id}>
                    <TableCell className="align-top">
                      <span className="flex flex-col gap-0.5">
                        <span className="font-mono text-foreground/90">{needLabel(need, t)}</span>
                        <span className="text-2xs text-muted-foreground">{needSource(need)}</span>
                      </span>
                    </TableCell>
                    {holders.map((machine) => {
                      const check = checkFor(machine, id);
                      return (
                        <TableCell key={machine} className="align-top">
                          {check ? (
                            <span className="flex min-w-0 items-center gap-1.5">
                              <StatusDot tone={STATE_TONE[check.state]} />
                              <span className="text-foreground/85">{checkText(check, t)}</span>
                            </span>
                          ) : (
                            <Dash title={t('setup.toolchain.detail.notAsked', { machine })} />
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : (
        <p className="text-xs text-muted-foreground">{t('setup.toolchain.detail.noNeeds')}</p>
      )}
      {row.drift.length ? (
        <section className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">{t('setup.toolchain.detail.drift')}</h4>
          <ul className="flex flex-col gap-1 text-xs">
            {row.drift.map((entry) => (
              <li key={`${entry.dir}\u0000${entry.name}`} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-foreground/90">{entry.dir ? `${entry.dir}/${entry.name}` : entry.name}</span>
                <span className="text-muted-foreground">
                  {Object.entries(entry.versions).map(([machine, version], index) => (
                    <Fragment key={machine}>
                      {index ? ' · ' : null}
                      {tRich('setup.toolchain.detail.driftOn', { version, machine: <MachinePill name={machine} size="sm" /> })}
                    </Fragment>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {packageNotes.map(({ machine, place }) => (
        <section key={`${machine}\u0000${place.project.path}`} className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">
            {tRich('setup.toolchain.detail.on', { machine: <MachinePill name={machine} size="sm" /> })}
            <span className="ms-2 font-mono normal-case tracking-normal text-muted-foreground">{tilde(place.project.path, place.homeDir)}</span>
          </h4>
          <ul className="flex flex-col gap-1 text-xs text-foreground/85">
            {notInstalled(place.project).map((entry) => (
              <li key={`none-${entry.dir}`} className="flex items-center gap-1.5">
                <StatusDot tone="muted" />
                {t('setup.toolchain.detail.notInstalled', { dir: entry.dir || '.' })}
              </li>
            ))}
            {place.libraries.map(({ library, problem }) => (
              <li key={`${library.dir}\u0000${library.name}`} className="flex items-center gap-1.5">
                <StatusDot tone="warning" />
                <span className="font-mono">{library.dir ? `${library.dir}/${library.name}` : library.name}</span>
                <span className="text-muted-foreground">
                  {problem === 'absent'
                    ? t('setup.toolchain.detail.absent', { wants: library.wants })
                    : t('setup.toolchain.detail.unmatched', { installed: library.installed ?? '', wants: library.wants })}
                </span>
              </li>
            ))}
            {place.project.unread.map((file) => (
              <li key={`unread-${file}`} className="flex items-center gap-1.5">
                <StatusDot tone="muted" />
                {t('setup.toolchain.detail.unread', { file })}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function LibraryRowView({ row }: { row: LibraryRow }) {
  const { t } = useI18n();
  const [newest] = row.uses;
  return (
    <TableRow>
      <TableCell className="align-top">
        <span className="flex flex-col gap-0.5">
          <span className="font-mono text-xs text-foreground">{row.name}</span>
          {row.lines > 1 ? <span className="text-2xs text-warning-foreground">{t('setup.toolchain.libraries.lines', { count: row.lines })}</span> : null}
        </span>
      </TableCell>
      <TableCell>
        <span className="flex flex-wrap gap-1.5">
          {row.uses.map((use) => (
            <Badge
              key={use.key}
              variant={newest && use.version !== newest.version && row.lines > 1 ? 'warning' : 'secondary'}
              className="gap-1 font-normal"
              title={use.installed ? t('setup.toolchain.libraries.installed') : t('setup.toolchain.libraries.asked')}
            >
              <span>{use.name}</span>
              <span className={cn('font-mono', !use.installed && 'text-muted-foreground')}>{use.version}</span>
              {use.dev ? <span className="text-muted-foreground">{t('setup.toolchain.libraries.dev')}</span> : null}
            </Badge>
          ))}
        </span>
      </TableCell>
    </TableRow>
  );
}

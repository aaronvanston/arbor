import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useLibrary } from '../hooks/useLibrary';
import { ProviderMark } from '../components/identity/Identity';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../components/ui/collapsible';
import { TableCard, TableEmpty } from '../components/ui/data-table';
import { ChevronRight, Search, TriangleAlert } from '../components/ui/icons';
import { Input } from '../components/ui/input';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { toast } from '../components/ui/toast';
import { Toggle, ToggleGroup } from '../components/ui/toggle-group';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import type { LibraryKind, SetupLens } from '../navigation';
import { identityColorCss, identityColors } from '../services/identityColors';
import { LIBRARY_KINDS, libraryCounts, libraryList, libraryScope, type LibraryAgent, type LibraryRow, type LibraryToggle } from '../services/library';
import { removeEverywhere, takeIntoRepo, takeSources, updatePlugin, switchFile, switchHook, switchMachine, switchPlugin, switchServer, switchSkill, type LibrarySwitch, type SwitchFailure, type SwitchSources } from '../services/libraryToggle';
import { skillFolder } from '../services/repoBrowser';
import { LibraryItemPage, type LibraryActions } from './SetupLibraryItem';
import type { SetupMachine, SetupRepo } from '../native/types';
import type { LibrarySources } from '../hooks/useLibrary';
import { extensionsView } from '../services/setupPlugins';
import { withPluginRepo } from '../services/setupPluginRepo';
import { ProjectPluginsCard } from './SetupPluginProjects';
import { ProjectSkillsCard } from './SetupSkillProjects';
import { ProjectMcpCard } from './SetupMcpProjects';

export const KIND_LABEL: Record<LibraryKind, MessageKey> = {
  plugins: 'library.kind.plugins',
  mcps: 'library.kind.mcps',
  skills: 'library.kind.skills',
  hooks: 'library.kind.hooks',
  instructions: 'library.kind.instructions',
};

/** The Library's lenses: the list, each kind's grid by machine, and what it all costs. */
export type LibraryLens = 'list' | Extract<SetupLens, 'machines' | 'cost' | 'directory'>;

/**
 * The bar over every Library lens: which kind (the list and By machine have one; Cost is every kind's) and how it's
 * shown.
 */
export function LibraryBar({ kind, lens, counts, onChange }: {
  kind: LibraryKind;
  lens: LibraryLens;
  /** How many of each kind the list has, once it's read. */
  counts: Record<LibraryKind, number> | null;
  onChange: (kind: LibraryKind, lens: LibraryLens) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {lens === 'cost' || lens === 'directory' ? <span /> : (
        <ToggleGroup value={[kind]} aria-label={t('library.kinds')} onValueChange={(values) => { if (values[0]) onChange(values[0] as LibraryKind, lens); }}>
          {LIBRARY_KINDS.map((entry) => (
            <Toggle key={entry} value={entry}>
              {t(KIND_LABEL[entry])}
              {counts ? <span className="tabular-nums text-muted-foreground">{counts[entry]}</span> : null}
            </Toggle>
          ))}
        </ToggleGroup>
      )}
      <span className="flex items-center gap-2">
        <ToggleGroup value={lens === 'directory' ? [] : [lens]} aria-label={t('library.lens.label')} onValueChange={(values) => { if (values[0]) onChange(kind, values[0] as LibraryLens); }}>
          <Toggle value="list">{t('library.lens.list')}</Toggle>
          <Toggle value="machines">{t('library.lens.machines')}</Toggle>
          <Toggle value="cost">{t('library.lens.cost')}</Toggle>
        </ToggleGroup>
        <Button variant={lens === 'directory' ? 'default' : 'outline'} size="xs" onClick={() => onChange(kind, 'directory')}>{t('library.lens.directory')}</Button>
      </span>
    </div>
  );
}

/** A row's mark: its first letter in a color its name always gets, until things have icons of their own. */
export function LibraryMark({ name, size = 'md' }: { name: string; size?: 'md' | 'lg' }) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const color = identityColors[hash % identityColors.length] ?? 'slate';
  return (
    <span
      className={cn('account-chip account-fill squircle inline-flex shrink-0 items-center justify-center font-semibold', size === 'lg' ? 'size-12 text-xl' : 'size-8 text-sm')}
      style={{ '--account-color': identityColorCss(color) } as CSSProperties}
      data-fill="soft"
      aria-hidden="true"
    >
      {name.replace(/^[^A-Za-z0-9]+/, '').slice(0, 1).toUpperCase() || '·'}
    </span>
  );
}

export function AgentMarks({ agents }: { agents: LibraryAgent[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {agents.map((agent) => <ProviderMark key={agent} provider={agent} className="size-3.5" />)}
    </span>
  );
}

export function ScopeText({ row, className }: { row: LibraryRow; className?: string }) {
  const { t } = useI18n();
  const scope = libraryScope(row);
  const words = scope.kind === 'all' ? t('library.scope.all')
    : scope.kind === 'some' ? t('library.scope.some', { on: scope.on, of: scope.of })
      : scope.kind === 'off' ? t('library.scope.off')
        : scope.on ? t('library.scope.unlisted', { on: scope.on, of: scope.of }) : t('library.scope.unlistedNone');
  return (
    <span className={cn('flex shrink-0 items-center justify-end gap-2 text-xs', className)}>
      {row.behind.length ? (
        <Badge variant="warning" size="sm" title={t('library.behind.title', { machines: row.behind.join(', ') })}>
          {t('library.behind', { count: row.behind.length })}
        </Badge>
      ) : null}
      <span className="text-muted-foreground">{words}</span>
    </span>
  );
}


/** Flips a row's switch with its kind's own switch. */
function switchRow(repo: string, machines: SetupMachine[], toggle: LibraryToggle, on: boolean): Promise<LibrarySwitch> {
  switch (toggle.kind) {
    case 'plugin': return switchPlugin(repo, toggle.row, toggle.codex, on);
    case 'mcp': return switchServer(repo, machines, toggle.name, on);
    case 'hook': return switchHook(repo, machines, toggle.name, on);
    case 'skill': return switchSkill(repo, machines, toggle.name, on);
    case 'file': return switchFile(repo, machines, toggle.path, on);
  }
}

/** What a switch is doing, and what it did, so the row can say so and Undo can take it back. */
type Running = { key: string; on: boolean };
type Problem = { key: string; text: string };

/**
 * Sync › Library as a list: one row for each thing the repo gives the machines' agents, with where it's on and, for
 * what can be switched yet, a switch that changes every machine straight away.
 */
export function SetupLibrary({ machines, kind, item, onOpenItem, onOpenByMachine, onOpenRepo, onOpenInRepo, onCounts }: {
  machines: SetupMachine[];
  kind: LibraryKind;
  /** The row whose own page is open, by its key. */
  item: string | null;
  onOpenItem: (key: string) => void;
  /** Opens a file of the repo's in the Repo. */
  onOpenInRepo: (path: string) => void;
  /** Opens the kind's grid, where a row without a switch is changed. */
  onOpenByMachine: () => void;
  onOpenRepo: () => void;
  onCounts: (counts: Record<LibraryKind, number>) => void;
}) {
  const { t } = useI18n();
  const { repoPath, sources, setSources, loaded, loadError, rows } = useLibrary(machines);
  const [agent, setAgent] = useState<LibraryAgent | null>(null);
  const [query, setQuery] = useState('');
  const [running, setRunning] = useState<Running | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);

  const counts = useMemo(() => libraryCounts(rows), [rows]);
  useEffect(() => { onCounts(counts); }, [counts, onCounts]);
  const shown = useMemo(() => libraryList(rows, { kind, agent, query }), [rows, kind, agent, query]);

  const failedText = (failed: SwitchFailure[], needsYou: string[], name: string) => [
    ...failed.map((entry) => t('library.toggle.machineFailed', { name, machine: entry.machine, message: entry.message })),
    ...(needsYou.length ? [t('library.toggle.needsYou', { name, machines: needsYou.join(', ') })] : []),
  ];
  // What a switch read back replaces what was read, so the row shows its new state straight away.
  const keep = (next: SwitchSources) => setSources((current) => ({
    repo: next.repo ?? current.repo,
    registry: next.registry ?? current.registry,
    hooks: next.hooks ?? current.hooks,
  }));
  const report = (key: string, texts: string[]) =>
    setProblems((current) => [...current.filter((problem) => problem.key !== key), ...texts.map((text) => ({ key, text }))]);

  const undo = async (row: LibraryRow, runKey: string, on: boolean, run: LibrarySwitch) => {
    setRunning({ key: runKey, on: !on });
    try {
      const back = await run.undo();
      keep(back);
      const texts = failedText(back.failed, [], row.name);
      report(row.key, texts);
      if (!texts.length) toast({ kind: 'success', title: t('library.undo.done', { name: row.name }) });
    } catch (error) {
      report(row.key, [t('library.undo.failed', { name: row.name, error: String(error) })]);
    } finally {
      setRunning(null);
    }
  };

  /**
   * Runs one change to a row, one at a time since each walks every machine: what it changed, what it couldn't, and
   * Undo in its toast. `runKey` is what shows the spinner: the row, or one of its machines.
   */
  const perform = async (row: LibraryRow, runKey: string, on: boolean, title: string, start: (repo: string) => Promise<LibrarySwitch>) => {
    if (!repoPath || running) return;
    setRunning({ key: runKey, on });
    report(row.key, []);
    try {
      const run = await start(repoPath);
      keep(run);
      const texts = failedText(run.failed, run.needsYou, row.name);
      report(row.key, texts);
      toast({
        kind: texts.length ? 'warning' : 'success',
        title,
        description: [
          t(run.changed.length === 1 ? 'library.toggle.machines.one' : 'library.toggle.machines.other', { count: run.changed.length }),
          run.skipped.length ? t('library.toggle.skipped', { machines: run.skipped.join(', ') }) : null,
        ].filter(Boolean).join(' '),
        action: { label: t('common.undo'), onClick: () => { void undo(row, runKey, on, run); } },
      });
    } catch (error) {
      report(row.key, [t('library.toggle.failed', { name: row.name, error: String(error) })]);
    } finally {
      setRunning(null);
    }
  };
  /** Takes a row only machines have into the repo; MCP servers and hooks have no Undo, so the item page confirms first. */
  const take = async (row: LibraryRow, from: { machine: string; home: string }) => {
    if (!repoPath || running) return;
    setRunning({ key: row.key, on: true });
    report(row.key, []);
    try {
      const run = await takeIntoRepo(repoPath, machines, row, from);
      keep(run);
      const texts = failedText(run.failed, [], row.name);
      report(row.key, texts);
      const undo = run.undo;
      toast({
        kind: texts.length ? 'warning' : 'success',
        title: t('library.item.take.done', { name: row.name }),
        ...(undo ? { action: { label: t('common.undo'), onClick: () => { void (async () => { try { const back = await undo(); keep(back); report(row.key, failedText(back.failed, [], row.name)); } catch (error) { report(row.key, [t('library.undo.failed', { name: row.name, error: String(error) })]); } })(); } } } : {}),
      });
    } catch (error) {
      report(row.key, [t('library.item.take.failed', { name: row.name, error: String(error) })]);
    } finally {
      setRunning(null);
    }
  };
  /** Updates a Claude Code plugin wherever a home has an older version; an update isn't taken back, so it has no Undo. */
  const update = async (row: LibraryRow) => {
    const target = row.toggle;
    if (target?.kind !== 'plugin' || running) return;
    setRunning({ key: `${row.key}\u0000update`, on: true });
    report(row.key, []);
    try {
      const run = await updatePlugin(target.row);
      const texts = failedText(run.failed, [], row.name);
      report(row.key, texts);
      toast({
        kind: texts.length ? 'warning' : 'success',
        title: t('library.item.update.done', { name: row.name }),
        description: t(run.changed.length === 1 ? 'library.toggle.machines.one' : 'library.toggle.machines.other', { count: run.changed.length }),
      });
    } catch (error) {
      report(row.key, [t('library.toggle.failed', { name: row.name, error: String(error) })]);
    } finally {
      setRunning(null);
    }
  };
  const toggle = (row: LibraryRow, on: boolean) => {
    const target = row.toggle;
    if (target) void perform(row, row.key, on, t(on ? 'library.toggle.on' : 'library.toggle.off', { name: row.name }), (repo) => switchRow(repo, machines, target, on));
  };
  const actionsFor = (row: LibraryRow): LibraryActions => {
    const target = row.toggle;
    const repoFile = row.kind === 'skills' ? `${skillFolder(row.name)}/SKILL.md` : row.kind === 'instructions' && row.detail ? row.detail.replace(/^~\//, '') : null;
    return {
      running: running?.key ?? null,
      problems: problems.filter((problem) => problem.key === row.key).map((problem) => problem.text),
      onToggle: (on) => toggle(row, on),
      onMachine: (machine, on) => {
        if (!target) return;
        const title = t(on ? 'library.item.machineOn' : 'library.item.machineOff', { name: row.name, machine });
        void perform(row, `${row.key}\u0000${machine}`, on, title, (repo) => switchMachine(repo, machines, target, machine, on));
      },
      onRemove: () => {
        if (target) void perform(row, row.key, false, t('library.item.removedToast', { name: row.name }), (repo) => removeEverywhere(repo, machines, target));
      },
      onOpenByMachine,
      onOpenInRepo: repoFile && row.state !== 'unlisted' ? () => onOpenInRepo(repoFile) : null,
      takeFrom: takeSources(row, machines),
      onTake: (from) => void take(row, from),
      onUpdate: () => void update(row),
    };
  };

  if (!repoPath) {
    return (
      <TableCard title={t(KIND_LABEL[kind])}>
        <TableEmpty action={<Button variant="outline" size="sm" onClick={onOpenRepo}>{t('library.noRepo.open')}</Button>}>{t('library.noRepo')}</TableEmpty>
      </TableCard>
    );
  }

  if (item !== null) {
    const row = rows.find((entry) => entry.key === item);
    if (!loaded) return <TableEmpty><span className="inline-flex items-center gap-2"><Spinner />{t('library.loading')}</span></TableEmpty>;
    if (!row) return <TableEmpty>{t('library.item.gone')}</TableEmpty>;
    return (
      <LibraryItemPage row={row} machines={machines} actions={actionsFor(row)}>
        {repoPath && row.state !== 'unlisted' && row.state !== 'removed' ? <ItemProjects row={row} repo={repoPath} machines={machines} sources={sources} onRepo={(repo) => setSources((current) => ({ ...current, repo }))} /> : null}
      </LibraryItemPage>
    );
  }

  const search = t('library.search');
  const agentLabel = (value: LibraryAgent | null) => t(value === 'claude' ? 'library.agent.claude' : value === 'codex' ? 'library.agent.codex' : 'library.agent.all');
  return (
    <div className="flex flex-col gap-3">
      {loadError ? (
        <Alert variant="error" icon={<TriangleAlert />}>
          <AlertDescription>{t('library.loadFailed', { error: loadError })}</AlertDescription>
        </Alert>
      ) : null}
      <TableCard
        title={t(KIND_LABEL[kind])}
        count={loaded ? counts[kind] : null}
        toolbar={(
          <>
            <Select value={agent ?? 'all'} onValueChange={(value) => setAgent(value === 'claude' || value === 'codex' ? value : null)}>
              <SelectTrigger size="sm" className="w-auto min-w-32" aria-label={t('library.agent.label')}>
                <SelectValue>{agentLabel(agent)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                <SelectItem value="all">{t('library.agent.all')}</SelectItem>
                <SelectItem value="claude">{t('library.agent.claude')}</SelectItem>
                <SelectItem value="codex">{t('library.agent.codex')}</SelectItem>
              </SelectPopup>
            </Select>
            <Input size="sm" wrapperClassName="w-56" startAddon={<Search />} value={query} placeholder={search} aria-label={search} onChange={(event) => setQuery(event.target.value)} />
          </>
        )}
      >
        {!loaded ? (
          <TableEmpty><span className="inline-flex items-center gap-2"><Spinner />{t('library.loading')}</span></TableEmpty>
        ) : !shown.rows.length ? (
          <TableEmpty>{query.trim() ? t('library.empty.search', { query: query.trim() }) : t('library.empty')}</TableEmpty>
        ) : (
          <ul className="divide-y divide-border/50">
            {shown.rows.map((row) => (
              <LibraryItem
                key={row.key}
                row={row}
                running={running?.key === row.key ? running : null}
                held={running !== null && running.key !== row.key}
                problems={problems.filter((problem) => problem.key === row.key).map((problem) => problem.text)}
                onToggle={(on) => toggle(row, on)}
                onOpen={() => onOpenItem(row.key)}
              />
            ))}
          </ul>
        )}
      </TableCard>
      {shown.removed.length ? <RemovedRows rows={shown.removed} onOpen={onOpenItem} /> : null}
    </div>
  );
}

/**
 * An item's own values in a project, as Per home's "In a project" cards keep them: a Claude Code plugin's, a skill's or
 * an MCP server's, set per project and machine and brought into each checkout.
 */
function ItemProjects({ row, repo, machines, sources, onRepo }: {
  row: LibraryRow;
  repo: string;
  machines: SetupMachine[];
  sources: LibrarySources;
  onRepo: (repo: SetupRepo) => void;
}) {
  const toggle = row.toggle;
  if (toggle?.kind === 'plugin' && !toggle.codex && sources.repo) {
    const setup = sources.repo;
    const plugins = setup.plugins.filter((plugin) => plugin.id === toggle.row.id);
    if (!plugins.length) return null;
    return (
      <ProjectPluginsCard
        repo={repo}
        plugins={plugins}
        view={withPluginRepo(extensionsView(machines), setup.plugins)}
        onPlugins={(next) => onRepo({ ...setup, plugins: setup.plugins.map((plugin) => next.find((entry) => entry.id === plugin.id) ?? plugin) })}
      />
    );
  }
  if (toggle?.kind === 'skill') return <ProjectSkillsCard machines={machines} only={toggle.name} />;
  if (toggle?.kind === 'mcp' && sources.registry?.found) return <ProjectMcpCard repo={repo} registry={sources.registry} machines={machines} only={toggle.name} />;
  return null;
}

function LibraryItem({ row, running, held, problems, onToggle, onOpen }: {
  row: LibraryRow;
  running: Running | null;
  /** Another switch is running; one at a time, since each walks every machine. */
  held: boolean;
  problems: string[];
  onToggle: (on: boolean) => void;
  /** Opens the row's own page. */
  onOpen: () => void;
}) {
  const { t } = useI18n();
  // A row the repo doesn't list is on while any machine has it, and its switch lists it on or off for them all.
  const on = running ? running.on : row.state === 'unlisted' ? row.on.length > 0 : row.state === 'on';
  return (
    <li className="flex flex-col gap-2 px-4 py-3" data-library-row={row.key}>
      <div className="flex items-center gap-4">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onOpen} aria-label={t('library.item.open', { name: row.name })}>
          <LibraryMark name={row.name} />
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
              <span className="truncate">{row.name}</span>
              <AgentMarks agents={row.agents} />
            </span>
            {row.detail ? <span className="truncate font-mono text-xs text-muted-foreground">{row.detail}</span> : null}
          </span>
        </button>
        <ScopeText row={row} />
        {row.toggle ? (
          <span className="flex w-10 justify-end">
            {running ? <Spinner className="size-4" /> : null}
            <Switch
              className={cn(running && 'hidden')}
              checked={on}
              disabled={held}
              onCheckedChange={onToggle}
              aria-label={t('library.switch.label', { name: row.name })}
            />
          </span>
        ) : (
          <Button variant="ghost-muted" size="xs" onClick={onOpen} aria-label={t('library.byMachine.aria', { name: row.name })}>
            {t('library.details')}
            <ChevronRight />
          </Button>
        )}
      </div>
      {problems.map((text) => <p key={text} className="ps-11 text-xs text-error-foreground">{text}</p>)}
    </li>
  );
}

function RemovedRows({ rows, onOpen }: { rows: LibraryRow[]; onOpen: (key: string) => void }) {
  const { t } = useI18n();
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        {t('library.removed', { count: rows.length })}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {rows.map((row) => (
            <li key={row.key}>
              <Badge variant="muted" render={<button type="button" onClick={() => onOpen(row.key)} aria-label={t('library.item.open', { name: row.name })} />}>{row.name}</Badge>
            </li>
          ))}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  );
}

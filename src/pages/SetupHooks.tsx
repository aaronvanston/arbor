import { useEffect, useMemo, useState } from 'react';
import { useConfirmation } from '../components/ConfirmationDialog';
import { MachinePill } from '../components/identity/Identity';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TableCard, TableEmpty } from '../components/ui/data-table';
import { ChevronDown, TriangleAlert } from '../components/ui/icons';
import { Menu, MenuGroup, MenuGroupLabel, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '../components/ui/menu';
import { StatusDot, type StatusTone } from '../components/ui/status-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { toast } from '../components/ui/toast';
import { applyHookSet } from '../services/applyEngine';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import type { HookCell, HookRegistry, HookView, HookWanted, SetupMachine } from '../native/types';
import {
  getHookRegistry,
  HOOK_AGENT_KINDS,
  hookAgents,
  hookChanges,
  hookGrid,
  hookMachines,
  hookSummary,
  hookValue,
  ownHookCount,
  setHookAgents,
  setHookWanted,
  takeHook,
  type HookAgents,
  type HookMachineState,
  type HookRow,
} from '../services/setupHooks';
import { storedSetupRepo } from '../services/setupSync';
import { repoValueToast } from '../services/switchReport';
import { GridFilters, MachineCell, MachineHead } from './SetupPluginGrid';
import { NameCell } from './SetupNameCell';

type Translate = ReturnType<typeof useI18n>['t'];

const STATE_TEXT: Record<HookMachineState, MessageKey> = {
  same: 'setup.hooks.state.same',
  add: 'setup.hooks.state.add',
  update: 'setup.hooks.state.update',
  extra: 'setup.hooks.state.extra',
  mixed: 'setup.hooks.state.mixed',
  off: 'setup.hooks.state.off',
  removed: 'setup.hooks.state.removed',
  none: 'setup.hooks.state.none',
};

const STATE_TONE: Record<HookMachineState, StatusTone> = {
  same: 'success',
  add: 'warning',
  update: 'warning',
  extra: 'warning',
  mixed: 'warning',
  off: 'muted',
  removed: 'muted',
  none: 'muted',
};

const CELL_TEXT: Record<HookCell['state'], MessageKey> = {
  same: 'setup.hooks.cell.same',
  add: 'setup.hooks.cell.add',
  update: 'setup.hooks.cell.update',
  extra: 'setup.hooks.cell.extra',
};

/** What a change in a machine's review does to one home, in words. */
function changeText(cell: HookCell, t: Translate): string {
  const name = cell.name ?? cell.script;
  return t(CELL_TEXT[cell.state], { name, home: cell.home, event: cell.event });
}

/**
 * Sync › Library › Hooks: the hooks the setup repo keeps, in .agents/hooks.json, and how each machine's Claude Code and Codex
 * homes stand against them. Each repo hook runs a script from ~/.agents/hooks, which syncs with the repo's other files; every other
 * hook is the home's own and is only counted. A machine is brought in step once its changes have been read through.
 */
export function SetupHooks({ machines }: { machines: SetupMachine[] }) {
  const { t, tRich } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [repo] = useState(storedSetupRepo);
  const [registry, setRegistry] = useState<HookRegistry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [applyErrors, setApplyErrors] = useState<Record<string, string>>({});
  const [onlyDifferences, setOnlyDifferences] = useState(true);
  const [query, setQuery] = useState('');

  // Read again whenever a machine has been, since each home is compared with the repo as its last scan found it.
  const scans = machines.map((machine) => `${machine.machine}:${machine.scannedAt ?? ''}`).join('\n');
  useEffect(() => {
    if (!repo) return undefined;
    let current = true;
    getHookRegistry(repo)
      .then((next) => { if (current) { setRegistry(next); setLoadError(null); } })
      .catch((error) => { if (current) { setRegistry(null); setLoadError(String(error)); } });
    return () => { current = false; };
  }, [repo, scans]);

  const fleet = useMemo(() => hookMachines(machines), [machines]);
  const names = useMemo(() => fleet.map((machine) => machine.machine), [fleet]);
  const rows = useMemo(() => (registry ? hookGrid(registry, names, onlyDifferences, query) : []), [registry, names, onlyDifferences, query]);

  if (!repo) {
    return <p className="max-w-3xl text-sm text-muted-foreground">{t('setup.hooks.noRepo')}</p>;
  }

  const save = async (run: () => Promise<HookRegistry>, done?: () => void) => {
    setSaving(true);
    setSaveError(null);
    try {
      setRegistry(await run());
      done?.();
    } catch (error) {
      setSaveError(String(error));
    } finally {
      setSaving(false);
    }
  };
  // A repo value is committed at once, so its toast offers Undo, which commits the value before it again.
  const setWanted = (view: HookView, machine: string | null, wanted: HookWanted, undoing = false) => {
    const before = hookValue(view, machine);
    void save(() => setHookWanted(repo, view.name, machine, wanted), () => toast(repoValueToast(view.name, undoing, () => setWanted(view, machine, before, true), t)));
  };
  const take = (cell: HookCell) => void save(() => takeHook(repo, cell.machine, cell.home, cell.event, cell.script));
  const setAgents = (view: HookView, agents: HookAgents, undoing = false) => {
    const before = hookAgents(view);
    void save(() => setHookAgents(repo, view.name, HOOK_AGENT_KINDS[agents]), () => toast(repoValueToast(view.name, undoing, () => setAgents(view, before, true), t)));
  };

  const bringInStep = async (machine: string) => {
    if (!registry?.commit) return;
    const changes = hookChanges(registry, machine);
    const commands = registry.hooks.filter((hook) => changes.some((cell) => cell.name === hook.name && cell.state !== 'extra'));
    const confirmed = await askConfirmation({
      title: tRich('setup.hooks.apply.title', { machine: <MachinePill name={machine} size="sm" /> }),
      // The message sits in the dialog's description paragraph, so it's made of phrasing elements only.
      message: (
        <span className="flex flex-col gap-3">
          <span className="flex flex-col gap-1 text-sm">
            {changes.map((cell) => <span key={`${cell.home}\u0000${cell.event}\u0000${cell.script}`}>{changeText(cell, t)}</span>)}
          </span>
          {commands.length ? (
            <span className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('setup.hooks.apply.commands')}</span>
              {commands.map((hook) => (
                <code key={hook.name} className="break-all rounded-md bg-muted px-2 py-1 font-mono text-xs">
                  {hook.name}: {hook.command ?? t('setup.hooks.command.hidden')}
                </code>
              ))}
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground">{t('setup.hooks.apply.note')}</span>
          {changes.some((cell) => cell.agent === 'codex' && cell.state !== 'extra') ? (
            <span className="text-xs text-muted-foreground">{t('setup.hooks.apply.codexReview')}</span>
          ) : null}
        </span>
      ),
      confirmText: t('setup.hooks.apply.confirm'),
    });
    if (!confirmed) return;
    setApplying(machine);
    setApplyErrors((current) => ({ ...current, [machine]: '' }));
    try {
      const edits = await applyHookSet(repo, registry.commit, machine);
      const failed = edits.filter((edit) => edit.error);
      if (failed.length) {
        setApplyErrors((current) => ({ ...current, [machine]: failed.map((edit) => `${edit.path}: ${edit.error}`).join('; ') }));
      } else {
        toast({ title: t('setup.hooks.apply.done', { machine }) });
      }
    } catch (error) {
      setApplyErrors((current) => ({ ...current, [machine]: String(error) }));
    } finally {
      setApplying(null);
    }
  };

  const fileProblems = registry?.problems ?? [];
  const broken = registry?.hooks.filter((hook) => hook.problems.length) ?? [];
  const inLine = registry ? registry.hooks.length + new Set(registry.cells.filter((cell) => cell.name === null).map((cell) => `${cell.event}\u0000${cell.script}`)).size - rows.length : 0;
  let empty: string | null = null;
  if (!rows.length) {
    empty = query.trim()
      ? t('setup.hooks.grid.noMatch', { query: query.trim() })
      // A file Arbor can't read compares with nothing, so an empty grid isn't every machine in step.
      : fileProblems.length ? t('setup.hooks.grid.unreadable')
      : registry?.found || registry?.cells.length ? t('setup.hooks.grid.allInLine') : t('setup.hooks.grid.empty');
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-3xl text-xs leading-[1.5] text-muted-foreground">{t('setup.hooks.intro')}</p>
      {loadError ? (
        <Alert variant="error" icon={<TriangleAlert />}>
          <AlertDescription>{t('setup.hooks.loadFailed', { error: loadError })}</AlertDescription>
        </Alert>
      ) : null}
      <TableCard title={t('setup.hooks.machines.title')} count={t(fleet.length === 1 ? 'setup.hooks.machines.count.one' : 'setup.hooks.machines.count.other', { count: fleet.length })}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('setup.hooks.machines.machine')}</TableHead>
              <TableHead>{t('setup.hooks.machines.repo')}</TableHead>
              <TableHead>{t('setup.hooks.machines.own')}</TableHead>
              <TableHead className="text-end">{t('setup.hooks.machines.action')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fleet.map((machine) => {
              const changes = registry ? hookChanges(registry, machine.machine) : [];
              const own = ownHookCount(machine);
              const error = applyErrors[machine.machine];
              let reason: string | undefined;
              if (!registry?.commit) reason = t('setup.hooks.apply.noCommit');
              else if (fileProblems.length || broken.length) reason = t('setup.hooks.apply.broken');
              else if (!machine.reachable) reason = t('setup.hooks.apply.away');
              return (
                <TableRow key={machine.machine}>
                  <TableCell><MachinePill name={machine.machine} size="sm" /></TableCell>
                  <TableCell className="text-xs">
                    <span className="flex flex-col gap-0.5">
                      <span className="flex items-center gap-1.5">
                        <StatusDot tone={changes.length ? 'warning' : 'success'} />
                        {changes.length ? t(changes.length === 1 ? 'setup.hooks.machines.changes.one' : 'setup.hooks.machines.changes.other', { count: changes.length }) : t('setup.hooks.machines.inStep')}
                      </span>
                      {error ? <span className="text-destructive-foreground">{error}</span> : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {own ? t(own === 1 ? 'setup.hooks.machines.ownCount.one' : 'setup.hooks.machines.ownCount.other', { count: own }) : t('setup.hooks.machines.ownNone')}
                  </TableCell>
                  <TableCell className="text-end">
                    {changes.length ? (
                      <Button
                        size="xs"
                        disabled={Boolean(reason) || applying !== null}
                        disabledReason={reason}
                        onClick={() => void bringInStep(machine.machine)}
                      >
                        {applying === machine.machine ? t('setup.hooks.apply.busy') : t('setup.hooks.apply.button')}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableCard>
      <TableCard
        title={t('setup.hooks.grid.title')}
        count={t((registry?.hooks.length ?? 0) === 1 ? 'setup.hooks.grid.count.one' : 'setup.hooks.grid.count.other', { count: registry?.hooks.length ?? 0 })}
        toolbar={(
          <GridFilters
            search={t('setup.hooks.grid.search')}
            show={t('setup.hooks.grid.show')}
            query={query}
            onQuery={setQuery}
            onlyDifferences={onlyDifferences}
            onOnlyDifferences={setOnlyDifferences}
          />
        )}
        footer={inLine > 0 || saveError ? (
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {inLine > 0 && onlyDifferences ? (
              <Button variant="link" size="xs" onClick={() => setOnlyDifferences(false)}>
                {t(inLine === 1 ? 'setup.hooks.grid.inLine.one' : 'setup.hooks.grid.inLine.other', { count: inLine })}
              </Button>
            ) : null}
            {saveError ? <span className="text-destructive-foreground">{saveError}</span> : null}
          </div>
        ) : null}
      >
        <div className="flex flex-col gap-1 border-b border-border/50 px-4 py-2.5 text-xs text-muted-foreground">
          {registry && !registry.found ? <span>{t('setup.hooks.repo.none')}</span> : null}
          {registry?.uncommitted ? <span>{t('setup.hooks.repo.uncommitted')}</span> : null}
          {fileProblems.map((problem) => <span key={problem} className="text-destructive-foreground">{problem}</span>)}
          {broken.map((hook) => (
            <span key={hook.name} className="text-destructive-foreground">{t('setup.hooks.repo.problem', { name: hook.name, problem: hook.problems.join('; ') })}</span>
          ))}
          {registry?.found && !fileProblems.length && !broken.length ? <span>{t('setup.hooks.repo.found')}</span> : null}
        </div>
        {empty ? <TableEmpty>{empty}</TableEmpty> : (
          <Table stickyHeader containerClassName="max-h-[calc(100vh-var(--workspace-topbar-height)-16rem)] overflow-auto">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 min-w-52 bg-card">{t('setup.hooks.column.hook')}</TableHead>
                <TableHead className="min-w-56">{t('setup.hooks.column.runs')}</TableHead>
                <TableHead className="min-w-36">{t('setup.hooks.column.repo')}</TableHead>
                {fleet.map((machine) => (
                  <MachineHead key={machine.machine} column={{ machine: machine.machine, homes: [], reachable: machine.reachable }} pickable={false} />
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => { const view = row.view; return (
                <TableRow key={row.key}>
                  <NameCell
                    name={row.view?.name ?? row.script}
                    note={row.view
                      ? [row.event, row.view.matcher, hookAgents(row.view) === 'claude' ? null : t(`setup.hooks.agents.${hookAgents(row.view)}`)].filter(Boolean).join(' · ')
                      : t('setup.hooks.row.notInRepo', { event: row.event })}
                  />
                  <TableCell className="max-w-72 text-xs"><RunsCell row={row} t={t} /></TableCell>
                  <TableCell className="text-xs">
                    {view ? <RepoMenu hook={view} busy={saving} onWanted={(wanted) => setWanted(view, null, wanted)} onAgents={(agents) => setAgents(view, agents)} /> : (
                      <span className="text-muted-foreground">{t('setup.hooks.repo.notIn')}</span>
                    )}
                  </TableCell>
                  {fleet.map((machine) => {
                    const summary = registry ? hookSummary(registry, row, machine.machine) : { state: 'none' as const, cells: [], differs: false };
                    return (
                      <MachineCell
                        key={machine.machine}
                        label={t('setup.hooks.cell.label', { name: row.view?.name ?? row.script, machine: machine.machine })}
                        outlined={summary.differs}
                        trigger={(
                          <>
                            <StatusDot tone={STATE_TONE[summary.state]} />
                            <span className={cn('truncate', STATE_TONE[summary.state] === 'muted' ? 'text-muted-foreground' : 'text-foreground/85')}>{t(STATE_TEXT[summary.state])}</span>
                          </>
                        )}
                      >
                        <div className="flex items-center gap-2 border-b border-border/50 px-3.5 py-2.5">
                          <MachinePill name={machine.machine} size="sm" />
                          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{row.view?.name ?? row.script}</span>
                        </div>
                        {summary.cells.length ? summary.cells.map((cell) => (
                          <div key={cell.home} className="flex min-w-0 items-center gap-3 border-b border-border/50 px-3.5 py-2 last:border-0">
                            <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground" title={cell.home}>{cell.home}</span>
                            <span className="text-xs">{t(STATE_TEXT[cell.state])}</span>
                            {!row.view && cell.blocked === null ? (
                              <Button size="xs" variant="outline" disabled={saving} onClick={() => take(cell)}>{t('setup.hooks.take')}</Button>
                            ) : null}
                          </div>
                        )) : <p className="px-3.5 py-2.5 text-xs text-muted-foreground">{t('setup.hooks.cell.nothing')}</p>}
                        {view && !view.removed ? (
                          <div className="flex items-center justify-end border-t border-border/50 px-3.5 py-2.5">
                            <MachineMenu hook={view} machine={machine.machine} busy={saving} onWanted={(wanted) => setWanted(view, machine.machine, wanted)} />
                          </div>
                        ) : null}
                      </MachineCell>
                    );
                  })}
                </TableRow>
              ); })}
            </TableBody>
          </Table>
        )}
      </TableCard>
    </div>
  );
}

/** What a hook runs: the repo's command, never one that looks like it holds a secret; a machine's hook only by script. */
function RunsCell({ row, t }: { row: HookRow; t: Translate }) {
  if (!row.view) return <span className="font-mono text-muted-foreground">{t('setup.hooks.scriptPath', { script: row.script })}</span>;
  const { command, timeout } = row.view;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate font-mono" title={command ?? undefined}>{command ?? t('setup.hooks.command.hidden')}</span>
      {timeout ? <span className="text-2xs text-muted-foreground">{t('setup.hooks.timeout', { count: timeout })}</span> : null}
    </span>
  );
}

const AGENT_CHOICES: readonly HookAgents[] = ['claude', 'codex', 'both'];
const isHookAgents = (value: string): value is HookAgents => (AGENT_CHOICES as readonly string[]).includes(value);

/** A repo hook's value for every machine, on every machine or removed from them all, and the agents it goes to. */
function RepoMenu({ hook, busy, onWanted, onAgents }: {
  hook: HookView;
  busy: boolean;
  onWanted: (wanted: HookWanted) => void;
  onAgents: (agents: HookAgents) => void;
}) {
  const { t } = useI18n();
  const value = hook.removed ? 'removed' : 'default';
  const agents = hookAgents(hook);
  return (
    <span className="flex items-center gap-1.5">
      <Menu>
        <MenuTrigger render={<Button variant="ghost-muted" size="xs" disabled={busy} aria-label={t('setup.hooks.repo.aria', { name: hook.name })} />}>
          {t(hook.removed ? 'setup.hooks.repo.removed' : 'setup.hooks.repo.every')}
          <ChevronDown />
        </MenuTrigger>
        <MenuPopup align="start" className="min-w-60">
          <MenuRadioGroup value={value} onValueChange={(next: string) => { if (next !== value && (next === 'default' || next === 'removed')) onWanted(next); }}>
            <MenuRadioItem value="default" closeOnClick>{t('setup.hooks.repo.every')}</MenuRadioItem>
            <MenuRadioItem value="removed" closeOnClick>{t('setup.hooks.repo.removed')}</MenuRadioItem>
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>{t('setup.hooks.repo.agents')}</MenuGroupLabel>
            <MenuRadioGroup value={agents} onValueChange={(next: string) => { if (next !== agents && isHookAgents(next)) onAgents(next); }}>
              {AGENT_CHOICES.map((choice) => (
                <MenuRadioItem key={choice} value={choice} closeOnClick>{t(`setup.hooks.agents.${choice}`)}</MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>
      {hook.off.length ? <Badge variant="outline" size="sm">{t('setup.hooks.repo.offCount', { count: hook.off.length })}</Badge> : null}
    </span>
  );
}

/** A repo hook's value on one machine: as every machine has it, or kept off it. */
function MachineMenu({ hook, machine, busy, onWanted }: { hook: HookView; machine: string; busy: boolean; onWanted: (wanted: HookWanted) => void }) {
  const { t } = useI18n();
  const value = hook.off.includes(machine) ? 'off' : 'default';
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost-muted" size="xs" disabled={busy} />}>
        <span className="text-muted-foreground">{t('setup.plugins.grid.repoHere')}</span>
        {t(value === 'off' ? 'setup.hooks.repo.here.off' : 'setup.hooks.repo.here.default')}
        <ChevronDown />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-60">
        <MenuRadioGroup value={value} onValueChange={(next: string) => { if (next !== value && (next === 'default' || next === 'off')) onWanted(next); }}>
          <MenuRadioItem value="default" closeOnClick>{t('setup.hooks.repo.here.default')}</MenuRadioItem>
          <MenuRadioItem value="off" closeOnClick>{t('setup.hooks.repo.here.off')}</MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

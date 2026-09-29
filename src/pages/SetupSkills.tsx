import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronDown, Search, Sparkles, X } from '../components/ui/icons';
import { useConfirmation } from '../components/ConfirmationDialog';
import { SettingsSection } from '../components/layout/settings';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '../components/ui/menu';
import { Spinner } from '../components/ui/spinner';
import { StatusDot, type StatusTone } from '../components/ui/status-dot';
import { Switch } from '../components/ui/switch';
import { TableCard, TableEmpty, TableHeadLabel } from '../components/ui/data-table';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import { formatAgo } from '../lib/format';
import { homeKey, overrideLabel, overrideWords } from '../services/setupInventory';
import {
  addChanges,
  applySkillChanges,
  cellOptions,
  changeKey,
  choose,
  fleetSkillGrid,
  fleetSkills,
  removeFromMachine,
  repoSkillState,
  getSkillUsage,
  homeCounts,
  isTurnedOff,
  needsLook,
  plannedSkills,
  settleSkills,
  skillChanges,
  skillSuggestions,
  skillsView,
  STORE,
  usageFor,
  type PendingSkills,
  type PlannedSkill,
  type RepoSkillState,
  type SkillCell,
  type SkillHome,
  type SkillPlace,
  type SkillRow,
  type SkillSuggestion,
  type SkillsView,
} from '../services/setupSkills';
import { getSetupRepo, listSetupBackups, scanned, setSetupSkillRemoved, storedSetupRepo, undoSetupSync } from '../services/setupSync';
import { toast } from '../components/ui/toast';
import { setSyncMachine, useSyncScope } from '../services/syncScope';
import { setSyncSkills, takeSyncReview, useSyncChanges } from '../services/syncChanges';
import type { Comparison } from './SetupCompare';
import { BackupList, undoMessage } from './SetupSync';
import type {
  SetupBackup,
  SetupMachine,
  SetupRepo,
  SkillAction,
  SkillUsage,
  SkillUsageReport,
  SyncOutcome,
} from '../native/types';
import { MachinePill } from '../components/identity/Identity';
import { ProjectSkillsCard } from './SetupSkillProjects';
import { ChosenBadge, GridFilters, MachineCell } from './SetupPluginGrid';

/** How far back skill use is counted. */
const USAGE_DAYS = 30;

type Translate = ReturnType<typeof useI18n>['t'];
type TranslateRich = ReturnType<typeof useI18n>['tRich'];
/** What a change did, with the machine's pill in the sentence. */
type Notice = { ok: boolean; text: ReactNode };

/** How a place reads, and the color of its dot. Codex loads the store itself, so a second copy there is a warning. */
function placeLook(place: SkillPlace, agent: SkillHome['agent'] | 'store'): { tone: StatusTone | null; key: MessageKey } {
  const codex = agent === 'codex';
  switch (place) {
    case 'store': return { tone: 'success', key: 'setup.skills.place.store' };
    case 'linked': return codex ? { tone: 'warning', key: 'setup.skills.place.linkedCodex' } : { tone: 'success', key: 'setup.skills.place.linked' };
    case 'off': return { tone: 'muted', key: 'setup.skills.place.off' };
    case 'loads': return { tone: 'success', key: 'setup.skills.place.loads' };
    case 'copy': return { tone: 'warning', key: codex ? 'setup.skills.place.copyCodex' : 'setup.skills.place.copy' };
    case 'drifted': return { tone: 'warning', key: codex ? 'setup.skills.place.driftedCodex' : 'setup.skills.place.drifted' };
    case 'own': return { tone: 'info', key: 'setup.skills.place.own' };
    case 'elsewhere': return { tone: 'info', key: 'setup.skills.place.elsewhere' };
    case 'broken': return { tone: 'error', key: 'setup.skills.place.broken' };
    case 'notSkill': return { tone: 'muted', key: 'setup.skills.place.notSkill' };
    case 'viaFolder': return { tone: 'muted', key: 'setup.skills.place.viaFolder' };
    default: return { tone: null, key: 'setup.skills.place.none' };
  }
}

/** What choosing an action does, in the words the cell's menu uses. */
function actionLabel(action: SkillAction, row: SkillRow, cell: SkillCell): MessageKey {
  switch (action) {
    case 'link': return 'setup.skills.action.link';
    case 'useStore': return 'setup.skills.action.useStore';
    case 'adopt': return row.store ? 'setup.skills.action.adopt' : 'setup.skills.action.moveIn';
    default:
      if (cell.home.agent === 'claude' && cell.place === 'linked') return 'setup.skills.action.turnOff';
      return cell.item?.link ? 'setup.skills.action.removeLink' : 'setup.skills.action.removeCopy';
  }
}

/** A chosen change, in a sentence, for the review. */
function changeText({ row, cell, action }: PlannedSkill, t: Translate): string {
  const name = row.name;
  switch (action) {
    case 'link': return t('setup.skills.change.link', { name });
    case 'useStore': return t('setup.skills.change.useStore', { name });
    case 'adopt':
      if (row.store) return t('setup.skills.change.adopt', { name });
      return t(cell.home.agent === 'claude' ? 'setup.skills.change.moveIn' : 'setup.skills.change.moveInCodex', { name });
    default:
      if (cell.home.agent === 'claude' && cell.place === 'linked') return t('setup.skills.change.turnOff', { name });
      if (cell.home.agent === 'codex' && row.store?.sum && ['copy', 'linked', 'drifted'].includes(cell.place)) return t('setup.skills.change.removeTwice', { name });
      if (cell.item?.link) return t('setup.skills.change.removeLink', { name, target: cell.item.link });
      return t('setup.skills.change.removeCopy', { name });
  }
}

function suggestionText(suggestion: SkillSuggestion, t: Translate, homeLabel: (key: string) => string): string {
  const count = suggestion.kind === 'intoStore' ? new Set(suggestion.changes.map((change) => change.row.name)).size : suggestion.changes.length;
  const one = count === 1;
  switch (suggestion.kind) {
    case 'linkCopies': return t(one ? 'setup.skills.suggest.linkCopies.one' : 'setup.skills.suggest.linkCopies.other', { count });
    case 'codexTwice': return t(one ? 'setup.skills.suggest.codexTwice.one' : 'setup.skills.suggest.codexTwice.other', { count });
    case 'intoStore': return t(one ? 'setup.skills.suggest.intoStore.one' : 'setup.skills.suggest.intoStore.other', { count });
    default:
      return t(one ? 'setup.skills.suggest.match.one' : 'setup.skills.suggest.match.other', {
        count,
        home: homeLabel(homeKey({ agent: 'claude', path: suggestion.home ?? '' })),
      });
  }
}

/** What a change to skills did, in a sentence: done, refused because something changed, or partly done. */
function skillOutcome(outcome: SyncOutcome, machine: string, t: Translate, tRich: TranslateRich): Notice {
  const changed = outcome.failed.filter((failure) => failure.reason === 'changed').map((failure) => failure.path);
  const failed = outcome.failed.filter((failure) => failure.reason === 'failed').map((failure) => failure.path);
  const pill = <MachinePill name={machine} />;
  if (changed.length) return { ok: false, text: tRich('setup.skills.outcome.changed', { machine: pill, skills: changed.join(', ') }) };
  if (failed.length) return { ok: false, text: t('setup.skills.outcome.failed', { done: outcome.done.length, skills: failed.join(', ') }) };
  return { ok: true, text: tRich(outcome.done.length === 1 ? 'setup.skills.outcome.done.one' : 'setup.skills.outcome.done.other', { count: outcome.done.length, machine: pill }) };
}

/**
 * The Skills tab: one machine's store of skills against each of its Claude Code and Codex homes, what each home
 * loads, how much each skill was used lately, and changes to bring them in step, reviewed before they're made.
 */
export function SetupSkills({ machines, homeLabel, onCompare }: {
  machines: SetupMachine[];
  homeLabel: (key: string) => string;
  onCompare: (comparison: Comparison) => void;
}) {
  const { t, tRich } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [query, setQuery] = useState('');
  const [onlyLook, setOnlyLook] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [usage, setUsage] = useState<SkillUsageReport | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [backups, setBackups] = useState<SetupBackup[] | null>(null);
  const [backupsError, setBackupsError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);

  // Sync's scope picks the machine; at All machines the page sums up every machine instead.
  const { machine: scoped } = useSyncScope();
  const machine = machines.find((entry) => entry.machine === scoped) ?? null;
  const name = machine?.machine ?? null;
  // Chosen changes live with Sync's other pages', by machine, so they last when the page or the machine changes.
  const { skills: chosen, review } = useSyncChanges();
  const pending = useMemo(() => (name ? chosen[name] ?? {} : {}), [chosen, name]);
  const setPending = useCallback((updater: PendingSkills | ((current: PendingSkills) => PendingSkills)) => {
    if (name) setSyncSkills(name, updater);
  }, [name]);
  const view = useMemo(() => (machine ? skillsView(machine) : null), [machine]);
  // What was chosen, less anything the machine's last scan no longer allows.
  const settled = useMemo(() => (view ? settleSkills(view, pending) : {}), [view, pending]);
  const suggestions = useMemo(() => (view ? skillSuggestions(view, settled) : []), [view, settled]);
  const planned = useMemo(() => (view ? plannedSkills(view, settled) : []), [view, settled]);
  const used = useMemo(() => new Map((usage?.skills ?? []).map((entry) => [entry.name, entry])), [usage]);
  // What the machine's last scan no longer allows is dropped.
  useEffect(() => {
    if (view && machine && scanned(machine)) setPending((current) => settleSkills(view, current));
  }, [view, machine, setPending]);
  // The tray's Review for this machine, asked for from another page.
  useEffect(() => {
    if (review?.kind === 'skills' && review.machine === name && takeSyncReview('skills')) setReviewing(true);
  }, [review, name]);

  const loadBackups = useCallback(async (target: string) => {
    try {
      setBackups(await listSetupBackups(target));
      setBackupsError(null);
    } catch (error) {
      setBackupsError(String(error));
    }
  }, []);

  useEffect(() => {
    let current = true;
    getSkillUsage(USAGE_DAYS)
      .then((report) => { if (current) setUsage(report); })
      .catch((error) => { if (current) setUsageError(String(error)); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    setNotice(null);
    setBackups(null);
    setBackupsError(null);
    if (name) void loadBackups(name);
  }, [name, loadBackups]);

  const undo = async (backup: SetupBackup) => {
    if (!machine) return;
    const confirmed = await askConfirmation({
      title: t('setup.skills.undo.title'),
      message: undoMessage(backup, t),
      confirmText: t('setup.sync.history.undo'),
      variant: 'danger',
    });
    if (!confirmed) return;
    setUndoing(backup.id);
    setNotice(null);
    try {
      const outcome = await undoSetupSync(machine.machine, backup.id);
      const result = skillOutcome(outcome, machine.machine, t, tRich);
      setNotice(result.ok ? { ok: true, text: tRich('setup.skills.undone', { machine: <MachinePill name={machine.machine} /> }) } : result);
      void loadBackups(machine.machine);
    } catch (error) {
      setNotice({ ok: false, text: t('setup.skills.undoFailed', { error: String(error) }) });
    } finally {
      setUndoing(null);
    }
  };

  const applied = (outcome: SyncOutcome) => {
    if (!machine) return;
    setNotice(skillOutcome(outcome, machine.machine, t, tRich));
    // Nothing was made when the machine had changed: the choices stay, to review again once it's read.
    if (outcome.backup !== null) {
      setPending({});
      setReviewing(false);
    }
    void loadBackups(machine.machine);
  };

  const needle = query.trim().toLowerCase();
  const rows = (view?.rows ?? []).filter((row) =>
    (!needle || row.name.toLowerCase().includes(needle) || Boolean(row.declaredName?.toLowerCase().includes(needle)))
    && (!onlyLook || needsLook(row) || row.cells.some((cell) => settled[changeKey(cell.home.path, row.name)])));
  const skillBackups = backups?.filter((backup) => backup.skills.length) ?? null;

  // The table's own controls, in its card's head.
  const skillControls = (
    <>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch size="sm" checked={onlyLook} onCheckedChange={setOnlyLook} />
        {t('setup.skills.onlyLook')}
      </label>
      <Input
        type="search"
        data-page-search
        size="sm"
        wrapperClassName="w-48"
        startAddon={<Search />}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('setup.skills.search')}
        aria-label={t('setup.skills.search')}
      />
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-3xl text-xs leading-[1.5] text-muted-foreground">{t('setup.skills.intro')}</p>
      {notice ? (
        <p className={cn('text-sm', notice.ok ? 'text-muted-foreground' : 'text-error-foreground')} role="status">{notice.text}</p>
      ) : null}
      {!machine || !view ? (
        <>
          <FleetSkillsCard
            machines={machines}
            chosen={chosen}
            used={used}
            usage={usage}
            usageError={usageError}
            homeLabel={homeLabel}
            onCompare={onCompare}
          />
          <ProjectSkillsCard machines={machines} />
        </>
      ) : !scanned(machine) ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{tRich('setup.skills.notRead', { machine: <MachinePill name={machine.machine} /> })}</p>
      ) : (
        <>
          {!view.store ? (
            <p className="text-xs text-muted-foreground">{tRich('setup.skills.noStore', { machine: <MachinePill name={machine.machine} size="sm" /> })}</p>
          ) : view.store.skillsLink ? (
            <p className="text-xs text-muted-foreground">{t('setup.skills.storeLink', { target: view.store.skillsLink })}</p>
          ) : null}
          {view.sharing.map((entry) => (
            <p key={entry.path} className="text-xs text-muted-foreground">
              {t('setup.skills.sharedHome', { home: homeLabel(`codex:${entry.path}`), target: entry.home })}
            </p>
          ))}
          {suggestions.length ? (
            <Suggestions
              suggestions={suggestions}
              homeLabel={homeLabel}
              onAdd={(suggestion) => setPending((current) => addChanges(view, settleSkills(view, current), suggestion.changes))}
            />
          ) : null}
          <TableCard
            title={t('setup.skills.table.title')}
            count={rows.length === view.rows.length
              ? t(view.rows.length === 1 ? 'setup.sync.count.skills.one' : 'setup.sync.count.skills.other', { count: view.rows.length })
              : t('setup.skills.table.shown', { shown: rows.length, total: view.rows.length })}
            toolbar={view.rows.length ? skillControls : null}
          >
            {!view.rows.length ? (
              <TableEmpty>{tRich('setup.skills.empty', { machine: <MachinePill name={machine.machine} /> })}</TableEmpty>
            ) : !rows.length ? (
              <TableEmpty action={onlyLook && !needle ? <Button variant="outline" size="sm" onClick={() => setOnlyLook(false)}>{t('setup.skills.showEverything')}</Button> : null}>
                {needle ? t('setup.skills.noMatches', { query: query.trim() }) : tRich('setup.skills.allFine', { machine: <MachinePill name={machine.machine} /> })}
              </TableEmpty>
            ) : (
          <SkillsTable
            view={view}
            rows={rows}
            pending={settled}
            used={used}
            usage={usage}
            usageError={usageError}
            homeLabel={homeLabel}
            onChoose={(row, cell, action) => setPending((current) => choose(view, settleSkills(view, current), row, cell, action))}
            onCompare={(row, cell) => {
              if (!row.store || !cell.item) return;
              onCompare({
                kind: 'skill',
                name: row.name,
                reference: { machine: machine.machine, item: row.store, label: row.store.path ?? `${STORE}/${row.name}` },
                other: { machine: machine.machine, item: cell.item, label: cell.item.path ?? row.name },
              });
            }}
          />
            )}
          </TableCard>
          <ProjectSkillsCard machines={machines} />
          <BackupList
            machine={machine.machine}
            backups={skillBackups}
            error={backupsError}
            busy={undoing !== null}
            undoing={undoing}
            onUndo={(backup) => void undo(backup)}
          />
        </>
      )}
      <SkillReviewDialog
        open={reviewing && planned.length > 0}
        machine={machine}
        view={view}
        pending={settled}
        planned={planned}
        homeLabel={homeLabel}
        onClose={() => setReviewing(false)}
        onApplied={applied}
      />
    </div>
  );
}

function Suggestions({ suggestions, homeLabel, onAdd }: {
  suggestions: SkillSuggestion[];
  homeLabel: (key: string) => string;
  onAdd: (suggestion: SkillSuggestion) => void;
}) {
  const { t } = useI18n();
  return (
    <SettingsSection title={t('setup.skills.suggest.title')}>
      {suggestions.map((suggestion) => (
        <div key={`${suggestion.kind}:${suggestion.home ?? ''}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <Sparkles aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
          <p className="min-w-0 flex-1 text-sm leading-[1.45] text-foreground/90">{suggestionText(suggestion, t, homeLabel)}</p>
          <Button variant="outline" size="xs" onClick={() => onAdd(suggestion)}>
            {t(suggestion.changes.length === 1 ? 'setup.skills.suggest.add.one' : 'setup.skills.suggest.add.other', { count: suggestion.changes.length })}
          </Button>
        </div>
      ))}
    </SettingsSection>
  );
}

/**
 * Sync › Skills at All machines: every skill any machine has, and in how many of each machine's homes it loads. A
 * machine's column head opens that machine, where its skills can be changed.
 */
function FleetSkillsCard({ machines, chosen, used, usage, usageError, homeLabel, onCompare }: {
  machines: SetupMachine[];
  chosen: Record<string, PendingSkills>;
  used: ReadonlyMap<string, SkillUsage>;
  usage: SkillUsageReport | null;
  usageError: string | null;
  homeLabel: (key: string) => string;
  onCompare: (comparison: Comparison) => void;
}) {
  const { t, tRich } = useI18n();
  // What's out of line comes first, as on the plugins' grid.
  const [onlyLook, setOnlyLook] = useState(true);
  const [query, setQuery] = useState('');
  // The setup repo says which skills every machine gets and which it took off them all.
  const [repoPath] = useState(storedSetupRepo);
  const [repo, setRepo] = useState<SetupRepo | null>(null);
  const [repoBusy, setRepoBusy] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const scans = machines.map((machine) => `${machine.machine}:${machine.scannedAt ?? ''}`).join('\n');
  useEffect(() => {
    if (!repoPath) return undefined;
    let current = true;
    getSetupRepo(repoPath)
      .then((next) => { if (current) setRepo(next.head ? next : null); })
      .catch(() => { if (current) setRepo(null); });
    return () => { current = false; };
  }, [repoPath, scans]);
  const removed = useMemo(() => new Set(repo?.removedSkills ?? []), [repo]);
  const fleet = useMemo(() => fleetSkills(machines), [machines]);
  const grid = useMemo(() => fleetSkillGrid(fleet, onlyLook, query, chosen, removed), [fleet, onlyLook, query, chosen, removed]);
  const setRemoved = async (name: string, gone: boolean, undo = false) => {
    if (!repoPath) return;
    setRepoBusy(true);
    setRepoError(null);
    try {
      setRepo(await setSetupSkillRemoved(repoPath, name, gone));
      if (!undo) {
        toast({
          kind: 'success',
          title: t(gone ? 'setup.skills.repo.removedDone' : 'setup.skills.repo.backDone', { name }),
          description: gone ? t('setup.skills.repo.removedNext') : undefined,
          action: { label: t('common.undo'), onClick: () => void setRemoved(name, !gone, true) },
        });
      }
    } catch (error) {
      setRepoError(String(error));
    } finally {
      setRepoBusy(false);
    }
  };
  const now = Date.now();
  let empty: ReactNode = null;
  if (!fleet.rows.length) empty = t('setup.skills.fleet.empty');
  else if (!grid.rows.length) empty = query.trim() ? t('setup.skills.noMatches', { query: query.trim() }) : t('setup.skills.fleet.allInLine');
  return (
    <TableCard
      title={t('setup.skills.table.title')}
      count={t(grid.rows.length === 1 ? 'setup.sync.count.skills.one' : 'setup.sync.count.skills.other', { count: grid.rows.length })}
      toolbar={fleet.rows.length ? (
        <GridFilters search={t('setup.skills.search')} show={t('setup.skills.fleet.show')} query={query} onQuery={setQuery} onlyDifferences={onlyLook} onOnlyDifferences={setOnlyLook} />
      ) : null}
      footer={grid.inLine || repoError ? (
        <div className="flex flex-col gap-1 py-0.5 text-xs text-muted-foreground">
          {grid.inLine ? (
            <span className="flex flex-wrap items-center gap-2">
              {t(grid.inLine === 1 ? 'setup.skills.fleet.inLine.one' : 'setup.skills.fleet.inLine.other', { count: grid.inLine })}
              <Button variant="link" size="xs" onClick={() => setOnlyLook(false)}>{t('setup.plugins.grid.showAll')}</Button>
            </span>
          ) : null}
          {repoError ? <span className="text-error-foreground" role="alert">{repoError}</span> : null}
        </div>
      ) : null}
    >
      {empty ? (
        <TableEmpty>{empty}</TableEmpty>
      ) : (
        <Table stickyHeader containerClassName="max-h-[calc(100vh-var(--workspace-topbar-height)-16rem)] overflow-auto">
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 min-w-52 bg-card">{t('setup.skills.column.skill')}</TableHead>
              {repo ? <TableHead className="min-w-40">{t('setup.plugins.column.repo')}</TableHead> : null}
              <TableHead className="min-w-28">{t('setup.skills.column.used')}</TableHead>
              {fleet.machines.map((machine) => (
                <TableHead key={machine} className="min-w-40">
                  <button
                    type="button"
                    className="cursor-pointer rounded-sm outline-none ring-ring focus-visible:ring-2"
                    aria-label={t('setup.skills.fleet.open', { machine })}
                    onClick={() => setSyncMachine(machine)}
                  >
                    <MachinePill name={machine} size="sm" />
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {grid.rows.map((row) => (
              <TableRow key={row.name}>
                <TableCell className="sticky left-0 z-10 max-w-72 bg-card">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-mono text-xs text-foreground" title={row.name}>{row.name}</span>
                    {row.source ? <span className="truncate text-2xs text-muted-foreground">{row.source}</span> : null}
                  </div>
                </TableCell>
                {repo ? (
                  <TableCell className="text-xs">
                    <SkillRepoMenu name={row.name} state={repoSkillState(repo, row.name)} busy={repoBusy} onRemoved={(gone) => void setRemoved(row.name, gone)} />
                  </TableCell>
                ) : null}
                <TableCell className="text-xs">
                  <UsageView usage={used.get(row.name) ?? null} loading={usage === null && usageError === null} error={usageError} now={now} />
                </TableCell>
                {fleet.machines.map((machine) => {
                  const cell = row.cells[machine];
                  const view = fleet.views[machine];
                  if (!cell || !view) return <TableCell key={machine} className="text-xs text-muted-foreground">{t('setup.skills.fleet.none')}</TableCell>;
                  const pending = chosen[machine] ?? {};
                  const count = cell.row.cells.filter((home) => pending[changeKey(home.home.path, row.name)]).length;
                  const gone = removed.has(row.name);
                  const toRemove = gone ? removeFromMachine(cell, settleSkills(view, pending)) : [];
                  return (
                    <MachineCell
                      key={machine}
                      label={t('setup.plugins.grid.cell', { name: row.name, machine })}
                      outlined={cell.look || gone}
                      trigger={count ? <ChosenBadge count={count} /> : (
                        <>
                          <StatusDot tone={cell.look || gone ? 'warning' : cell.loads ? 'success' : 'muted'} />
                          <span className={cn('truncate', cell.loads ? 'text-foreground/85' : 'text-muted-foreground')}>
                            {gone
                              ? t('setup.skills.fleet.removed')
                              : cell.look
                              ? t('setup.skills.fleet.look')
                              : cell.loads
                                ? cell.homes === 1 ? t('setup.skills.fleet.loadsOnly') : t('setup.skills.fleet.loads', { loads: cell.loads, homes: cell.homes })
                                : t('setup.skills.fleet.off')}
                          </span>
                        </>
                      )}
                    >
                      <div className="flex items-center gap-2 border-b border-border/50 px-3.5 py-2.5">
                        <MachinePill name={machine} size="sm" />
                        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{row.name}</span>
                      </div>
                      {gone ? (
                        <div className="flex flex-col gap-2 border-b border-border/50 px-3.5 py-2.5">
                          <p className="text-xs text-muted-foreground">{tRich('setup.skills.fleet.removedNote', { machine: <MachinePill name={machine} size="sm" /> })}</p>
                          {toRemove.length ? (
                            <Button
                              variant="outline"
                              size="xs"
                              className="self-start"
                              onClick={() => setSyncSkills(machine, (current) => addChanges(view, settleSkills(view, current), toRemove))}
                            >
                              {t(toRemove.length === 1 ? 'setup.skills.fleet.removeHere.one' : 'setup.skills.fleet.removeHere.other', { count: toRemove.length })}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="flex flex-col">
                        {cell.row.cells.map((home) => (
                          <div key={home.home.path} className="flex min-w-0 items-center gap-3 border-b border-border/50 px-3.5 py-2 last:border-0">
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate text-sm text-foreground">{homeLabel(homeKey(home.home))}</span>
                              <span className="truncate font-mono text-2xs text-muted-foreground" title={home.home.path}>{home.home.path}</span>
                            </span>
                            <span className="flex min-w-0 max-w-64 justify-end text-xs">
                              <SkillCellView
                                row={cell.row}
                                cell={home}
                                pending={pending}
                                homeLabel={homeLabel}
                                onChoose={(action) => setSyncSkills(machine, (current) => choose(view, settleSkills(view, current), cell.row, home, action))}
                                onCompare={() => {
                                  if (!cell.row.store || !home.item) return;
                                  onCompare({
                                    kind: 'skill',
                                    name: row.name,
                                    reference: { machine, item: cell.row.store, label: cell.row.store.path ?? `${STORE}/${row.name}` },
                                    other: { machine, item: home.item, label: home.item.path ?? row.name },
                                  });
                                }}
                              />
                            </span>
                          </div>
                        ))}
                      </div>
                      <p className="border-t border-border/50 px-3.5 py-2 text-2xs text-muted-foreground">{t('setup.skills.fleet.homeHint')}</p>
                    </MachineCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </TableCard>
  );
}

const REPO_STATE: Record<RepoSkillState, MessageKey> = {
  synced: 'setup.skills.repo.synced',
  removed: 'setup.skills.repo.removed',
  absent: 'setup.skills.repo.absent',
};

/** A skill's value in the setup repo: every machine gets it, or it's taken off them all, which can be put back. */
function SkillRepoMenu({ name, state, busy, onRemoved }: { name: string; state: RepoSkillState; busy: boolean; onRemoved: (removed: boolean) => void }) {
  const { t } = useI18n();
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost-muted" size="xs" disabled={busy} aria-label={t('setup.skills.repo.aria', { name })} />}>
        <span className={cn(state === 'removed' ? 'text-warning-foreground' : state === 'absent' && 'text-muted-foreground')}>{t(REPO_STATE[state])}</span>
        <ChevronDown />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-60">
        {state === 'removed' ? (
          <MenuItem onClick={() => onRemoved(false)}>{t('setup.skills.repo.putBack')}</MenuItem>
        ) : (
          <MenuItem variant="destructive" onClick={() => onRemoved(true)}>{t('setup.skills.repo.remove')}</MenuItem>
        )}
      </MenuPopup>
    </Menu>
  );
}

function SkillsTable({ view, rows, pending, used, usage, usageError, homeLabel, onChoose, onCompare }: {
  view: SkillsView;
  rows: SkillRow[];
  pending: PendingSkills;
  used: ReadonlyMap<string, SkillUsage>;
  usage: SkillUsageReport | null;
  usageError: string | null;
  homeLabel: (key: string) => string;
  onChoose: (row: SkillRow, cell: SkillCell, action: SkillAction | null) => void;
  onCompare: (row: SkillRow, cell: SkillCell) => void;
}) {
  const { t } = useI18n();
  const now = Date.now();
  return (
    <Table containerClassName="max-h-[calc(100vh-var(--workspace-topbar-height)-16rem)] min-h-64 overflow-auto">
      <TableHeader className="sticky top-0 z-20 bg-card">
        <TableRow>
          <TableHead className="sticky left-0 z-10 min-w-52 bg-inherit">{t('setup.skills.column.skill')}</TableHead>
          <TableHead className="min-w-28">
            <Tooltip>
              <TooltipTrigger render={<span className="cursor-help underline decoration-dotted underline-offset-4" />}>
                {t('setup.skills.column.used')}
              </TooltipTrigger>
              <TooltipPopup>
                {[t('setup.skills.column.usedHint'), usage?.pending ? t('setup.skills.column.usedPending', { count: usage.pending }) : null].filter(Boolean).join(' ')}
              </TooltipPopup>
            </Tooltip>
          </TableHead>
          <TableHead className="min-w-36" title={STORE}>
            <TableHeadLabel detail={STORE} mono>{t('setup.skills.column.store')}</TableHeadLabel>
          </TableHead>
          {view.homes.map((home) => {
            const counts = homeCounts(view, home);
            return (
              <TableHead key={home.path} className="min-w-44" title={home.path}>
                <TableHeadLabel
                  detail={
                    <span title={home.folderLink ? t('setup.skills.home.folderLink', { target: home.folderLink }) : undefined}>
                      {home.folderLink
                        ? t('setup.skills.home.linksTo', { target: home.folderLink })
                        : [
                          t('setup.skills.home.counts', counts),
                          counts.turnedOff ? t('setup.skills.home.turnedOff', { count: counts.turnedOff }) : null,
                        ].filter(Boolean).join(' · ')}
                    </span>
                  }
                >
                  {homeLabel(homeKey(home))}
                </TableHeadLabel>
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.name}>
            <TableCell className="sticky left-0 z-10 max-w-72 bg-card">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-mono text-xs text-foreground" title={row.name}>{row.name}</span>
                  {row.manualOnly ? (
                    <Badge variant="muted" size="sm" title={t('setup.skills.manualOnlyHint')}>{t('setup.skills.manualOnly')}</Badge>
                  ) : null}
                </span>
                {row.source || row.declaredName ? (
                  <span className="truncate text-2xs text-muted-foreground">
                    {[row.source, row.declaredName ? t('setup.skills.declared', { name: row.declaredName }) : null].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
              </div>
            </TableCell>
            <TableCell className="text-xs">
              <UsageView usage={usageFor(row, used)} loading={usage === null && usageError === null} error={usageError} now={now} />
            </TableCell>
            <TableCell className="max-w-48 text-xs">
              <PlaceView place={row.storePlace} agent="store" target={row.store?.link ?? null} />
            </TableCell>
            {row.cells.map((cell) => (
              <TableCell key={cell.home.path} className="max-w-56 text-xs">
                <SkillCellView
                  row={row}
                  cell={cell}
                  pending={pending}
                  homeLabel={homeLabel}
                  onChoose={(action) => onChoose(row, cell, action)}
                  onCompare={() => onCompare(row, cell)}
                />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PlaceView({ place, agent, target }: { place: SkillPlace; agent: SkillHome['agent'] | 'store'; target: string | null }) {
  const { t } = useI18n();
  const look = placeLook(place, agent);
  const text = t(look.key, { target: target ?? '' });
  if (!look.tone) return <span className="text-muted-foreground/60" title={text}>—</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={text}>
      <StatusDot tone={look.tone} />
      <span className={cn('truncate', look.tone === 'muted' ? 'text-muted-foreground' : 'text-foreground/85')}>{text}</span>
    </span>
  );
}

function SkillCellView({ row, cell, pending, homeLabel, onChoose, onCompare }: {
  row: SkillRow;
  cell: SkillCell;
  pending: PendingSkills;
  homeLabel: (key: string) => string;
  onChoose: (action: SkillAction | null) => void;
  onCompare: () => void;
}) {
  const { t } = useI18n();
  const options = cellOptions(row, cell, pending);
  const chosen = pending[changeKey(cell.home.path, row.name)] ?? null;
  const comparable = cell.place === 'drifted' && Boolean(row.store?.sum && cell.item?.sum);
  const words = cell.override ? overrideWords(cell.override).map(([key, values]) => t(key, values)).join(' ') : undefined;
  const label = overrideLabel(cell.override);
  const where = <PlaceView place={cell.place} agent={cell.home.agent} target={cell.item?.link ?? null} />;
  // The home's settings have the last word on whether it loads, and are said to, with where they're set on hover.
  const place = isTurnedOff(cell) ? (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={words}>
      <StatusDot tone="muted" />
      <span className="truncate text-muted-foreground">{t('setup.override.off')}</span>
    </span>
  ) : label ? (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="min-w-0">{where}</span>
      <Badge variant="muted" size="sm" className="shrink-0" title={words}>{t(label)}</Badge>
    </span>
  ) : where;
  if (!options.length && !comparable) return place;
  return (
    <div className="flex min-w-0 items-center gap-1">
      {chosen ? (
        <Badge variant="primary" size="lg" className="min-w-0 max-w-full font-normal">
          <ArrowRight aria-hidden="true" />
          <span className="truncate">{t(actionLabel(chosen, row, cell))}</span>
          <button
            type="button"
            className="-me-1 inline-flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-primary/15"
            onClick={() => onChoose(null)}
            aria-label={t('setup.skills.action.clear')}
            title={t('setup.skills.action.clear')}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </Badge>
      ) : (
        <span className="min-w-0">{place}</span>
      )}
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost-muted" size="icon-xs" className="shrink-0" aria-label={t('setup.skills.actions', { name: row.name, home: homeLabel(homeKey(cell.home)) })} />}
        >
          <ChevronDown />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-52">
          {options.map((action) => (
            <MenuItem
              key={action}
              variant={action === 'remove' ? 'destructive' : 'default'}
              onClick={() => onChoose(action)}
              className={cn(chosen === action && 'font-medium')}
            >
              {t(actionLabel(action, row, cell))}
            </MenuItem>
          ))}
          {comparable ? (
            <>
              {options.length ? <MenuSeparator /> : null}
              <MenuItem onClick={onCompare}>{t('setup.skills.action.compare')}</MenuItem>
            </>
          ) : null}
          {chosen ? (
            <>
              <MenuSeparator />
              <MenuItem onClick={() => onChoose(null)}>{t('setup.skills.action.clear')}</MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  );
}

function UsageView({ usage, loading, error, now }: { usage: SkillUsage | null; loading: boolean; error: string | null; now: number }) {
  const { t, tRich } = useI18n();
  if (loading) return <Spinner className="size-3 text-muted-foreground" />;
  if (error) return <span className="text-muted-foreground/60" title={t('setup.skills.used.failed', { error })}>—</span>;
  if (!usage) return <span className="text-muted-foreground">{t('setup.skills.used.none')}</span>;
  const lines = [
    usage.calls ? t(usage.calls === 1 ? 'setup.skills.used.calls.one' : 'setup.skills.used.calls.other', { count: usage.calls }) : null,
    usage.lastMs ? t('setup.skills.used.last', { time: formatAgo(usage.lastMs, now) }) : null,
  ].filter((line): line is string => Boolean(line));
  const machines = Object.entries(usage.machines).sort((a, b) => b[1] - a[1]);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-default tabular-nums text-foreground/85" />}>
        {t(usage.sessions === 1 ? 'setup.skills.used.sessions.one' : 'setup.skills.used.sessions.other', { count: usage.sessions })}
      </TooltipTrigger>
      <TooltipPopup className="flex-col items-start">
        {lines.map((line) => <span key={line}>{line}</span>)}
        {machines.map(([machine, count]) => <span key={machine}>{tRich('setup.skills.used.machine', { machine: <MachinePill name={machine} size="sm" />, count })}</span>)}
      </TooltipPopup>
    </Tooltip>
  );
}

export function SkillReviewDialog({ open, machine, view, pending, planned, homeLabel, onClose, onApplied }: {
  open: boolean;
  machine: SetupMachine | null;
  view: SkillsView | null;
  pending: PendingSkills;
  planned: PlannedSkill[];
  homeLabel: (key: string) => string;
  onClose: () => void;
  onApplied: (outcome: SyncOutcome) => void;
}) {
  const { t, tRich } = useI18n();
  // Asked in the footer rather than over the dialog, which would take a click on it as one outside.
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setConfirming(false);
      setError(null);
    }
  }, [open]);

  const changes = view ? skillChanges(view, pending) : null;
  // Until the machine has been read again after a change, what it has isn't known.
  const reading = machine?.scanning === true;
  const count = planned.length;
  const byHome = (view?.homes ?? [])
    .map((home) => ({ home, changes: planned.filter((change) => change.cell.home.path === home.path) }))
    .filter((group) => group.changes.length);

  const apply = async () => {
    setConfirming(false);
    if (!machine || !changes?.length) return;
    setBusy(true);
    setError(null);
    try {
      onApplied(await applySkillChanges(machine.machine, changes));
    } catch (failure) {
      setError(t('setup.skills.outcome.error', { error: String(failure) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen && !busy) onClose(); }}>
      <DialogPopup className="max-w-3xl">
        {machine ? (
          <>
            <DialogHeader>
              <DialogTitle className="pe-8">{tRich('setup.skills.review.title', { machine: <MachinePill name={machine.machine} size="lg" /> })}</DialogTitle>
              <DialogDescription>
                {tRich('setup.skills.review.description', {
                  machine: <MachinePill name={machine.machine} />,
                  time: machine.scannedAt !== null ? formatAgo(machine.scannedAt, Date.now()) : t('setup.sync.notRead'),
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-4">
              {byHome.map(({ home, changes: group }) => (
                <section key={home.path} className="flex flex-col gap-1.5">
                  <h3 className="flex items-baseline gap-2 text-xs font-medium text-muted-foreground">
                    {homeLabel(homeKey(home))}
                    <span className="font-mono normal-case tracking-normal text-muted-foreground">{`${home.path}/skills`}</span>
                  </h3>
                  <div className="overflow-hidden rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
                    {group.map((change) => (
                      <div key={change.row.name} className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm">
                        <span className="w-40 shrink-0 truncate font-mono text-xs text-foreground" title={change.row.name}>{change.row.name}</span>
                        <span className="min-w-0 flex-1 text-muted-foreground">{changeText(change, t)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
              {reading ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5" />{tRich('setup.skills.reading', { machine: <MachinePill name={machine.machine} size="sm" /> })}</p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              {confirming ? (
                <>
                  <p className="me-auto max-w-xl text-sm text-foreground" role="status">
                    {tRich(count === 1 ? 'setup.skills.confirm.one' : 'setup.skills.confirm.other', { count, machine: <MachinePill name={machine.machine} /> })}
                  </p>
                  <Button variant="outline" onClick={() => setConfirming(false)}>{t('setup.sync.back')}</Button>
                  <Button variant={planned.some((change) => change.action === 'remove') ? 'destructive' : 'default'} onClick={() => void apply()}>
                    {tRich('setup.skills.confirm.apply', { machine: <MachinePill name={machine.machine} /> })}
                  </Button>
                </>
              ) : (
                <>
                  {error ? <p className="me-auto max-w-xl text-sm text-error-foreground" role="status">{error}</p> : null}
                  <Button variant="outline" disabled={busy} onClick={onClose}>{t('common.close')}</Button>
                  <Button disabled={!changes?.length || busy || reading} onClick={() => setConfirming(true)}>
                    {busy ? <Spinner /> : null}
                    {t(count === 1 ? 'setup.skills.apply.one' : 'setup.skills.apply.other', { count })}
                  </Button>
                </>
              )}
            </DialogFooter>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

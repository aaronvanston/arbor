import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronDown, CircleCheck, CircleX, FolderGit2, HardDrive, Layers, Search, Sparkles } from '../components/ui/icons';
import { useConfirmation } from '../components/ConfirmationDialog';
import { SettingsSection } from '../components/layout/settings';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '../components/ui/menu';
import { Spinner } from '../components/ui/spinner';
import { StatusDot, type StatusTone } from '../components/ui/status-dot';
import { Switch } from '../components/ui/switch';
import { TableCard, TableEmpty, TableHeadLabel } from '../components/ui/data-table';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { toast } from '../components/ui/toast';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import { formatAgo } from '../lib/format';
import { homeKey, overrideLabel, overrideWords } from '../services/setupInventory';
import {
  applySkillChanges,
  cellOptions,
  fleetSkillGrid,
  fleetSkills,
  repoSkillState,
  getSkillUsage,
  homeCounts,
  isTurnedOff,
  needsLook,
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
import { skillFolder } from '../services/repoBrowser';
import {
  applySkillPick,
  bulkHomeChanges,
  endActivity,
  isBusy,
  machinePlan,
  planKeys,
  planSize,
  planSkills,
  putsOnly,
  runSkillPlan,
  runSucceeded,
  startActivity,
  takeableSkills,
  tickRows,
  touchedSkills,
  undoSkillRun,
  undoSucceeded,
  useSkillActivity,
  type BulkHomeKind,
  type Kept,
  type RunPhase,
  type RunProblem,
  type SkillCopy,
  type SkillPlan,
  type SkillPlanKind,
  type SkillRunDone,
  type SkillRunProgress,
  type UndoProblems,
} from '../services/skillRuns';
import { getSetupRepo, listSetupBackups, scanned, skillWanted, storedSetupRepo, undoSetupSync } from '../services/setupSync';
import { setSyncMachine, useSyncScope } from '../services/syncScope';
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
import { GridFilters, MachineCell } from './SetupPluginGrid';

/** How far back skill use is counted. */
const USAGE_DAYS = 30;

type Translate = ReturnType<typeof useI18n>['t'];
type TranslateRich = ReturnType<typeof useI18n>['tRich'];
/** What a change did, with the machine's pill in the sentence. */
type Notice = { ok: boolean; text: ReactNode };

/** A change across machines, or one machine's picked together, waiting to be looked over and made. */
type PlanRequest =
  | { kind: Exclude<SkillPlanKind, 'machine'>; names: string[]; first: string | null }
  | { kind: 'machine'; machine: string; changes: PlannedSkill[] };

/** What the repo column's menu can do to a skill: put it on every machine (in the repo first), or take it off them all. */
type RepoAction = 'add' | 'remove';

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

/** A change, in a sentence, for a review or a plan. */
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

/** What a pick made straight away did, for its toast. */
function pickedText({ row, cell, action }: PlannedSkill, home: string, t: Translate): string {
  const name = row.name;
  switch (action) {
    case 'link': return t('setup.skills.picked.link', { name, home });
    case 'useStore': return t('setup.skills.picked.useStore', { name, home });
    case 'adopt': return t('setup.skills.picked.adopt', { name });
    default:
      return t(cell.home.agent === 'claude' && cell.place === 'linked' ? 'setup.skills.picked.turnOff' : 'setup.skills.picked.remove', { name, home });
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

/** What a finished run did, for its toast. */
function doneTitle(done: SkillRunDone, t: Translate, tRich: TranslateRich): ReactNode {
  const count = done.names.length;
  const one = count === 1;
  const name = done.names[0] ?? '';
  if (done.kind === 'machine') {
    const machine = done.backups[0]?.machine ?? '';
    return tRich(one ? 'setup.skills.done.machine.one' : 'setup.skills.done.machine.other', { count, machine: <MachinePill name={machine} size="sm" /> });
  }
  const keys: Record<Exclude<SkillPlanKind, 'machine'>, [MessageKey, MessageKey]> = {
    add: done.repoSteps.length ? ['setup.skills.done.add.one', 'setup.skills.done.add.other'] : ['setup.skills.done.putOn.one', 'setup.skills.done.putOn.other'],
    remove: ['setup.skills.done.remove.one', 'setup.skills.done.remove.other'],
    on: ['setup.skills.done.on.one', 'setup.skills.done.on.other'],
    off: ['setup.skills.done.off.one', 'setup.skills.done.off.other'],
  };
  return t(keys[done.kind][one ? 0 : 1], { name, count });
}

/** Why a machine's part didn't finish, in a sentence. */
function problemText(problem: RunProblem, t: Translate): string {
  switch (problem.kind) {
    case 'changed': return t('setup.skills.plan.problem.changed');
    case 'failed': return t('setup.skills.plan.problem.failed', { paths: problem.paths.join(', ') });
    case 'unread': return t('setup.skills.plan.problem.unread');
    default: return problem.detail;
  }
}

/** What undoing a run couldn't put back, in a sentence for its toast. */
function undoProblemText(problems: UndoProblems, t: Translate): string {
  const machines = Object.entries(problems.machines).map(([machine, problem]) => `${machine}: ${problemText(problem, t)}`);
  return [...machines, ...(problems.repoError ? [problems.repoError] : [])].join(' ');
}

/**
 * The Skills tab: one machine's store of skills against each of its Claude Code and Codex homes, or at All machines
 * every skill against every machine, with the setup repo's say beside each. A pick in a cell is made straight away
 * and can be undone; ticked skills can be put on every machine, taken off them all, or changed in every home at once,
 * each looked over first as one plan.
 */
export function SetupSkills({ machines, homeLabel, onCompare, onOpenInRepo }: {
  machines: SetupMachine[];
  homeLabel: (key: string) => string;
  onCompare: (comparison: Comparison) => void;
  /** Opens a file in the setup repo's browser, by its path there. */
  onOpenInRepo: (path: string) => void;
}) {
  const { t, tRich } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [query, setQuery] = useState('');
  const [onlyLook, setOnlyLook] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [usage, setUsage] = useState<SkillUsageReport | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [backups, setBackups] = useState<SetupBackup[] | null>(null);
  const [backupsError, setBackupsError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [request, setRequest] = useState<PlanRequest | null>(null);
  const activity = useSkillActivity();

  // Sync's scope picks the machine; at All machines the page sums up every machine instead.
  const { machine: scoped } = useSyncScope();
  const machine = machines.find((entry) => entry.machine === scoped) ?? null;
  const name = machine?.machine ?? null;
  const view = useMemo(() => (machine ? skillsView(machine) : null), [machine]);
  const suggestions = useMemo(() => (view ? skillSuggestions(view) : []), [view]);
  const used = useMemo(() => new Map((usage?.skills ?? []).map((entry) => [entry.name, entry])), [usage]);

  // The setup repo says which skills every machine gets, and which it took off them all.
  const [repoPath] = useState(storedSetupRepo);
  const [repo, setRepo] = useState<SetupRepo | null>(null);
  // Until a chosen repo's first read is back, the page doesn't ask for one to be chosen.
  const [repoRead, setRepoRead] = useState(false);
  const scans = machines.map((entry) => `${entry.machine}:${entry.scannedAt ?? ''}`).join('\n');
  const readRepo = useCallback(async () => {
    if (!repoPath) return;
    try {
      const next = await getSetupRepo(repoPath);
      setRepo(next.head ? next : null);
    } catch {
      setRepo(null);
    } finally {
      setRepoRead(true);
    }
  }, [repoPath]);
  useEffect(() => { void readRepo(); }, [readRepo, scans]);

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
    setSelected(new Set());
    anchor.current = null;
    if (name) void loadBackups(name);
  }, [name, loadBackups]);

  const tick = useCallback((order: readonly string[], skill: string, on: boolean, range: boolean) => {
    setSelected((current) => tickRows(order, current, anchor.current, skill, on, range));
    anchor.current = skill;
  }, []);
  const tickAll = useCallback((shown: readonly string[], on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const skill of shown) {
        if (on) next.add(skill);
        else next.delete(skill);
      }
      return next;
    });
  }, []);

  const undoPick = async (target: string, backup: string) => {
    try {
      const outcome = await undoSetupSync(target, backup);
      if (outcome.failed.length) setNotice(skillOutcome(outcome, target, t, tRich));
      else toast({ kind: 'success', title: tRich('setup.skills.undone', { machine: <MachinePill name={target} size="sm" /> }) });
      if (target === name) void loadBackups(target);
    } catch (error) {
      setNotice({ ok: false, text: t('setup.skills.undoFailed', { error: String(error) }) });
    }
  };

  /** A cell's pick, made straight away; its toast can undo it. */
  const pick = async (target: SetupMachine, targetView: SkillsView, row: SkillRow, cell: SkillCell, action: SkillAction) => {
    setNotice(null);
    try {
      const outcome = await applySkillPick(target.machine, targetView, row, cell, action);
      if (!outcome) {
        setNotice({ ok: false, text: tRich('setup.skills.pick.stale', { machine: <MachinePill name={target.machine} /> }) });
        return;
      }
      if (outcome.failed.length) setNotice(skillOutcome(outcome, target.machine, t, tRich));
      else {
        const backup = outcome.backup;
        toast({
          kind: 'success',
          title: pickedText({ row, cell, action }, homeLabel(homeKey(cell.home)), t),
          description: <MachinePill name={target.machine} size="sm" />,
          action: backup ? { label: t('common.undo'), onClick: () => void undoPick(target.machine, backup) } : undefined,
        });
      }
      if (target.machine === name) void loadBackups(target.machine);
    } catch (error) {
      setNotice({ ok: false, text: t('setup.skills.outcome.error', { error: String(error) }) });
    }
  };

  const undoRun = async (done: SkillRunDone) => {
    const keys = done.backups.flatMap(({ machine: target }) => done.names.map((skill) => ({ machine: target, name: skill })));
    startActivity(keys);
    try {
      const problems = await undoSkillRun(done);
      void readRepo();
      if (name) void loadBackups(name);
      if (undoSucceeded(problems)) toast({ kind: 'success', title: t('setup.skills.done.undone') });
      else toast({ kind: 'error', title: t('setup.skills.done.undoFailed', { error: undoProblemText(problems, t) }) });
    } finally {
      endActivity(keys);
    }
  };

  const finished = (done: SkillRunDone) => {
    setRequest(null);
    setSelected(new Set());
    void readRepo();
    if (name) void loadBackups(name);
    toast({ kind: 'success', title: doneTitle(done, t, tRich), action: { label: t('common.undo'), onClick: () => void undoRun(done) } });
  };

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

  // Read once for the table, rather than per row.
  const takeable = useMemo(() => takeableSkills(machines), [machines]);
  const onRepo = (skill: string, action: RepoAction) => setRequest({ kind: action, names: [skill], first: name });

  const needle = query.trim().toLowerCase();
  const rows = (view?.rows ?? []).filter((row) =>
    (!needle || row.name.toLowerCase().includes(needle) || Boolean(row.declaredName?.toLowerCase().includes(needle)))
    && (!onlyLook || needsLook(row)));
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
      <SkillsHow repo={repo !== null} reading={Boolean(repoPath) && !repoRead} />
      {notice ? (
        <p className={cn('text-sm', notice.ok ? 'text-muted-foreground' : 'text-error-foreground')} role="status">{notice.text}</p>
      ) : null}
      {!machine || !view ? (
        <>
          <FleetSkillsCard
            machines={machines}
            repo={repo}
            selected={selected}
            onTick={tick}
            onTickAll={tickAll}
            activity={activity}
            used={used}
            usage={usage}
            usageError={usageError}
            homeLabel={homeLabel}
            onCompare={onCompare}
            onOpenInRepo={onOpenInRepo}
            onPick={(target, targetView, row, cell, action) => void pick(target, targetView, row, cell, action)}
            onRepo={onRepo}
          />
          <ProjectSkillsCard machines={machines} />
          <FleetBulkBar machines={machines} repo={repo} selected={selected} onClear={() => setSelected(new Set())} onPlan={setRequest} />
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
              onReview={(suggestion) => setRequest({ kind: 'machine', machine: machine.machine, changes: suggestion.changes })}
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
                machine={machine}
                view={view}
                rows={rows}
                repo={repo}
                selected={selected}
                onTick={tick}
                onTickAll={tickAll}
                busy={(skill) => isBusy(activity, machine, skill)}
                used={used}
                usage={usage}
                usageError={usageError}
                homeLabel={homeLabel}
                onPick={(row, cell, action) => void pick(machine, view, row, cell, action)}
                onRepo={onRepo}
                canTake={(skill) => takeable.has(skill)}
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
          <MachineBulkBar
            machine={machine}
            view={view}
            machines={machines}
            repo={repo}
            selected={selected}
            onClear={() => setSelected(new Set())}
            onPlan={setRequest}
          />
        </>
      )}
      <SkillPlanDialog
        request={request}
        machines={machines}
        repo={repo}
        homeLabel={homeLabel}
        onClose={() => {
          setRequest(null);
          void readRepo();
          if (name) void loadBackups(name);
        }}
        onDone={finished}
      />
    </div>
  );
}

/** How a skill reaches an agent: the repo lists it, each machine's store keeps it, and homes load it from there. */
function SkillsHow({ repo, reading }: { repo: boolean; reading: boolean }) {
  const { t } = useI18n();
  const steps = [
    { icon: FolderGit2, title: 'setup.skills.how.repo', detail: 'setup.skills.how.repoDetail' },
    { icon: HardDrive, title: 'setup.skills.how.store', detail: 'setup.skills.how.storeDetail' },
    { icon: Layers, title: 'setup.skills.how.homes', detail: 'setup.skills.how.homesDetail' },
  ] as const;
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border/70 bg-card px-4 py-3">
      <ol className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {steps.map((step, index) => (
          <li key={step.title} className="flex items-center gap-4">
            {index ? <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/70" /> : null}
            <span className="flex items-center gap-2.5">
              <step.icon aria-hidden="true" className="size-4 shrink-0 text-primary" />
              <span className="flex flex-col leading-tight">
                <span className="text-sm text-foreground">{t(step.title)}</span>
                <span className="text-xs text-muted-foreground">{t(step.detail)}</span>
              </span>
            </span>
          </li>
        ))}
      </ol>
      {reading ? null : <p className="text-xs text-muted-foreground">{t(repo ? 'setup.skills.how.note' : 'setup.skills.how.noRepo')}</p>}
    </div>
  );
}

function Suggestions({ suggestions, homeLabel, onReview }: {
  suggestions: SkillSuggestion[];
  homeLabel: (key: string) => string;
  onReview: (suggestion: SkillSuggestion) => void;
}) {
  const { t } = useI18n();
  return (
    <SettingsSection title={t('setup.skills.suggest.title')}>
      {suggestions.map((suggestion) => (
        <div key={`${suggestion.kind}:${suggestion.home ?? ''}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <Sparkles aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
          <p className="min-w-0 flex-1 text-sm leading-[1.45] text-foreground/90">{suggestionText(suggestion, t, homeLabel)}</p>
          <Button variant="outline" size="xs" onClick={() => onReview(suggestion)}>
            {t(suggestion.changes.length === 1 ? 'setup.skills.suggest.review.one' : 'setup.skills.suggest.review.other', { count: suggestion.changes.length })}
          </Button>
        </div>
      ))}
    </SettingsSection>
  );
}

/** A row's tick box; Shift ticks every row from the last one ticked. */
function TickCell({ name, order, selected, onTick }: {
  name: string;
  order: readonly string[];
  selected: ReadonlySet<string>;
  onTick: (order: readonly string[], name: string, on: boolean, range: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <Checkbox
      checked={selected.has(name)}
      aria-label={t('setup.skills.select.one', { name })}
      onCheckedChange={(checked, details) => onTick(order, name, checked, 'shiftKey' in details.event && details.event.shiftKey === true)}
    />
  );
}

/** The head's tick box: every row shown, some, or none. */
function TickAll({ shown, selected, onTickAll }: { shown: readonly string[]; selected: ReadonlySet<string>; onTickAll: (shown: readonly string[], on: boolean) => void }) {
  const { t } = useI18n();
  const ticked = shown.filter((name) => selected.has(name)).length;
  return (
    <Checkbox
      checked={ticked > 0 && ticked === shown.length}
      indeterminate={ticked > 0 && ticked < shown.length}
      aria-label={t('setup.skills.select.all')}
      onCheckedChange={() => onTickAll(shown, ticked < shown.length)}
    />
  );
}

/**
 * Sync › Skills at All machines: every skill any machine has, and in how many of each machine's homes it loads. A
 * machine's cell opens to its homes, each changed as it's picked; a machine's column head opens that machine.
 */
function FleetSkillsCard({ machines, repo, selected, onTick, onTickAll, activity, used, usage, usageError, homeLabel, onCompare, onOpenInRepo, onPick, onRepo }: {
  machines: SetupMachine[];
  repo: SetupRepo | null;
  selected: ReadonlySet<string>;
  onTick: (order: readonly string[], name: string, on: boolean, range: boolean) => void;
  onTickAll: (shown: readonly string[], on: boolean) => void;
  activity: ReturnType<typeof useSkillActivity>;
  used: ReadonlyMap<string, SkillUsage>;
  usage: SkillUsageReport | null;
  usageError: string | null;
  homeLabel: (key: string) => string;
  onCompare: (comparison: Comparison) => void;
  onOpenInRepo: (path: string) => void;
  onPick: (machine: SetupMachine, view: SkillsView, row: SkillRow, cell: SkillCell, action: SkillAction) => void;
  onRepo: (name: string, action: RepoAction) => void;
}) {
  const { t, tRich } = useI18n();
  // What's out of line comes first, as on the plugins' grid.
  const [onlyLook, setOnlyLook] = useState(true);
  const [query, setQuery] = useState('');
  const removed = useMemo(() => new Set(repo?.removedSkills ?? []), [repo]);
  const fleet = useMemo(() => fleetSkills(machines), [machines]);
  const takeable = useMemo(() => takeableSkills(machines), [machines]);
  const grid = useMemo(() => fleetSkillGrid(fleet, onlyLook, query, removed), [fleet, onlyLook, query, removed]);
  const order = useMemo(() => grid.rows.map((row) => row.name), [grid]);
  const byName = useMemo(() => new Map(machines.map((machine) => [machine.machine, machine])), [machines]);
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
      footer={grid.inLine ? (
        <span className="flex flex-wrap items-center gap-2 py-0.5 text-xs text-muted-foreground">
          {t(grid.inLine === 1 ? 'setup.skills.fleet.inLine.one' : 'setup.skills.fleet.inLine.other', { count: grid.inLine })}
          <Button variant="link" size="xs" onClick={() => setOnlyLook(false)}>{t('setup.plugins.grid.showAll')}</Button>
        </span>
      ) : null}
    >
      {empty ? (
        <TableEmpty>{empty}</TableEmpty>
      ) : (
        <Table stickyHeader containerClassName="max-h-[calc(100vh-var(--workspace-topbar-height)-16rem)] overflow-auto">
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 w-9 bg-card pe-0"><TickAll shown={order} selected={selected} onTickAll={onTickAll} /></TableHead>
              <TableHead className="sticky left-9 z-10 min-w-52 bg-card">{t('setup.skills.column.skill')}</TableHead>
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
              <TableRow key={row.name} data-state={selected.has(row.name) ? 'selected' : undefined}>
                <TableCell className="sticky left-0 z-10 w-9 bg-card pe-0"><TickCell name={row.name} order={order} selected={selected} onTick={onTick} /></TableCell>
                <TableCell className="sticky left-9 z-10 max-w-72 bg-card">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    {repo && repoSkillState(repo, row.name) === 'synced' ? (
                      // The repo's copy is the one every machine gets, so its name opens that copy's files.
                      <button
                        type="button"
                        className="cursor-pointer truncate rounded-sm text-start font-mono text-xs text-foreground underline decoration-muted-foreground/50 underline-offset-4 outline-none ring-ring hover:decoration-foreground focus-visible:ring-2"
                        title={t('setup.skills.fleet.openInRepo', { name: row.name })}
                        onClick={() => onOpenInRepo(`${skillFolder(row.name)}/SKILL.md`)}
                      >
                        {row.name}
                      </button>
                    ) : (
                      <span className="truncate font-mono text-xs text-foreground" title={row.name}>{row.name}</span>
                    )}
                    {row.source ? <span className="truncate text-2xs text-muted-foreground">{row.source}</span> : null}
                  </div>
                </TableCell>
                {repo ? (
                  <TableCell className="text-xs">
                    <SkillRepoMenu name={row.name} state={repoSkillState(repo, row.name)} wanted={null} takeable={takeable.has(row.name)} onAction={(action) => onRepo(row.name, action)} />
                  </TableCell>
                ) : null}
                <TableCell className="text-xs">
                  <UsageView usage={used.get(row.name) ?? null} loading={usage === null && usageError === null} error={usageError} now={now} />
                </TableCell>
                {fleet.machines.map((machine) => {
                  const cell = row.cells[machine];
                  const view = fleet.views[machine];
                  const entry = byName.get(machine);
                  if (!cell || !view || !entry) return <TableCell key={machine} className="text-xs text-muted-foreground">{t('setup.skills.fleet.none')}</TableCell>;
                  const gone = removed.has(row.name);
                  const busy = isBusy(activity, entry, row.name);
                  return (
                    <MachineCell
                      key={machine}
                      label={t('setup.plugins.grid.cell', { name: row.name, machine })}
                      outlined={cell.look || gone}
                      trigger={busy ? (
                        <>
                          <Spinner className="size-3 text-muted-foreground" />
                          <span className="truncate text-muted-foreground">{t('setup.skills.busy')}</span>
                        </>
                      ) : (
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
                          <Button variant="outline" size="xs" className="self-start" onClick={() => onRepo(row.name, 'remove')}>{t('setup.skills.repo.removeLeft')}</Button>
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
                                busy={busy}
                                homeLabel={homeLabel}
                                onPick={(action) => onPick(entry, view, cell.row, home, action)}
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

/**
 * A skill's value in the setup repo, and what can be done with it there: put it on every machine (taking a machine's
 * copy into the repo first when it hasn't got one, or putting back one it removed), or take it off every machine.
 * `wanted` is the repo's own value for the machine shown, if it has one.
 */
function SkillRepoMenu({ name, state, wanted, takeable, onAction }: {
  name: string;
  state: RepoSkillState;
  wanted: 'off' | 'own' | null;
  /** Whether some machine has a copy the repo could take, for a skill the repo hasn't got. */
  takeable: boolean;
  onAction: (action: RepoAction) => void;
}) {
  const { t } = useI18n();
  const label: MessageKey = state === 'synced' && wanted === 'off' ? 'setup.skills.repo.offHere' : state === 'synced' && wanted === 'own' ? 'setup.skills.repo.ownHere' : REPO_STATE[state];
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost-muted" size="xs" className="-ms-2" aria-label={t('setup.skills.repo.aria', { name })} />}>
        <span className={cn(state === 'removed' ? 'text-warning-foreground' : state === 'absent' ? 'text-muted-foreground' : 'text-foreground/85')}>{t(label)}</span>
        <ChevronDown />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-60">
        {state === 'absent' ? (
          <MenuItem disabledReason={takeable ? undefined : t('setup.skills.repo.noCopy')} onClick={() => onAction('add')}>{t('setup.skills.repo.add')}</MenuItem>
        ) : null}
        {state === 'synced' ? <MenuItem onClick={() => onAction('add')}>{t('setup.skills.repo.putOn')}</MenuItem> : null}
        {state === 'removed' ? <MenuItem onClick={() => onAction('add')}>{t('setup.skills.repo.putBack')}</MenuItem> : null}
        <MenuSeparator />
        <MenuItem variant="destructive" onClick={() => onAction('remove')}>
          {t(state === 'removed' ? 'setup.skills.repo.removeLeft' : 'setup.skills.repo.remove')}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function SkillsTable({ machine, view, rows, repo, selected, onTick, onTickAll, busy, used, usage, usageError, homeLabel, onPick, onRepo, onCompare, canTake }: {
  machine: SetupMachine;
  view: SkillsView;
  rows: SkillRow[];
  repo: SetupRepo | null;
  selected: ReadonlySet<string>;
  onTick: (order: readonly string[], name: string, on: boolean, range: boolean) => void;
  onTickAll: (shown: readonly string[], on: boolean) => void;
  busy: (name: string) => boolean;
  used: ReadonlyMap<string, SkillUsage>;
  usage: SkillUsageReport | null;
  usageError: string | null;
  homeLabel: (key: string) => string;
  onPick: (row: SkillRow, cell: SkillCell, action: SkillAction) => void;
  onRepo: (name: string, action: RepoAction) => void;
  onCompare: (row: SkillRow, cell: SkillCell) => void;
  canTake: (name: string) => boolean;
}) {
  const { t } = useI18n();
  const now = Date.now();
  const order = useMemo(() => rows.map((row) => row.name), [rows]);
  return (
    <Table containerClassName="max-h-[calc(100vh-var(--workspace-topbar-height)-16rem)] min-h-64 overflow-auto">
      <TableHeader className="sticky top-0 z-20 bg-card">
        <TableRow>
          <TableHead className="sticky left-0 z-10 w-9 bg-inherit pe-0"><TickAll shown={order} selected={selected} onTickAll={onTickAll} /></TableHead>
          <TableHead className="sticky left-9 z-10 min-w-52 bg-inherit">{t('setup.skills.column.skill')}</TableHead>
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
          {repo ? <TableHead className="min-w-36">{t('setup.plugins.column.repo')}</TableHead> : null}
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
        {rows.map((row) => {
          const working = busy(row.name);
          const wanted = repo ? skillWanted(repo, `${STORE}/${row.name}`, machine.machine) ?? null : null;
          return (
            <TableRow key={row.name} data-state={selected.has(row.name) ? 'selected' : undefined}>
              <TableCell className="sticky left-0 z-10 w-9 bg-card pe-0"><TickCell name={row.name} order={order} selected={selected} onTick={onTick} /></TableCell>
              <TableCell className="sticky left-9 z-10 max-w-72 bg-card">
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
              {repo ? (
                <TableCell className="text-xs">
                  <SkillRepoMenu name={row.name} state={repoSkillState(repo, row.name)} wanted={wanted} takeable={canTake(row.name)} onAction={(action) => onRepo(row.name, action)} />
                </TableCell>
              ) : null}
              <TableCell className="max-w-48 text-xs">
                <PlaceView place={row.storePlace} agent="store" target={row.store?.link ?? null} />
              </TableCell>
              {row.cells.map((cell) => (
                <TableCell key={cell.home.path} className="max-w-56 text-xs">
                  <SkillCellView
                    row={row}
                    cell={cell}
                    busy={working}
                    homeLabel={homeLabel}
                    onPick={(action) => onPick(row, cell, action)}
                    onCompare={() => onCompare(row, cell)}
                  />
                </TableCell>
              ))}
            </TableRow>
          );
        })}
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

/** A skill in one home, and what can be done to it there, done as soon as it's picked. */
function SkillCellView({ row, cell, busy, homeLabel, onPick, onCompare }: {
  row: SkillRow;
  cell: SkillCell;
  busy: boolean;
  homeLabel: (key: string) => string;
  onPick: (action: SkillAction) => void;
  onCompare: () => void;
}) {
  const { t } = useI18n();
  const options = cellOptions(row, cell);
  const comparable = cell.place === 'drifted' && Boolean(row.store?.sum && cell.item?.sum);
  const words = cell.override ? overrideWords(cell.override).map(([key, values]) => t(key, values)).join(' ') : undefined;
  const label = overrideLabel(cell.override);
  const where = <PlaceView place={cell.place} agent={cell.home.agent} target={cell.item?.link ?? null} />;
  if (busy) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground" title={t('setup.skills.busyHint')}>
        <Spinner className="size-3" />
        <span className="truncate">{t('setup.skills.busy')}</span>
      </span>
    );
  }
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
      <span className="min-w-0">{place}</span>
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost-muted" size="icon-xs" className="shrink-0" aria-label={t('setup.skills.actions', { name: row.name, home: homeLabel(homeKey(cell.home)) })} />}
        >
          <ChevronDown />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-52">
          {options.map((action) => (
            <MenuItem key={action} variant={action === 'remove' ? 'destructive' : 'default'} onClick={() => onPick(action)}>
              {t(actionLabel(action, row, cell))}
            </MenuItem>
          ))}
          {comparable ? (
            <>
              {options.length ? <MenuSeparator /> : null}
              <MenuItem onClick={onCompare}>{t('setup.skills.action.compare')}</MenuItem>
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

/** The bar ticked skills bring up, at the foot of the page while there are any. */
function BulkBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  const { t } = useI18n();
  if (!count) return null;
  return (
    <div className="sticky bottom-4 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-background/95 px-4 py-2.5 shadow-lg/5 backdrop-blur dark:bg-card/95" role="region" aria-label={t('setup.skills.bulk.label')}>
      <p className="me-auto text-sm text-foreground">{t(count === 1 ? 'setup.skills.bulk.count.one' : 'setup.skills.bulk.count.other', { count })}</p>
      <Button variant="ghost-muted" size="sm" onClick={onClear}>{t('setup.skills.bulk.clear')}</Button>
      {children}
    </div>
  );
}

/**
 * The skills a plan would change, counted for a button. An add that commits nothing only puts skills the repo already
 * has on the machines missing them, so the button says that instead.
 */
function useRepoPlans(names: string[], machines: SetupMachine[], repo: SetupRepo | null, first: string | null) {
  return useMemo((): { add: number; remove: number; addKey: MessageKey } => {
    if (!repo || !names.length) return { add: 0, remove: 0, addKey: 'setup.skills.bulk.add' };
    const add = planSkills('add', names, machines, repo, first);
    return {
      add: touchedSkills(add).length,
      remove: touchedSkills(planSkills('remove', names, machines, repo, first)).length,
      addKey: putsOnly(add) ? 'setup.skills.bulk.putOn' : 'setup.skills.bulk.add',
    };
  }, [names, machines, repo, first]);
}

function FleetBulkBar({ machines, repo, selected, onClear, onPlan }: {
  machines: SetupMachine[];
  repo: SetupRepo | null;
  selected: ReadonlySet<string>;
  onClear: () => void;
  onPlan: (request: PlanRequest) => void;
}) {
  const { t } = useI18n();
  const names = useMemo(() => [...selected].sort((a, b) => a.localeCompare(b)), [selected]);
  const counts = useRepoPlans(names, machines, repo, null);
  const homes = useMemo(() => ({
    on: names.length ? touchedSkills(planSkills('on', names, machines, repo)).length : 0,
    off: names.length ? touchedSkills(planSkills('off', names, machines, repo)).length : 0,
  }), [names, machines, repo]);
  const noRepo = repo ? undefined : t('setup.skills.repo.noRepo');
  return (
    <BulkBar count={names.length} onClear={onClear}>
      <Button variant="outline" size="sm" disabled={!homes.off} disabledReason={homes.off ? undefined : t('setup.skills.bulk.nothing')} onClick={() => onPlan({ kind: 'off', names, first: null })}>
        {t('setup.skills.bulk.off', { count: homes.off })}
      </Button>
      <Button variant="outline" size="sm" disabled={!homes.on} disabledReason={homes.on ? undefined : t('setup.skills.bulk.nothing')} onClick={() => onPlan({ kind: 'on', names, first: null })}>
        {t('setup.skills.bulk.on', { count: homes.on })}
      </Button>
      <Button variant="destructive-outline" size="sm" disabled={!counts.remove} disabledReason={noRepo ?? (counts.remove ? undefined : t('setup.skills.bulk.nothing'))} onClick={() => onPlan({ kind: 'remove', names, first: null })}>
        {t('setup.skills.bulk.remove', { count: counts.remove })}
      </Button>
      <Button size="sm" disabled={!counts.add} disabledReason={noRepo ?? (counts.add ? undefined : t('setup.skills.bulk.nothing'))} onClick={() => onPlan({ kind: 'add', names, first: null })}>
        {t(counts.addKey, { count: counts.add })}
      </Button>
    </BulkBar>
  );
}

const MACHINE_BULK: { kind: BulkHomeKind; key: MessageKey }[] = [
  { kind: 'link', key: 'setup.skills.bulk.link' },
  { kind: 'turnOff', key: 'setup.skills.bulk.turnOff' },
  { kind: 'useStore', key: 'setup.skills.bulk.useStore' },
  { kind: 'codexTwice', key: 'setup.skills.bulk.codexTwice' },
];

function MachineBulkBar({ machine, view, machines, repo, selected, onClear, onPlan }: {
  machine: SetupMachine;
  view: SkillsView;
  machines: SetupMachine[];
  repo: SetupRepo | null;
  selected: ReadonlySet<string>;
  onClear: () => void;
  onPlan: (request: PlanRequest) => void;
}) {
  const { t, tRich } = useI18n();
  const names = useMemo(() => [...selected].sort((a, b) => a.localeCompare(b)), [selected]);
  const counts = useRepoPlans(names, machines, repo, machine.machine);
  const here = useMemo(() => MACHINE_BULK.map((entry) => ({ ...entry, changes: bulkHomeChanges(view, selected, entry.kind) })), [view, selected]);
  const noRepo = repo ? undefined : t('setup.skills.repo.noRepo');
  return (
    <BulkBar count={names.length} onClear={onClear}>
      <Menu>
        <MenuTrigger render={<Button variant="outline" size="sm" />}>
          <span>{tRich('setup.skills.bulk.here', { machine: <MachinePill name={machine.machine} size="sm" /> })}</span>
          <ChevronDown />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-64">
          {here.map(({ kind, key, changes }) => (
            <MenuItem key={kind} disabled={!changes.length} onClick={() => onPlan({ kind: 'machine', machine: machine.machine, changes })}>
              {t(key, { count: changes.length })}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <Button variant="destructive-outline" size="sm" disabled={!counts.remove} disabledReason={noRepo ?? (counts.remove ? undefined : t('setup.skills.bulk.nothing'))} onClick={() => onPlan({ kind: 'remove', names, first: machine.machine })}>
        {t('setup.skills.bulk.remove', { count: counts.remove })}
      </Button>
      <Button size="sm" disabled={!counts.add} disabledReason={noRepo ?? (counts.add ? undefined : t('setup.skills.bulk.nothing'))} onClick={() => onPlan({ kind: 'add', names, first: machine.machine })}>
        {t(counts.addKey, { count: counts.add })}
      </Button>
    </BulkBar>
  );
}

const PLAN_TITLE: Record<Exclude<SkillPlanKind, 'machine'>, [MessageKey, MessageKey]> = {
  add: ['setup.skills.plan.title.add.one', 'setup.skills.plan.title.add.other'],
  remove: ['setup.skills.plan.title.remove.one', 'setup.skills.plan.title.remove.other'],
  on: ['setup.skills.plan.title.on.one', 'setup.skills.plan.title.on.other'],
  off: ['setup.skills.plan.title.off.one', 'setup.skills.plan.title.off.other'],
};
/** What taking a skill off every machine does in the repo, by how the repo has it now. */
const REMOVED_TEXT: Record<RepoSkillState, MessageKey> = {
  synced: 'setup.skills.plan.removed',
  absent: 'setup.skills.plan.removedMark',
  removed: 'setup.skills.plan.removedAlready',
};
const PUT_ON_TITLE: [MessageKey, MessageKey] = ['setup.skills.plan.title.putOn.one', 'setup.skills.plan.title.putOn.other'];

const copyKey = (copy: SkillCopy) => `${copy.machine}\u0000${copy.path}`;

/** One line of a plan: the skill, what happens to it, and where. */
function PlanLine({ name, text, where, muted = false, action }: { name: string; text: ReactNode; where?: ReactNode; muted?: boolean; action?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm">
      <span className="w-44 shrink-0 truncate font-mono text-xs text-foreground" title={name}>{name}</span>
      <span className={cn('min-w-0 flex-1', muted ? 'text-muted-foreground' : 'text-foreground/85')}>{text}</span>
      {where ? <span className="max-w-52 shrink-0 truncate text-xs text-muted-foreground">{where}</span> : null}
      {action}
    </div>
  );
}

/** Where a step stands while a plan runs. */
function PhaseView({ phase }: { phase: RunPhase | null | undefined }) {
  const { t } = useI18n();
  if (!phase) return null;
  if (phase === 'running') return <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner className="size-3" />{t('setup.skills.plan.status.running')}</span>;
  if (phase === 'done') return <span className="flex items-center gap-1.5 text-xs text-success-foreground"><CircleCheck aria-hidden="true" className="size-3.5" />{t('setup.skills.plan.status.done')}</span>;
  if (phase === 'failed') return <span className="flex items-center gap-1.5 text-xs text-error-foreground"><CircleX aria-hidden="true" className="size-3.5" />{t('setup.skills.plan.status.failed')}</span>;
  return <span className="text-xs text-muted-foreground">{t('setup.skills.plan.status.waiting')}</span>;
}

/**
 * A change to skills looked over before it's made: what the repo gets, and machine by machine what its store and
 * homes get, or why they're left alone. It runs here, each step as it goes; once it all worked it closes, and the
 * toast it leaves can undo it.
 */
function SkillPlanDialog({ request, machines, repo, homeLabel, onClose, onDone }: {
  request: PlanRequest | null;
  machines: SetupMachine[];
  repo: SetupRepo | null;
  homeLabel: (key: string) => string;
  onClose: () => void;
  onDone: (done: SkillRunDone) => void;
}) {
  const { t, tRich } = useI18n();
  const [chosen, setChosen] = useState<Record<string, SkillCopy>>({});
  const [progress, setProgress] = useState<SkillRunProgress | null>(null);
  const [done, setDone] = useState<SkillRunDone | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  // Fixed once it runs, so machines being read again as it goes don't change what's shown.
  const [frozen, setFrozen] = useState<SkillPlan | null>(null);

  useEffect(() => {
    setChosen({});
    setProgress(null);
    setDone(null);
    setFrozen(null);
    setUndoError(null);
  }, [request]);

  const live = useMemo(() => {
    if (!request) return null;
    if (request.kind === 'machine') return machinePlan(request.machine, request.changes);
    return planSkills(request.kind, request.names, machines, repo, request.first, chosen);
  }, [request, machines, repo, chosen]);
  const plan = frozen ?? live;
  const running = progress !== null && done === null;
  const size = plan ? planSize(plan) : { commits: 0, machines: 0, changes: 0 };
  const nothing = size.commits + size.changes === 0;

  const run = async () => {
    if (!plan) return;
    setFrozen(plan);
    const keys = planKeys(plan);
    startActivity(keys);
    let touched: string[] = [];
    try {
      const result = await runSkillPlan(plan, repo, setProgress);
      touched = result.touched;
      if (runSucceeded(result)) onDone(result);
      else setDone(result);
    } catch (error) {
      setDone({ kind: plan.kind, names: plan.names, repo: repo?.path ?? null, repoSteps: [], backups: [], problems: {}, repoError: String(error), touched: [] });
    } finally {
      endActivity(keys, touched);
    }
  };

  const undoPartial = async () => {
    if (!done) return;
    setUndoing(true);
    setUndoError(null);
    try {
      const problems = await undoSkillRun(done);
      if (undoSucceeded(problems)) {
        toast({ kind: 'success', title: t('setup.skills.done.undone') });
        onClose();
      } else setUndoError(t('setup.skills.done.undoFailed', { error: undoProblemText(problems, t) }));
    } finally {
      setUndoing(false);
    }
  };

  // An add that commits nothing reads as putting the skills on, which is all it does.
  const putting = plan ? putsOnly(plan) : false;
  // The skills it changes, as the bulk bar's button counted them; a ticked skill with nothing to do isn't one.
  const touched = plan ? touchedSkills(plan) : [];
  const titled = touched.length ? touched : plan?.names ?? [];
  const title = !plan || !request ? null : request.kind === 'machine'
    ? tRich('setup.skills.review.title', { machine: <MachinePill name={request.machine} size="lg" /> })
    : t((putting ? PUT_ON_TITLE : PLAN_TITLE[request.kind])[titled.length === 1 ? 0 : 1], { name: titled[0] ?? '', count: titled.length });
  const runKey: MessageKey = putting ? 'setup.skills.plan.run.putOn'
    : plan?.kind === 'add' ? 'setup.skills.plan.run.add'
    : plan?.kind === 'remove' ? 'setup.skills.plan.run.remove'
      : plan?.kind === 'on' ? 'setup.skills.plan.run.on'
        : plan?.kind === 'off' ? 'setup.skills.plan.run.off' : 'setup.skills.plan.run.machine';
  const changes = t(size.changes === 1 ? 'setup.skills.plan.changes.one' : 'setup.skills.plan.changes.other', { count: size.changes });
  const anythingDone = Boolean(done && (done.backups.length || done.repoSteps.length));

  return (
    <Dialog open={request !== null} onOpenChange={(isOpen) => { if (!isOpen && !running && !undoing) onClose(); }}>
      <DialogPopup className="max-w-3xl">
        {plan && request ? (
          <>
            <DialogHeader>
              <DialogTitle className="pe-8">{title}</DialogTitle>
              <DialogDescription>
                {request.kind === 'machine'
                  ? tRich('setup.skills.plan.description.machine', { machine: <MachinePill name={request.machine} /> })
                  : t(putting ? 'setup.skills.plan.description.putOn' : `setup.skills.plan.description.${request.kind}`)}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-4">
              {plan.kind === 'add' || plan.kind === 'remove' ? (
                <section className="flex flex-col gap-1.5">
                  <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <FolderGit2 aria-hidden="true" className="size-3.5" />
                    {t('setup.skills.plan.repo')}
                    <span className="ms-auto"><PhaseView phase={progress?.repo} /></span>
                  </h3>
                  <div className="overflow-hidden rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
                    {plan.names.map((name) => {
                      if (plan.kind === 'remove') {
                        const state = repo ? repoSkillState(repo, name) : 'absent';
                        return <PlanLine key={name} name={name} text={t(REMOVED_TEXT[state])} muted={state === 'removed'} />;
                      }
                      if (plan.putBack.includes(name)) return <PlanLine key={name} name={name} text={t('setup.skills.plan.putBack')} />;
                      const take = plan.takes.find((entry) => entry.name === name);
                      if (!take) return <PlanLine key={name} name={name} text={t('setup.skills.plan.inRepo')} muted />;
                      const copies = plan.copies[name] ?? [];
                      const where = (copy: SkillCopy) => (copy.agent ? homeLabel(homeKey({ agent: copy.agent, path: copy.home })) : t('setup.skills.column.store'));
                      return (
                        <PlanLine
                          key={name}
                          name={name}
                          text={tRich('setup.skills.plan.take', { machine: <MachinePill name={take.machine} size="sm" />, where: where(take) })}
                          action={copies.length > 1 ? (
                            <Menu>
                              <MenuTrigger render={<Button variant="ghost-muted" size="xs" disabled={running} />}>
                                {t('setup.skills.plan.copies', { count: copies.length })}
                                <ChevronDown />
                              </MenuTrigger>
                              <MenuPopup align="end" className="min-w-64">
                                <MenuRadioGroup
                                  value={copyKey(take)}
                                  onValueChange={(value: string) => {
                                    const copy = copies.find((entry) => copyKey(entry) === value);
                                    if (copy) setChosen((current) => ({ ...current, [name]: copy }));
                                  }}
                                >
                                  {copies.map((copy) => (
                                    <MenuRadioItem key={copyKey(copy)} value={copyKey(copy)} closeOnClick>
                                      <span>{tRich('setup.skills.plan.copy', { machine: <MachinePill name={copy.machine} size="sm" />, where: where(copy) })}</span>
                                    </MenuRadioItem>
                                  ))}
                                </MenuRadioGroup>
                              </MenuPopup>
                            </Menu>
                          ) : undefined}
                        />
                      );
                    })}
                  </div>
                  {progress?.repoError ? <p className="text-xs text-error-foreground" role="alert">{t('setup.skills.plan.repoFailed', { error: progress.repoError })}</p> : null}
                </section>
              ) : null}
              {plan.machines.map((entry) => {
                const state = progress?.machines[entry.machine];
                const lines = entry.storeIn.length + entry.storeOut.length + entry.homes.length;
                return (
                  <section key={entry.machine} className="flex flex-col gap-1.5">
                    <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                      <MachinePill name={entry.machine} size="sm" />
                      <span className="font-normal">{t(lines === 1 ? 'setup.skills.plan.changes.one' : 'setup.skills.plan.changes.other', { count: lines })}</span>
                      <span className="ms-auto"><PhaseView phase={state?.phase} /></span>
                    </h3>
                    <div className="overflow-hidden rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
                      {entry.storeIn.map((name) => <PlanLine key={`in:${name}`} name={name} text={t('setup.skills.plan.storeIn')} where={t('setup.skills.column.store')} />)}
                      {entry.homes.map((change) => (
                        <PlanLine key={`${change.cell.home.path}:${change.row.name}`} name={change.row.name} text={changeText(change, t)} where={homeLabel(homeKey(change.cell.home))} />
                      ))}
                      {entry.storeOut.map((name) => <PlanLine key={`out:${name}`} name={name} text={t('setup.skills.plan.storeOut')} where={t('setup.skills.column.store')} />)}
                      {entry.kept.map((kept: Kept) => (
                        <PlanLine
                          key={`kept:${kept.home ?? ''}:${kept.name}`}
                          name={kept.name}
                          text={t(`setup.skills.plan.kept.${kept.reason}`)}
                          where={kept.agent && kept.home ? homeLabel(homeKey({ agent: kept.agent, path: kept.home })) : kept.home ? t('setup.skills.column.store') : undefined}
                          muted
                        />
                      ))}
                    </div>
                    {state?.problem ? <p className="text-xs text-error-foreground" role="alert">{problemText(state.problem, t)}</p> : null}
                  </section>
                );
              })}
              {plan.uncopied.length ? <p className="text-xs text-muted-foreground">{t('setup.skills.plan.uncopied', { names: plan.uncopied.join(', ') })}</p> : null}
              {nothing ? <p className="text-sm text-muted-foreground">{t('setup.skills.plan.nothing')}</p> : null}
            </DialogPanel>
            <DialogFooter>
              {done ? (
                <>
                  <p className="me-auto max-w-xl text-sm text-error-foreground" role="status">{undoError ?? t('setup.skills.plan.partly')}</p>
                  <Button variant="outline" disabled={undoing} onClick={onClose}>{t('common.close')}</Button>
                  {anythingDone ? (
                    <Button variant="destructive" disabled={undoing} onClick={() => void undoPartial()}>
                      {undoing ? <Spinner /> : null}
                      {t('setup.skills.plan.undoDone')}
                    </Button>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="me-auto text-xs text-muted-foreground">
                    {nothing ? null : t(size.machines === 1 ? 'setup.skills.plan.across.one' : 'setup.skills.plan.across.other', { changes, count: size.machines })}
                  </p>
                  <Button variant="outline" disabled={running} onClick={onClose}>{t('common.cancel')}</Button>
                  <Button variant={plan.kind === 'remove' ? 'destructive' : 'default'} disabled={running || nothing} onClick={() => void run()}>
                    {running ? <Spinner /> : null}
                    {running ? t('setup.skills.plan.working') : t(runKey)}
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

/**
 * A machine's chosen skill changes reviewed together and made in one go: what Sync › Machines' checklist hands over
 * to bring a machine in line.
 */
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

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, CircleCheck, FolderGit2, Layers, RotateCcw } from '../components/ui/icons';
import { StatusDot } from '../components/ui/status-dot';
import { useConfirmation } from '../components/ConfirmationDialog';
import { ChangesHeader, FileChanges as FileChangesView, type CopyLabels } from '../components/FileChanges';
import { SettingsSection } from '../components/layout/settings';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { errorWords, plainError } from '../services/plainError';
import { Checkbox } from '../components/ui/checkbox';
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '../components/ui/menu';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../components/ui/collapsible';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../components/ui/dialog';
import { Spinner } from '../components/ui/spinner';
import { MiddleTruncate } from '../components/ui/middle-truncate';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import { formatAgo, formatDateTime } from '../lib/format';
import type { FileView } from '../services/fileView';
import { readSetupSkill, readSetupText } from '../services/setupInventory';
import {
  fileWanted,
  removableKind,
  setSetupFileMachine,
  setSetupSkillMachine,
  skillName,
  skillWanted,
  applySetupSync,
  changeable,
  chosen,
  getSetupRepo,
  isChecksum,
  nothingToApply,
  listSetupBackups,
  pullSetupRepo,
  pushSetupRepo,
  readSetupRepoFile,
  readSetupRepoSkill,
  scanned,
  startSetupRepo,
  storedSetupRepo,
  storeSetupRepo,
  syncChanges,
  syncCounts,
  syncPlan,
  takeSetupFile,
  takeSetupSkills,
  tally,
  undoSetupSync,
  type SyncChoices,
  type SyncFile,
  type SyncState,
} from '../services/setupSync';
import { SkillFilesDiff } from './SetupCompare';
import type {
  SkillWanted,
  ChangeKind,
  SetupBackup,
  SetupMachine,
  SetupRepo,
  SetupSkillFile,
  SyncOutcome,
} from '../native/types';
import { MachinePill } from '../components/identity/Identity';
import { heldPaths, reloadSyncStanding, standingOf, standingWords, useSyncStanding } from '../services/syncStanding';
import { keeperLine, SETUP_REPO_UPDATED_EVENT, useRepoKeeper } from '../services/setupRepoKeeper';
import { listen } from '@tauri-apps/api/event';
import { RepoBrowser } from './SetupRepoBrowser';

type Translate = ReturnType<typeof useI18n>['t'];
type TranslateRich = ReturnType<typeof useI18n>['tRich'];
type Plan = { machine: SetupMachine; files: SyncFile[] };

const short = (sha: string) => sha.slice(0, 7);

/** "2 files and 1 skill". */
export function countText(counts: { files: number; skills: number }, t: Translate): string {
  const files = t(counts.files === 1 ? 'setup.sync.count.files.one' : 'setup.sync.count.files.other', { count: counts.files });
  if (!counts.skills) return files;
  const skills = t(counts.skills === 1 ? 'setup.sync.count.skills.one' : 'setup.sync.count.skills.other', { count: counts.skills });
  return counts.files ? t('setup.sync.count.both', { files, skills }) : skills;
}

/** How many of the paths are files and how many skills, in words. */
const thingsText = (paths: string[], t: Translate) => countText(tally(paths), t);

/** What a change did, in a sentence (the machine as its pill): done, refused because something changed, or partly done. */
export function outcomeText(outcome: SyncOutcome, machine: string, t: Translate, tRich: TranslateRich): { ok: boolean; text: ReactNode } {
  const changed = outcome.failed.filter((failure) => failure.reason === 'changed').map((failure) => failure.path);
  const failed = outcome.failed.filter((failure) => failure.reason === 'failed').map((failure) => failure.path);
  // A clean-up's folders deleted for good since, which Undo can't bring back.
  const deleted = outcome.failed.filter((failure) => failure.reason === 'deleted').map((failure) => failure.path);
  const pill = <MachinePill name={machine} />;
  if (changed.length) return { ok: false, text: tRich('setup.sync.outcome.changed', { machine: pill, files: changed.join(', ') }) };
  if (failed.length) return { ok: false, text: t('setup.sync.outcome.failed', { done: outcome.done.length, files: failed.join(', ') }) };
  if (deleted.length) return { ok: outcome.done.length > 0, text: tRich('setup.sync.outcome.deleted', { things: thingsText(outcome.done, t), machine: pill, files: deleted.join(', ') }) };
  return { ok: true, text: tRich('setup.sync.outcome.done', { things: thingsText(outcome.done, t), machine: pill }) };
}

/** What a machine's review would change there, in a few words. */
function reviewText(plan: Plan, t: Translate): string {
  const counts = syncCounts(plan.files);
  return [
    counts.update ? t('setup.repo.machine.update', { count: counts.update }) : null,
    counts.add ? t('setup.repo.machine.add', { count: counts.add }) : null,
    counts.removed ? t('setup.repo.machine.removed', { count: counts.removed }) : null,
  ].filter(Boolean).join(' · ');
}

type Bulk = { running: boolean; results: { machine: string; ok: boolean; text: ReactNode }[] };

/**
 * The setup repo: a git repo on this Mac whose CLAUDE.md, AGENTS.md, rules, subagents, commands and skills
 * each machine is brought in step with, one machine first, after its changes have been reviewed.
 */
export function SetupRepoSection({ machines, history = null }: {
  machines: SetupMachine[];
  /** Opens the browser on History, narrowed to a machine's changes when one is named. */
  history?: { machine: string | null } | null;
}) {
  const { t, tRich } = useI18n();
  const { standing: standingNow } = useSyncStanding();
  const { askConfirmation } = useConfirmation();
  const [path, setPath] = useState<string | null>(storedSetupRepo);
  const [repo, setRepo] = useState<SetupRepo | null>(null);
  /** Why the repo can't be read. */
  const [error, setError] = useState<string | null>(null);
  /** Why starting, pulling or pushing didn't work, which leaves the repo as it was. */
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<'load' | 'start' | 'pull' | 'push' | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [reviewFocus, setReviewFocus] = useState<string | null>(null);
  /** The first machine brought in step with a commit this time, which lets the rest follow. */
  const [first, setFirst] = useState<{ machine: string; commit: string } | null>(null);
  const [bulk, setBulk] = useState<Bulk | null>(null);

  const load = useCallback(async (folder: string, quiet = false) => {
    if (!quiet) setBusy('load');
    try {
      setRepo(await getSetupRepo(folder));
      setError(null);
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      if (!quiet) setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (!path) return undefined;
    void load(path);
    // The repo is edited outside Arbor, so it's read again whenever Arbor comes back to the front, and so is where the
    // machines stand against it.
    const again = () => {
      void load(path, true);
      reloadSyncStanding();
    };
    window.addEventListener('focus', again);
    // The keeper fast-forwarded it: what's in it now is new.
    const pulled = listen(SETUP_REPO_UPDATED_EVENT, again);
    return () => {
      window.removeEventListener('focus', again);
      void pulled.then((off) => off()).catch(() => undefined);
    };
  }, [path, load]);

  const plans = useMemo<Plan[]>(
    () => (repo?.head ? machines.filter(scanned).map((machine) => ({ machine, files: syncPlan(repo, machine) })) : []),
    [repo, machines],
  );
  const behind = repo?.head && first?.commit === repo.head.sha
    ? plans.filter((plan) => plan.machine.machine !== first.machine && !nothingToApply(syncCounts(plan.files)))
    : [];

  const adoptFolder = (folder: string, found: SetupRepo | null = null) => {
    setPath(folder);
    storeSetupRepo(folder);
    setRepo(found);
    setError(null);
    setProblem(null);
    setFirst(null);
    setBulk(null);
    // The same folder again doesn't change the path, so the effect that reads it won't run: read it here.
    if (!found && folder === path) void load(folder);
  };
  const choose = async () => {
    const folder = await open({ directory: true, multiple: false, title: t('setup.repo.chooseTitle') });
    if (typeof folder === 'string') adoptFolder(folder);
  };
  const start = async () => {
    const folder = await open({ directory: true, multiple: false, title: t('setup.repo.startTitle') });
    if (typeof folder !== 'string') return;
    const confirmed = await askConfirmation({
      title: t('setup.repo.startConfirm.title'),
      message: t('setup.repo.startConfirm.message', { folder }),
      confirmText: t('setup.repo.startConfirm.confirm'),
    });
    if (!confirmed) return;
    setBusy('start');
    setProblem(null);
    try {
      adoptFolder(folder, await startSetupRepo(folder));
    } catch (startError) {
      setProblem(t('setup.repo.startFailed', { error: String(startError) }));
    } finally {
      setBusy(null);
    }
  };
  const forget = () => {
    setPath(null);
    storeSetupRepo(null);
    setRepo(null);
    setError(null);
    setProblem(null);
  };
  const git = async (kind: 'pull' | 'push') => {
    if (!path) return;
    setBusy(kind);
    setProblem(null);
    try {
      setRepo(await (kind === 'pull' ? pullSetupRepo(path) : pushSetupRepo(path)));
      setError(null);
    } catch (gitError) {
      setProblem(t(kind === 'pull' ? 'setup.repo.pullFailed' : 'setup.repo.pushFailed', { error: String(gitError) }));
    } finally {
      setBusy(null);
    }
  };
  const applied = (machine: string, outcome: SyncOutcome) => {
    if (repo?.head && outcome.backup && !outcome.failed.length) setFirst((current) => current?.commit === repo.head?.sha ? current : { machine, commit: repo.head!.sha });
  };
  const bringRest = async () => {
    if (!repo?.head || !behind.length) return;
    const confirmed = await askConfirmation({
      title: t(behind.length === 1 ? 'setup.repo.rest.confirm.one' : 'setup.repo.rest.confirm.other', { count: behind.length }),
      message: t('setup.repo.rest.message', { commit: short(repo.head.sha) }),
      details: behind.map((plan) => ({ label: <MachinePill name={plan.machine.machine} size="sm" />, value: reviewText(plan, t) })),
      confirmText: t('setup.repo.rest.confirm.button'),
    });
    if (!confirmed) return;
    const results: Bulk['results'] = [];
    setBulk({ running: true, results });
    for (const plan of behind) {
      try {
        // An edit made on a machine is never overwritten by bringing the rest along.
        const outcome = await applySetupSync(repo.path, repo.head.sha, plan.machine.machine, syncChanges(plan.files, {}, heldPaths(standingNow, plan.machine.machine)));
        const result = outcomeText(outcome, plan.machine.machine, t, tRich);
        results.push({
          machine: plan.machine.machine,
          ok: result.ok,
          text: result.ok ? t('setup.repo.rest.done', { things: thingsText(outcome.done, t) }) : result.text,
        });
      } catch (applyError) {
        results.push({ machine: plan.machine.machine, ok: false, text: t('setup.sync.outcome.error', { error: String(applyError) }) });
      }
      setBulk({ running: true, results: [...results] });
    }
    setBulk({ running: false, results });
  };

  const reviewed = plans.find((plan) => plan.machine.machine === reviewing)?.machine ?? null;

  return (
    <>
      <SettingsSection
        title={t('setup.repo.title')}
        headerAction={path ? (
          <div className="flex items-center gap-1.5">
            {repo?.upstream ? (
              <>
                <Button variant="ghost-muted" size="xs" disabled={busy !== null} focusableWhenDisabled onClick={() => void git('pull')} title={t('setup.repo.pullTitle', { upstream: repo.upstream.name })}>
                  {busy === 'pull' ? <Spinner /> : <ArrowDownToLine />}
                  {t('setup.repo.pull')}
                  {repo.upstream.behind ? <Badge variant="info" size="sm">{repo.upstream.behind}</Badge> : null}
                </Button>
                {repo.upstream.ahead ? (
                  <Button variant="ghost-muted" size="xs" disabled={busy !== null} focusableWhenDisabled onClick={() => void git('push')} title={t('setup.repo.pushTitle', { upstream: repo.upstream.name })}>
                    {busy === 'push' ? <Spinner /> : <ArrowUpFromLine />}
                    {t('setup.repo.push')}
                    <Badge variant="info" size="sm">{repo.upstream.ahead}</Badge>
                  </Button>
                ) : null}
              </>
            ) : null}
            <Button variant="ghost-muted" size="icon-xs" disabled={busy !== null} focusableWhenDisabled onClick={() => void load(path)} aria-label={t('setup.repo.reload')} title={t('setup.repo.reload')}>
              <RefreshIcon refreshing={busy === 'load'} />
            </Button>
            <Button variant="ghost-muted" size="xs" disabled={busy !== null} onClick={() => void choose()}>{t('setup.repo.change')}</Button>
          </div>
        ) : undefined}
      >
        {!path ? (
          <>
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <FolderGit2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <p className="min-w-0 flex-1 text-xs leading-[1.45] text-muted-foreground">{t('setup.repo.intro')}</p>
              <div className="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void choose()}>{t('setup.repo.choose')}</Button>
                <Button size="sm" disabled={busy !== null} onClick={() => void start()}>
                  {busy === 'start' ? <Spinner /> : null}
                  {t('setup.repo.start')}
                </Button>
              </div>
            </div>
            {problem ? <p className="px-4 py-2.5 text-xs text-error-foreground" role="alert">{problem}</p> : null}
          </>
        ) : (
          <>
            <RepoSummary path={path} repo={repo} error={error} onForget={forget} />
            {problem ? <p className="px-4 py-2.5 text-xs text-error-foreground" role="alert">{problem}</p> : null}
            {repo?.head && plans.length ? <MachineStrip plans={plans} onReview={(machine) => { setReviewFocus(null); setReviewing(machine); }} /> : null}
            {repo?.head && !plans.length ? <p className="px-4 py-3 text-xs text-muted-foreground">{t('setup.repo.noMachines')}</p> : null}
            {behind.length && !bulk?.running ? (
              <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {tRich(behind.length === 1 ? 'setup.repo.rest.one' : 'setup.repo.rest.other', { machine: <MachinePill name={first?.machine} size="sm" />, count: behind.length })}
                </p>
                <Button size="sm" onClick={() => void bringRest()}>
                  {t(behind.length === 1 ? 'setup.repo.rest.button.one' : 'setup.repo.rest.button.other', { count: behind.length })}
                </Button>
              </div>
            ) : null}
            {bulk?.results.length || bulk?.running ? (
              <div className="flex flex-col gap-1 px-4 py-3 text-sm" role="status">
                {bulk.results.map((result) => (
                  <p key={result.machine} className={cn('flex min-w-0 items-center gap-2', result.ok ? 'text-muted-foreground' : 'text-error-foreground')}>
                    <MachinePill name={result.machine} className="shrink-0" />
                    <span className="min-w-0">{result.text}</span>
                  </p>
                ))}
                {bulk.running ? <p className="flex items-center gap-2 text-muted-foreground"><Spinner className="size-3.5" />{t('setup.repo.rest.running')}</p> : null}
              </div>
            ) : null}
          </>
        )}
      </SettingsSection>
      {repo?.head ? (
        <SyncReviewDialog
          repo={repo}
          machine={reviewed}
          focus={reviewFocus}
          onClose={() => setReviewing(null)}
          onApplied={applied}
          onRepo={setRepo}
        />
      ) : null}
      {repo ? (
        <RepoBrowser
          repo={repo}
          machines={machines}
          history={history}
          onRepo={setRepo}
          onReview={(machine, path) => {
            setReviewFocus(path ?? null);
            setReviewing(machine);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Whether the repo is kept in step with its remote, and when it last was, or what stopped it: the Pull and Push
 * buttons stay for the user to sort that out.
 */
function KeeperLineView() {
  const { t } = useI18n();
  const found = useRepoKeeper();
  if (!found) return null;
  const line = keeperLine(found);
  if (line.kind === 'problem') {
    return (
      <p className="text-xs text-warning-foreground" role="status" data-repo-keeper="problem" title={line.detail ?? undefined}>
        {t(line.key, { upstream: found.upstream ?? t('repoKeeper.theRemote') })}
        {line.detail ? <span className="text-muted-foreground"> {t('repoKeeper.gitSaid', { detail: line.detail })}</span> : null}
      </p>
    );
  }
  const text = line.kind === 'off' ? t('repoKeeper.off')
    : line.kind === 'noRemote' ? t('repoKeeper.noRemote')
      : line.running ? t('repoKeeper.checking', { upstream: line.upstream })
        : line.fetchedMs ? t('repoKeeper.kept', { upstream: line.upstream, time: formatAgo(line.fetchedMs) })
          : t('repoKeeper.keptNotYet', { upstream: line.upstream });
  return <p className="text-xs text-muted-foreground" data-repo-keeper={line.kind}>{text}</p>;
}

/** Where the repo is, its last commit, and what in it isn't synced. */
function RepoSummary({ path, repo, error, onForget }: { path: string; repo: SetupRepo | null; error: string | null; onForget: () => void }) {
  const { t } = useI18n();
  const now = Date.now();
  const notes: { tone: 'warning' | 'muted'; text: string }[] = [];
  if (repo && !repo.head) notes.push({ tone: 'warning', text: t('setup.repo.noCommits') });
  const blocked = repo?.skills.filter((skill) => skill.problem) ?? [];
  if (blocked.length) {
    const [only] = blocked;
    notes.push({
      tone: 'warning',
      text: blocked.length === 1 && only?.problem
        ? t('setup.repo.blocked.one', { name: only.name, reason: t(PROBLEM[only.problem]) })
        : t('setup.repo.blocked.other', { count: blocked.length, names: blocked.map((skill) => skill.name).join(', ') }),
    });
  }
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <FolderGit2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <MiddleTruncate value={path} className="font-mono text-xs text-foreground" />
        {repo ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {t('setup.repo.synced', { things: countText({ files: repo.files.length, skills: repo.skills.filter((skill) => !skill.problem).length }, t) })}
          </span>
        ) : null}
      </div>
      {repo?.head ? (
        <p className="min-w-0 truncate text-xs text-muted-foreground" title={repo.head.subject}>
          {[repo.branch, `${short(repo.head.sha)} ${repo.head.subject}`, formatAgo(repo.head.atMs, now)].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      <KeeperLineView />
      {error ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-error-foreground" role="alert">
          <span className="min-w-0 flex-1">{t('setup.repo.failed', { error })}</span>
          <Button variant="ghost-muted" size="xs" onClick={onForget}>{t('setup.repo.forget')}</Button>
        </div>
      ) : null}
      {notes.map((note) => (
        <p key={note.text} className={cn('text-xs', note.tone === 'warning' ? 'text-warning-foreground' : 'text-muted-foreground')}>{note.text}</p>
      ))}
    </div>
  );
}

/**
 * Each machine against the repo, in a line, as Sync's standing has it (every kind, not only the files this review
 * changes); a machine opens its review.
 */
function MachineStrip({ plans, onReview }: { plans: Plan[]; onReview: (machine: string) => void }) {
  const { t } = useI18n();
  const { standing } = useSyncStanding();
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
      {plans.map((plan) => {
        const found = standingOf(standing, plan.machine.machine);
        const words = found ? standingWords(found) : null;
        const summary = {
          inStep: found?.state !== 'behind',
          text: words ? [t(words.key), ...words.parts.map((part) => t(part.key, { count: part.count }))].join(' · ') : '…',
        };
        return (
          <button
            key={plan.machine.machine}
            type="button"
            className="inline-flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-background px-2 py-1 text-xs hover:bg-accent dark:bg-input/24"
            title={t('setup.repo.reviewTitle', { machine: plan.machine.machine })}
            onClick={() => onReview(plan.machine.machine)}
          >
            {plan.machine.scanning ? <Spinner className="size-3" /> : <StatusDot tone={summary.inStep ? 'success' : 'warning'} />}
            <MachinePill name={plan.machine.machine} size="sm" />
            <span className={cn('truncate', summary.inStep ? 'text-muted-foreground' : 'text-warning-foreground')}>{summary.text}</span>
          </button>
        );
      })}
    </div>
  );
}

const GROUPS: { state: SyncState; title: MessageKey }[] = [
  { state: 'update', title: 'setup.sync.group.update' },
  { state: 'add', title: 'setup.sync.group.add' },
  { state: 'removed', title: 'setup.sync.group.removed' },
  { state: 'extra', title: 'setup.sync.group.extra' },
  { state: 'blocked', title: 'setup.sync.group.blocked' },
  { state: 'linked', title: 'setup.sync.group.linked' },
  { state: 'noHome', title: 'setup.sync.group.noHome' },
  { state: 'offHere', title: 'setup.sync.group.offHere' },
  { state: 'own', title: 'setup.sync.group.own' },
];

/** Why a skill can't be synced. */
const PROBLEM: Record<NonNullable<SyncFile['problem']>, MessageKey> = {
  link: 'setup.sync.problem.link',
  name: 'setup.sync.problem.name',
  secret: 'setup.sync.problem.secret',
  large: 'setup.sync.problem.large',
  noDoc: 'setup.sync.problem.noDoc',
  notSkill: 'setup.sync.problem.notSkill',
};

/** What a file's box, ticked or not, does to it. */
const ACTION: Record<'update' | 'add' | 'extra' | 'removed', [on: MessageKey, off: MessageKey]> = {
  update: ['setup.sync.action.replace', 'setup.sync.action.keep'],
  add: ['setup.sync.action.add', 'setup.sync.action.leaveOut'],
  extra: ['setup.sync.action.remove', 'setup.sync.action.keep'],
  removed: ['setup.sync.action.remove', 'setup.sync.action.keep'],
};

/** A machine's files against the repo's, what bringing it in step would change, and the changes made before. */
export function SyncReviewDialog({ repo, machine, focus = null, onClose, onApplied, onRepo }: {
  repo: SetupRepo;
  machine: SetupMachine | null;
  /** A file to open the review on, as the repo browser's machine buttons ask for one. */
  focus?: string | null;
  onClose: () => void;
  onApplied: (machine: string, outcome: SyncOutcome) => void;
  onRepo: (repo: SetupRepo) => void;
}) {
  const { t, tRich } = useI18n();
  const [choices, setChoices] = useState<SyncChoices>({});
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  // Asked in the footer rather than over the dialog, which would take a click on it as one outside.
  const [pending, setPending] = useState<{ kind: 'apply' } | { kind: 'undo'; backup: SetupBackup } | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: ReactNode } | null>(null);
  const [backups, setBackups] = useState<SetupBackup[] | null>(null);
  const [backupsError, setBackupsError] = useState<string | null>(null);
  const name = machine?.machine ?? null;
  const pill = <MachinePill name={name} />;

  const loadBackups = useCallback(async (target: string) => {
    try {
      setBackups(await listSetupBackups(target));
      setBackupsError(null);
    } catch (error) {
      setBackupsError(String(error));
    }
  }, []);

  useEffect(() => {
    setChoices({});
    setShown(new Set(focus ? [focus] : []));
    setNotice(null);
    setPending(null);
    setBackups(null);
    setBackupsError(null);
    if (name) void loadBackups(name);
  }, [name, focus, loadBackups]);

  const files = useMemo(() => (machine ? syncPlan(repo, machine) : []), [repo, machine]);
  // What was edited on the machine stays unticked unless someone ticks it.
  const { standing } = useSyncStanding();
  const held = useMemo(() => heldPaths(standing, name ?? ''), [standing, name]);
  const changes = syncChanges(files, choices, held);
  // Until the machine has been read again after a change, what it has isn't known.
  const reading = machine?.scanning === true;
  const same = files.filter((file) => file.state === 'same').map((file) => file.path);
  const head = repo.head;

  const toggle = (path: string) => setShown((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  const apply = async () => {
    setPending(null);
    if (!machine || !head || !changes.length) return;
    setBusy('apply');
    setNotice(null);
    try {
      const outcome = await applySetupSync(repo.path, head.sha, machine.machine, changes);
      setNotice(outcomeText(outcome, machine.machine, t, tRich));
      setChoices({});
      onApplied(machine.machine, outcome);
      void loadBackups(machine.machine);
    } catch (error) {
      setNotice({ ok: false, text: t('setup.sync.outcome.error', { error: String(error) }) });
    } finally {
      setBusy(null);
    }
  };

  // A skill kept off this machine, or its own copy kept, is recorded in the repo for every Arbor that reads it.
  const want = async (file: SyncFile, wanted: SkillWanted | null) => {
    if (!machine) return;
    setBusy(file.path);
    setNotice(null);
    try {
      onRepo(await (file.kind === 'skill'
        ? setSetupSkillMachine(repo.path, skillName(file.path), machine.machine, wanted)
        : setSetupFileMachine(repo.path, file.path, machine.machine, wanted)));
      setChoices((current) => {
        const next = { ...current };
        delete next[file.path];
        return next;
      });
    } catch (error) {
      setNotice({ ok: false, text: String(error) });
    } finally {
      setBusy(null);
    }
  };

  const take = async (file: SyncFile) => {
    if (!machine) return;
    setBusy(file.path);
    setNotice(null);
    try {
      onRepo(await (file.kind === 'skill' ? takeSetupSkills(repo.path, machine.machine, [file.path]) : takeSetupFile(repo.path, machine.machine, file.path)));
      setNotice({ ok: true, text: tRich('setup.sync.taken', { path: file.path, machine: pill }) });
    } catch (error) {
      setNotice({ ok: false, text: t('setup.sync.takeFailed', { error: String(error) }) });
    } finally {
      setBusy(null);
    }
  };

  /** Every skill only the machine has, in one commit. */
  const takeAll = async (paths: string[]) => {
    if (!machine) return;
    setBusy('takeAll');
    setNotice(null);
    try {
      onRepo(await takeSetupSkills(repo.path, machine.machine, paths));
      setNotice({ ok: true, text: tRich('setup.sync.takenAll', { count: paths.length, machine: pill }) });
    } catch (error) {
      setNotice({ ok: false, text: t('setup.sync.takeFailed', { error: String(error) }) });
    } finally {
      setBusy(null);
    }
  };

  const undo = async (backup: SetupBackup) => {
    setPending(null);
    if (!machine) return;
    setBusy(backup.id);
    setNotice(null);
    try {
      const outcome = await undoSetupSync(machine.machine, backup.id);
      const result = outcomeText(outcome, machine.machine, t, tRich);
      setNotice(result.ok ? { ok: true, text: tRich('setup.sync.undone', { machine: pill }) } : result);
      void loadBackups(machine.machine);
    } catch (error) {
      setNotice({ ok: false, text: t('setup.sync.outcome.error', { error: String(error) }) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={machine !== null} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogPopup className="max-w-4xl">
        {machine && head ? (
          <>
            <DialogHeader>
              <DialogTitle className="pe-8">{tRich('setup.sync.title', { machine: <MachinePill name={machine.machine} size="lg" /> })}</DialogTitle>
              <DialogDescription>
                {tRich('setup.sync.description', {
                  commit: `${short(head.sha)} ${head.subject}`,
                  machine: pill,
                  time: machine.scannedAt !== null ? formatAgo(machine.scannedAt, Date.now()) : t('setup.sync.notRead'),
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-4">
              {GROUPS.map(({ state, title }) => {
                const group = files.filter((file) => file.state === state);
                if (!group.length) return null;
                const skillsOnly = state === 'extra' ? group.filter((file) => file.kind === 'skill').map((file) => file.path) : [];
                return (
                  <section key={state} className="flex flex-col gap-1.5">
                    <div className="flex min-h-6 items-center gap-3">
                      <h3 className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
                        {tRich(title, { machine: <MachinePill name={machine.machine} size="sm" /> })}
                      </h3>
                      {skillsOnly.length > 1 ? (
                        <Button
                          variant="ghost-muted"
                          size="xs"
                          disabled={busy !== null || pending !== null}
                          onClick={() => void takeAll(skillsOnly)}
                          title={t('setup.sync.takeAllTitle', { machine: machine.machine })}
                        >
                          {busy === 'takeAll' ? <Spinner /> : null}
                          {t('setup.sync.takeAll', { count: skillsOnly.length })}
                        </Button>
                      ) : null}
                    </div>
                    <div className="overflow-hidden rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
                      {group.map((file) => (
                        <SyncFileRow
                          key={file.path}
                          repo={repo}
                          machine={machine.machine}
                          file={file}
                          on={chosen(file, choices, held)}
                          edited={held.has(file.path)}
                          open={shown.has(file.path)}
                          busy={busy !== null || pending !== null}
                          taking={busy === file.path}
                          onChoose={(on) => setChoices((current) => ({ ...current, [file.path]: on }))}
                          onToggle={() => toggle(file.path)}
                          onTake={() => void take(file)}
                          wanted={file.kind === 'skill' && file.skill
                            ? skillWanted(repo, file.path, machine.machine) ?? null
                            : file.kind !== 'skill' && file.repo && removableKind(file.kind) ? fileWanted(repo, file.path, machine.machine) ?? null : undefined}
                          onWanted={(wanted) => void want(file, wanted)}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
              {same.length ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <CircleCheck aria-hidden="true" className="size-3.5 text-success-foreground" />
                  {t(same.length === 1 ? 'setup.sync.same.one' : 'setup.sync.same.other', { things: thingsText(same, t) })}
                </p>
              ) : null}
              <BackupList
                machine={machine.machine}
                backups={backups}
                error={backupsError}
                busy={busy !== null || pending !== null}
                undoing={busy}
                onUndo={(backup) => setPending({ kind: 'undo', backup })}
              />
            </DialogPanel>
            <DialogFooter>
              {pending?.kind === 'apply' ? (
                <>
                  <p className="me-auto max-w-xl text-sm text-foreground" role="status">
                    {tRich(changes.length === 1 ? 'setup.sync.confirm.one' : 'setup.sync.confirm.other', {
                      things: thingsText(changes.map((change) => change.path), t),
                      machine: pill,
                    })}
                  </p>
                  <Button variant="outline" onClick={() => setPending(null)}>{t('setup.sync.back')}</Button>
                  <Button variant={changes.some((change) => change.remove) ? 'destructive' : 'default'} onClick={() => void apply()}>
                    {/* One run of text, so the button's gap doesn't pull the words and the pill apart. */}
                    <span>{tRich('setup.sync.confirm.apply', { machine: pill })}</span>
                  </Button>
                </>
              ) : pending?.kind === 'undo' ? (
                <>
                  <p className="me-auto max-w-xl text-sm text-foreground" role="status">{undoMessage(pending.backup, t)}</p>
                  <Button variant="outline" onClick={() => setPending(null)}>{t('setup.sync.back')}</Button>
                  <Button variant="destructive" onClick={() => void undo(pending.backup)}>{t('setup.sync.history.undo')}</Button>
                </>
              ) : (
                <>
                  {notice ? (
                    <p className={cn('me-auto max-w-xl text-sm', notice.ok ? 'text-muted-foreground' : 'text-error-foreground')} role="status">{notice.text}</p>
                  ) : null}
                  <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
                  <Button disabled={!changes.length || busy !== null || reading} onClick={() => setPending({ kind: 'apply' })}>
                    {busy === 'apply' ? <Spinner /> : null}
                    {changes.length ? t('setup.sync.apply', { things: thingsText(changes.map((change) => change.path), t) }) : t('setup.sync.apply.none')}
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
 * A repo skill's value on this machine: following All machines, kept off the machine, or the machine's own copy
 * kept. Tinted while the machine has a value of its own.
 */
function SkillWantedMenu({ path, machine, wanted, busy, onWanted }: {
  path: string;
  machine: string;
  wanted: SkillWanted | null;
  busy: boolean;
  onWanted: (wanted: SkillWanted | null) => void;
}) {
  const { t, tRich } = useI18n();
  // The button's small print takes the small pill; the menu's lines take the usual one.
  const label = wanted === 'off'
    ? tRich('setup.sync.wanted.off', { machine: <MachinePill name={machine} size="sm" /> })
    : wanted === 'own' ? tRich('setup.sync.wanted.ownShort', { machine: <MachinePill name={machine} size="sm" /> }) : t('setup.sync.wanted.all');
  const pill = <MachinePill name={machine} />;
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost-muted" size="xs" disabled={busy} aria-label={t('setup.sync.wanted.aria', { path, machine })} />}
        className={cn('max-w-56', wanted && 'text-primary')}
      >
        <Layers className={cn(wanted && 'text-primary')} />
        <span className="truncate">{label}</span>
        <ChevronDown />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-60">
        <MenuRadioGroup value={wanted ?? 'all'} onValueChange={(value: string) => onWanted(value === 'all' ? null : (value as SkillWanted))}>
          <MenuRadioItem value="all" closeOnClick>{t('setup.sync.wanted.all')}</MenuRadioItem>
          <MenuRadioItem value="off" closeOnClick><span>{tRich('setup.sync.wanted.off', { machine: pill })}</span></MenuRadioItem>
          <MenuRadioItem value="own" closeOnClick><span>{tRich('setup.sync.wanted.own', { machine: pill })}</span></MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function SyncFileRow({ repo, machine, file, on, open: isOpen, busy, taking, onChoose, onToggle, onTake, wanted, onWanted, edited = false }: {
  repo: SetupRepo;
  machine: string;
  file: SyncFile;
  on: boolean;
  open: boolean;
  busy: boolean;
  taking: boolean;
  onChoose: (on: boolean) => void;
  onToggle: () => void;
  onTake: () => void;
  /** A repo skill's own value on this machine, null while it follows every machine's; undefined for anything else. */
  wanted?: SkillWanted | null;
  onWanted?: (wanted: SkillWanted | null) => void;
  /** Edited on the machine since it last matched the repo, so it's left unticked. */
  edited?: boolean;
}) {
  const { t, tRich } = useI18n();
  const skill = file.kind === 'skill';
  const canChange = changeable(file);
  // A skill is compared file by file, and a file line by line when it's text.
  const readable = canChange && (skill || file.item === null || file.item.text);
  const action = file.state === 'update' || file.state === 'add' || file.state === 'extra' || file.state === 'removed' ? ACTION[file.state][on ? 0 : 1] : null;
  const note: MessageKey | null = file.state === 'linked'
    ? 'setup.sync.linked'
    : file.state === 'noHome'
      ? file.path.startsWith('~/.codex/') ? 'setup.sync.noHome.codex' : 'setup.sync.noHome.claude'
      : file.state === 'blocked' && file.problem
        ? PROBLEM[file.problem]
        : file.state === 'offHere'
          ? file.item ? 'setup.sync.offHere.present' : 'setup.sync.offHere.absent'
          : file.state === 'own'
            ? 'setup.sync.own.note'
            : null;
  const link = file.item?.link ?? '';
  const pill = <MachinePill name={machine} size="sm" />;
  return (
    <Collapsible className="flex flex-col" open={isOpen} onOpenChange={onToggle}>
      <div className="flex min-w-0 items-center gap-3 px-3 py-2">
        {canChange ? (
          <Checkbox checked={on} disabled={busy} onCheckedChange={(checked) => onChoose(checked === true)} aria-label={t('setup.sync.include', { path: file.path })} />
        ) : null}
        {readable ? (
          <CollapsibleTrigger
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={t(isOpen ? 'setup.sync.hideChanges' : 'setup.sync.showChanges')}
          >
            <MiddleTruncate value={file.path} className="font-mono text-xs text-foreground" />
          </CollapsibleTrigger>
        ) : (
          <MiddleTruncate value={file.path} className="flex-1 font-mono text-xs text-foreground" />
        )}
        {edited ? <Badge variant="info" size="sm" data-sync-edited={file.path}>{t('sync.change.editedHere')}</Badge> : null}
        {/* The title has the note's words in full for when it's cut short, so it names the machine in words. */}
        {note ? <span className="min-w-0 shrink truncate text-xs text-muted-foreground" title={t(note, { link, machine })}>{tRich(note, { link, machine: pill })}</span> : null}
        {action ? <span className={cn('shrink-0 text-xs', on ? 'text-foreground' : 'text-muted-foreground')}>{tRich(action, { machine: pill })}</span> : null}
        {wanted !== undefined && onWanted ? <SkillWantedMenu path={file.path} machine={machine} wanted={wanted} busy={busy} onWanted={onWanted} /> : null}
        {(file.state === 'update' || file.state === 'extra') && (skill || file.item?.text) ? (
          <Button variant="ghost-muted" size="xs" disabled={busy} focusableWhenDisabled onClick={onTake} title={t('setup.sync.takeTitle', { machine })}>
            {taking ? <Spinner /> : null}
            {t('setup.sync.take', { machine })}
          </Button>
        ) : null}
      </div>
      {readable ? (
        <CollapsiblePanel>
          {skill ? <SkillChanges repo={repo} machine={machine} file={file} /> : <FileChanges repo={repo} machine={machine} file={file} />}
        </CollapsiblePanel>
      ) : null}
    </Collapsible>
  );
}

type Sides = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ready'; machine: string | null; repo: string | null };

/** The machine's copy against the repo's, read when it's opened. */
function FileChanges({ repo, machine, file }: { repo: SetupRepo; machine: string; file: SyncFile }) {
  const { t } = useI18n();
  const [sides, setSides] = useState<Sides>({ state: 'loading' });
  const commit = repo.head?.sha ?? '';
  useEffect(() => {
    let current = true;
    setSides({ state: 'loading' });
    const theirs = file.item?.path ? readSetupText(machine, file.item.path) : Promise.resolve(null);
    const ours = file.repo ? readSetupRepoFile(repo.path, commit, file.path) : Promise.resolve(null);
    Promise.all([theirs, ours])
      .then(([machineText, repoText]) => {
        if (!current) return;
        const tooLarge = [machineText, repoText].find((text) => text && text.content === null);
        if (tooLarge) setSides({ state: 'error', error: t('setup.sync.tooLarge') });
        else setSides({ state: 'ready', machine: machineText?.content ?? null, repo: repoText?.content ?? null });
      })
      .catch((error) => { if (current) setSides({ state: 'error', error: String(error) }); });
    return () => { current = false; };
  }, [repo.path, commit, machine, file.path, file.item?.path, file.repo, t]);
  return (
    <div className="flex flex-col gap-2 border-t border-border/50 bg-muted/20 px-3 py-2.5 dark:bg-input/8">
      {sides.state === 'loading' ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5" />{t('setup.compare.loading')}</p>
      ) : sides.state === 'error' ? (
        <p className="text-xs text-error-foreground">{sides.error}</p>
      ) : (
        <FileSidesDiff machine={machine} path={file.path} before={sides.machine} after={sides.repo} />
      )}
    </div>
  );
}

/** The two copies of a file, and for an agent's markdown, the choice of seeing them rendered. */
function FileSidesDiff({ machine, path, before, after }: { machine: string; path: string; before: string | null; after: string | null }) {
  const { t, tRich } = useI18n();
  const [view, setView] = useState<FileView>('source');
  const labels = syncLabels(machine, before !== null, after !== null, t, tRich);
  return (
    <>
      <ChangesHeader {...labels} path={path} view={view} onView={setView} />
      <FileChangesView path={path} before={before} after={after} labels={labels} view={view} />
    </>
  );
}

/** What the machine's copy and the repo's are called over them, or that one hasn't it. */
const syncLabels = (machine: string, onMachine: boolean, inRepo: boolean, t: Translate, tRich: TranslateRich): CopyLabels => {
  const pill = <MachinePill name={machine} size="sm" />;
  return {
    before: onMachine ? pill : tRich('setup.compare.notOn', { machine: pill }),
    after: inRepo ? t('setup.sync.theRepo') : t('setup.sync.notInRepo'),
  };
};

type SkillSides = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ready'; machine: SetupSkillFile[] | null; repo: SetupSkillFile[] | null };

/** The machine's copy of a skill against the repo's, file by file, read when it's opened. */
function SkillChanges({ repo, machine, file }: { repo: SetupRepo; machine: string; file: SyncFile }) {
  const { t } = useI18n();
  const [sides, setSides] = useState<SkillSides>({ state: 'loading' });
  const commit = repo.head?.sha ?? '';
  const name = file.skill?.name ?? null;
  const theirPath = file.item?.path ?? null;
  // A machine without a SHA-256 tool fingerprints each file by its checksum, so the repo's are given that way too.
  const ck = file.item?.sum ? isChecksum(file.item.sum) : false;
  useEffect(() => {
    let current = true;
    setSides({ state: 'loading' });
    const theirs = theirPath ? readSetupSkill(machine, theirPath) : Promise.resolve(null);
    const ours = name ? readSetupRepoSkill(repo.path, commit, name, ck) : Promise.resolve(null);
    Promise.all([theirs, ours])
      .then(([machineFiles, repoFiles]) => { if (current) setSides({ state: 'ready', machine: machineFiles, repo: repoFiles }); })
      .catch((error) => { if (current) setSides({ state: 'error', error: String(error) }); });
    return () => { current = false; };
  }, [repo.path, commit, machine, name, theirPath, ck]);
  return (
    <div className="flex flex-col gap-2 border-t border-border/50 bg-muted/20 px-3 py-2.5 dark:bg-input/8">
      {sides.state === 'loading' ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5" />{t('setup.compare.loading')}</p>
      ) : sides.state === 'error' ? (
        <p className="text-xs text-error-foreground">{sides.error}</p>
      ) : (
        <SkillSidesDiff machine={machine} before={sides.machine} after={sides.repo} />
      )}
    </div>
  );
}

/** The two copies of a skill, with a header saying which is which. */
function SkillSidesDiff({ machine, before, after }: { machine: string; before: SetupSkillFile[] | null; after: SetupSkillFile[] | null }) {
  const { t, tRich } = useI18n();
  const labels = syncLabels(machine, before !== null, after !== null, t, tRich);
  return (
    <>
      <ChangesHeader {...labels} />
      <SkillFilesDiff before={before ?? []} after={after ?? []} labels={labels} />
    </>
  );
}

/** How many files and skills a backup holds: setup sync's files and store skills, and the Skills tab's skills. */
export const backupCounts = (backup: SetupBackup) => {
  const files = backup.files.filter((file) => !file.skill).length;
  return { files, skills: backup.files.length - files + backup.skills.length };
};

/** What undoing a backup puts back, in a sentence. */
export function undoMessage(backup: SetupBackup, t: Translate): string {
  const time = formatDateTime(backup.atMs, { year: 'always' });
  if (backup.skills.length) {
    return t(backup.skills.length === 1 ? 'setup.skills.undo.confirm.one' : 'setup.skills.undo.confirm.other', { count: backup.skills.length, time });
  }
  const things = countText(backupCounts(backup), t);
  return t(backup.files.length === 1 ? 'setup.sync.undo.confirm.one' : 'setup.sync.undo.confirm.other', { things, time });
}

export const CHANGE_KIND: Record<ChangeKind, MessageKey> = {
  sync: 'setup.history.what.sync',
  skills: 'setup.history.what.skills',
  reporter: 'setup.history.what.reporter',
  keepSessions: 'setup.history.what.keepSessions',
  telemetry: 'setup.history.what.telemetry',
  mcp: 'setup.history.what.mcp',
  checkouts: 'setup.history.what.checkouts',
  plugins: 'setup.history.what.plugins',
  hooks: 'setup.history.what.hooks',
  automations: 'setup.history.what.automations',
  ssh: 'setup.history.what.ssh',
  projects: 'setup.history.what.projects',
  cleanup: 'setup.history.what.cleanup',
  uninstall: 'setup.history.what.uninstall',
  probe: 'setup.history.what.probe',
};

/**
 * The changes Arbor made on a machine, newest first, each with Undo: setup sync's files and skills, the Skills tab's
 * skills, and settings files other features changed. `limit` is how many to show.
 */
export function BackupList({ machine, backups, error, busy, undoing, onUndo, onRetry, limit = 5 }: {
  machine: string;
  backups: SetupBackup[] | null;
  error: string | null;
  busy: boolean;
  /** The backup being undone now. */
  undoing: string | null;
  onUndo: (backup: SetupBackup) => void;
  /** Lists the changes again after a failure; without it, the failure has no button beside it. */
  onRetry?: () => void;
  limit?: number;
}) {
  const { t, tRich } = useI18n();
  if (error) {
    return (
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground" title={errorWords(error)}>{t('setup.sync.history.failed', { error: plainError(error, t) })}</p>
        {onRetry ? <Button type="button" variant="outline" size="xs" onClick={onRetry}>{t('common.tryAgain')}</Button> : null}
      </div>
    );
  }
  if (!backups?.length) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{tRich('setup.sync.history.title', { machine: <MachinePill name={machine} size="sm" /> })}</h3>
      <div className="overflow-hidden rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
        {backups.slice(0, limit).map((backup) => (
          <div key={backup.id} className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm">
            <span className="shrink-0 text-foreground">{formatDateTime(backup.atMs, { year: 'always' })}</span>
            <span
              className="min-w-0 flex-1 truncate text-muted-foreground"
              title={[...backup.files.map((file) => file.path), ...backup.skills.map((skill) => `${skill.home}/skills/${skill.name}`)].join('\n')}
            >
              {[t(CHANGE_KIND[backup.what]), countText(backupCounts(backup), t), backup.commit ? t('setup.sync.history.from', { commit: short(backup.commit) }) : null]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {backup.what === 'uninstall' || backup.what === 'probe' ? (
              <Badge variant="outline" size="sm">{t('setup.sync.history.noUndo')}</Badge>
            ) : backup.deletedAtMs !== undefined ? (
              <Badge variant="outline" size="sm" title={formatDateTime(backup.deletedAtMs, { year: 'always' })}>{t('setup.sync.history.deleted', { when: formatAgo(backup.deletedAtMs) })}</Badge>
            ) : backup.undoneAtMs !== null ? (
              <Badge variant="outline" size="sm">{t('setup.sync.history.undone')}</Badge>
            ) : (
              <Button variant="ghost-muted" size="xs" disabled={busy} onClick={() => onUndo(backup)}>
                {undoing === backup.id ? <Spinner /> : <RotateCcw />}
                {t('setup.sync.history.undo')}
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

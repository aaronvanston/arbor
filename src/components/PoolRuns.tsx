import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useI18n } from '../i18n';
import { formatAgo, formatDateTime, formatDuration, formatRelative } from '../lib/format';
import { sessionsView, type AppView } from '../navigation';
import { CommandLine } from './CommandLine';
import { MachinePill } from './identity/Identity';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from './ui/dialog';
import { ArrowUpRight, ExternalLink, X } from './ui/icons';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './ui/select';
import { Spinner } from './ui/spinner';
import { Textarea } from './ui/textarea';
import { toast } from './ui/toast';
import { SettingsBlock } from './layout/settings';
import { useConfirmation } from './ConfirmationDialog';
import { HARNESS_LABEL } from '../services/harnesses';
import { useFleetHealth } from '../services/fleetHealth';
import { SETUP_PROJECTS_UPDATED_EVENT, getProjects, scanProjects } from '../services/setupProjects';
import { plainError } from '../services/plainError';
import { useAppPreferences } from '../appPreferences';
import {
  RUN_STATE_LABEL,
  RUN_STATE_TONE,
  cancelRun,
  canOpenRun,
  newRunRequest,
  openRun,
  poolRepos,
  reasonMessage,
  runCommands,
  repoName,
  runDraftProblem,
  runHarnessChoices,
  runSetupChoices,
  runSetupLabel,
  setupLabel,
  startRun,
  unscannedMembers,
} from '../services/runs';
import type { HarnessRun, MachinePool, MachineProjects, RunHarness, RunRequest } from '../native/types';

/** One run's reason, worded, or null when it has none. */
function useReason() {
  const { t } = useI18n();
  return (run: HarnessRun) => {
    const message = reasonMessage(run);
    return message ? t(message.key, { ...message.values, harness: t(HARNESS_LABEL[message.harness]) }) : null;
  };
}

/**
 * What a run's details show: when it ran, its session, and for one on the command line the commands that read its log
 * and pick up its session on the machine.
 */
export function RunDetails({ run, nowMs }: { run: HarnessRun; nowMs: number }) {
  const { t } = useI18n();
  const health = useFleetHealth();
  const { log, resume } = runCommands(run, health);
  const ended = run.endedAtMs ?? (run.state === 'running' ? nowMs : null);
  const facts: { label: string; value: string }[] = [
    ...(run.startedAtMs ? [{ label: t('runs.info.started'), value: formatDateTime(run.startedAtMs, { seconds: true }) }] : []),
    ...(run.endedAtMs ? [{ label: t('runs.info.ended'), value: formatDateTime(run.endedAtMs, { seconds: true }) }] : []),
    ...(run.startedAtMs && ended ? [{ label: t('runs.info.took'), value: formatDuration(Math.max(0, ended - run.startedAtMs)) }] : []),
    ...(run.handle.sessionId ? [{ label: t('runs.info.session'), value: run.handle.sessionId }] : []),
  ];
  return (
    <div className="flex flex-col gap-3 pt-2" data-slot="run-details">
      {facts.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          {facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className="min-w-0 truncate font-mono tabular-nums text-foreground">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {log ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">{t('runs.info.log')}</span>
          <CommandLine command={log} />
          <span className="text-xs text-muted-foreground">{t('runs.info.logHint')}</span>
        </div>
      ) : run.used === 'headless' && !run.handle.log && run.state === 'failed' ? (
        <p className="text-xs text-muted-foreground">{t('runs.info.noLog')}</p>
      ) : null}
      {resume ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">{t('runs.info.resume')}</span>
          <CommandLine command={resume} />
          <span className="text-xs text-muted-foreground">{t('runs.info.resumeHint')}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A pool's latest runs: how each went, where it went, and what can still be done with it (taking a waiting one out of
 * the queue, bringing an Orca run's terminal to the front, opening its session), with details to look into it.
 */
export function PoolRunsBlock({ runs, nowMs = Date.now(), onNavigate }: { runs: HarnessRun[]; nowMs?: number; onNavigate?: (view: AppView) => void }) {
  const { t } = useI18n();
  const reason = useReason();
  const { askConfirmation } = useConfirmation();
  const health = useFleetHealth();
  const [busy, setBusy] = useState<string | null>(null);
  // Arbor never keeps a run's prompt, so one taken out of the queue can't be put back: it's asked first.
  const cancel = async (run: HarnessRun) => {
    const confirmed = await askConfirmation({
      title: t('runs.cancelConfirm.title', { title: run.title }),
      message: t('runs.cancelConfirm.message'),
      confirmText: t('runs.cancelConfirm.confirm'),
      variant: 'danger',
    });
    if (confirmed) await act(run.id, () => cancelRun(run.id), t('runs.canceled', { title: run.title }));
  };
  const act = async (id: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    try {
      await action();
      if (done) toast({ kind: 'success', title: done });
    } catch (failure) {
      toast({ kind: 'error', title: plainError(failure, t) });
    } finally {
      setBusy(null);
    }
  };
  if (runs.length === 0) return <SettingsBlock className="py-2 text-xs text-muted-foreground">{t('runs.none')}</SettingsBlock>;
  return (
    <ul className="divide-y divide-border/50" data-slot="pool-runs">
      {runs.map((run) => {
        const why = reason(run);
        const harness = run.used ?? run.harness;
        return (
          <Collapsible key={run.id} render={<li />} className="flex items-start gap-3 px-4 py-2.5" data-run-state={run.state}>
            <Badge variant={RUN_STATE_TONE[run.state]} className="mt-0.5 shrink-0">{t(RUN_STATE_LABEL[run.state])}</Badge>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="truncate font-medium text-foreground">{run.title}</span>
                {run.machine ? <MachinePill name={run.machine} size="sm" /> : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('runs.line', {
                  harness: t(HARNESS_LABEL[harness]),
                  setup: runSetupLabel(run, health, t),
                  folder: run.repo && !run.folder ? repoName(run.repo) : run.folder,
                  when: formatAgo(run.queuedAtMs, nowMs),
                })}
                {run.handle.worktree ? ` · ${t('runs.ownWorktree', { name: run.handle.worktree })}` : ''}
                {run.used === 'headless' && run.harness !== 'headless' ? ` · ${t('runs.fellBack', { harness: t(HARNESS_LABEL[run.harness]) })}` : ''}
                {run.used === 't3' && run.state === 'handedOff' ? ` · ${t('runs.whereT3')}` : ''}
              </p>
              {why ? <p className={run.state === 'failed' ? 'text-xs text-error-foreground' : 'text-xs text-warning-foreground'}>{why}</p> : null}
              {run.state === 'queued' && run.waitUntilMs ? (
                <p className="text-xs text-muted-foreground">
                  {t(run.reason === 'noHarness' ? 'runs.waitsUntilHarness' : 'runs.waitsUntil', { when: formatRelative(run.waitUntilMs, nowMs), harness: t(HARNESS_LABEL[run.harness]) })}
                </p>
              ) : null}
              {run.startedAtMs ? (
                <CollapsiblePanel>
                  <RunDetails run={run} nowMs={nowMs} />
                </CollapsiblePanel>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {run.state === 'queued' ? (
                <Button variant="outline" size="xs" disabled={busy === run.id} onClick={() => void cancel(run)}>
                  <X />{t('runs.cancel')}
                </Button>
              ) : null}
              {canOpenRun(run) ? (
                <Button variant="outline" size="xs" disabled={busy === run.id} onClick={() => void act(run.id, () => openRun(run.id))}>
                  {busy === run.id ? <Spinner /> : <ExternalLink />}{t('runs.open')}
                </Button>
              ) : null}
              {run.handle.sessionId && onNavigate ? (
                <Button variant="ghost-muted" size="xs" onClick={() => onNavigate(sessionsView({ session: run.handle.sessionId }))}>
                  {t('runs.openSession')}<ArrowUpRight />
                </Button>
              ) : null}
              {run.startedAtMs ? (
                <CollapsibleTrigger chevron="end" render={<Button variant="ghost-muted" size="xs" />}>
                  {t('runs.details')}
                </CollapsibleTrigger>
              ) : null}
            </div>
          </Collapsible>
        );
      })}
    </ul>
  );
}

/** A choice in the repository list that switches to typing a folder. */
const FOLDER_CHOICE = '__folder';

/**
 * The members' repositories, as their last Projects scans found them, kept fresh. Members never looked at are scanned
 * once while the dialog is open, the way Setup's checklist does, so the list speaks for every member it can reach.
 */
function usePoolProjects(pool: MachinePool | null) {
  const health = useFleetHealth();
  const [projects, setProjects] = useState<MachineProjects[] | null>(null);
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!pool) return;
    let current = true;
    const load = () => getProjects().then((next) => { if (current) setProjects(next); }).catch(() => { if (current) setProjects([]); });
    void load();
    const stop = listen(SETUP_PROJECTS_UPDATED_EVENT, () => void load());
    return () => {
      current = false;
      void stop.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [pool]);
  const unseen = pool && projects ? unscannedMembers(pool, projects) : [];
  const reachable = new Set((health ?? []).filter((machine) => machine.host.enabled && !machine.error).map((machine) => machine.machine));
  useEffect(() => {
    for (const machine of unseen) {
      if (!reachable.has(machine) || asked.current.has(machine)) continue;
      asked.current.add(machine);
      scanProjects(machine).catch(() => undefined);
    }
  });
  const scanning = (projects ?? []).filter((entry) => entry.scanning && pool?.members.some((member) => member.machine === entry.machine)).map((entry) => entry.machine);
  return { projects, scanning };
}

/**
 * Starts a session on a pool: the repository (or a folder), where it runs (Orca or the agent's command line), the agent,
 * the prompt, and whether it gets a worktree of its own. The pool picks the member.
 */
export function StartRunDialog({ pool, onClose }: { pool: MachinePool | null; onClose: () => void }) {
  const { t } = useI18n();
  const health = useFleetHealth();
  const reason = useReason();
  // Settings › Harnesses can turn T3 Code and Orca off for runs; the command line is always there.
  const harnesses = runHarnessChoices(useAppPreferences());
  const firstHarness = harnesses[0] ?? 'headless';
  const [draft, setDraft] = useState<RunRequest>(() => newRunRequest(''));
  const [byFolder, setByFolder] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const { projects, scanning } = usePoolProjects(pool);
  useEffect(() => {
    if (!pool) return;
    setDraft(newRunRequest(pool.id, firstHarness));
    setByFolder(false);
    setError(null);
    setTried(false);
  }, [pool, firstHarness]);
  const repos = pool && projects ? poolRepos(pool, projects) : [];
  const total = pool?.members.filter((member) => member.weight !== 'manual').length ?? 0;
  const firstRepo = repos[0]?.repo;
  // The repo on the most members, until one is picked or a folder typed.
  useEffect(() => {
    if (!pool || byFolder || draft.repo || !firstRepo) return;
    setDraft((current) => ({ ...current, repo: firstRepo }));
  }, [pool, byFolder, draft.repo, firstRepo]);
  const choices = pool ? runSetupChoices(pool, health, draft.harness) : [];
  const firstChoice = choices[0]?.id;
  // The first setup that's ready somewhere, once a harness is picked.
  useEffect(() => {
    if (!pool || draft.setup || !firstChoice) return;
    setDraft((current) => ({ ...current, setup: firstChoice ?? '' }));
  }, [pool, draft.setup, firstChoice]);
  const change = (patch: Partial<RunRequest>) => setDraft((current) => ({ ...current, ...patch }));
  const problem = runDraftProblem(draft);
  const chosen = choices.find((choice) => choice.id === draft.setup);
  const chosenRepo = repos.find((entry) => entry.repo === draft.repo);
  // Orca's own worktree command starts its agents with their default model.
  const takesModel = !(draft.harness === 'orca' && draft.worktree);
  const pickWhere = (next: string) => {
    if (next === FOLDER_CHOICE) {
      setByFolder(true);
      change({ repo: undefined });
    } else {
      setByFolder(false);
      change({ repo: next, folder: '' });
    }
  };
  const start = async () => {
    setTried(true);
    if (problem || !pool) return;
    setStarting(true);
    setError(null);
    try {
      const run = await startRun({ ...draft, title: draft.title?.trim() || undefined, folder: draft.folder.trim(), model: takesModel ? draft.model?.trim() || undefined : undefined });
      const harness = t(HARNESS_LABEL[run.used ?? run.harness]);
      if (run.state === 'handedOff' || run.state === 'running') {
        toast({ kind: 'success', title: t('runs.started', { harness, machine: run.machine ?? '' }) });
        onClose();
      } else if (run.state === 'queued') {
        toast({ kind: 'info', title: t('runs.queued', { pool: pool.name }), description: reason(run) ?? undefined });
        onClose();
      } else {
        // Nothing took it: say why here, where it can be changed and tried again.
        setError(reason(run) ?? t(RUN_STATE_LABEL[run.state]));
      }
    } catch (failure) {
      setError(plainError(failure, t));
    } finally {
      setStarting(false);
    }
  };
  return (
    <Dialog open={pool !== null} onOpenChange={(isOpen) => { if (!isOpen && !starting) onClose(); }}>
      <DialogPopup className="max-w-xl" initialFocus={promptRef}>
        <form className="contents" onSubmit={(event) => { event.preventDefault(); void start(); }}>
          <DialogHeader>
            <DialogTitle>{t('runs.dialog.title', { pool: pool?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('runs.dialog.description')}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <Label>{t('runs.dialog.repo')}</Label>
              <Select value={byFolder ? FOLDER_CHOICE : draft.repo ?? ''} onValueChange={(next) => { if (next) pickWhere(String(next)); }}>
                <SelectTrigger size="sm" aria-label={t('runs.dialog.repo')}>
                  <SelectValue>
                    {byFolder ? t('runs.dialog.folderChoice') : chosenRepo ? repoName(chosenRepo.repo) : t('runs.dialog.noRepos')}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {repos.map((entry) => (
                    <SelectItem key={entry.repo} value={entry.repo}>
                      <span className="flex w-full items-center justify-between gap-3">
                        <span className="font-mono text-xs">{repoName(entry.repo)}</span>
                        <span className="text-xs text-muted-foreground">{t('runs.dialog.repoOn', { count: entry.machines.length, total })}</span>
                      </span>
                    </SelectItem>
                  ))}
                  <SelectItem value={FOLDER_CHOICE}>{t('runs.dialog.folderChoice')}</SelectItem>
                </SelectPopup>
              </Select>
              {byFolder ? (
                <Input id="run-folder" font="mono" value={draft.folder} onChange={(event) => change({ folder: event.target.value })} placeholder={t('runs.dialog.folderPlaceholder')} spellCheck={false} aria-label={t('runs.dialog.folder')} />
              ) : null}
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {scanning.length > 0 ? <><Spinner className="size-3" />{t('runs.dialog.scanning', { machines: scanning.join(', ') })}</> : t('runs.dialog.reposHint')}
              </p>
              {chosenRepo && !byFolder ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {chosenRepo.machines.map((machine) => <MachinePill key={machine} name={machine} size="sm" />)}
                </div>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>{t('runs.dialog.harness')}</Label>
                <Select value={draft.harness} onValueChange={(next) => { if (next) change({ harness: next as RunHarness, setup: '' }); }}>
                  <SelectTrigger size="sm" aria-label={t('runs.dialog.harness')}>
                    <SelectValue>{t(HARNESS_LABEL[draft.harness])}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {harnesses.map((harness) => <SelectItem key={harness} value={harness}>{t(HARNESS_LABEL[harness])}</SelectItem>)}
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{t('runs.dialog.agent')}</Label>
                <Select value={draft.setup} onValueChange={(next) => change({ setup: next ? String(next) : '' })} disabled={choices.length === 0}>
                  <SelectTrigger size="sm" aria-label={t('runs.dialog.agent')}>
                    <SelectValue>{chosen ? setupLabel(chosen, t) : t('runs.dialog.noSetups')}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {choices.map((choice) => (
                      <SelectItem key={choice.id} value={choice.id}>
                        <span className="flex w-full items-center justify-between gap-3">
                          <span>{setupLabel(choice, t)}</span>
                          <span className="text-xs text-muted-foreground">{t('runs.dialog.readyOn', { ready: choice.ready, found: choice.found })}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>
            {choices.length === 0 ? <p className="-mt-3 text-xs text-muted-foreground">{t('runs.dialog.noSetupsHint', { harness: t(HARNESS_LABEL[draft.harness]) })}</p> : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="run-title">{t('runs.dialog.name')}</Label>
              <Input id="run-title" value={draft.title ?? ''} onChange={(event) => change({ title: event.currentTarget.value })} placeholder={t('runs.dialog.namePlaceholder')} />
              <p className="text-xs text-muted-foreground">{t('runs.dialog.nameHint')}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="run-prompt">{t('runs.dialog.prompt')}</Label>
              <Textarea id="run-prompt" ref={promptRef} rows={5} value={draft.prompt} onChange={(event) => change({ prompt: event.currentTarget.value })} placeholder={t('runs.dialog.promptPlaceholder')} />
              <p className="text-xs text-muted-foreground">{t('runs.dialog.promptHint')}</p>
            </div>
            {takesModel ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="run-model">{t('runs.dialog.model')}</Label>
                <Input id="run-model" font="mono" value={draft.model ?? ''} onChange={(event) => change({ model: event.target.value })} placeholder={t('runs.dialog.modelPlaceholder')} spellCheck={false} />
              </div>
            ) : null}
            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox checked={draft.worktree === true} onCheckedChange={(on) => change({ worktree: on === true })} className="mt-0.5" />
              <span className="space-y-0.5">
                <span className="block">{t('runs.dialog.worktree')}</span>
                <span className="block text-xs text-muted-foreground">{t(takesModel ? 'runs.dialog.worktreeHint' : 'runs.dialog.orcaModel')}</span>
              </span>
            </label>
            {draft.harness === 'headless' ? (
              <p className="text-xs text-muted-foreground">{t('runs.dialog.headlessHint')}</p>
            ) : (
              <label className="flex items-start gap-2.5 text-sm">
                <Checkbox checked={draft.fallback} onCheckedChange={(on) => change({ fallback: on === true })} className="mt-0.5" />
                <span className="space-y-0.5">
                  <span className="block">{t('runs.dialog.fallback')}</span>
                  <span className="block text-xs text-muted-foreground">{t('runs.dialog.fallbackHint')}</span>
                </span>
              </label>
            )}
            {tried && problem ? <p className="text-sm text-error-foreground" role="alert">{t(problem)}</p> : null}
            {error ? <p className="text-sm text-error-foreground" role="alert">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={starting} onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={starting}>
              {starting ? <Spinner /> : null}
              {t('runs.dialog.start')}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

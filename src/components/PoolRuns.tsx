import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { formatAgo, formatRelative } from '../lib/format';
import { MachinePill } from './identity/Identity';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from './ui/dialog';
import { ExternalLink, X } from './ui/icons';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './ui/select';
import { Spinner } from './ui/spinner';
import { Textarea } from './ui/textarea';
import { toast } from './ui/toast';
import { SettingsBlock } from './layout/settings';
import { HARNESS_LABEL } from '../services/harnesses';
import { useFleetHealth } from '../services/fleetHealth';
import {
  RUN_HARNESSES,
  RUN_STATE_LABEL,
  RUN_STATE_TONE,
  cancelRun,
  canOpenRun,
  newRunRequest,
  openRun,
  reasonMessage,
  runDraftProblem,
  runSetupChoices,
  setupLabel,
  startRun,
} from '../services/runs';
import type { HarnessRun, MachinePool, RunHarness, RunRequest } from '../native/types';

/** One run's reason, worded, or null when it has none. */
function useReason() {
  const { t } = useI18n();
  return (run: HarnessRun) => {
    const message = reasonMessage(run);
    return message ? t(message.key, { ...message.values, harness: t(HARNESS_LABEL[message.harness]) }) : null;
  };
}

/**
 * A pool's latest runs: how each went, where it went, and what can still be done with it (taking a waiting one out of
 * the queue, or bringing an Orca run's terminal to the front).
 */
export function PoolRunsBlock({ runs, nowMs = Date.now() }: { runs: HarnessRun[]; nowMs?: number }) {
  const { t } = useI18n();
  const reason = useReason();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (id: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    try {
      await action();
      if (done) toast({ kind: 'success', title: done });
    } catch (failure) {
      toast({ kind: 'error', title: String(failure) });
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
          <li key={run.id} className="flex items-start gap-3 px-4 py-2.5" data-run-state={run.state}>
            <Badge variant={RUN_STATE_TONE[run.state]} className="mt-0.5 shrink-0">{t(RUN_STATE_LABEL[run.state])}</Badge>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="truncate font-medium text-foreground">{run.title}</span>
                {run.machine ? <MachinePill name={run.machine} size="sm" /> : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('runs.line', {
                  harness: t(HARNESS_LABEL[harness]),
                  setup: run.setup,
                  folder: run.folder,
                  when: formatAgo(run.queuedAtMs, nowMs),
                })}
                {run.used === 'headless' && run.harness !== 'headless' ? ` · ${t('runs.fellBack', { harness: t(HARNESS_LABEL[run.harness]) })}` : ''}
                {run.used === 't3' && run.state === 'handedOff' ? ` · ${t('runs.whereT3')}` : ''}
              </p>
              {why ? <p className={run.state === 'failed' ? 'text-xs text-error-foreground' : 'text-xs text-warning-foreground'}>{why}</p> : null}
              {run.state === 'queued' && run.waitUntilMs ? <p className="text-xs text-muted-foreground">{t('runs.waitsUntil', { when: formatRelative(run.waitUntilMs, nowMs) })}</p> : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {run.state === 'queued' ? (
                <Button variant="outline" size="xs" disabled={busy === run.id} onClick={() => void act(run.id, () => cancelRun(run.id), t('runs.canceled', { title: run.title }))}>
                  <X />{t('runs.cancel')}
                </Button>
              ) : null}
              {canOpenRun(run) ? (
                <Button variant="outline" size="xs" disabled={busy === run.id} onClick={() => void act(run.id, () => openRun(run.id))}>
                  {busy === run.id ? <Spinner /> : <ExternalLink />}{t('runs.open')}
                </Button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Starts a run on a pool: which harness and setup, the folder, the prompt, and whether the command line may stand in. */
export function StartRunDialog({ pool, onClose }: { pool: MachinePool | null; onClose: () => void }) {
  const { t } = useI18n();
  const health = useFleetHealth();
  const reason = useReason();
  const [draft, setDraft] = useState<RunRequest>(() => newRunRequest(''));
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const folderRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!pool) return;
    setDraft(newRunRequest(pool.id));
    setError(null);
    setTried(false);
  }, [pool]);
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
  const start = async () => {
    setTried(true);
    if (problem || !pool) return;
    setStarting(true);
    setError(null);
    try {
      const run = await startRun({ ...draft, folder: draft.folder.trim(), model: draft.model?.trim() || undefined });
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
      setError(String(failure));
    } finally {
      setStarting(false);
    }
  };
  return (
    <Dialog open={pool !== null} onOpenChange={(isOpen) => { if (!isOpen && !starting) onClose(); }}>
      <DialogPopup className="max-w-xl" initialFocus={folderRef}>
        <form className="contents" onSubmit={(event) => { event.preventDefault(); void start(); }}>
          <DialogHeader>
            <DialogTitle>{t('runs.dialog.title', { pool: pool?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('runs.dialog.description')}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-5">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>{t('runs.dialog.harness')}</Label>
                <Select value={draft.harness} onValueChange={(next) => { if (next) change({ harness: next as RunHarness, setup: '' }); }}>
                  <SelectTrigger size="sm" aria-label={t('runs.dialog.harness')}>
                    <SelectValue>{t(HARNESS_LABEL[draft.harness])}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {RUN_HARNESSES.map((harness) => <SelectItem key={harness} value={harness}>{t(HARNESS_LABEL[harness])}</SelectItem>)}
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{t(draft.harness === 't3' ? 'runs.dialog.setup' : 'runs.dialog.agent')}</Label>
                <Select value={draft.setup} onValueChange={(next) => change({ setup: next ? String(next) : '' })} disabled={choices.length === 0}>
                  <SelectTrigger size="sm" aria-label={t(draft.harness === 't3' ? 'runs.dialog.setup' : 'runs.dialog.agent')}>
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
            <div className="grid grid-cols-[2fr_1fr] gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="run-folder">{t('runs.dialog.folder')}</Label>
                <Input id="run-folder" ref={folderRef} font="mono" value={draft.folder} onChange={(event) => change({ folder: event.target.value })} placeholder={t('runs.dialog.folderPlaceholder')} spellCheck={false} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="run-model">{t('runs.dialog.model')}</Label>
                <Input id="run-model" font="mono" value={draft.model ?? ''} onChange={(event) => change({ model: event.target.value })} placeholder={t('runs.dialog.modelPlaceholder')} spellCheck={false} />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="run-prompt">{t('runs.dialog.prompt')}</Label>
              <Textarea id="run-prompt" rows={5} value={draft.prompt} onChange={(event) => change({ prompt: event.currentTarget.value })} placeholder={t('runs.dialog.promptPlaceholder')} />
              <p className="text-xs text-muted-foreground">{t('runs.dialog.promptHint')}</p>
            </div>
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

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/resources';
import { cn } from '../../lib/utils';
import { invokeCommand } from '../../native/commands';
import type { Automation, AutomationAccess, Harness, AutomationInput, AutomationRunsOn, AutomationSession, AutomationWorkspace, MachineProjects } from '../../native/types';
import {
  automationHold,
  backgroundRunnerCheck,
  choiceSummary,
  loadAutomations,
  scheduleChoice,
  scheduleRule,
  scheduleWords,
  switchSchedule,
  useAutomations,
  type ScheduleChoice,
} from '../../services/automations';
import { usePools } from '../../services/pools';
import { PoolName } from '../PoolName';
import { useFleetMachines } from '../../services/fleetHealth';
import { getProjects, tilde } from '../../services/setupProjects';
import { HarnessName } from '../identity/Harness';
import { MachinePill } from '../identity/Identity';
import { Button } from '../ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../ui/dialog';
import { ArrowLeft, Sparkles, TriangleAlert } from '../ui/icons';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../ui/select';
import { Spinner } from '../ui/spinner';
import { Textarea } from '../ui/textarea';
import { toast } from '../ui/toast';
import { Toggle, ToggleGroup } from '../ui/toggle-group';

/** Where the dialog stands: a description to draft from, or the automation's fields. */
type Step = 'describe' | 'review';

/** What the fields hold; the machine is '' until one's picked, and `best` for the one Arbor picks when it's due. */
type Form = {
  name: string;
  prompt: string;
  agent: Harness;
  machine: string;
  projectPath: string;
  workspace: AutomationWorkspace;
  session: AutomationSession;
  access: AutomationAccess;
  /** As picked; the machine only when its background runner can take it (`backgroundRunnerCheck`). */
  runsOn: AutomationRunsOn;
  /** None for a copy whose original's schedule Arbor couldn't read, until one is picked. */
  schedule: ScheduleChoice | null;
  graceMinutes: number;
  precheck: string;
  precheckTimeoutSecs: number;
  enabled: boolean;
  /** The model and effort it's set to. The form doesn't change them, but a save writes every field, so they're kept. */
  model: string | null;
  effort: string | null;
};

const BEST = 'best';
/** A pool's choice in the machine field, beside the machines' names. */
const POOL_PREFIX = 'pool:';
const poolValue = (id: string) => `${POOL_PREFIX}${id}`;
const poolOf = (value: string) => (value.startsWith(POOL_PREFIX) ? value.slice(POOL_PREFIX.length) : null);
const isMachine = (value: string) => Boolean(value) && value !== BEST && poolOf(value) === null;

const emptyForm = (machine: string): Form => ({
  name: '',
  prompt: '',
  agent: 'claude',
  machine,
  projectPath: '',
  workspace: 'checkout',
  session: 'fresh',
  access: 'edits',
  runsOn: 'machine',
  schedule: { kind: 'hourly', hours: 1, minute: 0 },
  graceMinutes: 60,
  precheck: '',
  precheckTimeoutSecs: 60,
  enabled: true,
  model: null,
  effort: null,
});

const formFrom = (automation: Automation): Form => ({
  name: automation.summary.name,
  prompt: automation.prompt,
  agent: automation.summary.agent ?? 'claude',
  machine: automation.summary.target.kind === 'best' ? BEST
    : automation.summary.target.kind === 'pool' ? poolValue(automation.summary.target.id)
      : automation.summary.machine ?? '',
  projectPath: automation.projectPath ?? '',
  workspace: automation.workspace,
  session: automation.session,
  access: automation.access,
  runsOn: automation.summary.runsOn,
  schedule: automation.rrule ? scheduleChoice(automation.rrule) : { kind: 'daily', hour: 9, minute: 0 },
  graceMinutes: automation.graceMinutes,
  precheck: automation.precheck ?? '',
  precheckTimeoutSecs: automation.precheckTimeoutSecs,
  enabled: automation.summary.enabled,
  model: automation.model,
  effort: automation.effort,
});

/**
 * A copy of another app's automation whose schedule Arbor couldn't read: everything else as the original has it, on
 * the machine it was found on, paused, and the schedule left for the user to pick.
 */
const copyForm = (automation: Automation): Form => ({
  ...formFrom(automation),
  machine: automation.summary.machine ?? '',
  runsOn: 'app',
  schedule: null,
  enabled: false,
});

const GRACE_CHOICES = [15, 30, 60, 120, 360, 720, 1440];
const TIMEOUT_CHOICES = [15, 30, 60, 120, 300, 600];
const SCHEDULE_KINDS: readonly ScheduleChoice['kind'][] = ['everyMinutes', 'hourly', 'daily', 'weekdays', 'weekly', 'custom'];
const MINUTE_CHOICES = [5, 10, 15, 20, 30, 45];
/** What a kind picked for a schedule that had none starts from: 9:00, as a new day's work usually does. */
const DEFAULT_PICKED: ScheduleChoice = { kind: 'daily', hour: 9, minute: 0 };
const HOUR_CHOICES = [1, 2, 3, 4, 6, 8, 12];
const DAY_SHORT: readonly MessageKey[] = [
  'automations.day.short.sunday', 'automations.day.short.monday', 'automations.day.short.tuesday', 'automations.day.short.wednesday',
  'automations.day.short.thursday', 'automations.day.short.friday', 'automations.day.short.saturday',
];
const EXAMPLES: readonly MessageKey[] = ['automations.describe.example.sentry', 'automations.describe.example.changelog', 'automations.describe.example.deps'];

const twoDigits = (value: number) => String(value).padStart(2, '0');

/**
 * New automation, or an Arbor automation edited. A new one starts from a sentence, which the proxy's drafting model
 * makes into a schedule, a precheck and a prompt, all left for the user to check; editing opens straight on the fields.
 */
export function AutomationDialog({ open, onOpenChange, editing, copyOf, machine = null, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Arbor automation to edit, by its id; none for a new one. */
  editing?: string;
  /** Another app's automation to copy into a new one, opened on its fields with the schedule to pick. */
  copyOf?: Automation;
  /** The machine a new one starts on, as the list was narrowed to. */
  machine?: string | null;
  onSaved: (automation: Automation) => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>(editing || copyOf ? 'review' : 'describe');
  const [description, setDescription] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(() => (copyOf ? copyForm(copyOf) : emptyForm(machine ?? '')));
  const [loaded, setLoaded] = useState(!editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const describeRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const update = (patch: Partial<Form>) => setForm((current) => ({ ...current, ...patch }));

  useEffect(() => {
    if (!editing) return undefined;
    let current = true;
    invokeCommand('get_automation', { id: editing })
      .then((automation) => { if (current) { setForm(formFrom(automation)); setLoaded(true); } })
      .catch((reason: unknown) => { if (current) setError(String(reason)); });
    return () => { current = false; };
  }, [editing]);

  const draft = async () => {
    setDrafting(true);
    setDraftError(null);
    try {
      const result = await invokeCommand('draft_automation', {
        input: { description, ...(isMachine(form.machine) ? { machine: form.machine } : {}), ...(form.projectPath ? { projectPath: form.projectPath } : {}) },
      });
      setForm((current) => ({
        ...current,
        name: result.name,
        prompt: result.prompt,
        agent: result.agent,
        session: result.session,
        schedule: scheduleChoice(result.rrule),
        graceMinutes: result.graceMinutes,
        precheck: result.precheck ?? '',
        precheckTimeoutSecs: result.precheckTimeoutSecs,
      }));
      setNote(result.note);
      setStep('review');
    } catch (reason) {
      setDraftError(String(reason));
    } finally {
      setDrafting(false);
    }
  };

  const fillMyself = () => {
    if (!form.prompt.trim() && description.trim()) update({ prompt: description.trim() });
    setStep('review');
  };

  const { list } = useAutomations();
  const runsOnBlocked = backgroundRunnerCheck(list, isMachine(form.machine) || !form.machine ? form.machine : null, form.schedule?.kind ?? '');
  const runsOn: AutomationRunsOn = runsOnBlocked ? 'app' : form.runsOn;

  const problem = !form.name.trim() ? t('automations.form.needName')
    : !form.prompt.trim() ? t('automations.form.needPrompt')
      : !form.machine ? t('automations.form.needMachine')
        : form.machine === BEST ? t('automations.target.bestGone')
          : !form.projectPath.trim() ? t('automations.form.needProject')
            : !form.schedule ? t('automations.form.needSchedule')
              : form.schedule.kind === 'custom' && !form.schedule.rrule.trim() ? t('automations.form.needRule')
                : null;

  const save = async () => {
    if (problem || !form.schedule) return;
    setSaving(true);
    setError(null);
    const input: AutomationInput = {
      ...(editing ? { id: editing } : {}),
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      agent: form.agent,
      target: poolOf(form.machine) !== null ? { kind: 'pool', id: poolOf(form.machine) ?? '' } : { kind: 'machine', name: form.machine },
      projectPath: form.projectPath.trim(),
      workspace: form.workspace,
      session: form.session,
      access: form.access,
      runsOn,
      rrule: scheduleRule(form.schedule),
      graceMinutes: form.graceMinutes,
      ...(form.precheck.trim() ? { precheck: form.precheck.trim() } : {}),
      precheckTimeoutSecs: form.precheckTimeoutSecs,
      enabled: form.enabled,
      ...(form.model ? { model: form.model } : {}),
      ...(form.effort ? { effort: form.effort } : {}),
    };
    try {
      const saved = await invokeCommand('save_automation', { input });
      await loadAutomations();
      toast({ title: t(editing ? 'automations.form.saved' : 'automations.form.created', { name: saved.summary.name }) });
      onOpenChange(false);
      onSaved(saved);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      {step === 'describe' ? (
        <DialogPopup className="max-w-xl" initialFocus={describeRef}>
          <form className="contents" onSubmit={(event) => { event.preventDefault(); if (description.trim()) void draft(); }}>
            <DialogHeader>
              <DialogTitle>{t('automations.describe.title')}</DialogTitle>
              <DialogDescription>{t('automations.describe.description')}</DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-3">
              <Textarea
                ref={describeRef}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t('automations.describe.placeholder')}
                aria-label={t('automations.describe.title')}
                className="min-h-28"
                disabled={drafting}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && description.trim()) {
                    event.preventDefault();
                    void draft();
                  }
                }}
              />
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    disabled={drafting}
                    className="cursor-pointer rounded-full border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => setDescription(t(example))}
                  >
                    {t(example)}
                  </button>
                ))}
              </div>
              {draftError ? (
                <p className="flex items-start gap-1.5 text-sm text-error-foreground" role="alert">
                  <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  {draftError}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">{t('automations.describe.privacy')}</p>
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="ghost" className="me-auto" disabled={drafting} onClick={fillMyself}>{t('automations.describe.skip')}</Button>
              <Button type="button" variant="outline" disabled={drafting} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
              <Button type="submit" disabled={!description.trim() || drafting}>
                {drafting ? <Spinner /> : <Sparkles />}
                {drafting ? t('automations.describe.drafting') : t('automations.describe.draft')}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      ) : (
        <DialogPopup className="h-[min(48rem,100%)] max-w-5xl" initialFocus={nameRef}>
          <form className="contents" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <DialogHeader className="border-b pb-4">
              <DialogTitle>{t(editing ? 'automations.form.editTitle' : copyOf ? 'automations.form.copyTitle' : 'automations.form.newTitle')}</DialogTitle>
              <DialogDescription>{t('automations.form.description')}</DialogDescription>
            </DialogHeader>
            {!loaded ? (
              <DialogPanel className="flex flex-1 items-center justify-center">{error ? <p className="text-sm text-error-foreground">{error}</p> : <Spinner />}</DialogPanel>
            ) : (
              <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_20rem]">
                <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-6">
                  <Field label={t('automations.form.name')} htmlFor="automation-name">
                    <Input id="automation-name" ref={nameRef} value={form.name} onChange={(event) => update({ name: event.target.value })} placeholder={t('automations.form.namePlaceholder')} />
                  </Field>
                  <Field label={t('automations.form.prompt')} htmlFor="automation-prompt" hint={t('automations.form.promptHint')} grow>
                    <Textarea
                      id="automation-prompt"
                      value={form.prompt}
                      onChange={(event) => update({ prompt: event.target.value })}
                      className="min-h-64 flex-1 font-mono text-xs leading-relaxed"
                      wrapperClassName="flex flex-1"
                    />
                  </Field>
                  {note ? (
                    <p className="flex items-start gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-xs text-muted-foreground dark:bg-input/16">
                      <Sparkles aria-hidden="true" className="mt-px size-3.5 shrink-0 text-icon-muted" />
                      {t('automations.form.draftNote', { note })}
                    </p>
                  ) : null}
                </div>
                <div className="flex min-h-0 min-w-0 flex-col gap-5 overflow-y-auto overflow-x-hidden border-t p-6 md:border-t-0 md:border-s">
                  <AgentField value={form.agent} onChange={(agent) => update({ agent })} />
                  {/* Saving still works without the key; say here, while the agent is picked, that runs won't start. */}
                  {automationHold(list, form.agent) === 'noKey' ? (
                    <p className="-mt-3 flex items-start gap-1.5 text-xs text-warning-foreground" role="note">
                      <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                      {t('automations.hold.noKey')}
                    </p>
                  ) : null}
                  {/* A path picked on one machine may not exist on another; a pool's members share one, so moving onto or off a pool keeps it. */}
                  <MachineField machine={form.machine} onChange={(next) => update({ machine: next, projectPath: next === form.machine || !isMachine(next) || !isMachine(form.machine) ? form.projectPath : '' })} />
                  <Field
                    label={t('automations.fact.runsOn')}
                    hint={runsOnBlocked ? t(runsOnBlocked, { machine: form.machine }) : t(runsOn === 'machine' ? 'automations.runsOn.machineHint' : 'automations.runsOn.appHint')}
                  >
                    <Segmented
                      label={t('automations.fact.runsOn')}
                      value={runsOn}
                      options={[['machine', t('automations.runsOn.machine'), Boolean(runsOnBlocked)], ['app', t('automations.runsOn.app')]]}
                      onChange={(next) => update({ runsOn: next })}
                    />
                  </Field>
                  <ProjectField target={form.machine} value={form.projectPath} onChange={(projectPath) => update({ projectPath })} />
                  <Field label={t('automations.fact.workspace')} hint={t(form.workspace === 'newWorktree' ? 'automations.workspace.newWorktreeHint' : 'automations.workspace.checkoutHint')}>
                    <Segmented
                      label={t('automations.fact.workspace')}
                      value={form.workspace}
                      options={[['checkout', t('automations.workspace.checkout')], ['newWorktree', t('automations.workspace.newWorktree')]]}
                      onChange={(workspace) => update({ workspace })}
                    />
                  </Field>
                  <Field label={t('automations.fact.session')} hint={t(form.session === 'reuse' ? 'automations.session.reuseHint' : 'automations.session.freshHint')}>
                    <Segmented
                      label={t('automations.fact.session')}
                      value={form.session}
                      options={[['fresh', t('automations.session.fresh')], ['reuse', t('automations.session.reuse')]]}
                      onChange={(session) => update({ session })}
                    />
                  </Field>
                  <Field label={t('automations.fact.access')} hint={t(form.access === 'full' ? 'automations.access.fullHint' : 'automations.access.editsHint')}>
                    <Segmented
                      label={t('automations.fact.access')}
                      value={form.access}
                      options={[['edits', t('automations.access.edits')], ['full', t('automations.access.full')]]}
                      onChange={(access) => update({ access })}
                    />
                    {form.access === 'full' ? (
                      <p className="flex items-start gap-1.5 text-xs text-warning-foreground" role="note">
                        <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                        {t('automations.access.fullWarning')}
                      </p>
                    ) : null}
                  </Field>
                  <ScheduleField value={form.schedule} copied={Boolean(copyOf)} onChange={(schedule) => update({ schedule })} />
                  <Field label={t('automations.fact.grace')} hint={t('automations.form.graceHint')}>
                    <ChoiceSelect
                      label={t('automations.fact.grace')}
                      value={form.graceMinutes}
                      choices={GRACE_CHOICES}
                      words={(minutes) => (minutes < 60 ? t('automations.form.minutes', { count: minutes }) : t('automations.form.hours', { count: minutes / 60 }))}
                      onChange={(graceMinutes) => update({ graceMinutes })}
                    />
                  </Field>
                  <PrecheckField
                    value={form.precheck}
                    timeout={form.precheckTimeoutSecs}
                    onChange={(precheck) => update({ precheck })}
                    onTimeoutChange={(precheckTimeoutSecs) => update({ precheckTimeoutSecs })}
                  />
                </div>
              </div>
            )}
            <DialogFooter className="items-center">
              {!editing && !copyOf ? (
                <Button type="button" variant="ghost" className="me-auto" disabled={saving} onClick={() => setStep('describe')}>
                  <ArrowLeft />
                  {t('automations.form.back')}
                </Button>
              ) : null}
              {problem && loaded ? <p className={cn('text-xs text-muted-foreground', editing && 'me-auto')}>{problem}</p> : null}
              {error && loaded ? <p className="text-xs text-error-foreground" role="alert">{error}</p> : null}
              <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
              <Button type="submit" disabled={Boolean(problem) || saving || !loaded}>
                {saving ? <Spinner /> : null}
                {t(editing ? 'automations.form.save' : 'automations.form.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      )}
    </Dialog>
  );
}

function Field({ label, htmlFor, hint, grow = false, children }: { label: string; htmlFor?: string; hint?: ReactNode; grow?: boolean; children: ReactNode }) {
  return (
    <div className={cn('flex flex-col gap-1.5', grow && 'min-h-0 flex-1')}>
      {htmlFor ? <Label htmlFor={htmlFor}>{label}</Label> : <span className="text-sm font-medium text-foreground">{label}</span>}
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  /** Each choice, its words, and whether it can't be picked now. */
  options: [T, string, boolean?][];
  onChange: (value: T) => void;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next: unknown[]) => { const [picked] = next; if (typeof picked === 'string') onChange(picked as T); }}
      className="w-full"
    >
      {options.map(([option, words, disabled]) => <Toggle key={option} value={option} disabled={disabled} className="flex-1">{words}</Toggle>)}
    </ToggleGroup>
  );
}

function ChoiceSelect({ label, value, choices, words, onChange }: { label: string; value: number; choices: readonly number[]; words: (value: number) => string; onChange: (value: number) => void }) {
  const listed = choices.includes(value) ? choices : [...choices, value].sort((left, right) => left - right);
  return (
    <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
      <SelectTrigger aria-label={label} className="w-full min-w-0"><SelectValue>{words(value)}</SelectValue></SelectTrigger>
      <SelectPopup>{listed.map((choice) => <SelectItem key={choice} value={String(choice)}>{words(choice)}</SelectItem>)}</SelectPopup>
    </Select>
  );
}

function AgentField({ value, onChange }: { value: Harness; onChange: (agent: Harness) => void }) {
  const { t } = useI18n();
  // The harnesses Arbor can start, and the one picked even if this Arbor no longer can.
  const launchable = useAutomations().list?.agents ?? ['claude', 'codex'];
  const agents = launchable.includes(value) ? launchable : [...launchable, value];
  return (
    <Field label={t('automations.fact.agent')}>
      <Select value={value} onValueChange={(next) => onChange((next ?? 'claude') as Harness)}>
        <SelectTrigger aria-label={t('automations.fact.agent')}>
          <SelectValue><HarnessName harness={value} /></SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {agents.map((agent) => (
            <SelectItem key={agent} value={agent}><HarnessName harness={agent} /></SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Field>
  );
}

function MachineField({ machine, onChange }: { machine: string; onChange: (machine: string) => void }) {
  const { t } = useI18n();
  const fleet = useFleetMachines();
  const { pools } = usePools();
  const names = useMemo(() => {
    const listed = (fleet ?? []).map((entry) => entry.machine);
    return isMachine(machine) && !listed.includes(machine) ? [...listed, machine] : listed;
  }, [fleet, machine]);
  const pool = poolOf(machine);
  // A machine with no SSH host can't be reached to run anything, so it's listed but can't be picked until it has one.
  const hostless = useMemo(() => new Set((fleet ?? []).filter((entry) => !entry.health || entry.health.status === 'unconfigured').map((entry) => entry.machine)), [fleet]);
  return (
    <Field label={t('automations.fact.machine')} hint={machine === BEST ? t('automations.target.bestGone') : pool !== null ? t('automations.target.poolHint') : t('automations.form.machineHint')}>
      <Select value={machine} onValueChange={(next) => onChange(String(next ?? ''))}>
        <SelectTrigger aria-label={t('automations.fact.machine')}>
          <SelectValue>
            {machine === BEST ? t('automations.target.best')
              : pool !== null ? <PoolName id={pool} />
                : machine ? <MachinePill name={machine} size="sm" /> : <span className="text-muted-foreground">{t('automations.form.pickMachine')}</span>}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {names.map((name) => (
            hostless.has(name) && name !== machine ? (
              <SelectItem key={name} value={name} disabled>
                <span className="flex flex-col items-start">
                  <MachinePill name={name} size="sm" />
                  <span className="text-xs text-muted-foreground">{t('automations.target.noHost')}</span>
                </span>
              </SelectItem>
            ) : <SelectItem key={name} value={name}><MachinePill name={name} size="sm" /></SelectItem>
          ))}
          {/* A pool picks one of its members with room when the run is due. */}
          {(pools ?? []).map((entry) => (
            <SelectItem key={entry.id} value={poolValue(entry.id)}>
              <span className="flex flex-col">
                <PoolName id={entry.id} />
                <span className="text-xs text-muted-foreground">{t('automations.target.poolShort')}</span>
              </span>
            </SelectItem>
          ))}
          {pools && pools.length === 0 ? (
            <SelectItem value="" disabled>
              <span className="flex flex-col">
                <span>{t('automations.target.pool')}</span>
                <span className="text-xs text-muted-foreground">{t('automations.target.noPools')}</span>
              </span>
            </SelectItem>
          ) : null}
        </SelectPopup>
      </Select>
    </Field>
  );
}

/**
 * The project's folder: one of the repos Arbor found on the machine, or a path typed in.
 * A pool's run lands on any member, so its suggestions are the folders found on every
 * member, written from the home folder so the one path works on each.
 */
function ProjectField({ target, value, onChange }: { target: string; value: string; onChange: (path: string) => void }) {
  const { t } = useI18n();
  const listId = useId();
  const { pools } = usePools();
  const [projects, setProjects] = useState<MachineProjects[] | null>(null);
  useEffect(() => {
    let current = true;
    getProjects().then((next) => { if (current) setProjects(next); }).catch(() => { if (current) setProjects([]); });
    return () => { current = false; };
  }, []);
  const pool = poolOf(target);
  const machines = pool !== null
    ? (pools ?? []).find((entry) => entry.id === pool)?.members.map((member) => member.machine) ?? []
    : isMachine(target) ? [target] : [];
  const pathsOn = (machine: string) => {
    const found = projects?.find((entry) => entry.machine === machine);
    return (found?.repos ?? []).filter((repo) => !repo.bare).map((repo) => tilde(repo.path, found?.homeDir ?? ''));
  };
  const [first, ...rest] = machines;
  const paths = first === undefined ? [] : pathsOn(first).filter((path) => rest.every((machine) => pathsOn(machine).includes(path)));
  const hint = pool !== null
    ? (paths.length ? t('automations.form.projectHintPool') : t('automations.form.projectHintPoolNone'))
    : paths.length ? t('automations.form.projectHint') : t('automations.form.projectHintNone');
  return (
    <Field label={t('automations.fact.project')} htmlFor="automation-project" hint={hint}>
      <Input
        id="automation-project"
        font="mono"
        list={listId}
        value={value}
        disabled={!target || target === BEST}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('automations.form.projectPlaceholder')}
      />
      <datalist id={listId}>{paths.map((path) => <option key={path} value={path} />)}</datalist>
    </Field>
  );
}

/** The schedule's fields. `value` is none for a copy whose original's schedule couldn't be read, until one is picked. */
function ScheduleField({ value, copied = false, onChange }: { value: ScheduleChoice | null; copied?: boolean; onChange: (choice: ScheduleChoice) => void }) {
  const { t } = useI18n();
  const kindWords = (kind: ScheduleChoice['kind']) => t(`automations.form.schedule.${kind}`);
  if (!value) {
    return (
      <Field label={t('automations.fact.schedule')} hint={<span className="text-warning-foreground">{t(copied ? 'automations.form.schedule.copyHint' : 'automations.form.needSchedule')}</span>}>
        <Select value={null} onValueChange={(next) => onChange(switchSchedule(DEFAULT_PICKED, (next ?? 'daily') as ScheduleChoice['kind']))}>
          <SelectTrigger aria-label={t('automations.fact.schedule')}><SelectValue>{t('automations.form.schedule.pick')}</SelectValue></SelectTrigger>
          <SelectPopup>{SCHEDULE_KINDS.map((kind) => <SelectItem key={kind} value={kind}>{kindWords(kind)}</SelectItem>)}</SelectPopup>
        </Select>
      </Field>
    );
  }
  const time = 'hour' in value ? `${twoDigits(value.hour)}:${twoDigits(value.minute)}` : '';
  const setTime = (text: string) => {
    const [hour, minute] = text.split(':').map(Number);
    if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return;
    if ('hour' in value) onChange({ ...value, hour, minute });
  };
  return (
    <Field label={t('automations.fact.schedule')} hint={value.kind === 'custom' ? t('automations.form.schedule.customHint') : scheduleWords(choiceSummary(value), t)}>
      <Select value={value.kind} onValueChange={(next) => onChange(switchSchedule(value, (next ?? 'hourly') as ScheduleChoice['kind']))}>
        <SelectTrigger aria-label={t('automations.fact.schedule')}><SelectValue>{kindWords(value.kind)}</SelectValue></SelectTrigger>
        <SelectPopup>{SCHEDULE_KINDS.map((kind) => <SelectItem key={kind} value={kind}>{kindWords(kind)}</SelectItem>)}</SelectPopup>
      </Select>
      {value.kind === 'everyMinutes' ? (
        <ChoiceSelect label={t('automations.form.schedule.every')} value={value.minutes} choices={MINUTE_CHOICES} words={(minutes) => t('automations.form.minutes', { count: minutes })} onChange={(minutes) => onChange({ ...value, minutes })} />
      ) : null}
      {value.kind === 'hourly' ? (
        <div className="grid grid-cols-2 gap-2">
          <ChoiceSelect label={t('automations.form.schedule.every')} value={value.hours} choices={HOUR_CHOICES} words={(hours) => t('automations.form.everyHours', { count: hours })} onChange={(hours) => onChange({ ...value, hours })} />
          <ChoiceSelect label={t('automations.form.schedule.minute')} value={value.minute} choices={[0, 5, 10, 15, 20, 30, 45]} words={(minute) => t('automations.form.atMinute', { minute: twoDigits(minute) })} onChange={(minute) => onChange({ ...value, minute })} />
        </div>
      ) : null}
      {value.kind === 'weekly' ? (
        <ToggleGroup
          multiple
          aria-label={t('automations.form.schedule.days')}
          value={value.days.map(String)}
          onValueChange={(next: unknown[]) => {
            const days = next.map(Number).filter((day) => day >= 0 && day <= 6).sort((left, right) => left - right);
            if (days.length) onChange({ ...value, days });
          }}
          className="w-full"
        >
          {DAY_SHORT.map((key, day) => <Toggle key={key} value={String(day)} className="flex-1 px-0">{t(key)}</Toggle>)}
        </ToggleGroup>
      ) : null}
      {'hour' in value ? (
        <Input type="time" aria-label={t('automations.form.schedule.time')} value={time} onChange={(event) => setTime(event.target.value)} />
      ) : null}
      {value.kind === 'custom' ? (
        <Input font="mono" aria-label={t('automations.form.schedule.rule')} value={value.rrule} onChange={(event) => onChange({ kind: 'custom', rrule: event.target.value })} placeholder={t('automations.form.schedule.rulePlaceholder')} />
      ) : null}
    </Field>
  );
}

function PrecheckField({ value, timeout, onChange, onTimeoutChange }: { value: string; timeout: number; onChange: (value: string) => void; onTimeoutChange: (seconds: number) => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="automation-precheck">{t('automations.fact.precheck')}</Label>
        <div className="w-28">
          <ChoiceSelect
            label={t('automations.form.precheckTimeout')}
            value={timeout}
            choices={TIMEOUT_CHOICES}
            words={(seconds) => (seconds < 60 ? t('automations.form.seconds', { count: seconds }) : t('automations.form.minutes', { count: seconds / 60 }))}
            onChange={onTimeoutChange}
          />
        </div>
      </div>
      <Textarea
        id="automation-precheck"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('automations.form.precheckPlaceholder')}
        className="min-h-20 font-mono text-xs"
        spellCheck={false}
      />
      <p className="text-xs text-muted-foreground">{t('automations.precheck.explain')}</p>
    </div>
  );
}

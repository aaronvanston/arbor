import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/resources';
import { cn } from '../../lib/utils';
import { invokeCommand } from '../../native/commands';
import type { Automation, AutomationAccess, AutomationAgent, AutomationInput, AutomationSession, AutomationWorkspace, MachineProjects } from '../../native/types';
import {
  choiceSummary,
  loadAutomations,
  scheduleChoice,
  scheduleRule,
  scheduleWords,
  switchSchedule,
  type ScheduleChoice,
} from '../../services/automations';
import { useFleetMachines } from '../../services/fleetHealth';
import { getProjects, tilde } from '../../services/setupProjects';
import { MachinePill, ProviderMark } from '../identity/Identity';
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
  agent: AutomationAgent;
  machine: string;
  projectPath: string;
  workspace: AutomationWorkspace;
  session: AutomationSession;
  access: AutomationAccess;
  schedule: ScheduleChoice;
  graceMinutes: number;
  precheck: string;
  precheckTimeoutSecs: number;
  enabled: boolean;
};

const BEST = 'best';

const emptyForm = (machine: string): Form => ({
  name: '',
  prompt: '',
  agent: 'claude',
  machine,
  projectPath: '',
  workspace: 'checkout',
  session: 'fresh',
  access: 'edits',
  schedule: { kind: 'hourly', hours: 1, minute: 0 },
  graceMinutes: 60,
  precheck: '',
  precheckTimeoutSecs: 60,
  enabled: true,
});

const formFrom = (automation: Automation): Form => ({
  name: automation.summary.name,
  prompt: automation.prompt,
  agent: automation.summary.agent === 'codex' ? 'codex' : 'claude',
  machine: automation.summary.target.kind === 'best' ? BEST : automation.summary.machine ?? '',
  projectPath: automation.projectPath ?? '',
  workspace: automation.workspace,
  session: automation.session,
  access: automation.access,
  schedule: automation.rrule ? scheduleChoice(automation.rrule) : { kind: 'daily', hour: 9, minute: 0 },
  graceMinutes: automation.graceMinutes,
  precheck: automation.precheck ?? '',
  precheckTimeoutSecs: automation.precheckTimeoutSecs,
  enabled: automation.summary.enabled,
});

const GRACE_CHOICES = [15, 30, 60, 120, 360, 720, 1440];
const TIMEOUT_CHOICES = [15, 30, 60, 120, 300, 600];
const SCHEDULE_KINDS: readonly ScheduleChoice['kind'][] = ['everyMinutes', 'hourly', 'daily', 'weekdays', 'weekly', 'custom'];
const MINUTE_CHOICES = [5, 10, 15, 20, 30, 45];
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
export function AutomationDialog({ open, onOpenChange, editing, machine = null, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Arbor automation to edit, by its id; none for a new one. */
  editing?: string;
  /** The machine a new one starts on, as the list was narrowed to. */
  machine?: string | null;
  onSaved: (automation: Automation) => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>(editing ? 'review' : 'describe');
  const [description, setDescription] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(() => emptyForm(machine ?? ''));
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
        input: { description, ...(form.machine && form.machine !== BEST ? { machine: form.machine } : {}), ...(form.projectPath ? { projectPath: form.projectPath } : {}) },
      });
      setForm((current) => ({
        ...current,
        name: result.name,
        prompt: result.prompt,
        agent: result.agent === 'codex' ? 'codex' : 'claude',
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

  const problem = !form.name.trim() ? t('automations.form.needName')
    : !form.prompt.trim() ? t('automations.form.needPrompt')
      : !form.machine ? t('automations.form.needMachine')
        : form.machine === BEST ? t('automations.target.bestSoon')
          : !form.projectPath.trim() ? t('automations.form.needProject')
            : form.schedule.kind === 'custom' && !form.schedule.rrule.trim() ? t('automations.form.needRule')
              : null;

  const save = async () => {
    if (problem) return;
    setSaving(true);
    setError(null);
    const input: AutomationInput = {
      ...(editing ? { id: editing } : {}),
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      agent: form.agent,
      target: { kind: 'machine', name: form.machine },
      projectPath: form.projectPath.trim(),
      workspace: form.workspace,
      session: form.session,
      access: form.access,
      rrule: scheduleRule(form.schedule),
      graceMinutes: form.graceMinutes,
      ...(form.precheck.trim() ? { precheck: form.precheck.trim() } : {}),
      precheckTimeoutSecs: form.precheckTimeoutSecs,
      enabled: form.enabled,
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
              <DialogTitle>{t(editing ? 'automations.form.editTitle' : 'automations.form.newTitle')}</DialogTitle>
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
                  <MachineField machine={form.machine} onChange={(next) => update({ machine: next, projectPath: next === form.machine ? form.projectPath : '' })} />
                  <ProjectField machine={form.machine} value={form.projectPath} onChange={(projectPath) => update({ projectPath })} />
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
                  <ScheduleField value={form.schedule} onChange={(schedule) => update({ schedule })} />
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
              {!editing ? (
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

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (value: T) => void }) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next: unknown[]) => { const [picked] = next; if (typeof picked === 'string') onChange(picked as T); }}
      className="w-full"
    >
      {options.map(([option, words]) => <Toggle key={option} value={option} className="flex-1">{words}</Toggle>)}
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

const AGENTS: readonly AutomationAgent[] = ['claude', 'codex'];

function AgentField({ value, onChange }: { value: AutomationAgent; onChange: (agent: AutomationAgent) => void }) {
  const { t } = useI18n();
  return (
    <Field label={t('automations.fact.agent')}>
      <Select value={value} onValueChange={(next) => onChange((next ?? 'claude') as AutomationAgent)}>
        <SelectTrigger aria-label={t('automations.fact.agent')}>
          <SelectValue>
            <span className="inline-flex items-center gap-2"><ProviderMark provider={value} decorative />{t(`automations.agent.${value}`)}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {AGENTS.map((agent) => (
            <SelectItem key={agent} value={agent}>
              <span className="inline-flex items-center gap-2"><ProviderMark provider={agent} decorative />{t(`automations.agent.${agent}`)}</span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Field>
  );
}

function MachineField({ machine, onChange }: { machine: string; onChange: (machine: string) => void }) {
  const { t } = useI18n();
  const fleet = useFleetMachines();
  const names = useMemo(() => {
    const listed = (fleet ?? []).map((entry) => entry.machine);
    return machine && machine !== BEST && !listed.includes(machine) ? [...listed, machine] : listed;
  }, [fleet, machine]);
  return (
    <Field label={t('automations.fact.machine')} hint={machine === BEST ? t('automations.target.bestSoon') : t('automations.form.machineHint')}>
      <Select value={machine} onValueChange={(next) => onChange(String(next ?? ''))}>
        <SelectTrigger aria-label={t('automations.fact.machine')}>
          <SelectValue>
            {machine === BEST ? t('automations.target.best') : machine ? <MachinePill name={machine} size="sm" /> : <span className="text-muted-foreground">{t('automations.form.pickMachine')}</span>}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {names.map((name) => <SelectItem key={name} value={name}><MachinePill name={name} size="sm" /></SelectItem>)}
          {/* The load balancer will pick the machine; until it's there the choice is shown, but can't be taken. */}
          <SelectItem value={BEST} disabled>
            <span className="flex flex-col">
              <span>{t('automations.target.best')}</span>
              <span className="text-xs text-muted-foreground">{t('automations.target.bestSoonShort')}</span>
            </span>
          </SelectItem>
        </SelectPopup>
      </Select>
    </Field>
  );
}

/** The project's folder: one of the repos Arbor found on the machine, or a path typed in. */
function ProjectField({ machine, value, onChange }: { machine: string; value: string; onChange: (path: string) => void }) {
  const { t } = useI18n();
  const listId = useId();
  const [projects, setProjects] = useState<MachineProjects[] | null>(null);
  useEffect(() => {
    let current = true;
    getProjects().then((next) => { if (current) setProjects(next); }).catch(() => { if (current) setProjects([]); });
    return () => { current = false; };
  }, []);
  const found = projects?.find((entry) => entry.machine === machine);
  const paths = (found?.repos ?? []).filter((repo) => !repo.bare).map((repo) => tilde(repo.path, found?.homeDir ?? ''));
  return (
    <Field label={t('automations.fact.project')} htmlFor="automation-project" hint={paths.length ? t('automations.form.projectHint') : t('automations.form.projectHintNone')}>
      <Input
        id="automation-project"
        font="mono"
        list={listId}
        value={value}
        disabled={!machine}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('automations.form.projectPlaceholder')}
      />
      <datalist id={listId}>{paths.map((path) => <option key={path} value={path} />)}</datalist>
    </Field>
  );
}

function ScheduleField({ value, onChange }: { value: ScheduleChoice; onChange: (choice: ScheduleChoice) => void }) {
  const { t } = useI18n();
  const kindWords = (kind: ScheduleChoice['kind']) => t(`automations.form.schedule.${kind}`);
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

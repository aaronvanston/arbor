import { useSyncExternalStore } from 'react';
import type { MessageKey } from '../i18n/resources';
import { invokeCommand } from '../native/commands';
import type {
  AutomationList,
  AutomationScan,
  AutomationRunStatus,
  AutomationSource,
  AutomationSummary,
  ScheduleSummary,
} from '../native/types';
import { formatTime } from '../lib/format';
import type { StatusTone } from '../components/ui/status-dot';
import type { SystemNotification } from './notify';

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

// ── The list, shared by the page, the palette and each machine's page ─────────────────────────────────────────────

type AutomationsState = { list: AutomationList | null; error: string | null; loading: boolean };

let state: AutomationsState = { list: null, error: null, loading: false };
const listeners = new Set<() => void>();
const set = (next: Partial<AutomationsState>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** The list as a command returned it, for the commands that answer with the whole list. */
export const showAutomations = (list: AutomationList) => set({ list, error: null });

/** Reads the list Arbor holds; it doesn't look on the machines again (`scanAutomations` does). */
export async function loadAutomations() {
  set({ loading: true });
  try {
    set({ list: await invokeCommand('list_automations'), error: null, loading: false });
  } catch (error) {
    set({ error: String(error), loading: false });
  }
}

/** Looks for automations on `machine`, or on every machine, again. */
export async function scanAutomations(machine: string | null = null) {
  set({ loading: true });
  try {
    set({ list: await invokeCommand('scan_automations', { machine }), error: null, loading: false });
  } catch (error) {
    set({ error: String(error), loading: false });
  }
}

export function useAutomations(): AutomationsState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** Sent by the native side whenever an automation, a run or a machine's look changes. */
export const AUTOMATIONS_UPDATED_EVENT = 'automations-updated';

// ── Alerts ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** When each Arbor automation last ran, as the window last saw it, so only a run that's new can raise an alert. */
export type SeenRuns = Record<string, number>;

const ALERTING: readonly AutomationRunStatus[] = ['failed', 'unreachable'];

/**
 * The alerts for Arbor's runs that failed since `seen`, and what's seen now. The first look (`seen` null) only notes
 * where things stand, so opening Arbor doesn't announce old failures.
 */
export function failedRunAlerts(seen: SeenRuns | null, list: AutomationList, t: Translate): { seen: SeenRuns; alerts: SystemNotification[] } {
  const next: SeenRuns = {};
  const alerts: SystemNotification[] = [];
  for (const automation of list.automations) {
    if (automation.source !== 'arbor' || !automation.lastRun) continue;
    const { status, atMs } = automation.lastRun;
    next[automation.id] = atMs;
    if (!seen || (seen[automation.id] ?? 0) >= atMs || !ALERTING.includes(status)) continue;
    const machine = automation.machine ?? '';
    alerts.push({
      title: t('automations.alert.failedTitle', { name: automation.name }),
      body: t(status === 'unreachable' ? 'automations.alert.unreachableBody' : 'automations.alert.failedBody', { machine }),
      kind: 'automationFailed',
      subject: { automation: automation.id, ...(machine ? { machine } : {}) },
    });
  }
  return { seen: next, alerts };
}

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const DAY_KEYS: readonly MessageKey[] = [
  'automations.day.sunday', 'automations.day.monday', 'automations.day.tuesday', 'automations.day.wednesday',
  'automations.day.thursday', 'automations.day.friday', 'automations.day.saturday',
];

/** A time of day the way the rest of the app writes one. */
const timeOfDay = (hour: number, minute: number) => formatTime(new Date(2026, 0, 1, hour, minute));

const twoDigits = (value: number) => String(value).padStart(2, '0');

/** "Hourly at :15", "Daily at 5:00 pm", "Mondays at 10:00 am", "Every 30 minutes". */
export function scheduleWords(schedule: ScheduleSummary, t: Translate): string {
  switch (schedule.kind) {
    case 'everyMinutes': return t('automations.schedule.everyMinutes', { count: schedule.minutes });
    case 'everyHours': return schedule.hours === 1
      ? t('automations.schedule.hourly', { minute: twoDigits(schedule.minute) })
      : t('automations.schedule.everyHours', { count: schedule.hours, minute: twoDigits(schedule.minute) });
    case 'daily': return t('automations.schedule.daily', { time: timeOfDay(schedule.hour, schedule.minute) });
    case 'weekdays': return t('automations.schedule.weekdays', { time: timeOfDay(schedule.hour, schedule.minute) });
    case 'weekly': {
      const time = timeOfDay(schedule.hour, schedule.minute);
      const dayName = (day: number) => t(DAY_KEYS[day] ?? 'automations.day.sunday');
      const [only] = schedule.days;
      if (schedule.days.length === 1 && only !== undefined) return t('automations.schedule.weeklyOne', { day: dayName(only), time });
      return t('automations.schedule.weeklyDays', { days: schedule.days.map(dayName).join(', '), time });
    }
    case 'custom': return t('automations.schedule.custom');
    case 'elsewhere': return t('automations.schedule.elsewhere');
  }
}

export const SOURCE_LABEL: Record<AutomationSource, MessageKey> = {
  arbor: 'automations.source.arbor',
  codexApp: 'automations.source.codexApp',
  claudeDesktop: 'automations.source.claudeDesktop',
  orca: 'automations.source.orca',
};

export const RUN_STATUS_LABEL: Record<AutomationRunStatus, MessageKey> = {
  running: 'automations.run.running',
  done: 'automations.run.done',
  failed: 'automations.run.failed',
  skipped: 'automations.run.skipped',
  unreachable: 'automations.run.unreachable',
  missed: 'automations.run.missed',
  canceled: 'automations.run.canceled',
};

export const RUN_STATUS_TONE: Record<AutomationRunStatus, StatusTone> = {
  running: 'info',
  done: 'success',
  failed: 'error',
  skipped: 'muted',
  unreachable: 'warning',
  missed: 'warning',
  canceled: 'muted',
};


// ── Filtering ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Which automations by whether they run: on, paused, or on with a last run that failed. */
export type AutomationState = 'all' | 'on' | 'paused' | 'failing';

/** The list's switch, in order. Failed only joins it while something's failing. */
export const AUTOMATION_STATES: readonly AutomationState[] = ['on', 'paused', 'all', 'failing'];

export const STATE_LABEL: Record<AutomationState, MessageKey> = {
  all: 'automations.state.all',
  on: 'automations.state.on',
  paused: 'automations.state.paused',
  failing: 'automations.state.failing',
};

export type AutomationFilter = {
  search: string;
  source: AutomationSource | 'all';
  machine: string;
  /** Every one when left out. */
  state?: AutomationState;
  /** Every model when left out or `all`. */
  model?: string;
};

const inState = (item: AutomationSummary, state: AutomationState) => {
  switch (state) {
    case 'all': return true;
    case 'on': return item.enabled;
    case 'paused': return !item.enabled;
    // A paused one isn't failing: nothing more will go wrong until it's on again.
    case 'failing': return item.enabled && (item.lastRun?.status === 'failed' || item.lastRun?.status === 'unreachable');
  }
};

/** Everything but the state, so the switch can count what each of its choices would show. */
const matching = (automations: readonly AutomationSummary[], filter: AutomationFilter) => {
  const words = filter.search.trim().toLowerCase();
  return automations
    .filter((item) => filter.source === 'all' || item.source === filter.source)
    .filter((item) => !filter.model || filter.model === 'all' || item.model === filter.model)
    .filter((item) => !filter.machine || item.machine === filter.machine || item.target.kind !== 'machine')
    .filter((item) => !words || [item.name, item.project ?? '', item.machine ?? '', item.model ?? ''].some((text) => text.toLowerCase().includes(words)));
};

/**
 * The automations to list: the ones whose name, project, machine or model has the search in it, from the source
 * picked, in the state and with the model picked, that run on the machine picked (one a pool picks a member for when
 * it's due counts on every machine). Arbor's own first, then by name.
 */
export function filterAutomations(automations: readonly AutomationSummary[], filter: AutomationFilter): AutomationSummary[] {
  return matching(automations, filter)
    .filter((item) => inState(item, filter.state ?? 'all'))
    .sort((left, right) => Number(left.source !== 'arbor') - Number(right.source !== 'arbor') || left.name.localeCompare(right.name));
}

/** How many each state would list with the other filters as they are. */
export function stateCounts(automations: readonly AutomationSummary[], filter: AutomationFilter): Record<AutomationState, number> {
  const shown = matching(automations, filter);
  const count = (state: AutomationState) => shown.filter((item) => inState(item, state)).length;
  return { all: shown.length, on: count('on'), paused: count('paused'), failing: count('failing') };
}

/** The models automations run with, for the model filter. */
export const automationModels = (automations: readonly AutomationSummary[]): string[] =>
  [...new Set(automations.flatMap((item) => (item.model ? [item.model] : [])))].sort((left, right) => left.localeCompare(right));

/** The machines automations run on, for the breadcrumb's picker. */
export const automationMachines = (automations: readonly AutomationSummary[]) =>
  [...new Set(automations.flatMap((item) => (item.machine ? [item.machine] : [])))].sort((left, right) => left.localeCompare(right));

// ── Schedules as the dialog picks them ────────────────────────────────────────────────────────────────────────────

/** A schedule the dialog's controls can show; anything else is kept as its rule, `custom`. */
export type ScheduleChoice =
  | { kind: 'everyMinutes'; minutes: number }
  | { kind: 'hourly'; hours: number; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; days: number[]; hour: number; minute: number }
  | { kind: 'custom'; rrule: string };

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const WEEKDAYS = [1, 2, 3, 4, 5];

/** An RRULE's parts, with or without its `RRULE:` start, as the Codex app writes both. */
function ruleParts(rrule: string): Map<string, string> {
  const body = rrule.trim().replace(/^RRULE:/i, '');
  return new Map(body.split(';').flatMap((part) => {
    const [key, value] = part.split('=');
    return key && value !== undefined ? [[key.toUpperCase(), value.toUpperCase()] as [string, string]] : [];
  }));
}

const whole = (value: string | undefined, fallback: number) => {
  const number = Number(value);
  return value !== undefined && Number.isInteger(number) ? number : fallback;
};

/** The dialog's schedule for a rule, or `custom` with the rule for one it has no controls for. */
export function scheduleChoice(rrule: string): ScheduleChoice {
  const parts = ruleParts(rrule);
  const known = new Set(['FREQ', 'INTERVAL', 'BYHOUR', 'BYMINUTE', 'BYSECOND', 'BYDAY']);
  if ([...parts.keys()].some((key) => !known.has(key)) || whole(parts.get('BYSECOND'), 0) !== 0) return { kind: 'custom', rrule };
  const interval = whole(parts.get('INTERVAL'), 1);
  const minute = whole(parts.get('BYMINUTE'), 0);
  const hour = whole(parts.get('BYHOUR'), 0);
  const byday = parts.get('BYDAY');
  const days = byday ? byday.split(',').map((day) => BYDAY.indexOf(day as (typeof BYDAY)[number])) : [];
  if (days.includes(-1) || minute < 0 || minute > 59 || hour < 0 || hour > 23) return { kind: 'custom', rrule };
  switch (parts.get('FREQ')) {
    case 'MINUTELY':
      return parts.has('BYHOUR') || parts.has('BYMINUTE') || byday ? { kind: 'custom', rrule } : { kind: 'everyMinutes', minutes: interval };
    case 'HOURLY':
      return parts.has('BYHOUR') || byday ? { kind: 'custom', rrule } : { kind: 'hourly', hours: interval, minute };
    case 'DAILY':
      if (interval !== 1 || !parts.has('BYHOUR')) return { kind: 'custom', rrule };
      return byday ? weekly(days, hour, minute) : { kind: 'daily', hour, minute };
    case 'WEEKLY':
      if (interval !== 1 || !parts.has('BYHOUR') || !days.length) return { kind: 'custom', rrule };
      return weekly(days, hour, minute);
    default:
      return { kind: 'custom', rrule };
  }
}

function weekly(days: number[], hour: number, minute: number): ScheduleChoice {
  const sorted = [...new Set(days)].sort((left, right) => left - right);
  if (sorted.length === 7) return { kind: 'daily', hour, minute };
  if (sorted.join() === WEEKDAYS.join()) return { kind: 'weekdays', hour, minute };
  return { kind: 'weekly', days: sorted, hour, minute };
}

/** The rule a schedule is saved as. */
export function scheduleRule(choice: ScheduleChoice): string {
  switch (choice.kind) {
    case 'everyMinutes': return `FREQ=MINUTELY;INTERVAL=${Math.max(1, choice.minutes)}`;
    case 'hourly': return `FREQ=HOURLY;INTERVAL=${Math.max(1, choice.hours)};BYMINUTE=${choice.minute}`;
    case 'daily': return `FREQ=DAILY;BYHOUR=${choice.hour};BYMINUTE=${choice.minute}`;
    case 'weekdays': return `FREQ=WEEKLY;BYDAY=${WEEKDAYS.map((day) => BYDAY[day]).join(',')};BYHOUR=${choice.hour};BYMINUTE=${choice.minute}`;
    case 'weekly': return `FREQ=WEEKLY;BYDAY=${(choice.days.length ? choice.days : [1]).map((day) => BYDAY[day]).join(',')};BYHOUR=${choice.hour};BYMINUTE=${choice.minute}`;
    case 'custom': return choice.rrule.trim().replace(/^RRULE:/i, '');
  }
}

/** The words for a choice, as the list will show it once saved. */
export function choiceSummary(choice: ScheduleChoice): ScheduleSummary {
  switch (choice.kind) {
    case 'everyMinutes': return { kind: 'everyMinutes', minutes: choice.minutes };
    case 'hourly': return { kind: 'everyHours', hours: choice.hours, minute: choice.minute };
    case 'daily': return { kind: 'daily', hour: choice.hour, minute: choice.minute };
    case 'weekdays': return { kind: 'weekdays', hour: choice.hour, minute: choice.minute };
    case 'weekly': return { kind: 'weekly', days: choice.days, hour: choice.hour, minute: choice.minute };
    case 'custom': return { kind: 'custom' };
  }
}

/** A choice of another kind, keeping the time of day and minute it had. */
export function switchSchedule(choice: ScheduleChoice, kind: ScheduleChoice['kind']): ScheduleChoice {
  const hour = 'hour' in choice ? choice.hour : 9;
  const minute = 'minute' in choice ? choice.minute : 0;
  switch (kind) {
    case 'everyMinutes': return { kind, minutes: choice.kind === 'everyMinutes' ? choice.minutes : 30 };
    case 'hourly': return { kind, hours: choice.kind === 'hourly' ? choice.hours : 1, minute };
    case 'daily': return { kind, hour, minute };
    case 'weekdays': return { kind, hour, minute };
    case 'weekly': return { kind, days: choice.kind === 'weekly' ? choice.days : [1], hour, minute };
    case 'custom': return { kind, rrule: scheduleRule(choice) };
  }
}

// ── The background runner ─────────────────────────────────────────────────────────────────────────────────────────

/** Where a machine's background runner stands: what Settings shows and offers for it. */
export type RunnerState = 'ready' | 'outdated' | 'stopped' | 'missing' | 'unsupported' | 'unknown';

const versionParts = (version: string) => version.split(/[.-]/).map((part) => Number.parseInt(part, 10)).map((part) => (Number.isNaN(part) ? 0 : part));

/** Whether `version` is older than `than`, by its numbers. */
export function olderVersion(version: string, than: string): boolean {
  const [left, right] = [versionParts(version), versionParts(than)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const [a, b] = [left[index] ?? 0, right[index] ?? 0];
    if (a !== b) return a < b;
  }
  return false;
}

export function runnerState(scan: AutomationScan | undefined, bundled: string | null): RunnerState {
  const udian = scan?.udian;
  if (!udian) return 'unknown';
  if (!udian.version) return udian.target && bundled ? 'missing' : 'unsupported';
  if (!udian.live) return 'stopped';
  return bundled && olderVersion(udian.version, bundled) ? 'outdated' : 'ready';
}

/** Whether Arbor can put or update the runner Arbor carries on the machine. */
export const canInstallRunner = (state: RunnerState) => state === 'missing' || state === 'outdated' || state === 'stopped';

export const RUNNER_STATE_LABEL: Record<RunnerState, MessageKey> = {
  ready: 'automations.runner.state.ready',
  outdated: 'automations.runner.state.outdated',
  stopped: 'automations.runner.state.stopped',
  missing: 'automations.runner.state.missing',
  unsupported: 'automations.runner.state.unsupported',
  unknown: 'automations.runner.state.unknown',
};

export const RUNNER_STATE_TONE: Record<RunnerState, StatusTone> = {
  ready: 'success',
  outdated: 'warning',
  stopped: 'warning',
  missing: 'muted',
  unsupported: 'muted',
  unknown: 'muted',
};

/**
 * Whether an automation can run on its machine in the background, and why not when it can't: it has to name one
 * machine (a pool's member is picked by Arbor when it's due), follow one of the usual schedules, and the machine's
 * runner has to be there and answering. A runner that's only older still runs it.
 */
export function backgroundRunnerCheck(list: AutomationList | null, machine: string | null, scheduleKind: string): MessageKey | null {
  if (!machine) return 'automations.runsOn.why.pool';
  if (scheduleKind === 'custom') return 'automations.runsOn.why.custom';
  const state = runnerState(list?.scans.find((scan) => scan.machine === machine), list?.udianBundled ?? null);
  if (state === 'ready' || state === 'outdated') return null;
  return 'automations.runsOn.why.notSetUp';
}

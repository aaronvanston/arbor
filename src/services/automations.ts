import { useSyncExternalStore } from 'react';
import type { MessageKey } from '../i18n/resources';
import { invokeCommand } from '../native/commands';
import type {
  AutomationList,
  AutomationScan,
  AutomationRunStatus,
  AutomationSource,
  AutomationSummary,
  Harness,
  MachinePool,
  ScheduleSummary,
} from '../native/types';
import { formatTime } from '../lib/format';
import type { StatusTone } from '../components/ui/status-dot';
import { compareVersions } from './agentVersions';
import { savedStore } from './savedStore';
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

/**
 * Why an Arbor automation has nowhere to run, or null when it has: its target is the old "Best machine", which Arbor no
 * longer picks for it, or a pool that's been removed. Each of its runs would fail until it's given another. A pool is
 * only called gone once the pools have been read.
 */
export function automationTargetGone(item: Pick<AutomationSummary, 'source' | 'target'>, pools: readonly MachinePool[] | null): 'best' | 'pool' | null {
  const { source, target } = item;
  if (source !== 'arbor') return null;
  if (target.kind === 'best') return 'best';
  if (target.kind === 'pool' && pools && !pools.some((pool) => pool.id === target.id)) return 'pool';
  return null;
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
    case 'manual': return t('automations.schedule.manual');
    case 'elsewhere': return t('automations.schedule.elsewhere');
  }
}

type AutomationApp = {
  label: MessageKey;
  /** What an automation's page says about the app keeping it; Arbor's own say where they run instead. */
  note: MessageKey | null;
  /** Offered as a filter only once it's found on a machine, like any other app's feature. */
  whenFound: boolean;
};

/**
 * The apps that keep automations (`automations/apps/` on the native side), in the filter's order. A new app is an
 * entry here, its mark in `AutomationApp.tsx` and its two strings.
 */
export const AUTOMATION_APPS: Record<AutomationSource, AutomationApp> = {
  arbor: { label: 'automations.source.arbor', note: null, whenFound: false },
  codexApp: { label: 'automations.source.codexApp', note: 'automations.note.codex', whenFound: false },
  claudeDesktop: { label: 'automations.source.claudeDesktop', note: 'automations.note.claude', whenFound: false },
  orca: { label: 'automations.source.orca', note: 'automations.note.orca', whenFound: true },
  superset: { label: 'automations.source.superset', note: 'automations.note.superset', whenFound: true },
  ultradian: { label: 'automations.source.ultradian', note: 'automations.note.ultradian', whenFound: true },
};

export const SOURCE_LABEL = (source: AutomationSource): MessageKey => AUTOMATION_APPS[source].label;

/**
 * What starts an automation when it's due, which the list's Runs in column and its filter go by: the app that keeps
 * it, except Arbor's own set to run on their machine, which ultradian, the background runner there, starts whether
 * Arbor is open or not.
 */
export const automationRunner = (item: Pick<AutomationSummary, 'source' | 'runsOn'>): AutomationSource =>
  item.source === 'arbor' && item.runsOn === 'machine' ? 'ultradian' : item.source;

/** The apps to filter by: every one listed always, the others once a machine has them, and the one picked. */
export function sourceChoices(scans: readonly AutomationScan[], picked: AutomationSource | 'all'): AutomationSource[] {
  // A machine with the background runner set up has ultradian, whether or not anyone made schedules in it there.
  const found = new Set(scans.flatMap((scan) => (scan.udian?.version ? [...scan.apps, 'ultradian' as const] : scan.apps)));
  return (Object.keys(AUTOMATION_APPS) as AutomationSource[]).filter((source) => !AUTOMATION_APPS[source].whenFound || found.has(source) || source === picked);
}

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
  /** What runs it (`automationRunner`). */
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
    .filter((item) => filter.source === 'all' || automationRunner(item) === filter.source)
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

/** A column the list can be sorted by, and which way. */
export type AutomationSort = { column: 'nextRun' | 'lastRun'; descending: boolean };

/**
 * The list in the order picked from a column, or as `filterAutomations` gave it. One with no time for the column
 * (paused, or never run) goes last either way.
 */
export function sortAutomations(automations: readonly AutomationSummary[], sort: AutomationSort | null): AutomationSummary[] {
  if (!sort) return [...automations];
  const time = (item: AutomationSummary) => (sort.column === 'nextRun' ? (item.enabled ? item.nextRunAtMs : null) : item.lastRun?.atMs ?? null);
  return [...automations].sort((left, right) => {
    const [a, b] = [time(left), time(right)];
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    return sort.descending ? b - a : a - b;
  });
}

// ── Folding automations of the same name together ─────────────────────────────────────────────────────────────────

/**
 * One row of the list: an automation, or a fold of the ones that share a name and what runs them (the same scan on
 * every machine), which opens onto them.
 */
export type AutomationRow =
  | { kind: 'item'; item: AutomationSummary; /** The fold it's listed under, while that's open. */ inGroup: string | null }
  | { kind: 'group'; key: string; items: AutomationSummary[] };

/**
 * Automations fold together when they have the same name, give or take case, spaces, hyphens and underscores
 * (`cofactor-scan`, `Cofactor scan`), and the same runner.
 */
export const automationGroupKey = (item: AutomationSummary) => `${automationRunner(item)}\n${item.name.trim().replace(/[\s_-]+/g, ' ').toLowerCase()}`;

/** Whether the list folds automations of the same name together; on until it's turned off, in this window. */
export const automationsGrouped = savedStore({
  key: 'arbor.automations.grouped.v1',
  parse: (raw) => (raw === null ? true : JSON.parse(raw) !== false),
  fallback: true,
  place: 'window',
});

export const automationRowId = (row: AutomationRow) => (row.kind === 'group' ? `group:${row.key}` : row.item.id);

/**
 * The list as rows. Folded, two or more of the same name and runner become one row where the first of them would be,
 * and an open fold lists them under it; unfolded, one row each, as given.
 */
export function automationRows(items: readonly AutomationSummary[], { grouped, open }: { grouped: boolean; open: ReadonlySet<string> }): AutomationRow[] {
  if (!grouped) return items.map((item) => ({ kind: 'item', item, inGroup: null }));
  const byKey = new Map<string, AutomationSummary[]>();
  for (const item of items) {
    const key = automationGroupKey(item);
    byKey.set(key, [...(byKey.get(key) ?? []), item]);
  }
  const rows: AutomationRow[] = [];
  const placed = new Set<string>();
  for (const item of items) {
    const key = automationGroupKey(item);
    const members = byKey.get(key) ?? [item];
    if (members.length < 2) {
      rows.push({ kind: 'item', item, inGroup: null });
      continue;
    }
    if (placed.has(key)) continue;
    placed.add(key);
    rows.push({ kind: 'group', key, items: members });
    if (open.has(key)) rows.push(...members.map((member): AutomationRow => ({ kind: 'item', item: member, inGroup: key })));
  }
  return rows;
}

/** What a fold's row says for its automations together. A value they don't all share is null with `varies`. */
export type AutomationGroupSummary = {
  machines: string[];
  schedule: { value: ScheduleSummary | null; varies: boolean };
  project: { value: string | null; varies: boolean };
  model: { value: string | null; varies: boolean };
  /** The soonest next run of the ones that are on. */
  nextRunAtMs: number | null;
  /** The newest last run of any of them. */
  lastRun: AutomationSummary['lastRun'];
  /** How many are on and whose last run failed or found the machine away. */
  failing: number;
  enabled: number;
};

const shared = <T,>(values: T[], same: (left: T, right: T) => boolean = Object.is): { value: T | null; varies: boolean } => {
  const [first] = values;
  if (first === undefined) return { value: null, varies: false };
  return values.every((value) => same(value, first)) ? { value: first, varies: false } : { value: null, varies: true };
};

export function automationGroupSummary(items: readonly AutomationSummary[]): AutomationGroupSummary {
  const on = items.filter((item) => item.enabled);
  const next = on.flatMap((item) => (item.nextRunAtMs === null ? [] : [item.nextRunAtMs]));
  const last = items.reduce<AutomationSummary['lastRun']>((newest, item) => (item.lastRun && (!newest || item.lastRun.atMs > newest.atMs) ? item.lastRun : newest), null);
  return {
    machines: [...new Set(items.flatMap((item) => (item.machine ? [item.machine] : [])))].sort((left, right) => left.localeCompare(right)),
    schedule: shared(items.map((item) => item.schedule), (left, right) => JSON.stringify(left) === JSON.stringify(right)),
    project: shared(items.map((item) => item.project)),
    model: shared(items.map((item) => item.model)),
    nextRunAtMs: next.length ? Math.min(...next) : null,
    lastRun: last,
    failing: on.filter((item) => item.lastRun?.status === 'failed' || item.lastRun?.status === 'unreachable').length,
    enabled: on.length,
  };
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
export type RunnerState = 'ready' | 'noSkill' | 'outdated' | 'stopped' | 'missing' | 'unsupported' | 'unknown';

/** Whether `version` is older than `than`. A release candidate comes before its release, so a machine on 0.3.0-rc.1 is
 *  offered 0.3.0. */
export const olderVersion = (version: string, than: string): boolean => compareVersions(version, than) < 0;

/** `skill` is the fingerprint of the skill this build carries with the runner, which a ready machine should have too. */
export function runnerState(scan: AutomationScan | undefined, bundled: string | null, skill: string | null = null): RunnerState {
  const udian = scan?.udian;
  if (!udian) return 'unknown';
  // A machine that could take the runner reads as not set up even when this build carries none: it's the build that
  // lacks it, not the machine, and Set up only shows when there's one to put there.
  if (!udian.version) return udian.target ? 'missing' : 'unsupported';
  if (!udian.live) return 'stopped';
  if (bundled && olderVersion(udian.version, bundled)) return 'outdated';
  return skill && udian.skill !== skill ? 'noSkill' : 'ready';
}

/** Whether putting the runner Arbor carries on a machine starts pruning its history: ultradian before 0.2 kept every
 *  run, and from 0.2 it keeps 30 days. Arbor's install keeps a copy first, and asks before it goes ahead. */
export const runnerPrunesHistory = (scan: AutomationScan | undefined): boolean =>
  Boolean(scan?.udian?.version && olderVersion(scan.udian.version, '0.2.0'));

/** Whether Arbor can put or update the runner Arbor carries on the machine. */
export const canInstallRunner = (state: RunnerState) => state === 'missing' || state === 'outdated' || state === 'stopped' || state === 'noSkill';

export const RUNNER_STATE_LABEL: Record<RunnerState, MessageKey> = {
  ready: 'automations.runner.state.ready',
  noSkill: 'automations.runner.state.noSkill',
  outdated: 'automations.runner.state.outdated',
  stopped: 'automations.runner.state.stopped',
  missing: 'automations.runner.state.missing',
  unsupported: 'automations.runner.state.unsupported',
  unknown: 'automations.runner.state.unknown',
};

export const RUNNER_STATE_TONE: Record<RunnerState, StatusTone> = {
  ready: 'success',
  // It runs automations all the same; agents there just don't know its command line.
  noSkill: 'success',
  outdated: 'warning',
  stopped: 'warning',
  missing: 'muted',
  unsupported: 'muted',
  unknown: 'muted',
};

/**
 * Whether an automation can run on its machine in the background, and why not when it can't: it has to name one
 * machine (a pool's member is picked by Arbor when it's due), follow one of the usual schedules, and the machine's
 * runner has to be there and answering. A runner that's only older still runs it. `machine` is null for a pool, and
 * empty while none is picked yet.
 */
export function backgroundRunnerCheck(list: AutomationList | null, machine: string | null, scheduleKind: string): MessageKey | null {
  if (machine === '') return 'automations.runsOn.why.noMachine';
  if (!machine) return 'automations.runsOn.why.pool';
  if (scheduleKind === 'custom') return 'automations.runsOn.why.custom';
  const state = runnerState(list?.scans.find((scan) => scan.machine === machine), list?.udianBundled ?? null);
  if (state === 'ready' || state === 'outdated') return null;
  return 'automations.runsOn.why.notSetUp';
}

// ── What stops Arbor's automations starting ───────────────────────────────────────────────────────────────────────

/** Why an Arbor automation that's on won't start when it's due: all of them are turned off, or it has no proxy key. */
export type AutomationHold = 'off' | 'noKey';

/** Agents an automation starts through the proxy (`proxy::routes`), which need the Automations key to run. */
const THROUGH_PROXY: ReadonlySet<Harness> = new Set<Harness>(['claude', 'codex']);

/**
 * What would stop an automation with this agent from starting, so its page, the list and the form can say so before a
 * run fails: Settings' switch for all of Arbor's automations, then the Automations key that Claude and Codex runs
 * reach the proxy with. Null when nothing does, or before the list is read.
 */
export function automationHold(list: Pick<AutomationList, 'running' | 'proxyKey'> | null, agent: Harness | null): AutomationHold | null {
  if (!list) return null;
  if (!list.running) return 'off';
  return !list.proxyKey && agent !== null && THROUGH_PROXY.has(agent) ? 'noKey' : null;
}

/** The hold on any of Arbor's own automations in the list, for one note above them all. */
export function automationsHold(list: AutomationList | null): AutomationHold | null {
  const arbor = list?.automations.filter((item) => item.source === 'arbor') ?? [];
  if (!list || !arbor.length) return null;
  if (!list.running) return 'off';
  return arbor.some((item) => item.enabled && automationHold(list, item.agent) === 'noKey') ? 'noKey' : null;
}

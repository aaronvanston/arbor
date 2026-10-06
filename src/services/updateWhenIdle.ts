import { useSyncExternalStore } from 'react';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import { compareVersions } from './agentVersions';
import { sleptBetween } from './machineAlerts';
import { holdReloadWhile } from './reloadHolds';
import type { LiveSessionsReport } from '../native/types';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/** How long no agent session has to have been running before an update waiting for them goes ahead. */
export const IDLE_UPDATE_WAIT_MS = 2 * 60_000;
/** While an update waits, the running sessions are checked this often, window shown or not. */
export const IDLE_UPDATE_CHECK_MS = 15_000;

/** The agent sessions running now and how many machines they're on, for warning before the proxy restarts. */
export type LiveAgentLoad = { sessions: number; machines: number };

/**
 * What's running now, from the latest live sessions check. Machines are counted from the sessions the report lists
 * (at most 12), their key's machine else their transcript's, so with more running it's the fewest they're on.
 */
export function liveAgentLoad(report: LiveSessionsReport | null): LiveAgentLoad {
  if (!report?.running) return { sessions: 0, machines: 0 };
  const machines = new Set(report.sessions.map((session) => session.machine || session.transcript?.machine || '').filter(Boolean));
  return { sessions: report.running, machines: machines.size };
}

/**
 * Whether installing Arbor restarts the proxy. The core keeps running while Arbor swaps itself, unless the new version
 * bundles a newer core than the one installed, which it swaps in at launch. Not knowing either version counts as a
 * restart.
 */
export function appUpdateRestartsProxy(bundledCoreVersion: string | null | undefined, installedCoreVersion: string | null | undefined) {
  if (!bundledCoreVersion || !installedCoreVersion) return true;
  return compareVersions(bundledCoreVersion.replace(/^v/, ''), installedCoreVersion.replace(/^v/, '')) > 0;
}

/**
 * Something that restarts the proxy, put off until the agents are idle: installing an Arbor version, installing a
 * core version (an update, or a `reinstall` of the one installed), or restarting the core.
 */
export type IdleUpdate =
  | { kind: 'app'; version: string }
  | { kind: 'core'; version: string; reinstall?: boolean }
  | { kind: 'restart' };

const isReinstall = (update: IdleUpdate) => update.kind === 'core' && update.reinstall === true;

export type IdleUpdateState = {
  /** At most one for Arbor and one for the core, the core's first: Arbor relaunching ends everything after it. */
  updates: IdleUpdate[];
  /** Since when the checks have found no session running; null while one is, or before the first check. */
  idleSinceMs: number | null;
  /** The last one that went ahead by itself and failed. */
  failure: { update: IdleUpdate; error: string } | null;
};

export const emptyIdleUpdates: IdleUpdateState = { updates: [], idleSinceMs: null, failure: null };

const forCore = (update: IdleUpdate) => update.kind !== 'app';
const coreFirst = (updates: IdleUpdate[]) => [...updates.filter(forCore), ...updates.filter((update) => !forCore(update))];

/**
 * Waits for idle agents to do `update`, in place of whatever was waiting for the same thing. A restart doesn't
 * replace a core install, which restarts the core anyway. The wait starts over: sessions were running to ask.
 */
export function withIdleUpdate(state: IdleUpdateState, update: IdleUpdate): IdleUpdateState {
  const same = state.updates.find((item) => forCore(item) === forCore(update));
  const kept = update.kind === 'restart' && same?.kind === 'core' ? same : update;
  return {
    updates: coreFirst([...state.updates.filter((item) => item !== same), kept]),
    idleSinceMs: null,
    failure: null,
  };
}

/**
 * What's left waiting once one of `kind` has started some other way: installing Arbor or a core version settles
 * whatever waited for the same, and a restart settles only a waiting restart.
 */
export function withoutSettled(state: IdleUpdateState, kind: IdleUpdate['kind']): IdleUpdateState {
  const updates = state.updates.filter((item) =>
    kind === 'app' ? item.kind !== 'app' : kind === 'core' ? !forCore(item) : item.kind !== 'restart');
  return updates.length === state.updates.length ? state : { ...state, updates, idleSinceMs: updates.length ? state.idleSinceMs : null };
}

/** Stops waiting, for everything. The last failure stays until it's dismissed. */
export function withoutIdleUpdates(state: IdleUpdateState): IdleUpdateState {
  return state.updates.length ? { ...state, updates: [], idleSinceMs: null } : state;
}

/**
 * Takes in a check of the running sessions, or null when it failed. A running session starts the wait over, and
 * so does a failed check, as one may have started. The wait counts from the first check that finds none.
 * Time this Mac spent asleep since the check before (`lastCheckMs`) isn't quiet time: no agent could reach the
 * proxy, so the wait starts over from the first check after it wakes.
 */
export function observeAgents(state: IdleUpdateState, running: number | null, nowMs: number, lastCheckMs: number | null = null): IdleUpdateState {
  if (!state.updates.length) return state;
  const slept = lastCheckMs !== null && sleptBetween(lastCheckMs, nowMs, IDLE_UPDATE_CHECK_MS);
  const idleSinceMs = running !== 0 ? null : slept ? nowMs : (state.idleSinceMs ?? nowMs);
  return idleSinceMs === state.idleSinceMs ? state : { ...state, idleSinceMs };
}

/** When what's waiting goes ahead, if no session runs before then; null until the checks find none. */
export const idleUpdateDueAtMs = (state: IdleUpdateState) =>
  state.updates.length && state.idleSinceMs !== null ? state.idleSinceMs + IDLE_UPDATE_WAIT_MS : null;

/** What goes ahead now, core first; nothing until no session has run for the whole wait. */
export function dueIdleUpdates(state: IdleUpdateState, nowMs: number): IdleUpdate[] {
  const dueAtMs = idleUpdateDueAtMs(state);
  return dueAtMs !== null && nowMs >= dueAtMs ? state.updates : [];
}

/** Keeps a failure from an update that went ahead by itself, to show until it's dismissed or another waits. */
export function withIdleUpdateFailure(state: IdleUpdateState, update: IdleUpdate, error: string): IdleUpdateState {
  return { ...state, failure: { update, error } };
}

/**
 * Why a waiting Arbor install can't go ahead now, or '' when it can: the last check has to have found the update,
 * and one this Mac can install by itself.
 */
export function idleAppUpdateBlocked(
  update: IdleUpdate,
  info: { updateAvailable: boolean; autoUpdateSupported: boolean } | null,
  t: Translate,
): string {
  if (update.kind !== 'app') return '';
  if (!info?.updateAvailable) return t('idleUpdate.failed.appMissing', { version: update.version });
  return info.autoUpdateSupported ? '' : t('idleUpdate.failed.appManual', { version: update.version });
}

/**
 * What an Arbor install that went ahead by itself came to, from its task's phase after it started: the error once it
 * failed, `settled` once it can't fail any more (installed, or canceled by hand), else null while it runs. It fails
 * after it has started, so only the task says so.
 */
export function idleAppUpdateOutcome(task: { phase: string; message: string | null }, t: Translate): { failed: string } | 'settled' | null {
  if (task.phase === 'failed') return { failed: task.message || t('appUpdate.phase.failed') };
  return task.phase === 'canceled' || task.phase === 'restarting' || task.phase === 'completed' ? 'settled' : null;
}

const confirmationKeys = {
  update: ['idleUpdate.confirm.update', 'idleUpdate.confirm.updateMachines', 'idleUpdate.updateWhenIdle', 'idleUpdate.updateNow'],
  reinstall: ['idleUpdate.confirm.reinstall', 'idleUpdate.confirm.reinstallMachines', 'idleUpdate.reinstallWhenIdle', 'idleUpdate.reinstallNow'],
  restart: ['idleUpdate.confirm.restart', 'idleUpdate.confirm.restartMachines', 'idleUpdate.restartWhenIdle', 'idleUpdate.restartNow'],
} satisfies Record<string, [MessageKey, MessageKey, MessageKey, MessageKey]>;

/** The warning before starting something that restarts the proxy under running sessions, with its buttons. */
export function idleUpdateConfirmation(update: IdleUpdate, load: LiveAgentLoad, t: Translate) {
  const [message, messageMachines, whenIdle, now] = confirmationKeys[update.kind === 'restart' ? 'restart' : isReinstall(update) ? 'reinstall' : 'update'];
  const spread = load.sessions > 1 && load.machines > 1;
  return {
    title: t(load.sessions === 1 ? 'idleUpdate.confirm.title.one' : 'idleUpdate.confirm.title.other', { count: load.sessions }),
    message: t(spread ? messageMachines : message, { machines: load.machines }),
    confirmText: t(whenIdle),
    secondaryText: t(now),
  };
}

/** The sidebar pill's and the waiting notice's title: a restart or a reinstall on its own isn't an update. */
export const idleUpdateTitleKey = (updates: IdleUpdate[]): MessageKey =>
  updates.every((update) => update.kind === 'restart')
    ? 'app.updatePill.restartWaiting'
    : updates.every((update) => update.kind === 'restart' || isReinstall(update)) ? 'app.updatePill.reinstallWaiting' : 'app.updatePill.waiting';

/** What's waiting, in a few words for the sidebar pill: Arbor first, as when they're only available. */
export const idleUpdatePillDetail = (updates: IdleUpdate[], t: Translate) => [...updates].reverse().map((update) =>
  update.kind === 'restart'
    ? t('app.updatePill.restart')
    : t(update.kind === 'app' ? 'app.updatePill.app' : update.reinstall ? 'app.updatePill.reinstall' : 'app.updatePill.core', { version: update.version }),
).join(' · ');

/** What's waiting, in a sentence. */
export function idleUpdateWaitingText(updates: IdleUpdate[], t: Translate) {
  const app = updates.find((update) => update.kind === 'app');
  const core = updates.find((update) => update.kind === 'core');
  const restart = updates.some((update) => update.kind === 'restart');
  if (app && core) return t(core.reinstall ? 'idleUpdate.waiting.appReinstall' : 'idleUpdate.waiting.appCore', { app: app.version, core: core.version });
  if (app) return t(restart ? 'idleUpdate.waiting.appRestart' : 'idleUpdate.waiting.app', { version: app.version });
  if (core) return t(core.reinstall ? 'idleUpdate.waiting.reinstall' : 'idleUpdate.waiting.core', { version: core.version });
  return restart ? t('idleUpdate.waiting.restart') : '';
}

/** The title of the notice for one that went ahead by itself and failed. */
export const idleUpdateFailureKey = (update: IdleUpdate): MessageKey =>
  update.kind === 'restart' ? 'idleUpdate.failed.restart' : isReinstall(update) ? 'idleUpdate.failed.reinstall' : 'idleUpdate.failed.update';

/**
 * The versions available that nothing waits to install, to say so beside what waits. Arbor installs its latest
 * whenever it goes ahead, so any Arbor install waiting covers it; a core install covers only its own version, so a
 * reinstall of the one installed leaves the update out.
 */
export function availableBesideWaiting(updates: IdleUpdate[], available: { app: string; core: string }) {
  return {
    app: available.app && !updates.some((update) => update.kind === 'app') ? available.app : '',
    core: available.core && !updates.some((update) => update.kind === 'core' && update.version === available.core) ? available.core : '',
  };
}

// Kept in memory only: a relaunch starts without anything waiting.
let current = emptyIdleUpdates;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getCurrent = () => current;
const setCurrent = (next: IdleUpdateState) => {
  if (next === current) return;
  current = next;
  listeners.forEach((listener) => listener());
};

// What waits is kept nowhere else, so the window doesn't reload while anything waits or a failure is still to be seen.
holdReloadWhile('update', () => current.updates.length > 0 || current.failure !== null);

// When the last check was taken in while something waited, to tell a sleep from a check that's merely late. Kept
// out of the state so a check that changes nothing doesn't re-render what shows the wait.
let lastCheckMs: number | null = null;

export const useIdleUpdates = () => useSyncExternalStore(subscribe, getCurrent, getCurrent);

export const scheduleIdleUpdate = (update: IdleUpdate) => {
  lastCheckMs = null;
  setCurrent(withIdleUpdate(current, update));
};
export const settleIdleUpdate = (kind: IdleUpdate['kind']) => setCurrent(withoutSettled(current, kind));
export const cancelIdleUpdates = () => setCurrent(withoutIdleUpdates(current));
export const recordAgentCheck = (running: number | null, nowMs: number) => {
  setCurrent(observeAgents(current, running, nowMs, lastCheckMs));
  lastCheckMs = current.updates.length ? nowMs : null;
};

/** Hands over what's due and stops waiting for it, so it only goes ahead once. */
export function takeDueIdleUpdates(nowMs: number): IdleUpdate[] {
  const due = dueIdleUpdates(current, nowMs);
  if (due.length) setCurrent(withoutIdleUpdates(current));
  return due;
}

export const recordIdleUpdateFailure = (update: IdleUpdate, error: string) =>
  setCurrent(withIdleUpdateFailure(current, update, error));
export const dismissIdleUpdateFailure = () => setCurrent(current.failure ? { ...current, failure: null } : current);

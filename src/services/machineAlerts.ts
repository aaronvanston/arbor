import type { MessageKey, MessageVariables } from '../i18n/resources';
import type { SystemNotification } from './notify';
import { formatDuration } from '../lib/format';
import type { MachineHealth } from '../native/types';
import { machineName } from './machineNames';

/**
 * Failing this long, a machine is announced as down. In the background each machine is checked once a
 * minute, so a dropped check or a quick reboot doesn't count.
 */
export const MACHINE_DOWN_AFTER_MS = 5 * 60_000;
/**
 * For this long after this Mac wakes, comes back online or starts Arbor, failed checks are put down to its
 * own network still coming up.
 */
export const SETTLE_AFTER_RESUME_MS = 60_000;
/** Monitor ticks this much later than due mean this Mac was asleep in between. */
export const SLEEP_GAP_MS = 60_000;
/** SSH errors can run long; the notification keeps the start. */
const ERROR_MAX = 160;

/** Per machine: since when its checks have been failing, and whether that was announced. */
export type MachineAlertState = Record<string, { downSinceMs: number; notified: boolean }>;
export type MachineAlert = {
  machine: string;
  kind: 'down' | 'up';
  downSinceMs: number;
  error: string | null;
  /** Why the check failed; null for a machine that's back. */
  failure: SshFailure | null;
};

/** What a failed check's error comes down to. */
export type SshFailure = 'hostKey' | 'auth' | 'dns' | 'refused' | 'timeout' | 'other';

const FAILURES: [SshFailure, RegExp][] = [
  // Checks accept a first host key on their own, so a key that fails to verify is one that changed.
  ['hostKey', /host key verification failed|remote host identification has changed|host key for .+ has changed|no \S+ host key is known/i],
  // SSH's own wording, which a script's "Permission denied" on a file doesn't have.
  ['auth', /permission denied \(|permission denied, please try again|too many authentication failures|no supported authentication methods/i],
  ['dns', /could not resolve hostname|name or service not known|nodename nor servname|name resolution|no address associated with hostname/i],
  ['refused', /connection refused/i],
  ['timeout', /timed out|timeout/i],
];

export function sshFailure(error: string | null): SshFailure {
  return FAILURES.find(([, pattern]) => pattern.test(error ?? ''))?.[0] ?? 'other';
}

/** A host key that changed or a login that's turned down stays that way until someone fixes it. */
export const needsFixing = (failure: SshFailure) => failure === 'hostKey' || failure === 'auth';

/** Whether this Mac slept between two monitor ticks meant to come `intervalMs` apart. */
export const sleptBetween = (lastTickMs: number, nowMs: number, intervalMs: number) => nowMs - lastTickMs > intervalMs + SLEEP_GAP_MS;

/** What this Mac's own network was doing, since a failed check can be its fault rather than the machine's. */
export type LocalNetwork = {
  offline: boolean;
  /** When this Mac last woke, came back online or started Arbor; null when that's not known. */
  resumedAtMs: number | null;
};

/**
 * Picks the machines to announce: down once checks have failed for {@link MACHINE_DOWN_AFTER_MS}, or at once
 * when the failure won't fix itself, and back once a machine announced as down answers again. Time counts
 * from the first failure seen since this Mac's network came up, so a sleep or a quit doesn't add to it.
 * While this Mac is offline or settling, and for checks that ran before it resumed, failures change nothing,
 * as with a machine not checked since a change. One no longer checked at all is forgotten.
 */
export function nextMachineNotifications(
  state: MachineAlertState,
  machines: MachineHealth[],
  nowMs: number,
  { offline, resumedAtMs }: LocalNetwork = { offline: false, resumedAtMs: null },
) {
  const next: MachineAlertState = {};
  const alerts: MachineAlert[] = [];
  const settling = offline || (resumedAtMs !== null && nowMs < resumedAtMs + SETTLE_AFTER_RESUME_MS);
  machines.forEach((machine) => {
    // The machine Arbor runs on can't report itself down.
    if (machine.local || machine.status === 'unconfigured') return;
    const previous = state[machine.machine];
    const stale = resumedAtMs !== null && (machine.lastAttemptAt ?? nowMs) < resumedAtMs;
    if (machine.status === 'pending' || (machine.status === 'unreachable' && (settling || stale))) {
      if (previous) next[machine.machine] = previous;
    } else if (machine.status === 'unreachable') {
      const failure = sshFailure(machine.error);
      // An unannounced count from before this Mac resumed ran while nothing was watching; it starts over.
      const kept = previous && (previous.notified || resumedAtMs === null || previous.downSinceMs >= resumedAtMs);
      const downSinceMs = kept ? previous.downSinceMs : nowMs;
      const due = !previous?.notified && (needsFixing(failure) || nowMs - downSinceMs >= MACHINE_DOWN_AFTER_MS);
      next[machine.machine] = { downSinceMs, notified: Boolean(previous?.notified) || due };
      if (due) alerts.push({ machine: machine.machine, kind: 'down', downSinceMs, error: machine.error, failure });
    } else if (previous?.notified) {
      alerts.push({ machine: machine.machine, kind: 'up', downSinceMs: previous.downSinceMs, error: null, failure: null });
    }
  });
  const changed = JSON.stringify(next) !== JSON.stringify(state);
  return { state: next, alerts, changed };
}

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

const clip = (text: string) => (text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1).trimEnd()}…` : text);

const REASONS: Record<Exclude<SshFailure, 'other'>, MessageKey> = {
  hostKey: 'machines.sshFailure.hostKey',
  auth: 'machines.sshFailure.auth',
  dns: 'machines.sshFailure.dns',
  refused: 'machines.sshFailure.refused',
  timeout: 'machines.sshFailure.timeout',
};

/**
 * A plain sentence for why checks fail, safe to send anywhere: unlike the error, it names no host, user or key.
 * Null when there's nothing plainer to say than that they failed.
 */
export const sshFailureReason = (failure: SshFailure, t: Translate) => (failure === 'other' ? null : t(REASONS[failure]));

/** What the Machines page says about a failing machine: the plain reason, or the error when there's none plainer. */
export function unreachableReason(error: string | null, t: Translate) {
  if (!error) return null;
  return sshFailureReason(sshFailure(error), t) ?? error;
}

/**
 * One notification for the machines that need fixing, one for those that went down and one for those that
 * came back. The phone gets the plain reason only; the error, which can name hosts, users or keys, stays on this Mac.
 */
export function machineNotifications(alerts: MachineAlert[], nowMs: number, t: Translate): SystemNotification[] {
  const list = (items: MachineAlert[]) => (items.length === 1
    ? machineName(items[0]!.machine)
    : t('quota.service.list', { items: items.slice(0, -1).map((item) => machineName(item.machine)).join(', '), last: machineName(items[items.length - 1]!.machine) }));
  const down = alerts.filter((alert) => alert.kind === 'down');
  const broken = down.filter((alert) => needsFixing(alert.failure ?? 'other'));
  const failing = down.filter((alert) => !needsFixing(alert.failure ?? 'other'));
  const up = alerts.filter((alert) => alert.kind === 'up');
  const messages: SystemNotification[] = [];
  const single = (alert: MachineAlert, fix: boolean): SystemNotification => {
    const reason = sshFailureReason(alert.failure ?? 'other', t);
    const time = formatDuration(nowMs - alert.downSinceMs);
    const body = reason === null
      ? t('notifications.machineDown.bodyNoReason', { time })
      : t(fix ? 'notifications.machineFix.body' : 'notifications.machineDown.body', { reason, time });
    return {
      title: t(fix ? 'notifications.machineFix.title' : 'notifications.machineDown.title', { machine: alert.machine }),
      body: alert.error ? t('notifications.machineDown.withError', { body, error: clip(alert.error) }) : body,
      ...(alert.error ? { phoneBody: body } : {}),
      kind: 'machineDown',
      urgent: true,
      subject: { machine: alert.machine },
    };
  };
  if (broken.length === 1) messages.push(single(broken[0]!, true));
  else if (broken.length > 1) {
    messages.push({
      title: t('notifications.machineFix.titleMany', { count: broken.length }),
      body: t('notifications.machineFix.bodyMany', { machines: list(broken) }),
      kind: 'machineDown',
      urgent: true,
      subject: { machines: broken.map((alert) => alert.machine) },
    });
  }
  if (failing.length === 1) messages.push(single(failing[0]!, false));
  else if (failing.length > 1) {
    messages.push({
      title: t('notifications.machineDown.titleMany', { count: failing.length }),
      body: t('notifications.machineDown.bodyMany', { machines: list(failing) }),
      kind: 'machineDown',
      urgent: true,
      subject: { machines: failing.map((alert) => alert.machine) },
    });
  }
  if (up.length === 1) {
    const [alert] = up;
    messages.push({
      title: t('notifications.machineUp.title', { machine: alert!.machine }),
      body: t('notifications.machineUp.body', { time: formatDuration(nowMs - alert!.downSinceMs) }),
      kind: 'machineUp',
      subject: { machine: alert!.machine },
    });
  } else if (up.length > 1) {
    messages.push({
      title: t('notifications.machineUp.titleMany', { count: up.length }),
      body: t('notifications.machineUp.bodyMany', { machines: list(up) }),
      kind: 'machineUp',
      subject: { machines: up.map((alert) => alert.machine) },
    });
  }
  return messages;
}

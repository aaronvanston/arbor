import type { MessageKey, MessageVariables } from '../i18n/resources';
import { formatDuration, formatWhen } from '../lib/format';
import type { ComputeForgotten, ComputeIssue, ComputeProviderId, ComputeProviderSnapshot, ComputeSandbox, ComputeSnapshot, ComputeStartBlock } from '../native/types';
import type { AlertSubject } from './alertHistory';
import {
  findLimit,
  formatHours,
  isActiveSandbox,
  LIMIT_LEVELS,
  limitShare,
  planHours,
  rateLimitedListStale,
  sandboxAgeMs,
  START_BLOCK_LABEL,
  type PlanHours,
} from './compute';
import { computeProviderName } from './computeHint';
import type { SystemNotification } from './notify';

/**
 * Compute's alerts as a pure function of the snapshot (components/ComputeAlerts.tsx runs it after every round).
 * Each problem alerts once while it lasts, across restarts too, and again only after it cleared and came back, as the
 * proxy checks do. A stopped sandbox is never a problem, and a teammate's is never Arbor's to alert about.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** A sandbox degraded this long alerts; a blip that clears in a round or two doesn't. */
export const DEGRADED_ALERT_MS = 5 * MINUTE_MS;
/** A key the provider says expires within this long alerts once, ahead of it. */
export const KEY_EXPIRY_WARNING_MS = 7 * DAY_MS;

export type ComputeProblem =
  | { kind: 'key'; provider: ComputeProviderId; expired: boolean }
  | { kind: 'keyExpiring'; provider: ComputeProviderId; expiresAtMs: number }
  | { kind: 'planHours'; provider: ComputeProviderId; hours: PlanHours }
  | { kind: 'startsBlocked'; provider: ComputeProviderId; block: ComputeStartBlock | null }
  | { kind: 'activeNearMax'; provider: ComputeProviderId; used: number; max: number }
  | { kind: 'forgotten'; provider: ComputeProviderId; sandbox: ComputeSandbox; reason: ComputeForgotten }
  | { kind: 'degraded'; provider: ComputeProviderId; sandbox: ComputeSandbox; issue: ComputeIssue; sinceMs: number }
  | { kind: 'sandboxError'; provider: ComputeProviderId; sandbox: ComputeSandbox };

type ProblemKind = ComputeProblem['kind'];

/** Problems read from the provider's limits, which a key without the scope for them can't judge. */
const LIMIT_PROBLEMS: ReadonlySet<ProblemKind> = new Set<ProblemKind>(['planHours', 'startsBlocked', 'activeNearMax']);
const KEY_PROBLEMS: ReadonlySet<ProblemKind> = new Set<ProblemKind>(['key', 'keyExpiring']);

/**
 * Plan hours' key names the period they reset at, when the provider says, so what was alerted in one period never
 * silences the next one's.
 */
const planHoursKey = (provider: ComputeProviderId, resetsAtMs: number | null) =>
  `${provider}:planHours${resetsAtMs === null ? '' : `:${resetsAtMs}`}`;

/** What makes a problem the same one as before: its provider, its kind, and for a sandbox's, the sandbox. */
export function computeProblemKey(problem: ComputeProblem): string {
  if (problem.kind === 'planHours') return planHoursKey(problem.provider, problem.hours.resetsAtMs);
  const sandbox = 'sandbox' in problem ? `:${problem.sandbox.id}` : '';
  return `${problem.provider}:${problem.kind}${sandbox}`;
}

const keyKind = (key: string) => key.split(':')[1] as ProblemKind | undefined;
const keyProvider = (key: string) => key.split(':')[0];

/**
 * Which of a provider's kinds of problem its last round couldn't judge: everything before its first round since launch
 * (Rust reports it `ok` with nothing listed until then), while it isn't answering, or while asking Arbor to slow down
 * has kept the list from being read a while (the figures are the last good ones); everything but the key once the key
 * is refused; and the limits' while the key can't read them. A provider asking to slow down over the CPU and memory
 * reads alone, with the list fresh, is judged as usual: no alert depends on those reads.
 */
function unjudged(provider: ComputeProviderSnapshot, nowMs: number): (kind: ProblemKind) => boolean {
  if (provider.status === 'refused') return (kind) => !KEY_PROBLEMS.has(kind);
  if (provider.checkedAtMs === null) return () => true;
  switch (provider.status) {
    case 'unreachable': return () => true;
    case 'rateLimited': return rateLimitedListStale(provider, nowMs) ? () => true : () => false;
    case 'limitsNeedScope': return (kind) => LIMIT_PROBLEMS.has(kind);
    case 'ok': return () => false;
  }
}

/** One provider's problems now, of the kinds its last round could judge. */
function providerProblems(provider: ComputeProviderSnapshot, nowMs: number): ComputeProblem[] {
  const id = provider.id;
  const problems: ComputeProblem[] = [];
  const expired = provider.keyExpiresAtMs !== null && provider.keyExpiresAtMs <= nowMs;
  if (provider.status === 'refused' || expired) problems.push({ kind: 'key', provider: id, expired });
  else if (provider.keyExpiresAtMs !== null && provider.keyExpiresAtMs - nowMs <= KEY_EXPIRY_WARNING_MS) {
    problems.push({ kind: 'keyExpiring', provider: id, expiresAtMs: provider.keyExpiresAtMs });
  }

  const hours = planHours(provider);
  if (hours && (hours.runsOutFirst || hours.share >= LIMIT_LEVELS.warning)) problems.push({ kind: 'planHours', provider: id, hours });
  if (provider.canStart === false) problems.push({ kind: 'startsBlocked', provider: id, block: provider.startBlock });
  const active = findLimit(provider, 'activeSandboxes');
  if (active && active.max !== null && (limitShare(active) ?? 0) >= LIMIT_LEVELS.warning) {
    problems.push({ kind: 'activeNearMax', provider: id, used: active.used, max: active.max });
  }

  for (const sandbox of provider.sandboxes) {
    if (!sandbox.mine || !isActiveSandbox(sandbox)) continue;
    if (sandbox.forgotten !== null) problems.push({ kind: 'forgotten', provider: id, sandbox, reason: sandbox.forgotten });
    if (sandbox.state === 'error') problems.push({ kind: 'sandboxError', provider: id, sandbox });
    else if (sandbox.issue !== null && sandbox.issueSinceMs !== null && nowMs - sandbox.issueSinceMs >= DEGRADED_ALERT_MS) {
      problems.push({ kind: 'degraded', provider: id, sandbox, issue: sandbox.issue, sinceMs: sandbox.issueSinceMs });
    }
  }
  const skip = unjudged(provider, nowMs);
  return problems.filter((problem) => !skip(problem.kind));
}

/** Every problem in the snapshot now. */
export const computeProblems = (snapshot: ComputeSnapshot, nowMs: number): ComputeProblem[] =>
  snapshot.providers.flatMap((provider) => providerProblems(provider, nowMs));

/**
 * Whether a round says nothing new about plan hours already alerted: with nothing running there's no run-out time, so
 * a run-out alerted earlier in the same period isn't over just because the sandboxes stopped for a while. A known
 * run-out after the reset, or a new period, does end it.
 */
function planHoursQuiet(provider: ComputeProviderSnapshot, key: string): boolean {
  const hours = planHours(provider);
  return hours !== null && hours.runOutAtMs === null && hours.share < LIMIT_LEVELS.warning && key === planHoursKey(provider.id, hours.resetsAtMs);
}

/**
 * Whether a sandbox alerted as forgotten is only at work again, not looked after. Rust holds the flag back while its
 * CPU is busy and says so, so one hovering at that line doesn't alert again each time it goes quiet. Anything else
 * that clears the flag (it stopped, its session is live again, it was given an auto-stop) ends the alert, and the
 * next time it looks forgotten is news.
 */
function forgottenHeldBack(provider: ComputeProviderSnapshot, key: string): boolean {
  const id = key.split(':')[2];
  return provider.sandboxes.some((sandbox) => sandbox.id === id && sandbox.forgottenHeld);
}

/**
 * The problems to alert about now, and the keys to remember: each alerts once when it appears and again only after
 * it was gone. What a round couldn't judge (a provider not read yet since launch or not answering, limits the key can't read, plan hours with
 * nothing running, a forgotten sandbox that's busy for a while) keeps what was remembered for it, so a provider that drops out for a minute, or sandboxes that
 * stop and start again, don't alert everything again. A provider no longer connected forgets its own.
 */
export function nextComputeAlerts(alerted: readonly string[], snapshot: ComputeSnapshot, nowMs: number): { alert: ComputeProblem[]; alerted: string[] } {
  const problems = computeProblems(snapshot, nowMs);
  const carried = alerted.filter((key) => {
    const provider = snapshot.providers.find((entry) => entry.id === keyProvider(key));
    const kind = keyKind(key);
    if (provider === undefined || kind === undefined) return false;
    return unjudged(provider, nowMs)(kind)
      || (kind === 'planHours' && planHoursQuiet(provider, key))
      || (kind === 'forgotten' && forgottenHeldBack(provider, key));
  });
  const keys = problems.map(computeProblemKey);
  return {
    alert: problems.filter((problem) => !alerted.includes(computeProblemKey(problem))),
    alerted: [...new Set([...keys, ...carried])],
  };
}

// ---------------------------------------------------------------------------
// The alerts as they're sent
// ---------------------------------------------------------------------------

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/** A sandbox as an alert subject: its provider and id, since ids are only unique within a provider. */
export const computeSandboxSubject = (provider: ComputeProviderId, sandboxId: string) => `${provider}/${sandboxId}`;

/** The provider and id back out of a sandbox subject, or null for anything else. */
export function parseComputeSandboxSubject(subject: string): { provider: string; sandbox: string } | null {
  const slash = subject.indexOf('/');
  return slash > 0 && slash < subject.length - 1 ? { provider: subject.slice(0, slash), sandbox: subject.slice(slash + 1) } : null;
}

/** The setting a key problem is fixed on: the provider's card on Settings › Compute. */
export const COMPUTE_KEY_SETTING = 'compute.providers';

export const ISSUE_LABEL: Record<ComputeIssue, MessageKey> = {
  diskPressure: 'compute.issue.diskPressure',
  memoryPressure: 'compute.issue.memoryPressure',
  crashed: 'compute.issue.crashed',
  setupFailed: 'compute.issue.setupFailed',
  other: 'compute.issue.other',
};

function sandboxSubject(problem: { provider: ComputeProviderId; sandbox: ComputeSandbox }): AlertSubject {
  return {
    sandbox: computeSandboxSubject(problem.provider, problem.sandbox.id),
    // The machine it was started from, so narrowing Alerts to that machine finds it.
    ...(problem.sandbox.machine ? { on: problem.sandbox.machine } : {}),
  };
}

/**
 * The alert for a problem that just appeared. Bodies hold only names, counts, times and words from the problem's kind,
 * never anything the provider wrote.
 */
export function computeAlertNotification(problem: ComputeProblem, t: Translate, nowMs: number): SystemNotification {
  const provider = computeProviderName(problem.provider);
  const when = (ms: number) => formatWhen(ms, { now: nowMs });
  switch (problem.kind) {
    case 'key':
      return {
        title: t(problem.expired ? 'compute.alerts.keyExpired.title' : 'compute.alerts.keyRefused.title', { provider }),
        body: t('compute.alerts.keyRefused.body', { provider }),
        kind: 'computeKey',
        urgent: true,
        subject: { compute: problem.provider, setting: COMPUTE_KEY_SETTING },
      };
    case 'keyExpiring':
      return {
        title: t('compute.alerts.keyExpiring.title', { provider }),
        body: t('compute.alerts.keyExpiring.body', { provider, when: when(problem.expiresAtMs) }),
        kind: 'computeKey',
        subject: { compute: problem.provider, setting: COMPUTE_KEY_SETTING },
      };
    case 'planHours': {
      const { hours } = problem;
      const left = formatHours(hours.left);
      const reset = hours.resetsAtMs === null ? null : when(hours.resetsAtMs);
      const runsOut = hours.runsOutFirst && hours.runOutAtMs !== null;
      return {
        title: runsOut && hours.runOutAtMs !== null
          ? t('compute.alerts.planHoursRunOut.title', { provider, when: when(hours.runOutAtMs) })
          : t('compute.alerts.planHoursUsed.title', { provider, percent: Math.round(hours.share * 100) }),
        body: runsOut
          ? t('compute.alerts.planHoursRunOut.body', { left, rate: formatHours(hours.perHour ?? 0), reset: reset ?? '' })
          : t(reset ? 'compute.alerts.planHoursUsed.body' : 'compute.alerts.planHoursUsed.bodyNoReset', { left, max: formatHours(hours.max), reset: reset ?? '' }),
        kind: 'computeLimit',
        urgent: hours.left <= 0,
        subject: { compute: problem.provider },
      };
    }
    case 'startsBlocked':
      return {
        title: t('compute.alerts.startsBlocked.title', { provider }),
        body: t('compute.alerts.startsBlocked.body', { reason: t(START_BLOCK_LABEL[problem.block ?? 'other']) }),
        kind: 'computeLimit',
        urgent: true,
        subject: { compute: problem.provider },
      };
    case 'activeNearMax':
      return {
        title: t('compute.alerts.activeNearMax.title', { provider, used: problem.used, max: problem.max }),
        body: t('compute.alerts.activeNearMax.body'),
        kind: 'computeLimit',
        subject: { compute: problem.provider },
      };
    case 'forgotten': {
      const { sandbox } = problem;
      const body = problem.reason === 'sessionEnded' && sandbox.session?.endedAtMs != null
        ? t('compute.alerts.forgotten.sessionEnded', { ago: formatDuration(nowMs - sandbox.session.endedAtMs) })
        : problem.reason === 'keptAlive'
          ? t('compute.alerts.forgotten.keptAlive', { age: formatDuration(sandboxAgeMs(sandbox, nowMs)) })
          : t('compute.alerts.forgotten.noAutoStop', { age: formatDuration(sandboxAgeMs(sandbox, nowMs)) });
      return { title: t('compute.alerts.forgotten.title', { name: sandbox.name }), body, kind: 'computeSandbox', subject: sandboxSubject(problem) };
    }
    case 'degraded':
      return {
        title: t('compute.alerts.degraded.title', { name: problem.sandbox.name }),
        body: t('compute.alerts.degraded.body', { issue: t(ISSUE_LABEL[problem.issue]), duration: formatDuration(nowMs - problem.sinceMs) }),
        kind: 'computeSandbox',
        subject: sandboxSubject(problem),
      };
    case 'sandboxError':
      return {
        title: t('compute.alerts.sandboxError.title', { name: problem.sandbox.name }),
        body: t('compute.alerts.sandboxError.body', { provider }),
        kind: 'computeSandbox',
        urgent: true,
        subject: sandboxSubject(problem),
      };
  }
}

import { invokeCommand } from '../native/commands';
import { compareVersions, runningAgents } from './agentVersions';
import type { AgentKind, ClientHour, ClientVersions, MachineHealth } from '../native/types';

/**
 * Careful agent updates: a new Claude Code or Codex goes on one machine first, and the proxy's records of its
 * requests (see `client_versions.rs`) say whether it fails more than the version the other machines still run, before
 * the rest are updated. Claude Code updates itself where auto-updates are on, so a machine that did is a trial too.
 */

export const getClientVersions = (fromMs: number, toMs: number) => invokeCommand('get_client_versions', { fromMs, toMs });

/** How far back versions are counted. */
export const ROLLOUT_DAYS = 7;
/** Requests a new version sends before it can look fine. */
export const TRIAL_MIN_REQUESTS = 100;
/** Requests it sends before it can look worse: a failure or two among the first few says little. */
export const WORSE_MIN_REQUESTS = 20;
/** Requests the other versions send before they're something to compare with. */
export const BASELINE_MIN_REQUESTS = 100;
/** A new version fails more when its rate is this much higher (a point), and far enough past chance (99%, one-sided). */
export const WORSE_MIN_GAP = 0.01;
const WORSE_Z = 2.33;

/**
 * The agent and version behind a request, from its User-Agent. Claude Code sends `claude-cli/<version> (…)` however
 * it was started; Codex names its surface first (`codex_cli_rs`, `codex_exec`, `codex-tui`). The Codex app is left
 * out: its version is the app's, and an agent update doesn't change it.
 */
export function agentVersion(userAgent: string): { agent: AgentKind; version: string } | null {
  const claude = /^claude-cli\/(\d[\w.+-]*)/i.exec(userAgent.trim());
  if (claude?.[1]) return { agent: 'claude', version: claude[1] };
  const codex = /^codex[-_][\w-]+\/(\d[\w.+-]*)/i.exec(userAgent.trim());
  if (codex?.[1]) return { agent: 'codex', version: codex[1] };
  return null;
}

export type Tally = { requests: number; failed: number; rateLimited: number };
const EMPTY: Tally = { requests: 0, failed: 0, rateLimited: 0 };
const add = (total: Tally, hour: Tally): Tally => ({
  requests: total.requests + hour.requests,
  failed: total.failed + hour.failed,
  rateLimited: total.rateLimited + hour.rateLimited,
});
/** Failures that weren't a rate limit. */
export const errorsOf = (tally: Tally) => tally.failed - tally.rateLimited;
export const shareOf = (count: number, requests: number) => (requests > 0 ? count / requests : 0);

/** A version's requests in the window, and the machines they came from. */
export type VersionUse = Tally & { version: string; machines: string[]; firstMs: number; lastMs: number };

type AgentHour = ClientHour & { version: string };

const agentHours = (data: ClientVersions, agent: AgentKind): AgentHour[] =>
  data.hours.flatMap((hour) => {
    const client = agentVersion(hour.userAgent);
    return client?.agent === agent ? [{ ...hour, version: client.version }] : [];
  });

/** Each version of an agent that sent requests in the window, the newest first. */
export function versionUses(data: ClientVersions, agent: AgentKind): VersionUse[] {
  const uses = new Map<string, VersionUse>();
  for (const hour of agentHours(data, agent)) {
    const use = uses.get(hour.version) ?? { ...EMPTY, version: hour.version, machines: [], firstMs: hour.hourMs, lastMs: hour.hourMs };
    uses.set(hour.version, {
      ...add(use, hour),
      version: hour.version,
      machines: hour.machine && !use.machines.includes(hour.machine) ? [...use.machines, hour.machine].sort() : use.machines,
      firstMs: Math.min(use.firstMs, hour.hourMs),
      lastMs: Math.max(use.lastMs, hour.hourMs),
    });
  }
  return [...uses.values()].sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Whether a new version's rate of something is higher than the others', by more than a point and past what chance
 * would give: a one-sided test of two proportions.
 */
export function rateWorse(count: number, requests: number, baseCount: number, baseRequests: number): boolean {
  if (requests < WORSE_MIN_REQUESTS || baseRequests <= 0) return false;
  const rate = count / requests;
  const baseRate = baseCount / baseRequests;
  if (rate - baseRate < WORSE_MIN_GAP) return false;
  const pooled = (count + baseCount) / (requests + baseRequests);
  const spread = Math.sqrt(pooled * (1 - pooled) * (1 / requests + 1 / baseRequests));
  return spread === 0 || (rate - baseRate) / spread >= WORSE_Z;
}

export type RolloutVerdict = 'waiting' | 'fine' | 'worse' | 'noBaseline';
export type WorseMeasure = 'errors' | 'rateLimits';

export type RolloutComparison = {
  /** When the new version sent its first request in the window (the hour it started), else null. */
  since: number | null;
  /** The new version's requests since then. */
  newer: Tally;
  /** The other versions' requests over the same hours, or, when they sent too few, over the hours before. */
  older: Tally;
  baseline: 'same' | 'before';
  verdict: RolloutVerdict;
  worse: WorseMeasure[];
};

/** Compares the newest version with every other version of the agent, over the hours since it arrived. */
export function compareNewest(data: ClientVersions, agent: AgentKind, newest: string): RolloutComparison {
  const hours = agentHours(data, agent);
  const first = hours.filter((hour) => hour.version === newest).reduce<number | null>((min, hour) => (min === null ? hour.hourMs : Math.min(min, hour.hourMs)), null);
  const newer = hours.filter((hour) => hour.version === newest).reduce(add, EMPTY);
  const others = hours.filter((hour) => hour.version !== newest && compareVersions(hour.version, newest) < 0);
  const same = others.filter((hour) => first === null || hour.hourMs >= first).reduce(add, EMPTY);
  const before = first === null ? EMPTY : others.filter((hour) => hour.hourMs < first).reduce(add, EMPTY);
  const [older, baseline] = same.requests >= BASELINE_MIN_REQUESTS || before.requests < BASELINE_MIN_REQUESTS ? [same, 'same' as const] : [before, 'before' as const];
  const worse: WorseMeasure[] = [];
  if (older.requests >= BASELINE_MIN_REQUESTS) {
    if (rateWorse(errorsOf(newer), newer.requests, errorsOf(older), older.requests)) worse.push('errors');
    if (rateWorse(newer.rateLimited, newer.requests, older.rateLimited, older.requests)) worse.push('rateLimits');
  }
  const verdict: RolloutVerdict = older.requests < BASELINE_MIN_REQUESTS ? 'noBaseline' : worse.length ? 'worse' : newer.requests < TRIAL_MIN_REQUESTS ? 'waiting' : 'fine';
  return { since: first, newer, older, baseline, verdict, worse };
}

export type RolloutMachine = {
  machine: string;
  version: string | null;
  running: number | null;
  reachable: boolean;
  /** What updates it there, the way it was installed. */
  command: string;
};

export type AgentRollout = {
  agent: AgentKind;
  /** The newest version installed anywhere in the fleet. */
  newest: string | null;
  /** The agent's latest release on npm, when it could be asked. */
  latest: string | null;
  /** Machines with it. */
  ahead: RolloutMachine[];
  /** Machines with an older version, or one Arbor couldn't read. */
  behind: RolloutMachine[];
  /** The version most of the machines behind run, the newest of a tie. */
  previous: string | null;
  /** Only while some machines are ahead and some behind. */
  comparison: RolloutComparison | null;
  uses: VersionUse[];
};

const reachable = (item: MachineHealth) => item.status !== 'unreachable' && item.status !== 'pending';

/**
 * Where an agent's rollout stands across the fleet. Null when no machine has it and no request came from it. `latest`
 * is its latest release, which only says whether there's something newer to try: a rollout is still between versions
 * the machines run.
 */
export function agentRollout(agent: AgentKind, machines: MachineHealth[], data: ClientVersions | null, latest: string | null = null): AgentRollout | null {
  const installed: RolloutMachine[] = machines.flatMap((item) => {
    const install = item.agents[agent];
    return install
      ? [{ machine: item.machine, version: install.version, running: runningAgents(item)?.[agent] ?? null, reachable: reachable(item), command: install.updateCommand }]
      : [];
  });
  const uses = data ? versionUses(data, agent) : [];
  if (!installed.length && !uses.length) return null;
  const newest = installed.reduce<string | null>((top, entry) => (entry.version && (!top || compareVersions(entry.version, top) > 0) ? entry.version : top), null);
  const ahead = installed.filter((entry) => newest !== null && entry.version === newest);
  const behind = installed.filter((entry) => !ahead.includes(entry));
  const counts = new Map<string, number>();
  for (const entry of behind) if (entry.version) counts.set(entry.version, (counts.get(entry.version) ?? 0) + 1);
  const previous = [...counts.entries()].sort(([a, left], [b, right]) => right - left || compareVersions(b, a))[0]?.[0] ?? null;
  const comparison = newest && ahead.length && behind.length && data ? compareNewest(data, agent, newest) : null;
  return { agent, newest, latest, ahead, behind, previous, comparison, uses };
}

/** Whether the fleet's newest is already the latest release. False while the release isn't known. */
export const atLatest = (rollout: AgentRollout) => Boolean(rollout.newest && rollout.latest && compareVersions(rollout.newest, rollout.latest) >= 0);

/**
 * The machine to try a new version on first: one that answers, running the fewest of the agent's sessions, since
 * those keep their version until they restart.
 */
export function trialMachine(rollout: AgentRollout): string | null {
  const candidates = [...rollout.ahead, ...rollout.behind].filter((entry) => entry.reachable);
  candidates.sort((a, b) => (a.running ?? 0) - (b.running ?? 0) || a.machine.localeCompare(b.machine));
  return candidates[0]?.machine ?? null;
}

/**
 * A command that puts a version back, for its user to run on the machine. Claude Code's installer takes a version;
 * Codex is installed from npm. Null for a version that isn't plain dots and letters, which no command should carry.
 */
export function rollbackCommand(agent: AgentKind, version: string): string | null {
  if (!/^\d[\w.+-]*$/.test(version)) return null;
  return agent === 'claude' ? `claude install ${version}` : `npm install -g @openai/codex@${version}`;
}

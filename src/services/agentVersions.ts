import { AGENT_KINDS } from './machineHealth';
import type { AgentKind, HealthStatus, LatestVersions, MachineHealth } from '../native/types';

const versionParts = (version: string) => {
  const [main = '', ...pre] = version.split('+')[0]!.split('-');
  return { main: main.split('.').map((part) => Number.parseInt(part, 10) || 0), pre: pre.join('-') };
};

/** Compares dotted versions part by part as numbers, so 2.1.281 is newer than 2.1.90. A pre-release comes before its release. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.main.length, right.main.length); index += 1) {
    const difference = (left.main[index] ?? 0) - (right.main[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return Math.sign(left.pre.localeCompare(right.pre, 'en', { numeric: true }));
}

/**
 * Each agent's version to be at: its latest release when npm said, else the newest in the fleet and a machine that has
 * it. `machine` is null for the release.
 */
export type NewestAgents = Record<AgentKind, { version: string; machine: string | null } | null>;

export function newestAgents(machines: MachineHealth[], latest: LatestVersions | null = null): NewestAgents {
  const newest: NewestAgents = { claude: null, codex: null };
  for (const item of machines) {
    for (const agent of AGENT_KINDS) {
      const version = item.agents[agent]?.version;
      const current = newest[agent];
      if (version && (!current || compareVersions(version, current.version) > 0)) newest[agent] = { version, machine: item.machine };
    }
  }
  for (const agent of AGENT_KINDS) {
    const release = latest?.[agent];
    // Once the release is known it's the mark, so a lone machine can be behind, and one ahead of it isn't.
    if (release) newest[agent] = { version: release, machine: null };
  }
  return newest;
}

export type AgentBehind = { agent: AgentKind; version: string; newest: string; machine: string | null };

/** The agents on a machine older than their latest release, or than the same agent elsewhere in the fleet when that's unknown. */
export function agentsBehind(item: MachineHealth, newest: NewestAgents): AgentBehind[] {
  return AGENT_KINDS.flatMap((agent) => {
    const version = item.agents[agent]?.version;
    const top = newest[agent];
    return version && top && compareVersions(version, top.version) < 0 ? [{ agent, version, newest: top.version, machine: top.machine }] : [];
  });
}

/** Agents running at the machine's last sample. Null while it's unreachable, since that sample is out of date. */
export function runningAgents(item: MachineHealth): Record<AgentKind, number> | null {
  const latest = item.latest;
  if (item.status === 'unreachable' || !latest || (latest.claudeRunning === null && latest.codexRunning === null)) return null;
  return { claude: latest.claudeRunning ?? 0, codex: latest.codexRunning ?? 0 };
}

/** One agent on one machine as Sync › Agents lists it: its version and the newer one to be at, not there, or not looked for yet. */
export type AgentVersionCell =
  | { state: 'installed'; version: string | null; newer: { version: string; machine: string | null } | null }
  | { state: 'missing' }
  | { state: 'unchecked' };

export type AgentVersionRow = {
  machine: string;
  status: HealthStatus;
  agents: Record<AgentKind, AgentVersionCell>;
  /** Each agent running at the last sample, null while that sample is out of date. */
  running: Record<AgentKind, number> | null;
};

/**
 * Each machine's agents side by side, in the order the machines come. A machine with no host is left out: nothing
 * checks its agents, so its row would only ever be empty.
 */
export function agentVersionRows(machines: MachineHealth[], newest: NewestAgents): AgentVersionRow[] {
  return machines.filter((item) => item.status !== 'unconfigured').map((item) => {
    const behind = agentsBehind(item, newest);
    const cell = (agent: AgentKind): AgentVersionCell => {
      const install = item.agents[agent];
      if (!install) return item.agents.checkedAt === null ? { state: 'unchecked' } : { state: 'missing' };
      const lag = behind.find((entry) => entry.agent === agent);
      return { state: 'installed', version: install.version, newer: lag ? { version: lag.newest, machine: lag.machine } : null };
    };
    return { machine: item.machine, status: item.status, agents: { claude: cell('claude'), codex: cell('codex') }, running: runningAgents(item) };
  });
}

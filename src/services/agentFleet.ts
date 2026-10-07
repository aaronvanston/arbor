import { atLatest, type AgentRollout, type RolloutMachine } from './agentRollout';
import { compareVersions } from './agentVersions';
import type { HarnessHomeRow } from './harnessHomes';
import type { AgentKind, Harness } from '../native/types';

/**
 * Sync › Agents as one list of agents, each with its machines under it, and what "update all" means for each: Claude
 * Code and Codex up to their latest release (or the fleet's newest while it isn't known), the other agents up to the
 * newest one the fleet runs, since Arbor doesn't know their releases.
 */

/** Where an agent stands across the fleet, as its card's header says it. */
export type AgentStanding =
  /** Some machines run a newer version than the rest, and its requests are being compared. */
  | 'trial'
  /** Every machine on one version, and it's the latest release. */
  | 'current'
  /** Every machine on one version, and a newer release is out. */
  | 'releaseOut'
  /** Machines on different versions, with nothing comparing them. */
  | 'mixed'
  /** One version everywhere, with no release known to compare it with. */
  | 'even'
  /** No machine's version could be read. */
  | 'unknown';

export function rolloutStanding(rollout: AgentRollout): AgentStanding {
  if (!rollout.newest) return 'unknown';
  if (rollout.behind.length) return rollout.comparison ? 'trial' : 'mixed';
  if (atLatest(rollout)) return 'current';
  return rollout.latest && compareVersions(rollout.latest, rollout.newest) > 0 ? 'releaseOut' : 'even';
}

/** The version "update all" brings Claude Code or Codex to: its latest release, else the fleet's newest. */
export const rolloutTarget = (rollout: AgentRollout): string | null =>
  rollout.latest && (!rollout.newest || compareVersions(rollout.latest, rollout.newest) > 0) ? rollout.latest : rollout.newest;

/** Whether a machine's version is older than a target, or couldn't be read, which an update would settle too. */
const below = (version: string | null, target: string | null) => target !== null && (version === null || compareVersions(version, target) < 0);

/** The machines "update all" runs on for Claude Code or Codex: each that answers and is below the target. */
export function rolloutTargets(rollout: AgentRollout): RolloutMachine[] {
  const target = rolloutTarget(rollout);
  return [...rollout.ahead, ...rollout.behind]
    .filter((entry) => entry.reachable && below(entry.version, target))
    .sort((a, b) => a.machine.localeCompare(b.machine));
}

/** Whether nobody in the fleet has run the version an update would bring yet, so it goes everywhere untried. */
export function untried(rollout: AgentRollout): boolean {
  const target = rolloutTarget(rollout);
  return target !== null && !rollout.ahead.some((entry) => entry.version === target);
}

/** Another agent (Pi, Droid…) across the fleet: its homes, the newest version any of them runs, and the ones behind it. */
export type HarnessGroup = {
  harness: Harness;
  rows: HarnessHomeRow[];
  newest: string | null;
  /** Homes on an older version than the newest, that Arbor can update. */
  behind: HarnessHomeRow[];
  /** Homes Arbor can update at all. One machine with several homes of an agent is updated once. */
  updatable: HarnessHomeRow[];
};

const onePerMachine = (rows: HarnessHomeRow[]) => rows.filter((row, index) => rows.findIndex((other) => other.machine === row.machine) === index);

/** The other agents' homes grouped by agent, in the order the rows come (the catalog's). */
export function harnessGroups(rows: HarnessHomeRow[]): HarnessGroup[] {
  const groups: HarnessGroup[] = [];
  for (const row of rows) {
    let group = groups.find((entry) => entry.harness === row.harness);
    if (!group) {
      group = { harness: row.harness, rows: [], newest: null, behind: [], updatable: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups.map((group) => {
    const newest = group.rows.reduce<string | null>((top, row) => (row.version && (!top || compareVersions(row.version, top) > 0) ? row.version : top), null);
    const updatable = onePerMachine(group.rows.filter((row) => row.updateCommand !== null));
    const behind = updatable.filter((row) => row.version !== null && newest !== null && compareVersions(row.version, newest) < 0);
    return { ...group, newest, behind, updatable };
  });
}

/**
 * What an agent card's update button brings up: the homes behind the newest, as Update everything does, so its count
 * agrees with the card's "behind"; every home Arbor can update once none is behind (a newer release may be out).
 */
export const harnessUpdateRows = (group: HarnessGroup): HarnessHomeRow[] => (group.behind.length ? group.behind : group.updatable);

/** One update "update everything" runs: an agent on a machine, with its command and the version it's on. */
export type FleetUpdate =
  | { kind: 'agent'; agent: AgentKind; machine: string; command: string; version: string | null }
  | { kind: 'harness'; harness: Harness; machine: string; command: string; version: string | null };

/**
 * Everything behind across the fleet, agent by agent: Claude Code and Codex below their target, then each other agent
 * below the newest the fleet runs. What's already current is left alone.
 */
export function fleetUpdates(rollouts: AgentRollout[], groups: HarnessGroup[]): FleetUpdate[] {
  return [
    ...rollouts.flatMap((rollout) =>
      rolloutTargets(rollout).map((entry): FleetUpdate => ({ kind: 'agent', agent: rollout.agent, machine: entry.machine, command: entry.command, version: entry.version })),
    ),
    ...groups.flatMap((group) =>
      group.behind.flatMap((row): FleetUpdate[] => (row.updateCommand ? [{ kind: 'harness', harness: row.harness, machine: row.machine, command: row.updateCommand, version: row.version }] : [])),
    ),
  ];
}

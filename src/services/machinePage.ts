import type { HealthStatus, MachineUsage, SetupMachine } from '../native/types';
import { setupChecks } from './setupChecks';
import { buildMatrix, homeKeys, machineDifferences, resolveReference } from './setupInventory';

/**
 * Where a machine's setup stands against the reference machine's: how many things differ, in which homes (most first,
 * as Sync › Checks counts them, one home at a time), and how many problems its last scan found.
 */
export type SetupStanding = {
  reference: string | null;
  differences: number;
  homes: { key: string; count: number }[];
  problems: number;
};

export function setupStanding(machines: SetupMachine[], name: string, chosenReference: string | null): SetupStanding {
  const reference = resolveReference(machines, chosenReference);
  const homes = homeKeys(machines)
    .map((key) => ({ key, count: machineDifferences(buildMatrix(machines, key, reference), name) }))
    .filter((home) => home.count > 0)
    .sort((a, b) => b.count - a.count);
  return {
    reference,
    differences: homes.reduce((sum, home) => sum + home.count, 0),
    homes,
    problems: setupChecks(machines).filter((check) => check.machine === name && check.level === 'problem').length,
  };
}

/**
 * Whether a machine's page opens on "Bring … in line", and whether its steps start folded. It's there for a machine
 * with no host, one never scanned, and one that differs from the reference or has problems; not for the reference
 * itself, nor before the scans have loaded. Its steps are open for a machine still being set up (no host, no scan) and
 * folded for one that's only drifted, so its health stays in sight.
 */
export function checklistOnPage(
  status: HealthStatus | null,
  scanned: SetupMachine | null,
  standing: SetupStanding,
  loaded: boolean,
  name: string,
): { show: boolean; folded: boolean } {
  if (!loaded || standing.reference === name) return { show: false, folded: false };
  const settingUp = status === 'unconfigured' || !scanned || (scanned.scannedAt === null && !scanned.homes.length);
  return { show: settingUp || standing.differences > 0 || standing.problems > 0, folded: !settingUp };
}

/** A machine's requests in the range, over every key pool it has: null when it made none. */
export function machineUsageTotal(items: MachineUsage[], machine: string): MachineUsage | null {
  const own = items.filter((item) => item.machine === machine);
  if (!own.length) return null;
  return own.reduce((total, item) => ({
    ...total,
    requests: total.requests + item.requests,
    tokens: total.tokens + item.tokens,
    success: total.success + item.success,
    failures: total.failures + item.failures,
    canceled: total.canceled + item.canceled,
    lastRequest: !total.lastRequest || (item.lastRequest && item.lastRequest > total.lastRequest) ? item.lastRequest : total.lastRequest,
  }), { machine, pool: '', requests: 0, tokens: 0, success: 0, failures: 0, canceled: 0, lastRequest: null as string | null });
}

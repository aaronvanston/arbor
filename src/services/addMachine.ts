import { invokeCommand } from '../native/commands';
import { saveMachineHosts } from './machineHealth';
import type { MachineHost, ThisMac } from '../native/types';

/**
 * Adding machines to the machine list, which the Machines page and every Sync view read from. This Mac comes first: its
 * scripts run here rather than over SSH, and it's filed under the name its sessions and setup already have.
 */

/** This Mac as the machine list names it, or would once it's added, and whether it's there yet. */
export const getThisMac = () => invokeCommand('get_this_mac');

/** The row that lists this Mac. The port isn't used: its scripts run here. */
export const thisMacHost = (thisMac: ThisMac): MachineHost => ({ machine: thisMac.name, endpoint: 'localhost', port: 22, enabled: true, source: '' });

/** Lists this Mac, unless it's there already, and gives the name it's listed under. */
export async function addThisMac(): Promise<string> {
  const thisMac = await getThisMac();
  if (!thisMac.listed) await saveMachineHosts([thisMacHost(thisMac)]);
  return thisMac.name;
}

const listeners = new Set<() => void>();

/** Opens the app's Add machine dialog, for a page with no other way to reach it. */
export function requestAddMachine() {
  for (const listener of listeners) listener();
}

/** Calls `listener` each time a page asks for the Add machine dialog; returns what stops it. */
export function onAddMachineRequest(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

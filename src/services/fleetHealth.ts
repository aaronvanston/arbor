import { useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { MachineHealth } from '../native/types';
import { useFleetBoard } from './fleetBoard';
import { homeMachines, type HomeMachine } from './homeOverview';
import { fetchMachineHealth, onMachineHostsSaved } from './machineHealth';
import { sharedStore } from './savedStore';

/** A machine's status changes slowly, and the sampler's rounds come every 5 seconds while Machines is open. */
const REFRESH_MS = 30_000;

const store = sharedStore<MachineHealth[] | null>(null);

/**
 * Every machine with a host, as the health sampler last saw it, for the sidebar, Home and the menu bar menu; null until
 * it's been read once. `FleetHealthMonitor` keeps it fresh.
 */
export const useFleetHealth = store.useValue;

/**
 * Every machine with its health and what its agents are doing now, from the live board, in Home's order; null until
 * health has been read once. Today's requests aren't read, so `today` is always null.
 */
export function useFleetMachines(): HomeMachine[] | null {
  const health = useFleetHealth();
  const { board } = useFleetBoard();
  return useMemo(() => (health ? homeMachines(health, [], board, board?.thisMachine ?? '') : null), [health, board]);
}

/**
 * Reads the machines' health now, then after the sampler's rounds at most every 30 seconds. The reads are passive, so
 * they leave the sampler on its background interval rather than the fast one Machines asks for. Returns what stops it.
 */
export function watchFleetHealth(): () => void {
  let disposed = false;
  let readAt = 0;
  const read = () => {
    readAt = Date.now();
    fetchMachineHealth(null, 1_000, true)
      .then((snapshot) => { if (!disposed) store.set(snapshot.machines); })
      // A failed first read still settles, so what waits on it says there's nothing rather than loading for good.
      .catch(() => { if (!disposed && store.get() === null) store.set([]); });
  };
  read();
  const unlisten = listen('machine-health-updated', () => { if (Date.now() - readAt >= REFRESH_MS) read(); });
  // A machine added or removed shows in the sidebar and Home at once, and again after the sampler's round that reads
  // it, rather than up to half a minute later.
  const stopSaved = onMachineHostsSaved(() => {
    read();
    readAt = 0;
  });
  return () => {
    disposed = true;
    stopSaved();
    void unlisten.then((stop) => stop()).catch(() => undefined);
  };
}

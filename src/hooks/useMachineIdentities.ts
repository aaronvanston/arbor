import { useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import { readFleetHealth } from '../services/machineHealth';
import { identitiesByMachine, type MachineIdentity } from '../services/machineIdentity';
import { replaceEqualDeep, useStoreSelector } from '../services/stableValue';

const HEALTH_UPDATED_EVENT = 'machine-health-updated';
/** A machine's model doesn't change; this only picks up machines that answer for the first time. */
const REFRESH_MS = 60_000;

let identities = new Map<string, MachineIdentity>();
let readAt = 0;
let reading = false;
const listeners = new Set<() => void>();
let unlisten: Promise<() => void> | null = null;

async function read() {
  if (reading) return;
  reading = true;
  readAt = Date.now();
  try {
    const snapshot = await readFleetHealth();
    // What a machine is rarely changes: a read that found the same ones tells no one, so every pill on screen stays put.
    const next = replaceEqualDeep(identities, identitiesByMachine(snapshot.machines));
    if (next === identities) return;
    identities = next;
    listeners.forEach((listener) => listener());
  } catch {
    // Machines keep the plain icon until a read works.
  } finally {
    reading = false;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!unlisten) {
    if (Date.now() - readAt >= REFRESH_MS) void read();
    unlisten = listen(HEALTH_UPDATED_EVENT, () => {
      if (Date.now() - readAt >= REFRESH_MS) void read();
    });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && unlisten) {
      const pending = unlisten;
      unlisten = null;
      void pending.then((stop) => stop());
    }
  };
}
const getIdentities = () => identities;

/**
 * What each machine is (a MacBook Pro, a Mac mini, a Linux box), for places that name machines without the health
 * snapshot at hand. One copy serves everything on screen, however many rows name a machine. Its reads are passive and
 * take no history, so they neither hold the sampler on its fast interval nor carry the charts' points.
 */
export function useMachineIdentities(): Map<string, MachineIdentity> {
  return useSyncExternalStore(subscribe, getIdentities, getIdentities);
}

/** What one machine is, from the same copy: a pill renders again only when its own machine's kind changes. */
export function useMachineKind(name: string): MachineIdentity['kind'] | undefined {
  return useStoreSelector(subscribe, getIdentities, (identities) => identities.get(name)?.kind);
}

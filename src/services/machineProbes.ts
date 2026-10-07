import { useSyncExternalStore } from 'react';
import type { MessageKey } from '../i18n/resources';
import { invokeCommand } from '../native/commands';
import type { MachineProbes } from '../native/types';
import type { StatusTone } from '../components/ui/status-dot';
import { compareVersions } from './agentVersions';

/** A machine's health probe as its row shows it. */
export type ProbeState = 'streaming' | 'starting' | 'none' | 'unknown';

/**
 * `unknown` when Grove isn't read or doesn't know the machine (no host yet); `starting` for a probe installed and not
 * followed yet, which is the next round's work, or past the allowance of streams.
 */
export function probeState(probes: MachineProbes | null, machine: string): ProbeState {
  if (!probes || probes.unavailable) return 'unknown';
  const probe = probes.machines.find((entry) => entry.machine === machine);
  if (!probe) return 'unknown';
  if (!probe.installed) return 'none';
  return probe.streaming ? 'streaming' : 'starting';
}

export const PROBE_STATE_LABEL: Record<ProbeState, MessageKey> = {
  streaming: 'machines.probe.state.streaming',
  starting: 'machines.probe.state.starting',
  none: 'machines.probe.state.none',
  unknown: 'machines.probe.state.unknown',
};

export const PROBE_STATE_TONE: Record<ProbeState, StatusTone> = {
  streaming: 'success',
  starting: 'warning',
  none: 'muted',
  unknown: 'muted',
};

/** A machine's probe is older than the release Arbor carries. A prerelease comes before its release. */
export function probeOutOfDate(probes: MachineProbes | null, machine: string): boolean {
  const probe = probes?.machines.find((entry) => entry.machine === machine);
  return Boolean(probes?.version && probe?.installed && probe.version && compareVersions(probe.version, probes.version) < 0);
}

/**
 * The row's button: Install where Grove reads a machine with no probe, Update where its probe is older than the one
 * Arbor carries (which Arbor also does by itself), and nothing where it's up to date or its release isn't known yet.
 */
export function probeAction(probes: MachineProbes | null, machine: string): 'install' | 'update' | null {
  const state = probeState(probes, machine);
  if (state === 'none') return 'install';
  if (state !== 'unknown' && probeOutOfDate(probes, machine)) return 'update';
  return null;
}

export const canRemoveProbe = (state: ProbeState) => state === 'streaming' || state === 'starting';

/** How long after a change the list is read again, so a new probe shows as streaming once the sampler follows it. */
const SETTLE_MS = 7_000;

let value: MachineProbes | null = null;
const listeners = new Set<() => void>();
let settle: ReturnType<typeof setTimeout> | null = null;

const set = (next: MachineProbes) => {
  value = next;
  listeners.forEach((listener) => listener());
};

/** Reads the list again. A failed read keeps the last one. */
export async function refreshMachineProbes(): Promise<void> {
  try {
    set(await invokeCommand('get_machine_probes'));
  } catch {
    // The list is only ever a label beside the readings; the next read tries again.
  }
}

/** Takes in what a change answered with, and reads again once the sampler has had a round to follow it. */
export function showMachineProbes(next: MachineProbes): void {
  set(next);
  if (settle !== null) clearTimeout(settle);
  settle = setTimeout(() => {
    settle = null;
    void refreshMachineProbes();
  }, SETTLE_MS);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // Read when a page that shows it opens; nothing polls it.
  if (listeners.size === 1) void refreshMachineProbes();
  return () => {
    listeners.delete(listener);
  };
};

const snapshot = () => value;

export const useMachineProbes = () => useSyncExternalStore(subscribe, snapshot, snapshot);

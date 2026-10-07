import { useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invokeCommand } from '../native/commands';
import type { KindCounts, MachineStanding, SyncStanding } from '../native/types';
import type { MessageKey } from '../i18n/resources';
import { SETUP_INVENTORY_UPDATED_EVENT } from './setupInventory';
import { replaceEqualDeep } from './stableValue';
import { storedSetupRepo, subscribeSetupRepo } from './setupSync';

/**
 * Where every machine stands against the setup repo. "In step" is worked out once, in Rust (`setup_standing.rs`), and
 * everything that says it reads this: Overview, the Repo strip, the Library's behind, the sidebar badge and `arbor
 * sync`. Nothing here decides it again; these are only ways to read and show it.
 *
 * One read is shared by every page and the sidebar: it follows the setup repo setting, and reads again when a scan of
 * machines or projects lands (a burst of them in two reads at most), or when something here asks after changing the repo.
 */

export const getSyncStanding = (repo: string) => invokeCommand('get_sync_standing', { repo });

const SETUP_PROJECTS_UPDATED_EVENT = 'setup-projects-updated';

export type StandingSnapshot = {
  /** The setup repo's folder, or null when none is chosen. */
  repoPath: string | null;
  standing: SyncStanding | null;
  /** Why the repo couldn't be read. */
  error: string | null;
  /** A read has come back (or there's no repo to read). */
  loaded: boolean;
};

let snapshot: StandingSnapshot = { repoPath: storedSetupRepo(), standing: null, error: null, loaded: storedSetupRepo() === null };
const listeners = new Set<() => void>();
let stopEvents: (() => void) | null = null;

/** Takes a new snapshot, keeping the old objects where nothing changed, and tells no one when nothing did. */
const tell = (next: StandingSnapshot) => {
  const kept = replaceEqualDeep(snapshot, next);
  if (kept === snapshot) return;
  snapshot = kept;
  listeners.forEach((listener) => listener());
};

let inFlight = false;
let again = false;

async function read() {
  const repoPath = storedSetupRepo();
  if (!repoPath) {
    tell({ repoPath: null, standing: null, error: null, loaded: true });
    return;
  }
  if (repoPath !== snapshot.repoPath) tell({ repoPath, standing: null, error: null, loaded: false });
  try {
    tell({ repoPath, standing: await getSyncStanding(repoPath), error: null, loaded: true });
  } catch (error) {
    tell({ repoPath, standing: null, error: String(error), loaded: true });
  }
}

/**
 * Reads the standing again. Scans land in bursts: an ask while a read is under way waits for it and makes one more
 * read after, so a burst costs two reads at most and no timers.
 */
export function reloadSyncStanding() {
  if (inFlight) {
    again = true;
    return;
  }
  inFlight = true;
  void read().finally(() => {
    inFlight = false;
    if (again) {
      again = false;
      reloadSyncStanding();
    }
  });
}

function start() {
  let disposed = false;
  const unlisten = [SETUP_INVENTORY_UPDATED_EVENT, SETUP_PROJECTS_UPDATED_EVENT].map((event) => listen(event, () => reloadSyncStanding()));
  const stopRepo = subscribeSetupRepo(() => reloadSyncStanding());
  reloadSyncStanding();
  stopEvents = () => {
    if (disposed) return;
    disposed = true;
    stopRepo();
    for (const stop of unlisten) void stop.then((off) => off()).catch(() => undefined);
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      stopEvents?.();
      stopEvents = null;
    }
  };
}

const get = () => snapshot;

/** The shared standing, read while anything on screen uses it. */
export const useSyncStanding = () => useSyncExternalStore(subscribe, get, get);

// ---------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------

/** A machine's standing, or null when the standing hasn't it. */
export const standingOf = (standing: SyncStanding | null, machine: string): MachineStanding | null =>
  standing?.machines.find((entry) => entry.machine === machine) ?? null;

/** The machines behind on the item with `key` (a Library row's key, or `project:owner/name`). */
export const machinesBehindOn = (standing: SyncStanding | null, key: string): string[] =>
  standing?.machines.filter((machine) => machine.behind.some((item) => item.key === key)).map((machine) => machine.machine) ?? [];

/** The machines behind the repo and answering, which bringing in line can reach. */
export const machinesBehind = (standing: SyncStanding | null): MachineStanding[] =>
  standing?.machines.filter((machine) => machine.state === 'behind') ?? [];

/** Each kind a machine is behind on, with its count, in the order they're listed. */
const KIND_WORDS: { kind: keyof KindCounts; one: MessageKey; other: MessageKey }[] = [
  { kind: 'files', one: 'sync.standing.count.files.one', other: 'sync.standing.count.files.other' },
  { kind: 'skills', one: 'sync.standing.count.skills.one', other: 'sync.standing.count.skills.other' },
  { kind: 'mcp', one: 'sync.standing.count.mcp.one', other: 'sync.standing.count.mcp.other' },
  { kind: 'hooks', one: 'sync.standing.count.hooks.one', other: 'sync.standing.count.hooks.other' },
  { kind: 'plugins', one: 'sync.standing.count.plugins.one', other: 'sync.standing.count.plugins.other' },
  { kind: 'projects', one: 'sync.standing.count.projects.one', other: 'sync.standing.count.projects.other' },
];

/** What a machine is behind on, as phrases: "2 files", "1 plugin". */
export function behindParts(counts: KindCounts): { key: MessageKey; count: number }[] {
  return KIND_WORDS.filter(({ kind }) => counts[kind] > 0).map(({ kind, one, other }) => ({ key: counts[kind] === 1 ? one : other, count: counts[kind] }));
}

/** A machine's standing in a few words, as the strips and the CLI say it. */
export function standingWords(machine: MachineStanding): { key: MessageKey; parts: { key: MessageKey; count: number }[] } {
  switch (machine.state) {
    case 'inStep': return { key: 'sync.standing.inStep', parts: [] };
    case 'notScanned': return { key: 'sync.standing.notScanned', parts: [] };
    case 'unreachable': return { key: 'sync.standing.unreachable', parts: [] };
    case 'behind': return { key: 'sync.standing.behind', parts: behindParts(machine.counts) };
  }
}

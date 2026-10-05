import { useSyncExternalStore } from 'react';
import { invokeCommand } from '../native/commands';
import type { LatestVersions } from '../native/types';
import { afterLaunch } from './launchSettle';

/** The native side keeps an answer an hour, so asking sooner gets the same one. */
const KNOWN_REFRESH_MS = 60 * 60 * 1000;
/** A failure is asked again after five minutes. */
const UNKNOWN_REFRESH_MS = 5 * 60 * 1000;

/** One answer the pages share, asked for while one of them shows it and not otherwise. */
function releaseStore<T>(ask: () => Promise<T>, unknown: T, known: (value: T) => boolean, same: (a: T, b: T) => boolean) {
  let value = unknown;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Whether a round of asking is under way: one ask in flight or the next one waiting. */
  let polling = false;
  const listeners = new Set<() => void>();

  /** Asks again, and tells the pages when the answer changed. A failed ask reads as unknown. */
  const refresh = async (): Promise<T> => {
    let next: T;
    try {
      next = await ask();
    } catch {
      next = unknown;
    }
    if (!same(next, value)) {
      value = next;
      listeners.forEach((listener) => listener());
    }
    return value;
  };

  const poll = async () => {
    const answer = await refresh();
    if (!listeners.size) {
      polling = false;
      return;
    }
    timer = setTimeout(() => void poll(), known(answer) ? KNOWN_REFRESH_MS : UNKNOWN_REFRESH_MS);
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (!polling) {
      polling = true;
      // The registries are on the network; at launch, Home's own reads go first.
      void afterLaunch().then(poll);
    }
    return () => {
      listeners.delete(listener);
      if (!listeners.size && timer !== null) {
        clearTimeout(timer);
        timer = null;
        polling = false;
      }
    };
  };

  return { refresh, subscribe, snapshot: () => value };
}

const UNKNOWN: LatestVersions = { claude: null, codex: null };

const latestStore = releaseStore(
  async (): Promise<LatestVersions> => {
    const answer = await invokeCommand('get_agent_latest_versions');
    return { claude: answer?.claude ?? null, codex: answer?.codex ?? null };
  },
  UNKNOWN,
  (latest) => Boolean(latest.claude && latest.codex),
  (a, b) => a.claude === b.claude && a.codex === b.codex,
);

export const refreshLatestVersions = latestStore.refresh;
export const useLatestAgentVersions = () => useSyncExternalStore(latestStore.subscribe, latestStore.snapshot, latestStore.snapshot);

const t3Store = releaseStore(
  async () => (await invokeCommand('get_t3_compatibility')) ?? null,
  null,
  (policies) => policies !== null,
  (a, b) => JSON.stringify(a) === JSON.stringify(b),
);

export const refreshT3Compatibility = t3Store.refresh;
const notWanted = () => () => {};
const nothing = () => null;
/** T3 Code's policies, asked for only while `wanted`: while the machine shown runs T3 Code. */
export const useT3Compatibility = (wanted: boolean) =>
  useSyncExternalStore(wanted ? t3Store.subscribe : notWanted, wanted ? t3Store.snapshot : nothing, wanted ? t3Store.snapshot : nothing);

import type { MessageKey } from '../i18n/resources';
import { invokeCommand } from '../native/commands';
import type {
  CleanupCache,
  CleanupGroup,
  CleanupHold,
  CleanupHome,
  CleanupLeftover,
  CleanupScan,
  ClearableKind,
  LeftoverKind,
  RestoreProblem,
  SetAsideItem,
} from '../native/types';

/**
 * A machine's clean-up (`cleanup.rs`): one read-only look at what could come off it, run when its page's Clean up
 * section is opened or refreshed and never on a timer, and what's been set aside there. Removing moves a thing aside on
 * the machine, never deletes it, so it happens at once with Undo; only Delete for good, inside the set-aside area, asks
 * first.
 */

export const getCleanup = (machine: string) => invokeCommand('get_machine_cleanup', { machine });
export const checkCleanup = (machine: string) => invokeCommand('check_machine_cleanup', { machine });
export const removeCleanup = (machine: string, items: { group: CleanupGroup; path: string }[]) => invokeCommand('remove_cleanup_items', { machine, items });
export const restoreSetAside = (machine: string, stamp: string, item: number | null = null) => invokeCommand('restore_set_aside', { machine, stamp, item });
export const deleteSetAside = (machine: string, items: Pick<SetAsideItem, 'stamp' | 'item'>[]) =>
  invokeCommand('delete_set_aside', { machine, items: items.map(({ stamp, item }) => ({ stamp, item })) });

/** Why an item has no Remove, as its button says. */
export const HOLD_REASON: Record<CleanupHold, MessageKey> = {
  sessions: 'machine.cleanup.hold.sessions',
  unmeasured: 'machine.cleanup.hold.unmeasured',
  outsideHome: 'machine.cleanup.hold.outsideHome',
};

export const CLEARABLE_KIND: Record<ClearableKind, MessageKey> = {
  logs: 'machine.cleanup.cache.logs',
  cache: 'machine.cleanup.cache.cache',
};

export const LEFTOVER_KIND: Record<LeftoverKind, MessageKey> = {
  launchAgent: 'machine.cleanup.leftover.launchAgent',
  systemdUnit: 'machine.cleanup.leftover.systemdUnit',
};

export const GROUP_LABEL: Record<CleanupGroup, MessageKey> = {
  home: 'machine.cleanup.kind.home',
  cache: 'machine.cleanup.kind.cache',
  leftover: 'machine.cleanup.kind.leftover',
};

export const RESTORE_PROBLEM: Record<RestoreProblem, MessageKey> = {
  taken: 'machine.cleanup.restore.taken',
  changed: 'machine.cleanup.restore.changed',
  gone: 'machine.cleanup.restore.gone',
  failed: 'machine.cleanup.restore.failed',
};

type Sized = { sizeKb: number | null };

/** Biggest first, then by path, so what frees the most is at the top. */
export function bySize<T extends Sized & { path: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (b.sizeKb ?? -1) - (a.sizeKb ?? -1) || a.path.localeCompare(b.path));
}

/** The kilobytes the items take, of those measured. */
export const totalKb = (items: readonly Sized[]) => items.reduce((sum, item) => sum + (item.sizeKb ?? 0), 0);

/** What the section shows, group by group, each biggest first. */
export type CleanupView = {
  homes: CleanupHome[];
  caches: CleanupCache[];
  leftovers: CleanupLeftover[];
  aside: SetAsideItem[];
  /** How many things could be removed now, and what they take. */
  removable: number;
  removableKb: number;
  asideKb: number;
  /** Nothing found in any group, and nothing set aside. */
  empty: boolean;
};

export function cleanupView(scan: CleanupScan): CleanupView {
  const homes = bySize(scan.homes);
  const caches = bySize(scan.caches);
  const leftovers = bySize(scan.leftovers);
  const free = [...homes, ...caches, ...leftovers].filter((item) => item.held === null);
  return {
    homes,
    caches,
    leftovers,
    aside: [...scan.aside].sort((a, b) => b.atMs - a.atMs || a.item - b.item),
    removable: free.length,
    removableKb: totalKb(free),
    asideKb: totalKb(scan.aside),
    empty: !scan.homes.length && !scan.caches.length && !scan.leftovers.length && !scan.agents.length && !scan.aside.length,
  };
}

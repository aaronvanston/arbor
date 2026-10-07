import type { MessageKey } from '../i18n/resources';
import { formatCount } from '../lib/format';
import { invokeCommand } from '../native/commands';
import type {
  ArchiveBlock,
  CleanupAgent,
  CleanupCache,
  CleanupGroup,
  CleanupHold,
  CleanupHome,
  CleanupLeftover,
  CleanupScan,
  ClearableKind,
  Harness,
  HomeArchive,
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
export const removeCleanup = (machine: string, items: { group: CleanupGroup; path: string }[], allowUnarchived = false) =>
  invokeCommand('remove_cleanup_items', { machine, items, allowUnarchived });
export const restoreSetAside = (machine: string, stamp: string, item: number | null = null) => invokeCommand('restore_set_aside', { machine, stamp, item });
export const uninstallAgent = (machine: string, path: string) => invokeCommand('uninstall_cleanup_agent', { machine, path });
export const deleteSetAside = (machine: string, items: Pick<SetAsideItem, 'stamp' | 'item'>[]) =>
  invokeCommand('delete_set_aside', { machine, items: items.map(({ stamp, item }) => ({ stamp, item })) });

/** Why an item has no Remove, as its button says. */
export const HOLD_REASON: Record<CleanupHold, MessageKey> = {
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
  agent: 'machine.cleanup.kind.agent',
};

/**
 * Whether uninstalling an agent takes a machine's last copy of Claude Code or Codex, on a machine Arbor routes work to
 * (one in a pool): its confirmation says the machine will no longer run it.
 */
/**
 * The copy of an agent's harness that runs instead once `agent`, the first on the PATH, comes off; none when it isn't
 * the first or no other copy is there.
 */
export function nextCopy(agents: readonly CleanupAgent[], agent: CleanupAgent): CleanupAgent | null {
  if (!agent.first) return null;
  return agents.find((other) => other !== agent && other.harness === agent.harness) ?? null;
}

/** A look this recent is what a removal from another page goes by; an older one is looked at again first. */
export const CLEANUP_FRESH_MS = 10 * 60_000;

export const scanIsFresh = (scan: CleanupScan, nowMs: number) => scan.scannedAtMs !== null && nowMs - scan.scannedAtMs < CLEANUP_FRESH_MS;

/** The home at `path` in a look, when it found one there. */
export const homeIn = (scan: CleanupScan, path: string) => scan.homes.find((home) => home.path === path) ?? null;

/** The copy of `harness` that runs on the machine: the first on its PATH. */
export const runningAgent = (scan: CleanupScan, harness: Harness) =>
  scan.agents.find((agent) => agent.harness === harness && agent.first) ?? scan.agents.find((agent) => agent.harness === harness) ?? null;

/** A home's folder that names one folder, rather than a pattern or where a variable points, which the clean-up can find. */
export const concreteHomePath = (path: string) => (path.startsWith('~/') || path.startsWith('/')) && !path.includes('*');

export const lastRoutedCopy = (agent: Pick<CleanupAgent, 'harness' | 'onlyCopy'>, routed: boolean) =>
  routed && agent.onlyCopy && (agent.harness === 'claude' || agent.harness === 'codex');

export const RESTORE_PROBLEM: Record<RestoreProblem, MessageKey> = {
  taken: 'machine.cleanup.restore.taken',
  changed: 'machine.cleanup.restore.changed',
  gone: 'machine.cleanup.restore.gone',
  failed: 'machine.cleanup.restore.failed',
};

/** Why none of a home's sessions count as archived, as its row says. */
export const ARCHIVE_BLOCK: Record<ArchiveBlock, MessageKey> = {
  off: 'machine.cleanup.archive.off',
  paused: 'machine.cleanup.archive.paused',
  mainMissing: 'machine.cleanup.archive.mainMissing',
  foreign: 'machine.cleanup.archive.foreign',
  notKept: 'machine.cleanup.archive.notKept',
  unreadable: 'machine.cleanup.archive.unreadable',
};

/** Every session file in the home is safely in the archive, and the archive has looked since the last was written. */
export const allArchived = (archive: HomeArchive) => archive.blocked === null && archive.notArchived === 0 && !archive.newerThanPass;

/** A home's archive standing as its row and its confirmation say it. */
export function archiveLine(archive: HomeArchive): { key: MessageKey; variables: Record<string, string | number>; ok: boolean } {
  if (archive.blocked) return { key: ARCHIVE_BLOCK[archive.blocked], variables: {}, ok: false };
  if (archive.notArchived > 0) return { key: 'machine.cleanup.archive.partly', variables: { count: formatCount(archive.notArchived), total: formatCount(archive.sessions) }, ok: false };
  if (archive.newerThanPass) return { key: 'machine.cleanup.archive.newer', variables: {}, ok: false };
  if (archive.sessions === 0) return { key: 'machine.cleanup.archive.none', variables: {}, ok: true };
  return { key: 'machine.cleanup.archive.all', variables: { total: formatCount(archive.sessions) }, ok: true };
}

/**
 * Whether setting a home aside asks first, and why: some of its sessions aren't archived (ask, then allow), or an agent
 * is still using it and will make a new one. Anything else goes at once, with Undo.
 */
export function removalAsks(home: Pick<CleanupHome, 'role' | 'archive'>): { unarchived: boolean; active: boolean } | null {
  const unarchived = home.archive !== null && !allArchived(home.archive);
  const active = home.role === 'active' && home.archive !== null;
  return unarchived || active ? { unarchived, active } : null;
}

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

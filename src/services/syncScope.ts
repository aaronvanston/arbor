import { savedStore } from './savedStore';

/**
 * What Sync's pages show, as T3's scope sentence picks it: a project or All projects, a machine or All machines. One
 * choice for every Sync page, apart from Settings' own, and kept between visits, as the machine Skills showed was.
 */
export type SyncScope = { project: string | null; machine: string | null };

const EMPTY: SyncScope = { project: null, machine: null };

/** A saved scope, or All projects on All machines when there's none or it can't be read. */
export function parseSyncScope(raw: string | null): SyncScope {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object') return EMPTY;
    const text = (entry: unknown) => (typeof entry === 'string' && entry ? entry : null);
    const { project, machine } = value as Record<string, unknown>;
    return { project: text(project), machine: text(machine) };
  } catch {
    return EMPTY;
  }
}

const store = savedStore<SyncScope>({ key: 'arbor.sync.scope.v1', parse: parseSyncScope, fallback: EMPTY, place: 'window' });

export const useSyncScope = store.useValue;

function update(next: Partial<SyncScope>) {
  const current = store.get();
  const merged = { ...current, ...next };
  if (merged.project !== current.project || merged.machine !== current.machine) store.set(merged);
}

/** Shows Sync for one project's own values, or with null for All projects. */
export const setSyncProject = (project: string | null) => update({ project });

/** Shows Sync on one machine, or with null on All machines. */
export const setSyncMachine = (machine: string | null) => update({ machine });

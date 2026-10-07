import { APP_PREFERENCE_DEFAULTS, type AppPreferences } from '../appPreferences';
import { machineLookKey } from './machineLook';
import { savedStore, sharedStore } from './savedStore';

/**
 * Settings a machine can have its own value for: the value set for All machines applies to every
 * machine, a new one included, until a machine is given its own. Only what Arbor itself does about a machine (its
 * alerts) is here; accounts and routing are the proxy's, which serves every machine alike.
 */
export const MACHINE_SCOPED_PREFERENCES = [
  'heavySessionTokens',
  'machineNotifications',
  'setupChangeAlerts',
  'autoLineUp',
  'agentPermissionAlerts',
  'agentWaitingAlerts',
] as const;

export type MachineScopedKey = (typeof MACHINE_SCOPED_PREFERENCES)[number];

/**
 * The ones a project can have its own value for too, on every machine or on one. They're about a session, which
 * knows its project; a machine going down doesn't.
 */
export const PROJECT_SCOPED_PREFERENCES = ['heavySessionTokens', 'agentPermissionAlerts', 'agentWaitingAlerts'] as const satisfies readonly MachineScopedKey[];
export type ProjectScopedKey = (typeof PROJECT_SCOPED_PREFERENCES)[number];
export const isProjectScoped = (key: MachineScopedKey): key is ProjectScopedKey => (PROJECT_SCOPED_PREFERENCES as readonly string[]).includes(key);
export type MachineOverrides = Partial<Pick<AppPreferences, MachineScopedKey>>;
/** Each machine's own values, keyed by machineLookKey so "Mac Mini" and "mac-mini" are the one machine. */
export type MachineOverrideMap = Record<string, MachineOverrides>;

/** Where the value a machine uses comes from, nearest first. */
export type SettingSource = 'projectMachine' | 'project' | 'machine' | 'all' | 'default';

/**
 * A project's own values, keyed by `projectSettingsKey`: for every machine, and for one machine, keyed by
 * machineLookKey, which wins over both.
 */
export type ProjectOverrides = { all?: MachineOverrides; machines?: Record<string, MachineOverrides> };
export type ProjectOverrideMap = Record<string, ProjectOverrides>;

/** A project as settings know it: its repository, `owner/name`, which is the same on every machine. */
export const projectSettingsKey = (repository: string) => repository.trim().toLowerCase();

/** Where a value is being looked at or set: a project, a machine, both, or neither for All. */
export type ScopeAt = { project: string | null; machine: string | null };

/** The value set at exactly `at`, not inherited, for a project-scoped setting. */
export function valueAt<K extends MachineScopedKey>(overrides: MachineOverrideMap, projects: ProjectOverrideMap, at: ScopeAt, key: K): AppPreferences[K] | undefined {
  if (at.project) {
    if (!isProjectScoped(key)) return undefined;
    const project = projects[projectSettingsKey(at.project)];
    const own = at.machine ? project?.machines?.[machineLookKey(at.machine)] : project?.all;
    return own?.[key] as AppPreferences[K] | undefined;
  }
  return at.machine ? (overrides[machineLookKey(at.machine)]?.[key] as AppPreferences[K] | undefined) : undefined;
}

/**
 * The value a session uses: its project's own on its machine, else its project's, else its machine's, else All
 * machines'. A session without a project, or a setting a project can't have, skips the project's layers.
 */
export function resolveScoped<K extends MachineScopedKey>(
  preferences: AppPreferences,
  overrides: MachineOverrideMap,
  projects: ProjectOverrideMap,
  at: ScopeAt,
  key: K,
): { value: AppPreferences[K]; source: SettingSource } {
  const layers: [ScopeAt, SettingSource][] = [
    [at, 'projectMachine'],
    [{ project: at.project, machine: null }, 'project'],
    [{ project: null, machine: at.machine }, 'machine'],
  ];
  for (const [layer, source] of layers) {
    if (!layer.project && !layer.machine) continue;
    if (source === 'projectMachine' && !(at.project && at.machine)) continue;
    const own = valueAt(overrides, projects, layer, key);
    if (own !== undefined) return { value: own, source };
  }
  const all = preferences[key];
  return { value: all, source: all === APP_PREFERENCE_DEFAULTS[key] ? 'default' : 'all' };
}

export type ResolvedSetting<K extends MachineScopedKey> = {
  value: AppPreferences[K];
  source: SettingSource;
  /** What All machines has, which the machine goes back to when its own value is cleared. */
  inherited: AppPreferences[K];
};

/** The value `machine` uses for `key`: its own, else All machines'. With no machine, All machines'. */
export function resolveMachineSetting<K extends MachineScopedKey>(
  preferences: AppPreferences,
  overrides: MachineOverrideMap,
  machine: string | null,
  key: K,
): ResolvedSetting<K> {
  const inherited = preferences[key];
  const own = machine ? overrides[machineLookKey(machine)]?.[key] : undefined;
  if (own !== undefined) return { value: own as AppPreferences[K], source: 'machine', inherited };
  return { value: inherited, source: inherited === APP_PREFERENCE_DEFAULTS[key] ? 'default' : 'all', inherited };
}

/** The value `machine` uses for `key`; a monitor's shorthand for resolveMachineSetting. */
export const machineValue = <K extends MachineScopedKey>(
  preferences: AppPreferences,
  overrides: MachineOverrideMap,
  machine: string | null,
  key: K,
): AppPreferences[K] => resolveMachineSetting(preferences, overrides, machine, key).value;

/** A setting's value everywhere, then each machine's and each project's own, where they have one. */
function scopedValues(preferences: AppPreferences, overrides: MachineOverrideMap, key: MachineScopedKey, projects: ProjectOverrideMap) {
  const projectValues = isProjectScoped(key)
    ? Object.values(projects).flatMap((project) => [project.all, ...Object.values(project.machines ?? {})])
    : [];
  return [preferences[key], ...[...Object.values(overrides), ...projectValues].map((own) => own?.[key])];
}

/** Whether an alert is on for All machines or any one machine, so its monitor keeps running. A threshold of 0 is off. */
export function raisedAnywhere(preferences: AppPreferences, overrides: MachineOverrideMap, key: MachineScopedKey, projects: ProjectOverrideMap = {}): boolean {
  return scopedValues(preferences, overrides, key, projects).some((value) => (typeof value === 'number' ? value > 0 : value === true));
}

/**
 * The lowest value a threshold is raised to anywhere: everywhere, on a machine, or in a project. Null when it's off
 * everywhere. Nothing under it is over any scope's threshold.
 */
export function lowestRaised(preferences: AppPreferences, overrides: MachineOverrideMap, key: MachineScopedKey, projects: ProjectOverrideMap = {}): number | null {
  const raised = scopedValues(preferences, overrides, key, projects).filter((value): value is number => typeof value === 'number' && value > 0);
  return raised.length ? Math.min(...raised) : null;
}

/** How many settings `machine` has its own value for. */
export const overrideCount = (overrides: MachineOverrideMap, machine: string) =>
  Object.keys(overrides[machineLookKey(machine)] ?? {}).length;

/** Drops what isn't a scoped setting of the right type, so a hand-edited or older store can't feed an alert junk. */
export function sanitizeOverrides(raw: unknown): MachineOverrideMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: MachineOverrideMap = {};
  for (const [machine, values] of Object.entries(raw as Record<string, unknown>)) {
    if (!values || typeof values !== 'object') continue;
    const kept: Record<string, unknown> = {};
    for (const key of MACHINE_SCOPED_PREFERENCES) {
      const value = (values as Record<string, unknown>)[key];
      if (value !== undefined && typeof value === typeof APP_PREFERENCE_DEFAULTS[key]) kept[key] = value;
    }
    if (Object.keys(kept).length) out[machine] = kept as MachineOverrides;
  }
  return out;
}

/** Drops what isn't a project-scoped setting of the right type, as sanitizeOverrides does for machines. */
export function sanitizeProjectOverrides(raw: unknown): ProjectOverrideMap {
  if (!raw || typeof raw !== 'object') return {};
  const keep = (values: unknown): MachineOverrides | undefined => {
    const kept = sanitizeOverrides({ x: values }).x ?? {};
    for (const key of Object.keys(kept) as MachineScopedKey[]) if (!isProjectScoped(key)) delete kept[key];
    return Object.keys(kept).length ? kept : undefined;
  };
  const out: ProjectOverrideMap = {};
  for (const [project, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const { all, machines } = entry as { all?: unknown; machines?: unknown };
    const next: ProjectOverrides = {};
    const allKept = keep(all);
    if (allKept) next.all = allKept;
    if (machines && typeof machines === 'object') {
      const perMachine = Object.fromEntries(Object.entries(machines).flatMap(([machine, values]) => {
        const kept = keep(values);
        return kept ? [[machine, kept]] : [];
      }));
      if (Object.keys(perMachine).length) next.machines = perMachine;
    }
    if (next.all || next.machines) out[project] = next;
  }
  return out;
}

const machineOverrides = savedStore<MachineOverrideMap>({
  key: 'arbor.machine-overrides.v1',
  parse: (raw) => (raw ? sanitizeOverrides(JSON.parse(raw)) : {}),
  fallback: {},
});

export const useMachineOverrides = machineOverrides.useValue;

/** Gives `machine` its own value for `key`. */
export function setMachineOverride<K extends MachineScopedKey>(machine: string, key: K, value: AppPreferences[K]) {
  const id = machineLookKey(machine);
  const overrides = machineOverrides.get();
  machineOverrides.set({ ...overrides, [id]: { ...overrides[id], [key]: value } });
}

/** Puts `machine` back on All machines' value for `key`, or for every setting when `key` is left out. */
export function clearMachineOverride(machine: string, key?: MachineScopedKey) {
  const id = machineLookKey(machine);
  const rest = { ...machineOverrides.get() };
  if (key) {
    const own = { ...rest[id] };
    delete own[key];
    if (Object.keys(own).length) rest[id] = own;
    else delete rest[id];
  } else {
    delete rest[id];
  }
  machineOverrides.set(rest);
}

/** Puts every machine back on All machines' value for `key`. */
export function clearOverridesFor(key: MachineScopedKey) {
  const next: MachineOverrideMap = {};
  for (const [machine, own] of Object.entries(machineOverrides.get())) {
    const kept = { ...own };
    delete kept[key];
    if (Object.keys(kept).length) next[machine] = kept;
  }
  machineOverrides.set(next);
}

const projectOverrides = savedStore<ProjectOverrideMap>({
  key: 'arbor.project-overrides.v1',
  parse: (raw) => (raw ? sanitizeProjectOverrides(JSON.parse(raw)) : {}),
  fallback: {},
});

export const useProjectOverrides = projectOverrides.useValue;

/** Sets or, with undefined, clears the value at exactly `at`; All itself is the preference, not an override. */
export function setScopedOverride<K extends MachineScopedKey>(at: ScopeAt, key: K, value: AppPreferences[K] | undefined) {
  if (!at.project) {
    if (!at.machine) return;
    if (value === undefined) clearMachineOverride(at.machine, key);
    else setMachineOverride(at.machine, key, value);
    return;
  }
  if (!isProjectScoped(key)) return;
  const id = projectSettingsKey(at.project);
  const projects = projectOverrides.get();
  const machines: Record<string, MachineOverrides> = { ...projects[id]?.machines };
  const project: ProjectOverrides = { ...projects[id], machines };
  const edit = (own: MachineOverrides | undefined): MachineOverrides | undefined => {
    const next: MachineOverrides = { ...own };
    if (value === undefined) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
    return Object.keys(next).length ? next : undefined;
  };
  if (at.machine) {
    const machine = machineLookKey(at.machine);
    const next = edit(machines[machine]);
    if (next) machines[machine] = next;
    else delete machines[machine];
  } else {
    const next = edit(project.all);
    if (next) project.all = next;
    else delete project.all;
  }
  if (!Object.keys(machines).length) delete project.machines;
  const rest = { ...projects };
  if (project.all || project.machines) rest[id] = project;
  else delete rest[id];
  projectOverrides.set(rest);
}

/** Puts every project back on the machines' values for `key`. */
export function clearProjectOverridesFor(key: MachineScopedKey) {
  const next: ProjectOverrideMap = {};
  for (const [id, project] of Object.entries(projectOverrides.get())) {
    const strip = (own: MachineOverrides | undefined) => {
      const kept = { ...own };
      delete kept[key];
      return Object.keys(kept).length ? kept : undefined;
    };
    const all = strip(project.all);
    const machines = Object.fromEntries(Object.entries(project.machines ?? {}).flatMap(([machine, own]) => {
      const kept = strip(own);
      return kept ? [[machine, kept]] : [];
    }));
    const entry: ProjectOverrides = { ...(all ? { all } : {}), ...(Object.keys(machines).length ? { machines } : {}) };
    if (entry.all || entry.machines) next[id] = entry;
  }
  projectOverrides.set(next);
}

/** How many settings a project has its own value for, on any machine. */
export const projectOverrideCount = (projects: ProjectOverrideMap, project: string) => {
  const entry = projects[projectSettingsKey(project)];
  return new Set([...Object.keys(entry?.all ?? {}), ...Object.values(entry?.machines ?? {}).flatMap((own) => Object.keys(own))]).size;
};

/** The project Settings is showing, or null for All projects; kept and reset with the machine. */
const projectScope = sharedStore<string | null>(null);
export const useSettingsProject = projectScope.useValue;
export const setSettingsProject = projectScope.set;

/**
 * The machine Settings is showing, or null for All machines. It stays as Settings search and the page list move
 * between pages, and isn't saved: Settings opens on All machines.
 */
const scope = sharedStore<string | null>(null);

export const useSettingsScope = scope.useValue;
export const setSettingsScope = scope.set;

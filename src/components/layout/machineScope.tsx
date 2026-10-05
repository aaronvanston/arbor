import { listen } from '@tauri-apps/api/event';
import { useEffect, useState, type ReactNode } from 'react';
import { Check, ChevronDown, FolderGit2, Layers } from '../ui/icons';
import { APP_PREFERENCE_DEFAULTS, setAppPreference, useAppPreferences, type AppPreferences } from '../../appPreferences';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import { readFleetHealth } from '../../services/machineHealth';
import {
  clearOverridesFor,
  clearProjectOverridesFor,
  isProjectScoped,
  overrideCount,
  projectOverrideCount,
  projectSettingsKey,
  setScopedOverride,
  setSettingsProject,
  setSettingsScope,
  useMachineOverrides,
  useProjectOverrides,
  useSettingsProject,
  useSettingsScope,
  valueAt,
  type MachineScopedKey,
  type ScopeAt,
  type SettingSource,
} from '../../services/machineSettings';
import { getProjects, SETUP_PROJECTS_UPDATED_EVENT } from '../../services/setupProjects';
import type { ResetOffer } from '../../services/settingDefaults';
import { MachinePill } from '../identity/Identity';
import { Button } from '../ui/button';
import { Menu, MenuGroupLabel, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '../ui/menu';
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip';
import { machineName } from '../../services/machineNames';

export type FleetMachine = { machine: string; local: boolean; reachable: boolean };

let fleet: FleetMachine[] = [];
let fleetRead: Promise<void> | null = null;

/** The machines Settings can be scoped to, this Mac first, then the rest by name. Read once, as they rarely change. */
export function useFleetMachines(): FleetMachine[] {
  const [machines, setMachines] = useState(fleet);
  useEffect(() => {
    let live = true;
    fleetRead ??= readFleetHealth()
      .then((snapshot) => {
        fleet = snapshot.machines
          .map((health) => ({ machine: health.machine, local: health.local, reachable: health.status !== 'unreachable' && health.status !== 'unconfigured' }))
          .sort((a, b) => Number(b.local) - Number(a.local) || a.machine.localeCompare(b.machine));
      })
      .catch(() => {
        fleetRead = null;
      });
    void fleetRead.then(() => {
      if (live) setMachines(fleet);
    });
    return () => {
      live = false;
    };
  }, []);
  return machines;
}

export type FleetProject = { key: string; name: string; machines: string[] };

let projectsList: FleetProject[] = [];

/** Folds each machine's last Projects scan into the projects the scope offers. */
const readFleetProjects = () =>
  getProjects().then((scans) => {
    const found = new Map<string, FleetProject>();
    for (const scan of scans) {
      for (const repo of scan.repos) {
        const parts = repo.remote && !repo.remote.startsWith('/') ? repo.remote.split('/') : [];
        if (parts.length < 3 || repo.state === 'missing') continue;
        const repository = parts.slice(-2).join('/').replace(/\.git$/, '');
        const key = projectSettingsKey(repository);
        const entry = found.get(key) ?? { key: repository, name: parts[parts.length - 1]!.replace(/\.git$/, ''), machines: [] };
        if (!entry.machines.includes(scan.machine)) entry.machines.push(scan.machine);
        found.set(key, entry);
      }
    }
    projectsList = [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
    return projectsList;
  });

/**
 * The projects Settings can be scoped to: every repository with a remote on a hosted service, by `owner/name`, which
 * is the one project on every machine, as the Projects scan last found them. A folder with no remote only means
 * something on its machine, so it can't have settings of its own. The last list shows straight away, and it's read
 * again on every mount and after every scan, since the first read can come before any machine has been scanned.
 */
export function useFleetProjects(): FleetProject[] {
  const [projects, setProjects] = useState(projectsList);
  useEffect(() => {
    let live = true;
    const load = () => void readFleetProjects().then((next) => { if (live) setProjects(next); }).catch(() => undefined);
    load();
    let stop: (() => void) | null = null;
    listen(SETUP_PROJECTS_UPDATED_EVENT, load)
      .then((unlisten) => { if (live) stop = unlisten; else unlisten(); })
      .catch(() => undefined);
    return () => {
      live = false;
      stop?.();
    };
  }, []);
  return projects;
}

/** A project as the scope shows it: its name, with `owner/` when two projects share one. */
export const projectLabel = (project: string, projects: FleetProject[]) => {
  const found = projects.find((entry) => projectSettingsKey(entry.key) === projectSettingsKey(project));
  if (!found) return project;
  return projects.filter((entry) => entry.name === found.name).length > 1 ? found.key : found.name;
};

/** The trigger of a picker inside a sentence: a dotted underline, solid while hovered or open. */
const PICKER =
  'inline-flex min-w-0 max-w-72 cursor-pointer items-center gap-1.5 rounded-sm text-foreground underline decoration-foreground/30 decoration-dotted underline-offset-4 outline-none ring-ring hover:decoration-foreground hover:decoration-solid focus-visible:ring-2 data-popup-open:decoration-foreground data-popup-open:decoration-solid';

/**
 * The scope sentence at the top of a page whose settings a machine can have its own values for: "Applying these
 * settings across [All machines ▾]", or "on [machine ▾]" once one is picked. The menu counts each machine's own values.
 */
export function SettingsScopeSentence({ className, projects: withProjects = false }: {
  className?: string;
  /** The page has settings a project can have its own value for, so the sentence picks a project too. */
  projects?: boolean;
}) {
  const scope = useSettingsScope();
  const project = useSettingsProject();
  const overrides = useMachineOverrides();
  const projectOverrides = useProjectOverrides();
  return (
    <ScopeSentence
      className={className}
      project={withProjects ? { value: project, onChange: setSettingsProject, count: (key) => projectOverrideCount(projectOverrides, key) } : null}
      machine={{ value: scope, onChange: setSettingsScope, count: (machine) => overrideCount(overrides, machine) }}
    />
  );
}

type ScopePick = { value: string | null; onChange: (value: string | null) => void; count?: (key: string) => number };

/**
 * The sentence itself: a project picker when `project` is given, then the machine picker. Settings and Sync each keep
 * their own choice and pass it in.
 */
export function ScopeSentence({ className, project, machine }: {
  className?: string;
  project: ScopePick | null;
  machine: ScopePick;
}) {
  const { t } = useI18n();
  const machines = useFleetMachines();
  const projects = useFleetProjects();
  const ownCount = (own: number) => (own ? <span className="text-xs text-primary">{t(own === 1 ? 'machineScope.ownCount.one' : 'machineScope.ownCount.other', { count: own })}</span> : null);
  return (
    <p className={cn('flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-4 text-sm text-muted-foreground', className)} data-slot="settings-scope">
      {project ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">{t('machineScope.sentence.leadFor')}</span>
          <Menu>
            <MenuTrigger className={PICKER} aria-label={t('machineScope.projectPicker.aria')}>
              {project.value ? <FolderGit2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /> : null}
              <span className="truncate">{project.value ? projectLabel(project.value, projects) : t('machineScope.allProjects')}</span>
              <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            </MenuTrigger>
            <MenuPopup align="start" className="min-w-64">
              <MenuRadioGroup value={project.value ?? ''} onValueChange={(value: string) => project.onChange(value || null)}>
                <MenuRadioItem value="" closeOnClick>
                  <span className="min-w-0 flex-1 truncate">{t('machineScope.allProjects')}</span>
                </MenuRadioItem>
                <MenuSeparator />
                <MenuGroupLabel>{t('machineScope.projects')}</MenuGroupLabel>
                {projects.length ? projects.map((entry) => (
                  <MenuRadioItem key={entry.key} value={entry.key} closeOnClick>
                    <FolderGit2 aria-hidden="true" className="size-4 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate" title={entry.key}>{projectLabel(entry.key, projects)}</span>
                    {ownCount(project.count?.(entry.key) ?? 0)}
                  </MenuRadioItem>
                )) : <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('machineScope.projects.none')}</p>}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        </span>
      ) : (
        <span>{t('machineScope.sentence.lead')}</span>
      )}
      <span className="flex min-w-0 items-center gap-1.5">
        <span>{t(machine.value ? 'machineScope.sentence.on' : 'machineScope.sentence.across')}</span>
        <Menu>
          <MenuTrigger className={PICKER} aria-label={t('machineScope.picker.aria')}>
            {/* A machine goes by its pill here as everywhere; All machines keeps the sentence's underline. */}
            {machine.value ? <MachinePill name={machine.value} /> : (
              <>
                <Layers aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{t('machineScope.all')}</span>
              </>
            )}
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          </MenuTrigger>
          <MenuPopup align="start" className="min-w-64">
            <MenuRadioGroup value={machine.value ?? ''} onValueChange={(value: string) => machine.onChange(value || null)}>
              <MenuRadioItem value="" closeOnClick>
                <Layers aria-hidden="true" className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{t('machineScope.all')}</span>
              </MenuRadioItem>
              <MenuSeparator />
              <MenuGroupLabel>{t('machineScope.machines')}</MenuGroupLabel>
              {machines.map(({ machine: name, local, reachable }) => (
                <MenuRadioItem key={name} value={name} closeOnClick>
                  <span className="flex min-w-0 flex-1"><MachinePill name={name} /></span>
                  {local ? <span className="text-xs text-muted-foreground">{t('machineScope.thisMac')}</span> : null}
                  {!reachable ? <span className="text-xs text-muted-foreground">{t('machineScope.offline')}</span> : null}
                  {ownCount(machine.count?.(name) ?? 0)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      </span>
    </p>
  );
}

type Layer = { label: ReactNode; value: string | null; wins: boolean };

/**
 * The layers mark after a row's title: tinted while the value shown is a machine's own, or at All machines while
 * some machine has its own. Its popover lays out where the value comes from, nearest first, the one in use ticked, and
 * at All machines, the machines that differ, each a link to its scope.
 */
function ScopeMarker({ tone, hint, shownHint, layers, overriders, onResetAll }: {
  tone: 'own' | 'varies' | 'plain';
  /** The button's name, read out, so plain words. */
  hint: string;
  /** What its tooltip shows instead, with a machine as its pill. */
  shownHint?: ReactNode;
  layers: Layer[];
  overriders: { at: ScopeAt; where: ReactNode; value: string }[];
  onResetAll?: () => void;
}) {
  const { t } = useI18n();
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-micro"
                  aria-label={hint}
                  data-reset-default
                />
              }
            />
          }
        >
          <Layers className={cn('size-3', tone === 'own' && 'text-primary', tone === 'varies' && 'text-warning')} />
        </TooltipTrigger>
        <TooltipPopup>{shownHint ?? hint}</TooltipPopup>
      </Tooltip>
      <PopoverPopup width="lg" padding="none" align="start" className="text-sm">
        <div className="divide-y divide-border/60">
          <div className="px-3 py-2.5">
            <div className="pb-1.5 text-xs font-medium text-muted-foreground">{t('machineScope.layers.title')}</div>
            {layers.map((layer, index) => (
              <div key={index} className={cn('grid grid-cols-[auto_minmax(0,1fr)_1rem] items-center gap-x-4 rounded-md px-2 py-1', layer.wins && 'bg-foreground/[0.06]')}>
                <span className={cn('min-w-0 truncate whitespace-nowrap', layer.value === null && 'text-muted-foreground')}>{layer.label}</span>
                <span className={cn('min-w-0 truncate text-right', layer.value === null ? 'text-muted-foreground' : 'text-foreground')}>{layer.value ?? t('machineScope.layers.unset')}</span>
                {layer.wins ? <Check aria-hidden="true" className="size-3.5 text-primary" /> : <span />}
              </div>
            ))}
          </div>
          {overriders.length ? (
            <div className="px-3 py-2.5">
              <div className="flex items-center justify-between gap-2 pb-1.5 text-xs font-medium text-muted-foreground">
                <span>{t('machineScope.layers.ownOn')}</span>
                {onResetAll ? (
                  <PopoverClose render={<Button variant="ghost-muted" size="xs" onClick={onResetAll} />}>{t('machineScope.layers.resetAll')}</PopoverClose>
                ) : null}
              </div>
              {overriders.map(({ at, where, value }) => (
                <PopoverClose
                  key={`${at.project ?? ''}\u0000${at.machine ?? ''}`}
                  render={<button type="button" onClick={() => { setSettingsProject(at.project); setSettingsScope(at.machine); }} />}
                  className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1 text-left outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex min-w-0 items-center gap-1.5 truncate">{where}</span>
                  <span className="max-w-44 truncate text-foreground">{value}</span>
                </PopoverClose>
              ))}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export type ScopedValue<T> = {
  value: T;
  set: (value: T) => void;
  source: SettingSource;
  /** The layers mark for the row's title; none while nothing differs anywhere. */
  marker: ReactNode;
  /** At a machine or project, going back to the value it inherits; at All, the default. */
  reset: ResetOffer | undefined;
  /** Why the row can't be changed at the project picked: it's the same for every project. */
  held: string | undefined;
};

/** Where a scoped value is kept: All's value, the default, and the value set at each project, machine, or both. */
export type ScopedSource<T> = {
  all: T;
  fallback: T;
  /** A project can have its own value, on every machine or on one. */
  byProject?: boolean;
  /** The value set at exactly `at` (a project, a machine, or both), or undefined while it inherits. */
  own: (at: ScopeAt) => T | undefined;
  label: (value: T) => string;
  setAll: (value: T) => void;
  setOwn: (at: ScopeAt, value: T) => void;
  clearOwn: (at: ScopeAt) => void;
  /** Puts every project and machine back on All's value. */
  clearAll: () => void;
};

type Candidate = { at: ScopeAt; source: SettingSource };

/** The layers a value at `at` can come from, nearest first, before All's. */
const candidates = ({ project, machine }: ScopeAt): Candidate[] => [
  ...(project && machine ? [{ at: { project, machine }, source: 'projectMachine' as const }] : []),
  ...(project ? [{ at: { project, machine: null }, source: 'project' as const }] : []),
  ...(machine ? [{ at: { project: null, machine }, source: 'machine' as const }] : []),
];

/**
 * A scoped value as the scope shows it: All's, or the picked project's and machine's, own or inherited, with its
 * layers mark and its reset. Nearest wins: the project on the machine, the project, the machine, then All. Setting it
 * at a scope gives that scope its own value; setting it back to what it inherits keeps it its own until
 * Reset hands it back.
 */
export function useScopedValue<T>(source: ScopedSource<T>): ScopedValue<T> {
  const { t, tRich } = useI18n();
  const machine = useSettingsScope();
  const picked = useSettingsProject();
  const machines = useFleetMachines().map((entry) => entry.machine);
  const projects = useFleetProjects();
  const { all, fallback, label } = source;
  const project = source.byProject ? picked : null;
  const held = picked && !source.byProject ? t('machineScope.projectWide') : undefined;
  const at: ScopeAt = { project, machine };

  const found = candidates(at).map((candidate) => ({ ...candidate, value: source.own(candidate.at) }));
  const winner = found.find((candidate) => candidate.value !== undefined);
  const origin: SettingSource = winner?.source ?? (all === fallback ? 'default' : 'all');
  const value = winner?.value !== undefined ? winner.value : all;
  const exact = found[0];
  const ownHere = Boolean(exact && exact.value !== undefined);
  const inherited = found.slice(1).find((candidate) => candidate.value !== undefined)?.value ?? all;

  const where = (layer: ScopeAt): ReactNode => {
    const projectName = layer.project ? projectLabel(layer.project, projects) : null;
    if (projectName && layer.machine) return <span>{tRich('machineScope.layers.projectOn', { project: projectName, machine: <MachinePill name={layer.machine} size="sm" /> })}</span>;
    if (projectName) return <span className="flex items-center gap-1.5"><FolderGit2 aria-hidden="true" className="size-3.5 text-muted-foreground" />{projectName}</span>;
    return <MachinePill name={layer.machine ?? ''} size="sm" />;
  };
  const allLabel = t(source.byProject ? 'machineScope.layers.allBoth' : 'machineScope.all');
  const layers: Layer[] = [
    ...found.map((candidate) => ({ label: where(candidate.at), value: candidate.value !== undefined ? label(candidate.value) : null, wins: origin === candidate.source })),
    { label: allLabel, value: all === fallback ? null : label(all), wins: origin === 'all' },
    { label: t('machineScope.layers.default'), value: label(fallback), wins: origin === 'default' },
  ];

  // At All: every project, machine and project on a machine with its own value.
  const everywhere: ScopeAt[] = [
    ...machines.map((entry) => ({ project: null, machine: entry })),
    ...(source.byProject ? projects.flatMap((entry) => [{ project: entry.key, machine: null }, ...machines.map((m) => ({ project: entry.key, machine: m }))]) : []),
  ];
  const overriders = project || machine ? [] : everywhere.flatMap((layer) => {
    const theirs = source.own(layer);
    return theirs === undefined ? [] : [{ at: layer, where: where(layer), value: label(theirs) }];
  });

  const scopedHere = Boolean(project || machine);
  const hereName = project && machine
    ? t('machineScope.layers.projectOn', { project: projectLabel(project, projects), machine })
    : project ? projectLabel(project, projects) : machine ? machineName(machine) : '';
  const herePill = machine ? <MachinePill name={machine} size="sm" /> : null;
  const hereShown = project && herePill
    ? tRich('machineScope.layers.projectOn', { project: projectLabel(project, projects), machine: herePill })
    : herePill ?? hereName;
  let marker: ReactNode = null;
  if (scopedHere && ownHere) {
    marker = (
      <ScopeMarker
        tone="own"
        hint={t('machineScope.hint.own', { place: hereName })}
        shownHint={tRich('machineScope.hint.own', { place: hereShown })}
        layers={layers}
        overriders={[]}
      />
    );
  } else if (scopedHere) {
    marker = <ScopeMarker tone="plain" hint={t(origin === 'all' ? 'machineScope.hint.fromAll' : origin === 'default' ? 'machineScope.hint.default' : 'machineScope.hint.inherits')} layers={layers} overriders={[]} />;
  } else if (overriders.length) {
    marker = (
      <ScopeMarker
        tone="varies"
        hint={t(source.byProject
          ? overriders.length === 1 ? 'machineScope.hint.variesPlaces.one' : 'machineScope.hint.variesPlaces.other'
          : overriders.length === 1 ? 'machineScope.hint.varies.one' : 'machineScope.hint.varies.other', { count: overriders.length })}
        layers={layers}
        overriders={overriders}
        onResetAll={source.clearAll}
      />
    );
  }

  const set = (next: T) => (scopedHere ? source.setOwn(at, next) : source.setAll(next));
  const reset: ResetOffer | undefined = scopedHere
    ? ownHere
      ? { value: label(inherited), onReset: () => source.clearOwn(at), tooltip: t('machineScope.reset.tooltipInherit', { value: label(inherited) }) }
      : undefined
    : all !== fallback ? { value: label(fallback), onReset: () => source.setAll(fallback) } : undefined;

  return { value, set, source: origin, marker, reset, held };
}

/** One of the machine-scoped preferences (src/services/machineSettings.ts) as the scope shows it. */
export function useScopedPreference<K extends MachineScopedKey>(key: K, label: (value: AppPreferences[K]) => string): ScopedValue<AppPreferences[K]> {
  const preferences = useAppPreferences();
  const overrides = useMachineOverrides();
  const projects = useProjectOverrides();
  return useScopedValue<AppPreferences[K]>({
    all: preferences[key],
    fallback: APP_PREFERENCE_DEFAULTS[key],
    byProject: isProjectScoped(key),
    own: (at) => valueAt(overrides, projects, at, key),
    label,
    setAll: (value) => setAppPreference(key, value),
    setOwn: (at, value) => setScopedOverride(at, key, value),
    clearOwn: (at) => setScopedOverride(at, key, undefined),
    clearAll: () => {
      clearOverridesFor(key);
      clearProjectOverridesFor(key);
    },
  });
}

/** Why a row stays put at a machine: it's the same on every machine. */
export function useFleetWideHold(): string | undefined {
  const { t } = useI18n();
  const scope = useSettingsScope();
  const project = useSettingsProject();
  if (scope) return t('machineScope.fleetWide');
  return project ? t('machineScope.projectWide') : undefined;
}

/** The scope notice: what a page holds for every machine alike, folded away at one machine, and the way back to it. */
export function FleetWideNotice({ text }: { text: string }) {
  const { t } = useI18n();
  // The button names what it widens to, so a project's scope doesn't read as a machine's.
  const scope = useSettingsScope();
  const project = useSettingsProject();
  const showAll = project ? (scope ? 'machineScope.showAllEverywhere' : 'machineScope.showAllProjects') : 'machineScope.showAll';
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border/70 px-4 py-3 text-sm text-muted-foreground">
      <span>{text}</span>
      <Button variant="outline" size="sm" onClick={() => { setSettingsScope(null); setSettingsProject(null); }}>
        <Layers />
        {t(showAll)}
      </Button>
    </div>
  );
}

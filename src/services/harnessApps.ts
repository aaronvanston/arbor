import type { AppPreferences } from '../appPreferences';
import type { MessageKey } from '../i18n/resources';
import type { AutomationScan, AutomationSource, MachineHealth, RunHarness } from '../native/types';

/**
 * The apps that run agents, as Settings › Harnesses shows them: where each was found and what Arbor reads from it or
 * hands it. T3 Code and Orca are found by each machine's agents check, the rest by the automation scans.
 */

export type HarnessApp = 't3' | 'orca' | 'superset' | 'codexApp' | 'claudeDesktop';

type HarnessAppSpec = {
  label: MessageKey;
  /** The automations it keeps, which Arbor can stop reading. */
  automations: Exclude<AutomationSource, 'arbor'> | null;
  /** The runs a pool can hand it, which can be turned off. T3 Code takes none from outside for now. */
  runs: Exclude<RunHarness, 'headless' | 't3'> | null;
};

/** In the page's order. A new app that runs agents is an entry here. */
export const HARNESS_APPS: Readonly<Record<HarnessApp, HarnessAppSpec>> = {
  t3: { label: 'harness.kind.t3', automations: null, runs: null },
  orca: { label: 'harness.kind.orca', automations: 'orca', runs: 'orca' },
  superset: { label: 'automations.source.superset', automations: 'superset', runs: null },
  codexApp: { label: 'automations.source.codexApp', automations: 'codexApp', runs: null },
  claudeDesktop: { label: 'automations.source.claudeDesktop', automations: 'claudeDesktop', runs: null },
};

const APP_ORDER = Object.keys(HARNESS_APPS) as HarnessApp[];

export type HarnessAppsInput = {
  health: readonly MachineHealth[] | null;
  scans: readonly AutomationScan[];
  /** T3 Code was found on this Mac or a machine (the live board's own look). */
  t3Found: boolean;
  appsOff: readonly AutomationSource[];
  preferences: Pick<AppPreferences, 'fleetT3Threads' | 'fleetT3Titles' | 'runsToOrca'>;
};

export type HarnessAppRow = {
  app: HarnessApp;
  /** The machines it was found on, sorted. Empty when it's shown only because something of it is off. */
  machines: string[];
};

/** The machines each app was last found on. */
export function harnessAppMachines(health: readonly MachineHealth[] | null, scans: readonly AutomationScan[]): Record<HarnessApp, string[]> {
  const found: Record<HarnessApp, Set<string>> = { t3: new Set(), orca: new Set(), superset: new Set(), codexApp: new Set(), claudeDesktop: new Set() };
  for (const machine of health ?? []) {
    if (machine.agents.t3) found.t3.add(machine.machine);
    if (machine.agents.orca) found.orca.add(machine.machine);
  }
  for (const scan of scans) {
    for (const source of scan.apps) {
      if (source !== 'arbor') found[source].add(scan.machine);
    }
  }
  return Object.fromEntries(APP_ORDER.map((app) => [app, [...found[app]].sort()])) as Record<HarnessApp, string[]>;
}

/** Something of the app is turned off, so its card stays to turn it back on even where it's no longer found. */
function anythingOff(app: HarnessApp, input: HarnessAppsInput): boolean {
  const { automations, runs } = HARNESS_APPS[app];
  const { preferences } = input;
  if (automations && input.appsOff.includes(automations)) return true;
  if (runs === 'orca' && !preferences.runsToOrca) return true;
  return app === 't3' && (!preferences.fleetT3Threads || preferences.fleetT3Titles);
}

/**
 * The apps the page shows: each once some machine has it, like any other app's feature, or while something of it is
 * set away from its default.
 */
export function harnessApps(input: HarnessAppsInput): HarnessAppRow[] {
  const machines = harnessAppMachines(input.health, input.scans);
  return APP_ORDER
    .filter((app) => machines[app].length > 0 || (app === 't3' && input.t3Found) || anythingOff(app, input))
    .map((app) => ({ app, machines: machines[app] }));
}

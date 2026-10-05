import { describe, expect, it } from 'bun:test';
import { APP_PREFERENCE_DEFAULTS } from '../src/appPreferences';
import type { AutomationScan, MachineAgents, MachineHealth } from '../src/native/types';
import { harnessAppMachines, harnessApps, type HarnessAppsInput } from '../src/services/harnessApps';
import { newRunRequest, runHarnessChoices, runHarnessesOff } from '../src/services/runs';

const agents = (fields: Partial<MachineAgents>): MachineAgents => ({
  claude: null, codex: null, checkedAt: 1, error: null, updating: [], reporter: { installed: false, homes: [] }, t3: null, orca: null, ...fields,
});
// Only what the page reads; the rest of a machine's health doesn't matter here.
const machine = (name: string, found: Partial<MachineAgents>) => ({ machine: name, agents: agents(found) }) as unknown as MachineHealth;
const scan = (name: string, apps: AutomationScan['apps']): AutomationScan => ({
  machine: name, scannedAtMs: 1, scanning: false, error: null, apps, udian: null, placingError: null,
});
const t3 = { version: '0.0.30', running: true, setups: [] };
const orca = { version: '1.4.0', running: true, agents: ['claude'] };

const input = (fields: Partial<HarnessAppsInput> = {}): HarnessAppsInput => ({
  health: [], scans: [], t3Found: false, appsOff: [], preferences: APP_PREFERENCE_DEFAULTS, ...fields,
});
const shown = (fields: Partial<HarnessAppsInput>) => harnessApps(input(fields)).map((row) => `${row.app}:${row.machines.join(',')}`);

describe('Settings › Harnesses', () => {
  it('finds each app on the machines its agents check or automation scan saw it on', () => {
    const health = [machine('cedar-02', { t3, orca }), machine('casey-mbp', { t3 }), machine('ci-01', {})];
    const scans = [scan('casey-mbp', ['codexApp', 'claudeDesktop']), scan('cedar-02', ['orca', 'superset'])];
    expect(harnessAppMachines(health, scans)).toEqual({
      t3: ['casey-mbp', 'cedar-02'], orca: ['cedar-02'], superset: ['cedar-02'], codexApp: ['casey-mbp'], claudeDesktop: ['casey-mbp'],
    });
  });

  it('shows an app only once it is found, and keeps one with something turned off so it can be turned back on', () => {
    expect(shown({})).toEqual([]);
    expect(shown({ health: [machine('casey-mbp', { orca })] })).toEqual(['orca:casey-mbp']);
    // T3 Code on this Mac alone counts, as the live board found it.
    expect(shown({ t3Found: true })).toEqual(['t3:']);
    expect(shown({ appsOff: ['superset'] })).toEqual(['superset:']);
    expect(shown({ preferences: { ...APP_PREFERENCE_DEFAULTS, runsToOrca: false } })).toEqual(['orca:']);
    expect(shown({ preferences: { ...APP_PREFERENCE_DEFAULTS, fleetT3Titles: true } })).toEqual(['t3:']);
    expect(shown({ preferences: { ...APP_PREFERENCE_DEFAULTS, fleetT3Threads: false } })).toEqual(['t3:']);
  });

  it('keeps the apps in the page’s order', () => {
    const scans = [scan('casey-mbp', ['claudeDesktop', 'superset', 'codexApp', 'orca'])];
    expect(harnessApps(input({ scans, t3Found: true })).map((row) => row.app)).toEqual(['t3', 'orca', 'superset', 'codexApp', 'claudeDesktop']);
  });

  it('reads thread titles only once they are asked for', () => {
    expect(APP_PREFERENCE_DEFAULTS.fleetT3Titles).toBe(false);
  });
});

describe('the harnesses runs are handed to', () => {
  it('leaves out the ones turned off, never the command line', () => {
    expect(runHarnessesOff({ runsToOrca: true })).toEqual([]);
    expect(runHarnessChoices({ runsToOrca: true })).toEqual(['orca', 'headless']);
    expect(runHarnessesOff({ runsToOrca: false })).toEqual(['orca']);
    expect(runHarnessChoices({ runsToOrca: false })).toEqual(['headless']);
  });

  it('starts a new run on the first harness still on', () => {
    expect(newRunRequest('builds').harness).toBe('orca');
    expect(newRunRequest('builds', 'headless').harness).toBe('headless');
  });
});

import { describe, expect, it } from 'bun:test';
import { APP_PREFERENCE_DEFAULTS, type AppPreferences } from '../src/appPreferences';
import {
  machineValue,
  overrideCount,
  raisedAnywhere,
  resolveMachineSetting,
  resolveScoped,
  sanitizeOverrides,
  sanitizeProjectOverrides,
  valueAt,
  type MachineOverrideMap,
  type ProjectOverrideMap,
} from '../src/services/machineSettings';
import { topicRaisedHere } from '../src/services/phoneAlerts';

const M = 1_000_000;
const prefs = (fields: Partial<AppPreferences> = {}): AppPreferences => ({ ...APP_PREFERENCE_DEFAULTS, ...fields });

describe('machine-scoped settings', () => {
  it('uses a machine’s own value, else All machines’, else the default', () => {
    const overrides: MachineOverrideMap = { cedar02: { heavySessionTokens: 500 * M } };
    expect(resolveMachineSetting(prefs(), overrides, 'cedar-02', 'heavySessionTokens')).toEqual({ value: 500 * M, source: 'machine', inherited: 100 * M });
    expect(resolveMachineSetting(prefs(), overrides, 'ci-01', 'heavySessionTokens')).toEqual({ value: 100 * M, source: 'default', inherited: 100 * M });
    expect(resolveMachineSetting(prefs({ heavySessionTokens: 200 * M }), overrides, 'ci-01', 'heavySessionTokens').source).toBe('all');
    // All machines itself never reads a machine's value.
    expect(machineValue(prefs(), overrides, null, 'heavySessionTokens')).toBe(100 * M);
  });

  it('matches machines by name loosely, as the rest of Arbor does', () => {
    const overrides: MachineOverrideMap = { macmini: { machineNotifications: false } };
    expect(machineValue(prefs(), overrides, 'Mac Mini', 'machineNotifications')).toBe(false);
    expect(machineValue(prefs(), overrides, 'mac-mini', 'machineNotifications')).toBe(false);
    expect(overrideCount(overrides, 'mac-mini')).toBe(1);
  });

  it('keeps an alert running while any machine still has it on', () => {
    const off = prefs({ machineNotifications: false, heavySessionTokens: 0 });
    expect(raisedAnywhere(off, {}, 'machineNotifications')).toBe(false);
    expect(raisedAnywhere(off, { ci01: { machineNotifications: true } }, 'machineNotifications')).toBe(true);
    expect(raisedAnywhere(off, { ci01: { heavySessionTokens: 0 } }, 'heavySessionTokens')).toBe(false);
    expect(raisedAnywhere(off, { ci01: { heavySessionTokens: 50 * M } }, 'heavySessionTokens')).toBe(true);
    // Off everywhere but one machine, the phone topic still counts as raised here.
    expect(topicRaisedHere('machines', off, { ci01: { machineNotifications: true } })).toBe(true);
    expect(topicRaisedHere('machines', off)).toBe(false);
  });

  it('drops what isn’t a machine-scoped setting of the right type', () => {
    expect(sanitizeOverrides({
      ci01: { machineNotifications: 'yes', heavySessionTokens: 5, quitGuard: false },
      labbox: { limitNotifications: false },
      junk: null,
    })).toEqual({ ci01: { heavySessionTokens: 5 } });
    expect(sanitizeOverrides('nope')).toEqual({});
  });
});

describe('a project’s own values', () => {
  const machines: MachineOverrideMap = { cedar02: { heavySessionTokens: 500 * M, agentWaitingAlerts: false } };
  const projects: ProjectOverrideMap = {
    'casey/arbor': { all: { heavySessionTokens: 250 * M }, machines: { cedar02: { heavySessionTokens: 50 * M } } },
    'acme/proxy': { machines: { caseymbp: { agentWaitingAlerts: false } } },
  };
  const at = (project: string | null, machine: string | null) => ({ project, machine });

  it('win nearest first: the project on the machine, the project, the machine, then All', () => {
    expect(resolveScoped(prefs(), machines, projects, at('Casey/Arbor', 'cedar-02'), 'heavySessionTokens')).toEqual({ value: 50 * M, source: 'projectMachine' });
    expect(resolveScoped(prefs(), machines, projects, at('casey/arbor', 'ci-01'), 'heavySessionTokens')).toEqual({ value: 250 * M, source: 'project' });
    expect(resolveScoped(prefs(), machines, projects, at('acme/proxy', 'cedar-02'), 'heavySessionTokens')).toEqual({ value: 500 * M, source: 'machine' });
    expect(resolveScoped(prefs(), machines, projects, at(null, 'ci-01'), 'heavySessionTokens').source).toBe('default');
    expect(resolveScoped(prefs(), machines, projects, at('acme/proxy', 'casey-mbp'), 'agentWaitingAlerts').value).toBe(false);
    expect(resolveScoped(prefs(), machines, projects, at('acme/proxy', 'ci-01'), 'agentWaitingAlerts').value).toBe(true);
  });

  it('only exist for settings about a session', () => {
    const odd = { 'casey/arbor': { all: { machineNotifications: false } } } as ProjectOverrideMap;
    expect(valueAt({}, odd, at('casey/arbor', null), 'machineNotifications')).toBeUndefined();
    expect(sanitizeProjectOverrides({ 'casey/arbor': { all: { machineNotifications: false, heavySessionTokens: 'x' } }, junk: 3 })).toEqual({});
    expect(sanitizeProjectOverrides(projects)).toEqual(projects);
  });

  it('keep an alert’s monitor running when only a project turns it on', () => {
    const off = prefs({ agentWaitingAlerts: false });
    expect(raisedAnywhere(off, {}, 'agentWaitingAlerts')).toBe(false);
    expect(raisedAnywhere(off, {}, 'agentWaitingAlerts', { 'casey/arbor': { machines: { ci01: { agentWaitingAlerts: true } } } })).toBe(true);
  });
});

import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import { alertDestination } from '../src/services/alertHistory';
import {
  automationGroupSummary,
  automationRows,
  automationMachines,
  automationRunner,
  sortAutomations,
  automationTargetGone,
  automationHold,
  automationsHold,
  choiceSummary,
  copyKeepsSchedule,
  failedRunAlerts,
  automationModels,
  backgroundRunnerCheck,
  canInstallRunner,
  runnerPrunesHistory,
  filterAutomations,
  olderVersion,
  runnerState,
  scheduleChoice,
  scheduleRule,
  scheduleWords,
  sourceChoices,
  stateCounts,
  switchSchedule,
} from '../src/services/automations';
import type { AutomationList, AutomationScan, AutomationSummary, MachinePool, UdianOnMachine } from '../src/native/types';
import { itemAt } from './support/items';

const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);

const summary = (overrides: Partial<AutomationSummary>): AutomationSummary => ({
  id: 'arbor:a',
  source: 'arbor',
  name: 'Sentry watch',
  enabled: true,
  machine: 'cedar-02',
  target: { kind: 'machine', name: 'cedar-02' },
  project: 'billing',
  agent: 'claude',
  model: null,
  schedule: { kind: 'everyHours', hours: 1, minute: 0 },
  nextRunAtMs: null,
  lastRun: null,
  hasPrecheck: true,
  abilities: { edit: true, pause: true, runNow: true, delete: true, copy: false },
  runsOn: 'app',
  ...overrides,
});

const list = (automations: AutomationSummary[]): AutomationList => ({ automations, scans: [], running: true, draftModel: 'gpt-6-luna', draftEffort: 'low', udianBundled: '1.0.0', udianSkill: null, agents: ['claude', 'codex'], proxyKey: true, proxyAddress: '', appsOff: [] });

describe('copying into Arbor', () => {
  it('keeps the schedule only when the app keeps a rule, never for a Claude task, whose schedule Claude keeps', () => {
    const codex = summary({ source: 'codexApp', schedule: { kind: 'everyMinutes', minutes: 30 } });
    expect(copyKeepsSchedule({ summary: codex, rrule: 'RRULE:FREQ=MINUTELY;INTERVAL=30' })).toBe(true);
    expect(copyKeepsSchedule({ summary: summary({ source: 'claudeDesktop', schedule: { kind: 'elsewhere' } }), rrule: null })).toBe(false);
    // An Orca automation with no rule reads as a custom schedule, but there's still nothing to copy.
    expect(copyKeepsSchedule({ summary: summary({ source: 'orca', schedule: { kind: 'custom' } }), rrule: null })).toBe(false);
    expect(copyKeepsSchedule({ summary: codex, rrule: '  ' })).toBe(false);
  });
});

describe('schedules', () => {
  it('reads the rules the Codex app and Orca write into the dialog’s choices', () => {
    expect(scheduleChoice('RRULE:FREQ=MINUTELY;INTERVAL=30')).toEqual({ kind: 'everyMinutes', minutes: 30 });
    expect(scheduleChoice('FREQ=HOURLY;INTERVAL=2;BYMINUTE=15')).toEqual({ kind: 'hourly', hours: 2, minute: 15 });
    expect(scheduleChoice('FREQ=DAILY;BYHOUR=9;BYMINUTE=0')).toEqual({ kind: 'daily', hour: 9, minute: 0 });
    expect(scheduleChoice('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=30')).toEqual({ kind: 'weekdays', hour: 9, minute: 30 });
    expect(scheduleChoice('FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=17;BYMINUTE=0')).toEqual({ kind: 'weekly', days: [1, 4], hour: 17, minute: 0 });
    expect(scheduleChoice('FREQ=MONTHLY;BYMONTHDAY=1').kind).toBe('custom');
  });

  it('saves each choice as a rule that reads back the same', () => {
    for (const rule of ['FREQ=MINUTELY;INTERVAL=10', 'FREQ=HOURLY;INTERVAL=1;BYMINUTE=0', 'FREQ=DAILY;BYHOUR=7;BYMINUTE=45', 'FREQ=WEEKLY;BYDAY=SU,SA;BYHOUR=8;BYMINUTE=0']) {
      const choice = scheduleChoice(rule);
      expect(scheduleChoice(scheduleRule(choice))).toEqual(choice);
    }
  });

  it('keeps the time of day when the kind changes', () => {
    expect(switchSchedule({ kind: 'daily', hour: 17, minute: 30 }, 'weekly')).toEqual({ kind: 'weekly', days: [1], hour: 17, minute: 30 });
    expect(switchSchedule({ kind: 'daily', hour: 17, minute: 30 }, 'custom')).toEqual({ kind: 'custom', rrule: 'FREQ=DAILY;BYHOUR=17;BYMINUTE=30' });
  });

  it('puts a schedule in words', () => {
    expect(scheduleWords(choiceSummary({ kind: 'everyMinutes', minutes: 30 }), t)).toContain('30');
    expect(scheduleWords({ kind: 'everyHours', hours: 1, minute: 5 }, t)).toContain(':05');
    expect(scheduleWords({ kind: 'elsewhere' }, t)).toBe(t('automations.schedule.elsewhere'));
  });
});

describe('the list', () => {
  const automations = [
    summary({ id: 'orca:1', source: 'orca', name: 'Audit', machine: 'cam-mbp', target: { kind: 'machine', name: 'cam-mbp' } }),
    summary({ id: 'arbor:b', name: 'Changelog', machine: 'cam-mbp', target: { kind: 'machine', name: 'cam-mbp' } }),
    summary({ id: 'arbor:c', name: 'Best placed', machine: null, target: { kind: 'best' } }),
    summary({ id: 'arbor:d', name: 'Pooled', machine: null, target: { kind: 'pool', id: 'builds' } }),
    summary({}),
  ];

  it('lists Arbor’s own first, by name, and keeps one a pool places on every machine', () => {
    const shown = filterAutomations(automations, { search: '', source: 'all', machine: 'cam-mbp' });
    expect(shown.map((item) => item.id)).toEqual(['arbor:c', 'arbor:b', 'arbor:d', 'orca:1']);
    expect(filterAutomations(automations, { search: 'billing', source: 'orca', machine: '' }).map((item) => item.id)).toEqual(['orca:1']);
  });

  it('narrows to on, paused or failing automations, and to one model', () => {
    const mixed = [
      summary({ id: 'arbor:on', name: 'A', model: 'claude-opus-5-5' }),
      summary({ id: 'arbor:off', name: 'B', enabled: false, agent: 'codex', model: 'gpt-6-sol', lastRun: { status: 'failed', atMs: 1 } }),
      summary({ id: 'arbor:bad', name: 'C', agent: 'codex', model: 'gpt-6-sol', lastRun: { status: 'unreachable', atMs: 1 } }),
      summary({ id: 'orca:x', source: 'orca', name: 'D', agent: null }),
    ];
    const ids = (state: 'all' | 'on' | 'paused' | 'failing', model = 'all') =>
      filterAutomations(mixed, { search: '', source: 'all', machine: '', state, model }).map((item) => item.id);
    expect(ids('on')).toEqual(['arbor:on', 'arbor:bad', 'orca:x']);
    expect(ids('paused')).toEqual(['arbor:off']);
    expect(ids('failing')).toEqual(['arbor:bad']);
    expect(ids('all', 'gpt-6-sol')).toEqual(['arbor:off', 'arbor:bad']);
    expect(automationModels(mixed)).toEqual(['claude-opus-5-5', 'gpt-6-sol']);
    // A paused one that failed counts as paused, not failing.
    expect(stateCounts(mixed, { search: '', source: 'all', machine: '' })).toEqual({ all: 4, on: 3, paused: 1, failing: 1 });
    expect(stateCounts(mixed, { search: 'gpt', source: 'all', machine: '' })).toEqual({ all: 2, on: 1, paused: 1, failing: 1 });
  });

  it('names each machine once for the picker', () => {
    expect(automationMachines(automations)).toEqual(['cam-mbp', 'cedar-02']);
  });
});

describe('alerts', () => {
  it('stays quiet on the first look, then alerts once for a run that failed', () => {
    const first = failedRunAlerts(null, list([summary({ lastRun: { status: 'failed', atMs: 10 } })]), t);
    expect(first.alerts).toEqual([]);
    const again = failedRunAlerts(first.seen, list([summary({ lastRun: { status: 'failed', atMs: 10 } })]), t);
    expect(again.alerts).toEqual([]);
    const next = failedRunAlerts(again.seen, list([summary({ lastRun: { status: 'unreachable', atMs: 20 } })]), t);
    expect(next.alerts).toHaveLength(1);
    const alert = itemAt(next.alerts, 0);
    expect(alert.kind).toBe('automationFailed');
    expect(alert.subject).toEqual({ automation: 'arbor:a', machine: 'cedar-02' });
    expect(alertDestination({ kind: alert.kind, subject: alert.subject })).toEqual({ kind: 'automation', automation: 'arbor:a' });
  });

  it('leaves runs that went well and other apps’ automations alone', () => {
    const seen = { 'arbor:a': 1, 'orca:1': 1 };
    const done = failedRunAlerts(seen, list([summary({ lastRun: { status: 'done', atMs: 5 } })]), t);
    expect(done.alerts).toEqual([]);
    const orca = failedRunAlerts(seen, list([summary({ id: 'orca:1', source: 'orca', lastRun: { status: 'failed', atMs: 5 } })]), t);
    expect(orca.alerts).toEqual([]);
  });
});

describe('the apps that keep automations', () => {
  const scan = (machine: string, apps: AutomationScan['apps']): AutomationScan => ({ machine, scannedAtMs: 1, scanning: false, error: null, apps, udian: null, placingError: null });

  it('offers an app found only on some machine once one has it, and the one picked', () => {
    expect(sourceChoices([], 'all')).toEqual(['arbor', 'codexApp', 'claudeDesktop']);
    expect(sourceChoices([scan('a', ['codexApp']), scan('b', ['superset'])], 'all')).toEqual(['arbor', 'codexApp', 'claudeDesktop', 'superset']);
    expect(sourceChoices([], 'orca')).toEqual(['arbor', 'codexApp', 'claudeDesktop', 'orca']);
  });

  it('offers ultradian on a machine whose background runner is set up, own schedules or not', () => {
    const runner: AutomationScan = { ...scan('a', []), udian: { target: 'darwin-arm64', version: '0.3.1', live: true, skill: null } };
    expect(sourceChoices([runner], 'all')).toEqual(['arbor', 'codexApp', 'claudeDesktop', 'ultradian']);
    expect(sourceChoices([{ ...runner, udian: { target: 'darwin-arm64', version: null, live: false, skill: null } }], 'all')).not.toContain('ultradian');
  });

  it('lists what starts each one: Arbor, or ultradian for Arbor’s own placed on their machine and someone’s own', () => {
    const placed = summary({ id: 'arbor:p', runsOn: 'machine' });
    const fromArbor = summary({ id: 'arbor:a' });
    const own = summary({ id: 'ultradian:cedar-02:triage', source: 'ultradian', runsOn: 'machine' });
    const orca = summary({ id: 'orca:1', source: 'orca' });
    expect([placed, fromArbor, own, orca].map(automationRunner)).toEqual(['ultradian', 'arbor', 'ultradian', 'orca']);
    const all = [placed, fromArbor, own, orca];
    expect(filterAutomations(all, { search: '', source: 'ultradian', machine: '' }).map((item) => item.id)).toEqual(['arbor:p', 'ultradian:cedar-02:triage']);
    expect(filterAutomations(all, { search: '', source: 'arbor', machine: '' }).map((item) => item.id)).toEqual(['arbor:a']);
  });

  it('sorts by next or last run, with the ones that have none last either way', () => {
    const items = [
      summary({ id: 'a', nextRunAtMs: 300, lastRun: { status: 'done', atMs: 10 } }),
      summary({ id: 'b', nextRunAtMs: 100, lastRun: null }),
      summary({ id: 'c', nextRunAtMs: 200, enabled: false, lastRun: { status: 'failed', atMs: 30 } }),
      summary({ id: 'd', nextRunAtMs: 200, lastRun: { status: 'skipped', atMs: 20 } }),
    ];
    const ids = (list: AutomationSummary[]) => list.map((item) => item.id);
    expect(ids(sortAutomations(items, null))).toEqual(['a', 'b', 'c', 'd']);
    // A paused one has no next run.
    expect(ids(sortAutomations(items, { column: 'nextRun', descending: false }))).toEqual(['b', 'd', 'a', 'c']);
    expect(ids(sortAutomations(items, { column: 'nextRun', descending: true }))).toEqual(['a', 'd', 'b', 'c']);
    expect(ids(sortAutomations(items, { column: 'lastRun', descending: true }))).toEqual(['c', 'd', 'a', 'b']);
  });

  it('says a schedule that only runs by hand', () => {
    expect(scheduleWords({ kind: 'manual' }, t)).toBe('Run by hand');
  });
});

describe('the background runner', () => {
  type Runner = Omit<UdianOnMachine, 'skill'> & { skill?: string | null };
  const scan = (machine: string, udian: Runner | null): AutomationScan => ({ machine, scannedAtMs: 1, scanning: false, error: null, apps: [], udian: udian && { skill: null, ...udian }, placingError: null });

  it('compares versions by their numbers', () => {
    expect(olderVersion('0.9.2', '1.0.0')).toBe(true);
    expect(olderVersion('1.0.10', '1.0.9')).toBe(false);
    expect(olderVersion('1.0.0', '1.0.0')).toBe(false);
    // A release candidate is newer than the release before it and older than its own release, so machines move from
    // 0.2.1 to the candidate, and from the candidate to the release.
    expect(olderVersion('0.2.1', '0.3.0-rc.1')).toBe(true);
    expect(olderVersion('0.3.0-rc.1', '0.3.0')).toBe(true);
    expect(olderVersion('0.3.0', '0.3.0-rc.1')).toBe(false);
    expect(olderVersion('0.3.0-rc.1', '0.3.0-rc.2')).toBe(true);
  });

  it('says where each machine stands, and offers to set it up only where Arbor can', () => {
    expect(runnerState(undefined, '1.0.0')).toBe('unknown');
    expect(runnerState(scan('a', { target: 'linux-x64', version: null, live: false }), '1.0.0')).toBe('missing');
    expect(runnerState(scan('a', { target: null, version: null, live: false }), '1.0.0')).toBe('unsupported');
    expect(runnerState(scan('a', { target: 'linux-x64', version: null, live: false }), null)).toBe('missing');
    expect(runnerState(scan('a', { target: 'linux-x64', version: '0.9.2', live: true }), '1.0.0')).toBe('outdated');
    expect(runnerState(scan('a', { target: 'linux-x64', version: '1.0.0', live: false }), '1.0.0')).toBe('stopped');
    expect(runnerState(scan('a', { target: 'linux-x64', version: '1.0.0', live: true }), '1.0.0')).toBe('ready');
    // A ready runner without the skill this build carries is offered it; one whose skill matches is ready.
    expect(runnerState(scan('a', { target: 'linux-x64', version: '1.0.0', live: true, skill: null }), '1.0.0', 'c1-2')).toBe('noSkill');
    expect(runnerState(scan('a', { target: 'linux-x64', version: '1.0.0', live: true, skill: 'c0-1' }), '1.0.0', 'c1-2')).toBe('noSkill');
    expect(runnerState(scan('a', { target: 'linux-x64', version: '1.0.0', live: true, skill: 'c1-2' }), '1.0.0', 'c1-2')).toBe('ready');
    expect(runnerState(scan('a', { target: 'linux-x64', version: '0.9.2', live: true, skill: null }), '1.0.0', 'c1-2')).toBe('outdated');
    expect(canInstallRunner('noSkill')).toBe(true);
    expect(canInstallRunner('ready')).toBe(false);
    expect(canInstallRunner('unsupported')).toBe(false);
    expect(canInstallRunner('outdated')).toBe(true);
  });

  it('asks before an update that starts pruning a machine\'s older runs', () => {
    expect(runnerPrunesHistory(scan('a', { target: 'linux-x64', version: '0.1.0', live: true }))).toBe(true);
    expect(runnerPrunesHistory(scan('a', { target: 'linux-x64', version: '0.2.0', live: true }))).toBe(false);
    expect(runnerPrunesHistory(scan('a', { target: 'linux-x64', version: null, live: false }))).toBe(false);
    expect(runnerPrunesHistory(undefined)).toBe(false);
  });

  it('lets an automation run on its machine only with one machine, a usual schedule and a runner there', () => {
    const runners = { ...list([]), scans: [scan('ready-box', { target: 'linux-x64', version: '1.0.0', live: true }), scan('bare-box', { target: 'linux-x64', version: null, live: false })] };
    expect(backgroundRunnerCheck(runners, 'ready-box', 'daily')).toBeNull();
    expect(backgroundRunnerCheck(runners, null, 'daily')).toBe('automations.runsOn.why.pool');
    // With no machine picked yet, it says to pick one rather than talk about pools.
    expect(backgroundRunnerCheck(runners, '', 'daily')).toBe('automations.runsOn.why.noMachine');
    expect(backgroundRunnerCheck(runners, 'ready-box', 'custom')).toBe('automations.runsOn.why.custom');
    expect(backgroundRunnerCheck(runners, 'bare-box', 'daily')).toBe('automations.runsOn.why.notSetUp');
    expect(backgroundRunnerCheck(null, 'ready-box', 'daily')).toBe('automations.runsOn.why.notSetUp');
  });
});

describe('an automation with nowhere to run', () => {
  const pool = { id: 'builds' } as MachinePool;
  it('is one aimed at the old best machine or a removed pool', () => {
    expect(automationTargetGone(summary({ target: { kind: 'best' } }), [pool])).toBe('best');
    expect(automationTargetGone(summary({ target: { kind: 'pool', id: 'gone' } }), [pool])).toBe('pool');
    expect(automationTargetGone(summary({ target: { kind: 'pool', id: 'builds' } }), [pool])).toBeNull();
    expect(automationTargetGone(summary({ target: { kind: 'machine', name: 'ci-01' } }), [])).toBeNull();
    // Until the pools are read, a pool isn't called gone; another app's automation runs where that app says.
    expect(automationTargetGone(summary({ target: { kind: 'pool', id: 'gone' } }), null)).toBeNull();
    expect(automationTargetGone(summary({ source: 'codexApp', target: { kind: 'best' } }), [pool])).toBeNull();
  });
});

describe('what stops Arbor’s automations starting', () => {
  it('says all are off first, then a missing key for agents that go through the proxy', () => {
    expect(automationHold(null, 'claude')).toBeNull();
    expect(automationHold({ running: false, proxyKey: true }, 'pi')).toBe('off');
    expect(automationHold({ running: true, proxyKey: false }, 'claude')).toBe('noKey');
    expect(automationHold({ running: true, proxyKey: false }, 'codex')).toBe('noKey');
    // Other agents keep their own setup, so they don't need the key.
    expect(automationHold({ running: true, proxyKey: false }, 'pi')).toBeNull();
    expect(automationHold({ running: true, proxyKey: true }, 'claude')).toBeNull();
  });

  it('notes the list only for Arbor’s own automations that are on', () => {
    const noKey = { ...list([summary({ agent: 'claude' })]), proxyKey: false };
    expect(automationsHold(noKey)).toBe('noKey');
    expect(automationsHold({ ...noKey, automations: [summary({ enabled: false })] })).toBeNull();
    expect(automationsHold({ ...noKey, automations: [summary({ source: 'codexApp' })] })).toBeNull();
    expect(automationsHold({ ...list([summary({})]), running: false })).toBe('off');
    expect(automationsHold(null)).toBeNull();
  });
});

describe('folding automations of the same name', () => {
  const scanOn = (machine: string, overrides: Partial<AutomationSummary> = {}) =>
    summary({ id: `ultradian:${machine}:cofactor-scan`, source: 'ultradian', runsOn: 'machine', name: 'cofactor-scan', machine, target: { kind: 'machine', name: machine }, ...overrides });
  const items = [
    scanOn('cam-mbp', { nextRunAtMs: 300, lastRun: { status: 'done', atMs: 50 } }),
    summary({ id: 'arbor:a', name: 'Sentry watch' }),
    scanOn('cedar-02', { nextRunAtMs: 100, lastRun: { status: 'failed', atMs: 40 } }),
    scanOn('ci-01', { name: 'Cofactor  Scan', enabled: false, nextRunAtMs: 50, schedule: { kind: 'daily', hour: 1, minute: 0 } }),
    // Same name, but Orca runs it, so it's another thing.
    summary({ id: 'orca:1', source: 'orca', name: 'cofactor-scan' }),
  ];
  const kinds = (rows: ReturnType<typeof automationRows>) => rows.map((row) => (row.kind === 'group' ? `group(${row.items.length})` : row.inGroup ? `  ${row.item.id}` : row.item.id));

  it('folds the same name and runner into one row where the first was, and opens onto them', () => {
    expect(kinds(automationRows(items, { grouped: false, open: new Set() }))).toEqual(items.map((item) => item.id));
    const folded = automationRows(items, { grouped: true, open: new Set() });
    expect(kinds(folded)).toEqual(['group(3)', 'arbor:a', 'orca:1']);
    const group = itemAt(folded, 0);
    if (group.kind !== 'group') throw new Error('a fold');
    expect(kinds(automationRows(items, { grouped: true, open: new Set([group.key]) }))).toEqual(['group(3)', '  ultradian:cam-mbp:cofactor-scan', '  ultradian:cedar-02:cofactor-scan', '  ultradian:ci-01:cofactor-scan', 'arbor:a', 'orca:1']);
  });

  it('folds names that differ only in case, spacing, hyphens and underscores', () => {
    expect(kinds(automationRows([scanOn('a', { name: 'Cofactor scan' }), scanOn('b', { name: ' cofactor__SCAN ' })], { grouped: true, open: new Set() }))).toEqual(['group(2)']);
  });

  it('sums a fold up: its machines, what they share, the soonest next run, the newest last run and how many fail', () => {
    const together = automationGroupSummary([itemAt(items, 0), itemAt(items, 2), itemAt(items, 3)]);
    expect(together.machines).toEqual(['cam-mbp', 'cedar-02', 'ci-01']);
    expect(together.schedule).toEqual({ value: null, varies: true });
    expect(together.project).toEqual({ value: 'billing', varies: false });
    // The paused one's next run doesn't count.
    expect(together.nextRunAtMs).toBe(100);
    expect(together.lastRun).toEqual({ status: 'done', atMs: 50 });
    expect(together.failing).toBe(1);
    expect(together.enabled).toBe(2);
    expect(automationGroupSummary([itemAt(items, 0), itemAt(items, 2)]).schedule).toEqual({ value: { kind: 'everyHours', hours: 1, minute: 0 }, varies: false });
  });
});

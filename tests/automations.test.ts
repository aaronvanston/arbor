import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import { alertDestination } from '../src/services/alertHistory';
import {
  automationMachines,
  choiceSummary,
  failedRunAlerts,
  automationAgents,
  filterAutomations,
  scheduleChoice,
  scheduleRule,
  scheduleWords,
  switchSchedule,
} from '../src/services/automations';
import type { AutomationList, AutomationSummary } from '../src/native/types';
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
  schedule: { kind: 'everyHours', hours: 1, minute: 0 },
  nextRunAtMs: null,
  lastRun: null,
  hasPrecheck: true,
  abilities: { edit: true, pause: true, runNow: true, delete: true, copy: false },
  ...overrides,
});

const list = (automations: AutomationSummary[]): AutomationList => ({ automations, scans: [], running: true, draftModel: 'gpt-6-luna', draftEffort: 'low' });

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
    summary({ id: 'orca:1', source: 'orca', name: 'Audit', machine: 'casey-mbp', target: { kind: 'machine', name: 'casey-mbp' } }),
    summary({ id: 'arbor:b', name: 'Changelog', machine: 'casey-mbp', target: { kind: 'machine', name: 'casey-mbp' } }),
    summary({ id: 'arbor:c', name: 'Best placed', machine: null, target: { kind: 'best' } }),
    summary({ id: 'arbor:d', name: 'Pooled', machine: null, target: { kind: 'pool', id: 'builds' } }),
    summary({}),
  ];

  it('lists Arbor’s own first, by name, and keeps one a pool places on every machine', () => {
    const shown = filterAutomations(automations, { search: '', source: 'all', machine: 'casey-mbp' });
    expect(shown.map((item) => item.id)).toEqual(['arbor:c', 'arbor:b', 'arbor:d', 'orca:1']);
    expect(filterAutomations(automations, { search: 'billing', source: 'orca', machine: '' }).map((item) => item.id)).toEqual(['orca:1']);
  });

  it('narrows to on, paused or failing automations, and to one agent', () => {
    const mixed = [
      summary({ id: 'arbor:on', name: 'A', agent: 'claude' }),
      summary({ id: 'arbor:off', name: 'B', enabled: false, agent: 'codex', lastRun: { status: 'failed', atMs: 1 } }),
      summary({ id: 'arbor:bad', name: 'C', agent: 'codex', lastRun: { status: 'unreachable', atMs: 1 } }),
      summary({ id: 'orca:x', source: 'orca', name: 'D', agent: null }),
    ];
    const ids = (state: 'all' | 'on' | 'paused' | 'failing', agent: 'all' | 'codex' | 'other' = 'all') =>
      filterAutomations(mixed, { search: '', source: 'all', machine: '', state, agent }).map((item) => item.id);
    expect(ids('on')).toEqual(['arbor:on', 'arbor:bad', 'orca:x']);
    expect(ids('paused')).toEqual(['arbor:off']);
    expect(ids('failing')).toEqual(['arbor:bad']);
    expect(ids('all', 'codex')).toEqual(['arbor:off', 'arbor:bad']);
    expect(ids('all', 'other')).toEqual(['orca:x']);
    expect(automationAgents(mixed)).toEqual(['claude', 'codex', 'other']);
  });

  it('names each machine once for the picker', () => {
    expect(automationMachines(automations)).toEqual(['casey-mbp', 'cedar-02']);
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

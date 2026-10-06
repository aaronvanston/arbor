import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import type { AutomationList, AutomationSummary, MachineHealth } from '../src/native/types';
import { parseAlertHistory, withAlert, type AlertHistory, type AlertRecord } from '../src/services/alertHistory';
import { failedRunAlerts } from '../src/services/automations';
import {
  backgroundBootUrl,
  CARRY_FRESH_MS,
  carriedHistory,
  carriedTimes,
  hiddenAt,
  lookedAt,
  readCarry,
  RELOAD_AFTER_MS,
  RELOAD_CHECK_MS,
  reloadBlock,
  SHOWN_TRACK,
  startsInBackground,
  TRAY_KEPT_MS,
  trayPushWaits,
  withoutBootMark,
  writeCarry,
  type AwayTrack,
  type ReloadInputs,
} from '../src/services/backgroundReload';
import { MACHINE_DOWN_AFTER_MS, nextMachineNotifications } from '../src/services/machineAlerts';
import { holdingReload, holdReload, holdReloadWhile, reloadHolds } from '../src/services/reloadHolds';

const MINUTE = 60_000;
const T0 = 1_000 * MINUTE;
const FREE = { unsaved: false, dialog: false, busy: false };

/** The window hidden at T0, then looked at every five minutes in `places`. */
function lookedAtEach(places: Parameters<typeof lookedAt>[1][]): { track: AwayTrack; nowMs: number } {
  let track = hiddenAt(SHOWN_TRACK, T0);
  let nowMs = T0;
  for (const place of places) {
    nowMs += RELOAD_CHECK_MS;
    track = lookedAt(track, place, nowMs);
  }
  return { track, nowMs };
}

const due = (inputs: Partial<ReloadInputs> & Pick<ReloadInputs, 'track' | 'nowMs'>) => reloadBlock({ shell: true, page: FREE, holds: [], ...inputs });

describe('when the hidden window reloads into a fresh page', () => {
  it('reloads once it has been closed or minimized for half an hour, counted from when it hid', () => {
    const fiveLooks = lookedAtEach(Array(5).fill('away'));
    expect(fiveLooks.nowMs - T0).toBe(25 * MINUTE);
    expect(due(fiveLooks)).toBe('too-soon');
    const sixLooks = lookedAtEach(Array(6).fill('away'));
    expect(sixLooks.nowMs - T0).toBe(RELOAD_AFTER_MS);
    expect(due(sixLooks)).toBeNull();
  });

  it('never reloads a window that is only covered, and counts afresh once it is closed after being covered', () => {
    expect(due(lookedAtEach(Array(24).fill('covered')))).toBe('not-away');
    // Covered for ten minutes, then closed: half an hour from the first look that found it closed.
    const closedLater = lookedAtEach(['covered', 'covered', ...Array(6).fill('away')]);
    expect(closedLater.track.awaySinceMs).toBe(T0 + 3 * RELOAD_CHECK_MS);
    expect(due(closedLater)).toBe('too-soon');
    expect(due(lookedAtEach(['covered', 'covered', ...Array(7).fill('away')]))).toBeNull();
    // Covered again in between starts the count over.
    expect(due(lookedAtEach([...Array(5).fill('away'), 'covered', 'away', 'away']))).toBe('too-soon');
  });

  it('forgets the count once the window shows, and hiding again while hidden keeps it', () => {
    const { track } = lookedAtEach(Array(7).fill('away'));
    expect(lookedAt(track, 'shown', T0 + 40 * MINUTE)).toEqual(SHOWN_TRACK);
    expect(hiddenAt(track, T0 + 40 * MINUTE)).toBe(track);
  });

  it('leaves a page that started in the background and was never shown alone: it has nothing to let go of', () => {
    expect(due({ ...lookedAtEach(Array(12).fill('away')), shell: false })).toBe('no-page');
  });

  it('waits while the page has unsaved edits, a dialog (a sign-in or a confirmation) or work going on', () => {
    const away = lookedAtEach(Array(7).fill('away'));
    expect(due({ ...away, page: { ...FREE, unsaved: true } })).toBe('unsaved');
    expect(due({ ...away, page: { ...FREE, dialog: true } })).toBe('dialog');
    expect(due({ ...away, page: { ...FREE, busy: true } })).toBe('busy');
  });

  it('waits while an alert goes out, the command line is answered, a cap is applied or an update waits or installs', () => {
    const away = lookedAtEach(Array(7).fill('away'));
    for (const hold of ['alert', 'cli', 'caps', 'update', 'confirmation'] as const) expect(due({ ...away, holds: [hold] })).toBe(hold);
  });
});

describe('what holds the reload', () => {
  it('holds while work runs, each release counting once, and lets go when the work fails too', async () => {
    const first = holdReload('alert');
    const second = holdReload('alert');
    expect(reloadHolds()).toEqual(['alert']);
    first();
    first();
    expect(reloadHolds()).toEqual(['alert']);
    second();
    expect(reloadHolds()).toEqual([]);
    const failing = holdingReload('caps', async () => {
      expect(reloadHolds()).toEqual(['caps']);
      throw new Error('the core is down');
    });
    await expect(failing).rejects.toThrow('the core is down');
    expect(reloadHolds()).toEqual([]);
  });

  it('holds for as long as a condition says so', () => {
    let waiting = true;
    const stop = holdReloadWhile('update', () => waiting);
    expect(reloadHolds()).toEqual(['update']);
    waiting = false;
    expect(reloadHolds()).toEqual([]);
    waiting = true;
    stop();
    expect(reloadHolds()).toEqual([]);
  });
});

describe('starting in the background', () => {
  it('reloads to the same address marked, keeping the mock’s flags, and drops the mark once started', () => {
    const marked = backgroundBootUrl('tauri://localhost/?size=real');
    expect(marked).toBe('tauri://localhost/?size=real&boot=background');
    expect(withoutBootMark(marked)).toBe('tauri://localhost/?size=real');
  });

  it('starts in the background only while the window is still hidden', () => {
    const marked = backgroundBootUrl('tauri://localhost/');
    expect(startsInBackground(marked, true)).toBe(true);
    expect(startsInBackground(marked, false)).toBe(false);
    expect(startsInBackground('tauri://localhost/', true)).toBe(false);
  });
});

describe('the tray across a reload', () => {
  it('leaves the tray as it was while a reloaded page takes its first readings, for a minute at most', () => {
    expect(trayPushWaits(true, true, 0)).toBe(true);
    expect(trayPushWaits(true, true, TRAY_KEPT_MS - 1)).toBe(true);
    expect(trayPushWaits(true, true, TRAY_KEPT_MS)).toBe(false);
    // A reading goes straight through, and a page started any other way clears the tray as it always has.
    expect(trayPushWaits(false, true, 0)).toBe(false);
    expect(trayPushWaits(true, false, 0)).toBe(false);
  });
});

describe('what a reload carries over', () => {
  const usage = { kind: 'main', page: 'usage', params: { tab: 'requests', machine: 'cam-mbp' } };
  const history = { entries: [{ kind: 'main', page: 'home' }, usage, { kind: 'settings', page: 'routing' }], index: 1 };

  it('takes back the views and their params, on the step it was on', () => {
    const values = readCarry(writeCarry({ history }, T0), T0 + MINUTE);
    expect(carriedHistory(values.history)).toEqual(history as never);
  });

  it('drops a step this version doesn’t know, and anything stale, damaged or unexpected', () => {
    const odd = { entries: [{ kind: 'main', page: 'agents' }, usage, { kind: 'settings', page: 'auth-files' }], index: 1 };
    expect(carriedHistory(odd)).toEqual({ entries: [usage], index: 0 } as never);
    expect(carriedHistory({ entries: [usage], index: 3 })).toBeNull();
    expect(carriedHistory({ entries: [{ kind: 'main', page: 'usage', params: { tab: 4 } }], index: 0 })).toBeNull();
    expect(readCarry(writeCarry({ history }, T0), T0 + CARRY_FRESH_MS + 1)).toEqual({});
    expect(readCarry('{"savedAtMs":', T0)).toEqual({});
    expect(readCarry(null, T0)).toEqual({});
    expect(carriedTimes({ 'arbor:a': 'yesterday' })).toBeNull();
  });
});

const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);

describe('no alert goes out twice across a reload', () => {
  const record = (atMs: number): AlertRecord => ({
    id: `a${atMs}`, atMs, kind: 'machineDown', title: 'ci-01 is unreachable', body: 'No answer for 6m.', urgent: true, subject: { machine: 'ci-01' },
  });

  it('folds a repeat into what the history kept, so the new page doesn’t send it again', () => {
    const sent = withAlert({ entries: [], seenAtMs: 0 }, record(T0), T0);
    expect(sent.deliver).toBe(true);
    // The new page reads the history back from where it was saved.
    const reloaded: AlertHistory = parseAlertHistory(JSON.stringify(sent.history));
    const repeat = withAlert(reloaded, record(T0 + 2 * MINUTE), T0 + 2 * MINUTE);
    expect(repeat.deliver).toBe(false);
    expect(repeat.history.entries[0]?.count).toBe(2);
  });

  it('keeps a down machine’s count going rather than starting it over, and doesn’t announce one already announced', () => {
    const health = (name: string): MachineHealth => ({
      machine: name, host: { machine: name, endpoint: name, port: 22, enabled: true, source: 'manual' }, local: false,
      status: 'unreachable', score: null, reason: null, facts: null, latest: null, points: [],
      error: `ssh: connect to host ${name} port 22: Connection refused`, lastOkAt: 0, lastAttemptAt: T0 + 4 * MINUTE, pingTarget: null, path: null,
      agents: { claude: null, codex: null, checkedAt: 0, error: null, updating: [], reporter: { installed: false, homes: [] }, t3: null, orca: null },
    });
    // Down since T0 + 2m, not announced yet, when the window reloads at T0 + 4m; the page before last resumed at T0.
    const counting = { 'ci-01': { downSinceMs: T0 + 2 * MINUTE, notified: false } };
    const later = T0 + 2 * MINUTE + MACHINE_DOWN_AFTER_MS;
    const carried = nextMachineNotifications(counting, [{ ...health('ci-01'), lastAttemptAt: later }], later, { offline: false, resumedAtMs: T0 });
    expect(carried.alerts.map((alert) => alert.kind)).toEqual(['down']);
    // Taken as a fresh resume instead, the count would start over at the reload.
    const restarted = nextMachineNotifications(counting, [{ ...health('ci-01'), lastAttemptAt: later }], later, { offline: false, resumedAtMs: T0 + 4 * MINUTE });
    expect(restarted.alerts).toEqual([]);
    const announced = nextMachineNotifications(carried.state, [{ ...health('ci-01'), lastAttemptAt: later + MINUTE }], later + MINUTE, { offline: false, resumedAtMs: T0 });
    expect(announced.alerts).toEqual([]);
  });

  it('alerts for an automation run that failed during the reload, and not for one alerted before it', () => {
    const summary = (lastRun: AutomationSummary['lastRun']): AutomationSummary => ({
      id: 'arbor:a', source: 'arbor', name: 'Sentry watch', enabled: true, machine: 'cedar-02', target: { kind: 'machine', name: 'cedar-02' },
      project: 'billing', agent: 'claude', model: null, schedule: { kind: 'everyHours', hours: 1, minute: 0 }, nextRunAtMs: null, lastRun,
    } as AutomationSummary);
    const list = (automations: AutomationSummary[]) => ({ automations, scans: [], running: true, draftModel: 'gpt-6-luna', draftEffort: 'low', udianBundled: '1.0.0', agents: ['claude'], proxyKey: true, proxyAddress: '', appsOff: [] }) as unknown as AutomationList;
    const before = failedRunAlerts({}, list([summary({ status: 'failed', atMs: 10 })]), t);
    expect(before.alerts).toHaveLength(1);
    const seen = carriedTimes(readCarry(writeCarry({ 'automations.seen': before.seen }, T0), T0)['automations.seen']);
    expect(failedRunAlerts(seen, list([summary({ status: 'failed', atMs: 10 })]), t).alerts).toEqual([]);
    expect(failedRunAlerts(seen, list([summary({ status: 'failed', atMs: 20 })]), t).alerts).toHaveLength(1);
    // Without the carry, the new page's first look would only note where things stand, and miss it.
    expect(failedRunAlerts(null, list([summary({ status: 'failed', atMs: 20 })]), t).alerts).toEqual([]);
  });
});

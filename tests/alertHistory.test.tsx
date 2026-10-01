import { afterEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { renderToStaticMarkup } from 'react-dom/server';
import { alertToast } from '../src/components/AlertCoordinator';
import { I18nProvider, translate } from '../src/i18n';
import { machinesView, type AppView } from '../src/navigation';
import { AlertsPage } from '../src/pages/AlertsPage';
import { mockCommands } from '../src/dev/mock/answers';
import {
  ALERT_HISTORY_DAYS,
  ALERT_HISTORY_LIMIT,
  ALERT_REPEAT_WINDOW_MS,
  alertDestination,
  alertMachines,
  alertsByDay,
  alertsOn,
  clearAlertHistory,
  getAlertHistory,
  markAlertRead,
  markAlertsSeen,
  parseAlertHistory,
  recordAlertDelivery,
  recordAlerts,
  resetAlertHistory,
  restoreAlerts,
  showUnreadAlertsInTray,
  startOfDay,
  unreadAlerts,
  withAlert,
  withAlerts,
  withRestoredAlerts,
  type AlertHistory,
  type AlertRecord,
} from '../src/services/alertHistory';
import { itemAt } from './support/items';

const DAY = 24 * 3_600_000;
const record = (id: string, atMs: number, fields: Partial<AlertRecord> = {}): AlertRecord => ({
  id, atMs, kind: 'machineDown', title: `Alert ${id}`, body: 'No answer to its health checks for 6m.', urgent: false, ...fields,
});
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

afterEach(() => resetAlertHistory());

describe('the alert history', () => {
  it('keeps alerts newest first, for a month and up to a limit', () => {
    const now = 100 * DAY;
    const history = withAlerts({ entries: [record('old', now - 2 * DAY)], seenAtMs: 0 }, [record('a', now), record('b', now)], now);
    // Sent together, they stay in the order they were sent.
    expect(history.entries.map((entry) => entry.id)).toEqual(['a', 'b', 'old']);
    expect(withAlerts(history, [], now + (ALERT_HISTORY_DAYS - 1) * DAY).entries.map((entry) => entry.id)).toEqual(['a', 'b']);
    const many = Array.from({ length: ALERT_HISTORY_LIMIT + 5 }, (_, index) => record(String(index), now));
    expect(withAlerts({ entries: [], seenAtMs: 0 }, many, now).entries).toHaveLength(ALERT_HISTORY_LIMIT);
  });

  it('records each alert, how it got out, and what’s unread until the page shows it', () => {
    const recorded = recordAlerts([
      { title: 'ci-01 is unreachable', body: 'No answer for 6m.', kind: 'machineDown', urgent: true, subject: { machine: 'ci-01' } },
      { title: 'Claude account paused', body: 'work has used 81%.', kind: 'accountPaused' },
    ], 5_000);
    expect(recorded.map((alert) => alert.deliver)).toEqual([true, true]);
    const ids = recorded.map((alert) => alert.id);
    expect(ids).toHaveLength(2);
    expect(unreadAlerts(getAlertHistory())).toBe(2);
    recordAlertDelivery(ids, { mac: 'shown' });
    recordAlertDelivery(ids.slice(1), { phone: 'The webhook refused the alert (HTTP 500)' });
    recordAlertDelivery(ids.slice(0, 1), { phone: null });
    expect(getAlertHistory().entries).toEqual([
      {
        id: ids[0]!, atMs: 5_000, kind: 'machineDown', title: 'ci-01 is unreachable', body: 'No answer for 6m.', urgent: true,
        subject: { machine: 'ci-01' }, mac: 'shown', phone: null,
      },
      {
        id: ids[1]!, atMs: 5_000, kind: 'accountPaused', title: 'Claude account paused', body: 'work has used 81%.', urgent: false,
        mac: 'shown', phone: 'The webhook refused the alert (HTTP 500)',
      },
    ]);
    markAlertsSeen(6_000);
    expect(unreadAlerts(getAlertHistory())).toBe(0);
    recordAlerts([{ title: 'ci-01 is back', body: 'It answers again.', kind: 'machineUp' }], 7_000);
    expect(unreadAlerts(getAlertHistory())).toBe(1);
    clearAlertHistory();
    expect(getAlertHistory()).toEqual({ entries: [], seenAtMs: 6_000 });
  });

  it('puts cleared alerts back exactly on Undo, beside any that came in since', () => {
    resetAlertHistory({
      seenAtMs: 6_000,
      entries: [
        record('b', 5_000, { mac: 'shown', phone: null, subject: { machine: 'ci-01' } }),
        record('a', 5_000, { kind: 'accountPaused', urgent: true }),
        record('old', 1_000, { mac: 'off' }),
      ],
    });
    const before = getAlertHistory();
    const cleared = clearAlertHistory();
    expect(cleared.entries).toEqual(before.entries);
    expect(getAlertHistory().entries).toEqual([]);
    restoreAlerts(cleared);
    expect(getAlertHistory()).toEqual(before);

    // One that fired during the Undo window stays, and new, above the ones put back.
    const again = clearAlertHistory();
    const fresh = itemAt(recordAlerts([{ title: 'ci-01 is back', body: 'It answers again.', kind: 'machineUp' }], 7_000), 0).id;
    restoreAlerts(again);
    expect(getAlertHistory().entries.map((entry) => entry.id)).toEqual([fresh, 'b', 'a', 'old']);
    expect(unreadAlerts(getAlertHistory())).toBe(1);

    // Clearing what a filter shows leaves the rest, and Undo puts those back in place.
    const beforeFiltered = getAlertHistory();
    const machines = clearAlertHistory('machines');
    expect(machines.entries.map((entry) => entry.id)).toEqual([fresh, 'b', 'old']);
    expect(getAlertHistory().entries.map((entry) => entry.id)).toEqual(['a']);
    restoreAlerts(machines);
    expect(getAlertHistory()).toEqual(beforeFiltered);
    // A filter with nothing in it clears nothing, and leaves the history untouched.
    const settled = getAlertHistory();
    expect(clearAlertHistory('digests').entries).toEqual([]);
    expect(getAlertHistory()).toBe(settled);

    // Putting back what's already there doesn't double it, and the count kept still holds.
    expect(withRestoredAlerts(before, { entries: before.entries, order: [] })).toEqual(before);
    const many = Array.from({ length: ALERT_HISTORY_LIMIT }, (_, index) => record(`m${index}`, 2_000));
    expect(withRestoredAlerts({ entries: [record('new', 9_000)], seenAtMs: 0 }, { entries: many, order: [] }).entries).toHaveLength(ALERT_HISTORY_LIMIT);
  });

  it('narrows to the alerts on one machine, and clears only those', () => {
    const heavy = record('heavy', 4_000, { kind: 'heavySession', subject: { session: 's-1', on: 'casey-mbp' } });
    const down = record('down', 3_000, { subject: { machine: 'ci-01' } });
    const both = record('both', 2_000, { subject: { machines: ['ci-01', 'casey-mbp'] } });
    const none = record('none', 1_000, { kind: 'outage', subject: { url: 'https://status.example.com' } });
    expect(alertMachines(heavy)).toEqual(['casey-mbp']);
    expect(alertMachines(none)).toEqual([]);
    const entries = [heavy, down, both, none];
    expect(alertsOn(entries, '').map((entry) => entry.id)).toEqual(['heavy', 'down', 'both', 'none']);
    expect(alertsOn(entries, 'casey-mbp').map((entry) => entry.id)).toEqual(['heavy', 'both']);
    expect(alertsOn(entries, 'ci-01').map((entry) => entry.id)).toEqual(['down', 'both']);

    resetAlertHistory({ seenAtMs: 0, entries });
    const cleared = clearAlertHistory('machines', 'ci-01');
    expect(cleared.entries.map((entry) => entry.id)).toEqual(['down', 'both']);
    expect(getAlertHistory().entries.map((entry) => entry.id)).toEqual(['heavy', 'none']);
    restoreAlerts(cleared);
    expect(getAlertHistory().entries).toEqual(entries);
  });

  it('still folds a session alert that notes the machine it happened on', () => {
    const first = withAlert({ entries: [], seenAtMs: 0 }, record('one', 1_000, { kind: 'heavySession', subject: { session: 's-1', on: 'casey-mbp' } }), 1_000);
    const again = withAlert(first.history, record('two', 2_000, { kind: 'heavySession', subject: { session: 's-1', on: 'casey-mbp' } }), 2_000);
    expect(again.history.entries).toHaveLength(1);
    expect(itemAt(again.history.entries, 0).count).toBe(2);
  });

  it('opens the account, machine, session or status page an alert was about', () => {
    expect(alertDestination({ kind: 'accountPaused', subject: { account: 'work.json::work' } })).toEqual({ kind: 'accounts', account: 'work.json::work' });
    expect(alertDestination({ kind: 'limitWarning', subject: { provider: 'claude' } })).toEqual({ kind: 'accounts', account: undefined });
    expect(alertDestination({ kind: 'machineUp', subject: { machine: 'ci-01' } })).toEqual({ kind: 'machines', machine: 'ci-01' });
    expect(alertDestination({ kind: 'agentPermission', subject: { session: 'a3f1', machine: 'casey-mbp' } })).toEqual({ kind: 'session', session: 'a3f1' });
    // Many sessions at once, or one Arbor didn't see: the Sessions page.
    expect(alertDestination({ kind: 'agentWaiting', subject: { machine: 'casey-mbp' } })).toEqual({ kind: 'sessions' });
    expect(alertDestination({ kind: 'heavySession', subject: { session: 'b7' } })).toEqual({ kind: 'session', session: 'b7' });
    expect(alertDestination({ kind: 'outage', subject: { url: 'https://status.claude.com/incidents/x' } })).toEqual({ kind: 'url', url: 'https://status.claude.com/incidents/x' });
    expect(alertDestination({ kind: 'outage' })).toEqual({ kind: 'home' });
    expect(alertDestination({ kind: 'digest' })).toEqual({ kind: 'digest' });
    expect(alertDestination({ kind: 'test' })).toBeNull();
  });

  it('reads back only what it can show', () => {
    expect(parseAlertHistory(null)).toEqual({ entries: [], seenAtMs: 0 });
    expect(parseAlertHistory('not json')).toEqual({ entries: [], seenAtMs: 0 });
    const stored = JSON.stringify({ seenAtMs: 9, entries: [record('a', 1), { id: 'b', atMs: 2, kind: 'somethingNew', title: 'x', body: 'y' }, null] });
    expect(parseAlertHistory(stored)).toEqual({ entries: [record('a', 1)], seenAtMs: 9 });
  });

  it('splits alerts into the days they fired on', () => {
    const today = startOfDay(Date.now());
    const days = alertsByDay([record('a', today + 3_600_000), record('b', today + 60_000), record('c', today - 60_000)]);
    expect(days.map((day) => [day.dayMs === today, day.entries.map((entry) => entry.id)])).toEqual([[true, ['a', 'b']], [false, ['c']]]);
  });

  it('lists them by day, marks what’s new, and says when one didn’t get out', () => {
    const today = startOfDay(Date.now());
    resetAlertHistory({
      seenAtMs: today + 1_000,
      entries: [
        record('new', today + 2_000, { title: 'ci-01 is unreachable', mac: 'shown', phone: 'The webhook refused the alert (HTTP 500)' }),
        record('seen', today + 500, { kind: 'agentWaiting', title: 'Codex is waiting for you', body: 'api · main on cedar-02', mac: 'off', phone: null }),
        record('older', today - 3_600_000, { kind: 'digest', title: 'Your week with Claude and Codex' }),
      ],
    });
    const html = text(renderToStaticMarkup(<I18nProvider><AlertsPage coreReady onNavigate={() => undefined} /></I18nProvider>));
    expect(html).toContain('Today ci-01 is unreachable New');
    expect(html).toContain('Didn’t reach your phone: The webhook refused the alert (HTTP 500)');
    expect(html).toContain('Codex is waiting for you Sent to your phone');
    expect(html).toContain('This Mac didn’t show it: notifications are off for Arbor in System Settings.');
    expect(html).toContain('Yesterday Your week with Claude and Codex');
    expect(html).toContain('Alerts are kept for 30 days.');
    expect(html.match(/ New /g)).toHaveLength(1);

    resetAlertHistory();
    expect(text(renderToStaticMarkup(<I18nProvider><AlertsPage coreReady onNavigate={() => undefined} /></I18nProvider>))).toContain('No alerts yet');
  });
});

describe('repeated alerts', () => {
  const MINUTE = 60_000;
  // As LimitsMonitor raises it: about the provider's limits, not an account.
  const waiting = (id: string, atMs: number, fields: Partial<AlertRecord> = {}) =>
    record(id, atMs, { kind: 'limitWarning', title: 'Claude is running out early', subject: { provider: 'claude' }, ...fields });
  const empty: AlertHistory = { entries: [], seenAtMs: 0 };
  /** Adds alerts one after another, noting which went out. */
  const run = (history: AlertHistory, records: AlertRecord[]) => records.reduce(
    (state, next) => {
      const added = withAlert(state.history, next, next.atMs);
      return { history: added.history, sent: [...state.sent, ...(added.deliver ? [next.id] : [])] };
    },
    { history, sent: [] as string[] },
  );

  it('folds a repeat about the same thing into one entry with a count, and sends it once', () => {
    const { history, sent } = run(empty, [waiting('a', 0), waiting('b', 3 * MINUTE, { body: 'later' }), waiting('c', 6 * MINUTE, { body: 'latest' })]);
    expect(sent).toEqual(['a']);
    expect(history.entries).toHaveLength(1);
    // The entry keeps its id and shows the latest one.
    expect(itemAt(history.entries, 0)).toMatchObject({ id: 'a', atMs: 6 * MINUTE, body: 'latest', count: 3, notifiedAtMs: 0 });
  });

  it('sends a steady repeat again once a window has passed since it last went out', () => {
    const { history, sent } = run(empty, [0, 4, 8, 12, 16, 20].map((minute) => waiting(`m${minute}`, minute * MINUTE)));
    expect(sent).toEqual(['m0', 'm12']);
    expect(itemAt(history.entries, 0)).toMatchObject({ id: 'm0', count: 6, notifiedAtMs: 12 * MINUTE });
  });

  it('starts a new entry once a repeat comes in after the window', () => {
    const { history, sent } = run(empty, [waiting('a', 0), waiting('b', ALERT_REPEAT_WINDOW_MS + 1)]);
    expect(sent).toEqual(['a', 'b']);
    expect(history.entries.map((entry) => [entry.id, entry.count])).toEqual([['b', undefined], ['a', undefined]]);
  });

  it('sends a repeat straight away when it’s more urgent than before', () => {
    const { history, sent } = run(empty, [waiting('a', 0), waiting('b', MINUTE, { urgent: true }), waiting('c', 2 * MINUTE)]);
    expect(sent).toEqual(['a', 'b']);
    // Once urgent, it stays so.
    expect(itemAt(history.entries, 0)).toMatchObject({ id: 'a', urgent: true, count: 3, notifiedAtMs: MINUTE });
  });

  it('keeps apart other kinds, other things, and a repeat after news about the same thing', () => {
    const down = (id: string, atMs: number, machine = 'ci-01') => record(id, atMs, { kind: 'machineDown', subject: { machine } });
    const up = (id: string, atMs: number) => record(id, atMs, { kind: 'machineUp', subject: { machine: 'ci-01' } });
    // Down, back up, down again: the second "down" is news, not a repeat.
    const { history, sent } = run(empty, [down('d1', 0), up('u1', MINUTE), down('d2', 2 * MINUTE), down('other', 3 * MINUTE, 'ci-02')]);
    expect(sent).toEqual(['d1', 'u1', 'd2', 'other']);
    expect(history.entries.map((entry) => entry.id)).toEqual(['other', 'd2', 'u1', 'd1']);
    // A limit running out, back on track, then running out again: each kind has its own title, but all are about Claude.
    const limit = run(empty, [waiting('w1', 0), waiting('r1', 2 * MINUTE, { kind: 'limitRecovered', title: 'Claude is back on track' }), waiting('w2', 4 * MINUTE)]);
    expect(limit.sent).toEqual(['w1', 'r1', 'w2']);
    // Another provider's limit is another thing.
    expect(run(empty, [waiting('c', 0), waiting('x', MINUTE, { subject: { provider: 'codex' } })]).sent).toEqual(['c', 'x']);
  });

  it('never folds alerts about nothing in particular, or about several things, which a title can’t tell apart', () => {
    const many = (id: string, atMs: number, machines: string[], kind: AlertRecord['kind'] = 'machineDown') =>
      record(id, atMs, { kind, title: `${machines.length} machines are down`, subject: { machines } });
    // Two different pairs of machines going down minutes apart: both are news.
    const pairs = run(empty, [many('p1', 0, ['ci-01', 'ci-02']), many('p2', 5 * MINUTE, ['ci-03', 'ci-04'])]);
    expect(pairs.sent).toEqual(['p1', 'p2']);
    expect(pairs.history.entries.map((entry) => [entry.id, entry.count])).toEqual([['p2', undefined], ['p1', undefined]]);
    const titled = run(empty, [record('t1', 0, { kind: 'digest', title: 'Your week' }), record('t2', MINUTE, { kind: 'digest', title: 'Your week' })]);
    expect(titled.sent).toEqual(['t1', 't2']);
    expect(run(empty, [record('a', 0, { kind: 'resetReady', title: 'Codex resets ready' }), record('b', MINUTE, { kind: 'resetReady', title: 'Codex resets ready' })]).sent)
      .toEqual(['a', 'b']);
    // Back up together with another machine is still news about each, so its next "down" goes out.
    const down = (id: string, atMs: number) => record(id, atMs, { kind: 'machineDown', subject: { machine: 'ci-01' } });
    const together = run(empty, [down('d1', 0), many('u', 2 * MINUTE, ['ci-01', 'ci-02'], 'machineUp'), down('d2', 4 * MINUTE)]);
    expect(together.sent).toEqual(['d1', 'u', 'd2']);
  });

  it('moves a repeat to the top, unread again, with how it last got out dropped when it goes out again', () => {
    resetAlertHistory({ seenAtMs: 2 * MINUTE, entries: [record('other', MINUTE), waiting('a', 0, { mac: 'shown', phone: null })] });
    const [quiet] = recordAlerts([{ title: 'Claude is running out early', body: 'again', kind: 'limitWarning', subject: { provider: 'claude' } }], 3 * MINUTE);
    expect(quiet).toEqual({ id: 'a', deliver: false });
    expect(getAlertHistory().entries.map((entry) => entry.id)).toEqual(['a', 'other']);
    // Not sent again, so how it got out still stands.
    expect(itemAt(getAlertHistory().entries, 0)).toMatchObject({ count: 2, mac: 'shown', phone: null });
    expect(unreadAlerts(getAlertHistory())).toBe(1);

    const [again] = recordAlerts([{ title: 'Claude is running out early', body: 'again', kind: 'limitWarning', urgent: true, subject: { provider: 'claude' } }], 4 * MINUTE);
    expect(again).toEqual({ id: 'a', deliver: true });
    const entry = itemAt(getAlertHistory().entries, 0);
    expect(entry.count).toBe(3);
    expect(entry).not.toHaveProperty('mac');
    expect(entry).not.toHaveProperty('phone');
  });

  it('never folds agents that need you, as each is its own session waiting', () => {
    const agent = (id: string, atMs: number, kind: AlertRecord['kind'] = 'agentWaiting') =>
      record(id, atMs, { kind, title: 'Codex is waiting for you', subject: { machine: 'cedar-02' } });
    const down = (id: string, atMs: number) => record(id, atMs, { kind: 'machineDown', subject: { machine: 'cedar-02' } });
    // Two sessions on one machine that Arbor only knows by the machine, a minute apart: both show and both go out.
    const { history, sent } = run(empty, [agent('w1', 0), agent('w2', MINUTE), agent('p1', 2 * MINUTE, 'agentPermission'), agent('p2', 3 * MINUTE, 'agentPermission')]);
    expect(sent).toEqual(['w1', 'w2', 'p1', 'p2']);
    expect(history.entries.map((entry) => [entry.id, entry.count])).toEqual([['p2', undefined], ['p1', undefined], ['w2', undefined], ['w1', undefined]]);
    // And one in between doesn't make a machine's repeated "down" news again.
    const machine = run(empty, [down('d1', 0), agent('w1', MINUTE), down('d2', 2 * MINUTE)]);
    expect(machine.sent).toEqual(['d1', 'w1']);
    expect(machine.history.entries.map((entry) => [entry.id, entry.count])).toEqual([['d1', 2], ['w1', undefined]]);
  });

  it('never folds setup changes, as each lists different changes', () => {
    const change = (id: string, atMs: number) =>
      record(id, atMs, { kind: 'setupChanged', title: 'Setup changed on ci-01', subject: { machine: 'ci-01' } });
    const down = (id: string, atMs: number) => record(id, atMs, { kind: 'machineDown', subject: { machine: 'ci-01' } });
    const { history, sent } = run(empty, [change('c1', 0), change('c2', MINUTE)]);
    expect(sent).toEqual(['c1', 'c2']);
    expect(history.entries.map((entry) => [entry.id, entry.count])).toEqual([['c2', undefined], ['c1', undefined]]);
    // And one in between doesn't make a machine's repeated "down" news again.
    const machine = run(empty, [down('d1', 0), change('c1', MINUTE), down('d2', 2 * MINUTE)]);
    expect(machine.sent).toEqual(['d1', 'c1']);
    expect(machine.history.entries.map((entry) => [entry.id, entry.count])).toEqual([['d1', 2], ['c1', undefined]]);
  });

  it('keeps a count through storage, and drops one that isn’t a count', () => {
    const stored = JSON.stringify({ seenAtMs: 0, entries: [waiting('a', 5, { count: 3, notifiedAtMs: 1 }), waiting('b', 4, { count: 'x' as unknown as number, notifiedAtMs: 'y' as unknown as number })] });
    const [first, second] = parseAlertHistory(stored).entries;
    expect(first).toMatchObject({ count: 3, notifiedAtMs: 1 });
    expect(second).not.toHaveProperty('count');
    expect(second).not.toHaveProperty('notifiedAtMs');
  });

  it('shows the count on the Alerts page', () => {
    resetAlertHistory({ seenAtMs: 0, entries: [waiting('a', startOfDay(Date.now()) + 1_000, { count: 3 })] });
    const html = text(renderToStaticMarkup(<I18nProvider><AlertsPage coreReady onNavigate={() => undefined} /></I18nProvider>));
    expect(html).toContain('Claude is running out early ×3 Came in 3 times in a row');
  });
});

describe('the unread count on the tray icon', () => {
  const trayCounts: unknown[] = [];
  let stop: (() => void) | null = null;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

  const start = () => {
    Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
    mockCommands({
      set_tray_unread: ({ count }) => {
        trayCounts.push(count);
        return null;
      },
    });
    stop = showUnreadAlertsInTray();
  };

  afterEach(() => {
    stop?.();
    stop = null;
    trayCounts.length = 0;
    clearMocks();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  it('follows alerts coming in and being read, once each time it changes', () => {
    resetAlertHistory({ seenAtMs: 0, entries: [record('a', 1_000)] });
    start();
    recordAlerts([{ title: 'ci-01 is unreachable', body: 'No answer for 6m.', kind: 'machineDown', subject: { machine: 'ci-01' } }], 2_000);
    // Delivery notes don't change the count, so nothing more is sent.
    recordAlertDelivery([itemAt(getAlertHistory().entries, 0).id], { mac: 'shown' });
    markAlertsSeen(3_000);
    expect(trayCounts).toEqual([1, 2, 0]);
  });

  it('leaves the tray alone until the app turns it on', () => {
    Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
    mockCommands({
      set_tray_unread: ({ count }) => {
        trayCounts.push(count);
        return null;
      },
    });
    recordAlerts([{ title: 'ci-01 is back', body: 'It answers again.', kind: 'machineUp' }], 1_000);
    expect(trayCounts).toEqual([]);
  });
});

describe('opening an alert from its toast', () => {
  const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);
  const down = { title: 'ci-01 is unreachable', body: 'No answer for 6m.', kind: 'machineDown', urgent: true, subject: { machine: 'ci-01' } } as const;

  it('marks that alert read and goes where its row on the Alerts page does', () => {
    const [first, second] = recordAlerts([down, { title: 'Claude account paused', body: 'work has used 81%.', kind: 'accountPaused', subject: { account: 'claude-work.json' } }], 5_000);
    if (!first || !second) throw new Error('expected two alerts');
    const opened: AppView[] = [];
    const toast = alertToast({ ...down, id: first.id }, { current: { coreReady: true, onNavigate: (view) => opened.push(view), t } });
    expect(toast.action?.label).toBe('Open');
    toast.action?.onClick();
    expect(opened).toEqual([machinesView('ci-01')]);
    // Only the one opened is read; the sidebar and tray still count the other.
    expect(unreadAlerts(getAlertHistory())).toBe(1);
    expect(getAlertHistory().entries.find((entry) => entry.id === first.id)).toMatchObject({ read: true });
    expect(parseAlertHistory(JSON.stringify(getAlertHistory())).entries.find((entry) => entry.id === first.id)).toMatchObject({ read: true });
  });

  it('leaves it off the Alerts page’s new ones, and a repeat makes it new again', () => {
    const [first] = recordAlerts([down], 5_000);
    if (!first) throw new Error('expected an alert');
    markAlertRead(first.id);
    expect(unreadAlerts(getAlertHistory())).toBe(0);
    const html = text(renderToStaticMarkup(<I18nProvider><AlertsPage coreReady onNavigate={() => undefined} /></I18nProvider>));
    expect(html).not.toContain('New');
    recordAlerts([down], 6_000);
    expect(getAlertHistory().entries).toHaveLength(1);
    expect(itemAt(getAlertHistory().entries, 0)).not.toHaveProperty('read');
    expect(unreadAlerts(getAlertHistory())).toBe(1);
  });

  it('offers no Open when its page needs the core and that’s stopped', () => {
    const paused = { title: 'Claude account paused', body: 'work has used 81%.', kind: 'accountPaused', subject: { account: 'claude-work.json' } } as const;
    const [first] = recordAlerts([paused], 5_000);
    if (!first) throw new Error('expected an alert');
    const current = { current: { coreReady: false, onNavigate: () => undefined, t } };
    expect(alertToast({ ...paused, id: first.id }, current).action).toBeUndefined();
    // Machines open without the core.
    expect(alertToast({ ...down, id: first.id }, current).action?.label).toBe('Open');
  });
});

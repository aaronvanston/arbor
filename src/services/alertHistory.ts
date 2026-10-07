import { invokeCommand } from '../native/commands';
import type { SystemNotification } from './notify';
import type { AlertKind } from './phoneAlerts';
import { savedStore } from './savedStore';

/**
 * What an alert is about, so the history can open it and tell a repeat from news: an account key, a machine, a
 * session id, a status page, or a provider whose limits it's about. One alert about several accounts or machines
 * names each of them in `accounts` or `machines`. `on` is the machine it happened on when that isn't what it's about
 * (a session's), so narrowing Alerts to a machine finds it without making it about two things.
 */
export type AlertSubject = {
  account?: string;
  machine?: string;
  session?: string;
  url?: string;
  provider?: string;
  accounts?: string[];
  machines?: string[];
  on?: string;
  /** An automation, by its id. */
  automation?: string;
  /** The setup repo, by its folder. */
  repo?: string;
  /**
   * What opening it shows, beyond what it's about, so these don't count when telling a repeat from news: the provider
   * whose accounts an outage affects, the kinds of setup item a setup change touched (`hook`, `mcp`, `plugin`,
   * `marketplace`), and the setting (by its id in settingsIndex.ts) a proxy problem is fixed on. Alerts saved before
   * these existed open as they always did.
   */
  affects?: string;
  changed?: string[];
  setting?: string;
};

/** An alert as it fired, and how it got out. */
export type AlertRecord = {
  id: string;
  atMs: number;
  kind: AlertKind;
  title: string;
  body: string;
  urgent: boolean;
  subject?: AlertSubject;
  /**
   * Whether this Mac showed it: `app` when it showed in Arbor's window because that was in front, `off` when Arbor
   * isn't allowed to notify. Missing until that's known.
   */
  mac?: 'shown' | 'app' | 'off' | 'failed';
  /** How sending it to the phone went: the error, or null once it got there. Missing when phone alerts were off. */
  phone?: string | null;
  /** How many times it came in, once it has repeated; `atMs`, the title and the body are the latest one's. */
  count?: number;
  /** When a repeat last went out to the Mac and phone. Missing while it has only gone out once, at `atMs`. */
  notifiedAtMs?: number;
  /** Opened from its toast before the Alerts page showed it, so it's no longer unread though it's newer than `seenAtMs`. */
  read?: true;
};

export type AlertHistory = {
  /** Newest first. */
  entries: AlertRecord[];
  /** When the Alerts page last showed them; anything newer is unread. */
  seenAtMs: number;
};

/** Alerts are kept this many days, and at most this many of them. */
export const ALERT_HISTORY_DAYS = 30;
export const ALERT_HISTORY_LIMIT = 500;
const DAY_MS = 24 * 3_600_000;
/**
 * An alert that comes in again this soon after the last one updates that entry instead of adding one, and reaches
 * the Mac and phone at most once in this long, so a machine or limit that keeps tripping doesn't ping every time.
 */
export const ALERT_REPEAT_WINDOW_MS = 10 * 60_000;

/** What the Alerts page can narrow the list to. */
export type AlertCategory = 'limits' | 'sessions' | 'machines' | 'outages' | 'digests';
export const ALERT_CATEGORIES: readonly AlertCategory[] = ['limits', 'sessions', 'machines', 'outages', 'digests'];
const CATEGORY: Record<AlertKind, AlertCategory | null> = {
  limitWarning: 'limits',
  limitCritical: 'limits',
  limitRecovered: 'limits',
  resetReady: 'limits',
  expiring: 'limits',
  accountPaused: 'limits',
  accountResumed: 'limits',
  heavySession: 'sessions',
  agentPermission: 'sessions',
  agentWaiting: 'sessions',
  archiveAway: 'sessions',
  archiveFailing: 'sessions',
  machineDown: 'machines',
  automationFailed: 'machines',
  machineUp: 'machines',
  setupChanged: 'machines',
  setupRepo: 'machines',
  outage: 'outages',
  // The proxy's own trouble: Home says what's wrong, with the fix.
  proxySettings: 'outages',
  digest: 'digests',
  test: null,
};
export const alertCategory = (kind: AlertKind) => CATEGORY[kind];

// Read from storage too, so a list that isn't one counts as naming nothing.
const ids = (...values: unknown[]) =>
  values.flatMap((value) => (Array.isArray(value) ? value : [value])).filter((id): id is string => typeof id === 'string' && id !== '');

/** The Sync views a setup change opens on: Hooks, or MCP & plugins, which has MCP servers, plugins and marketplaces. */
export type SetupChangeView = 'hooks' | 'plugins';

/** Where opening an alert goes. */
export type AlertDestination =
  | { kind: 'accounts'; account?: string; provider?: string }
  | { kind: 'machines'; machine?: string }
  | { kind: 'automation'; automation: string }
  | { kind: 'setup'; tab?: SetupChangeView | 'repo'; machine?: string }
  | { kind: 'archive' }
  | { kind: 'session'; session: string }
  | { kind: 'sessions'; machine?: string }
  | { kind: 'setting'; setting: string }
  | { kind: 'digest' }
  | { kind: 'home' }
  | { kind: 'url'; url: string };

/** The one thing in a field and a list of them, or nothing when there are none or several. */
function onlyOne(one: unknown, many: unknown): string | undefined {
  const [first, ...others] = [...new Set(ids(one, many))];
  return first !== undefined && !others.length ? first : undefined;
}

/** The first thing named in fields and lists of them, when they name any. */
const firstOf = (...values: unknown[]): string | undefined => ids(...values)[0];

const SETUP_CHANGE_VIEW: Readonly<Record<string, SetupChangeView>> = { hook: 'hooks', mcp: 'plugins', plugin: 'plugins', marketplace: 'plugins' };

/**
 * Where a setup change opens: the Sync view that has everything that changed, on the machine it changed on; the
 * machine's own page when the changes span views; and Checks for one saved before alerts said what changed.
 */
function setupChangeDestination(subject: AlertSubject | undefined): AlertDestination {
  const machine = onlyOne(subject?.machine, subject?.machines);
  const views = [...new Set(ids(subject?.changed).flatMap((kind) => SETUP_CHANGE_VIEW[kind] ?? []))];
  const [view, ...others] = views;
  if (!view) return { kind: 'setup' };
  if (!others.length) return { kind: 'setup', tab: view, ...(machine ? { machine } : {}) };
  return machine ? { kind: 'machines', machine } : { kind: 'setup' };
}

/**
 * The page an alert is about, and the row on it when the alert names one: an account (the first when it names
 * several) or a provider's accounts, one machine's page, one machine's live sessions, the setting a proxy problem is
 * fixed on. An alert about several machines opens the page that shows them all.
 */
export function alertDestination({ kind, subject }: Pick<AlertRecord, 'kind' | 'subject'>): AlertDestination | null {
  if (kind === 'setupChanged') return setupChangeDestination(subject);
  if (kind === 'setupRepo') return { kind: 'setup', tab: 'repo' };
  if (kind === 'automationFailed' && subject?.automation) return { kind: 'automation', automation: subject.automation };
  // What's wrong with the archive, and what to do, is on its settings page.
  if (kind === 'archiveAway' || kind === 'archiveFailing') return { kind: 'archive' };
  // Fixed on its row in Settings › Proxy; a settings file the proxy didn't load is shown, with its line, on Home.
  if (kind === 'proxySettings') {
    const setting = firstOf(subject?.setting);
    return setting ? { kind: 'setting', setting } : { kind: 'home' };
  }
  switch (CATEGORY[kind]) {
    case 'limits': {
      const account = firstOf(subject?.account, subject?.accounts);
      const provider = firstOf(subject?.provider);
      return { kind: 'accounts', ...(account ? { account } : provider ? { provider } : {}) };
    }
    case 'sessions': {
      if (typeof subject?.session === 'string' && subject.session) return { kind: 'session', session: subject.session };
      const machine = onlyOne(subject?.machine, subject?.machines);
      return machine ? { kind: 'sessions', machine } : { kind: 'sessions' };
    }
    case 'machines': {
      const machine = onlyOne(subject?.machine, subject?.machines);
      return machine ? { kind: 'machines', machine } : { kind: 'machines' };
    }
    case 'outages': {
      if (typeof subject?.url === 'string' && subject.url) return { kind: 'url', url: subject.url };
      const provider = firstOf(subject?.affects);
      return provider ? { kind: 'accounts', provider } : { kind: 'home' };
    }
    case 'digests': return { kind: 'digest' };
    default: return null;
  }
}

/** Adds alerts ahead of the older ones, in the order they were sent, and lets go of those past the age or count kept. */
export function withAlerts(history: AlertHistory, records: AlertRecord[], nowMs: number): AlertHistory {
  const cutoff = nowMs - ALERT_HISTORY_DAYS * DAY_MS;
  const entries = [...records, ...history.entries].filter((entry) => entry.atMs >= cutoff).slice(0, ALERT_HISTORY_LIMIT);
  return { ...history, entries };
}

/** Each thing an alert is about, such as `machine:ci-01`, to tell a repeat from news. None when it names nothing. */
function aboutThings(subject: AlertSubject | undefined): string[] {
  if (!subject) return [];
  return [
    ...ids(subject.account, subject.accounts).map((id) => `account:${id}`),
    ...ids(subject.machine, subject.machines).map((id) => `machine:${id}`),
    ...ids(subject.session).map((id) => `session:${id}`),
    ...ids(subject.url).map((id) => `url:${id}`),
    ...ids(subject.provider).map((id) => `provider:${id}`),
    ...ids(subject.automation).map((id) => `automation:${id}`),
    ...ids(subject.repo).map((id) => `repo:${id}`),
  ];
}

/** The one thing an alert is about, or null when it names none or several. */
function aboutOne(subject: AlertSubject | undefined) {
  const [thing, ...others] = aboutThings(subject);
  return thing !== undefined && !others.length ? thing : null;
}

/** The machines an alert names or happened on. */
export function alertMachines(entry: Pick<AlertRecord, 'subject'>): string[] {
  const subject = entry.subject;
  return subject ? [...new Set(ids(subject.machine, subject.machines, subject.on))] : [];
}

/** The alerts on `machine`, as the breadcrumb picks it; `''` is all of them, and alerts that name no machine show only then. */
export function alertsOn(entries: readonly AlertRecord[], machine: string): AlertRecord[] {
  return machine ? entries.filter((entry) => alertMachines(entry).includes(machine)) : [...entries];
}

/** The history with one more alert, the entry that holds it, and whether it should go out to the Mac and phone. */
export type AlertAdded = { history: AlertHistory; id: string; deliver: boolean };

/**
 * Kinds that are never folded, as each one is news of its own about a machine. An agent's needs-you alert is a
 * different wait of a session wanting you, and the reporter already alerts a wait once; sessions Arbor didn't carry
 * are named only by their machine, so folding would merge two sessions into one entry and keep the second from
 * reaching you. A setup change lists what changed since the scan before, so the next one on that machine is
 * different changes, not a repeat.
 */
const UNFOLDED: ReadonlySet<AlertKind> = new Set<AlertKind>(['agentPermission', 'agentWaiting', 'setupChanged']);

/**
 * Adds an alert, or folds it into the entry for the same kind of alert about the same one thing when that came in
 * within the repeat window. Only the newest alert about a thing counts: once something else was said about it (a
 * machine back up between two "down"s, even in an alert about several machines), the same alert is news again. A
 * repeat goes out again once the window since it last went out has passed, or straight away when it's more urgent
 * than before. Agents that need you and setup changes are never folded, and nor are alerts about nothing in particular or about several
 * things at once, since two of those with the same title can be about different things.
 */
export function withAlert(history: AlertHistory, record: AlertRecord, nowMs: number): AlertAdded {
  const about = UNFOLDED.has(record.kind) ? null : aboutOne(record.subject);
  // An agent waiting on a machine, or its setup changing, isn't news about whether it's up, so those entries don't
  // count as the newest about it.
  const last = about === null
    ? undefined
    : history.entries.find((entry) => !UNFOLDED.has(entry.kind) && aboutThings(entry.subject).includes(about));
  if (!last || last.kind !== record.kind || aboutOne(last.subject) !== about || record.atMs - last.atMs > ALERT_REPEAT_WINDOW_MS) {
    return { history: withAlerts(history, [record], nowMs), id: record.id, deliver: true };
  }
  const notifiedAtMs = last.notifiedAtMs ?? last.atMs;
  const deliver = (record.urgent && !last.urgent) || record.atMs - notifiedAtMs >= ALERT_REPEAT_WINDOW_MS;
  // Sent again, how it got out is for that send, so the last one's outcome goes. Either way it's news, so unread.
  const { mac: _mac, phone: _phone, read: _read, ...kept } = last;
  const merged: AlertRecord = {
    ...kept,
    ...(deliver ? {} : { ...(last.mac ? { mac: last.mac } : {}), ...(last.phone !== undefined ? { phone: last.phone } : {}) }),
    atMs: record.atMs,
    title: record.title,
    body: record.body,
    urgent: last.urgent || record.urgent,
    count: (last.count ?? 1) + 1,
    notifiedAtMs: deliver ? record.atMs : notifiedAtMs,
    ...(record.subject ? { subject: record.subject } : {}),
  };
  const rest = { ...history, entries: history.entries.filter((entry) => entry.id !== last.id) };
  return { history: withAlerts(rest, [merged], nowMs), id: last.id, deliver };
}

/** Alerts taken out of the history, and the order of the whole history then, to put them back where they were. */
export type ClearedAlerts = { entries: AlertRecord[]; order: string[] };

/**
 * Puts cleared alerts back beside any that came in since, newest first, as they were. Alerts sent at the same moment
 * keep the order they had when some were cleared.
 */
export function withRestoredAlerts(history: AlertHistory, { entries: restored, order }: ClearedAlerts): AlertHistory {
  const kept = new Set(history.entries.map((entry) => entry.id));
  // Any that came in since weren't there to be ordered, and go ahead of those that were.
  const rank = new Map(order.map((id, index) => [id, index]));
  const place = (entry: AlertRecord) => rank.get(entry.id) ?? -1;
  const entries = [...history.entries, ...restored.filter((entry) => !kept.has(entry.id))]
    .sort((a, b) => b.atMs - a.atMs || place(a) - place(b))
    .slice(0, ALERT_HISTORY_LIMIT);
  return { ...history, entries };
}

/** Whether an alert is new: it came in after the Alerts page last showed them, and hasn't been opened since. */
export const isUnreadAlert = (entry: AlertRecord, seenAtMs: number) => entry.atMs > seenAtMs && !entry.read;

export const unreadAlerts = (history: AlertHistory) => history.entries.filter((entry) => isUnreadAlert(entry, history.seenAtMs)).length;

/** Local midnight before an instant. */
export function startOfDay(ms: number) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Newest-first alerts split into the days they fired on, in this Mac's time zone. */
export function alertsByDay(entries: AlertRecord[]) {
  const days: { dayMs: number; entries: AlertRecord[] }[] = [];
  entries.forEach((entry) => {
    const dayMs = startOfDay(entry.atMs);
    const last = days[days.length - 1];
    if (last?.dayMs === dayMs) last.entries.push(entry);
    else days.push({ dayMs, entries: [entry] });
  });
  return days;
}

const isRecord = (value: unknown): value is AlertRecord => {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<AlertRecord>;
  return typeof entry.id === 'string' && typeof entry.atMs === 'number' && typeof entry.kind === 'string' && entry.kind in CATEGORY
    && typeof entry.title === 'string' && typeof entry.body === 'string';
};

const readRecord = ({ count, notifiedAtMs, read, ...entry }: AlertRecord): AlertRecord => ({
  ...entry,
  urgent: entry.urgent === true,
  ...(read === true ? { read } : {}),
  ...(typeof count === 'number' && count > 1 ? { count } : {}),
  ...(typeof notifiedAtMs === 'number' ? { notifiedAtMs } : {}),
});

/** The history as stored, keeping only entries it can show. */
export function parseAlertHistory(raw: string | null): AlertHistory {
  try {
    const parsed = JSON.parse(raw ?? '{}') as Partial<AlertHistory>;
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isRecord).map(readRecord) : [],
      seenAtMs: typeof parsed.seenAtMs === 'number' ? parsed.seenAtMs : 0,
    };
  } catch {
    return { entries: [], seenAtMs: 0 };
  }
}

// Up to 500 alerts, which the first screen doesn't need before it draws.
const store = savedStore<AlertHistory>({ key: 'arbor.alert-history.v1', parse: parseAlertHistory, fallback: { entries: [], seenAtMs: 0 }, afterLaunch: true });
let sequence = 0;

/** Whether the app has asked for the unread count on the tray icon, and the count it was last sent. */
let trayOn = false;
let trayUnread: number | null = null;

function showUnreadInTray() {
  if (!trayOn) return;
  const count = unreadAlerts(store.get());
  if (count === trayUnread) return;
  trayUnread = count;
  invokeCommand('set_tray_unread', { count }).catch((error) => {
    // Sent again with the next change.
    trayUnread = null;
    console.warn('Failed to show the unread alerts on the tray icon', error);
  });
}

/**
 * Keeps the unread count on the tray icon, since that's all that shows once the window is closed and the Dock icon
 * gone. Started by the app, so tests and the mock's sample alerts don't reach for it. Returns a function that stops it.
 */
export function showUnreadAlertsInTray() {
  trayOn = true;
  showUnreadInTray();
  return () => {
    trayOn = false;
    trayUnread = null;
  };
}

function save(next: AlertHistory) {
  store.set(next);
  showUnreadInTray();
}

export const useAlertHistory = store.useValue;
export const getAlertHistory = store.get;

/** Where an alert went in the history, and whether it should go out, being new or a repeat that's due again. */
export type RecordedAlert = { id: string; deliver: boolean };

/**
 * Keeps alerts as they're sent, folding repeats into the entry they repeat. Returns, in the same order, the entry
 * each is in, to note how it got out, and whether to send it.
 */
export function recordAlerts(messages: SystemNotification[], nowMs = Date.now()): RecordedAlert[] {
  if (!messages.length) return [];
  const records = messages.map(({ title, body, kind, urgent, subject }): AlertRecord => ({
    id: `${nowMs.toString(36)}-${(sequence++).toString(36)}`,
    atMs: nowMs,
    kind,
    title,
    body,
    urgent: urgent ?? false,
    ...(subject ? { subject } : {}),
  }));
  let next = store.get();
  // Each goes on top, so adding them last to first keeps those sent together in the order they were sent.
  const recorded = [...records].reverse().map((record): RecordedAlert => {
    const added = withAlert(next, record, nowMs);
    next = added.history;
    return { id: added.id, deliver: added.deliver };
  }).reverse();
  save(next);
  return recorded;
}

export function recordAlertDelivery(ids: string[], delivery: Pick<AlertRecord, 'mac'> | Pick<AlertRecord, 'phone'>) {
  if (!ids.length) return;
  const wanted = new Set(ids);
  const history = store.get();
  save({ ...history, entries: history.entries.map((entry) => (wanted.has(entry.id) ? { ...entry, ...delivery } : entry)) });
}

/** Everything so far has been seen. */
export function markAlertsSeen(nowMs = Date.now()) {
  const history = store.get();
  if (!unreadAlerts(history)) return;
  save({ ...history, seenAtMs: Math.max(nowMs, ...history.entries.map((entry) => entry.atMs)) });
}

/** Marks one alert read, as opening it from its toast does; the others stay new. */
export function markAlertRead(id: string) {
  const history = store.get();
  const entry = history.entries.find((item) => item.id === id);
  if (!entry || !isUnreadAlert(entry, history.seenAtMs)) return;
  save({ ...history, entries: history.entries.map((item) => (item === entry ? { ...item, read: true } : item)) });
}

/** Removes the alerts of one category, or all of them. Returns what it removed, for Undo. */
export function clearAlertHistory(category: AlertCategory | null = null, machine = ''): ClearedAlerts {
  const history = store.get();
  const order = history.entries.map((entry) => entry.id);
  const entries = alertsOn(history.entries, machine).filter((entry) => category === null || alertCategory(entry.kind) === category);
  if (!entries.length) return { entries, order: [] };
  const gone = new Set(entries);
  save({ ...history, entries: history.entries.filter((entry) => !gone.has(entry)) });
  return { entries, order };
}

/** Undoes `clearAlertHistory`. */
export function restoreAlerts(cleared: ClearedAlerts) {
  if (cleared.entries.length) save(withRestoredAlerts(store.get(), cleared));
}

/** Replaces the history, for tests. */
export function resetAlertHistory(next: AlertHistory = { entries: [], seenAtMs: 0 }) {
  store.set(next);
  sequence = 0;
  showUnreadInTray();
}

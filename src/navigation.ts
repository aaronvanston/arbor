import type { UsageResultFilter } from './services/usageFilters';

export type MainPageId = 'home' | 'accounts' | 'usage' | 'sessions' | 'machines' | 'setup' | 'alerts';
/**
 * Settings' pages. Some ids differ from their names: `general` is Proxy, `overrides` Model routes, `data` Usage
 * database and `software` App. The ids are what saved views and picks hold, so they stay.
 */
export type SettingsPageId =
  | 'general'
  | 'routing'
  | 'overrides'
  | 'aliases'
  | 'extra-models'
  | 'machines'
  | 'session-archive'
  | 'data'
  | 'diagnostics'
  | 'appearance'
  | 'notifications'
  | 'software'
  | 'updates'
  | 'about';

/**
 * Each page's views, which the sidebar tree lists under the page and a view's `tab` param names. The ids are what
 * saved views and recent picks hold, so they stay.
 */
/**
 * The Usage page's views; Prices is each model's price beside what it was used for. Saved ids of views that now live
 * elsewhere (Capacity, Analysis, Failures, Claude Code) open through `movedUsageView`.
 */
export type UsageTabId = 'overview' | 'digest' | 'lifetime' | 'events' | 'prices';
/** The Sessions page's views: the live board of what's running and waiting now, the sessions one by one, or by project. */
export type SessionsTabId = 'live' | 'sessions' | 'projects';
/**
 * How Sessions › Projects looks at the projects: their sessions' activity (no lens), or `checkouts`, each repo's
 * branches and worktrees on each machine.
 */
export type ProjectsLens = 'checkouts';
/**
 * Sync's views (the page's id is `setup`). `overview` is its Checks and `history` Arbor's changes, ids that saved
 * views hold, so they stay. Saved ids of views that now live elsewhere (Context, Projects, Checklist) open through
 * `movedSetupView`.
 */
export type SetupTabId = 'overview' | 'agents' | 'repo' | 'skills' | 'plugins' | 'hooks' | 'toolchain' | 'cost' | 'history';
/**
 * The Accounts page's views: each account's limits, every sign-in the core has with what each takes, and what each
 * subscription is worth against what it costs.
 */
export type AccountsTabId = 'limits' | 'sign-ins' | 'value';

/**
 * What the Usage page shows: a view, the machine or session (with its subagents) its requests are narrowed to, and how
 * they ended: Requests with `failed` is the failed ones, with what went wrong.
 */
export type UsageParams = { tab?: UsageTabId; machine?: string; session?: string; result?: Exclude<UsageResultFilter, 'all'> };
/**
 * What the Sessions page shows: the session open in place of the list, and the list's view, machine and project, and
 * on Projects how it looks at them.
 */
export type SessionsParams = { tab?: SessionsTabId; session?: string; machine?: string; project?: string; lens?: ProjectsLens };
/** What Sync shows: one of its views, and on Cost the machine Claude Code's spend is narrowed to. */
export type SetupParams = { tab?: SetupTabId; machine?: string };
export type AccountsParams = { tab?: AccountsTabId };
/** What Machines shows: the fleet at a glance, or one machine's own page. */
export type MachinesParams = { machine?: string };

/**
 * What's on screen. Views are state, not URLs. A page that can show more than one thing carries what it shows in
 * `params`, so going back to a view shows it as it was left.
 */
export type AppView =
  | { kind: 'main'; page: 'usage'; params?: UsageParams }
  | { kind: 'main'; page: 'sessions'; params?: SessionsParams }
  | { kind: 'main'; page: 'setup'; params?: SetupParams }
  | { kind: 'main'; page: 'accounts'; params?: AccountsParams }
  | { kind: 'main'; page: 'machines'; params?: MachinesParams }
  | { kind: 'main'; page: Exclude<MainPageId, ParamPageId>; params?: undefined }
  | { kind: 'settings'; page: SettingsPageId; params?: undefined };

/** The main pages whose views carry params. */
type ParamPageId = 'usage' | 'sessions' | 'setup' | 'accounts' | 'machines';

/** A main page as it opens from its row, the palette or ⌘1–⌘7: where it was left, for a page that remembers that. */
export const mainView = (page: MainPageId): AppView => ({ kind: 'main', page }) as AppView;
export const usageView = (params: UsageParams = {}): AppView => ({ kind: 'main', page: 'usage', params });
export const setupView = (params: SetupParams = {}): AppView => ({ kind: 'main', page: 'setup', params });
/**
 * Sync's Checks: each machine's last scan and what it found, with a scan's progress. What a setup change or a scan
 * asked for opens, rather than the view Sync was left on, which may show none of it (Agents, Cost).
 */
export const setupChecksView = (): AppView => setupView({ tab: 'overview' });
export const accountsView = (params: AccountsParams = {}): AppView => ({ kind: 'main', page: 'accounts', params });
/** Accounts' limits, where an account's row is: what an account's alert, its palette row or a limit opens. */
export const accountLimitsView = (): AppView => accountsView({ tab: 'limits' });
/**
 * Accounts' Sign-ins: every credential by provider, with its name, avatar, priority and cap, and adding more. Add
 * account elsewhere opens it with the sign-in open (`addAccount`).
 */
export const accountSignInsView = (): AppView => accountsView({ tab: 'sign-ins' });
/** The Machines page: the fleet at a glance, or `machine`'s own page when it's given. */
export const machinesView = (machine?: string): AppView => ({ kind: 'main', page: 'machines', params: machine ? { machine } : {} });
export const sessionsView = (params: SessionsParams = {}): AppView => ({ kind: 'main', page: 'sessions', params });
/** Sessions › Projects' Checkouts: each repo's branches and worktrees on each machine, with the ones that can go. */
export const checkoutsView = (): AppView => sessionsView({ tab: 'projects', lens: 'checkouts' });
/** The live board: every machine's sessions working, waiting on their user or done, on the Sessions page. */
export const liveBoardView = (): AppView => sessionsView({ tab: 'live' });
/** A machine's sessions, listed on the Sessions page; `__unassigned__` is those Arbor couldn't place. */
export const machineSessionsView = (machine: string): AppView => sessionsView({ tab: 'sessions', machine });
/** A machine's requests, listed on the Usage page. */
export const machineRequestsView = (machine: string): AppView => usageView({ tab: 'events', machine });
/** Usage's Requests with Failed on: the failed requests, with their statuses and what the provider said. */
export const failedRequestsView = (): AppView => usageView({ tab: 'events', result: 'failed' });

const usageTabIds: readonly string[] = ['overview', 'digest', 'lifetime', 'events', 'prices'] satisfies UsageTabId[];
const sessionsTabIds: readonly string[] = ['live', 'sessions', 'projects'] satisfies SessionsTabId[];
const setupTabIds: readonly string[] = ['overview', 'agents', 'repo', 'skills', 'plugins', 'hooks', 'toolchain', 'cost', 'history'] satisfies SetupTabId[];
const accountsTabIds: readonly string[] = ['limits', 'sign-ins', 'value'] satisfies AccountsTabId[];
export const isUsageTab = (tab: string | undefined | null): tab is UsageTabId => usageTabIds.includes(tab ?? '');
export const isSessionsTab = (tab: string | undefined | null): tab is SessionsTabId => sessionsTabIds.includes(tab ?? '');
export const isSetupTab = (tab: string | undefined | null): tab is SetupTabId => setupTabIds.includes(tab ?? '');
export const isAccountsTab = (tab: string | undefined | null): tab is AccountsTabId => accountsTabIds.includes(tab ?? '');

/**
 * Where a Usage view that moved is now, by the id saved views, recent picks and links still name it: Capacity is
 * Accounts › Value, Analysis the Breakdown on Overview, Failures Requests with Failed on, and Claude Code (`telemetry`)
 * Sync › Cost. Null for any other id.
 */
export function movedUsageView(tab: string | null | undefined): AppView | null {
  switch (tab) {
    case 'capacity': return accountsView({ tab: 'value' });
    case 'analysis': return usageView({ tab: 'overview' });
    case 'failures': return failedRequestsView();
    case 'telemetry': return setupView({ tab: 'cost' });
    default: return null;
  }
}

/**
 * Where a Sync view that moved is now, by the id saved views, recent picks and links still name it: Context is Cost's
 * starting context, Projects Sessions › Projects' Checkouts, and Checklist the Machines page, where each machine's page
 * has its own. Null for any other id; Checks and Arbor's changes kept theirs (`overview`, `history`).
 */
export function movedSetupView(tab: string | null | undefined): AppView | null {
  switch (tab) {
    case 'context': return setupView({ tab: 'cost' });
    case 'projects': return checkoutsView();
    case 'checklist': return machinesView();
    default: return null;
  }
}

/**
 * The Sync view to open for the one it was last left on, saved by its id: one that moved within Sync opens where it is
 * now, and one that left Sync, or was never one, opens Checks, since opening Sync shouldn't land on another page.
 */
export function savedSetupView(saved: string | null | undefined): SetupTabId {
  if (isSetupTab(saved)) return saved;
  const moved = movedSetupView(saved);
  return moved?.kind === 'main' && moved.page === 'setup' && moved.params?.tab ? moved.params.tab : 'overview';
}

/** A Usage view as the page saves where it was left: its view, and Failed when that's on. */
export type SavedUsageView = { tab: UsageTabId; result?: UsageParams['result'] };

/**
 * The Usage view to open for the one it was last left on, saved by its id: Analysis opens Overview and Failures
 * Requests with Failed on, and a view that moved off the page opens Overview, since opening Usage shouldn't land on
 * another page.
 */
export function savedUsageView(saved: string | null | undefined): SavedUsageView {
  if (isUsageTab(saved)) return { tab: saved };
  const moved = movedUsageView(saved);
  return moved?.kind === 'main' && moved.page === 'usage' && moved.params?.tab ? { tab: moved.params.tab, result: moved.params.result } : { tab: 'overview' };
}

/**
 * A main page's view by the page's id and the view's, as a query string or a saved pick names them, with the machine
 * whose page Machines opens or the lens Sessions › Projects looks through. A view that moved to another page opens there, and
 * one the page doesn't have opens the page where it was left; a page that isn't one is null.
 */
export function mainPageView(page: string, tab?: string | null, more: { machine?: string | null; lens?: string | null } = {}): AppView | null {
  if (!(mainPageIds as readonly string[]).includes(page)) return null;
  switch (page) {
    case 'usage': return isUsageTab(tab) ? usageView({ tab }) : movedUsageView(tab) ?? usageView();
    case 'sessions':
      if (tab === 'projects' && more.lens === 'checkouts') return checkoutsView();
      return sessionsView(isSessionsTab(tab) ? { tab } : {});
    case 'setup': return isSetupTab(tab) ? setupView({ tab }) : movedSetupView(tab) ?? setupView();
    case 'accounts': return accountsView(isAccountsTab(tab) ? { tab } : {});
    case 'machines': return machinesView(more.machine ?? undefined);
    default: return mainView(page as MainPageId);
  }
}

/** The same page, whatever it shows. */
export const samePage = (a: AppView, b: AppView) => a.kind === b.kind && a.page === b.page;

/** A view's params with the empty ones left out, so an empty filter and no filter are the same. */
function keptParams<T extends Record<string, string | undefined>>(params: T | undefined): T | undefined {
  const kept = Object.entries(params ?? {}).filter(([, value]) => value);
  return kept.length ? (Object.fromEntries(kept) as T) : undefined;
}

/** The view without its empty params. */
export function normalizeView(view: AppView): AppView {
  if (view.kind !== 'main' || view.params === undefined) return view;
  const params = keptParams<Record<string, string | undefined>>(view.params);
  return (params ? { kind: 'main', page: view.page, params } : { kind: 'main', page: view.page }) as AppView;
}

/** The same page showing the same thing. */
export function sameView(a: AppView, b: AppView) {
  if (!samePage(a, b)) return false;
  const left: Record<string, string | undefined> = a.params ?? {};
  const right: Record<string, string | undefined> = b.params ?? {};
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) => (left[key] || '') === (right[key] || ''));
}

/** The main pages in the sidebar tree's order, which ⌘1–⌘6 follow, then Alerts, the footer's bell, on ⌘7. */
export const mainPageIds: readonly MainPageId[] = ['home', 'machines', 'sessions', 'setup', 'accounts', 'usage', 'alerts'];
/** Settings' pages in the sidebar's order: Proxy, Fleet, Data and Arbor's own. */
export const settingsPageIds: readonly SettingsPageId[] = [
  'general', 'routing', 'overrides', 'aliases', 'extra-models', 'machines', 'session-archive', 'data',
  'diagnostics', 'appearance', 'notifications', 'software', 'updates', 'about',
];

/**
 * Settings pages that were folded into others, by their old ids, for anything that saved one: Interface's alert
 * switches and Phone Alerts are both on Notifications, and Network is on Proxy (`general`) with the proxy's keys and
 * logging.
 */
const MOVED_SETTINGS_PAGES: Readonly<Record<string, SettingsPageId>> = { interface: 'notifications', 'phone-alerts': 'notifications', network: 'general' };

/** The Settings page an id names today, following a page that moved, or null for an id that was never one. */
function resolveSettingsPage(id: string): SettingsPageId | null {
  if ((settingsPageIds as readonly string[]).includes(id)) return id as SettingsPageId;
  return MOVED_SETTINGS_PAGES[id] ?? null;
}

/**
 * Settings pages that left Settings for a main page, by their old ids: Pricing is Usage › Prices, and Auth files and
 * Sign-in (`oauth`) are Accounts › Sign-ins, which signs in to each provider itself.
 */
const LEFT_SETTINGS: Readonly<Record<string, () => AppView>> = {
  pricing: () => usageView({ tab: 'prices' }),
  'auth-files': () => accountSignInsView(),
  oauth: () => accountSignInsView(),
};

/**
 * What a Settings page's id opens today, for a link, saved pick or saved view that names it: the page, the one it was
 * folded into, or the main page it moved to. Null for an id that was never one.
 */
export function settingsPageView(id: string): AppView | null {
  const page = resolveSettingsPage(id);
  if (page) return { kind: 'settings', page };
  return LEFT_SETTINGS[id]?.() ?? null;
}

/** Pages that talk only to the desktop app (local SQLite, config files, updater) and never need the core. */
const alwaysAvailablePages = new Set<string>([
  // Main pages.
  'home', 'usage', 'sessions', 'machines', 'setup', 'alerts',
  // Settings pages.
  'settings:general', 'settings:routing', 'settings:aliases', 'settings:extra-models', 'settings:software',
  'settings:machines', 'settings:data', 'settings:session-archive', 'settings:appearance', 'settings:notifications',
  'settings:updates', 'settings:diagnostics', 'settings:about',
]);

export const viewPageId = (view: AppView) => (view.kind === 'main' ? view.page : `settings:${view.page}`);

/** Accounts' Value reads only Arbor's own usage records, so, like Usage, it opens without the core. */
const opensWithoutCore = (view: AppView) => view.kind === 'main' && view.page === 'accounts' && view.params?.tab === 'value';

export function canOpenView(view: AppView, coreReady: boolean) {
  return coreReady || opensWithoutCore(view) || alwaysAvailablePages.has(viewPageId(view));
}

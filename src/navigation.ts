import type { UsageResultFilter } from './services/usageFilters';

export type MainPageId = 'home' | 'accounts' | 'usage' | 'sessions' | 'machines' | 'pools' | 'automations' | 'setup' | 'alerts';
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
  | 'agent-homes'
  | 'harnesses'
  | 'pools'
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
 * Sync's views (the page's id is `setup`): Overview, its Checks (`overview`, the id saved views hold), Library,
 * everything the repo gives the machines' agents, Software, their agents and tools, and Repo. Saved ids of views that
 * now live elsewhere (Agents, Skills, MCP & plugins, Hooks, Toolchain, Cost, Arbor's changes, and before them Context,
 * Projects and Checklist) open through `movedSetupView`.
 */
export type SetupTabId = 'overview' | 'library' | 'software' | 'repo';
/** The Library's tabs: what kind of thing it lists. */
export type LibraryKind = 'plugins' | 'mcps' | 'skills' | 'hooks' | 'instructions';
/**
 * How a Sync view looks at what it shows: the Library by machine (each kind's grid) or by what it costs, and the
 * Repo as Arbor's changes on one machine, with its undo.
 */
export type SetupLens = 'machines' | 'cost' | 'changes';
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
/**
 * What Sync shows: one of its views, the Library's kind, how the view looks at it, and the machine Cost's Claude Code
 * spend is narrowed to, or whose changes the Repo's Arbor's changes lists.
 */
export type SetupParams = { tab?: SetupTabId; kind?: LibraryKind; lens?: SetupLens; machine?: string };
export type AccountsParams = { tab?: AccountsTabId };
/** What Machines shows: the fleet at a glance, or one machine's own page. */
export type MachinesParams = { machine?: string };
/**
 * What Automations shows: every automation, narrowed to the machine they run on, or one automation's own page, with
 * what it's set to do and its runs.
 */
export type AutomationsParams = { automation?: string; machine?: string };
/** What Pools shows: every pool's health at a glance, or one pool's own page. */
export type PoolsParams = { pool?: string };

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
  | { kind: 'main'; page: 'automations'; params?: AutomationsParams }
  | { kind: 'main'; page: 'pools'; params?: PoolsParams }
  | { kind: 'main'; page: Exclude<MainPageId, ParamPageId>; params?: undefined }
  | { kind: 'settings'; page: SettingsPageId; params?: undefined };

/** The main pages whose views carry params. */
type ParamPageId = 'usage' | 'sessions' | 'setup' | 'accounts' | 'machines' | 'pools' | 'automations';

/** A main page as it opens from its row, the palette or ⌘1–⌘8: where it was left, for a page that remembers that. */
export const mainView = (page: MainPageId): AppView => ({ kind: 'main', page }) as AppView;
export const usageView = (params: UsageParams = {}): AppView => ({ kind: 'main', page: 'usage', params });
export const setupView = (params: SetupParams = {}): AppView => ({ kind: 'main', page: 'setup', params });
/**
 * Sync's Overview, its Checks: each machine's last scan and what it found, with a scan's progress. What a setup change
 * or a scan asked for opens, rather than the view Sync was left on, which may show none of it (Software, Cost).
 */
export const setupChecksView = (): AppView => setupView({ tab: 'overview' });
/** Sync › Library on a kind, as a list, or by machine with `lens`. */
export const libraryView = (kind?: LibraryKind, lens?: Extract<SetupLens, 'machines' | 'cost'>): AppView =>
  setupView({ tab: 'library', ...(kind ? { kind } : {}), ...(lens ? { lens } : {}) });
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
/** Pools: every pool at a glance, or `pool`'s own page (by id) when it's given. */
export const poolsView = (pool?: string): AppView => ({ kind: 'main', page: 'pools', params: pool ? { pool } : {} });
/** Automations: every one, or `automation`'s own page when it's given. */
export const automationsView = (params: AutomationsParams = {}): AppView => ({ kind: 'main', page: 'automations', params });
/** One automation's own page. */
export const automationView = (automation: string): AppView => automationsView({ automation });
/** Sessions › Projects' Checkouts: each repo's branches and worktrees on each machine, with the ones that can go. */
export const checkoutsView = (): AppView => sessionsView({ tab: 'projects', lens: 'checkouts' });
/** The live board: every machine's sessions working, waiting on their user or done, on the Sessions page. */
export const liveBoardView = (): AppView => sessionsView({ tab: 'live' });
/** The live board narrowed to one machine: what a machine page's Live section opens. */
export const machineLiveView = (machine: string): AppView => sessionsView({ tab: 'live', machine });
/** A machine's sessions, listed on the Sessions page; `__unassigned__` is those Arbor couldn't place. */
export const machineSessionsView = (machine: string): AppView => sessionsView({ tab: 'sessions', machine });
/** A machine's requests, listed on the Usage page. */
export const machineRequestsView = (machine: string): AppView => usageView({ tab: 'events', machine });
/** Usage's Requests with Failed on: the failed requests, with their statuses and what the provider said. */
export const failedRequestsView = (): AppView => usageView({ tab: 'events', result: 'failed' });

/**
 * The views that can be looked at for one machine or all, which the breadcrumb's machine picker narrows: Sessions'
 * Live, list and Projects, and Usage's Overview, Weekly, Requests and Prices. Sync's Cost has its own; the rest compare machines
 * or are fleet-wide.
 */
export function hasMachineScope(page: MainPageId, tab: string | undefined): boolean {
  if (page === 'sessions') return tab === 'live' || tab === 'sessions' || tab === 'projects';
  if (page === 'usage') return tab === 'overview' || tab === 'digest' || tab === 'events' || tab === 'prices' || tab === 'lifetime';
  return false;
}

/** Sync's views with a machine in their breadcrumb: the Library's Cost, and the Repo's Arbor's changes, one machine's at a time. */
const setupMachineScope = (params: SetupParams | undefined) =>
  (params?.tab === 'library' && params.lens === 'cost') || (params?.tab === 'repo' && params.lens === 'changes');

/**
 * The view `next` opens as, picked while `current` is on screen: a view of the same page that can be narrowed to a
 * machine keeps the machine the page is narrowed to, so moving between Sessions' views stays on that machine.
 */
export function keepMachineScope(current: AppView, next: AppView): AppView {
  if (current.kind !== 'main' || next.kind !== 'main' || current.page !== next.page) return next;
  if (next.page !== 'sessions' && next.page !== 'usage' && next.page !== 'setup') return next;
  const machine = current.params && 'machine' in current.params ? current.params.machine : undefined;
  const tab = next.params?.tab;
  const scoped = next.page === 'setup' ? setupMachineScope(next.params) : hasMachineScope(next.page, tab);
  if (!machine || !scoped || next.params?.machine !== undefined) return next;
  return { ...next, params: { ...next.params, machine } } as AppView;
}

const usageTabIds: readonly string[] = ['overview', 'digest', 'lifetime', 'events', 'prices'] satisfies UsageTabId[];
const sessionsTabIds: readonly string[] = ['live', 'sessions', 'projects'] satisfies SessionsTabId[];
const setupTabIds: readonly string[] = ['overview', 'library', 'software', 'repo'] satisfies SetupTabId[];
const accountsTabIds: readonly string[] = ['limits', 'sign-ins', 'value'] satisfies AccountsTabId[];
export const isUsageTab = (tab: string | undefined | null): tab is UsageTabId => usageTabIds.includes(tab ?? '');
export const isSessionsTab = (tab: string | undefined | null): tab is SessionsTabId => sessionsTabIds.includes(tab ?? '');
export const isSetupTab = (tab: string | undefined | null): tab is SetupTabId => setupTabIds.includes(tab ?? '');
export const isAccountsTab = (tab: string | undefined | null): tab is AccountsTabId => accountsTabIds.includes(tab ?? '');

/**
 * Where a Usage view that moved is now, by the id saved views, recent picks and links still name it: Capacity is
 * Accounts › Value, Analysis the Breakdown on Overview, Failures Requests with Failed on, and Claude Code (`telemetry`)
 * Sync › Library › Cost. Null for any other id.
 */
export function movedUsageView(tab: string | null | undefined): AppView | null {
  switch (tab) {
    case 'capacity': return accountsView({ tab: 'value' });
    case 'analysis': return usageView({ tab: 'overview' });
    case 'failures': return failedRequestsView();
    case 'telemetry': return libraryView(undefined, 'cost');
    default: return null;
  }
}

/**
 * Where a Sync view that moved is now, by the id saved views, recent picks and links still name it: Agents and
 * Toolchain are Software; Skills, MCP & plugins and Hooks the Library's kind by machine, as their grids were; Cost
 * (and Context before it) the Library by cost; Arbor's changes the Repo's; Projects Sessions › Projects' Checkouts;
 * and Checklist the Machines page, where each machine's page has its own. Null for any other id.
 */
export function movedSetupView(tab: string | null | undefined): AppView | null {
  switch (tab) {
    case 'agents':
    case 'toolchain': return setupView({ tab: 'software' });
    case 'skills': return libraryView('skills', 'machines');
    case 'plugins': return libraryView('plugins', 'machines');
    case 'hooks': return libraryView('hooks', 'machines');
    case 'cost':
    case 'context': return libraryView(undefined, 'cost');
    case 'history': return setupView({ tab: 'repo', lens: 'changes' });
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
    case 'automations': return automationsView();
    case 'pools': return poolsView();
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

/** The main pages in the sidebar tree's order, which ⌘1–⌘8 follow, then Alerts, the footer's bell, on ⌘9. */
export const mainPageIds: readonly MainPageId[] = ['home', 'machines', 'pools', 'sessions', 'automations', 'setup', 'accounts', 'usage', 'alerts'];
/** Settings' pages in the sidebar's order: Proxy, Fleet, Data and Arbor's own. */
export const settingsPageIds: readonly SettingsPageId[] = [
  'general', 'routing', 'overrides', 'aliases', 'extra-models', 'machines', 'agent-homes', 'harnesses', 'pools', 'session-archive',
  'data', 'diagnostics', 'appearance', 'notifications', 'software', 'updates', 'about',
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
  'home', 'usage', 'sessions', 'machines', 'pools', 'automations', 'setup', 'alerts',
  // Settings pages.
  'settings:general', 'settings:routing', 'settings:aliases', 'settings:extra-models', 'settings:software',
  'settings:machines', 'settings:agent-homes', 'settings:harnesses', 'settings:pools', 'settings:data', 'settings:session-archive', 'settings:appearance', 'settings:notifications',
  'settings:updates', 'settings:diagnostics', 'settings:about',
]);

export const viewPageId = (view: AppView) => (view.kind === 'main' ? view.page : `settings:${view.page}`);

/** Accounts' Value reads only Arbor's own usage records, so, like Usage, it opens without the core. */
const opensWithoutCore = (view: AppView) => view.kind === 'main' && view.page === 'accounts' && view.params?.tab === 'value';

export function canOpenView(view: AppView, coreReady: boolean) {
  return coreReady || opensWithoutCore(view) || alwaysAvailablePages.has(viewPageId(view));
}

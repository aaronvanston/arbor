import { lazy, type ComponentType } from 'react';
import type { AppView, MainPageId, SettingsPageId } from './navigation';

// Home comes with the app; every other page's code loads when someone shows they're about to open it (pointing at or
// focusing a link to it, the palette's lit row) or, at the latest, as it's opened. Loading them all after launch
// parsed and kept 1.4 MB of JS that most launches never use.
const loaders = {
  accounts: () => import('./pages/AccountsPage'),
  usage: () => import('./pages/UsageRecordsPage'),
  automations: () => import('./pages/AutomationsPage'),
  machinePools: () => import('./pages/PoolsPage'),
  usageData: () => import('./pages/UsageDataSettingsPage'),
  setup: () => import('./pages/SetupPage'),
  alerts: () => import('./pages/AlertsPage'),
  config: () => import('./pages/ConfigPanel'),
  modelRouting: () => import('./pages/ModelRoutingPage'),
  extraModels: () => import('./pages/ExtraModelsPage'),
  settings: () => import('./pages/SettingsPages'),
  agentHomes: () => import('./pages/AgentHomesSettings'),
  harnesses: () => import('./pages/HarnessesSettings'),
  pools: () => import('./pages/PoolsSettings'),
  appearance: () => import('./pages/AppearanceSettingsPage'),
  notifications: () => import('./pages/NotificationsSettingsPage'),
  sessionArchive: () => import('./pages/SessionArchiveSettings'),
  versions: () => import('./pages/VersionManagementPage'),
  diagnostics: () => import('./pages/DiagnosticsSettings'),
  about: () => import('./pages/AboutSettings'),
};

export type PageModuleId = keyof typeof loaders;
type PageModule<Id extends PageModuleId> = Awaited<ReturnType<(typeof loaders)[Id]>>;

const MAIN_PAGE_MODULE: Record<MainPageId, PageModuleId | null> = {
  home: null,
  accounts: 'accounts',
  usage: 'usage',
  sessions: 'usage',
  machines: 'usage',
  pools: 'machinePools',
  automations: 'automations',
  setup: 'setup',
  alerts: 'alerts',
};

const SETTINGS_PAGE_MODULE: Record<SettingsPageId, PageModuleId> = {
  general: 'config',
  routing: 'config',
  aliases: 'config',
  software: 'config',
  overrides: 'modelRouting',
  'extra-models': 'extraModels',
  machines: 'settings',
  'agent-homes': 'agentHomes',
  harnesses: 'harnesses',
  pools: 'pools',
  data: 'usageData',
  'session-archive': 'sessionArchive',
  appearance: 'appearance',
  notifications: 'notifications',
  updates: 'versions',
  diagnostics: 'diagnostics',
  about: 'about',
};

/** The code a view's page needs beyond the app's own, or null for Home. */
export function pageModuleFor(view: AppView): PageModuleId | null {
  return view.kind === 'main' ? MAIN_PAGE_MODULE[view.page] : SETTINGS_PAGE_MODULE[view.page];
}

const isPageModuleId = (value: string): value is PageModuleId => Object.prototype.hasOwnProperty.call(loaders, value);

const loaded = new Map<PageModuleId, unknown>();
const loading = new Map<PageModuleId, Promise<unknown>>();

/** Loads a page's code once; a failed load is tried again next time. */
export function loadPageModule<Id extends PageModuleId>(id: Id): Promise<PageModule<Id>> {
  let pending = loading.get(id) as Promise<PageModule<Id>> | undefined;
  if (!pending) {
    pending = (loaders[id]() as Promise<PageModule<Id>>).then((module) => {
      loaded.set(id, module);
      return module;
    });
    pending.catch(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

export const prefetchPageModule = (id: PageModuleId) => void loadPageModule(id).catch(() => undefined);

export function prefetchView(view: AppView) {
  const id = pageModuleFor(view);
  if (id) prefetchPageModule(id);
}

/**
 * Marks an element as leading to a view, so pointing at or focusing it (or anything in it) loads that page's code:
 * spread onto a link, a row or a card that opens the page.
 */
export function prefetchAttribute(view: AppView): { 'data-prefetch'?: PageModuleId } {
  const id = pageModuleFor(view);
  return id ? { 'data-prefetch': id } : {};
}

/** Loads the page under the pointer or the focus, for anything marked with `prefetchAttribute`. */
export function watchPrefetchIntent(root: Document = document) {
  const onIntent = (event: Event) => {
    if (!(event.target instanceof Element)) return;
    const id = event.target.closest<HTMLElement>('[data-prefetch]')?.dataset.prefetch;
    if (id && isPageModuleId(id)) prefetchPageModule(id);
  };
  root.addEventListener('pointerover', onIntent, { passive: true });
  root.addEventListener('focusin', onIntent);
  return () => {
    root.removeEventListener('pointerover', onIntent);
    root.removeEventListener('focusin', onIntent);
  };
}

/**
 * Whether the latest call to `arriveWhenLoaded` is still waiting. Each call, and `cancelPendingArrival`, takes the
 * place of the one before, so a slow load can't land on a page someone has since left for another.
 */
let arrival = 0;

/**
 * Goes to a view once its page's code is here: at once when it is, or after the load. Arriving before it would suspend
 * the page, and React holds a suspended page back for 300 ms before showing it, where loading first costs only the
 * load. A failed load arrives anyway, so the page's error boundary says what went wrong. Settles once it's arrived, or
 * been passed over for a later one.
 */
export function arriveWhenLoaded(view: AppView, arrive: () => void): Promise<void> {
  const id = pageModuleFor(view);
  const ticket = ++arrival;
  if (!id || loaded.has(id)) {
    arrive();
    return Promise.resolve();
  }
  const settle = () => {
    if (ticket === arrival) arrive();
  };
  return loadPageModule(id).then(settle, settle);
}

export const cancelPendingArrival = () => void ++arrival;

// The browser mock's __mockOpen goes to a view the same way, through this rather than an import: anything the launch
// imports that reaches this module would let the pages load without the app, and the build would split the app's code
// into dozens of pieces to share with them.
if (import.meta.env.DEV || import.meta.env.MODE === 'demo') {
  (window as Window & { __arriveWhenLoaded?: typeof arriveWhenLoaded }).__arriveWhenLoaded = arriveWhenLoaded;
}

/**
 * `lazy()` for a page's component. Once the page's code is here it's handed over in the same render, so the page
 * shows at once instead of suspending (see `arriveWhenLoaded`).
 */
export function lazyPage<Id extends PageModuleId, Props extends object>(id: Id, pick: (module: PageModule<Id>) => ComponentType<Props>) {
  return lazy(() => {
    const module = loaded.get(id) as PageModule<Id> | undefined;
    if (!module) return loadPageModule(id).then((value) => ({ default: pick(value) }));
    // React reads a thenable that calls back at once as already resolved; a promise, even a settled one, calls back
    // later, after the page has suspended. Only React's lazy() ever sees this object.
    const ready = { default: pick(module) };
    // oxlint-disable-next-line unicorn/no-thenable
    return { then: (resolve: (value: typeof ready) => void) => resolve(ready) } as unknown as Promise<typeof ready>;
  });
}

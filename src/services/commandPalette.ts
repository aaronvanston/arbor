import type { MessageKey } from '../i18n/resources';
import { movedSetupView, movedUsageView, settingsPageView, type AppView } from '../navigation';
import { savedStore } from './savedStore';
import { currentSettingId } from './settingsIndex';
import type { ZoomLevel } from '../native/types';
import { canZoomIn, canZoomOut } from './zoom';

/** What the search palette lists, in the order its groups are listed. */
export type PaletteGroup = 'recent' | 'pages' | 'actions' | 'settings' | 'projects' | 'sessions' | 'machines' | 'accounts';
export const PALETTE_GROUPS: readonly PaletteGroup[] = ['recent', 'pages', 'actions', 'settings', 'projects', 'sessions', 'machines', 'accounts'];
/** The most of each group listed at once for a search. Nothing typed, or `>` for actions, lists them all. */
export const PALETTE_LIMITS: Record<PaletteGroup, number> = { recent: 5, pages: 7, actions: 5, settings: 5, projects: 5, sessions: 8, machines: 5, accounts: 5 };

export type PaletteEntry = {
  id: string;
  group: PaletteGroup;
  label: string;
  /** Other words it can be found by: a project's repository, an account's email and provider. */
  keywords?: string;
  /** Found by the app's own session search, which matches more than the label shows. */
  searched?: boolean;
  /** When it's listed: before anything is typed, once something is, or only as a recent pick. Both when unset. */
  shown?: 'idle' | 'typed' | 'recentOnly';
};

const terms = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/** A query that starts with `>` asks for actions only; the rest is what to match them by. */
export function parsePaletteQuery(query: string) {
  const trimmed = query.trimStart();
  const actionsOnly = trimmed.startsWith('>');
  return { actionsOnly, text: (actionsOnly ? trimmed.slice(1) : trimmed).trim() };
}

/**
 * How well an entry matches what's typed, lower first, or null when a word typed isn't in it. The label
 * starting with it comes first, then a word in the label starting with it, then the label holding every word,
 * then the other words it can be found by.
 */
export function paletteScore(entry: PaletteEntry, query: string): number | null {
  const words = terms(query);
  if (!words.length) return 0;
  if (entry.searched) return 3;
  const label = entry.label.toLowerCase();
  const haystack = `${label} ${entry.keywords?.toLowerCase() ?? ''}`;
  if (!words.every((word) => haystack.includes(word))) return null;
  if (label.startsWith(words.join(' '))) return 0;
  if (label.split(/[\s/·._:-]+/).some((part) => part.startsWith(words[0]!))) return 1;
  return words.every((word) => label.includes(word)) ? 2 : 3;
}

/** The entries that match, best first and otherwise in the order given. */
export function paletteMatches<T extends PaletteEntry>(entries: readonly T[], query: string): T[] {
  return entries
    .flatMap((entry, index) => {
      const score = paletteScore(entry, query);
      return score === null ? [] : [{ entry, score, index }];
    })
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((item) => item.entry);
}

const byGroup = <T extends PaletteEntry>(entries: readonly T[], limited: boolean) =>
  PALETTE_GROUPS.flatMap((group) => {
    const members = entries.filter((entry) => entry.group === group);
    return limited ? members.slice(0, PALETTE_LIMITS[group]) : members;
  });

/**
 * What the palette lists for a query, group by group in palette order. Nothing typed: the recent picks, then what's
 * offered before a search. `>` and some words: just the actions that match. Words alone: everything that matches,
 * best first within a group, and a few of each.
 */
export function paletteResults<T extends PaletteEntry>(entries: readonly T[], query: string, recents: readonly string[] = []): T[] {
  const { actionsOnly, text } = parsePaletteQuery(query);
  const listed = entries.filter((entry) => entry.shown !== 'recentOnly');
  if (actionsOnly) return paletteMatches(listed.filter((entry) => entry.group === 'actions'), text);
  if (text) return byGroup(paletteMatches(listed.filter((entry) => entry.shown !== 'idle'), text), true);
  const recent = recents.flatMap((id) => {
    const entry = entries.find((item) => item.id === id);
    // A copy under its own id, since the same entry is usually in its group further down too.
    return entry ? [{ ...entry, id: `recent:${entry.id}`, group: 'recent' as const }] : [];
  });
  return [...recent.slice(0, PALETTE_LIMITS.recent), ...byGroup(listed.filter((entry) => entry.shown !== 'typed'), false)];
}

/**
 * Whether a key leaves a list of accounts for the palette's own: Escape always, and Backspace in an empty field.
 * At the palette's own list, Escape closes the palette instead.
 */
export const leavesSubmenu = (key: string, query: string, inSubmenu: boolean) =>
  inSubmenu && (key === 'Escape' || (key === 'Backspace' && query === ''));

/** The id a recent row was copied from. */
export const recentSourceId = (id: string) => (id.startsWith('recent:') ? id.slice('recent:'.length) : id);

/** What an action needs to know to say whether it can run. */
export type PaletteActionContext = {
  /** Null while the core's state is still being read. */
  core: { installed: boolean; running: boolean; ready: boolean; busy: boolean } | null;
  /** Accounts turned on, and turned off. */
  accounts: number;
  paused: number;
  /** Whether Back and Forward have somewhere to go. */
  history: { back: boolean; forward: boolean };
  /** Whether the sidebar shows now, so the action says which way it goes. */
  sidebarShown: boolean;
  /** The window's zoom, so each zoom action says when it has nowhere to go. */
  zoom: ZoomLevel;
};

export type PaletteActionId =
  | 'refresh-limits'
  | 'start-core'
  | 'stop-core'
  | 'restart-core'
  | 'pause-account'
  | 'resume-account'
  | 'copy-base-url'
  | 'copy-api-key'
  | 'scan-setup'
  | 'toggle-sidebar'
  | 'theme-light'
  | 'theme-dark'
  | 'theme-system'
  | 'zoom-in'
  | 'zoom-out'
  | 'actual-size'
  | 'go-back'
  | 'go-forward';

export type PaletteAction = {
  id: PaletteActionId;
  unavailable: MessageKey | null;
  /** What it's called now, for an action that says which way it goes. */
  label?: MessageKey;
};

/**
 * The actions to offer, in order, each with why it can't run now (or null when it can). Start swaps with Stop and
 * Restart as the core starts and stops, and the sidebar's action says Hide or Show under one id, so a recent pick of
 * it still finds it; the rest stay listed and say what they're waiting for.
 */
export function paletteActions({ core, accounts, paused, history, sidebarShown, zoom }: PaletteActionContext): PaletteAction[] {
  const needsCore: MessageKey | null = core?.ready ? null : core?.running ? 'kernel.access.waiting' : 'app.coreRequired.title';
  const busy: MessageKey | null = !core || core.busy ? 'palette.unavailable.coreBusy' : null;
  const coreActions: PaletteAction[] = core?.running
    ? [{ id: 'restart-core', unavailable: busy }, { id: 'stop-core', unavailable: busy }]
    : [{ id: 'start-core', unavailable: core && !core.installed ? 'palette.unavailable.coreMissing' : busy }];
  return [
    { id: 'refresh-limits', unavailable: needsCore ?? (accounts ? null : 'palette.unavailable.noAccounts') },
    ...coreActions,
    { id: 'pause-account', unavailable: needsCore ?? (accounts ? null : 'palette.unavailable.noAccounts') },
    { id: 'resume-account', unavailable: needsCore ?? (paused ? null : 'palette.unavailable.nonePaused') },
    { id: 'copy-base-url', unavailable: null },
    { id: 'copy-api-key', unavailable: null },
    { id: 'scan-setup', unavailable: null },
    { id: 'toggle-sidebar', unavailable: null, label: sidebarShown ? 'app.sidebar.hide' : 'app.sidebar.show' },
    { id: 'theme-light', unavailable: null },
    { id: 'theme-dark', unavailable: null },
    { id: 'theme-system', unavailable: null },
    { id: 'zoom-in', unavailable: canZoomIn(zoom) ? null : 'zoom.atLargest' },
    { id: 'zoom-out', unavailable: canZoomOut(zoom) ? null : 'zoom.atSmallest' },
    { id: 'actual-size', unavailable: zoom.factor === 1 ? 'zoom.atActualSize' : null },
    { id: 'go-back', unavailable: history.back ? null : 'palette.unavailable.noBack' },
    { id: 'go-forward', unavailable: history.forward ? null : 'palette.unavailable.noForward' },
  ];
}

/** How many picks the palette remembers. */
const RECENT_PICKS = 5;

/** The list with a pick moved to the front, once, and the oldest dropped past the limit. */
export const withRecent = (recents: readonly string[], id: string, limit = RECENT_PICKS) =>
  [id, ...recents.filter((item) => item !== id)].slice(0, limit);

/**
 * A page's row in the palette, and its view's under it, by what it opens: `page:main:usage:events`, and
 * `page:main:usage:events:failed` for Requests with Failed on.
 */
export function palettePageId(view: AppView) {
  // A page's view is picked, and remembered, apart from the page.
  const tab = view.kind === 'main' && view.params && 'tab' in view.params ? view.params.tab : undefined;
  const result = view.kind === 'main' && view.page === 'usage' ? view.params?.result : undefined;
  const lens = view.kind === 'main' && view.page === 'sessions' ? view.params?.lens : undefined;
  return `page:${view.kind}:${view.page}${tab ? `:${tab}` : ''}${result ? `:${result}` : ''}${lens ? `:${lens}` : ''}`;
}

/**
 * A pick of a page, view or setting that has since moved, under where it is now: a Settings page folded into another
 * or one that left Settings (Pricing is Usage › Prices), a setting that moved with its page, a Usage
 * view that moved (Capacity to Accounts › Value, Analysis to Overview, Failures to Requests with Failed on, Claude Code
 * to Sync › Cost) or a Sync view that did (Context to Cost, Projects to Sessions › Projects' Checkouts).
 */
const SETTINGS_PAGE_PICK = 'page:settings:';
const SETTING_PICK = 'setting:';
const MOVED_VIEW_PICKS: readonly (readonly [string, (tab: string) => AppView | null])[] = [
  ['page:main:usage:', movedUsageView],
  ['page:main:setup:', movedSetupView],
];
function currentPickId(id: string) {
  for (const [prefix, moved] of MOVED_VIEW_PICKS) {
    if (!id.startsWith(prefix)) continue;
    const view = moved(id.slice(prefix.length));
    return view ? palettePageId(view) : id;
  }
  if (id.startsWith(SETTING_PICK)) return `${SETTING_PICK}${currentSettingId(id.slice(SETTING_PICK.length))}`;
  if (!id.startsWith(SETTINGS_PAGE_PICK)) return id;
  const view = settingsPageView(id.slice(SETTINGS_PAGE_PICK.length));
  return view ? palettePageId(view) : id;
}

/**
 * The ids of the latest picks, newest first. Only ids are kept: a row's name is read fresh when it's shown. Two
 * picks of pages that have since become one are listed once.
 */
export function parseRecents(raw: string | null): string[] {
  const saved: unknown = JSON.parse(raw ?? '[]');
  if (!Array.isArray(saved)) return [];
  const ids = saved.filter((id): id is string => typeof id === 'string').map(currentPickId);
  return [...new Set(ids)].slice(0, RECENT_PICKS);
}

const recents = savedStore<string[]>({ key: 'arbor.palette.recent.v1', parse: parseRecents, fallback: [] });

export const readRecents = recents.get;

export function rememberRecent(id: string): string[] {
  const next = withRecent(recents.get(), recentSourceId(id));
  recents.set(next);
  return next;
}

/**
 * What a key pressed on the sidebar's search row opens the palette with: a printable character starts the search
 * with it. Anything else, Space and shortcuts included, is left to the button.
 */
export const typedPaletteQuery = (event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): string | null =>
  event.key.length !== 1 || event.key === ' ' || event.metaKey || event.ctrlKey || event.altKey ? null : event.key;

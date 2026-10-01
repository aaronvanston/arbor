import type { MessageKey } from '../i18n/resources';
import {
  accountsView,
  checkoutsView,
  failedRequestsView,
  sessionsView,
  setupView,
  usageView,
  type AccountsTabId,
  type AppView,
  type MainPageId,
  type SessionsTabId,
  type SetupTabId,
  type UsageTabId,
} from '../navigation';
import { savedStore, storedRecord } from './savedStore';

/**
 * The sidebar as a tree, in the way T3 lists threads under each project: Home on its own, then the pages in two
 * labeled sections, each page with its views under it. The tree picks the view; pages have no tabs of their own.
 * Machines has no fixed views: its row is the fleet overview and its leaves are the machines themselves. Alerts is
 * the footer's bell, so it isn't here.
 */
type LeafOf<P extends MainPageId, T extends string> = { page: P; tab: T; labelKey: MessageKey; keywords?: MessageKey };
export type TreeLeaf =
  | LeafOf<'usage', UsageTabId>
  | LeafOf<'sessions', SessionsTabId>
  | LeafOf<'setup', SetupTabId>
  | LeafOf<'accounts', AccountsTabId>;

export type TreePageId = Exclude<MainPageId, 'alerts'>;
/** `machines`: the page lists the fleet's machines as its leaves, and its own row is a view, the overview. */
export type TreePage = { id: TreePageId; labelKey: MessageKey; leaves: readonly TreeLeaf[]; machines?: true; keywords?: MessageKey };
/** A section with no label (Home's) draws no head row. */
export type TreeSection = { id: 'top' | 'fleet' | 'spend'; labelKey: MessageKey | null; pages: readonly TreePage[] };

/**
 * One view of Sync (still `setup` inside), which Setup, its old name, finds in the search palette too, along with any
 * other words `keywords` gives it (which say Setup as well).
 */
const sync = (tab: SetupTabId, labelKey: MessageKey, keywords: MessageKey = 'tree.sync.keywords'): TreeLeaf => ({ page: 'setup', tab, labelKey, keywords });

export const SIDEBAR_TREE: readonly TreeSection[] = [
  { id: 'top', labelKey: null, pages: [{ id: 'home', labelKey: 'app.nav.home', leaves: [] }] },
  {
    id: 'fleet',
    labelKey: 'tree.section.fleet',
    pages: [
      // Each machine's page has its checklist, which was Sync's, and the palette still finds it by.
      { id: 'machines', labelKey: 'app.nav.machines', leaves: [], machines: true, keywords: 'tree.machines.keywords' },
      {
        id: 'sessions',
        labelKey: 'app.nav.sessions',
        leaves: [
          { page: 'sessions', tab: 'live', labelKey: 'fleet.tab', keywords: 'fleet.palette.keywords' },
          { page: 'sessions', tab: 'sessions', labelKey: 'tree.sessions.all' },
          // Its Activity; Checkouts, which was Sync's Projects, is the palette's own row below.
          { page: 'sessions', tab: 'projects', labelKey: 'usage.tab.projects', keywords: 'tree.projects.activityKeywords' },
        ],
      },
      {
        id: 'setup',
        labelKey: 'app.nav.setup',
        keywords: 'tree.sync.keywords',
        leaves: [
          sync('overview', 'setup.tab.overview'),
          // Machines' Agent updates, which the palette still finds it by, with each machine's versions.
          sync('agents', 'setup.tab.agents', 'tree.sync.agentsKeywords'),
          sync('skills', 'setup.tab.skills'),
          sync('plugins', 'setup.tab.plugins'),
          sync('hooks', 'setup.tab.hooks'),
          sync('toolchain', 'setup.tab.toolchain'),
          sync('repo', 'setup.tab.repo'),
          // Context's starting context and Usage's Claude Code, which the palette still finds it by.
          sync('cost', 'setup.tab.cost', 'tree.sync.costKeywords'),
          sync('history', 'setup.tab.history'),
        ],
      },
    ],
  },
  {
    id: 'spend',
    labelKey: 'tree.section.spend',
    pages: [
      {
        id: 'accounts',
        labelKey: 'app.nav.accounts',
        leaves: [
          { page: 'accounts', tab: 'limits', labelKey: 'tree.accounts.limits', keywords: 'tree.accounts.limitsKeywords' },
          // Settings' Auth files once, which the palette still finds it by.
          { page: 'accounts', tab: 'sign-ins', labelKey: 'tree.accounts.signIns', keywords: 'tree.accounts.signInsKeywords' },
          // Usage's Capacity once, which the palette still finds it by.
          { page: 'accounts', tab: 'value', labelKey: 'tree.accounts.value', keywords: 'tree.accounts.valueKeywords' },
        ],
      },
      {
        id: 'usage',
        labelKey: 'app.nav.usageRecords',
        leaves: [
          // Its Breakdown was the Analysis view, which the palette still finds it by.
          { page: 'usage', tab: 'overview', labelKey: 'usage.tab.overview', keywords: 'tree.usage.overviewKeywords' },
          { page: 'usage', tab: 'digest', labelKey: 'usage.tab.digest' },
          { page: 'usage', tab: 'lifetime', labelKey: 'usage.tab.lifetime' },
          { page: 'usage', tab: 'events', labelKey: 'usage.tab.events' },
          // Settings › Pricing once, which the palette still finds it by.
          { page: 'usage', tab: 'prices', labelKey: 'usage.tab.prices', keywords: 'tree.usage.pricesKeywords' },
        ],
      },
    ],
  },
];

/** Every page in the tree, top to bottom. */
export const TREE_PAGES: readonly TreePage[] = SIDEBAR_TREE.flatMap((section) => section.pages);

/**
 * Views the search palette lists under their page besides the tree's leaves: Requests with Failed on, which was
 * Usage's Failures, and Projects' Checkouts, which was Sync's Projects, so each is found by its old name and a recent
 * pick of it still opens it.
 */
export type PaletteView = { page: TreePageId; view: AppView; labelKey: MessageKey; keywords?: MessageKey };
export const PALETTE_VIEWS: readonly PaletteView[] = [
  { page: 'usage', view: failedRequestsView(), labelKey: 'usage.failures.title', keywords: 'usage.requests.failedKeywords' },
  { page: 'sessions', view: checkoutsView(), labelKey: 'tree.projects.checkoutsTitle', keywords: 'tree.projects.checkoutsKeywords' },
];

export const treePage = (id: MainPageId) => TREE_PAGES.find((page) => page.id === id);

/** The view a leaf opens. */
export function leafView(leaf: TreeLeaf): AppView {
  switch (leaf.page) {
    case 'usage': return usageView({ tab: leaf.tab });
    case 'sessions': return sessionsView({ tab: leaf.tab });
    case 'setup': return setupView({ tab: leaf.tab });
    case 'accounts': return accountsView({ tab: leaf.tab });
  }
}

/** The leaf a page's view is, by the page and the view's id. */
const treeLeaf = (page: MainPageId, tab: string | undefined) =>
  tab === undefined ? undefined : treePage(page)?.leaves.find((leaf) => leaf.tab === tab);

/** A view's name as the tree lists it, for the second half of the page's "Section / View" breadcrumb. */
export const leafLabel = (page: MainPageId, tab: string | undefined): MessageKey | undefined => treeLeaf(page, tab)?.labelKey;

/**
 * The leaf that's the view on screen, if one is. A session open in place of the Sessions list belongs to no view in
 * particular, and a page opened without naming a view has none until it writes the one it opened on into the view.
 */
export function openLeaf(view: AppView): TreeLeaf | undefined {
  if (view.kind !== 'main' || !view.params) return undefined;
  if (view.page === 'sessions' && view.params.session) return undefined;
  return 'tab' in view.params ? treeLeaf(view.page, view.params.tab) : undefined;
}

/**
 * The machine Machines has opened out, for lighting its leaf, when it's one of the machines `listed` under Machines.
 * One that isn't (gone or renamed since an old alert named it, or not loaded yet) has no leaf, so Machines' own row
 * stays lit as the current page.
 */
export function openMachine(view: AppView, listed: readonly string[]): string | null {
  const machine = view.kind === 'main' && view.page === 'machines' ? view.params?.machine ?? null : null;
  return machine !== null && listed.includes(machine) ? machine : null;
}

// ── Heights, in rem, for working out whether the open groups fit ─────────────────────────────────────────────────
/** A labeled section's head row, and the gap above every section but the first. */
export const SECTION_HEAD_REM = 1.75;
export const SECTION_GAP_REM = 0.75;
/** A page row, T3's 32px menu button, with the 1px after it. */
export const PAGE_ROW_REM = 2 + 1 / 16;
/** A view under its page: 28px, with the 2px after it, and the sub-list's 4px above and below. */
export const LEAF_ROW_REM = 1.75 + 2 / 16;
export const LEAF_LIST_PAD_REM = 0.5;

/** How many rows a page opens to: its views, or for Machines the machines, `machines` of them. */
export const leafCount = (page: TreePage, machines: number) => (page.machines ? machines : page.leaves.length);

/** How tall the tree is with these groups open, in rem, with `machines` rows under Machines when it's open. */
export function treeHeightRem(open: ReadonlySet<MainPageId>, machines = 0): number {
  return SIDEBAR_TREE.reduce((total, section, index) => {
    const pages = section.pages.reduce((sum, page) => {
      const leaves = leafCount(page, machines);
      if (!open.has(page.id) || !leaves) return sum + PAGE_ROW_REM;
      return sum + PAGE_ROW_REM + LEAF_LIST_PAD_REM + leaves * LEAF_ROW_REM;
    }, 0);
    return total + (index ? SECTION_GAP_REM : 0) + (section.labelKey ? SECTION_HEAD_REM : 0) + pages;
  }, 0);
}

/**
 * The groups drawn open: the ones wanted, less the others from the bottom of the tree up until it fits, so a short
 * window keeps the current page's views (or machines) in sight without scrolling. Neither the current page's group
 * nor `kept`, the one just opened by hand (`keptOpen`), is ever the one closed; when those don't fit, the tree
 * scrolls.
 */
export function fitOpenGroups(
  wanted: ReadonlySet<MainPageId>,
  current: MainPageId | null,
  availableRem: number,
  machines = 0,
  kept: MainPageId | null = null,
): Set<MainPageId> {
  const open = new Set(wanted);
  const others = TREE_PAGES.map((page) => page.id).filter((id) => id !== current && id !== kept && open.has(id)).reverse();
  for (const id of others) {
    if (treeHeightRem(open, machines) <= availableRem) break;
    open.delete(id);
  }
  return open;
}

/** A group opened by hand, by its chevron or Right arrow, and the page that was current when it was. */
export type HandOpened = { page: MainPageId; on: MainPageId | null };

/**
 * The group the fit leaves open besides the current page's: the one last opened by hand, for as long as the page it
 * was opened on is current. Closed again straight away to fit, its chevron would seem to do nothing and its views
 * would be out of reach without leaving the page. Going to another page lets it go, and it fits like the rest.
 */
export const keptOpen = (opened: HandOpened | null, current: MainPageId | null): MainPageId | null =>
  (opened && opened.on === current ? opened.page : null);

/** What's kept open after a group is opened or closed by hand on `current`. */
export const handOpened = (previous: HandOpened | null, page: MainPageId, open: boolean, current: MainPageId | null): HandOpened | null =>
  (open ? { page, on: current } : previous?.page === page ? null : previous);

// ── Which groups are open, kept across restarts ──────────────────────────────────────────────────────────────────
/**
 * A choice per page: true for opened by hand, false for closed by hand. A page with no choice is open while it's the
 * current page. Arriving at a page drops a "closed" on it, so the page you go to always shows its views.
 */
export type OpenChoices = Partial<Record<MainPageId, boolean>>;

/** The choices saved, keeping only true or false for a page that's in the tree. */
export const parseOpenChoices = (raw: string | null): OpenChoices =>
  Object.fromEntries(
    Object.entries(storedRecord(raw)).filter(([id, value]) => typeof value === 'boolean' && TREE_PAGES.some((page) => page.id === id)),
  ) as OpenChoices;

/** The groups wanted open: every one opened by hand, and the current page's unless it was closed by hand. */
export function wantedOpen(current: MainPageId | null, choices: OpenChoices): Set<MainPageId> {
  const open = new Set<MainPageId>();
  for (const page of TREE_PAGES) if (choices[page.id]) open.add(page.id);
  if (current && choices[current] !== false) open.add(current);
  return open;
}

/** The choices once a page is arrived at: its views show again, even if its group was closed by hand before. */
export function arrivedChoices(choices: OpenChoices, page: MainPageId): OpenChoices {
  if (choices[page] !== false) return choices;
  const { [page]: _dropped, ...rest } = choices;
  return rest;
}

const choices = savedStore<OpenChoices>({ key: 'arbor.sidebar.tree.v1', parse: parseOpenChoices, fallback: {}, place: 'window' });

export const useOpenChoices = choices.useValue;

export const setGroupOpen = (page: MainPageId, open: boolean) => choices.set({ ...choices.get(), [page]: open });

export const arriveAtPage = (page: MainPageId) => choices.set(arrivedChoices(choices.get(), page));

/**
 * Whether the tree's focused row was taken away with the focus on it, as a page change folding its group does, which
 * leaves the focus on the window (`active` is the document's focused element, `body` its body).
 */
export const focusDropped = (row: { isConnected: boolean } | null, active: unknown, body: unknown): boolean =>
  row !== null && !row.isConnected && (active === null || active === body);

// ── Moving through the tree with the keyboard ────────────────────────────────────────────────────────────────────
/**
 * The tree is a navigation landmark of lists and disclosure buttons (the WAI-ARIA disclosure pattern for navigation),
 * not an ARIA tree: every row is a button in the Tab order, and each page with views has a chevron button beside it
 * with `aria-expanded` that shows or hides them. On top of Tab, the arrow keys move the way they do in a tree:
 * - Up and Down go to the row above or below, pages and views alike, skipping the chevrons; Home and End go to the
 *   first and last row.
 * - Right on a page opens its group, or when it's open goes to its first view; Left on a view goes to its page, and on
 *   an open page closes its group.
 * This works out where Up, Down, Home and End go among `count` rows from `index`; null for any other key.
 */
export function treeKeyTarget(key: string, index: number, count: number): number | null {
  if (!count) return null;
  switch (key) {
    case 'ArrowDown': return Math.min(index + 1, count - 1);
    case 'ArrowUp': return Math.max(index - 1, 0);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

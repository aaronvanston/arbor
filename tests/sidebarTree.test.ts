import { describe, expect, test } from 'bun:test';
import { translate } from '../src/i18n';
import { paletteScore } from '../src/services/commandPalette';
import { accountsView, machinesView, mainPageIds, sessionsView, setupView, usageView, type MainPageId } from '../src/navigation';
import {
  arrivedChoices,
  fitOpenGroups,
  focusDropped,
  handOpened,
  keptOpen,
  leafView,
  openLeaf,
  openMachine,
  parseOpenChoices,
  SIDEBAR_TREE,
  TREE_PAGES,
  treeHeightRem,
  treeKeyTarget,
  wantedOpen,
} from '../src/services/sidebarTree';


describe('the sidebar tree', () => {
  test('has Home alone at the top, then Fleet (Machines, Pools, Sessions, Automations, Sync) and Spend (Accounts, Usage); Alerts is the footer’s bell', () => {
    expect(SIDEBAR_TREE.map((section) => [section.labelKey, section.pages.map((page) => page.id)])).toEqual([
      [null, ['home']],
      ['tree.section.fleet', ['machines', 'pools', 'sessions', 'automations', 'setup']],
      ['tree.section.spend', ['accounts', 'usage']],
    ]);
  });

  test('numbers its pages for ⌘1–⌘8 in the order it draws them, with Alerts on ⌘9', () => {
    expect(mainPageIds).toEqual([...TREE_PAGES.map((page) => page.id), 'alerts']);
  });

  test('lists every view each page has, Sync’s under their new names', () => {
    const leaves = (id: MainPageId) => TREE_PAGES.find((page) => page.id === id)?.leaves.map((leaf) => leaf.tab);
    expect(leaves('usage')).toEqual(['overview', 'digest', 'lifetime', 'events', 'prices']);
    expect(leaves('sessions')).toEqual(['live', 'sessions', 'projects']);
    expect(leaves('setup')).toEqual(['overview', 'library', 'projects', 'software', 'repo']);
    expect(TREE_PAGES.find((page) => page.id === 'setup')?.leaves.map((leaf) => leaf.labelKey).slice(0, 1)).toEqual(['setup.tab.overview']);
    expect(leaves('accounts')).toEqual(['limits', 'sign-ins', 'value']);
    // Machines lists the machines themselves.
    expect(leaves('machines')).toEqual([]);
    expect(TREE_PAGES.find((page) => page.id === 'machines')?.machines).toBe(true);
  });

  test('calls Setup Sync, which Setup still finds in the search palette, page and views alike', () => {
    const sync = TREE_PAGES.find((page) => page.id === 'setup');
    expect(translate('app.nav.setup')).toBe('Sync');
    const found = (label: string, keywords: string | undefined) => paletteScore({ id: label, group: 'pages', label, keywords }, 'setup');
    expect(found('Sync', sync?.keywords && translate(sync.keywords))).not.toBeNull();
    for (const leaf of sync?.leaves ?? []) expect(found(translate(leaf.labelKey), leaf.keywords && translate(leaf.keywords))).not.toBeNull();
  });

  test('lights the leaf that is the view on screen, and none for a session open in place of the list', () => {
    expect(openLeaf(usageView({ tab: 'events', result: 'failed' }))?.tab).toBe('events');
    expect(openLeaf(setupView({ tab: 'repo', lens: 'changes' }))?.labelKey).toBe('setup.tab.repo');
    expect(openLeaf(sessionsView({ tab: 'projects', project: 'arbor' }))?.tab).toBe('projects');
    expect(openLeaf(sessionsView({ tab: 'sessions', session: 'a3f1' }))).toBeUndefined();
    // A page opened without naming a view has none lit until it writes the one it opened on into the view.
    expect(openLeaf(usageView())).toBeUndefined();
    expect(openLeaf(accountsView({ tab: 'limits' }))?.labelKey).toBe('tree.accounts.limits');
    expect(openLeaf({ kind: 'main', page: 'accounts' })).toBeUndefined();
    expect(openLeaf({ kind: 'settings', page: 'general' })).toBeUndefined();
  });

  test('opens a leaf’s view, and a machine opens Machines with it opened out', () => {
    for (const page of TREE_PAGES) {
      for (const leaf of page.leaves) expect(openLeaf(leafView(leaf))).toBe(leaf);
    }
    const listed = ['this-mac', 'ci-01'];
    expect(openMachine(machinesView('ci-01'), listed)).toBe('ci-01');
    expect(openMachine(machinesView(), listed)).toBeNull();
    expect(openMachine(usageView({ machine: 'ci-01' }), listed)).toBeNull();
    // A machine the tree doesn't list has no leaf to light, so Machines' own row stays the current page.
    expect(openMachine(machinesView('old-box'), listed)).toBeNull();
    expect(openMachine(machinesView('ci-01'), [])).toBeNull();
  });
});

describe('the tree’s open groups', () => {
  test('open the current page’s unless it was closed by hand, and keep those opened by hand', () => {
    expect([...wantedOpen('usage', {})]).toEqual(['usage']);
    expect([...wantedOpen('usage', { usage: false })]).toEqual([]);
    // Home is wanted too as the current page, though it has nothing under it to show.
    expect([...wantedOpen('home', { machines: true, setup: false })]).toEqual(['machines', 'home']);
    expect([...wantedOpen('sessions', { usage: true })].sort()).toEqual(['sessions', 'usage']);
  });

  test('reopen a group closed by hand once its page is arrived at, and leave the rest as they were', () => {
    const choices = { usage: false, machines: true } as const;
    expect(arrivedChoices(choices, 'usage')).toEqual({ machines: true });
    expect(arrivedChoices(choices, 'machines')).toBe(choices);
    expect(arrivedChoices(choices, 'home')).toBe(choices);
  });

  test('are read back from storage, keeping only a yes or no for a page in the tree', () => {
    expect(parseOpenChoices(JSON.stringify({ usage: true, setup: false, alerts: true, nope: true, sessions: 'yes' }))).toEqual({ usage: true, setup: false });
    expect(parseOpenChoices('[true]')).toEqual({});
    expect(parseOpenChoices(null)).toEqual({});
  });

  test('that don’t fit close from the bottom up, never the current one, counting the machines as Machines’ rows', () => {
    const wanted = new Set<MainPageId>(['machines', 'setup', 'usage']);
    expect([...fitOpenGroups(wanted, 'machines', 100, { machines: 4 })].sort()).toEqual(['machines', 'setup', 'usage']);
    // Room for Machines and Sync but not Usage as well: Usage, the lowest, goes first.
    const both = treeHeightRem(new Set<MainPageId>(['machines', 'setup']), { machines: 4 });
    expect([...fitOpenGroups(wanted, 'machines', both, { machines: 4 })].sort()).toEqual(['machines', 'setup']);
    // The current page low in the tree keeps its group; the ones above it close, lowest first.
    expect([...fitOpenGroups(wanted, 'usage', treeHeightRem(new Set<MainPageId>(['machines', 'usage']), { machines: 4 }), { machines: 4 })].sort()).toEqual(['machines', 'usage']);
    // Too short for anything but the current group: it stays open, and the tree scrolls.
    expect([...fitOpenGroups(wanted, 'machines', 1, { machines: 4 })]).toEqual(['machines']);
    expect([...fitOpenGroups(wanted, null, 1, { machines: 4 })]).toEqual([]);
    // More machines take more room, and Machines with none listed has nothing to open.
    expect(treeHeightRem(new Set<MainPageId>(['machines']), { machines: 18 })).toBeGreaterThan(treeHeightRem(new Set<MainPageId>(['machines']), { machines: 4 }));
    expect(treeHeightRem(new Set<MainPageId>(['machines']), { machines: 0 })).toBe(treeHeightRem(new Set()));
    // A page with no views, like Home, takes a row whether it's "open" or not.
    expect(treeHeightRem(new Set<MainPageId>(['home']))).toBe(treeHeightRem(new Set()));
  });

  test('fit a 640px-tall window’s tree with Usage open and the machines closed', () => {
    // 640px window, less the title row, search row and footer: about 26rem for the tree.
    const open = fitOpenGroups(new Set<MainPageId>(['machines', 'setup', 'usage']), 'usage', 26, { machines: 18 });
    expect([...open]).toEqual(['usage']);
  });

  test('leave a group just opened by hand open, closing only the others to fit, and scroll when even that’s too tall', () => {
    const wanted = new Set<MainPageId>(['machines', 'sessions', 'setup', 'accounts', 'usage']);
    // Accounts' chevron on Usage › Requests in a 640px window: Accounts opens, and the rest still close to fit.
    expect([...fitOpenGroups(wanted, 'usage', 26, { machines: 18 }, 'accounts')].sort()).toEqual(['accounts', 'usage']);
    // Sync's nine views and Usage's four are taller than the room: both stay open, and the tree scrolls.
    const sync = fitOpenGroups(wanted, 'usage', 26, { machines: 18 }, 'setup');
    expect([...sync].sort()).toEqual(['setup', 'usage']);
    expect(treeHeightRem(sync, { machines: 18 })).toBeGreaterThan(26);
    // Machines' own chevron on a machine's page is its current group; Usage opened by hand stays with it.
    expect([...fitOpenGroups(wanted, 'machines', 26, { machines: 18 }, 'usage')].sort()).toEqual(['machines', 'usage']);
  });

  test('keep a group opened by hand open only while the page it was opened on is current', () => {
    const opened = handOpened(null, 'setup', true, 'usage');
    expect(opened).toEqual({ page: 'setup', on: 'usage' });
    expect(keptOpen(opened, 'usage')).toBe('setup');
    // Another page fits it like the rest.
    expect(keptOpen(opened, 'sessions')).toBeNull();
    expect(keptOpen(null, 'usage')).toBeNull();
    // Closing it by hand lets it go; closing another leaves it; opening another takes its place.
    expect(handOpened(opened, 'setup', false, 'usage')).toBeNull();
    expect(handOpened(opened, 'accounts', false, 'usage')).toBe(opened);
    expect(handOpened(opened, 'accounts', true, 'usage')).toEqual({ page: 'accounts', on: 'usage' });
  });
});

describe('the tree’s focus', () => {
  test('counts as dropped only when its row was taken away and the focus fell to the window', () => {
    const body = { tag: 'body' };
    const gone = { isConnected: false };
    expect(focusDropped(gone, body, body)).toBe(true);
    expect(focusDropped(gone, null, body)).toBe(true);
    // The focus went somewhere else before the row went: it stays there.
    expect(focusDropped(gone, { tag: 'input' }, body)).toBe(false);
    // The row is still there, or there wasn't one.
    expect(focusDropped({ isConnected: true }, body, body)).toBe(false);
    expect(focusDropped(null, body, body)).toBe(false);
  });
});

describe('the tree’s arrow keys', () => {
  test('move up and down a row, stopping at the ends, and Home and End go to the first and last', () => {
    expect(treeKeyTarget('ArrowDown', 2, 5)).toBe(3);
    expect(treeKeyTarget('ArrowDown', 4, 5)).toBe(4);
    expect(treeKeyTarget('ArrowUp', 0, 5)).toBe(0);
    expect(treeKeyTarget('ArrowUp', 3, 5)).toBe(2);
    expect(treeKeyTarget('Home', 3, 5)).toBe(0);
    expect(treeKeyTarget('End', 1, 5)).toBe(4);
  });

  test('leave other keys, and an empty tree, alone', () => {
    expect(treeKeyTarget('ArrowRight', 1, 5)).toBeNull();
    expect(treeKeyTarget('Enter', 1, 5)).toBeNull();
    expect(treeKeyTarget('ArrowDown', 0, 0)).toBeNull();
  });
});

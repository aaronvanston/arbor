import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import { alertDestinationView } from '../src/alertNavigation';
import {
  accountLimitsView,
  accountsView,
  canOpenView,
  checkoutsView,
  failedRequestsView,
  machinesView,
  mainPageView,
  movedSetupView,
  movedUsageView,
  savedSetupView,
  savedUsageView,
  libraryView,
  sessionsView,
  setupView,
  usageView,
} from '../src/navigation';
import { palettePageId, paletteScore, parseRecents } from '../src/services/commandPalette';
import { PALETTE_VIEWS, TREE_PAGES } from '../src/services/sidebarTree';

/** The palette row a tree leaf gets, found (or not) by `query`. */
function leafFound(page: string, tab: string, query: string) {
  const leaf = TREE_PAGES.find((item) => item.id === page)?.leaves.find((item) => item.tab === tab);
  if (!leaf) throw new Error(`no ${page} leaf ${tab}`);
  const label = translate(leaf.labelKey);
  return paletteScore({ id: label, group: 'pages', label, keywords: leaf.keywords && translate(leaf.keywords) }, query) !== null;
}

describe('Usage’s Failures, now Requests with Failed on', () => {
  it('opens Requests with Failed on from its old id, in a link, a saved pick, a query string or where Usage was left', () => {
    expect(failedRequestsView()).toEqual(usageView({ tab: 'events', result: 'failed' }));
    expect(movedUsageView('failures')).toEqual(failedRequestsView());
    expect(mainPageView('usage', 'failures')).toEqual(failedRequestsView());
    expect(savedUsageView('failures')).toEqual({ tab: 'events', result: 'failed' });
    expect(parseRecents(JSON.stringify(['page:main:usage:failures', 'page:main:usage:events']))).toEqual(['page:main:usage:events:failed', 'page:main:usage:events']);
  });

  it('is listed in the search palette as Usage › Failed requests, found by its old name, apart from Requests', () => {
    const [failed] = PALETTE_VIEWS;
    if (!failed) throw new Error('no palette views');
    expect(failed.page).toBe('usage');
    expect(failed.view).toEqual(failedRequestsView());
    expect(palettePageId(failed.view)).toBe('page:main:usage:events:failed');
    expect(palettePageId(usageView({ tab: 'events' }))).toBe('page:main:usage:events');
    const label = translate(failed.labelKey);
    expect(label).toBe('Failed requests');
    expect(paletteScore({ id: label, group: 'pages', label, keywords: failed.keywords && translate(failed.keywords) }, 'failures')).not.toBeNull();
    expect(leafFound('usage', 'events', 'failures')).toBe(false);
  });
});

describe('Usage’s Analysis, now the Breakdown on Overview', () => {
  it('opens Overview from its old id, in a link, a saved pick, a query string or the view Usage was left on', () => {
    expect(movedUsageView('analysis')).toEqual(usageView({ tab: 'overview' }));
    expect(mainPageView('usage', 'analysis')).toEqual(usageView({ tab: 'overview' }));
    expect(parseRecents(JSON.stringify(['page:main:usage:analysis']))).toEqual(['page:main:usage:overview']);
    expect(savedUsageView('analysis')).toEqual({ tab: 'overview' });
  });

  it('lists a saved pick of Analysis and one of Overview once', () => {
    expect(parseRecents(JSON.stringify(['page:main:usage:analysis', 'page:main:usage:overview', 'page:main:home']))).toEqual(['page:main:usage:overview', 'page:main:home']);
  });

  it('is found by its old name, and by Breakdown, in the search palette', () => {
    expect(leafFound('usage', 'overview', 'analysis')).toBe(true);
    expect(leafFound('usage', 'overview', 'breakdown')).toBe(true);
  });
});

describe('Usage’s Capacity, now Accounts › Value', () => {
  it('opens Value from its old id, in a link, a saved pick or a query string', () => {
    expect(movedUsageView('capacity')).toEqual(accountsView({ tab: 'value' }));
    expect(mainPageView('usage', 'capacity')).toEqual(accountsView({ tab: 'value' }));
    expect(mainPageView('accounts', 'value')).toEqual(accountsView({ tab: 'value' }));
    expect(parseRecents(JSON.stringify(['page:main:usage:capacity', 'page:main:home']))).toEqual(['page:main:accounts:value', 'page:main:home']);
    expect(palettePageId(accountsView({ tab: 'value' }))).toBe('page:main:accounts:value');
  });

  it('opens Usage on Overview when it was the view Usage was left on, rather than leaving the page', () => {
    expect(savedUsageView('capacity')).toEqual({ tab: 'overview' });
    expect(savedUsageView('lifetime')).toEqual({ tab: 'lifetime' });
    expect(savedUsageView(null)).toEqual({ tab: 'overview' });
  });

  it('is found by its old name in the search palette', () => {
    expect(leafFound('accounts', 'value', 'capacity')).toBe(true);
    expect(leafFound('accounts', 'limits', 'capacity')).toBe(false);
  });

  it('opens with the core stopped, as it did on Usage, while Limits still needs it', () => {
    expect(canOpenView(accountsView({ tab: 'value' }), false)).toBe(true);
    expect(canOpenView(accountLimitsView(), false)).toBe(false);
    expect(canOpenView({ kind: 'main', page: 'accounts' }, false)).toBe(false);
    expect(canOpenView(usageView({ tab: 'overview' }), false)).toBe(true);
  });

  it('leaves an account’s alert opening Limits, where its row is', () => {
    expect(alertDestinationView({ kind: 'accounts', account: 'claude-max' })).toEqual(accountLimitsView());
  });

  it('leaves ids that never moved alone', () => {
    expect(movedUsageView('events')).toBeNull();
    expect(movedUsageView('toString')).toBeNull();
    expect(movedUsageView(null)).toBeNull();
    expect(parseRecents(JSON.stringify(['page:main:usage:events', 'page:main:usage']))).toEqual(['page:main:usage:events', 'page:main:usage']);
  });
});

describe('Sync’s Context and Usage’s Claude Code, then Sync › Cost, now the Library by cost', () => {
  it('opens the Library by cost from every old id, in a link, a saved pick, a query string or where Sync was left', () => {
    const cost = libraryView(undefined, 'cost');
    expect(cost).toEqual(setupView({ tab: 'library', lens: 'cost' }));
    expect(movedSetupView('context')).toEqual(cost);
    expect(movedSetupView('cost')).toEqual(cost);
    expect(movedUsageView('telemetry')).toEqual(cost);
    expect(mainPageView('setup', 'context')).toEqual(cost);
    expect(mainPageView('setup', 'cost')).toEqual(cost);
    expect(mainPageView('usage', 'telemetry')).toEqual(cost);
    expect(savedSetupView('context')).toEqual({ tab: 'library', lens: 'cost' });
    expect(savedSetupView('cost')).toEqual({ tab: 'library', lens: 'cost' });
    expect(parseRecents(JSON.stringify(['page:main:setup:context', 'page:main:usage:telemetry', 'page:main:home']))).toEqual(['page:main:setup:library:cost', 'page:main:home']);
  });

  it('opens Usage on Overview when Claude Code was the view Usage was left on, rather than leaving the page', () => {
    expect(savedUsageView('telemetry')).toEqual({ tab: 'overview' });
  });

  it('is found in the search palette by its old names, and by Setup', () => {
    expect(leafFound('setup', 'library', 'claude code')).toBe(true);
    expect(leafFound('setup', 'library', 'context')).toBe(true);
    expect(leafFound('setup', 'library', 'cost')).toBe(true);
    expect(leafFound('setup', 'library', 'setup')).toBe(true);
    expect(leafFound('setup', 'library', 'telemetry')).toBe(true);
    expect(TREE_PAGES.find((page) => page.id === 'usage')?.leaves.some((leaf) => (leaf.tab as string) === 'telemetry')).toBe(false);
  });
});

describe('Sync’s Agents and Toolchain, now Sync › Software', () => {
  it('opens Software from either old id, which the palette still finds it by', () => {
    expect(mainPageView('setup', 'agents')).toEqual(setupView({ tab: 'software' }));
    expect(mainPageView('setup', 'toolchain')).toEqual(setupView({ tab: 'software' }));
    expect(savedSetupView('agents')).toEqual({ tab: 'software' });
    expect(savedSetupView('toolchain')).toEqual({ tab: 'software' });
    expect(palettePageId(setupView({ tab: 'software' }))).toBe('page:main:setup:software');
    expect(leafFound('setup', 'software', 'agent updates')).toBe(true);
    expect(leafFound('setup', 'software', 'rollout')).toBe(true);
    expect(leafFound('setup', 'software', 'versions')).toBe(true);
    expect(leafFound('setup', 'software', 'toolchain')).toBe(true);
  });
});

describe('Sync’s Skills, MCP & plugins and Hooks, now the Library’s kinds', () => {
  it('opens each old view as its kind by machine, the grid it was', () => {
    expect(mainPageView('setup', 'skills')).toEqual(libraryView('skills', 'machines'));
    expect(mainPageView('setup', 'plugins')).toEqual(libraryView('plugins', 'machines'));
    expect(mainPageView('setup', 'hooks')).toEqual(libraryView('hooks', 'machines'));
    expect(savedSetupView('skills')).toEqual({ tab: 'library', kind: 'skills', lens: 'machines' });
    for (const word of ['skills', 'plugins', 'mcp', 'hooks', 'marketplaces']) expect(leafFound('setup', 'library', word)).toBe(true);
  });
});

describe('Sync’s Checklist, now on each machine’s page', () => {
  it('opens Machines from its old id, in a link, a saved pick or a query string, and Sync where Sync was left on it', () => {
    expect(movedSetupView('checklist')).toEqual(machinesView());
    expect(mainPageView('setup', 'checklist')).toEqual(machinesView());
    expect(savedSetupView('checklist')).toEqual({ tab: 'overview' });
    expect(parseRecents(JSON.stringify(['page:main:setup:checklist']))).toEqual(['page:main:machines']);
  });

  it('finds Machines in the search palette by its old name', () => {
    const machines = TREE_PAGES.find((page) => page.id === 'machines');
    if (!machines) throw new Error('no Machines row');
    const label = translate(machines.labelKey);
    const found = (query: string) => paletteScore({ id: label, group: 'pages', label, keywords: machines.keywords && translate(machines.keywords) }, query) !== null;
    expect(found('checklist')).toBe(true);
    expect(found('add a machine')).toBe(true);
  });
});

describe('Sessions › Projects’ Checkouts, once Sync’s Projects, and Sync › Projects now', () => {
  it('opens Checkouts by its own view, and Sync’s old Projects id on Sync’s Projects again', () => {
    expect(checkoutsView()).toEqual(sessionsView({ tab: 'projects', lens: 'checkouts' }));
    expect(movedSetupView('projects')).toBeNull();
    expect(mainPageView('setup', 'projects')).toEqual(setupView({ tab: 'projects' }));
    expect(mainPageView('sessions', 'projects', { lens: 'checkouts' })).toEqual(checkoutsView());
    // Without a lens, or with one Projects doesn't have, it's Projects' Activity.
    expect(mainPageView('sessions', 'projects')).toEqual(sessionsView({ tab: 'projects' }));
    expect(mainPageView('sessions', 'projects', { lens: 'nope' })).toEqual(sessionsView({ tab: 'projects' }));
    expect(mainPageView('sessions', 'live', { lens: 'checkouts' })).toEqual(sessionsView({ tab: 'live' }));
    expect(palettePageId(checkoutsView())).toBe('page:main:sessions:projects:checkouts');
    expect(palettePageId(sessionsView({ tab: 'projects' }))).toBe('page:main:sessions:projects');
    expect(parseRecents(JSON.stringify(['page:main:setup:projects', 'page:main:sessions:projects']))).toEqual([
      'page:main:setup:projects',
      'page:main:sessions:projects',
    ]);
  });

  it('opens Sync on Projects when it was last left there, and lists it in the sidebar', () => {
    expect(savedSetupView('projects')).toEqual({ tab: 'projects' });
    expect(TREE_PAGES.find((page) => page.id === 'setup')?.leaves.some((leaf) => (leaf.tab as string) === 'projects')).toBe(true);
  });
});

describe('Sync’s views that kept their ids', () => {
  it('open Overview from `overview`, and Arbor’s changes, now the Repo’s, from `history`', () => {
    expect(mainPageView('setup', 'overview')).toEqual(setupView({ tab: 'overview' }));
    expect(mainPageView('setup', 'history')).toEqual(setupView({ tab: 'repo', lens: 'changes' }));
    expect(savedSetupView('overview')).toEqual({ tab: 'overview' });
    expect(savedSetupView('history')).toEqual({ tab: 'repo', lens: 'changes' });
    expect(movedSetupView('overview')).toBeNull();
    expect(parseRecents(JSON.stringify(['page:main:setup:overview', 'page:main:setup:history']))).toEqual(['page:main:setup:overview', 'page:main:setup:repo:changes']);
    expect(translate('setup.tab.overview')).toBe('Overview');
    expect(leafFound('setup', 'repo', 'arbor’s changes')).toBe(true);
    expect(leafFound('setup', 'overview', 'checks')).toBe(true);
  });

  it('keeps a recent pick of Context or Arbor’s changes on the lens it moved to, which the palette has a row of', () => {
    const rows = PALETTE_VIEWS.map((item) => palettePageId(item.view));
    for (const id of parseRecents(JSON.stringify(['page:main:setup:context', 'page:main:setup:history']))) expect(rows).toContain(id);
    // Lenses the palette has no row of keep their tab's row, so the pick still opens Sync.
    expect(palettePageId(libraryView('skills', 'machines'))).toBe('page:main:setup:library');
  });

  it('opens Overview for a saved view that was never Sync’s, or none', () => {
    expect(savedSetupView('nope')).toEqual({ tab: 'overview' });
    expect(savedSetupView(null)).toEqual({ tab: 'overview' });
    expect(movedSetupView('toString')).toBeNull();
  });

  it('lists Sync’s views in the sidebar’s order, Overview first', () => {
    expect(TREE_PAGES.find((page) => page.id === 'setup')?.leaves.map((leaf) => translate(leaf.labelKey))).toEqual([
      'Overview', 'Library', 'Projects', 'Software', 'Repo',
    ]);
  });

  it('opens Sync’s Checks for a change to a machine’s setup, whichever view Sync was left on', () => {
    // Agents and Cost, where Sync may have been left, show none of the scanned setup the change is in.
    expect(alertDestinationView({ kind: 'setup' })).toEqual(setupView({ tab: 'overview' }));
  });
});

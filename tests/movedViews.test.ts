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

describe('Sync’s Context and Usage’s Claude Code, now Sync › Cost', () => {
  it('opens Cost from either old id, in a link, a saved pick, a query string or where Sync was left', () => {
    expect(movedSetupView('context')).toEqual(setupView({ tab: 'cost' }));
    expect(movedUsageView('telemetry')).toEqual(setupView({ tab: 'cost' }));
    expect(mainPageView('setup', 'context')).toEqual(setupView({ tab: 'cost' }));
    expect(mainPageView('usage', 'telemetry')).toEqual(setupView({ tab: 'cost' }));
    expect(savedSetupView('context')).toBe('cost');
    expect(parseRecents(JSON.stringify(['page:main:setup:context', 'page:main:usage:telemetry', 'page:main:home']))).toEqual(['page:main:setup:cost', 'page:main:home']);
    expect(palettePageId(setupView({ tab: 'cost' }))).toBe('page:main:setup:cost');
  });

  it('opens Usage on Overview when Claude Code was the view Usage was left on, rather than leaving the page', () => {
    expect(savedUsageView('telemetry')).toEqual({ tab: 'overview' });
  });

  it('is found in the search palette by both old names, and by Setup', () => {
    expect(leafFound('setup', 'cost', 'claude code')).toBe(true);
    expect(leafFound('setup', 'cost', 'context')).toBe(true);
    expect(leafFound('setup', 'cost', 'setup')).toBe(true);
    expect(leafFound('setup', 'cost', 'telemetry')).toBe(true);
    expect(TREE_PAGES.find((page) => page.id === 'usage')?.leaves.some((leaf) => (leaf.tab as string) === 'telemetry')).toBe(false);
  });
});

describe('Machines’ Agent updates, now Sync › Agents', () => {
  it('has a leaf of its own on Sync, right after Checks, which the palette finds by its old name', () => {
    expect(mainPageView('setup', 'agents')).toEqual(setupView({ tab: 'agents' }));
    expect(savedSetupView('agents')).toBe('agents');
    expect(palettePageId(setupView({ tab: 'agents' }))).toBe('page:main:setup:agents');
    expect(TREE_PAGES.find((page) => page.id === 'setup')?.leaves.slice(0, 2).map((leaf) => leaf.tab)).toEqual(['overview', 'agents']);
    expect(leafFound('setup', 'agents', 'agent updates')).toBe(true);
    expect(leafFound('setup', 'agents', 'rollout')).toBe(true);
    expect(leafFound('setup', 'agents', 'versions')).toBe(true);
  });

  it('leaves Machines itself where it was, for its health and a machine an alert names', () => {
    expect(mainPageView('machines')).toEqual(machinesView());
    expect(alertDestinationView({ kind: 'machines', machine: 'ci-01' })).toEqual(machinesView('ci-01'));
  });
});

describe('Sync’s Checklist, now on each machine’s page', () => {
  it('opens Machines from its old id, in a link, a saved pick or a query string, and Sync where Sync was left on it', () => {
    expect(movedSetupView('checklist')).toEqual(machinesView());
    expect(mainPageView('setup', 'checklist')).toEqual(machinesView());
    expect(savedSetupView('checklist')).toBe('overview');
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

describe('Sync’s Projects, now Sessions › Projects’ Checkouts', () => {
  it('opens Checkouts from its old id, in a link, a saved pick or a query string', () => {
    expect(checkoutsView()).toEqual(sessionsView({ tab: 'projects', lens: 'checkouts' }));
    expect(movedSetupView('projects')).toEqual(checkoutsView());
    expect(mainPageView('setup', 'projects')).toEqual(checkoutsView());
    expect(mainPageView('sessions', 'projects', { lens: 'checkouts' })).toEqual(checkoutsView());
    // Without a lens, or with one Projects doesn't have, it's Projects' Activity.
    expect(mainPageView('sessions', 'projects')).toEqual(sessionsView({ tab: 'projects' }));
    expect(mainPageView('sessions', 'projects', { lens: 'nope' })).toEqual(sessionsView({ tab: 'projects' }));
    expect(mainPageView('sessions', 'live', { lens: 'checkouts' })).toEqual(sessionsView({ tab: 'live' }));
    expect(palettePageId(checkoutsView())).toBe('page:main:sessions:projects:checkouts');
    expect(palettePageId(sessionsView({ tab: 'projects' }))).toBe('page:main:sessions:projects');
    expect(parseRecents(JSON.stringify(['page:main:setup:projects', 'page:main:sessions:projects']))).toEqual([
      'page:main:sessions:projects:checkouts',
      'page:main:sessions:projects',
    ]);
  });

  it('opens Checks when Sync was last left on Projects, rather than leaving Sync', () => {
    expect(savedSetupView('projects')).toBe('overview');
    expect(TREE_PAGES.find((page) => page.id === 'setup')?.leaves.some((leaf) => (leaf.tab as string) === 'projects')).toBe(false);
  });

  it('is found in the search palette as Checkouts and by Projects, beside Projects itself', () => {
    const checkouts = PALETTE_VIEWS.find((item) => palettePageId(item.view) === palettePageId(checkoutsView()));
    if (!checkouts) throw new Error('no Checkouts row');
    expect(checkouts.page).toBe('sessions');
    const label = translate(checkouts.labelKey);
    const found = (query: string) => paletteScore({ id: label, group: 'pages', label, keywords: checkouts.keywords && translate(checkouts.keywords) }, query) !== null;
    expect(label).toBe('Project checkouts');
    expect(found('checkouts')).toBe(true);
    expect(found('projects')).toBe(true);
    expect(found('worktrees')).toBe(true);
    expect(found('sync')).toBe(true);
    expect(leafFound('sessions', 'projects', 'projects')).toBe(true);
    expect(leafFound('sessions', 'projects', 'activity')).toBe(true);
  });
});

describe('Sync’s views that kept their ids', () => {
  it('open Checks from `overview` and Arbor’s changes from `history`, however they’re named', () => {
    expect(mainPageView('setup', 'overview')).toEqual(setupView({ tab: 'overview' }));
    expect(mainPageView('setup', 'history')).toEqual(setupView({ tab: 'history' }));
    expect(savedSetupView('overview')).toBe('overview');
    expect(savedSetupView('history')).toBe('history');
    expect(movedSetupView('overview')).toBeNull();
    expect(movedSetupView('history')).toBeNull();
    expect(parseRecents(JSON.stringify(['page:main:setup:overview', 'page:main:setup:history']))).toEqual(['page:main:setup:overview', 'page:main:setup:history']);
    expect(translate('setup.tab.overview')).toBe('Checks');
    expect(translate('setup.tab.history')).toBe('Arbor’s changes');
  });

  it('opens Checks for a saved view that was never Sync’s, or none', () => {
    expect(savedSetupView('nope')).toBe('overview');
    expect(savedSetupView(null)).toBe('overview');
    expect(movedSetupView('toString')).toBeNull();
  });

  it('lists Sync’s views in the sidebar’s order, Checks first', () => {
    expect(TREE_PAGES.find((page) => page.id === 'setup')?.leaves.map((leaf) => translate(leaf.labelKey))).toEqual([
      'Checks', 'Agents', 'Skills', 'MCP & plugins', 'Hooks', 'Toolchain', 'Repo', 'Cost', 'Arbor’s changes',
    ]);
  });

  it('opens Sync’s Checks for a change to a machine’s setup, whichever view Sync was left on', () => {
    // Agents and Cost, where Sync may have been left, show none of the scanned setup the change is in.
    expect(alertDestinationView({ kind: 'setup' })).toEqual(setupView({ tab: 'overview' }));
  });
});

import { afterEach, describe, expect, it } from 'bun:test';
import { alertDestinationView } from '../src/alertNavigation';
import { accountsView, canOpenView, machinesView, mainPageView, normalizeView, sameView, sessionsView, setupView, usageView, type AppView } from '../src/navigation';
import {
  HISTORY_LIMIT,
  canArrive,
  changePageView,
  changeView,
  currentView,
  goBack,
  goForward,
  goToView,
  lockedInPlace,
  mouseStep,
  pushView,
  replaceView,
  resetViewHistory,
  returnToView,
  startHistory,
  stepHistory,
  stepTarget,
  type ViewHistory,
} from '../src/services/viewHistory';

const home: AppView = { kind: 'main', page: 'home' };
const accounts: AppView = { kind: 'main', page: 'accounts' };
const machines: AppView = { kind: 'main', page: 'machines' };
const setup: AppView = { kind: 'main', page: 'setup' };
const general: AppView = { kind: 'settings', page: 'general' };
const modelRoutes: AppView = { kind: 'settings', page: 'overrides' };

const history = (entries: readonly AppView[], index = entries.length - 1): ViewHistory => ({ entries, index });
const pages = (state: ViewHistory) => state.entries.map((view) => (view.kind === 'main' ? view.page : `settings:${view.page}`));
const coreUp = (view: AppView) => canOpenView(view, true);
const coreDown = (view: AppView) => canOpenView(view, false);

describe('views that carry what they show', () => {
  it('count an empty filter as no filter', () => {
    expect(sameView(usageView({ tab: 'events', machine: '' }), usageView({ tab: 'events' }))).toBe(true);
    expect(sameView(sessionsView({}), { kind: 'main', page: 'sessions' })).toBe(true);
    expect(normalizeView(sessionsView({ session: '', project: '' }))).toEqual({ kind: 'main', page: 'sessions' });
    expect(normalizeView(usageView({ tab: 'digest', session: undefined }))).toEqual({ kind: 'main', page: 'usage', params: { tab: 'digest' } });
    expect(normalizeView(home)).toBe(home);
  });

  it('differ by any param, and by page even with the same params', () => {
    expect(sameView(sessionsView({ session: 'a3f1' }), sessionsView({ session: 'b7' }))).toBe(false);
    expect(sameView(sessionsView({ tab: 'projects' }), sessionsView({ tab: 'sessions' }))).toBe(false);
    expect(sameView(usageView({ machine: 'ci-01' }), sessionsView({ machine: 'ci-01' }))).toBe(false);
    expect(sameView(general, { kind: 'settings', page: 'general' })).toBe(true);
    expect(sameView(general, modelRoutes)).toBe(false);
  });

  it('carry Sync’s view, Accounts’ and the machine Machines has opened out', () => {
    expect(sameView(setupView({ tab: 'skills' }), setupView({ tab: 'repo' }))).toBe(false);
    expect(sameView(setupView({}), setup)).toBe(true);
    expect(normalizeView(machinesView())).toEqual(machines);
    expect(normalizeView(machinesView('ci-01'))).toEqual({ kind: 'main', page: 'machines', params: { machine: 'ci-01' } });
    expect(sameView(machinesView('ci-01'), machinesView('cedar-02'))).toBe(false);
    expect(sameView(accountsView({ tab: 'limits' }), accounts)).toBe(false);
  });

  it('are named by a page’s id and its view’s, a view the page doesn’t have opening it where it was left', () => {
    expect(mainPageView('setup', 'history')).toEqual(setupView({ tab: 'history' }));
    expect(mainPageView('usage', 'lifetime')).toEqual(usageView({ tab: 'lifetime' }));
    expect(normalizeView(mainPageView('setup', 'nope') ?? home)).toEqual(setup);
    expect(mainPageView('accounts', 'limits')).toEqual(accountsView({ tab: 'limits' }));
    expect(mainPageView('machines', null, { machine: 'ci-01' })).toEqual(machinesView('ci-01'));
    expect(mainPageView('alerts')).toEqual({ kind: 'main', page: 'alerts' });
    expect(mainPageView('versions')).toBeNull();
  });

  it('are what an alert opens, with its session, tab or machine', () => {
    expect(alertDestinationView({ kind: 'session', session: 'a3f1' })).toEqual(sessionsView({ session: 'a3f1' }));
    expect(alertDestinationView({ kind: 'digest' })).toEqual(usageView({ tab: 'digest' }));
    expect(alertDestinationView({ kind: 'sessions' })).toEqual({ kind: 'main', page: 'sessions' });
    expect(alertDestinationView({ kind: 'machines', machine: 'ci-01' })).toEqual(machinesView('ci-01'));
    expect(normalizeView(alertDestinationView({ kind: 'machines' }) ?? home)).toEqual(machines);
  });
});

describe('going somewhere', () => {
  it('adds a step and drops the ones ahead', () => {
    const state = pushView(history([home, accounts, machines], 1), setup);
    expect(pages(state)).toEqual(['home', 'accounts', 'setup']);
    expect(state.index).toBe(2);
  });

  it('changes nothing when it’s the view already on screen, and keeps the steps ahead', () => {
    const state = history([home, usageView({ tab: 'events' }), accounts], 1);
    expect(pushView(state, usageView({ tab: 'events', machine: '' }))).toBe(state);
    // The same page showing something else is a step of its own.
    expect(pages(pushView(state, usageView({ tab: 'events', result: 'failed' })))).toEqual(['home', 'usage', 'usage']);
  });

  it('keeps the latest steps once there are too many', () => {
    let state = startHistory();
    for (let step = 0; step < HISTORY_LIMIT + 20; step += 1) state = pushView(state, sessionsView({ session: `s${step}` }));
    expect(state.entries).toHaveLength(HISTORY_LIMIT);
    expect(state.index).toBe(HISTORY_LIMIT - 1);
    expect(currentView(state)).toEqual(sessionsView({ session: `s${HISTORY_LIMIT + 19}` }));
    expect(state.entries[0]).toEqual(sessionsView({ session: 's20' }));
    expect(pushView(history([home, accounts]), setup, 2).entries).toEqual([accounts, setup]);
  });

  it('keeps each view without its empty params', () => {
    expect(currentView(pushView(startHistory(), sessionsView({ project: 'arbor', machine: '' })))).toEqual(sessionsView({ project: 'arbor' }));
  });
});

describe('a page changing what it shows', () => {
  it('rewrites its own step and keeps the ones ahead', () => {
    const state = replaceView(history([home, usageView({ tab: 'overview' }), accounts], 1), usageView({ tab: 'digest' }));
    expect(state.entries).toEqual([home, usageView({ tab: 'digest' }), accounts]);
    expect(state.index).toBe(1);
  });

  it('changes nothing when it shows the same thing', () => {
    const state = history([home, usageView({ tab: 'events' })]);
    expect(replaceView(state, usageView({ tab: 'events', session: '' }))).toBe(state);
  });

  it('folds into the step beside it once they show the same thing', () => {
    // Choosing Sessions again from the list opens it afresh, and the page then names its tab.
    const again = replaceView(history([home, sessionsView({ tab: 'sessions' }), sessionsView({})]), sessionsView({ tab: 'sessions' }));
    expect(again).toEqual(history([home, sessionsView({ tab: 'sessions' })]));
    const ahead = replaceView(history([home, usageView({ tab: 'overview' }), usageView({ tab: 'events' })], 1), usageView({ tab: 'events' }));
    expect(ahead).toEqual(history([home, usageView({ tab: 'events' })]));
  });

  it('opens a session as a step of its own, and closing it steps back to the list', () => {
    const list = sessionsView({ tab: 'sessions', project: 'arbor' });
    const opened = changeView(history([home, list]), sessionsView({ tab: 'sessions', project: 'arbor', session: 'a3f1' }), 'push');
    expect(opened.index).toBe(2);
    const closed = changeView(opened, list, 'return');
    expect(closed).toEqual({ entries: opened.entries, index: 1 });
    // Forward opens it again.
    expect(currentView(stepHistory(closed, 1, coreUp))).toEqual(sessionsView({ tab: 'sessions', project: 'arbor', session: 'a3f1' }));
  });

  it('closes a session opened from elsewhere to the list, in its place', () => {
    const state = history([home, sessionsView({ session: 'a3f1' })]);
    expect(returnToView(state, sessionsView({}))).toEqual(history([home, { kind: 'main', page: 'sessions' }]));
  });

  it('is ignored once another page is on screen', () => {
    const state = history([home, accounts]);
    expect(changeView(state, usageView({ tab: 'events' }), 'replace')).toBe(state);
    expect(changeView(state, sessionsView({ session: 'a3f1' }), 'push')).toBe(state);
  });
});

describe('back and forward', () => {
  it('step one view at a time, and stop at either end', () => {
    const state = history([home, usageView({ tab: 'digest' }), sessionsView({ session: 'a3f1' })]);
    const back = stepHistory(state, -1, coreUp);
    expect(currentView(back)).toEqual(usageView({ tab: 'digest' }));
    expect(currentView(stepHistory(back, 1, coreUp))).toEqual(sessionsView({ session: 'a3f1' }));
    expect(stepHistory(state, 1, coreUp)).toBe(state);
    const start = history([home, accounts], 0);
    expect(stepHistory(start, -1, coreUp)).toBe(start);
    expect(stepTarget(start, -1, coreUp)).toBeNull();
    expect(stepTarget(start, 1, coreUp)).toBe(1);
  });

  it('pass over a page that needs the core while it’s down', () => {
    const state = history([home, accounts, machines, modelRoutes, setup]);
    expect(stepTarget(state, -1, coreDown)).toBe(2);
    expect(stepTarget(history(state.entries, 2), -1, coreDown)).toBe(0);
    expect(stepTarget(history(state.entries, 2), 1, coreDown)).toBe(4);
    expect(stepTarget(history([accounts, home]), -1, coreDown)).toBeNull();
    // With the core up, every step opens.
    expect(stepTarget(history(state.entries, 2), -1, coreUp)).toBe(1);
  });

  it('pass over a step that shows what’s already on screen', () => {
    // Accounts is locked, so the only step left behind it would change nothing.
    expect(stepTarget(history([home, accounts, home]), -1, coreDown)).toBeNull();
  });

  it('treat entering and leaving Settings as ordinary steps', () => {
    let state = pushView(pushView(pushView(startHistory(), sessionsView({ session: 'a3f1' })), general), modelRoutes);
    state = pushView(state, sessionsView({ session: 'a3f1' }));
    expect(pages(state)).toEqual(['home', 'sessions', 'settings:general', 'settings:overrides', 'sessions']);
    state = stepHistory(state, -1, coreUp);
    expect(currentView(state)).toEqual(modelRoutes);
    state = stepHistory(stepHistory(state, -1, coreUp), -1, coreUp);
    expect(currentView(state)).toEqual(sessionsView({ session: 'a3f1' }));
  });

  it('come from the mouse’s fourth and fifth buttons', () => {
    expect(mouseStep(3)).toBe(-1);
    expect(mouseStep(4)).toBe(1);
    expect(mouseStep(0)).toBeNull();
    expect(mouseStep(2)).toBeNull();
  });
});

describe('the app’s history', () => {
  afterEach(() => resetViewHistory());

  it('starts on Home, and says whether Back and Forward moved', () => {
    resetViewHistory();
    expect(goBack(coreUp)).toBe(false);
    expect(goToView(accounts)).toBe(true);
    expect(goToView(accounts)).toBe(false);
    expect(changePageView(usageView({ tab: 'events' }))).toBe(false);
    expect(goBack(coreDown)).toBe(true);
    expect(goForward(coreDown)).toBe(false);
    expect(goForward(coreUp)).toBe(true);
  });
});

describe('a page that needs the core, while it’s down', () => {
  it('stays where it is, locked, with no step added or taken away', () => {
    const state = history([home, setup, accounts]);
    // The core stops on Accounts: it stays the current step, shown locked in place rather than swapped for Home.
    expect(lockedInPlace(state, false)).toBe(true);
    expect(currentView(state)).toEqual(accounts);
    // Once the core answers, it opens right there.
    expect(lockedInPlace(state, true)).toBe(false);
    // A page that doesn't need the core never locks.
    expect(lockedInPlace(history([home, accounts, setup]), false)).toBe(false);
    expect(lockedInPlace(history([general]), false)).toBe(false);
    expect(lockedInPlace(history([modelRoutes]), false)).toBe(true);
    // Back leaves it; Forward passes over it while the core is still down, and opens it again once it's back.
    const back = stepHistory(state, -1, coreDown);
    expect(currentView(back)).toEqual(setup);
    expect(stepHistory(back, 1, coreDown)).toBe(back);
    expect(stepHistory(back, 1, coreUp)).toEqual(state);
  });

  it('is returned to from the other side of Settings, but opened afresh only with the core up', () => {
    // A sidebar row, the palette or a page's link: not while the core is down.
    expect(canArrive(accounts, 'open', false)).toBe(false);
    expect(canArrive(modelRoutes, 'open', false)).toBe(false);
    expect(canArrive(accounts, 'open', true)).toBe(true);
    expect(canArrive(setup, 'open', false)).toBe(true);
    // Leaving Settings for Accounts, or opening Settings at Model routes, goes even with the core down, and shows it locked.
    expect(canArrive(accounts, 'return', false)).toBe(true);
    expect(canArrive(modelRoutes, 'return', false)).toBe(true);
    const left = pushView(history([home, accounts, general]), accounts);
    expect(pages(left)).toEqual(['home', 'accounts', 'settings:general', 'accounts']);
    expect(lockedInPlace(left, false)).toBe(true);
    expect(currentView(stepHistory(left, -1, coreDown))).toEqual(general);
  });
});

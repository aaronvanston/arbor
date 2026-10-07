import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { translate } from '../src/i18n';
import type { MessageKey } from '../src/i18n/resources';
import {
  leavesSubmenu,
  paletteActions,
  paletteMatches,
  paletteResults,
  paletteScore,
  parsePaletteQuery,
  parseRecents,
  readRecents,
  rememberRecent,
  typedPaletteQuery,
  withRecent,
  type PaletteEntry,
} from '../src/services/commandPalette';
import { ZOOM_MAX_STEP, ZOOM_MIN_STEP, zoomLevelAt } from '../src/services/zoom';
import { movedSettingsFocus } from '../src/navigation';

const entry = (group: PaletteEntry['group'], label: string, fields: Partial<PaletteEntry> = {}): PaletteEntry => ({
  id: `${group}:${label}`, group, label, ...fields,
});

describe('the search palette', () => {
  it('ranks a label starting with what’s typed first, then a word in it, then anything else it can be found by', () => {
    expect(paletteScore(entry('pages', 'Machines'), 'mach')).toBe(0);
    expect(paletteScore(entry('projects', 'easy-cli-proxy'), 'proxy')).toBe(1);
    expect(paletteScore(entry('projects', 'arbor'), 'rbo')).toBe(2);
    expect(paletteScore(entry('accounts', 'Work Max', { keywords: 'cam@example.com Claude' }), 'example')).toBe(3);
    // Every word has to be somewhere.
    expect(paletteScore(entry('accounts', 'Work Max', { keywords: 'Claude' }), 'work codex')).toBeNull();
    expect(paletteScore(entry('accounts', 'Work Max', { keywords: 'Claude' }), 'WORK claude')).toBe(1);
    // The session search matched it already, on more than its label.
    expect(paletteScore(entry('sessions', 'Fix the login loop', { searched: true }), 'pr 412')).toBe(3);
  });

  it('lists groups in order, best first, a few of each', () => {
    const entries = [
      entry('accounts', 'arbor-bot', { keywords: 'Codex' }),
      entry('sessions', 'Draft release notes', { searched: true }),
      entry('projects', 'tools/arbor'),
      entry('projects', 'arbor'),
      entry('pages', 'Home'),
      ...Array.from({ length: 7 }, (_, index) => entry('machines', `arbor-ci-${index}`)),
    ];
    expect(paletteResults(entries, 'arbor').map((item) => item.id)).toEqual([
      'projects:arbor',
      'projects:tools/arbor',
      'sessions:Draft release notes',
      'machines:arbor-ci-0', 'machines:arbor-ci-1', 'machines:arbor-ci-2', 'machines:arbor-ci-3', 'machines:arbor-ci-4',
      'accounts:arbor-bot',
    ]);
    // Nothing typed: everything offered, in group order.
    expect(paletteResults([entry('sessions', 'Recent'), entry('pages', 'Home')], '').map((item) => item.id)).toEqual(['pages:Home', 'sessions:Recent']);
  });

  it('lists settings after actions, only once something is typed, a few at a time', () => {
    const settings = Array.from({ length: 7 }, (_, index) => entry('settings', `Retry ${index}`, { shown: 'typed', keywords: 'Network Failure Retries' }));
    const entries = [...settings, entry('actions', 'Retry the scan'), entry('pages', 'Network', { shown: 'typed' })];
    expect(paletteResults(entries, '').map((item) => item.group)).toEqual(['actions']);
    expect(paletteResults(entries, 'retry').map((item) => item.id)).toEqual([
      'actions:Retry the scan',
      'settings:Retry 0', 'settings:Retry 1', 'settings:Retry 2', 'settings:Retry 3', 'settings:Retry 4',
    ]);
    // Found by the page it's on, too.
    expect(paletteResults(entries, 'network').map((item) => item.group)).toEqual(['pages', 'settings', 'settings', 'settings', 'settings', 'settings']);
  });
});

/** A stand-in for localStorage. */
describe('the palette’s actions', () => {
  const entries = [
    entry('pages', 'Accounts'),
    entry('pages', 'Settings › Auth Files', { shown: 'typed' }),
    entry('actions', 'Refresh limits', { keywords: 'quota' }),
    entry('actions', 'Pause account…', { keywords: 'disable' }),
    entry('actions', 'Resume account…'),
    entry('actions', 'Appearance: Dark', { keywords: 'theme' }),
    entry('accounts', 'Work account', { shown: 'typed' }),
  ];
  const ids = (list: PaletteEntry[]) => list.map((item) => item.id);

  it('lists only actions after a >, in their own order until something follows it', () => {
    expect(parsePaletteQuery('  > pau ')).toEqual({ actionsOnly: true, text: 'pau' });
    expect(parsePaletteQuery('pause')).toEqual({ actionsOnly: false, text: 'pause' });
    expect(ids(paletteResults(entries, '>'))).toEqual(['actions:Refresh limits', 'actions:Pause account…', 'actions:Resume account…', 'actions:Appearance: Dark']);
    expect(ids(paletteResults(entries, '>dark'))).toEqual(['actions:Appearance: Dark']);
    expect(ids(paletteResults(entries, '> theme'))).toEqual(['actions:Appearance: Dark']);
    expect(ids(paletteResults(entries, '>work'))).toEqual([]);
  });

  it('mixes actions in with the pages and the rest when there’s no >', () => {
    expect(ids(paletteResults(entries, 'acc'))).toEqual(['pages:Accounts', 'actions:Pause account…', 'actions:Resume account…', 'accounts:Work account']);
    // A word in the label outranks one only in the keywords.
    expect(ids(paletteResults([entry('actions', 'Disable nothing'), entry('actions', 'Pause account…', { keywords: 'disable' })], 'disable')))
      .toEqual(['actions:Disable nothing', 'actions:Pause account…']);
    // Nothing typed: what's offered then, in group order; settings pages and accounts wait for a search.
    expect(ids(paletteResults(entries, ''))).toEqual(['pages:Accounts', 'actions:Refresh limits', 'actions:Pause account…', 'actions:Resume account…', 'actions:Appearance: Dark']);
  });

  it('lists every account in a submenu, best match first, and goes back on Backspace in an empty field', () => {
    const accounts = Array.from({ length: 7 }, (_, index) => entry('accounts', `acct-${index}`, { keywords: index === 6 ? 'work' : '' }));
    expect(paletteMatches(accounts, '')).toHaveLength(7);
    expect(ids(paletteMatches(accounts, 'work'))).toEqual(['accounts:acct-6']);
    expect(ids(paletteMatches([entry('accounts', 'my work'), entry('accounts', 'work')], 'work'))).toEqual(['accounts:work', 'accounts:my work']);
    expect(leavesSubmenu('Backspace', '', true)).toBe(true);
    expect(leavesSubmenu('Backspace', 'w', true)).toBe(false);
    expect(leavesSubmenu('Backspace', '', false)).toBe(false);
    expect(leavesSubmenu('Delete', '', true)).toBe(false);
    // Escape goes back one list whatever's typed, and at the palette's own list it's left to close the palette.
    expect(leavesSubmenu('Escape', 'wor', true)).toBe(true);
    expect(leavesSubmenu('Escape', '', false)).toBe(false);
  });

  it('opens from the sidebar’s search row with what was typed there', () => {
    const key = (value: string, modifiers: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey', boolean>> = {}) =>
      typedPaletteQuery({ key: value, metaKey: false, ctrlKey: false, altKey: false, ...modifiers });
    expect(key('c')).toBe('c');
    expect(key('C')).toBe('C');
    expect(key('3')).toBe('3');
    // Enter and Space click the row, opening it empty; arrows, Tab and shortcuts do what they always do.
    for (const other of ['Enter', ' ', 'Tab', 'ArrowDown', 'Escape']) expect(key(other)).toBeNull();
    expect(key('k', { metaKey: true })).toBeNull();
    expect(key('b', { ctrlKey: true })).toBeNull();
    expect(key('a', { altKey: true })).toBeNull();
  });

  it('offers Start or Stop and Restart by the core’s state, and says why the rest can’t run', () => {
    const history = { back: true, forward: true };
    const offered = (context: Omit<Parameters<typeof paletteActions>[0], 'history' | 'sidebarShown' | 'zoom'>) =>
      Object.fromEntries(paletteActions({ history, sidebarShown: true, zoom: zoomLevelAt(0), ...context }).map((action) => [action.id, action.unavailable]));
    const stopped = offered({ core: { installed: true, running: false, ready: false, busy: false }, accounts: 0, paused: 0 });
    expect(Object.keys(stopped)).toEqual([
      'refresh-limits', 'start-core', 'pause-account', 'resume-account', 'copy-base-url', 'copy-api-key', 'scan-setup', 'toggle-sidebar', 'theme-light', 'theme-dark', 'theme-system',
      'zoom-in', 'zoom-out', 'actual-size', 'go-back', 'go-forward',
    ]);
    expect(stopped).toMatchObject({ 'refresh-limits': 'app.coreRequired.title', 'start-core': null, 'pause-account': 'app.coreRequired.title', 'copy-api-key': null, 'scan-setup': null });
    const running = offered({ core: { installed: true, running: true, ready: true, busy: false }, accounts: 3, paused: 0 });
    expect(running).toMatchObject({ 'refresh-limits': null, 'restart-core': null, 'stop-core': null, 'pause-account': null, 'resume-account': 'palette.unavailable.nonePaused' });
    expect('start-core' in running).toBe(false);
    expect(offered({ core: { installed: true, running: true, ready: false, busy: true }, accounts: 3, paused: 1 }))
      .toMatchObject({ 'stop-core': 'palette.unavailable.coreBusy', 'pause-account': 'kernel.access.waiting' });
    expect(offered({ core: { installed: false, running: false, ready: false, busy: false }, accounts: 0, paused: 0 })['start-core']).toBe('palette.unavailable.coreMissing');
    expect(offered({ core: null, accounts: 0, paused: 0 })['start-core']).toBe('palette.unavailable.coreBusy');
    expect(offered({ core: { installed: true, running: true, ready: true, busy: false }, accounts: 0, paused: 2 }))
      .toMatchObject({ 'refresh-limits': 'palette.unavailable.noAccounts', 'resume-account': null });
  });

  it('offers Go back and Go forward, grayed out when there’s nowhere to go', () => {
    const offered = (history: { back: boolean; forward: boolean }) =>
      Object.fromEntries(paletteActions({ core: null, accounts: 0, paused: 0, history, sidebarShown: true, zoom: zoomLevelAt(0) }).map((action) => [action.id, action.unavailable]));
    expect(offered({ back: true, forward: false })).toMatchObject({ 'go-back': null, 'go-forward': 'palette.unavailable.noForward' });
    expect(offered({ back: false, forward: true })).toMatchObject({ 'go-back': 'palette.unavailable.noBack', 'go-forward': null });
  });

  it('offers Hide sidebar or Show sidebar as it is now, under one id, so a recent pick of it still finds it', () => {
    const sidebar = (sidebarShown: boolean) =>
      paletteActions({ core: null, accounts: 0, paused: 0, history: { back: false, forward: false }, sidebarShown, zoom: zoomLevelAt(0) }).find((action) => action.id === 'toggle-sidebar');
    expect(sidebar(true)).toEqual({ id: 'toggle-sidebar', unavailable: null, label: 'app.sidebar.hide' });
    expect(sidebar(false)).toEqual({ id: 'toggle-sidebar', unavailable: null, label: 'app.sidebar.show' });
  });

  it('offers Zoom in, Zoom out and Actual size, each grayed out where it has nowhere to go', () => {
    const offered = (step: number) =>
      Object.fromEntries(paletteActions({ core: null, accounts: 0, paused: 0, history: { back: false, forward: false }, sidebarShown: true, zoom: zoomLevelAt(step) })
        .filter((action) => action.id.startsWith('zoom') || action.id === 'actual-size')
        .map((action) => [action.id, action.unavailable]));
    expect(offered(0)).toEqual({ 'zoom-in': null, 'zoom-out': null, 'actual-size': 'zoom.atActualSize' });
    expect(offered(ZOOM_MAX_STEP)).toEqual({ 'zoom-in': 'zoom.atLargest', 'zoom-out': null, 'actual-size': null });
    expect(offered(ZOOM_MIN_STEP)).toEqual({ 'zoom-in': null, 'zoom-out': 'zoom.atSmallest', 'actual-size': null });
    // A level previewed off the steps still goes back to actual size.
    const previewed = paletteActions({ core: null, accounts: 0, paused: 0, history: { back: false, forward: false }, sidebarShown: true, zoom: { step: 0, factor: 1.04 } });
    expect(previewed.find((action) => action.id === 'actual-size')?.unavailable).toBeNull();
  });

  it('finds Actual size by “reset zoom”, as other apps name it, and not the steps beside it', () => {
    const source = readFileSync(new URL('../src/components/CommandPaletteActions.tsx', import.meta.url), 'utf8');
    const t = (key: string) => translate(key as MessageKey);
    // Each action as the palette lists it, in the words CommandPaletteActions gives it.
    const listed = (['zoom-in', 'zoom-out', 'actual-size'] as const).map((id) => {
      const [, label = '', keywords = ''] = source.match(new RegExp(`'${id}': \\{ label: '([\\w.]+)', icon: \\w+, keywords: '([\\w.]+)'`)) ?? [];
      return entry('actions', t(label), { keywords: t(keywords) });
    });
    expect(listed.map((action) => action.label)).toEqual(['Zoom in', 'Zoom out', 'Actual size']);
    expect(paletteMatches(listed, 'reset zoom').map((action) => action.label)).toEqual(['Actual size']);
    expect(paletteMatches(listed, 'zoom').map((action) => action.label)).toEqual(['Zoom in', 'Zoom out', 'Actual size']);
  });
});

describe('the palette’s recent picks', () => {
  it('keep the last five, newest first, each once', () => {
    expect(withRecent(['b', 'a'], 'a')).toEqual(['a', 'b']);
    expect(withRecent(['1', '2', '3', '4', '5'], '6')).toEqual(['6', '1', '2', '3', '4']);
  });

  it('are saved as ids only, keeping only the ids of what was saved', () => {
    expect(readRecents()).toEqual([]);
    rememberRecent('page:main:home');
    // A pick from the Recent section is remembered as what it was copied from.
    expect(rememberRecent('recent:action:scan-setup')).toEqual(['action:scan-setup', 'page:main:home']);
    expect(readRecents()).toEqual(['action:scan-setup', 'page:main:home']);
    expect(parseRecents('{"a":1}')).toEqual([]);
    expect(parseRecents('["a", 3, "b"]')).toEqual(['a', 'b']);
    expect(parseRecents(null)).toEqual([]);
  });

  it('follow a Settings page that moved, listing two picks that became one page once', () => {
    expect(parseRecents(JSON.stringify(['page:settings:interface', 'page:main:setup', 'page:settings:network', 'page:settings:general', 'page:settings:gone']))).toEqual(['page:settings:notifications', 'page:main:setup', 'page:settings:general', 'page:settings:gone']);
  });

  // system-13: Phone Alerts' old id lands on the phone section of Notifications, not the top of it.
  it('brings Phone Alerts back as the phone section it was named for', () => {
    expect(parseRecents(JSON.stringify(['page:settings:phone-alerts']))).toEqual(['setting:notifications.phone-service']);
    expect(movedSettingsFocus('phone-alerts')).toBe('notifications.phone-service');
    expect(movedSettingsFocus('interface')).toBeNull();
  });

  it('follow a setting whose row moved page with it', () => {
    expect(parseRecents(JSON.stringify(['setting:network.port', 'page:settings:network', 'setting:general.debug']))).toEqual(['setting:general.port', 'page:settings:general', 'setting:general.debug']);
  });

  it('follow a Settings page that left Settings for a main page', () => {
    expect(parseRecents(JSON.stringify(['page:settings:pricing']))).toEqual(['page:main:usage:prices']);
  });

  it('come first when nothing is typed, as they are now, skipping any that are gone', () => {
    const entries = [
      entry('pages', 'Home'),
      entry('pages', 'Accounts', { shown: 'typed' }),
      entry('actions', 'Scan setup'),
      entry('sessions', 'Old session', { shown: 'recentOnly' }),
      entry('sessions', 'Latest session', { shown: 'idle' }),
    ];
    const results = paletteResults(entries, '', ['sessions:Old session', 'gone:thing', 'pages:Accounts', 'actions:Scan setup']);
    expect(results.map((item) => `${item.group} ${item.id}`)).toEqual([
      'recent recent:sessions:Old session',
      'recent recent:pages:Accounts',
      'recent recent:actions:Scan setup',
      'pages pages:Home',
      'actions actions:Scan setup',
      'sessions sessions:Latest session',
    ]);
    // Once something is typed they give way to the search, and a recent-only row stays out of it.
    expect(paletteResults(entries, 'session', ['sessions:Old session']).map((item) => item.id)).toEqual([]);
  });
});

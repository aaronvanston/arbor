import { afterEach, describe, expect, it } from 'bun:test';
import {
  SHORTCUTS,
  dispatchShortcut,
  focusSearchField,
  formatKeys,
  isOverlayTarget,
  isTypingTarget,
  matchesKeys,
  matchesShortcut,
  modifierHeldAfter,
  registerShortcut,
  type ShortcutEvent,
} from '../src/services/shortcuts';

type Target = { tagName?: string; type?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown };
const body: Target = { tagName: 'BODY', closest: () => null };
const field: Target = { tagName: 'INPUT', type: 'search', closest: () => null };
const inDialog: Target = { tagName: 'BUTTON', closest: (selector) => (selector.includes('dialog') ? {} : null) };

/** A key press as the window sees it, with a record of whether its default was prevented. */
function press(key: string, init: Partial<Omit<ShortcutEvent, 'target'>> & { target?: Target } = {}) {
  const event = {
    key,
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    prevented: false,
    ...init,
    target: (init.target ?? body) as unknown as EventTarget,
    preventDefault() {
      event.prevented = true;
    },
  };
  return event;
}
const cmd = (key: string, init: Parameters<typeof press>[1] = {}) => press(key, { metaKey: true, ...init });

const removals: (() => void)[] = [];
const handle = (...args: Parameters<typeof registerShortcut>) => {
  const remove = registerShortcut(...args);
  removals.push(remove);
  return remove;
};
afterEach(() => removals.splice(0).forEach((remove) => remove()));

describe('keyboard shortcuts', () => {
  it('match ⌘ on a Mac and Ctrl elsewhere, and number the main pages in the sidebar tree’s order, Alerts last', () => {
    expect(matchesShortcut(cmd('k'), 'palette.toggle', true)).toBe(true);
    expect(matchesShortcut(cmd('k'), 'palette.toggle', false)).toBe(false);
    expect(matchesShortcut(press('k', { ctrlKey: true }), 'palette.toggle', false)).toBe(true);
    expect(matchesShortcut(press('k', { ctrlKey: true }), 'palette.toggle', true)).toBe(false);
    // Extra modifiers make it another shortcut.
    expect(matchesShortcut(cmd('k', { shiftKey: true }), 'palette.toggle', true)).toBe(false);
    expect(SHORTCUTS.filter((shortcut) => shortcut.id.startsWith('go.')).map((shortcut) => `${shortcut.id} ${shortcut.keys}`)).toEqual([
      'go.home mod+1', 'go.machines mod+2', 'go.pools mod+3', 'go.sessions mod+4', 'go.automations mod+5', 'go.setup mod+6',
      'go.accounts mod+7', 'go.usage mod+8', 'go.alerts mod+9',
    ]);
  });

  it('fall back on the physical key for a symbol or digit when a modifier changes the character', () => {
    expect(matchesKeys(cmd('¡', { code: 'Digit1' }), 'mod+1', true)).toBe(true);
    expect(matchesKeys(cmd('<', { code: 'Comma' }), 'mod+,', true)).toBe(true);
    // A layout that types a letter there means that letter.
    expect(matchesKeys(cmd('q', { code: 'BracketLeft' }), 'mod+[', true)).toBe(false);
    // Unmodified, what was typed counts: Shift-/ is a question mark, but Shift-7 typing a slash is a slash.
    expect(matchesKeys(press('?', { code: 'Slash', shiftKey: true }), '/', true)).toBe(false);
    expect(matchesKeys(press('/', { code: 'Digit7', shiftKey: true }), '/', true)).toBe(true);
    expect(matchesKeys(press('Escape'), 'escape', true)).toBe(true);
    expect(matchesKeys(press('Escape', { shiftKey: true }), 'escape', true)).toBe(false);
  });

  it('write the keys the platform’s way', () => {
    const names = { escape: 'Esc', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' };
    expect(['mod+k', 'mod+,', 'mod+1', 'escape', '/', 'mod+shift+b'].map((keys) => formatKeys(keys, names, true))).toEqual(['⌘K', '⌘,', '⌘1', 'Esc', '/', '⇧⌘B']);
    expect(['mod+k', 'mod+[', 'mod+shift+b'].map((keys) => formatKeys(keys, names, false))).toEqual(['Ctrl+K', 'Ctrl+[', 'Ctrl+Shift+B']);
  });

  it('route a press to the newest handler, and back to the one before once it goes', () => {
    const calls: string[] = [];
    handle('page.refresh', () => void calls.push('list'));
    const removeDetail = handle('page.refresh', () => void calls.push('detail'));
    expect(dispatchShortcut(cmd('r'), true)).toBe('page.refresh');
    removeDetail();
    expect(dispatchShortcut(cmd('r'), true)).toBe('page.refresh');
    expect(calls).toEqual(['detail', 'list']);
  });

  it('take a handler for a reserved shortcut registered later, without a change here', () => {
    expect(dispatchShortcut(cmd('['), true)).toBeNull();
    expect(dispatchShortcut(cmd('b'), true)).toBeNull();
    let back = 0;
    handle('history.back', () => void (back += 1));
    const event = cmd('[');
    expect(dispatchShortcut(event, true)).toBe('history.back');
    expect(event.prevented).toBe(true);
    expect(back).toBe(1);
  });

  it('leave typing alone: a plain key in a text field is text, while ⌘ chords and Escape still reach a handler', () => {
    const seen: string[] = [];
    for (const id of ['page.search', 'go.home', 'page.refresh', 'settings.leave', 'palette.toggle'] as const) handle(id, () => void seen.push(id));
    expect(dispatchShortcut(press('/', { target: field }), true)).toBeNull();
    expect(dispatchShortcut(press('/', { target: { tagName: 'TEXTAREA', closest: () => null } }), true)).toBeNull();
    expect(dispatchShortcut(press('/', { target: { tagName: 'DIV', isContentEditable: true, closest: () => null } }), true)).toBeNull();
    // A chord types nothing, so it works from a search field as it would anywhere else.
    expect(dispatchShortcut(cmd('1', { target: field }), true)).toBe('go.home');
    expect(dispatchShortcut(cmd('r', { target: field }), true)).toBe('page.refresh');
    expect(dispatchShortcut(press('Escape', { target: field }), true)).toBe('settings.leave');
    expect(dispatchShortcut(cmd('k', { target: field }), true)).toBe('palette.toggle');
    // A checkbox or a button isn't typing.
    expect(dispatchShortcut(press('/', { target: { tagName: 'INPUT', type: 'checkbox', closest: () => null } }), true)).toBe('page.search');
    expect(seen).toEqual(['go.home', 'page.refresh', 'settings.leave', 'palette.toggle', 'page.search']);
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('offer a key two shortcuts share to each in turn, so / searches Settings there and the page everywhere else', () => {
    const seen: string[] = [];
    handle('page.search', () => void seen.push('page'));
    expect(dispatchShortcut(press('/'), true)).toBe('page.search');
    const removeSettings = handle('settings.search', () => void seen.push('settings'));
    expect(dispatchShortcut(press('/'), true)).toBe('settings.search');
    // A handler that passes lets the next shortcut have it.
    removeSettings();
    handle('settings.search', () => false);
    expect(dispatchShortcut(press('/'), true)).toBe('page.search');
    // Typed into a field, it's still text for both.
    expect(dispatchShortcut(press('/', { target: field }), true)).toBeNull();
    expect(seen).toEqual(['page', 'settings', 'page']);
  });

  it('focus a search field only when it’s on screen, so / passes a hidden Settings search on to the page’s', () => {
    const seen: string[] = [];
    const searchField = (shown: boolean, name: string, disabled = false) => ({
      offsetParent: shown ? {} : null,
      disabled,
      focus: () => void seen.push(`focus ${name}`),
      select: () => void seen.push(`select ${name}`),
    });
    expect(focusSearchField(searchField(true, 'settings'))).toBe(true);
    expect(focusSearchField(searchField(false, 'settings'))).toBe(false);
    expect(focusSearchField(searchField(true, 'settings', true))).toBe(false);
    expect(focusSearchField(null)).toBe(false);
    expect(seen).toEqual(['focus settings', 'select settings']);
    seen.length = 0;
    // The sidebar hidden with ⌘B, or by a narrow window: its search is still mounted, but out of sight.
    const sidebar = searchField(false, 'settings');
    handle('page.search', () => focusSearchField(searchField(true, 'auth files')));
    handle('settings.search', () => focusSearchField(sidebar));
    const slash = press('/');
    expect(dispatchShortcut(slash, true)).toBe('page.search');
    expect(slash.prevented).toBe(true);
    expect(seen).toEqual(['focus auth files', 'select auth files']);
    // Shown again, it has `/` first.
    sidebar.offsetParent = {};
    expect(dispatchShortcut(press('/'), true)).toBe('settings.search');
  });

  it('never reach past a dialog or menu, or take a press something else handled', () => {
    let calls = 0;
    handle('settings.leave', () => void (calls += 1));
    handle('palette.toggle', () => void (calls += 1));
    expect(dispatchShortcut(press('Escape', { target: inDialog }), true)).toBeNull();
    expect(dispatchShortcut(cmd('k', { target: inDialog }), true)).toBeNull();
    expect(dispatchShortcut(press('Escape', { defaultPrevented: true }), true)).toBeNull();
    expect(dispatchShortcut(press('Escape', { isComposing: true }), true)).toBeNull();
    expect(dispatchShortcut(cmd('k', { repeat: true }), true)).toBeNull();
    expect(calls).toBe(0);
  });

  it('count the space around an open dialog as the dialog, so the mouse’s back button there leaves the page alone', () => {
    // Beside the popup, a press lands on the viewport or backdrop the dialog lays over the whole window.
    const inside = (slot: string): Target => ({ tagName: 'DIV', closest: (selector) => (selector.split(', ').includes(`[data-slot="${slot}"]`) ? {} : null) });
    expect(isOverlayTarget(inside('dialog-viewport') as unknown as EventTarget)).toBe(true);
    expect(isOverlayTarget(inside('dialog-backdrop') as unknown as EventTarget)).toBe(true);
    expect(isOverlayTarget(inside('dialog-popup') as unknown as EventTarget)).toBe(true);
    expect(isOverlayTarget(inside('sidebar') as unknown as EventTarget)).toBe(false);
    expect(isOverlayTarget(body as unknown as EventTarget)).toBe(false);
  });

  it('keep ⌘R from reloading the app even where no page handles it', () => {
    const event = cmd('r');
    expect(dispatchShortcut(event, true)).toBeNull();
    expect(event.prevented).toBe(true);
    // Held down, mid-composition, or inside a dialog, it still never reloads.
    for (const init of [{ repeat: true }, { isComposing: true }, { target: inDialog }]) {
      const pressed = cmd('r', init);
      expect(dispatchShortcut(pressed, true)).toBeNull();
      expect(pressed.prevented).toBe(true);
    }
    // A handler that passes leaves the key's usual meaning alone.
    handle('page.search', () => false);
    const slash = press('/');
    expect(dispatchShortcut(slash, true)).toBeNull();
    expect(slash.prevented).toBe(false);
  });

  it('count ⌘ as held from its own press to its release, and never from another key’s flags', () => {
    const key = (type: string, name: string, metaKey = false) => ({ type, key: name, metaKey, ctrlKey: false });
    expect(modifierHeldAfter(false, key('keydown', 'Meta', true), true)).toBe(true);
    expect(modifierHeldAfter(true, key('keydown', '1', true), true)).toBe(true);
    expect(modifierHeldAfter(true, key('keyup', 'Meta'), true)).toBe(false);
    // A dictation tool's paste can leave metaKey set on later presses.
    expect(modifierHeldAfter(false, key('keydown', 'Enter', true), true)).toBe(false);
    expect(modifierHeldAfter(true, key('keydown', 'a'), true)).toBe(false);
    expect(modifierHeldAfter(false, { type: 'keydown', key: 'Control', metaKey: false, ctrlKey: true }, false)).toBe(true);
  });
});

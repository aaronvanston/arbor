import type { MessageKey } from '../i18n/resources';
import { mainPageIds, type MainPageId } from '../navigation';

/**
 * The app's keyboard shortcuts. Each one is defined here once, with its keys and what it does; whoever owns the
 * action registers a handler for it while it can run (a page for ⌘R, the shell for ⌘1–⌘8). One listener on the
 * window hands each key press to the newest handler for the shortcut it matches.
 */
export type ShortcutId =
  | 'palette.toggle'
  | 'settings.open'
  | 'settings.leave'
  | 'page.refresh'
  | 'settings.search'
  | 'page.search'
  | `go.${MainPageId}`
  | 'history.back'
  | 'history.forward'
  | 'sidebar.toggle';

export type ShortcutDefinition = {
  id: ShortcutId;
  /** `mod` is ⌘ on a Mac and Ctrl elsewhere, then `shift`, `alt`, and the key: `mod+k`, `mod+,`, `escape`, `/`. */
  keys: string;
  label: MessageKey;
  /**
   * Stops the webview's own use of these keys even when nothing handles them here, as ⌘R would otherwise reload
   * the whole app.
   */
  claimed?: boolean;
};

const PAGE_LABELS: Record<MainPageId, MessageKey> = {
  home: 'app.nav.home',
  accounts: 'app.nav.accounts',
  usage: 'app.nav.usageRecords',
  sessions: 'app.nav.sessions',
  machines: 'app.nav.machines',
  pools: 'app.nav.pools',
  automations: 'app.nav.automations',
  setup: 'app.nav.setup',
  alerts: 'app.nav.alerts',
};

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  { id: 'palette.toggle', keys: 'mod+k', label: 'shortcuts.palette' },
  { id: 'settings.open', keys: 'mod+,', label: 'shortcuts.settings' },
  { id: 'settings.leave', keys: 'escape', label: 'shortcuts.leaveSettings' },
  { id: 'page.refresh', keys: 'mod+r', label: 'shortcuts.refresh', claimed: true },
  // Ahead of the page's own search, which `/` reaches outside Settings, where nothing handles this one, and in Settings
  // with the sidebar hidden, where this one passes.
  { id: 'settings.search', keys: '/', label: 'shortcuts.settingsSearch' },
  { id: 'page.search', keys: '/', label: 'shortcuts.search' },
  // In the sidebar tree's order (Home, Machines, Pools, Sessions, Automations, Sync, Accounts, Usage), then Alerts, the footer's bell.
  ...mainPageIds.map((page, index): ShortcutDefinition => ({ id: `go.${page}`, keys: `mod+${index + 1}`, label: PAGE_LABELS[page] })),
  { id: 'history.back', keys: 'mod+[', label: 'shortcuts.back' },
  { id: 'history.forward', keys: 'mod+]', label: 'shortcuts.forward' },
  { id: 'sidebar.toggle', keys: 'mod+b', label: 'shortcuts.sidebar' },
];

export const shortcutDefinition = (id: ShortcutId) => SHORTCUTS.find((shortcut) => shortcut.id === id);

type Combo = { key: string; mod: boolean; shift: boolean; alt: boolean };

export function parseKeys(keys: string): Combo {
  const parts = keys.toLowerCase().split('+');
  // `mod++` would name the plus key; none of ours do, so the last part is always the key.
  const key = parts.pop() ?? '';
  return { key, mod: parts.includes('mod'), shift: parts.includes('shift'), alt: parts.includes('alt') };
}

export const isMacPlatform = (platform = typeof navigator === 'undefined' ? '' : navigator.platform) =>
  /mac|iphone|ipad|ipod/i.test(platform);

/** What a key press needs to be matched and routed, as a DOM `KeyboardEvent` has it. */
export type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing' | 'defaultPrevented' | 'preventDefault'> & {
  target: EventTarget | null;
};

// With ⌘ or Option held, some layouts report another character in `key`; the physical key still says which it was.
const CODE_KEYS: Record<string, string> = {
  Comma: ',', Slash: '/', BracketLeft: '[', BracketRight: ']',
  Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9', Digit0: '0',
};

function eventKeys(event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey'>) {
  const key = event.key.toLowerCase();
  const keys = new Set([key === 'esc' ? 'escape' : key]);
  const physical = CODE_KEYS[event.code];
  // Only with a modifier held: unmodified, `key` is what was typed (Shift-/ is `?`, not a slash). And a layout
  // that types a letter there means that letter; the position only stands in for a symbol or digit.
  const modified = event.metaKey || event.ctrlKey || event.altKey;
  if (physical && modified && !/^[a-z]$/.test(key)) keys.add(physical);
  return keys;
}

export function matchesKeys(event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, keys: string, mac = isMacPlatform()) {
  const combo = parseKeys(keys);
  const meta = combo.mod && mac;
  const ctrl = combo.mod && !mac;
  if (event.metaKey !== meta || event.ctrlKey !== ctrl || event.altKey !== combo.alt) return false;
  // A symbol can take Shift on some layouts (`/` is Shift-7 on a German keyboard), so only letters and named keys check it.
  const symbol = combo.key.length === 1 && !/[a-z0-9]/.test(combo.key);
  if (!symbol && event.shiftKey !== combo.shift) return false;
  return eventKeys(event).has(combo.key);
}

export const matchesShortcut = (event: Parameters<typeof matchesKeys>[0], id: ShortcutId, mac = isMacPlatform()) => {
  const definition = shortcutDefinition(id);
  return definition ? matchesKeys(event, definition.keys, mac) : false;
};

type TargetLike = { tagName?: string; type?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown };
const NOT_TYPED = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

/** A field that takes typing, where a plain key press is text and not a shortcut. */
export function isTypingTarget(target: EventTarget | null) {
  const element = target as TargetLike | null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && !NOT_TYPED.has((element.type ?? 'text').toLowerCase());
}

/**
 * Dialogs, menus and pickers handle their own keys, and a shortcut shouldn't reach the page behind them. A dialog
 * also lays its backdrop and viewport over the whole window, so a mouse button pressed beside it lands on those.
 */
const OVERLAY = [
  '[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', '[role="listbox"]',
  '[data-slot="dialog-popup"]', '[data-slot="dialog-viewport"]', '[data-slot="dialog-backdrop"]',
].join(', ');
export const isOverlayTarget = (target: EventTarget | null) => Boolean((target as TargetLike | null)?.closest?.(OVERLAY));

/**
 * Whether a shortcut works while typing in a field. A chord with ⌘ (Ctrl elsewhere) types nothing, so ⌘2 still
 * opens Accounts from the Sessions search; a plain key like `/` is text there. Escape
 * reaches its handler, which lets go of the field before doing anything else.
 */
const worksWhileTyping = (definition: ShortcutDefinition) => definition.keys === 'escape' || parseKeys(definition.keys).mod;

type SearchFieldLike = { offsetParent: unknown; disabled?: boolean; focus: () => void; select?: () => void };

/**
 * Focuses a search field and selects what's typed in it, when it's on screen. One in a hidden sidebar (⌘B, or a
 * window too narrow for it) is still mounted but can't take focus. Returns whether it did, so a `/` handler passes the
 * key on to the next search rather than swallowing it.
 */
export function focusSearchField(field: SearchFieldLike | null | undefined): boolean {
  if (!field || field.offsetParent === null || field.disabled) return false;
  field.focus();
  field.select?.();
  return true;
}

/** Returns `false` when it didn't handle the press, so the key keeps its usual meaning. */
export type ShortcutHandler = (event: ShortcutEvent) => boolean | void;

const handlers = new Map<ShortcutId, ShortcutHandler[]>();

/**
 * Adds a handler for a shortcut until the returned function removes it. The newest handler wins, so a view that
 * opens over another (a session over the Sessions list) takes the shortcut back when it closes.
 */
export function registerShortcut(id: ShortcutId, handler: ShortcutHandler): () => void {
  handlers.set(id, [...(handlers.get(id) ?? []), handler]);
  return () => {
    const rest = (handlers.get(id) ?? []).filter((item) => item !== handler);
    if (rest.length) handlers.set(id, rest);
    else handlers.delete(id);
  };
}

/**
 * Routes one key press. Returns the shortcut that handled it, if one did. Shortcuts that share keys are offered it in
 * the order they're listed, and the first with a handler that takes it wins: `/` is Settings search in Settings (the
 * page's own search when the sidebar is hidden) and the page's own search everywhere else.
 */
export function dispatchShortcut(event: ShortcutEvent, mac = isMacPlatform()): ShortcutId | null {
  if (event.defaultPrevented) return null;
  const definitions = SHORTCUTS.filter((shortcut) => matchesKeys(event, shortcut.keys, mac));
  if (!definitions.length) return null;
  // Before anything can pass on the press, so ⌘R held down or pressed mid-composition still never reloads.
  if (definitions.some((definition) => definition.claimed)) event.preventDefault();
  if (event.isComposing || event.repeat) return null;
  if (isOverlayTarget(event.target)) return null;
  for (const definition of definitions) {
    if (isTypingTarget(event.target) && !worksWhileTyping(definition)) continue;
    const registered = handlers.get(definition.id) ?? [];
    const handler = registered[registered.length - 1];
    if (!handler || handler(event) === false) continue;
    event.preventDefault();
    return definition.id;
  }
  return null;
}

export type KeyNames = { escape: string; ctrl: string; alt: string; shift: string };

/** How the keys read on this platform: `⌘K` and `⇧⌘B` on a Mac, `Ctrl+K` and `Ctrl+Shift+B` elsewhere. */
export function formatKeys(keys: string, names: KeyNames, mac = isMacPlatform()) {
  const combo = parseKeys(keys);
  const key = combo.key === 'escape' ? names.escape : combo.key.toUpperCase();
  if (mac) return `${combo.alt ? '⌥' : ''}${combo.shift ? '⇧' : ''}${combo.mod ? '⌘' : ''}${key}`;
  return [combo.mod ? names.ctrl : '', combo.alt ? names.alt : '', combo.shift ? names.shift : '', key].filter(Boolean).join('+');
}

/** The key that shows the page-number hints while it's held: ⌘ on a Mac, Ctrl elsewhere. */
const HOLD_KEYS = { mac: new Set(['Meta', 'OS', 'Command']), other: new Set(['Control']) };

/**
 * Whether ⌘ (Ctrl elsewhere) is held after this key event. Only a press or release of that key itself changes it
 * to held; any other key can only clear it, because the flags on a synthetic press (a dictation tool's paste) can
 * claim ⌘ is down long after it was let go.
 */
export function modifierHeldAfter(held: boolean, event: Pick<KeyboardEvent, 'type' | 'key' | 'metaKey' | 'ctrlKey'>, mac = isMacPlatform()) {
  if ((mac ? HOLD_KEYS.mac : HOLD_KEYS.other).has(event.key)) return event.type === 'keydown';
  return held && (mac ? event.metaKey : event.ctrlKey);
}

export const isModifierKey = (key: string) => ['Meta', 'OS', 'Command', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn'].includes(key);

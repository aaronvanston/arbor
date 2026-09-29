import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import {
  dispatchShortcut,
  formatKeys,
  isModifierKey,
  isMacPlatform,
  modifierHeldAfter,
  registerShortcut,
  shortcutDefinition,
  type ShortcutHandler,
  type ShortcutId,
} from '../services/shortcuts';

/** Handles a shortcut while the component is mounted and `enabled`. The newest handler for a shortcut wins. */
export function useShortcut(id: ShortcutId, handler: ShortcutHandler, enabled = true) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!enabled) return undefined;
    return registerShortcut(id, (event) => handlerRef.current(event));
  }, [id, enabled]);
}

/** The one key listener that routes presses to the registered handlers. The shell mounts it once. */
export function useShortcutListener() {
  useEffect(() => {
    // Bubbling, so a dialog or menu that handles Escape (and prevents its default) gets it first.
    const onKeyDown = (event: KeyboardEvent) => void dispatchShortcut(event);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** How a shortcut's keys read on this platform, like `⌘1` or `Ctrl+1`. */
export function useShortcutKeys(id: ShortcutId) {
  const { t } = useI18n();
  const definition = shortcutDefinition(id);
  if (!definition) return '';
  return formatKeys(definition.keys, {
    escape: t('shortcuts.key.escape'),
    ctrl: t('shortcuts.key.ctrl'),
    alt: t('shortcuts.key.alt'),
    shift: t('shortcuts.key.shift'),
  });
}

/** How long ⌘ has to be held before the sidebar shows which number opens which page. */
const MODIFIER_HINT_DELAY_MS = 500;

/**
 * True once ⌘ (Ctrl elsewhere) has been held on its own for a moment. Pressing a shortcut before then keeps the
 * hints hidden, so someone who knows the keys never sees them flash.
 */
export function useModifierHold(delayMs = MODIFIER_HINT_DELAY_MS) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const mac = isMacPlatform();
    let held = false;
    let timer: number | undefined;
    const cancel = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const reset = () => {
      held = false;
      cancel();
      setShown(false);
    };
    const onKey = (event: KeyboardEvent) => {
      const next = modifierHeldAfter(held, event, mac);
      if (!next) {
        reset();
        return;
      }
      if (!held) timer = window.setTimeout(() => setShown(true), delayMs);
      else if (event.type === 'keydown' && !isModifierKey(event.key)) cancel();
      held = true;
    };
    const onVisibility = () => {
      if (document.hidden) reset();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    // Switching apps with ⌘-Tab never delivers the key's release, and a paste can report ⌘ long after it's up.
    window.addEventListener('blur', reset);
    window.addEventListener('paste', reset, true);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancel();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', reset);
      window.removeEventListener('paste', reset, true);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [delayMs]);
  return shown;
}

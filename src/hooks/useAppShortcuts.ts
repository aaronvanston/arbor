import { useEffect, useRef } from 'react';
import { mainPageIds, mainView, type AppView } from '../navigation';
import { focusSearchField, isOverlayTarget, isTypingTarget, registerShortcut } from '../services/shortcuts';
import { hasUnsavedChanges, settingsEscape } from '../services/unsavedChanges';
import { mouseStep } from '../services/viewHistory';
import { useShortcut, useShortcutListener } from './useShortcuts';

/** Focuses the open page's own search field, the first one on screen marked `data-page-search`. */
const focusPageSearch = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('main [data-page-search]')).some((field) => focusSearchField(field));

/**
 * The shell's shortcuts: search, Settings, the main pages in the sidebar tree's order, `/` for the page's search, ⌘B
 * for the sidebar, and Back and Forward on ⌘[ and ⌘] and the mouse's back and forward buttons.
 */
export function useAppShortcuts({ inSettings, navigate, openSettings, leaveSettings, togglePalette, toggleSidebar, goBack, goForward }: {
  inSettings: boolean;
  navigate: (view: AppView) => void;
  openSettings: () => void;
  leaveSettings: () => void;
  togglePalette: () => void;
  toggleSidebar: () => void;
  /** Each returns whether it went anywhere. */
  goBack: () => boolean;
  goForward: () => boolean;
}) {
  useShortcutListener();
  useShortcut('palette.toggle', togglePalette);
  useShortcut('settings.open', openSettings, !inSettings);
  useShortcut('settings.leave', (event) => {
    // Leaving unmounts the page with any edits not saved yet, so Esc lets go of a field first and then waits for them.
    const step = settingsEscape(isTypingTarget(event.target), hasUnsavedChanges());
    if (step === 'blur' && event.target instanceof HTMLElement) event.target.blur();
    if (step === 'leave') leaveSettings();
    return step !== 'stay';
  }, inSettings);
  useShortcut('page.search', focusPageSearch);
  useShortcut('sidebar.toggle', toggleSidebar);
  useShortcut('history.back', goBack);
  useShortcut('history.forward', goForward);

  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    const removals = mainPageIds.map((page) => registerShortcut(`go.${page}`, () => navigateRef.current(mainView(page))));
    return () => removals.forEach((remove) => remove());
  }, []);

  const stepRef = useRef({ goBack, goForward });
  stepRef.current = { goBack, goForward };
  useEffect(() => {
    // On release, as a browser does. Not from inside a dialog or menu, or beside an open dialog, which would be left
    // open over another page or lose what's typed in it.
    const onMouseUp = (event: MouseEvent) => {
      const step = mouseStep(event.button);
      if (step === null || isOverlayTarget(event.target)) return;
      event.preventDefault();
      if (step < 0) stepRef.current.goBack();
      else stepRef.current.goForward();
    };
    window.addEventListener('mouseup', onMouseUp);
    return () => window.removeEventListener('mouseup', onMouseUp);
  }, []);
}

import { listen } from '@tauri-apps/api/event';
import type { AppMenuAction } from '../native/types';

/** Sent by the native shell when Check for Updates… or Settings… is picked in the app menu (src-tauri/src/app_menu.rs). */
export const APP_MENU_ACTION_EVENT = 'app-menu-action';

export type AppMenuHandlers = {
  /** Opens Settings › Updates and checks for a new Arbor and a new core. */
  checkForUpdates: () => void;
  openSettings: () => void;
};

/** Carries out an app menu item. The native side has already shown the window. */
export function runAppMenuAction(action: AppMenuAction, handlers: AppMenuHandlers) {
  switch (action) {
    case 'checkForUpdates':
      handlers.checkForUpdates();
      break;
    case 'openSettings':
      handlers.openSettings();
      break;
  }
}

/**
 * Listens for the app menu's items. `handlers` is read on each pick, so the listener can stay for the window's life
 * while what it calls changes. Returns what stops it.
 */
export function watchAppMenuActions(handlers: () => AppMenuHandlers): () => void {
  const stop = listen<AppMenuAction>(APP_MENU_ACTION_EVENT, ({ payload }) => runAppMenuAction(payload, handlers()));
  return () => void stop.then((unlisten) => unlisten()).catch(() => undefined);
}

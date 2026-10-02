import { useSyncExternalStore } from 'react';
import { invokeCommand } from '../native/commands';
import type { AppIconChoice, AppIconSetting } from '../native/types';
import type { MessageKey } from '../i18n/resources';

/**
 * The Dock icon's color. The native side owns it (src-tauri/src/app_icon.rs): it's saved in config.toml and put in the
 * Dock at launch. Auto shows the build's own icon, the one it's packaged with: Forest for stable, Amber for nightly and
 * Sky for dev. Settings › Appearance picks it, and Settings › About shows the one in the Dock.
 */
export const APP_ICON_CHOICES: readonly AppIconChoice[] = ['auto', 'forest', 'amber', 'sky', 'ember', 'signal', 'paper', 'mono'];

export const APP_ICON_LABEL: Record<AppIconChoice, MessageKey> = {
  auto: 'appIcon.auto',
  forest: 'appIcon.forest',
  amber: 'appIcon.amber',
  sky: 'appIcon.sky',
  ember: 'appIcon.ember',
  signal: 'appIcon.signal',
  paper: 'appIcon.paper',
  mono: 'appIcon.mono',
};

/** Before the native side answers, and outside the app: the stable build's own icon. */
const UNKNOWN: AppIconSetting = { choice: 'auto', shown: 'forest' };

let setting: AppIconSetting = UNKNOWN;
let asked = false;
const listeners = new Set<() => void>();

function show(next: AppIconSetting) {
  if (next.choice === setting.choice && next.shown === setting.shown) return;
  setting = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!asked) {
    asked = true;
    invokeCommand('get_app_icon').then(show).catch(() => undefined);
  }
  return () => { listeners.delete(listener); };
}

export function useAppIcon(): AppIconSetting {
  return useSyncExternalStore(subscribe, () => setting, () => setting);
}

/** Saves the choice and puts it in the Dock. Throws when it couldn't be saved, for the row to say why. */
export async function setAppIcon(choice: AppIconChoice): Promise<void> {
  show(await invokeCommand('set_app_icon', { choice }));
}

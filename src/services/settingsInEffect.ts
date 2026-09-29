import { invokeCommand } from '../native/commands';
import type { SettingsInEffect } from '../native/types';
import type { NoticeMessage } from './appNotice';
import { refreshProxyChecks } from './proxyChecks';

/**
 * After a save the proxy takes without a restart, whether it's running it (src-tauri/src/settings_in_effect.rs). One
 * value it can't read anywhere in config.yaml makes it skip the reload and keep its old settings, and only its log
 * would say so. A save it didn't load refreshes the proxy checks too, so Home and Usage say so as well.
 */
export async function confirmSettingsInEffect(): Promise<SettingsInEffect | null> {
  try {
    const result = await invokeCommand('confirm_core_settings');
    if (result.state === 'notLoaded') void refreshProxyChecks();
    return result;
  } catch {
    // Not being able to ask says nothing against the save, which has already worked.
    return null;
  }
}

/** What to say beside a save the proxy didn't load, or null when "Saved" says it all. */
export function notLoadedNotice(result: SettingsInEffect | null): NoticeMessage | null {
  if (result?.state !== 'notLoaded') return null;
  return result.line === null
    ? { key: 'config.notice.savedNotLoaded' }
    : { key: 'config.notice.savedNotLoadedLine', variables: { line: result.line } };
}

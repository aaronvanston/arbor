import type { MessageKey } from '../i18n/resources';
import {
  isAuthFileGoneFromDisk,
  isOAuthCredentialFile,
  isRuntimeOnlyAuthFile,
  type AuthFileAvailability,
  type AuthFileRecord,
} from './authFiles';
import { reauthProviderForFile } from './authReauth';
import { readBoolean, readString } from './managementApi';
import { providerForFile } from './quotaService';

export type AuthFileActionId =
  | 'reauth'
  | 'refresh-credential'
  | 'enable'
  | 'check-limits'
  | 'priority'
  | 'cap'
  | 'models'
  | 'exclude-models'
  | 'copy-name'
  | 'disable'
  | 'delete';

/** Something a credential row can do, and why it can't right now, if it can't. */
export type AuthFileAction = { id: AuthFileActionId; unavailable: MessageKey | null };

/** What a row offers: one action up front, the rest in its ⋯ menu. */
export type AuthFileActions = {
  primary: AuthFileAction | null;
  /** In groups, split by separators; the destructive ones last. */
  menu: AuthFileAction[][];
};

/**
 * The fix a credential needs, offered up front: Sign In Again only when the provider rejected the token, Refresh Now
 * while the core waits to retry. Both need an OAuth credential file; Sign In Again also needs a provider the app can
 * sign in to.
 */
export function primaryAuthFileAction(file: AuthFileRecord, availability: AuthFileAvailability): 'reauth' | 'refresh' | null {
  if (!isOAuthCredentialFile(file)) return null;
  if (availability.kind === 'signin') return reauthProviderForFile(file) ? 'reauth' : null;
  return availability.kind === 'retrying' ? 'refresh' : null;
}

const action = (id: AuthFileActionId, unavailable: MessageKey | null = null): AuthFileAction => ({ id, unavailable });

/**
 * What a credential row offers. Up front, the one thing its state calls for: the fix it needs, Enable when it's
 * turned off, or reading its limits. Everything else goes in the ⋯ menu, which says why an item can't be used rather
 * than leaving it out, as the row's buttons did.
 */
export function authFileActions(file: AuthFileRecord, availability: AuthFileAvailability): AuthFileActions {
  const disabled = readBoolean(file, 'disabled');
  const runtime = isRuntimeOnlyAuthFile(file);
  // The file left the disk (the core replaced or lost it) and is listed until the core notices.
  const removed = isAuthFileGoneFromDisk(file);
  // Only OAuth credential files can be turned on and off, re-prioritized, capped or signed in again.
  const oauthFile = isOAuthCredentialFile(file);
  const fileOnly: MessageKey = removed ? 'authFiles.menu.removed' : 'authFiles.menu.fileOnly';
  const limits = Boolean(providerForFile(file));
  const hasProvider = Boolean(readString(file, 'provider', 'type', 'account_type'));
  const canReauth = oauthFile && reauthProviderForFile(file) !== null;

  const fix = primaryAuthFileAction(file, availability);
  const primary = fix === 'reauth'
    ? action('reauth')
    : fix === 'refresh'
      ? action('refresh-credential')
      : disabled && oauthFile
        ? action('enable')
        // A turned-off account's limits aren't read: the core stops refreshing its sign-in.
        : limits && !disabled && !removed ? action('check-limits') : null;
  const offered = (id: AuthFileActionId) => primary?.id !== id;

  const routing: AuthFileAction[] = [
    ...(limits && !disabled && offered('check-limits') ? [action('check-limits', removed ? 'authFiles.menu.removed' : null)] : []),
    action('priority', !oauthFile ? fileOnly : disabled ? 'authFiles.priority.disabledHint' : null),
    ...(oauthFile && limits ? [action('cap')] : []),
  ];
  const models: AuthFileAction[] = [
    ...(hasProvider
      ? [
          action('models', disabled ? 'authFiles.menu.enableFirst' : null),
          action('exclude-models', !oauthFile || !readString(file, 'name') ? fileOnly : disabled ? 'authFiles.menu.enableFirst' : null),
        ]
      : []),
    action('copy-name'),
  ];
  const signIn = canReauth && offered('reauth') ? [action('reauth')] : [];
  const lastly: AuthFileAction[] = [
    ...(offered('enable') ? [action(disabled ? 'enable' : 'disable', oauthFile ? null : fileOnly)] : []),
    // The core has nothing left to delete for a removed file and drops it by itself.
    action('delete', runtime ? 'authFiles.menu.runtimeDelete' : removed ? 'authFiles.menu.removed' : null),
  ];
  return { primary, menu: [routing, models, signIn, lastly].filter((group) => group.length > 0) };
}

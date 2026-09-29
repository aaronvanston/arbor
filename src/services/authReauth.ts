import { translate } from '../i18n';
import {
  canonicalProvider,
  changedAuthFileNames,
  changedOAuthAuthFileNames,
  isAuthFileForProvider,
  isAuthFileGoneFromDisk,
  isRuntimeOnlyAuthFile,
  snapshotAuthFiles,
  type AuthFileRecord,
  type AuthFileSnapshot,
} from './authFiles';
import { migrateAccountKeys, renamedCredentialKeys, type AccountKeyRename } from './accountKeys';
import { isRecord, managementApi, readString, responseList, type ManagementJson } from './managementApi';
import type { OAuthProviderId } from './oauthCallback';

export type ReauthApi = {
  get: (path: string, query?: Record<string, string>) => Promise<ManagementJson>;
  delete: (path: string, options?: { query?: Record<string, string> }) => Promise<ManagementJson>;
  uploadAuthFileText: (name: string, text: string) => Promise<ManagementJson>;
};

export type ListingPollOptions = {
  /** Listing attempts while the core finishes writing the new credential. */
  attempts?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type CompleteReauthOptions = ListingPollOptions & {
  /** Carries the app's per-account state to a credential's new file name. */
  migrateKeys?: (renames: AccountKeyRename[]) => void;
};

const listingPoll = (options: ListingPollOptions) => ({
  attempts: Math.max(1, options.attempts ?? 8),
  pollMs: options.pollMs ?? 500,
  sleep: options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); })),
});

export type ReauthOutcome =
  | { kind: 'in-place'; name: string }
  | { kind: 'transplanted'; name: string; from: string }
  /** The core saved the login under its own new name and removed `from` itself. */
  | { kind: 'renamed'; name: string; from: string }
  | { kind: 'mismatch'; name: string; signedInAs: string[] }
  /** The login shares `name`'s email but the file records another workspace or organization. */
  | { kind: 'other-workspace'; name: string; saved: string }
  /** `name` left the disk but no credential for its account appeared. */
  | { kind: 'missing'; name: string }
  | { kind: 'none'; name: string };

/** OAuth provider the GUI can re-run a sign-in for, or null when the file is not re-authenticatable. */
export const reauthProviderForFile = (file: AuthFileRecord): OAuthProviderId | null => {
  const provider = canonicalProvider(readString(file, 'provider', 'type', 'account_type'));
  return provider === 'codex' || provider === 'claude' || provider === 'xai' ? provider : null;
};

export const authAccountId = (file: AuthFileRecord) =>
  readString(file, 'account_id', 'account_uuid', 'accountId');

export const authEmail = (file: AuthFileRecord) => readString(file, 'email').toLowerCase();

export const authAccountLabel = (file: AuthFileRecord) =>
  readString(file, 'email') || authAccountId(file) || readString(file, 'name');

/** Freshly written credentials that may belong to `target`'s account: by account id first, then by email. */
const sameAccountCredentials = (target: AuthFileRecord, candidates: AuthFileRecord[]) => {
  const accountId = authAccountId(target);
  const email = authEmail(target);
  const byId = accountId ? candidates.filter((candidate) => authAccountId(candidate) === accountId) : [];
  const byEmail = email ? candidates.filter((candidate) => !byId.includes(candidate) && authEmail(candidate) === email) : [];
  return [...byId, ...byEmail];
};

/** Pick the freshly written credential that belongs to the same account as `target`. */
export function matchReauthCredential(
  target: AuthFileRecord,
  candidates: AuthFileRecord[],
): AuthFileRecord | null {
  return sameAccountCredentials(target, candidates)[0] ?? null;
}

/** User-configured fields that a re-login must never clobber (mirrors the core's re-login preserve list). */
export const PRESERVED_AUTH_FIELDS = [
  'priority',
  'disabled',
  'prefix',
  'websockets',
  'note',
  'proxy_url',
  'weight',
  'headers',
  'models',
  'thinking',
  'excluded_models',
] as const;

/** Overlay fresh OAuth tokens onto the existing file while keeping its settings. */
export function mergeReauthCredential(
  existing: Record<string, unknown>,
  fresh: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing, ...fresh };
  for (const key of PRESERVED_AUTH_FIELDS) {
    if (key in existing) merged[key] = existing[key];
  }
  return merged;
}

const downloadAuthFile = async (api: ReauthApi, name: string) => {
  const payload = await api.get('/auth-files/download', { name });
  if (!isRecord(payload)) {
    throw new Error(translate('authFiles.reauth.invalidFile', { name }));
  }
  return payload;
};

/** Changed files whose names did not exist before the sign-in. */
const newFilesAmong = (candidates: AuthFileRecord[], knownNames: Set<string>) =>
  candidates.filter((file) => !knownNames.has(readString(file, 'name')));

/**
 * Identity fields a credential file records about its account: the Codex
 * workspace, the Claude organization and user. The listing leaves them out.
 */
const FILE_IDENTITY_FIELDS = ['account_id', 'organization_uuid', 'account_uuid'] as const;

/** Whether two credential files name different accounts; a file that records no id never conflicts. */
const conflictingIdentity = (left: Record<string, unknown>, right: Record<string, unknown>) =>
  FILE_IDENTITY_FIELDS.some((field) => {
    const leftId = readString(left, field);
    const rightId = readString(right, field);
    return Boolean(leftId && rightId && leftId !== rightId);
  });

/** Credential files of `provider` from before a sign-in that are no longer on disk. */
const vanishedCredentials = (before: AuthFileRecord[], after: AuthFileRecord[], provider: string) => {
  const onDisk = new Set(after.filter((file) => !isAuthFileGoneFromDisk(file)).map((file) => readString(file, 'name')));
  return before.filter((file) => {
    const name = readString(file, 'name');
    return Boolean(name) && !onDisk.has(name) && !isRuntimeOnlyAuthFile(file) && !isAuthFileGoneFromDisk(file)
      && isAuthFileForProvider(file, provider);
  });
};

const pairVanishedCredentials = (
  before: AuthFileRecord[],
  after: AuthFileRecord[],
  provider: string,
  { newFilesOnly }: { newFilesOnly: boolean },
) => {
  const changed = new Set(changedAuthFileNames(snapshotAuthFiles(before), after, provider));
  const knownNames = new Set(before.map((file) => readString(file, 'name')));
  const fresh = after.filter((file) => changed.has(readString(file, 'name')));
  const created = newFilesAmong(fresh, knownNames);
  return vanishedCredentials(before, after, provider).flatMap((file) => {
    const name = readString(file, 'name');
    const others = (candidates: AuthFileRecord[]) => candidates.filter((candidate) => readString(candidate, 'name') !== name);
    const match = matchReauthCredential(file, others(created))
      ?? (newFilesOnly ? null : matchReauthCredential(file, others(fresh)));
    return match ? [{ from: file, to: match }] : [];
  });
};

/**
 * Credentials a sign-in moved to a new file name: a file from before the login
 * that has left the disk, paired with a file for the same account (account id,
 * falling back to email). The listing only tells accounts apart by email, so a
 * file the sign-in created goes first; an existing file that changed meanwhile
 * (the core refreshes tokens on its own schedule) is only the fallback.
 */
export function renamedCredentials(
  before: AuthFileRecord[],
  after: AuthFileRecord[],
  provider: string,
): { from: AuthFileRecord; to: AuthFileRecord }[] {
  return pairVanishedCredentials(before, after, provider, { newFilesOnly: false });
}

/**
 * The credential listing once a finished sign-in shows in it. The core saves
 * the login first and lists it a moment later, so this polls briefly until a
 * credential of the provider changed and every file the sign-in replaced has a
 * newly created successor listed, then returns the last listing either way.
 */
export async function listingAfterSignIn(
  before: AuthFileRecord[],
  provider: string,
  api: Pick<ReauthApi, 'get'> = managementApi,
  options: ListingPollOptions = {},
): Promise<AuthFileRecord[]> {
  const { attempts, pollMs, sleep } = listingPoll(options);
  const snapshot = snapshotAuthFiles(before);
  let files: AuthFileRecord[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(pollMs);
    files = responseList(await api.get('/auth-files'), 'files');
    if (changedAuthFileNames(snapshot, files, provider).length > 0
      && pairVanishedCredentials(before, files, provider, { newFilesOnly: true }).length
        === vanishedCredentials(before, files, provider).length) break;
  }
  return files;
}

/** What a finished sign-in wrote, once the core lists it. */
export type SignInResult = {
  /** The listing that shows it. */
  files: AuthFileRecord[];
  /** Credentials that weren't listed before the sign-in. */
  added: string[];
  /** Credentials that were, and that the sign-in wrote again: an account signed in to again. */
  refreshed: string[];
  /** Why a new credential's priority couldn't be set, when it couldn't. The sign-in itself was saved. */
  priorityError?: string;
};

export type SettleSignInOptions = CompleteReauthOptions & {
  setPriority?: (name: string) => Promise<unknown>;
};

/**
 * Follows up a finished sign-in to `provider` once the core lists it. An account the core saved under a new file name
 * keeps the app's per-account state (profile, order, cap) under the new one, and a new credential without a priority
 * of its own goes in the default tier, 0.
 */
export async function settleSignIn(
  before: AuthFileRecord[],
  provider: OAuthProviderId,
  api: Pick<ReauthApi, 'get'> = managementApi,
  options: SettleSignInOptions = {},
): Promise<SignInResult> {
  const files = await listingAfterSignIn(before, provider, api, options);
  const renamed = renamedCredentials(before, files, provider);
  const migrate = options.migrateKeys ?? migrateAccountKeys;
  migrate(renamed.map(({ from, to }) => renamedCredentialKeys(from, to)));
  const snapshot = snapshotAuthFiles(before);
  // An account the core moved to a new file name was here before, under its old one.
  const known = new Set([...snapshot.keys(), ...renamed.map(({ to }) => readString(to, 'name'))]);
  const written = changedAuthFileNames(snapshot, files, provider);
  const result: SignInResult = {
    files,
    added: written.filter((name) => !known.has(name)),
    refreshed: written.filter((name) => known.has(name)),
  };
  const setPriority = options.setPriority ?? ((name: string) => managementApi.patch('/auth-files/fields', { name, priority: 0 }));
  const failures = (await Promise.allSettled(changedOAuthAuthFileNames(snapshot, files, provider).map(setPriority)))
    .flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []));
  const [failure] = failures;
  return failure === undefined ? result : { ...result, priorityError: String(failure) };
}

/**
 * After an OAuth sign-in finished, fold the new credential into `target`.
 * The core writes re-logins to its own canonical file name, so when the
 * names differ the fresh tokens are copied into the existing file and the
 * duplicate is deleted. Files with a different identity are left alone.
 * Newer cores go one step further for some providers (Claude from 7.2.158):
 * they carry the old file's settings into the canonical file and delete the
 * old one themselves, which is reported as a rename and left as it is.
 */
export async function completeReauth(
  target: AuthFileRecord,
  provider: OAuthProviderId,
  before: AuthFileSnapshot,
  api: ReauthApi = managementApi,
  options: CompleteReauthOptions = {},
): Promise<ReauthOutcome> {
  const name = readString(target, 'name');
  const { attempts, pollMs, sleep } = listingPoll(options);
  const knownNames = new Set(before.keys());

  // The core writes the login to a file of its own and its watcher picks it up a
  // moment later, so give the listing a few tries before deciding nothing arrived.
  // Only the sign-in's own result ends the wait: the target rewritten in place,
  // or a file that did not exist before. A credential that merely changed
  // meanwhile (the core refreshed it) does not, even when it shares the email.
  let candidates: AuthFileRecord[] = [];
  let newFiles: AuthFileRecord[] = [];
  let rewrittenInPlace = false;
  let targetGone = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(pollMs);
    const files = responseList(await api.get('/auth-files'), 'files');
    const changed = new Set(changedAuthFileNames(before, files, provider));
    // Never treat the target as its own fresh credential: the core only updated
    // it in place when no separate file appeared, and matching it to itself is
    // exactly how a duplicate gets left behind.
    candidates = files.filter((file) => {
      const fileName = readString(file, 'name');
      return fileName !== name && changed.has(fileName);
    });
    newFiles = newFilesAmong(candidates, knownNames);
    // A core that renamed the credential has already deleted the target; the
    // listing can keep showing it from memory until the core's watcher notices.
    targetGone = !files.some((file) => readString(file, 'name') === name && !isAuthFileGoneFromDisk(file));
    rewrittenInPlace = !targetGone && changed.has(name);
    if (rewrittenInPlace || newFiles.length > 0) break;
  }

  // An existing file for the account only counts once nothing new arrived: the
  // login may have rewritten the account's own file under another name. When
  // the target itself was rewritten, or a new file appeared, an existing file
  // that shares the email is another credential (a second organization or
  // workspace) and must not be folded into the target.
  const matches = newFiles.length > 0
    ? sameAccountCredentials(target, newFiles)
    : rewrittenInPlace ? [] : sameAccountCredentials(target, candidates);
  const [match] = matches;

  if (!match) {
    if (targetGone) return { kind: 'missing', name };
    // A new file for another account is what this sign-in saved; the target
    // changing at the same time was the core refreshing it. Without one, a
    // rewritten target is where the sign-in landed.
    const signedIn = newFiles.length > 0 ? newFiles : rewrittenInPlace ? [] : candidates;
    if (signedIn.length > 0) {
      return { kind: 'mismatch', name, signedInAs: signedIn.map(authAccountLabel).filter(Boolean) };
    }
    return rewrittenInPlace ? { kind: 'in-place', name } : { kind: 'none', name };
  }
  if (targetGone) {
    // The core already moved the account and its settings to the new file.
    // Copying the tokens back would put the deleted file back on disk next to
    // the new one, so only the app's own per-account state follows it.
    (options.migrateKeys ?? migrateAccountKeys)([renamedCredentialKeys(target, match)]);
    return { kind: 'renamed', name: readString(match, 'name'), from: name };
  }

  // The files themselves record the workspace or organization the listing
  // leaves out. Never fold one account's login into another's file: take the
  // first candidate whose file agrees with the target's.
  const existing = await downloadAuthFile(api, name);
  let fresh: Record<string, unknown> | undefined;
  let freshName = '';
  for (const candidate of matches) {
    const candidateName = readString(candidate, 'name');
    const content = await downloadAuthFile(api, candidateName);
    if (conflictingIdentity(existing, content)) continue;
    fresh = content;
    freshName = candidateName;
    break;
  }
  if (!fresh) return { kind: 'other-workspace', name, saved: readString(match, 'name') };
  const merged = mergeReauthCredential(existing, fresh);
  await api.uploadAuthFileText(name, `${JSON.stringify(merged, null, 2)}\n`);
  await api.delete('/auth-files', { query: { name: freshName } });
  return { kind: 'transplanted', name, from: freshName };
}

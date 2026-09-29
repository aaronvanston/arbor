import { useEffect, useSyncExternalStore } from 'react';
import { managementApi, readBoolean, readString, responseList } from './managementApi';
import { authFileAvailabilityChangesAt, dedupeAuthFiles, isAuthFileGoneFromDisk } from './authFiles';
import { rememberCredentialEmails } from './emailPrivacy';
import { idleQuota, loadQuota, providerForFile, quotaKey, type AuthFile } from './quotaService';
import {
  captureQuotaCacheGeneration,
  commitQuotaCacheIfCurrent,
  getQuotaCacheSnapshot,
  pruneQuotaCache,
  storeQuotaResult,
  updateQuotaCache,
} from './quotaCache';

/**
 * Auth files that can report subscription limits, shared by the Accounts page and the sidebar summary
 * so both read the same list and the same quota cache.
 */
type AccountsState = {
  files: AuthFile[];
  /** Accounts turned off in the core. Their limits aren't read: the core stops refreshing their sign-in. */
  disabled: AuthFile[];
  /** The core's whole listing: other sign-ins, API keys and files it's about to drop as well. */
  listing: AuthFile[];
  /** When the listing arrived, and when the core says it built it: each credential's state is read as of then. */
  listedAt: { receivedAtMs: number; observedAt?: string };
  /** Quiet reloads in a row that failed, and that still found a file gone from the disk: each waits longer. */
  quietFailures: number;
  lingeringChecks: number;
  loading: boolean;
  loaded: boolean;
  refreshing: boolean;
  error: string;
};

const EMPTY: AccountsState = {
  files: [], disabled: [], listing: [], listedAt: { receivedAtMs: 0 }, quietFailures: 0, lingeringChecks: 0,
  loading: false, loaded: false, refreshing: false, error: '',
};
let state: AccountsState = EMPTY;
const listeners = new Set<() => void>();
const REFRESH_CONCURRENCY = 4;

const emit = (next: Partial<AccountsState>) => {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getSnapshot = () => state;

export const useAccountsStore = () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

/**
 * Why no account shows its limits, or null while one does: the list is still loading, every account the core listed
 * is turned off (by hand, or paused by Arbor at a cap), the list failed to load before it said anything, or the core
 * has no account at all. Only the last is a reason to offer adding one.
 */
export type AccountsGap = 'loading' | 'off' | 'failed' | 'none';

type ListedAccounts = Pick<AccountsState, 'loaded' | 'error' | 'files' | 'disabled'>;

export function accountsGap({ loaded, error, files, disabled }: ListedAccounts): AccountsGap | null {
  if (files.length) return null;
  if (!loaded) return 'loading';
  // Accounts from an earlier listing are still known after a later one fails, so they still say every one is off.
  if (disabled.length) return 'off';
  return error ? 'failed' : 'none';
}

/**
 * The core listed no account that can report limits, on or off. Not while the list is loading or failed to load: that
 * says nothing about whether there are any.
 */
export const hasNoAccounts = (store: ListedAccounts) => accountsGap(store) === 'none';
export const getAccountsSnapshot = getSnapshot;

/**
 * Credentials that can report limits. A file that left the disk (the core just
 * replaced it under a new name) lingers in the listing until the core notices;
 * it is not an account to show.
 */
export const accountFilesFromListing = (files: AuthFile[]) =>
  files.filter((file) => !readBoolean(file, 'disabled') && !isAuthFileGoneFromDisk(file) && providerForFile(file));

/** Credentials that could report limits but are turned off. */
export const disabledAccountFilesFromListing = (files: AuthFile[]) =>
  files.filter((file) => readBoolean(file, 'disabled') && !isAuthFileGoneFromDisk(file) && providerForFile(file));

let listingRequest = 0;
let appliedListing = 0;

/**
 * Reads the core's listing again. A quiet reload, which the page makes by itself when a credential's state is due to
 * change, keeps the last listing without an alarm when it fails, and waits longer before the next.
 */
export async function loadAccountFiles({ quiet = false }: { quiet?: boolean } = {}): Promise<AuthFile[]> {
  const request = ++listingRequest;
  if (!quiet) emit({ loading: true, error: '' });
  try {
    const payload = await managementApi.get('/auth-files');
    // A slower, older request doesn't replace a newer listing; a newer one that failed doesn't stop an older one.
    if (request < appliedListing) return state.files;
    appliedListing = request;
    const allFiles = dedupeAuthFiles(responseList(payload, 'files'));
    const files = accountFilesFromListing(allFiles);
    rememberCredentialEmails(allFiles);
    pruneQuotaCache(new Set(allFiles.map(quotaKey)));
    updateQuotaCache((current) => {
      const next = { ...current };
      files.forEach((file) => {
        const key = quotaKey(file);
        if (!next[key]) next[key] = idleQuota();
      });
      return next;
    });
    const lingering = allFiles.some(isAuthFileGoneFromDisk);
    emit({
      files,
      disabled: disabledAccountFilesFromListing(allFiles),
      listing: allFiles,
      listedAt: { receivedAtMs: Date.now(), observedAt: readString(payload, 'observed_at') || undefined },
      quietFailures: 0,
      lingeringChecks: quiet && lingering ? state.lingeringChecks + 1 : 0,
      loading: quiet ? state.loading : false,
      loaded: true,
    });
    return files;
  } catch (error) {
    if (request < appliedListing) return state.files;
    if (quiet) {
      emit({ quietFailures: state.quietFailures + 1 });
      return [];
    }
    emit({ loading: false, loaded: true, error: String(error) });
    return [];
  }
}

// Reload a little after a rest ends: the core rounds its countdown up to whole seconds.
const LISTING_RELOAD_GRACE_MS = 1_000;
// Timers beyond about 24.8 days overflow; a long rest is simply checked again later.
const MAX_LISTING_RELOAD_MS = 6 * 3_600_000;
// A file that left the disk usually drops out of the core's listing within a second or two.
const LINGERING_RELOAD_MS = 2_000;
// Pauses that double with each quiet reload in a row that failed, or that still found a removed file, up to a cap.
const RELOAD_BACKOFF_MS = 2_000;
const MAX_RELOAD_BACKOFF_MS = 5 * 60_000;
const reloadBackoff = (count: number) =>
  count > 0 ? Math.min(RELOAD_BACKOFF_MS * 2 ** (count - 1), MAX_RELOAD_BACKOFF_MS) : 0;

/**
 * How long until the Accounts page reads the listing again by itself: just after the first rest in it ends, and soon
 * while a removed file still lingers, checking for that file less often each time it is still there. After quiet
 * reloads failed, everything waits for a growing pause (the core may be restarting). Undefined when nothing in the
 * listing changes on its own.
 */
export function listingReloadDelay({ changesAtMs, lingering, lingeringChecks, failures, receivedAtMs, nowMs }: {
  changesAtMs?: number;
  lingering: boolean;
  lingeringChecks: number;
  failures: number;
  receivedAtMs: number;
  nowMs: number;
}): number | undefined {
  const lingeringAtMs = lingering ? receivedAtMs + Math.max(LINGERING_RELOAD_MS, reloadBackoff(lingeringChecks)) : Infinity;
  const dueAtMs = Math.min(changesAtMs ?? Infinity, lingeringAtMs);
  if (dueAtMs === Infinity) return undefined;
  return Math.min(Math.max(dueAtMs - nowMs, reloadBackoff(failures), 0) + LISTING_RELOAD_GRACE_MS, MAX_LISTING_RELOAD_MS);
}

/**
 * The store for an Accounts view while it's open: the listing is read again as the view opens, with limits fetched for
 * any account never checked, and again by itself when a credential's state is due to change. States are read as of the
 * listing, so when the first rest in it ends, or while a removed file lingers in it, a fresh listing is read quietly
 * instead of guessing what the core did next.
 */
export function useLiveAccounts() {
  const store = useAccountsStore();
  const { listing, listedAt, lingeringChecks, quietFailures } = store;
  useEffect(() => {
    void loadAccountFiles().then((files) => {
      const snapshot = getQuotaCacheSnapshot();
      void refreshAccountQuotas(files.filter((file) => (snapshot[quotaKey(file)]?.status ?? 'idle') === 'idle'));
    });
  }, []);
  useEffect(() => {
    if (!listedAt.receivedAtMs) return;
    const delay = listingReloadDelay({
      changesAtMs: authFileAvailabilityChangesAt(listing, listedAt.receivedAtMs, listedAt.observedAt),
      lingering: listing.some(isAuthFileGoneFromDisk),
      lingeringChecks,
      failures: quietFailures,
      receivedAtMs: listedAt.receivedAtMs,
      nowMs: Date.now(),
    });
    if (delay === undefined) return;
    const timer = window.setTimeout(() => void loadAccountFiles({ quiet: true }), delay);
    return () => window.clearTimeout(timer);
  }, [listing, listedAt, lingeringChecks, quietFailures]);
  return store;
}

export async function refreshAccountQuotas(targets: AuthFile[]): Promise<void> {
  const pending = targets.filter((file) => getQuotaCacheSnapshot()[quotaKey(file)]?.status !== 'loading');
  if (!pending.length) return;
  emit({ refreshing: true, error: '' });
  const cacheGeneration = captureQuotaCacheGeneration();
  updateQuotaCache((current) => ({
    ...current,
    // Keep the last known rows while loading so bars and figures animate to the new values instead of clearing.
    ...Object.fromEntries(pending.map((file) => {
      const previous = current[quotaKey(file)];
      return [quotaKey(file), { ...previous, status: 'loading', rows: previous?.rows ?? [] }];
    })),
  }));
  try {
    for (let index = 0; index < pending.length; index += REFRESH_CONCURRENCY) {
      const batch = pending.slice(index, index + REFRESH_CONCURRENCY);
      await Promise.all(batch.map(async (file) => {
        const result = await loadQuota(file);
        commitQuotaCacheIfCurrent(cacheGeneration, () => storeQuotaResult(quotaKey(file), result));
      }));
    }
  } finally {
    emit({ refreshing: false });
  }
}

/** Loads the file list once and fetches limits for any account that has never been queried. */
export async function ensureAccountsLoaded(): Promise<void> {
  const files = state.loaded && !state.error ? state.files : await loadAccountFiles();
  const snapshot = getQuotaCacheSnapshot();
  await refreshAccountQuotas(files.filter((file) => (snapshot[quotaKey(file)]?.status ?? 'idle') === 'idle'));
}

export const setAccountsError = (error: string) => emit({ error });

/** Back to nothing loaded, for tests. */
export const resetAccountsStore = () => emit(EMPTY);

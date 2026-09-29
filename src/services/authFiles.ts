import { managementApi, readBoolean, readString } from './managementApi';
import {
  authFileStatusMessage,
  cooldownTimestamp,
  isKnownCooldownReason,
  normalizeAuthFileCooldowns,
  statusMessageReason,
  summarizeAuthFileCooldowns,
  type AuthFileCooldown,
} from './authFileHealth';
import { translate } from '../i18n';

export type AuthFileRecord = Record<string, unknown>;
export type AuthFileSnapshot = Map<string, string>;

export const authFileName = (file: AuthFileRecord) =>
  readString(file, 'name') || translate('authFiles.unnamed');

export const isRuntimeOnlyAuthFile = (file: AuthFileRecord) =>
  readBoolean(file, 'runtime_only', 'runtimeOnly');

/**
 * A file-backed credential whose file has left the disk. The core keeps listing
 * it (`source: memory`) until its watcher catches up, for example right after
 * it saved a login under a new name and deleted the file it replaced.
 */
export const isAuthFileGoneFromDisk = (file: AuthFileRecord) =>
  Boolean(readString(file, 'path'))
  && readString(file, 'source').toLowerCase() === 'memory'
  && !isRuntimeOnlyAuthFile(file);

/**
 * An OAuth credential stored as a file in the auth folder. Runtime-only entries
 * and API keys also appear in the listing, but the core cannot enable, disable
 * or re-prioritize them through the file endpoints: a disabled runtime entry
 * drops out of the listing with no way back.
 */
export const isOAuthCredentialFile = (file: AuthFileRecord): boolean => {
  if (!readString(file, 'name').toLowerCase().endsWith('.json') || isRuntimeOnlyAuthFile(file)) return false;
  const kinds = ['account_type', 'auth_kind', 'authKind'].map((key) =>
    readString(file, key).toLowerCase().replace(/[-_]/g, ''));
  if (kinds.includes('apikey')) return false;
  const source = readString(file, 'source').toLowerCase();
  return !source || source === 'file';
};

export const setOAuthCredentialFileDisabled = async (
  file: AuthFileRecord,
  disabled: boolean,
  api: { patch: (path: string, body: Record<string, unknown>) => Promise<unknown> } = managementApi,
): Promise<void> => {
  if (!isOAuthCredentialFile(file)) {
    throw new Error(translate('authFiles.fileOnly'));
  }
  await api.patch('/auth-files/status', { name: readString(file, 'name'), disabled });
};

export const parseAuthFilePriority = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) return undefined;
  const priority = Number(normalized);
  return Number.isSafeInteger(priority) ? priority : undefined;
};

export const normalizeAuthFilePriorityInput = (value: string): number | null => {
  const normalized = value.trim();
  if (!normalized) return 0;
  return parseAuthFilePriority(normalized) ?? null;
};

/** Other names credential files and older tools use for a provider Arbor knows. */
const PROVIDER_ALIASES = new Map([
  ['anthropic', 'claude'],
  ['openai', 'codex'],
  ['grok', 'xai'],
  ['x-ai', 'xai'],
  ['x_ai', 'xai'],
  ['anti-gravity', 'antigravity'],
  ['anti_gravity', 'antigravity'],
]);

/**
 * The one name for a provider, whichever alias the file used. Limits, re-sign-in, matching a fresh
 * credential and the Auth Files list all read it, so they can't disagree about which provider a file is.
 */
export const canonicalProvider = (value: string) => {
  const provider = value.trim().toLowerCase();
  return PROVIDER_ALIASES.get(provider) ?? provider;
};

const authFileProvider = (file: AuthFileRecord) =>
  canonicalProvider(readString(file, 'provider', 'type'));

export const isAuthFileForProvider = (file: AuthFileRecord, provider: string) =>
  authFileProvider(file) === canonicalProvider(provider);

/** Providers that have at least one OAuth credential file, for the provider-wide model exclusions. */
export const oauthModelProvidersFromAuthFiles = (files: AuthFileRecord[]): string[] =>
  [...new Set(files.filter(isOAuthCredentialFile).map(authFileProvider).filter(Boolean))].sort();

/**
 * Fields that describe the credential on disk. Runtime state the core attaches
 * to a listing (status, cooldowns, quota observations) is deliberately left out:
 * it churns on its own, and a snapshot that moves by itself makes every
 * credential look like it was just rewritten. `updated_at` is runtime state too:
 * the core stamps it after every request a credential serves. A rewrite of the
 * file still shows in `modtime`, which the core reads from the file itself.
 */
const FINGERPRINT_FIELDS = [
  'name', 'type', 'provider', 'account_type',
  'email', 'account', 'label', 'account_id', 'account_uuid', 'accountId',
  'auth_index', 'authIndex', 'path', 'source', 'runtime_only', 'runtimeOnly',
  'priority', 'disabled', 'excluded_models',
  'modtime', 'last_refresh', 'expired', 'size',
] as const;

export const authFileFingerprint = (file: AuthFileRecord) =>
  JSON.stringify(FINGERPRINT_FIELDS.map((field) => file[field] ?? null));

export const snapshotAuthFiles = (files: AuthFileRecord[]): AuthFileSnapshot => {
  const grouped = new Map<string, string[]>();
  files.forEach((file) => {
    const name = readString(file, 'name');
    if (!name) return;
    const fingerprints = grouped.get(name) ?? [];
    fingerprints.push(authFileFingerprint(file));
    grouped.set(name, fingerprints);
  });
  return new Map(Array.from(grouped, ([name, fingerprints]) => [
    name,
    fingerprints.sort().join('\n'),
  ]));
};

export const changedAuthFileNames = (
  before: AuthFileSnapshot,
  files: AuthFileRecord[],
  provider: string,
  options: { requireDefaultPriority?: boolean } = {},
) => {
  const expectedProvider = canonicalProvider(provider);
  const after = snapshotAuthFiles(files);
  const names = new Set<string>();
  files.forEach((file) => {
    const name = readString(file, 'name');
    // A file that just left the disk is not a fresh credential, and writing a
    // field to it would put the file the core deleted back on disk. Runtime
    // entries have no file a sign-in could write, and their listed times move
    // with every request they serve.
    if (!name || isAuthFileGoneFromDisk(file) || isRuntimeOnlyAuthFile(file)
      || authFileProvider(file) !== expectedProvider) return;
    if (options.requireDefaultPriority) {
      const priority = parseAuthFilePriority(file.priority);
      if (priority !== undefined && priority !== 0) return;
    }
    if (before.get(name) !== after.get(name)) names.add(name);
  });
  return Array.from(names);
};

/** Changed credentials that still carry the default priority (used to apply priority 0 after a login). */
export const changedOAuthAuthFileNames = (
  before: AuthFileSnapshot,
  files: AuthFileRecord[],
  provider: string,
) => changedAuthFileNames(before, files, provider, { requireDefaultPriority: true });

/** One model the core is resting on a credential it otherwise still routes to. */
export type AuthFileModelCooldown = {
  model: string;
  reason: string;
  httpStatus?: number;
  retryAtMs: number;
};

/** Model rests on a usable credential: how many models, and when the first one is tried again. */
export type AuthFileModelLimits = {
  count: number;
  retryAtMs: number;
  cooldowns: AuthFileModelCooldown[];
};

export type AuthFileAvailability =
  | { kind: 'ready'; models?: AuthFileModelLimits }
  | { kind: 'disabled' }
  | { kind: 'limit'; retryAtMs?: number }
  | { kind: 'signin'; message: string; reason?: string }
  | { kind: 'retrying'; message: string; reason?: string; retryAtMs?: number }
  | { kind: 'access'; message: string; reason?: string }
  | { kind: 'unavailable'; message: string; retryAtMs?: number };

type Trouble = 'limit' | 'signin' | 'access' | 'retrying';

/** What each core reason code means for the person looking at the credential. */
const REASON_TROUBLE: Record<string, Trouble> = {
  quota: 'limit',
  credential_quota: 'limit',
  unauthorized: 'signin',
  invalid_grant: 'signin',
  payment_required: 'access',
  not_found: 'access',
  transient_error: 'retrying',
  cloudflare_challenge: 'retrying',
  token_expired: 'retrying',
};

const httpTrouble = (status: number | undefined): Trouble | undefined => {
  if (status === undefined) return undefined;
  if (status === 429) return 'limit';
  if (status === 401) return 'signin';
  if (status === 402 || status === 403 || status === 404) return 'access';
  if (status === 408 || status >= 500) return 'retrying';
  return undefined;
};

/** Reason codes decide; the HTTP status only speaks for a code this app does not know. */
const troubleFor = (reason: string | undefined, httpStatus?: number): Trouble | undefined => {
  if (reason && Object.prototype.hasOwnProperty.call(REASON_TROUBLE, reason)) return REASON_TROUBLE[reason];
  if (reason === 'model_not_supported') return undefined;
  return httpTrouble(httpStatus);
};

/** Keeps a reason only when the app has a label for it. */
const labeledReason = (reason: string | undefined) =>
  reason && isKnownCooldownReason(reason) ? reason : undefined;

// Last resort for free-text messages from cores that predate the reason markers.
const SIGN_IN_ERROR = /\b401\b|unauthori[sz]ed|invalid_grant|invalid_token|token (?:has )?(?:expired|revoked)|refresh(?:ing)? (?:token )?(?:failed|error)|authentication_error|re-?login|sign in again/i;

/**
 * A core timestamp on this machine's clock. The core stamps each listing with
 * `observed_at`, so the gap between that and the timestamp is what counts, not
 * whether the two clocks agree.
 */
const coreInstantMs = (value: unknown, listedAtMs: number, observedAt?: string): number | undefined => {
  const at = cooldownTimestamp(value);
  if (!at) return undefined;
  const observed = cooldownTimestamp(observedAt);
  return observed ? listedAtMs + (Date.parse(at) - Date.parse(observed)) : Date.parse(at);
};

type ActiveCooldown = AuthFileCooldown & { retryAtMs: number; trouble?: Trouble };

/** Rests that were still running when the listing was built, timed from when it arrived. */
const activeCooldowns = (file: AuthFileRecord, listedAtMs: number, observedAt?: string) => {
  const snapshot = normalizeAuthFileCooldowns(file.cooldowns, listedAtMs, observedAt);
  const rows: ActiveCooldown[] = summarizeAuthFileCooldowns(snapshot, listedAtMs).active
    .map(({ record, remainingSeconds }) => ({
      ...record,
      retryAtMs: listedAtMs + remainingSeconds * 1000,
      trouble: troubleFor(record.reason, record.httpStatus),
    }));
  return { rows, known: Boolean(snapshot?.records) };
};

const earliest = (rows: { retryAtMs: number }[]) =>
  rows.length ? Math.min(...rows.map((row) => row.retryAtMs)) : undefined;
const latest = (rows: { retryAtMs: number }[]) =>
  rows.length ? Math.max(...rows.map((row) => row.retryAtMs)) : undefined;

const modelLimits = (rows: ActiveCooldown[]): AuthFileModelLimits | undefined => {
  const cooldowns = rows
    .filter((row) => row.scope === 'model' && row.model)
    .map((row): AuthFileModelCooldown => ({
      model: row.model ?? '',
      reason: row.reason,
      retryAtMs: row.retryAtMs,
      ...(row.httpStatus ? { httpStatus: row.httpStatus } : {}),
    }))
    .sort((left, right) => left.retryAtMs - right.retryAtMs || left.model.localeCompare(right.model));
  const [soonest] = cooldowns;
  if (!soonest) return undefined;
  return {
    count: new Set(cooldowns.map((cooldown) => cooldown.model)).size,
    retryAtMs: soonest.retryAtMs,
    cooldowns,
  };
};

/**
 * Why the core is or is not routing to a credential, as of the listing that
 * reported it. A rejected token comes first: only a fresh sign-in fixes it,
 * whatever else is going on. A blocked credential is then explained by the
 * most specific evidence available: the core's credential-wide rest, then the
 * status the core recorded for the credential, then the rests on its models
 * (every model resting blocks the credential too). On a credential the core
 * still uses, model rests only annotate `ready`. Times are measured from
 * `listedAtMs`, when the listing arrived: once a rest ends the page loads a
 * fresh listing rather than guessing what the core did next.
 */
export const authFileAvailability = (
  file: AuthFileRecord,
  listedAtMs = Date.now(),
  observedAt?: string,
): AuthFileAvailability => {
  if (readBoolean(file, 'disabled')) return { kind: 'disabled' };
  const message = authFileStatusMessage(file);
  const marker = statusMessageReason(message);
  const markerTrouble = troubleFor(marker);
  const { rows, known } = activeCooldowns(file, listedAtMs, observedAt);
  const credentialRows = rows.filter((row) => row.scope === 'credential');
  const blocked = readBoolean(file, 'unavailable') || credentialRows.length > 0;
  const nextRetryAtMs = coreInstantMs(file.next_retry_after ?? file.nextRetryAfter, listedAtMs, observedAt);
  const pendingRetryAtMs = nextRetryAtMs !== undefined && nextRetryAtMs > listedAtMs ? nextRetryAtMs : undefined;
  // The core routes to the credential again once every credential-wide rest is
  // over, otherwise as soon as the first model rest ends.
  const reopensAtMs = latest(credentialRows) ?? earliest(rows) ?? pendingRetryAtMs;

  // A rejected token is a problem with the whole credential, whatever scope the
  // core recorded it under. It outranks any limit or rest, which only matter
  // again once the credential can sign in.
  const signInRow = rows.find((row) => row.trouble === 'signin');
  if (markerTrouble === 'signin' || signInRow) {
    return { kind: 'signin', message, reason: markerTrouble === 'signin' ? marker : labeledReason(signInRow?.reason) };
  }

  if (!blocked) {
    const models = modelLimits(rows);
    return models ? { kind: 'ready', models } : { kind: 'ready' };
  }

  /** The block as explained by one set of rests, if any of them says why. */
  const explainedBy = (
    subset: ActiveCooldown[],
    limitEndsAt: (limits: ActiveCooldown[]) => number | undefined,
  ): AuthFileAvailability | undefined => {
    const limits = subset.filter((row) => row.trouble === 'limit');
    if (limits.length > 0) return { kind: 'limit', retryAtMs: limitEndsAt(limits) };
    const retryRow = subset.find((row) => row.trouble === 'retrying');
    if (retryRow) return { kind: 'retrying', message, reason: labeledReason(retryRow.reason), retryAtMs: reopensAtMs };
    const accessRow = subset.find((row) => row.trouble === 'access');
    if (accessRow) return { kind: 'access', message, reason: labeledReason(accessRow.reason) };
    return undefined;
  };

  // The core's credential-wide rest (an account limit, or any rest on a
  // credential without per-model state) lasts until its latest end.
  const byCredentialRest = explainedBy(credentialRows, latest);
  if (byCredentialRest) return byCredentialRest;

  // The status the core recorded for the credential: its latest failure.
  if (markerTrouble === 'limit') {
    // `next_retry_after` is the credential's own retry time; older cores report
    // nothing else, and newer ones only list model rests when it has models.
    const limitAtMs = pendingRetryAtMs ?? earliest(rows.filter((row) => row.trouble === 'limit'));
    const limitPassed = nextRetryAtMs !== undefined && nextRetryAtMs <= listedAtMs;
    if (limitAtMs !== undefined || (!known && !limitPassed)) return { kind: 'limit', retryAtMs: limitAtMs };
    // A usage limit whose rest already ended is waiting on the core's next attempt.
    return { kind: 'retrying', message, reason: marker, retryAtMs: reopensAtMs };
  }
  if (markerTrouble === 'retrying') {
    // The core retries a failed token refresh on a timer of its own, not when
    // a model rest ends, so only the credential's own retry time applies.
    return { kind: 'retrying', message, reason: marker, retryAtMs: marker === 'token_expired' ? pendingRetryAtMs : reopensAtMs };
  }
  if (markerTrouble === 'access') return { kind: 'access', message, reason: marker };

  // Every model resting: the first one to reopen reopens the credential.
  const byModelRests = explainedBy(rows, earliest);
  if (byModelRests) return byModelRests;

  // No reason at all: the core is between attempts.
  if (!message) return { kind: 'retrying', message, retryAtMs: reopensAtMs };
  if (SIGN_IN_ERROR.test(message)) return { kind: 'signin', message };
  return { kind: 'unavailable', message, retryAtMs: reopensAtMs };
};

/**
 * The next moment a listing goes stale on its own: the earliest rest that ends
 * among these credentials. The page reloads then instead of re-deriving states
 * from old data.
 */
export const authFileAvailabilityChangesAt = (
  files: AuthFileRecord[],
  listedAtMs: number,
  observedAt?: string,
): number | undefined => earliest(files.flatMap((file) => {
  if (readBoolean(file, 'disabled')) return [];
  const moments = activeCooldowns(file, listedAtMs, observedAt).rows;
  const next = coreInstantMs(file.next_retry_after ?? file.nextRetryAfter, listedAtMs, observedAt);
  return next !== undefined && next > listedAtMs ? [...moments, { retryAtMs: next }] : moments;
}));

const hasMeaningfulValue = (value: unknown) => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

const authFileTimestamp = (file: AuthFileRecord) => {
  for (const value of [file.modtime, file.updated_at, file.last_refresh]) {
    if (value === null || value === undefined || value === '') continue;
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = new Date(String(value)).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
};

const authFileSourceFields = new Set([
  'source', 'path', 'runtime_only', 'runtimeOnly', 'account_type', 'auth_kind', 'authKind',
]);

// How the core is treating one entry. Each entry's health is its own: a
// duplicate's rejected token or rest must not turn a healthy file into one
// that needs a sign-in.
const authFileHealthFields = new Set([
  'status', 'status_message', 'statusMessage', 'unavailable',
  'next_retry_after', 'nextRetryAfter', 'cooldowns',
]);

const authFilePriority = (file: AuthFileRecord) => {
  let score = 0;
  if (readString(file, 'source').toLowerCase() === 'file') score += 32;
  if (readString(file, 'path')) score += 16;
  if (!isRuntimeOnlyAuthFile(file)) score += 8;
  if (!readBoolean(file, 'disabled')) score += 4;
  if (authFileTimestamp(file) > 0) score += 2;
  return score;
};

const mergeDuplicateAuthFiles = (entries: AuthFileRecord[]) => {
  const sorted = [...entries].sort((left, right) => {
    const priority = authFilePriority(right) - authFilePriority(left);
    if (priority !== 0) return priority;
    const timestamp = authFileTimestamp(right) - authFileTimestamp(left);
    if (timestamp !== 0) return timestamp;
    return Object.values(right).filter(hasMeaningfulValue).length
      - Object.values(left).filter(hasMeaningfulValue).length;
  });
  const merged = { ...sorted[0] };
  sorted.slice(1).forEach((entry) => {
    Object.entries(entry).forEach(([key, value]) => {
      // Where a record came from is not something a duplicate can lend: a
      // runtime twin would otherwise make the file on disk look runtime-only.
      // Nor is its health; `cooldowns: null` (unknown) and `[]` (none) are both
      // answers from the kept record, never gaps to fill in from another one.
      if (authFileSourceFields.has(key) || authFileHealthFields.has(key)) return;
      if (!hasMeaningfulValue(merged[key]) && hasMeaningfulValue(value)) merged[key] = value;
    });
  });
  return merged;
};

export const dedupeAuthFiles = (files: AuthFileRecord[]) => {
  const grouped = new Map<string, AuthFileRecord[]>();
  files.forEach((file, index) => {
    const key = authFileName(file) || `unnamed-${index}`;
    const entries = grouped.get(key) ?? [];
    entries.push(file);
    grouped.set(key, entries);
  });
  return Array.from(grouped.values())
    .map(mergeDuplicateAuthFiles)
    .sort((left, right) =>
      authFileName(left).localeCompare(authFileName(right), undefined, { sensitivity: 'base' }),
    );
};

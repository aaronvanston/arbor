import { buildXaiBillingSummary, mergeXaiBillingSummaries, type XaiBillingConfig } from './xaiBilling';
import {
  apiCallErrorMessage,
  isRecord,
  managementApi,
  normalizeAuthIndex,
  readString,
} from './managementApi';
import { authFileName, canonicalProvider } from './authFiles';
import { readCommandError } from './commandError';
import {
  codexConsumeOutcome, codexRedeemRequestId, nextCodexResetCredit, rememberCodexRedeem, settleCodexRedeem,
  unsettledCodexRedeem, type UnsettledCodexRedeem,
} from './codexResetRedeem';
import { antigravityProjectFor, codexMetadataFor, isPaidXaiFile } from './quotaMetadata';
import { quotaResetFor, quotaResetInstant } from './quotaTime';
import { translate } from '../i18n';
import { formatDateTime, formatDuration, formatMoney } from '../lib/format';

const quotaText = (
  key: Parameters<typeof translate>[0],
  variables?: Parameters<typeof translate>[1],
) => translate(key, variables);

export type AuthFile = Record<string, unknown>;
export type QuotaProvider = 'claude' | 'codex' | 'kimi' | 'xai' | 'antigravity';
export type QuotaStatus = 'idle' | 'loading' | 'success' | 'error';
export type QuotaRow = {
  label: string;
  remainingPercent: number | null;
  reset?: string;
  resetAtMs?: number;
  /** How long the window runs, set only where the provider says or the window's name fixes it. */
  windowMs?: number;
  detail?: string;
  /** A Codex limit outside the main rate limit (code review or a per-feature limit), which a manual reset doesn't refill. */
  extra?: boolean;
};
/** How a Claude banked reset can be used. Its count and use-by date are `resetCredits` and `resetCreditsEarliestExpiry`. */
export type ClaudeBankedReset = {
  /** The reset a claim uses, set only while one can be used now. */
  grantId?: string;
  /** Why none of the resets left can be used now. */
  blockedReason?: string;
  /** The limits the reset refills. */
  refills?: string;
  /** Set when using the reset now spends it before the account reaches a limit. */
  earlyUse?: { percentLeft?: number; limit?: string };
  /** When the weekly limit resets. Using a banked reset doesn't move it. */
  weeklyResetsAt?: string;
};
export type QuotaState = {
  status: QuotaStatus;
  rows: QuotaRow[];
  error?: string;
  plan?: string;
  resetCredits?: number;
  resetCreditsApplicable?: number;
  resetCreditsError?: string;
  resetCreditsEarliestExpiry?: string;
  bankedReset?: ClaudeBankedReset;
  subscriptionActiveUntil?: string;
  serverTimeOffsetMs?: number;
  fetchedAt?: number;
  /**
   * Set while `rows` are held over from the check at `fetchedAt` because a later one failed: when the first
   * failure came. Only for showing; nothing automatic acts on stale rows.
   */
  staleSinceMs?: number;
  pendingAction?: 'reset';
  /**
   * `not-used` means the provider declined and nothing was spent; `message` replaces the generic wording.
   * `warning` is set on a reset that went through but left something undone.
   */
  actionResult?: {
    action: 'reset'; status: 'success' | 'not-used' | 'refresh-error' | 'error'; error?: string; message?: string; warning?: string;
  };
};

export const idleQuota = (): QuotaState => ({ status: 'idle', rows: [] });

const endpointByProvider: Record<QuotaProvider, string> = {
  claude: 'https://api.anthropic.com/api/oauth/usage',
  codex: 'https://chatgpt.com/backend-api/wham/usage',
  kimi: 'https://api.kimi.com/coding/v1/usages',
  xai: 'https://cli-chat-proxy.grok.com/v1/billing',
  antigravity: 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
};

const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
/** Claude Code's read of banked resets (its `cedar_ember` program), alongside the usage windows. */
const CLAUDE_BANKED_RESETS_URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1';
const claudeResetClaimUrl = (organization: string) =>
  `https://api.anthropic.com/api/organizations/${encodeURIComponent(organization)}/reset_rate_limits`;
const XAI_WEEKLY_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const CODEX_RESET_CREDITS_URL =
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const CODEX_RESET_CREDITS_CONSUME_URL =
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume';
const ANTIGRAVITY_CODE_ASSIST_URL =
  'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';

const headersByProvider: Record<QuotaProvider, Record<string, string>> = {
  claude: {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'anthropic-beta': 'oauth-2025-04-20',
  },
  codex: {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'User-Agent': 'codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)',
  },
  kimi: { Authorization: 'Bearer $TOKEN$' },
  xai: {
    Authorization: 'Bearer $TOKEN$',
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-client-version': '0.2.91',
    accept: '*/*',
    'user-agent': 'grok-pager/0.2.91 grok-shell/0.2.91 (macos; aarch64)',
  },
  antigravity: {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'User-Agent': 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)',
  },
};

/** Claude offers banked resets to Claude Code, so those requests identify as it. */
const claudeCodeHeaders: Record<string, string> = {
  ...headersByProvider.claude,
  'User-Agent': 'claude-cli/2.1.280 (external, cli)',
};

export const providerForFile = (file: AuthFile): QuotaProvider | null => {
  const value = canonicalProvider(readString(file, 'provider', 'type', 'account_type'));
  return ['claude', 'codex', 'kimi', 'xai', 'antigravity'].includes(value)
    ? (value as QuotaProvider)
    : null;
};

export const fileName = authFileName;

export const quotaKey = (file: AuthFile) =>
  `${fileName(file)}::${normalizeAuthIndex(file.auth_index ?? file.authIndex)}`;

const parseBody = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const numberValue = (value: unknown): number | null => {
  if (isRecord(value) && 'val' in value) return numberValue(value.val);
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const clampPercent = (value: unknown): number | null => {
  const parsed = numberValue(value);
  if (parsed === null) return null;
  return Math.max(0, Math.min(100, parsed));
};

const remainingFromUsedPercent = (value: unknown): number | null => {
  const used = clampPercent(value);
  return used === null ? null : Math.max(0, Math.min(100, 100 - used));
};

const quotaFraction = (value: unknown): number | null => {
  if (typeof value === 'string' && value.trim().endsWith('%')) {
    const parsed = Number(value.trim().slice(0, -1));
    return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed / 100)) : null;
  }
  const parsed = numberValue(value);
  return parsed === null ? null : Math.max(0, Math.min(1, parsed));
};

/** An expiry or reset instant from a provider, "29 Sep, 5:36 pm", or a dash when it can't be read. */
export const formatQuotaTimestamp = (value: string | undefined): string => {
  const ms = value ? quotaResetInstant(value) : undefined;
  return ms === undefined ? '—' : formatDateTime(ms);
};

const absoluteResetLabel = (value: unknown): string | undefined => {
  const ms = quotaResetInstant(value);
  return ms === undefined ? undefined : formatDateTime(ms);
};

const relativeResetLabel = (value: unknown): string | undefined => {
  const seconds = numberValue(value);
  if (seconds === null || seconds <= 0) return undefined;
  return quotaText('format.relative.future', { span: formatDuration(seconds * 1000, 'up') });
};

const formatUsdFromCents = (value: number | null) => (value === null ? undefined : formatMoney(value / 100));

const codexResetLabel = (window: Record<string, unknown>): string | undefined =>
  absoluteResetLabel(window.reset_at ?? window.resetAt)
  ?? relativeResetLabel(window.reset_after_seconds ?? window.resetAfterSeconds);

const FIVE_HOUR_SECONDS = 18_000;
const WEEK_SECONDS = 604_800;
const MIN_MONTH_SECONDS = 28 * 86_400;
const MAX_MONTH_SECONDS = 31 * 86_400;

const formatWindowDuration = (seconds: number | null): string => {
  if (seconds === null || seconds <= 0) return quotaText('quota.service.duration.unknown');
  const day = 86_400;
  const hour = 3_600;
  const minute = 60;
  if (seconds % day === 0) return quotaText('quota.service.duration.days', { count: seconds / day });
  if (seconds % hour === 0) return quotaText('quota.service.duration.hours', { count: seconds / hour });
  if (seconds % minute === 0) return quotaText('quota.service.duration.minutes', { count: seconds / minute });
  return quotaText('quota.service.duration.seconds', { count: seconds });
};

const codexWindowLabel = (
  duration: number | null,
  prefix: string,
  kind: 'primary' | 'secondary',
) => {
  if (duration === FIVE_HOUR_SECONDS) return `${prefix}${quotaText('quota.service.limit.fiveHours')}`;
  if (duration === WEEK_SECONDS) return `${prefix}${quotaText('quota.service.limit.week')}`;
  if (duration !== null && duration >= MIN_MONTH_SECONDS && duration <= MAX_MONTH_SECONDS) {
    return `${prefix}${quotaText('quota.service.limit.month')}`;
  }
  if (duration !== null) {
    return `${prefix}${quotaText('quota.service.limit.duration', { duration: formatWindowDuration(duration) })}`;
  }
  if (kind === 'primary') return `${prefix}${quotaText('quota.service.limit.fiveHours')}`;
  return `${prefix}${quotaText('quota.service.limit.week')}`;
};

const codexWindowRows = (value: Record<string, unknown>): QuotaRow[] => {
  const windows: Array<{
    raw: unknown;
    kind: 'primary' | 'secondary';
    prefix: string;
    source: Record<string, unknown>;
  }> = [];
  const addRateLimit = (rawRateLimit: unknown, prefix: string) => {
    if (!isRecord(rawRateLimit)) return;
    const entries: typeof windows = [
      { raw: rawRateLimit.primary_window ?? rawRateLimit.primaryWindow, kind: 'primary', prefix, source: rawRateLimit },
      { raw: rawRateLimit.secondary_window ?? rawRateLimit.secondaryWindow, kind: 'secondary', prefix, source: rawRateLimit },
    ];
    const order = ({ raw, kind }: typeof entries[number]) => {
      const duration = isRecord(raw) ? numberValue(raw.limit_window_seconds ?? raw.limitWindowSeconds) : null;
      if (duration === FIVE_HOUR_SECONDS) return 0;
      if (duration === WEEK_SECONDS || (duration !== null && duration >= MIN_MONTH_SECONDS && duration <= MAX_MONTH_SECONDS)) return 1;
      return kind === 'primary' ? 0 : 1;
    };
    windows.push(...entries.sort((a, b) => order(a) - order(b)));
  };

  addRateLimit(value.rate_limit ?? value.rateLimit, '');
  addRateLimit(
    value.code_review_rate_limit ?? value.codeReviewRateLimit,
    `${quotaText('quota.service.codeReview')} `,
  );
  const additional = value.additional_rate_limits ?? value.additionalRateLimits;
  if (Array.isArray(additional)) {
    additional.forEach((item, index) => {
      if (!isRecord(item)) return;
      const name = readString(item, 'limit_name', 'limitName', 'metered_feature', 'meteredFeature')
        || quotaText('quota.service.additional', { index: index + 1 });
      addRateLimit(item.rate_limit ?? item.rateLimit, `${name} `);
    });
  }

  return windows.map(({ raw, kind, prefix, source }): QuotaRow | null => {
    if (!isRecord(raw)) return null;
    const duration = numberValue(raw.limit_window_seconds ?? raw.limitWindowSeconds);
    const reached = source.limit_reached === true || source.limitReached === true || source.allowed === false;
    const resetAtMs = quotaResetFor(raw, ['reset_at', 'resetAt'], ['reset_after_seconds', 'resetAfterSeconds']);
    return {
      label: codexWindowLabel(duration, prefix, kind),
      remainingPercent: remainingFromUsedPercent(raw.used_percent ?? raw.usedPercent)
        ?? (reached && resetAtMs !== undefined ? 0 : null),
      reset: codexResetLabel(raw),
      resetAtMs,
      // Only the reply's own length; the label's 5-hour/weekly fallback is a guess.
      ...(duration !== null && duration > 0 ? { windowMs: duration * 1000 } : {}),
      ...(prefix ? { extra: true } : {}),
    };
  }).filter((row): row is QuotaRow => row !== null);
};

export const codexResetCreditsFor = (payload: unknown): number | undefined => {
  const value = parseBody(payload);
  if (!isRecord(value)) return undefined;
  const credits = isRecord(value.rate_limit_reset_credits)
    ? value.rate_limit_reset_credits
    : isRecord(value.rateLimitResetCredits)
      ? value.rateLimitResetCredits
      : null;
  const count = numberValue(credits?.available_count ?? credits?.availableCount);
  return count === null ? undefined : Math.max(0, Math.floor(count));
};

export const codexResetCreditDetailsFor = (
  payload: unknown,
  nowMs = Date.now(),
): { availableCount?: number; applicableAvailableCount?: number; earliestExpiry?: string } => {
  const value = parseBody(payload);
  if (!isRecord(value)) return {};
  const credits = Array.isArray(value.credits)
    ? value.credits
      .filter(isRecord)
      .filter((credit) =>
        readString(credit, 'reset_type', 'resetType') === 'codex_rate_limits'
        && readString(credit, 'status') === 'available',
      )
    : [];
  const availableCount = numberValue(value.available_count ?? value.availableCount);
  const applicableCount = numberValue(value.applicable_available_count ?? value.applicableAvailableCount);
  const validCredits = credits.filter((credit) => {
    const expiry = quotaResetInstant(credit.expires_at ?? credit.expiresAt);
    return expiry !== undefined && expiry > nowMs;
  });
  const earliestExpiry = validCredits
    .map((credit) => readString(credit, 'expires_at', 'expiresAt'))
    .map((expiresAt) => ({ expiresAt, expiresAtMs: quotaResetInstant(expiresAt) ?? NaN }))
    .filter((credit) =>
      credit.expiresAt
      && Number.isFinite(credit.expiresAtMs)
      && credit.expiresAtMs > nowMs,
    )
    .sort((left, right) => left.expiresAtMs - right.expiresAtMs)[0]?.expiresAt;

  return {
    // An empty detail list is not an explicit zero; keep the usage-summary fallback.
    availableCount: availableCount === null
      ? validCredits.length || undefined
      : Math.max(0, Math.floor(availableCount)),
    ...(applicableCount === null ? {} : { applicableAvailableCount: Math.max(0, Math.floor(applicableCount)) }),
    earliestExpiry,
  };
};

const CLAUDE_GRANT_ID = /^[a-z0-9_-]{1,40}$/;
/** The limits a banked reset can refill, in the order Claude Code weighs them. */
const CLAUDE_RESET_LIMITS = [
  'five_hour', 'seven_day', 'seven_day_overage_included', 'seven_day_opus', 'seven_day_sonnet',
  'seven_day_cowork', 'seven_day_omelette', 'seven_day_oauth_apps',
];
/** The Claude windows with a row of their own, in the order the Accounts page shows them. */
const CLAUDE_ROW_FIELDS = ['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_cowork', 'iguana_necktie'];
/** A usage reply without any of these fields is an error reported in the body. */
const CLAUDE_USAGE_FIELDS = [
  'five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet',
  'cinder_cove', 'extra_usage', 'limits',
];

/** Claude's replies don't give window lengths, but the names fix them: five hours, or a week (`iguana_necktie` is the older 7-day Fable field). */
const claudeWindowMs = (key: string): number | undefined => {
  if (key === 'five_hour') return FIVE_HOUR_SECONDS * 1000;
  if (key.startsWith('seven_day') || key === 'weekly_scoped' || key === 'iguana_necktie') return WEEK_SECONDS * 1000;
  return undefined;
};

/** Any 7-day Claude cap by its usage field, including ones added after the fixed labels were written. */
const CLAUDE_SEVEN_DAY = /^seven_day_([a-z0-9_]+)$/;

/** "Omelette" from `seven_day_omelette`, never the raw field name. */
const claudeFieldName = (suffix: string) => suffix.split('_').filter(Boolean)
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

/**
 * A Claude window's label from its usage field: the same for its row on the Accounts page and wherever a banked
 * reset names it (what it refills, what blocks it), so both say the same thing. Null for a field that isn't a window.
 */
const claudeWindowLabel = (key: string): string | null => {
  switch (key) {
    case 'five_hour': return quotaText('quota.service.window.fiveHour');
    // The overage-included variant is the 7-day limit itself, as banked resets name it.
    case 'seven_day':
    case 'seven_day_overage_included': return quotaText('quota.service.window.sevenDay');
    case 'seven_day_oauth_apps': return quotaText('quota.service.window.sevenDayOAuth');
    case 'seven_day_opus': return quotaText('quota.service.window.sevenDayOpus');
    case 'seven_day_sonnet': return quotaText('quota.service.window.sevenDaySonnet');
    case 'seven_day_cowork': return quotaText('quota.service.window.sevenDayCowork');
    case 'iguana_necktie': return quotaText('quota.service.window.sevenDayFable');
    default: {
      const suffix = CLAUDE_SEVEN_DAY.exec(key)?.[1];
      return suffix ? quotaText('quota.service.window.sevenDayNamed', { name: claudeFieldName(suffix) }) : null;
    }
  }
};

/** Claude Code's limits, and any other 7-day cap: a reset naming one Arbor also shows as a row can say so. */
const isClaudeResetLimit = (limit: string) => CLAUDE_RESET_LIMITS.includes(limit) || CLAUDE_SEVEN_DAY.test(limit);

const claudeLimits = (value: unknown): string[] => (Array.isArray(value)
  ? value.filter((limit): limit is string => typeof limit === 'string' && isClaudeResetLimit(limit))
  : []);

type ClaudeGrant = {
  id: string;
  resetsLeft: number;
  endsAt: string;
  clears: string[];
  paused: boolean;
  usableNow: boolean;
  useRequiresLimit: boolean;
  percentUsed: Record<string, number>;
  blocking: string[];
};

const claudeGrantFor = (value: unknown): ClaudeGrant | null => {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  const resetsLeft = numberValue(value.resets_left);
  // Like Claude Code, drop a grant without a valid id or count rather than guess.
  if (!CLAUDE_GRANT_ID.test(id) || resetsLeft === null || !Number.isInteger(resetsLeft) || resetsLeft < 0) return null;
  const percentUsed: Record<string, number> = {};
  if (isRecord(value.percent_used)) {
    for (const [limit, percent] of Object.entries(value.percent_used)) {
      if (isClaudeResetLimit(limit) && typeof percent === 'number'
        && Number.isInteger(percent) && percent >= 0 && percent <= 100) percentUsed[limit] = percent;
    }
  }
  return {
    id,
    resetsLeft,
    endsAt: readString(value, 'ends_at'),
    clears: claudeLimits(value.clears),
    paused: booleanValue(value.paused) ?? false,
    usableNow: booleanValue(value.usable_now) ?? false,
    // Claude Code assumes a reset only works at a limit unless told otherwise.
    useRequiresLimit: booleanValue(value.use_requires_limit) ?? true,
    percentUsed,
    blocking: claudeLimits(value.blocking),
  };
};

/**
 * Banked resets from the `cedar_ember` block of a Claude usage reply, read the
 * way Claude Code reads them. A missing block, or an account that isn't
 * eligible, means none are offered, which is not the same as none left.
 */
export const claudeBankedResetFor = (
  payload: unknown,
  nowMs = Date.now(),
): Pick<QuotaState, 'resetCredits' | 'resetCreditsEarliestExpiry' | 'bankedReset'> & { error?: string } => {
  const value = parseBody(payload);
  const block = isRecord(value) ? value.cedar_ember : undefined;
  const eligible = isRecord(block) ? booleanValue(block.eligible) : null;
  if (!isRecord(block) || eligible === null) return {};
  const ineligibleReason = readString(block, 'ineligible_reason');
  if (ineligibleReason === 'unavailable') return { error: quotaText('quota.service.error.bankedResetsUnavailable') };
  const grants = (Array.isArray(block.grants) ? block.grants : [])
    .map(claudeGrantFor)
    .filter((grant): grant is ClaudeGrant => grant !== null);
  const live = grants.filter((grant) => {
    const endsAtMs = quotaResetInstant(grant.endsAt);
    return grant.resetsLeft > 0 && (endsAtMs === undefined || endsAtMs > nowMs);
  });
  const earliestEnd = (items: ClaudeGrant[]) => items
    .map((grant) => ({ endsAt: grant.endsAt, endsAtMs: quotaResetInstant(grant.endsAt) }))
    .filter((grant): grant is { endsAt: string; endsAtMs: number } => grant.endsAtMs !== undefined)
    .sort((left, right) => left.endsAtMs - right.endsAtMs)[0]?.endsAt;
  const counted = {
    resetCredits: live.reduce((total, grant) => total + grant.resetsLeft, 0),
    resetCreditsEarliestExpiry: earliestEnd(live),
  };
  if (eligible !== true) {
    // Claude also decides by the client asking. When that is why resets the
    // account has can't be used here, say so instead of hiding them.
    return live.length && ['surface', 'cli_version'].includes(ineligibleReason)
      ? { ...counted, bankedReset: { blockedReason: quotaText('quota.bankedReset.blocked.client', { reason: ineligibleReason }) } }
      : {};
  }
  const bankedReset: ClaudeBankedReset = { weeklyResetsAt: readString(block, 'weekly_resets_at') || undefined };
  const offer = live.find((grant) => grant.id === readString(block, 'next_grant_id') && grant.usableNow && !grant.paused);
  if (offer) {
    bankedReset.grantId = offer.id;
    const labels = [...new Set(offer.clears.map(claudeWindowLabel).filter((label): label is string => label !== null))];
    const last = labels[labels.length - 1];
    if (last !== undefined) {
      bankedReset.refills = labels.length === 1 ? last
        : quotaText('quota.service.list', { items: labels.slice(0, -1).join(', '), last });
    }
    // A reset that doesn't need a limit can be spent before reaching any it refills.
    const exhausted = claudeLimits(block.exhausted);
    if (!offer.useRequiresLimit && !offer.clears.some((limit) => exhausted.includes(limit))) {
      let most: { limit: string; used: number } | undefined;
      // Claude Code's order breaks ties; caps it doesn't know come after.
      for (const limit of [...CLAUDE_RESET_LIMITS, ...offer.clears.filter((item) => !CLAUDE_RESET_LIMITS.includes(item))]) {
        const used = offer.percentUsed[limit] as number | undefined;
        if (offer.clears.includes(limit) && used !== undefined && (!most || used > most.used)) most = { limit, used };
      }
      const label = most ? claudeWindowLabel(most.limit) : null;
      bankedReset.earlyUse = most && label && most.used < 100 ? { percentLeft: 100 - most.used, limit: label } : {};
    }
  } else if (live.length) {
    const blocking = live.flatMap((grant) => grant.blocking).map(claudeWindowLabel).find((label) => label !== null);
    const cooldownUntil = quotaResetInstant(block.cooldown_until);
    bankedReset.blockedReason = blocking
      ? quotaText('quota.bankedReset.blocked.limit', { limit: blocking })
      : live.every((grant) => grant.paused)
        ? quotaText('quota.bankedReset.blocked.paused')
        : cooldownUntil !== undefined && cooldownUntil > nowMs
          ? quotaText('quota.bankedReset.blocked.cooldown')
          : live.every((grant) => grant.useRequiresLimit)
            ? quotaText('quota.bankedReset.blocked.needsLimit')
            : quotaText('quota.bankedReset.blocked.later');
  }
  return {
    ...counted,
    ...(offer ? { resetCreditsEarliestExpiry: offer.endsAt || undefined } : {}),
    bankedReset,
  };
};

/** "Opus" from "Claude Opus 5": a new model version keeps its window's label, and saved choices keyed by it. */
const claudeModelFamily = (name: string) => {
  const family = name.replace(/^claude\s+/i, '').replace(/(?:\s+v?\d[\d.]*)+$/i, '').trim() || name;
  return family.charAt(0).toUpperCase() + family.slice(1);
};

/**
 * Adds the caps Claude added after the fixed labels were written: any other `seven_day_*` window, and every
 * model-scoped weekly limit. Without them a cap that blocks requests would go unseen. A usage field's label already
 * shown keeps its row, and its place, except to a model's own weekly limit under the same label: that one takes it,
 * as Fable's does over the legacy field, unless it's marked inactive (a replaced version's) and the field has a
 * figure. Labels stay the same either way, so saved choices keyed by them hold.
 */
const withClaudeNewCaps = (value: Record<string, unknown>, known: Record<string, string>, shown: QuotaRow[]): QuotaRow[] => {
  const rows = [...shown];
  const at = new Map(rows.map((row, index) => [row.label.toLowerCase(), index]));
  const capRow = (label: string, raw: Record<string, unknown>, used: unknown, windowMs: number | undefined): QuotaRow => ({
    label,
    remainingPercent: remainingFromUsedPercent(used),
    reset: absoluteResetLabel(raw.resets_at ?? raw.resetsAt),
    resetAtMs: quotaResetFor(raw, ['resets_at', 'resetsAt']),
    windowMs,
  });
  const add = (row: QuotaRow) => {
    if (at.has(row.label.toLowerCase())) return;
    at.set(row.label.toLowerCase(), rows.length);
    rows.push(row);
  };
  Object.entries(value).forEach(([key, raw]) => {
    const label = CLAUDE_SEVEN_DAY.test(key) ? claudeWindowLabel(key) : null;
    if (!label || key in known || !isRecord(raw) || numberValue(raw.utilization) === null) return;
    add(capRow(label, raw, raw.utilization, claudeWindowMs(key)));
  });
  const scoped = new Map<string, Record<string, unknown>>();
  (Array.isArray(value.limits) ? value.limits : []).filter(isRecord).forEach((limit) => {
    if (readString(limit, 'kind').toLowerCase() !== 'weekly_scoped' || numberValue(limit.percent) === null) return;
    const scope = isRecord(limit.scope) ? limit.scope : null;
    const name = readString(scope?.model, 'display_name', 'displayName').trim();
    if (!name) return;
    const label = quotaText('quota.service.window.sevenDayNamed', { name: claudeModelFamily(name) });
    const held = scoped.get(label);
    // Like Fable, a model's active limit wins over a stale one.
    if (!held || (held.is_active !== true && limit.is_active === true)) scoped.set(label, limit);
  });
  scoped.forEach((limit, label) => {
    const row = capRow(label, limit, limit.percent, claudeWindowMs('weekly_scoped'));
    const index = at.get(label.toLowerCase());
    if (index === undefined) add(row);
    else if (limit.is_active !== false || rows[index]!.remainingPercent === null) rows[index] = row;
  });
  return rows;
};

export const quotaRowsFor = (provider: QuotaProvider, payload: unknown): QuotaRow[] => {
  const value = parseBody(payload);
  if (!isRecord(value)) return [];

  if (provider === 'codex') return codexWindowRows(value);

  if (provider === 'claude') {
    const labels: Record<string, string> = Object.fromEntries(CLAUDE_ROW_FIELDS.map((key) => [key, claudeWindowLabel(key)!]));
    // Every Fable version is one window, so a new version's active limit wins over an old one's or the legacy field.
    const fableCandidates = (Array.isArray(value.limits) ? value.limits : []).filter(isRecord)
      .filter((limit) => {
        const scope = isRecord(limit.scope) ? limit.scope : null;
        const name = readString(scope?.model, 'display_name', 'displayName').trim();
        return readString(limit, 'kind').toLowerCase() === 'weekly_scoped'
          && name !== '' && claudeModelFamily(name).toLowerCase() === 'fable' && numberValue(limit.percent) !== null;
      });
    const fable = fableCandidates.find((limit) => limit.is_active === true) ?? fableCandidates[0];
    const fixed = Object.entries(labels)
      .filter(([key]) => key !== 'iguana_necktie' || !fable)
      .map(([key, label]): QuotaRow | null => {
        const raw = value[key];
        if (!isRecord(raw) || !('utilization' in raw)) return null;
        return {
          label,
          remainingPercent: remainingFromUsedPercent(raw.utilization),
          reset: absoluteResetLabel(raw.resets_at ?? raw.resetsAt),
          resetAtMs: quotaResetFor(raw, ['resets_at', 'resetsAt']),
          windowMs: claudeWindowMs(key),
        };
      })
      .filter((row): row is QuotaRow => row !== null);
    if (fable) fixed.push({
      label: quotaText('quota.service.window.sevenDayFable'),
      remainingPercent: remainingFromUsedPercent(fable.percent),
      reset: absoluteResetLabel(fable.resets_at ?? fable.resetsAt),
      resetAtMs: quotaResetFor(fable, ['resets_at', 'resetsAt']),
      windowMs: claudeWindowMs('weekly_scoped'),
    });
    const rows = withClaudeNewCaps(value, labels, fixed);
    const extraUsage = isRecord(value.extra_usage)
      ? value.extra_usage
      : isRecord(value.extraUsage)
        ? value.extraUsage
        : null;
    if (extraUsage && booleanValue(extraUsage.is_enabled ?? extraUsage.isEnabled) === true) {
      const monthlyLimit = numberValue(extraUsage.monthly_limit ?? extraUsage.monthlyLimit);
      const usedCredits = numberValue(extraUsage.used_credits ?? extraUsage.usedCredits);
      const computedRemaining = monthlyLimit !== null && monthlyLimit > 0 && usedCredits !== null
        ? ((monthlyLimit - usedCredits) / monthlyLimit) * 100
        : null;
      const usedLabel = formatUsdFromCents(usedCredits);
      const limitLabel = formatUsdFromCents(monthlyLimit);
      rows.push({
        label: quotaText('quota.service.extraUsage'),
        remainingPercent:
          remainingFromUsedPercent(extraUsage.utilization)
          ?? clampPercent(computedRemaining),
        detail: usedLabel && limitLabel
          ? quotaText('quota.service.usedOf', { used: usedLabel, limit: limitLabel })
          : undefined,
      });
    }
    return rows;
  }

  if (provider === 'kimi') {
    const items: unknown[] = Array.isArray(value.limits) ? [...value.limits] : [];
    if (isRecord(value.usage)) {
      items.push({ ...value.usage, label: readString(value.usage, 'name', 'title') || quotaText('quota.service.weekly') });
    }
    return items
      .map((raw, index): QuotaRow | null => {
        if (!isRecord(raw)) return null;
        const detail = isRecord(raw.detail) ? raw.detail : raw;
        const limit = numberValue(detail.limit);
        const used = numberValue(detail.used);
        const remaining = numberValue(detail.remaining);
        const usedValue = used ?? (limit !== null && remaining !== null ? limit - remaining : null);
        if (usedValue === null && limit === null) return null;
        const window = isRecord(raw.window) ? raw.window : null;
        const duration = numberValue(window?.duration ?? raw.duration ?? detail.duration);
        const unit = (readString(window, 'timeUnit', 'time_unit')
          || readString(raw, 'timeUnit', 'time_unit')
          || readString(detail, 'timeUnit', 'time_unit')).toLowerCase().replace(/^time_unit_/, '');
        const durationText = duration !== null && duration > 0
          ? unit.startsWith('week')
            ? quotaText('quota.service.duration.days', { count: duration * 7 })
            : unit.startsWith('day')
              ? quotaText('quota.service.duration.days', { count: duration })
              : unit.startsWith('hour')
                ? quotaText('quota.service.duration.hours', { count: duration })
                : unit.startsWith('second')
                  ? quotaText('quota.service.duration.seconds', { count: duration })
                  : duration % 60 === 0
                    ? quotaText('quota.service.duration.hours', { count: duration / 60 })
                    : quotaText('quota.service.duration.minutes', { count: duration })
          : '';
        const durationLabel = durationText
          ? quotaText('quota.service.window.duration', { duration: durationText })
          : '';
        return {
          label:
            readString(raw, 'label', 'name', 'title', 'scope')
            || readString(detail, 'name', 'title', 'scope')
            || durationLabel
            || quotaText('quota.service.limit.numbered', { index: index + 1 }),
          remainingPercent: clampPercent(
            limit !== null && limit > 0
              ? (Math.max(0, limit - (usedValue ?? 0)) / limit) * 100
              : (usedValue ?? 0) > 0
                ? 0
                : null,
          ),
          reset:
            absoluteResetLabel(
              detail.reset_at ?? detail.resetAt ?? detail.reset_time ?? detail.resetTime,
            )
            ?? relativeResetLabel(detail.reset_in ?? detail.resetIn ?? detail.ttl),
          resetAtMs: quotaResetFor(detail, ['reset_at', 'resetAt', 'reset_time', 'resetTime'], ['reset_in', 'resetIn', 'ttl']),
          detail: limit === null ? undefined : `${usedValue ?? 0} / ${limit}`,
        };
      })
      .filter((row): row is QuotaRow => row !== null);
  }

  if (provider === 'xai') {
    if (value.mode === 'paid-health' || value.mode === 'paid-info') return [{
      label: quotaText('quota.service.xaiPaidAccount'),
      remainingPercent: null,
      detail: quotaText(value.mode === 'paid-health'
        ? 'quota.service.xaiPaidHealth' : 'quota.service.xaiPaidQuotaUnavailable'),
    }];
    const build = (payload: unknown) => {
      if (!isRecord(payload)) return null;
      return buildXaiBillingSummary(
        (isRecord(payload.config) ? payload.config : payload) as XaiBillingConfig,
      );
    };
    const billing = isRecord(value.weekly) || isRecord(value.monthly)
      ? mergeXaiBillingSummaries(build(value.weekly), build(value.monthly))
      : build(value);
    if (!billing) return [];
    const rows: QuotaRow[] = [];
    const weeklyReset = {
      reset: absoluteResetLabel(billing.periodEnd),
      resetAtMs: billing.resetAtMs ?? undefined,
    };
    if (billing.periodType === 'weekly'
      && (billing.usagePercent !== null || billing.periodEnd || billing.productUsage.length > 0)) {
      rows.push({
        label: quotaText('quota.service.weekly'),
        remainingPercent: remainingFromUsedPercent(billing.usagePercent),
        ...weeklyReset,
      });
    }
    billing.productUsage.forEach((item) => rows.push({
      label: item.product,
      remainingPercent: remainingFromUsedPercent(item.usagePercent),
    }));
    const monthlyReset = {
      reset: absoluteResetLabel(billing.billingPeriodEnd),
      resetAtMs: quotaResetInstant(billing.billingPeriodEnd),
    };
    const amount = (cap: number | null, used: number | null) => {
      const remaining = cap !== null && used !== null ? Math.max(0, cap - used) : null;
      return cap === null ? formatUsdFromCents(remaining)
        : `${formatUsdFromCents(remaining)} / ${formatUsdFromCents(cap)}`;
    };
    if (billing.onDemandCapCents !== null && billing.onDemandCapCents > 0) {
      rows.push({
        label: quotaText('quota.service.onDemand'),
        remainingPercent: remainingFromUsedPercent(billing.onDemandUsedPercent),
        detail: amount(billing.onDemandCapCents, billing.onDemandUsedCents),
      });
    }
    if (billing.monthlyLimitCents !== null || billing.usedCents !== null || billing.billingPeriodEnd) {
      rows.push({
        label: quotaText('quota.service.monthlyIncluded'),
        remainingPercent: remainingFromUsedPercent(billing.usedPercent),
        detail: amount(billing.monthlyLimitCents, billing.includedUsedCents),
        ...monthlyReset,
      });
    }
    return rows.length > 0 ? rows : [{
      label: quotaText(billing.periodType === 'weekly'
        ? 'quota.service.weekly' : 'quota.service.monthlyIncluded'),
      remainingPercent: null,
    }];
  }
  const nested = parseBody(value.body);
  const summary = !Array.isArray(value.groups) && isRecord(nested) ? nested : value;
  const groups = Array.isArray(summary.groups) ? summary.groups : [];
  return groups.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.buckets)) return [];
    const order = (bucket: unknown) => {
      const window = readString(bucket, 'window').toLowerCase();
      return ['5h', 'five-hour', 'five_hour'].includes(window) ? 0 : ['weekly', 'week'].includes(window) ? 1 : 2;
    };
    const buckets = [...group.buckets].sort((a, b) => order(a) - order(b));
    const groupLabel = readString(group, 'display_name', 'displayName')
      || quotaText('quota.service.quota');
    const groupDescription = readString(group, 'description');
    return buckets
      .map((bucket, index): QuotaRow | null => {
        if (!isRecord(bucket)) return null;
        const remaining = quotaFraction(bucket.remaining_fraction ?? bucket.remainingFraction);
        if (remaining === null) return null;
        const bucketLabel = readString(bucket, 'display_name', 'displayName', 'window');
        const label = bucketLabel && (buckets.length > 1 || bucketLabel !== groupLabel)
          ? `${groupLabel} · ${bucketLabel}`
          : groupLabel;
        return {
          label: label || quotaText('quota.service.quota.numbered', { index: index + 1 }),
          remainingPercent: remaining * 100,
          reset: absoluteResetLabel(bucket.reset_time ?? bucket.resetTime),
          resetAtMs: quotaResetFor(bucket, ['reset_time', 'resetTime']),
          detail: readString(bucket, 'description') || groupDescription || undefined,
        };
      })
      .filter((row): row is QuotaRow => row !== null);
  });
};

const resolveProjectId = async (file: AuthFile): Promise<string> => {
  const direct = antigravityProjectFor(file);
  if (direct) return direct;
  try {
    const payload = parseBody(await managementApi.get('/auth-files/download', { name: fileName(file) }));
    return isRecord(payload) ? antigravityProjectFor(payload) : '';
  } catch {
    return '';
  }
};

const resolveCodexAccountId = (file: AuthFile): string => codexMetadataFor(file).accountId;

const xaiUserIdFromRecord = (record: Record<string, unknown>): string => {
  const nestedRecords = [record, record.metadata, record.attributes]
    .filter(isRecord);
  for (const source of nestedRecords) {
    const direct = readString(source, 'sub', 'subject', 'user_id', 'userId');
    if (direct) return direct;
    for (const container of [source.oauth, source.user]) {
      if (!isRecord(container)) continue;
      const nested = readString(container, 'sub', 'subject', 'user_id', 'userId', 'id');
      if (nested) return nested;
    }
  }
  return '';
};

const resolveXaiUserId = (file: AuthFile): string =>
  xaiUserIdFromRecord(file);

/**
 * How the core answers when its own request to the provider got nothing back: it couldn't
 * connect, look the host up, finish TLS, or hear back in time.
 */
const coreGotNoAnswer = (reason: unknown) => {
  const failure = readCommandError(reason);
  return failure.kind === 'core' && failure.status === 502 && failure.reason === 'request failed';
};

const requestQuotaPayload = async (
  authIndex: string,
  url: string,
  header: Record<string, string>,
  method: 'GET' | 'POST' = 'GET',
  data?: string,
  timeoutMs?: number,
  responseClock?: { serverTimeOffsetMs?: number },
) => {
  let response: Record<string, unknown>;
  try {
    response = await managementApi.post<Record<string, unknown>>('/api-call', {
      authIndex,
      method,
      url,
      header,
      data,
    }, { timeoutMs });
  } catch (error) {
    // A read that got no answer at all says where it couldn't get to. A POST may have landed anyway.
    if (method === 'GET' && coreGotNoAnswer(error)) {
      throw new Error(quotaText('quota.service.error.unreachable', { host: new URL(url).host }));
    }
    throw error;
  }
  const status = Number(response.status_code ?? response.statusCode ?? 0);
  if (status < 200 || status >= 300) {
    throw new Error(apiCallErrorMessage(response));
  }
  if (responseClock) {
    const header = isRecord(response.header) ? response.header : {};
    const raw = Object.entries(header).find(([key]) => key.toLowerCase() === 'date')?.[1];
    const serverTime = quotaResetInstant(Array.isArray(raw) ? raw[0] : raw);
    responseClock.serverTimeOffsetMs = serverTime === undefined ? undefined : serverTime - Date.now();
  }
  return parseBody(response.body ?? response.bodyText);
};

const callXaiPaidHealth = async (authIndex: string): Promise<unknown> => {
  const header = { Authorization: 'Bearer $TOKEN$', accept: 'application/json' };
  const [profile, chat] = await Promise.allSettled([
    requestQuotaPayload(authIndex, 'https://api.x.ai/v1/me', header, 'GET', undefined, 15_000),
    requestQuotaPayload(authIndex, 'https://api.x.ai/v1/chat/completions', {
      ...header, 'Content-Type': 'application/json',
    }, 'POST', JSON.stringify({
      model: 'grok-4.5',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    }), 15_000),
  ]);
  if (chat.status === 'rejected') throw chat.reason;
  const record = profile.status === 'fulfilled' && isRecord(profile.value) ? profile.value : {};
  return {
    mode: 'paid-health', plan_type: 'Paid',
    userId: readString(record, 'user_id', 'userId') || undefined,
    teamId: readString(record, 'team_id', 'teamId') || undefined,
  };
};
const callXaiQuota = async (file: AuthFile): Promise<unknown> => {
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  if (!authIndex) throw new Error(quotaText('quota.service.error.missingAuthIndex'));
  if (isPaidXaiFile(file)) return callXaiPaidHealth(authIndex);
  const header = { ...headersByProvider.xai };
  const userId = await resolveXaiUserId(file);
  if (userId) header['x-userid'] = userId;
  const [weekly, monthly] = await Promise.allSettled([
    requestQuotaPayload(authIndex, XAI_WEEKLY_URL, header),
    requestQuotaPayload(authIndex, endpointByProvider.xai, header),
  ]);
  const payload = {
    weekly: weekly.status === 'fulfilled' ? weekly.value : null,
    monthly: monthly.status === 'fulfilled' ? monthly.value : null,
  };
  if (quotaRowsFor('xai', payload).length > 0) return payload;
  const billingError = weekly.status === 'rejected' && monthly.status === 'rejected'
    ? weekly.reason : new Error(quotaText('quota.service.error.unrecognized'));
  try {
    return await callXaiPaidHealth(authIndex);
  } catch {
    throw billingError;
  }
};

const booleanValue = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : null;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return null;
};

const resolveClaudePlan = (payload: unknown): string | undefined => {
  if (!isRecord(payload)) return undefined;
  const account = isRecord(payload.account) ? payload.account : null;
  const organization = isRecord(payload.organization) ? payload.organization : null;
  if (booleanValue(account?.has_claude_max) === true) {
    // The tier reads like `default_claude_max_20x`.
    const tier = /(\d+)\s*x\b/i.exec(readString(organization, 'rate_limit_tier'));
    return tier ? `Max ${tier[1]}x` : 'Max';
  }
  if (booleanValue(account?.has_claude_pro) === true) return 'Pro';
  if (
    readString(organization, 'organization_type').toLowerCase() === 'claude_team'
    && readString(organization, 'subscription_status').toLowerCase() === 'active'
  ) return 'Team';
  if (
    booleanValue(account?.has_claude_max) === false
    && booleanValue(account?.has_claude_pro) === false
  ) return 'Free';
  return undefined;
};

const loadClaudePlan = async (file: AuthFile): Promise<string | undefined> => {
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  if (!authIndex) return undefined;
  try {
    return resolveClaudePlan(
      await requestQuotaPayload(authIndex, CLAUDE_PROFILE_URL, headersByProvider.claude),
    );
  } catch {
    return undefined;
  }
};

const loadAntigravityPlan = async (file: AuthFile): Promise<string | undefined> => {
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  if (!authIndex) return undefined;
  try {
    const payload = await requestQuotaPayload(
      authIndex,
      ANTIGRAVITY_CODE_ASSIST_URL,
      headersByProvider.antigravity,
      'POST',
      JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
    );
    if (!isRecord(payload)) return undefined;
    const currentTier = isRecord(payload.currentTier)
      ? payload.currentTier
      : isRecord(payload.current_tier)
        ? payload.current_tier
        : null;
    const paidTier = isRecord(payload.paidTier)
      ? payload.paidTier
      : isRecord(payload.paid_tier)
        ? payload.paid_tier
        : null;
    const effectiveTier = readString(paidTier, 'id') ? paidTier : currentTier;
    const tierId = readString(effectiveTier, 'id').toLowerCase();
    const tierName = readString(effectiveTier, 'name');
    const knownPlans: Record<string, string> = {
      'free-tier': 'Free',
      'g1-pro-tier': 'Pro',
      'g1-ultra-tier': 'Ultra',
      'g1-ultra-lite-tier': 'Ultra Lite',
    };
    return knownPlans[tierId] || tierName || tierId || undefined;
  } catch {
    return undefined;
  }
};

async function callUpstreamQuota(
  file: AuthFile,
  provider: QuotaProvider,
  resolvedCodexAccountId?: string,
  responseClock?: { serverTimeOffsetMs?: number },
): Promise<unknown> {
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  if (!authIndex) throw new Error(quotaText('quota.service.error.missingAuthIndex'));
  const header = { ...headersByProvider[provider] };
  if (provider === 'codex') {
    const accountId = resolvedCodexAccountId ?? await resolveCodexAccountId(file);
    if (accountId) header['Chatgpt-Account-Id'] = accountId;
  }
  const project = provider === 'antigravity' ? await resolveProjectId(file) : '';
  if (provider === 'antigravity' && !project) {
    throw new Error(quotaText('quota.service.error.missingProject'));
  }
  const urls = provider === 'antigravity'
    ? [endpointByProvider.antigravity, 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary', 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary']
    : [endpointByProvider[provider]];
  let lastError = '';
  let hadSuccessfulResponse = false;
  for (const url of urls) {
    try {
      const payload = await requestQuotaPayload(
        authIndex,
        url,
        header,
        provider === 'antigravity' ? 'POST' : 'GET',
        project ? JSON.stringify({ project }) : undefined,
        undefined,
        provider === 'antigravity' ? responseClock : undefined,
      );
      if (provider === 'antigravity') {
        hadSuccessfulResponse = true;
        if (quotaRowsFor('antigravity', payload).length === 0) {
          lastError = quotaText('quota.service.error.antigravityEmpty');
          continue;
        }
      }
      return payload;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(
    lastError || quotaText(
      hadSuccessfulResponse
        ? 'quota.service.error.upstreamEmpty'
        : 'quota.service.error.noResponse',
    ),
  );
}

const requestCodexResetCredits = async (file: AuthFile, accountId: string): Promise<Record<string, unknown>> => {
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  if (!authIndex) throw new Error(quotaText('quota.service.error.missingResetAuthIndex'));
  const header: Record<string, string> = {
    ...headersByProvider.codex,
    Accept: 'application/json',
    'OpenAI-Beta': 'codex-1',
    Originator: 'Codex Desktop',
  };
  if (accountId) header['Chatgpt-Account-Id'] = accountId;
  const payload = await requestQuotaPayload(authIndex, CODEX_RESET_CREDITS_URL, header, 'GET', undefined, 8_000);
  if (!isRecord(payload) || !['credits', 'available_count', 'availableCount', 'applicable_available_count', 'applicableAvailableCount'].some((key) => key in payload)) {
    throw new Error(quotaText('quota.service.error.resetCreditsInvalid'));
  }
  return payload;
};

const callCodexResetCredits = async (file: AuthFile, accountId: string) =>
  codexResetCreditDetailsFor(await requestCodexResetCredits(file, accountId));

const callClaudeBankedReset = async (file: AuthFile): Promise<ReturnType<typeof claudeBankedResetFor>> => {
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  if (!authIndex) throw new Error(quotaText('quota.service.error.missingResetAuthIndex'));
  const payload = await requestQuotaPayload(authIndex, CLAUDE_BANKED_RESETS_URL, claudeCodeHeaders, 'GET', undefined, 8_000);
  if (!isRecord(payload) || !CLAUDE_USAGE_FIELDS.some((field) => field in payload)) {
    throw new Error(quotaText('quota.service.error.bankedResetsInvalid'));
  }
  return claudeBankedResetFor(payload);
};

/**
 * Claude accounts offered banked resets since launch. Most accounts never are,
 * so a failed check is only worth reporting on these.
 */
const claudeBankedResetAccounts = new Set<string>();

async function loadQuotaSnapshot(file: AuthFile): Promise<QuotaState> {
  const provider = providerForFile(file);
  if (!provider) {
    return {
      status: 'error',
      rows: [],
      error: quotaText('quota.service.error.unsupportedProvider'),
    };
  }
  try {
    // A turned-off account is read too: the core keeps its sign-in fresh, and Accounts shows its limits grayed out.
    const codexMetadata = provider === 'codex' ? codexMetadataFor(file) : undefined;
    const codexAccountId = codexMetadata?.accountId || '';
    const responseClock: { serverTimeOffsetMs?: number } = {};
    const payloadPromise = provider === 'xai'
      ? callXaiQuota(file)
      : callUpstreamQuota(file, provider, codexAccountId, responseClock);
    const planPromise = provider === 'claude'
      ? loadClaudePlan(file)
      : provider === 'antigravity'
        ? loadAntigravityPlan(file)
        : Promise.resolve(undefined);
    let resetCreditsError: string | undefined;
    const resetCreditsPromise = provider === 'codex'
      ? callCodexResetCredits(file, codexAccountId).catch((error) => {
        resetCreditsError = error instanceof Error ? error.message : String(error);
        return null;
      })
      : Promise.resolve(null);
    let bankedResetError: string | undefined;
    const bankedResetPromise = provider === 'claude'
      ? callClaudeBankedReset(file).catch((error) => {
        bankedResetError = error instanceof Error ? error.message : String(error);
        return null;
      })
      : Promise.resolve(null);
    const [payload, detectedPlan, resetCreditDetails, bankedReset] = await Promise.all([
      payloadPromise,
      planPromise,
      resetCreditsPromise,
      bankedResetPromise,
    ]);
    const rows = quotaRowsFor(provider, payload);
    if (rows.length === 0) {
      return {
        status: 'error',
        rows: [],
        error: quotaText('quota.service.error.unrecognized'),
      };
    }
    if (provider === 'claude') {
      const key = quotaKey(file);
      if (bankedReset?.resetCredits !== undefined) claudeBankedResetAccounts.add(key);
      else if (bankedReset && !bankedReset.error) claudeBankedResetAccounts.delete(key);
      const failure = bankedResetError ?? bankedReset?.error;
      if (failure && claudeBankedResetAccounts.has(key)) resetCreditsError = failure;
    }
    const resetCredits = provider === 'codex'
      ? resetCreditDetails?.availableCount ?? codexResetCreditsFor(payload)
      : bankedReset?.resetCredits;
    const usageCreditDetails = provider === 'codex' && isRecord(payload)
      ? codexResetCreditDetailsFor(payload.rate_limit_reset_credits ?? payload.rateLimitResetCredits)
      : {};
    return {
      status: 'success',
      rows,
      plan: detectedPlan
        ?? (readString(isRecord(payload) ? payload : {}, 'plan_type', 'planType') || codexMetadata?.plan),
      subscriptionActiveUntil: codexMetadata?.subscriptionActiveUntil,
      resetCreditsError,
      resetCreditsApplicable: provider === 'codex'
        ? usageCreditDetails.applicableAvailableCount ?? resetCreditDetails?.applicableAvailableCount ?? resetCredits
        : undefined,
      resetCredits,
      resetCreditsEarliestExpiry: resetCreditDetails?.earliestExpiry ?? bankedReset?.resetCreditsEarliestExpiry,
      bankedReset: bankedReset?.bankedReset,
      serverTimeOffsetMs: responseClock.serverTimeOffsetMs,
      fetchedAt: Date.now(),
    };
  } catch (error) {
    return {
      status: 'error',
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const createRedeemRequestId = () => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
};

async function consumeCodexResetCreditSnapshot(file: AuthFile): Promise<QuotaState> {
  if (providerForFile(file) !== 'codex') {
    throw new Error(quotaText('quota.service.error.codexResetOnly'));
  }
  if (booleanValue(file.disabled) === true) throw new Error(quotaText('quota.fileDisabled'));
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  if (!authIndex) throw new Error(quotaText('quota.service.error.missingConsumeAuthIndex'));
  const header = {
    ...headersByProvider.codex,
  };
  const accountId = await resolveCodexAccountId(file);
  if (accountId) header['Chatgpt-Account-Id'] = accountId;
  // T3 Code also keys a redemption by the ChatGPT account, so both apps send one credit under one id.
  // Not fileName(): its stand-in for a file with no name is the same for every such file.
  const account = accountId || readString(file, 'name') || authIndex;
  // An unconfirmed try is kept per login, not per account id: every seat of a ChatGPT Team workspace shares that
  // id, and one seat's redemption must never be resent, or settled, through another's.
  const attempt = `${account}:${quotaKey(file)}`;
  const finish = async (
    status: 'success' | 'not-used' | 'error',
    message: string,
    warning?: string,
  ): Promise<QuotaState> => ({
    ...await loadQuotaSnapshot(file),
    actionResult: { action: 'reset', status, message, ...(warning ? { warning } : {}) },
  });

  // Trying again soon after an unconfirmed redemption resends it unchanged, even
  // if the credit it named has since left the list because it was spent.
  const retry = unsettledCodexRedeem(attempt);
  let redeem: UnsettledCodexRedeem;
  if (retry) {
    redeem = retry;
  } else {
    // Without the list, Codex picks the credit and the kept id stands in for a derived one.
    const credit = await requestCodexResetCredits(file, accountId).then((payload) => nextCodexResetCredit(payload), () => undefined);
    redeem = credit
      ? {
        requestId: await codexRedeemRequestId(account, credit.id).catch(() => createRedeemRequestId()),
        creditId: credit.id,
        atMs: Date.now(),
      }
      : { requestId: createRedeemRequestId(), atMs: Date.now() };
  }
  rememberCodexRedeem(attempt, redeem);
  const unsettled = (error = '') => finish('error', quotaText(
    retry ? 'quota.codexReset.result.stillUnconfirmed' : 'quota.codexReset.result.unconfirmed',
    { detail: error ? ` (${error})` : '' },
  ));

  let response: Record<string, unknown>;
  try {
    response = await managementApi.post<Record<string, unknown>>('/api-call', {
      authIndex,
      method: 'POST',
      url: CODEX_RESET_CREDITS_CONSUME_URL,
      header,
      data: JSON.stringify({
        redeem_request_id: redeem.requestId,
        ...(redeem.creditId ? { credit_id: redeem.creditId } : {}),
      }),
    }, { timeoutMs: 25_000 });
  } catch (error) {
    // The redemption may have reached Codex before the reply was lost.
    return unsettled(error instanceof Error ? error.message : String(error));
  }
  const httpStatus = Number(response.status_code ?? response.statusCode ?? 0);
  if (httpStatus === 401 || httpStatus === 403 || (httpStatus === 429 && !retry)) {
    // Refused, so nothing was spent now. An earlier try whose reply was lost stays unknown.
    if (!retry) settleCodexRedeem(attempt);
    return finish('not-used', quotaText(httpStatus === 429 ? 'quota.codexReset.result.rateLimited' : 'quota.codexReset.result.auth'));
  }
  if (httpStatus < 200 || httpStatus >= 300) return unsettled(apiCallErrorMessage(response));
  const outcome = codexConsumeOutcome(parseBody(response.body ?? response.bodyText));
  if (!outcome) return unsettled();
  settleCodexRedeem(attempt);
  if (outcome === 'nothing_to_reset') {
    return finish('not-used', quotaText(retry ? 'quota.codexReset.result.nothingToResetAfterRetry' : 'quota.codexReset.result.nothingToReset'));
  }
  if (outcome === 'no_credit') {
    return finish('not-used', quotaText(retry ? 'quota.codexReset.result.noCreditAfterRetry' : 'quota.codexReset.result.noCredit'));
  }
  // The core keeps resting the account after the limit it hit. This clears that
  // rest in the core alone (nothing goes to Codex), so it routes again now.
  const proxyTold = await managementApi.post('/reset-quota', { auth_index: authIndex }, { timeoutMs: 10_000 })
    .then(() => true, () => false);
  return finish(
    'success',
    quotaText(outcome === 'reset'
      ? 'quota.codexReset.result.reset'
      : retry ? 'quota.codexReset.result.earlierReset' : 'quota.codexReset.result.alreadyRedeemed'),
    proxyTold ? undefined : quotaText('quota.codexReset.result.proxyNotTold'),
  );
}

const CLAUDE_CLAIM_RESULTS = ['reset', 'already_used', 'not_limited', 'cooldown', 'ineligible', 'unavailable'];
/** How long Claude Code keeps an unconfirmed claim's request id for a retry. */
const CLAUDE_UNSETTLED_CLAIM_MS = 600_000;
/**
 * Claims with an unknown outcome, by account. Trying the same reset again soon
 * after reuses the request id, so Claude sees the same claim and can't spend
 * a second reset on it.
 */
const unsettledClaudeClaims = new Map<string, { grantId: string; requestId: string; atMs: number }>();

async function claimClaudeBankedResetSnapshot(
  file: AuthFile,
  expected: { grantId: string; earlyUse: boolean },
): Promise<QuotaState> {
  if (providerForFile(file) !== 'claude') throw new Error(quotaText('quota.service.error.claudeResetOnly'));
  if (booleanValue(file.disabled) === true) throw new Error(quotaText('quota.fileDisabled'));
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  if (!authIndex) throw new Error(quotaText('quota.service.error.missingConsumeAuthIndex'));
  if (!CLAUDE_GRANT_ID.test(expected.grantId)) throw new Error(quotaText('quota.service.error.bankedResetsInvalid'));
  const key = quotaKey(file);
  const finish = async (
    status: 'success' | 'not-used' | 'error',
    message: string,
    refresh = true,
  ): Promise<QuotaState> => ({
    ...(refresh ? await loadQuotaSnapshot(file) : { status: 'error' as const, rows: [] }),
    actionResult: { action: 'reset', status, message },
  });

  // Claim only the reset that was confirmed, and only while the limits still
  // match the confirmation: a reset spent before reaching a limit is gone.
  let organization: string;
  let weeklyResetsAt: string | undefined;
  try {
    const [current, profile] = await Promise.all([
      callClaudeBankedReset(file),
      requestQuotaPayload(authIndex, CLAUDE_PROFILE_URL, headersByProvider.claude),
    ]);
    if (current.error) throw new Error(current.error);
    const offered = current.bankedReset;
    if (offered?.grantId !== expected.grantId || (offered.earlyUse !== undefined && !expected.earlyUse)) {
      return finish('not-used', quotaText('quota.bankedReset.result.changed'));
    }
    weeklyResetsAt = offered.weeklyResetsAt;
    organization = readString(isRecord(profile) ? profile.organization : null, 'uuid');
  } catch (error) {
    return finish('not-used', quotaText('quota.bankedReset.result.checkFailed', {
      error: error instanceof Error ? error.message : String(error),
    }), false);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(organization)) {
    return finish('not-used', quotaText('quota.bankedReset.result.noOrganization'), false);
  }

  const earlier = unsettledClaudeClaims.get(key);
  const retry = earlier && earlier.grantId === expected.grantId
    && Date.now() - earlier.atMs < CLAUDE_UNSETTLED_CLAIM_MS ? earlier : undefined;
  const requestId = retry?.requestId ?? createRedeemRequestId();
  const unsettled = (error = '') => {
    unsettledClaudeClaims.set(key, { grantId: expected.grantId, requestId, atMs: retry?.atMs ?? Date.now() });
    return finish('error', quotaText(retry ? 'quota.bankedReset.result.stillUnconfirmed' : 'quota.bankedReset.result.unconfirmed', {
      detail: error ? ` (${error})` : '',
    }));
  };
  let response: Record<string, unknown>;
  try {
    response = await managementApi.post<Record<string, unknown>>('/api-call', {
      authIndex,
      method: 'POST',
      url: claudeResetClaimUrl(organization),
      header: claudeCodeHeaders,
      data: JSON.stringify({ program: 'cedar_ember', grant_id: expected.grantId, request_id: requestId }),
    }, { timeoutMs: 25_000 });
  } catch (error) {
    // The claim may have reached Claude before the reply was lost.
    return unsettled(error instanceof Error ? error.message : String(error));
  }
  const httpStatus = Number(response.status_code ?? response.statusCode ?? 0);
  if (httpStatus === 429) {
    return retry
      ? finish('error', quotaText('quota.bankedReset.result.unconfirmed', { detail: '' }))
      : finish('not-used', quotaText('quota.bankedReset.result.rateLimited'));
  }
  if (httpStatus === 401 || httpStatus === 403) return finish('not-used', quotaText('quota.bankedReset.result.auth'));
  if (httpStatus < 200 || httpStatus >= 300) return unsettled(apiCallErrorMessage(response));
  const body = parseBody(response.body ?? response.bodyText);
  if (!isRecord(body)) return unsettled();
  const result = readString(body, 'result');
  const outcome = CLAUDE_CLAIM_RESULTS.includes(result) ? result : 'unavailable';
  if (outcome === 'unavailable') return unsettled();
  // A cooldown after an unconfirmed claim may be that claim still going through.
  if (outcome !== 'cooldown' || !retry) unsettledClaudeClaims.delete(key);
  switch (outcome) {
    case 'reset': {
      const weekly = readString(body, 'weekly_resets_at') || weeklyResetsAt;
      return finish('success', weekly
        ? quotaText('quota.bankedReset.result.resetWeekly', { time: formatQuotaTimestamp(weekly) })
        : quotaText('quota.bankedReset.result.reset'));
    }
    case 'already_used':
      return retry
        ? finish('success', quotaText('quota.bankedReset.result.earlierReset'))
        : finish('not-used', quotaText('quota.bankedReset.result.alreadyUsed'));
    case 'cooldown':
      return finish('not-used', quotaText(retry ? 'quota.bankedReset.result.cooldownAfterRetry' : 'quota.bankedReset.result.cooldown'));
    case 'not_limited':
      return finish('not-used', quotaText(retry ? 'quota.bankedReset.result.goneAfterRetry' : 'quota.bankedReset.result.notLimited'));
    default:
      return finish('not-used', quotaText(retry ? 'quota.bankedReset.result.goneAfterRetry' : 'quota.bankedReset.result.gone'));
  }
}

const quotaRequests = new Map<string, Promise<QuotaState>>();
const quotaMutationRequests = new Map<string, Promise<QuotaState>>();

export function loadQuota(file: AuthFile): Promise<QuotaState> {
  const key = quotaKey(file);
  const reset = quotaMutationRequests.get(key);
  if (reset) return reset.catch((error): QuotaState => ({
    status: 'error', rows: [], error: error instanceof Error ? error.message : String(error),
  }));
  const existing = quotaRequests.get(key);
  if (existing) return existing;
  const request = loadQuotaSnapshot(file).finally(() => {
    if (quotaRequests.get(key) === request) quotaRequests.delete(key);
  });
  quotaRequests.set(key, request);
  return request;
}

function runQuotaMutation(file: AuthFile, mutate: () => Promise<QuotaState>): Promise<QuotaState> {
  const key = quotaKey(file);
  const existing = quotaMutationRequests.get(key);
  if (existing) return existing;
  const request = (async () => {
    await quotaRequests.get(key);
    return mutate();
  })().finally(() => {
    if (quotaMutationRequests.get(key) === request) quotaMutationRequests.delete(key);
  });
  quotaMutationRequests.set(key, request);
  return request;
}

export function consumeCodexResetCredit(file: AuthFile): Promise<QuotaState> {
  return runQuotaMutation(file, () => consumeCodexResetCreditSnapshot(file));
}

/** Uses the Claude banked reset that was confirmed. `earlyUse` is whether the confirmation warned it would be spent early. */
export function claimClaudeBankedReset(file: AuthFile, expected: { grantId: string; earlyUse: boolean }): Promise<QuotaState> {
  return runQuotaMutation(file, () => claimClaudeBankedResetSnapshot(file, expected));
}

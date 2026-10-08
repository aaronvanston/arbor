import { translate } from '../i18n';
import { isRecord, normalizeAuthIndex } from './managementApi';
import { codexMetadataFor } from './quotaMetadata';
import { headersByProvider, quotaFailure, requestQuotaPayload, type AuthFile } from './quotaService';

/*
 * Loaded only when `arbor` asks for it, so none of this weighs on the window's launch.
 */

/** What ChatGPT's profile page reads: the account's own token counts. Undocumented, like `/wham/usage`. */
const CODEX_PROFILE_URL = 'https://chatgpt.com/backend-api/wham/profiles/me';

/**
 * What ChatGPT counts for a Codex sign-in, as its profile page shows it: tokens over the account's whole life, the
 * busiest day, streaks and a token total a day. It's the account's own count, so it takes in Codex used anywhere,
 * which the session archive can only count where it keeps transcripts. Names, the picture and the skills used are left
 * out; only numbers come back.
 */
export type CodexProfile = {
  lifetimeTokens: number;
  peakDailyTokens: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  threads: number | null;
  longestTurnSec: number | null;
  fastModePercent: number | null;
  reasoningEffort: string | null;
  reasoningEffortPercent: number | null;
  skillsUsed: number | null;
  uniqueSkillsUsed: number | null;
  /** yyyy-mm-dd, the day ChatGPT's count is up to. */
  asOf: string | null;
  /** Oldest first, as ChatGPT buckets them. */
  days: Array<{ day: string; tokens: number }>;
};

const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** The profile from `/wham/profiles/me`'s answer, or null when it doesn't carry a lifetime count. */
export function codexProfileFor(payload: unknown): CodexProfile | null {
  if (!isRecord(payload) || !isRecord(payload.stats)) return null;
  const { stats } = payload;
  const lifetimeTokens = count(stats.lifetime_tokens);
  if (lifetimeTokens === null) return null;
  const metadata = isRecord(payload.metadata) ? payload.metadata : {};
  const buckets = Array.isArray(stats.daily_usage_buckets) ? stats.daily_usage_buckets : [];
  return {
    lifetimeTokens,
    peakDailyTokens: count(stats.peak_daily_tokens),
    currentStreakDays: count(stats.current_streak_days),
    longestStreakDays: count(stats.longest_streak_days),
    threads: count(stats.total_threads),
    longestTurnSec: count(stats.longest_running_turn_sec),
    fastModePercent: count(stats.fast_mode_usage_percentage),
    reasoningEffort: text(stats.most_used_reasoning_effort),
    reasoningEffortPercent: count(stats.most_used_reasoning_effort_percentage),
    skillsUsed: count(stats.total_skills_used),
    uniqueSkillsUsed: count(stats.unique_skills_used),
    asOf: text(metadata.stats_as_of),
    days: buckets.flatMap((bucket) => {
      if (!isRecord(bucket)) return [];
      const day = text(bucket.start_date);
      const tokens = count(bucket.tokens);
      return day && tokens !== null ? [{ day, tokens }] : [];
    }),
  };
}

/** ChatGPT's own token counts for a Codex sign-in, read through the core so its token never leaves it. */
export async function loadCodexProfile(file: AuthFile): Promise<CodexProfile> {
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  if (!authIndex) throw new Error(translate('quota.service.error.missingAuthIndex'));
  const header: Record<string, string> = { ...headersByProvider.codex, Accept: 'application/json' };
  const accountId = codexMetadataFor(file).accountId;
  if (accountId) header['Chatgpt-Account-Id'] = accountId;
  let payload: unknown;
  try {
    payload = await requestQuotaPayload(authIndex, CODEX_PROFILE_URL, header, 'GET', undefined, 15_000);
  } catch (error) {
    throw new Error(quotaFailure(error));
  }
  const profile = codexProfileFor(payload);
  if (!profile) throw new Error(translate('quota.service.error.profileInvalid'));
  return profile;
}

type ProfileAccount = { id: string; name: string; state: string; file: AuthFile; key: string };

/**
 * Each account's counts, a failure kept on its own row, and a total. A ChatGPT account signed in more than once
 * answers with the same counts each time, so the total takes it once.
 */
export async function readCodexProfiles(accounts: ProfileAccount[], hash: (value: string) => string) {
  const read = await Promise.all(accounts.map(async ({ id, name, state, file, key }) => {
    // Which ChatGPT account the sign-in is, hashed like the id so sign-ins of one account can be told apart.
    const shown = { id, name, state, chatgptAccount: hash(codexMetadataFor(file).accountId || key) };
    try {
      return { ...shown, profile: await loadCodexProfile(file), error: null };
    } catch (error) {
      return { ...shown, profile: null, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const counted = new Map(read.flatMap((row) => (row.profile ? [[row.chatgptAccount, row.profile.lifetimeTokens] as const] : [])));
  return { lifetimeTokens: [...counted.values()].reduce((sum, tokens) => sum + tokens, 0), accounts: read };
}

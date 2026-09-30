import type { MessageKey, MessageVariables } from '../i18n/resources';
import { formatCount, formatMoney } from '../lib/format';
import { savedStore, sharedStore, storedRecord } from './savedStore';
import { sessionClient } from './usageSessions';
import type { UsageSession, UsageSessionPage } from '../native/types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How far back a session's tokens are counted. */
export const HEAVY_SESSION_WINDOW_MS = HOUR;
/** Back over the threshold after this long under it, a session is worth another notification. */
const EPISODE_GAP_MS = HOUR;

/** A session that used at least the threshold in the last hour, subagents included. */
export type HeavySession = {
  id: string;
  /** The client, such as Claude Code or Codex CLI, and the app it ran in. */
  client: string | null;
  host: string | null;
  machine: string;
  apiKeyHash: string;
  tokens: number;
  requests: number;
  /** What the hour's requests would cost at API prices; null when some of them had no price. */
  cost: number | null;
  /** Other sessions that sent requests with the same key in the hour. */
  otherKeySessions: number;
};

/** The sessions in `page` that used at least `thresholdTokens`. The page holds the last hour's sessions. */
export function heavySessions(page: UsageSessionPage, thresholdTokens: number | ((session: UsageSession) => number)): HeavySession[] {
  const threshold = typeof thresholdTokens === 'number' ? () => thresholdTokens : thresholdTokens;
  return page.items
    .filter((session) => {
      // Each project and machine can have its own threshold (Settings › Notifications scoped to it); 0 is off there.
      const tokens = threshold(session);
      return tokens > 0 && session.totalTokens >= tokens;
    })
    .map((session) => {
      const client = sessionClient(session.userAgent);
      return {
        id: session.id,
        client: client?.name ?? null,
        host: client?.host ?? null,
        machine: session.machine,
        apiKeyHash: session.apiKeyHash,
        tokens: session.totalTokens,
        requests: session.requests,
        cost: session.pricedRequests >= session.requests ? session.estimatedCost : null,
        otherKeySessions: session.apiKeyHash
          ? page.items.filter((other) => other.id !== session.id && other.apiKeyHash === session.apiKeyHash).length
          : 0,
      };
    })
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * Picks the sessions to notify about. `seen` maps each session to when it was
 * last over the threshold: a session is mentioned when it goes over, and again
 * only after an hour under it. Entries are dropped a day after that.
 */
export function nextHeavyNotifications(seen: Record<string, number>, items: HeavySession[], nowMs: number) {
  const next = Object.fromEntries(Object.entries(seen).filter(([, seenMs]) => seenMs > nowMs - DAY));
  const fresh = items.filter((item) => {
    const last = next[item.id];
    next[item.id] = nowMs;
    return last === undefined || nowMs - last > EPISODE_GAP_MS;
  });
  const changed = items.length > 0 || Object.keys(next).length !== Object.keys(seen).length;
  return { seen: next, fresh, changed };
}

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/** The title and text a heavy session is announced with, in notifications and the banner. */
export function heavySessionText(session: HeavySession, t: Translate) {
  const client = session.client
    ? session.host ? t('notifications.heavySession.clientIn', { client: session.client, host: session.host }) : session.client
    : t('notifications.heavySession.unknownClient');
  const tokens = formatCount(session.tokens);
  return {
    title: session.machine ? t('notifications.heavySession.title', { machine: session.machine }) : t('notifications.heavySession.titleNoMachine'),
    body: session.cost === null
      ? t('notifications.heavySession.bodyNoCost', { client, tokens })
      : t('notifications.heavySession.body', { client, tokens, cost: formatMoney(session.cost) }),
  };
}

const latest = sharedStore<HeavySession[]>([]);

/** The heavy sessions from the latest check, for the banner. */
export const useHeavySessions = latest.useValue;

export function setHeavySessions(items: HeavySession[]) {
  if (JSON.stringify(items) !== JSON.stringify(latest.get())) latest.set(items);
}

const parseDismissed = (raw: string | null): Record<string, number> =>
  Object.fromEntries(Object.entries(storedRecord(raw)).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));

const dismissed = savedStore<Record<string, number>>({ key: 'arbor.heavy-sessions-dismissed.v1', parse: parseDismissed, fallback: {} });

/** Sessions whose banner was closed, by when; a dismissal is forgotten after a day. */
export const useDismissedHeavySessions = dismissed.useValue;

export function dismissHeavySession(id: string, nowMs = Date.now()) {
  const next = Object.fromEntries(Object.entries(dismissed.get()).filter(([, atMs]) => atMs > nowMs - DAY));
  next[id] = nowMs;
  dismissed.set(next);
}

/** Going over the threshold again brings a closed banner back, along with the notification. */
export function undismissHeavySessions(ids: string[]) {
  const current = dismissed.get();
  if (!ids.some((id) => current[id] !== undefined)) return;
  const next = { ...current };
  ids.forEach((id) => delete next[id]);
  dismissed.set(next);
}

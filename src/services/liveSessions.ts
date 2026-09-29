import { useSyncExternalStore } from 'react';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import { formatDuration, formatMoney, formatTokens } from '../lib/format';
import { sessionClient, sessionPlace, shortSessionId } from './usageSessions';
import type { LiveContext, LiveSessionsReport, UsageSession } from '../native/types';

/** Sessions are running while they've made a request in the last this long, as `get_live_sessions` counts them. */
export const LIVE_ACTIVE_MS = 5 * 60_000;
/** A compaction this close is worth a line in the tray. */
export const TRAY_FORECAST_MS = 30 * 60_000;
/** The busiest sessions the tray lists, under the line for them all. */
export const TRAY_SESSION_LINES = 3;
const TRAY_NAME_CHARS = 32;

/** How far a conversation is on the way to its compaction point, from 0 to 1; null without a point. */
export const contextShare = (context: LiveContext) =>
  context.compactsAt ? Math.min(1, context.tokens / context.compactsAt) : null;

/** What to say about when a conversation compacts: `due` once it's there, `soon` within the tray's reach. */
export type CompactionOutlook = { kind: 'due' } | { kind: 'in'; ms: number; soon: boolean } | null;

export function compactionOutlook(context: LiveContext): CompactionOutlook {
  if (context.compactsInMs === null) return null;
  if (context.compactsInMs <= 0) return { kind: 'due' };
  return { kind: 'in', ms: context.compactsInMs, soon: context.compactsInMs <= TRAY_FORECAST_MS };
}

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** A session's name where there's only room for a few words: its title, else its project, client or short id. */
export function liveSessionName(session: UsageSession) {
  const title = session.transcript?.title?.trim();
  if (title) return title;
  const place = sessionPlace(session.transcript);
  if (place) return place.branch && place.branch !== place.project ? `${place.project} · ${place.branch}` : place.project;
  return sessionClient(session.userAgent)?.name ?? shortSessionId(session.id);
}

/**
 * The tray menu's lines for the running sessions: one for them all, then one each for the costliest few with how
 * full their conversation is, what they're spending and, when it's close, when they'll compact.
 */
export function liveTrayLines(report: LiveSessionsReport | null, t: Translate): string[] {
  if (!report?.running) return [];
  const count = report.running;
  const header = report.pricedRequests
    ? t(count === 1 ? 'tray.sessions.running.one' : 'tray.sessions.running.other', { count, cost: formatMoney(report.costPerHour) })
    : t(count === 1 ? 'tray.sessions.runningNoCost.one' : 'tray.sessions.runningNoCost.other', { count });
  const lines = report.sessions.slice(0, TRAY_SESSION_LINES).map((session) => {
    const share = contextShare(session.context);
    const outlook = compactionOutlook(session.context);
    return [
      truncate(liveSessionName(session), TRAY_NAME_CHARS),
      share !== null
        ? t('tray.sessions.contextShare', { percent: Math.round(share * 100) })
        : session.context.tokens ? t('tray.sessions.context', { tokens: formatTokens(session.context.tokens) }) : '',
      session.pricedRequests ? t('tray.sessions.costPerHour', { cost: formatMoney(session.estimatedCost) }) : '',
      outlook?.kind === 'due'
        ? t('tray.sessions.compactsNow')
        : outlook?.soon ? t('tray.sessions.compactsIn', { time: formatDuration(outlook.ms) }) : '',
    ].filter(Boolean).join(' · ');
  });
  return [header, ...lines];
}

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const emitChange = () => listeners.forEach((listener) => listener());

/** Null until the first check. A failed check keeps the last one. */
let current: LiveSessionsReport | null = null;
const getCurrent = () => current;

/** The running sessions from the latest check that worked, for Home's board. */
export const useLiveSessions = () => useSyncExternalStore(subscribe, getCurrent, getCurrent);

export function setLiveSessions(report: LiveSessionsReport) {
  if (JSON.stringify(report) === JSON.stringify(current)) return;
  current = report;
  emitChange();
}

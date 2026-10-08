import { useSyncExternalStore } from 'react';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import { formatDuration, formatMoney, formatTokens } from '../lib/format';
import { sessionClient, sessionPlace, shortSessionId } from './usageSessions';
import type { LiveContext, LiveSession, LiveSessionsReport, TrayDot, TrayRow, UsageSession } from '../native/types';

/** Sessions are running while they've made a request in the last this long, as `get_live_sessions` counts them. */
export const LIVE_ACTIVE_MS = 5 * 60_000;
/** A compaction this close is worth a line in the tray. */
export const TRAY_FORECAST_MS = 30 * 60_000;
/** The busiest sessions the tray lists, under the line for them all; the rest of the report's are in a sub-menu. */
export const TRAY_SESSION_LINES = 3;
/** Sessions waiting on you the tray lists, the most pressing first. */
export const TRAY_WAITING_LINES = 5;
/** A conversation this full gets an amber dot in the tray. */
const TRAY_FULL_SHARE = 0.8;
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
  return session.transcript?.title?.trim() || untitledSessionName(session);
}

/**
 * A session's name without its title, for what's kept or sent on, like alerts (the alert history keeps them and the
 * phone gets them): its project and branch, else its client or short id. Titles are only ever held in memory.
 */
export function untitledSessionName(session: UsageSession) {
  const place = sessionPlace(session.transcript);
  if (place) return place.branch && place.branch !== place.project ? `${place.project} · ${place.branch}` : place.project;
  return sessionClient(session.userAgent)?.name ?? shortSessionId(session.id);
}

/** A session waiting on you, as the tray names it. */
export type TrayWaitingSession = { name: string; status: 'approval' | 'question'; machine: string; sinceMs: number };

/** The running sessions by client, from their User-Agents: "12 Claude · 8 Codex · 1 other". */
export function clientCountsText(clients: readonly string[], t: Translate): string {
  const counts = { claude: 0, codex: 0, other: 0 };
  for (const userAgent of clients) {
    const name = sessionClient(userAgent)?.name.toLowerCase() ?? '';
    counts[name.startsWith('claude') ? 'claude' : name.startsWith('codex') ? 'codex' : 'other'] += 1;
  }
  return [
    counts.claude ? t('tray.agents.claude', { count: counts.claude }) : '',
    counts.codex ? t('tray.agents.codex', { count: counts.codex }) : '',
    counts.other ? t('tray.agents.other', { count: counts.other }) : '',
  ].filter(Boolean).join(' · ');
}

/** One running session: its name, how full its conversation is, what it's spending and, when it's close, when it compacts. */
function liveSessionRow(session: LiveSession, t: Translate, machine?: string): TrayRow {
  const share = contextShare(session.context);
  const outlook = compactionOutlook(session.context);
  const text = [
    truncate(liveSessionName(session), TRAY_NAME_CHARS),
    share !== null
      ? t('tray.sessions.contextShare', { percent: Math.round(share * 100) })
      : session.context.tokens ? t('tray.sessions.context', { tokens: formatTokens(session.context.tokens) }) : '',
    session.pricedRequests ? t('tray.sessions.costPerHour', { cost: formatMoney(session.estimatedCost) }) : '',
    outlook?.kind === 'due'
      ? t('tray.sessions.compactsNow')
      : outlook?.soon ? t('tray.sessions.compactsIn', { time: formatDuration(outlook.ms) }) : '',
    machine ?? '',
  ].filter(Boolean).join(' · ');
  const full = outlook?.kind === 'due' || outlook?.soon || (share !== null && share >= TRAY_FULL_SHARE);
  const dot: TrayDot = full ? 'amber' : 'blank';
  return { text, dot };
}

/**
 * The tray menu's rows for the sessions: a line for those running and what they spent, the split by client, then those
 * waiting on you, the costliest few, and the rest of the report's in a sub-menu.
 */
export function liveTrayRows(
  report: LiveSessionsReport | null,
  waiting: readonly TrayWaitingSession[],
  t: Translate,
  { nowMs = Date.now(), machineName = (machine: string) => machine }: { nowMs?: number; machineName?: (machine: string) => string } = {},
): TrayRow[] {
  const rows: TrayRow[] = [];
  const running = report?.running ?? 0;
  if (report && running) {
    rows.push({
      text: report.pricedRequests
        ? t(running === 1 ? 'tray.sessions.running.one' : 'tray.sessions.running.other', { count: running, cost: formatMoney(report.costPerHour) })
        : t(running === 1 ? 'tray.sessions.runningNoCost.one' : 'tray.sessions.runningNoCost.other', { count: running }),
    });
    const clients = clientCountsText(report.clients, t);
    if (clients) rows.push({ text: clients });
  }
  if (waiting.length) {
    rows.push({ text: t('tray.sessions.waitingHeader') });
    for (const session of waiting.slice(0, TRAY_WAITING_LINES)) {
      rows.push({
        text: [
          truncate(session.name, TRAY_NAME_CHARS),
          t(session.status === 'approval' ? 'fleet.status.approval' : 'fleet.status.question'),
          session.machine ? machineName(session.machine) : '',
          formatDuration(Math.max(0, nowMs - session.sinceMs)),
        ].filter(Boolean).join(' · '),
        dot: 'amber',
      });
    }
    if (waiting.length > TRAY_WAITING_LINES) rows.push({ text: t('tray.sessions.andMore', { count: waiting.length - TRAY_WAITING_LINES }) });
  }
  if (report && running) {
    const listed = report.sessions.slice(0, TRAY_SESSION_LINES);
    const rest = report.sessions.slice(TRAY_SESSION_LINES);
    if (waiting.length) rows.push({ text: t('tray.sessions.costliestHeader') });
    rows.push(...listed.map((session) => liveSessionRow(session, t)));
    const unlisted = running - report.sessions.length;
    if (rest.length) {
      rows.push({
        text: t('tray.sessions.more', { count: running - listed.length }),
        dot: 'blank',
        children: [
          ...rest.map((session) => liveSessionRow(session, t, session.machine ? machineName(session.machine) : undefined)),
          ...(unlisted > 0 ? [{ text: t('tray.sessions.andMore', { count: unlisted }) }] : []),
        ],
      });
    }
  }
  return rows;
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

import { useMemo, useSyncExternalStore } from 'react';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import { getFleetSources, type T3SkipReason } from './fleetSources';
import { LIVE_ACTIVE_MS, liveSessionName } from './liveSessions';
import { useQuotaClock } from './quotaTime';
import { savedStore } from './savedStore';
import { sessionClient, sessionPlace, shortSessionId } from './usageSessions';
import type {
  AttentionItem,
  FleetProxySession,
  FleetSources,
  T3Channel,
  T3ChannelKind,
  T3Thread,
  UsageSession,
} from '../native/types';

/**
 * Where a session is, most urgent first: asking for approval, asking a question, working, failed, done with a turn
 * nobody has looked at, or idle.
 */
export type FleetStatus = 'approval' | 'question' | 'working' | 'failed' | 'done' | 'idle';
export const FLEET_STATUS_ORDER: readonly FleetStatus[] = ['approval', 'question', 'working', 'failed', 'done', 'idle'];
/** What told Arbor about a session: T3 Code's database, a reporter's wait, the proxy's requests, or its transcript. */
export type FleetSourceKind = 't3' | 'reporter' | 'proxy' | 'transcript';
export type FleetClient = 't3code' | 'claudeCode' | 'claudeSdk' | 'codex' | 'other';
/**
 * What's worth saying beside the status: a plan ready to build, a turn T3 Code hasn't started yet, T3 Code no longer
 * running, or the machine not answering.
 */
export type FleetNote = 'planReady' | 'queued' | 't3Stopped' | 'machineQuiet';

/** One session on the board, from every source that knows it by the same stored id. */
export type FleetSession = {
  /** `t3:<machine>:<channel>:<threadId>` for a T3 Code thread, else `<agent>:<agentSessionId>`. Snoozes and seen marks are kept by it. */
  key: string;
  client: FleetClient;
  /** `T3 Code`, or the client as the Sessions list names it. */
  clientLabel: string;
  /** T3 Code's provider (`claudeAgent`, `codex`…), else the reporter's or proxy's (`claude`, `codex`). */
  agent: string | null;
  /** Empty when no source says. */
  machine: string;
  /** Keyed by its folder. */
  project: { key: string; name: string } | null;
  status: FleetStatus;
  sinceMs: number;
  note: FleetNote | null;
  /** Asking for approval or an answer, from a source that's still up to date, and not snoozed. */
  countsAsWaiting: boolean;
  /** Opens the session's page: its requests came through Arbor. */
  arborSessionId: string | null;
  /** Claude's session UUID or Codex's thread id. */
  agentSessionId: string | null;
  t3ThreadId: string | null;
  sources: FleetSourceKind[];
  snoozedUntilMs: number | null;
  snoozedBy: 'arbor' | 't3' | null;
  lastActiveMs: number;
  /** For its name and place, when its requests came through Arbor. */
  session: UsageSession | null;
};

/** A T3 Code database that wasn't read, and why. */
export type FleetSkipNote = { machine: string; channel: T3ChannelKind; reason: T3SkipReason; migration: number | null };
/** Rows with no folder are `Other`: a null key. */
export type FleetProject = { key: string | null; name: string | null; rows: FleetSession[] };
export type FleetMachine = {
  machine: string;
  thisMachine: boolean;
  /** Its rows that aren't idle, by project, the most urgent first. */
  projects: FleetProject[];
  /** Folded under the rest, the latest first. */
  idle: FleetSession[];
  skipped: FleetSkipNote[];
};
export type FleetBoard = {
  nowMs: number;
  t3Enabled: boolean;
  /** Some machine has T3 Code. Without it the board never mentions T3 Code. */
  t3Found: boolean;
  thisMachine: string;
  machines: FleetMachine[];
  /** Folded at the end, the soonest to wake first. */
  snoozed: FleetSession[];
  /** Every row, snoozed ones too. */
  rows: FleetSession[];
  /** Rows by status, leaving out the snoozed. */
  counts: Record<FleetStatus, number>;
};

/** How far back a session stays on the board once it's quiet: the same six hours a reporter's wait lasts. */
export const FLEET_WINDOW_MS = 6 * 60 * 60_000;
/** A message T3 Code hasn't started a turn for counts as work this long (T3 Code's QUEUED_TURN_START_GRACE_MS). */
const QUEUED_GRACE_MS = 2 * 60_000;
/** A session whose last request failed is Failed once it's been quiet this long, rather than retrying. */
const FAILED_QUIET_MS = 60_000;
/** Another machine's T3 Code threads are old news once it hasn't answered for this long. */
export const MACHINE_QUIET_MS = 2 * 60_000;
/** T3 Code's database versions Arbor reads, as `t3_threads.rs` checks them. */
export const T3_MIGRATIONS = { min: 34, max: 54 } as const;
/** Home's Needs you card is a short list: at most this many. */
export const NEEDS_YOU_LIMIT = 4;
/** And only what began this recently: older requests and finished turns are the board's. */
export const NEEDS_YOU_WINDOW_MS = 2 * 60 * 60_000;

const rank = (status: FleetStatus) => FLEET_STATUS_ORDER.indexOf(status);
const lastSegment = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;

/** `raisedAtMs` is when the newest thing it's asking about began, when that's later than `sinceMs`. */
type Verdict = { status: FleetStatus; sinceMs: number; note: FleetNote | null; raisedAtMs?: number };

/**
 * A message T3 Code hasn't started a turn for yet (T3 Code's hasQueuedTurnStart): newer than every time on the latest
 * turn, within the grace window either way (another device's clock can run ahead), and not after a failed start.
 */
function queuedTurnStart(thread: T3Thread, now: number) {
  const at = thread.latestUserMessageAtMs;
  if (at === null || thread.sessionStatus === 'error' || Math.abs(now - at) > QUEUED_GRACE_MS) return false;
  const { turn } = thread;
  if (!turn) return true;
  return [turn.requestedAtMs, turn.startedAtMs, turn.completedAtMs].every((time) => time === null || time < at);
}

/** When a thread's work started, as T3 Code times it (resolveWorkingStartedAt). */
function workingSince(thread: T3Thread) {
  const { turn } = thread;
  if (turn && turn.completedAtMs === null) return turn.startedAtMs ?? turn.requestedAtMs;
  return thread.sessionUpdatedAtMs ?? thread.updatedAtMs;
}

function t3LastActive(thread: T3Thread) {
  const { turn } = thread;
  return Math.max(
    thread.updatedAtMs,
    thread.sessionUpdatedAtMs ?? 0,
    thread.latestUserMessageAtMs ?? 0,
    thread.approvalSinceMs ?? 0,
    turn?.requestedAtMs ?? 0,
    turn?.startedAtMs ?? 0,
    turn?.completedAtMs ?? 0,
  );
}

/**
 * A T3 Code thread's status as T3 Code's sidebar puts it: pending approval, then input, then a running, starting or
 * queued turn, then a failed session, then a completed turn nobody has seen. Arbor's own seen mark stands in for
 * T3 Code's, which it keeps in the browser; a thread never seen counts as unseen. With T3 Code's server gone, work
 * can't be going on, so it's Failed as of its last activity, and what it was asking for stays but can't be answered.
 */
export function fleetStatus(thread: T3Thread, { now, serverRunning, seenMs = null }: { now: number; serverRunning: boolean; seenMs?: number | null }): Verdict {
  const stopped: FleetNote | null = serverRunning ? null : 't3Stopped';
  const updated = thread.sessionUpdatedAtMs ?? thread.updatedAtMs;
  if (thread.pendingApprovals > 0) {
    const sinceMs = thread.approvalSinceMs ?? updated;
    return { status: 'approval', sinceMs, raisedAtMs: Math.max(sinceMs, thread.latestApprovalAtMs ?? sinceMs), note: stopped };
  }
  if (thread.pendingQuestions > 0) return { status: 'question', sinceMs: thread.questionSeenAtMs ?? updated, note: stopped };
  const running = thread.sessionStatus === 'running' || thread.sessionStatus === 'starting';
  const queued = !running && queuedTurnStart(thread, now);
  if (running || queued) {
    // When T3 Code stopped isn't known, so it's timed by the last thing it recorded.
    if (!serverRunning) return { status: 'failed', sinceMs: t3LastActive(thread), note: 't3Stopped' };
    return queued
      ? { status: 'working', sinceMs: thread.latestUserMessageAtMs ?? updated, note: 'queued' }
      : { status: 'working', sinceMs: workingSince(thread), note: null };
  }
  if (thread.sessionStatus === 'error') return { status: 'failed', sinceMs: updated, note: null };
  const { turn } = thread;
  // T3 Code's Plan Ready: a plan-mode thread whose latest turn started and finished (however it ended) left a plan to
  // act on. It waits on a decision, so like a request it stays until that's made, whatever Arbor's seen mark says and
  // however old, unless the thread is filed away.
  if (
    thread.interactionMode === 'plan' && thread.hasActionablePlan && !thread.settled
    && turn !== null && turn.startedAtMs !== null && turn.completedAtMs !== null
  ) {
    return { status: 'done', sinceMs: turn.completedAtMs, note: 'planReady' };
  }
  if (
    turn?.state === 'completed' && turn.completedAtMs !== null && !thread.settled
    && (seenMs === null || turn.completedAtMs > seenMs) && now - turn.completedAtMs < FLEET_WINDOW_MS
  ) {
    return { status: 'done', sinceMs: turn.completedAtMs, note: null };
  }
  return { status: 'idle', sinceMs: t3LastActive(thread), note: null };
}

type Candidate = Verdict & { source: FleetSourceKind; stale: boolean };

/** A reporter's wait: asking for permission or an answer, or done with its turn until that's been seen. */
function reporterCandidate(item: AttentionItem, seenMs: number | null): Candidate | null {
  const base = { sinceMs: item.sinceMs, note: null, source: 'reporter' as const, stale: false };
  if (item.kind === 'permission') return { ...base, status: 'approval' };
  if (item.kind === 'question') return { ...base, status: 'question' };
  return seenMs !== null && item.sinceMs <= seenMs ? null : { ...base, status: 'done' };
}

type ProxyActivity = { startedAtMs: number; lastActiveAtMs: number; lastRequestFailed: boolean };

/**
 * What the proxy's requests say: Failed once its own last request failed and it's gone quiet, else Working while it
 * made one in the last few minutes after any turn the reporter says ended, else Idle.
 */
function proxyCandidate(activity: ProxyActivity, now: number, turnEndedMs: number | null): Candidate {
  const quiet = now - activity.lastActiveAtMs;
  const base = { note: null, source: 'proxy' as const, stale: false };
  if (activity.lastRequestFailed && quiet >= FAILED_QUIET_MS && quiet < FLEET_WINDOW_MS) {
    return { ...base, status: 'failed', sinceMs: activity.lastActiveAtMs };
  }
  if (quiet <= LIVE_ACTIVE_MS && (turnEndedMs === null || activity.lastActiveAtMs > turnEndedMs)) {
    return { ...base, status: 'working', sinceMs: activity.startedAtMs };
  }
  return { ...base, status: 'idle', sinceMs: activity.lastActiveAtMs };
}

/** The highest-ranked candidate; between two of the same rank, one still up to date. */
const bestOf = (candidates: (Candidate | null)[]) =>
  candidates.reduce<Candidate | null>((best, candidate) => {
    if (!candidate) return best;
    if (!best) return candidate;
    const byRank = rank(candidate.status) - rank(best.status);
    return byRank < 0 || (byRank === 0 && best.stale && !candidate.stale) ? candidate : best;
  }, null);

/** Snoozes Arbor keeps, by row key: when each wakes and when it was set. */
export type FleetSnooze = { untilMs: number; atMs: number };
export type FleetSnoozes = Record<string, FleetSnooze>;
/** When each row was last looked at, by row key. */
export type FleetSeen = Record<string, number>;
/** When each T3 Code thread asking a question was first seen asking, by row key: kept across restarts. */
export type FleetAsked = Record<string, number>;
/** What Arbor keeps about the rows between reads. */
type FleetMarks = { snoozes: FleetSnoozes; seen: FleetSeen; asked: FleetAsked };

const t3Key = (channel: T3Channel, thread: T3Thread) => `t3:${channel.machine}:${channel.channel}:${thread.threadId}`;

/**
 * The first-seen times of the questions T3 Code threads are asking, updated from a read: the backend's time counts
 * from when this run of Arbor first saw one, so the earlier one kept here wins, and a thread seen not asking starts
 * afresh. Threads not in the read keep theirs, so a restart or T3 Code threads being turned off and on doesn't make an
 * old question look new. The same object comes back when nothing changed.
 */
export function rememberQuestions(asked: FleetAsked, sources: FleetSources): FleetAsked {
  let next = asked;
  const set = (key: string, value: number | null) => {
    if ((asked[key] ?? null) === value) return;
    if (next === asked) next = { ...asked };
    if (value === null) delete next[key];
    else next[key] = value;
  };
  for (const channel of sources.t3) {
    for (const thread of channel.threads) {
      const key = t3Key(channel, thread);
      if (thread.pendingQuestions > 0) set(key, Math.min(asked[key] ?? Infinity, thread.questionSeenAtMs ?? sources.nowMs));
      else set(key, null);
    }
  }
  return next;
}

/** A row as a snooze sees it: what it is, since when, and when the newest thing it's asking about began. */
type SnoozeCheck = Pick<FleetSession, 'status' | 'sinceMs'> & { raisedAtMs?: number };

/**
 * Something new that outranks a snooze set at `atMs`: a request for approval or an answer, a failure or a done turn
 * since. A second approval asked for after it counts, though the first still waits.
 */
const raisedHand = (row: SnoozeCheck, atMs: number) =>
  row.status !== 'working' && row.status !== 'idle' && Math.max(row.sinceMs, row.raisedAtMs ?? row.sinceMs) > atMs;

/** T3 Code's own rule for a snoozed thread raising its hand (threadRaisedHandWhileSnoozed). */
function t3RaisedHand(thread: T3Thread) {
  const at = thread.t3SnoozedAtMs;
  if (thread.pendingApprovals > 0 || thread.pendingQuestions > 0) return true;
  if (thread.sessionStatus === 'error' && (at === null || (thread.sessionUpdatedAtMs ?? 0) > at)) return true;
  const { turn } = thread;
  return at !== null && turn?.state === 'completed' && turn.completedAtMs !== null && turn.completedAtMs > at;
}

/**
 * Whether a row is snoozed now, and by whom: by Arbor until its time unless something new has come up since it was
 * set, else by T3 Code's own snooze under T3 Code's rule (effectiveSnoozed). Unlike T3 Code, a row asking for
 * approval can be snoozed here: it only hides the row, and a new request after the snooze wakes it.
 */
export function effectiveSnooze(
  row: SnoozeCheck,
  { arbor, t3, now }: { arbor?: FleetSnooze; t3?: T3Thread | null; now: number },
): { untilMs: number; by: 'arbor' | 't3' } | null {
  if (arbor && arbor.untilMs > now && !raisedHand(row, arbor.atMs)) return { untilMs: arbor.untilMs, by: 'arbor' };
  const until = t3?.t3SnoozedUntilMs ?? null;
  if (t3 && until !== null && until > now && !t3RaisedHand(t3) && !(t3.t3SnoozedAtMs !== null && raisedHand(row, t3.t3SnoozedAtMs))) {
    return { untilMs: until, by: 't3' };
  }
  return null;
}

/** A row in the making: the sources that share its id. */
type Draft = {
  key: string;
  t3: { thread: T3Thread; channel: T3Channel } | null;
  /** Another T3 Code thread claims the same id, so this one links to nothing. */
  ambiguous: boolean;
  reporter: AttentionItem | null;
  proxy: FleetProxySession | null;
};

function clientOf(session: UsageSession | null, agent: string | null): { client: FleetClient; label: string } {
  const client = sessionClient(session?.userAgent);
  if (client) {
    const kind: FleetClient = client.name === 'Claude Code' ? 'claudeCode'
      : client.name === 'claude -p' || client.name === 'Claude Agent SDK' ? 'claudeSdk'
        : /codex/i.test(client.name) ? 'codex' : 'other';
    return { client: kind, label: client.name };
  }
  if (agent === 'claude') return { client: 'claudeCode', label: 'Claude Code' };
  if (agent === 'codex') return { client: 'codex', label: 'Codex' };
  return { client: 'other', label: agent ?? '' };
}

function projectOf(thread: T3Thread | null, session: UsageSession | null): FleetSession['project'] {
  if (thread?.workspaceRoot) return { key: thread.workspaceRoot, name: lastSegment(thread.workspaceRoot) };
  const transcript = session?.transcript;
  const key = transcript ? transcript.mainRepo || transcript.repoRoot || transcript.cwd : '';
  if (!key) return null;
  return { key, name: sessionPlace(transcript)?.project || lastSegment(key) };
}

/** Joins the sources into drafts by the exact ids they store: never by time, title, folder or machine, and never case-folded. */
function mergeSources(sources: FleetSources): Draft[] {
  const drafts: Draft[] = [];
  const claims = new Map<string, number>();
  for (const channel of sources.t3) {
    for (const thread of channel.threads) {
      if (thread.agentSessionId) claims.set(thread.agentSessionId, (claims.get(thread.agentSessionId) ?? 0) + 1);
    }
  }
  const byId = new Map<string, Draft>();
  for (const channel of sources.t3) {
    for (const thread of channel.threads) {
      const id = thread.agentSessionId;
      const ambiguous = Boolean(id && (claims.get(id) ?? 0) > 1);
      const draft: Draft = { key: t3Key(channel, thread), t3: { thread, channel }, ambiguous, reporter: null, proxy: null };
      drafts.push(draft);
      if (id && !ambiguous) byId.set(id, draft);
    }
  }
  for (const item of sources.attention.items) {
    const found = byId.get(item.sessionId);
    if (found && !found.reporter) {
      found.reporter = item;
      continue;
    }
    // A second wait for the same session is the less pressing one: the report lists the pressing first.
    if (found) continue;
    const draft: Draft = { key: `${item.agent}:${item.sessionId}`, t3: null, ambiguous: false, reporter: item, proxy: null };
    drafts.push(draft);
    byId.set(item.sessionId, draft);
  }
  for (const proxy of sources.sessions) {
    const found = byId.get(proxy.session.id);
    if (found && !found.proxy) {
      found.proxy = proxy;
      continue;
    }
    if (found) continue;
    const draft: Draft = { key: `${proxy.session.provider}:${proxy.session.id}`, t3: null, ambiguous: false, reporter: null, proxy };
    drafts.push(draft);
    byId.set(proxy.session.id, draft);
  }
  return drafts;
}

function rowOf(draft: Draft, sources: FleetSources, now: number, { snoozes, seen, asked }: FleetMarks): FleetSession {
  const { t3, reporter, proxy } = draft;
  const channel = t3?.channel ?? null;
  const firstAsked = asked[draft.key];
  // A question that was asking before this run of Arbor saw it keeps the time it was first seen then.
  const thread = t3 && firstAsked !== undefined && t3.thread.pendingQuestions > 0
    ? { ...t3.thread, questionSeenAtMs: Math.min(firstAsked, t3.thread.questionSeenAtMs ?? firstAsked) }
    : t3?.thread ?? null;
  const seenMs = seen[draft.key] ?? null;
  const quiet = channel !== null && channel.machine !== sources.thisMachine && now - channel.readAtMs > MACHINE_QUIET_MS;
  const t3Verdict = thread && channel ? fleetStatus(thread, { now, serverRunning: channel.serverRunning, seenMs }) : null;
  const t3Candidate: Candidate | null = t3Verdict && channel
    ? { ...t3Verdict, source: 't3', stale: !channel.serverRunning || quiet }
    : null;
  const t3Stopped = channel !== null && !channel.serverRunning;
  let reporterPick = reporter ? reporterCandidate(reporter, seenMs) : null;
  // T3 Code runs the agent, so with T3 Code gone the agent's wait can't be answered either, whatever its hooks said.
  if (reporterPick && t3Stopped) reporterPick = { ...reporterPick, stale: true, note: 't3Stopped' };
  const linked = thread && !draft.ambiguous ? thread.arborSession : null;
  const activity: ProxyActivity | null = proxy
    ? { startedAtMs: proxy.session.startedAtMs, lastActiveAtMs: proxy.session.lastActiveAtMs, lastRequestFailed: proxy.lastRequestFailed }
    : linked ? { startedAtMs: linked.lastActiveAtMs, lastActiveAtMs: linked.lastActiveAtMs, lastRequestFailed: linked.lastRequestFailed } : null;
  // Nor can its requests still be going on: T3 Code's own record says how the thread ended, and a request a minute
  // ago mustn't read as Working.
  const proxyPick = activity && !t3Stopped ? proxyCandidate(activity, now, reporter?.kind === 'waiting' ? reporter.sinceMs : null) : null;

  const lastActiveMs = Math.max(
    thread ? t3LastActive(thread) : 0,
    reporter?.sinceMs ?? 0,
    activity?.lastActiveAtMs ?? 0,
  );
  let pick: Candidate | null;
  if (t3Candidate && channel?.serverRunning && !quiet) {
    // A live T3 Code decides working, failed, done and idle. A reporter can still say it's asking for something, but
    // only when it asked after T3 Code was last read: T3 Code records a request before the agent's hook fires, so a
    // read since that shows nothing pending means it was answered (the hook never says so).
    const asking = reporterPick && reporterPick.status !== 'done' && reporterPick.sinceMs > channel.readAtMs ? reporterPick : null;
    pick = asking && rank(asking.status) < rank(t3Candidate.status) ? asking : t3Candidate;
  } else {
    pick = bestOf([t3Candidate, reporterPick, proxyPick]);
  }
  const verdict: Candidate = pick ?? { status: 'idle', sinceMs: lastActiveMs, note: null, source: reporter ? 'reporter' : 'proxy', stale: false };
  const note = verdict.source === 't3' && quiet ? 'machineQuiet' : verdict.note;

  const session = proxy?.session ?? reporter?.session ?? null;
  const agentSessionId = thread?.agentSessionId ?? reporter?.sessionId ?? proxy?.session.id ?? null;
  const arborSessionId = linked?.id ?? proxy?.session.id ?? (reporter?.session ? reporter.sessionId : null);
  const agent = thread?.provider ?? reporter?.agent ?? proxy?.session.provider ?? null;
  const { client, label } = thread ? { client: 't3code' as const, label: 'T3 Code' } : clientOf(session, agent);
  const kinds: FleetSourceKind[] = [
    ...(thread ? ['t3' as const] : []),
    ...(reporter ? ['reporter' as const] : []),
    ...(activity ? ['proxy' as const] : []),
    ...(session?.transcript ? ['transcript' as const] : []),
  ];
  const partial = { status: verdict.status, sinceMs: verdict.sinceMs, raisedAtMs: verdict.raisedAtMs };
  const snooze = effectiveSnooze(partial, { arbor: snoozes[draft.key], t3: thread, now });
  return {
    key: draft.key,
    client,
    clientLabel: label,
    agent,
    machine: channel?.machine ?? reporter?.machine ?? (session ? session.machine || session.transcript?.machine || '' : ''),
    project: projectOf(thread, session),
    status: verdict.status,
    sinceMs: verdict.sinceMs,
    note,
    countsAsWaiting: (verdict.status === 'approval' || verdict.status === 'question') && !verdict.stale && !snooze,
    arborSessionId,
    agentSessionId,
    t3ThreadId: thread?.threadId ?? null,
    sources: kinds,
    snoozedUntilMs: snooze?.untilMs ?? null,
    snoozedBy: snooze?.by ?? null,
    lastActiveMs,
    session,
  };
}

/** Approval, Question and Working longest first; Failed, Done and Idle latest first, a plan ready ahead of other Done. */
export function compareFleetRows(a: FleetSession, b: FleetSession) {
  const byStatus = rank(a.status) - rank(b.status);
  if (byStatus) return byStatus;
  // A plan waits on a decision, so it ranks above a turn that's only finished.
  const byPlan = Number(b.note === 'planReady') - Number(a.note === 'planReady');
  if (byPlan) return byPlan;
  const oldestFirst = a.status === 'approval' || a.status === 'question' || a.status === 'working';
  return (oldestFirst ? a.sinceMs - b.sinceMs : b.sinceMs - a.sinceMs) || a.key.localeCompare(b.key);
}

/**
 * The board's machines: this Mac first, then by name, with the rows no machine claims last. Within each, the rows
 * that aren't idle by project, the project with the most urgent row first and the rows without a folder under Other
 * at the end; idle rows fold apart. A machine whose T3 Code wasn't read is listed for the note, even with no rows.
 */
export function groupFleet(rows: readonly FleetSession[], thisMachine: string, skipped: readonly FleetSkipNote[] = []): FleetMachine[] {
  const machines = new Map<string, FleetMachine>();
  const machine = (name: string) => {
    let found = machines.get(name);
    if (!found) machines.set(name, (found = { machine: name, thisMachine: name === thisMachine, projects: [], idle: [], skipped: [] }));
    return found;
  };
  for (const note of skipped) machine(note.machine).skipped.push(note);
  for (const row of [...rows].sort(compareFleetRows)) {
    const group = machine(row.machine);
    if (row.status === 'idle') {
      group.idle.push(row);
      continue;
    }
    const key = row.project?.key ?? null;
    let project = group.projects.find((item) => item.key === key);
    if (!project) group.projects.push((project = { key, name: row.project?.name ?? null, rows: [] }));
    project.rows.push(row);
  }
  for (const group of machines.values()) {
    // Rows were added most urgent first, so a project's place is its first row's.
    const order = new Map(group.projects.map((project, index) => [project.key, index]));
    group.projects.sort((a, b) => Number(a.key === null) - Number(b.key === null) || (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
    group.idle.sort((a, b) => b.lastActiveMs - a.lastActiveMs || a.key.localeCompare(b.key));
  }
  return [...machines.values()].sort((a, b) =>
    Number(b.thisMachine) - Number(a.thisMachine) || Number(a.machine === '') - Number(b.machine === '') || a.machine.localeCompare(b.machine));
}

/** Rows that stay on the board whatever their age: asking for something, working, or a plan waiting on a decision. */
const staysOnBoard = (row: FleetSession) =>
  row.status === 'approval' || row.status === 'question' || row.status === 'working' || row.note === 'planReady';

/**
 * The live board from everything `get_fleet_sources` returned: one row per session, merged by the ids each source
 * stores, each with the status its best source gives. Rows asking for something, working or with a plan ready stay
 * whatever their age; the rest go after six hours quiet.
 */
export function buildFleetBoard(
  sources: FleetSources,
  { now, snoozes = {}, seen = {}, asked = {} }: { now: number } & Partial<FleetMarks>,
): FleetBoard {
  const rows = mergeSources(sources)
    .map((draft) => rowOf(draft, sources, now, { snoozes, seen, asked }))
    .filter((row) => staysOnBoard(row) || now - row.lastActiveMs <= FLEET_WINDOW_MS);
  const shown = rows.filter((row) => !row.snoozedBy);
  const skipped = sources.t3.flatMap((channel): FleetSkipNote[] =>
    channel.skipped ? [{ machine: channel.machine, channel: channel.channel, reason: channel.skipped.reason, migration: channel.skipped.migration }] : []);
  const counts = Object.fromEntries(FLEET_STATUS_ORDER.map((status) => [status, 0])) as Record<FleetStatus, number>;
  for (const row of shown) counts[row.status] += 1;
  return {
    nowMs: now,
    t3Enabled: sources.t3Enabled,
    t3Found: sources.t3Found,
    thisMachine: sources.thisMachine,
    machines: groupFleet(shown, sources.thisMachine, skipped),
    snoozed: rows.filter((row) => row.snoozedBy).sort((a, b) => (a.snoozedUntilMs ?? 0) - (b.snoozedUntilMs ?? 0) || a.key.localeCompare(b.key)),
    rows,
    counts,
  };
}

/**
 * The board narrowed to one machine's sessions, its counts with it, for Sessions › Live picked to a machine. `''` is
 * every machine, the board as it is; `__unassigned__` is the rows no machine claims.
 */
export function boardForMachine(board: FleetBoard, machine: string): FleetBoard {
  if (!machine) return board;
  const name = machine === '__unassigned__' ? '' : machine;
  const rows = board.rows.filter((row) => row.machine === name);
  const counts = Object.fromEntries(FLEET_STATUS_ORDER.map((status) => [status, 0])) as Record<FleetStatus, number>;
  for (const row of rows) if (!row.snoozedBy) counts[row.status] += 1;
  return {
    ...board,
    machines: board.machines.filter((group) => group.machine === name),
    snoozed: board.snoozed.filter((row) => row.machine === name),
    rows,
    counts,
  };
}

/** Sessions waiting on their user, for the tray: asking for approval or an answer, up to date and not snoozed. */
/**
 * Sessions working now on each machine, counted as the sidebar's chips and Home count them (snoozed ones left out),
 * for the pools' agent limits.
 */
export function workingByMachine(board: Pick<FleetBoard, 'rows'>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of board.rows) {
    if (row.machine && row.snoozedUntilMs === null && row.status === 'working') counts[row.machine] = (counts[row.machine] ?? 0) + 1;
  }
  // In name order, so the same counts always read the same and aren't sent again.
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export const waitingCount = (board: FleetBoard) => board.rows.filter((row) => row.countsAsWaiting).length;

/** Whether a row belongs in Needs you: asking for something, failed or done, and not snoozed. */
const needsYou = (row: FleetSession) => !row.snoozedBy && row.status !== 'working' && row.status !== 'idle';

/**
 * Home's Needs you card: what asks for approval or an answer, what failed and what's done, snoozed rows left out, only
 * what came to that in the last `NEEDS_YOU_WINDOW_MS` before `nowMs`, the most pressing first and at most `limit`.
 * `more` is how many others the board has, older ones included.
 */
export function needsYouRows(board: FleetBoard, nowMs: number, limit = NEEDS_YOU_LIMIT) {
  const all = board.rows.filter(needsYou);
  const recent = all.filter((row) => row.sinceMs >= nowMs - NEEDS_YOU_WINDOW_MS).sort(compareFleetRows).slice(0, limit);
  return { rows: recent, more: all.length - recent.length };
}

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/**
 * One line on what the rows say, naming each count that isn't zero: "2 waiting on you · 1 can't be answered now ·
 * 3 working · 1 done". A request that can't be answered (T3 Code stopped, or its machine not answering) is named
 * apart from those waiting on you, so every row asking for something is in it. Snoozed rows are left out. Home's card,
 * which doesn't list working rows, leaves them out of its line too.
 */
export function fleetSummary(board: FleetBoard, t: Translate, { working = true }: { working?: boolean } = {}) {
  const waiting = waitingCount(board);
  const parts: [number, MessageKey][] = [
    [waiting, 'fleet.summary.waiting'],
    [board.counts.approval + board.counts.question - waiting, 'fleet.summary.stale'],
    [working ? board.counts.working : 0, 'fleet.summary.working'],
    [board.counts.failed, 'fleet.summary.failed'],
    [board.counts.done, 'fleet.summary.done'],
  ];
  const named = parts.filter(([count]) => count > 0).map(([count, key]) => t(key, { count }));
  return named.length ? named.join(' · ') : t('fleet.summary.none');
}

/** Home's Needs you line: what it lists, named as the board's line names it. */
export function needsYouSummary(rows: readonly FleetSession[], t: Translate) {
  const count = (test: (row: FleetSession) => boolean) => rows.filter(test).length;
  const asking = (row: FleetSession) => row.status === 'approval' || row.status === 'question';
  const parts: [number, MessageKey][] = [
    [count((row) => row.countsAsWaiting), 'fleet.summary.waiting'],
    [count((row) => asking(row) && !row.countsAsWaiting), 'fleet.summary.stale'],
    [count((row) => row.status === 'failed'), 'fleet.summary.failed'],
    [count((row) => row.status === 'done'), 'fleet.summary.done'],
  ];
  return parts.filter(([total]) => total > 0).map(([total, key]) => t(key, { count: total })).join(' · ');
}

const PROVIDER_NAME: Record<string, MessageKey> = {
  claudeAgent: 'fleet.provider.claude',
  claude: 'fleet.provider.claude',
  codex: 'fleet.provider.codex',
  cursor: 'fleet.provider.cursor',
  opencode: 'fleet.provider.opencode',
  grok: 'fleet.provider.grok',
  antigravity: 'fleet.provider.antigravity',
};

/**
 * A row's name: the linked session's, as the other lists name it, else for a T3 Code thread its provider, project and
 * short thread id ("Claude in arbor · 1a2b3c4d"), never T3 Code's title; else the client with a short id.
 */
export function fleetSessionName(row: FleetSession, t: Translate) {
  if (row.session) return liveSessionName(row.session);
  const id = shortSessionId(row.t3ThreadId ?? row.agentSessionId ?? row.key);
  if (row.t3ThreadId) {
    const nameKey = row.agent ? PROVIDER_NAME[row.agent] : undefined;
    const agent = nameKey ? t(nameKey) : row.agent || t('fleet.provider.unknown');
    return row.project
      ? t('fleet.row.t3Name', { agent, project: row.project.name, id })
      : t('fleet.row.t3NameNoProject', { agent, id });
  }
  return `${row.clientLabel || t('fleet.provider.unknown')} ${id}`;
}

/** What a T3 Code database that wasn't read says about it, in plain words. */
export function fleetSkipNote(note: FleetSkipNote): { key: MessageKey; variables: MessageVariables } {
  const where = { machine: note.machine, min: T3_MIGRATIONS.min, max: T3_MIGRATIONS.max, migration: note.migration ?? '' };
  switch (note.reason) {
    case 'noSqlite3': return { key: 'fleet.skip.noSqlite3', variables: where };
    case 'unreadable': return { key: 'fleet.skip.unreadable', variables: where };
    case 'schema': return { key: 'fleet.skip.schema', variables: where };
    case 'migrationRange':
      if (note.migration === null) return { key: 'fleet.skip.schema', variables: where };
      return { key: note.migration > T3_MIGRATIONS.max ? 'fleet.skip.newer' : 'fleet.skip.older', variables: where };
  }
}

export type SnoozeOptionId = 'hour' | 'tonight' | 'tomorrow';
export type SnoozeOption = { id: SnoozeOptionId; untilMs: number };
/** When a snooze until tonight or tomorrow wakes. */
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;
const HOUR_MS = 60 * 60_000;

/**
 * The snooze presets: an hour from now; 6pm tonight while that's more than an hour away;
 * 9am on the next calendar day, moved by the date rather than 24 hours so a daylight-saving change can't skip a day.
 */
export function snoozeOptions(now: number): SnoozeOption[] {
  const options: SnoozeOption[] = [{ id: 'hour', untilMs: now + HOUR_MS }];
  const evening = new Date(now);
  evening.setHours(EVENING_HOUR, 0, 0, 0);
  if (evening.getTime() - now > HOUR_MS) options.push({ id: 'tonight', untilMs: evening.getTime() });
  const morning = new Date(now);
  morning.setDate(morning.getDate() + 1);
  morning.setHours(MORNING_HOUR, 0, 0, 0);
  options.push({ id: 'tomorrow', untilMs: morning.getTime() });
  return options;
}

const SNOOZES_KEY = 'arbor.fleet-snoozes.v1';
const SEEN_KEY = 'arbor.fleet-seen.v1';
const ASKED_KEY = 'arbor.fleet-asked.v1';
/** A snooze is kept a day past its time, so one that wakes early still knows when it was set; then it goes. */
const SNOOZE_KEPT_MS = 24 * HOUR_MS;
/** Seen marks outlast the board's six hours by plenty, then go. */
const SEEN_KEPT_MS = 7 * 24 * HOUR_MS;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Snoozes as stored, keeping only well-formed ones not long past their time. */
export function pruneSnoozes(value: unknown, now: number): FleetSnoozes {
  const kept: FleetSnoozes = {};
  for (const [key, entry] of Object.entries(record(value))) {
    const { untilMs, atMs } = record(entry);
    if (finite(untilMs) && finite(atMs) && untilMs + SNOOZE_KEPT_MS > now) kept[key] = { untilMs, atMs };
  }
  return kept;
}

/** Seen marks as stored, keeping only those from the last week. */
export function pruneSeen(value: unknown, now: number): FleetSeen {
  const kept: FleetSeen = {};
  for (const [key, at] of Object.entries(record(value))) {
    if (finite(at) && at + SEEN_KEPT_MS > now) kept[key] = at;
  }
  return kept;
}

/** A map kept in localStorage: row keys (ids) and times, nothing else, pruned as it's read and as it's written. */
function storedMap<T>(key: string, prune: (value: unknown, now: number) => Record<string, T>) {
  const store = savedStore<Record<string, T>>({ key, parse: (raw) => prune(JSON.parse(raw ?? '{}'), Date.now()), fallback: {} });
  return { read: store.get, write: (next: Record<string, T>) => store.set(prune(next, Date.now())), subscribe: store.subscribe };
}

const snoozeStore = storedMap(SNOOZES_KEY, pruneSnoozes);
const seenStore = storedMap(SEEN_KEY, pruneSeen);
// Question times go after a week like seen marks: ids and times only.
const askedStore = storedMap(ASKED_KEY, pruneSeen);

/** Hides a row until `untilMs`, or until something new comes up. */
export function snoozeFleetSession(key: string, untilMs: number, now = Date.now()) {
  snoozeStore.write({ ...snoozeStore.read(), [key]: { untilMs, atMs: now } });
}

export function unsnoozeFleetSession(key: string) {
  const rest = { ...snoozeStore.read() };
  delete rest[key];
  snoozeStore.write(rest);
}

/** Marks a row looked at: a turn done before now is no longer news. */
export function markFleetSeen(key: string, now = Date.now()) {
  seenStore.write({ ...seenStore.read(), [key]: now });
}

let sources: FleetSources | null = null;
let failure = '';
const sourceListeners = new Set<() => void>();
const subscribeSources = (listener: () => void) => {
  sourceListeners.add(listener);
  return () => sourceListeners.delete(listener);
};
const getSources = () => sources;
const getFailure = () => failure;

export function setFleetSources(next: FleetSources) {
  const asked = askedStore.read();
  const remembered = rememberQuestions(asked, next);
  if (remembered !== asked) askedStore.write(remembered);
  sources = next;
  failure = '';
  sourceListeners.forEach((listener) => listener());
}

/** The sources as last read, or null before the first read. */
export const currentFleetSources = getSources;

/** Calls `listener` after each read of the sources, and after one fails. */
export const onFleetSources = subscribeSources;

/** A failed read keeps the last board, and says why. */
export function setFleetFailure(error: string) {
  if (error === failure) return;
  failure = error;
  sourceListeners.forEach((listener) => listener());
}

/** Reads the sources again, for the monitor and a Retry. */
export async function loadFleetSources() {
  try {
    setFleetSources(await getFleetSources());
  } catch (error) {
    setFleetFailure(String(error));
  }
}

/** The board as it stands now, or null before the first read. */
export const currentFleetBoard = (now = Date.now()) =>
  sources ? buildFleetBoard(sources, { now, snoozes: snoozeStore.read(), seen: seenStore.read(), asked: askedStore.read() }) : null;

/**
 * The reporter waits the Needs you alerts leave out, by session id: those that landed on a snoozed row. A row only
 * takes a wait whose id is its own (a T3 Code thread's agent id equals the wait's), so a snoozed thread whose id
 * another thread also claims, and so links to nothing, never silences the wait that got a row of its own.
 */
export function snoozedWaitIds(board: FleetBoard | null) {
  return new Set((board?.snoozed ?? []).flatMap((row) => (row.sources.includes('reporter') && row.agentSessionId ? [row.agentSessionId] : [])));
}

/** The live board, rebuilt as the sources, snoozes and seen marks change and once a minute. Null before the first read. */
export function useFleetBoard(): { board: FleetBoard | null; failure: string; now: number } {
  const current = useSyncExternalStore(subscribeSources, getSources, getSources);
  const error = useSyncExternalStore(subscribeSources, getFailure, getFailure);
  const snoozes = useSyncExternalStore(snoozeStore.subscribe, snoozeStore.read, snoozeStore.read);
  const seen = useSyncExternalStore(seenStore.subscribe, seenStore.read, seenStore.read);
  const asked = useSyncExternalStore(askedStore.subscribe, askedStore.read, askedStore.read);
  const clock = useQuotaClock();
  const { board, now } = sharedBoard(current, { snoozes, seen, asked }, clock);
  return useMemo(() => ({ board, failure: error, now }), [board, error, now]);
}

/** Whether some machine has T3 Code, so its threads' switch is worth showing. False before the first read. */
export function useT3Found() {
  return useSyncExternalStore(subscribeSources, getT3Found, getT3Found);
}
const getT3Found = () => sources?.t3Found ?? false;

/**
 * The last board built, for every component showing it at once (a Sessions list asks once per row): it's built again
 * only when the sources, a mark or the minute changes.
 */
let shared: { current: FleetSources | null; marks: FleetMarks; clock: number; board: FleetBoard | null; now: number } | null = null;
function sharedBoard(current: FleetSources | null, marks: FleetMarks, clock: number) {
  const same = shared && shared.current === current && shared.clock === clock
    && shared.marks.snoozes === marks.snoozes && shared.marks.seen === marks.seen && shared.marks.asked === marks.asked;
  if (!shared || !same) {
    const now = Math.max(clock, Date.now());
    shared = { current, marks, clock, now, board: current ? buildFleetBoard(current, { now, ...marks }) : null };
  }
  return shared;
}

const bySessionCache = new WeakMap<FleetBoard, Map<string, FleetSession>>();
/**
 * The rows that need you by the Arbor session they open, so the other lists that show a session name its state as the
 * board does, snoozes included.
 */
export function needsYouBySession(board: FleetBoard) {
  let found = bySessionCache.get(board);
  if (!found) {
    found = new Map(board.rows.flatMap((row) => (needsYou(row) && row.arborSessionId ? [[row.arborSessionId, row] as const] : [])));
    bySessionCache.set(board, found);
  }
  return found;
}

/** What each Arbor session that needs you is waiting on, from the live board. Empty before the first read. */
export function useNeedsYouBySession(): ReadonlyMap<string, FleetSession> {
  const { board } = useFleetBoard();
  return board ? needsYouBySession(board) : EMPTY_ROWS;
}
const EMPTY_ROWS: ReadonlyMap<string, FleetSession> = new Map();

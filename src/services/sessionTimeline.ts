import type {
  CostParts,
  SessionRequest,
  TranscriptCompaction,
  UsageSession,
  UsageSessionThread,
  UsageSessionTimeline,
} from '../native/types';

/** A request that carried a thread's conversation on, or compacted it: a point on its context line. */
export type ContextPoint = {
  request: SessionRequest;
  /** Input tokens, cached ones included. */
  context: number;
  compacted: boolean;
};

export type SessionChange = 'model' | 'effort' | 'tier';

/**
 * Something worth seeing in a thread. `at` is the context point it sits at, or -1 when the thread has none.
 * A compaction is `detected` when the requests show the conversation shrinking, and `recorded` when the agent's
 * transcript has it, which also says what started it (Claude Code only) and how long it took. One only the
 * transcript has has no summary size, and its sizes are the transcript's, if it gave any.
 */
export type SessionEvent = { at: number; timestampMs: number } & (
  | {
      kind: 'compaction';
      before: number;
      after: number;
      summary: number;
      detected: boolean;
      recorded: boolean;
      trigger: 'auto' | 'manual' | null;
      durationMs: number | null;
    }
  | { kind: 'subagent'; thread: UsageSessionThread }
  | { kind: 'failure'; status: number; message: string; count: number }
  | { kind: 'change'; change: SessionChange; from: string; to: string }
  | { kind: 'cacheMiss'; tokens: number; idleMs: number; cost: number }
  | { kind: 'idle'; idleMs: number }
  | { kind: 'longContext'; threshold: number }
);

export type ThreadTimeline = {
  id: string;
  points: ContextPoint[];
  events: SessionEvent[];
  /** Every request the thread made, side requests and failures included. */
  requests: number;
  sideRequests: number;
  peak: number;
  compactions: number;
};

/** Requests with less context than this carry too little for a missed cache to matter. */
export const CACHE_MISS_MIN_TOKENS = 20_000;
/** A gap between a thread's requests at least this long is shown as the thread sitting idle. */
export const IDLE_EVENT_MS = 30 * 60_000;
/** Gaps this long or longer don't count toward a session's active time. */
export const ACTIVE_GAP_MS = 5 * 60_000;
/** Past this much context a conversation is deep: each request re-sends all of it. */
export const DEEP_CONTEXT_TOKENS = 400_000;
/** A compaction in the transcript this close to one Arbor saw in the requests is the same one. */
export const COMPACTION_MATCH_MS = 10 * 60_000;

export const costTotal = (cost: CostParts | null | undefined) => (cost ? cost.input + cost.cacheRead + cost.cacheWrite + cost.output : 0);

const addCost = (total: CostParts, cost: CostParts | null) => {
  if (!cost) return;
  total.input += cost.input;
  total.cacheRead += cost.cacheRead;
  total.cacheWrite += cost.cacheWrite;
  total.output += cost.output;
};

const emptyCost = (): CostParts => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

/** When a request's response had finished. */
const requestEnd = (request: SessionRequest) => request.timestampMs + Math.max(0, request.latencyMs);

/** The tier a request ran in, in the terms the UI uses. */
export function speedTier(tier: string): 'fast' | 'flex' | 'standard' {
  const normalized = tier.trim().toLowerCase();
  if (normalized === 'priority' || normalized === 'fast') return 'fast';
  if (normalized === 'flex' || normalized === 'batch') return 'flex';
  return 'standard';
}

/**
 * How many tokens `request` had to send again uncached that `previous` had in the cache: the provider dropped
 * the cache, or it expired while the thread sat idle. Zero when nothing worth noting was missed.
 */
export function cacheMissTokens(previous: SessionRequest, request: SessionRequest): number {
  // The conversation has to have kept most of its context, and have been cached before.
  if (request.inputTokens < previous.inputTokens * 0.8) return 0;
  if (previous.cacheReadTokens + previous.cacheCreationTokens < previous.inputTokens * 0.5) return 0;
  const carried = Math.min(previous.inputTokens, request.inputTokens);
  const missed = carried - request.cacheReadTokens;
  if (carried < CACHE_MISS_MIN_TOKENS || missed < CACHE_MISS_MIN_TOKENS || request.cacheReadTokens >= carried * 0.5) return 0;
  return missed;
}

/**
 * The readable part of a failed request's response: the message of a JSON error, as Anthropic, OpenAI and the core
 * send them, or else the text itself. Arbor keeps only the start of a response, so the JSON may be cut off.
 */
export function failureMessage(body: string): string {
  const text = body.trim();
  const match = /"message"\s*:\s*"((?:[^"\\]|\\.)*)("?)/.exec(text);
  if (!match?.[1]) return text;
  let message = match[1];
  try {
    message = JSON.parse(`"${message}"`) as string;
  } catch {
    // Cut off inside an escape: show it as it came.
  }
  return match[2] ? message.trim() : `${message.trim()}…`;
}

/** The first context point at or after `timestampMs`, or the last one. -1 for a thread with none. */
function pointAt(points: ContextPoint[], timestampMs: number): number {
  if (!points.length) return -1;
  let low = 0;
  let high = points.length - 1;
  if (points[high]!.request.timestampMs < timestampMs) return high;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (points[middle]!.request.timestampMs >= timestampMs) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** The conversation, events and counts of one thread of a session. Subagent launches come from `session`. */
export function buildThreadTimeline(timeline: UsageSessionTimeline, threadId: string): ThreadTimeline {
  const own = timeline.requests.filter((request) => request.threadId === threadId);
  const points: ContextPoint[] = [];
  const events: SessionEvent[] = [];
  let sideRequests = 0;
  let previous: SessionRequest | null = null;
  // Long-context billing is noted once for each stretch of conversation between compactions.
  let billedLong = false;
  for (const request of own) {
    if (request.step === 'side') sideRequests += 1;
    if (request.step !== 'conversation' && request.step !== 'compacted') continue;
    const at = points.length;
    const compacted = request.step === 'compacted';
    points.push({ request, context: request.inputTokens, compacted });
    const { timestampMs } = request;
    if (previous) {
      if (compacted) {
        billedLong = false;
        events.push({
          kind: 'compaction', at, timestampMs, before: previous.inputTokens, after: request.inputTokens, summary: previous.outputTokens,
          detected: true, recorded: false, trigger: null, durationMs: null,
        });
      } else {
        const missed = cacheMissTokens(previous, request);
        if (missed) {
          const cost = request.cost ? request.cost.input + request.cost.cacheWrite : 0;
          events.push({ kind: 'cacheMiss', at, timestampMs, tokens: missed, idleMs: Math.max(0, timestampMs - requestEnd(previous)), cost });
        }
      }
      const changes: [SessionChange, string, string][] = [
        ['model', previous.model, request.model],
        ['effort', previous.reasoningEffort, request.reasoningEffort],
        ['tier', speedTier(previous.serviceTier), speedTier(request.serviceTier)],
      ];
      for (const [change, from, to] of changes) {
        if (from !== to && (change !== 'model' || (from && to))) events.push({ kind: 'change', at, timestampMs, change, from, to });
      }
    }
    if (request.longContext && !billedLong) {
      billedLong = true;
      events.push({ kind: 'longContext', at, timestampMs, threshold: timeline.longContextThresholds[request.model] ?? 0 });
    }
    previous = request;
  }

  // The main thread waits while its subagents work, so it's only idle when the whole session is.
  const active = threadId === timeline.session?.id ? timeline.requests : own;
  let lastEnd: number | null = null;
  for (const request of active) {
    if (lastEnd !== null && request.timestampMs - lastEnd >= IDLE_EVENT_MS) {
      events.push({ kind: 'idle', at: pointAt(points, request.timestampMs), timestampMs: lastEnd, idleMs: request.timestampMs - lastEnd });
    }
    lastEnd = Math.max(lastEnd ?? 0, requestEnd(request));
  }

  // Failures in a row with the same status read as one.
  let failure: Extract<SessionEvent, { kind: 'failure' }> | null = null;
  for (const request of own) {
    if (!request.failed || request.canceled) {
      failure = null;
      continue;
    }
    if (failure && failure.status === request.failureStatus) {
      failure.count += 1;
      continue;
    }
    failure = { kind: 'failure', at: pointAt(points, request.timestampMs), timestampMs: request.timestampMs, status: request.failureStatus, message: failureMessage(request.failure), count: 1 };
    events.push(failure);
  }

  for (const thread of timeline.session?.threads ?? []) {
    if (thread.parentId !== threadId || thread.id === threadId) continue;
    events.push({ kind: 'subagent', at: pointAt(points, thread.startedAtMs), timestampMs: thread.startedAtMs, thread });
  }
  // The transcript is the session's own, so it speaks for the main thread.
  if (threadId === timeline.session?.id) addRecordedCompactions(events, points, timeline.session.transcript?.compactions ?? []);
  events.sort((left, right) => left.timestampMs - right.timestampMs);

  return {
    id: threadId,
    points,
    events,
    requests: own.length,
    sideRequests,
    peak: points.reduce((peak, point) => Math.max(peak, point.context), 0),
    compactions: events.filter((event) => event.kind === 'compaction').length,
  };
}

/**
 * Pairs each compaction Arbor saw with the closest one the transcript records, taking what started it and how long
 * it took, and adds the ones only the transcript has. `compaction_count` in src-tauri/src/usage/session_read.rs
 * pairs them the same way for the count every other screen shows, so change both together.
 */
function addRecordedCompactions(events: SessionEvent[], points: ContextPoint[], recorded: TranscriptCompaction[]) {
  const unmatched = new Set(recorded.keys());
  for (const event of events) {
    if (event.kind !== 'compaction') continue;
    let closest = -1;
    for (const index of unmatched) {
      const gap = Math.abs(recorded[index]!.atMs - event.timestampMs);
      if (gap <= COMPACTION_MATCH_MS && (closest < 0 || gap < Math.abs(recorded[closest]!.atMs - event.timestampMs))) closest = index;
    }
    if (closest < 0) continue;
    unmatched.delete(closest);
    const compaction = recorded[closest]!;
    Object.assign(event, { recorded: true, trigger: compaction.trigger || null, durationMs: compaction.durationMs });
  }
  for (const index of unmatched) {
    const compaction = recorded[index]!;
    events.push({
      kind: 'compaction', at: pointAt(points, compaction.atMs), timestampMs: compaction.atMs,
      before: compaction.preTokens ?? 0, after: compaction.postTokens ?? 0, summary: 0,
      detected: false, recorded: true, trigger: compaction.trigger || null, durationMs: compaction.durationMs,
    });
  }
}

export type SessionTotals = {
  requests: number;
  failures: number;
  canceled: number;
  sideRequests: number;
  unpricedRequests: number;
  cost: CostParts;
  /** What subagents' requests cost. */
  subagentCost: number;
  /** What side requests cost, in every thread. */
  sideCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Time spent on requests, leaving out gaps of ACTIVE_GAP_MS or more. */
  activeMs: number;
  spanMs: number;
};

/** Totals over every request of a session. */
export function sessionTotals(timeline: UsageSessionTimeline, mainThreadId: string): SessionTotals {
  const totals: SessionTotals = {
    requests: 0, failures: 0, canceled: 0, sideRequests: 0, unpricedRequests: 0, cost: emptyCost(), subagentCost: 0, sideCost: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, activeMs: 0, spanMs: 0,
  };
  const { requests } = timeline;
  requests.forEach((request, index) => {
    totals.requests += 1;
    if (request.canceled) totals.canceled += 1;
    else if (request.failed) totals.failures += 1;
    if (request.step === 'side') {
      totals.sideRequests += 1;
      totals.sideCost += costTotal(request.cost);
    }
    if (!request.cost && (request.inputTokens || request.outputTokens)) totals.unpricedRequests += 1;
    addCost(totals.cost, request.cost);
    if (request.threadId !== mainThreadId) totals.subagentCost += costTotal(request.cost);
    totals.inputTokens += request.inputTokens;
    totals.outputTokens += request.outputTokens;
    totals.cacheReadTokens += request.cacheReadTokens;
    totals.cacheCreationTokens += request.cacheCreationTokens;
    const next = requests[index + 1];
    const gap = next ? next.timestampMs - request.timestampMs : Infinity;
    totals.activeMs += gap < ACTIVE_GAP_MS ? gap : Math.max(0, request.latencyMs);
  });
  if (requests.length) {
    totals.spanMs = Math.max(...requests.map(requestEnd)) - requests[0]!.timestampMs;
  }
  return totals;
}

/** The share of input read from the cache, or null without input. */
export const cacheHitRate = (totals: Pick<SessionTotals, 'inputTokens' | 'cacheReadTokens'>) =>
  totals.inputTokens > 0 ? totals.cacheReadTokens / totals.inputTokens : null;

export type SessionCheck =
  | { id: 'deepContext'; peak: number }
  | { id: 'cacheMisses'; count: number; tokens: number; cost: number }
  | { id: 'longContext'; requests: number; threshold: number }
  | { id: 'fastSubagents'; threads: number }
  | { id: 'subagentShare'; cost: number; share: number }
  | { id: 'highEffort'; effort: string; share: number };

/**
 * Things in a session that tend to make it cost more than it needs to. Each is a fact
 * about the session, for the user to weigh; none is a rule.
 */
export function sessionChecks(timeline: UsageSessionTimeline, main: ThreadTimeline, totals: SessionTotals): SessionCheck[] {
  const checks: SessionCheck[] = [];
  if (main.peak > DEEP_CONTEXT_TOKENS) checks.push({ id: 'deepContext', peak: main.peak });

  const threads = timeline.session?.threads ?? [];
  const misses = threads
    .map((thread) => (thread.id === main.id ? main : buildThreadTimeline(timeline, thread.id)))
    .flatMap((thread) => thread.events)
    .filter((event): event is Extract<SessionEvent, { kind: 'cacheMiss' }> => event.kind === 'cacheMiss');
  if (misses.length) {
    checks.push({
      id: 'cacheMisses',
      count: misses.length,
      tokens: misses.reduce((sum, miss) => sum + miss.tokens, 0),
      cost: misses.reduce((sum, miss) => sum + miss.cost, 0),
    });
  }

  const long = timeline.requests.filter((request) => request.longContext);
  if (long.length) {
    const thresholds = long.map((request) => timeline.longContextThresholds[request.model] ?? 0);
    checks.push({ id: 'longContext', requests: long.length, threshold: Math.min(...thresholds) });
  }

  const fast = new Set(
    timeline.requests.filter((request) => request.threadId !== main.id && speedTier(request.serviceTier) === 'fast').map((request) => request.threadId),
  );
  if (fast.size) checks.push({ id: 'fastSubagents', threads: fast.size });

  // Only a session Arbor saw working itself can be said to hand too much to its subagents.
  const total = costTotal(totals.cost);
  if (timeline.session?.hasOwnRequests && total > 0 && totals.subagentCost / total >= 0.3) {
    checks.push({ id: 'subagentShare', cost: totals.subagentCost, share: totals.subagentCost / total });
  }

  const conversation = main.points.map((point) => point.request.reasoningEffort.trim().toLowerCase());
  const high = conversation.filter((effort) => effort === 'xhigh' || effort === 'max');
  if (conversation.length && high.length / conversation.length >= 0.5) {
    const effort = high.filter((value) => value === 'max').length > high.length / 2 ? 'max' : 'xhigh';
    checks.push({ id: 'highEffort', effort, share: high.length / conversation.length });
  }
  return checks;
}

/** Thread names as the session detail uses them: the main session, then subagents numbered in list order. */
export function threadNames(session: UsageSession | null): Map<string, { main: boolean; index: number }> {
  const names = new Map<string, { main: boolean; index: number }>();
  let index = 0;
  for (const thread of session?.threads ?? []) {
    if (thread.id === session!.id) names.set(thread.id, { main: true, index: 0 });
    else names.set(thread.id, { main: false, index: ++index });
  }
  return names;
}

export type SessionPlatform = { os?: string; arch?: string; terminal?: string };

// Tokens after the platform that name the app hosting the client, or no terminal at all.
const HOST_TOKENS = /^(?:orca|t3code|unknown|dumb)(?![a-z0-9])/i;

/**
 * The machine details a client puts in its User-Agent. Codex sends the OS, CPU and terminal, as in
 * `codex-tui/0.156.0 (Mac OS 26.0.0; arm64) iTerm.app/3.6.1`; Claude Code sends none.
 */
export function sessionPlatform(userAgent: string | null | undefined): SessionPlatform | null {
  const match = /^[^()]*\(([^;()]+);\s*([^;()]+)\)\s*(\S+)?/.exec(userAgent?.trim() ?? '');
  if (!match) return null;
  const [, rawOs = '', arch = '', terminalToken = ''] = match;
  const mac = /^Mac OS (\d+)/i.exec(rawOs.trim());
  const os = mac ? `macOS ${mac[1]}` : rawOs.trim().replace(/(\.0)+$/, '');
  const terminal = terminalToken && !terminalToken.startsWith('(') && !HOST_TOKENS.test(terminalToken)
    ? terminalToken.split('/')[0]!.replace(/\.app$/i, '')
    : undefined;
  return { os: os || undefined, arch: arch.trim() || undefined, terminal };
}

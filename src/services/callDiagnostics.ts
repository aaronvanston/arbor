import { invokeCommand } from '../native/commands';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import type { CallKind, ClearedCalls, DiagnosticCall } from '../native/types';

export const getCallDiagnostics = () => invokeCommand('get_call_diagnostics');
export const clearCallDiagnostics = () => invokeCommand('clear_call_diagnostics');
export const undoClearCallDiagnostics = (cleared: ClearedCalls) =>
  invokeCommand('undo_clear_call_diagnostics', { clearedAtMs: cleared.clearedAtMs, previousClearedAtMs: cleared.previousClearedAtMs });

/** A call that failed, ran out of time, or took too long. */
export const isProblem = (call: DiagnosticCall) => call.outcome !== 'ok' || call.slow;

/**
 * The nearest-rank percentile of values sorted from low to high: the smallest one with at least `p` percent of them at
 * or below it. 0 when there are none.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

/** One machine's (or the core's) operation, and how its calls went. */
export type CallGroup = {
  key: string;
  kind: CallKind;
  target: string;
  operation: string;
  calls: number;
  /** Failed, including those that ran out of time. */
  failed: number;
  timedOut: number;
  slow: number;
  /** Of every call kept, not only the problems. */
  p50Ms: number;
  p95Ms: number;
  /** The latest call that failed, ran out of time or was slow. */
  lastProblem: DiagnosticCall | null;
  lastSeenMs: number;
  /** How long its calls take before they're slow. */
  slowAfterMs: number;
};

const groupKey = (call: DiagnosticCall) => `${call.kind}\u0000${call.target}\u0000${call.operation}`;

/**
 * The calls by machine (or core) and operation: the ones with a problem first, the latest problem first, then the
 * rest by their latest call.
 */
export function groupCalls(calls: readonly DiagnosticCall[]): CallGroup[] {
  const byKey = new Map<string, DiagnosticCall[]>();
  for (const call of calls) {
    const key = groupKey(call);
    const members = byKey.get(key);
    if (members) members.push(call);
    else byKey.set(key, [call]);
  }
  const groups = [...byKey].map(([key, members]): CallGroup => {
    const durations = members.map((call) => call.durationMs).sort((a, b) => a - b);
    const latest = (list: DiagnosticCall[]) => list.reduce<DiagnosticCall | null>((best, call) => (!best || call.atMs > best.atMs ? call : best), null);
    const newest = latest(members);
    return {
      key,
      kind: newest?.kind ?? 'machine',
      target: newest?.target ?? '',
      operation: newest?.operation ?? '',
      calls: members.length,
      failed: members.filter((call) => call.outcome !== 'ok').length,
      timedOut: members.filter((call) => call.outcome === 'timedOut').length,
      slow: members.filter((call) => call.outcome === 'ok' && call.slow).length,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      lastProblem: latest(members.filter(isProblem)),
      lastSeenMs: newest?.atMs ?? 0,
      slowAfterMs: newest?.slowAfterMs ?? 0,
    };
  });
  return groups.sort((a, b) => {
    if (a.lastProblem && b.lastProblem) return b.lastProblem.atMs - a.lastProblem.atMs || a.key.localeCompare(b.key);
    if (a.lastProblem || b.lastProblem) return a.lastProblem ? -1 : 1;
    return b.lastSeenMs - a.lastSeenMs || a.key.localeCompare(b.key);
  });
}

/** The groups with a failure or a slow call, the latest problem first. */
export const problemGroups = (calls: readonly DiagnosticCall[]) => groupCalls(calls).filter((group) => group.lastProblem);

export type CallSummary = { calls: number; failed: number; timedOut: number; slow: number; sinceMs: number | null };

export function summarizeCalls(calls: readonly DiagnosticCall[]): CallSummary {
  return {
    calls: calls.length,
    failed: calls.filter((call) => call.outcome !== 'ok').length,
    timedOut: calls.filter((call) => call.outcome === 'timedOut').length,
    slow: calls.filter((call) => call.outcome === 'ok' && call.slow).length,
    sinceMs: calls.length ? Math.min(...calls.map((call) => call.atMs)) : null,
  };
}

/** Why Clear can't be pressed, or null when it can: the calls are still being read, couldn't be read, or there are none. */
export function clearBlockedReason(summary: CallSummary | null, loadFailed: boolean): MessageKey | null {
  if (!summary) return loadFailed ? 'diagnostics.clear.unreadable' : 'diagnostics.clear.loading';
  return summary.calls ? null : 'diagnostics.clear.nothing';
}

export type ProblemText = { key: MessageKey; variables?: MessageVariables };

/** What went wrong with a call, briefly: it ran out of time, its exit code or HTTP status, no answer, or slow. */
export function problemText(call: DiagnosticCall): ProblemText | null {
  if (call.outcome === 'timedOut') return { key: 'diagnostics.problem.timedOut' };
  if (call.outcome === 'failed') {
    if (call.code === null) return { key: call.kind === 'core' ? 'diagnostics.problem.noAnswer' : 'diagnostics.problem.didNotRun' };
    return { key: call.kind === 'core' ? 'diagnostics.problem.status' : 'diagnostics.problem.exit', variables: { code: call.code } };
  }
  return call.slow ? { key: 'diagnostics.problem.slow' } : null;
}

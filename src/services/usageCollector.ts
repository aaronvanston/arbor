import type { StatusTone } from '../components/ui/status-dot';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import type { UsageCollectorStatus } from '../native/types';
import { plainError } from './plainError';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/** The pill for a collector status. Before the first answer it reads as waiting, like a core that isn't up yet. */
export function collectorDisplay(status: Pick<UsageCollectorStatus, 'state'> | null): { tone: StatusTone; labelKey: MessageKey } {
  switch (status?.state) {
    case 'collecting': return { tone: 'success', labelKey: 'usage.collector.collecting' };
    case 'error': return { tone: 'error', labelKey: 'usage.collector.error' };
    default: return { tone: 'warning', labelKey: 'usage.collector.waiting' };
  }
}

/** When the last record came in, in milliseconds, or null if none has (or the time can't be read). */
export function lastCollectedMs(status: Pick<UsageCollectorStatus, 'lastCollectedAt'> | null): number | null {
  if (!status?.lastCollectedAt) return null;
  const ms = Date.parse(status.lastCollectedAt);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The collector's failure in plain words. Every HTTP status it reports is the core's answer to its usage queue (it
 * asks nothing else), so it reads as the core's: a 401 says the core didn't take Arbor's key, not "the server".
 */
export function collectorProblem(message: string, t: Translate): string {
  const status = /\bHTTP (\d{3})\b/.exec(message)?.[1];
  return plainError(status ? { kind: 'core', status: Number(status), message } : message, t);
}

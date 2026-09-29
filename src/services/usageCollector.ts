import type { StatusTone } from '../components/ui/status-dot';
import type { MessageKey } from '../i18n/resources';
import type { UsageCollectorStatus } from '../native/types';

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

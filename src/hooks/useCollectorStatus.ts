import { useEffect, useState } from 'react';
import { invokeCommand } from '../native/commands';
import type { UsageCollectorStatus } from '../native/types';

/**
 * The usage collector's status, read every `refreshMs` while the window is visible. It's a cheap read
 * of the collector's in-memory state, so polling is enough to follow along.
 */
export function useCollectorStatus(refreshMs: number) {
  const [status, setStatus] = useState<UsageCollectorStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [checkedAt, setCheckedAt] = useState(() => Date.now());

  useEffect(() => {
    let canceled = false;
    const refresh = async () => {
      try {
        const next = await invokeCommand('get_usage_collector_status');
        if (canceled) return;
        setStatus(next);
        setLoadError('');
      } catch (error) {
        if (canceled) return;
        setLoadError(String(error));
      }
      setCheckedAt(Date.now());
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, refreshMs);
    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [refreshMs]);

  return { status, loadError, checkedAt };
}

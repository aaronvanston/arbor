import { useEffect, useState } from 'react';
import { invokeCommand } from '../native/commands';
import type { UsageCollectorStatus } from '../native/types';
import { pacedInterval } from '../services/hiddenPace';

const SHARED_READ_MS = 5_000;
let sharedStatus: UsageCollectorStatus | null = null;
let sharedStatusAt = 0;
let sharedRead: Promise<UsageCollectorStatus> | null = null;

function readCollectorStatus(): Promise<UsageCollectorStatus> {
  const now = Date.now();
  if (sharedStatus && now - sharedStatusAt < SHARED_READ_MS) return Promise.resolve(sharedStatus);
  if (sharedRead) return sharedRead;
  sharedRead = invokeCommand('get_usage_collector_status')
    .then((value) => {
      sharedStatus = value;
      sharedStatusAt = Date.now();
      return value;
    })
    .finally(() => {
      sharedRead = null;
    });
  return sharedRead;
}

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
        const next = await readCollectorStatus();
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
    const stopTimer = pacedInterval(() => {
      if (!document.hidden) void refresh();
    }, refreshMs);
    return () => {
      canceled = true;
      stopTimer();
    };
  }, [refreshMs]);

  return { status, loadError, checkedAt };
}

/**
 * Whether the proxy hasn't recorded a single request yet, as on a new install, so an empty view can say so rather than
 * blame its filters. Null until the collector has answered.
 */
export function useNothingRecorded() {
  const { status } = useCollectorStatus(30_000);
  return status ? status.totalRecords === 0 : null;
}

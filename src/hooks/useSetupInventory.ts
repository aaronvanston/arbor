import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { fetchSetupInventory, scanSetup, SETUP_INVENTORY_UPDATED_EVENT } from '../services/setupInventory';
import type { SetupInventory } from '../native/types';

/** How often a page asks for scans of machines that weren't answering, or have gone stale, while it's open. */
const STALE_CHECK_MS = 60_000;

/**
 * The last setup scan of each machine, read again as each scan lands. Opening a page that reads it asks for scans of
 * machines not scanned lately, and it asks again each minute, so a machine that wasn't answering is read once it is.
 * Sync and Sessions › Projects' Checkouts both read it. `error` is the latest failure to read it or to start a scan.
 */
export function useSetupInventory() {
  const [inventory, setInventory] = useState<SetupInventory | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setInventory(await fetchSetupInventory());
      setError(null);
    } catch (failure) {
      setError(String(failure));
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const scanStale = () => {
      if (!document.hidden) scanSetup(null, true).catch((failure) => console.warn('Could not start setup scans', failure));
    };
    void reload();
    scanStale();
    listen(SETUP_INVENTORY_UPDATED_EVENT, () => { if (!disposed) void reload(); })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    const poll = window.setInterval(scanStale, STALE_CHECK_MS);
    return () => {
      disposed = true;
      unlisten?.();
      window.clearInterval(poll);
    };
  }, [reload]);

  return { inventory, error, setError, reload };
}

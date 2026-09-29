import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invokeCommand } from './native/commands';
import { listen } from '@tauri-apps/api/event';
import type { CoreStatus } from './native/types';

/** A live core that isn't answering on its port yet reads as starting, as does one the app is still launching. */
export function isCoreStarting(status: CoreStatus) {
  return status.running ? !status.ready : status.starting;
}

type CoreRuntimeContextValue = {
  status: CoreStatus | null;
  statusError: string;
  refreshStatus: () => Promise<void>;
  publishStatus: (status: CoreStatus | null) => void;
};

const CoreRuntimeContext = createContext<CoreRuntimeContextValue | null>(null);

export function CoreRuntimeProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const refreshRequest = useRef<Promise<void> | null>(null);
  const statusRevision = useRef(0);

  const publishStatus = useCallback((nextStatus: CoreStatus | null) => {
    ++statusRevision.current;
    setStatus((previous) => JSON.stringify(previous) === JSON.stringify(nextStatus) ? previous : nextStatus);
    if (nextStatus) {
      setStatusError('');
    }
  }, []);

  const refreshStatus = useCallback(() => {
    if (refreshRequest.current) return refreshRequest.current;
    const revision = statusRevision.current;
    refreshRequest.current = invokeCommand('get_core_status')
      .then((nextStatus) => {
        if (revision === statusRevision.current) publishStatus(nextStatus);
      })
      .catch((error) => {
        if (revision !== statusRevision.current) return;
        setStatus(null);
        setStatusError(String(error));
      })
      .finally(() => { refreshRequest.current = null; });
    return refreshRequest.current;
  }, [publishStatus]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    listen<CoreStatus>('core-status-changed', (event) => {
      if (!disposed) {
        publishStatus(event.payload);
      }
    }).then((stop) => {
      if (disposed) {
        stop();
      } else {
        unlisten = stop;
      }
    }).catch((error) => {
      if (!disposed) {
        setStatusError(String(error));
      }
    });

    void refreshStatus();
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void refreshStatus();
      }
    }, 10_000);

    return () => {
      disposed = true;
      unlisten?.();
      window.clearInterval(timer);
    };
  }, [publishStatus, refreshStatus]);

  const value = useMemo(
    () => ({ status, statusError, refreshStatus, publishStatus }),
    [publishStatus, refreshStatus, status, statusError],
  );

  return <CoreRuntimeContext.Provider value={value}>{children}</CoreRuntimeContext.Provider>;
}

export function useCoreRuntime() {
  const context = useContext(CoreRuntimeContext);
  if (!context) {
    throw new Error('useCoreRuntime must be used within CoreRuntimeProvider');
  }
  return context;
}

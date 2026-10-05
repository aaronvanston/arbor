import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { invokeCommand } from './native/commands';
import { useCoreRuntime } from './coreRuntime';
import type { CoreLatest } from './native/types';
import { afterLaunch } from './services/launchSettle';

/**
 * The core's releases come from GitHub a few times a week, so the background check asks every half hour, and when
 * the window comes back if it's been five minutes.
 */
const CORE_POLL_INTERVAL_MS = 30 * 60_000;
const CORE_RECHECK_ON_SHOW_MS = 5 * 60_000;

type CoreUpdateContextValue = {
  latest: CoreLatest | null;
  error: string;
  checking: boolean;
  hasUpdate: boolean;
  check: (force?: boolean) => Promise<void>;
};

let latestAutoCheckStarted = false;
let cachedLatest: CoreLatest | null = null;
let cachedLatestError = '';
let latestCheckPromise: Promise<CoreLatest> | null = null;
let latestRequestEpoch = 0;

function normalizeVersion(version: string | null | undefined) {
  return (version ?? '').trim().replace(/^v/i, '');
}

type SemanticVersion = {
  core: [string, string, string];
  prerelease: string[] | null;
};

const semanticVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemanticVersion(version: string | null | undefined): SemanticVersion | null {
  const match = semanticVersionPattern.exec(normalizeVersion(version));
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  // The three core groups aren't optional in the pattern, so any match has them.
  if (major === undefined || minor === undefined || patch === undefined) return null;

  return {
    core: [major, minor, patch],
    prerelease: prerelease ? prerelease.split('.') : null,
  };
}

function compareNumericIdentifier(left: string, right: string) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function compareSemanticVersions(left: SemanticVersion, right: SemanticVersion) {
  for (const index of [0, 1, 2] as const) {
    const difference = compareNumericIdentifier(left.core[index], right.core[index]);
    if (difference !== 0) return difference;
  }

  if (left.prerelease === null) return right.prerelease === null ? 0 : 1;
  if (right.prerelease === null) return -1;

  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;

    const leftIsNumeric = /^\d+$/.test(leftIdentifier);
    const rightIsNumeric = /^\d+$/.test(rightIdentifier);
    if (leftIsNumeric && rightIsNumeric) {
      return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    }
    if (leftIsNumeric) return -1;
    if (rightIsNumeric) return 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }

  return 0;
}

export function coreUpdateAvailable(
  currentVersion: string | null | undefined,
  latestVersion: string | null | undefined,
) {
  const current = parseSemanticVersion(currentVersion);
  const latest = parseSemanticVersion(latestVersion);
  return Boolean(current && latest && compareSemanticVersions(latest, current) > 0);
}

export function requestLatestCore(force = false) {
  if (!force && latestCheckPromise) {
    return latestCheckPromise;
  }

  const requestEpoch = ++latestRequestEpoch;
  const request = invokeCommand('check_latest_core')
    .then((result) => {
      if (requestEpoch === latestRequestEpoch) {
        cachedLatest = result;
        cachedLatestError = '';
      }
      return result;
    })
    .catch((error) => {
      if (requestEpoch === latestRequestEpoch) {
        cachedLatest = null;
        cachedLatestError = String(error);
      }
      throw error;
    })
    .finally(() => {
      if (latestCheckPromise === request) {
        latestCheckPromise = null;
      }
    });
  latestCheckPromise = request;

  return request;
}

const CoreUpdateContext = createContext<CoreUpdateContextValue | null>(null);

export function CoreUpdateProvider({ children }: { children: ReactNode }) {
  const { status } = useCoreRuntime();
  const [latest, setLatest] = useState<CoreLatest | null>(cachedLatest);
  const [error, setError] = useState(cachedLatestError);
  const [checking, setChecking] = useState(Boolean(latestCheckPromise));
  const checkEpochRef = useRef(0);

  const check = useCallback(async (force = false) => {
    const checkEpoch = ++checkEpochRef.current;
    setChecking(true);
    setError('');

    try {
      const result = await requestLatestCore(force);
      if (checkEpoch === checkEpochRef.current) {
        setLatest(result);
      }
    } catch (nextError) {
      if (checkEpoch === checkEpochRef.current) {
        setLatest(null);
        setError(String(nextError));
      }
    } finally {
      if (checkEpoch === checkEpochRef.current) {
        setChecking(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!latestAutoCheckStarted) {
      latestAutoCheckStarted = true;
      // The release list is on the network; Home's own reads go first.
      void afterLaunch().then(() => check());
    } else if (latestCheckPromise) {
      void check();
    }
  }, [check]);

  useEffect(() => {
    let disposed = false;
    let lastPollAt = Date.now();
    // Quiet background poll; errors keep the last known release rather than clearing it.
    const poll = async () => {
      if (document.visibilityState !== 'visible' || latestCheckPromise) return;
      lastPollAt = Date.now();
      try {
        const result = await requestLatestCore(true);
        if (!disposed) {
          setLatest((current) => (current && JSON.stringify(current) === JSON.stringify(result) ? current : result));
          setError('');
        }
      } catch {}
    };
    const pollOnShow = () => {
      if (Date.now() - lastPollAt >= CORE_RECHECK_ON_SHOW_MS) void poll();
    };
    const timer = window.setInterval(() => void poll(), CORE_POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', pollOnShow);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', pollOnShow);
    };
  }, []);

  const value = useMemo<CoreUpdateContextValue>(() => ({
    latest,
    error,
    checking,
    hasUpdate: coreUpdateAvailable(status?.currentVersion, latest?.version),
    check,
  }), [check, checking, error, latest, status?.currentVersion]);

  return <CoreUpdateContext.Provider value={value}>{children}</CoreUpdateContext.Provider>;
}

export function useCoreUpdate() {
  const context = useContext(CoreUpdateContext);
  if (!context) {
    throw new Error('useCoreUpdate must be used within CoreUpdateProvider');
  }
  return context;
}

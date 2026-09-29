import { isCoreStarting } from '../coreRuntime';
import type { StatusTone } from '../components/ui/status-dot';
import type { MessageKey } from '../i18n/resources';
import type { CoreStatus } from '../native/types';

/**
 * Why a page that needs the core can't show yet: its status hasn't been read, couldn't be read, the core is starting,
 * stopped, or not installed at all.
 */
export type CoreLock = 'checking' | 'unreadable' | 'starting' | 'stopped' | 'missing';

/** What gets a locked page going: start the core, install it first, or read its status again. */
export type CoreLockAction = 'start' | 'install' | 'check';

/** Null while the core answers, when nothing is locked. */
export function coreLock(status: CoreStatus | null, statusError: string): CoreLock | null {
  if (!status) return statusError ? 'unreadable' : 'checking';
  if (status.ready) return null;
  if (isCoreStarting(status)) return 'starting';
  return status.installed ? 'stopped' : 'missing';
}

/**
 * What a locked page says and offers. The title names the page (`{page}`); the unreadable status's description
 * carries the error (`{error}`). The states that are only waiting offer nothing: the page opens by itself.
 */
export const CORE_LOCK_PAGE: Record<CoreLock, { title: MessageKey; description: MessageKey; action: CoreLockAction | null }> = {
  checking: { title: 'app.coreLocked.checking.title', description: 'app.coreRequired.waitingDescription', action: null },
  unreadable: { title: 'app.coreLocked.title', description: 'app.coreLocked.unreadable', action: 'check' },
  starting: { title: 'kernel.access.waiting', description: 'app.coreRequired.waitingDescription', action: null },
  stopped: { title: 'app.coreLocked.title', description: 'app.coreLocked.stopped', action: 'start' },
  missing: { title: 'app.coreLocked.title', description: 'app.coreLocked.missing', action: 'install' },
};

/** The short reason a locked sidebar row or search palette entry gives. */
export function coreLockHint(lock: CoreLock | null): MessageKey {
  if (lock === 'starting') return 'kernel.access.waiting';
  if (lock === 'missing') return 'palette.unavailable.coreMissing';
  return 'app.coreRequired.title';
}

/**
 * The core as the sidebar's footer shows it: its Core button's dot (green running, amber starting, red stopped, gray
 * missing or not read yet) and word, and whether it's down, which adds the footer's labeled row with Start or Install.
 */
export type SidebarCoreState = { tone: StatusTone; label: MessageKey; down: 'stopped' | 'missing' | null };

const SIDEBAR_CORE_STATE: Record<CoreLock | 'running', SidebarCoreState> = {
  running: { tone: 'success', label: 'sidebar.core.running', down: null },
  checking: { tone: 'muted', label: 'sidebar.core.checking', down: null },
  unreadable: { tone: 'error', label: 'sidebar.core.unreadable', down: null },
  starting: { tone: 'warning', label: 'sidebar.core.starting', down: null },
  stopped: { tone: 'error', label: 'sidebar.core.stopped', down: 'stopped' },
  missing: { tone: 'muted', label: 'sidebar.core.missing', down: 'missing' },
};

export const sidebarCoreState = (status: CoreStatus | null, statusError: string): SidebarCoreState =>
  SIDEBAR_CORE_STATE[coreLock(status, statusError) ?? 'running'];

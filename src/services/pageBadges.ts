import type { MessageKey } from '../i18n/resources';
import { authFileAvailability } from './authFiles';
import { authFileStatusMessage } from './authFileHealth';
import type { HealthStatus } from '../native/types';
import { quotaKey, type AuthFile } from './quotaService';
import type { SetupCheck } from './setupChecks';

/**
 * What a sidebar page link shows when its page has something that needs you: an amber or red dot, or a count. Pages
 * with nothing waiting show nothing, so a badge always means "look here". `label` is what a screen reader hears in
 * place of the mark, so it says what the color or number does: which thing, and how bad.
 */
export type PageBadge = { tone: 'warning' | 'error'; count?: number; label: MessageKey };

/**
 * Accounts: an account needs signing in again, was turned off with an error from the core, or is paused at its cap by
 * Arbor. An account turned off by hand, with nothing wrong, isn't flagged.
 */
export function accountsBadge(
  files: readonly AuthFile[],
  disabled: readonly AuthFile[],
  paused: Readonly<Record<string, unknown>>,
  nowMs: number,
): PageBadge | null {
  if (files.some((file) => authFileAvailability(file, nowMs).kind === 'signin')) return { tone: 'warning', label: 'sidebar.badge.accounts.signIn' };
  const off = disabled.some((file) => quotaKey(file) in paused || authFileStatusMessage(file) !== '');
  return off ? { tone: 'warning', label: 'sidebar.badge.accounts.off' } : null;
}

/** Machines: red while one is down or critical, amber while one is degraded; the Machines page colors them the same. */
export function machinesBadge(statuses: readonly HealthStatus[]): PageBadge | null {
  if (statuses.some((status) => status === 'unreachable' || status === 'critical')) return { tone: 'error', label: 'sidebar.badge.machines.down' };
  return statuses.includes('degraded') ? { tone: 'warning', label: 'sidebar.badge.machines.degraded' } : null;
}

/** Sync: how many problems its checks found. Warnings and notes wait on the Sync page. */
export function setupBadge(checks: readonly Pick<SetupCheck, 'level'>[]): PageBadge | null {
  const count = checks.filter((check) => check.level === 'problem').length;
  return count ? { tone: 'warning', count, label: count === 1 ? 'sidebar.badge.setup.one' : 'sidebar.badge.setup.other' } : null;
}

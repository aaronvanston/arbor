import type { MessageKey } from '../i18n/resources';
import { authFileAvailability } from './authFiles';
import { authFileStatusMessage } from './authFileHealth';
import type { HealthStatus } from '../native/types';
import { quotaKey, type AuthFile } from './quotaService';
import type { SetupCheck } from './setupChecks';
import { accountsView, machinesView, poolsView, setupChecksView, type AppView, type MainPageId } from '../navigation';
import type { FocusTarget } from '../focusRequests';

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

/** Pools: one with no machine that has room now, so a run started on it would wait, spill or not start. */
export function poolsBadge(standings: readonly string[]): PageBadge | null {
  return standings.includes('full') ? { tone: 'warning', label: 'sidebar.badge.pools.full' } : null;
}

/** Sync: how many problems its checks found. Warnings and notes wait on the Sync page. */
export function setupBadge(checks: readonly Pick<SetupCheck, 'level'>[]): PageBadge | null {
  const count = checks.filter((check) => check.level === 'problem').length;
  return count ? { tone: 'warning', count, label: count === 1 ? 'sidebar.badge.setup.one' : 'sidebar.badge.setup.other' } : null;
}

/**
 * Where a badge leads: the view with the things it counts, named for its tooltip ("Opens Sync › Checks"), and what to
 * pick out there. A badge can always be followed, so a number in the sidebar never leaves anyone guessing what it's
 * about. Null for a page whose badges aren't known here.
 */
export type BadgeDestination = { view: AppView; place: MessageKey; focus?: { target: FocusTarget; id: string } };

export function badgeDestination(page: MainPageId, badge: PageBadge): BadgeDestination | null {
  switch (page) {
    case 'setup':
      // Only the problems are counted, so only they show when the count is followed.
      return { view: setupChecksView(), place: 'sidebar.badge.place.checks', focus: { target: 'setup-checks', id: 'problem' } };
    case 'accounts':
      return badge.label === 'sidebar.badge.accounts.signIn'
        ? { view: accountsView({ tab: 'sign-ins' }), place: 'sidebar.badge.place.signIns' }
        : { view: accountsView({ tab: 'limits' }), place: 'sidebar.badge.place.limits' };
    case 'machines':
      return { view: machinesView(), place: 'sidebar.badge.place.machines' };
    case 'pools':
      return { view: poolsView(), place: 'sidebar.badge.place.pools' };
    default:
      return null;
  }
}

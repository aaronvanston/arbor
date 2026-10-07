import { describe, expect, it } from 'bun:test';
import { en } from '../src/i18n/locales/en';
import { accountsBadge, badgeDestination, machinesBadge, setupBadge } from '../src/services/pageBadges';
import { present } from './support/items';

const now = Date.parse('2026-09-26T09:00:00Z');
const account = (name: string, fields: Record<string, unknown> = {}) => ({ name, auth_index: '0', ...fields });

describe('the Accounts link’s dot', () => {
  it('stays off while every account is working or was turned off by hand', () => {
    expect(accountsBadge([account('a.json'), account('b.json')], [], {}, now)).toBeNull();
    expect(accountsBadge([account('a.json')], [account('b.json', { disabled: true })], {}, now)).toBeNull();
  });

  it('turns amber when an account needs signing in again', () => {
    const rejected = account('a.json', { unavailable: true, status: 'error', status_message: 'invalid_grant', cooldowns: [] });
    expect(accountsBadge([rejected, account('b.json')], [], {}, now)).toEqual({ tone: 'warning', label: 'sidebar.badge.accounts.signIn' });
    // Signing in is what to do first, so it's what the dot says when an account is also off.
    expect(accountsBadge([rejected], [account('b.json', { disabled: true, status_message: 'token expired' })], {}, now)?.label).toBe('sidebar.badge.accounts.signIn');
  });

  it('turns amber for an account the core turned off with an error, or one Arbor paused at its cap', () => {
    const failed = account('b.json', { disabled: true, status_message: 'token expired' });
    expect(accountsBadge([account('a.json')], [failed], {}, now)).toEqual({ tone: 'warning', label: 'sidebar.badge.accounts.off' });
    const capped = account('c.json', { disabled: true });
    expect(accountsBadge([account('a.json')], [capped], { 'c.json::0': { pausedAtMs: now } }, now)).toEqual({ tone: 'warning', label: 'sidebar.badge.accounts.off' });
  });
});

describe('the Machines link’s dot', () => {
  it('stays off while every machine is healthy or not checked yet', () => {
    expect(machinesBadge([])).toBeNull();
    expect(machinesBadge(['healthy', 'pending', 'unconfigured'])).toBeNull();
  });

  it('is amber for a degraded machine and red once one is down or critical, whatever the others are', () => {
    expect(machinesBadge(['healthy', 'degraded'])).toEqual({ tone: 'warning', label: 'sidebar.badge.machines.degraded' });
    expect(machinesBadge(['degraded', 'unreachable'])).toEqual({ tone: 'error', label: 'sidebar.badge.machines.down' });
    expect(machinesBadge(['healthy', 'critical'])).toEqual({ tone: 'error', label: 'sidebar.badge.machines.down' });
  });

  it('tells a screen reader a machine down from a slow one, as the color does', () => {
    expect(en[present(machinesBadge(['unreachable'])).label]).toBe('A machine is down or critical');
    expect(en[present(machinesBadge(['degraded'])).label]).toBe('A machine is degraded');
  });
});

describe('the Sync link’s count', () => {
  const problem = (machine: string) => ({ level: 'problem' as const, machine });
  const warning = (machine: string) => ({ level: 'warning' as const, machine });

  it('counts machines behind the setup repo, as Sync’s standing has them', () => {
    expect(setupBadge([], [])).toBeNull();
    expect(setupBadge([], ['ci-01', 'cedar-02'])).toEqual({ tone: 'warning', count: 2, label: 'sidebar.badge.setup.behind.other' });
    expect(en['sidebar.badge.setup.behind.one'].replace('{count}', '1')).toBe('1 machine behind the setup repo');
  });

  it('counts machines with problems too, warnings and notes waiting on the page, and each machine once', () => {
    expect(setupBadge([warning('ci-01'), { level: 'note', machine: 'ci-01' }])).toBeNull();
    expect(setupBadge([problem('ci-01'), warning('cam-mbp'), problem('ci-01')])).toEqual({ tone: 'warning', count: 1, label: 'sidebar.badge.setup.one' });
    expect(en['sidebar.badge.setup.one'].replace('{count}', '1')).toBe('1 machine with setup problems');
    expect(setupBadge([problem('ci-01'), problem('lab-box')], ['ci-01', 'cedar-02'])).toEqual({ tone: 'warning', count: 3, label: 'sidebar.badge.setup.both.other' });
  });
});

describe('where a sidebar badge leads', () => {
  it('opens Overview for machines behind, which has the checks below it too', () => {
    expect(badgeDestination('setup', present(setupBadge([], ['ci-01'])))).toEqual({
      view: { kind: 'main', page: 'setup', params: { tab: 'overview' } },
      place: 'sidebar.badge.place.overview',
    });
  });

  it('opens Sync’s Checks showing only the problems when that’s all it counts', () => {
    const badge = present(setupBadge([{ level: 'problem', machine: 'ci-01' }, { level: 'warning', machine: 'ci-01' }]));
    expect(badgeDestination('setup', badge)).toEqual({
      view: { kind: 'main', page: 'setup', params: { tab: 'overview' } },
      place: 'sidebar.badge.place.checks',
      focus: { target: 'setup-checks', id: 'problem' },
    });
  });

  it('opens Sign-ins for an account to sign in again, and Limits for one turned off', () => {
    expect(badgeDestination('accounts', { tone: 'warning', label: 'sidebar.badge.accounts.signIn' })?.place).toBe('sidebar.badge.place.signIns');
    expect(badgeDestination('accounts', { tone: 'warning', label: 'sidebar.badge.accounts.off' })?.place).toBe('sidebar.badge.place.limits');
  });

  it('names each place in words the tooltip can show', () => {
    expect(en['sidebar.badge.place.checks']).toBe('the checks on Sync › Overview');
    expect(badgeDestination('machines', present(machinesBadge(['degraded'])))?.place).toBe('sidebar.badge.place.machines');
  });
});

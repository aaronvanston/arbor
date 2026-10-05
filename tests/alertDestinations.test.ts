import { describe, expect, it } from 'bun:test';
import { alertDestinationFocus, alertDestinationView } from '../src/alertNavigation';
import { accountLimitsView, libraryView, machinesView, sessionsView, setupChecksView } from '../src/navigation';
import { alertDestination, parseAlertHistory, type AlertRecord } from '../src/services/alertHistory';
import { outageNotification } from '../src/services/outageAlerts';
import { proxyProblemNotification } from '../src/services/proxyChecks';
import { setupChangeNotification } from '../src/services/setupChanges';
import { translate } from '../src/i18n';
import type { MessageKey, MessageVariables } from '../src/i18n/resources';

const t = (key: MessageKey, variables?: MessageVariables) => translate(key, variables);

/** Where an alert opens: the destination, its page, and what that page is asked to bring into view. */
function opens(alert: Pick<AlertRecord, 'kind' | 'subject'>) {
  const destination = alertDestination(alert);
  if (!destination) return null;
  return { destination, view: alertDestinationView(destination), ...alertDestinationFocus(destination) };
}

describe('limit alerts', () => {
  it('open a provider’s alert on that provider’s accounts', () => {
    expect(opens({ kind: 'limitWarning', subject: { provider: 'claude' } })).toEqual({
      destination: { kind: 'accounts', provider: 'claude' },
      view: accountLimitsView(),
      focus: { target: 'provider', id: 'claude' },
    });
  });

  it('open one account’s alert on its row', () => {
    expect(opens({ kind: 'expiring', subject: { account: 'work.json::work' } })?.focus).toEqual({ target: 'account', id: 'work.json::work' });
  });

  it('open an alert about several accounts on the first of them', () => {
    expect(opens({ kind: 'resetReady', subject: { accounts: ['casey.json::a', 'casey.json::b'] } })).toEqual({
      destination: { kind: 'accounts', account: 'casey.json::a' },
      view: accountLimitsView(),
      focus: { target: 'account', id: 'casey.json::a' },
    });
  });

  it('open the limits with nothing focused when they name nothing usable', () => {
    expect(opens({ kind: 'limitCritical' })).toEqual({ destination: { kind: 'accounts' }, view: accountLimitsView() });
    expect(opens({ kind: 'expiring', subject: { accounts: [] } })?.focus).toBeUndefined();
  });
});

describe('machine alerts', () => {
  it('open one machine’s page, whether it’s named alone or in a list', () => {
    expect(opens({ kind: 'machineDown', subject: { machine: 'ci-01' } })?.view).toEqual(machinesView('ci-01'));
    expect(opens({ kind: 'machineUp', subject: { machines: ['ci-01'] } })).toEqual({
      destination: { kind: 'machines', machine: 'ci-01' },
      view: machinesView('ci-01'),
      focus: { target: 'machine', id: 'ci-01' },
    });
  });

  it('open the fleet for several machines', () => {
    expect(opens({ kind: 'machineDown', subject: { machines: ['ci-02', 'ci-03'] } })).toEqual({
      destination: { kind: 'machines' },
      view: machinesView(),
    });
  });
});

describe('agent alerts', () => {
  it('open the session when Arbor carried it', () => {
    expect(opens({ kind: 'agentPermission', subject: { session: 'a3f1', machine: 'casey-mbp' } })?.view).toEqual(sessionsView({ session: 'a3f1' }));
  });

  it('open the live board on the one machine they waited on', () => {
    const live = sessionsView({ tab: 'live', machine: 'casey-mbp' });
    expect(opens({ kind: 'agentWaiting', subject: { machine: 'casey-mbp' } })?.view).toEqual(live);
    expect(opens({ kind: 'agentPermission', subject: { machines: ['casey-mbp'] } })?.view).toEqual(live);
  });

  it('open Sessions for waits on several machines', () => {
    expect(opens({ kind: 'agentWaiting', subject: { machines: ['casey-mbp', 'ci-01'] } })?.view).toEqual({ kind: 'main', page: 'sessions' });
  });
});

describe('setup change alerts', () => {
  const alert = (kinds: ('hook' | 'mcp' | 'plugin' | 'marketplace')[]) =>
    setupChangeNotification({ machine: 'ci-01', changes: kinds.map((kind) => ({ home: '~/.agent-app', kind, name: 'x', change: 'added' })) }, t)!;

  it('open the Library’s hooks by machine for hooks', () => {
    expect(opens(alert(['hook']))).toEqual({ destination: { kind: 'setup', tab: 'hooks', machine: 'ci-01' }, view: libraryView('hooks', 'machines') });
  });

  it('open the Library’s plugins by machine, on the machine, for MCP servers, plugins and marketplaces', () => {
    expect(opens(alert(['mcp', 'plugin', 'marketplace']))).toEqual({
      destination: { kind: 'setup', tab: 'plugins', machine: 'ci-01' },
      view: libraryView('plugins', 'machines'),
      syncMachine: 'ci-01',
    });
  });

  it('open the machine’s page when the changes span Sync views', () => {
    expect(opens(alert(['hook', 'mcp']))?.view).toEqual(machinesView('ci-01'));
  });

  it('open Checks for one saved before alerts said what changed', () => {
    expect(opens({ kind: 'setupChanged', subject: { machine: 'ci-01' } })).toEqual({ destination: { kind: 'setup' }, view: setupChecksView() });
  });
});

describe('proxy alerts', () => {
  it('open the setting each problem is fixed on, in Settings › Proxy', () => {
    const message = proxyProblemNotification({ kind: 'usageOff', detail: null }, t);
    expect(opens(message)).toEqual({
      destination: { kind: 'setting', setting: 'general.usage-statistics' },
      view: { kind: 'settings', page: 'general' },
      focus: { target: 'setting', id: 'general.usage-statistics' },
    });
    expect(opens(proxyProblemNotification({ kind: 'openToNetwork', detail: '0.0.0.0' }, t))?.focus).toEqual({ target: 'setting', id: 'general.host' });
  });

  it('open Home for a settings file that didn’t load, and for ones saved without a setting', () => {
    expect(opens(proxyProblemNotification({ kind: 'settingsNotLoaded', detail: '153' }, t))?.view).toEqual({ kind: 'main', page: 'home' });
    expect(opens({ kind: 'proxySettings' })?.view).toEqual({ kind: 'main', page: 'home' });
  });
});

describe('outage alerts', () => {
  const incident = { id: 'a', name: 'Elevated errors', status: 'investigating', indicator: 'major' as const, url: 'https://status.example.com/a' };

  it('open the incident', () => {
    expect(opens(outageNotification({ provider: 'claude', incident }, t))?.destination).toEqual({ kind: 'url', url: 'https://status.example.com/a' });
  });

  it('open the provider’s accounts without a link, and Home without either', () => {
    expect(opens(outageNotification({ provider: 'codex', incident: { ...incident, url: '' } }, t))).toEqual({
      destination: { kind: 'accounts', provider: 'codex' },
      view: accountLimitsView(),
      focus: { target: 'provider', id: 'codex' },
    });
    expect(opens({ kind: 'outage' })?.view).toEqual({ kind: 'main', page: 'home' });
  });
});

describe('saved alerts', () => {
  it('open as before when their subject is missing or isn’t what it should be', () => {
    const raw = JSON.stringify({
      seenAtMs: 0,
      entries: [
        { id: '1', atMs: 1, kind: 'machineDown', title: '', body: '', subject: { machines: 'ci-01' } },
        { id: '2', atMs: 1, kind: 'setupChanged', title: '', body: '', subject: { machine: 'ci-01', changed: 'hook' } },
        { id: '3', atMs: 1, kind: 'limitWarning', title: '', body: '', subject: { provider: 7 } },
        { id: '4', atMs: 1, kind: 'test', title: '', body: '' },
      ],
    });
    const [machine, setup, limit, test] = parseAlertHistory(raw).entries.map(alertDestination);
    // A list saved as a single name still names it.
    expect(machine).toEqual({ kind: 'machines', machine: 'ci-01' });
    expect(setup).toEqual({ kind: 'setup', tab: 'hooks', machine: 'ci-01' });
    expect(limit).toEqual({ kind: 'accounts' });
    expect(test).toBeNull();
  });
});

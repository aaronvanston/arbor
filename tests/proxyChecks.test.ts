import { describe, expect, test } from 'bun:test';
import type { ProxyChecks } from '../src/native/types';
import { nextProxyAlerts, proxyProblemNotification, proxyProblemText, shownProxyProblems } from '../src/services/proxyChecks';

const checks = (...kinds: ProxyChecks['problems']): ProxyChecks => ({ checked: true, problems: kinds });
const usageOff = { kind: 'usageOff', detail: null } as const;
const noKeys = { kind: 'noClientKeys', detail: null } as const;
const network = (host: string) => ({ kind: 'openToNetwork', detail: host }) as const;
const notLoaded = (line: string | null) => ({ kind: 'settingsNotLoaded', detail: line }) as const;

describe('proxy checks', () => {
  test('a problem alerts once while it lasts, and again once it comes back', () => {
    const first = nextProxyAlerts([], checks(usageOff), null);
    expect(first.alert).toEqual([usageOff]);
    const again = nextProxyAlerts(first.alerted, checks(usageOff, noKeys), null);
    expect(again.alert).toEqual([noKeys]);
    const fixed = nextProxyAlerts(again.alerted, checks(noKeys), null);
    expect(fixed.alert).toEqual([]);
    expect(nextProxyAlerts(fixed.alerted, checks(usageOff, noKeys), null).alert).toEqual([usageOff]);
  });

  test('a core that did not answer neither alerts nor forgets what was alerted', () => {
    const unanswered = nextProxyAlerts(['usageOff'], { checked: false, problems: [] }, null);
    expect(unanswered).toEqual({ alert: [], alerted: ['usageOff'] });
  });

  test('the network warning closed for one address stays closed for it, and a new address brings it back', () => {
    expect(shownProxyProblems(checks(network('0.0.0.0'), usageOff), '0.0.0.0')).toEqual([usageOff]);
    expect(shownProxyProblems(checks(network('192.168.1.20')), '0.0.0.0')).toEqual([network('192.168.1.20')]);
    expect(nextProxyAlerts([], checks(network('0.0.0.0')), '0.0.0.0').alert).toEqual([]);
    expect(nextProxyAlerts(['openToNetwork:0.0.0.0'], checks(network('192.168.1.20')), null).alert).toEqual([network('192.168.1.20')]);
  });

  // money-21: Settings › Proxy shows the checks too, less what its key list already says inline.
  test('leaves out what a page already says', () => {
    expect(shownProxyProblems(checks(noKeys, usageOff, notLoaded('153')), null, ['noClientKeys'])).toEqual([usageOff, notLoaded('153')]);
  });

  test('nothing shows before the core has been asked', () => {
    expect(shownProxyProblems(null, null)).toEqual([]);
  });

  test('a settings file the proxy did not load names the line when its log did', () => {
    expect(proxyProblemText(notLoaded('153'))).toEqual({ title: 'proxyChecks.settingsNotLoaded.title', body: 'proxyChecks.settingsNotLoaded.bodyLine' });
    expect(proxyProblemText(notLoaded(null)).body).toBe('proxyChecks.settingsNotLoaded.body');
    const t = (key: string, variables?: Record<string, unknown>) => `${key} ${String(variables?.line)}`;
    expect(proxyProblemNotification(notLoaded('153'), t)).toMatchObject({ urgent: true, body: 'proxyChecks.settingsNotLoaded.bodyLine 153' });
  });

  test('only the network warning alerts quietly', () => {
    const t = (key: string, variables?: Record<string, unknown>) => (key.endsWith('openToNetwork.body') ? `${key} ${String(variables?.host)}` : key);
    expect(proxyProblemNotification(usageOff, t)).toMatchObject({ kind: 'proxySettings', urgent: true, title: 'proxyChecks.usageOff.title' });
    expect(proxyProblemNotification(network('0.0.0.0'), t)).toMatchObject({ urgent: false, body: 'proxyChecks.openToNetwork.body 0.0.0.0' });
  });
});

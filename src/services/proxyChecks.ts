import { invokeCommand } from '../native/commands';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import type { ProxyChecks, ProxyProblem, ProxyProblemKind } from '../native/types';
import type { SystemNotification } from './notify';
import { savedStore, sharedStore } from './savedStore';

/**
 * The proxy settings Arbor depends on, as the running core has them (src-tauri/src/proxy_checks.rs): usage statistics
 * on, client keys set, the management API taking Arbor's key, the core running what its config.yaml says, and the
 * proxy kept to this Mac. Without them Usage can go quiet with nothing saying why; these say so, on Home and Usage,
 * and as an alert when a problem appears.
 */

const latest = sharedStore<ProxyChecks | null>(null);
/** The address the network warning was closed for, kept so listening there on purpose is only said once. */
const dismissedHost = savedStore<string | null>({
  key: 'arbor.proxy-checks.network-dismissed.v1',
  parse: (raw) => raw || null,
  fallback: null,
  serialize: (host) => host ?? '',
});

/** Asks the core again, and hands the answer to every banner. A core that didn't answer keeps what it said last. */
export async function refreshProxyChecks(): Promise<ProxyChecks> {
  const checks = await invokeCommand('check_proxy_settings');
  if (checks.checked || !latest.get()) latest.set(checks);
  return checks;
}

export const useProxyChecks = latest.useValue;
export const useDismissedNetworkHost = dismissedHost.useValue;

/**
 * Keeps the proxy open to the network without saying so again, for this address: listening there on purpose needs
 * saying once, and another address is news.
 */
export const dismissNetworkWarning = (host: string) => dismissedHost.set(host);

/** The problems a banner shows: all of them, less the network warning once it's been closed for this address. */
export function shownProxyProblems(checks: ProxyChecks | null, dismissed: string | null): ProxyProblem[] {
  if (!checks?.checked) return [];
  return checks.problems.filter((problem) => problem.kind !== 'openToNetwork' || problem.detail !== dismissed);
}

/** What makes a problem the same one as before: its kind, and for the network warning the address. */
export const proxyProblemKey = (problem: ProxyProblem) =>
  problem.kind === 'openToNetwork' ? `${problem.kind}:${problem.detail ?? ''}` : problem.kind;

/**
 * The problems to alert about now, and those to remember: each alerts once when it appears, and again only after it
 * was fixed and came back. A core that didn't answer changes nothing.
 */
export function nextProxyAlerts(alerted: readonly string[], checks: ProxyChecks, dismissed: string | null) {
  if (!checks.checked) return { alert: [] as ProxyProblem[], alerted: [...alerted] };
  const shown = shownProxyProblems(checks, dismissed);
  return {
    alert: shown.filter((problem) => !alerted.includes(proxyProblemKey(problem))),
    alerted: shown.map(proxyProblemKey),
  };
}

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

const PROXY_PROBLEM_TEXT: Record<ProxyProblemKind, { title: MessageKey; body: MessageKey }> = {
  managementRefused: { title: 'proxyChecks.managementRefused.title', body: 'proxyChecks.managementRefused.body' },
  settingsNotLoaded: { title: 'proxyChecks.settingsNotLoaded.title', body: 'proxyChecks.settingsNotLoaded.body' },
  usageOff: { title: 'proxyChecks.usageOff.title', body: 'proxyChecks.usageOff.body' },
  noClientKeys: { title: 'proxyChecks.noClientKeys.title', body: 'proxyChecks.noClientKeys.body' },
  defaultClientKey: { title: 'proxyChecks.defaultClientKey.title', body: 'proxyChecks.defaultClientKey.body' },
  openToNetwork: { title: 'proxyChecks.openToNetwork.title', body: 'proxyChecks.openToNetwork.body' },
};

/** A problem as its banner and alert put it: a file the core didn't load names the line, when its log does. */
export function proxyProblemText(problem: ProxyProblem): { title: MessageKey; body: MessageKey } {
  const text = PROXY_PROBLEM_TEXT[problem.kind];
  return problem.kind === 'settingsNotLoaded' && problem.detail
    ? { ...text, body: 'proxyChecks.settingsNotLoaded.bodyLine' }
    : text;
}

/**
 * The settings row each problem is fixed on, which the banner's button opens. A file the core didn't load is fixed in
 * the file, which the banner shows instead.
 */
export const PROXY_PROBLEM_SETTING: Record<Exclude<ProxyProblemKind, 'settingsNotLoaded'>, string> = {
  managementRefused: 'general.webui-key',
  usageOff: 'general.usage-statistics',
  noClientKeys: 'general.api-keys',
  defaultClientKey: 'general.api-keys',
  openToNetwork: 'general.host',
};

export const proxyProblemVariables = (problem: ProxyProblem): MessageVariables => ({
  status: problem.detail ?? '',
  host: problem.detail || '0.0.0.0',
  line: problem.detail ?? '',
});

/** The alert for a problem that just appeared. Only the network warning waits: it may be on purpose. */
export function proxyProblemNotification(problem: ProxyProblem, t: Translate): SystemNotification {
  const text = proxyProblemText(problem);
  const variables = proxyProblemVariables(problem);
  return {
    title: t(text.title, variables),
    body: t(text.body, variables),
    kind: 'proxySettings',
    urgent: problem.kind !== 'openToNetwork',
  };
}

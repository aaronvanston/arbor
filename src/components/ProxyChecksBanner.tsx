import { useState } from 'react';
import { requestFocus } from '../focusRequests';
import { useI18n } from '../i18n';
import { invokeCommand } from '../native/commands';
import type { ProxyProblem, ProxyProblemKind } from '../native/types';
import type { AppView } from '../navigation';
import { getThisMac } from '../services/addMachine';
import { addNewClientKey } from '../services/clientKeys';
import {
  dismissNetworkWarning,
  PROXY_PROBLEM_SETTING,
  proxyProblemKey,
  proxyProblemText,
  proxyProblemVariables,
  refreshProxyChecks,
  shownProxyProblems,
  useDismissedNetworkHost,
  useProxyChecks,
} from '../services/proxyChecks';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Button } from './ui/button';
import { ServerCog, TriangleAlert, X } from './ui/icons';
import { toast } from './ui/toast';

/**
 * What's wrong with the proxy settings Arbor depends on, on Home and the Usage pages, each with its fix: usage
 * statistics turn back on from here, a settings file the proxy didn't load is shown in Finder, and the rest open their
 * row in Settings. Shown only while a problem lasts.
 *
 * Settings › Proxy shows them too, where the settings are changed (`onProxySettings`): its buttons then find the row on
 * the same page, and `omit` leaves out what the page already says inline.
 */
export function ProxyChecksBanner({ onNavigate, onProxySettings = false, omit = [] }: {
  onNavigate?: (view: AppView) => void;
  onProxySettings?: boolean;
  omit?: ProxyProblemKind[];
}) {
  const checks = useProxyChecks();
  const dismissed = useDismissedNetworkHost();
  const problems = shownProxyProblems(checks, dismissed, omit);
  if (!problems.length) return null;
  return (
    <div className="flex flex-col gap-2" data-slot="proxy-checks">
      {problems.map((problem) => <ProxyProblemAlert key={proxyProblemKey(problem)} problem={problem} onNavigate={onNavigate} onProxySettings={onProxySettings} />)}
    </div>
  );
}

function ProxyProblemAlert({ problem, onNavigate, onProxySettings }: { problem: ProxyProblem; onNavigate?: (view: AppView) => void; onProxySettings: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const text = proxyProblemText(problem);
  const variables = proxyProblemVariables(problem);
  const { kind } = problem;
  const network = kind === 'openToNetwork';
  // Like a network warning, a guessable key is a risk to fix rather than something broken.
  const warning = network || kind === 'defaultClientKey';

  const openSetting = (onNavigate || onProxySettings) && kind !== 'settingsNotLoaded' ? () => {
    requestFocus('setting', PROXY_PROBLEM_SETTING[kind]);
    onNavigate?.({ kind: 'settings', page: 'general' });
  } : undefined;
  const turnOn = async () => {
    setBusy(true);
    setError('');
    try {
      await invokeCommand('turn_on_usage_statistics');
      await refreshProxyChecks();
    } catch (reason) {
      setError(t('proxyChecks.turnOnFailed', { error: String(reason) }));
    } finally {
      setBusy(false);
    }
  };
  // A new install starts with no key, so this is usually the first thing it shows; one press closes it, with the key
  // named for this Mac, whose agents are the first to connect.
  const makeKey = async () => {
    setBusy(true);
    setError('');
    try {
      const { name } = await getThisMac().catch(() => ({ name: '' }));
      await addNewClientKey(name);
      toast({ kind: 'success', title: t('proxyChecks.keyMade') });
      await refreshProxyChecks();
    } catch (reason) {
      setError(t('connectAgent.makeKeyFailed', { error: String(reason) }));
    } finally {
      setBusy(false);
    }
  };
  const showFile = async () => {
    setError('');
    try {
      await invokeCommand('reveal_core_config_file');
    } catch (reason) {
      setError(t('proxyChecks.showFileFailed', { error: String(reason) }));
    }
  };

  const settingButton = openSetting ? <Button variant="outline" size="xs" onClick={openSetting}>{t('proxyChecks.openSetting')}</Button> : null;
  const action = kind === 'usageOff'
    ? <Button variant="outline" size="xs" disabled={busy} onClick={() => void turnOn()}>{t('proxyChecks.turnOn')}</Button>
    : kind === 'noClientKeys'
      ? <><Button variant="outline" size="xs" disabled={busy} onClick={() => void makeKey()}>{t('connectAgent.makeKey')}</Button>{settingButton}</>
    : kind === 'settingsNotLoaded'
      ? <Button variant="outline" size="xs" onClick={() => void showFile()}>{t('proxyChecks.showFile')}</Button>
      : settingButton;
  return (
    <Alert
      variant={warning ? 'warning' : 'error'}
      icon={warning ? <TriangleAlert /> : <ServerCog />}
      action={
        <div className="flex items-center gap-1">
          {action}
          {network && problem.detail !== null ? (
            <Button variant="ghost-muted" size="icon-xs" aria-label={t('proxyChecks.dismiss')} onClick={() => dismissNetworkWarning(problem.detail ?? '')}>
              <X />
            </Button>
          ) : null}
        </div>
      }
    >
      <AlertTitle>{t(text.title, variables)}</AlertTitle>
      <AlertDescription>
        <span>{t(text.body, variables)}</span>
        {error ? <span className="text-error-foreground">{error}</span> : null}
      </AlertDescription>
    </Alert>
  );
}

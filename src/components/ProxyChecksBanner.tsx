import { useState } from 'react';
import { requestFocus } from '../focusRequests';
import { useI18n } from '../i18n';
import { invokeCommand } from '../native/commands';
import type { ProxyProblem } from '../native/types';
import type { AppView } from '../navigation';
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

/**
 * What's wrong with the proxy settings Arbor depends on, on Home and the Usage pages, each with its fix: usage
 * statistics turn back on from here, a settings file the proxy didn't load is shown in Finder, and the rest open their
 * row in Settings. Shown only while a problem lasts.
 */
export function ProxyChecksBanner({ onNavigate }: { onNavigate?: (view: AppView) => void }) {
  const checks = useProxyChecks();
  const dismissed = useDismissedNetworkHost();
  const problems = shownProxyProblems(checks, dismissed);
  if (!problems.length) return null;
  return (
    <div className="flex flex-col gap-2" data-slot="proxy-checks">
      {problems.map((problem) => <ProxyProblemAlert key={proxyProblemKey(problem)} problem={problem} onNavigate={onNavigate} />)}
    </div>
  );
}

function ProxyProblemAlert({ problem, onNavigate }: { problem: ProxyProblem; onNavigate?: (view: AppView) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const text = proxyProblemText(problem);
  const variables = proxyProblemVariables(problem);
  const { kind } = problem;
  const network = kind === 'openToNetwork';
  // Like a network warning, a guessable key is a risk to fix rather than something broken.
  const warning = network || kind === 'defaultClientKey';

  const openSetting = onNavigate && kind !== 'settingsNotLoaded' ? () => {
    requestFocus('setting', PROXY_PROBLEM_SETTING[kind]);
    onNavigate({ kind: 'settings', page: 'general' });
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
  const showFile = async () => {
    setError('');
    try {
      await invokeCommand('reveal_core_config_file');
    } catch (reason) {
      setError(t('proxyChecks.showFileFailed', { error: String(reason) }));
    }
  };

  const action = kind === 'usageOff'
    ? <Button variant="outline" size="xs" disabled={busy} onClick={() => void turnOn()}>{t('proxyChecks.turnOn')}</Button>
    : kind === 'settingsNotLoaded'
      ? <Button variant="outline" size="xs" onClick={() => void showFile()}>{t('proxyChecks.showFile')}</Button>
      : openSetting ? <Button variant="outline" size="xs" onClick={openSetting}>{t('proxyChecks.openSetting')}</Button> : null;
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

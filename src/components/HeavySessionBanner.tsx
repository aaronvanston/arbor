import { useState } from 'react';
import { Flame, Pause, Play, X } from './ui/icons';
import { useI18n } from '../i18n';
import { formatNumber } from '../lib/format';
import { useAppPreferences } from '../appPreferences';
import { raisedAnywhere, useMachineOverrides, useProjectOverrides } from '../services/machineSettings';
import { clientKeyName, maskApiKey, useClientKeys } from '../services/clientKeys';
import type { CoreApiKeyView } from '../native/types';
import { dismissHeavySession, heavySessionText, useDismissedHeavySessions, useHeavySessions, type HeavySession } from '../services/heavySessions';
import { machineMentions } from '../services/machineMentions';
import { shortSessionId } from '../services/usageSessions';
import { useConfirmation } from './ConfirmationDialog';
import { MachinePill } from './identity/Identity';
import { MachineText } from './identity/MachineText';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';

/**
 * A banner for each session over the heavy-session threshold in the last hour, leading to the session and,
 * when its key can be spared, pausing that key. Closing one lasts until the session goes over again after
 * an hour under.
 */
export function HeavySessionBanner({ onOpenSession }: { onOpenSession?: (id: string) => void }) {
  const { t } = useI18n();
  const preferences = useAppPreferences();
  const overrides = useMachineOverrides();
  const projects = useProjectOverrides();
  const sessions = useHeavySessions();
  const dismissed = useDismissedHeavySessions();
  const shown = raisedAnywhere(preferences, overrides, 'heavySessionTokens', projects) ? sessions.filter((session) => dismissed[session.id] === undefined) : [];
  const { keys, pause, resume } = useClientKeys(shown.length > 0);
  const { askConfirmation } = useConfirmation();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const change = async (session: HeavySession, action: 'pause' | 'resume') => {
    setBusy(session.id);
    setErrors(({ [session.id]: _, ...rest }) => rest);
    try {
      await (action === 'pause' ? pause : resume)(session.apiKeyHash);
    } catch (error) {
      const message = t(action === 'pause' ? 'heavySession.pauseFailed' : 'heavySession.resumeFailed', { error: String(error) });
      setErrors((current) => ({ ...current, [session.id]: message }));
    } finally {
      setBusy(null);
    }
  };
  const confirmPause = async (session: HeavySession, key: CoreApiKeyView) => {
    const others = session.otherKeySessions;
    const confirmed = await askConfirmation({
      title: t('heavySession.pauseTitle', { key: clientKeyName(key) }),
      message: t('heavySession.pauseMessage'),
      details: [
        { label: t('heavySession.detail.machine'), value: <MachinePill name={session.machine} fallback={t('usage.events.unassigned')} size="sm" /> },
        { label: t('heavySession.detail.key'), value: maskApiKey(key.apiKey) },
      ],
      warning: others ? t(others === 1 ? 'heavySession.pauseOthers.one' : 'heavySession.pauseOthers.other', { count: others }) : undefined,
      confirmText: t('heavySession.pause'),
      variant: 'danger',
    });
    if (confirmed) await change(session, 'pause');
  };

  if (!shown.length) return null;
  return (
    <div className="flex flex-col gap-2" data-slot="heavy-sessions">
      {shown.map((session) => (
        <HeavySessionAlert
          key={session.id}
          session={session}
          active={keys?.apiKeys.find((key) => key.apiKeyHash === session.apiKeyHash)}
          paused={keys?.pausedApiKeys.find((key) => key.apiKeyHash === session.apiKeyHash)}
          onlyKey={keys?.apiKeys.length === 1}
          busy={busy === session.id}
          error={errors[session.id]}
          onOpenSession={onOpenSession}
          onPause={(key) => void confirmPause(session, key)}
          onResume={() => void change(session, 'resume')}
        />
      ))}
    </div>
  );
}

function HeavySessionAlert({
  session,
  active,
  paused,
  onlyKey,
  busy,
  error,
  onOpenSession,
  onPause,
  onResume,
}: {
  session: HeavySession;
  active?: CoreApiKeyView;
  paused?: CoreApiKeyView;
  onlyKey: boolean;
  busy: boolean;
  error?: string;
  onOpenSession?: (id: string) => void;
  onPause: (key: CoreApiKeyView) => void;
  onResume: () => void;
}) {
  const { t } = useI18n();
  const text = heavySessionText(session, t);
  const key = active ?? paused;
  const details = [
    t('heavySession.session', { id: shortSessionId(session.id) }),
    key ? t('heavySession.key', { key: clientKeyName(key) }) : '',
    t('heavySession.requests', { count: formatNumber(session.requests) }),
  ].filter(Boolean);
  return (
    <Alert
      variant="warning"
      icon={<Flame />}
      action={
        <div className="flex items-center gap-1">
          {onOpenSession ? (
            <Button variant="outline" size="xs" onClick={() => onOpenSession(session.id)}>{t('heavySession.view')}</Button>
          ) : null}
          {active ? (
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              disabledReason={onlyKey ? t('heavySession.onlyKey') : undefined}
              onClick={() => onPause(active)}
            >
              {busy ? <Spinner /> : <Pause />}
              {t('heavySession.pause')}
            </Button>
          ) : paused ? (
            <Button variant="outline" size="xs" disabled={busy} onClick={onResume}>
              {busy ? <Spinner /> : <Play />}
              {t('heavySession.resume')}
            </Button>
          ) : null}
          <Button variant="ghost-muted" size="icon-xs" aria-label={t('heavySession.dismiss')} onClick={() => dismissHeavySession(session.id)}>
            <X />
          </Button>
        </div>
      }
    >
      <AlertTitle><MachineText parts={machineMentions(text.title, [session.machine])} size="md" /></AlertTitle>
      <AlertDescription className="gap-0.5">
        <span>{text.body}</span>
        <span>{details.join(' · ')}</span>
        {!active && paused ? <span>{t('heavySession.paused', { key: clientKeyName(paused) })}</span> : null}
        {error ? <span className="text-error-foreground">{error}</span> : null}
      </AlertDescription>
    </Alert>
  );
}

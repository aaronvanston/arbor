import { useI18n } from '../../i18n';
import { invokeCommand } from '../../native/commands';
import { showAutomations, type AutomationHold } from '../../services/automations';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Button } from '../ui/button';
import { CirclePause, TriangleAlert } from '../ui/icons';

/**
 * Says Arbor's automations won't start when they're due, and why (`automationHold`), where they'd otherwise look
 * ready: the list, an automation's page and the form. Turned off is undone right here; a missing key is added in
 * Settings › Machines, which asks first, so that one opens there.
 */
export function AutomationHoldNote({ hold, onOpenSettings }: { hold: AutomationHold | null; onOpenSettings?: () => void }) {
  const { t } = useI18n();
  if (hold === 'off') {
    return (
      <Alert
        variant="warning"
        icon={<CirclePause />}
        action={(
          <Button size="sm" variant="outline" onClick={() => { void invokeCommand('set_automations_running', { running: true }).then(showAutomations); }}>
            {t('automations.paused.resume')}
          </Button>
        )}
      >
        <AlertTitle>{t('automations.paused.title')}</AlertTitle>
        <AlertDescription>{t('automations.paused.description')}</AlertDescription>
      </Alert>
    );
  }
  if (hold === 'noKey') {
    return (
      <Alert
        variant="warning"
        icon={<TriangleAlert />}
        action={onOpenSettings ? <Button size="sm" variant="outline" onClick={onOpenSettings}>{t('automations.hold.open')}</Button> : undefined}
      >
        <AlertDescription>{t('automations.hold.noKey')}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

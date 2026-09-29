import { AlertCircle } from './ui/icons';
import { useCollectorStatus } from '../hooks/useCollectorStatus';
import { useI18n } from '../i18n';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Button } from './ui/button';

const REFRESH_MS = 15_000;

/**
 * The usage pages' only sign that collection has stopped, now the collector's status lives on
 * Settings › Data: without it their numbers would quietly go stale. Shown only while it's failing.
 */
export function UsageCollectorBanner({ onOpenData }: { onOpenData?: () => void }) {
  const { t } = useI18n();
  const { status } = useCollectorStatus(REFRESH_MS);
  if (status?.state !== 'error') return null;
  return (
    <Alert
      variant="error"
      icon={<AlertCircle />}
      action={onOpenData ? <Button variant="outline" size="xs" onClick={onOpenData}>{t('usage.collector.openData')}</Button> : undefined}
    >
      <AlertTitle>{t('usage.collector.bannerTitle')}</AlertTitle>
      {status.message ? <AlertDescription>{status.message}</AlertDescription> : null}
    </Alert>
  );
}

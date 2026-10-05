import { SettingsRow, SettingsSection } from '../components/layout/settings';
import { Skeleton } from '../components/ui/skeleton';
import { StatusPill } from '../components/ui/status-dot';
import { useCollectorStatus } from '../hooks/useCollectorStatus';
import { useI18n } from '../i18n';
import { formatAgo } from '../lib/format';
import { collectorDisplay, collectorProblem, lastCollectedMs } from '../services/usageCollector';
import { plainError } from '../services/plainError';

const REFRESH_MS = 5_000;

/**
 * Settings › Data: whether Arbor is copying the core's requests into the local database right now.
 * The record count is left to Storage just below.
 */
export function UsageCollectorSection() {
  const { t } = useI18n();
  const { status, loadError, checkedAt } = useCollectorStatus(REFRESH_MS);
  const { tone, labelKey } = collectorDisplay(status);
  const last = lastCollectedMs(status);

  return (
    <SettingsSection title={t('usage.collector.title')} description={t('usage.collector.description')}>
      <SettingsRow
        settingId="data.collector"
        title={t('usage.collector.status')}
        description={loadError ? t('usage.collector.loadFailed', { error: plainError(loadError, t) }) : status?.message ? (status.state === 'error' ? collectorProblem(status.message, t) : status.message) : undefined}
        status={last === null ? undefined : t('usage.collector.lastRecord', { time: formatAgo(last, checkedAt) })}
        control={status ? <StatusPill tone={tone}>{t(labelKey)}</StatusPill> : loadError ? null : <Skeleton className="h-6 w-32" />}
      />
    </SettingsSection>
  );
}

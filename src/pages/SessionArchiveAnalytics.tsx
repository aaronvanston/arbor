import { useState } from 'react';
import { useI18n } from '../i18n';
import { SettingsRow, SettingsSection } from '../components/layout/settings';
import { Button } from '../components/ui/button';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { formatNumber } from '../lib/format';
import { formatBytes } from '../services/machineHealth';
import { plainError } from '../services/plainError';
import { analyticsStanding, clearSessionArchiveAnalytics, setSessionArchiveAnalytics } from '../services/sessionArchive';
import type { ArchiveAnalyticsDetail, ArchiveStatus } from '../native/types';

const DETAILS: ArchiveAnalyticsDetail[] = ['everything', 'numbers'];

/**
 * The archive's analytics tables: the switch that keeps them up, how much of what was said they hold, and what the last
 * check left them as. `act` runs a change and takes the status it answers with, as the rows above it do.
 */
export function ArchiveAnalytics({ status, act }: { status: ArchiveStatus; act: (task: () => Promise<ArchiveStatus | void>) => Promise<void> }) {
  const { t } = useI18n();
  const { analytics } = status;
  // Turning it on can wait on a download, so the switch says it's working.
  const [busy, setBusy] = useState(false);
  const change = async (enabled: boolean, detail: ArchiveAnalyticsDetail) => {
    setBusy(true);
    await act(() => setSessionArchiveAnalytics(enabled, detail));
    setBusy(false);
  };
  const detailLabel = (detail: ArchiveAnalyticsDetail) => t(detail === 'numbers' ? 'sessionArchive.analytics.detail.numbers' : 'sessionArchive.analytics.detail.everything');
  const unavailable = !analytics.engineReady && analytics.engineBytes === null;
  const standing = analyticsStanding(analytics);
  const hasTables = analytics.rows > 0 || analytics.enabled;

  return (
    <SettingsSection settingId="session-archive.analytics" title={t('sessionArchive.analytics.title')} description={t('sessionArchive.analytics.description')}>
      <SettingsRow
        settingId="session-archive.analytics-on"
        title={t('sessionArchive.analytics.on.title')}
        description={
          unavailable
            ? t('sessionArchive.analytics.on.unavailable')
            : analytics.engineReady || analytics.engineBytes === null
              ? t('sessionArchive.analytics.on.description')
              : t('sessionArchive.analytics.on.download', { size: formatBytes(analytics.engineBytes) })
        }
        control={
          <>
            {busy ? <Spinner className="size-4" aria-label={t('sessionArchive.analytics.on.working')} /> : null}
            <Switch
              checked={analytics.enabled}
              disabled={busy || (unavailable && !analytics.enabled)}
              onCheckedChange={(checked) => void change(checked, analytics.detail)}
              aria-label={t('sessionArchive.analytics.on.title')}
            />
          </>
        }
      />
      <SettingsRow
        settingId="session-archive.analytics-detail"
        title={t('sessionArchive.analytics.detail.title')}
        description={t('sessionArchive.analytics.detail.description')}
        control={
          <Select value={analytics.detail} onValueChange={(value) => void change(analytics.enabled, value === 'numbers' ? 'numbers' : 'everything')}>
            <SelectTrigger size="sm" className="w-auto min-w-36" aria-label={t('sessionArchive.analytics.detail.title')} disabled={busy}>
              <SelectValue>{detailLabel(analytics.detail)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              {DETAILS.map((detail) => <SelectItem key={detail} value={detail}>{detailLabel(detail)}</SelectItem>)}
            </SelectPopup>
          </Select>
        }
      />
      {hasTables ? (
        <SettingsRow
          settingId="session-archive.analytics-tables"
          title={t('sessionArchive.analytics.tables.title')}
          description={
            <>
              {t('sessionArchive.analytics.tables.size', { rows: formatNumber(analytics.rows), size: formatBytes(analytics.bytes) })}{' '}
              <span className={standing.failed ? 'text-error-foreground' : undefined}>
                {standing.key === 'sessionArchive.analytics.standing.failed'
                  ? t(standing.key, { error: plainError(analytics.lastError ?? '', t) })
                  : t(standing.key, { count: analytics.versionsLeft ?? 0 })}
              </span>
            </>
          }
          control={
            <Button
              variant="outline"
              size="sm"
              disabledReason={analytics.resetting ? t('sessionArchive.analytics.tables.waiting') : undefined}
              onClick={() => void act(clearSessionArchiveAnalytics)}
            >
              {t(analytics.enabled ? 'sessionArchive.analytics.tables.rebuild' : 'sessionArchive.analytics.tables.remove')}
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

import { useConfirmation } from '../components/ConfirmationDialog';
import { useState } from 'react';
import { invokeCommand } from '../native/commands';
import { AlertCircle, ShieldCheck, TriangleAlert, Wrench } from '../components/ui/icons';
import { useI18n } from '../i18n';
import { formatNumber } from '../lib/format';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsBlock, SettingsRow, SettingsSection } from '../components/layout/settings';
import { StatBlock } from '../components/layout/stats';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { MiddleTruncate } from '../components/ui/middle-truncate';
import { UsageCollectorSection } from './UsageCollectorSection';
import { UsageStorageSection } from './UsageStorageSection';
import type { UsageRepairResult } from '../native/types';

export function UsageDataSettingsPage() {
  const { t } = useI18n();
  return (
    <Page>
      <PageTopbar>
        <PageBreadcrumb segments={[t('settings.title'), t('settings.nav.data')]} />
      </PageTopbar>
      <PageBody gap="gap-6">
        <UsageCollectorSection />
        <UsageStorageSection />
        <UsageDataManagementView />
      </PageBody>
    </Page>
  );
}

function UsageDataManagementView() {
  const { askConfirmation } = useConfirmation();
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<UsageRepairResult | null>(null);
  const [error, setError] = useState('');

  const repair = async () => {
    if (!await askConfirmation({ title: t('usage.dataManagement.title'), message: t('usage.dataManagement.confirm') })) return;
    setRunning(true);
    setError('');
    setResult(null);
    try {
      const next = await invokeCommand('repair_usage_cache_records');
      setResult(next);
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <SettingsSection
        title={t('usage.dataManagement.title')}
        description={t('usage.dataManagement.description')}
        headerAction={<Badge variant="muted">{t('usage.dataManagement.manualBadge')}</Badge>}
        className="max-w-4xl"
      >
        <SettingsBlock>
          <Alert variant="warning" icon={<TriangleAlert />}>
            <AlertDescription>{t('usage.dataManagement.notice')}</AlertDescription>
          </Alert>
        </SettingsBlock>
        <SettingsRow
          settingId="data.repair"
          title={t('usage.dataManagement.actionTitle')}
          description={t('usage.dataManagement.actionDescription')}
          control={
            <Button onClick={() => void repair()} disabled={running}>
              {running ? <Spinner /> : <Wrench />}
              {running ? t('usage.dataManagement.running') : t('usage.dataManagement.run')}
            </Button>
          }
        />
        {error ? (
          <SettingsBlock>
            <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{error}</AlertDescription></Alert>
          </SettingsBlock>
        ) : null}
      </SettingsSection>

      {result ? (
        <SettingsSection title={t('usage.dataManagement.resultTitle')} className="max-w-4xl">
          <SettingsBlock>
            <Alert variant="success" icon={<ShieldCheck />}>
              <AlertDescription>{t('usage.dataManagement.success', { repaired: result.repaired, deleted: result.deleted })}</AlertDescription>
            </Alert>
          </SettingsBlock>
          <div className="grid grid-cols-3 divide-x divide-border/60">
            <StatBlock label={t('usage.dataManagement.scanned')} value={formatNumber(result.scanned)} />
            <StatBlock label={t('usage.dataManagement.repaired')} value={formatNumber(result.repaired)} tone="success" />
            <StatBlock label={t('usage.dataManagement.deleted')} value={formatNumber(result.deleted)} tone={result.deleted > 0 ? 'warning' : 'default'} />
          </div>
          <div className="flex items-center justify-between gap-6 px-4 py-3 text-sm">
            <span className="shrink-0 text-muted-foreground">{t('usage.dataManagement.backup')}</span>
            <MiddleTruncate value={result.backupPath ?? '—'} title={result.backupPath ?? undefined} className="font-mono text-sm text-foreground" />
          </div>
        </SettingsSection>
      ) : null}
    </>
  );
}

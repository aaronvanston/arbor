import { useEffect, useState } from 'react';
import { AlertCircle, Info } from '../components/ui/icons';
import { invokeCommand } from '../native/commands';
import type { ProductAnalyticsInput, ProductAnalyticsSettings } from '../native/types';
import { useI18n } from '../i18n';
import { SettingsBlock, SettingsRow, SettingsSection } from '../components/layout/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Switch } from '../components/ui/switch';

/**
 * Settings › Software's usage data: whether Arbor tells PostHog how it's used, and when it breaks. Kept by the app
 * (product_analytics.rs), which reads it before the window opens, so a crash while starting up follows it too.
 */
export function UsageDataSettings() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<ProductAnalyticsSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let disposed = false;
    invokeCommand('get_product_analytics')
      .then((next) => {
        if (!disposed) setSettings(next);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(String(reason));
      });
    return () => {
      disposed = true;
    };
  }, []);

  const change = async (patch: Partial<ProductAnalyticsInput>) => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      setSettings(await invokeCommand('set_product_analytics', { settings: { usage: settings.usage, crashReports: settings.crashReports, ...patch } }));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  // A build from source never sends, and the environment can turn everything off; either way the switches can't matter.
  const silent = Boolean(settings && (!settings.available || settings.blockedByEnv));
  const disabled = !settings || saving || silent;
  return (
    <SettingsSection title={t('usageData.title')} description={t('usageData.description')}>
      <SettingsRow
        settingId="software.usage-data"
        title={t('usageData.usage')}
        description={t('usageData.usageDescription')}
        control={
          <Switch
            checked={Boolean(settings?.usage) && !silent}
            disabled={disabled}
            aria-label={t('usageData.usage')}
            onCheckedChange={(checked) => void change({ usage: checked })}
          />
        }
      />
      <SettingsRow
        settingId="software.crash-reports"
        title={t('usageData.crashes')}
        description={t('usageData.crashesDescription')}
        control={
          <Switch
            checked={Boolean(settings?.crashReports) && !silent}
            disabled={disabled}
            aria-label={t('usageData.crashes')}
            onCheckedChange={(checked) => void change({ crashReports: checked })}
          />
        }
      />
      {silent || error ? (
        <SettingsBlock>
          <Alert variant={error ? 'error' : 'info'} icon={error ? <AlertCircle /> : <Info />}>
            <AlertDescription>{error ?? t(settings?.available === false ? 'usageData.unavailable' : 'usageData.blockedByEnv')}</AlertDescription>
          </Alert>
        </SettingsBlock>
      ) : null}
    </SettingsSection>
  );
}

import { useI18n } from '../i18n';
import { setAppPreference, useAppPreferences } from '../appPreferences';
import { quitGuardSupported } from '../services/quitGuard';
import { SettingsRow, SettingsSection } from '../components/layout/settings';
import { Switch } from '../components/ui/switch';

/** The ⌘Q guard's switch, on this Mac only. It's kept in the app's window, not with the software settings above. */
export function QuitGuardSettings() {
  const { t } = useI18n();
  const { quitGuard } = useAppPreferences();
  if (typeof navigator === 'undefined' || !quitGuardSupported(navigator.userAgent)) return null;
  return (
    <SettingsSection title={t('config.quit.title')}>
      <SettingsRow
        settingId="software.quit-guard"
        title={t('config.quit.guard')}
        description={t('config.quit.guardDescription')}
        control={
          <Switch
            checked={quitGuard}
            aria-label={t('config.quit.guard')}
            onCheckedChange={(checked) => setAppPreference('quitGuard', checked)}
          />
        }
      />
    </SettingsSection>
  );
}

import { SettingsRow, SettingsSection } from '../components/layout/settings';
import { Switch } from '../components/ui/switch';
import { useI18n } from '../i18n';
import { keepRepoNow, setKeepInStep, useKeepInStep } from '../services/setupRepoKeeper';

/**
 * Settings › Machines › Sync: whether Arbor keeps the setup repo in step with its remote by itself. Off, the repo is
 * only pulled and pushed with Sync › Repo's buttons, as before.
 */
export function SyncSettings() {
  const { t } = useI18n();
  const on = useKeepInStep();
  const change = (next: boolean) => {
    setKeepInStep(next);
    // Turned on, it catches up straight away rather than at the next round; turned off, the round says so.
    void keepRepoNow().catch(() => undefined);
  };
  return (
    <SettingsSection title={t('repoKeeper.settings.title')} description={t('repoKeeper.settings.description')}>
      <SettingsRow
        settingId="machines.sync-keep-repo"
        title={t('repoKeeper.settings.keep')}
        description={t('repoKeeper.settings.keepHint')}
        control={<Switch checked={on} onCheckedChange={change} aria-label={t('repoKeeper.settings.keep')} />}
      />
    </SettingsSection>
  );
}

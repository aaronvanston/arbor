import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invokeCommand } from '../native/commands';
import { useI18n } from '../i18n';
import { InlineNotice, useAppNotice } from '../appNotice';
import { createSoftwareSaver, type SoftwareSaverEvents } from '../services/softwareSettings';
import { SOFTWARE_DEFAULTS as SOFTWARE, onOffLabel, resetOffer } from '../services/settingDefaults';
import { SettingsBlock, SettingsRow, SettingsSection } from '../components/layout/settings';
import { Badge } from '../components/ui/badge';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import type { SoftwareSettings, WindowsCloseBehavior } from '../native/types';

/** How Arbor itself starts and closes: settings of the app's own, which never touch the core. */
export function SoftwareSettingsSection() {
  const { t } = useI18n();
  const onOff = onOffLabel(t);
  const feedback = useAppNotice();
  const [settings, setSettings] = useState<SoftwareSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [closeBehaviorDraft, setCloseBehaviorDraft] = useState<WindowsCloseBehavior>('ask');
  const [autostartDraft, setAutostartDraft] = useState(false);
  const [startCoreDraft, setStartCoreDraft] = useState(true);
  const [silentStartDraft, setSilentStartDraft] = useState(false);

  const show = (shown: SoftwareSettings) => {
    setCloseBehaviorDraft(shown.closeBehavior);
    setAutostartDraft(shown.autostartEnabled);
    setStartCoreDraft(shown.startCoreOnLaunch);
    setSilentStartDraft(shown.silentStartEnabled);
  };

  async function load() {
    setLoading(true);
    try {
      const result = await invokeCommand('get_software_settings');
      setSettings(result);
      show(result);
    } catch (error) {
      setSettings(null);
      feedback.showNotice({ key: 'config.error.saveFailed', variables: { error: String(error) } }, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void load();
    void listen('config-files-changed', () => {
      if (!disposed) void load();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
    // Mount-only: the first load and the config listener are set up once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // These are the app's own and never restart the core, so each saves as it changes, as Appearance's do. The switch
  // shows the change straight away and goes back if saving it fails; a change made while one saves waits for it.
  const saverEvents = useRef<SoftwareSaverEvents | null>(null);
  saverEvents.current = {
    show,
    busy: setSaving,
    saved: setSettings,
    failed: (error) => {
      feedback.showNotice({ key: 'config.error.saveFailed', variables: { error: String(error) } }, 'error');
      void load();
    },
  };
  const [saver] = useState(() => createSoftwareSaver(
    (next) => invokeCommand('save_software_settings', { settings: next }),
    () => saverEvents.current ?? { show() {}, busy() {}, saved() {}, failed() {} },
  ));
  const change = (next: Partial<SoftwareSettings>) => {
    feedback.clearNotice();
    if (settings) void saver.change(settings, next);
  };

  const statusLabel = loading ? t('common.loading') : settings === null ? t('common.unavailable') : '';
  // Left enabled while a change saves, so the keyboard stays on the switch; a second change waits for the first.
  const disabled = loading || settings === null;
  const closeBehaviorLabel = closeBehaviorDraft === 'exit'
    ? t('config.software.behavior.exit')
    : closeBehaviorDraft === 'minimize-to-tray'
      ? t('config.software.behavior.minimize')
      : t('config.software.behavior.ask');

  return (
    <SettingsSection
      title={t('config.software.title')}
      headerAction={
        saving ? <Spinner className="text-muted-foreground" /> : statusLabel ? <Badge variant="muted">{statusLabel}</Badge> : null
      }
    >
      <SettingsRow
        settingId="software.autostart"
        reset={resetOffer(autostartDraft, SOFTWARE.autostartEnabled, onOff(SOFTWARE.autostartEnabled), () => void change({ autostartEnabled: SOFTWARE.autostartEnabled }), disabled)}
        title={t('config.software.autostart')}
        description={t('config.software.autostartDescription')}
        control={<Switch checked={autostartDraft} disabled={disabled} aria-label={t('config.software.autostart')} onCheckedChange={(checked) => void change({ autostartEnabled: checked })} />}
      />
      <SettingsRow
        settingId="software.start-core"
        reset={resetOffer(startCoreDraft, SOFTWARE.startCoreOnLaunch, onOff(SOFTWARE.startCoreOnLaunch), () => void change({ startCoreOnLaunch: SOFTWARE.startCoreOnLaunch }), disabled)}
        title={t('config.software.startCoreOnLaunch')}
        description={t('config.software.startCoreOnLaunchDescription')}
        control={<Switch checked={startCoreDraft} disabled={disabled} aria-label={t('config.software.startCoreOnLaunch')} onCheckedChange={(checked) => void change({ startCoreOnLaunch: checked })} />}
      />
      <SettingsRow
        settingId="software.silent-start"
        reset={resetOffer(silentStartDraft, SOFTWARE.silentStartEnabled, onOff(SOFTWARE.silentStartEnabled), () => void change({ silentStartEnabled: SOFTWARE.silentStartEnabled }), disabled)}
        title={t('config.software.silentStart')}
        description={t('config.software.silentStartDescription')}
        control={<Switch checked={silentStartDraft} disabled={disabled} aria-label={t('config.software.silentStart')} onCheckedChange={(checked) => void change({ silentStartEnabled: checked })} />}
      />
      <SettingsRow
        settingId="software.close-behavior"
        reset={resetOffer(closeBehaviorDraft, SOFTWARE.closeBehavior, t('config.software.behavior.ask'), () => void change({ closeBehavior: SOFTWARE.closeBehavior }), disabled)}
        title={t('config.software.closeBehavior')}
        description={t('config.software.closeBehaviorDescription')}
        control={
          <Select
            value={closeBehaviorDraft}
            disabled={disabled}
            onValueChange={(value) => {
              if (value) void change({ closeBehavior: value as WindowsCloseBehavior });
            }}
          >
            <SelectTrigger size="sm" className="w-48" aria-label={t('config.software.closeBehavior')}>
              <SelectValue>{closeBehaviorLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="ask">{t('config.software.behavior.ask')}</SelectItem>
              <SelectItem value="minimize-to-tray">{t('config.software.behavior.minimize')}</SelectItem>
              <SelectItem value="exit">{t('config.software.behavior.exit')}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {feedback.notice ? (
        <SettingsBlock>
          <InlineNotice key={feedback.revision} notice={feedback.notice} onDismiss={feedback.clearNotice} />
        </SettingsBlock>
      ) : null}
    </SettingsSection>
  );
}

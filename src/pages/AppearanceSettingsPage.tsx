import { useState } from 'react';
import { Minus, Moon, Plus, Sun, SunMoon } from '../components/ui/icons';
import { useI18n } from '../i18n';
import { REFRESH_INTERVAL_OPTIONS, setAppPreference, useAppPreferences } from '../appPreferences';
import { DEFAULT_THEME_PREFERENCE, isThemePreference, type ThemePreference } from '../theme';
import type { MessageKey } from '../i18n/resources';
import { onOffLabel, preferenceReset, resetOffer } from '../services/settingDefaults';
import { APP_COLOR_LABEL, APP_COLORS, appColorChoice, appColorSwatch, isAppColor } from '../services/appColor';
import { isSidebarArt, isSidebarArtMotion, SIDEBAR_ART_LABEL, SIDEBAR_ART_MOTION_LABEL, SIDEBAR_ART_MOTIONS, SIDEBAR_ARTS, sidebarArtChoice, sidebarArtMotionChoice } from '../services/sidebarArt';
import {
  canZoomIn,
  canZoomOut,
  resetZoom,
  tryZoomChange,
  useZoomLevel,
  zoomFailureReason,
  zoomIn,
  zoomOut,
  zoomPercent,
  type ZoomFailure,
} from '../services/zoom';
import { MachinePicker, ProviderPicker } from '../components/GlancePicks';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { Button } from '../components/ui/button';
import { SettingsRow, SettingsSection } from '../components/layout/settings';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { Toggle, ToggleGroup } from '../components/ui/toggle-group';

const THEME_LABEL: Record<ThemePreference, MessageKey> = { light: 'app.theme.light', dark: 'app.theme.dark', system: 'app.theme.system' };

/**
 * Settings › Appearance › Zoom: the level with −, + and Actual size, beside the View menu's ⌘− / ⌘= / ⌘0 and the
 * palette's actions, which all go through the same native command. A change the settings file refused says why under
 * the row, until the zoom moves on.
 */
function ZoomRow() {
  const { t } = useI18n();
  const level = useZoomLevel();
  const [failure, setFailure] = useState<ZoomFailure | null>(null);
  const change = (next: () => Promise<unknown>) => () => {
    void tryZoomChange(next).then(setFailure);
  };
  const reason = zoomFailureReason(failure, level);
  return (
    <SettingsRow
      settingId="appearance.zoom"
      title={t('appearance.zoom.title')}
      description={t('appearance.zoom.description')}
      status={reason ? <span className="text-error-foreground">{t('zoom.failedBecause', { error: reason })}</span> : null}
      control={
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon-sm" aria-label={t('zoom.out')} disabledReason={canZoomOut(level) ? undefined : t('zoom.atSmallest')} onClick={change(zoomOut)}>
              <Minus />
            </Button>
            <output className="min-w-12 text-center text-sm tabular-nums text-foreground">{t('zoom.level', { percent: zoomPercent(level.factor) })}</output>
            <Button variant="outline" size="icon-sm" aria-label={t('zoom.in')} disabledReason={canZoomIn(level) ? undefined : t('zoom.atLargest')} onClick={change(zoomIn)}>
              <Plus />
            </Button>
          </div>
          <Button variant="outline" size="sm" disabledReason={level.factor === 1 ? t('zoom.atActualSize') : undefined} onClick={change(resetZoom)}>
            {t('zoom.actualSize')}
          </Button>
        </div>
      }
    />
  );
}

/**
 * Settings › Appearance: how the app looks and what the sidebar and tray show. The window's theme lives here rather
 * than in the sidebar; the alerts are on Notifications.
 */
export function AppearanceSettingsPage({ theme, onThemeChange }: { theme: ThemePreference; onThemeChange: (theme: ThemePreference) => void }) {
  const { t } = useI18n();
  const preferences = useAppPreferences();
  const onOff = onOffLabel(t);
  const appColor = appColorChoice(preferences.appColor);
  const sidebarArt = sidebarArtChoice(preferences.sidebarArt);
  const sidebarArtMotion = sidebarArtMotionChoice(preferences.sidebarArtMotion);
  const intervalLabel = (minutes: number) => (minutes === 0 ? t('interface.refreshInterval.off') : t('interface.refreshInterval.minutes', { minutes }));
  return (
    <Page>
      <PageTopbar>
        <PageBreadcrumb segments={[t('settings.title'), t('settings.nav.appearance')]} />
      </PageTopbar>
      <PageBody>
        <SettingsSection title={t('appearance.window.title')} description={t('appearance.window.description')}>
          <SettingsRow
            settingId="appearance.theme"
            reset={resetOffer(theme, DEFAULT_THEME_PREFERENCE, t(THEME_LABEL[DEFAULT_THEME_PREFERENCE]), () => onThemeChange(DEFAULT_THEME_PREFERENCE))}
            title={t('appearance.theme.title')}
            description={t('appearance.theme.description')}
            control={
              <ToggleGroup
                value={[theme]}
                onValueChange={(value) => {
                  const next = value[0];
                  if (isThemePreference(next)) onThemeChange(next);
                }}
                aria-label={t('appearance.theme.title')}
              >
                <Toggle value="light"><Sun /> {t('app.theme.light')}</Toggle>
                <Toggle value="dark"><Moon /> {t('app.theme.dark')}</Toggle>
                <Toggle value="system"><SunMoon /> {t('app.theme.system')}</Toggle>
              </ToggleGroup>
            }
          />
          <SettingsRow
            settingId="appearance.color"
            reset={preferenceReset(preferences, 'appColor', (color) => t(APP_COLOR_LABEL[color]))}
            title={t('appearance.color.title')}
            description={t('appearance.color.description')}
            control={
              <ToggleGroup
                value={[appColor]}
                onValueChange={(value) => {
                  const next = value[0];
                  if (isAppColor(next)) setAppPreference('appColor', next);
                }}
                aria-label={t('appearance.color.title')}
              >
                {APP_COLORS.map((color) => (
                  <Toggle key={color} value={color}>
                    <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: appColorSwatch(color) }} />
                    {t(APP_COLOR_LABEL[color])}
                  </Toggle>
                ))}
              </ToggleGroup>
            }
          />
          <SettingsRow
            settingId="appearance.sidebar-art"
            reset={preferenceReset(preferences, 'sidebarArt', (art) => t(SIDEBAR_ART_LABEL[art]))}
            title={t('appearance.sidebarArt.title')}
            description={t('appearance.sidebarArt.description')}
            control={
              <Select value={sidebarArt} onValueChange={(value) => { if (isSidebarArt(value)) setAppPreference('sidebarArt', value); }}>
                <SelectTrigger size="sm" className="w-auto min-w-40" aria-label={t('appearance.sidebarArt.title')}>
                  <SelectValue>{t(SIDEBAR_ART_LABEL[sidebarArt])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  {SIDEBAR_ARTS.map((art) => (
                    <SelectItem key={art} value={art}>{t(SIDEBAR_ART_LABEL[art])}</SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          {sidebarArt !== 'off' ? (
            <SettingsRow
              settingId="appearance.sidebar-art-motion"
              reset={preferenceReset(preferences, 'sidebarArtMotion', (motion) => t(SIDEBAR_ART_MOTION_LABEL[motion]))}
              title={t('appearance.sidebarArtMotion.title')}
              description={t('appearance.sidebarArtMotion.description')}
              control={
                <Select value={sidebarArtMotion} onValueChange={(value) => { if (isSidebarArtMotion(value)) setAppPreference('sidebarArtMotion', value); }}>
                  <SelectTrigger size="sm" className="w-auto min-w-40" aria-label={t('appearance.sidebarArtMotion.title')}>
                    <SelectValue>{t(SIDEBAR_ART_MOTION_LABEL[sidebarArtMotion])}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {SIDEBAR_ART_MOTIONS.map((motion) => (
                      <SelectItem key={motion} value={motion}>{t(SIDEBAR_ART_MOTION_LABEL[motion])}</SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          ) : null}
          <ZoomRow />
        </SettingsSection>
        <SettingsSection title={t('appearance.sidebarTray.title')} description={t('appearance.sidebarTray.description')}>
          <SettingsRow
            settingId="appearance.sidebar-limits"
            reset={preferenceReset(preferences, 'sidebarLimits', onOff)}
            title={t('interface.sidebarLimits.title')}
            description={t('interface.sidebarLimits.description')}
            control={
              <Switch
                checked={preferences.sidebarLimits}
                aria-label={t('interface.sidebarLimits.title')}
                onCheckedChange={(checked) => setAppPreference('sidebarLimits', checked)}
              />
            }
          />
          <SettingsRow
            settingId="appearance.sidebar-machines"
            reset={preferenceReset(preferences, 'sidebarMachines', onOff)}
            title={t('interface.sidebarMachines.title')}
            description={t('interface.sidebarMachines.description')}
            control={
              <Switch
                checked={preferences.sidebarMachines}
                aria-label={t('interface.sidebarMachines.title')}
                onCheckedChange={(checked) => setAppPreference('sidebarMachines', checked)}
              />
            }
          />
          <SettingsRow
            settingId="appearance.tray-limits"
            reset={preferenceReset(preferences, 'trayLimits', onOff)}
            title={t('interface.trayLimits.title')}
            description={t('interface.trayLimits.description')}
            control={
              <Switch
                checked={preferences.trayLimits}
                aria-label={t('interface.trayLimits.title')}
                onCheckedChange={(checked) => setAppPreference('trayLimits', checked)}
              />
            }
          />
          <SettingsRow
            settingId="appearance.tray-machines"
            reset={preferenceReset(preferences, 'trayMachines', onOff)}
            title={t('interface.trayMachines.title')}
            description={t('interface.trayMachines.description')}
            control={
              <Switch
                checked={preferences.trayMachines}
                aria-label={t('interface.trayMachines.title')}
                onCheckedChange={(checked) => setAppPreference('trayMachines', checked)}
              />
            }
          />
          <SettingsRow
            settingId="appearance.tray-sessions"
            reset={preferenceReset(preferences, 'traySessions', onOff)}
            title={t('interface.traySessions.title')}
            description={t('interface.traySessions.description')}
            control={
              <Switch
                checked={preferences.traySessions}
                aria-label={t('interface.traySessions.title')}
                onCheckedChange={(checked) => setAppPreference('traySessions', checked)}
              />
            }
          />
          <SettingsRow
            settingId="appearance.glance-providers"
            title={t('interface.glanceProviders.title')}
            description={t('interface.glanceProviders.description')}
            control={<ProviderPicker label={t('interface.glanceProviders.title')} />}
          />
          <SettingsRow
            settingId="appearance.glance-machines"
            title={t('interface.glanceMachines.title')}
            description={t('interface.glanceMachines.description')}
            control={<MachinePicker label={t('interface.glanceMachines.title')} />}
          />
        </SettingsSection>
        <SettingsSection title={t('appearance.privacy.title')} description={t('appearance.privacy.description')}>
          <SettingsRow
            settingId="appearance.hide-emails"
            reset={preferenceReset(preferences, 'hideEmails', onOff)}
            title={t('appearance.hideEmails.title')}
            description={t('appearance.hideEmails.description')}
            control={
              <Switch
                checked={preferences.hideEmails}
                aria-label={t('appearance.hideEmails.title')}
                onCheckedChange={(checked) => setAppPreference('hideEmails', checked)}
              />
            }
          />
        </SettingsSection>
        <SettingsSection title={t('appearance.limits.title')} description={t('appearance.limits.description')}>
          <SettingsRow
            settingId="appearance.refresh-interval"
            reset={preferenceReset(preferences, 'refreshIntervalMinutes', intervalLabel)}
            title={t('interface.refreshInterval.title')}
            description={t('interface.refreshInterval.description')}
            control={
              <Select value={String(preferences.refreshIntervalMinutes)} onValueChange={(value) => setAppPreference('refreshIntervalMinutes', Number(value ?? 0))}>
                <SelectTrigger size="sm" className="w-auto min-w-32" aria-label={t('interface.refreshInterval.title')}>
                  <SelectValue>{intervalLabel(preferences.refreshIntervalMinutes)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  {REFRESH_INTERVAL_OPTIONS.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>{intervalLabel(minutes)}</SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>
      </PageBody>
    </Page>
  );
}

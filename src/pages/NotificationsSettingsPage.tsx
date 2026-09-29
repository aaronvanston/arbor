import { useI18n } from '../i18n';
import { formatCount, formatTime } from '../lib/format';
import { HEAVY_SESSION_TOKEN_OPTIONS, setAppPreference, useAppPreferences } from '../appPreferences';
import { ATTENTION_ALERT_AFTER_MS } from '../services/agentAttention';
import { EXPIRING_MIN_PERCENT } from '../services/expiringCapacity';
import { MACHINE_DOWN_AFTER_MS } from '../services/machineAlerts';
import { SETUP_WATCH_INTERVAL_MS } from '../services/setupChanges';
import { DIGEST_SEND_HOUR, startWeeklyDigests } from '../services/weeklyDigest';
import { onOffLabel, preferenceReset } from '../services/settingDefaults';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsRow, SettingsSection } from '../components/layout/settings';
import { FleetWideNotice, projectLabel, SettingsScopeSentence, useFleetProjects, useFleetWideHold, useScopedPreference } from '../components/layout/machineScope';
import { MachinePill } from '../components/identity/Identity';
import { useSettingsProject, useSettingsScope } from '../services/machineSettings';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { PhoneAlertsSettings } from './PhoneAlertsSettings';

/**
 * Settings › Notifications: every kind of alert Arbor raises, each turned on or off here for the Mac and the phone
 * alike, then where alerts go besides this Mac.
 */
export function NotificationsSettingsPage() {
  const { t } = useI18n();
  const preferences = useAppPreferences();
  const heavyLabel = (tokens: number) => (tokens === 0 ? t('interface.heavySessions.off') : t('interface.heavySessions.tokens', { tokens: formatCount(tokens) }));
  const digestTime = formatTime(new Date(2026, 0, 5, DIGEST_SEND_HOUR));
  const onOff = onOffLabel(t);
  const scope = useSettingsScope();
  const project = useSettingsProject();
  const projects = useFleetProjects();
  const held = useFleetWideHold();
  const heavy = useScopedPreference('heavySessionTokens', heavyLabel);
  const machines = useScopedPreference('machineNotifications', onOff);
  const setupChanges = useScopedPreference('setupChangeAlerts', onOff);
  const permission = useScopedPreference('agentPermissionAlerts', onOff);
  const waiting = useScopedPreference('agentWaitingAlerts', onOff);
  return (
    <Page>
      <PageTopbar>
        <PageBreadcrumb segments={[t('settings.title'), t('settings.nav.notifications'), ...(project ? [projectLabel(project, projects)] : []), ...(scope ? [<MachinePill key="machine" name={scope} />] : [])]} />
      </PageTopbar>
      <PageBody>
        <SettingsScopeSentence className="-mb-2" projects />
        <SettingsSection title={t('interface.limits.title')} description={t('notifications.limits.description')}>
          <SettingsRow
            settingId="notifications.limit-pace"
            held={held}
            reset={preferenceReset(preferences, 'limitNotifications', onOff)}
            title={t('interface.limitNotifications.title')}
            description={t('interface.limitNotifications.description')}
            control={
              <Switch
                checked={preferences.limitNotifications}
                aria-label={t('interface.limitNotifications.title')}
                onCheckedChange={(checked) => setAppPreference('limitNotifications', checked)}
              />
            }
          />
          <SettingsRow
            settingId="notifications.reset-ready"
            held={held}
            reset={preferenceReset(preferences, 'resetNotifications', onOff)}
            title={t('interface.resetNotifications.title')}
            description={t('interface.resetNotifications.description')}
            control={
              <Switch
                checked={preferences.resetNotifications}
                aria-label={t('interface.resetNotifications.title')}
                onCheckedChange={(checked) => setAppPreference('resetNotifications', checked)}
              />
            }
          />
          <SettingsRow
            settingId="notifications.reserve"
            held={held}
            reset={preferenceReset(preferences, 'reserveAlerts', onOff)}
            title={t('interface.reserveAlerts.title')}
            description={t('interface.reserveAlerts.description')}
            control={
              <Switch
                checked={preferences.reserveAlerts}
                aria-label={t('interface.reserveAlerts.title')}
                onCheckedChange={(checked) => setAppPreference('reserveAlerts', checked)}
              />
            }
          />
          <SettingsRow
            settingId="notifications.expiring"
            held={held}
            reset={preferenceReset(preferences, 'expiringNotifications', onOff)}
            title={t('interface.expiringNotifications.title')}
            description={t('interface.expiringNotifications.description', { percent: EXPIRING_MIN_PERCENT })}
            control={
              <Switch
                checked={preferences.expiringNotifications}
                aria-label={t('interface.expiringNotifications.title')}
                onCheckedChange={(checked) => setAppPreference('expiringNotifications', checked)}
              />
            }
          />
        </SettingsSection>
        <SettingsSection title={t('interface.sessions.title')} description={t('interface.sessions.description')}>
          <SettingsRow
            settingId="notifications.heavy-sessions"
            reset={heavy.reset}
            marker={heavy.marker}
            title={t('interface.heavySessions.title')}
            description={t('interface.heavySessions.description')}
            control={
              <Select value={String(heavy.value)} onValueChange={(value) => heavy.set(Number(value ?? 0))}>
                <SelectTrigger size="sm" className="w-auto min-w-32" aria-label={t('interface.heavySessions.title')}>
                  <SelectValue>{heavyLabel(heavy.value)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  {HEAVY_SESSION_TOKEN_OPTIONS.map((tokens) => (
                    <SelectItem key={tokens} value={String(tokens)}>{heavyLabel(tokens)}</SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            settingId="notifications.archive-alerts"
            held={held}
            reset={preferenceReset(preferences, 'archiveAlerts', onOff)}
            title={t('interface.archiveAlerts.title')}
            description={t('interface.archiveAlerts.description')}
            control={
              <Switch
                checked={preferences.archiveAlerts}
                aria-label={t('interface.archiveAlerts.title')}
                onCheckedChange={(checked) => setAppPreference('archiveAlerts', checked)}
              />
            }
          />
        </SettingsSection>
        {/* The status check stays beside the alert that needs it, though it also feeds the sidebar and tray. */}
        <SettingsSection title={t('interface.status.title')} description={t('interface.status.description')}>
          <SettingsRow
            settingId="notifications.provider-status"
            held={held}
            reset={preferenceReset(preferences, 'providerStatus', onOff)}
            title={t('interface.providerStatus.title')}
            description={t('interface.providerStatus.description')}
            control={
              <Switch
                checked={preferences.providerStatus}
                aria-label={t('interface.providerStatus.title')}
                onCheckedChange={(checked) => setAppPreference('providerStatus', checked)}
              />
            }
          />
          <SettingsRow
            settingId="notifications.outages"
            held={held}
            reset={preferences.providerStatus ? preferenceReset(preferences, 'outageNotifications', onOff) : undefined}
            title={t('interface.outageNotifications.title')}
            description={t('interface.outageNotifications.description')}
            control={
              <Switch
                checked={preferences.providerStatus && preferences.outageNotifications}
                disabled={!preferences.providerStatus}
                aria-label={t('interface.outageNotifications.title')}
                onCheckedChange={(checked) => setAppPreference('outageNotifications', checked)}
              />
            }
          />
        </SettingsSection>
        <SettingsSection title={t('interface.machines.title')} description={t('interface.machines.description')}>
          <SettingsRow
            settingId="notifications.machines"
            reset={machines.reset}
            marker={machines.marker}
            held={machines.held}
            title={t('interface.machineNotifications.title')}
            description={t('interface.machineNotifications.description', { minutes: MACHINE_DOWN_AFTER_MS / 60_000 })}
            control={
              <Switch
                checked={machines.value}
                aria-label={t('interface.machineNotifications.title')}
                onCheckedChange={(checked) => machines.set(checked)}
              />
            }
          />
          <SettingsRow
            settingId="notifications.setup-changes"
            reset={setupChanges.reset}
            marker={setupChanges.marker}
            held={setupChanges.held}
            title={t('interface.setupChangeAlerts.title')}
            description={t('interface.setupChangeAlerts.description', { minutes: SETUP_WATCH_INTERVAL_MS / 60_000 })}
            control={
              <Switch
                checked={setupChanges.value}
                aria-label={t('interface.setupChangeAlerts.title')}
                onCheckedChange={(checked) => setupChanges.set(checked)}
              />
            }
          />
        </SettingsSection>
        <SettingsSection title={t('interface.attention.title')} description={t('interface.attention.description')}>
          <SettingsRow
            settingId="notifications.agent-permission"
            reset={permission.reset}
            marker={permission.marker}
            title={t('interface.agentPermissionAlerts.title')}
            description={t('interface.agentPermissionAlerts.description', { seconds: ATTENTION_ALERT_AFTER_MS.permission / 1000 })}
            control={
              <Switch
                checked={permission.value}
                aria-label={t('interface.agentPermissionAlerts.title')}
                onCheckedChange={(checked) => permission.set(checked)}
              />
            }
          />
          <SettingsRow
            settingId="notifications.agent-waiting"
            reset={waiting.reset}
            marker={waiting.marker}
            title={t('interface.agentWaitingAlerts.title')}
            description={t('interface.agentWaitingAlerts.description', { seconds: ATTENTION_ALERT_AFTER_MS.waiting / 1000 })}
            control={
              <Switch
                checked={waiting.value}
                aria-label={t('interface.agentWaitingAlerts.title')}
                onCheckedChange={(checked) => waiting.set(checked)}
              />
            }
          />
        </SettingsSection>
        <SettingsSection title={t('interface.digest.title')} description={t('interface.digest.description')}>
          <SettingsRow
            settingId="notifications.weekly-digest"
            held={held}
            reset={preferenceReset(preferences, 'weeklyDigest', onOff)}
            title={t('interface.weeklyDigest.title')}
            description={t('interface.weeklyDigest.description', { time: digestTime })}
            control={
              <Switch
                checked={preferences.weeklyDigest}
                aria-label={t('interface.weeklyDigest.title')}
                onCheckedChange={(checked) => {
                  if (checked) startWeeklyDigests(Date.now());
                  setAppPreference('weeklyDigest', checked);
                }}
              />
            }
          />
        </SettingsSection>
        {scope || project ? <FleetWideNotice text={t('machineScope.phoneFleetWide')} /> : <PhoneAlertsSettings />}
      </PageBody>
    </Page>
  );
}

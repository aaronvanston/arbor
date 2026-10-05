import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, TerminalSquare } from '../components/ui/icons';
import { setAppPreference, useAppPreferences, type AppPreferences } from '../appPreferences';
import { useI18n } from '../i18n';
import { invokeCommand } from '../native/commands';
import { onOffLabel, preferenceReset } from '../services/settingDefaults';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsBlock, SettingsRow, SettingsSection } from '../components/layout/settings';
import { MachinePills } from '../components/identity/Identity';
import { AutomationAppMark } from '../components/automations/AutomationApp';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { KnownHarnesses } from './AgentHomesSettings';
import { useAgentHomes } from '../services/agentHomes';
import { loadAutomations, showAutomations, useAutomations } from '../services/automations';
import { useT3Found } from '../services/fleetBoard';
import { useFleetHealth } from '../services/fleetHealth';
import { HARNESS_APPS, harnessApps, type HarnessApp, type HarnessAppRow } from '../services/harnessApps';
import type { AutomationSource } from '../native/types';

/**
 * Settings › Harnesses: the apps that run agents on the machines (each once it's found) with what Arbor reads from them
 * and hands them, then the agents themselves and where each keeps its things.
 */
export function HarnessesSettingsPage() {
  const { t } = useI18n();
  const preferences = useAppPreferences();
  const health = useFleetHealth();
  const t3Found = useT3Found();
  const { list } = useAutomations();
  const { view, error: homesError } = useAgentHomes();
  useEffect(() => {
    if (!list) void loadAutomations();
  }, [list]);
  const apps = harnessApps({ health, scans: list?.scans ?? [], t3Found, appsOff: list?.appsOff ?? [], preferences });
  return (
    <Page>
      <PageTopbar>
        <PageBreadcrumb segments={[t('settings.title'), t('settings.nav.harnesses')]} />
      </PageTopbar>
      <PageBody gap="gap-6">
        {apps.length === 0 ? (
          <SettingsSection title={t('harnesses.apps.title')} description={t('harnesses.apps.description')}>
            <SettingsBlock className="text-xs text-muted-foreground">{t('harnesses.apps.none')}</SettingsBlock>
          </SettingsSection>
        ) : apps.map((row) => <AppCard key={row.app} row={row} preferences={preferences} appsOff={list?.appsOff ?? []} />)}
        {homesError ? <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{homesError}</AlertDescription></Alert> : null}
        {view ? <KnownHarnesses harnesses={view.harnesses} /> : homesError ? null : (
          <p className="flex items-center gap-2 px-4 text-sm text-muted-foreground" role="status"><Spinner />{t('agentHomes.loading')}</p>
        )}
      </PageBody>
    </Page>
  );
}

function AppTitle({ app }: { app: HarnessApp }) {
  const { t } = useI18n();
  const { automations } = HARNESS_APPS[app];
  return (
    <span className="inline-flex items-center gap-1.5">
      {automations ? <AutomationAppMark source={automations} /> : <TerminalSquare className="size-3.5" aria-hidden="true" />}
      <span>{t(HARNESS_APPS[app].label)}</span>
    </span>
  );
}

/** One app: where it was found, then a row for each thing Arbor does with it. */
function AppCard({ row, preferences, appsOff }: { row: HarnessAppRow; preferences: AppPreferences; appsOff: readonly AutomationSource[] }) {
  const { t, tRich } = useI18n();
  const { app, machines } = row;
  const name = t(HARNESS_APPS[app].label);
  const summary = machines.length
    ? tRich('harnesses.app.foundOn', { machines: <MachinePills names={machines} /> })
    : t('harnesses.app.notFound');
  return (
    <SettingsSection title={<AppTitle app={app} />} description={t('harnesses.app.description', { app: name })} summary={summary}>
      {app === 't3' ? <T3Rows preferences={preferences} /> : null}
      {app === 'orca' ? <AutomationsRow settingId="harnesses.orca-automations" source="orca" appsOff={appsOff} /> : null}
      {app === 'orca' ? (
        <PreferenceRow settingId="harnesses.orca-runs" preference="runsToOrca" title={t('harnesses.runs.title')} description={t('harnesses.runs.description')} />
      ) : null}
      {app === 'superset' ? <AutomationsRow settingId="harnesses.superset-automations" source="superset" appsOff={appsOff} /> : null}
      {app === 'codexApp' ? <AutomationsRow settingId="harnesses.codex-app-automations" source="codexApp" appsOff={appsOff} /> : null}
      {app === 'claudeDesktop' ? <AutomationsRow settingId="harnesses.claude-automations" source="claudeDesktop" appsOff={appsOff} /> : null}
    </SettingsSection>
  );
}

function T3Rows({ preferences }: { preferences: AppPreferences }) {
  const { t } = useI18n();
  return (
    <>
      <PreferenceRow settingId="harnesses.t3-threads" preference="fleetT3Threads" title={t('harnesses.t3Threads.title')} description={t('harnesses.t3Threads.description')} />
      <PreferenceRow
        settingId="harnesses.t3-titles"
        preference="fleetT3Titles"
        title={t('harnesses.t3Titles.title')}
        description={t('harnesses.t3Titles.description')}
        held={preferences.fleetT3Threads ? undefined : t('harnesses.t3Titles.needsThreads')}
      />
    </>
  );
}

type SwitchPreference = 'fleetT3Threads' | 'fleetT3Titles' | 'runsToOrca';

function PreferenceRow({ settingId, preference, title, description, held }: {
  settingId: string;
  preference: SwitchPreference;
  title: string;
  description: ReactNode;
  held?: string;
}) {
  const { t } = useI18n();
  const preferences = useAppPreferences();
  return (
    <SettingsRow
      settingId={settingId}
      reset={preferenceReset(preferences, preference, onOffLabel(t))}
      title={title}
      description={description}
      held={held}
      control={<Switch checked={preferences[preference]} aria-label={title} onCheckedChange={(checked) => setAppPreference(preference, checked)} />}
    />
  );
}

/** Reading one app's automations. Off, the native side stops asking for them and forgets what it found. */
function AutomationsRow({ settingId, source, appsOff }: { settingId: string; source: Exclude<AutomationSource, 'arbor'>; appsOff: readonly AutomationSource[] }) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = !appsOff.includes(source);
  const app = t(HARNESS_APPS[source].label);
  const change = async (enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      showAutomations(await invokeCommand('set_automation_app_enabled', { source, enabled }));
    } catch (failure) {
      setError(String(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsRow
      settingId={settingId}
      title={t('harnesses.automations.title')}
      description={t('harnesses.automations.description')}
      status={error ? <span className="text-xs text-destructive-foreground">{error}</span> : saving ? <Spinner /> : undefined}
      control={<Switch checked={on} disabled={saving} aria-label={t('harnesses.automations.label', { app })} onCheckedChange={(checked) => void change(checked)} />}
    />
  );
}

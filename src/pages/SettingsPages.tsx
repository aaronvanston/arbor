import { useCallback, useEffect, useState } from 'react';
import { invokeCommand } from '../native/commands';
import { AlertCircle, ArrowUpRight } from '../components/ui/icons';
import { useI18n } from '../i18n';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsRow, SettingsSection } from '../components/layout/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { UsageMachineAssignments } from './UsageMachineAssignments';
import { MachineHostsSettings } from './MachineHostsSettings';
import { AgentTelemetrySettings } from './AgentTelemetrySettings';
import { MachineProbesSettings } from '../components/MachineProbes';
import { AutomationSettings } from '../components/automations/AutomationSettings';
import { FleetWideNotice, SettingsScopeSentence } from '../components/layout/machineScope';
import { MachinePill } from '../components/identity/Identity';
import { useSettingsScope } from '../services/machineSettings';
import { machinesView, type AppView } from '../navigation';
import type { MachineAssignment } from '../native/types';

export function MachineAssignmentsSettingsPage({ onNavigate }: { onNavigate?: (view: AppView) => void }) {
  const { t } = useI18n();
  const scope = useSettingsScope();
  const [assignments, setAssignments] = useState<MachineAssignment[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setAssignments(await invokeCommand('get_usage_machine_assignments'));
      setError('');
    } catch (requestError) {
      setError(String(requestError));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Page>
      <PageTopbar>
        <PageBreadcrumb segments={[t('settings.title'), t('settings.nav.machines'), ...(scope ? [<MachinePill key="machine" name={scope} />] : [])]} />
      </PageTopbar>
      <PageBody gap="gap-6">
        <SettingsScopeSentence className="-mb-1" />
        {error ? <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{error}</AlertDescription></Alert> : null}
        {scope ? (
          <>
            <OneMachineSettings machine={scope} onNavigate={onNavigate} />
            <FleetWideNotice text={t('machineScope.onMachine.fleetWide')} />
          </>
        ) : (
          <>
            <UsageMachineAssignments assignments={assignments} onSaved={() => void load()} />
            <MachineHostsSettings />
            <MachineProbesSettings />
            <AutomationSettings />
            <AgentTelemetrySettings />
          </>
        )}
      </PageBody>
    </Page>
  );
}

/**
 * Settings › Machines at one machine. What's set on the machine itself, its alerts reporter and Claude Code metrics, is
 * on its own page with its agents, so this points there rather than showing the same rows twice.
 */
function OneMachineSettings({ machine, onNavigate }: { machine: string; onNavigate?: (view: AppView) => void }) {
  const { t, tRich } = useI18n();
  return (
    <SettingsSection title={<span>{tRich('machineScope.onMachine.title', { machine: <MachinePill name={machine} /> })}</span>} description={t('machineScope.onMachine.description')}>
      <SettingsRow
        title={t('machineScope.onMachine.agentsTitle')}
        description={tRich('machineScope.onMachine.agentsHint', { machine: <MachinePill name={machine} size="sm" /> })}
        control={
          <Button variant="outline" size="sm" disabled={!onNavigate} onClick={() => onNavigate?.(machinesView(machine))}>
            <ArrowUpRight />
            <span>{tRich('machineScope.onMachine.open', { machine: <MachinePill name={machine} /> })}</span>
          </Button>
        }
      />
    </SettingsSection>
  );
}

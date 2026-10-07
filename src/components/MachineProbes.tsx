import { useState } from 'react';
import { useI18n } from '../i18n';
import { invokeCommand } from '../native/commands';
import {
  PROBE_STATE_LABEL,
  PROBE_STATE_TONE,
  canInstallProbe,
  canRemoveProbe,
  probeState,
  showMachineProbes,
  useMachineProbes,
  type ProbeState,
} from '../services/machineProbes';
import { plainError } from '../services/plainError';
import { useConfirmation } from './ConfirmationDialog';
import { MachinePill } from './identity/Identity';
import { SettingsBlock, SettingsRow, SettingsSection } from './layout/settings';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
import { StatusDot } from './ui/status-dot';
import { toast } from './ui/toast';

/** Installing, updating and removing probes, each confirmed first: both change what runs at login on the machine. */
function useProbeActions() {
  const { t } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ machine: string; error: string } | null>(null);

  const install = async (machine: string, state: ProbeState, version: string | null) => {
    const update = state !== 'none';
    const asked = await askConfirmation({
      title: t(update ? 'machines.probe.update.title' : 'machines.probe.install.title', { machine }),
      message: t('machines.probe.install.message', { machine, version: version ?? '' }),
      confirmText: t(update ? 'machines.probe.update' : 'machines.probe.install'),
    });
    if (!asked) return;
    setBusy(machine);
    setFailed(null);
    try {
      showMachineProbes(await invokeCommand('install_machine_probe', { machine }));
      toast({ title: t(update ? 'machines.probe.updated' : 'machines.probe.installed', { machine }) });
    } catch (reason) {
      setFailed({ machine, error: plainError(reason, t) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (machine: string) => {
    const asked = await askConfirmation({
      title: t('machines.probe.remove.title', { machine }),
      message: t('machines.probe.remove.message', { machine }),
      confirmText: t('machines.probe.remove'),
      variant: 'danger',
    });
    if (!asked) return;
    setBusy(machine);
    setFailed(null);
    try {
      showMachineProbes(await invokeCommand('uninstall_machine_probe', { machine }));
      toast({ title: t('machines.probe.removed', { machine }) });
    } catch (reason) {
      setFailed({ machine, error: plainError(reason, t) });
    } finally {
      setBusy(null);
    }
  };

  return { busy, failed, install, remove };
}

type Actions = ReturnType<typeof useProbeActions>;

function ProbeLine({ machine, state, version, actions, pill }: { machine: string; state: ProbeState; version: string | null; actions: Actions; pill: boolean }) {
  const { t } = useI18n();
  const busy = actions.busy === machine;
  const failed = actions.failed?.machine === machine ? actions.failed.error : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-3">
        {pill ? <MachinePill name={machine} /> : null}
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot tone={PROBE_STATE_TONE[state]} />
          {t(PROBE_STATE_LABEL[state])}
        </span>
        {busy ? <Spinner /> : null}
        {canRemoveProbe(state) ? (
          <Button size="xs" variant="ghost-muted" disabled={actions.busy !== null} onClick={() => void actions.remove(machine)}>
            {t('machines.probe.remove')}
          </Button>
        ) : null}
        {version && canInstallProbe(state) ? (
          <Button size="xs" variant="outline" disabled={actions.busy !== null} onClick={() => void actions.install(machine, state, version)}>
            {t(state === 'none' ? 'machines.probe.install' : 'machines.probe.update')}
          </Button>
        ) : null}
      </div>
      {failed ? <p className="text-xs text-error-foreground" role="alert">{failed}</p> : null}
    </div>
  );
}

/** Why machine health isn't read through Grove, when it isn't: the readings come from Arbor's own script meanwhile. */
export function GroveUnavailableNote() {
  const { t } = useI18n();
  const probes = useMachineProbes();
  if (!probes?.unavailable) return null;
  return (
    <SettingsBlock>
      <Alert variant="warning">
        <AlertDescription><p>{t('machines.probe.unavailable', { reason: probes.unavailable })}</p></AlertDescription>
      </Alert>
    </SettingsBlock>
  );
}

/** One machine's probe, on its page under its readings. */
export function MachineProbeBlock({ machine }: { machine: string }) {
  const { t } = useI18n();
  const probes = useMachineProbes();
  const actions = useProbeActions();
  const state = probeState(probes, machine);
  if (!probes) return null;
  return (
    <SettingsBlock className="flex flex-col gap-1.5">
      <p className="text-xs font-medium">{t('machines.probe.title')}</p>
      <ProbeLine machine={machine} state={state} version={probes.version} actions={actions} pill={false} />
      {state === 'none' ? <p className="text-xs text-muted-foreground">{t('machines.probe.noneHint')}</p> : null}
    </SettingsBlock>
  );
}

/** Settings › Machines › Health probes: every machine Grove reads, with its probe. */
export function MachineProbesSettings() {
  const { t } = useI18n();
  const probes = useMachineProbes();
  const actions = useProbeActions();
  return (
    <SettingsSection title={t('machines.probe.settings.title')} description={t('machines.probe.settings.description')}>
      <SettingsRow
        settingId="machines.health-probes"
        align="start"
        title={t('machines.probe.title')}
        description={probes?.version ? t('machines.probe.settings.version', { version: probes.version }) : t('machines.probe.noBundle')}
      >
        {probes?.unavailable ? (
          <p className="text-xs text-muted-foreground">{t('machines.probe.unavailable', { reason: probes.unavailable })}</p>
        ) : probes && probes.machines.length ? (
          <ul className="divide-y divide-border/60 rounded-lg border border-border/70">
            {probes.machines.map((probe) => (
              <li key={probe.machine} className="px-3 py-2">
                <ProbeLine machine={probe.machine} state={probeState(probes, probe.machine)} version={probes.version} actions={actions} pill />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t(probes ? 'machines.probe.settings.empty' : 'machines.probe.settings.loading')}</p>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

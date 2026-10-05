import { useEffect, useState } from 'react';
import { SettingsRow, SettingsSection } from '../components/layout/settings';
import { Button } from '../components/ui/button';
import { draftFromNumber, NumberField, numberFromDraft } from '../components/ui/number-field';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { useI18n } from '../i18n';
import { formatAgo } from '../lib/format';
import { cn } from '../lib/utils';
import { parsePort } from '../services/machineHealth';
import { plainError } from '../services/plainError';
import { DEFAULT_TELEMETRY_PORT, machineTelemetryState, setAgentTelemetry, takeAgentTelemetry, telemetryNeedsSetup, useAgentTelemetry } from '../services/agentTelemetry';
import { MachinePill } from '../components/identity/Identity';

/**
 * Settings › Machines: whether Arbor takes Claude Code's own telemetry, and on which port. Each machine is set up to
 * send it from the Machines page.
 */
export function AgentTelemetrySettings() {
  const { t } = useI18n();
  const { status, error: loadError } = useAgentTelemetry();
  const [port, setPort] = useState(String(DEFAULT_TELEMETRY_PORT));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedPort = status?.port ?? DEFAULT_TELEMETRY_PORT;
  useEffect(() => setPort(String(savedPort)), [savedPort]);

  const parsed = parsePort(port);
  const save = async (enabled: boolean, nextPort: number) => {
    setBusy(true);
    setError(null);
    try {
      takeAgentTelemetry(await setAgentTelemetry(enabled, nextPort));
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };

  const listening = status?.listening ?? null;
  const state = !status
    ? ''
    : status.error
      ? t('telemetry.settings.failed', { error: plainError(status.error, t) })
      : listening
        ? t('telemetry.settings.listening', { address: listening })
        : t('telemetry.settings.off');
  const nowMs = Date.now();

  return (
    <SettingsSection title={t('telemetry.settings.title')} description={t('telemetry.settings.description')}>
      <SettingsRow
        settingId="machines.telemetry"
        title={t('telemetry.settings.receive')}
        description={t('telemetry.settings.receiveHint')}
        status={state ? <span className={cn(status?.error ? 'text-error-foreground' : undefined)}>{state}</span> : null}
        control={
          <>
            {busy ? <Spinner /> : null}
            <Switch
              checked={status?.enabled ?? false}
              disabled={!status || busy}
              onCheckedChange={(checked) => void save(checked, status?.port ?? DEFAULT_TELEMETRY_PORT)}
              aria-label={t('telemetry.settings.receive')}
            />
          </>
        }
      />
      <SettingsRow
        settingId="machines.telemetry-port"
        title={t('telemetry.settings.port')}
        description={t('telemetry.settings.portHint')}
        control={
          <>
            <NumberField
              wrapperClassName="w-24"
              font="mono"
              min={1}
              max={65535}
              value={numberFromDraft(port)}
              onValueChange={(next) => setPort(draftFromNumber(next))}
              aria-label={t('telemetry.settings.port')}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!status || busy || parsed === null || parsed === savedPort}
              onClick={() => { if (parsed !== null) void save(status?.enabled ?? false, parsed); }}
            >
              {t('telemetry.settings.savePort')}
            </Button>
          </>
        }
      />
      {status && status.enabled && !status.lan ? (
        <div className="px-4 py-3 text-sm text-warning-foreground" role="status">{t('telemetry.settings.localOnly')}</div>
      ) : null}
      {error || loadError ? <div className="px-4 py-3 text-sm text-error-foreground" role="alert">{error ?? loadError}</div> : null}
      <SettingsRow
        settingId="machines.telemetry-machines"
        title={t('telemetry.settings.machines')}
        description={status?.machines.length ? undefined : t('telemetry.settings.noMachines')}
        align="start"
      >
        {status?.machines.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {status.machines.map((entry) => {
              const { state: machineState } = machineTelemetryState(status, entry.machine, nowMs);
              return (
                <li key={entry.machine} className="flex items-center gap-3">
                  <span className="flex w-40 min-w-0 shrink-0"><MachinePill name={entry.machine} /></span>
                  <span className={cn('text-muted-foreground', machineState === 'quiet' || telemetryNeedsSetup(entry) ? 'text-warning-foreground' : undefined)}>
                    {entry.cumulative
                      ? t('telemetry.machine.cumulative')
                      : entry.stalePort !== null
                        ? t('telemetry.machine.stalePort', { port: entry.stalePort, current: status.port })
                        : entry.lastMs !== null
                          ? t('telemetry.settings.lastSent', { time: formatAgo(entry.lastMs, nowMs) })
                          : t('telemetry.settings.nothingYet')}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}

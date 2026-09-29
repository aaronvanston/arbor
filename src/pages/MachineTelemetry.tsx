import { useState } from 'react';
import { Radio, RadioTower } from '../components/ui/icons';
import { useConfirmation } from '../components/ConfirmationDialog';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { useI18n } from '../i18n';
import { MachinePill } from '../components/identity/Identity';
import { formatAgo } from '../lib/format';
import { cn } from '../lib/utils';
import { machineTelemetryState, reloadAgentTelemetry, setMachineTelemetry, telemetryNeedsSetup, telemetryPlanText, useAgentTelemetry } from '../services/agentTelemetry';
import type { MachineHealth } from '../native/types';

type Outcome = { ok: boolean; text: string; details: string[] };

/**
 * The expanded machine's telemetry row: whether its Claude Code sends Arbor what it spends by skill, plugin, MCP
 * server and subagent, and a button to set that up or take it away. Both show which files change first.
 */
export function MachineTelemetryRow({ item }: { item: MachineHealth }) {
  const { t, tRich } = useI18n();
  const { status } = useAgentTelemetry();
  const { askConfirmation } = useConfirmation();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const reachable = item.status !== 'unreachable' && item.status !== 'pending';
  const nowMs = Date.now();
  const { state, entry } = machineTelemetryState(status, item.machine, nowMs);
  const on = state !== 'off';
  const again = telemetryNeedsSetup(entry);

  const change = async (enabled: boolean) => {
    setBusy(true);
    setOutcome(null);
    try {
      const plan = await setMachineTelemetry(item.machine, enabled, true);
      const confirmed = await askConfirmation({
        title: tRich(enabled ? 'telemetry.machine.setupTitle' : 'telemetry.machine.removeTitle', { machine: <MachinePill name={item.machine} size="lg" /> }),
        message: enabled
          ? t('telemetry.machine.setupMessage', { endpoint: plan.endpoints.join(', ') || t('telemetry.machine.noEndpoint') })
          : t('telemetry.machine.removeMessage'),
        details: plan.files.map((file) => ({ label: file.path, value: telemetryPlanText(file, enabled, t) })),
        warning: enabled ? t('telemetry.machine.setupWarning') : undefined,
        confirmText: t(enabled ? 'telemetry.machine.setUp' : 'telemetry.machine.remove'),
        variant: enabled ? 'primary' : 'danger',
      });
      if (!confirmed) return;
      const done = await setMachineTelemetry(item.machine, enabled);
      const failed = done.files.filter((file) => file.error);
      const written = done.files.filter((file) => file.written).length;
      setOutcome({
        ok: !failed.length,
        text: failed.length
          ? t(failed.length === 1 ? 'telemetry.machine.failed.one' : 'telemetry.machine.failed.other', { count: failed.length })
          : !enabled
            ? t('telemetry.machine.removed')
            : t(written === 1 ? 'telemetry.machine.done.one' : 'telemetry.machine.done.other', { count: written }),
        details: failed.map((file) => `${file.path}: ${file.error}`),
      });
    } catch (error) {
      setOutcome({ ok: false, text: t('telemetry.machine.error'), details: [String(error)] });
    } finally {
      setBusy(false);
      void reloadAgentTelemetry();
    }
  };

  const text = state === 'off'
    ? t('telemetry.machine.off')
    : state === 'stopped'
      ? t('telemetry.machine.stopped')
      : entry?.cumulative
        ? t('telemetry.machine.cumulative')
        : entry?.stalePort != null && status
          ? t('telemetry.machine.stalePort', { port: entry.stalePort, current: status.port })
          : state === 'waiting'
          ? t('telemetry.machine.waiting')
          : t(state === 'quiet' ? 'telemetry.machine.quiet' : 'telemetry.machine.receiving', { time: entry?.lastMs ? formatAgo(entry.lastMs, nowMs) : '' });
  const attention = state === 'stopped' || state === 'quiet' || again;
  const unavailable = !reachable
    ? t('machines.agents.updateUnreachable')
    : !status?.enabled
      ? t('telemetry.machine.receiverOff')
      : !item.local && !status.lan
        ? t('telemetry.machine.localOnly')
        : undefined;

  return (
    <div className="flex flex-col gap-1.5 border-t border-border/40 pt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="w-24 shrink-0 text-sm font-medium text-foreground">{t('telemetry.machine.label')}</span>
        <span className={cn('min-w-0 flex-1 truncate text-sm', !on ? 'text-muted-foreground' : attention ? 'text-warning-foreground' : 'text-foreground')} title={text}>
          {text}
        </span>
        <span className="ms-auto flex items-center gap-2">
          {!on || again ? (
            <Button variant="outline" size="xs" disabled={busy} onClick={() => void change(true)} disabledReason={unavailable}>
              {busy ? <Spinner /> : <RadioTower />}
              {t(on ? 'telemetry.machine.setUpAgain' : 'telemetry.machine.setUp')}
            </Button>
          ) : null}
          {on ? (
            <Button
              variant="ghost-muted"
              size="xs"
              disabled={busy}
              onClick={() => void change(false)}
              disabledReason={reachable ? undefined : t('machines.agents.updateUnreachable')}
            >
              {busy && !again ? <Spinner /> : <Radio />}
              {t('telemetry.machine.remove')}
            </Button>
          ) : null}
        </span>
      </div>
      {outcome ? (
        <div className={cn('text-xs', outcome.ok ? 'text-muted-foreground' : 'text-error-foreground')} role="status">
          <p>{outcome.text}</p>
          {outcome.details.length ? <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-2xs">{outcome.details.join('\n')}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

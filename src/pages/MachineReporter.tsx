import { useState } from 'react';
import { BellOff, BellRing } from '../components/ui/icons';
import { useConfirmation } from '../components/ConfirmationDialog';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { MachinePill } from '../components/identity/Identity';
import { cn } from '../lib/utils';
import { setAgentReporter } from '../services/agentAttention';
import type { AgentKind, MachineHealth, ReporterFile, ReporterStatus } from '../native/types';

type Translate = (key: MessageKey, variables?: Record<string, string | number>) => string;

const AGENT_NAME: Record<AgentKind, MessageKey> = {
  claude: 'machines.agents.name.claude',
  codex: 'machines.agents.name.codex',
};

const NO_REPORTER: ReporterStatus = { installed: false, homes: [] };

/** What setting the reporter up, or taking it away, does to one settings file. */
export function reporterPlanText(file: ReporterFile, enabled: boolean, t: Translate) {
  if (file.error) return t('machines.reporter.plan.error', { error: file.error });
  if (file.change === 'none') return t(enabled ? 'machines.reporter.plan.none' : 'machines.reporter.plan.nothing');
  if (!enabled) {
    if (file.agent === 'claude') return t('machines.reporter.plan.claudeRemove');
    return t(file.chained ? 'machines.reporter.plan.codexRestore' : 'machines.reporter.plan.codexRemove');
  }
  if (file.agent === 'claude') return t(file.change === 'create' ? 'machines.reporter.plan.claudeCreate' : 'machines.reporter.plan.claudeAdd');
  if (file.change === 'create') return t('machines.reporter.plan.codexCreate');
  return t(file.chained ? 'machines.reporter.plan.codexChain' : 'machines.reporter.plan.codexAdd');
}

/** Where the reporter runs: "Claude Code (2 homes) · Codex (1 home)". */
export function reporterHomesText(status: ReporterStatus, t: Translate) {
  return (['claude', 'codex'] as const)
    .map((agent) => {
      const count = status.homes.filter((home) => home.agent === agent && home.reporting).length;
      if (!count) return '';
      return t(count === 1 ? 'machines.reporter.homes.one' : 'machines.reporter.homes.other', { agent: t(AGENT_NAME[agent]), count });
    })
    .filter(Boolean)
    .join(' · ');
}

type Outcome = { ok: boolean; text: string; details: string[] };

/**
 * The expanded machine's alerts row: whether Arbor's reporter tells it when an agent there is waiting on its user,
 * and a button to set it up or take it away. Both show exactly which files change before anything does.
 */
export function MachineReporterRow({ item }: { item: MachineHealth }) {
  const { t, tRich } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const status = item.agents.reporter ?? NO_REPORTER;
  const reachable = item.status !== 'unreachable' && item.status !== 'pending';
  const missing = status.installed ? status.homes.filter((home) => !home.reporting) : [];
  const homes = reporterHomesText(status, t);

  const change = async (enabled: boolean) => {
    setBusy(true);
    setOutcome(null);
    try {
      const plan = await setAgentReporter(item.machine, enabled, true);
      const confirmed = await askConfirmation({
        title: tRich(enabled ? 'machines.reporter.setupTitle' : 'machines.reporter.removeTitle', { machine: <MachinePill name={item.machine} size="lg" /> }),
        message: t(enabled ? 'machines.reporter.setupMessage' : 'machines.reporter.removeMessage'),
        details: plan.files.map((file) => ({ label: file.path, value: reporterPlanText(file, enabled, t) })),
        warning: enabled ? t('machines.reporter.setupWarning') : undefined,
        confirmText: t(enabled ? 'machines.reporter.setUp' : 'machines.reporter.remove'),
        variant: enabled ? 'primary' : 'danger',
      });
      if (!confirmed) return;
      const done = await setAgentReporter(item.machine, enabled);
      const failed = done.files.filter((file) => file.error);
      const written = done.files.filter((file) => file.written).length;
      setOutcome({
        ok: !failed.length,
        text: failed.length
          ? t(failed.length === 1 ? 'machines.reporter.failed.one' : 'machines.reporter.failed.other', { count: failed.length })
          : !enabled
            ? t('machines.reporter.removed')
            : written
              ? t(written === 1 ? 'machines.reporter.done.one' : 'machines.reporter.done.other', { count: written })
              : t('machines.reporter.already'),
        details: failed.map((file) => `${file.path}: ${file.error}`),
      });
    } catch (error) {
      setOutcome({ ok: false, text: t('machines.reporter.error'), details: [String(error)] });
    } finally {
      setBusy(false);
    }
  };

  const text = !status.installed
    ? t('machines.reporter.off')
    : homes || t('machines.reporter.noHomes');

  return (
    <div className="flex flex-col gap-1.5 border-t border-border/40 pt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="w-24 shrink-0 text-sm font-medium text-foreground">{t('machines.reporter.label')}</span>
        <span className={cn('min-w-0 flex-1 truncate text-sm', status.installed ? 'text-foreground' : 'text-muted-foreground')} title={text}>
          {text}
          {missing.length ? (
            <span className="text-warning-foreground" title={missing.map((home) => home.home).join('\n')}>
              {' · '}
              {t(missing.length === 1 ? 'machines.reporter.missing.one' : 'machines.reporter.missing.other', { count: missing.length })}
            </span>
          ) : null}
        </span>
        <span className="ms-auto flex items-center gap-2">
          {!status.installed || missing.length ? (
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => void change(true)}
              disabledReason={reachable ? undefined : t('machines.agents.updateUnreachable')}
            >
              {busy ? <Spinner /> : <BellRing />}
              {t(status.installed ? 'machines.reporter.setUpAgain' : 'machines.reporter.setUp')}
            </Button>
          ) : null}
          {status.installed ? (
            <Button
              variant="ghost-muted"
              size="xs"
              disabled={busy}
              onClick={() => void change(false)}
              disabledReason={reachable ? undefined : t('machines.agents.updateUnreachable')}
            >
              {busy && !missing.length ? <Spinner /> : <BellOff />}
              {t('machines.reporter.remove')}
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

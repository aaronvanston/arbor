import { useState } from 'react';
import { ArrowUpCircle, Bot } from '../components/ui/icons';
import { useI18n } from '../i18n';
import { formatWhen } from '../lib/format';
import type { MessageKey } from '../i18n/resources';
import { useConfirmation } from '../components/ConfirmationDialog';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { MiddleTruncate } from '../components/ui/middle-truncate';
import { MachinePill } from '../components/identity/Identity';
import { cn } from '../lib/utils';
import { useT3Compatibility } from '../services/agentReleases';
import { agentsBehind, runningAgents, type AgentBehind, type NewestAgents } from '../services/agentVersions';
import { AGENT_KINDS, updateMachineAgent } from '../services/machineHealth';
import { t3Advisory, type T3Advisory } from '../services/t3Compat';
import { agentBehindProblem, agentCheckFailedProblem, agentUpdateFailedProblem, duplicateInstallProblem, t3AdvisoryProblem } from '../services/fixPrompt';
import { FixMenu } from '../components/FixMenu';
import { MachineReporterRow } from './MachineReporter';
import { MachineTelemetryRow } from './MachineTelemetry';
import type { AgentInstall, AgentKind, AgentUpdate, InstallMethod, MachineHealth } from '../native/types';

export const AGENT_NAME: Record<AgentKind, MessageKey> = {
  claude: 'machines.agents.name.claude',
  codex: 'machines.agents.name.codex',
};

/** How an install was made, as the row and the update's confirmation name it. Unproven ones aren't named. */
export const INSTALL_METHOD: Record<InstallMethod, MessageKey | null> = {
  native: 'machines.agents.method.native',
  homebrew: 'machines.agents.method.homebrew',
  npm: 'machines.agents.method.npm',
  bun: 'machines.agents.method.bun',
  pnpm: 'machines.agents.method.pnpm',
  mise: 'machines.agents.method.mise',
  unknown: null,
};

/** A home-directory path as the user would type it: /Users/casey/.local/bin/claude reads ~/.local/bin/claude. */
export const shortAgentPath = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, '~');

function useBehindText() {
  const { t } = useI18n();
  return (entry: AgentBehind) => {
    const fields = { agent: t(AGENT_NAME[entry.agent]), version: entry.version, newest: entry.newest };
    return entry.machine ? t('machines.agents.behindTitle', { ...fields, machine: entry.machine }) : t('machines.agents.behindLatestTitle', fields);
  };
}

/** The collapsed row's view of a machine's agents: how many are running, and whether one is behind its latest release or the fleet. */
export function MachineAgentSummary({ item, newest }: { item: MachineHealth; newest: NewestAgents }) {
  const { t } = useI18n();
  const behindText = useBehindText();
  const running = runningAgents(item);
  const behind = agentsBehind(item, newest);
  const total = running ? running.claude + running.codex : 0;
  const runningText = running ? t('machines.agents.runningTitle', { claude: running.claude, codex: running.codex }) : '';
  return (
    <>
      {total ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground" title={runningText}>
          <Bot className="size-3.5 text-icon-muted" aria-hidden="true" />
          <span className="tabular-nums" aria-hidden="true">{total}</span>
          <span className="sr-only">{runningText}</span>
        </span>
      ) : null}
      {behind.length ? (
        <Badge variant="warning" size="sm" className="shrink-0" title={behind.map(behindText).join('\n')}>
          {behind.length === 1 ? t('machines.agents.behind', { agent: t(AGENT_NAME[behind[0]!.agent]) }) : t('machines.agents.behindMany')}
        </Badge>
      ) : null}
    </>
  );
}

export type UpdateOutcome = { ok: boolean; text: string; output: string };

/**
 * What an update that went through did: moved the version on, left it where it was, or can't say. A version that
 * didn't move isn't proof it's the latest (a package manager can lag the agent's own releases), so it isn't called that.
 */
export function updateOutcomeText(t: ReturnType<typeof useI18n>['t'], agent: AgentKind, result: AgentUpdate) {
  const name = t(AGENT_NAME[agent]);
  return result.before && result.after && result.before !== result.after
    ? t('machines.agents.updated', { agent: name, before: result.before, after: result.after })
    : result.after && result.before === result.after
    ? t('machines.agents.unchanged', { agent: name, version: result.after })
    : t('machines.agents.updateDone', { agent: name });
}

/**
 * Updates a machine's agent the way it was installed, once its user has seen the command and said so, and keeps what
 * each update did. A machine's page and its checklist both update this way.
 */
export function useAgentUpdate(item: MachineHealth) {
  const { t, tRich } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [pending, setPending] = useState<AgentKind[]>([]);
  const [outcomes, setOutcomes] = useState<Partial<Record<AgentKind, UpdateOutcome>>>({});
  const running = runningAgents(item);

  const update = async (agent: AgentKind) => {
    const install = item.agents[agent];
    if (!install) return;
    const name = t(AGENT_NAME[agent]);
    const count = running?.[agent] ?? 0;
    const method = INSTALL_METHOD[install.method];
    const confirmed = await askConfirmation({
      title: tRich('machines.agents.updateTitle', { agent: name, machine: <MachinePill name={item.machine} size="lg" /> }),
      message: t('machines.agents.updateMessage', { command: install.updateCommand }),
      details: [
        { label: t('machines.agents.detail.version'), value: install.version ?? t('machines.agents.unknownVersion') },
        { label: t('machines.agents.detail.path'), value: shortAgentPath(install.path) },
        ...(method ? [{ label: t('machines.agents.detail.method'), value: t(method) }] : []),
      ],
      warning: count ? t(count === 1 ? 'machines.agents.runningWarning.one' : 'machines.agents.runningWarning.other', { count, agent: name }) : undefined,
      confirmText: t('machines.agents.update'),
    });
    if (!confirmed) return;
    setPending((current) => [...current, agent]);
    setOutcomes((current) => ({ ...current, [agent]: undefined }));
    try {
      const result = await updateMachineAgent(item.machine, agent, install.updateCommand);
      setOutcomes((current) => ({ ...current, [agent]: { ok: true, text: updateOutcomeText(t, agent, result), output: result.output } }));
    } catch (error) {
      setOutcomes((current) => ({ ...current, [agent]: { ok: false, text: t('machines.agents.updateFailed', { agent: name }), output: String(error) } }));
    } finally {
      setPending((current) => current.filter((entry) => entry !== agent));
    }
  };
  const busy = (agent: AgentKind) => pending.includes(agent) || item.agents.updating.includes(agent);
  return { update, busy, outcomes };
}

/** What an update did, with the agent's own output a click away, or in full when it failed. */
export function UpdateOutcomeView({ outcome, fix }: {
  outcome: UpdateOutcome;
  /** The machine and agent, so a failed update can be handed to an agent to fix. */
  fix?: { machine: string; agent: AgentKind; item?: MachineHealth | null };
}) {
  const { t } = useI18n();
  return (
    <div className={cn('text-xs', outcome.ok ? 'text-muted-foreground' : 'text-error-foreground')} role="status">
      <p className="flex flex-wrap items-center gap-2">
        {outcome.text}
        {fix && !outcome.ok ? (
          <FixMenu
            machine={fix.machine}
            item={fix.item}
            problem={agentUpdateFailedProblem({ agent: fix.agent, command: fix.item?.agents[fix.agent]?.updateCommand ?? null, output: outcome.output }, t)}
          />
        ) : null}
      </p>
      {outcome.output ? (
        outcome.ok ? (
          <details className="mt-1">
            <summary className="cursor-pointer text-muted-foreground">{t('machines.agents.output')}</summary>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-2xs text-muted-foreground">{outcome.output}</pre>
          </details>
        ) : (
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-2xs">{outcome.output}</pre>
        )
      ) : null}
    </div>
  );
}

/** Why T3 Code on the machine warns about an agent's version, and what it recommends instead. */
export function t3AdvisoryText(
  t: ReturnType<typeof useI18n>['t'],
  advisory: T3Advisory,
  fields: { agent: AgentKind; version: string; t3Version: string | null },
) {
  const values = {
    app: fields.t3Version ? t('machines.agents.t3.app', { version: fields.t3Version }) : t('machines.agents.t3.appName'),
    agent: t(AGENT_NAME[fields.agent]),
    version: fields.version,
  };
  const reason = t(advisory.status === 'broken' ? 'machines.agents.t3.broken' : 'machines.agents.t3.unsupported', values);
  return advisory.recommendation ? `${reason} ${t('machines.agents.t3.use', { recommendation: advisory.recommendation })}` : reason;
}

/**
 * The same agent installed more than once on a machine: each copy's path and version, the one the shell finds first
 * at the top. Only that one is updated, so an older one elsewhere can still start from a shell with another PATH.
 */
export function AgentCopies({ agent, install, item }: { agent: AgentKind; install: AgentInstall; item?: MachineHealth }) {
  const { t } = useI18n();
  if (!install.copies.length) return null;
  const copies = [{ path: install.path, real: install.real, version: install.version }, ...install.copies];
  const problem = duplicateInstallProblem({
    agent,
    copies: copies.map((copy) => `${copy.real && copy.real !== copy.path ? `${copy.path} → ${copy.real}` : copy.path} (${copy.version ?? '?'})`),
  }, t);
  return (
    <Alert variant="warning" className="px-3 py-2 text-xs">
      <AlertTitle className="flex flex-wrap items-center justify-between gap-2">
        {t('machines.agents.copies.title', { agent: t(AGENT_NAME[agent]), count: copies.length })}
        {item ? <FixMenu machine={item.machine} item={item} problem={problem} className="-my-1" /> : null}
      </AlertTitle>
      <AlertDescription className="gap-1.5">
        <span>{t('machines.agents.copies.description')}</span>
        <ul className="flex flex-col gap-1">
          {copies.map((copy, index) => (
            <li key={copy.path} className="flex min-w-0 items-center gap-2">
              <MiddleTruncate value={shortAgentPath(copy.path)} title={copy.real ?? copy.path} className="font-mono text-2xs" />
              <span className="shrink-0 text-2xs tabular-nums">{copy.version ?? t('machines.agents.unknownVersion')}</span>
              {index === 0 ? <Badge variant="outline" size="sm" className="shrink-0">{t('machines.agents.copies.first')}</Badge> : null}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/**
 * A machine's agents: installed versions, what's running, and an update button for each, then whether Arbor's reporter
 * tells it when one is waiting on its user. `embedded` is for a card of its own that's already titled, on the
 * machine's page: no box or title of its own, only when they were last checked.
 */
export function MachineAgentsBlock({ item, newest, embedded = false }: { item: MachineHealth; newest: NewestAgents; embedded?: boolean }) {
  const { t, tRich } = useI18n();
  const behindText = useBehindText();
  const { update, busy: updating, outcomes } = useAgentUpdate(item);
  const { agents } = item;
  const running = runningAgents(item);
  const behind = agentsBehind(item, newest);
  const reachable = item.status !== 'unreachable' && item.status !== 'pending';
  // T3 Code's policies are only asked for while a machine shown runs it.
  const policies = useT3Compatibility(agents.t3 !== null);

  const status = agents.error
    ? t('machines.agents.checkFailed', { error: agents.error })
    : agents.checkedAt
    ? t('machines.agents.checked', { time: formatWhen(agents.checkedAt) })
    : reachable
    ? t('machines.agents.checking')
    : '';

  return (
    <section
      className={cn('flex min-w-0 flex-col gap-2', embedded ? 'px-4 py-3' : 'rounded-lg border border-border/50 bg-background/50 p-3 dark:bg-input/10')}
      aria-label={t('machines.agents.title')}
    >
      <div className={cn('flex h-5 items-center gap-2', embedded ? 'justify-end' : 'justify-between')}>
        {embedded ? null : (
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Bot className="size-3.5 shrink-0 text-icon-muted" aria-hidden="true" />
            {t('machines.agents.title')}
          </span>
        )}
        <span className="flex min-w-0 items-center gap-1">
          <span className={cn('truncate text-2xs', agents.error ? 'text-warning-foreground' : 'text-muted-foreground')} title={agents.error ?? undefined}>
            {status}
          </span>
          {agents.error ? <FixMenu compact machine={item.machine} item={item} problem={agentCheckFailedProblem(agents.error, t)} /> : null}
        </span>
      </div>
      <div className="flex flex-col divide-y divide-border/40">
        {AGENT_KINDS.map((agent) => {
          const install = agents[agent];
          const method = install ? INSTALL_METHOD[install.method] : null;
          const lag = behind.find((entry) => entry.agent === agent);
          const advisory = install && agents.t3 ? t3Advisory(policies, agent, install.version, agents.t3.version) : null;
          const advisoryText = advisory && install?.version
            ? t3AdvisoryText(t, advisory, { agent, version: install.version, t3Version: agents.t3?.version ?? null })
            : null;
          const busy = updating(agent);
          const outcome = outcomes[agent];
          const count = running?.[agent] ?? null;
          return (
            <div key={agent} className="flex flex-col gap-1.5 py-2 first:pt-1 last:pb-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="w-24 shrink-0 text-sm font-medium text-foreground">{t(AGENT_NAME[agent])}</span>
                {install ? (
                  <>
                    <span className={cn('text-sm tabular-nums', install.version ? 'text-foreground' : 'text-muted-foreground')}>
                      {install.version ?? t('machines.agents.unknownVersion')}
                    </span>
                    {lag ? (
                      // Grown past the small badge's height when it holds the newer machine's pill.
                      <Badge variant="warning" size="sm" className={cn(lag.machine && 'h-auto py-px')} title={behindText(lag)}>
                        {lag.machine
                          ? tRich('machines.agents.newer', { version: lag.newest, machine: <MachinePill name={lag.machine} size="sm" /> })
                          : t('machines.agents.newerLatest', { version: lag.newest })}
                      </Badge>
                    ) : null}
                    {advisory && advisoryText ? (
                      <Badge variant="warning" size="sm" title={advisoryText}>
                        {t(advisory.status === 'broken' ? 'machines.agents.t3.brokenLabel' : 'machines.agents.t3.unsupportedLabel')}
                      </Badge>
                    ) : null}
                    <MiddleTruncate value={shortAgentPath(install.path)} title={install.real ?? install.path} className="font-mono text-2xs text-muted-foreground" />
                    {method ? (
                      <span className="shrink-0 text-2xs text-muted-foreground" title={t('machines.agents.methodTitle', { command: install.updateCommand })}>
                        {t(method)}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-sm text-muted-foreground">{agents.checkedAt ? t('machines.agents.notFound') : '—'}</span>
                )}
                <span className="ms-auto flex items-center gap-3">
                  {count !== null && install ? (
                    <span className="text-2xs tabular-nums text-muted-foreground">{t('machines.agents.running', { count })}</span>
                  ) : null}
                  {install && (lag || advisoryText) ? (
                    <FixMenu
                      machine={item.machine}
                      item={item}
                      problem={lag ? agentBehindProblem(lag, item, t) : t3AdvisoryProblem(agent, advisoryText ?? '', t)}
                    />
                  ) : null}
                  {install ? (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={busy}
                      onClick={() => void update(agent)}
                      disabledReason={reachable ? undefined : t('machines.agents.updateUnreachable')}
                    >
                      {busy ? <Spinner /> : <ArrowUpCircle />}
                      {busy ? t('machines.agents.updating') : t('machines.agents.update')}
                    </Button>
                  ) : null}
                </span>
              </div>
              {advisoryText ? <p className="text-xs text-warning-foreground">{advisoryText}</p> : null}

              {install ? <AgentCopies agent={agent} install={install} item={item} /> : null}
              {outcome ? <UpdateOutcomeView outcome={outcome} fix={{ machine: item.machine, agent, item }} /> : null}
            </div>
          );
        })}
      </div>
      <MachineReporterRow item={item} />
      <MachineTelemetryRow item={item} />
    </section>
  );
}

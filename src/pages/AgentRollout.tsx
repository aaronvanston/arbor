import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowUpCircle, FlaskConical } from '../components/ui/icons';
import { useConfirmation } from '../components/ConfirmationDialog';
import { SettingsSection } from '../components/layout/settings';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { TABLE_NUMERIC_CLASS } from '../components/ui/data-table';
import { Spinner } from '../components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatCount, formatPercent, formatWhen } from '../lib/format';
import { cn } from '../lib/utils';
import {
  agentRollout,
  atLatest,
  errorsOf,
  getClientVersions,
  rollbackCommand,
  ROLLOUT_DAYS,
  shareOf,
  TRIAL_MIN_REQUESTS,
  trialMachine,
  type AgentRollout,
  type RolloutMachine,
  type RolloutVerdict,
  type Tally,
} from '../services/agentRollout';
import { useLatestAgentVersions } from '../services/agentReleases';
import { compareVersions } from '../services/agentVersions';
import { AGENT_KINDS, fetchMachineHealth, updateMachineAgent } from '../services/machineHealth';
import { AGENT_NAME, updateOutcomeText, UpdateOutcomeView, type UpdateOutcome } from './MachineAgents';
import { CommandLine } from '../components/CommandLine';
import type { AgentKind, ClientVersions, MachineHealth } from '../native/types';
import { MachinePill, MachinePills } from '../components/identity/Identity';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MACHINES_POLL_MS = 15_000;
// A week of requests by agent version, which a few minutes more hardly moves; each read walks all of it.
const VERSIONS_POLL_MS = 5 * 60_000;

const VERDICT: Record<RolloutVerdict, { label: MessageKey; variant: 'muted' | 'success' | 'warning' }> = {
  waiting: { label: 'rollout.verdict.waitingLabel', variant: 'muted' },
  fine: { label: 'rollout.verdict.fineLabel', variant: 'success' },
  worse: { label: 'rollout.verdict.worseLabel', variant: 'warning' },
  noBaseline: { label: 'rollout.verdict.noBaselineLabel', variant: 'muted' },
};

/** Updates one after another, stopping at the first that fails. */
type Run = { current: string | null; results: (UpdateOutcome & { machine: string })[]; notTried: number };

const rate = (count: number, requests: number) => formatPercent(shareOf(count, requests), 1);

/**
 * Agent updates, atop Sync › Agents (it was on Machines): a new Claude Code or Codex goes on one machine first, its
 * requests through the proxy are compared with the version the others still run, and only then do the rest update,
 * one at a time.
 */
export function AgentRolloutSection() {
  const { t, tRich } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [machines, setMachines] = useState<MachineHealth[] | null>(null);
  const [versions, setVersions] = useState<ClientVersions | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Partial<Record<AgentKind, Run>>>({});
  const [chosen, setChosen] = useState<Partial<Record<AgentKind, string>>>({});

  const loadMachines = useCallback(async () => {
    try {
      setMachines((await fetchMachineHealth(Date.now(), 1_000, true)).machines);
    } catch {
      // The versions table below says why; this keeps what it had.
    }
  }, []);
  const loadVersions = useCallback(async () => {
    const now = Date.now();
    try {
      setVersions(await getClientVersions(now - ROLLOUT_DAYS * DAY_MS, now + HOUR_MS));
      setVersionsError(null);
    } catch (error) {
      setVersionsError(String(error));
    }
  }, []);
  useEffect(() => {
    void loadMachines();
    void loadVersions();
    const machinesTimer = window.setInterval(() => { if (!document.hidden) void loadMachines(); }, MACHINES_POLL_MS);
    const versionsTimer = window.setInterval(() => { if (!document.hidden) void loadVersions(); }, VERSIONS_POLL_MS);
    return () => {
      window.clearInterval(machinesTimer);
      window.clearInterval(versionsTimer);
    };
  }, [loadMachines, loadVersions]);

  const latest = useLatestAgentVersions();
  const rollouts = useMemo(
    () => (machines ? AGENT_KINDS.flatMap((agent) => agentRollout(agent, machines, versions, latest[agent]) ?? []) : []),
    [machines, versions, latest],
  );

  const run = async (agent: AgentKind, targets: RolloutMachine[]) => {
    setRuns((current) => ({ ...current, [agent]: { current: targets[0]?.machine ?? null, results: [], notTried: 0 } }));
    const update = (change: (run: Run) => Run) => setRuns((current) => {
      const previous = current[agent];
      return previous ? { ...current, [agent]: change(previous) } : current;
    });
    for (const [index, { machine, command }] of targets.entries()) {
      update((previous) => ({ ...previous, current: machine }));
      try {
        const result = await updateMachineAgent(machine, agent, command);
        update((previous) => ({ ...previous, results: [...previous.results, { machine, ok: true, text: updateOutcomeText(t, agent, result), output: result.output }] }));
      } catch (error) {
        const failed = { machine, ok: false, text: t('machines.agents.updateFailed', { agent: t(AGENT_NAME[agent]) }), output: String(error) };
        update((previous) => ({ ...previous, results: [...previous.results, failed], notTried: targets.length - index - 1 }));
        break;
      } finally {
        await loadMachines();
      }
    }
    update((previous) => ({ ...previous, current: null }));
    void loadVersions();
  };

  const tryFirst = async (rollout: AgentRollout, machine: string) => {
    const entry = [...rollout.ahead, ...rollout.behind].find((candidate) => candidate.machine === machine);
    if (!entry) return;
    const name = t(AGENT_NAME[rollout.agent]);
    const confirmed = await askConfirmation({
      title: tRich('rollout.try.title', { machine: <MachinePill name={machine} size="lg" /> }),
      message: tRich('rollout.try.message', { command: entry.command, machine: <MachinePill name={machine} size="md" /> }),
      details: [{ label: t('machines.agents.detail.version'), value: entry.version ?? t('machines.agents.unknownVersion') }],
      warning: entry.running
        ? t(entry.running === 1 ? 'machines.agents.runningWarning.one' : 'machines.agents.runningWarning.other', { count: entry.running, agent: name })
        : undefined,
      confirmText: t('machines.agents.update'),
    });
    if (confirmed) await run(rollout.agent, [entry]);
  };

  const updateRest = async (rollout: AgentRollout) => {
    const targets = rollout.behind.filter((entry) => entry.reachable);
    if (!targets.length || !rollout.newest) return;
    const name = t(AGENT_NAME[rollout.agent]);
    const verdict = rollout.comparison?.verdict;
    const running = targets.reduce((sum, entry) => sum + (entry.running ?? 0), 0);
    const warnings = [
      verdict === 'worse' ? t('rollout.rest.warning.worse', { version: rollout.newest }) : null,
      verdict === 'waiting' ? t('rollout.rest.warning.waiting', { version: rollout.newest }) : null,
      verdict === 'noBaseline' ? t('rollout.rest.warning.noBaseline', { version: rollout.newest }) : null,
      running ? t(running === 1 ? 'rollout.rest.warning.running.one' : 'rollout.rest.warning.running.other', { count: running, agent: name }) : null,
    ].filter((text): text is string => text !== null);
    // Machines installed different ways update with different commands, so each is shown against its machine.
    const commands = new Set(targets.map((entry) => entry.command));
    const [command] = commands;
    const confirmed = await askConfirmation({
      title: t(targets.length === 1 ? 'rollout.rest.title.one' : 'rollout.rest.title.other', { agent: name, count: targets.length }),
      message: commands.size === 1 && command ? t('rollout.rest.message', { command }) : t('rollout.rest.messageMixed'),
      details: [
        {
          label: t('rollout.rest.machines'),
          value: (
            <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
              {targets.map((entry) => (
                <span key={entry.machine} className="inline-flex items-center gap-1">
                  <MachinePill name={entry.machine} size="sm" />
                  {entry.version ?? t('machines.agents.unknownVersion')}
                </span>
              ))}
            </span>
          ),
        },
        {
          label: t('rollout.rest.tried'),
          value: (
            <span className="inline-flex items-center gap-1">
              {rollout.newest}
              <MachinePills names={rollout.ahead.map((entry) => entry.machine)} />
            </span>
          ),
        },
        ...(commands.size > 1 ? targets.map((entry) => ({ label: <MachinePill name={entry.machine} size="sm" />, value: entry.command })) : []),
      ],
      warning: warnings.length ? warnings.join(' ') : undefined,
      confirmText: t('machines.agents.update'),
      variant: verdict === 'worse' ? 'danger' : 'primary',
    });
    if (confirmed) await run(rollout.agent, targets);
  };

  if (!machines || !rollouts.length) return null;
  return (
    <SettingsSection title={t('rollout.title')} description={t('rollout.description')}>
      <div className="divide-y divide-border/50">
        {rollouts.map((rollout) => (
          <RolloutRow
            key={rollout.agent}
            rollout={rollout}
            run={runs[rollout.agent]}
            chosen={chosen[rollout.agent] ?? null}
            onChoose={(machine) => setChosen((current) => ({ ...current, [rollout.agent]: machine }))}
            onTry={(machine) => void tryFirst(rollout, machine)}
            onUpdateRest={() => void updateRest(rollout)}
          />
        ))}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/50 px-4 py-3 text-xs text-muted-foreground">
        <p>{t('rollout.note', { days: ROLLOUT_DAYS })}</p>
        {versions?.truncated ? <p>{t('rollout.truncated')}</p> : null}
        {versionsError ? <p className="text-error-foreground">{t('rollout.failed', { error: versionsError })}</p> : null}
      </div>
    </SettingsSection>
  );
}

/** One agent's rollout: where each version runs, how the newest compares, and what to do next. */
export function RolloutRow({
  rollout,
  run,
  chosen,
  onChoose,
  onTry,
  onUpdateRest,
}: {
  rollout: AgentRollout;
  run: Run | undefined;
  chosen: string | null;
  onChoose: (machine: string) => void;
  onTry: (machine: string) => void;
  onUpdateRest: () => void;
}) {
  const { t, tRich } = useI18n();
  const { agent, newest, latest, ahead, behind, previous, comparison } = rollout;
  const name = t(AGENT_NAME[agent]);
  const busy = Boolean(run?.current);
  const even = behind.length === 0;
  // Trying the latest on a fleet already at the release would only leave it unchanged.
  const current = even && atLatest(rollout);
  const candidates = [...ahead, ...behind].filter((entry) => entry.reachable);
  const target = chosen && candidates.some((entry) => entry.machine === chosen) ? chosen : trialMachine(rollout);
  const rest = behind.filter((entry) => entry.reachable);
  const away = behind.filter((entry) => !entry.reachable);
  const verdict = comparison ? VERDICT[comparison.verdict] : null;
  const newestUse = rollout.uses.find((use) => use.version === newest);
  const rollback = comparison?.verdict === 'worse' && previous ? rollbackCommand(agent, previous) : null;

  const mixed = new Set(behind.map((entry) => entry.version)).size > 1;
  const placement: ReactNode = !newest
    ? t('rollout.unknown')
    : even
    ? [
        t(ahead.length === 1 ? 'rollout.even.one' : 'rollout.even.other', { version: newest, count: ahead.length }),
        current ? t('rollout.latest.current') : latest && compareVersions(latest, newest) > 0 ? t('rollout.latest.out', { version: latest }) : null,
      ].filter((part): part is string => part !== null).join(' · ')
    : (
      <>
        {tRich('rollout.ahead', { version: newest, machines: <MachinePills names={ahead.map((entry) => entry.machine)} /> })}
        {' · '}
        {t(mixed ? 'rollout.behind.mixed' : behind.length === 1 ? 'rollout.behind.one' : 'rollout.behind.other', {
          count: behind.length,
          version: previous ?? t('machines.agents.unknownVersion'),
        })}
      </>
    );

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-medium text-foreground">{name}</span>
        {verdict ? <Badge variant={verdict.variant} size="sm">{t(verdict.label)}</Badge> : null}
        <span className="min-w-0 text-xs text-muted-foreground">{placement}</span>
        <span className="ms-auto flex flex-wrap items-center gap-2">
          {busy ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
              <Spinner />
              <span>{tRich('rollout.updating', { machine: <MachinePill name={run?.current} size="sm" /> })}</span>
            </span>
          ) : !newest || current ? null : even ? (
            candidates.length && target ? (
              <>
                <Select value={target} onValueChange={(value) => { if (value) onChoose(String(value)); }}>
                  <SelectTrigger size="sm" className="w-auto min-w-36" aria-label={t('rollout.try.machine')}>
                    <SelectValue><MachinePill name={target} /></SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {candidates.map((entry) => <SelectItem key={entry.machine} value={entry.machine}><MachinePill name={entry.machine} /></SelectItem>)}
                  </SelectPopup>
                </Select>
                <Button variant="outline" size="sm" onClick={() => onTry(target)}>
                  <FlaskConical />
                  {t('rollout.try.button')}
                </Button>
              </>
            ) : null
          ) : (
            <Button
              variant={comparison?.verdict === 'fine' ? 'default' : 'outline'}
              size="sm"
              disabled={!rest.length}
              disabledReason={rest.length ? undefined : t('rollout.rest.unreachable')}
              onClick={onUpdateRest}
            >
              <ArrowUpCircle />
              {t('rollout.rest.button', { count: rest.length })}
            </Button>
          )}
        </span>
      </div>

      {comparison && newest ? (
        comparison.since === null ? (
          <p className="text-xs text-muted-foreground">{t('rollout.compare.none', { version: newest })}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-muted-foreground">{t('rollout.compare.since', { time: formatWhen(comparison.since), version: newest })}</p>
            {/* Two rows under a sentence, read as part of this agent's block rather than a table of their own. */}
            <Table density="compact">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('rollout.table.version')}</TableHead>
                  <TableHead className={TABLE_NUMERIC_CLASS}>{t('rollout.table.requests')}</TableHead>
                  <TableHead className={TABLE_NUMERIC_CLASS}>{t('rollout.table.failed')}</TableHead>
                  <TableHead className={TABLE_NUMERIC_CLASS}>{t('rollout.table.rateLimited')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TallyRow label={newest} version note={<MachinePills names={ahead.map((entry) => entry.machine)} />} tally={comparison.newer} highlight={comparison.worse} />
                <TallyRow
                  label={t('rollout.table.older')}
                  note={t(comparison.baseline === 'same' ? 'rollout.table.sameHours' : 'rollout.table.hoursBefore')}
                  tally={comparison.older}
                  highlight={[]}
                />
              </TableBody>
            </Table>
          </div>
        )
      ) : null}

      {comparison && newest ? <VerdictText rollout={rollout} /> : null}
      {even && newestUse ? (
        <p className="text-xs text-muted-foreground">
          {t('rollout.even.requests', { requests: formatCount(newestUse.requests), days: ROLLOUT_DAYS, rate: rate(errorsOf(newestUse), newestUse.requests) })}
        </p>
      ) : null}
      {away.length && !even ? (
        <p className="text-xs text-muted-foreground">
          {tRich(away.length === 1 ? 'rollout.away.one' : 'rollout.away.other', { machines: <MachinePills names={away.map((entry) => entry.machine)} /> })}
        </p>
      ) : null}

      {rollback && previous ? (
        <Alert variant="warning">
          <AlertTitle>{tRich('rollout.rollback.title', { machines: <MachinePills names={ahead.map((entry) => entry.machine)} size="md" />, version: previous })}</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>{t('rollout.rollback.description')}</span>
            <CommandLine command={rollback} />
            {agent === 'claude' ? <span>{t('rollout.rollback.claude')}</span> : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {run?.results.length ? (
        <ul className="flex flex-col gap-2">
          {run.results.map((result) => (
            <li key={result.machine} className="flex flex-col items-start gap-1">
              <MachinePill name={result.machine} />
              <UpdateOutcomeView outcome={result} />
            </li>
          ))}
          {run.notTried ? (
            <li className="text-xs text-muted-foreground">{t(run.notTried === 1 ? 'rollout.stopped.one' : 'rollout.stopped.other', { count: run.notTried })}</li>
          ) : null}
        </ul>
      ) : null}

      {rollout.uses.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">{t('rollout.versions', { days: ROLLOUT_DAYS })}</summary>
          <Table density="compact" className="mt-1.5">
            <TableHeader>
              <TableRow>
                <TableHead>{t('rollout.table.version')}</TableHead>
                <TableHead>{t('rollout.table.machines')}</TableHead>
                <TableHead className={TABLE_NUMERIC_CLASS}>{t('rollout.table.requests')}</TableHead>
                <TableHead className={TABLE_NUMERIC_CLASS}>{t('rollout.table.failed')}</TableHead>
                <TableHead className={TABLE_NUMERIC_CLASS}>{t('rollout.table.rateLimited')}</TableHead>
                <TableHead className="text-end">{t('rollout.table.lastSeen')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rollout.uses.map((use) => (
                <TableRow key={use.version}>
                  <TableCell className="font-mono">{use.version}</TableCell>
                  <TableCell className="text-muted-foreground">{use.machines.length ? <MachinePills names={use.machines} /> : t('rollout.table.noMachine')}</TableCell>
                  <TableCell className={TABLE_NUMERIC_CLASS}>{formatCount(use.requests)}</TableCell>
                  <TableCell className={TABLE_NUMERIC_CLASS}>{rate(errorsOf(use), use.requests)}</TableCell>
                  <TableCell className={TABLE_NUMERIC_CLASS}>{rate(use.rateLimited, use.requests)}</TableCell>
                  <TableCell className="text-end text-muted-foreground">{formatWhen(use.lastMs)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </details>
      ) : null}
    </div>
  );
}

function TallyRow({ label, note, tally, highlight, version = false }: { label: string; note: ReactNode; tally: Tally; highlight: string[]; version?: boolean }) {
  return (
    <TableRow>
      <TableCell>
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('text-foreground', version && 'font-mono')}>{label}</span>
          {note ? <span className="text-muted-foreground">{note}</span> : null}
        </span>
      </TableCell>
      <TableCell className={TABLE_NUMERIC_CLASS}>{formatCount(tally.requests)}</TableCell>
      <TableCell className={cn(TABLE_NUMERIC_CLASS, highlight.includes('errors') && 'font-medium text-warning-foreground')}>
        {rate(errorsOf(tally), tally.requests)}
      </TableCell>
      <TableCell className={cn(TABLE_NUMERIC_CLASS, highlight.includes('rateLimits') && 'font-medium text-warning-foreground')}>
        {rate(tally.rateLimited, tally.requests)}
      </TableCell>
    </TableRow>
  );
}

/** What the comparison says, and what to do about it. */
function VerdictText({ rollout }: { rollout: AgentRollout }) {
  const { t } = useI18n();
  const { comparison, newest } = rollout;
  if (!comparison || !newest) return null;
  const { newer, older } = comparison;
  const lines =
    comparison.verdict === 'worse'
      ? comparison.worse.map((measure) =>
          measure === 'errors'
            ? t('rollout.verdict.worse.errors', { version: newest, rate: rate(errorsOf(newer), newer.requests), baseRate: rate(errorsOf(older), older.requests) })
            : t('rollout.verdict.worse.rateLimits', { version: newest, rate: rate(newer.rateLimited, newer.requests), baseRate: rate(older.rateLimited, older.requests) }),
        )
      : comparison.verdict === 'waiting'
      ? [t('rollout.verdict.waiting', { version: newest, count: formatCount(newer.requests), min: formatCount(TRIAL_MIN_REQUESTS) })]
      : comparison.verdict === 'fine'
      ? [t('rollout.verdict.fine', { version: newest })]
      : [t('rollout.verdict.noBaseline', { version: newest })];
  return (
    <div className={cn('flex flex-col gap-0.5 text-xs', comparison.verdict === 'worse' ? 'text-warning-foreground' : 'text-muted-foreground')}>
      {lines.map((line) => <p key={line}>{line}</p>)}
    </div>
  );
}

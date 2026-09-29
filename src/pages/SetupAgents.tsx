import { useCallback, useEffect, useMemo, useState } from 'react';
import { SettingsSection } from '../components/layout/settings';
import { MachinePill } from '../components/identity/Identity';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TABLE_NUMERIC_CLASS, TableEmpty } from '../components/ui/data-table';
import { Spinner } from '../components/ui/spinner';
import { StatusDot } from '../components/ui/status-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { requestFocus } from '../focusRequests';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { machinesView, type AppView } from '../navigation';
import { useLatestAgentVersions } from '../services/agentReleases';
import { agentVersionRows, newestAgents, type AgentVersionCell, type AgentVersionRow } from '../services/agentVersions';
import { AGENT_KINDS, fetchMachineHealth } from '../services/machineHealth';
import { AgentRolloutSection } from './AgentRollout';
import { AGENT_NAME } from './MachineAgents';
import { STATUS_TONE } from './MachineHealthPanel';
import type { HealthStatus, MachineHealth } from '../native/types';

/** How often the versions are read again; the machines check their agents every ten minutes, so this is plenty. */
const POLL_MS = 30_000;

const STATUS_LABEL: Record<HealthStatus, MessageKey> = {
  healthy: 'machines.health.status.healthy',
  degraded: 'machines.health.status.degraded',
  critical: 'machines.health.status.critical',
  unreachable: 'machines.health.status.unreachable',
  pending: 'machines.health.status.pending',
  unconfigured: 'machines.health.status.unconfigured',
};

/**
 * Sync › Agents: Claude Code and Codex across the fleet. The rollout first (a new version on one machine, compared with
 * the rest, then the rest updated), and under it each machine's versions side by side. A machine's own agents, and
 * updating just that one, stay on Machines, which each row opens.
 */
export function SetupAgents({ onNavigate }: { onNavigate: (view: AppView) => void }) {
  const [machines, setMachines] = useState<MachineHealth[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setMachines((await fetchMachineHealth(Date.now(), 1_000, true)).machines);
      setError(null);
    } catch (failure) {
      // What was read stays up, with why it couldn't be read again under it.
      setError(String(failure));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);
  const latest = useLatestAgentVersions();
  const rows = useMemo(() => (machines ? agentVersionRows(machines, newestAgents(machines, latest)) : null), [machines, latest]);

  return (
    <div className="flex flex-col gap-6">
      <AgentRolloutSection />
      <AgentVersionsSection
        rows={rows}
        error={error}
        onOpen={(machine) => {
          // Picked while its page is already open, the page goes back to its top, as the sidebar's machine leaves do.
          requestFocus('machine', machine);
          onNavigate(machinesView(machine));
        }}
        onConfigure={() => onNavigate({ kind: 'settings', page: 'machines' })}
      />
    </div>
  );
}

/** Each machine's Claude Code and Codex, which one is behind, and how many run there now. */
export function AgentVersionsSection({ rows, error, onOpen, onConfigure }: {
  /** Null until the machines are first read. */
  rows: AgentVersionRow[] | null;
  error: string | null;
  onOpen: (machine: string) => void;
  onConfigure: () => void;
}) {
  const { t } = useI18n();
  return (
    <SettingsSection title={t('setup.agents.versions.title')} description={t('setup.agents.versions.description')}>
      {rows === null ? (
        error ? (
          <p className="px-4 py-4 text-sm text-error-foreground">{t('setup.agents.versions.loadFailed', { error })}</p>
        ) : (
          <TableEmpty>
            <span className="inline-flex items-center gap-2">
              <Spinner />
              {t('setup.agents.versions.loading')}
            </span>
          </TableEmpty>
        )
      ) : !rows.length ? (
        <TableEmpty action={<Button variant="outline" size="sm" onClick={onConfigure}>{t('setup.agents.versions.configure')}</Button>}>
          {t('setup.agents.versions.empty')}
        </TableEmpty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('setup.agents.column.machine')}</TableHead>
              {AGENT_KINDS.map((agent) => <TableHead key={agent}>{t(AGENT_NAME[agent])}</TableHead>)}
              <TableHead className={TABLE_NUMERIC_CLASS}>{t('setup.agents.column.running')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.machine}>
                <TableCell>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="inline-flex" title={t(STATUS_LABEL[row.status])}>
                      <StatusDot tone={STATUS_TONE[row.status]} className="size-1.5" />
                      <span className="sr-only">{t(STATUS_LABEL[row.status])}</span>
                    </span>
                    <MachinePill name={row.machine} onClick={() => onOpen(row.machine)} label={t('setup.agents.open', { machine: row.machine })} />
                  </span>
                </TableCell>
                {AGENT_KINDS.map((agent) => <TableCell key={agent}><VersionCell cell={row.agents[agent]} /></TableCell>)}
                <TableCell
                  className={`${TABLE_NUMERIC_CLASS} text-muted-foreground`}
                  title={row.running ? t('machines.agents.runningTitle', { claude: row.running.claude, codex: row.running.codex }) : undefined}
                >
                  {row.running ? row.running.claude + row.running.codex : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {rows !== null && error ? (
        <p className="border-t border-border/50 px-4 py-3 text-xs text-error-foreground">{t('setup.agents.versions.stale', { error })}</p>
      ) : null}
    </SettingsSection>
  );
}

function VersionCell({ cell }: { cell: AgentVersionCell }) {
  const { t, tRich } = useI18n();
  if (cell.state === 'unchecked') return <span className="text-muted-foreground" title={t('setup.agents.unchecked')}>—</span>;
  if (cell.state === 'missing') return <span className="text-muted-foreground">{t('machines.agents.notFound')}</span>;
  return (
    <span className="flex items-center gap-2">
      <span className="tabular-nums text-foreground">{cell.version ?? t('machines.agents.unknownVersion')}</span>
      {cell.newer ? (
        // The badge grows to fit the machine's pill, which stands taller than its words.
        <Badge variant="warning" size="sm" className="h-auto min-h-4">
          {cell.newer.machine
            ? <span>{tRich('machines.agents.newer', { version: cell.newer.version, machine: <MachinePill name={cell.newer.machine} size="sm" /> })}</span>
            : t('machines.agents.newerLatest', { version: cell.newer.version })}
        </Badge>
      ) : null}
    </span>
  );
}

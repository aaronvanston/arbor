import { useMemo } from 'react';
import { HarnessName } from '../components/identity/Harness';
import { MachinePill } from '../components/identity/Identity';
import { SettingsSection } from '../components/layout/settings';
import { Badge } from '../components/ui/badge';
import { TABLE_NUMERIC_CLASS } from '../components/ui/data-table';
import { MiddleTruncate } from '../components/ui/middle-truncate';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { harnessHomeRows, harnessSkillRows, type InstructionsState } from '../services/harnessHomes';
import { formatBytes } from '../services/machineHealth';
import type { SetupMachine } from '../native/types';

const STATE: Record<InstructionsState, { label: MessageKey; variant: 'success' | 'warning' | 'muted' } | null> = {
  same: { label: 'setup.harnessHomes.same', variant: 'success' },
  differs: { label: 'setup.harnessHomes.differs', variant: 'warning' },
  only: { label: 'setup.harnessHomes.only', variant: 'muted' },
  missing: null,
};

/**
 * Sync › Agents: the other harnesses' homes on each machine (Pi's, Droid's…), with their instructions file against the
 * same harness's elsewhere and how many skills they keep. Only read for now; Claude Code's and Codex's are the rest of
 * Sync. Left out until a scan finds one.
 */
export function HarnessHomesSection({ machines }: { machines: SetupMachine[] }) {
  const { t } = useI18n();
  const rows = useMemo(() => harnessHomeRows(machines), [machines]);
  if (!rows.length) return null;
  return (
    <SettingsSection title={t('setup.harnessHomes.title')} description={t('setup.harnessHomes.description')}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('setup.harnessHomes.agent')}</TableHead>
            <TableHead>{t('setup.agents.column.machine')}</TableHead>
            <TableHead>{t('setup.harnessHomes.home')}</TableHead>
            <TableHead>{t('setup.harnessHomes.instructions')}</TableHead>
            <TableHead className={TABLE_NUMERIC_CLASS}>{t('setup.harnessHomes.skills')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const state = STATE[row.state];
            return (
              <TableRow key={`${row.machine}\t${row.path}`}>
                <TableCell><HarnessName harness={row.harness} className="w-max" /></TableCell>
                <TableCell><MachinePill name={row.machine} /></TableCell>
                <TableCell className="max-w-64"><MiddleTruncate value={row.path} className="font-mono text-xs" /></TableCell>
                <TableCell>
                  {row.instructions ? (
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs">{row.instructions.name}</span>
                      {row.instructions.size !== null ? <span className="text-xs text-muted-foreground">{formatBytes(row.instructions.size)}</span> : null}
                      {state ? <Badge variant={state.variant} size="sm">{t(state.label)}</Badge> : null}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t('setup.harnessHomes.none')}</span>
                  )}
                </TableCell>
                <TableCell className={TABLE_NUMERIC_CLASS}>{row.skills || '—'}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </SettingsSection>
  );
}

/**
 * Sync › Skills: the skills in the other harnesses' own folders, with the harnesses each machine has each in. Only read
 * for now. Left out until a scan finds one.
 */
export function HarnessSkillsSection({ machines }: { machines: SetupMachine[] }) {
  const { t } = useI18n();
  const rows = useMemo(() => harnessSkillRows(machines), [machines]);
  const columns = useMemo(() => machines.filter((entry) => entry.harnessHomes.length).map((entry) => entry.machine), [machines]);
  if (!rows.length) return null;
  return (
    <SettingsSection title={t('setup.harnessSkills.title')} description={t('setup.harnessSkills.description')}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('setup.harnessSkills.skill')}</TableHead>
            {columns.map((machine) => <TableHead key={machine}><MachinePill name={machine} size="sm" /></TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.name}>
              <TableCell className="font-mono text-xs">{row.name}</TableCell>
              {columns.map((machine) => {
                const harnesses = row.on[machine];
                return (
                  <TableCell key={machine}>
                    {harnesses ? (
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        {harnesses.map((harness) => <HarnessName key={harness} harness={harness} className="w-max" />)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t('setup.harnessSkills.notHere')}</span>
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SettingsSection>
  );
}

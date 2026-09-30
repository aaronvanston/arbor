import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useConfirmation } from '../components/ConfirmationDialog';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { BACKUPS_KEPT, listSetupBackups, undoSetupSync } from '../services/setupSync';
import { BackupList, outcomeText, undoMessage } from './SetupSync';
import type { SetupBackup, SetupMachine } from '../native/types';
import { MachinePill } from '../components/identity/Identity';

const MACHINE_KEY = 'arbor.setup.history.machine.v1';

function readStored(): string | null {
  try {
    return localStorage.getItem(MACHINE_KEY);
  } catch {
    return null;
  }
}

/**
 * Sync › Arbor’s changes: every change Arbor made to files on one machine, newest first, each with Undo. Setup sync and the
 * Skills tab make changes here, and so do the features that change an agent's settings: the needs-you reporter,
 * keeping sessions, telemetry and MCP servers. Each was backed up on the machine first.
 */
export function SetupHistory({ machines }: { machines: SetupMachine[] }) {
  const { t, tRich } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [chosen, setChosen] = useState<string | null>(readStored);
  const [backups, setBackups] = useState<SetupBackup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: ReactNode } | null>(null);

  const machine = machines.find((entry) => entry.machine === chosen) ?? machines.find((entry) => entry.local) ?? machines[0] ?? null;
  const name = machine?.machine ?? null;

  const load = useCallback(async (target: string) => {
    try {
      setBackups(await listSetupBackups(target));
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  useEffect(() => {
    setBackups(null);
    setError(null);
    setNotice(null);
    if (name) void load(name);
  }, [name, load]);

  const choose = (value: string) => {
    setChosen(value);
    try {
      localStorage.setItem(MACHINE_KEY, value);
    } catch {
      // The choice lasts until the page closes.
    }
  };

  const undo = async (backup: SetupBackup) => {
    if (!machine) return;
    const confirmed = await askConfirmation({
      title: t('setup.history.undo.title'),
      message: undoMessage(backup, t),
      confirmText: t('setup.sync.history.undo'),
      variant: 'danger',
    });
    if (!confirmed) return;
    setUndoing(backup.id);
    setNotice(null);
    try {
      const result = outcomeText(await undoSetupSync(machine.machine, backup.id), machine.machine, t, tRich);
      setNotice(result.ok ? { ok: true, text: tRich('setup.sync.undone', { machine: <MachinePill name={machine.machine} /> }) } : result);
      void load(machine.machine);
    } catch (reason) {
      setNotice({ ok: false, text: t('setup.history.undoFailed', { error: String(reason) }) });
    } finally {
      setUndoing(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-3xl text-xs leading-[1.5] text-muted-foreground">{t('setup.history.intro')}</p>
      {machines.length > 1 && machine ? (
        <Select value={machine.machine} onValueChange={(value) => { if (value) choose(String(value)); }}>
          <SelectTrigger size="sm" className="w-auto min-w-44 self-start" aria-label={t('setup.history.machine.label')}>
            <SelectValue>{tRich('setup.history.machine.value', { machine: <MachinePill name={machine.machine} /> })}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {machines.map((entry) => <SelectItem key={entry.machine} value={entry.machine}><MachinePill name={entry.machine} /></SelectItem>)}
          </SelectPopup>
        </Select>
      ) : null}
      {notice ? (
        <p className={cn('text-sm', notice.ok ? 'text-muted-foreground' : 'text-error-foreground')} role="status">{notice.text}</p>
      ) : null}
      {!machine ? null : backups === null && error === null ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner /><span>{tRich('setup.history.loading', { machine: <MachinePill name={machine.machine} size="sm" /> })}</span></p>
      ) : backups?.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{tRich('setup.history.empty', { machine: <MachinePill name={machine.machine} /> })}</p>
      ) : (
        <BackupList
          machine={machine.machine}
          backups={backups}
          error={error}
          busy={undoing !== null}
          undoing={undoing}
          onUndo={(backup) => void undo(backup)}
          limit={BACKUPS_KEPT}
        />
      )}
    </div>
  );
}

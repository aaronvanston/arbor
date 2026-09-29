import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { AlertCircle, Archive, FolderInput, FolderSearch, TriangleAlert } from '../components/ui/icons';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { SettingsRow, SettingsSection } from '../components/layout/settings';
import { StatBlock, StatsGrid } from '../components/layout/stats';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../components/ui/dialog';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { MiddleTruncate } from '../components/ui/middle-truncate';
import { Progress } from '../components/ui/progress';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { toast } from '../components/ui/toast';
import { formatDate, formatDateRange, formatNumber, formatPercent } from '../lib/format';
import { cn } from '../lib/utils';
import { formatBytes } from '../services/machineHealth';
import {
  addSessionImport,
  cancelSessionImport,
  importHomeName,
  importBlocker,
  importProgress,
  previewSessionImport,
} from '../services/sessionArchive';
import type { ArchiveImport, ArchiveStatus, ImportPreview } from '../native/types';
import { MachinePill, MachinePills } from '../components/identity/Identity';

const AGENT_KEYS: Record<string, MessageKey> = {
  claude: 'sessionArchive.homes.claude',
  codex: 'sessionArchive.homes.codex',
  openclaw: 'sessionArchive.homes.openclaw',
  'claude-desktop': 'sessionArchive.homes.claudeDesktop',
};

/**
 * Settings › Session Archive › Old backups: copies of agent homes taken into the archive, like a copied ~/.claude or a
 * Codex backup, and other session backups (OpenClaw, Claude's desktop app), each shown with how far it's got.
 */
export function ArchiveImports({ status, onStatus }: { status: ArchiveStatus; onStatus: (status: ArchiveStatus) => void }) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    const folder = await open({ directory: true, multiple: false, title: t('sessionArchive.imports.chooseTitle') });
    if (typeof folder === 'string') setPicked(folder);
  };
  // Stopping keeps what the import kept, so it's undone by starting it again.
  const stop = async (item: ArchiveImport) => {
    setError(null);
    try {
      onStatus(await cancelSessionImport(item.id));
      toast({
        title: t('sessionArchive.imports.stopped'),
        description: t('sessionArchive.imports.stoppedDescription'),
        action: {
          label: t('common.undo'),
          onClick: () => {
            addSessionImport(item.path, item.machine)
              .then(onStatus)
              .catch((reason: unknown) => toast({ kind: 'error', title: t('sessionArchive.imports.undoFailed'), description: String(reason) }));
          },
        },
        focusAction: true,
      });
    } catch (reason) {
      setError(String(reason));
    }
  };

  return (
    <SettingsSection
      settingId="session-archive.imports"
      title={t('sessionArchive.imports.title')}
      description={t('sessionArchive.imports.description')}
      headerAction={
        <Button variant="outline" size="sm" onClick={() => void choose()}>
          <FolderInput />
          {t('sessionArchive.imports.add')}
        </Button>
      }
    >
      {status.imports.length === 0 ? (
        <Empty size="sm">
          <EmptyMedia><FolderSearch /></EmptyMedia>
          <EmptyTitle>{t('sessionArchive.imports.empty.title')}</EmptyTitle>
          <EmptyDescription>{t('sessionArchive.imports.empty.description')}</EmptyDescription>
        </Empty>
      ) : (
        status.imports.map((item) => <ImportRow key={item.id} item={item} paused={status.paused} onStop={() => void stop(item)} />)
      )}
      {error ? <p className="px-4 pb-3 text-sm text-error-foreground">{error}</p> : null}
      <ImportDialog path={picked} onClose={() => setPicked(null)} onStatus={onStatus} />
    </SettingsSection>
  );
}

export function ImportRow({ item, paused, onStop }: { item: ArchiveImport; paused: boolean; onStop: () => void }) {
  const { t, tRich } = useI18n();
  const progress = importProgress(item);
  const machines = item.machines.length > 0 ? <MachinePills names={item.machines} /> : <MachinePill name={item.machine} size="sm" />;
  const from = tRich(item.homes === 1 ? 'sessionArchive.imports.from.one' : 'sessionArchive.imports.from.other', { machine: machines, count: item.homes });
  return (
    <SettingsRow
      align="start"
      title={<MiddleTruncate value={item.path} className="font-mono text-sm" />}
      description={from}
      status={
        <span className="flex flex-col gap-1.5">
          {progress.kind === 'done' ? (
            <span>{t('sessionArchive.imports.done', { date: formatDate(item.finishedAt ?? item.addedAt), sessions: formatNumber(item.sessions), files: formatNumber(item.kept) })}</span>
          ) : progress.kind === 'away' ? (
            <span className="text-warning-foreground">{t('sessionArchive.imports.away')}</span>
          ) : progress.kind === 'starting' ? (
            <span>{t(paused ? 'sessionArchive.imports.paused' : 'sessionArchive.imports.starting')}</span>
          ) : (
            <>
              <span>{t('sessionArchive.imports.importing', { kept: formatNumber(item.kept), files: formatNumber(item.files), share: formatPercent(progress.share) })}</span>
              <Progress value={progress.share * 100} className="max-w-64" />
            </>
          )}
          {item.failures > 0 ? (
            <span className="text-warning-foreground">{t(item.failures === 1 ? 'sessionArchive.imports.failures.one' : 'sessionArchive.imports.failures.other', { count: formatNumber(item.failures) })}</span>
          ) : null}
          {item.error ? <span className="text-warning-foreground">{item.error}</span> : null}
        </span>
      }
      control={
        progress.kind === 'done' ? (
          <Badge variant="success">{t('sessionArchive.imports.doneBadge')}</Badge>
        ) : (
          <Button variant="outline" size="sm" onClick={onStop}>{t('sessionArchive.imports.stop')}</Button>
        )
      }
    />
  );
}

/** Opens for a chosen folder: what Arbor found in it, where it came from, and Import. */
function ImportDialog({ path, onClose, onStatus }: { path: string | null; onClose: () => void; onStatus: (status: ArchiveStatus) => void }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [machine, setMachine] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPreview(null);
    setError(null);
    if (path === null) return;
    let current = true;
    previewSessionImport(path).then(
      (next) => {
        if (!current) return;
        setPreview(next);
        setMachine(next.machines[0] ?? '');
      },
      (reason) => current && setError(String(reason)),
    );
    return () => {
      current = false;
    };
  }, [path]);

  const blocker = preview ? importBlocker(preview) : null;
  const machineMissing = preview !== null && blocker === null && !machine;
  const go = async () => {
    if (!preview || blocker || machineMissing) return;
    setBusy(true);
    setError(null);
    try {
      onStatus(await addSessionImport(preview.path, machine));
      toast({ kind: 'success', title: t('sessionArchive.imports.started'), description: t('sessionArchive.imports.startedDescription') });
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={path !== null} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogPopup className="max-w-xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t('sessionArchive.imports.dialog.title')}</DialogTitle>
          <DialogDescription>
            <MiddleTruncate value={preview?.path ?? path ?? ''} className="font-mono text-sm" />
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {preview ? (
            <ImportPreviewBody
              preview={preview}
              machine={machine}
              onMachine={setMachine}
            />
          ) : error ? null : (
            <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner />{t('sessionArchive.imports.dialog.looking')}</p>
          )}
          {error ? <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{error}</AlertDescription></Alert> : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button
            disabled={!preview || blocker !== null || machineMissing || busy}
            disabledReason={busy || !preview ? undefined : blocker ? t(blocker) : undefined}
            onClick={() => void go()}
          >
            {busy ? <Spinner /> : <Archive />}
            {t('sessionArchive.imports.dialog.import')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** What a folder holds: how much is new to the archive, the homes found, and the machines they came from. */
export function ImportPreviewBody({
  preview,
  machine,
  onMachine,
}: {
  preview: ImportPreview;
  machine: string;
  onMachine: (machine: string) => void;
}) {
  const { t } = useI18n();
  const blocker = importBlocker(preview);
  const agentName = (agent: string) => {
    const key = AGENT_KEYS[agent];
    return key ? t(key) : agent;
  };
  return (
    <>
      {blocker === null ? (
        <div className="flex flex-col gap-1.5">
          <StatsGrid columns={2}>
            <StatBlock
              label={t('sessionArchive.imports.preview.sessions')}
              value={formatNumber(preview.sessions)}
              hint={t('sessionArchive.imports.preview.newSessions', { count: formatNumber(preview.newSessions) })}
            />
            <StatBlock label={t('sessionArchive.imports.preview.files')} value={formatNumber(preview.files)} hint={formatBytes(preview.bytes)} />
          </StatsGrid>
          {preview.firstAt !== null && preview.lastAt !== null ? (
            <p className="text-xs text-muted-foreground">{t('sessionArchive.imports.preview.dates', { range: formatDateRange(preview.firstAt, preview.lastAt) })}</p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t(blocker)}</p>
      )}
      {preview.partial ? (
        <Alert variant="warning" icon={<TriangleAlert />}><AlertDescription>{t('sessionArchive.imports.preview.partial')}</AlertDescription></Alert>
      ) : null}
      {preview.homes.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">{t('sessionArchive.imports.preview.homes')}</p>
          <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60">
            {preview.homes.map((home) => (
              <li key={home.root} className="flex items-center gap-3 px-3 py-2 text-sm">
                <MiddleTruncate value={importHomeName(home.root, preview.path)} className="min-w-0 flex-1 font-mono" />
                <Badge variant="muted" size="sm" className="shrink-0">{agentName(home.agent)}</Badge>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {home.state === 'new'
                    ? t('sessionArchive.imports.preview.homeFiles', { files: formatNumber(home.files), size: formatBytes(home.bytes) })
                    : t(home.state === 'live' ? 'sessionArchive.imports.preview.live' : 'sessionArchive.imports.preview.imported')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {blocker === null ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">{t('sessionArchive.imports.dialog.machine')}</p>
          <MachineSelect machines={preview.machines} value={machine} onChange={onMachine} label={t('sessionArchive.imports.dialog.machine')} className="self-start" />
          <p className="text-xs text-muted-foreground">{t('sessionArchive.imports.dialog.machineHint')}</p>
        </div>
      ) : null}
    </>
  );
}

function MachineSelect({ machines, value, onChange, label, className }: { machines: string[]; value: string; onChange: (machine: string) => void; label: string; className?: string }) {
  const { t } = useI18n();
  return (
    <Select value={value} onValueChange={(next) => onChange(String(next ?? ''))}>
      <SelectTrigger size="sm" className={cn('w-auto min-w-48 shrink-0', className)} aria-label={label}>
        <SelectValue>{value ? <MachinePill name={value} /> : <span className="text-muted-foreground">{t('sessionArchive.imports.dialog.choose')}</span>}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {machines.map((name) => <SelectItem key={name} value={name}><MachinePill name={name} /></SelectItem>)}
      </SelectPopup>
    </Select>
  );
}

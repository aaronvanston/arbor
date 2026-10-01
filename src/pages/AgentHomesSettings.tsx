import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, FolderSearch, Plus, RotateCcw, Trash2 } from '../components/ui/icons';
import { FixMenu } from '../components/FixMenu';
import { scanFailedProblem } from '../services/fixPrompt';
import { useI18n } from '../i18n';
import { formatWhen } from '../lib/format';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsBlock, SettingsSection } from '../components/layout/settings';
import { SettingsMachineCrumb } from '../components/layout/MachineCrumb';
import { MachinePill } from '../components/identity/Identity';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { MiddleTruncate } from '../components/ui/middle-truncate';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { TableEmpty } from '../components/ui/data-table';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { toast } from '../components/ui/toast';
import { useSettingsScope } from '../services/machineSettings';
import {
  AGENT_HOME_KINDS,
  AGENT_HOME_LABEL,
  hasSettings,
  homeFromFound,
  homePathProblem,
  isVariable,
  ownHomes,
  previewAgentHome,
  removeAgentHome,
  saveAgentHome,
  scanAgentHomes,
  switchedHere,
  syncOffCount,
  useAgentHomes,
} from '../services/agentHomes';
import type { AgentHome, AgentHomeKind, AgentHomesView, MachineAgentHomes } from '../native/types';

/**
 * Settings › Agent homes: where each machine's agents keep their homes, which every script that reads one goes by.
 * The agents' own homes are on every machine; each machine has the ones Arbor found there and the ones added for it.
 */
export function AgentHomesSettingsPage() {
  const { t } = useI18n();
  const scope = useSettingsScope();
  const { view, error } = useAgentHomes();
  // The machine the Add dialog adds for ('' is every machine), while it's open.
  const [adding, setAdding] = useState<string | null>(null);
  const machines = view?.machines.filter((entry) => !scope || entry.machine === scope) ?? [];
  const syncOff = view ? syncOffCount(view) : 0;
  return (
    <Page>
      <PageTopbar>
        <PageBreadcrumb
          segments={[
            t('settings.title'),
            t('settings.nav.agentHomes'),
            // A filter, not a setting per machine: each machine's homes are its own, so picking one shows just its.
            <SettingsMachineCrumb key="machine" machines={view?.machines.map((entry) => entry.machine) ?? (scope ? [scope] : [])} />,
          ]}
        />
      </PageTopbar>
      <PageBody gap="gap-6">
        {error ? <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{error}</AlertDescription></Alert> : null}
        {!view ? (
          error ? null : <p className="flex items-center gap-2 px-4 text-sm text-muted-foreground" role="status"><Spinner />{t('agentHomes.loading')}</p>
        ) : (
          <>
            {syncOff ? <p className="px-4 text-sm text-muted-foreground" data-slot="agent-homes-sync-note">{t(syncOff === 1 ? 'agentHomes.syncOffNote.one' : 'agentHomes.syncOffNote.other', { count: syncOff })}</p> : null}
            <EveryMachineHomes view={view} onAdd={() => setAdding('')} />
            {machines.map((machine) => (
              <MachineHomes key={machine.machine} view={view} machine={machine} onAdd={() => setAdding(machine.machine)} />
            ))}
          </>
        )}
        <AddAgentHomeDialog
          machine={adding}
          machines={view?.machines.map((entry) => entry.machine) ?? []}
          onClose={() => setAdding(null)}
        />
      </PageBody>
    </Page>
  );
}

/** The homes every machine reads: the agents' own and any added for all of them. */
function EveryMachineHomes({ view, onAdd }: { view: AgentHomesView; onAdd: () => void }) {
  const { t } = useI18n();
  return (
    <SettingsSection
      settingId="agent-homes.everywhere"
      title={t('agentHomes.everywhere.title')}
      description={t('agentHomes.everywhere.description')}
      headerAction={<Button variant="outline" size="sm" onClick={onAdd}><Plus />{t('agentHomes.add.button')}</Button>}
    >
      <HomesTable homes={view.everywhere} view={view} />
    </SettingsSection>
  );
}

/** One machine's own homes, how its last look went, and what that look found that the list doesn't have. */
function MachineHomes({ view, machine, onAdd }: { view: AgentHomesView; machine: MachineAgentHomes; onAdd: () => void }) {
  const { t, tRich } = useI18n();
  const [looking, setLooking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const own = ownHomes(view, machine.machine);
  const look = async () => {
    setLooking(true);
    setFailure(null);
    try {
      await scanAgentHomes(machine.machine);
    } catch (lookError) {
      setFailure(String(lookError));
    } finally {
      setLooking(false);
    }
  };
  const summary = looking
    ? t('agentHomes.machine.looking')
    : machine.error
      ? t('agentHomes.machine.lookFailed', { time: formatWhen(machine.scannedAtMs ?? 0) })
      : machine.scannedAtMs !== null
        ? t('agentHomes.machine.looked', { time: formatWhen(machine.scannedAtMs) })
        : t('agentHomes.machine.notLooked');
  return (
    <SettingsSection
      settingId={`agent-homes.machine.${machine.machine}`}
      title={<MachinePill name={machine.machine} />}
      description={tRich('agentHomes.machine.description', { machine: <MachinePill name={machine.machine} size="sm" /> })}
      summary={summary}
      headerAction={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void look()} disabled={looking}>
            <RefreshIcon refreshing={looking} />
            {t('agentHomes.machine.lookAgain')}
          </Button>
          <Button variant="outline" size="sm" onClick={onAdd}><Plus />{t('agentHomes.add.button')}</Button>
        </div>
      }
    >
      {failure ?? machine.error ? (
        <SettingsBlock>
          <Alert variant="error" icon={<AlertCircle />}>
            <AlertDescription className="flex-row flex-wrap items-center justify-between gap-2">
              <span className="min-w-0">{t('agentHomes.machine.error', { error: failure ?? machine.error ?? '' })}</span>
              <FixMenu machine={machine.machine} problem={scanFailedProblem({ scan: 'homes', error: failure ?? machine.error ?? '' }, t)} />
            </AlertDescription>
          </Alert>
        </SettingsBlock>
      ) : null}
      {own.length ? (
        <HomesTable homes={own} view={view} />
      ) : (
        <TableEmpty>{t(machine.scannedAtMs === null ? 'agentHomes.machine.emptyNotLooked' : 'agentHomes.machine.empty')}</TableEmpty>
      )}
      {machine.suggested.length ? (
        <div className="border-t border-border/60" data-slot="agent-homes-suggested">
          <p className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground">{t('agentHomes.suggested.title')}</p>
          <Table className="table-fixed">
            <TableBody>
              {machine.suggested.map((found) => (
                <TableRow key={`${found.agent}:${found.path}`}>
                  <TableCell className="w-48">{t(AGENT_HOME_LABEL[found.agent])}</TableCell>
                  <TableCell><MiddleTruncate value={found.path} className="font-mono" /></TableCell>
                  <TableCell className="w-40 text-end text-muted-foreground">{t(found.folders === 1 ? 'agentHomes.suggested.folders.one' : 'agentHomes.suggested.folders.other', { count: found.folders })}</TableCell>
                  <TableCell className="w-24 text-end">
                    <Button variant="outline" size="xs" onClick={() => void addFound(machine.machine, found, t)}>
                      <Plus />
                      {t('agentHomes.suggested.add')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </SettingsSection>
  );
}

type Translate = ReturnType<typeof useI18n>['t'];

async function addFound(machine: string, found: MachineAgentHomes['suggested'][number], t: Translate) {
  try {
    await saveAgentHome(homeFromFound(machine, found));
    toast({ kind: 'success', title: t('agentHomes.added', { path: found.path }) });
  } catch (error) {
    toast({ kind: 'error', title: t('agentHomes.saveFailed'), description: String(error) });
  }
}

/** Homes with their switches: Sessions for reading their sessions, Sync for their settings. */
function HomesTable({ homes, view }: { homes: AgentHome[]; view: AgentHomesView }) {
  const { t } = useI18n();
  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-48">{t('agentHomes.column.agent')}</TableHead>
          <TableHead>{t('agentHomes.column.folder')}</TableHead>
          <TableHead className="w-24">{t('agentHomes.column.source')}</TableHead>
          <TableHead className="w-20 text-center">{t('agentHomes.column.sessions')}</TableHead>
          <TableHead className="w-20 text-center">{t('agentHomes.column.sync')}</TableHead>
          <TableHead className="w-12"><span className="sr-only">{t('agentHomes.column.actions')}</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {homes.map((home) => <HomeRow key={`${home.machine}:${home.agent}:${home.path}`} home={home} view={view} />)}
      </TableBody>
    </Table>
  );
}

function HomeRow({ home, view }: { home: AgentHome; view: AgentHomesView }) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const change = async (patch: Partial<Pick<AgentHome, 'sessions' | 'sync'>>) => {
    setSaving(true);
    try {
      await saveAgentHome({ ...home, ...patch });
    } catch (error) {
      toast({ kind: 'error', title: t('agentHomes.saveFailed'), description: String(error) });
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    try {
      await removeAgentHome(home);
      toast({
        kind: 'success',
        title: t(home.source === 'standard' ? 'agentHomes.reset' : 'agentHomes.removed', { path: home.path }),
        action: { label: t('common.undo'), onClick: () => void saveAgentHome(home) },
      });
    } catch (error) {
      toast({ kind: 'error', title: t('agentHomes.saveFailed'), description: String(error) });
    }
  };
  // A standard home can't leave the list; one switched on a machine can go back to how every machine has it.
  const removable = home.source !== 'standard' || (home.machine !== '' && switchedHere(view, home));
  const folder: ReactNode = isVariable(home) ? (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="font-mono">{home.path}</span>
      <span className="truncate text-xs text-muted-foreground">{t('agentHomes.variable')}</span>
    </span>
  ) : (
    <MiddleTruncate value={home.path} className="font-mono" />
  );
  const source = home.source === 'standard' ? 'agentHomes.source.standard' : home.source === 'found' ? 'agentHomes.source.found' : 'agentHomes.source.added';
  return (
    <TableRow data-agent-home={home.path}>
      <TableCell>{t(AGENT_HOME_LABEL[home.agent])}</TableCell>
      <TableCell>{folder}</TableCell>
      <TableCell><Badge variant={home.source === 'standard' ? 'muted' : 'outline'} size="sm">{t(source)}</Badge></TableCell>
      <TableCell className="text-center">
        <Switch size="sm" checked={home.sessions} disabled={saving} onCheckedChange={(sessions) => void change({ sessions })} aria-label={t('agentHomes.sessionsFor', { path: home.path })} />
      </TableCell>
      <TableCell className="text-center">
        {hasSettings(home.agent) ? (
          <Switch size="sm" checked={home.sync} disabled={saving} onCheckedChange={(sync) => void change({ sync })} aria-label={t('agentHomes.syncFor', { path: home.path })} />
        ) : (
          <span className="text-muted-foreground" title={t('agentHomes.noSettings')}>–</span>
        )}
      </TableCell>
      <TableCell className="text-end">
        {removable ? (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void remove()}
            aria-label={t(home.source === 'standard' ? 'agentHomes.resetHome' : 'agentHomes.removeHome', { path: home.path })}
            title={t(home.source === 'standard' ? 'agentHomes.resetHome' : 'agentHomes.removeHome', { path: home.path })}
          >
            {home.source === 'standard' ? <RotateCcw /> : <Trash2 />}
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

type Preview = { state: 'idle' } | { state: 'looking' } | { state: 'failed'; error: string } | { state: 'done'; folders: string[] };

/** Adds a home for a machine or every machine, after showing which folders it would take in. */
function AddAgentHomeDialog({ machine, machines, onClose }: { machine: string | null; machines: string[]; onClose: () => void }) {
  const { t, tRich } = useI18n();
  const [target, setTarget] = useState('');
  const [agent, setAgent] = useState<AgentHomeKind>('claude');
  const [path, setPath] = useState('');
  const [sessions, setSessions] = useState(true);
  const [sync, setSync] = useState(false);
  const [preview, setPreview] = useState<Preview>({ state: 'idle' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const run = useRef(0);
  const open = machine !== null;
  useEffect(() => {
    if (!open) return;
    setTarget(machine);
    setAgent('claude');
    setPath('');
    setSessions(true);
    setSync(false);
    setPreview({ state: 'idle' });
    setError(null);
  }, [open, machine]);
  // What was looked at no longer holds once the folder, agent or machine changes.
  useEffect(() => {
    run.current += 1;
    setPreview({ state: 'idle' });
  }, [target, agent, path]);

  const problem = path.trim() ? homePathProblem(path) : null;
  const ready = Boolean(path.trim()) && problem === null && !saving;
  // Every machine's is looked at on this Mac, which may not have it.
  const lookOn = target || (machines[0] ?? '');
  const look = () => {
    const at = ++run.current;
    setPreview({ state: 'looking' });
    previewAgentHome(target, agent, path)
      .then((folders) => { if (at === run.current) setPreview({ state: 'done', folders }); })
      .catch((failure) => { if (at === run.current) setPreview({ state: 'failed', error: String(failure) }); });
  };
  const save = async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      await saveAgentHome({ machine: target, agent, path: path.trim(), source: 'added', sessions, sync: sync && hasSettings(agent) });
      toast({ kind: 'success', title: t('agentHomes.added', { path: path.trim() }) });
      onClose();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen && !saving) onClose(); }}>
      <DialogPopup className="max-w-lg" initialFocus={pathRef}>
        <form className="contents" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <DialogHeader>
            <DialogTitle>{t('agentHomes.add.title')}</DialogTitle>
            <DialogDescription>{t('agentHomes.add.description')}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>{t('agentHomes.add.machine')}</Label>
                <Select value={target} onValueChange={(next) => setTarget(String(next ?? ''))}>
                  <SelectTrigger size="sm" aria-label={t('agentHomes.add.machine')}>
                    <SelectValue>{target ? <MachinePill name={target} /> : t('agentHomes.everywhere.title')}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="">{t('agentHomes.everywhere.title')}</SelectItem>
                    {machines.map((name) => <SelectItem key={name} value={name}><MachinePill name={name} /></SelectItem>)}
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{t('agentHomes.add.agent')}</Label>
                <Select value={agent} onValueChange={(next) => { if (next) setAgent(next as AgentHomeKind); }}>
                  <SelectTrigger size="sm" aria-label={t('agentHomes.add.agent')}>
                    <SelectValue>{t(AGENT_HOME_LABEL[agent])}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {AGENT_HOME_KINDS.map((kind) => <SelectItem key={kind} value={kind}>{t(AGENT_HOME_LABEL[kind])}</SelectItem>)}
                  </SelectPopup>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agent-home-path">{t('agentHomes.add.path')}</Label>
              <div className="flex items-center gap-2">
                <Input id="agent-home-path" ref={pathRef} font="mono" value={path} onChange={(event) => setPath(event.target.value)} placeholder={t('agentHomes.add.pathPlaceholder')} aria-invalid={problem ? true : undefined} />
                <Button type="button" variant="outline" size="sm" disabled={!ready || preview.state === 'looking' || !lookOn} onClick={look}>
                  {preview.state === 'looking' ? <Spinner /> : <FolderSearch />}
                  {t('agentHomes.add.look')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t('agentHomes.add.pathHint')}</p>
              {problem ? <p className="text-sm text-error-foreground" role="alert">{t(problem)}</p> : null}
            </div>
            {preview.state === 'failed' ? <p className="text-sm text-error-foreground" role="alert">{t('agentHomes.add.lookFailed', { error: preview.error })}</p> : null}
            {preview.state === 'done' ? (
              <div className="flex flex-col gap-1.5" data-slot="agent-home-preview">
                <p className="text-xs text-muted-foreground">
                  {preview.folders.length
                    ? tRich(preview.folders.length === 1 ? 'agentHomes.add.found.one' : 'agentHomes.add.found.other', { count: preview.folders.length, machine: <MachinePill name={lookOn} size="sm" /> })
                    : tRich('agentHomes.add.foundNone', { agent: t(AGENT_HOME_LABEL[agent]), machine: <MachinePill name={lookOn} size="sm" /> })}
                </p>
                {preview.folders.length ? (
                  <ul className="max-h-36 overflow-y-auto rounded-lg border border-border/60 bg-muted/20 px-3 py-1.5 font-mono text-xs dark:bg-input/10">
                    {preview.folders.map((folder) => <li key={folder} className="truncate" title={folder}>{folder}</li>)}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-col gap-2">
              <label className="flex items-start justify-between gap-3 text-sm">
                <span>
                  <span className="block text-foreground">{t('agentHomes.add.sessions')}</span>
                  <span className="block text-xs text-muted-foreground">{t('agentHomes.add.sessionsHint')}</span>
                </span>
                <Switch size="sm" checked={sessions} onCheckedChange={setSessions} aria-label={t('agentHomes.add.sessions')} />
              </label>
              <label className="flex items-start justify-between gap-3 text-sm">
                <span>
                  <span className="block text-foreground">{t('agentHomes.add.sync')}</span>
                  <span className="block text-xs text-muted-foreground">{t(hasSettings(agent) ? 'agentHomes.add.syncHint' : 'agentHomes.noSettings')}</span>
                </span>
                <Switch size="sm" checked={sync && hasSettings(agent)} disabled={!hasSettings(agent)} onCheckedChange={setSync} aria-label={t('agentHomes.add.sync')} />
              </label>
            </div>
            {error ? <p className="text-sm text-error-foreground" role="alert">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={!ready}>
              {saving ? <Spinner /> : <Plus />}
              {t('agentHomes.add.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

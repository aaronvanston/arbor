import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, EyeOff, FolderSearch, Plus, RotateCcw, Trash2 } from '../components/ui/icons';
import { FixMenu } from '../components/FixMenu';
import { scanFailedProblem } from '../services/fixPrompt';
import { useI18n } from '../i18n';
import { formatWhen } from '../lib/format';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsBlock, SettingsSection } from '../components/layout/settings';
import { SettingsMachineCrumb } from '../components/layout/MachineCrumb';
import { HarnessName } from '../components/identity/Harness';
import { MachinePill, MachinePills } from '../components/identity/Identity';
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
import { TableEmpty } from '../components/ui/data-table';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { toast } from '../components/ui/toast';
import { cn } from '../lib/utils';
import { concreteHomePath, LazyCleanupRowMenu } from './cleanupMenuLazy';
import { knownHarnessOrder } from '../services/knownHarnesses';
import { useSettingsScope } from '../services/machineSettings';
import {
  AGENT_HOME_KINDS,
  AGENT_HOME_LABEL,
  GUESS_REASON_LABEL,
  ROLE_LABEL,
  canFollowGuess,
  homeFromFound,
  homePathProblem,
  ignoredFromFound,
  isVariable,
  ownHomes,
  previewAgentHome,
  removeAgentHome,
  roleOf,
  rolesFor,
  saveAgentHome,
  scanAgentHomes,
  switchedHere,
  useAgentHomes,
  withRole,
} from '../services/agentHomes';
import type { AgentHome, AgentHomeKind, AgentHomeRole, AgentHomesView, HarnessInfo, MachineAgentHomes } from '../native/types';
import type { MessageKey } from '../i18n/resources';

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
            <RolesIntro />
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

const ROLE_HINT: Record<AgentHomeRole, MessageKey> = {
  active: 'agentHomes.role.activeHint',
  history: 'agentHomes.role.historyHint',
  ignored: 'agentHomes.role.ignoredHint',
};

/** What each role does, above the lists that set them. */
function RolesIntro() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 px-4" data-slot="agent-homes-roles">
      <p className="text-sm text-muted-foreground">{t('agentHomes.intro')}</p>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        {(['active', 'history', 'ignored'] as const).map((role) => (
          <div key={role} className="flex flex-col gap-0.5">
            <dt className="font-medium text-foreground">{t(ROLE_LABEL[role])}</dt>
            <dd className="text-xs text-muted-foreground">{t(ROLE_HINT[role])}</dd>
          </div>
        ))}
      </dl>
    </div>
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
      <HomesTable homes={view.everywhere} view={view} machines={view.machines.map((entry) => entry.machine)} />
    </SettingsSection>
  );
}

/**
 * What Arbor knows about each agent: where it keeps things by default, and what Arbor does with it. It's on Settings ›
 * Harnesses, beside the apps that run them.
 */
export function KnownHarnesses({ harnesses }: { harnesses: HarnessInfo[] }) {
  const { t, tRich } = useI18n();
  return (
    <SettingsSection settingId="harnesses.agents" title={t('agentHomes.harnesses.title')} description={t('agentHomes.harnesses.description')}>
      <Table containerClassName="@container" className="min-w-[52rem]">
        <TableHeader>
          <TableRow>
            <TableHead>{t('agentHomes.harnesses.harness')}</TableHead>
            <TableHead>{t('agentHomes.harnesses.arbor')}</TableHead>
            <TableHead>{t('agentHomes.harnesses.home')}</TableHead>
            <TableHead>{t('agentHomes.harnesses.instructions')}</TableHead>
            <TableHead>{t('agentHomes.harnesses.skills')}</TableHead>
            <TableHead>{t('agentHomes.harnesses.mcp')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {knownHarnessOrder(harnesses).map((harness) => (
            <TableRow key={harness.harness} className="align-top" data-found={harness.found ? 'true' : 'false'}>
              <TableCell className="whitespace-nowrap text-sm">
                <HarnessName harness={harness.harness} className={cn('w-max', !harness.found && 'text-muted-foreground')} />
                {harness.foundOn.length ? (
                  <span className="mt-1 block text-xs text-muted-foreground">{tRich('harnesses.app.foundOn', { machines: <MachinePills names={harness.foundOn} /> })}</span>
                ) : !harness.found ? (
                  <span className="mt-1 block text-xs text-muted-foreground">{t('harnesses.app.notFound')}</span>
                ) : null}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <span className="flex flex-col items-start gap-1">
                  {harness.sessions ? <Badge variant="muted" size="sm">{t('agentHomes.harnesses.readsSessions')}</Badge> : null}
                  {harness.sync ? <Badge variant="muted" size="sm">{t('agentHomes.harnesses.sync')}</Badge> : null}
                  {harness.automations ? (
                    <Badge variant="muted" size="sm" title={harness.limitsEdits ? undefined : t('agentHomes.harnesses.fullAccessHint')}>
                      {t(harness.limitsEdits ? 'agentHomes.harnesses.automations' : 'agentHomes.harnesses.automationsFull')}
                    </Badge>
                  ) : null}
                  {!harness.sessions && !harness.sync && !harness.automations ? <span className="text-xs text-muted-foreground">{t('agentHomes.harnesses.listedOnly')}</span> : null}
                </span>
              </TableCell>
              <TableCell className="text-xs">
                <Paths paths={[harness.home]} />
                {harness.homeEnv ? <span className="block font-mono text-2xs text-muted-foreground">{harness.homeEnv}</span> : null}
              </TableCell>
              <TableCell className="text-xs">
                {harness.globalInstructions ? <Paths paths={[harness.globalInstructions]} /> : null}
                {harness.projectInstructions.length
                  ? <span className="block text-2xs text-muted-foreground">{t('agentHomes.harnesses.inProjects', { files: harness.projectInstructions.join(', ') })}</span>
                  : null}
                {!harness.globalInstructions && !harness.projectInstructions.length ? <Unknown /> : null}
              </TableCell>
              <TableCell className="text-xs">{harness.skills.length ? <Paths paths={harness.skills} /> : <Unknown />}</TableCell>
              <TableCell className="text-xs">
                {harness.mcp ? (
                  <>
                    <Paths paths={[harness.mcp]} />
                    {harness.mcpKey ? <span className="block font-mono text-2xs text-muted-foreground">{harness.mcpKey}</span> : null}
                  </>
                ) : <Unknown />}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SettingsSection>
  );
}

function Paths({ paths }: { paths: string[] }) {
  return (
    <span className="flex min-w-0 flex-col">
      {paths.map((path) => <span key={path} className="whitespace-nowrap font-mono text-xs text-foreground">{path}</span>)}
    </span>
  );
}

function Unknown() {
  return <span className="text-muted-foreground">—</span>;
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
        <HomesTable homes={own} view={view} machines={[machine.machine]} />
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
                  <TableCell>
                    <MiddleTruncate value={found.path} className="font-mono" />
                    {found.guess ? <span className="block whitespace-normal text-xs text-muted-foreground">{t(GUESS_REASON_LABEL[found.guess.reason])}</span> : null}
                  </TableCell>
                  <TableCell className="w-28 text-end text-muted-foreground">{t(found.folders === 1 ? 'agentHomes.suggested.folders.one' : 'agentHomes.suggested.folders.other', { count: found.folders })}</TableCell>
                  <TableCell className="w-28">{found.guess ? <Badge variant="outline" size="sm">{t(ROLE_LABEL[found.guess.role])}</Badge> : null}</TableCell>
                  <TableCell className="w-44">
                    <span className="flex justify-end gap-1.5">
                      <Button variant="ghost" size="xs" onClick={() => void ignoreFound(machine.machine, found, t)}>
                        <EyeOff />
                        {t('agentHomes.suggested.ignore')}
                      </Button>
                      <Button variant="outline" size="xs" onClick={() => void addFound(machine.machine, found, t)}>
                        <Plus />
                        {t('agentHomes.suggested.add')}
                      </Button>
                    </span>
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

/** Keeps a suggestion on the list as ignored, with Undo taking it off again so it's offered once more. */
async function ignoreFound(machine: string, found: MachineAgentHomes['suggested'][number], t: Translate) {
  const home = ignoredFromFound(machine, found);
  try {
    await saveAgentHome(home);
    toast({ kind: 'success', title: t('agentHomes.suggested.ignored', { path: found.path }), action: { label: t('common.undo'), onClick: () => void removeAgentHome(home) } });
  } catch (error) {
    toast({ kind: 'error', title: t('agentHomes.saveFailed'), description: String(error) });
  }
}

/** Homes with their roles. */
function HomesTable({ homes, view, machines }: { homes: AgentHome[]; view: AgentHomesView; machines: string[] }) {
  const { t } = useI18n();
  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-48">{t('agentHomes.column.agent')}</TableHead>
          <TableHead>{t('agentHomes.column.folder')}</TableHead>
          <TableHead className="w-24">{t('agentHomes.column.source')}</TableHead>
          <TableHead className="w-60">{t('agentHomes.column.role')}</TableHead>
          <TableHead className="w-12"><span className="sr-only">{t('agentHomes.column.actions')}</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {homes.map((home) => <HomeRow key={`${home.machine}:${home.agent}:${home.path}`} home={home} view={view} machines={machines} />)}
      </TableBody>
    </Table>
  );
}

function HomeRow({ home, view, machines }: { home: AgentHome; view: AgentHomesView; machines: string[] }) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const change = async (next: AgentHome) => {
    setSaving(true);
    try {
      await saveAgentHome(next);
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
  const role = roleOf(home);
  const folderPath: ReactNode = isVariable(home) ? (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="font-mono">{home.path}</span>
      <span className="truncate text-xs text-muted-foreground">{t('agentHomes.variable')}</span>
    </span>
  ) : (
    <MiddleTruncate value={home.path} className="font-mono" />
  );
  // Why Arbor would pick what it does: always while the home follows it, and when the user's pick differs from it.
  const guess = home.guess;
  const why = !guess
    ? null
    : !home.chosen
      ? t(GUESS_REASON_LABEL[guess.reason])
      : guess.role !== role
        ? t('agentHomes.guess.differs', { reason: t(GUESS_REASON_LABEL[guess.reason]), role: t(ROLE_LABEL[guess.role]) })
        : null;
  const folder: ReactNode = (
    <>
      {folderPath}
      {why ? <span className="block whitespace-normal text-xs text-muted-foreground" data-slot="agent-home-guess">{why}</span> : null}
    </>
  );
  const source = home.source === 'standard' ? 'agentHomes.source.standard' : home.source === 'found' ? 'agentHomes.source.found' : 'agentHomes.source.added';
  return (
    <TableRow data-agent-home={home.path}>
      <TableCell>{t(AGENT_HOME_LABEL[home.agent])}</TableCell>
      <TableCell>{folder}</TableCell>
      <TableCell><Badge variant={home.source === 'standard' ? 'muted' : 'outline'} size="sm">{t(source)}</Badge></TableCell>
      <TableCell>
        <RoleSelect home={home} disabled={saving} onChange={(next) => void change(next)} />
      </TableCell>
      <TableCell className="text-end">
        {/* Taking the folder itself off a machine goes through its Clean up, with the same checks and Undo. */}
        <LazyCleanupRowMenu
          machines={machines}
          path={concreteHomePath(home.path) ? home.path : null}
          openPage={!concreteHomePath(home.path)}
          label={t('cleanupMenu.label', { name: home.path })}
        />
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

const AUTOMATIC = 'automatic';

/** A home's role, with Automatic for one that can follow Arbor's guess. */
function RoleSelect({ home, disabled, onChange }: { home: AgentHome; disabled: boolean; onChange: (home: AgentHome) => void }) {
  const { t } = useI18n();
  const role = roleOf(home);
  const automatic = canFollowGuess(home);
  const value = automatic && !home.chosen ? AUTOMATIC : role;
  const pick = (next: string) => {
    if (next === value) return;
    if (next === AUTOMATIC) onChange(withRole(home, home.guess?.role ?? role, false));
    else onChange(withRole(home, next as AgentHomeRole, true));
  };
  return (
    <Select value={value} onValueChange={(next) => { if (next) pick(String(next)); }} disabled={disabled}>
      <SelectTrigger size="sm" aria-label={t('agentHomes.roleFor', { path: home.path })}>
        <SelectValue>{value === AUTOMATIC ? t('agentHomes.role.automaticNow', { role: t(ROLE_LABEL[role]) }) : t(ROLE_LABEL[role])}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {automatic ? (
          <SelectItem value={AUTOMATIC}>
            {home.guess ? t('agentHomes.role.automaticNow', { role: t(ROLE_LABEL[home.guess.role]) }) : t('agentHomes.role.automatic')}
          </SelectItem>
        ) : null}
        {rolesFor(home.agent).map((option) => <SelectItem key={option} value={option}>{t(ROLE_LABEL[option])}</SelectItem>)}
      </SelectPopup>
    </Select>
  );
}

type Preview = { state: 'idle' } | { state: 'looking' } | { state: 'failed'; error: string } | { state: 'done'; folders: string[] };

/** Adds a home for a machine or every machine, after showing which folders it would take in. */
function AddAgentHomeDialog({ machine, machines, onClose }: { machine: string | null; machines: string[]; onClose: () => void }) {
  const { t, tRich } = useI18n();
  const [target, setTarget] = useState('');
  const [agent, setAgent] = useState<AgentHomeKind>('claude');
  const [path, setPath] = useState('');
  // Someone adding a folder by hand means agents to run from it, where Arbor can keep its settings.
  const [role, setRole] = useState<AgentHomeRole>('active');
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
    setRole('active');
    setPreview({ state: 'idle' });
    setError(null);
  }, [open, machine]);
  // What was looked at no longer holds once the folder, agent or machine changes.
  useEffect(() => {
    run.current += 1;
    setPreview({ state: 'idle' });
  }, [target, agent, path]);

  const roles: AgentHomeRole[] = rolesFor(agent).filter((option) => option !== 'ignored');
  const pickedRole = roles.includes(role) ? role : (roles[0] ?? 'ignored');
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
      const home: AgentHome = { machine: target, agent, path: path.trim(), source: 'added', sessions: false, sync: false, chosen: true, guess: null };
      await saveAgentHome(withRole(home, pickedRole, true));
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
            <div className="flex flex-col gap-1.5">
              <Label>{t('agentHomes.add.role')}</Label>
              <Select value={pickedRole} onValueChange={(next) => { if (next) setRole(next as AgentHomeRole); }}>
                <SelectTrigger size="sm" aria-label={t('agentHomes.add.role')}>
                  <SelectValue>{t(ROLE_LABEL[pickedRole])}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {roles.map((option) => <SelectItem key={option} value={option}>{t(ROLE_LABEL[option])}</SelectItem>)}
                </SelectPopup>
              </Select>
              <p className="text-xs text-muted-foreground">{t(ROLE_HINT[pickedRole])}</p>
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

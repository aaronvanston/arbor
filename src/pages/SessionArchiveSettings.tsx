import { useCallback, useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Archive, FolderOpen, FolderSearch } from '../components/ui/icons';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsRow, SettingsSection } from '../components/layout/settings';
import { FleetWideNotice, projectLabel, SettingsScopeSentence, useFleetMachines, useFleetProjects, useScopedValue } from '../components/layout/machineScope';
import { FixMenu } from '../components/FixMenu';
import { archiveCollectionProblem, sessionRetentionProblem } from '../services/fixPrompt';
import { MachinePill } from '../components/identity/Identity';
import { projectSettingsKey, useSettingsProject, useSettingsScope } from '../services/machineSettings';
import { machineLookKey } from '../services/machineLook';
import { onOffLabel } from '../services/settingDefaults';
import { StatBlock, StatsGrid } from '../components/layout/stats';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Spinner } from '../components/ui/spinner';
import { StatusPill } from '../components/ui/status-dot';
import { Switch } from '../components/ui/switch';
import { formatAgo, formatNumber } from '../lib/format';
import { formatBytes } from '../services/machineHealth';
import { useQuotaClock } from '../services/quotaTime';
import { ArchiveImports } from './SessionArchiveImports';
import {
  adoptSessionArchive,
  archiveKeepsMachine,
  archiveStateKey,
  archiveSwitchSaver,
  archiveTone,
  checkSessionArchiveFolder,
  compression,
  createSessionArchive,
  deletesAfterDays,
  folderVerdict,
  getSessionArchiveStatus,
  revealSessionArchive,
  runSessionArchiveNow,
  setSessionArchiveMachine,
  setSessionArchivePaused,
  setSessionArchiveProject,
  sourcesByMachine,
} from '../services/sessionArchive';
import type { ArchiveStatus, FolderCheck } from '../native/types';

/**
 * Each status read counts the whole index and looks at the drive, so the page follows closely only while a pass or
 * an import is going, and not at all while the window is hidden.
 */
const BUSY_REFRESH_MS = 5_000;
const IDLE_REFRESH_MS = 15_000;

/** What each kind of home is called under its path. */
const HOME_AGENT_KEYS: Record<string, MessageKey> = {
  claude: 'sessionArchive.homes.claude',
  codex: 'sessionArchive.homes.codex',
  'claude-desktop': 'sessionArchive.homes.claudeDesktop',
  pi: 'sessionArchive.homes.pi',
};

/** Settings › Session archive: where every session's copy is kept, and how keeping it is going. */
export function SessionArchiveSettingsPage() {
  const { t } = useI18n();
  const scope = useSettingsScope();
  const project = useSettingsProject();
  const projects = useFleetProjects();
  const [status, setStatus] = useState<ArchiveStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getSessionArchiveStatus());
      setLoadError(null);
    } catch (error) {
      setLoadError(String(error));
    }
  }, []);

  const busy = Boolean(status && (status.running || status.imports.some((item) => item.finishedAt === null)));
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const refreshShown = () => {
      if (!document.hidden) void refresh();
    };
    const timer = window.setInterval(refreshShown, busy ? BUSY_REFRESH_MS : IDLE_REFRESH_MS);
    document.addEventListener('visibilitychange', refreshShown);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshShown);
    };
  }, [refresh, busy]);

  return (
    <Page>
      <PageTopbar>
        <PageBreadcrumb segments={[t('settings.title'), t('settings.nav.sessionArchive'), ...(status?.state !== 'off' ? [...(project ? [projectLabel(project, projects)] : []), ...(scope ? [<MachinePill key="machine" name={scope} />] : [])] : [])]} />
      </PageTopbar>
      <PageBody>
        {status && status.state !== 'off' ? <SettingsScopeSentence className="-mb-2" projects /> : null}
        {status ? (
          status.state === 'off' ? <ArchiveSetup status={status} onStatus={setStatus} /> : <ArchiveOverview status={status} onStatus={setStatus} />
        ) : loadError ? (
          <p className="px-4 text-sm text-error-foreground">{loadError}</p>
        ) : (
          <div className="flex justify-center py-10"><Spinner /></div>
        )}
      </PageBody>
    </Page>
  );
}

/** No archive yet: pick a folder on another drive, then make one there or use the one already there. */
export function ArchiveSetup({ status, onStatus }: { status: ArchiveStatus; onStatus: (status: ArchiveStatus) => void }) {
  const { t } = useI18n();
  const [path, setPath] = useState('');
  const [check, setCheck] = useState<FolderCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const folder = path.trim();
    setCheck(null);
    if (!folder) return;
    let current = true;
    const timer = window.setTimeout(() => {
      checkSessionArchiveFolder(folder).then((result) => current && setCheck(result), (reason) => current && setError(String(reason)));
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [path]);

  const verdict = check ? folderVerdict(check, status.archiveId) : null;
  const choose = async () => {
    const folder = await open({ directory: true, multiple: false, title: t('sessionArchive.setup.chooseTitle') });
    if (typeof folder === 'string') setPath(folder);
  };
  const go = async () => {
    if (!verdict?.action) return;
    setBusy(true);
    setError(null);
    try {
      onStatus(verdict.action === 'create' ? await createSessionArchive(path.trim()) : await adoptSessionArchive(path.trim()));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const checkLine = verdict && check ? (
    <span className={verdict.action ? undefined : 'text-warning-foreground'}>
      {t(verdict.key)}
      {check.freeBytes !== null && verdict.action ? ` ${t('sessionArchive.setup.free', { size: formatBytes(check.freeBytes) })}` : null}
    </span>
  ) : null;

  return (
    <SettingsSection title={t('sessionArchive.title')} description={t('sessionArchive.description')}>
      <SettingsRow
        settingId="session-archive.folder"
        align="start"
        title={t('sessionArchive.setup.folderTitle')}
        description={t('sessionArchive.setup.folderDescription')}
        status={error ? <span className="text-error-foreground">{error}</span> : checkLine}
        control={
          <Button
            size="sm"
            disabled={!verdict?.action || busy}
            disabledReason={busy ? undefined : !path.trim() ? t('sessionArchive.setup.needFolder') : verdict && !verdict.action ? t(verdict.key) : undefined}
            onClick={() => void go()}
          >
            {busy ? <Spinner /> : <Archive />}
            {verdict?.action === 'use' ? t('sessionArchive.setup.use') : t('sessionArchive.setup.create')}
          </Button>
        }
      >
        <div className="flex gap-2">
          <Input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={t('sessionArchive.setup.placeholder')}
            aria-label={t('sessionArchive.setup.folderTitle')}
            font="mono"
            className="text-sm"
          />
          <Button variant="outline" size="sm" onClick={() => void choose()}>
            <FolderSearch />
            {t('sessionArchive.setup.choose')}
          </Button>
        </div>
        {check?.ownDisk && verdict?.action ? <p className="pt-2 text-xs text-warning-foreground">{t('sessionArchive.ownDisk.short')}</p> : null}
        {check?.noowners && verdict?.action ? <p className="pt-2 text-xs text-muted-foreground">{t('sessionArchive.noowners.short')}</p> : null}
      </SettingsRow>
    </SettingsSection>
  );
}

export function ArchiveOverview({ status, onStatus }: { status: ArchiveStatus; onStatus: (status: ArchiveStatus) => void }) {
  const { t, tRich } = useI18n();
  const now = useQuotaClock();
  const [error, setError] = useState<string | null>(null);
  // Set by Check now to the scheduled pass it asked ahead of; the loop reschedules after every pass.
  const [askedBefore, setAskedBefore] = useState<number | null | undefined>(undefined);
  const asked = askedBefore !== undefined;
  const [saveSwitches] = useState(() => archiveSwitchSaver());
  const act = async (task: () => Promise<ArchiveStatus | void>) => {
    setError(null);
    try {
      const next = await task();
      if (next) onStatus(next);
    } catch (reason) {
      setError(String(reason));
    }
  };
  // The pass starts once the loop wakes and can finish between polls, so the button waits until
  // the pass is seen running or the next one has been scheduled.
  useEffect(() => {
    if (status.running || (askedBefore !== undefined && status.nextPassAt !== askedBefore)) setAskedBefore(undefined);
  }, [status.running, status.nextPassAt, askedBefore]);

  const scope = useSettingsScope();
  const project = useSettingsProject();
  const projects = useFleetProjects();
  const fleet = useFleetMachines();
  const local = fleet.find((machine) => machine.machine === scope)?.local ?? false;
  const thisMac = fleet.find((machine) => machine.local)?.machine;
  // Keeping the other machines' sessions is All machines' value; each machine, each project, and a project on one
  // machine can be kept or left out on its own, nearest winning.
  const projectValue = ({ project: at, machine }: { project: string | null; machine: string | null }) => {
    const own = at ? status.projectOverrides[projectSettingsKey(at)] : undefined;
    if (!own) return undefined;
    return machine ? own.machines[machineLookKey(machine)] : own.all ?? undefined;
  };
  const keep = useScopedValue<boolean>({
    all: status.otherMachines,
    fallback: true,
    byProject: true,
    // This Mac is always kept, which a project on it inherits; it only differs from All when other machines aren't kept.
    own: (at) => (at.project ? projectValue(at) : at.machine === thisMac ? (status.otherMachines ? undefined : true) : at.machine ? status.machineOverrides[machineLookKey(at.machine)] : undefined),
    label: onOffLabel(t),
    setAll: (checked) => void act(() => saveSwitches(status, { otherMachines: checked })),
    setOwn: ({ project: at, machine }, checked) => {
      if (at) void act(() => setSessionArchiveProject(at, machine, checked));
      else if (machine) void act(() => setSessionArchiveMachine(machine, checked));
    },
    clearOwn: ({ project: at, machine }) => {
      if (at) void act(() => setSessionArchiveProject(at, machine, null));
      else if (machine) void act(() => setSessionArchiveMachine(machine, null));
    },
    clearAll: () => void act(async () => {
      let next: ArchiveStatus | undefined;
      for (const machine of Object.keys(status.machineOverrides)) next = await setSessionArchiveMachine(machine, null);
      for (const [key, own] of Object.entries(status.projectOverrides)) {
        for (const machine of Object.keys(own.machines)) next = await setSessionArchiveProject(key, machine, null);
        if (own.all !== null) next = await setSessionArchiveProject(key, null, null);
      }
      return next;
    }),
  });

  const main = status.main;
  const connected = Boolean(main?.connected);
  const passLine = status.running || asked
    ? t('sessionArchive.status.running')
    : status.lastPassAt !== null
      ? t('sessionArchive.status.lastPass', { time: formatAgo(status.lastPassAt, now) })
      : t('sessionArchive.status.noPassYet');
  const runReason = status.paused
    ? t('sessionArchive.status.pausedReason')
    : !connected ? t('sessionArchive.status.missingReason') : status.running || asked ? t('sessionArchive.status.running') : undefined;
  const ratio = compression(status.totals);
  // A moved or renamed archive is picked up again from wherever it is now.
  const find = async () => {
    const folder = await open({ directory: true, multiple: false, title: t('sessionArchive.folder.findTitle') });
    if (typeof folder !== 'string') return;
    await act(async () => {
      const verdict = folderVerdict(await checkSessionArchiveFolder(folder), status.archiveId);
      if (verdict.action !== 'use') throw t(verdict.key);
      return adoptSessionArchive(folder);
    });
  };

  // At a project or one machine, only whether its sessions are kept is its own; the rest is the archive's, on this
  // Mac. This Mac's sessions are always kept, unless a project on it says otherwise.
  if (scope || project) {
    const name = project ? projectLabel(project, projects) : null;
    const heldOn = local && !project;
    const title = t(project ? 'sessionArchive.project.title' : 'sessionArchive.machine.title');
    const description = name && scope
      ? tRich('sessionArchive.project.onMachine', { project: name, machine: <MachinePill name={scope} size="sm" /> })
      : name ? t('sessionArchive.project.description', { project: name })
        : t(local ? 'sessionArchive.machine.thisMac' : 'sessionArchive.machine.description');
    return (
      <>
        <SettingsSection title={project || !scope ? t('sessionArchive.title') : <span>{tRich('machineScope.onMachine.title', { machine: <MachinePill name={scope} /> })}</span>}>
          <SettingsRow
            settingId="session-archive.other-machines"
            title={title}
            description={description}
            status={project ? t('sessionArchive.project.unknown') : undefined}
            marker={heldOn ? undefined : keep.marker}
            reset={heldOn ? undefined : keep.reset}
            held={heldOn ? t('sessionArchive.machine.thisMacHeld') : undefined}
            control={<Switch checked={heldOn || keep.value} onCheckedChange={keep.set} aria-label={title} />}
          />
          {error ? <div className="px-4 py-3 text-sm text-error-foreground" role="alert">{error}</div> : null}
        </SettingsSection>
        <FleetWideNotice text={t(project ? 'sessionArchive.project.fleetWide' : 'sessionArchive.machine.fleetWide')} />
      </>
    );
  }

  return (
    <>
      <SettingsSection title={t('sessionArchive.title')} description={t('sessionArchive.description')}>
        <SettingsRow
          settingId="session-archive.status"
          title={t('sessionArchive.status.title')}
          description={t(`sessionArchive.stateDetail.${status.state}`)}
          status={
            <span className="flex flex-wrap items-center gap-2">
              <StatusPill tone={archiveTone(status.state)}>{t(archiveStateKey(status.state))}</StatusPill>
              <span>{passLine}</span>
              {status.lastError ? <span className="text-error-foreground">{status.lastError}</span> : null}
              {error ? <span className="text-error-foreground">{error}</span> : null}
            </span>
          }
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={runReason !== undefined}
              disabledReason={runReason}
              onClick={() => {
                setAskedBefore(status.nextPassAt);
                void act(runSessionArchiveNow);
              }}
            >
              <RefreshIcon refreshing={status.running || asked} />
              {t('sessionArchive.status.runNow')}
            </Button>
          }
        />
        <SettingsRow
          settingId="session-archive.folder"
          title={t('sessionArchive.folder.title')}
          description={<span className="break-all font-mono text-xs">{main?.root}</span>}
          status={
            connected
              ? main?.freeBytes !== null && main?.freeBytes !== undefined ? t('sessionArchive.folder.free', { size: formatBytes(main.freeBytes) }) : null
              // Not connected also covers a folder that's there but holds something else, which the state names.
              : <span className="text-warning-foreground">{t(status.state === 'foreign' ? 'sessionArchive.folder.holdsOther' : 'sessionArchive.folder.notConnected')}</span>
          }
          control={
            connected ? (
              <Button variant="outline" size="sm" onClick={() => void act(revealSessionArchive)}>
                <FolderOpen />
                {t('sessionArchive.folder.reveal')}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => void find()}>
                <FolderSearch />
                {t('sessionArchive.folder.find')}
              </Button>
            )
          }
        />
        {status.warnings.includes('own-disk') && main ? (
          <SettingsRow
            title={t('sessionArchive.ownDisk.title')}
            description={t('sessionArchive.ownDisk.description')}
            control={<Badge variant="warning">{t('sessionArchive.ownDisk.badge')}</Badge>}
          />
        ) : null}
        {status.warnings.includes('noowners') && main ? (
          <SettingsRow
            title={t('sessionArchive.noowners.title')}
            description={t('sessionArchive.noowners.description', { drive: main.mountPoint ?? main.root })}
            control={<Badge variant="warning">{t('sessionArchive.noowners.badge')}</Badge>}
          />
        ) : null}
        <SettingsRow
          settingId="session-archive.pause"
          title={t('sessionArchive.pause.title')}
          description={t('sessionArchive.pause.description')}
          control={
            <Switch
              checked={status.paused}
              onCheckedChange={(checked) => void act(() => setSessionArchivePaused(checked))}
              aria-label={t('sessionArchive.pause.title')}
            />
          }
        />
        <SettingsRow
          settingId="session-archive.gentle"
          title={t('sessionArchive.gentle.title')}
          description={t('sessionArchive.gentle.description')}
          control={
            <Switch
              checked={status.gentle}
              onCheckedChange={(checked) => void act(() => saveSwitches(status, { gentle: checked }))}
              aria-label={t('sessionArchive.gentle.title')}
            />
          }
        />
        <SettingsRow
          settingId="session-archive.other-machines"
          title={t('sessionArchive.otherMachines.title')}
          description={t('sessionArchive.otherMachines.description')}
          marker={keep.marker}
          reset={keep.reset}
          control={
            <Switch
              checked={keep.value}
              onCheckedChange={keep.set}
              aria-label={t('sessionArchive.otherMachines.title')}
            />
          }
        />
      </SettingsSection>

      <SettingsSection settingId="session-archive.kept" title={t('sessionArchive.kept.title')} description={t('sessionArchive.kept.description')}>
        <StatsGrid columns={4} className="rounded-none border-0 shadow-none">
          <StatBlock label={t('sessionArchive.kept.sessions')} value={formatNumber(status.totals.sessions)} />
          <StatBlock label={t('sessionArchive.kept.versions')} value={formatNumber(status.totals.versions)} hint={status.totals.growing > 0 ? t('sessionArchive.kept.growing', { count: status.totals.growing }) : undefined} />
          <StatBlock label={t('sessionArchive.kept.files')} value={formatNumber(status.totals.files)} />
          <StatBlock
            label={t('sessionArchive.kept.size')}
            value={formatBytes(status.totals.storedBytes)}
            hint={ratio !== null ? t('sessionArchive.kept.sizeHint', { size: formatBytes(status.totals.rawBytes), ratio: formatNumber(ratio, 1) }) : undefined}
          />
        </StatsGrid>
      </SettingsSection>

      {sourcesByMachine(status.sources, status.machines).map((group) => {
        // A machine left out isn't checked any more, so its last check's failure is nothing to fix; what it kept stays.
        // Until the fleet is read, this Mac is the group without an SSH pass.
        const local = thisMac ? group.machine === thisMac : !group.run;
        const kept = archiveKeepsMachine(status, { machine: group.machine, local });
        const failed = kept ? group.run?.error : undefined;
        return (
        <SettingsSection
          key={group.machine}
          title={<span>{tRich('sessionArchive.homes.title', { machine: <MachinePill name={group.machine} /> })}</span>}
          description={t('sessionArchive.homes.description')}
          headerAction={failed && group.run ? (
            <FixMenu
              machine={group.machine}
              problem={archiveCollectionProblem({ error: failed, lastOk: group.run.lastOkAt !== null ? formatAgo(group.run.lastOkAt, now) : null }, t)}
            />
          ) : undefined}
          summary={!kept ? (
            <span className="text-muted-foreground">{t('sessionArchive.homes.leftOut')}</span>
          ) : failed && group.run ? (
            <span className="text-error-foreground">
              {t('sessionArchive.homes.failed', { error: failed })}{' '}
              {group.run.lastOkAt !== null ? t('sessionArchive.homes.lastKept', { time: formatAgo(group.run.lastOkAt, now) }) : t('sessionArchive.homes.neverKept')}
            </span>
          ) : undefined}
        >
          {group.sources.map((source) => {
            const days = deletesAfterDays(source);
            return (
              <SettingsRow
                key={source.label}
                title={<span className="font-mono text-sm">{source.label}</span>}
                description={t(HOME_AGENT_KEYS[source.agent] ?? 'sessionArchive.homes.claude')}
                status={
                  <span className="flex flex-wrap gap-x-3">
                    <span>{t('sessionArchive.homes.kept', { kept: formatNumber(source.kept), files: formatNumber(source.files) })}</span>
                    {source.gone > 0 ? <span>{t('sessionArchive.homes.gone', { count: source.gone })}</span> : null}
                    {days !== null ? <span className="text-warning-foreground">{t('sessionArchive.homes.deletes', { days })}</span> : null}
                  </span>
                }
                control={(
                  <span className="flex items-center gap-2">
                    {kept && source.kept < source.files && status.state !== 'paused' ? <Badge variant="info">{t('sessionArchive.homes.catchingUp')}</Badge> : null}
                    {days !== null ? <FixMenu machine={source.machine} problem={sessionRetentionProblem({ home: source.label, days }, t)} /> : null}
                  </span>
                )}
              />
            );
          })}
        </SettingsSection>
        );
      })}

      <ArchiveImports status={status} onStatus={onStatus} />
    </>
  );
}

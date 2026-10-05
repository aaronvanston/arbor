import { useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invokeCommand } from '../native/commands';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { AlertCircle, Download, ExternalLink, FileText, Hammer, Info, RotateCcw } from '../components/ui/icons';
import { useCoreRuntime } from '../coreRuntime';
import { useCoreUpdate } from '../coreUpdate';
import { useI18n } from '../i18n';
import { useAppUpdate } from '../appUpdate';
import { displayAppVersion } from '../appUpdateModel';
import { InlineNotice, useAppNotice } from '../appNotice';
import { createVersionManagementVisitTracker } from '../services/versionManagementVisits';
import { readCommandError } from '../services/commandError';
import { buildChannelLabel, useBuildChannel } from '../services/buildChannel';
import { appUpdateRestartsProxy, settleIdleUpdate } from '../services/updateWhenIdle';
import { devBuildLine } from '../services/devBuild';
import { IdleUpdateNotice, useIdleUpdateGuard } from '../components/UpdateWhenIdle';
import { ReleaseNoteSections } from '../components/UpdateReleaseNotes';
import { ARBOR_RELEASES_URL, CORE_RELEASES_URL, NO_RELEASE_NOTES, coreReleaseUrl, releaseNotesToShow } from '../services/releaseNotes';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsBlock, SettingsRow, SettingsSection } from '../components/layout/settings';
import { StatBlock } from '../components/layout/stats';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge, type BadgeProps } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { AlertDialog, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../components/ui/dialog';
import { Progress } from '../components/ui/progress';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { toast } from '../components/ui/toast';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import type { CoreInstallResult, CoreInstallTask, DevBuildStatus, UpdateChannel } from '../native/types';

export type MessageType = 'info' | 'success' | 'error';
const recordVersionManagementVisit = createVersionManagementVisitTracker();

export function VersionManagementPage() {
  const { t } = useI18n();
  const build = useBuildChannel();
  const {
    info: appUpdate,
    error: appUpdateError,
    checking: checkingAppUpdate,
    task: appUpdateTask,
    check: checkAppUpdate,
    requestInstall: requestAppUpdate,
    install: installAppUpdate,
  } = useAppUpdate();
  const { guard: guardRestart } = useIdleUpdateGuard();

  const {
    status: coreStatus,
    refreshStatus,
  } = useCoreRuntime();
  const {
    latest,
    error: latestError,
    checking: checkingLatest,
    hasUpdate: coreHasUpdate,
    check: checkLatest,
  } = useCoreUpdate();

  const [installedAppVersion, setInstalledAppVersion] = useState('');

  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<CoreInstallTask | null>(null);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [confirmUpdateOpen, setConfirmUpdateOpen] = useState(false);
  const [cancelingInstall, setCancelingInstall] = useState(false);

  const [updateChannel, setUpdateChannel] = useState<UpdateChannel | null>(null);
  const [updateChannelSaving, setUpdateChannelSaving] = useState(false);
  const [devBuild, setDevBuild] = useState<DevBuildStatus | null>(null);
  const [devBuildStarting, setDevBuildStarting] = useState(false);
  const [devBuildsSaving, setDevBuildsSaving] = useState(false);
  const feedback = useAppNotice();
  const { showNotice } = feedback;

  const completedInstallKeyRef = useRef('');
  const manualInstallInProgressRef = useRef(false);
  const pageVisitRef = useRef({});

  const showInstallCompletedNotice = (result: CoreInstallResult, message?: string | null) => {
    const key = `${result.version}\u0000${result.assetName}\u0000${result.binaryPath ?? ''}`;
    if (completedInstallKeyRef.current === key) return;
    completedInstallKeyRef.current = key;
    showNotice(message || t('kernel.install.completed', { version: result.version }), 'success');
  };

  const applyInstallTask = (
    task: CoreInstallTask,
    showFinishedDialog = true,
    showCompletionNotice = true,
  ) => {
    if (!task.running && !task.message && !task.result) {
      setProgress(null);
      setInstalling(false);
      setCancelingInstall(false);
      return;
    }

    setInstalling(task.running);
    if (!task.running) {
      setCancelingInstall(false);
    }

    if (showCompletionNotice && (task.running || showFinishedDialog)) {
      setProgress(task);
      setInstallDialogOpen(true);
    } else {
      setProgress(null);
      setInstallDialogOpen(false);
    }

    if (task.result) {
      if (showCompletionNotice) {
        showInstallCompletedNotice(task.result, task.message);
      }
      setInstallDialogOpen(false);
      setProgress(null);
      setCancelingInstall(false);
      void refreshStatus();
      return;
    }

    if (task.message && !task.running) {
      showNotice(task.message, task.phase === 'failed' ? 'error' : 'info');
    }
  };

  const loadInstallTask = async () => {
    try {
      const task = await invokeCommand('get_core_install_task');
      applyInstallTask(task, false, false);
    } catch {}
  };

  const changeUpdateChannel = async (channel: UpdateChannel) => {
    setUpdateChannelSaving(true);
    try {
      const saved = await invokeCommand('set_update_channel', { channel });
      setUpdateChannel(saved);
      showNotice({ key: saved === 'dev' ? 'appUpdate.channelNowDev' : saved === 'nightly' ? 'appUpdate.channelNowNightly' : 'appUpdate.channelNowStable' }, 'info');
      void checkAppUpdate();
    } catch (error) {
      showNotice({ key: 'appUpdate.channelSaveFailed', variables: { error: String(error) } }, 'error');
    } finally {
      setUpdateChannelSaving(false);
    }
  };

  const installVersion = async (version: string) => {
    // Started now, so nothing waits for idle agents to install a core.
    settleIdleUpdate('core');
    completedInstallKeyRef.current = '';
    manualInstallInProgressRef.current = true;
    setInstalling(true);
    setCancelingInstall(false);
    setInstallDialogOpen(true);
    setProgress({
      running: true,
      cancelable: true,
      phase: 'preparing-download',
      downloaded: 0,
      total: null,
      percent: null,
      message: null,
      result: null,
    });

    try {
      const result = await invokeCommand('install_core_version', { version });
      showInstallCompletedNotice(result, t('kernel.install.completed', { version: result.version }));
      manualInstallInProgressRef.current = false;
      setProgress({
        running: false,
        cancelable: false,
        phase: 'completed',
        downloaded: 1,
        total: 1,
        percent: 100,
        message: t('kernel.install.completed', { version: result.version }),
        result,
      });
      setInstallDialogOpen(false);
      setProgress(null);
      setCancelingInstall(false);
      await refreshStatus();
    } catch (error) {
      manualInstallInProgressRef.current = false;
      setCancelingInstall(false);
      const failure = readCommandError(error);
      const canceled = failure.kind === 'canceled';
      showNotice(failure.message, canceled ? 'info' : 'error');
      setProgress((current) => ({
        running: false,
        cancelable: false,
        phase: canceled ? 'canceled' : 'failed',
        downloaded: current?.downloaded ?? 0,
        total: current?.total ?? null,
        percent: current?.percent ?? null,
        message: failure.message,
        result: null,
      }));
    } finally {
      setInstalling(false);
    }
  };

  const cancelInstall = async () => {
    if (cancelingInstall || !progress?.running || !progress.cancelable) {
      return;
    }

    setCancelingInstall(true);
    try {
      await invokeCommand('cancel_core_install');
    } catch (error) {
      setCancelingInstall(false);
      showNotice(String(error), 'error');
    }
  };

  const closeInstallDialog = () => {
    if (installing || progress?.running) {
      return;
    }
    setInstallDialogOpen(false);
    setProgress(null);
    setCancelingInstall(false);
  };

  const buildLatestMain = async () => {
    setDevBuildStarting(true);
    try {
      setDevBuild(await invokeCommand('request_dev_build'));
    } catch (error) {
      showNotice({ key: 'appUpdate.devBuild.buildNowFailed', variables: { error: String(error) } }, 'error');
    } finally {
      setDevBuildStarting(false);
    }
  };

  // On asks for the repository the first time; after that the builder remembers the one it was set up from.
  const toggleDevBuilds = async (enabled: boolean) => {
    let repository: string | null = null;
    if (enabled && !devBuild?.repository) {
      const folder = await open({ directory: true, multiple: false, title: t('appUpdate.devBuild.chooseRepository') });
      if (typeof folder !== 'string') return;
      repository = folder;
    }
    setDevBuildsSaving(true);
    try {
      setDevBuild(await invokeCommand('set_dev_builds', { enabled, repository }));
      toast({ kind: 'success', title: t(enabled ? 'appUpdate.devBuild.turnedOn' : 'appUpdate.devBuild.turnedOff') });
    } catch (error) {
      showNotice({ key: 'appUpdate.devBuild.toggleFailed', variables: { error: String(error) } }, 'error');
    } finally {
      setDevBuildsSaving(false);
    }
  };

  const openDevBuildLog = async () => {
    try {
      await invokeCommand('open_dev_build_log');
    } catch (error) {
      showNotice({ key: 'appUpdate.devBuild.showLogFailed', variables: { error: String(error) } }, 'error');
    }
  };

  const openAppRelease = async () => {
    try {
      await invokeCommand('open_external_url', { url: appUpdate?.releaseUrl || ARBOR_RELEASES_URL });
    } catch (error) {
      showNotice({ key: 'kernel.error.openUpdate', variables: { error: String(error) } }, 'error');
    }
  };

  useEffect(() => {
    let disposed = false;
    invokeCommand('get_update_channel')
      .then((channel) => { if (!disposed) setUpdateChannel(channel); })
      .catch(() => { if (!disposed) setUpdateChannel('stable'); });
    return () => { disposed = true; };
  }, []);

  // The builder's status, read again every ten seconds while a build is under way or asked for. When one finishes on
  // the dev channel, the app checks for the build it made.
  const devBuildActive = devBuild ? devBuildLine(devBuild).active : false;
  const devBuildActiveRef = useRef(devBuildActive);
  useEffect(() => {
    let disposed = false;
    const load = () => invokeCommand('get_dev_build_status')
      .then((status) => { if (!disposed) setDevBuild(status); })
      .catch(() => undefined);
    void load();
    const timer = devBuildActive ? window.setInterval(() => void load(), 10_000) : undefined;
    return () => { disposed = true; window.clearInterval(timer); };
  }, [devBuildActive]);
  useEffect(() => {
    if (devBuildActiveRef.current && !devBuildActive && updateChannel === 'dev') void checkAppUpdate();
    devBuildActiveRef.current = devBuildActive;
  }, [checkAppUpdate, devBuildActive, updateChannel]);

  useEffect(() => {
    if (!recordVersionManagementVisit(pageVisitRef.current)) return;
    if (!checkingAppUpdate && !appUpdateTask.running) {
      void checkAppUpdate();
    }
    if (!checkingLatest) {
      void checkLatest();
    }
  }, [appUpdateTask.running, checkAppUpdate, checkLatest, checkingAppUpdate, checkingLatest]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let unlistenConfig: (() => void) | null = null;

    listen<CoreInstallTask>('core-install-progress', (event) => {
      const showTaskUi = manualInstallInProgressRef.current;
      applyInstallTask(event.payload, showTaskUi, showTaskUi);
      if (!event.payload.running) {
        manualInstallInProgressRef.current = false;
      }
    })
      .then((unlistenProgress) => {
        if (disposed) unlistenProgress();
        else unlisten = unlistenProgress;
      })
      .catch(() => undefined);

    void listen('config-files-changed', () => {
      if (disposed) return;
      void refreshStatus();
    }).then((stop) => {
      if (disposed) stop();
      else unlistenConfig = stop;
    });

    loadInstallTask();

    void getVersion()
      .then((version) => {
        if (!disposed) setInstalledAppVersion(version);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
      unlistenConfig?.();
    };
    // Mount-only: the listeners and first loads are set up once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derived state calculations
  const latestVersion = latest?.version ?? '';
  const currentVersion = coreStatus?.currentVersion ?? '';
  const coreNotes = coreHasUpdate ? releaseNotesToShow(latest?.releases, currentVersion, latestVersion, { versions: 3 }) : NO_RELEASE_NOTES;
  const coreInstalled = Boolean(coreStatus?.installed);
  const coreRunning = Boolean(coreStatus?.running);
  const coreProcessBusy = Boolean(coreStatus?.starting);
  const busy = checkingLatest || installing || coreProcessBusy;
  const installDisabled = busy || installing;

  const resolvedAppVersion = appUpdate?.currentVersion || installedAppVersion;
  const buildLabel = buildChannelLabel(build);
  const currentAppVersion = resolvedAppVersion ? displayAppVersion(resolvedAppVersion) : t('common.detecting');
  const latestAppVersion = appUpdate?.latestVersion ? displayAppVersion(appUpdate.latestVersion) : '';

  const appHasUpdate = Boolean(appUpdate?.updateAvailable);
  const appVersionStatusLabel: string | null = appUpdateTask.running
    ? t(`appUpdate.phase.${appUpdateTask.phase}` as Parameters<typeof t>[0])
    : appUpdateError
      ? t('kernel.update.failed')
      : appHasUpdate
        ? t('appUpdate.available', { version: latestAppVersion })
        : checkingAppUpdate || !appUpdate
          ? t('appUpdate.phase.checking')
          : t('appUpdate.upToDate');
  const appVersionStatusVariant: BadgeProps['variant'] = appUpdateError
    ? 'error'
    : appUpdateTask.running || checkingAppUpdate || !appUpdate
      ? 'info'
      : appHasUpdate
        ? 'primary'
        : 'success';

  const coreVersionStatusVariant: BadgeProps['variant'] = installing || progress?.running
    ? 'info'
    : latestError
      ? 'error'
      : coreHasUpdate
        ? 'primary'
        : !coreInstalled
          ? 'warning'
          : latestVersion
            ? 'success'
            : 'muted';

  const coreVersionStatusLabel: string = installing || progress?.running
    ? (cancelingInstall ? t('kernel.install.canceling') : progress?.phase ? localizeInstallPhase(progress.phase, t) : t('kernel.install.inProgress'))
    : latestError
      ? t('kernel.update.failed')
      : coreHasUpdate
        ? t('kernel.update.toVersion', { version: latestVersion })
        : !coreInstalled
          ? t('kernel.status.notInstalled')
          : latestVersion
            ? t('kernel.update.latest')
            : t('kernel.update.notChecked');

  // Install dialog calculations
  const computedPercent = progress?.percent ?? (progress?.total && progress.total > 0 ? (progress.downloaded / progress.total) * 100 : null);
  const progressKnown = computedPercent !== null;
  const progressPercent = clampPercent(computedPercent ?? 0);
  const progressText = progress
    ? progress.phase === 'completed'
      ? t('kernel.progress.completed')
      : progress.phase === 'extracting'
        ? t('kernel.progress.extracting')
        : progress.phase === 'verifying'
          ? t('kernel.progress.verifying')
          : progress.phase === 'swapping'
            ? t('kernel.progress.swapping')
            : progress.total
              ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
              : progress.downloaded > 0
                ? formatBytes(progress.downloaded)
                : t('kernel.progress.waiting')
    : '';

  const installDialogTone: MessageType = progress?.result
    ? 'success'
    : progress?.phase === 'failed'
      ? 'error'
      : 'info';

  const installRunning = Boolean(installing || progress?.running);

  const installDialogTitle = installRunning
    ? cancelingInstall
      ? t('kernel.install.titleCanceling')
      : t('kernel.install.titleInstalling')
    : progress?.result
      ? t('kernel.install.titleCompleted')
      : progress?.phase === 'canceled'
        ? t('kernel.install.titleCanceled')
        : t('kernel.install.titleFailed');

  const installDialogMessage = cancelingInstall
    ? t('kernel.install.waitingStop')
    : progress?.message || (installing ? t('kernel.install.taskRunning') : '');

  const installDialogAction = installRunning
    ? cancelingInstall
      ? t('kernel.install.cancelingShort')
      : progress?.cancelable
        ? t('kernel.install.cancel')
        : t('common.processing')
    : t('common.close');

  const installDialogActionDisabled = installRunning && (cancelingInstall || !progress?.cancelable);

  // Dev is offered only on a Mac that builds main, or kept on view while it's the channel.
  const offerDev = Boolean(devBuild?.installed) || updateChannel === 'dev';
  const devLine = devBuild ? devBuildLine(devBuild) : null;
  const channelLabel = updateChannel === 'dev'
    ? t('appUpdate.channel.dev')
    : updateChannel === 'nightly' ? t('appUpdate.channel.nightly') : t('appUpdate.channel.stable');

  return (
    <Page>
      <PageTopbar>
        <PageBreadcrumb segments={[t('settings.title'), t('settings.nav.updates')]} />
      </PageTopbar>
      <PageBody>
        {feedback.notice ? (
          <InlineNotice key={feedback.revision} notice={feedback.notice} onDismiss={feedback.clearNotice} />
        ) : null}
        <IdleUpdateNotice />

        <SettingsSection
          title={t('kernel.versions.appCardTitle')}
          headerAction={<Badge variant={appVersionStatusVariant} size="lg" title={appUpdateError || appVersionStatusLabel}>{appVersionStatusLabel}</Badge>}
        >
          <div className="grid grid-cols-2 divide-x divide-border/50">
            <StatBlock label={t('appUpdate.current')} value={currentAppVersion} hint={buildLabel ? t(buildLabel) : undefined} />
            <StatBlock
              label={t('appUpdate.latest')}
              value={appUpdate ? (latestAppVersion || currentAppVersion) : (checkingAppUpdate ? t('appUpdate.checking') : t('common.detecting'))}
              hint={appHasUpdate ? t('appUpdate.phase.available') : undefined}
              tone={appHasUpdate ? 'success' : 'default'}
            />
          </div>
          <SettingsRow
            settingId="updates.app"
            title={t('appUpdate.status')}
            description={updateChannel === 'dev' ? t('appUpdate.feedDev') : t('appUpdate.feed')}
            status={appUpdateError ? null : !appUpdate?.autoUpdateSupported ? t('appUpdate.manualFallback') : null}
            control={
              <>
                <Button variant="outline" size="sm" disabled={checkingAppUpdate || appUpdateTask.running} onClick={() => void checkAppUpdate()}>
                  <RefreshIcon refreshing={checkingAppUpdate} />
                  {checkingAppUpdate ? t('appUpdate.checking') : t('appUpdate.check')}
                </Button>
                {appHasUpdate && appUpdate?.autoUpdateSupported ? (
                  <Button
                    size="sm"
                    disabled={appUpdateTask.running}
                    onClick={() => appUpdateRestartsProxy(appUpdate.bundledCoreVersion, coreStatus?.currentVersion)
                      ? void guardRestart({ kind: 'app', version: appUpdate.latestVersion }, () => void installAppUpdate(), requestAppUpdate)
                      : requestAppUpdate()}
                  >
                    <Download />
                    {t('appUpdate.installNow')}
                  </Button>
                ) : null}
                <Button variant={appHasUpdate && !appUpdate?.autoUpdateSupported ? 'default' : 'ghost-muted'} size="sm" onClick={() => void openAppRelease()}>
                  <ExternalLink />
                  {t('appUpdate.openRelease')}
                </Button>
              </>
            }
          />
          {appUpdateError ? (
            <SettingsBlock>
              <Alert variant="error" icon={<AlertCircle />}>
                <AlertDescription>{appUpdateError}</AlertDescription>
              </Alert>
            </SettingsBlock>
          ) : null}
          <SettingsRow
            settingId="updates.channel"
            title={t('appUpdate.channel')}
            description={t('appUpdate.channelDescription')}
            control={
              <Select
                value={updateChannel ?? 'stable'}
                disabled={updateChannel === null || updateChannelSaving || appUpdateTask.running}
                onValueChange={(value) => { if (value && value !== updateChannel) void changeUpdateChannel(value as UpdateChannel); }}
              >
                <SelectTrigger size="sm" className="w-36" aria-label={t('appUpdate.channel')}>
                  <SelectValue>{channelLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="stable">{t('appUpdate.channel.stable')}</SelectItem>
                  <SelectItem value="nightly">{t('appUpdate.channel.nightly')}</SelectItem>
                  {offerDev ? <SelectItem value="dev">{t('appUpdate.channel.dev')}</SelectItem> : null}
                </SelectPopup>
              </Select>
            }
          />
          {devBuild && devLine ? (
            <SettingsRow
              settingId="updates.dev-build"
              title={t('appUpdate.devBuild')}
              description={devBuild.installed ? t('appUpdate.devBuild.description') : t('appUpdate.devBuild.offDescription')}
              status={devBuildsSaving ? t('appUpdate.devBuild.settingUp') : devBuild.installed || updateChannel === 'dev' ? (
                <span className={devLine.tone === 'error' ? 'text-error-foreground' : undefined} title={devBuild.error ?? devBuild.repository ?? undefined}>
                  {t(devLine.key, { ...devLine.variables, ...(devLine.step ? { step: t(devLine.step) } : {}) })}
                </span>
              ) : null}
              control={
                <>
                  {devBuild.installed && devBuild.hasLog ? (
                    <Button variant="ghost-muted" size="sm" onClick={() => void openDevBuildLog()}>
                      <FileText />
                      {t('appUpdate.devBuild.showLog')}
                    </Button>
                  ) : null}
                  {devBuild.installed ? (
                    <Button variant="outline" size="sm" disabled={devBuildStarting || devLine.busy} onClick={() => void buildLatestMain()}>
                      {devBuildStarting || devLine.busy ? <Spinner /> : <Hammer />}
                      {t('appUpdate.devBuild.buildNow')}
                    </Button>
                  ) : null}
                  <Switch
                    size="sm"
                    checked={devBuild.installed}
                    disabled={devBuildsSaving}
                    onCheckedChange={(enabled) => void toggleDevBuilds(enabled)}
                    aria-label={t('appUpdate.devBuild.toggle')}
                  />
                </>
              }
            />
          ) : null}
        </SettingsSection>

        <SettingsSection
          title={t('kernel.versions.coreCardTitle')}
          description={t('kernel.versions.coreRunningNotice')}
          headerAction={<Badge variant={coreVersionStatusVariant} size="lg" title={coreVersionStatusLabel}>{coreVersionStatusLabel}</Badge>}
        >
          <div className="grid grid-cols-2 divide-x divide-border/50">
            <StatBlock
              label={t('kernel.versions.current')}
              value={<span title={currentVersion || t('kernel.status.notInstalled')}>{currentVersion || t('kernel.status.notInstalled')}</span>}
              tone={coreInstalled ? 'default' : 'warning'}
            />
            <StatBlock
              label={t('kernel.versions.latest')}
              value={
                <span title={latestVersion || latestError || t('kernel.update.notChecked')}>
                  {checkingLatest ? t('kernel.update.checking') : (latestVersion || (latestError ? t('common.detectionFailed') : t('kernel.update.notChecked')))}
                </span>
              }
              hint={coreHasUpdate ? t('appUpdate.phase.available') : undefined}
              tone={coreHasUpdate ? 'success' : 'default'}
            />
          </div>
          <SettingsRow
            settingId="updates.core"
            title={t('kernel.versions.updateStatus')}
            description={t('kernel.versions.coreSourceHint')}
            control={
              <>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void checkLatest(true)}>
                  <RefreshIcon refreshing={checkingLatest} />
                  {checkingLatest ? t('kernel.update.checking') : t('kernel.versions.check')}
                </Button>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant={latestVersion && (!coreInstalled || coreHasUpdate) ? 'default' : 'outline'}
                        size="sm"
                        // Once the core is current there's nothing newer to take; Reinstall puts the same version back.
                        disabled={!latestVersion || busy || (coreInstalled && !coreHasUpdate)}
                        focusableWhenDisabled
                        // Only a running core is stopped, so only then is there anything to confirm.
                        onClick={() => void guardRestart(
                          { kind: 'core', version: latestVersion },
                          () => void installVersion(latestVersion),
                          coreRunning ? () => setConfirmUpdateOpen(true) : () => void installVersion(latestVersion),
                        )}
                      />
                    }
                  >
                    <Download />
                    {t(!coreInstalled ? 'kernel.versions.installLatestMissing' : coreRunning ? 'kernel.versions.installLatest' : 'kernel.versions.updateLatest')}
                  </TooltipTrigger>
                  <TooltipPopup>
                    {coreInstalled && !coreHasUpdate && latestVersion
                      ? t('kernel.update.latest')
                      : latestVersion
                        ? t(coreRunning ? 'kernel.versions.stopAndUpdateVersion' : 'kernel.versions.installVersion', { version: latestVersion })
                        : t('kernel.versions.installLatest')}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={<Button variant="ghost-muted" size="sm" disabled={!currentVersion || installDisabled} focusableWhenDisabled onClick={() => void guardRestart({ kind: 'core', version: currentVersion, reinstall: true }, () => void installVersion(currentVersion))} />}
                  >
                    <RotateCcw />
                    {t('kernel.versions.reinstall')}
                  </TooltipTrigger>
                  <TooltipPopup>{t('kernel.versions.reinstallTitle')}</TooltipPopup>
                </Tooltip>
              </>
            }
          />
          {coreNotes.sections.length ? (
            <SettingsBlock>
              <ReleaseNoteSections view={coreNotes} releaseUrl={coreReleaseUrl} releasesUrl={CORE_RELEASES_URL} />
            </SettingsBlock>
          ) : null}
          {latestError ? (
            <SettingsBlock>
              <Alert variant="error" icon={<AlertCircle />}>
                <AlertDescription>{latestError}</AlertDescription>
              </Alert>
            </SettingsBlock>
          ) : null}
        </SettingsSection>
      </PageBody>

      <AlertDialog open={confirmUpdateOpen} onOpenChange={setConfirmUpdateOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <span className="text-xs font-medium text-muted-foreground">{t('kernel.dialog.install')}</span>
            <DialogTitle>{t('kernel.versions.confirmUpdateTitle')}</DialogTitle>
            <DialogDescription>{t('kernel.versions.stopAndConfirmDescription', { version: latestVersion })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmUpdateOpen(false)}>{t('common.cancel')}</Button>
            <Button
              onClick={() => {
                setConfirmUpdateOpen(false);
                void installVersion(latestVersion);
              }}
            >
              <Download />
              {t('kernel.versions.installLatest')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </AlertDialog>

      <Dialog
        open={installDialogOpen && progress !== null}
        disablePointerDismissal
        onOpenChange={(next) => { if (!next) closeInstallDialog(); }}
      >
        <DialogPopup className="max-w-md" showCloseButton={!installRunning} aria-busy={installRunning}>
          <DialogHeader>
            <span className="text-xs font-medium text-muted-foreground">{t('kernel.dialog.install')}</span>
            <DialogTitle>{installDialogTitle}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4 text-sm">
              <span className="text-muted-foreground">{t('kernel.dialog.phase')}</span>
              <Badge variant={installDialogTone === 'error' ? 'error' : installDialogTone === 'success' ? 'success' : 'info'} size="lg">
                {installRunning && !cancelingInstall ? <Spinner className="size-3" /> : null}
                {cancelingInstall ? t('kernel.install.cancelingShort') : progress ? localizeInstallPhase(progress.phase, t) : ''}
              </Badge>
            </div>
            <Progress
              value={progressKnown ? progressPercent : installRunning ? null : 0}
              tone={installDialogTone === 'error' ? 'error' : installDialogTone === 'success' ? 'success' : 'primary'}
            />
            <div className="flex items-center justify-between gap-4 text-xs">
              <strong className="font-semibold tabular-nums text-foreground">{progressKnown ? `${progressPercent.toFixed(1)}%` : t('kernel.dialog.unknownProgress')}</strong>
              <span className="tabular-nums text-muted-foreground">{progressText}</span>
            </div>
            {installDialogMessage ? (
              <Alert variant={installDialogTone === 'error' ? 'error' : installDialogTone === 'success' ? 'success' : 'default'} icon={installDialogTone === 'error' ? <AlertCircle /> : <Info />} aria-live="polite">
                <AlertDescription>{installDialogMessage}</AlertDescription>
              </Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant={installRunning ? 'destructive-outline' : 'default'}
              disabled={installDialogActionDisabled}
              onClick={installRunning ? cancelInstall : closeInstallDialog}
            >
              {installDialogAction}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </Page>
  );
}

function localizeInstallPhase(
  phase: string,
  t: ReturnType<typeof useI18n>['t'],
) {
  const keys = {
    'preparing-download': 'kernel.phase.preparingDownload',
    'downloading': 'kernel.phase.downloading',
    'verifying': 'kernel.phase.verifying',
    'extracting': 'kernel.phase.extracting',
    'preparing-bundled': 'kernel.phase.preparingBundled',
    'swapping': 'kernel.phase.swapping',
    'completed': 'kernel.phase.completed',
    'failed': 'kernel.phase.failed',
    'canceled': 'kernel.phase.canceled',
  } as const;
  const key = keys[phase as keyof typeof keys];
  return key ? t(key) : phase === 'idle' ? '' : phase;
}

function clampPercent(percent: number) {
  return Math.min(100, Math.max(0, percent));
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

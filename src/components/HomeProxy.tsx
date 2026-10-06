import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { ArrowRight, Check, Copy, Eye, EyeOff, Monitor, Play, RotateCcw, Square, TerminalSquare, Users } from './ui/icons';
import { invokeCommand } from '../native/commands';
import { isCoreStarting, useCoreRuntime } from '../coreRuntime';
import { useAppUpdate } from '../appUpdate';
import { displayAppVersion } from '../appUpdateModel';
import { InlineNotice, useAppNotice } from '../appNotice';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useShortcut } from '../hooks/useShortcuts';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { accountLimitsView, machinesView, type AppView } from '../navigation';
import { getAccountsSnapshot, refreshAccountQuotas, useAccountsStore } from '../services/accountsStore';
import { clientApiProfiles } from '../services/clientAccess';
import { CORE_ACTION_LABEL, runCoreProcess, type CoreProcessCommand } from '../services/coreProcess';
import { accountsFlow, type ProxyFlow } from '../services/homeOverview';
import { useQuotaClock } from '../services/quotaTime';
import { DetailRow, SettingsBlock, SettingsSection } from './layout/settings';
import { WithShortcut } from './ShortcutKbd';
import { useConfirmation } from './ConfirmationDialog';
import { ConnectAgentDialog } from './dialogsWhenOpened';
import { useIdleUpdateGuard } from './UpdateWhenIdle';
import { Button } from './ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible';
import { RefreshIcon } from './ui/refresh-icon';
import { Spinner } from './ui/spinner';
import { StatusDot, type StatusTone } from './ui/status-dot';
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip';

const MASKED_KEY = '••••••••••••••••';
const TONE_BOX: Record<StatusTone, string> = {
  success: 'border-success/30 bg-success/8 text-success',
  warning: 'border-warning/30 bg-warning/8 text-warning',
  error: 'border-error/30 bg-error/8 text-error',
  info: 'border-info/30 bg-info/8 text-info',
  muted: 'border-border bg-muted text-muted-foreground',
  primary: 'border-primary/30 bg-primary/8 text-primary',
};

/**
 * The proxy at the foot of Home, drawn as the site draws it: the machines sending it requests, the proxy itself, and
 * the accounts it passes them to. Below that, what an agent needs to reach it, and the core's details folded away with
 * Stop, so it isn't one stray click from cutting every machine off. It's shown whether or not the core is running,
 * since this is where it's started.
 *
 * Memoized, with only the machines' count and how many sent something today from Home's machines, so it renders again
 * when those change, or when an account becomes ready or not as a limit resets, rather than on every sampling round.
 */
export const HomeProxy = memo(function HomeProxy({ machines, onNavigate }: { machines: ProxyFlow['machines']; onNavigate?: (view: AppView) => void }) {
  const { t } = useI18n();
  const { askConfirmation } = useConfirmation();
  const { info: appUpdate } = useAppUpdate();
  const { status: coreStatus, statusError, refreshStatus, publishStatus } = useCoreRuntime();
  const { files, loaded } = useAccountsStore();

  const [installedAppVersion, setInstalledAppVersion] = useState('');
  const [listenHost, setListenHost] = useState('127.0.0.1');
  const [port, setPort] = useState(8317);
  const [processBusy, setProcessBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const processFeedback = useAppNotice();
  const { showNotice: showProcessNotice, clearNotice: clearProcessNotice } = processFeedback;
  const { copy, copied } = useCopyToClipboard({ inline: true });
  const [apiKey, setApiKey] = useState<string | null | undefined>(undefined);
  const [apiKeyError, setApiKeyError] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [tlsEnabled, setTlsEnabled] = useState(false);
  const { guard: guardRestart } = useIdleUpdateGuard();
  const disposed = useRef(false);

  useEffect(() => {
    disposed.current = false;
    let unlistenConfig: (() => void) | null = null;
    const loadGuiSettings = () => invokeCommand('get_gui_settings')
      .then((settings) => {
        if (disposed.current) return;
        setListenHost(settings.host);
        setPort(settings.port);
      })
      .catch(() => undefined);
    const loadApiKey = () => invokeCommand('get_core_config_settings')
      .then((settings) => {
        if (disposed.current) return;
        setApiKey(settings.apiKeys[0]?.apiKey ?? null);
        setApiKeyError(false);
      })
      .catch(() => {
        if (disposed.current) return;
        setApiKey(undefined);
        setApiKeyError(true);
      });
    const loadTls = () => invokeCommand('get_core_tls_settings')
      .then((settings) => { if (!disposed.current) setTlsEnabled(settings.enabled); })
      .catch(() => { if (!disposed.current) setTlsEnabled(false); });

    void listen('config-files-changed', () => {
      if (disposed.current) return;
      void loadGuiSettings();
      void loadTls();
      void refreshStatus();
      void loadApiKey();
    }).then((stop) => {
      if (disposed.current) stop();
      else unlistenConfig = stop;
    });
    void loadGuiSettings();
    void loadTls();
    void loadApiKey();
    void getVersion().then((version) => { if (!disposed.current) setInstalledAppVersion(version); }).catch(() => undefined);
    return () => {
      disposed.current = true;
      unlistenConfig?.();
    };
    // Mount-only: the listener and first loads are set up once, and refreshStatus is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runCoreProcessCommand = async (command: CoreProcessCommand) => {
    setProcessBusy(true);
    clearProcessNotice();
    try {
      const error = await runCoreProcess(command, { publishStatus, refreshStatus });
      if (error) {
        showProcessNotice({ key: 'kernel.notice.actionFailed', variables: { action: t(CORE_ACTION_LABEL[command]), error } }, 'error');
      } else if (command === 'restart_core_process') {
        showProcessNotice({ key: 'kernel.notice.restarted' }, 'success');
      }
    } finally {
      setProcessBusy(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshStatus();
    } finally {
      setRefreshing(false);
    }
  };

  const coreInstalled = Boolean(coreStatus?.installed);
  const coreRunning = Boolean(coreStatus?.running);
  // Status and process controls follow `running`; anything that talks to the core waits for `ready`.
  const coreReady = Boolean(coreStatus?.ready);
  // Stopping cuts off every agent using the proxy, so it asks first, as the sidebar and palette do.
  const stopCore = async () => {
    const confirmed = await askConfirmation({
      title: t('palette.confirm.stopCore.title'),
      message: t('palette.confirm.stopCore.message'),
      confirmText: t('palette.action.stopCore'),
      variant: 'danger',
    });
    if (confirmed) await runCoreProcessCommand('stop_core_process');
  };
  const coreProcessBusy = processBusy || Boolean(coreStatus?.starting);
  // Reads as starting while a live core isn't answering yet, matching the sidebar. The controls stay on
  // coreProcessBusy so a core that never starts answering can still be stopped or restarted.
  const coreStatusBusy = coreProcessBusy || (coreStatus ? isCoreStarting(coreStatus) : false);

  // The page's own refresh, and the account limits' below it.
  useShortcut('page.refresh', () => {
    if (!refreshing) void refresh();
    if (coreReady) void refreshAccountQuotas(getAccountsSnapshot().files);
  });

  const tone: StatusTone = statusError ? 'error' : coreStatusBusy ? 'warning' : coreRunning ? 'success' : coreInstalled ? 'muted' : 'error';
  const statusLabel = coreStatusBusy
    ? t('common.processing')
    : coreStatus
      ? coreRunning ? t('kernel.status.running') : coreInstalled ? t('kernel.status.stopped') : t('kernel.status.notInstalled')
      : statusError ? t('common.detectionFailed') : t('common.detecting');
  const coreVersion = coreStatus?.currentVersion ?? '';
  const appVersion = appUpdate?.currentVersion || installedAppVersion;

  const profiles = clientApiProfiles(port, tlsEnabled, listenHost).filter((profile) => profile.id !== 'gemini');
  const accounts = useQuotaClock((now) => accountsFlow(coreReady && loaded ? files : null, now));
  const flow: ProxyFlow = { machines, accounts };
  const keyToggleLabel = showApiKey ? t('config.keys.hide') : t('config.keys.show');
  const keyCopyLabel = copied === 'home:apikey' ? t('config.notice.keyCopied') : t('config.keys.copy');

  return (
    <SettingsSection
      title={t('home.proxy.title')}
      description={t('home.proxy.description')}
      headerAction={
        <div className="flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost-muted" size="icon-sm" disabled={coreProcessBusy || refreshing} focusableWhenDisabled onClick={() => void refresh()} aria-label={t('kernel.control.refresh')} />}
            >
              <RefreshIcon refreshing={refreshing} />
            </TooltipTrigger>
            <TooltipPopup><WithShortcut id="page.refresh">{t('kernel.control.refresh')}</WithShortcut></TooltipPopup>
          </Tooltip>
          {coreRunning ? (
            <Button variant="outline" size="sm" disabled={coreProcessBusy} onClick={() => void guardRestart({ kind: 'restart' }, () => void runCoreProcessCommand('restart_core_process'))}>
              {coreProcessBusy ? <Spinner /> : <RotateCcw />}
              {t('kernel.control.restart')}
            </Button>
          ) : (
            <Button size="sm" disabled={!coreInstalled || coreProcessBusy} onClick={() => void runCoreProcessCommand('start_core_process')}>
              {coreProcessBusy ? <Spinner /> : <Play />}
              {coreProcessBusy ? t('common.processing') : t('kernel.control.start')}
            </Button>
          )}
        </div>
      }
    >
      <SettingsBlock className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1.15fr)_auto_minmax(0,1fr)] items-center gap-3 py-4">
        <FlowEnd
          icon={<Monitor />}
          value={flow.machines ? t(flow.machines.count === 1 ? 'home.proxy.machines.one' : 'home.proxy.machines.other', { count: flow.machines.count }) : t('home.machines.title')}
          hint={flow.machines ? (flow.machines.sentToday ? t('home.proxy.machinesToday', { count: flow.machines.sentToday }) : t('home.proxy.machinesQuiet')) : t('common.loading')}
          onOpen={onNavigate ? () => onNavigate(machinesView()) : undefined}
          openLabel={t('home.machines.open')}
        />
        <ArrowRight className="size-4 text-icon-muted" aria-hidden="true" />
        <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border/60 bg-background/60 px-3 py-2 dark:bg-input/20">
          <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg border', TONE_BOX[tone])} aria-hidden="true">
            {coreStatusBusy ? <Spinner /> : <StatusDot tone={tone} className="size-2.5" />}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground" role="status" title={statusError || undefined}>{statusLabel}</span>
            <span className={cn('block truncate text-xs text-muted-foreground', coreRunning && 'font-mono')}>
              {coreRunning ? `${listenHost}:${port}` : coreInstalled ? t('home.proxy.stoppedHint') : statusError || t('kernel.status.notInstalled')}
            </span>
          </span>
        </div>
        <ArrowRight className="size-4 text-icon-muted" aria-hidden="true" />
        <FlowEnd
          icon={<Users />}
          value={flow.accounts ? t(flow.accounts.count === 1 ? 'home.proxy.accounts.one' : 'home.proxy.accounts.other', { count: flow.accounts.count }) : t('home.accounts.title')}
          hint={flow.accounts
            ? !flow.accounts.count ? t('home.proxy.accountsNone') : flow.accounts.ready ? t('home.proxy.accountsReady', { count: flow.accounts.ready }) : t('home.proxy.accountsNoneReady')
            : coreReady ? t('common.loading') : t('home.proxy.accountsWaiting')}
          warn={Boolean(flow.accounts && flow.accounts.count && !flow.accounts.ready)}
          onOpen={onNavigate ? () => onNavigate(accountLimitsView()) : undefined}
          openLabel={t('home.limits.open')}
        />
      </SettingsBlock>

      <SettingsBlock className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
        {profiles.map((profile) => {
          const id = `${profile.id}:base`;
          const copyLabel = t(copied === id ? 'kernel.access.apiCopied' : 'kernel.access.copyApi', { name: profile.name });
          return (
            <ConnectField key={profile.id} label={profile.name} hint={profile.description}>
              <code className="min-w-0 truncate rounded-md bg-muted px-2 py-1 font-mono text-sm text-foreground dark:bg-input/32" title={profile.baseUrl}>{profile.baseUrl}</code>
              <Button variant="ghost-muted" size="icon-sm" onClick={() => void copy(profile.baseUrl, { id })} title={copyLabel} aria-label={copyLabel}>
                {copied === id ? <Check className="text-success" /> : <Copy />}
              </Button>
            </ConnectField>
          );
        })}
        <ConnectField label={t('home.proxy.key')}>
          {apiKeyError ? (
            <span className="text-xs text-error-foreground">{t('common.detectionFailed')}</span>
          ) : apiKey ? (
            <>
              <code className="min-w-0 truncate rounded-md bg-muted px-2 py-1 font-mono text-sm text-foreground dark:bg-input/32">{showApiKey ? apiKey : MASKED_KEY}</code>
              <Button variant="ghost-muted" size="icon-sm" onClick={() => setShowApiKey((current) => !current)} title={keyToggleLabel} aria-label={keyToggleLabel}>
                {showApiKey ? <EyeOff /> : <Eye />}
              </Button>
              <Button variant="ghost-muted" size="icon-sm" onClick={() => void copy(apiKey, { id: 'home:apikey' })} title={keyCopyLabel} aria-label={keyCopyLabel}>
                {copied === 'home:apikey' ? <Check className="text-success" /> : <Copy />}
              </Button>
            </>
          ) : apiKey === null ? (
            <span className="text-xs text-warning-foreground">{t('kernel.access.noConfiguredKey')}</span>
          ) : (
            <span className="text-xs text-muted-foreground">{t('common.loading')}</span>
          )}
        </ConnectField>
        <Button variant="outline" size="sm" className="ms-auto" onClick={() => setConnecting(true)}>
          <TerminalSquare />
          {t('home.start.agent.title')}
        </Button>
        <ConnectAgentDialog open={connecting} onClose={() => setConnecting(false)} onNavigate={onNavigate} />
      </SettingsBlock>

      <Collapsible>
        <CollapsibleTrigger className="flex min-h-9 w-full items-center gap-1.5 px-4 text-xs text-muted-foreground outline-none ring-ring ring-inset transition-colors hover:text-foreground focus-visible:ring-2">
          {t('home.proxy.details')}
          <span className="ms-auto truncate font-mono text-xs">{[coreVersion && t('home.proxy.coreVersion', { version: coreVersion }), appVersion && t('home.proxy.appVersion', { version: displayAppVersion(appVersion) })].filter(Boolean).join(' · ')}</span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="grid grid-cols-2 divide-x divide-border/50 border-t border-border/50 py-1">
            <div>
              <DetailRow label={t('kernel.control.installStatus')} value={coreStatus ? (coreInstalled ? t('kernel.control.installed') : t('kernel.status.notInstalled')) : t('common.detecting')} />
              <DetailRow label={t('kernel.control.pid')} value={coreStatus?.processId || t('kernel.control.noPid')} mono={Boolean(coreStatus?.processId)} />
            </div>
            <div>
              <DetailRow label={t('kernel.overview.coreVersion')} value={coreVersion || (coreInstalled ? t('common.unavailable') : t('kernel.status.notInstalled'))} mono={Boolean(coreVersion)} />
              <DetailRow label={t('kernel.overview.appVersion')} value={appVersion ? displayAppVersion(appVersion) : t('common.detecting')} mono />
            </div>
          </div>
          <DetailRow className="border-t border-border/50" label={t('home.proxy.installedAt')} value={coreStatus?.binaryPath || coreStatus?.installDir || statusError || t('common.detecting')} mono />
          <div className="flex items-center justify-between gap-6 border-t border-border/50 px-4 py-2.5">
            <span className="min-w-0 text-xs text-muted-foreground">{t('home.proxy.stopHint')}</span>
            <Button variant="destructive-outline" size="sm" disabled={!coreRunning || coreProcessBusy} onClick={() => void stopCore()}>
              {coreProcessBusy ? <Spinner /> : <Square />}
              {t('kernel.control.stop')}
            </Button>
          </div>
        </CollapsiblePanel>
      </Collapsible>

      {processFeedback.notice ? (
        <SettingsBlock>
          <InlineNotice key={processFeedback.revision} notice={processFeedback.notice} onDismiss={processFeedback.clearNotice} />
        </SettingsBlock>
      ) : null}
    </SettingsSection>
  );
});

/** One end of the flow: a count, what it's doing, and where it opens. */
function FlowEnd({ icon, value, hint, warn = false, onOpen, openLabel }: {
  icon: ReactNode;
  value: string;
  hint: string;
  warn?: boolean;
  onOpen?: () => void;
  openLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      title={onOpen ? openLabel : undefined}
      className="flex min-w-0 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-none ring-ring transition-colors hover:bg-accent/50 focus-visible:ring-2 disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground dark:bg-input/32 [&_svg]:size-4" aria-hidden="true">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{value}</span>
        <span className={cn('block truncate text-xs', warn ? 'text-warning-foreground' : 'text-muted-foreground')}>{hint}</span>
      </span>
    </button>
  );
}

/** What an agent sets to reach the proxy: a labeled value with its buttons. */
function ConnectField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-xs text-muted-foreground" title={hint}>{label}</span>
      <div className="flex min-w-0 items-center gap-1">{children}</div>
    </div>
  );
}

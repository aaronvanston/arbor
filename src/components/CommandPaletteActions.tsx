import { useMemo } from 'react';
import { invokeCommand } from '../native/commands';
import { ArrowLeft, ArrowRight, CirclePause, CirclePlay, Gauge, KeyRound, Link2, Moon, PanelLeft, Play, RotateCcw, Scan, ScanSearch, Square, Sun, SunMoon, ZoomIn, ZoomOut, type AppIcon } from './ui/icons';
import { isCoreStarting, useCoreRuntime } from '../coreRuntime';
import { pendingCopyToast } from '../hooks/useCopyToClipboard';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { canOpenView, setupChecksView, type AppView } from '../navigation';
import { pauseAccount, resumeAccount } from '../services/accountPause';
import { resolveAccountProfile, useAccountProfiles } from '../services/accountProfiles';
import { useAccountReserves } from '../services/accountReserves';
import { getAccountsSnapshot, refreshAccountQuotas, useAccountsStore } from '../services/accountsStore';
import { loadProxyBaseUrl } from '../services/clientAccess';
import { copyPendingText } from '../lib/clipboard';
import { paletteActions, type PaletteActionId } from '../services/commandPalette';
import { CORE_ACTION_LABEL, runCoreProcess, type CoreProcessCommand } from '../services/coreProcess';
import { isOAuthCredentialFile } from '../services/authFiles';
import { providerLabel } from '../services/providerLimits';
import { fileName, providerForFile, quotaKey, type AuthFile } from '../services/quotaService';
import { scanSetup } from '../services/setupInventory';
import type { ShortcutId } from '../services/shortcuts';
import { toggleSidebar, useSidebarLayout } from '../services/sidebarLayout';
import { goBack, goForward, stepTarget, useViewHistory } from '../services/viewHistory';
import { resetZoom, tryZoomChange, useZoomLevel, zoomIn, zoomOut, zoomPercent } from '../services/zoom';
import { useThemePreference, type ThemePreference } from '../theme';
import { AccountAvatar } from './AccountAvatar';
import { useConfirmation } from './ConfirmationDialog';
import { IconBox, type PaletteItem, type PaletteSubmenu } from './paletteItem';
import { toast } from './ui/toast';
import { useIdleUpdateGuard } from './UpdateWhenIdle';

const ACTION: Record<PaletteActionId, { label: MessageKey; icon: AppIcon; keywords?: MessageKey; shortcut?: ShortcutId }> = {
  'refresh-limits': { label: 'palette.action.refreshLimits', icon: Gauge, keywords: 'palette.keywords.limits' },
  'start-core': { label: 'palette.action.startCore', icon: Play, keywords: 'palette.keywords.core' },
  'stop-core': { label: 'palette.action.stopCore', icon: Square, keywords: 'palette.keywords.core' },
  'restart-core': { label: 'palette.action.restartCore', icon: RotateCcw, keywords: 'palette.keywords.core' },
  'pause-account': { label: 'palette.action.pauseAccount', icon: CirclePause, keywords: 'palette.keywords.pause' },
  'resume-account': { label: 'palette.action.resumeAccount', icon: CirclePlay, keywords: 'palette.keywords.resume' },
  'copy-base-url': { label: 'palette.action.copyBaseUrl', icon: Link2, keywords: 'palette.keywords.copy' },
  'copy-api-key': { label: 'palette.action.copyApiKey', icon: KeyRound, keywords: 'palette.keywords.copy' },
  'scan-setup': { label: 'palette.action.scanSetup', icon: ScanSearch },
  // Called Hide or Show by paletteActions, as the sidebar is now.
  'toggle-sidebar': { label: 'app.sidebar.hide', icon: PanelLeft, keywords: 'palette.keywords.sidebar', shortcut: 'sidebar.toggle' },
  'theme-light': { label: 'palette.action.themeLight', icon: Sun, keywords: 'palette.keywords.theme' },
  'theme-dark': { label: 'palette.action.themeDark', icon: Moon, keywords: 'palette.keywords.theme' },
  'theme-system': { label: 'palette.action.themeSystem', icon: SunMoon, keywords: 'palette.keywords.theme' },
  'zoom-in': { label: 'zoom.in', icon: ZoomIn, keywords: 'palette.keywords.zoom' },
  'zoom-out': { label: 'zoom.out', icon: ZoomOut, keywords: 'palette.keywords.zoom' },
  // Its own words, so "reset zoom" finds it and not the two steps beside it.
  'actual-size': { label: 'zoom.actualSize', icon: Scan, keywords: 'palette.keywords.actualSize' },
  'go-back': { label: 'palette.action.back', icon: ArrowLeft, keywords: 'palette.keywords.history', shortcut: 'history.back' },
  'go-forward': { label: 'palette.action.forward', icon: ArrowRight, keywords: 'palette.keywords.history', shortcut: 'history.forward' },
};
const THEME: Partial<Record<PaletteActionId, ThemePreference>> = { 'theme-light': 'light', 'theme-dark': 'dark', 'theme-system': 'system' };
const ZOOM_ACTIONS: readonly PaletteActionId[] = ['zoom-in', 'zoom-out', 'actual-size'];
const CORE_DONE: Record<CoreProcessCommand, MessageKey> = {
  start_core_process: 'kernel.notice.started',
  stop_core_process: 'kernel.notice.stopped',
  restart_core_process: 'kernel.notice.restarted',
};

/** What the Core menu asks before starting or restarting the core; stopping always asks, with the palette's own words. */
const CORE_CONFIRM: Record<'start_core_process' | 'restart_core_process', { title: MessageKey; message: MessageKey; confirm: MessageKey }> = {
  start_core_process: { title: 'palette.confirm.startCore.title', message: 'palette.confirm.startCore.message', confirm: 'palette.action.startCore' },
  restart_core_process: { title: 'palette.confirm.restartCore.title', message: 'palette.confirm.restartCore.message', confirm: 'palette.action.restartCore' },
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What the palette can do besides open things. Each action calls the same service the page with its button does;
 * Stop core and Pause ask first, and Restart core waits for idle agents as the Home page's button does. The palette
 * closes as an action starts, so each says how it went in a toast; a failure has nowhere else to stay, so it's an
 * error toast that stays until it's dismissed.
 *
 * `confirmCore` is for the sidebar's Core menu, a click away rather than typed for: Start and Restart ask first too,
 * once (Restart's question about busy agents is its confirmation when there are any).
 */
export function usePaletteActions({ onNavigate, confirmCore = false }: { onNavigate: (view: AppView) => void; confirmCore?: boolean }): {
  actions: PaletteItem[];
  submenus: Record<PaletteSubmenu, PaletteItem[]>;
} {
  const { t } = useI18n();
  const { status, publishStatus, refreshStatus } = useCoreRuntime();
  const { files, disabled } = useAccountsStore();
  const profiles = useAccountProfiles();
  const reserves = useAccountReserves();
  const [theme, setTheme] = useThemePreference();
  const { askConfirmation } = useConfirmation();
  const { guard: guardRestart } = useIdleUpdateGuard();
  const history = useViewHistory();
  const sidebarShown = useSidebarLayout().shown;
  const zoom = useZoomLevel();

  const actions = useMemo(() => {
    // Back and Forward pass over pages that need the core while it's down, as ⌘[ and ⌘] do.
    const canOpen = (view: AppView) => canOpenView(view, Boolean(status?.ready));
    const coreCommand = async (command: CoreProcessCommand) => {
      const error = await runCoreProcess(command, { publishStatus, refreshStatus });
      toast(error
        ? { kind: 'error', title: t('palette.outcome.coreFailed', { action: t(CORE_ACTION_LABEL[command]) }), description: error }
        : { kind: 'success', title: t(CORE_DONE[command]) });
    };
    // Starts the copy in the same key press or click as the pick, as WebKit asks; see copyPendingText.
    const copy = async (read: () => Promise<string | null>, label: (value: string) => string, empty: string) => {
      toast(pendingCopyToast(await copyPendingText(read), { label, empty }, t));
    };
    // The same command as the View menu and Settings › Appearance; the page's new size says it worked.
    const changeZoom = (change: () => Promise<unknown>) => async () => {
      const failure = await tryZoomChange(change);
      if (failure) toast({ kind: 'error', title: t('zoom.failed'), description: failure.reason });
    };
    const confirmed = async (command: 'start_core_process' | 'restart_core_process') => !confirmCore || askConfirmation({
      title: t(CORE_CONFIRM[command].title),
      message: t(CORE_CONFIRM[command].message),
      confirmText: t(CORE_CONFIRM[command].confirm),
    });
    const run: Record<PaletteActionId, PaletteItem['run']> = {
      'refresh-limits': () => void refreshAccountQuotas(getAccountsSnapshot().files),
      'start-core': async () => {
        if (await confirmed('start_core_process')) await coreCommand('start_core_process');
      },
      'stop-core': async () => {
        const confirmed = await askConfirmation({
          title: t('palette.confirm.stopCore.title'),
          message: t('palette.confirm.stopCore.message'),
          confirmText: t('palette.action.stopCore'),
          variant: 'danger',
        });
        if (confirmed) await coreCommand('stop_core_process');
      },
      'restart-core': () => {
        const restart = () => void coreCommand('restart_core_process');
        void guardRestart({ kind: 'restart' }, restart, () => void confirmed('restart_core_process').then((yes) => { if (yes) restart(); }));
      },
      'pause-account': undefined,
      'resume-account': undefined,
      'copy-base-url': () => copy(loadProxyBaseUrl, (url) => t('palette.outcome.copiedUrl', { url }), t('palette.outcome.noUrl')),
      // Read, copied and dropped: the key is never put on screen or kept.
      'copy-api-key': () => copy(
        async () => (await invokeCommand('get_core_config_settings')).apiKeys[0]?.apiKey ?? null,
        () => t('palette.outcome.copiedKey'),
        t('palette.outcome.noKey'),
      ),
      'scan-setup': () => {
        // Checks shows the scan running and what it finds; the view Sync was left on might not (Agents has no scan).
        onNavigate(setupChecksView());
        scanSetup(null, false).catch((error: unknown) => toast({ kind: 'error', title: t('palette.outcome.scanFailed'), description: errorText(error) }));
      },
      'toggle-sidebar': toggleSidebar,
      'theme-light': () => setTheme('light'),
      'theme-dark': () => setTheme('dark'),
      'theme-system': () => setTheme('system'),
      'zoom-in': changeZoom(zoomIn),
      'zoom-out': changeZoom(zoomOut),
      'actual-size': changeZoom(resetZoom),
      'go-back': () => void goBack(canOpen),
      'go-forward': () => void goForward(canOpen),
    };
    const core = status
      ? { installed: status.installed, running: status.running, ready: status.ready, busy: isCoreStarting(status) }
      : null;
    const steps = { back: stepTarget(history, -1, canOpen) !== null, forward: stepTarget(history, 1, canOpen) !== null };
    const zoomNow = t('zoom.level', { percent: zoomPercent(zoom.factor) });
    return paletteActions({ core, accounts: files.length, paused: disabled.length, history: steps, sidebarShown, zoom }).map(({ id, unavailable, label: current }): PaletteItem => {
      const { label, icon: Icon, keywords, shortcut } = ACTION[id];
      const submenu: PaletteSubmenu | undefined = id === 'pause-account' ? 'pause' : id === 'resume-account' ? 'resume' : undefined;
      return {
        id: `action:${id}`,
        group: 'actions',
        label: t(current ?? label),
        keywords: keywords ? t(keywords) : undefined,
        icon: <IconBox><Icon /></IconBox>,
        detail: THEME[id] === theme ? t('palette.action.current') : ZOOM_ACTIONS.includes(id) ? zoomNow : undefined,
        disabledReason: unavailable ? t(unavailable) : undefined,
        shortcut,
        submenu,
        run: run[id],
      };
    });
  }, [status, files.length, disabled.length, history, sidebarShown, zoom, theme, setTheme, publishStatus, refreshStatus, askConfirmation, guardRestart, onNavigate, confirmCore, t]);

  const submenus = useMemo(() => {
    const accountItem = (file: AuthFile, run: (name: string, key: string) => PaletteItem['run']): PaletteItem => {
      const key = quotaKey(file);
      const profile = resolveAccountProfile(key, fileName(file), profiles[key]);
      const provider = providerForFile(file);
      const email = typeof file.email === 'string' ? file.email : '';
      return {
        id: `account:${key}`,
        group: 'accounts',
        label: profile.name,
        keywords: [email, fileName(file), provider ? providerLabel[provider] : ''].join(' '),
        // As big as the other rows' icon tiles (IconBox), so every row's words start in line.
        icon: <AccountAvatar profile={profile} size="sm" className="size-7" />,
        detail: [provider ? providerLabel[provider] : '', reserves.paused[key] ? t('palette.pausedAtCap') : ''].filter(Boolean).join(' · '),
        run: run(profile.name, key),
      };
    };
    return {
      // Only a credential file can be turned off; the rest are listed grayed out so it's clear why they're missing.
      pause: files.map((file) => ({
        ...accountItem(file, (name) => async () => {
          const confirmed = await askConfirmation({
            title: t('palette.confirm.pause.title', { name }),
            message: t('palette.confirm.pause.message'),
            confirmText: t('palette.confirm.pause.button'),
          });
          if (!confirmed) return;
          try {
            await pauseAccount(file);
            toast({ kind: 'success', title: t('palette.outcome.paused', { name }) });
          } catch (error) {
            toast({ kind: 'error', title: t('palette.outcome.pauseFailed', { name }), description: errorText(error) });
          }
        }),
        disabledReason: isOAuthCredentialFile(file) ? undefined : t('palette.unavailable.cantPause'),
      })),
      resume: disabled.map((file) => accountItem(file, (name, key) => async () => {
        try {
          await resumeAccount(key, file);
          toast({ kind: 'success', title: t('palette.outcome.resumed', { name }) });
        } catch (error) {
          toast({ kind: 'error', title: t('palette.outcome.resumeFailed', { name }), description: errorText(error) });
        }
      })),
    };
  }, [files, disabled, profiles, reserves.paused, askConfirmation, t]);

  return { actions, submenus };
}

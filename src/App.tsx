import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { setSettingsProject, setSettingsScope } from './services/machineSettings';
import { addAccount } from './services/addAccount';
import { onAddMachineRequest } from './services/addMachine';
import { Activity, Archive, BellRing, Database, FolderSearch, Info, Monitor, PackageOpen, Palette, Route, Settings2, Shuffle, SlidersHorizontal, Sparkles, Tags, type AppIcon } from './components/ui/icons';
import { CoreRuntimeProvider, useCoreRuntime } from './coreRuntime';
import { CoreUpdateProvider, useCoreUpdate } from './coreUpdate';
import { HomePage } from './pages/HomePage';
import { MachinePill } from './components/identity/Identity';
import { SidebarLimits } from './components/SidebarLimits';
import { LimitsMonitor } from './components/LimitsMonitor';
import { AccountReservesMonitor } from './components/AccountReservesMonitor';
import { ProxyChecksMonitor } from './components/ProxyChecksMonitor';
import { SessionMonitor } from './components/SessionMonitor';
import { LiveSessionsMonitor } from './components/LiveSessionsMonitor';
import { WeeklyDigestMonitor } from './components/WeeklyDigestMonitor';
import { MachineMonitor } from './components/MachineMonitor';
import { SetupChangeMonitor } from './components/SetupChangeMonitor';
import { ArchiveMonitor } from './components/ArchiveMonitor';
import { AgentAttentionMonitor } from './components/AgentAttentionMonitor';
import { FleetMonitor } from './components/FleetMonitor';
import { AlertCoordinator } from './components/AlertCoordinator';
import { UpdateWhenIdleMonitor } from './components/UpdateWhenIdleMonitor';
import { AddMachineDialog } from './components/AddMachineDialog';
import { ARBOR_RELEASES_URL, NO_RELEASE_NOTES, arborReleaseUrl, releaseNotesToShow } from './services/releaseNotes';
import { availableBesideWaiting, idleUpdatePillDetail, idleUpdateTitleKey, useIdleUpdates } from './services/updateWhenIdle';
import { CommandPalette, type PalettePage, type PaletteSetting } from './components/CommandPalette';
import { SettingsSearch } from './components/SettingsSearch';
import { QuitGuard } from './components/QuitGuard';
import { MonitorBoundary, PageErrorBoundary } from './components/ErrorBoundaries';
import { CoreLockedPage } from './components/CoreLockedPage';
import { coreLock, coreLockHint, sidebarCoreState } from './services/coreLock';
import { useMacTitleBar } from './services/windowChrome';
import { clampSidebarWidth, pagePutsAwaySidebar, putAwaySidebarOverlay, toggleSidebar, useSidebarLayout, useSidebarMaxWidth } from './services/sidebarLayout';
import { sidebarArtChoice, sidebarArtHalo, sidebarArtInk } from './services/sidebarArt';
import { appColorChoice, applyAppColor } from './services/appColor';
import { SIDEBAR_ID, SidebarResizeHandle, SidebarToggle } from './components/SidebarControls';
import { SidebarHeader, SidebarRow, SidebarSearchGroup, SidebarSearchRow } from './components/sidebar/SidebarChrome';
import { PAGE_ICONS, SidebarTree } from './components/sidebar/SidebarTree';
import { leafView, PALETTE_VIEWS, TREE_PAGES } from './services/sidebarTree';
import { AlertsUtility, CoreDownRow, CoreUtility, SettingsBack, SettingsUtility, UpdateUtility } from './components/sidebar/SidebarFooter';
import { useAppShortcuts } from './hooks/useAppShortcuts';
import { useModifierHold } from './hooks/useShortcuts';
import { SETTINGS_PAGE_LABEL, indexSettings, type SettingEntry } from './services/settingsIndex';
import { requestFocus } from './focusRequests';
import { focusReturnTarget } from './services/focusReturn';
import { trackPageView, usageDataNoticeDue } from './services/productAnalytics';
import { invokeCommand } from './native/commands';
import { useSettingReveal } from './hooks/useSettingReveal';
import { useAppPreferences } from './appPreferences';
import { useScrollFade } from './hooks/useScrollFade';
import { clearOfFade, scrollEdges, scrollPosition } from './lib/scrollFade';
import { useI18n } from './i18n';
import { AppUpdateDialog, AppUpdateProvider, useAppUpdate } from './appUpdate';
import { appUpdateIndicatorState } from './appUpdateModel';
import { accountLimitsView, canOpenView, machinesView, mainView, samePage, viewPageId, type AppView, type MainPageId, type SettingsPageId } from './navigation';
import { canArrive, changePageView, currentView, goBack, goForward, goToView, lockedInPlace, useViewHistory, type ViewArrival, type ViewChange } from './services/viewHistory';
import type { MessageKey } from './i18n/resources';
import { useAppliedTheme, useThemePreference, type ThemePreference } from './theme';
import { cn } from './lib/utils';
import { toast, Toaster } from './components/ui/toast';
import { ConfirmationHost } from './components/ConfirmationDialog';
import { TooltipProvider } from './components/ui/tooltip';

/** Every main page's name: the sidebar tree's six, and Alerts, the footer's bell. */
const mainPages: { id: MainPageId; labelKey: MessageKey; keywords?: MessageKey }[] = [
  ...TREE_PAGES,
  { id: 'alerts', labelKey: 'app.nav.alerts' },
];

// Settings' pages in the sidebar, in named groups like the main sidebar's sections, so a page is found by what it's
// about. Each page's name is in the Settings index, where search reads it too.
const settingsGroups: { id: string; labelKey: MessageKey; pages: { id: SettingsPageId; icon: AppIcon }[] }[] = [
  {
    id: 'proxy',
    labelKey: 'settings.group.proxy',
    pages: [
      { id: 'general', icon: SlidersHorizontal },
      { id: 'routing', icon: Route },
      { id: 'overrides', icon: Shuffle },
      { id: 'aliases', icon: Tags },
      { id: 'extra-models', icon: Sparkles },
    ],
  },
  {
    id: 'fleet',
    labelKey: 'settings.group.fleet',
    pages: [
      { id: 'machines', icon: Monitor },
      { id: 'agent-homes', icon: FolderSearch },
      { id: 'session-archive', icon: Archive },
    ],
  },
  {
    id: 'data',
    labelKey: 'settings.group.data',
    pages: [
      { id: 'data', icon: Database },
      { id: 'diagnostics', icon: Activity },
    ],
  },
  {
    id: 'arbor',
    labelKey: 'settings.group.arbor',
    pages: [
      { id: 'appearance', icon: Palette },
      { id: 'notifications', icon: BellRing },
      { id: 'software', icon: Settings2 },
      { id: 'updates', icon: PackageOpen },
      { id: 'about', icon: Info },
    ],
  },
];

const HOME_VIEW: AppView = { kind: 'main', page: 'home' };

// Home comes with the app; every other page loads the first time it's opened, so starting up doesn't wait on them.
const pageModules = {
  accounts: () => import('./pages/AccountsPage'),
  usage: () => import('./pages/UsageRecordsPage'),
  usageData: () => import('./pages/UsageDataSettingsPage'),
  setup: () => import('./pages/SetupPage'),
  alerts: () => import('./pages/AlertsPage'),
  config: () => import('./pages/ConfigPanel'),
  modelRouting: () => import('./pages/ModelRoutingPage'),
  extraModels: () => import('./pages/ExtraModelsPage'),
  settings: () => import('./pages/SettingsPages'),
  agentHomes: () => import('./pages/AgentHomesSettings'),
  appearance: () => import('./pages/AppearanceSettingsPage'),
  notifications: () => import('./pages/NotificationsSettingsPage'),
  sessionArchive: () => import('./pages/SessionArchiveSettings'),
  versions: () => import('./pages/VersionManagementPage'),
  diagnostics: () => import('./pages/DiagnosticsSettings'),
  about: () => import('./pages/AboutSettings'),
};
const AccountsPage = lazy(() => pageModules.accounts().then((module) => ({ default: module.AccountsPage })));
const UsageRecordsPage = lazy(() => pageModules.usage().then((module) => ({ default: module.UsageRecordsPage })));
const UsageDataSettingsPage = lazy(() => pageModules.usageData().then((module) => ({ default: module.UsageDataSettingsPage })));
const SetupPage = lazy(() => pageModules.setup().then((module) => ({ default: module.SetupPage })));
const AlertsPage = lazy(() => pageModules.alerts().then((module) => ({ default: module.AlertsPage })));
const ConfigPanelPage = lazy(() => pageModules.config().then((module) => ({ default: module.ConfigPanelPage })));
const ModelRoutingPage = lazy(() => pageModules.modelRouting().then((module) => ({ default: module.ModelRoutingPage })));
const ExtraModelsPage = lazy(() => pageModules.extraModels().then((module) => ({ default: module.ExtraModelsPage })));
const MachineAssignmentsSettingsPage = lazy(() => pageModules.settings().then((module) => ({ default: module.MachineAssignmentsSettingsPage })));
const AgentHomesSettingsPage = lazy(() => pageModules.agentHomes().then((module) => ({ default: module.AgentHomesSettingsPage })));
const AppearanceSettingsPage = lazy(() => pageModules.appearance().then((module) => ({ default: module.AppearanceSettingsPage })));
const NotificationsSettingsPage = lazy(() => pageModules.notifications().then((module) => ({ default: module.NotificationsSettingsPage })));
const SessionArchiveSettingsPage = lazy(() => pageModules.sessionArchive().then((module) => ({ default: module.SessionArchiveSettingsPage })));
const VersionManagementPage = lazy(() => pageModules.versions().then((module) => ({ default: module.VersionManagementPage })));
const DiagnosticsSettingsPage = lazy(() => pageModules.diagnostics().then((module) => ({ default: module.DiagnosticsSettingsPage })));
const AboutSettingsPage = lazy(() => pageModules.about().then((module) => ({ default: module.AboutSettingsPage })));

/** Once the app has settled, loads the other pages in the background, so opening one later doesn't wait. */
function usePagePrefetch() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const load of Object.values(pageModules)) void load().catch(() => undefined);
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, []);
}

/** The name a view's page goes by in the sidebar. */
function pageLabelKey(view: AppView): MessageKey {
  if (view.kind === 'main') return mainPages.find((page) => page.id === view.page)?.labelKey ?? 'app.nav.home';
  return SETTINGS_PAGE_LABEL[view.page];
}

// Memoized: the shell renders again for things the page doesn't show (an update check, a held ⌘ showing shortcuts,
// the sidebar's limits), and the open page, some of them long tables, needn't follow it.
const ViewContent = memo(function ViewContent({ view, visit, coreReady, onNavigate, onViewChange, onAddMachine, theme, onThemeChange }: {
  view: AppView; visit: number; coreReady: boolean; onNavigate: (view: AppView) => void;
  onViewChange: (view: AppView, how?: ViewChange) => void; onAddMachine: () => void;
  theme: ThemePreference; onThemeChange: (theme: ThemePreference) => void;
}) {
  if (view.kind === 'main') {
    switch (view.page) {
      case 'home': return <HomePage onNavigate={onNavigate} onAddMachine={onAddMachine} />;
      case 'accounts': return <AccountsPage params={view.params} onNavigate={onNavigate} onViewChange={onViewChange} />;
      // Prices keeps its own page: a price list beside what each model was used for.
      case 'usage': return view.params?.tab === 'prices'
        ? <UsageRecordsPage key="prices" variant="pricing" onNavigate={onNavigate} />
        : <UsageRecordsPage key="usage" variant="usage" params={view.params} onNavigate={onNavigate} onViewChange={onViewChange} />;
      // Sessions opens a session, or Projects' Checkouts, in place of its list, so choosing it again goes back to the
      // list, and Back or Activity return to it as it was.
      case 'sessions': return <UsageRecordsPage key={`sessions-${visit}`} variant="sessions" params={view.params} onNavigate={onNavigate} onViewChange={onViewChange} />;
      case 'machines': return <UsageRecordsPage key="machines" variant="machines" params={view.params} onNavigate={onNavigate} onViewChange={onViewChange} />;
      case 'setup': return <SetupPage params={view.params} onNavigate={onNavigate} onViewChange={onViewChange} />;
      case 'alerts': return <AlertsPage coreReady={coreReady} onNavigate={onNavigate} />;
    }
  }
  switch (view.page) {
    case 'general':
    case 'routing':
    case 'aliases':
    case 'software':
      return <ConfigPanelPage section={view.page} />;
    case 'overrides': return <ModelRoutingPage />;
    case 'extra-models': return <ExtraModelsPage />;
    case 'machines': return <MachineAssignmentsSettingsPage onNavigate={onNavigate} />;
    case 'agent-homes': return <AgentHomesSettingsPage />;
    case 'data': return <UsageDataSettingsPage />;
    case 'session-archive': return <SessionArchiveSettingsPage />;
    case 'appearance': return <AppearanceSettingsPage theme={theme} onThemeChange={onThemeChange} />;
    case 'notifications': return <NotificationsSettingsPage />;
    case 'updates': return <VersionManagementPage />;
    case 'diagnostics': return <DiagnosticsSettingsPage />;
    case 'about': return <AboutSettingsPage onNavigate={onNavigate} />;
  }
});

function App() {
  return (
    <AppUpdateProvider>
      <CoreRuntimeProvider>
        <CoreUpdateProvider>
          <TooltipProvider delay={500}>
            <AppContent />
          </TooltipProvider>
        </CoreUpdateProvider>
      </CoreRuntimeProvider>
    </AppUpdateProvider>
  );
}

function AppContent() {
  const { t, tRich } = useI18n();
  usePagePrefetch();
  const { info: appUpdateInfo, hasUpdate, processing: appUpdateProcessing } = useAppUpdate();
  const { latest: coreLatest, hasUpdate: coreHasUpdate } = useCoreUpdate();
  const history = useViewHistory();
  const view = currentView(history);
  // Where Settings opens, and where leaving it returns to: the last page on each side, as it was left.
  const lastMainView = useRef<AppView>(HOME_VIEW);
  const lastSettingsPage = useRef<SettingsPageId>('general');
  useEffect(() => {
    if (view.kind === 'main') lastMainView.current = view;
    else lastSettingsPage.current = view.page;
  }, [view]);
  // Counts navigations, for pages that start over when they're chosen again. Back and Forward and a page's own
  // changes don't count: they return to a page as it was.
  const [visit, setVisit] = useState(0);
  const [theme, setTheme] = useThemePreference();
  const macTitleBar = useMacTitleBar();
  const { status, statusError } = useCoreRuntime();
  // Pages and background work that call the core wait until it answers, not just until its process is up.
  const coreReady = Boolean(status?.ready);
  const inSettings = view.kind === 'settings';
  const preferences = useAppPreferences();
  // Whichever nav is showing fades at an edge with more items past it, so a short window shows it scrolls.
  const [navScrollRef, navFadeStyle] = useScrollFade<HTMLElement>();
  const navRef = useRef<HTMLElement | null>(null);
  const setNavRef = useCallback((element: HTMLElement | null) => {
    navRef.current = element;
    navScrollRef(element);
  }, [navScrollRef]);
  const sidebar = useSidebarLayout();
  // The saved width, as far as the window allows: the page beside it keeps at least 640px. In a window too narrow for
  // both, the sidebar opens over the page instead (sidebar.overlay).
  const sidebarMax = useSidebarMaxWidth();
  const sidebarWidth = clampSidebarWidth(sidebar.width, sidebarMax);
  const shellRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // Hiding the sidebar with the focus in it, by ⌘B or by a window too narrow for it, would drop the focus on the page;
  // it goes to the sidebar button, which stays where it is.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!sidebar.shown && active !== null && asideRef.current?.contains(active)) toggleRef.current?.focus();
  }, [sidebar.shown]);
  // Switching the sidebar between the main pages and Settings takes away the control that did it (Settings, Back, Add
  // account), which drops the focus on the window. It goes to the row of the page that's open now, so the keyboard
  // stays in the sidebar and a screen reader says where it landed. Focus that's somewhere else is left there.
  const sidebarMode = useRef(inSettings);
  useLayoutEffect(() => {
    if (sidebarMode.current === inSettings) return;
    sidebarMode.current = inSettings;
    const active = document.activeElement;
    if (!sidebar.shown || (active !== null && active !== document.body)) return;
    asideRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
  }, [inSettings, sidebar.shown]);
  // In a window too narrow for the sidebar and a 640px page side by side, ⌘B or the sidebar button opens it over the
  // page, as a sheet: the focus goes into it, at the open page's row, and picking a page, a click beside it
  // or Esc puts it away again.
  useLayoutEffect(() => {
    const aside = asideRef.current;
    if (!sidebar.overlay || !aside || aside.contains(document.activeElement)) return;
    aside.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
  }, [sidebar.overlay]);
  const openPage = useRef(viewPageId(view));
  useEffect(() => {
    const page = viewPageId(view);
    if (pagePutsAwaySidebar(openPage.current, page)) putAwaySidebarOverlay();
    openPage.current = page;
  }, [view]);
  const [addingMachine, setAddingMachine] = useState(false);
  // Stable, so the memoized page doesn't render again for it.
  const addMachine = useCallback(() => setAddingMachine(true), []);
  useEffect(() => onAddMachineRequest(addMachine), [addMachine]);
  const appliedTheme = useAppliedTheme();
  const sidebarArt = sidebarArtChoice(preferences.sidebarArt);
  const appColor = appColorChoice(preferences.appColor);
  // Before paint, so the buttons never show the color before it for a frame.
  useLayoutEffect(() => applyAppColor(appColor), [appColor]);
  const idleUpdates = useIdleUpdates().updates;
  const updateIndicator = appUpdateIndicatorState(hasUpdate, coreHasUpdate, appUpdateProcessing, idleUpdates.length > 0);
  const waitingPill = updateIndicator === 'waiting';
  // While something waits, the versions available that nothing waits for still show, on a line of their own.
  const available = availableBesideWaiting(waitingPill ? idleUpdates : [], {
    app: hasUpdate ? appUpdateInfo?.latestVersion ?? '' : '',
    core: coreHasUpdate ? coreLatest?.version ?? '' : '',
  });
  const updateDetail = [
    available.app ? t('app.updatePill.app', { version: available.app }) : '',
    available.core ? t('app.updatePill.core', { version: available.core }) : '',
  ].filter(Boolean).join(' · ');
  const updateLabel = updateIndicator === 'processing'
    ? t('app.updatePill.processing')
    : waitingPill ? t(idleUpdateTitleKey(idleUpdates)) : t('app.updatePill.available');
  const pillDetail = waitingPill ? idleUpdatePillDetail(idleUpdates, t) : updateDetail;
  const pillAvailable = waitingPill && updateDetail ? t('app.updatePill.alsoAvailable', { items: updateDetail }) : '';
  // What the Arbor update changes, beside the update icon; its plain label only when there's nothing to show.
  const pillNotes = hasUpdate && appUpdateInfo && updateIndicator !== 'processing'
    ? releaseNotesToShow(appUpdateInfo.releases, appUpdateInfo.currentVersion, appUpdateInfo.latestVersion)
    : NO_RELEASE_NOTES;

  // Bring the current page's row into sight when the page changes from outside the nav (the update icon, the search
  // palette) or the nav swaps, centered so it's clear of the edge fades and the rows around it show. A row already in
  // clear view stays put, so clicking one doesn't move the nav. Only the nav scrolls: the row is on screen once it's
  // in the nav's view.
  // A hidden sidebar has nothing to measure, so it's done again as the sidebar comes back. The tree asks again when
  // its rows move under the row without a hand in it: the window or a zoom step changing its height, the fit folding
  // groups with it, or its machines arriving, for a machine opened before they had.
  const bringCurrentRowIntoView = useCallback(() => {
    const nav = navRef.current;
    const row = nav?.querySelector('[aria-current="page"]');
    if (!nav || !row || !sidebar.shown) return;
    if (clearOfFade(row.getBoundingClientRect(), nav.getBoundingClientRect(), scrollEdges(scrollPosition(nav, 'y')), NAV_FADE_PX)) return;
    row.scrollIntoView({ block: 'center' });
  }, [sidebar.shown]);
  useEffect(() => {
    bringCurrentRowIntoView();
  }, [view, inSettings, bringCurrentRowIntoView]);

  const goTo = useCallback((next: AppView, how: ViewArrival) => {
    if (!canArrive(next, how, coreReady)) return;
    goToView(next);
    setVisit((count) => count + 1);
  }, [coreReady]);
  const navigate = useCallback((next: AppView) => goTo(next, 'open'), [goTo]);
  const changeView = useCallback((next: AppView, how?: ViewChange) => void changePageView(next, how), []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // What was typed into the sidebar's search row to open it, typed into the palette as it opens.
  const [paletteQuery, setPaletteQuery] = useState('');
  // The palette hands focus back to what had it as it opened. When that was in the sidebar and the palette's action
  // hid the sidebar, the sidebar button takes it, rather than the page (focusReturnTarget).
  const paletteOpener = useRef<HTMLElement | null>(null);
  const openPalette = useCallback((open: boolean, query = '') => {
    if (open) {
      paletteOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPaletteQuery(query);
    }
    setPaletteOpen(open);
  }, []);
  const paletteFinalFocus = useCallback(() => {
    const opener = paletteOpener.current;
    paletteOpener.current = null;
    return focusReturnTarget(opener, { inSidebar: (element) => Boolean(asideRef.current?.contains(element)), sidebarButton: toggleRef.current });
  }, []);
  // Settings search, in the sidebar and the palette: the page opens at the row, which is brought into view once it's there.
  const settingsIndex = useMemo(() => indexSettings(t), [t]);
  const canOpenSettingsPage = useCallback((page: SettingsPageId) => canOpenView({ kind: 'settings', page }, coreReady), [coreReady]);
  const openSetting = useCallback((entry: SettingEntry) => {
    const target: AppView = { kind: 'settings', page: entry.page };
    if (!canOpenView(target, coreReady)) return;
    requestFocus('setting', entry.id);
    // Already open, it's left as it is, with whatever is typed into it.
    if (!samePage(currentView(history), target)) navigate(target);
  }, [coreReady, history, navigate]);
  useSettingReveal(view.kind === 'settings' ? view.page : null);
  useEffect(() => trackPageView(view), [view]);
  // Usage data is on from the start in an official release, so a new install's first launch says so, once, with the
  // way to turn it off.
  const openUsageData = useRef(() => {});
  openUsageData.current = () => {
    const target: AppView = { kind: 'settings', page: 'software' };
    requestFocus('setting', 'software.usage-data');
    if (!samePage(currentView(history), target)) navigate(target);
  };
  useEffect(() => {
    let disposed = false;
    invokeCommand('get_product_analytics')
      .then((settings) => {
        if (disposed || !usageDataNoticeDue(settings)) return;
        invokeCommand('mark_product_analytics_notice_shown').catch(() => undefined);
        toast({
          id: 'usage-data-notice',
          title: t('usageData.notice.title'),
          description: t('usageData.notice.description'),
          durationMs: 20_000,
          action: { label: t('usageData.notice.action'), onClick: () => openUsageData.current() },
        });
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
    // Once, on launch; the words are read as it shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Settings opens on All projects and machines each time, so it never starts out changing one without saying so.
  useEffect(() => {
    if (inSettings) return;
    setSettingsScope(null);
    setSettingsProject(null);
  }, [inSettings]);
  const paletteSettings = useMemo<PaletteSetting[]>(
    () => settingsIndex.map((setting) => ({ setting, locked: !canOpenSettingsPage(setting.entry.page) })),
    [settingsIndex, canOpenSettingsPage],
  );
  // Every page, and each of its views under it as the sidebar tree has them, found by the page's name as well.
  const palettePages = useMemo<PalettePage[]>(() => {
    const page = (view: AppView, labelKey: MessageKey, icon: AppIcon, keywords?: MessageKey): PalettePage => ({
      view, label: t(labelKey), icon, locked: !canOpenView(view, coreReady), keywords: keywords ? t(keywords) : undefined,
    });
    return [
      ...mainPages.map((item) => page(mainView(item.id), item.labelKey, PAGE_ICONS[item.id], item.keywords)),
      ...TREE_PAGES.flatMap((item) => item.leaves.map((leaf): PalettePage => ({
        ...page(leafView(leaf), leaf.labelKey, PAGE_ICONS[item.id], leaf.keywords),
        parent: t(item.labelKey),
      }))),
      ...PALETTE_VIEWS.map((item): PalettePage => ({
        ...page(item.view, item.labelKey, PAGE_ICONS[item.page], item.keywords),
        parent: t(pageLabelKey(mainView(item.page))),
      })),
      ...settingsGroups.flatMap((group) => group.pages).map((item) => page({ kind: 'settings', page: item.id }, SETTINGS_PAGE_LABEL[item.id], item.icon)),
    ];
  }, [coreReady, t]);
  // Settings, ⌘,, Back and Esc return to the page left on the other side, even one that needs the core and it has
  // stopped since.
  const openSettings = () => goTo({ kind: 'settings', page: lastSettingsPage.current }, 'return');
  const leaveSettings = () => goTo(lastMainView.current, 'return');
  // A page that needs the core is passed over while it's down, rather than landed on locked.
  const canOpen = (next: AppView) => canOpenView(next, coreReady);
  useAppShortcuts({
    inSettings, navigate, openSettings, leaveSettings,
    togglePalette: () => openPalette(!paletteOpen),
    toggleSidebar,
    goBack: () => goBack(canOpen),
    goForward: () => goForward(canOpen),
  });
  // While ⌘ is held for a moment, the sidebar shows which number opens which page.
  const shortcutHints = useModifierHold();

  const coreState = sidebarCoreState(status, statusError);
  const lock = coreLock(status, statusError);
  const coreLockedHint = t(coreLockHint(lock));
  const pageLabel = t(pageLabelKey(view));

  return (
    <>
      <MonitorBoundary name="LimitsMonitor"><LimitsMonitor coreReady={coreReady} /></MonitorBoundary>
      <MonitorBoundary name="AccountReservesMonitor"><AccountReservesMonitor coreReady={coreReady} /></MonitorBoundary>
      <MonitorBoundary name="ProxyChecksMonitor"><ProxyChecksMonitor coreReady={coreReady} /></MonitorBoundary>
      <MonitorBoundary name="SessionMonitor"><SessionMonitor /></MonitorBoundary>
      <MonitorBoundary name="LiveSessionsMonitor"><LiveSessionsMonitor /></MonitorBoundary>
      <MonitorBoundary name="WeeklyDigestMonitor"><WeeklyDigestMonitor /></MonitorBoundary>
      <MonitorBoundary name="MachineMonitor"><MachineMonitor /></MonitorBoundary>
      <MonitorBoundary name="SetupChangeMonitor"><SetupChangeMonitor /></MonitorBoundary>
      <MonitorBoundary name="ArchiveMonitor"><ArchiveMonitor /></MonitorBoundary>
      <MonitorBoundary name="AgentAttentionMonitor"><AgentAttentionMonitor /></MonitorBoundary>
      <MonitorBoundary name="FleetMonitor"><FleetMonitor /></MonitorBoundary>
      <MonitorBoundary name="AlertCoordinator"><AlertCoordinator coreReady={coreReady} onNavigate={navigate} /></MonitorBoundary>
      <MonitorBoundary name="UpdateWhenIdleMonitor"><UpdateWhenIdleMonitor /></MonitorBoundary>
      <MonitorBoundary name="QuitGuard"><QuitGuard /></MonitorBoundary>
      {/* Closed on a crash so it doesn't pop back open by itself when it restarts. */}
      <MonitorBoundary name="CommandPalette" onCrash={() => setPaletteOpen(false)}>
        <CommandPalette
          open={paletteOpen}
          initialQuery={paletteQuery}
          onOpenChange={openPalette}
          finalFocus={paletteFinalFocus}
          pages={palettePages}
          settings={paletteSettings}
          lockedHint={coreLockedHint}
          coreReady={coreReady}
          onNavigate={navigate}
          onOpenSetting={openSetting}
        />
      </MonitorBoundary>
      {/* The sidebar's width is set here, where its resize handle writes it mid-drag. With the Mac window buttons, the
          title-row controls start past them (styles.css). The artwork's halo color is set here too, as the sidebar
          button sits outside the sidebar. */}
      <div
        ref={shellRef}
        className="relative flex h-full w-full bg-background text-foreground"
        style={{ '--sidebar-width': `${sidebarWidth}px`, '--art-halo': sidebarArtHalo(sidebarArt, appliedTheme, appColor) } as CSSProperties}
        data-app-shell
        data-mac-title-bar={macTitleBar ? '' : undefined}
      >
        {/* The one sidebar button, fixed to the window beside the Mac window buttons: the same place whether the sidebar
            is open, hidden or in Settings. Over the artwork it takes the art's ink. It comes
            before the sidebar in the markup, as it's left of the wordmark on screen, so Tab reaches it first. */}
        <div className="pointer-events-none fixed top-0 left-[var(--workspace-controls-left)] z-50 flex h-[var(--workspace-topbar-height)] items-center">
          <SidebarToggle
            shown={sidebar.shown}
            onToggle={toggleSidebar}
            buttonRef={toggleRef}
            ink={sidebar.shown ? sidebarArtInk(sidebarArt, appliedTheme, appColor) : undefined}
            className={cn('pointer-events-auto', sidebar.shown && 'text-[var(--sidebar-icon-color)] hover:bg-sidebar-row-hover hover:text-sidebar-foreground')}
          />
        </div>

        {/* Hidden rather than taken out, so its scroll position and what it has loaded are there when it's back. Over
            the page in a narrow window, where Esc puts it away (unless something in it used the key first). */}
        <aside
          ref={asideRef}
          id={SIDEBAR_ID}
          className={cn(
            'surface-grain @container/sidebar relative flex w-[var(--sidebar-width)] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground',
            sidebar.overlay && 'absolute inset-y-0 left-0 z-40 shadow-lg',
            !sidebar.shown && 'hidden',
          )}
          data-app-sidebar
          data-overlay={sidebar.overlay ? '' : undefined}
          onKeyDown={(event) => {
            if (!sidebar.overlay || event.key !== 'Escape' || event.defaultPrevented) return;
            // Taken here, so Esc doesn't also leave Settings.
            event.preventDefault();
            putAwaySidebarOverlay();
          }}
        >
          <SidebarHeader art={sidebarArt} theme={appliedTheme} color={appColor} macTitleBar={macTitleBar} onHome={() => navigate(HOME_VIEW)} />

          {inSettings ? (
            <SettingsSearch
              index={settingsIndex}
              canOpen={canOpenSettingsPage}
              lockedHint={coreLockedHint}
              onOpen={openSetting}
              listRef={setNavRef}
              listStyle={navFadeStyle}
            >
              {/* Each group under its name, drawn as the main sidebar's sections are. */}
              {settingsGroups.map((group, index) => (
                <div key={group.id} className={cn('flex flex-col gap-0.5', index > 0 && 'mt-3')} role="group" aria-labelledby={`settings-group-${group.id}`}>
                  <div id={`settings-group-${group.id}`} className="flex h-7 items-center px-2.5 text-xs font-medium text-sidebar-muted-foreground">
                    {t(group.labelKey)}
                  </div>
                  {group.pages.map((item) => {
                    const target: AppView = { kind: 'settings', page: item.id };
                    return (
                      <SidebarRow
                        key={item.id}
                        icon={item.icon}
                        label={t(SETTINGS_PAGE_LABEL[item.id])}
                        active={samePage(view, target)}
                        locked={!canOpenView(target, coreReady)}
                        lockedHint={coreLockedHint}
                        onClick={() => navigate(target)}
                      />
                    );
                  })}
                </div>
              ))}
            </SettingsSearch>
          ) : (
            <>
              <SidebarSearchGroup>
                <SidebarSearchRow
                  coreReady={coreReady}
                  lockedHint={coreLockedHint}
                  onSearch={(query) => openPalette(true, query)}
                  onNavigate={navigate}
                  onAddMachine={addMachine}
                />
              </SidebarSearchGroup>
              <SidebarTree
                view={view}
                coreReady={coreReady}
                lockedHint={coreLockedHint}
                hint={shortcutHints}
                onNavigate={navigate}
                navRef={setNavRef}
                navStyle={navFadeStyle}
                onRowsMoved={bringCurrentRowIntoView}
              />
            </>
          )}

          <div className="flex shrink-0 flex-col gap-2 px-2 pt-1 pb-2" data-slot="sidebar-footer">
            {!inSettings && coreState.down ? <CoreDownRow state={coreState} onNavigate={navigate} /> : null}
            {preferences.sidebarLimits && coreReady && !inSettings ? (
              <div className="px-1">
                <SidebarLimits onOpen={() => navigate(accountLimitsView())} onAddAccount={() => addAccount(navigate)} />
              </div>
            ) : null}
            <div className="flex items-center gap-0.5">
              {inSettings ? (
                <SettingsBack onBack={leaveSettings} />
              ) : (
                <>
                  <SettingsUtility onOpen={openSettings} />
                  <AlertsUtility current={samePage(view, { kind: 'main', page: 'alerts' })} onNavigate={navigate} />
                  <CoreUtility state={coreState} onNavigate={navigate} />
                </>
              )}
              {updateIndicator ? (
                <UpdateUtility
                  state={updateIndicator}
                  current={samePage(view, { kind: 'settings', page: 'updates' })}
                  label={updateLabel}
                  detail={[pillDetail, pillAvailable].filter(Boolean)}
                  notes={pillNotes}
                  enabled={sidebar.shown}
                  releaseUrl={arborReleaseUrl}
                  releasesUrl={ARBOR_RELEASES_URL}
                  onOpen={() => navigate({ kind: 'settings', page: 'updates' })}
                />
              ) : null}
            </div>
          </div>
          <SidebarResizeHandle width={sidebarWidth} max={sidebarMax} shell={shellRef} />
        </aside>
        {/* The sheet's backdrop, under the sidebar while it's over the page: a click on the page puts the sidebar away
            rather than landing on what's under it. */}
        {sidebar.overlay ? (
          <div aria-hidden="true" className="absolute inset-0 z-30 bg-background/60 backdrop-blur-xs" data-slot="sidebar-scrim" onPointerDown={putAwaySidebarOverlay} />
        ) : null}

        {/* Relative for the same reason as PageBody's scroll area, for anything a page puts outside it. With the sidebar
            hidden, or over the page, the page's top bar starts where the wordmark does, past the sidebar button. */}
        <main
          className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
          style={sidebar.shown && !sidebar.overlay ? undefined : { '--topbar-start': 'var(--workspace-titlebar-content-left)' } as CSSProperties}
        >
          {/* Back and Forward start a page that failed over too, as choosing it again does. */}
          {lockedInPlace(history, coreReady) ? (
            <CoreLockedPage
              lock={lock ?? 'checking'}
              statusError={statusError}
              page={pageLabel}
              segments={view.kind === 'settings' ? [t('settings.title'), pageLabel] : [pageLabel]}
              width={view.kind === 'settings' ? 'readable' : 'main'}
              onInstall={() => navigate({ kind: 'settings', page: 'updates' })}
            />
          ) : (
            <PageErrorBoundary pageId={viewPageId(view)} resetKey={`${visit}:${history.index}`}>
              {/* A page's first load is a local file read; nothing shows for those few milliseconds. */}
              <Suspense fallback={null}>
                <ViewContent view={view} visit={visit} coreReady={coreReady} onNavigate={navigate} onViewChange={changeView} onAddMachine={addMachine} theme={theme} onThemeChange={setTheme} />
              </Suspense>
            </PageErrorBoundary>
          )}
        </main>
      </div>

      <AddMachineDialog
        open={addingMachine}
        onClose={() => setAddingMachine(false)}
        onAdded={(machine) => {
          setAddingMachine(false);
          toast({ kind: 'success', title: tRich('machines.hosts.added', { machine: <MachinePill name={machine} size="md" /> }) });
          // Its page, where the checklist brings it in line once it answers.
          navigate(machinesView(machine));
        }}
      />

      <AppUpdateDialog />
      <ConfirmationHost />
      <Toaster />
    </>
  );
}

/** The nav's edge fade: useScrollFade's 1.5rem. */
const NAV_FADE_PX = 24;

export default App;

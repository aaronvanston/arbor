import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { AppUpdateProvider } from './appUpdate';
import { CoreRuntimeProvider, useCoreRuntime } from './coreRuntime';
import { CoreUpdateProvider } from './coreUpdate';
import { LimitsMonitor } from './components/LimitsMonitor';
import { FleetHealthMonitor } from './components/FleetHealthMonitor';
import { AccountReservesMonitor } from './components/AccountReservesMonitor';
import { ProxyChecksMonitor } from './components/ProxyChecksMonitor';
import { SessionMonitor } from './components/SessionMonitor';
import { LiveSessionsMonitor } from './components/LiveSessionsMonitor';
import { WeeklyDigestMonitor } from './components/WeeklyDigestMonitor';
import { MachineMonitor } from './components/MachineMonitor';
import { SetupChangeMonitor } from './components/SetupChangeMonitor';
import { AutomationMonitor } from './components/AutomationMonitor';
import { ArchiveMonitor } from './components/ArchiveMonitor';
import { AgentAttentionMonitor } from './components/AgentAttentionMonitor';
import { FleetMonitor } from './components/FleetMonitor';
import { AlertCoordinator } from './components/AlertCoordinator';
import { UpdateWhenIdleMonitor } from './components/UpdateWhenIdleMonitor';
import { CliBridgeMonitor } from './components/CliBridgeMonitor';
import { QuitGuard } from './components/QuitGuard';
import { MonitorBoundary } from './components/ErrorBoundaries';
import { AfterLaunch } from './components/AfterLaunch';
import { useBackgroundReload } from './hooks/useBackgroundReload';
import type { AppView } from './navigation';
import type { ShellProps } from './App';
import { whenShown } from './services/bootMode';
import { carryOverReload } from './services/reloadHolds';
import { goToView, viewHistoryNow } from './services/viewHistory';

// Where the window was, carried over a reload into the background so it comes back there.
carryOverReload('history', viewHistoryNow);

let loadedShell: ComponentType<ShellProps> | null = null;

/**
 * Loads the app as it's seen (App.tsx). A launch waits for it before drawing anything, so the first frame is the whole
 * app; a page the window reloaded into in the background loads it once the window shows.
 */
export const loadShell = () => import('./App').then((module) => (loadedShell = module.default));

/**
 * Everything that runs while nobody looks (alerts, caps, limits, tray rows, the pools' report, the command line's window
 * actions), mounted for the page's whole life, and the app beside them once it has been shown.
 */
export function AppRoot() {
  const [Shell, setShell] = useState<ComponentType<ShellProps> | null>(() => loadedShell);
  const navigateRef = useRef<((view: AppView) => void) | null>(null);
  // An alert's Open goes through the shell, which checks the page can open; before it's there, straight to the view.
  const navigate = useCallback((view: AppView) => {
    if (navigateRef.current) navigateRef.current(view);
    else goToView(view);
  }, []);

  useEffect(() => {
    if (Shell) return;
    return whenShown(() => {
      void loadShell().then(
        (shell) => setShell(() => shell),
        // Thrown where the error boundary catches it, rather than leaving the window empty.
        (error: unknown) => setShell(() => {
          throw error;
        }),
      );
    });
  }, [Shell]);

  return (
    <AppUpdateProvider>
      <CoreRuntimeProvider>
        <CoreUpdateProvider>
          <AppMonitors shell={Shell !== null} onNavigate={navigate} />
          {Shell ? <Shell navigateRef={navigateRef} /> : null}
        </CoreUpdateProvider>
      </CoreRuntimeProvider>
    </AppUpdateProvider>
  );
}

function AppMonitors({ shell, onNavigate }: { shell: boolean; onNavigate: (view: AppView) => void }) {
  const { status } = useCoreRuntime();
  // Pages and background work that call the core wait until it answers, not just until its process is up.
  const coreReady = Boolean(status?.ready);
  useBackgroundReload(shell);
  return (
    <>
      {/* What feeds Home, the sidebar and the menu bar starts with the window; machine alerts share its health read. */}
      <MonitorBoundary name="LimitsMonitor"><LimitsMonitor coreReady={coreReady} /></MonitorBoundary>
      <MonitorBoundary name="LiveSessionsMonitor"><LiveSessionsMonitor /></MonitorBoundary>
      <MonitorBoundary name="MachineMonitor"><MachineMonitor /></MonitorBoundary>
      <MonitorBoundary name="FleetHealthMonitor"><FleetHealthMonitor /></MonitorBoundary>
      <MonitorBoundary name="FleetMonitor"><FleetMonitor /></MonitorBoundary>
      <MonitorBoundary name="AlertCoordinator"><AlertCoordinator coreReady={coreReady} onNavigate={onNavigate} /></MonitorBoundary>
      <MonitorBoundary name="QuitGuard"><QuitGuard /></MonitorBoundary>
      {/* The rest start once Home's reads have gone, a second or two in. */}
      <AfterLaunch>
        <MonitorBoundary name="AccountReservesMonitor"><AccountReservesMonitor coreReady={coreReady} /></MonitorBoundary>
        <MonitorBoundary name="ProxyChecksMonitor"><ProxyChecksMonitor coreReady={coreReady} /></MonitorBoundary>
        <MonitorBoundary name="SessionMonitor"><SessionMonitor /></MonitorBoundary>
        <MonitorBoundary name="WeeklyDigestMonitor"><WeeklyDigestMonitor /></MonitorBoundary>
        <MonitorBoundary name="SetupChangeMonitor"><SetupChangeMonitor /></MonitorBoundary>
        <MonitorBoundary name="AutomationMonitor"><AutomationMonitor /></MonitorBoundary>
        <MonitorBoundary name="ArchiveMonitor"><ArchiveMonitor /></MonitorBoundary>
        <MonitorBoundary name="AgentAttentionMonitor"><AgentAttentionMonitor /></MonitorBoundary>
        <MonitorBoundary name="UpdateWhenIdleMonitor"><UpdateWhenIdleMonitor /></MonitorBoundary>
        <MonitorBoundary name="CliBridgeMonitor"><CliBridgeMonitor /></MonitorBoundary>
      </AfterLaunch>
    </>
  );
}

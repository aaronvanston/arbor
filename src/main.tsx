import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { AppErrorBoundary } from './AppErrorBoundary';
import { AppRoot, loadShell } from './AppRoot';
import { I18nProvider } from './i18n';
import { trackWindowVisibility } from './lib/windowVisibility';
import { lastShownPageId } from './components/ErrorBoundaries';
import { beginBoot } from './services/bootMode';
import { preparePhoneAlerts } from './services/phoneAlerts';
import { reportUncaughtErrors } from './services/productAnalytics';
import { renameLegacySavedKeys } from './services/savedKeys';
import { loadSavedSettings } from './services/savedStore';
import { loadSystemRegion } from './services/systemRegion';
import { showWindowWhenPainted } from './services/windowChrome';
import { loadZoom } from './services/zoom';
import { initializeTheme } from './theme';

// Nothing reads saved state while modules load (savedStore waits until asked), so this still comes first.
renameLegacySavedKeys();

// The demo build (vite.config.js) is the mock for the website, so it installs it too.
if ((import.meta.env.DEV || import.meta.env.MODE === 'demo') && !('__TAURI_INTERNALS__' in window)) {
  const { installTauriMock } = await import('./dev/mockTauri');
  installTauriMock();
}

// After the mock, which sets the window's place and its start view: a page the window reloaded into in the background
// starts hidden, back on the view it was left on.
const background = beginBoot();

reportUncaughtErrors(lastShownPageId);
initializeTheme();
trackWindowVisibility();
// Moves phone alert secrets an earlier version kept in the window's storage into the app.
void preparePhoneAlerts();

/** Beside the error boundary rather than in it, so a crash on the first render still shows the window at once, on the error page. */
function ShowWindowWhenPainted() {
  useEffect(showWindowWhenPainted, []);
  return null;
}

// Dates and numbers follow the Mac's region, the Mac title row's size the window's zoom, and every page the settings
// the app keeps for the window, so all three are read before anything is drawn. A promise rather than a top-level await: the build targets
// ES2020, which doesn't have one. Meanwhile the window shows index.html's static first screen (src/boot/), which this
// render replaces with the same picture; should that screen not have shown it, this render does, and the shell shows
// it anyway if neither comes.
// A launch loads the app as it's seen alongside them, so its first frame is the whole app; a page the window reloaded
// into in the background starts only what keeps running, and the rest once the window shows. A shell that fails to load
// is loaded again by AppRoot, which shows the error page if it fails again.
void Promise.all([loadSystemRegion(), loadZoom(), loadSavedSettings(), background ? null : loadShell().catch(() => null)]).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider>
        <AppErrorBoundary>
          <AppRoot />
        </AppErrorBoundary>
      </I18nProvider>
      {/* The window is already up when a page the window reloaded into is shown. */}
      {background ? null : <ShowWindowWhenPainted />}
    </StrictMode>
  );
});

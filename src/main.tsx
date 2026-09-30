import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { AppErrorBoundary } from './AppErrorBoundary';
import App from './App';
import { I18nProvider } from './i18n';
import { trackWindowVisibility } from './lib/windowVisibility';
import { lastShownPageId } from './components/ErrorBoundaries';
import { preparePhoneAlerts } from './services/phoneAlerts';
import { reportUncaughtErrors } from './services/productAnalytics';
import { renameLegacySavedKeys } from './services/savedKeys';
import { loadSystemRegion } from './services/systemRegion';
import { showWindowWhenPainted } from './services/windowChrome';
import { loadZoom } from './services/zoom';
import { initializeTheme } from './theme';
import './styles.css';

// Nothing reads saved state while modules load (savedStore waits until asked), so this still comes first.
renameLegacySavedKeys();

if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
  const { installTauriMock } = await import('./dev/mockTauri');
  installTauriMock();
}

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

// Dates and numbers follow the Mac's region, and the Mac title row's size the window's zoom, so both
// are read before anything is drawn. A promise rather than a top-level await: the build targets
// ES2020, which doesn't have one. The window stays hidden until this first render paints; the shell
// shows it anyway if that never comes.
void Promise.all([loadSystemRegion(), loadZoom()]).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </I18nProvider>
      <ShowWindowWhenPainted />
    </StrictMode>
  );
});

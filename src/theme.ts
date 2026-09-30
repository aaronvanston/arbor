import { useSyncExternalStore } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createThemeController, type AppTheme, type ThemeEnvironment, type ThemePreference } from './themeController';

export type { AppTheme, ThemePreference } from './themeController';

const STORAGE_KEY = 'arbor.theme';
/**
 * The `--background` token from styles.css in sRGB. The pre-paint script in
 * index.html uses the same values, so the native window, the first paint and
 * the page never disagree at launch.
 */
export const WINDOW_BACKGROUND: Record<AppTheme, string> = {
  light: '#fcfcfc',
  dark: '#0a0a0a',
};

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** What the theme is until one is picked, and what Reset to default puts back. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

/**
 * Installs with nothing saved follow the system. Earlier versions saved the
 * detected light or dark theme at every launch, whether or not anyone picked
 * one, so an upgraded install keeps that theme until Auto is chosen.
 */
export function detectThemePreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isThemePreference(saved)) return saved;
  } catch {
    // Storage may be unavailable in a restricted WebView; follow the system appearance.
  }
  return DEFAULT_THEME_PREFERENCE;
}

function applyTheme(theme: AppTheme): void {
  const root = document.documentElement;
  const changed = root.dataset.theme !== theme;
  // Swap every color in one frame instead of letting transitions animate the
  // change, whether the user or the system switched the appearance.
  if (changed) root.classList.add('no-transitions');
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.style.backgroundColor = WINDOW_BACKGROUND[theme];
  if (document.body) {
    document.body.style.backgroundColor = WINDOW_BACKGROUND[theme];
  }
  if (changed) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => root.classList.remove('no-transitions'));
    });
  }
}

/** Connects the theme controller to this page, its storage and, inside Tauri, the native window. */
export function createThemeEnvironment(): ThemeEnvironment {
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  return {
    readPreference: detectThemePreference,
    savePreference(preference) {
      try {
        window.localStorage.setItem(STORAGE_KEY, preference);
      } catch {
        // The in-memory preference still works when persistent storage is unavailable.
      }
    },
    readMediaTheme: () => (media?.matches ? 'dark' : 'light'),
    listenMedia(listener) {
      if (!media) return () => {};
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', listener);
        return () => media.removeEventListener('change', listener);
      }
      media.addListener(listener);
      return () => media.removeListener(listener);
    },
    listenResume(listener) {
      const visible = () => { if (document.visibilityState === 'visible') listener(); };
      window.addEventListener('focus', listener);
      document.addEventListener('visibilitychange', visible);
      return () => {
        window.removeEventListener('focus', listener);
        document.removeEventListener('visibilitychange', visible);
      };
    },
    applyTheme,
    async connectNative() {
      // The browser preview has no native window and follows prefers-color-scheme.
      if (!isTauri()) return null;
      const currentWindow = getCurrentWindow();
      const currentWebview = getCurrentWebview();
      return {
        // setTheme('light' | 'dark') pins NSApp.appearance; only setTheme(null)
        // hands it back to macOS, which then reports changes itself.
        setTheme: (theme) => currentWindow.setTheme(theme),
        // Once macOS controls the appearance, WKWebView's prefers-color-scheme
        // follows it live, so system mode reads the media query. tao's
        // window.theme() is only a cache, refreshed by a distributed
        // notification AppKit can hold back while Arbor is inactive; reading it
        // would re-apply a stale theme over the live one.
        readTheme: async () => null,
        // Still a useful trigger: tao re-reads the live appearance before emitting it.
        listen: (listener) => currentWindow.onThemeChanged(({ payload }) => listener(payload)),
        async setBackground(theme) {
          const background = WINDOW_BACKGROUND[theme];
          await Promise.allSettled([
            currentWindow.setBackgroundColor(background),
            currentWebview.setBackgroundColor(background),
          ]);
        },
      };
    },
  };
}

let controller: ReturnType<typeof createThemeController> | undefined;

/** Applies the saved preference and keeps the page and native window in step with it. Safe to call again. */
export function initializeTheme() {
  if (controller) return controller;
  controller = createThemeController(createThemeEnvironment());
  return controller;
}

/** The saved preference (`system`, `light` or `dark`) and its setter, shared by every theme control. */
export function useThemePreference() {
  const themeController = initializeTheme();
  const preference = useSyncExternalStore(themeController.subscribe, themeController.getPreference);
  return [preference, themeController.setPreference] as const;
}

const appliedTheme = (): AppTheme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
const LIGHT: AppTheme = 'light';

const watchAppliedTheme = (listener: () => void) => {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
};

/**
 * The theme on screen now, light or dark, whatever the preference. For what styles.css's tokens can't reach, like
 * code highlighted in a shadow root, which otherwise follows the system instead of Arbor.
 */
export const useAppliedTheme = () => useSyncExternalStore(watchAppliedTheme, appliedTheme, () => LIGHT);

if (import.meta.hot) {
  import.meta.hot.dispose(() => controller?.dispose());
}

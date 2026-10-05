import { BOOT_KEY, readBootState } from './bootState';

/**
 * index.html's first script, inlined in its head by the build (vite.config.js, `bootShell()`): puts the saved theme,
 * Arbor's color and the zoom on the root before anything paints, so the static first screen and React's first frame
 * draw alike. Everything it reads is a look preference in the window's own storage; nothing secret is ever there.
 */
(() => {
  const root = document.documentElement;
  let savedTheme: string | null = null;
  try {
    // Versions up to 1.0 saved it under an older name, which the app renames once it loads (services/savedKeys.ts).
    savedTheme = localStorage.getItem('arbor.theme') ?? localStorage.getItem('easy-cli-proxy-api.theme');
  } catch {
    // Blocked storage follows the system; the app applies the theme again during initialization.
  }
  // An explicit light or dark choice wins; 'system' and no saved choice follow the OS.
  const theme = savedTheme === 'light' || savedTheme === 'dark'
    ? savedTheme
    : window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  // The --background token from styles.css, shared with WINDOW_BACKGROUND in theme.ts.
  root.style.backgroundColor = theme === 'dark' ? '#0a0a0a' : '#fcfcfc';
  // Arbor's color from the saved preferences, as services/appColor.ts's applyAppColor puts it (Summer has none).
  try {
    const saved = localStorage.getItem('arbor.preferences.v1') ?? localStorage.getItem('cpa-gui.preferences.v1');
    const color = (JSON.parse(saved ?? '{}') as { appColor?: unknown }).appColor;
    if (color === 'early-autumn' || color === 'autumn') root.dataset.appColor = color;
  } catch {
    // Damaged or blocked storage keeps Summer; the app applies the color again when it starts.
  }
  // The zoom the native side puts on the web view before it shows; the Mac title row divides by it (styles.css).
  let zoom = 1;
  try {
    zoom = readBootState(localStorage.getItem(BOOT_KEY)).zoom;
  } catch {
    // Actual size until services/zoom.ts hears the level.
  }
  if (zoom !== 1) root.style.setProperty('--zoom', String(zoom));
})();

import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import { emit } from '@tauri-apps/api/event';
import { mockWindows } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import { I18nProvider } from '../src/i18n';
import { AppearanceSettingsPage } from '../src/pages/AppearanceSettingsPage';
import { createThemeEnvironment, detectThemePreference, WINDOW_BACKGROUND } from '../src/theme';
import { createThemeController, type AppTheme, type ThemePreference } from '../src/themeController';
import { present } from './support/items';
import { PRE_PAINT_SCRIPT } from './support/bootScripts';

const STORAGE_KEY = 'arbor.theme';
const globals = globalThis as { window?: unknown; document?: unknown; isTauri?: boolean };

afterEach(() => {
  delete globals.window;
  delete globals.document;
  delete globals.isTauri;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Minimal page globals. The pre-paint script in index.html has already set the theme. */
function stubPage({ system = 'light', saved = null }: { system?: AppTheme; saved?: string | null } = {}) {
  let systemTheme = system;
  let mediaChanged: (() => void) | undefined;
  const writes: [string, string][] = [];
  const frames: (() => void)[] = [];
  const classes = new Set<string>();
  const root = {
    dataset: { theme: system } as Record<string, string>,
    style: {} as Record<string, string>,
    classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
  };
  const body = { style: {} as Record<string, string> };
  globals.window = {
    crypto: globalThis.crypto,
    localStorage: { getItem: () => saved, setItem: (key: string, value: string) => writes.push([key, value]) },
    matchMedia: () => ({
      get matches() { return systemTheme === 'dark'; },
      addEventListener: (_type: string, listener: () => void) => { mediaChanged = listener; },
      removeEventListener: () => {},
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
  };
  globals.document = { documentElement: root, body, visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} };
  return {
    root, body, writes, classes,
    /** The OS appearance changes and the WebView's prefers-color-scheme reports it. */
    setSystem(theme: AppTheme) { systemTheme = theme; mediaChanged?.(); },
    flushFrames() { while (frames.length) frames.shift()!(); },
  };
}

/** CSS `oklch(L C H)` to `#rrggbb`, via OKLab and linear sRGB. */
function oklchToHex(value: string) {
  const [lightness, chroma, hue] = value.slice(value.indexOf('(') + 1, value.lastIndexOf(')')).trim().split(/\s+/);
  if (lightness === undefined || chroma === undefined || hue === undefined) throw new Error(`Not an oklch() color: ${value}`);
  const l = lightness.endsWith('%') ? Number.parseFloat(lightness) / 100 : Number.parseFloat(lightness);
  const c = chroma.endsWith('%') ? (Number.parseFloat(chroma) / 100) * 0.4 : Number.parseFloat(chroma);
  // `none` (a missing hue, as Tailwind writes its grays) counts as 0.
  const h = ((hue === 'none' ? 0 : Number.parseFloat(hue)) * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const lms1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const lms2 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const lms3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return `#${[
    4.0767416621 * lms1 - 3.3077115913 * lms2 + 0.2309699292 * lms3,
    -1.2684380046 * lms1 + 2.6097574011 * lms2 - 0.3413193965 * lms3,
    -0.0041960863 * lms1 - 0.7034186147 * lms2 + 1.707614701 * lms3,
  ].map((linear) => {
    const encoded = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, encoded)) * 255).toString(16).padStart(2, '0');
  }).join('')}`;
}

describe('saved theme preference', () => {
  const detectWith = (getItem: () => string | null) => {
    globals.window = { localStorage: { getItem } };
    return detectThemePreference();
  };

  test('installs without a saved choice follow the system; saved choices are kept', () => {
    expect(detectWith(() => null)).toBe('system');
    expect(detectWith(() => 'light')).toBe('light');
    expect(detectWith(() => 'dark')).toBe('dark');
    expect(detectWith(() => 'system')).toBe('system');
    expect(detectWith(() => 'sepia')).toBe('system');
    expect(detectWith(() => { throw new Error('blocked'); })).toBe('system');
  });

  test('browser preview: startup follows the system live and never saves what it detected', () => {
    const page = stubPage({ system: 'dark' });
    const controller = createThemeController(createThemeEnvironment());
    expect(controller.getPreference()).toBe('system');
    expect(page.root.dataset.theme).toBe('dark');
    expect(page.root.style.colorScheme).toBe('dark');
    expect(page.root.style.backgroundColor).toBe(WINDOW_BACKGROUND.dark);
    expect(page.body.style.backgroundColor).toBe(WINDOW_BACKGROUND.dark);
    expect(page.classes.has('no-transitions')).toBe(false);

    page.setSystem('light');
    expect(page.root.dataset.theme).toBe('light');
    expect(page.body.style.backgroundColor).toBe(WINDOW_BACKGROUND.light);
    expect(page.classes.has('no-transitions')).toBe(true);
    page.flushFrames();
    expect(page.classes.has('no-transitions')).toBe(false);
    expect(page.writes).toEqual([]);

    controller.setPreference('dark');
    expect(page.root.dataset.theme).toBe('dark');
    expect(page.writes).toEqual([[STORAGE_KEY, 'dark']]);
    page.setSystem('light');
    expect(page.root.dataset.theme).toBe('dark');
    controller.dispose();
  });
});

describe('desktop window appearance', () => {
  test('Auto hands the appearance to macOS and follows it live; Light and Dark pin it', async () => {
    const page = stubPage({ system: 'light' });
    // Like tao, the window's reported theme is a cache that is only refreshed
    // by the (possibly delayed) theme-changed notification.
    let cachedNativeTheme: AppTheme = 'light';
    mockWindows('main');
    const calls = mockCommands({}, {
      plugins: (command) => (command === 'plugin:window|theme' ? cachedNativeTheme : null),
      events: true,
    });
    globals.isTauri = true;
    const pinned = () => calls.filter(({ command }) => command === 'plugin:window|set_theme').map(({ args }) => args.value);
    const backgrounds = () => calls.filter(({ command }) => command.endsWith('background_color')).map(({ args }) => args.color);

    const controller = createThemeController(createThemeEnvironment());
    await settle();
    expect(pinned()).toEqual([null]);
    expect(page.root.dataset.theme).toBe('light');
    expect(backgrounds()).toEqual([WINDOW_BACKGROUND.light, WINDOW_BACKGROUND.light]);

    // macOS turns dark while Arbor is in the background: the WebView reports it
    // before the window's cached theme catches up.
    page.setSystem('dark');
    await settle();
    expect(page.root.dataset.theme).toBe('dark');
    expect(backgrounds().slice(-2)).toEqual([WINDOW_BACKGROUND.dark, WINDOW_BACKGROUND.dark]);

    // The held notification arrives once Arbor is active again.
    cachedNativeTheme = 'dark';
    await emit('tauri://theme-changed', 'dark');
    await settle();
    expect(page.root.dataset.theme).toBe('dark');

    controller.setPreference('light');
    await settle();
    expect(pinned()).toEqual([null, 'light']);
    expect(page.root.dataset.theme).toBe('light');
    expect(backgrounds().slice(-2)).toEqual([WINDOW_BACKGROUND.light, WINDOW_BACKGROUND.light]);

    controller.setPreference('system');
    await settle();
    expect(pinned()).toEqual([null, 'light', null]);
    expect(page.root.dataset.theme).toBe('dark');
    expect(page.writes).toEqual([[STORAGE_KEY, 'light'], [STORAGE_KEY, 'system']]);
    expect(calls.some(({ command }) => command === 'plugin:window|theme')).toBe(false);
    controller.dispose();
    await settle();
  });
});

describe('theme controls', () => {
  const pressed = (theme: ThemePreference) => {
    const html = renderToStaticMarkup(<I18nProvider><AppearanceSettingsPage theme={theme} onThemeChange={() => {}} /></I18nProvider>);
    const group = html.slice(html.indexOf('aria-label="Theme"'));
    return [...group.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>.*?<\/svg>\s*([^<]+)<\/button>/g)]
      .map(([, isPressed, label]) => `${present(label, 'a button label').trim()}${isPressed === 'true' ? '*' : ''}`);
  };

  test('Appearance settings offers Light, Dark and Auto with the current choice pressed', () => {
    expect(pressed('system')).toEqual(['Light', 'Dark', 'Auto*']);
    expect(pressed('light')).toEqual(['Light*', 'Dark', 'Auto']);
    expect(pressed('dark')).toEqual(['Light', 'Dark*', 'Auto']);
  });
});

describe('launch colors', () => {
  test('the pre-paint script, native window and --background token use one color', () => {
    const script = PRE_PAINT_SCRIPT;
    const firstPaint = (dark: boolean) => {
      const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
      runInNewContext(script, {
        localStorage: { getItem: () => null },
        window: { matchMedia: () => ({ matches: dark }) },
        document: { documentElement: root },
      });
      return root.style.backgroundColor;
    };
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    // The page colors are Arbor's own or Tailwind's grays.
    const palette = css + readFileSync(new URL('../node_modules/tailwindcss/theme.css', import.meta.url), 'utf8');
    const backgrounds = [...css.matchAll(/--background:\s*var\((--color-[\w-]+)\)/g)].map(([, name]) => name);
    expect(backgrounds).toHaveLength(2);
    const [light, dark] = backgrounds.map((name) => oklchToHex(present(palette.match(new RegExp(`${name}:\\s*(oklch\\([^)]*\\))`))?.[1], name)));

    expect({ light, dark }).toEqual(WINDOW_BACKGROUND);
    expect({ light: firstPaint(false), dark: firstPaint(true) }).toEqual(WINDOW_BACKGROUND);
  });
});

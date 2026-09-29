import { afterEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { APP_PREFERENCE_DEFAULTS, previewAppPreference, setAppPreference, useAppPreferences } from '../src/appPreferences';
import { SidebarToggle } from '../src/components/SidebarControls';
import { SidebarArt as SidebarArtLayer } from '../src/components/sidebar/SidebarArt';
import { SidebarHeader } from '../src/components/sidebar/SidebarChrome';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { I18nProvider } from '../src/i18n';
import { AppearanceSettingsPage } from '../src/pages/AppearanceSettingsPage';
import { drawScene, SCENE_PALETTE, SCENE_ROWS, sceneRows, sceneTitleShade, sceneValues, type SceneName } from '../src/services/sidebarScenes';
import { APP_COLORS } from '../src/services/appColor';
import { DEFAULT_SIDEBAR_ART_MOTION, SIDEBAR_ART_SPEED, sidebarArtMotionChoice, DEFAULT_SIDEBAR_ART, isSidebarArt, SIDEBAR_ARTS, sidebarArtChoice, sidebarArtHalo, sidebarArtInk, type SidebarArt } from '../src/services/sidebarArt';
import { contrast } from './support/contrast';
import { lastItem, present } from './support/items';

afterEach(() => setAppPreference('sidebarArt', APP_PREFERENCE_DEFAULTS.sidebarArt));

const appearance = () => renderToStaticMarkup(<I18nProvider><TooltipProvider><AppearanceSettingsPage theme="light" onThemeChange={() => {}} /></TooltipProvider></I18nProvider>);
/** The Sidebar artwork row's markup, up to the next row. */
const artRow = (html: string) => {
  const start = html.indexOf('data-setting-id="appearance.sidebar-art"');
  return start < 0 ? '' : html.slice(start, html.indexOf('data-slot="settings-row"', start));
};

const hex = (rgb: readonly number[]) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

describe('the sidebar’s artwork', () => {
  it('is the canopy until another is chosen, and a saved name it doesn’t know goes back to that', () => {
    expect(DEFAULT_SIDEBAR_ART).toBe('canopy');
    expect(APP_PREFERENCE_DEFAULTS.sidebarArt).toBe('canopy');
    expect(SIDEBAR_ARTS).toEqual(['aurora', 'canopy', 'off']);
    for (const art of SIDEBAR_ARTS) expect(sidebarArtChoice(art)).toBe(art);
    // Names of retired artworks, which a saved preference can still hold.
    for (const saved of ['sky', 'country', 'sprouting', 'fern', 'rings', 'dusk', 'sunset', 'fields', 'treeline', 'meadow', 'contours', '', null, undefined, 3]) {
      expect(isSidebarArt(saved)).toBe(false);
      expect(sidebarArtChoice(saved)).toBe('canopy');
    }
    // A saved Leaves opens as Canopy, which carries its leaves.
    expect(isSidebarArt('leaves')).toBe(false);
    expect(sidebarArtChoice('leaves')).toBe('canopy');
  });

  it('gives the wordmark and sidebar button an ink over the aurora, and leaves them alone with none', () => {
    expect(sidebarArtInk('aurora', 'light', 'summer')).toMatch(/^#[0-9a-f]{6}$/);
    expect(sidebarArtInk('aurora', 'dark', 'summer')).toMatch(/^#[0-9a-f]{6}$/);
    expect(sidebarArtInk('off', 'light', 'summer')).toBeUndefined();
    expect(sidebarArtInk('off', 'dark', 'summer')).toBeUndefined();
  });

  const scenes = SIDEBAR_ARTS.filter((art): art is SceneName => art !== 'off');

  it('runs every scene at full strength behind the title row, with no bar cleared or dimmed there', () => {
    // The window buttons, sidebar button and wordmark sit between x 14 and 170, y 23 and 40 of the strip.
    for (const scene of scenes) {
      const cols = 256, rows = sceneRows(scene), value = new Float32Array(cols * rows), drift = new Float32Array(cols * rows);
      let brightest = 0;
      for (let seconds = 0; seconds < 600; seconds += 23.7) {
        sceneValues(scene, value, drift, cols, rows, seconds);
        for (let y = 23; y <= 40; y++) for (let x = 14; x <= 170; x++) brightest = Math.max(brightest, value[y * cols + x] ?? 0);
      }
      expect({ scene, full: brightest > 0.6 }).toEqual({ scene, full: true });
    }
  });

  it('keeps the wordmark and sidebar button at 4.5:1 over their halo, which only the artwork brings', () => {
    for (const art of scenes) {
      for (const theme of ['light', 'dark'] as const) {
        for (const color of APP_COLORS) {
          // The halo is the ground under them: the sidebar's own color, or the shade a scene lays under the title row.
          const halo = sidebarArtHalo(art, theme, color) ?? hex(SCENE_PALETTE[theme].ground);
          expect({ art, theme, color, ok: contrast(present(sidebarArtInk(art, theme, color)), halo) >= 4.5 }).toEqual({ art, theme, color, ok: true });
        }
      }
    }
    // Only the light canopy lays its shade there, in Arbor's color, and they go light on it.
    expect(scenes.filter((art) => sceneTitleShade(art, 'light', 'summer'))).toEqual(['canopy']);
    expect(scenes.filter((art) => sceneTitleShade(art, 'dark', 'summer'))).toEqual([]);
    expect(sidebarArtInk('canopy', 'light', 'summer')).toBe('#f5f5f5');
    expect(sidebarArtHalo('canopy', 'light', 'summer')).toBe('#052717');
    expect(new Set(APP_COLORS.map((color) => sidebarArtHalo('canopy', 'light', color))).size).toBe(APP_COLORS.length);
    expect(sidebarArtHalo('canopy', 'dark', 'autumn')).toBeUndefined();
    expect(sidebarArtHalo('off', 'light', 'autumn')).toBeUndefined();
    const header = (art: SidebarArt) => renderToStaticMarkup(<I18nProvider><SidebarHeader art={art} theme="light" color="summer" macTitleBar onHome={() => {}} /></I18nProvider>);
    const toggle = (art: SidebarArt) => renderToStaticMarkup(<I18nProvider><TooltipProvider><SidebarToggle shown onToggle={() => {}} ink={sidebarArtInk(art, 'light', 'summer')} /></TooltipProvider></I18nProvider>);
    expect(header('canopy')).toContain('art-halo');
    expect(toggle('canopy')).toContain('art-halo');
    expect(header('off')).not.toContain('art-halo');
    expect(toggle('off')).not.toContain('art-halo');
  });

  it('draws every scene in Arbor’s greens, leaving the rest and the strip’s foot clear', () => {
    for (const scene of scenes) {
      for (const theme of ['light', 'dark'] as const) {
        const cols = 256, rows = sceneRows(scene), pixels = new Uint32Array(cols * rows);
        drawScene(scene, pixels, new Float32Array(cols * rows), new Float32Array(cols * rows), cols, rows, 30, theme, 'summer');
        const drawn = pixels.filter((pixel) => pixel !== 0).length;
        expect({ scene, theme, some: drawn > cols * rows * 0.03, not: drawn < cols * rows * 0.8 }).toEqual({ scene, theme, some: true, not: true });
        expect({ scene, foot: pixels.subarray((rows - 6) * cols).every((pixel) => pixel === 0) }).toEqual({ scene, foot: true });
        for (const pixel of pixels) {
          if (!pixel) continue;
          const r = pixel & 255, g = (pixel >>> 8) & 255, b = (pixel >>> 16) & 255;
          expect(pixel >>> 24).toBe(255);
          expect(g).toBeGreaterThanOrEqual(Math.max(r, b));
        }
      }
    }
  });

  it('draws each season as the summer picture with its leaves turned: some to yellow and orange early on, most to orange and red later', () => {
    // The same dots in the same places, only their color turned, so each season's light and dark artwork follows from
    // the summer one's. Then how many of the dots with color enough to have a hue (OKLCH) are still green, and how many
    // have turned yellow or past it to orange and red.
    const hue = ([r, g, b]: number[]) => {
      const [lr, lg, lb] = [r, g, b].map((c) => ((c ?? 0) / 255 <= 0.04045 ? (c ?? 0) / 255 / 12.92 : (((c ?? 0) / 255 + 0.055) / 1.055) ** 2.4)) as [number, number, number];
      const l = Math.cbrt(0.4122214708 * lr + 0.5363377335 * lg + 0.0514459929 * lb), m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb), q = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
      const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * q, bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * q;
      return { chroma: Math.hypot(a, bb), degrees: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
    };
    const cols = 256, rows = sceneRows('canopy');
    for (const theme of ['light', 'dark'] as const) {
      const draw = (color: (typeof APP_COLORS)[number]) => {
        const pixels = new Uint32Array(cols * rows);
        drawScene('canopy', pixels, new Float32Array(cols * rows), new Float32Array(cols * rows), cols, rows, 30, theme, color);
        return pixels;
      };
      const summer = draw('summer');
      const shares = Object.fromEntries(APP_COLORS.map((color) => {
        const pixels = draw(color);
        expect({ theme, color, same: pixels.every((pixel, cell) => !pixel === !summer[cell]) }).toEqual({ theme, color, same: true });
        let green = 0, yellow = 0, orangeRed = 0, colored = 0;
        for (const pixel of pixels) {
          if (!pixel) continue;
          const { chroma, degrees } = hue([pixel & 255, (pixel >>> 8) & 255, (pixel >>> 16) & 255]);
          if (chroma < 0.04) continue;
          colored++;
          if (degrees >= 130 && degrees < 200) green++;
          else if (degrees >= 75 && degrees < 130) yellow++;
          else if (degrees < 75 || degrees >= 350) orangeRed++;
        }
        return [color, { green: green / colored, yellow: yellow / colored, orangeRed: orangeRed / colored }];
      }));
      expect({ theme, summer: (shares.summer?.green ?? 0) > 0.99 }).toEqual({ theme, summer: true });
      const early = present(shares['early-autumn']), late = present(shares.autumn);
      expect({ theme, early: { mostlyGreen: early.green > 0.45, someYellow: early.yellow > 0.08, someOrange: early.orangeRed > 0.04 } }).toEqual({ theme, early: { mostlyGreen: true, someYellow: true, someOrange: true } });
      expect({ theme, late: { fewGreen: late.green < 0.15, mostlyOrangeRed: late.orangeRed > 0.5 } }).toEqual({ theme, late: { fewGreen: true, mostlyOrangeRed: true } });
    }
  });

  it('leaves the summer artwork as it was, and turns the aurora in each season too', () => {
    // Every scene draws the same dots in every season, and in summer only greens (checked above for every scene).
    for (const scene of scenes) {
      for (const theme of ['light', 'dark'] as const) {
        const cols = 256, rows = sceneRows(scene), draw = (color: (typeof APP_COLORS)[number]) => {
          const pixels = new Uint32Array(cols * rows);
          drawScene(scene, pixels, new Float32Array(cols * rows), new Float32Array(cols * rows), cols, rows, 30, theme, color);
          return pixels;
        };
        const summer = draw('summer');
        for (const color of APP_COLORS) {
          const pixels = draw(color);
          expect({ scene, theme, color, same: pixels.every((pixel, cell) => !pixel === !summer[cell]) }).toEqual({ scene, theme, color, same: true });
          if (color !== 'summer') expect({ scene, theme, color, turned: pixels.some((pixel, cell) => pixel !== summer[cell]) }).toEqual({ scene, theme, color, turned: true });
        }
      }
    }
  });

  it('hangs the canopy along the top and stops it at the light one’s height, letting a leaf fall on past it', () => {
    // A taller strip than the rest, for the falling leaves.
    const cols = 256, rows = sceneRows('canopy'), value = new Float32Array(cols * rows), drift = new Float32Array(cols * rows);
    expect(rows).toBeGreaterThan(SCENE_ROWS);
    /** How much of rows `from`–`to` is lit above `least`. */
    const lit = (from: number, to: number, least = 0.05) => value.subarray(from * cols, to * cols).filter((v) => v > least).length / ((to - from) * cols);
    sceneValues('canopy', value, drift, cols, rows, 30);
    // Thick along the top and under the title row, then it stops in leaves above the search row (84 down).
    expect(lit(6, 20)).toBeGreaterThan(0.6);
    expect(lit(46, 60)).toBeGreaterThan(0.5);
    expect(lit(70, 84)).toBeLessThan(0.15);
    expect(lit(84, 96)).toBeLessThan(0.05);
    expect(lit(rows - 20, rows)).toBe(0);
    // Where it stops in each 8px column, the lowest 8×8 square still half covered, in the dark theme and the light: the
    // two end together.
    const ends = (theme: 'light' | 'dark', seconds: number) => {
      const pixels = new Uint32Array(cols * rows), found: number[] = [];
      drawScene('canopy', pixels, new Float32Array(cols * rows), new Float32Array(cols * rows), cols, rows, seconds, theme, 'summer');
      for (let x = 0; x + 8 <= cols; x += 8) {
        let lowest = 0;
        for (let y = 0; y + 8 <= 100; y += 2) {
          let covered = 0;
          for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) if (pixels[(y + j) * cols + x + i]) covered++;
          if (covered > 32) lowest = y;
        }
        found.push(lowest);
      }
      return found.sort((a, b) => a - b)[found.length >> 1] ?? 0;
    };
    for (const seconds of [0, 30, 97]) {
      expect({ seconds, together: Math.abs(ends('dark', seconds) - ends('light', seconds)) <= 6 }).toEqual({ seconds, together: true });
      expect(ends('dark', seconds)).toBeLessThan(66);
    }
    // Past the canopy, beside Home, a falling leaf lights it faintly, somewhere new each time.
    const places = new Set<number>();
    for (let seconds = 0; seconds < 240; seconds += 7.3) {
      sceneValues('canopy', value, drift, cols, rows, seconds);
      const below = value.subarray(104 * cols, 126 * cols).findIndex((v) => v > 0.01);
      if (below >= 0) places.add(Math.floor((below % cols) / 8));
    }
    expect(places.size).toBeGreaterThan(4);
  });

  it('draws the light canopy as the owner’s reference does: deep shade with lit leaves up top, each layer down paler', () => {
    const cols = 256, rows = sceneRows('canopy'), pixels = new Uint32Array(cols * rows), value = new Float32Array(cols * rows), drift = new Float32Array(cols * rows);
    const ink = (pixel: number) => (pixel ? 1 - ((pixel & 255) + ((pixel >>> 8) & 255) + ((pixel >>> 16) & 255)) / 765 : 0);
    const band = (from: number, to: number) => ({ from, to, cells: 0, dots: 0, ink: 0, lit: 0 });
    const top = band(4, 30), lower = band(46, 60), foot = band(70, 84), greens = new Set<number>();
    let flattest = Infinity;
    for (let seconds = 0; seconds < 120; seconds += 13.1) {
      drawScene('canopy', pixels, value, drift, cols, rows, seconds, 'light', 'summer');
      // A falling leaf fades out past Home, as in the dark theme, rather than being cut off at the strip's foot.
      expect(pixels.subarray((rows - 6) * cols).every((pixel) => pixel === 0)).toBe(true);
      for (const pixel of pixels) {
        if (!pixel) continue;
        greens.add(pixel);
        const r = pixel & 255, g = (pixel >>> 8) & 255, b = (pixel >>> 16) & 255;
        // Green, never the gray a teal lean or a green thinned over white reads as: blue stays nearer red than green.
        // The palest and deepest dots are too close to white or black to tell.
        expect({ green: g > r && g >= b && (g - r < 24 || b - r <= 0.65 * (g - r)) }).toEqual({ green: true });
      }
      for (const rowsOf of [top, lower, foot]) {
        for (let y = rowsOf.from; y < rowsOf.to; y++) {
          for (let x = 0; x < cols; x++) {
            const dot = ink(pixels[y * cols + x] ?? 0);
            rowsOf.cells++;
            if (!dot) continue;
            rowsOf.dots++;
            rowsOf.ink += dot;
            if (dot < 0.7) rowsOf.lit++;
          }
        }
      }
      // Where the canopy stops in each 8px column, the lowest 8×8 square still half covered: along its leaves, not a
      // line straight across.
      const ends: number[] = [];
      for (let x = 0; x + 8 <= cols; x += 8) {
        let lowest = 0;
        for (let y = 0; y + 8 <= 100; y += 2) {
          let covered = 0;
          for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) if (pixels[(y + j) * cols + x + i]) covered++;
          if (covered > 32) lowest = y;
        }
        ends.push(lowest);
      }
      ends.sort((a, b) => a - b);
      flattest = Math.min(flattest, (ends[Math.floor(0.9 * (ends.length - 1))] ?? 0) - (ends[Math.floor(0.1 * (ends.length - 1))] ?? 0));
    }
    // Covered and deep along the top, with lit leaves standing out of the shade rather than a flat dark block.
    expect(top.dots / top.cells).toBeGreaterThan(0.97);
    expect(top.ink / top.dots).toBeGreaterThan(0.7);
    expect(top.lit / top.dots).toBeGreaterThan(0.15);
    // Paler lower down, and still leaves there rather than dropped dots; then it stops, in leaves, well above Search
    // (84 rows down) rather than dissolving toward it.
    expect(lower.ink / lower.dots).toBeLessThan((0.65 * top.ink) / top.dots);
    expect(lower.dots / lower.cells).toBeGreaterThan(0.6);
    expect(foot.dots / foot.cells).toBeLessThan(0.05);
    expect(flattest).toBeGreaterThan(6);
    // In the dark theme's grain: a few far-apart greens dithered together, as its dots take one of three levels, not a
    // smooth blend along the whole ramp.
    expect(greens.size).toBe(3);
  });

  it('keeps the search row and the tree readable over the canopy that now reaches them', () => {
    // The sidebar's muted text (styles.css --sidebar-muted-foreground), its faintest, from the search label's top (84
    // rows down the strip). A dot is a pixel, so it's the mix in each 8px square that the text is read against.
    const muted = { light: '#6b6b75', dark: '#a3a3a3' } as const;
    const cols = 256, rows = sceneRows('canopy'), pixels = new Uint32Array(cols * rows), value = new Float32Array(cols * rows), drift = new Float32Array(cols * rows);
    for (const [theme, color] of (['light', 'dark'] as const).flatMap((theme) => APP_COLORS.map((color) => [theme, color] as const))) {
      const ground = SCENE_PALETTE[theme].ground;
      let worst = Infinity;
      for (let seconds = 0; seconds < 240; seconds += 11.3) {
        drawScene('canopy', pixels, value, drift, cols, rows, seconds, theme, color);
        for (let y = 84; y + 8 <= rows; y += 4) {
          for (let x = 0; x + 8 <= cols; x += 4) {
            const mix = [0, 0, 0];
            for (let j = 0; j < 8; j++) {
              for (let i = 0; i < 8; i++) {
                const pixel = pixels[(y + j) * cols + x + i] ?? 0, rgb = pixel ? [pixel & 255, (pixel >>> 8) & 255, (pixel >>> 16) & 255] : ground;
                rgb.forEach((c, k) => (mix[k] = (mix[k] ?? 0) + (c ?? 0) / 64));
              }
            }
            worst = Math.min(worst, contrast(muted[theme], hex(mix)));
          }
        }
      }
      expect({ theme, color, ok: worst >= 4.5 }).toEqual({ theme, color, ok: true });
    }
  });

  it('moves at its own pace, a fifth of it, or not at all', () => {
    expect(DEFAULT_SIDEBAR_ART_MOTION).toBe('moving');
    expect(APP_PREFERENCE_DEFAULTS.sidebarArtMotion).toBe('moving');
    expect(SIDEBAR_ART_SPEED).toEqual({ moving: 1, slow: 0.2, still: 0 });
    for (const saved of ['fast', '', null, undefined]) expect(sidebarArtMotionChoice(saved)).toBe('moving');
  });

  it('draws nothing with None, and a canvas behind the title row with a scene', () => {
    expect(renderToStaticMarkup(<SidebarArtLayer art="off" theme="light" color="summer" />)).toBe('');
    for (const theme of ['light', 'dark'] as const) {
      const layer = renderToStaticMarkup(<SidebarArtLayer art="canopy" theme={theme} color="autumn" />);
      expect(layer).toContain('data-slot="sidebar-art"');
      expect(layer).toContain('aria-hidden="true"');
      expect(layer).toContain('pointer-events-none');
      expect(layer).toContain('<canvas');
    }
  });
});

describe('Appearance’s Sidebar artwork row', () => {
  it('shows the choice, with a reset once it isn’t the default', () => {
    const initial = artRow(appearance());
    expect(initial).toContain('Sidebar artwork');
    expect(initial).toContain('Canopy');
    expect(initial).not.toContain('data-reset-default');
    setAppPreference('sidebarArt', 'off');
    const changed = artRow(appearance());
    expect(changed).toContain('None');
    expect(changed).toContain('data-reset-default');
  });
});

describe('a previewed preference', () => {
  /** Runs `body` with a stand-in for localStorage, returning each value written to it. */
  const withStorage = (body: () => void): string[] => {
    const written: string[] = [];
    const storage = globalThis as { localStorage?: unknown };
    const previous = storage.localStorage;
    storage.localStorage = { getItem: () => null, setItem: (_key: string, value: string) => void written.push(value) };
    try {
      body();
    } finally {
      storage.localStorage = previous;
    }
    return written;
  };
  const shown = () => {
    let seen = APP_PREFERENCE_DEFAULTS;
    function Probe() {
      seen = useAppPreferences();
      return null;
    }
    renderToStaticMarkup(<Probe />);
    return seen;
  };

  it('applies for this page load without being saved', () => {
    const written = withStorage(() => previewAppPreference('sidebarArt', 'off'));
    expect(shown().sidebarArt).toBe('off');
    expect(written).toEqual([]);
  });

  it('isn’t saved along with a preference changed after it', () => {
    const written = withStorage(() => {
      previewAppPreference('sidebarArt', 'off');
      setAppPreference('sidebarLimits', false);
    });
    expect(shown()).toMatchObject({ sidebarArt: 'off', sidebarLimits: false });
    const last = JSON.parse(lastItem(written)) as Record<string, unknown>;
    expect(last.sidebarLimits).toBe(false);
    expect(last.sidebarArt).toBe(APP_PREFERENCE_DEFAULTS.sidebarArt);
    setAppPreference('sidebarLimits', APP_PREFERENCE_DEFAULTS.sidebarLimits);
  });

  it('gives way to a choice of the same preference, which is saved', () => {
    const written = withStorage(() => {
      previewAppPreference('sidebarArt', 'off');
      setAppPreference('sidebarArt', 'aurora');
    });
    expect(shown().sidebarArt).toBe('aurora');
    expect((JSON.parse(lastItem(written)) as Record<string, unknown>).sidebarArt).toBe('aurora');
  });
});

import { describe, expect, it } from 'bun:test';
import { APP_PREFERENCE_DEFAULTS } from '../src/appPreferences';
import { APP_COLORS, appColorChoice, appColorSwatch, applyAppColor, DEFAULT_APP_COLOR, isAppColor, MOST_TURNED, seasonShade, seasonTurn, turnedGreen } from '../src/services/appColor';
import { SCENE_PALETTE } from '../src/services/sidebarScenes';

/** OKLab lightness and OKLCH hue of an sRGB color, 0–255 channels. */
const oklch = ([r, g, b]: readonly number[]) => {
  const [lr, lg, lb] = [r, g, b].map((c) => ((c ?? 0) / 255 <= 0.04045 ? (c ?? 0) / 255 / 12.92 : (((c ?? 0) / 255 + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363377335 * lg + 0.0514459929 * lb), m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb), s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { lightness: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, hue: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
};

describe('Arbor’s color', () => {
  it('is Summer until another season is chosen, and anything it doesn’t know is Summer', () => {
    expect(APP_COLORS).toEqual(['summer', 'early-autumn', 'autumn']);
    expect(DEFAULT_APP_COLOR).toBe('summer');
    expect(APP_PREFERENCE_DEFAULTS.appColor).toBe('summer');
    for (const color of APP_COLORS) expect(appColorChoice(color)).toBe(color);
    for (const saved of ['green', 'orange', 'winter', '', null, undefined, 3]) {
      expect(isAppColor(saved)).toBe(false);
      expect(appColorChoice(saved)).toBe('summer');
    }
  });

  it('turns a leaf’s greens through yellow and orange to red, keeping how light each is', () => {
    const greens = (['light', 'dark'] as const).flatMap((theme) => {
      const { cool, middle, warm, glow } = SCENE_PALETTE[theme];
      return glow ? [cool, middle, warm, glow] : [cool, middle, warm];
    });
    const middle = SCENE_PALETTE.light.middle;
    // The middle green's hue at each color: yellow, orange, red, each warmer than the one before.
    const hues = [0, 1, 2, 3].map((turn) => oklch(turnedGreen(middle, turn)).hue);
    expect(hues[0]).toBeGreaterThan(140);
    for (let turn = 1; turn <= MOST_TURNED; turn++) expect(hues[turn] ?? 0).toBeLessThan(hues[turn - 1] ?? 0);
    expect(hues[MOST_TURNED]).toBeLessThan(45);
    for (const green of greens) {
      expect(turnedGreen(green, 0)).toBe(green);
      for (let turn = 0.25; turn <= MOST_TURNED; turn += 0.25) {
        const turned = turnedGreen(green, turn);
        // A color a screen shows, no lighter or darker than the green it came from, and the same every time.
        expect({ turn, shown: turned.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255) }).toEqual({ turn, shown: true });
        expect({ turn, same: Math.abs(oklch(turned).lightness - oklch(green).lightness) < 0.01 }).toEqual({ turn, same: true });
        expect(turnedGreen(green, turn)).toEqual(turned);
      }
    }
  });

  it('keeps Summer green, turns some of Early autumn’s leaves, and most of Autumn’s to orange and red', () => {
    /** The share of a season's leaves turned at least `from` and less than `to`. */
    const share = (color: (typeof APP_COLORS)[number], from: number, to: number) => {
      let count = 0;
      for (let at = 0; at <= 1000; at++) {
        const turn = seasonTurn(color, at / 1000);
        if (turn >= from && turn < to) count++;
      }
      return count / 1001;
    };
    expect(share('summer', 0, 0.01)).toBe(1);
    expect(seasonShade('summer')).toBe(0);
    // Early autumn: mostly still green, then yellows and some orange.
    expect(share('early-autumn', 0, 0.5)).toBeGreaterThan(0.55);
    expect(share('early-autumn', 0.75, 1.5)).toBeGreaterThan(0.15);
    expect(share('early-autumn', 1.5, 3.1)).toBeGreaterThan(0.05);
    // Autumn: few green, mostly orange on to red.
    expect(share('autumn', 0, 0.5)).toBeLessThan(0.1);
    expect(share('autumn', 1.5, 3.1)).toBeGreaterThan(0.6);
    // Each leaf further on in a season has turned at least as far as the one before it.
    for (const color of APP_COLORS) {
      for (let at = 1; at <= 100; at++) expect(seasonTurn(color, at / 100)).toBeGreaterThanOrEqual(seasonTurn(color, (at - 1) / 100));
    }
  });

  it('gives every season its own swatch', () => {
    expect(new Set(APP_COLORS.map(appColorSwatch)).size).toBe(APP_COLORS.length);
    for (const color of APP_COLORS) expect(appColorSwatch(color)).toStartWith('conic-gradient(');
  });

  it('puts the season on the page, and Summer takes it away', () => {
    const page = globalThis as { document?: unknown };
    const previous = page.document;
    const dataset: Record<string, string | undefined> = {};
    page.document = { documentElement: { dataset } };
    try {
      applyAppColor('autumn');
      expect(dataset.appColor).toBe('autumn');
      applyAppColor('summer');
      expect('appColor' in dataset).toBe(false);
    } finally {
      page.document = previous;
    }
  });
});

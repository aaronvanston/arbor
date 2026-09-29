import type { MessageKey } from '../i18n/resources';

/**
 * Arbor's color, chosen in Settings › Appearance, as a season: Summer is all green; Early autumn is mostly green with
 * leaves turning yellow and orange; Autumn is mostly orange and red. The buttons and highlights take `--primary` from
 * styles.css, whose `:root[data-app-color=…]` blocks set it for each; the sidebar's artwork turns its leaves
 * (`seasonTurn`, `turnedGreen`).
 */
export type AppColor = 'summer' | 'early-autumn' | 'autumn';

/** In the order Appearance lists them. */
export const APP_COLORS: readonly AppColor[] = ['summer', 'early-autumn', 'autumn'];
export const DEFAULT_APP_COLOR: AppColor = 'summer';

export const APP_COLOR_LABEL: Record<AppColor, MessageKey> = {
  summer: 'appearance.color.summer',
  'early-autumn': 'appearance.color.earlyAutumn',
  autumn: 'appearance.color.autumn',
};

export const isAppColor = (value: unknown): value is AppColor => APP_COLORS.includes(value as AppColor);
/** The saved color, or Summer for anything else. */
export const appColorChoice = (value: unknown): AppColor => (isAppColor(value) ? value : DEFAULT_APP_COLOR);

type Rgb = readonly [number, number, number];

/**
 * How far a leaf has turned, from 0 (green) through 1 (yellow) and 2 (orange) to 3 (red): where the greens' own hue
 * (their middle green's, 155°) turns to at each, and how much of their color they keep. Between two, a leaf is on its
 * way from one to the next, so a green going yellow passes through lime.
 */
const TURN_STOPS: readonly (readonly [hue: number, chroma: number])[] = [
  [155, 1],
  [88, 1.08],
  [56, 1.1],
  [32, 1],
];
const GREENS_HUE = 155;
export const MOST_TURNED = TURN_STOPS.length - 1;

/**
 * Each season as how far its leaves have turned: `[share, turn]` pairs, rising, reading as "the leaf `share` of the way
 * through them, from the greenest to the most turned, has turned this far", so the pairs set what share of the leaves
 * are green, yellow, orange or red. `shade` is how far the light canopy's deep shade between the leaves has turned.
 */
const SEASONS: Record<AppColor, { turns: readonly (readonly [number, number])[]; shade: number }> = {
  summer: { turns: [[0, 0], [1, 0]], shade: 0 },
  'early-autumn': { turns: [[0, 0], [0.58, 0.2], [0.66, 0.85], [0.84, 1.15], [0.92, 1.8], [1, 2.2]], shade: 0.1 },
  autumn: { turns: [[0, 0.1], [0.06, 0.4], [0.14, 1], [0.28, 1.4], [0.55, 2], [0.8, 2.5], [1, 3]], shade: 2.2 },
};

/** How far the leaf `share` of the way through `color`'s leaves (0 greenest, 1 most turned) has turned. */
export function seasonTurn(color: AppColor, share: number): number {
  const turns = SEASONS[color].turns;
  const next = turns.findIndex(([at]) => at >= share);
  if (next <= 0) return turns[0]?.[1] ?? 0;
  const [from, fromTurn] = turns[next - 1] ?? [0, 0], [to, toTurn] = turns[next] ?? [1, 0];
  return fromTurn + ((toTurn - fromTurn) * (share - from)) / (to - from || 1);
}
/** How far the light canopy's shade has turned in `color`. */
export const seasonShade = (color: AppColor) => SEASONS[color].shade;

const toLinear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
const toGamma = (channel: number) => (channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055);

/** sRGB 0–255 to OKLCH: lightness 0–1, chroma, hue in degrees. */
function toOklch([r, g, b]: Rgb): [number, number, number] {
  const [lr, lg, lb] = [r, g, b].map((channel) => toLinear(channel / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363377335 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, Math.hypot(a, bb), (Math.atan2(bb, a) * 180) / Math.PI];
}

/** OKLCH to linear sRGB, which may fall outside 0–1 where the color is past what a screen shows. */
function toLinearRgb(lightness: number, chroma: number, hue: number): [number, number, number] {
  const angle = (hue * Math.PI) / 180, a = chroma * Math.cos(angle), b = chroma * Math.sin(angle);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const shown = (rgb: readonly number[]) => rgb.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);

/**
 * One of the artwork's greens on a leaf turned `turn` of the way (0 green to `MOST_TURNED` red): its hue turned and its
 * chroma scaled as `TURN_STOPS` say there, at the lightness it had, with as much of that chroma as a screen can show (an
 * orange as light as the palest green can't be as strong). So a turned leaf keeps its shading, and the shade, the lit
 * leaves and the contrast with the sidebar's text stay as the green's. Unturned, a green is given back as it is.
 */
export function turnedGreen(rgb: Rgb, turn: number): Rgb {
  if (turn <= 0) return rgb;
  const at = Math.min(MOST_TURNED, turn), stop = Math.min(MOST_TURNED - 1, Math.floor(at)), share = at - stop;
  const [fromHue, fromChroma] = TURN_STOPS[stop] ?? [GREENS_HUE, 1], [toHue, toChroma] = TURN_STOPS[stop + 1] ?? [GREENS_HUE, 1];
  const [lightness, chroma, hue] = toOklch(rgb), target = hue + fromHue + (toHue - fromHue) * share - GREENS_HUE;
  let most = chroma * (fromChroma + (toChroma - fromChroma) * share);
  if (!shown(toLinearRgb(lightness, most, target))) {
    let least = 0;
    for (let step = 0; step < 24; step++) {
      const middle = (least + most) / 2;
      if (shown(toLinearRgb(lightness, middle, target))) least = middle;
      else most = middle;
    }
    most = least;
  }
  const linear = toLinearRgb(lightness, most, target);
  return linear.map((channel) => Math.round(Math.min(1, Math.max(0, toGamma(channel))) * 255)) as unknown as Rgb;
}

/** The artwork's middle green (the light canopy's), which a season's swatch in Appearance shows its leaves in. */
const SWATCH_GREEN: Rgb = [43, 132, 78];
/**
 * The swatch Appearance shows for `color`, as a CSS background: its leaves a quarter, a half and nine tenths of the way
 * through, from greenest to most turned, side by side (all green in Summer).
 */
export function appColorSwatch(color: AppColor) {
  const [a, b, c] = [0.25, 0.6, 0.92].map((share) => `rgb(${turnedGreen(SWATCH_GREEN, seasonTurn(color, share)).join(' ')})`);
  return `conic-gradient(from 90deg, ${a} 0 33%, ${b} 0 67%, ${c} 0)`;
}

/**
 * Puts `color` on the page, where styles.css's `:root[data-app-color=…]` blocks give the buttons and highlights theirs.
 * Summer is the page's own, so it takes the attribute away. index.html's pre-paint script does the same from what's
 * saved, so a launch never flashes Summer first.
 */
export function applyAppColor(color: AppColor) {
  const root = document.documentElement;
  if (color === DEFAULT_APP_COLOR) delete root.dataset.appColor;
  else root.dataset.appColor = color;
}

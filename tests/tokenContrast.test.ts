import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityColorIsLight, identityColors, identityColorValue } from '../src/services/identityColors';
import { APP_COLORS, DEFAULT_APP_COLOR } from '../src/services/appColor';

/*
 * Reads the color tokens straight out of styles.css (and Tailwind's palette) and checks that text meant to be read
 * clears WCAG AA against the surfaces it sits on, and chart marks 3:1, in both themes. A small resolver covers the
 * CSS the tokens use: var(), oklch(), hex, color-mix() and Tailwind's --alpha().
 */

type Rgba = [number, number, number, number];
type Theme = 'light' | 'dark';

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const source = (path: string) => readFileSync(join(sourceRoot, path), 'utf8');
const palette = readFileSync(new URL('../node_modules/tailwindcss/theme.css', import.meta.url), 'utf8');

/** The text inside the braces that open at `start`. */
function block(css: string, start: string): string {
  const open = css.indexOf(start);
  if (open < 0) throw new Error(`No ${start} in styles.css`);
  let depth = 0;
  for (let index = css.indexOf('{', open); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}' && --depth === 0) return css.slice(css.indexOf('{', open) + 1, index);
  }
  throw new Error(`Unclosed ${start}`);
}

const declarations = (css: string) => Object.fromEntries([...css.matchAll(/(--[\w-]+|color|background-color)\s*:\s*([^;{}]+);/g)].map(([, name, value]) => [name!, value!.trim()]));

/** The light declarations of a block and the dark ones from its nested `@variant dark`. */
function themed(css: string): Record<Theme, Record<string, string>> {
  const dark = block(css, '@variant dark');
  const light = css.replace(dark, '');
  return { light: declarations(light), dark: { ...declarations(light), ...declarations(dark) } };
}

const root = themed(block(styles, ':root {'));
const baseTokens: Record<Theme, Record<string, string>> = {
  light: { ...declarations(palette), ...declarations(block(styles, '@theme inline')), ...root.light },
  dark: { ...declarations(palette), ...declarations(block(styles, '@theme inline')), ...root.dark },
};
/** What resolve() reads: the green (:root) tokens, or another of Arbor's colors' over them while a test checks it. */
let tokens = baseTokens;

/** Splits on commas outside parentheses. */
function args(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    if (value[index] === ')') depth -= 1;
    if (value[index] === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  return [...parts, value.slice(start).trim()];
}

const inner = (value: string) => value.slice(value.indexOf('(') + 1, value.lastIndexOf(')'));
const toLinear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
const toGamma = (channel: number) => Math.min(1, Math.max(0, channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055));

function oklabToRgb([l, a, b]: number[]): number[] {
  const [x, y, z] = [l! + 0.3963377774 * a! + 0.2158037573 * b!, l! - 0.1055613458 * a! - 0.0638541728 * b!, l! - 0.0894841775 * a! - 1.291485548 * b!].map((channel) => channel ** 3);
  return [
    4.0767416621 * x! - 3.3077115913 * y! + 0.2309699292 * z!,
    -1.2684380046 * x! + 2.6097574011 * y! - 0.3413193965 * z!,
    -0.0041960863 * x! - 0.7034186147 * y! + 1.707614701 * z!,
  ].map(toGamma);
}

function rgbToOklab([r, g, b]: number[]): number[] {
  const [lr, lg, lb] = [r!, g!, b!].map(toLinear);
  const [x, y, z] = [
    0.4122214708 * lr! + 0.5363377335 * lg! + 0.0514459929 * lb!,
    0.2119034982 * lr! + 0.6806995451 * lg! + 0.1073969566 * lb!,
    0.0883024619 * lr! + 0.2817188376 * lg! + 0.6299787005 * lb!,
  ].map(Math.cbrt);
  return [
    0.2104542553 * x! + 0.793617785 * y! - 0.0040720468 * z!,
    1.9779984951 * x! - 2.428592205 * y! + 0.4505937099 * z!,
    0.0259040371 * x! + 0.7827717662 * y! - 0.808675766 * z!,
  ];
}

/** color-mix(): premultiplied interpolation, with a total under 100% becoming transparency (CSS Color 5). */
function mix(space: string, [a, p]: [Rgba, number | null], [b, q]: [Rgba, number | null]): Rgba {
  let first = p ?? (q === null ? 50 : 100 - q);
  let second = q ?? 100 - first;
  const total = first + second;
  first /= total;
  second /= total;
  const alpha = a[3] * first + b[3] * second;
  if (alpha === 0) return [0, 0, 0, 0];
  const encode = space === 'oklab' ? rgbToOklab : (rgb: number[]) => rgb;
  const decode = space === 'oklab' ? oklabToRgb : (rgb: number[]) => rgb;
  const [x, y] = [encode(a.slice(0, 3)), encode(b.slice(0, 3))];
  const channels = decode(x.map((channel, index) => (channel * a[3] * first + y[index]! * b[3] * second) / alpha));
  return [channels[0]!, channels[1]!, channels[2]!, alpha * Math.min(1, total / 100)];
}

function resolve(value: string, theme: Theme): Rgba {
  value = value.trim();
  if (value === 'transparent') return [0, 0, 0, 0];
  if (value === 'white') return [1, 1, 1, 1];
  if (value === 'black') return [0, 0, 0, 1];
  if (value.startsWith('#')) {
    const digits = value.length === 4 ? value.slice(1).split('').map((digit) => digit + digit) : value.slice(1).match(/../g)!;
    return [...digits.map((pair) => Number.parseInt(pair, 16) / 255), 1] as Rgba;
  }
  if (value.startsWith('var(')) {
    const [name, fallback] = args(inner(value));
    const next = tokens[theme][name!] ?? fallback;
    if (next === undefined) throw new Error(`Unknown token ${name}`);
    return resolve(next, theme);
  }
  if (value.startsWith('oklch(')) {
    const [l, c, h] = inner(value).split(/\s+/).map((part) => (part === 'none' ? 0 : part.endsWith('%') ? Number.parseFloat(part) / 100 : Number.parseFloat(part)));
    const angle = (h! * Math.PI) / 180;
    return [...oklabToRgb([l!, c! * Math.cos(angle), c! * Math.sin(angle)]), 1] as Rgba;
  }
  if (value.startsWith('--alpha(')) {
    const [, color, amount] = inner(value).match(/^(.*)\/\s*([\d.]+)%$/)!;
    const rgba = resolve(color!, theme);
    return [rgba[0], rgba[1], rgba[2], (rgba[3] * Number.parseFloat(amount!)) / 100];
  }
  if (value.startsWith('color-mix(')) {
    const [space, ...colors] = args(inner(value));
    const stop = (part: string): [Rgba, number | null] => {
      const match = part.match(/^(.*\S)\s+([\d.]+)%$/);
      return match ? [resolve(match[1]!, theme), Number.parseFloat(match[2]!)] : [resolve(part, theme), null];
    };
    return mix(space!.replace(/^in\s+/, ''), stop(colors[0]!), stop(colors[1]!));
  }
  throw new Error(`Can't resolve ${value}`);
}

const token = (name: string, theme: Theme) => resolve(`var(--${name})`, theme);

/** A color at a Tailwind opacity modifier: `bg-input/32` is `faded(input, 32)`. */
const faded = (color: Rgba, percent: number): Rgba => [color[0], color[1], color[2], (color[3] * percent) / 100];

/** The numbers a pattern captures from a source file, so a test follows the classes the component really uses. */
function classNumbers(path: string, pattern: RegExp): number[] {
  const match = source(path).match(pattern);
  if (!match) throw new Error(`${pattern} no longer matches ${path}`);
  return match.slice(1).map(Number);
}

/** Paints `top` over the layers below it, last one first (it must be opaque). */
function over(...layers: Rgba[]): Rgba {
  return layers.reduceRight((below, top) => {
    const alpha = top[3] + below[3] * (1 - top[3]);
    const channel = (index: number) => (top[index]! * top[3] + below[index]! * below[3] * (1 - top[3])) / alpha;
    return [channel(0), channel(1), channel(2), alpha];
  });
}

const luminance = ([r, g, b]: Rgba) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

/** WCAG contrast ratio; the text is painted over the surface first so translucent ink counts as it's seen. */
function contrast(text: Rgba, surface: Rgba): number {
  const [a, b] = [luminance(over(text, surface)), luminance(surface)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const THEMES: Theme[] = ['light', 'dark'];

describe('color tokens', () => {
  for (const theme of THEMES) {
    const surface = (...layers: string[]) => over(...layers.map((name) => token(name, theme)));
    const surfaces: Record<string, Rgba> = {
      background: surface('background'),
      card: surface('card'),
      'muted on card': surface('muted', 'card'),
      'accent on background': surface('accent', 'background'),
      sidebar: surface('sidebar'),
    };

    test(`${theme}: muted text clears 4.5:1 on every surface it sits on`, () => {
      for (const [name, color] of Object.entries(surfaces)) {
        expect({ name, ratio: contrast(token('muted-foreground', theme), color) >= 4.5 }).toEqual({ name, ratio: true });
      }
    });

    test(`${theme}: muted labels clear 4.5:1 inside a segmented control`, () => {
      // Unpressed segments show muted text straight on the group's input-tinted track, on pages and on cards.
      const [light, dark] = classNumbers('components/ui/toggle-group.tsx', /rounded-lg bg-input\/(\d+) p-0\.5 dark:bg-input\/(\d+)/);
      for (const base of ['background', 'card']) {
        const track = over(faded(token('input', theme), theme === 'light' ? light! : dark!), surface(base));
        expect({ base, ratio: contrast(token('muted-foreground', theme), track) >= 4.5 }).toEqual({ base, ratio: true });
      }
    });

    test(`${theme}: the update icon and the unread dot stand out on the sidebar`, () => {
      // The round update button is the accent alone, idle and on the neutral hover and current washes the other footer
      // buttons use; the bell's unread dot is the accent too. Both are graphics, so 3:1.
      for (const base of [surface('sidebar'), surface('sidebar-row-hover', 'sidebar'), surface('sidebar-row-selected', 'sidebar')]) {
        expect(contrast(token('primary', theme), base)).toBeGreaterThanOrEqual(3);
      }
    });

    test(`${theme}: alert text is readable on the alert's own tint`, () => {
      // Warning and error alerts write their description in the tone's color; info and success keep it muted.
      for (const base of ['background', 'card']) {
        for (const tone of ['warning', 'error']) {
          const tint = over(token(`${tone}-surface`, theme), surface(base));
          expect({ tone, base, ratio: contrast(token(`${tone}-foreground`, theme), tint) >= 4.5 }).toEqual({ tone, base, ratio: true });
        }
        for (const tone of ['info', 'success']) {
          const tint = over(faded(token(tone, theme), 4), surface(base));
          expect({ tone, base, ratio: contrast(token('muted-foreground', theme), tint) >= 4.5 }).toEqual({ tone, base, ratio: true });
        }
      }
    });

    test(`${theme}: placeholders read like muted text`, () => {
      // Inputs are the page color in light mode and a faint white wash in dark mode, on pages and on cards.
      for (const base of ['background', 'card']) {
        const field = theme === 'light' ? surface(base) : over([...token('input', theme).slice(0, 3), token('input', theme)[3] * 0.32] as Rgba, surface(base));
        expect(contrast(token('placeholder', theme), field)).toBeGreaterThanOrEqual(4.5);
      }
    });

    test(`${theme}: sidebar labels stay readable on the sidebar and its rows`, () => {
      // Idle and hovered rows keep muted labels (the limits rows stay muted on hover); the current page turns them
      // to the foreground color.
      for (const row of [surface('sidebar'), surface('sidebar-row-hover', 'sidebar')]) {
        expect(contrast(token('sidebar-muted-foreground', theme), row)).toBeGreaterThanOrEqual(4.5);
      }
      for (const row of ['sidebar-row-selected', 'sidebar-row-active']) {
        expect(contrast(token('sidebar-foreground', theme), surface(row, 'sidebar'))).toBeGreaterThanOrEqual(7);
      }
    });

    test(`${theme}: the sidebar's state dots clear 3:1 on the sidebar and its rows`, () => {
      // A page's badge, the Core button's dot and a provider's status dot are the only sign of what they mean until
      // hovered, so each tone holds 3:1 with the sidebar's own dot colors (its [data-app-sidebar] block).
      const scoped = themed(block(styles, '[data-app-sidebar] {'))[theme];
      const dot = (tone: string) => resolve(scoped[`--${tone}`] ?? `var(--${tone})`, theme);
      for (const tone of ['warning', 'success', 'error', 'info']) {
        for (const [name, row] of Object.entries({
          sidebar: surface('sidebar'),
          hover: surface('sidebar-row-hover', 'sidebar'),
          current: surface('sidebar-row-selected', 'sidebar'),
        })) {
          expect({ tone, row: name, visible: contrast(dot(tone), row) >= 3 }).toEqual({ tone, row: name, visible: true });
        }
      }
    });

    test(`${theme}: the sidebar's icon-only buttons clear 3:1`, () => {
      // Search, add, the footer's utilities and the sidebar button are an icon alone, dimmed like T3's until hovered.
      for (const row of [surface('sidebar'), surface('sidebar-row-hover', 'sidebar')]) {
        expect(contrast(token('sidebar-icon-color', theme), row)).toBeGreaterThanOrEqual(3);
      }
    });

    test(`${theme}: account chips are readable in every color`, () => {
      const chip = themed(block(styles, '@utility account-chip'))[theme];
      // Every color an account or machine can be given from the palette; the machine pill's soft fill is this tint.
      for (const color of identityColors) {
        const withColor = (value: string) => value.split('var(--account-color)').join(identityColorValue[color]);
        // Chips sit on cards and in the popover-colored search palette.
        for (const base of ['card', 'popover']) {
          const tint = over(resolve(withColor(chip['background-color']!), theme), surface(base));
          expect({ color, base, readable: contrast(resolve(withColor(chip.color!), theme), tint) >= 4.5 }).toEqual({ color, base, readable: true });
        }
      }
    });

    test(`${theme}: account avatars keep their letters readable in every fill and color`, () => {
      const chip = themed(block(styles, '@utility account-chip'))[theme];
      const fills = block(styles, '@utility account-fill');
      const rule = (selector: string) => declarations(block(fills, `${selector} {`));
      for (const color of identityColors) {
        const withColor = (value: string) => resolve(value.split('var(--account-color)').join(identityColorValue[color]), theme);
        // Solid takes dark letters on the light colors, as identityColorIsLight tells the avatar.
        const solid = rule(identityColorIsLight(color) ? "&[data-fill='solid'][data-ink='dark']" : "&[data-fill='solid']");
        const neutral = rule("&[data-fill='neutral']");
        for (const base of ['card', 'popover']) {
          const readable = {
            // Solid is opaque; neutral is the chip's letters on a gray wash; outline the chip's letters on the surface.
            solid: contrast(withColor(solid.color!), over(withColor(solid['background-color']!), surface(base))) >= 4.5,
            neutral: contrast(withColor(chip.color!), over(withColor(neutral['background-color']!), surface(base))) >= 4.5,
            outline: contrast(withColor(chip.color!), surface(base)) >= 4.5,
          };
          expect({ color, base, readable }).toEqual({ color, base, readable: { solid: true, neutral: true, outline: true } });
        }
      }
    });

    test(`${theme}: chart colors clear 3:1 against the surfaces charts sit on`, () => {
      for (let slot = 1; slot <= 6; slot += 1) {
        for (const base of ['background', 'card']) {
          expect({ slot, base, visible: contrast(token(`chart-${slot}`, theme), surface(base)) >= 3 }).toEqual({ slot, base, visible: true });
        }
      }
    });
  }

  test('every one of Arbor’s colors sets its own buttons in both themes, and index.html knows it before paint', () => {
    // index.html's pre-paint script, which the build inlines from here.
    const html = readFileSync(new URL('../src/boot/bootHead.ts', import.meta.url), 'utf8');
    for (const color of APP_COLORS.filter((color) => color !== DEFAULT_APP_COLOR)) {
      const own = themed(block(styles, `:root[data-app-color='${color}'] {`));
      expect({ color, light: own.light['--primary'] !== undefined, dark: own.dark['--primary'] !== own.light['--primary'] }).toEqual({ color, light: true, dark: true });
      expect({ color, prePaint: html.includes(`color === '${color}'`) }).toEqual({ color, prePaint: true });
    }
    expect(styles.includes(`[data-app-color='${DEFAULT_APP_COLOR}']`)).toBe(false);
  });

  for (const color of APP_COLORS) {
    test(`${color}: buttons, links and the open page's icon keep the teal's contrast`, () => {
      const own = color === DEFAULT_APP_COLOR ? { light: {}, dark: {} } : themed(block(styles, `:root[data-app-color='${color}'] {`));
      tokens = { light: { ...baseTokens.light, ...own.light }, dark: { ...baseTokens.dark, ...own.dark } };
      try {
        for (const theme of THEMES) {
          const primary = token('primary', theme), surface = (...layers: string[]) => over(...layers.map((name) => token(name, theme)));
          // A filled button's label, and the color as text: a link, a primary badge on its own tint (bg-primary/10,
          // dark:bg-primary/20) on the page and on cards.
          expect({ theme, label: contrast(token('primary-foreground', theme), primary) >= 4.5 }).toEqual({ theme, label: true });
          for (const base of ['background', 'card']) {
            expect({ theme, base, text: contrast(primary, surface(base)) >= 4.5 }).toEqual({ theme, base, text: true });
            const tint = over(faded(primary, theme === 'light' ? 10 : 20), surface(base));
            expect({ theme, base, badge: contrast(primary, tint) >= 4.5 }).toEqual({ theme, base, badge: true });
          }
          // The open page's icon and the update glyph on the sidebar and its rows are graphics: 3:1.
          for (const row of [surface('sidebar'), surface('sidebar-row-hover', 'sidebar'), surface('sidebar-row-selected', 'sidebar')]) {
            expect(contrast(primary, row)).toBeGreaterThanOrEqual(3);
          }
        }
      } finally {
        tokens = baseTokens;
      }
    });
  }

  test('muted and status text is faded only on icons, separators and dashes', () => {
    // Every one of these colors is tuned to clear 4.5:1 at full strength, so an opacity modifier takes text people
    // read under it. Fading is for decoration: a self-closing element (an icon) or a lone ·, — or ….
    const fadedText = /text-(?:sidebar-muted|muted|warning|error|destructive|success|info)-foreground\/\d+/;
    const decoration = [/className="[^"]*"[^<>]*\/>/, />\s*[·—…]\s*</];
    // `path: line` pairs that aren't text at all, each with its reason.
    const allowed = new Map([
      ['pages/MachineHealthPanel.tsx: muted: \'text-muted-foreground/60\',', 'the stroke of a gauge with no reading'],
    ]);
    const files = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return files(path);
        return /\.tsx?$/.test(entry.name) ? [path] : [];
      });
    const found: string[] = [];
    for (const file of files(sourceRoot)) {
      const path = relative(sourceRoot, file);
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (!fadedText.test(line) || decoration.some((pattern) => pattern.test(line)) || allowed.has(`${path}: ${line.trim()}`)) return;
        found.push(`${path}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  test('the accent never fills the update button, open or not', () => {
    // It marks the update itself (the glyph), not the page that's open or the one under the pointer (§9.2).
    const footer = source('components/sidebar/SidebarFooter.tsx');
    const start = footer.indexOf('rounded-full text-primary');
    expect(start).toBeGreaterThan(0);
    const classes = footer.slice(start, footer.indexOf(')}', start));
    expect(classes).toContain('hover:bg-sidebar-row-hover');
    expect(classes).toContain("current && 'bg-sidebar-row-selected'");
    expect(classes).not.toMatch(/bg-primary/);
  });

  test('the status pulse runs only on icons and dots, never on text', () => {
    // status-pulse holds 50% opacity for half of every cycle, which takes any text color under 4.5:1. So it's only
    // ever inside a self-closing element: an icon, or a dot with nothing in it.
    const files = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return files(path);
        return entry.name.endsWith('.tsx') ? [path] : [];
      });
    const found: string[] = [];
    for (const file of files(sourceRoot)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (line.includes('animate-status-pulse') && !/<[A-Za-z][^<>]*animate-status-pulse[^<>]*\/>/.test(line)) {
          found.push(`${relative(sourceRoot, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(found).toEqual([]);
  });

  test('the current page stands out on the black dark sidebar by its wash and its label', () => {
    // T3's rows: the current page's wash (7%) is fainter than a hovered row's (8%), so what marks it is the wash
    // being there at all and its label turning from muted to the foreground color.
    const sidebar = token('sidebar', 'dark');
    const selected = over(token('sidebar-row-selected', 'dark'), sidebar);
    expect(contrast(selected, sidebar)).toBeGreaterThanOrEqual(1.1);
    expect(contrast(token('sidebar-foreground', 'dark'), token('sidebar-muted-foreground', 'dark'))).toBeGreaterThanOrEqual(2);
    // Darker than the page, as in T3.
    expect(luminance(sidebar)).toBeLessThan(luminance(token('background', 'dark')));
  });

  test('the current page is told from a hovered row by more than color', () => {
    // A hovered row gets the same foreground label and a wash as strong or stronger, so color alone can't mark the
    // current page (WCAG 1.4.11 wants 3:1 between them). Its label's weight does.
    const row = source('components/sidebar/shellParts.ts').match(/export const ROW_CLASS = cn\(([\s\S]*?)\);/)?.[1] ?? '';
    expect(row).toContain('font-medium');
    expect(row).toContain('data-[active=true]:font-semibold');
  });
});

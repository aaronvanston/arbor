/**
 * The colors anything named by a color can take, machines and accounts alike, in the picker's order: round the
 * color wheel, then the grays. Any other color can be picked too, kept as its hex.
 */
export const identityColors = [
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple',
  'fuchsia', 'pink', 'rose', 'slate', 'stone',
] as const;
export type IdentityColor = (typeof identityColors)[number];
/**
 * How something is filled with its color, machines' pills and accounts' avatars alike: `soft` tints it and its words
 * with the color, `solid` fills it with the color, `outline` rings it in the color over nothing, and `neutral` is
 * gray with only its mark (a machine's icon, an account's letters) in the color.
 */
export const identityFills = ['soft', 'solid', 'outline', 'neutral'] as const;
export type IdentityFill = (typeof identityFills)[number];
export const isIdentityFill = (value: unknown): value is IdentityFill => typeof value === 'string' && (identityFills as readonly string[]).includes(value);

/** A color picked outside the palette, as `#rrggbb`. */
export type CustomColor = `#${string}`;
export type PickedColor = IdentityColor | CustomColor;

export const identityColorValue: Record<IdentityColor, string> = {
  red: 'var(--color-red-500)',
  orange: 'var(--color-orange-500)',
  amber: 'var(--color-amber-500)',
  yellow: 'var(--color-yellow-500)',
  lime: 'var(--color-lime-500)',
  green: 'var(--color-green-500)',
  emerald: 'var(--color-emerald-500)',
  teal: 'var(--color-teal-500)',
  cyan: 'var(--color-cyan-500)',
  sky: 'var(--color-sky-500)',
  blue: 'var(--color-blue-500)',
  indigo: 'var(--color-indigo-500)',
  violet: 'var(--color-violet-500)',
  purple: 'var(--color-purple-500)',
  fuchsia: 'var(--color-fuchsia-500)',
  pink: 'var(--color-pink-500)',
  rose: 'var(--color-rose-500)',
  slate: 'var(--color-slate-500)',
  stone: 'var(--color-stone-500)',
};

/**
 * Palette colors too light to carry white words when something is filled with them: they take dark ones. White on
 * the rest's deepened fill clears 4.5:1; on these it doesn't (green only 3.7:1), where dark words clear 7:1.
 * tokenContrast.test.ts measures both.
 */
const LIGHT_COLORS: ReadonlySet<IdentityColor> = new Set(['amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky']);

export const isPaletteColor = (value: unknown): value is IdentityColor =>
  typeof value === 'string' && (identityColors as readonly string[]).includes(value);
export const isCustomColor = (value: unknown): value is CustomColor => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** A stored color as it's kept: a palette name, or a hex in lower case. Null for anything else. */
export function keptColor(value: unknown): PickedColor | null {
  if (isPaletteColor(value)) return value;
  return isCustomColor(value) ? (value.toLowerCase() as CustomColor) : null;
}

/** A color as CSS: a palette variable, or the picked hex itself. */
export const identityColorCss = (color: PickedColor) => (isCustomColor(color) ? color : identityColorValue[color]);

/**
 * Whether something filled with the color needs dark words rather than white: the palette's light ones, or a picked
 * color whose luminance is past where white stops reading on it.
 */
export function identityColorIsLight(color: PickedColor): boolean {
  if (!isCustomColor(color)) return LIGHT_COLORS.has(color);
  const channel = (offset: number) => {
    const value = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // Where white and near-black words read equally well on it.
  return luminance > 0.18;
}
